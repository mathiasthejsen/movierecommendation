"""Heuristic title extraction from Reddit threads and social captions.

Jobs:

* ``extract_seed_titles`` finds the titles a post asks about
  ("Movies like Donnie Darko and Primer?", "Shows like Dark?").
* ``extract_candidate_titles`` finds the titles a comment recommends, using
  markdown bold/italic text, list items and "Title (Year)" patterns, and tells
  films and series apart from "(TV series)" / "(2008-2013)" markers and context.
* ``extract_caption`` splits a caption/shared text into (seeds, picks).

Candidates are *not* trusted: the caller validates each one against TMDB
search. For better recall an optional LLM extractor can be plugged in via
``LLM_EXTRACTOR=package.module:callable`` (see ``load_llm_extractor``).
Only the resulting (title, year) pairs are used; no Reddit text is stored.
"""

from __future__ import annotations

import importlib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Callable, Iterable, Protocol


MediaKind = str  # "movie" | "tv"


@dataclass(frozen=True)
class Candidate:
    title: str
    year: int | None = None
    # Media-type hint from the text ("movie", "tv") or None when unknown.
    kind: MediaKind | None = field(default=None, compare=False)


class LLMExtractor(Protocol):
    def __call__(self, text: str) -> Iterable[Candidate | tuple[str, int | None] | str]: ...


TV_MARKER_RE = re.compile(
    r"\s*[\(\[]\s*(?:tv(?:\s+(?:series|show|mini-?series))?|series|show|mini-?series|limited series|docuseries|anime series)\s*[\)\]]"
    r"|\s+(?:tv series|tv show|miniseries|limited series)\s*$",
    re.I,
)
FILM_MARKER_RE = re.compile(r"\s*[\(\[]\s*(?:film|movie)\s*[\)\]]|\s+\(the movie\)\s*$", re.I)
YEAR_RANGE_RE = re.compile(r"[\s,]*[\(\[]\s*((?:19|20)\d{2})\s*[-–—]\s*(?:(?:19|20)\d{2}|present|now)?\s*[\)\]]", re.I)
SEASON_RE = re.compile(r"\b(?:season|seasons|s\d{1,2}(?:e\d{1,2})?|episodes?)\b", re.I)
TV_CONTEXT_RE = re.compile(r"\b(?:shows?|series|tv|television|sitcoms?|anime|miniseries|binge)\b", re.I)
FILM_CONTEXT_RE = re.compile(r"\b(?:movies?|films?|cinema)\b", re.I)
EMOJI_OR_SYMBOL = {"So", "Sk", "Cs"}

YEAR_SUFFIX_RE = re.compile(r"[\s,]*[\(\[]\s*((?:19|20)\d{2})\s*[\)\]]\s*$")
YEAR_INLINE_RE = re.compile(r"^(.{1,80}?)\s*[\(\[]((?:19|20)\d{2})[\)\]]")
YEAR_COMMA_RE = re.compile(r"^(.{1,80}?),\s*((?:19|20)\d{2})$")
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\([^)]*\)")
URL_RE = re.compile(r"https?://\S+")
BOLD_RE = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
ITALIC_RE = re.compile(r"(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])|(?<![_\w])_(?=\S)([^_\n]+?)(?<=\S)_(?![_\w])")
LIST_ITEM_RE = re.compile(r"^\s*(?:[-*+•]|\d{1,3}[.)])\s+(.+?)\s*$")
TRAILING_DESC_RE = re.compile(r"(?:\s+(?:[-–—|]|[Dd]irected by|[Dd]ir\.)\s+|[:,]\s+(?=[a-z])).*$")

