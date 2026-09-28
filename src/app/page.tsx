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
const TAB_KEY = "movie-recommender:feed-tab";
type Tab = "ratings" | "curators";
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
  const [pinned, setPinned] = useState<{ taste: Recommendation[]; curators: Recommendation[]; sig: string } | null>(null);
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

  // Two independent rankings: pure taste (no curator influence) and curator picks only.
  const recs = useMemo(() => {
    if (!ready) return { taste: [] as Recommendation[], curators: [] as Recommendation[] };
    const merged = new Map<TitleKey, Title>([...extraTitles, ...Object.entries(snapshots), ...catalog]);
    const weightsByKey = new Map(ratings.map((r) => [r.key, preferenceWeight(r.kind, r.value)]));
    const base = {
      minYear: meta?.minYear ?? 1980,
      exclude: hideWatchlist ? watchlist.map((w) => w.key) : [],
    };
    const taste = rankRecommendations(weightsByKey, neighbors, merged, { ...base, filters: { ...filters, curatedOnly: false } });
    const curators = rankRecommendations(weightsByKey, neighbors, merged, {
      ...base,
      filters: { ...filters, curatedOnly: true },
      picks: indexPicks(picks),
      curatorWeights: weights,
    });
    return { taste, curators };
  }, [ready, extraTitles, snapshots, catalog, ratings, neighbors, meta, filters, picks, weights, hideWatchlist, watchlist]);

  const initialLoaded = ready && (neighborsLoaded || ratedKeys.length === 0);
  const filtersSig = JSON.stringify(filters);
  const currentList = (t: Tab, r: typeof recs) => (t === "ratings" ? r.taste : r.curators);

  // First pin, once the data is ready. After that the list never re-ranks by itself:
  // rating a card leaves it in place (dimmed) and offers "Update recommendations".
  useEffect(() => {
    if (!pinned && initialLoaded) setPinned({ ...recs, sig: ratedSig });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLoaded, pinned]);
  // Explicit re-rank triggers: the Update button, filter changes, the watchlist toggle.
  useEffect(() => {
    if (pinned) setPinned({ ...recs, sig: ratedSig });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, filtersSig, hideWatchlist]);
  // Offer a re-rank once the new rating's neighbour data has loaded (no ratings left = nothing to load).
  const stale = Boolean(pinned && pinned.sig !== ratedSig && (loadedSig === ratedSig || ratedKeys.length === 0));
  const refresh = () => {
    setGeneration((g) => g + 1);
    setShown(PAGE);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const [tab, setTab] = useState<Tab | null>(null);
  // The default tab is decided once, when the list first appears, so a first rating doesn't flip it.
  const [autoTab, setAutoTab] = useState<Tab | null>(null);
  useEffect(() => {
    const saved = localStorage.getItem(TAB_KEY);
    setTab(saved === "ratings" || saved === "curators" ? saved : null);
  }, []);
  useEffect(() => {
    if (pinned && !autoTab) setAutoTab(pinned.taste.length ? "ratings" : "curators");
  }, [pinned, autoTab]);
  const activeTab: Tab = tab ?? autoTab ?? (ratings.length ? "ratings" : "curators");
  const chooseTab = (t: Tab) => {
    setTab(t);
    setShown(PAGE);
    localStorage.setItem(TAB_KEY, t);
  };

  // Nothing on screen to shift yet (e.g. first ratings on an empty tab): show new results right away.
  useEffect(() => {
    if (!pinned || !stale) return;
    if (currentList(activeTab, pinned).length === 0 && currentList(activeTab, recs).length > 0) setGeneration((g) => g + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stale, activeTab]);

  const tasteList = pinned?.taste ?? [];
  const curatorList = pinned?.curators ?? [];
  const followed = curatorList.filter((r) => r.curators.some(isFollowed));
  const others = curatorList.filter((r) => !r.curators.some(isFollowed));

  if (error) return <p className="error">Couldn&apos;t load the data artifact: {error}</p>;
  if (!ready) return <p className="muted">Loading…</p>;

  const needsOnboarding = ratings.length < 5;
  const card = (r: Recommendation) => (
    <TitleCard key={r.title.key} title={getTitle(r.title.key) ?? r.title} reason={r.reason} badges={r.gem ? ["💎 Gem"] : undefined} dimWhenRated />
  );
  const more = (total: number) =>
    total > shown ? (
      <p style={{ textAlign: "center" }}>
        <button type="button" className="btn secondary" onClick={() => setShown((n) => n + PAGE)}>
          Show more
        </button>
      </p>
    ) : null;

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
      <div className="segmented tabs" role="tablist" aria-label="Recommendation source">
        <button type="button" role="tab" aria-selected={activeTab === "ratings"} className={activeTab === "ratings" ? "on" : ""} onClick={() => chooseTab("ratings")}>
          ⭐ Based on my ratings
        </button>
        <button type="button" role="tab" aria-selected={activeTab === "curators"} className={activeTab === "curators" ? "on" : ""} onClick={() => chooseTab("curators")}>
          📌 From curators
        </button>
      </div>
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

      {!pinned ? (
        <p className="muted">Loading recommendations…</p>
      ) : activeTab === "ratings" ? (
        <section role="tabpanel" aria-label="Based on my ratings">
          <p className="muted small">Titles similar to what you rated (MovieLens, TMDB, Reddit). Curators don&apos;t affect this list.</p>
          {tasteList.length === 0 ? (
            <p className="muted">
              {ratings.length
                ? "No matches for these filters yet — try widening them or rating a few more titles."
                : "Rate a few movies or shows to get recommendations here."}
            </p>
          ) : (
            <div className="list">{tasteList.slice(0, shown).map(card)}</div>
          )}
          {more(tasteList.length)}
        </section>
      ) : (
        <section role="tabpanel" aria-label="From curators">
          <p className="muted small">
            Titles your curators picked, ordered by how well they fit your ratings. Edit curators in config/curators.json.
          </p>
          <h2>📌 Picks by followed curators</h2>
          {followed.length ? (
            <div className="list">{followed.slice(0, shown).map(card)}</div>
          ) : (
            <p className="muted">
              No picks from the curators you follow yet. Share a post to the app or use <Link href="/picks/">Picks → Add pick</Link>.
            </p>
          )}
          {more(followed.length)}
          {others.length ? (
            <>
              <h2>Picks by other curators</h2>
              <div className="list">{others.slice(0, shown).map(card)}</div>
              {more(others.length)}
            </>
          ) : null}
        </section>
      )}

      {stale ? (
        <button type="button" className="btn refresh-bar" onClick={refresh}>
          ↻ Update recommendations
        </button>
      ) : null}
    </>
  );
}