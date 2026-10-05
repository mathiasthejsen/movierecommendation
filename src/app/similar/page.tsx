"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { Poster, TitleCard, TitleMeta, TypeBadge } from "@/components/TitleCard";
import { MediaToggle, type SearchType } from "@/components/TitleSearch";
import { loadNeighbors } from "@/lib/artifact";
import { isKey } from "@/lib/keys";
import { formatReason, rankRecommendations, tmdbFallbackEdges } from "@/lib/ranking";
import { useStore } from "@/lib/store";
import { proxyDetails, proxyRecommendations } from "@/lib/tmdbProxy";
import type { Edge, Title, TitleKey } from "@/lib/types";

const PAGE = 24;

function Similar() {
  const params = useSearchParams();
  const raw = params.get("key") ?? "";
  const key = isKey(raw) ? raw : null;
  const { ready, catalog, meta, getTitle } = useApp();
  const snapshots = useStore((s) => s.titles);
  const [edges, setEdges] = useState<Edge[] | null>(null);
  const [extra, setExtra] = useState<Map<TitleKey, Title>>(new Map());
  const [seed, setSeed] = useState<Title | null>(null);
  const [type, setType] = useState<SearchType>("both");
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    if (!ready || !key) return;
    let cancelled = false;
    setEdges(null);
    setShown(PAGE);
    (async () => {
      const map = await loadNeighbors([key]).catch(() => new Map<TitleKey, Edge[]>());
      let list = map.get(key) ?? null;
      const more = new Map<TitleKey, Title>();
      if (!list) {
        // Not in the weekly data (e.g. found via live search): ask TMDB through the proxy.
        const res = await proxyRecommendations(key);
        if (res.status === "ok" && res.data) {
          list = tmdbFallbackEdges(res.data.recommendations.map((t) => t.key), res.data.similar.map((t) => t.key));
          for (const t of [...res.data.recommendations, ...res.data.similar]) more.set(t.key, t);
        }
      }
      const seedTitle = getTitle(key) ?? (await proxyDetails(key)).data?.title ?? null;
      if (!cancelled) {
        setEdges(list ?? []);
        setExtra(more);
        setSeed(seedTitle);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);

  const results = useMemo(() => {
    if (!key || !edges) return [];
    const merged = new Map<TitleKey, Title>([...extra, ...Object.entries(snapshots), ...catalog]);
    return rankRecommendations(new Map([[key, 1]]), new Map([[key, edges]]), merged, {
      minYear: meta?.minYear ?? 1980,
      gemBoost: 0, // pure similarity here; gems are still labelled
      filters: { media: type },
    });
  }, [key, edges, extra, snapshots, catalog, meta, type]);

  if (!ready) return <p className="muted">Loading…</p>;
  if (!key) {
    return (
      <p className="muted">
        Nothing selected. Use <strong>More like this</strong> on any card, or go back to <Link href="/">For you</Link>.
      </p>
    );
  }
  const title = seed ?? getTitle(key);
  return (
    <>
      <p className="small">
        <button type="button" className="more-toggle" onClick={() => history.back()}>
          ← Back
        </button>
      </p>
      <h1>More like this</h1>
      {title ? (
        <div className="match" style={{ marginBottom: 12 }}>
          <Poster title={title} size="w185" />
          <div className="grow">
            <strong>{title.title}</strong> <TypeBadge title={title} />
            <TitleMeta title={title} />
          </div>
        </div>
      ) : null}
      <MediaToggle
        value={type}
        onChange={(t) => {
          setType(t);
          setShown(PAGE);
        }}
      />
      <p className="muted small">
        Ranked only by similarity to this title (MovieLens, TMDB, Reddit, Trakt, keywords). Titles you&apos;ve already rated are faded.
      </p>
      {edges === null ? (
        <p className="muted">Finding similar titles…</p>
      ) : results.length === 0 ? (
        <p className="muted">
          No similar titles found{type !== "both" ? " for this filter" : ""}. Titles that aren&apos;t in the weekly data need
          live TMDB (sign in, with the Edge Function set up).
        </p>
      ) : (
        <div className="list">
          {results.slice(0, shown).map((r) => (
            <TitleCard
              key={r.title.key}
              title={getTitle(r.title.key) ?? r.title}
              reason={formatReason([], r.sources, [], r.gem)}
              badges={r.gem ? ["💎 Gem"] : undefined}
              dimWhenRated
            />
          ))}
        </div>
      )}
      {results.length > shown ? (
        <p style={{ textAlign: "center" }}>
          <button type="button" className="btn secondary" onClick={() => setShown((n) => n + PAGE)}>
            Show more
          </button>
        </p>
      ) : null}
    </>
  );
}

export default function SimilarPage() {
  // useSearchParams needs a Suspense boundary in a static export.
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Similar />
    </Suspense>
  );
}
