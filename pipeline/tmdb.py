"""Minimal TMDB v3 client with an on-disk JSON cache (pipeline only).

The key is read from TMDB_API_KEY (v3 key) or TMDB_READ_TOKEN (v4 bearer) and
is never written into the cache keys or the artifact. Titles are addressed by
composite keys: ``movie:603`` / ``tv:1396``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any

import requests

from .extract import Candidate, normalize_title

log = logging.getLogger(__name__)

API = "https://api.themoviedb.org/3"


def make_key(kind: str, tmdb_id: int | str) -> str:
    return f"{kind}:{int(tmdb_id)}"


def split_key(key: str) -> tuple[str, int]:
    kind, _, raw = key.partition(":")
    return kind, int(raw)


def result_key(r: dict, default_kind: str) -> str | None:
    kind = r.get("media_type", default_kind)
    if kind not in ("movie", "tv") or "id" not in r:
        return None
    return make_key(kind, r["id"])


def result_year(r: dict) -> int | None:
    d = r.get("release_date") or r.get("first_air_date") or ""
    return int(d[:4]) if d[:4].isdigit() else None


def jitter_fraction(name: str) -> float:
    """Stable value in [0, 1) derived from a cache entry name."""
    return int(hashlib.sha1(name.encode()).hexdigest()[:8], 16) / 0x100000000


class TMDBClient:
    def __init__(
        self, api_key: str = "", read_token: str = "", cache_dir: Path | None = None, ttl_days: float = 3, ttl_jitter_days: float = 2
    ):
        if not (api_key or read_token):
            raise ValueError("TMDB_API_KEY or TMDB_READ_TOKEN is required")
        self.session = requests.Session()
        self._params: dict[str, str] = {}
        if read_token:
            self.session.headers["Authorization"] = f"Bearer {read_token}"
        else:
            self._params["api_key"] = api_key
        self.cache_dir = cache_dir / "tmdb" if cache_dir else None
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        # Default TTL is 3-5 days, fixed per cache entry (hash-based), so the daily run refreshes
        # roughly a quarter of the titles each day instead of everything on the same day.
        self.ttl = ttl_days * 86400
        self.ttl_jitter = ttl_jitter_days * 86400
        self.requests_made = 0

    def _cache_path(self, path: str, params: dict) -> Path | None:
        if not self.cache_dir:
            return None
        key = json.dumps([path, sorted(params.items())], separators=(",", ":"))
        return self.cache_dir / f"{hashlib.sha1(key.encode()).hexdigest()}.json"

    def _ttl(self, cp: Path | None, path: str, ttl: float | None) -> float:
        return (self.ttl + jitter_fraction(cp.name if cp else path) * self.ttl_jitter) if ttl is None else ttl

    def is_fresh(self, path: str, ttl: float | None = None, **params: Any) -> bool:
        """True when `get` would be answered from the cache (no request)."""
        params = {k: v for k, v in params.items() if v is not None}
        cp = self._cache_path(path, params)
        return bool(cp and cp.exists() and time.time() - cp.stat().st_mtime < self._ttl(cp, path, ttl))

    def peek(self, path: str, **params: Any) -> dict | None:
        """Any cached copy, however old (used when the per-run request budget is spent)."""
        params = {k: v for k, v in params.items() if v is not None}
        cp = self._cache_path(path, params)
        if cp and cp.exists():
            try:
                return json.loads(cp.read_text("utf-8"))
            except ValueError:
                return None
        return None

    def get(self, path: str, ttl: float | None = None, **params: Any) -> dict:
        params = {k: v for k, v in params.items() if v is not None}
        cp = self._cache_path(path, params)
        if cp and cp.exists() and time.time() - cp.stat().st_mtime < self._ttl(cp, path, ttl):
            return json.loads(cp.read_text("utf-8"))
        data: dict = {}
        for attempt in range(5):
            resp = self.session.get(f"{API}{path}", params={**self._params, **params}, timeout=30)
            self.requests_made += 1
            if resp.status_code == 429:
                time.sleep(float(resp.headers.get("Retry-After", 2)))
                continue
            if resp.status_code == 404:
                break
            if resp.status_code >= 500:
                time.sleep(2**attempt)
                continue
            resp.raise_for_status()
            data = resp.json()
            break
        else:
            raise RuntimeError(f"TMDB request failed repeatedly: {path}")
        time.sleep(0.03)
        if cp:
            cp.write_text(json.dumps(data), "utf-8")
        return data

    # --- endpoints -----------------------------------------------------------------
    def details(self, key: str) -> dict:
        kind, tmdb_id = split_key(key)
        # Keywords ride along with details (same request, same 3-5 day TTL) for the content bridge.
        d = self.get(f"/{kind}/{tmdb_id}", append_to_response="watch/providers,keywords")
        if d:
            d["media_type"] = kind
        return d

    def recommendations(self, key: str) -> list[dict]:
        kind, tmdb_id = split_key(key)
        return self.get(f"/{kind}/{tmdb_id}/recommendations").get("results", [])

    def similar(self, key: str) -> list[dict]:
        kind, tmdb_id = split_key(key)
        return self.get(f"/{kind}/{tmdb_id}/similar").get("results", [])

    def neighbors_budgeted(self, key: str, budget: list[int]) -> tuple[list[dict], list[dict]] | None:
        """recommendations + similar for `key`, spending at most budget[0] uncached requests.

        When the budget is spent, a stale cached copy is used if there is one, else None
        (that title is picked up on a later daily run).
        """
        kind, tmdb_id = split_key(key)
        paths = [f"/{kind}/{tmdb_id}/recommendations", f"/{kind}/{tmdb_id}/similar"]
        missing = [p for p in paths if not self.is_fresh(p)]
        if missing and budget[0] >= len(missing):
            budget[0] -= len(missing)
            return self.recommendations(key), self.similar(key)
        if missing:
            cached = [self.peek(p) for p in paths]
            if all(x is None for x in cached):
                return None
            recs, sims = ((x or {}).get("results", []) for x in cached)
            return recs, sims
        return self.recommendations(key), self.similar(key)

    def search(self, title: str, year: int | None = None, kind: str | None = None) -> list[dict]:
        ttl = 30 * 86400
        if kind == "movie":
            res = self.get("/search/movie", ttl=ttl, query=title, year=year, include_adult="false").get("results", [])
            return [{**r, "media_type": "movie"} for r in res]
        if kind == "tv":
            res = self.get("/search/tv", ttl=ttl, query=title, first_air_date_year=year, include_adult="false").get(
                "results", []
            )
            return [{**r, "media_type": "tv"} for r in res]
        res = self.get("/search/multi", ttl=ttl, query=title, include_adult="false").get("results", [])
        return [r for r in res if r.get("media_type") in ("movie", "tv")]

    def genres(self) -> dict[int, str]:
        out: dict[int, str] = {}
        for kind in ("movie", "tv"):
            for g in self.get(f"/genre/{kind}/list", ttl=30 * 86400).get("genres", []):
                out.setdefault(g["id"], g["name"])
        return out

    def providers(self, region: str) -> dict[int, dict]:
        out: dict[int, dict] = {}
        for kind in ("movie", "tv"):
            for p in self.get(f"/watch/providers/{kind}", ttl=7 * 86400, watch_region=region).get("results", []):
                out.setdefault(
                    p["provider_id"],
                    {"name": p["provider_name"], "logo": p.get("logo_path"), "rank": p.get("display_priority", 999)},
                )
        return out

    def recent_popular(self, pages: int, region: str) -> list[dict]:
        """Popular and newly released films (the daily refresh keeps new releases covered)."""
        since = (date.today() - timedelta(days=730)).isoformat()
        out: list[dict] = []
        for page in range(1, pages + 1):
            out += self.get("/movie/popular", ttl=86400, page=page, region=region).get("results", [])
            out += self.get(
                "/discover/movie", ttl=86400, page=page, sort_by="popularity.desc",
                **{"primary_release_date.gte": since, "vote_count.gte": 50},
            ).get("results", [])
        for page in range(1, max(2, pages // 3) + 1):
            out += self.get("/movie/now_playing", ttl=86400, page=page, region=region).get("results", [])
        return [{**r, "media_type": "movie"} for r in out]

    def popular_tv(self, pages: int, min_year: int) -> list[dict]:
        """Well-known and current series (first aired >= min_year)."""
        out: list[dict] = []
        for page in range(1, pages + 1):
            out += self.get(
                "/discover/tv", ttl=86400, page=page, sort_by="vote_count.desc",
                **{"first_air_date.gte": f"{min_year}-01-01", "vote_count.gte": 200},
            ).get("results", [])
            out += self.get("/tv/popular", ttl=86400, page=page).get("results", [])
        for page in range(1, max(2, pages // 3) + 1):
            out += self.get("/tv/on_the_air", ttl=86400, page=page).get("results", [])
            out += self.get("/tv/top_rated", ttl=86400, page=page).get("results", [])
        return [{**r, "media_type": "tv"} for r in out]


class TMDBResolver:
    """Validate an extracted title against TMDB search; returns a composite key.

    Searches the hinted type first (from "(TV series)" markers or the thread's
    context), then falls back to /search/multi so cross-type matches still work.
    """

    def __init__(self, client: TMDBClient, min_year: int = 1980):
        self.client = client
        self.min_year = min_year
        self._memo: dict[tuple[str, int | None, str | None], str | None] = {}

    def __call__(self, cand: Candidate, context: str | None = None) -> str | None:
        kind = cand.kind or context
        memo_key = (normalize_title(cand.title), cand.year, kind)
        if memo_key not in self._memo:
            self._memo[memo_key] = self._resolve(cand, kind)
        return self._memo[memo_key]

    def _resolve(self, cand: Candidate, kind: str | None) -> str | None:
        norm = normalize_title(cand.title)
        if len(norm) < 2:
            return None
        results: list[dict] = []
        if kind:
            results = self.client.search(cand.title, cand.year, kind) or (
                self.client.search(cand.title, None, kind) if cand.year else []
            )
        best = pick_best(results, cand, kind)
        if best is None:
            best = pick_best(self.client.search(cand.title), cand, kind)
        return best


def pick_best(results: list[dict], cand: Candidate, kind: str | None) -> str | None:
    norm = normalize_title(cand.title)
    best, best_score = None, 0.0
    for r in results[:10]:
        names = {normalize_title(r.get(k, "")) for k in ("title", "original_title", "name", "original_name")}
        if norm not in names:
            continue
        key = result_key(r, kind or "movie")
        if key is None:
            continue
        y = result_year(r)
        score = 1.0 + min(float(r.get("vote_count", 0)), 5000) / 5000
        if kind and key.startswith(kind + ":"):
            score += 0.75
        if cand.year and y:
            score += 1.0 if abs(cand.year - y) <= 1 else -1.0
        if score > best_score and float(r.get("vote_count", 0)) >= 20:
            best, best_score = key, score
    return best
