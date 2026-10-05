from pathlib import Path

from pipeline import mlcache
from pipeline.config import Config
from pipeline.tmdb import jitter_fraction

DAY = 86400


def cfg_for(tmp_path: Path, **over) -> Config:
    cfg = Config()
    cfg.cache_dir = tmp_path / "cache"
    cfg.movielens_dir = tmp_path / "raw" / "ml-32m"
    for k, v in over.items():
        setattr(cfg, k, v)
    return cfg


def test_cache_roundtrip_and_reuse(tmp_path, monkeypatch):
    monkeypatch.delenv("ML_REFRESH_DAYS", raising=False)
    cfg = cfg_for(tmp_path)
    calls = []

    def build(c):
        calls.append(1)
        return {"movie:1": 1999}, {"movie:1": [("movie:2", 0.91234567)]}

    years, nbrs = mlcache.neighbors(cfg, build, now=1000 * DAY)
    assert calls == [1] and years == {"movie:1": 1999}
    # Within a week: served from cache, no rebuild.
    years2, nbrs2 = mlcache.neighbors(cfg, build, now=1006 * DAY)
    assert calls == [1]
    assert years2 == years and nbrs2 == {"movie:1": [("movie:2", 0.9123)]}
    # A week later: recomputed.
    mlcache.neighbors(cfg, build, now=1007 * DAY)
    assert calls == [1, 1]


def test_key_change_forces_rebuild(tmp_path):
    cfg = cfg_for(tmp_path)
    mlcache.save(cfg, {"movie:1": 2000}, {}, now=0)
    cached = mlcache.load(cfg)
    assert not mlcache.needs_rebuild(cached, mlcache.cache_key(cfg), DAY, 7)
    other = cfg_for(tmp_path, top_k=cfg.top_k + 1)
    assert mlcache.cache_key(other) != mlcache.cache_key(cfg)
    assert mlcache.needs_rebuild(cached, mlcache.cache_key(other), DAY, 7)
    assert mlcache.cache_key(cfg, url="https://example.invalid/ml-33m.zip") != mlcache.cache_key(cfg)


def test_stale_cache_used_when_raw_missing(tmp_path):
    cfg = cfg_for(tmp_path)
    mlcache.save(cfg, {"movie:1": 2000}, {"movie:1": [("movie:3", 0.5)]}, now=0)
    years, nbrs = mlcache.neighbors(cfg, lambda c: None, now=30 * DAY)
    assert years == {"movie:1": 2000} and nbrs["movie:1"] == [("movie:3", 0.5)]
    # No cache and no raw data: empty, not a crash.
    assert mlcache.neighbors(cfg_for(tmp_path / "empty"), lambda c: None) == ({}, {})


def test_status_need_raw(tmp_path, monkeypatch):
    monkeypatch.setenv("ML_REFRESH_DAYS", "7")
    cfg = cfg_for(tmp_path)
    assert mlcache.status(cfg, now=0) == {"rebuild": True, "need_raw": True, "age_days": None}
    mlcache.save(cfg, {}, {}, now=0)
    assert mlcache.status(cfg, now=2 * DAY)["need_raw"] is False
    assert mlcache.status(cfg, now=8 * DAY)["need_raw"] is True
    (cfg.movielens_dir).mkdir(parents=True)
    (cfg.movielens_dir / "ratings.csv").write_text("userId,movieId,rating,timestamp\n")
    s = mlcache.status(cfg, now=8 * DAY)
    assert s["rebuild"] is True and s["need_raw"] is False


def test_corrupt_cache_is_ignored(tmp_path):
    cfg = cfg_for(tmp_path)
    p = mlcache.cache_path(cfg)
    p.parent.mkdir(parents=True)
    p.write_bytes(b"not gzip")
    assert mlcache.load(cfg) is None


def test_tmdb_ttl_jitter_is_stable_and_spread():
    names = [f"{i:040x}.json" for i in range(2000)]
    fr = [jitter_fraction(n) for n in names]
    assert all(0 <= f < 1 for f in fr)
    assert jitter_fraction(names[0]) == fr[0]  # deterministic per entry
    # Roughly uniform: each quarter of the 3-5 day window gets a fair share.
    quarters = [sum(1 for f in fr if q / 4 <= f < (q + 1) / 4) for q in range(4)]
    assert min(quarters) > 400
