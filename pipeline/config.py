"""Pipeline configuration, read from environment variables.

Secrets (TMDB key, Reddit credentials) are only ever read from the environment
and are never written to the artifact.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    raw = _env(name)
    return int(raw) if raw else default


@dataclass
class Config:
    tmdb_api_key: str = field(default_factory=lambda: _env("TMDB_API_KEY"))
    tmdb_read_token: str = field(default_factory=lambda: _env("TMDB_READ_TOKEN"))
    reddit_client_id: str = field(default_factory=lambda: _env("REDDIT_CLIENT_ID"))
    reddit_client_secret: str = field(default_factory=lambda: _env("REDDIT_CLIENT_SECRET"))
    reddit_username: str = field(default_factory=lambda: _env("REDDIT_USERNAME"))
    reddit_password: str = field(default_factory=lambda: _env("REDDIT_PASSWORD"))
    reddit_user_agent: str = field(
        default_factory=lambda: _env(
            "REDDIT_USER_AGENT", "personal-movie-recommender/0.1 (personal, non-commercial)"
        )
    )
    watch_region: str = field(default_factory=lambda: _env("WATCH_REGION", "US").upper())
    movielens_dir: Path = field(
        default_factory=lambda: Path(_env("MOVIELENS_DIR", str(REPO_ROOT / "data" / "raw" / "ml-32m")))
    )
    genome_dir: Path | None = field(
        default_factory=lambda: Path(_env("GENOME_DIR")) if _env("GENOME_DIR") else None
    )
    cache_dir: Path = field(
        default_factory=lambda: Path(_env("PIPELINE_CACHE_DIR", str(REPO_ROOT / "data" / "cache")))
    )
    output_dir: Path = field(
        default_factory=lambda: Path(_env("ARTIFACT_DIR", str(REPO_ROOT / "public" / "data")))
    )
    min_year: int = field(default_factory=lambda: _env_int("MIN_YEAR", 1980))
    min_ratings: int = field(default_factory=lambda: _env_int("MIN_RATINGS", 300))
    top_k: int = field(default_factory=lambda: _env_int("TOP_K", 50))
    max_movies: int = field(default_factory=lambda: _env_int("MAX_MOVIES", 9000))
    reddit_max_posts: int = field(default_factory=lambda: _env_int("REDDIT_MAX_POSTS", 400))
    popular_pages: int = field(default_factory=lambda: _env_int("TMDB_POPULAR_PAGES", 10))
    shards: int = field(default_factory=lambda: _env_int("NEIGHBOR_SHARDS", 32))
    max_artifact_mb: float = field(default_factory=lambda: float(_env("MAX_ARTIFACT_MB", "20")))
    llm_extractor: str = field(default_factory=lambda: _env("LLM_EXTRACTOR"))
    tv_pages: int = field(default_factory=lambda: _env_int("TMDB_TV_PAGES", 8))
    trakt_client_id: str = field(default_factory=lambda: _env("TRAKT_CLIENT_ID"))
    ig_user_id: str = field(default_factory=lambda: _env("IG_USER_ID"))
    ig_access_token: str = field(default_factory=lambda: _env("IG_ACCESS_TOKEN"))
    curators_enabled: bool = field(default_factory=lambda: _env("CURATORS_ENABLED", "true").lower() != "false")

    @property
    def has_tmdb(self) -> bool:
        return bool(self.tmdb_api_key or self.tmdb_read_token)

    @property
    def has_reddit(self) -> bool:
        return bool(self.reddit_client_id and self.reddit_client_secret)
