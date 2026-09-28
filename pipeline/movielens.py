"""MovieLens item-item similarity.

Combines two signals per film pair:

* rating co-occurrence: adjusted cosine over mean-centred user ratings, shrunk
  towards zero when few users rated both films;
* tags: cosine over the MovieLens tag genome (``genome-scores.csv`` from
  ml-25m / Tag Genome 2021, if ``GENOME_DIR`` is set) or, by default, a TF-IDF
  vector built from ml-32m ``tags.csv``.

Only derived neighbour scores leave this module; raw ratings and tags are never
written to the artifact.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse

log = logging.getLogger(__name__)

YEAR_RE = re.compile(r"\((\d{4})\)\s*$")
RATING_WEIGHT = 0.7
TAG_WEIGHT = 0.3
SHRINKAGE = 50.0
BLOCK = 512


@dataclass
class MLMovie:
    movie_id: int
    tmdb_id: int
    title: str
    year: int
    genres: list[str]
    mean_rating: float
    n_ratings: int


def parse_title(raw: str) -> tuple[str, int | None]:
    raw = raw.strip()
    m = YEAR_RE.search(raw)
    year = int(m.group(1)) if m else None
    title = YEAR_RE.sub("", raw).strip()
    # MovieLens writes "Matrix, The" / "Lives of Others, The (Das Leben der Anderen)"
    title = re.sub(r"\s*\([^)]*\)\s*$", "", title) if title.endswith(")") else title
    m2 = re.match(r"^(.*), (The|A|An|Les|La|Le|Il|El|Das|Der|Die)$", title)
    if m2:
        title = f"{m2.group(2)} {m2.group(1)}"
    return title, year


def load_movies(ml_dir: Path) -> pd.DataFrame:
    movies = pd.read_csv(ml_dir / "movies.csv", dtype={"movieId": "int32"})
    links = pd.read_csv(ml_dir / "links.csv", dtype={"movieId": "int32"})
    movies = movies.merge(links[["movieId", "tmdbId"]], on="movieId", how="left")
    parsed = movies["title"].map(parse_title)
    movies["clean_title"] = parsed.map(lambda p: p[0])
    movies["year"] = parsed.map(lambda p: p[1])
    return movies


def load_ratings(ml_dir: Path) -> pd.DataFrame:
    return pd.read_csv(
        ml_dir / "ratings.csv",
        usecols=["userId", "movieId", "rating"],
        dtype={"userId": "int32", "movieId": "int32", "rating": "float32"},
    )


def select_movies(
    movies: pd.DataFrame, ratings: pd.DataFrame, min_year: int, min_ratings: int, max_movies: int
) -> pd.DataFrame:
    stats = ratings.groupby("movieId")["rating"].agg(["count", "mean"]).reset_index()
    df = movies.merge(stats, on="movieId", how="inner")
    df = df[(df["year"].fillna(0) >= min_year) & (df["count"] >= min_ratings) & df["tmdbId"].notna()]
    df = df.sort_values("count", ascending=False).drop_duplicates("tmdbId").head(max_movies)
    df["tmdbId"] = df["tmdbId"].astype("int64")
    return df.reset_index(drop=True)


def _l2_normalize(mat: sparse.csr_matrix) -> sparse.csr_matrix:
    norms = np.sqrt(np.asarray(mat.multiply(mat).sum(axis=1)).ravel())
    norms[norms == 0] = 1.0
    return sparse.diags(1.0 / norms).astype(np.float32) @ mat


def rating_matrix(ratings: pd.DataFrame, movie_ids: np.ndarray) -> tuple[sparse.csr_matrix, sparse.csr_matrix]:
    """Return (normalised mean-centred item x user matrix, binary item x user matrix)."""
    index = pd.Index(movie_ids)
    r = ratings[ratings["movieId"].isin(movie_ids)].copy()
    r["centred"] = r["rating"] - r.groupby("userId")["rating"].transform("mean")
    users = pd.Index(r["userId"].unique())
    rows = index.get_indexer(r["movieId"])
    cols = users.get_indexer(r["userId"])
    shape = (len(index), len(users))
    centred = sparse.csr_matrix((r["centred"].to_numpy(np.float32), (rows, cols)), shape=shape)
    binary = sparse.csr_matrix((np.ones(len(r), dtype=np.float32), (rows, cols)), shape=shape)
    return _l2_normalize(centred), binary


def tag_matrix(ml_dir: Path, genome_dir: Path | None, movie_ids: np.ndarray) -> sparse.csr_matrix | None:
    index = pd.Index(movie_ids)
    if genome_dir and (genome_dir / "genome-scores.csv").exists():
        g = pd.read_csv(genome_dir / "genome-scores.csv", dtype={"movieId": "int32", "tagId": "int32"})
        g = g[g["movieId"].isin(movie_ids)]
        rows = index.get_indexer(g["movieId"])
        mat = sparse.csr_matrix(
            (g["relevance"].to_numpy(np.float32), (rows, g["tagId"].to_numpy() - 1)),
            shape=(len(index), int(g["tagId"].max())),
        )
        # Centre on the global mean relevance so generic tags don't dominate.
        mat = sparse.csr_matrix(mat.toarray() - mat.mean(axis=0).A1)
        return _l2_normalize(mat)
    tags_path = ml_dir / "tags.csv"
    if not tags_path.exists():
        return None
    t = pd.read_csv(tags_path, usecols=["movieId", "tag"], dtype={"movieId": "int32", "tag": "string"})
    t = t[t["movieId"].isin(movie_ids)].dropna()
    t["tag"] = t["tag"].str.lower().str.strip()
    counts = t.groupby(["movieId", "tag"]).size().reset_index(name="n")
    df = counts.groupby("tag")["movieId"].nunique()
    df = df[(df >= 3) & (df <= len(index) * 0.5)]
    counts = counts[counts["tag"].isin(df.index)]
    if counts.empty:
        return None
    tag_index = pd.Index(df.index)
    idf = np.log(len(index) / df.to_numpy(np.float32))
    cols = tag_index.get_indexer(counts["tag"])
    vals = np.log1p(counts["n"].to_numpy(np.float32)) * idf[cols]
    mat = sparse.csr_matrix((vals, (index.get_indexer(counts["movieId"]), cols)), shape=(len(index), len(tag_index)))
    return _l2_normalize(mat)


def top_k_similar(
    centred: sparse.csr_matrix,
    binary: sparse.csr_matrix,
    tags: sparse.csr_matrix | None,
    k: int,
) -> list[list[tuple[int, float]]]:
    """Blocked top-k neighbours by blended similarity. Returns row-index lists."""
    n = centred.shape[0]
    ct, bt = centred.T.tocsc(), binary.T.tocsc()
    tt = tags.T.tocsc() if tags is not None else None
    has_tags = np.asarray(tags.getnnz(axis=1) > 0).ravel() if tags is not None else np.zeros(n, bool)
    out: list[list[tuple[int, float]]] = []
    for start in range(0, n, BLOCK):
        stop = min(start + BLOCK, n)
        sim = (centred[start:stop] @ ct).toarray()
        co = (binary[start:stop] @ bt).toarray()
        sim *= co / (co + SHRINKAGE)
        np.clip(sim, 0, None, out=sim)
        if tt is not None:
            tsim = np.clip((tags[start:stop] @ tt).toarray(), 0, None)
            both = has_tags[start:stop, None] & has_tags[None, :]
            sim = np.where(both, RATING_WEIGHT * sim + TAG_WEIGHT * tsim, sim)
        for i in range(stop - start):
            sim[i, start + i] = 0.0
        kk = min(k, n - 1)
        idx = np.argpartition(-sim, kk, axis=1)[:, :kk] if kk < n else np.tile(np.arange(n), (stop - start, 1))
        for i in range(stop - start):
            row = [(int(j), float(sim[i, j])) for j in idx[i] if sim[i, j] > 0]
            row.sort(key=lambda x: -x[1])
            out.append(row)
    return out


def build_neighbors(
    ml_dir: Path,
    genome_dir: Path | None,
    min_year: int,
    min_ratings: int,
    max_movies: int,
    k: int,
) -> tuple[list[MLMovie], dict[int, list[tuple[int, float]]]]:
    """Return kept movies and tmdb_id -> [(tmdb_id, score)] neighbour lists."""
    log.info("Loading MovieLens from %s", ml_dir)
    movies = load_movies(ml_dir)
    ratings = load_ratings(ml_dir)
    kept = select_movies(movies, ratings, min_year, min_ratings, max_movies)
    log.info("Kept %d movies (year >= %d, >= %d ratings)", len(kept), min_year, min_ratings)
    ids = kept["movieId"].to_numpy()
    centred, binary = rating_matrix(ratings, ids)
    del ratings
    tags = tag_matrix(ml_dir, genome_dir, ids)
    rows = top_k_similar(centred, binary, tags, k)
    tmdb = kept["tmdbId"].to_numpy()
    neighbors = {f"movie:{int(tmdb[i])}": [(f"movie:{int(tmdb[j])}", s) for j, s in row] for i, row in enumerate(rows)}
    ml_movies = [
        MLMovie(
            movie_id=int(r.movieId),
            tmdb_id=int(r.tmdbId),
            title=str(r.clean_title),
            year=int(r.year),
            genres=[g for g in str(r.genres).split("|") if g and g != "(no genres listed)"],
            mean_rating=float(r["mean"]),
            n_ratings=int(r["count"]),
        )
        for _, r in kept.iterrows()
    ]
    return ml_movies, neighbors
