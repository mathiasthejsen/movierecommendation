"""Assemble and write the static data artifact consumed by the web app.

Layout (all under ``public/data``)::

    meta.json               version, counts, genre/provider names, attribution
    catalog.json            {"fields": [...], "rows": [[...], ...]} movie + TV metadata
    neighbors/<n>.json      {"movie:603": [["tv:1396", ml, reddit, tmdb, trakt], ...]}
                            scores are integers 0-100; shard = shard_of(key)
    curators.json           curator config (public fields) + accumulated picks

Titles use composite keys ``movie:<tmdb id>`` / ``tv:<tmdb id>``. Only derived
scores and TMDB metadata are written: never raw MovieLens ratings or tags,
Reddit text or usernames, Letterboxd reviews or Instagram captions.
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import numpy as np

log = logging.getLogger(__name__)

ARTIFACT_VERSION = 2
CATALOG_FIELDS = [
    "key", "title", "year", "genres", "poster", "runtime", "rating", "votes", "popularity",
    "providers", "overview", "seasons", "status",
]
OVERVIEW_CHARS = 220
N_SOURCES = 4  # movielens, reddit, tmdb, trakt

TMDB_GENRES = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
    18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
    9648: "Mystery", 10749: "Romance", 878: "Science Fiction", 10770: "TV Movie", 53: "Thriller",
    10752: "War", 37: "Western", 10762: "Kids", 10763: "News", 10764: "Reality", 10766: "Soap",
    10767: "Talk",
}
# TV genre ids -> movie genre ids, so one genre filter works for both media types.
TV_GENRE_MAP = {10759: [28, 12], 10765: [878, 14], 10768: [10752, 36]}


def shard_of(key: str, shards: int) -> int:
    """Must match shardOf() in src/lib/keys.ts."""
    kind, _, raw = key.partition(":")
    return (int(raw) * 2 + (1 if kind == "tv" else 0)) % shards


def map_genres(ids: Iterable[int]) -> list[int]:
    out: list[int] = []
    for g in ids:
        for m in TV_GENRE_MAP.get(g, [g]):
            if m not in out:
                out.append(m)
    return out


@dataclass
class Title:
    key: str
    title: str
    year: int
    genres: list[int]
    poster: str | None
    runtime: int | None
    rating: float  # 0-10
    votes: int
    popularity: float
    providers: list[int] = field(default_factory=list)
    overview: str = ""
    seasons: int | None = None  # TV only
    status: str | None = None  # TV only: "ended" | "ongoing"

    @property
    def kind(self) -> str:
        return self.key.split(":", 1)[0]

    def row(self) -> list:
        overview = self.overview.strip()
        if len(overview) > OVERVIEW_CHARS:
            overview = overview[: OVERVIEW_CHARS - 1].rsplit(" ", 1)[0] + "…"
        return [
            self.key, self.title, self.year, self.genres, self.poster, self.runtime,
            round(self.rating, 1), self.votes, round(self.popularity, 1), self.providers, overview,
            self.seasons, self.status,
        ]


def _tv_status(raw: str | None) -> str | None:
    if not raw:
        return None
    return "ended" if raw.lower() in ("ended", "canceled", "cancelled") else "ongoing"


def title_from_details(d: dict, region: str, fallback_year: int | None = None) -> Title | None:
    """Build a Title from a TMDB /movie/{id} or /tv/{id} payload (with watch/providers)."""
    if not d or not d.get("id") or d.get("adult"):
        return None
    kind = d.get("media_type") or ("tv" if "first_air_date" in d or "name" in d and "title" not in d else "movie")
    date_str = (d.get("release_date") if kind == "movie" else d.get("first_air_date")) or ""
    year = int(date_str[:4]) if date_str[:4].isdigit() else fallback_year
    if not year:
        return None
    genres = map_genres([g["id"] for g in d.get("genres", [])] or list(d.get("genre_ids", [])))
    if "providers" in d:
        providers = list(d["providers"])
    else:
        region_data = (d.get("watch/providers") or {}).get("results", {}).get(region, {})
        providers = sorted({p["provider_id"] for k in ("flatrate", "free", "ads") for p in region_data.get(k, [])})
    if kind == "tv":
        runtimes = d.get("episode_run_time") or []
        runtime = runtimes[0] if runtimes else d.get("runtime")
    else:
        runtime = d.get("runtime")
    return Title(
        key=f"{kind}:{int(d['id'])}",
        title=(d.get("title") or d.get("name") or d.get("original_title") or d.get("original_name") or ""),
        year=year,
        genres=genres,
        poster=d.get("poster_path"),
        runtime=runtime or None,
        rating=float(d.get("vote_average") or 0),
        votes=int(d.get("vote_count") or 0),
        popularity=float(d.get("popularity") or 0),
        providers=providers,
        overview=d.get("overview") or "",
        seasons=(d.get("number_of_seasons") or None) if kind == "tv" else None,
        status=_tv_status(d.get("status")) if kind == "tv" else None,
    )


def _percentile_scale(values: list[float], q: float = 99) -> float:
    if not values:
        return 1.0
    p = float(np.percentile(np.asarray(values, dtype=np.float64), q))
    return p if p > 0 else max(values) or 1.0


def merge_edges(
    ml: dict[str, list[tuple[str, float]]],
    reddit: dict[tuple[str, str], float],
    tmdb: dict[tuple[str, str], float],
    keep: set[str],
    cap: int,
    trakt: dict[tuple[str, str], float] | None = None,
) -> dict[str, list[list]]:
    """Normalise each source to 0-100 and merge into capped per-title lists."""
    ml_scale = _percentile_scale([s for row in ml.values() for _, s in row])
    rd_scale = _percentile_scale(list(reddit.values()))
    merged: dict[str, dict[str, list[float]]] = {}

    def add(src: str, dst: str, idx: int, score: float) -> None:
        if src == dst or src not in keep or dst not in keep or score <= 0:
            return
        slot = merged.setdefault(src, {}).setdefault(dst, [0.0] * N_SOURCES)
        slot[idx] = max(slot[idx], min(1.0, score))

    for src, row in ml.items():
        for dst, s in row:
            add(src, dst, 0, s / ml_scale)
    for (src, dst), w in reddit.items():
        add(src, dst, 1, w / rd_scale)
    for (src, dst), s in tmdb.items():
        add(src, dst, 2, s)
    for (src, dst), s in (trakt or {}).items():
        add(src, dst, 3, s)

    out: dict[str, list[list]] = {}
    for src, targets in merged.items():
        ranked = sorted(targets.items(), key=lambda kv: -(kv[1][0] + kv[1][1] + 0.6 * kv[1][2] + 0.5 * kv[1][3]))[:cap]
        rows = [[dst, *(round(v * 100) for v in scores)] for dst, scores in ranked]
        out[src] = [r for r in rows if any(r[1:])]
    return out


def tmdb_rank_edges(src: str, recommendations: list[dict], similar: list[dict]) -> dict[tuple[str, str], float]:
    """Turn TMDB list positions into 0-1 scores (recommendations weigh more than similar)."""
    kind = src.split(":", 1)[0]
    edges: dict[tuple[str, str], float] = {}
    for i, r in enumerate(recommendations[:20]):
        edges[(src, f"{r.get('media_type', kind)}:{int(r['id'])}")] = 0.9 - 0.03 * i
    for i, r in enumerate(similar[:20]):
        key = (src, f"{r.get('media_type', kind)}:{int(r['id'])}")
        score = 0.65 - 0.025 * i
        edges[key] = min(1.0, edges[key] + 0.1) if key in edges else score
    return edges


def write_artifact(
    out_dir: Path,
    titles: dict[str, Title],
    neighbors: dict[str, list[list]],
    *,
    shards: int,
    region: str,
    min_year: int,
    sample: bool,
    genres: dict[int, str],
    providers: dict[int, dict],
    counts: dict[str, int],
    curators: list[dict] | None = None,
    picks: list | None = None,
    last_fetched: dict[str, str] | None = None,
) -> int:
    """Write the artifact and return its total size in bytes."""
    out_dir.mkdir(parents=True, exist_ok=True)
    shard_dir = out_dir / "neighbors"
    if shard_dir.exists():
        shutil.rmtree(shard_dir)
    shard_dir.mkdir()

    used_providers = {p for t in titles.values() for p in t.providers}
    used_genres = {g for t in titles.values() for g in t.genres}
    rows = [t.row() for t in sorted(titles.values(), key=lambda t: -t.votes)]
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))  # noqa: E731

    (out_dir / "catalog.json").write_text(dump({"fields": CATALOG_FIELDS, "rows": rows}), "utf-8")
    buckets: list[dict[str, list]] = [{} for _ in range(shards)]
    for src, edges in neighbors.items():
        if src in titles and edges:
            buckets[shard_of(src, shards)][src] = edges
    for i, bucket in enumerate(buckets):
        (shard_dir / f"{i}.json").write_text(dump(bucket), "utf-8")

    pick_rows = [
        asdict(p) if hasattr(p, "__dataclass_fields__") else dict(p)
        for p in (picks or [])
    ]
    pick_rows = [p for p in pick_rows if p["key"] in titles]
    (out_dir / "curators.json").write_text(
        json.dumps(
            {"sample": sample, "curators": curators or [], "picks": pick_rows, "lastFetched": last_fetched or {}},
            ensure_ascii=False, separators=(",", ":"),
        ),
        "utf-8",
    )

    kinds = [t.kind for t in titles.values()]
    meta = {
        "version": ARTIFACT_VERSION,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sample": sample,
        "region": region,
        "minYear": min_year,
        "shards": shards,
        "counts": {
            "titles": len(titles), "movies": kinds.count("movie"), "tv": kinds.count("tv"),
            "withNeighbors": sum(len(b) for b in buckets), "curatorPicks": len(pick_rows), **counts,
        },
        "genres": {str(g): genres.get(g, TMDB_GENRES.get(g, str(g))) for g in sorted(used_genres)},
        "providers": {
            str(p): {"name": providers[p]["name"], "logo": providers[p].get("logo")}
            for p in sorted(used_providers, key=lambda p: providers.get(p, {}).get("rank", 999))
            if p in providers
        },
        "attribution": {
            "tmdb": "This product uses the TMDB API but is not endorsed or certified by TMDB.",
            "justwatch": "Streaming availability data provided by JustWatch via TMDB.",
            "movielens": "Film similarity derived from the MovieLens ml-32m dataset (GroupLens, University of Minnesota). Non-commercial use only.",
            "reddit": "Recommendation edges derived from public Reddit threads via the official API. No Reddit text is stored.",
            "trakt": "Related-show data from Trakt (trakt.tv).",
            "letterboxd": "Curator picks from public Letterboxd RSS feeds (IDs, ratings and links only).",
        },
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
    return sum(p.stat().st_size for p in out_dir.rglob("*.json"))
