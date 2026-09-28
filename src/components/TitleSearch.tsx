"use client";

import { useEffect, useState } from "react";
import { searchCatalog } from "@/lib/search";
import { proxySearch, type ProxyStatus } from "@/lib/tmdbProxy";
import type { MediaType, Title } from "@/lib/types";
import { useApp } from "./AppProvider";

export type SearchType = MediaType | "both";

/** Debounced search: live TMDB via the Edge Function when available, else the offline catalogue. */
export function useTitleSearch(query: string, type: SearchType) {
  const { catalog } = useApp();
  const [results, setResults] = useState<Title[]>([]);
  const [status, setStatus] = useState<ProxyStatus | "idle">("idle");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setStatus("idle");
      return;
    }
    const local = searchCatalog(catalog.values(), q, { type, limit: 30 });
    setResults(local);
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      const res = await proxySearch(q, type === "both" ? "multi" : type);
      if (cancelled) return;
      setLoading(false);
      setStatus(res.status);
      if (res.status === "ok" && res.data) {
        // Prefer artifact metadata (has providers/runtime) when a result is in the catalogue.
        const live = res.data.results.map((t) => catalog.get(t.key) ?? t);
        const seen = new Set(live.map((t) => t.key));
        setResults([...live, ...local.filter((t) => !seen.has(t.key))]);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, type, catalog]);

  return { results, status, loading };
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