SEED_PATTERNS = [
    re.compile(r"\b(?P<w>movies?|films?|shows?|series|tv shows?|tv series|sitcoms?|anime|something|anything|stuff|recommendations?|recs?)\s+(?:just\s+)?(?:like|similar to|in the vein of|along the lines of)\s+(?P<x>.+)", re.I),
    re.compile(r"\bif (?:you|i|u)\s+(?:liked|loved|enjoyed|like|love|enjoy)\s+(?P<x>.+)", re.I),
    re.compile(r"\b(?:looking for|want|need)\s+(?:more\s+)?(?P<w>movies?|films?|shows?|series)?\s*(?:like|similar to)\s+(?P<x>.+)", re.I),
    re.compile(r"^\s*(?:similar to|like)\s+(?P<x>.+)", re.I),
]
SEED_STOP_RE = re.compile(
    r"(?:\?|!|\.\s|\.$|,?\s+(?:what|which|then|try|any|anyone|please|pls|suggest|recommend|you|need|must|worth|i(?:'m| am)|for (?:a|my|the)|but|because|that|with)\b).*$",
    re.I,
)
SPLIT_RE = re.compile(r"\s*(?:,|;|/|&|\+|\band\b|\bor\b|\bvs\.?\b)\s*", re.I)

STOPWORDS = {
    "edit", "update", "spoiler", "spoilers", "this", "that", "yes", "no", "thanks", "thank you",
    "imo", "honestly", "definitely", "seriously", "also", "note", "tldr", "tl;dr", "movie", "movies",
    "film", "films", "the movie", "watch", "highly recommend", "must watch", "so good", "great",
    "show", "shows", "series", "tv", "season", "episode", "link in bio", "follow", "save this",
    "masterpiece", "underrated", "this one", "all of them", "anything", "everything", "none",
}
MAX_WORDS = 10


def normalize_title(title: str) -> str:
    """Lowercase, strip accents/punctuation and leading articles for matching."""
    s = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()
    s = s.lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"^(the|a|an)\s+", "", s.strip())
    return re.sub(r"\s+", " ", s).strip()


def _strip_markdown(text: str) -> str:
    text = MD_LINK_RE.sub(r"\1", text)
    text = URL_RE.sub("", text)
    return text.replace("\\", "")


def context_kind(text: str) -> MediaKind | None:
    """Guess whether a post/caption talks about TV or films."""
    tv = bool(TV_CONTEXT_RE.search(text) or SEASON_RE.search(text))
    film = bool(FILM_CONTEXT_RE.search(text))
    if tv and not film:
        return "tv"
    if film and not tv:
        return "movie"
    return None


def split_year(raw: str) -> Candidate:
    s = raw.strip().strip("\"'“”‘’*_`").strip()
    kind: MediaKind | None = None
    if TV_MARKER_RE.search(s):
        s, kind = TV_MARKER_RE.sub("", s).strip(), "tv"
    elif FILM_MARKER_RE.search(s):
        s, kind = FILM_MARKER_RE.sub("", s).strip(), "movie"
    m = YEAR_RANGE_RE.search(s)
    if m:  # "Dark (2017-2020)" / "Severance (2022–)" -> a series
        return Candidate(s[: m.start()].strip(), int(m.group(1)), "tv")
    m = YEAR_SUFFIX_RE.search(s)
    if m:
        return Candidate(s[: m.start()].strip(), int(m.group(1)), kind)
    m = YEAR_INLINE_RE.match(s)
    if m:
        return Candidate(m.group(1).strip(), int(m.group(2)), kind)
    m = YEAR_COMMA_RE.match(s)
    if m:
        return Candidate(m.group(1).strip(), int(m.group(2)), kind)
    return Candidate(s, None, kind)


def _clean_candidate(raw: str, kind: MediaKind | None = None) -> Candidate | None:
    raw = _strip_markdown(raw)
    raw = re.sub(r"[*_`]+", "", raw).strip()
    marker = ""
    if (tm := TV_MARKER_RE.search(raw)) or (tm := FILM_MARKER_RE.search(raw)):
        marker = tm.group(0).strip()
    range_m = YEAR_RANGE_RE.search(raw)
    # "Title (2004) - a great mind bender" -> keep the part with the year.
    m = YEAR_INLINE_RE.match(raw)
    if range_m:
        raw = raw[: range_m.end()]
    elif m:
        raw = f"{m.group(1)} ({m.group(2)})"
        if marker and marker not in raw:
            raw = f"{raw} {marker}"
    else:
        raw = TRAILING_DESC_RE.sub("", raw)
        if marker and marker not in raw:
            raw = f"{raw} {marker}"
    cand = split_year(raw)
    title = cand.title.strip(" .,:;!?-–—\"'“”‘’")
    if not title or len(title) > 80:
        return None
    if normalize_title(title) in STOPWORDS or title.lower() in STOPWORDS:
        return None
    if len(title.split()) > MAX_WORDS:
        return None
    if not re.search(r"[A-Za-z0-9]", title):
        return None
    return Candidate(title, cand.year, cand.kind or kind)


