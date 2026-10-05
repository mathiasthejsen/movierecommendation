"""Pipeline entry point.

    python -m pipeline.build            # full run (needs TMDB key; MovieLens download recommended)
    python -m pipeline.build --sample   # offline sample artifact, no keys needed

Optional sources are skipped with a warning when their credentials are missing:
Reddit (REDDIT_CLIENT_ID/SECRET), Trakt (TRAKT_CLIENT_ID), Instagram Business
Discovery (IG_USER_ID + IG_ACCESS_TOKEN). Letterboxd RSS curator feeds need no key.
"""

from __future__ import annotations

import argparse
import logging
import sys
import tempfile
from collections import Counter
from pathlib import Path

from . import curators as cur
from . import mlcache
from .artifact import TMDB_GENRES, Title, merge_edges, title_from_details, tmdb_rank_edges, write_artifact
from .config import Config
from .extract import load_llm_extractor
from .movielens import build_neighbors
from .reddit import RedditClient, mine_edges

log = logging.getLogger("pipeline")
MAX_EXTRA_TITLES = 4000


def run_sample(cfg: Config) -> int:
    from . import sample

    movies_seed, tv_seed = sample.load_seed(), sample.load_tv_seed()
    seed = movies_seed + tv_seed
    with tempfile.TemporaryDirectory() as tmp:
        ml_dir = sample.write_synthetic_movielens(Path(tmp) / "ml-sample")
        _, ml_neighbors = build_neighbors(ml_dir, None, cfg.min_year, min_ratings=30, max_movies=10_000, k=cfg.top_k)
    resolver = sample.SeedResolver(seed)
    reddit_edges = mine_edges(sample.sample_threads(), resolver)
    tmdb_edges: dict[tuple[str, str], float] = {}
    for key, recs in sample.simulated_tmdb_recommendations(tv_seed).items():
        tmdb_edges.update(tmdb_rank_edges(key, recs, []))
    details = sample.sample_details(seed)
    genres, providers = TMDB_GENRES, sample.SAMPLE_PROVIDERS
    if cfg.has_tmdb:
        # Optional: with a TMDB key, the sample gets real posters, overviews and providers.
        from .tmdb import TMDBClient

        client = TMDBClient(cfg.tmdb_api_key, cfg.tmdb_read_token, cfg.cache_dir)
        for key in list(details):
            real = client.details(key)
            if real:
                details[key] = real
        genres, providers = {**TMDB_GENRES, **client.genres()}, client.providers(cfg.watch_region)
        log.info("Enriched sample with TMDB metadata (%d requests)", client.requests_made)
    titles = {
        key: t
        for key, d in details.items()
        if (t := title_from_details(d, cfg.watch_region)) and t.year >= cfg.min_year
    }
    curators = cur.load_curators()
    picks: list[cur.Pick] = []
    for fixture, handle in sample.SAMPLE_FEEDS.items():
        entries = cur.parse_letterboxd_rss((sample.SAMPLE_DIR / fixture).read_text("utf-8"))
        year_of = lambda k: titles[k].year if k in titles else None  # noqa: E731
        picks += cur.entries_to_picks(entries, handle, resolver, cfg.min_year, year_of)
    neighbors = merge_edges(ml_neighbors, reddit_edges, tmdb_edges, set(titles), cap=cfg.top_k + 20)
    size = write_artifact(
        cfg.output_dir, titles, neighbors, shards=4, region=cfg.watch_region, min_year=cfg.min_year, sample=True,
        genres=genres, providers=providers,
        counts={
            "movielensEdges": sum(map(len, ml_neighbors.values())), "redditEdges": len(reddit_edges),
            "tmdbEdges": len(tmdb_edges), "traktEdges": 0,
        },
        curators=cur.public_curators(curators), picks=cur.merge_history([], picks),
    )
    log.info("Wrote sample artifact: %d titles, %.1f KB -> %s", len(titles), size / 1024, cfg.output_dir)
    return 0


