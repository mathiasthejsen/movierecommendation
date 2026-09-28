"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { SampleBanner } from "@/components/Chrome";
import { Filters } from "@/components/Filters";
import { TitleCard } from "@/components/TitleCard";
import { useAllPicks } from "@/components/usePicks";
import { loadNeighbors } from "@/lib/artifact";
import { ONBOARDING_TARGET } from "@/lib/config";
import { isFollowed } from "@/lib/curators";
import {
  indexPicks,
  preferenceWeight,
  rankRecommendations,
  tmdbFallbackEdges,
  type RankFilters,
  type Recommendation,
} from "@/lib/ranking";
import { activeRatings, activeWatchlist, useStore } from "@/lib/store";
import { proxyRecommendations } from "@/lib/tmdbProxy";
import type { Edge, Title, TitleKey } from "@/lib/types";

const PAGE = 24;
const FOLLOWED_MAX = 6;
const FILTER_KEY = "movie-recommender:filters";
const fallbackCache = new Map<TitleKey, { edges: Edge[]; titles: Title[] } | null>();

function loadFilters(): RankFilters {
  try {
    return JSON.parse(localStorage.getItem(FILTER_KEY) ?? "{}") as RankFilters;
  } catch {
    return {};
  }
}

export default function FeedPage() {
  const { ready, error, catalog, meta, getTitle, session } = useApp();
  const ratings = useStore(activeRatings);
  const watchlist = useStore(activeWatchlist);
  const snapshots = useStore((s) => s.titles);
  const { picks, weights } = useAllPicks();
  const [filters, setFilters] = useState<RankFilters>({});
  const [hideWatchlist, setHideWatchlist] = useState(false);
  const [neighbors, setNeighbors] = useState<Map<TitleKey, Edge[]>>(new Map());
  const [extraTitles, setExtraTitles] = useState<Map<TitleKey, Title>>(new Map());
  const [shown, setShown] = useState(PAGE);
  const [loadError, setLoadError] = useState<string | null>(null);
  // The visible list is "pinned": rating a card doesn't reshuffle the feed under your finger.
  // It re-ranks only on filter changes, first data load, or when you tap "Update recommendations".
  const [pinned, setPinned] = useState<{ list: Recommendation[]; sig: string } | null>(null);
  const [generation, setGeneration] = useState(0);
  const [neighborsLoaded, setNeighborsLoaded] = useState(false);
  const [loadedSig, setLoadedSig] = useState("");

  useEffect(() => setFilters(loadFilters()), []);
  const updateFilters = (f: RankFilters) => {
    setFilters(f);
    setShown(PAGE);
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
  };

  const ratedKeys = useMemo(() => ratings.map((r) => r.key).sort(), [ratings]);
  const ratedSig = ratedKeys.join(",");

  useEffect(() => {
    if (!ready || !ratedKeys.length) return;
    const sig = ratedSig;
    let cancelled = false;
    (async () => {
      try {
        const map = await loadNeighbors(ratedKeys);
        // TMDB fallback (via the Edge Function) for rated titles the artifact doesn't cover.
        const missing = ratedKeys.filter((k) => !map.has(k)).slice(0, 15);
        const extra = new Map<TitleKey, Title>();
        await Promise.all(
          missing.map(async (key) => {
            if (!fallbackCache.has(key)) {
              const res = await proxyRecommendations(key);
              fallbackCache.set(
                key,
                res.status === "ok" && res.data
                  ? {
                      edges: tmdbFallbackEdges(res.data.recommendations.map((t) => t.key), res.data.similar.map((t) => t.key)),
                      titles: [...res.data.recommendations, ...res.data.similar],
                    }
                  : null,
              );
            }
            const fb = fallbackCache.get(key);
            if (fb) {
              map.set(key, fb.edges);
              for (const t of fb.titles) extra.set(t.key, t);
            }
          }),
        );
        if (!cancelled) {
          setNeighbors(map);
          setExtraTitles(extra);
          setLoadError(null);
          setNeighborsLoaded(true);
          setLoadedSig(sig);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ratedSig, session?.user.id]);

  const recs = useMemo(() => {
    if (!ready) return [];
    const merged = new Map<TitleKey, Title>([...extraTitles, ...Object.entries(snapshots), ...catalog]);
    const weightsByKey = new Map(ratings.map((r) => [r.key, preferenceWeight(r.kind, r.value)]));
    return rankRecommendations(weightsByKey, neighbors, merged, {
      minYear: meta?.minYear ?? 1980,
      filters,
      picks: indexPicks(picks),
      curatorWeights: weights,
      exclude: hideWatchlist ? watchlist.map((w) => w.key) : [],
    });
  }, [ready, extraTitles, snapshots, catalog, ratings, neighbors, meta, filters, picks, weights, hideWatchlist, watchlist]);

  const initialLoaded = ready && (neighborsLoaded || ratedKeys.length === 0);
  const pinTrigger = `${generation}|${JSON.stringify(filters)}|${hideWatchlist}|${initialLoaded}`;
  useEffect(() => {
    if (initialLoaded) setPinned({ list: recs, sig: ratedSig });
    // Deliberately not depending on recs/ratedSig: re-pin only on explicit triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinTrigger]);
  // Offer a re-rank once the new rating's neighbour data has loaded (no ratings left = nothing to load).
  const stale = Boolean(pinned && pinned.sig !== ratedSig && (loadedSig === ratedSig || ratedKeys.length === 0));
  const refresh = () => {
    setGeneration((g) => g + 1);
    setShown(PAGE);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const visible = pinned?.list ?? [];

  // Top recommendations picked by curators you follow get their own section.
  const followedPicks = visible.filter((r) => r.curators.some(isFollowed)).slice(0, FOLLOWED_MAX);
  const followedKeys = new Set(followedPicks.map((r) => r.title.key));
  const rest = visible.filter((r) => !followedKeys.has(r.title.key));

  if (error) return <p className="error">Couldn&apos;t load the data artifact: {error}</p>;
  if (!ready) return <p className="muted">Loading…</p>;

  const needsOnboarding = ratings.length < 5;
  return (
    <>
      <h1>For you</h1>
      <SampleBanner />
      {needsOnboarding ? (
        <div className="notice">
          <p>
            Rate {ONBOARDING_TARGET} movies and shows you know to get taste-matched picks
            {ratings.length ? ` (${ratings.length} so far)` : ""}.
          </p>
          <Link className="btn" href="/onboarding/">
            Start rating
          </Link>
        </div>
      ) : null}
      <Filters value={filters} onChange={updateFilters} />
      <label className="row small muted" style={{ marginBottom: 10 }}>
        <input type="checkbox" checked={hideWatchlist} onChange={(e) => setHideWatchlist(e.target.checked)} /> Hide titles on my
        watchlist
      </label>
      {loadError ? (
        <div className="notice small">
          <p className="error">Couldn&apos;t load recommendation data ({loadError}). Check your connection.</p>
          <button type="button" className="btn secondary" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : null}
      {followedPicks.length ? (
        <section aria-labelledby="followed-heading">
          <h2 id="followed-heading">📌 Picks by followed curators</h2>
          <div className="list">
            {followedPicks.map((r) => (
              <TitleCard key={r.title.key} title={getTitle(r.title.key) ?? r.title} reason={r.reason} badges={r.gem ? ["💎 Gem"] : undefined} dimWhenRated />
            ))}
          </div>
        </section>
      ) : null}
      <h2>{followedPicks.length ? "More for you" : "Recommended"}</h2>
      {!pinned ? (
        <p className="muted">Loading recommendations…</p>
      ) : rest.length === 0 ? (
        <p className="muted">
          {ratings.length ? "No matches for these filters yet — try widening them or rating a few more titles." : "Nothing yet."}
        </p>
      ) : (
        <div className="list">
          {rest.slice(0, shown).map((r) => (
            <TitleCard
              key={r.title.key}
              title={getTitle(r.title.key) ?? r.title}
              reason={r.reason}
              badges={r.gem ? ["💎 Gem"] : undefined}
              dimWhenRated
            />
          ))}
        </div>
      )}
      {stale ? (
        <button type="button" className="btn refresh-bar" onClick={refresh}>
          ↻ Update recommendations
        </button>
      ) : null}
      {rest.length > shown ? (
        <p style={{ textAlign: "center" }}>
          <button type="button" className="btn secondary" onClick={() => setShown((n) => n + PAGE)}>
            Show more
          </button>
        </p>
      ) : null}
    </>
  );
}