def _compatible(a: Candidate, b: Candidate) -> bool:
    if a.kind and b.kind and a.kind != b.kind:
        return False
    return not (a.year and b.year and abs(a.year - b.year) > 1)


def _dedupe(cands: Iterable[Candidate | None]) -> list[Candidate]:
    """Merge repeated mentions; "Fargo (1996)" and "Fargo (2014-2024)" stay separate."""
    seen: dict[str, list[int]] = {}
    out: list[Candidate] = []
    for c in cands:
        if c is None:
            continue
        key = normalize_title(c.title)
        if not key:
            continue
        match = next((i for i in seen.get(key, []) if _compatible(out[i], c)), None)
        if match is not None:
            prev = out[match]
            out[match] = Candidate(prev.title, prev.year or c.year, prev.kind or c.kind)
            continue
        seen.setdefault(key, []).append(len(out))
        out.append(c)
    return out

def extract_candidate_titles(body: str, kind: MediaKind | None = None) -> list[Candidate]:
    """Titles recommended in a comment body. ``kind`` is the thread's media context."""
    if not body:
        return []
    text = _strip_markdown(body)
    found: list[Candidate | None] = []
    for m in BOLD_RE.finditer(text):
        found.append(_clean_candidate(m.group(2) + _marker_after(text, m.end()), kind))
    for m in ITALIC_RE.finditer(text):
        found.append(_clean_candidate((m.group(1) or m.group(2)) + _marker_after(text, m.end()), kind))
    for line in text.splitlines():
        lm = LIST_ITEM_RE.match(line)
        if lm:
            item = lm.group(1)
            bold = BOLD_RE.search(item)
            found.append(_clean_candidate(bold.group(2) + _marker_after(item, bold.end()) if bold else item, kind))
            continue
        # Bare "Title (Year)" / "Title (2008-2013)" mentions anywhere in the line.
        for ym in re.finditer(
            r"((?:[A-Z0-9][\w'’:.!-]*\s?){1,8})\s*(\(((?:19|20)\d{2})(?:\s*[-–—]\s*(?:(?:19|20)\d{2}|present)?)?\))", line
        ):
            found.append(_clean_candidate(f"{ym.group(1).strip()} {ym.group(2)}", kind))
    # A short comment that is just a title ("Coherence" / "Primer (2004)").
    stripped = text.strip()
    if "\n" not in stripped and 0 < len(stripped.split()) <= 6 and not found:
        found.append(_clean_candidate(stripped, kind))
    return _dedupe(found)


def _marker_after(text: str, pos: int) -> str:
    """Keep a "(TV series)" / "(2008-2013)" hint written right after bold text."""
    m = re.match(r"\s*([\(\[][^\)\]]{1,20}[\)\]])", text[pos:])
    return f" {m.group(1)}" if m and (TV_MARKER_RE.search(m.group(1)) or FILM_MARKER_RE.search(m.group(1)) or YEAR_RANGE_RE.search(m.group(1)) or YEAR_SUFFIX_RE.search(m.group(1))) else ""


def extract_seed_titles(title: str, body: str = "") -> list[Candidate]:
    """Titles a post is asking about. Returns candidates incl. the unsplit phrase."""
    out: list[Candidate | None] = []
    for text in (title, body[:500] if body else ""):
        if not text:
            continue
        text = _strip_markdown(text)
        # Bold/italic in the post title or first lines usually marks the seed films.
        for m in BOLD_RE.finditer(text):
            out.append(_clean_candidate(m.group(2)))
        for pattern in SEED_PATTERNS:
            m = pattern.search(text)
            if not m:
                continue
            word = (m.groupdict().get("w") or "").lower()
            kind = "tv" if TV_CONTEXT_RE.search(word) else "movie" if FILM_CONTEXT_RE.search(word) else None
            phrase = SEED_STOP_RE.sub("", m.group("x")).strip(" .,:;!?\"'")
            if not phrase:
                continue
            # Try the whole phrase first (titles can contain "and"), then the parts.
            out.append(_clean_candidate(phrase, kind))
            for part in SPLIT_RE.split(phrase):
                out.append(_clean_candidate(part, kind))
            break
        if out:
            break
    return _dedupe(out)


