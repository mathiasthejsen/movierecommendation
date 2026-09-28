import json

from pipeline import curators as cur
from pipeline.extract import Candidate
from pipeline.sample import SAMPLE_DIR

TITLES = {"memories of murder": "movie:11423", "cure": "movie:36095", "taxi driver": "movie:103", "the thing": "movie:1091"}
YEARS = {"movie:11423": 2003, "movie:36095": 1997, "movie:103": 1976, "movie:1091": 1982}


def resolve(c: Candidate, context=None):
    return TITLES.get(c.title.lower())


def fixture(name: str) -> str:
    return (SAMPLE_DIR / name).read_text("utf-8")


def test_parse_diary_feed():
    entries = cur.parse_letterboxd_rss(fixture("letterboxd_diary.xml"))
    by_title = {e.title: e for e in entries}
    assert by_title["Coherence"].tmdb_key == "movie:220289" and by_title["Coherence"].rating == 4.5
    assert by_title["Primer"].liked and by_title["Primer"].rating is None
    assert by_title["Chernobyl"].tmdb_key == "tv:87108"
    # Title-only item: film, year and star rating parsed from "<title>, <year> - ★★★★"
    mom = by_title["Memories of Murder"]
    assert mom.year == 2003 and mom.rating == 4.0 and mom.tmdb_key is None


def test_diary_picks_keep_rated_4_plus_or_liked_and_1980_plus():
    entries = cur.parse_letterboxd_rss(fixture("letterboxd_diary.xml"))
    picks = {p.key: p for p in cur.entries_to_picks(entries, "sortedcinema", resolve, 1980)}
    assert set(picks) == {"movie:220289", "movie:14337", "movie:11423", "tv:87108"}
    assert "movie:8363" not in picks  # 3 stars, not liked
    assert "movie:103" not in picks  # 1976
    assert picks["movie:220289"].weight == 0.95 and picks["movie:14337"].weight == 0.8
    assert picks["movie:220289"].url.startswith("https://letterboxd.com/")


def test_list_feed_items_become_lower_weight_picks():
    entries = cur.parse_letterboxd_rss(fixture("letterboxd_list.xml"))
    assert sum(e.is_list for e in entries) == 4
    picks = cur.entries_to_picks(entries, "mscorsese", resolve, 1980, year_of=YEARS.get)
    by_key = {p.key: p for p in picks}
    assert by_key["movie:11423"].source == "letterboxd-list" and by_key["movie:11423"].weight == cur.LIST_WEIGHT
    assert "movie:103" not in by_key  # Taxi Driver (1976) dropped via year lookup
    assert by_key["movie:949"].source == "letterboxd" and by_key["movie:949"].weight == 1.0


def test_no_review_text_in_picks():
    entries = cur.parse_letterboxd_rss(fixture("letterboxd_diary.xml")) + cur.parse_letterboxd_rss(fixture("letterboxd_list.xml"))
    picks = cur.entries_to_picks(entries, "x", resolve, 1980)
    assert "MUST NOT BE STORED" not in json.dumps([p.__dict__ for p in picks])


def test_merge_history_accumulates_and_dedupes():
    old = [
        {"key": "movie:1", "curator": "a", "source": "letterboxd-list", "url": "l", "weight": 0.5, "first_seen": "2026-01-01"},
        {"key": "movie:2", "curator": "a", "source": "letterboxd", "url": "u2", "weight": 0.9, "first_seen": "2026-01-01"},
    ]
    new = [
        cur.Pick("movie:1", "a", "letterboxd", "u1", 1.0, 5.0, True, "2026-09-28"),
        cur.Pick("movie:3", "a", "letterboxd", "u3", 0.9, 4.0, False, "2026-09-28"),
        cur.Pick("movie:1", "b", "letterboxd", "u1b", 0.9, 4.0, False, "2026-09-28"),
    ]
    merged = {(p.curator, p.key): p for p in cur.merge_history(old, new)}
    assert len(merged) == 4
    one = merged[("a", "movie:1")]
    assert one.first_seen == "2026-01-01" and one.weight == 1.0 and one.source == "letterboxd" and one.url == "u1"
    assert ("a", "movie:2") in merged  # older picks survive RSS rolling off


def test_collect_picks_skips_disabled_empty_and_recent(monkeypatch):
    calls = []
    monkeypatch.setattr(cur, "fetch_letterboxd", lambda u, s: calls.append(u) or fixture("letterboxd_diary.xml"))
    monkeypatch.setattr(cur.time, "sleep", lambda s: None)
    curators = [
        cur.Curator("a", letterboxd="alpha"),
        cur.Curator("b", letterboxd=""),  # share-target only
        cur.Curator("c", letterboxd="gamma", enabled=False),
        cur.Curator("d", letterboxd="delta"),
    ]
    last = {"d": __import__("datetime").date.today().isoformat()}
    picks = cur.collect_picks(curators, resolve, 1980, last_fetched=last)
    assert calls == ["alpha"]  # d was fetched this week already
    assert picks and all(p.curator == "a" for p in picks)
    assert "a" in last


def test_curator_config_is_valid():
    curators = cur.load_curators()
    handles = [c.handle for c in curators]
    assert len(handles) == len(set(handles))
    for h in ("goosebumpscinema", "treynesbitmovies", "sortedcinema", "thematthewshepherd", "doradane_film",
              "ethanneville", "moviesaretherapy", "nikofilmreviews"):
        c = next(c for c in curators if c.handle == h)
        assert c.own and c.weight == 1.0 and c.enabled
    assert next(c for c in curators if c.handle == "moviesaretherapy").letterboxd == "moviesrtherapy"
    assert next(c for c in curators if c.handle == "nikofilmreviews").letterboxd == ""
    assert all(c.weight == 0.6 for c in curators if not c.own)


def test_instagram_captions_to_picks_discards_captions():
    picks = cur.captions_to_picks(
        [("Movies like Donnie Darko 🎬 1. Memories of Murder (2003) 2. Cure", "https://www.instagram.com/p/abc/")],
        "goosebumpscinema", resolve,
    )
    assert [p.key for p in picks] == ["movie:11423", "movie:36095"]
    assert all(p.url == "https://www.instagram.com/p/abc/" and p.source == "instagram" for p in picks)
