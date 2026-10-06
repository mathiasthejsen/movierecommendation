"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { CuratorInput, isValidHandle } from "@/components/CuratorInput";
import { HideWatchlistToggle, useHideWatchlist } from "@/components/HideWatchlistToggle";
import { Poster, TitleCard, TypeBadge } from "@/components/TitleCard";
import { MediaToggle, SearchingHint, SearchStatus, useTitleSearch, type SearchType } from "@/components/TitleSearch";
import { useAllPicks } from "@/components/usePicks";
import { CURATORS, isFollowed } from "@/lib/curators";
import { curatorCounts, groupPicks, type PickGroup } from "@/lib/pickGroups";
import { activePicks, activeWatchlist, addPicks, getState, removePick, useStore } from "@/lib/store";
import type { Title } from "@/lib/types";

function AddPickForm() {
  const lastCurator = useStore((s) => s.settings.lastCurator);
  const [curator, setCurator] = useState(lastCurator || CURATORS[0]?.handle || "");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SearchType>("both");
  const [added, setAdded] = useState<string[]>([]);
  const { all, status, loading } = useTitleSearch(query, type);
  const add = (t: Title) => {
    if (!isValidHandle(curator)) return;
    addPicks([{ title: t, curator, postUrl: null, source: "manual" }]);
    setAdded((a) => [...a, t.key]);
  };
  // Collapsed by default; links to /picks/#add-pick open it and focus the first field.
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const openFromHash = () => {
      const el = ref.current;
      if (!el || window.location.hash !== "#add-pick") return;
      el.open = true;
      el.scrollIntoView({ block: "start" });
      el.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    };
    openFromHash();
    window.addEventListener("hashchange", openFromHash);
    return () => window.removeEventListener("hashchange", openFromHash);
  }, []);
  return (
    <details className="filters" id="add-pick" ref={ref}>
      <summary>➕ Add pick</summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <CuratorInput value={curator} onChange={setCurator} />
        <input type="search" placeholder="Search the title they recommended…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <MediaToggle value={type} onChange={setType} />
        <SearchStatus status={status} />
        {/* `all` only ever grows at the end, so slicing keeps visible rows in place. */}
        {all.slice(0, 8).map((t) => (
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
        <SearchingHint loading={loading} status={status} />
      </div>
    </details>
  );
}

const PAGE = 24;
const EXCLUDED_KEY = "movie-recommender:picks-excluded";

function PickSection({ heading, groups, empty }: { heading: string; groups: PickGroup[]; empty: string }) {
  // Paginate: the real data has well over a thousand picks, and rendering them all at once is slow.
  const [shown, setShown] = useState(PAGE);
  if (!groups.length && !empty) return null;
  return (
    <section>
      <h2>
        {heading} <span className="muted small">({groups.length})</span>
      </h2>
      {groups.length ? (
        <div className="list">
          {groups.slice(0, shown).map((g) => {
            // Followed curators first in the reason line.
            const handles = [...g.curators].sort((a, b) => Number(isFollowed(b)) - Number(isFollowed(a)));
            return <TitleCard key={g.title.key} title={g.title} reason={`Picked by ${handles.map((h) => `@${h}`).join(", ")}`} />;
          })}
        </div>
      ) : (
        <p className="muted">{empty}</p>
      )}
      {groups.length > shown ? (
        <p style={{ textAlign: "center" }}>
          <button type="button" className="btn secondary" onClick={() => setShown((n) => n + PAGE)}>
            Show more
          </button>
        </p>
      ) : null}
    </section>
  );
}

/** Multi-select curator chips. Stores the *deselected* handles, so everything (incl. new curators) is on by default. */
function CuratorFilter({
  counts,
  excluded,
  onChange,
}: {
  counts: Map<string, number>;
  excluded: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const handles = [...counts.keys()].sort(
    (a, b) => Number(isFollowed(b)) - Number(isFollowed(a)) || a.localeCompare(b),
  );
  const toggle = (h: string) => {
    const next = new Set(excluded);
    if (next.has(h)) next.delete(h);
    else next.add(h);
    onChange(next);
  };
  const selected = handles.filter((h) => !excluded.has(h)).length;
  return (
    <details className="filters">
      <summary>
        Curators <span className="muted small">({selected} of {handles.length} selected)</span>
      </summary>
      <div className="filter-row chips">
        <button type="button" className="chip" onClick={() => onChange(new Set())} disabled={selected === handles.length}>
          Select all
        </button>
        <button type="button" className="chip" onClick={() => onChange(new Set(handles))} disabled={selected === 0}>
          Clear
        </button>
      </div>
      <div className="filter-row chips">
        {handles.map((h) => {
          const on = !excluded.has(h);
          return (
            <button key={h} type="button" className={on ? "chip on" : "chip"} aria-pressed={on} onClick={() => toggle(h)}>
              {isFollowed(h) ? "📌 " : ""}@{h} <span className="muted">{counts.get(h)}</span>
            </button>
          );
        })}
      </div>
    </details>
  );
}
export default function PicksPage() {
  const { ready, getTitle, session } = useApp();
  const { picks } = useAllPicks();
  const mine = useStore(activePicks);
  const ownerId = useStore((s) => s.ownerId);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      setExcluded(new Set(JSON.parse(localStorage.getItem(EXCLUDED_KEY) ?? "[]") as string[]));
    } catch {
      /* ignore */
    }
  }, []);
  const updateExcluded = (next: Set<string>) => {
    setExcluded(next);
    localStorage.setItem(EXCLUDED_KEY, JSON.stringify([...next]));
  };
  // "Hide titles on my watchlist" (shared with For you). The hidden set is a snapshot, taken when
  // the page opens, when the setting changes and when you come back to the app, so adding a pick
  // to your watchlist here doesn't make it vanish under your finger.
  const [hideWatchlist, setHideWatchlist] = useHideWatchlist();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [snapTick, setSnapTick] = useState(0);
  useEffect(() => {
    setHidden(hideWatchlist ? new Set(activeWatchlist(getState()).map((w) => w.key)) : new Set());
  }, [hideWatchlist, snapTick, ready]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && setSnapTick((n) => n + 1);
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const counts = useMemo(() => curatorCounts(picks, hidden), [picks, hidden]);
  const grouped = useMemo(() => groupPicks(picks, getTitle, { excluded, hidden }), [picks, excluded, hidden, getTitle]);
  const groupedAll = useMemo(() => groupPicks(picks, getTitle, { excluded }), [picks, excluded, getTitle]);

  if (!ready) return <p className="muted">Loading…</p>;
  const hiddenCount = groupedAll.length - grouped.length;
  const allHidden = hideWatchlist && grouped.length === 0 && groupedAll.length > 0;
  const myOwn = mine.filter((p) => (p.pending || !p.addedBy || p.addedBy === (session?.user.id ?? ownerId)) && !hidden.has(p.key));
  // Remount sections when the selection changes so their "Show more" pagination resets.
  const selectionKey = [...excluded].sort().join(",");
  return (
    <>
      <h1>Curator picks</h1>
      <HideWatchlistToggle checked={hideWatchlist} hiddenCount={hiddenCount} onChange={setHideWatchlist} />
      <AddPickForm />
      {counts.size ? <CuratorFilter counts={counts} excluded={excluded} onChange={updateExcluded} /> : null}
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
      {allHidden ? (
        <div className="notice" role="status">
          <p>
            <strong>All picks are on your watchlist</strong>
            {excluded.size ? " for the selected curators" : ""}.
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={() => setHideWatchlist(false)}>
              Show them
            </button>
            <Link className="btn secondary" href="/watchlist/">
              Open watchlist
            </Link>
          </div>
        </div>
      ) : null}
      {allHidden ? null : (
        <>
          <PickSection
            key={`followed-${selectionKey}-${hideWatchlist}`}
            heading="📌 Picks by followed curators"
            groups={grouped.filter((g) => g.followed)}
            empty="No picks from the selected curators you follow — share a post to the app or add one above."
          />
          <PickSection
            key={`others-${selectionKey}-${hideWatchlist}`}
            heading="Picks by other curators"
            groups={grouped.filter((g) => !g.followed)}
            empty=""
          />
        </>
      )}
      {!groupedAll.length ? (
        <p className="muted small">
          Tip: see <Link href="/account/">Me</Link> for how to install the app so it appears in your phone&apos;s Share sheet.
        </p>
      ) : null}
    </>
  );
}
