"""Curator picks from official feeds (no scraping).

Sources, all optional and driven by ``config/curators.json``:

* Letterboxd public RSS (``https://letterboxd.com/<username>/rss/``): diary
  entries rated >= 4 stars or liked become picks; films inside list entries
  (e.g. Martin Scorsese's lists) become lower-weight picks. Items carry
  ``tmdb:movieId`` / ``tmdb:tvId``; otherwise title + year is matched via TMDB.
* Instagram Graph API Business Discovery (only if IG_USER_ID + IG_ACCESS_TOKEN
  are set, and only for Business/Creator accounts): captions are parsed in
  memory for titles; only TMDB keys and permalinks are kept.

Picks accumulate across daily runs (RSS only returns ~50 recent items): the
previous ``curators.json`` history in the artifact is merged and de-duplicated.
Only keys, rating, like flag and links are stored: never review text or captions.
"""

from __future__ import annotations

import html
import json
import logging
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import asdict, dataclass
from datetime import date
from pathlib import Path
from typing import Callable, Iterable

import requests

from .config import REPO_ROOT
from .extract import Candidate, extract_caption

log = logging.getLogger(__name__)

CURATORS_FILE = REPO_ROOT / "config" / "curators.json"
USER_AGENT = "personal-movie-recommender/0.1 (+daily RSS fetch; personal non-commercial use)"
FETCH_DELAY_S = 2.0
LIST_WEIGHT = 0.5
MIN_STARS = 4.0
MAX_PICKS_PER_CURATOR = 600
MIN_REFETCH_DAYS = 1  # the pipeline runs daily; one polite RSS read per curator per day
GRAPH_API = "https://graph.facebook.com/v21.0"

Resolver = Callable[[Candidate, "str | None"], "str | None"]


@dataclass
class Curator:
    handle: str
    name: str = ""
    instagram: str = ""
    tiktok: str = ""
    youtube: str = ""
    letterboxd: str = ""
    own: bool = False
    weight: float = 0.6
    enabled: bool = True
    verify: bool = False
    note: str = ""


@dataclass
class Pick:
    key: str  # "movie:603" / "tv:1396"
    curator: str
    source: str  # "letterboxd" | "letterboxd-list" | "instagram"
    url: str
    weight: float  # 0-1 strength of the pick itself (curator weight is applied in the app)
    rating: float | None = None
    liked: bool = False
    first_seen: str = ""


def load_curators(path: Path = CURATORS_FILE) -> list[Curator]:
    data = json.loads(path.read_text("utf-8"))
    fields = Curator.__dataclass_fields__
    return [Curator(**{k: v for k, v in c.items() if k in fields}) for c in data["curators"]]


# --- Letterboxd RSS ----------------------------------------------------------------

@dataclass
class FeedEntry:
    title: str
    year: int | None
    link: str
    tmdb_key: str | None
    rating: float | None
    liked: bool
    is_list: bool = False


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


LIST_FILM_RE = re.compile(r'<li[^>]*>\s*<a[^>]+href="(https://letterboxd\.com/film/[^"]+)"[^>]*>(.*?)</a>', re.I | re.S)
TITLE_YEAR_RE = re.compile(r"^(.*?),\s*((?:19|20)\d{2})(?:\s+-\s+.*)?$")


