"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { searchCatalog } from "@/lib/search";
import { createLatestGuard, mergeStable, rankByRelevance } from "@/lib/searchMerge";
import { TMDB_PROXY_URL } from "@/lib/config";
import { proxySearch, type ProxyStatus } from "@/lib/tmdbProxy";
import type { MediaType, Title } from "@/lib/types";
import { useApp } from "./AppProvider";

export type SearchType = MediaType | "both";

/**
 * Debounced search without flicker: offline catalogue results appear at once; live TMDB
 * results (via the Edge Function) are only ever *appended* as a "More results" group, so
 * nothing on screen moves. An AbortController + request id make sure a slow earlier query
 * can never overwrite a newer one.
 *
 * `results` is the stable primary list, `more` the appended live-only group, and `all`
 * both concatenated (for compact pickers that just slice the top N).
 */
export function useTitleSearch(query: string, type: SearchType) {
  const { catalog, session } = useApp();
  const canLive = Boolean(session) && Boolean(TMDB_PROXY_URL);
  const [groups, setGroups] = useState<{ primary: Title[]; more: Title[] }>({ primary: [], more: [] });
  const [status, setStatus] = useState<ProxyStatus | "idle">("idle");
  const [loading, setLoading] = useState(false);
  const guard = useRef(createLatestGuard());

  useEffect(() => {
    const id = guard.current.next();
    const q = query.trim();
    if (q.length < 2) {
      setGroups({ primary: [], more: [] });
      setStatus("idle");
      setLoading(false);
      return;
    }
    const local = rankByRelevance(searchCatalog(catalog.values(), q, { type, limit: 30 }), q, type);
    let shown = { primary: local, more: [] as Title[] };
    setGroups(shown);
    if (!canLive) {
      // No live search possible: say so right away instead of flashing "Searching TMDB…".
      setLoading(false);
      setStatus(TMDB_PROXY_URL ? "signed-out" : "not-configured");
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      const res = await proxySearch(q, type === "both" ? "multi" : type, undefined, controller.signal);
      if (!guard.current.isCurrent(id) || controller.signal.aborted) return; // a newer query owns the UI
      setLoading(false);
      setStatus(res.status);
      if (res.status === "ok" && res.data) {
        // Prefer artifact metadata (providers/runtime) when a live result is in the catalogue.
        const live = res.data.results.map((t) => catalog.get(t.key) ?? t);
        shown = mergeStable(shown, live, q, type);
        setGroups(shown);
      }
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, type, catalog, canLive]);

  const all = useMemo(() => [...groups.primary, ...groups.more], [groups]);
  return { results: groups.primary, more: groups.more, all, status, loading };
}

/** Subtle inline indicator while the live search is running (results stay where they are). */
export function SearchingHint({ loading, status }: { loading: boolean; status: ProxyStatus | "idle" }) {
  if (!loading || status === "signed-out" || status === "not-configured") return null;
  return (
    <p className="muted small searching" role="status" aria-live="polite">
      Searching TMDB…
    </p>
  );
}
export function SearchStatus({ status }: { status: ProxyStatus | "idle" }) {
  if (status === "ok" || status === "idle") return null;
  const text =
    status === "signed-out"
      ? "Searching the offline catalogue only — sign in to search all of TMDB."
      : status === "not-configured"
        ? "Searching the offline catalogue only (live TMDB search isn't configured)."
        : "Live search is unavailable right now — showing offline results.";
  return <p className="muted small">{text}</p>;
}

export function MediaToggle({ value, onChange }: { value: SearchType; onChange: (v: SearchType) => void }) {
  const opts: [SearchType, string][] = [
    ["movie", "Movies"],
    ["tv", "TV"],
    ["both", "Both"],
  ];
  return (
    <div className="segmented" role="radiogroup" aria-label="Media type">
      {opts.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}