def _strip_social(text: str) -> str:
    """Drop hashtags, @mentions and emoji (turned into line breaks) from captions/shares."""
    text = re.sub(r"(?<!\w)[#@][\w.]+", " ", text)
    chars = []
    for ch in text:
        if unicodedata.category(ch) in EMOJI_OR_SYMBOL or ch in "\u200d\ufe0f":
            chars.append("\n")
        else:
            chars.append(ch)
    text = "".join(chars)
    # Inline numbered lists: "1. Coherence (2013) 2. Primer" -> one item per line.
    text = re.sub(r"(?:(?<=\s)|^)(\d{1,2}[.)])\s+(?=\S)", r"\n\1 ", text)
    text = re.sub(r"[ \t]*[•|·▪►➡→][ \t]*", "\n- ", text)
    return text


def extract_caption(text: str) -> tuple[list[Candidate], list[Candidate]]:
    """(seeds, picks) from a social caption or shared text.

    Seeds are the reference titles ("Movies like Donnie Darko"); picks are the
    recommended titles. Used by the optional Instagram step; the web app ships
    the same rules in TypeScript for the Share Target page.
    """
    if not text:
        return [], []
    cleaned = _strip_social(_strip_markdown(text))
    kind = context_kind(text)
    lines = [ln.strip() for ln in cleaned.splitlines() if ln.strip()]
    seeds: list[Candidate] = []
    body_lines = lines
    if lines and any(p.search(lines[0]) for p in SEED_PATTERNS):
        seed_line, rest = lines[0], []
        # "Shows like Stranger Things: **Dark**, Severance and 1899" -> seed line + list.
        if (colon := re.search(r":\s+", seed_line)) and colon.start() > 0:
            after = seed_line[colon.end():]
            if re.search(r"\*\*|__|\((?:19|20)\d{2}|,|\band\b", after):
                seed_line = seed_line[: colon.start()]
                rest = [f"- {s.strip()}" for s in SPLIT_RE.split(after) if len(s.strip()) > 0]
        seeds = extract_seed_titles(seed_line)
        body_lines = rest + lines[1:]
    picks: list[Candidate] = []
    structured = [
        ln for ln in body_lines
        if LIST_ITEM_RE.match(ln) or BOLD_RE.search(ln) or re.search(r"\((?:19|20)\d{2}", ln)
    ]
    # With a list present, only list-like lines count; otherwise short title-like lines do.
    candidates = structured or [ln for ln in body_lines if len(ln.split()) <= 6 and not re.search(r"[.!?:]$", ln)]
    for line in candidates:
        picks += extract_candidate_titles(line, kind)
    seed_keys = {normalize_title(s.title) for s in seeds}
    picks = [p for p in _dedupe(picks) if normalize_title(p.title) not in seed_keys]
    return seeds, picks

def load_llm_extractor(spec: str) -> Callable[[str], list[Candidate]] | None:
    """Load an optional LLM-based extractor from ``module:callable``.

    The callable receives comment text and returns titles (strings, (title, year)
    tuples or Candidates). It runs in the pipeline only; keep API keys in env vars.
    """
    if not spec:
        return None
    module_name, _, attr = spec.partition(":")
    fn = getattr(importlib.import_module(module_name), attr or "extract")

    def wrapped(text: str) -> list[Candidate]:
        result: list[Candidate | None] = []
        for item in fn(text) or []:
            if isinstance(item, Candidate):
                result.append(item)
            elif isinstance(item, tuple):
                result.append(Candidate(str(item[0]), item[1] if len(item) > 1 else None))
            else:
                result.append(_clean_candidate(str(item)))
        return _dedupe(result)

    return wrapped
