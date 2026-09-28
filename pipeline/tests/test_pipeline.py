import json

from pipeline.artifact import map_genres, merge_edges, shard_of, title_from_details, tmdb_rank_edges
from pipeline.build import main
from pipeline.extract import Candidate
from pipeline.reddit import Comment, Thread, mine_edges

IDS = {
    ("donnie darko", "movie"): "movie:1", ("primer", "movie"): "movie:2", ("coherence", "movie"): "movie:3",
    ("moon", "movie"): "movie:4", ("dark", "tv"): "tv:10", ("severance", "tv"): "tv:11",
}


def resolve(c: Candidate, context=None):
    kind = c.kind or context or "movie"
    name = c.title.lower()
    return IDS.get((name, kind)) or IDS.get((name, "tv" if kind == "movie" else "movie"))


def test_mine_edges_weights_by_upvotes_and_dilutes_lists():
    threads = [
        Thread("Movies like Donnie Darko?", "", 10, [
            Comment("**Primer**", 100),
            Comment("**Coherence** and **Moon**", 100),
            Comment("**Moon**", -5),  # downvoted comments are ignored
        ], context="movie")
    ]
    edges = mine_edges(threads, resolve)
    assert edges[("movie:1", "movie:2")] > edges[("movie:1", "movie:3")] == edges[("movie:1", "movie:4")]
    assert edges[("movie:2", "movie:1")] == edges[("movie:1", "movie:2")] * 0.5  # reverse edge
    assert ("movie:1", "movie:1") not in edges


def test_mine_edges_keeps_cross_type_edges():
    threads = [Thread("If you liked Donnie Darko, any shows?", "", 10, [Comment("**Dark** and **Severance**", 50)], context="tv")]
    edges = mine_edges(threads, resolve)
    assert ("movie:1", "tv:10") in edges and ("movie:1", "tv:11") in edges


def test_mine_edges_skips_threads_without_resolvable_seed():
    threads = [Thread("Movies like Unknown Film?", "", 10, [Comment("**Primer**", 50)])]
    assert mine_edges(threads, resolve) == {}


def test_merge_edges_normalises_and_filters():
    ml = {"movie:1": [("movie:2", 0.5), ("movie:3", 0.25), ("movie:99", 0.9)]}
    reddit = {("movie:1", "movie:3"): 4.0, ("movie:1", "movie:2"): 1.0, ("movie:1", "tv:10"): 2.0}
    tmdb = {("tv:10", "movie:1"): 0.9}
    trakt = {("tv:10", "tv:11"): 0.8}
    out = merge_edges(ml, reddit, tmdb, keep={"movie:1", "movie:2", "movie:3", "tv:10", "tv:11"}, cap=10, trakt=trakt)
    by_key = {e[0]: e for e in out["movie:1"]}
    assert "movie:99" not in by_key  # target outside catalogue
    assert all(0 <= v <= 100 for e in out["movie:1"] for v in e[1:])
    assert by_key["movie:3"][2] == 100  # strongest reddit edge normalises to 100
    assert "tv:10" in by_key
    assert out["tv:10"] == [["movie:1", 0, 0, 90, 0], ["tv:11", 0, 0, 0, 80]]


def test_tmdb_rank_edges_boosts_overlap_and_keeps_media_type():
    edges = tmdb_rank_edges("tv:1", [{"id": 2}, {"id": 3}], [{"id": 3}, {"id": 4}])
    assert edges[("tv:1", "tv:2")] == 0.9
    assert edges[("tv:1", "tv:3")] == min(1.0, 0.87 + 0.1)
    assert edges[("tv:1", "tv:4")] < edges[("tv:1", "tv:3")]


def test_shard_of_matches_typescript_rule():
    assert shard_of("movie:603", 32) == (603 * 2) % 32
    assert shard_of("tv:603", 32) == (603 * 2 + 1) % 32


def test_title_from_details_movie_and_tv():
    d = {
        "id": 5, "media_type": "movie", "title": "X", "release_date": "2021-05-01", "genres": [{"id": 18}],
        "vote_average": 7.1, "vote_count": 10, "popularity": 3, "runtime": 101,
        "watch/providers": {"results": {"US": {"flatrate": [{"provider_id": 8}], "ads": [{"provider_id": 300}]}, "GB": {"flatrate": [{"provider_id": 9}]}}},
    }
    m = title_from_details(d, "US")
    assert m.key == "movie:5" and m.year == 2021 and m.genres == [18] and m.providers == [8, 300] and m.seasons is None
    tv = title_from_details(
        {"id": 7, "media_type": "tv", "name": "Show", "first_air_date": "2017-12-01", "genres": [{"id": 10765}, {"id": 18}],
         "number_of_seasons": 3, "status": "Ended", "episode_run_time": [55]}, "US")
    assert tv.key == "tv:7" and tv.title == "Show" and tv.seasons == 3 and tv.status == "ended" and tv.runtime == 55
    assert tv.genres == [878, 14, 18]  # TV genres mapped onto movie genre ids
    assert title_from_details({"id": 8, "media_type": "tv", "name": "S", "first_air_date": "2020", "status": "Returning Series"}, "US").status == "ongoing"
    assert title_from_details({"id": 6, "adult": True}, "US") is None


def test_map_genres_dedupes():
    assert map_genres([10759, 28, 18]) == [28, 12, 18]


def test_sample_build_writes_derived_only_artifact(tmp_path):
    assert main(["--sample", "--out", str(tmp_path)]) == 0
    meta = json.loads((tmp_path / "meta.json").read_text("utf-8"))
    assert meta["sample"] is True and meta["counts"]["movies"] > 50 and meta["counts"]["tv"] > 10
    catalog = json.loads((tmp_path / "catalog.json").read_text("utf-8"))
    f = catalog["fields"]
    years = [r[f.index("year")] for r in catalog["rows"]]
    assert min(years) >= 1980  # Alien (1979) and Taxi Driver (1976) are filtered out
    tv_rows = [r for r in catalog["rows"] if r[0].startswith("tv:")]
    assert all(r[f.index("seasons")] and r[f.index("status")] in ("ended", "ongoing") for r in tv_rows)
    shard = json.loads((tmp_path / "neighbors" / f"{shard_of('movie:141', meta['shards'])}.json").read_text("utf-8"))
    assert shard["movie:141"] and all(len(e) == 5 for e in shard["movie:141"])
    dark = json.loads((tmp_path / "neighbors" / f"{shard_of('tv:70523', meta['shards'])}.json").read_text("utf-8"))
    assert any(e[0].startswith("movie:") for e in dark["tv:70523"])  # cross-type edge from Reddit
    curators = json.loads((tmp_path / "curators.json").read_text("utf-8"))
    assert {p["curator"] for p in curators["picks"]} == {"sortedcinema", "mscorsese"}
    everything = "".join(p.read_text("utf-8") for p in tmp_path.rglob("*.json"))
    # No Reddit comment text, review text or raw rating data leaks into the artifact.
    assert "exactly what you want" not in everything
    assert "MUST NOT BE STORED" not in everything
    assert "userId" not in everything and "ratings.csv" not in everything
