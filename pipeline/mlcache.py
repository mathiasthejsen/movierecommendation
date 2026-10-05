"""Cache of the derived MovieLens neighbour lists (data/cache/movielens/, git-ignored).

MovieLens ml-32m is a static ~240 MB download and the item-item similarity takes a few
minutes, while the rest of the pipeline (TMDB metadata, providers, new releases, Reddit,
curator RSS) runs daily. So the derived neighbours are cached and only recomputed when the
cache key changes (download URL or similarity parameters) or the cache is older than
ML_REFRESH_DAYS (default 7).

    python -m pipeline.mlcache status   # prints need_raw=true|false (also to $GITHUB_OUTPUT)
"""

from __future__ import annotations

import gzip
import hashlib
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path

from .config import Config
from .download import URL

log = logging.getLogger("pipeline.mlcache")
ALGO_VERSION = 1  # bump when movielens.build_neighbors changes its output
DAY = 86400


def refresh_days() -> float:
    raw = os.environ.get("ML_REFRESH_DAYS", "").strip()
    return float(raw) if raw else 7.0


def cache_key(cfg: Config, url: str = URL) -> str:
    parts = [url, ALGO_VERSION, cfg.min_year, cfg.min_ratings, cfg.max_movies, cfg.top_k, bool(cfg.genome_dir)]
    return hashlib.sha1(json.dumps(parts).encode()).hexdigest()[:16]


def cache_path(cfg: Config) -> Path:
    return cfg.cache_dir / "movielens" / "neighbors.json.gz"


@dataclass
class Cached:
    key: str
    built_at: float
    years: dict[str, int]
    neighbors: dict[str, list[tuple[str, float]]]


def load(cfg: Config) -> Cached | None:
    p = cache_path(cfg)
    if not p.exists():
        return None
    try:
        d = json.loads(gzip.decompress(p.read_bytes()))
        return Cached(
            d["key"], float(d["builtAt"]), {k: int(v) for k, v in d["years"].items()},
            {k: [(dst, float(s)) for dst, s in v] for k, v in d["neighbors"].items()},
        )
    except Exception as e:  # corrupt or old format: rebuild
        log.warning("Ignoring unreadable MovieLens cache %s (%s)", p, e)
        return None


def save(cfg: Config, years: dict[str, int], neighbors: dict[str, list[tuple[str, float]]], now: float | None = None) -> Path:
    p = cache_path(cfg)
    p.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "key": cache_key(cfg), "builtAt": now if now is not None else time.time(), "years": years,
        "neighbors": {k: [[dst, round(s, 4)] for dst, s in v] for k, v in neighbors.items()},
    }
    p.write_bytes(gzip.compress(json.dumps(payload, separators=(",", ":")).encode(), compresslevel=6))
    return p


def needs_rebuild(cached: Cached | None, key: str, now: float, max_age_days: float) -> bool:
    return cached is None or cached.key != key or now - cached.built_at >= max_age_days * DAY


def raw_present(cfg: Config) -> bool:
    return (cfg.movielens_dir / "ratings.csv").exists()


def status(cfg: Config, now: float | None = None) -> dict[str, object]:
    now = time.time() if now is None else now
    cached = load(cfg)
    rebuild = needs_rebuild(cached, cache_key(cfg), now, refresh_days())
    return {
        "rebuild": rebuild,
        "need_raw": rebuild and not raw_present(cfg),
        "age_days": None if cached is None else round((now - cached.built_at) / DAY, 2),
    }


def neighbors(cfg: Config, build, now: float | None = None) -> tuple[dict[str, int], dict[str, list[tuple[str, float]]]]:
    """Return (years, neighbours): cached when fresh, else rebuilt via `build(cfg)` and cached.

    `build` returns (years, neighbours) or None when the raw data is missing; a stale cache is
    then still better than nothing.
    """
    now = time.time() if now is None else now
    cached = load(cfg)
    if not needs_rebuild(cached, cache_key(cfg), now, refresh_days()):
        log.info("Using cached MovieLens neighbours (%.1f days old, %d films)", (now - cached.built_at) / DAY, len(cached.neighbors))
        return cached.years, cached.neighbors
    built = build(cfg)
    if built is not None:
        years, nbrs = built
        save(cfg, years, nbrs, now)
        log.info("Recomputed MovieLens neighbours (%d films) and cached them", len(nbrs))
        return years, nbrs
    if cached is not None:
        log.warning("MovieLens raw data missing; using the stale neighbour cache (%.1f days old)", (now - cached.built_at) / DAY)
        return cached.years, cached.neighbors
    log.warning("MovieLens not found at %s and no cache; run `python -m pipeline.download`. Skipping.", cfg.movielens_dir)
    return {}, {}


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = argv if argv is not None else sys.argv[1:]
    if args[:1] != ["status"]:
        print(__doc__)
        return 2
    s = status(Config())
    lines = [f"rebuild={'true' if s['rebuild'] else 'false'}", f"need_raw={'true' if s['need_raw'] else 'false'}"]
    print("\n".join(lines), f"(cache age: {s['age_days']} days)")
    out = os.environ.get("GITHUB_OUTPUT")
    if out:
        with open(out, "a", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
