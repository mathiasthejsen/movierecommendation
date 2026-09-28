"""Optional Trakt "related shows" edges (only when TRAKT_CLIENT_ID is set)."""

from __future__ import annotations

import hashlib
import json
import logging
import time
from pathlib import Path

import requests

log = logging.getLogger(__name__)

API = "https://api.trakt.tv"


class TraktClient:
    def __init__(self, client_id: str, cache_dir: Path | None = None, ttl_days: float = 13):
        self.session = requests.Session()
        self.session.headers.update(
            {"trakt-api-version": "2", "trakt-api-key": client_id, "Content-Type": "application/json",
             "User-Agent": "personal-movie-recommender/0.1"}
        )
        self.cache_dir = cache_dir / "trakt" if cache_dir else None
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.ttl = ttl_days * 86400

    def _get(self, path: str, **params) -> list:
        cp = None
        if self.cache_dir:
            cp = self.cache_dir / (hashlib.sha1(json.dumps([path, sorted(params.items())]).encode()).hexdigest() + ".json")
            if cp.exists() and time.time() - cp.stat().st_mtime < self.ttl:
                return json.loads(cp.read_text("utf-8"))
        for _ in range(4):
            resp = self.session.get(f"{API}{path}", params=params, timeout=30)
            if resp.status_code == 429:
                time.sleep(float(resp.headers.get("Retry-After", 5)))
                continue
            data = resp.json() if resp.status_code == 200 else []
            break
        else:
            data = []
        time.sleep(0.35)  # well under Trakt's GET rate limit
        if cp:
            cp.write_text(json.dumps(data), "utf-8")
        return data

    def related_shows(self, tv_tmdb_id: int, limit: int = 20) -> list[int]:
        found = self._get(f"/search/tmdb/{tv_tmdb_id}", type="show")
        if not found:
            return []
        trakt_id = found[0].get("show", {}).get("ids", {}).get("trakt")
        if not trakt_id:
            return []
        related = self._get(f"/shows/{trakt_id}/related", limit=limit)
        return [s["ids"]["tmdb"] for s in related if s.get("ids", {}).get("tmdb")]


def trakt_edges(client: TraktClient, tv_keys: list[str]) -> dict[tuple[str, str], float]:
    edges: dict[tuple[str, str], float] = {}
    for key in tv_keys:
        tmdb_id = int(key.split(":", 1)[1])
        for i, rid in enumerate(client.related_shows(tmdb_id)):
            edges[(key, f"tv:{rid}")] = max(0.1, 0.9 - 0.035 * i)
    log.info("Trakt: %d related-show edges", len(edges))
    return edges
