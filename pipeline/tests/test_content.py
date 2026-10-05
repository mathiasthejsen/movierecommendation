from pipeline.artifact import CROSS_TYPE_KEEP, merge_edges
from pipeline.content import Features, bridge_edges, categories_of, edge_type_counts, keywords_of

# TMDB-like keyword IDs.
HEIST, CRIME, ROBBERY, GANG, PRISON, DETECTIVE = 10051, 6149, 9748, 1430, 378, 703
SPACE, ALIEN, ROBOT, FUTURE = 9882, 9951, 14544, 4565
CRIME_G, DRAMA_G, SCIFI_G, ANIM_G, COMEDY_G = 80, 18, 878, 16, 35


def corpus() -> dict[str, Features]:
    f = [
        # Films
        Features("movie:949", [HEIST, CRIME, ROBBERY, GANG], [CRIME_G, DRAMA_G], "en", 1995),  # Heat
        Features("movie:500", [HEIST, CRIME, ROBBERY], [CRIME_G], "en", 1992),  # Reservoir Dogs
        Features("movie:157336", [SPACE, FUTURE, ROBOT], [SCIFI_G, DRAMA_G], "en", 2014),  # Interstellar
        Features("movie:1", [CRIME], [CRIME_G, COMEDY_G], "fr", 1984),  # only one shared keyword with anything
        # Series
        Features("tv:71446", [HEIST, ROBBERY, CRIME, GANG], [CRIME_G, DRAMA_G], "es", 2017),  # Money Heist
        Features("tv:60059", [CRIME, PRISON, DETECTIVE], [CRIME_G, DRAMA_G], "en", 2015),  # Better Call Saul
        Features("tv:1399", [SPACE, ALIEN, FUTURE], [SCIFI_G, DRAMA_G], "en", 2011),
        Features("tv:2", [ROBOT, FUTURE, SPACE], [ANIM_G], "ja", 1999),
        Features("tv:3", [], [CRIME_G, DRAMA_G], "en", 1995),  # no keywords: same genre/lang/decade only
    ]
    return {x.key: x for x in f}


def test_crime_heist_movie_gets_crime_heist_series():
    edges = bridge_edges(corpus(), k=15, min_sim=0.1, min_shared=2)
    heat_tv = sorted((s for (src, dst), s in edges.items() if src == "movie:949" and dst.startswith("tv:")), reverse=True)
    best = max((dst for (src, dst) in edges if src == "movie:949" and dst.startswith("tv:")),
               key=lambda d: edges[("movie:949", d)])
    assert best == "tv:71446"
    assert heat_tv == sorted(heat_tv, reverse=True) and heat_tv[0] > 0.3
    # ...and the reverse direction exists for series watchers.
    assert ("tv:71446", "movie:949") in edges
    # Sci-fi film links to sci-fi series, not to the heist show.
    assert ("movie:157336", "tv:1399") in edges
    assert ("movie:157336", "tv:71446") not in edges


def test_same_genre_language_decade_alone_is_not_enough():
    edges = bridge_edges(corpus(), k=15, min_sim=0.0, min_shared=2)
    assert not any("tv:3" in pair for pair in edges)  # no shared keywords at all
    assert not any(src == "movie:1" for src, _ in edges)  # only one shared keyword
    with_one = bridge_edges(corpus(), k=15, min_sim=0.0, min_shared=1)
    assert any(src == "movie:1" for src, _ in with_one)


def test_threshold_respected_and_no_self_edges():
    for min_sim in (0.1, 0.3, 0.6):
        edges = bridge_edges(corpus(), k=15, min_sim=min_sim, min_shared=1)
        assert all(s >= min_sim for s in edges.values())
        assert all(src != dst for src, dst in edges)
        assert all(0 < s <= 1.0 + 1e-6 for s in edges.values())
    assert not any(src.startswith("movie:") and dst.startswith("movie:") for src, dst in edges)


