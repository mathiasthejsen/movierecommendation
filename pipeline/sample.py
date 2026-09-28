"""Offline sample mode: runs the real pipeline code on synthetic inputs.

Used when no API keys or MovieLens download are available (and in CI). It
generates a tiny MovieLens-shaped dataset from ``sample/seed_movies.csv`` taste
clusters, simulates TMDB recommendations for the TV seed, mines edges from
hand-written ``sample/reddit_threads.json`` fixtures, parses the Letterboxd RSS
fixtures for curator picks, and resolves titles against the seed catalogue
instead of TMDB search. The output is clearly marked ``sample: true``.
"""

from __future__ import annotations

import csv
import json
import random
from pathlib import Path

from .extract import Candidate, normalize_title
from .reddit import Comment, Thread

SAMPLE_DIR = Path(__file__).resolve().parent / "sample"
ML_GENRES = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 18: "Drama",
    14: "Fantasy", 27: "Horror", 9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 53: "Thriller",
    10402: "Musical", 10751: "Children",
}
# Illustrative only: real provider data comes from TMDB/JustWatch in a full run.
SAMPLE_PROVIDERS = {
    8: {"name": "Netflix", "logo": None, "rank": 1},
    9: {"name": "Amazon Prime Video", "logo": None, "rank": 2},
    1899: {"name": "Max", "logo": None, "rank": 3},
    337: {"name": "Disney Plus", "logo": None, "rank": 4},
    11: {"name": "MUBI", "logo": None, "rank": 5},
}
# Fixture feeds are attributed to these curators in sample mode.
SAMPLE_FEEDS = {"letterboxd_diary.xml": "sortedcinema", "letterboxd_list.xml": "mscorsese"}


def _read_seed(name: str, kind: str) -> list[dict]:
    with open(SAMPLE_DIR / name, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    for r in rows:
        r["kind"] = kind
        r["tmdb_id"] = int(r["tmdb_id"])
        r["key"] = f"{kind}:{r['tmdb_id']}"
        r["year"] = int(r["year"])
        r["genres"] = [int(g) for g in r["genres"].split("|") if g]
        r["clusters"] = r["clusters"].split("|")
        r["vote_average"] = float(r["vote_average"])
        r["vote_count"] = int(r["vote_count"])
        r["runtime"] = int(r["runtime"])
    return rows


def load_seed() -> list[dict]:
    return _read_seed("seed_movies.csv", "movie")


def load_tv_seed() -> list[dict]:
    rows = _read_seed("seed_tv.csv", "tv")
    for r in rows:
        r["seasons"] = int(r["seasons"])
    return rows


def write_synthetic_movielens(out_dir: Path, seed: int = 7, n_users: int = 1500) -> Path:
    """Write movies/links/ratings/tags CSVs shaped like ml-32m (films only)."""
    rng = random.Random(seed)
    movies = load_seed()
    out_dir.mkdir(parents=True, exist_ok=True)
    clusters = sorted({c for m in movies for c in m["clusters"]})
    with open(out_dir / "movies.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["movieId", "title", "genres"])
        for i, m in enumerate(movies, 1):
            genres = "|".join(ML_GENRES.get(g, "Drama") for g in m["genres"])
            w.writerow([i, f"{m['title']} ({m['year']})", genres])
    with open(out_dir / "links.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["movieId", "imdbId", "tmdbId"])
        for i, m in enumerate(movies, 1):
            w.writerow([i, f"{i:07d}", m["tmdb_id"]])
    with open(out_dir / "ratings.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["userId", "movieId", "rating", "timestamp"])
        for u in range(1, n_users + 1):
            likes = set(rng.sample(clusters, k=rng.choice([1, 2, 2, 3])))
            for i, m in enumerate(movies, 1):
                overlap = len(likes & set(m["clusters"]))
                popularity = min(1.0, m["vote_count"] / 20000)
                p_seen = 0.08 + 0.5 * popularity + 0.35 * (overlap > 0)
                if rng.random() > p_seen:
                    continue
                quality = (m["vote_average"] - 5) / 4
                mu = 2.4 + 1.1 * min(overlap, 2) + 0.8 * quality
                rating = min(5.0, max(0.5, round((mu + rng.gauss(0, 0.7)) * 2) / 2))
                w.writerow([u, i, rating, 1_600_000_000])
    with open(out_dir / "tags.csv", "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["userId", "movieId", "tag", "timestamp"])
        for i, m in enumerate(movies, 1):
            for c in m["clusters"]:
                for _ in range(rng.randint(2, 6)):
                    w.writerow([rng.randint(1, n_users), i, c, 1_600_000_000])
    return out_dir


def simulated_tmdb_recommendations(shows: list[dict]) -> dict[str, list[dict]]:
    """Stand-in for TMDB /tv/{id}/recommendations: rank other shows by cluster overlap."""
    out: dict[str, list[dict]] = {}
    for s in shows:
        scored = []
        for o in shows:
            if o is s:
                continue
            overlap = len(set(s["clusters"]) & set(o["clusters"]))
            if overlap:
                scored.append((overlap + o["vote_average"] / 20, o))
        scored.sort(key=lambda x: -x[0])
        out[s["key"]] = [{"id": o["tmdb_id"], "media_type": "tv"} for _, o in scored[:12]]
    return out


def sample_threads() -> list[Thread]:
    data = json.loads((SAMPLE_DIR / "reddit_threads.json").read_text("utf-8-sig"))
    return [
        Thread(
            title=t["title"],
            selftext=t.get("selftext", ""),
            score=t.get("score", 0),
            comments=[Comment(c["body"], c["score"]) for c in t.get("comments", [])],
            context=t.get("context", "movie"),
        )
        for t in data
    ]


class SeedResolver:
    """Resolves titles against the seed catalogue (stands in for TMDB search)."""

    def __init__(self, titles: list[dict]):
        self._by_title: dict[str, list[dict]] = {}
        for m in titles:
            self._by_title.setdefault(normalize_title(m["title"]), []).append(m)

    def __call__(self, cand: Candidate, context: str | None = None) -> str | None:
        matches = self._by_title.get(normalize_title(cand.title), [])
        kind = cand.kind or context
        if kind:
            matches = sorted(matches, key=lambda m: m["kind"] != kind)
        if cand.year:
            matches = [m for m in matches if abs(m["year"] - cand.year) <= 1] or matches
        return matches[0]["key"] if matches else None


def sample_details(titles: list[dict]) -> dict[str, dict]:
    """TMDB-details-shaped records for the seed titles (no posters in sample mode)."""
    rng = random.Random(11)
    out = {}
    for m in titles:
        providers = rng.sample(sorted(SAMPLE_PROVIDERS), k=rng.randint(0, 2))
        d = {
            "id": m["tmdb_id"],
            "media_type": m["kind"],
            "genres": [{"id": g} for g in m["genres"]],
            "poster_path": None,
            "overview": m["overview"],
            "vote_average": m["vote_average"],
            "vote_count": m["vote_count"],
            "popularity": m["vote_count"] / 400,
            "providers": providers,
        }
        if m["kind"] == "tv":
            d.update(name=m["title"], first_air_date=f"{m['year']}-01-01", episode_run_time=[m["runtime"]],
                     number_of_seasons=m["seasons"], status=m["status"])
        else:
            d.update(title=m["title"], release_date=f"{m['year']}-01-01", runtime=m["runtime"])
        out[m["key"]] = d
    return out