def parse_letterboxd_rss(xml_text: str) -> list[FeedEntry]:
    """Parse diary/review items and list items from a Letterboxd RSS feed."""
    root = ET.fromstring(xml_text)
    entries: list[FeedEntry] = []
    for item in root.iter("item"):
        fields: dict[str, str] = {}
        for child in item:
            fields[_local(child.tag)] = (child.text or "").strip()
        link = fields.get("link", "")
        if "/list/" in link:
            desc = fields.get("description", "")
            for film_url, raw_title in LIST_FILM_RE.findall(desc):
                title = html.unescape(re.sub(r"<[^>]+>", "", raw_title)).strip()
                if title:
                    entries.append(FeedEntry(title, None, film_url, None, None, False, is_list=True))
            continue
        title = fields.get("filmTitle")
        if not title:
            m = TITLE_YEAR_RE.match(fields.get("title", ""))
            if not m:
                continue
            title = m.group(1)
            fields.setdefault("filmYear", m.group(2))
        year = int(fields["filmYear"]) if fields.get("filmYear", "").isdigit() else None
        tmdb_key = None
        if fields.get("movieId", "").isdigit():
            tmdb_key = f"movie:{fields['movieId']}"
        elif fields.get("tvId", "").isdigit():
            tmdb_key = f"tv:{fields['tvId']}"
        try:
            rating = float(fields["memberRating"]) if fields.get("memberRating") else None
        except ValueError:
            rating = None
        if rating is None and (stars := re.search(r"\s-\s([★]*)(½?)\s*$", fields.get("title", ""))):
            rating = len(stars.group(1)) + (0.5 if stars.group(2) else 0) or None
        liked = fields.get("memberLike", "").lower() in ("yes", "true", "1")
        entries.append(FeedEntry(html.unescape(title), year, link, tmdb_key, rating, liked))
    return entries


def entries_to_picks(
    entries: Iterable[FeedEntry], curator: str, resolve: Resolver | None, min_year: int, year_of: Callable[[str], int | None] | None = None
) -> list[Pick]:
    """Keep rated >= 4 stars or liked diary entries, plus list films at lower weight."""
    today = date.today().isoformat()
    picks: list[Pick] = []
    for e in entries:
        if not e.is_list and not ((e.rating or 0) >= MIN_STARS or e.liked):
            continue
        if e.year is not None and e.year < min_year:
            continue
        key = e.tmdb_key or (resolve(Candidate(e.title, e.year, "movie"), "movie") if resolve else None)
        if not key:
            continue
        if e.year is None and year_of is not None and (y := year_of(key)) is not None and y < min_year:
            continue
        if e.is_list:
            weight = LIST_WEIGHT
        else:
            weight = 0.8 if e.rating is None else min(1.0, 0.5 + e.rating / 10)  # 4★ -> 0.9, 5★ -> 1.0
        picks.append(
            Pick(key, curator, "letterboxd-list" if e.is_list else "letterboxd", e.link, round(weight, 2),
                 e.rating, e.liked, today)
        )
    return picks


def fetch_letterboxd(username: str, session: requests.Session) -> str | None:
    url = f"https://letterboxd.com/{username}/rss/"
    resp = session.get(url, timeout=30)
    if resp.status_code == 404:
        log.warning("Letterboxd feed not found: %s", url)
        return None
    resp.raise_for_status()
    return resp.text


# --- Instagram Graph API (optional) ---------------------------------------------------

def fetch_instagram_captions(ig_user_id: str, token: str, username: str, session: requests.Session) -> list[tuple[str, str]]:
    """(caption, permalink) pairs for a public Business/Creator account via Business Discovery."""
    fields = f"business_discovery.username({username}){{media.limit(40){{caption,permalink,timestamp}}}}"
    resp = session.get(f"{GRAPH_API}/{ig_user_id}", params={"fields": fields, "access_token": token}, timeout=30)
    if resp.status_code >= 400:
        log.warning("Business Discovery failed for @%s (%s). Only Business/Creator accounts are supported.",
                    username, resp.json().get("error", {}).get("message", resp.status_code))
        return []
    media = resp.json().get("business_discovery", {}).get("media", {}).get("data", [])
    return [(m.get("caption") or "", m.get("permalink") or "") for m in media]


def captions_to_picks(captions: Iterable[tuple[str, str]], curator: str, resolve: Resolver) -> list[Pick]:
    today = date.today().isoformat()
    picks: list[Pick] = []
    for caption, permalink in captions:
        _, cands = extract_caption(caption)
        for c in cands:
            if key := resolve(c, c.kind):
                picks.append(Pick(key, curator, "instagram", permalink, 0.9, None, False, today))
    return picks  # captions are discarded here