def test_symmetric_caps():
    feats = {}
    for i in range(30):
        feats[f"movie:{i + 1}"] = Features(f"movie:{i + 1}", [HEIST, CRIME, ROBBERY, i + 1000], [CRIME_G], "en", 2000)
        feats[f"tv:{i + 1}"] = Features(f"tv:{i + 1}", [HEIST, CRIME, ROBBERY, i + 2000], [CRIME_G], "en", 2000)
    edges = bridge_edges(feats, k=5, min_sim=0.1, min_shared=2)
    per_src: dict[tuple[str, str], int] = {}
    for src, dst in edges:
        t = (src, dst.split(":")[0])
        per_src[t] = per_src.get(t, 0) + 1
    assert set(per_src.values()) == {5}  # every film -> 5 series, every series -> 5 films and 5 series
    counts = edge_type_counts(edges)
    assert counts["movie->tv"] == counts["tv->movie"] == counts["tv->tv"] == 30 * 5
    assert counts["movie->movie"] == 0


def test_keywords_and_categories_helpers():
    assert keywords_of({"keywords": {"keywords": [{"id": 1, "name": "a"}]}}) == [1]  # movie shape
    assert keywords_of({"keywords": {"results": [{"id": 2, "name": "b"}]}}) == [2]  # tv shape
    assert keywords_of({}) == []
    # Movie and TV genre IDs land in the same unified categories (mirror of categories.ts).
    assert categories_of([28]) == categories_of([10759]) == {"action"}
    assert categories_of([10765]) == {"scifi"} and categories_of([10762]) == {"family"}


def test_merge_keeps_cross_type_edges_beyond_the_cap():
    ml = {"movie:1": [(f"movie:{i}", 1.0 - i / 100) for i in range(2, 40)]}
    content = {("movie:1", f"tv:{i}"): 0.3 for i in range(1, 25)}
    keep = {"movie:1", *(f"movie:{i}" for i in range(2, 40)), *(f"tv:{i}" for i in range(1, 25))}
    out = merge_edges(ml, {}, {}, keep, cap=20, content=content)["movie:1"]
    tv = [e for e in out if e[0].startswith("tv:")]
    assert len(out) == 20 + CROSS_TYPE_KEEP and len(tv) == CROSS_TYPE_KEEP
    assert all(len(e) == 6 and e[5] > 0 and e[1] == 0 for e in tv)


def test_gates_category_formats_and_quality():
    base = [HEIST, CRIME, ROBBERY]
    feats = {x.key: x for x in [
        Features("movie:10", base, [CRIME_G], "en", 2000, votes=5000, rating=7.5),  # crime film
        Features("tv:10", base, [COMEDY_G], "en", 2000, votes=900, rating=8.0),  # same keywords, no shared category
        Features("tv:11", base, [CRIME_G, 10764], "en", 2000, votes=900, rating=8.0),  # crime *reality* show
        Features("tv:12", base, [CRIME_G, 10762], "en", 2000, votes=900, rating=8.0),  # kids' crime cartoon
        Features("tv:13", base, [CRIME_G], "en", 2000, votes=12, rating=8.0),  # too few votes
        Features("tv:14", base, [CRIME_G], "en", 2000, votes=900, rating=4.1),  # badly rated
        Features("tv:15", base, [CRIME_G, DRAMA_G], "en", 2000, votes=900, rating=8.0),  # the one good match
    ]}
    edges = bridge_edges(feats, k=15, min_sim=0.0, min_shared=2, min_votes={"tv": 100, "movie": 200}, min_rating=6.0)
    assert [d for s, d in edges if s == "movie:10"] == ["tv:15"]
    # Without gates the same corpus links to every series that shares a category and format.
    loose = bridge_edges(feats, k=15, min_sim=0.0, min_shared=2)
    assert {d for s, d in loose if s == "movie:10"} == {"tv:13", "tv:14", "tv:15"}

def test_chunking_gives_the_same_edges():
    feats = corpus()
    assert bridge_edges(feats, min_sim=0.1, min_shared=1, chunk=1) == bridge_edges(feats, min_sim=0.1, min_shared=1, chunk=1024)