def run_full(cfg: Config) -> int:
    from .tmdb import TMDBClient, TMDBResolver, result_key, result_year

    if not cfg.has_tmdb:
        log.error("TMDB_API_KEY (or TMDB_READ_TOKEN) is required for a full run. Use --sample for offline mode.")
        return 2
    tmdb = TMDBClient(cfg.tmdb_api_key, cfg.tmdb_read_token, cfg.cache_dir)
    resolver = TMDBResolver(tmdb, cfg.min_year)
    region = cfg.watch_region

    # 1. MovieLens item-item neighbours (films). Cached: recomputed weekly or when the
    #    parameters/URL change, so the daily run doesn't need the 240 MB download.
    def build_ml(c: Config):
        if not mlcache.raw_present(c):
            return None
        movies, nbrs = build_neighbors(c.movielens_dir, c.genome_dir, c.min_year, c.min_ratings, c.max_movies, c.top_k)
        return {f"movie:{m.tmdb_id}": m.year for m in movies}, nbrs

    ml_years, ml_neighbors = mlcache.neighbors(cfg, build_ml)
    catalog: set[str] = set(ml_years)

    # 2. Recent popular films + TV series, with TMDB recommendations/similar for everything
    #    MovieLens doesn't cover (all TV, and films too new for MovieLens).
    fresh = tmdb.recent_popular(cfg.popular_pages, region) + tmdb.popular_tv(cfg.tv_pages, cfg.min_year)
    new_keys = {
        k for r in fresh
        if not r.get("adult") and (k := result_key(r, "movie")) and (result_year(r) or 0) >= cfg.min_year
    } - catalog
    log.info("Adding %d recent/popular films and series not covered by MovieLens", len(new_keys))
    tmdb_edges: dict[tuple[str, str], float] = {}
    extra: set[str] = set()
    for key in sorted(new_keys):
        edges = tmdb_rank_edges(key, tmdb.recommendations(key), tmdb.similar(key))
        tmdb_edges.update(edges)
        extra |= {dst for _, dst in edges}
    catalog |= new_keys

    # 3. Optional Trakt related shows.
    trakt_edges: dict[tuple[str, str], float] = {}
    if cfg.trakt_client_id:
        from .trakt import TraktClient, trakt_edges as get_trakt_edges

        trakt_edges = get_trakt_edges(TraktClient(cfg.trakt_client_id, cfg.cache_dir),
                                      sorted(k for k in catalog if k.startswith("tv:")))
        extra |= {dst for _, dst in trakt_edges}
    else:
        log.info("TRAKT_CLIENT_ID not set; skipping Trakt.")

    # 4. Reddit X -> Y edges (films and TV, cross-type allowed).
    reddit_edges: dict[tuple[str, str], float] = {}
    if cfg.has_reddit:
        client = RedditClient(
            cfg.reddit_client_id, cfg.reddit_client_secret, cfg.reddit_user_agent, cfg.reddit_username, cfg.reddit_password
        )
        reddit_edges = mine_edges(client.threads(cfg.reddit_max_posts), resolver, load_llm_extractor(cfg.llm_extractor))
        extra |= {k for edge in reddit_edges for k in edge}
    else:
        log.warning("Reddit credentials not set; skipping Reddit edges.")

    # 5. Curator picks (Letterboxd RSS, optional Instagram Business Discovery), accumulated across runs.
    curators = cur.load_curators()
    prev_picks, last_fetched = cur.load_previous(cfg.output_dir)
    new_picks: list[cur.Pick] = []
    if cfg.curators_enabled:
        new_picks = cur.collect_picks(
            curators, resolver, cfg.min_year, cfg.ig_user_id, cfg.ig_access_token, last_fetched=last_fetched
        )
        if not (cfg.ig_user_id and cfg.ig_access_token):
            log.info("IG_USER_ID/IG_ACCESS_TOKEN not set; skipping Instagram Business Discovery.")
    picks = cur.merge_history(prev_picks, new_picks)

    # Bound catalogue growth from edge targets: keep curator picks, then the titles
    # referenced by the most edges (not key order, which would favour "movie:" over "tv:").
    refs: Counter[str] = Counter()
    for edges in (tmdb_edges, trakt_edges, reddit_edges):
        for src, dst in edges:
            refs[dst] += 1
            refs[src] += 1
    pick_keys = {p.key for p in picks} - catalog
    ranked = sorted((k for k in extra | set(refs) if k not in catalog and k not in pick_keys), key=lambda k: -refs[k])
    extra = pick_keys | set(ranked[: max(0, MAX_EXTRA_TITLES - len(pick_keys))])
    catalog |= extra

    # 6. Metadata for every title (poster, overview, genres, runtime, seasons, providers).
    log.info("Fetching TMDB details for %d titles", len(catalog))
    titles: dict[str, Title] = {}
    for i, key in enumerate(sorted(catalog)):
        t = title_from_details(tmdb.details(key), region, ml_years.get(key))
        if t and t.year >= cfg.min_year:
            titles[key] = t
        if i and i % 1000 == 0:
            log.info("  %d/%d (requests: %d)", i, len(catalog), tmdb.requests_made)

    genres = {**TMDB_GENRES, **tmdb.genres()}
    providers = tmdb.providers(region)
    counts = {
        "movielensEdges": sum(map(len, ml_neighbors.values())), "redditEdges": len(reddit_edges),
        "tmdbEdges": len(tmdb_edges), "traktEdges": len(trakt_edges),
    }
    top_k = cfg.top_k
    limit = cfg.max_artifact_mb * 1024 * 1024
    while True:
        neighbors = merge_edges(ml_neighbors, reddit_edges, tmdb_edges, set(titles), cap=top_k + 20, trakt=trakt_edges)
        size = write_artifact(
            cfg.output_dir, titles, neighbors, shards=cfg.shards, region=region, min_year=cfg.min_year,
            sample=False, genres=genres, providers=providers, counts=counts,
            curators=cur.public_curators(curators), picks=picks, last_fetched=last_fetched,
        )
        if size <= limit or top_k <= 10:
            break
        top_k -= 10
        log.warning("Artifact %.1f MB exceeds %.0f MB; retrying with top_k=%d", size / 2**20, cfg.max_artifact_mb, top_k)
    log.info("Wrote artifact: %d titles, %.1f MB -> %s", len(titles), size / 2**20, cfg.output_dir)
    return 0 if size <= limit else 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sample", action="store_true", help="build the offline sample artifact")
    parser.add_argument("--out", type=Path, help="output directory (default: public/data)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config()
    if args.out:
        cfg.output_dir = args.out
    return run_sample(cfg) if args.sample else run_full(cfg)


if __name__ == "__main__":
    sys.exit(main())