# --- accumulate -------------------------------------------------------------------------

def merge_history(previous: Iterable[dict], new: Iterable[Pick]) -> list[Pick]:
    """Union of previous and new picks, de-duplicated on (curator, key); keeps the earliest first_seen."""
    merged: dict[tuple[str, str], Pick] = {}
    fields = Pick.__dataclass_fields__
    for raw in previous:
        p = Pick(**{k: v for k, v in raw.items() if k in fields})
        merged[(p.curator, p.key)] = p
    for p in new:
        old = merged.get((p.curator, p.key))
        if old is None:
            merged[(p.curator, p.key)] = p
        else:
            old.weight = max(old.weight, p.weight)
            old.rating = p.rating if p.rating is not None else old.rating
            old.liked = old.liked or p.liked
            if old.source == "letterboxd-list" and p.source != "letterboxd-list":
                old.source, old.url = p.source, p.url
    by_curator: dict[str, list[Pick]] = {}
    for p in merged.values():
        by_curator.setdefault(p.curator, []).append(p)
    out: list[Pick] = []
    for picks in by_curator.values():
        picks.sort(key=lambda p: p.first_seen, reverse=True)
        out += picks[:MAX_PICKS_PER_CURATOR]
    return sorted(out, key=lambda p: (p.curator, p.key))


def load_previous(artifact_dir: Path) -> tuple[list[dict], dict[str, str]]:
    """Previous (picks, last_fetched) from the last artifact, if any (sample artifacts are ignored)."""
    path = artifact_dir / "curators.json"
    if not path.exists():
        return [], {}
    try:
        data = json.loads(path.read_text("utf-8"))
    except (ValueError, OSError):
        return [], {}
    if data.get("sample"):
        return [], {}
    return data.get("picks", []), data.get("lastFetched", {})


def collect_picks(
    curators: list[Curator],
    resolve: Resolver | None,
    min_year: int,
    ig_user_id: str = "",
    ig_token: str = "",
    year_of: Callable[[str], int | None] | None = None,
    last_fetched: dict[str, str] | None = None,
) -> list[Pick]:
    """Fetch every enabled curator's feeds sequentially, politely, at most once a day.

    ``last_fetched`` (handle -> ISO date) is updated in place.
    """
    last_fetched = last_fetched if last_fetched is not None else {}
    today = date.today()
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    picks: list[Pick] = []
    first = True
    for c in curators:
        if not c.enabled:
            continue
        prev = last_fetched.get(c.handle)
        if prev and (today - date.fromisoformat(prev)).days < MIN_REFETCH_DAYS:
            log.info("Curator @%s fetched on %s; skipping until tomorrow", c.handle, prev)
            continue
        if not (c.letterboxd or (c.instagram and ig_user_id and ig_token)):
            continue
        last_fetched[c.handle] = today.isoformat()
        if c.letterboxd:
            if not first:
                time.sleep(FETCH_DELAY_S)
            first = False
            try:
                xml_text = fetch_letterboxd(c.letterboxd, session)
                if xml_text:
                    got = entries_to_picks(parse_letterboxd_rss(xml_text), c.handle, resolve, min_year, year_of)
                    log.info("Letterboxd @%s: %d picks", c.letterboxd, len(got))
                    picks += got
            except (requests.RequestException, ET.ParseError) as err:
                log.warning("Letterboxd @%s skipped: %s", c.letterboxd, err)
        if c.instagram and ig_user_id and ig_token and resolve:
            time.sleep(FETCH_DELAY_S)
            got = captions_to_picks(fetch_instagram_captions(ig_user_id, ig_token, c.instagram, session), c.handle, resolve)
            log.info("Instagram @%s: %d picks", c.instagram, len(got))
            picks += got
    return picks


def public_curators(curators: list[Curator]) -> list[dict]:
    return [
        {k: v for k, v in asdict(c).items() if k in ("handle", "name", "instagram", "tiktok", "youtube", "letterboxd", "own", "weight", "enabled")}
        for c in curators
    ]
