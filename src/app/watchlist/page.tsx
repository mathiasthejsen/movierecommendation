"use client";

import Link from "next/link";
import { useState } from "react";
import { useApp } from "@/components/AppProvider";
import { MediaToggle, type SearchType } from "@/components/TitleSearch";
import { TitleCard } from "@/components/TitleCard";
import { activeWatchlist, useStore } from "@/lib/store";
import type { Title } from "@/lib/types";

export default function WatchlistPage() {
  const { ready, getTitle } = useApp();
  const items = useStore(activeWatchlist);
  const [type, setType] = useState<SearchType>("both");
  if (!ready) return <p className="muted">Loading…</p>;
  const titles = [...items]
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt))
    .map((w) => getTitle(w.key))
    .filter((t): t is Title => Boolean(t))
    .filter((t) => type === "both" || t.type === type);
  return (
    <>
      <h1>Watchlist</h1>
      <MediaToggle value={type} onChange={setType} />
      {titles.length ? (
        <div className="list" style={{ marginTop: 12 }}>
          {titles.map((t) => (
            <TitleCard key={t.key} title={t} />
          ))}
        </div>
      ) : (
        <p className="muted">
          Nothing here yet. Add titles from <Link href="/">For you</Link> or <Link href="/search/">Search</Link>.
        </p>
      )}
    </>
  );
}
