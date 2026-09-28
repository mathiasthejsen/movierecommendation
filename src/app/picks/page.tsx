"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { CuratorInput, isValidHandle } from "@/components/CuratorInput";
import { Poster, TitleCard, TypeBadge } from "@/components/TitleCard";
import { MediaToggle, SearchStatus, useTitleSearch, type SearchType } from "@/components/TitleSearch";
import { useAllPicks } from "@/components/usePicks";
import { CURATORS } from "@/lib/curators";
import { activePicks, addPicks, removePick, useStore } from "@/lib/store";
import { supabaseConfigured } from "@/lib/config";
import type { Title } from "@/lib/types";

function AddPickForm() {
  const lastCurator = useStore((s) => s.settings.lastCurator);
  const [curator, setCurator] = useState(lastCurator || CURATORS[0]?.handle || "");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SearchType>("both");
  const [added, setAdded] = useState<string[]>([]);
  const { results, status } = useTitleSearch(query, type);
  const add = (t: Title) => {
    if (!isValidHandle(curator)) return;
    addPicks([{ title: t, curator, postUrl: null, source: "manual" }]);
    setAdded((a) => [...a, t.key]);
  };
  return (
    <details className="filters" open={!lastCurator}>
      <summary>➕ Add pick</summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <CuratorInput value={curator} onChange={setCurator} />
        <input type="search" placeholder="Search the title they recommended…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <MediaToggle value={type} onChange={setType} />
        <SearchStatus status={status} />
        {results.slice(0, 8).map((t) => (
          <div className="match" key={t.key}>
            <Poster title={t} size="w185" />
            <div className="grow">
              <strong>{t.title}</strong> <TypeBadge title={t} />
              <div className="muted small">{t.year}</div>
            </div>
            <button type="button" className="btn" disabled={!isValidHandle(curator) || added.includes(t.key)} onClick={() => add(t)}>
              {added.includes(t.key) ? "Added" : "Add"}
            </button>
          </div>
        ))}
      </div>
    </details>
  );
}

export default function PicksPage() {
  const { ready, getTitle, session } = useApp();
  const { picks } = useAllPicks();
  const mine = useStore(activePicks);
  const ownerId = useStore((s) => s.ownerId);
  const [curatorFilter, setCuratorFilter] = useState("");

  const grouped = useMemo(() => {
    const byKey = new Map<string, { title: Title; curators: Set<string> }>();
    for (const p of picks) {
      if (curatorFilter && p.curator !== curatorFilter) continue;
      const t = getTitle(p.key);
      if (!t) continue;
      const g = byKey.get(p.key) ?? { title: t, curators: new Set<string>() };
      g.curators.add(p.curator);
      byKey.set(p.key, g);
    }
    return [...byKey.values()].sort((a, b) => b.curators.size - a.curators.size || b.title.votes - a.title.votes);
  }, [picks, curatorFilter, getTitle]);

  if (!ready) return <p className="muted">Loading…</p>;
  const handles = [...new Set(picks.map((p) => p.curator))].sort();
  const myOwn = mine.filter((p) => p.pending || !p.addedBy || p.addedBy === (session?.user.id ?? ownerId));
  return (
    <>
      <h1>Curator picks</h1>
      <p className="muted small">
        Share an Instagram or TikTok post to this app (Share → Reel Picks) or add picks by hand. Picks also come from
        curators&apos; public Letterboxd feeds.
        {supabaseConfigured && !session ? " Sign in to share picks with your family." : ""}
      </p>
      <AddPickForm />
      {handles.length ? (
        <label className="row small">
          Curator{" "}
          <select value={curatorFilter} onChange={(e) => setCuratorFilter(e.target.value)}>
            <option value="">All</option>
            {handles.map((h) => (
              <option key={h} value={h}>
                @{h}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {myOwn.length ? (
        <>
          <h2>Added by you</h2>
          <div className="stack">
            {myOwn.map((p) => {
              const t = getTitle(p.key);
              return (
                <div className="match" key={p.id}>
                  {t ? <Poster title={t} size="w185" /> : null}
                  <div className="grow">
                    <strong>{t?.title ?? p.key}</strong> {t ? <TypeBadge title={t} /> : null}
                    <div className="muted small">
                      @{p.curator}
                      {p.pending ? " · not synced yet" : ""}
                      {p.postUrl ? (
                        <>
                          {" · "}
                          <a href={p.postUrl} target="_blank" rel="noreferrer">
                            post ↗
                          </a>
                        </>
                      ) : null}
                    </div>
                  </div>
                  <button type="button" className="chip" onClick={() => removePick(p.id)} aria-label="Remove pick">
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      <h2>All picks</h2>
      {grouped.length ? (
        <div className="list">
          {grouped.map((g) => (
            <TitleCard
              key={g.title.key}
              title={g.title}
              reason={`Picked by ${[...g.curators].map((h) => `@${h}`).join(", ")}`}
            />
          ))}
        </div>
      ) : (
        <p className="muted">
          No picks yet. Try sharing a post to the app, or see <Link href="/account/">Me</Link> to install it first.
        </p>
      )}
    </>
  );
}
