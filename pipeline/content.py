"""Content-based bridge edges between films and series (and series <-> series).

MovieLens only links films to films, and TMDB/Trakt mostly link series to series, so a person
who has only rated films would never be shown a series. This builds a sparse TF-IDF vector per
title from TMDB keywords, the unified categories (mirror of src/lib/categories.ts), the original
language and the decade, and links each film to its most similar series (and back), plus
series to series. Pairs must share at least ``min_shared`` keywords, so a common genre,
language and decade alone never create an edge.

Pure numpy/scipy, chunked: ~11k titles take a few seconds.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field

import numpy as np
from scipy import sparse

log = logging.getLogger(__name__)

# Mirror of CATEGORIES in src/lib/categories.ts (TMDB movie + TV genre IDs -> category).
CATEGORY_GENRES: dict[str, list[int]] = {
    "action": [28, 12, 10759],
    "scifi": [878, 14, 10765],
    "war": [10752, 10768],
    "comedy": [35],
    "drama": [18, 10766],
    "thriller": [53],
    "crime": [80],
    "horror": [27],
    "mystery": [9648],
    "romance": [10749],
    "animation": [16],
    "documentary": [99],
    "family": [10751, 10762],
    "history": [36],
    "music": [10402],
    "western": [37],
    "reality": [10763, 10764, 10767],
}
_GENRE_TO_CATS: dict[int, list[str]] = {}
for _cat, _ids in CATEGORY_GENRES.items():
    for _g in _ids:
        _GENRE_TO_CATS.setdefault(_g, []).append(_cat)

# Relative weight of each feature group (applied to the TF-IDF values before normalising).
GROUP_WEIGHTS = {"k": 1.0, "c": 0.5, "l": 0.35, "d": 0.25}


def categories_of(genres) -> set[str]:
    return {c for g in genres for c in _GENRE_TO_CATS.get(int(g), [])}


@dataclass
class Features:
    key: str
    keywords: list[int] = field(default_factory=list)
    genres: list[int] = field(default_factory=list)
    language: str | None = None
    year: int | None = None
    votes: int | None = None  # TMDB vote count (quality gate for link targets)
    rating: float | None = None  # TMDB rating 0-10

    def tokens(self) -> list[str]:
        out = [f"k:{k}" for k in dict.fromkeys(self.keywords)]
        out += [f"c:{c}" for c in sorted(categories_of(self.genres))]
        if self.language:
            out.append(f"l:{self.language}")
        if self.year:
            out.append(f"d:{self.year // 10 * 10}")
        return out


def keywords_of(details: dict) -> list[int]:
    """Keyword IDs from a TMDB details payload with append_to_response=keywords (movie or TV shape)."""
    kw = details.get("keywords") or {}
    items = kw.get("keywords") or kw.get("results") or []
    return [int(k["id"]) for k in items if isinstance(k, dict) and k.get("id") is not None]


def _matrices(feats: list[Features]):
    """Row-normalised TF-IDF matrix over all tokens and a binary keyword-only matrix."""
    vocab: dict[str, int] = {}
    rows, cols = [], []
    for i, f in enumerate(feats):
        for t in f.tokens():
            rows.append(i)
            cols.append(vocab.setdefault(t, len(vocab)))
    n = len(feats)
    binary = sparse.csr_matrix((np.ones(len(rows), dtype=np.float32), (rows, cols)), shape=(n, len(vocab)))
    binary.sum_duplicates()
    binary.data[:] = 1.0
    df = np.asarray(binary.sum(axis=0)).ravel()
    idf = np.log((1 + n) / (1 + df)) + 1.0
    group = np.empty(len(vocab), dtype=np.float32)
    is_kw = np.zeros(len(vocab), dtype=bool)
    for tok, j in vocab.items():
        group[j] = GROUP_WEIGHTS[tok[0]]
        # A keyword used by a single title can't link anything; drop it from the overlap test.
        is_kw[j] = tok[0] == "k" and df[j] >= 2
    x = binary.multiply((idf * group).astype(np.float32)).tocsr()
    norms = np.sqrt(np.asarray(x.multiply(x).sum(axis=1)).ravel())
    norms[norms == 0] = 1.0
    x = sparse.diags(1.0 / norms) @ x
    kw = (binary @ sparse.diags(is_kw.astype(np.float32))).tocsr()
    kw.eliminate_zeros()
    return x.tocsr().astype(np.float32), kw.astype(np.float32)


# Formats that should only link to the same kind of title (a quiz show is not "like" a drama
# because both mention a quiz; a kids' show is not a pick for a grown-up thriller).
SPECIAL_FORMATS = {"reality": {"reality"}, "family": {"family", "animation"}}


@dataclass
class _Side:
    x: object  # tf-idf rows
    kw: object  # binary keyword rows
    cat: object  # binary category rows
    fmt: dict[str, np.ndarray]  # format name -> bool per row (row has that category)
    allow: dict[str, np.ndarray]  # format name -> bool per row (row may link to that format)
    ok: np.ndarray  # bool per row: passes the quality gate as a link target


def _top_k(
    src: _Side, dst: _Side, src_keys, dst_keys, k: int, min_sim: float, min_shared: int, chunk: int,
    self_index: dict[str, int] | None = None,
) -> dict[tuple[str, str], float]:
    """Top-k most similar dst per src row; `self_index` (dst key -> column) excludes self links."""
    edges: dict[tuple[str, str], float] = {}
    dst_xt, dst_kwt, dst_catt = dst.x.T.tocsr(), dst.kw.T.tocsr(), dst.cat.T.tocsr()
    for start in range(0, src.x.shape[0], chunk):
        stop = min(start + chunk, src.x.shape[0])
        sim = (src.x[start:stop] @ dst_xt).toarray()
        shared = (src.kw[start:stop] @ dst_kwt).toarray()
        same_cat = (src.cat[start:stop] @ dst_catt).toarray()
        sim[shared < min_shared] = 0.0
        sim[same_cat < 1] = 0.0  # at least one category in common
        sim[:, ~dst.ok] = 0.0
        for name in SPECIAL_FORMATS:
            # Target has the format but the source may not link to it.
            sim[np.ix_(~src.allow[name][start:stop], dst.fmt[name])] = 0.0
        sim[sim < min_sim] = 0.0
        for r in range(stop - start):
            row = sim[r]
            skey = src_keys[start + r]
            if self_index is not None and skey in self_index:
                row[self_index[skey]] = 0.0  # never link a title to itself
            nz = np.flatnonzero(row)
            if not nz.size:
                continue
            top = nz[np.argsort(-row[nz], kind="stable")[:k]]
            for j in top:
                edges[(skey, dst_keys[j])] = float(row[j])
    return edges


def bridge_edges(
    features: dict[str, Features],
    k: int = 15,
    min_sim: float = 0.2,
    min_shared: int = 2,
    tv_tv: bool = True,
    chunk: int = 1024,
    min_votes: dict[str, int] | None = None,
    min_rating: float = 0.0,
) -> dict[tuple[str, str], float]:
    """Content edges (cosine 0-1): film -> top-k series, series -> top-k films, series -> top-k series.

    Links need `min_shared` shared keywords, a shared category, a cosine of at least `min_sim`,
    and matching special formats (reality/talk, kids). Targets must have at least
    `min_votes[kind]` TMDB votes and a rating of at least `min_rating` (when known).
    """
    keys = sorted(features)
    if not keys:
        return {}
    feats = [features[key] for key in keys]
    x, kw = _matrices(feats)
    cats = [categories_of(f.genres) for f in feats]
    cat_names = sorted(CATEGORY_GENRES)
    ci = {c: j for j, c in enumerate(cat_names)}
    r, cl = zip(*[(i, ci[c]) for i, cs in enumerate(cats) for c in cs]) if any(cats) else ((), ())
    cat = sparse.csr_matrix((np.ones(len(r), dtype=np.float32), (r, cl)), shape=(len(keys), len(cat_names)))
    fmt = {n: np.array([n in cs for cs in cats]) for n in SPECIAL_FORMATS}
    allow = {n: np.array([bool(cs & ok) for cs in cats]) for n, ok in SPECIAL_FORMATS.items()}
    mv = min_votes or {}
    ok = np.array([
        (f.votes is None or f.votes >= mv.get(f.key.split(":")[0], 0)) and (f.rating is None or f.rating >= min_rating)
        for f in feats
    ])

    def side(idx: list[int]) -> _Side:
        return _Side(x[idx], kw[idx], cat[idx], {n: v[idx] for n, v in fmt.items()}, {n: v[idx] for n, v in allow.items()}, ok[idx])

    movie_idx = [i for i, key in enumerate(keys) if key.startswith("movie:")]
    tv_idx = [i for i, key in enumerate(keys) if key.startswith("tv:")]
    if not tv_idx:
        return {}
    mk, tk = [keys[i] for i in movie_idx], [keys[i] for i in tv_idx]
    tv_side = side(tv_idx)
    edges: dict[tuple[str, str], float] = {}
    if movie_idx:
        movie_side = side(movie_idx)
        edges.update(_top_k(movie_side, tv_side, mk, tk, k, min_sim, min_shared, chunk))
        edges.update(_top_k(tv_side, movie_side, tk, mk, k, min_sim, min_shared, chunk))
    if tv_tv:
        edges.update(_top_k(tv_side, tv_side, tk, tk, k, min_sim, min_shared, chunk, {key: j for j, key in enumerate(tk)}))
    counts = edge_type_counts(edges)
    log.info("Content bridge: %s (min_sim=%.2f, min_shared=%d, k=%d)", counts, min_sim, min_shared, k)
    return edges


def edge_type_counts(edges) -> dict[str, int]:
    """Edge counts by direction, e.g. {"movie->tv": 120, ...}."""
    out = {"movie->movie": 0, "movie->tv": 0, "tv->movie": 0, "tv->tv": 0}
    for s, d in edges:
        name = f"{s.split(':')[0]}->{d.split(':')[0]}"
        out[name] = out.get(name, 0) + 1
    return out


def content_scale(edges: dict[tuple[str, str], float]) -> float:
    """Scale so the strongest content links land near 1 (like the MovieLens percentile scaling)."""
    if not edges:
        return 1.0
    p = float(np.percentile(np.fromiter(edges.values(), dtype=np.float64), 99))
    return p if p > 0 and not math.isnan(p) else 1.0
