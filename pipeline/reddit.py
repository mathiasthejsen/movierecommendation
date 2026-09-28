"""Mine "if you liked X, try Y" edges from Reddit via the official OAuth API.

Uses a Reddit *script* app (client id/secret, optionally username/password).
Thread text is processed in memory only: the pipeline keeps nothing but
derived (seed_tmdb_id, target_tmdb_id) -> weight edges. No comment text, post
bodies or usernames are cached or written anywhere.
"""

from __future__ import annotations

import logging
import math
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Callable, Iterable, Iterator

import requests

from .extract import Candidate, context_kind, extract_candidate_titles, extract_seed_titles

log = logging.getLogger(__name__)

# subreddit -> default media context of its threads (None = mixed, decided per thread)
SUBREDDITS: dict[str, str | None] = {
    "MovieSuggestions": "movie",
    "movies": "movie",
    "televisionsuggestions": "tv",
    "NetflixBestOf": None,
}
QUERIES = {
    "movie": ('title:"movies like"', 'title:"similar to"', 'title:"if you liked"', 'title:"films like"'),
    "tv": ('title:"shows like"', 'title:"series like"', 'title:"similar to"', 'title:"if you liked"'),
}
REVERSE_WEIGHT = 0.5

# (candidate, thread media context) -> "movie:123" / "tv:456" or None
Resolver = Callable[[Candidate, "str | None"], "str | None"]


@dataclass
class Comment:
    body: str
    score: int


@dataclass
class Thread:
    title: str
    selftext: str
    score: int
    comments: list[Comment] = field(default_factory=list)
    context: str | None = None  # "movie" / "tv" / None (mixed)


class RedditClient:
    TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
    API = "https://oauth.reddit.com"

    def __init__(self, client_id: str, client_secret: str, user_agent: str, username: str = "", password: str = ""):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = user_agent
        self._auth = (client_id, client_secret)
        self._username, self._password = username, password
        self._token_expiry = 0.0

    def _ensure_token(self) -> None:
        if time.time() < self._token_expiry - 60:
            return
        data = (
            {"grant_type": "password", "username": self._username, "password": self._password}
            if self._username and self._password
            else {"grant_type": "client_credentials"}
        )
        resp = self.session.post(self.TOKEN_URL, auth=self._auth, data=data, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        if "access_token" not in payload:
            raise RuntimeError(f"Reddit auth failed: {payload.get('error', 'unknown error')}")
        self.session.headers["Authorization"] = f"bearer {payload['access_token']}"
        self._token_expiry = time.time() + float(payload.get("expires_in", 3600))

    def _get(self, path: str, params: dict) -> dict | list:
        for attempt in range(4):
            self._ensure_token()
            resp = self.session.get(f"{self.API}{path}", params={**params, "raw_json": 1}, timeout=30)
            remaining = float(resp.headers.get("x-ratelimit-remaining", "10") or 10)
            if resp.status_code == 429 or remaining < 2:
                wait = float(resp.headers.get("x-ratelimit-reset", "10") or 10)
                log.info("Reddit rate limit, sleeping %.0fs", wait)
                time.sleep(min(wait, 120))
                if resp.status_code == 429:
                    continue
            resp.raise_for_status()
            time.sleep(0.7)  # stay well under 100 requests/minute
            return resp.json()
        raise RuntimeError(f"Reddit request kept failing: {path}")

    def search(self, subreddit: str, query: str, limit: int, time_filter: str = "year") -> Iterator[dict]:
        after = None
        fetched = 0
        while fetched < limit:
            listing = self._get(
                f"/r/{subreddit}/search",
                {"q": query, "restrict_sr": 1, "sort": "top", "t": time_filter, "limit": 100, "after": after},
            )
            children = listing.get("data", {}).get("children", [])
            for child in children:
                fetched += 1
                yield child["data"]
            after = listing.get("data", {}).get("after")
            if not after or not children:
                break

    def comments(self, post_id: str, limit: int = 200) -> list[Comment]:
        data = self._get(f"/comments/{post_id}", {"limit": limit, "depth": 2, "sort": "top"})
        out: list[Comment] = []

        def walk(nodes: list) -> None:
            for node in nodes:
                if node.get("kind") != "t1":
                    continue
                d = node["data"]
                out.append(Comment(body=d.get("body", ""), score=int(d.get("score", 0))))
                replies = d.get("replies")
                if isinstance(replies, dict):
                    walk(replies.get("data", {}).get("children", []))

        if isinstance(data, list) and len(data) > 1:
            walk(data[1].get("data", {}).get("children", []))
        return out

    def threads(self, max_posts: int) -> Iterator[Thread]:
        seen: set[str] = set()
        per_query = max(10, max_posts // (len(SUBREDDITS) * 4))
        for sub, sub_context in SUBREDDITS.items():
            queries = QUERIES[sub_context] if sub_context else tuple(dict.fromkeys(QUERIES["movie"] + QUERIES["tv"]))
            for q in queries:
                for post in self.search(sub, q, per_query):
                    if post["id"] in seen or post.get("num_comments", 0) < 3:
                        continue
                    seen.add(post["id"])
                    yield Thread(
                        title=post.get("title", ""),
                        selftext=post.get("selftext", ""),
                        score=int(post.get("score", 0)),
                        comments=self.comments(post["id"]),
                        context=sub_context,
                    )
                    if len(seen) >= max_posts:
                        return

def mine_edges(
    threads: Iterable[Thread],
    resolve: Resolver,
    llm_extract: Callable[[str], list[Candidate]] | None = None,
) -> dict[tuple[int, int], float]:
    """Aggregate upvote-weighted X -> Y edges between TMDB ids.

    A comment with score s recommending n titles contributes
    log1p(s) / sqrt(n) to each (seed, title) pair; reverse edges get half weight.
    """
    edges: dict[tuple[str, str], float] = defaultdict(float)
    n_threads = 0
    for thread in threads:
        context = context_kind(thread.title) or thread.context
        seeds = {sid for c in extract_seed_titles(thread.title, thread.selftext) if (sid := resolve(c, context))}
        if not seeds:
            continue
        n_threads += 1
        for comment in thread.comments:
            if comment.score <= 0:
                continue
            cands = extract_candidate_titles(comment.body, context)
            if llm_extract is not None:
                cands = cands + llm_extract(comment.body)
            targets = {tid for c in cands if (tid := resolve(c, context))} - seeds
            if not targets:
                continue
            w = math.log1p(comment.score) / math.sqrt(len(targets))
            for s in seeds:
                for t in targets:
                    edges[(s, t)] += w
                    edges[(t, s)] += w * REVERSE_WEIGHT
    log.info("Mined %d Reddit edges from %d threads", len(edges), n_threads)
    return dict(edges)
