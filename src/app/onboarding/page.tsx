"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { SampleBanner } from "@/components/Chrome";
import { RatingTile as Tile } from "@/components/RatingTile";
import { MediaToggle, SearchingHint, SearchStatus, useTitleSearch, type SearchType } from "@/components/TitleSearch";
import { ONBOARDING_TARGET } from "@/lib/config";
import { onboardingPicks } from "@/lib/search";
import { activeRatings, updateSettings, useStore } from "@/lib/store";

export default function OnboardingPage() {
  const { ready, catalog } = useApp();
  const count = useStore((s) => activeRatings(s).length);
  const style = useStore((s) => s.settings.ratingStyle);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<SearchType>("both");
  const { results, more, status, loading } = useTitleSearch(query, type);
  const picks = useMemo(() => onboardingPicks(catalog.values(), 60), [catalog]);

  if (!ready) return <p className="muted">Loading…</p>;
  const pct = Math.min(100, Math.round((count / ONBOARDING_TARGET) * 100));
  const searching = query.trim().length >= 2;
  const list = searching ? results : picks;
  return (
    <>
      <h1>Rate {ONBOARDING_TARGET} titles you know</h1>
      <SampleBanner />
      <div className="progress">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>
            {count} / {ONBOARDING_TARGET} rated
          </span>
          <Link className="btn" href="/" onClick={() => updateSettings({ onboarded: true })}>
            {count >= ONBOARDING_TARGET ? "See my picks →" : "Done"}
          </Link>
        </div>
        <div className="bar" aria-hidden>
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="stack">
        <div className="row">
          <span className="muted small">Rate with</span>
          <div className="segmented" role="radiogroup" aria-label="Rating style">
            <button
              type="button"
              role="radio"
              aria-checked={style === "thumb"}
              className={style === "thumb" ? "on" : ""}
              onClick={() => updateSettings({ ratingStyle: "thumb" })}
            >
              👍👎
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={style === "star"}
              className={style === "star" ? "on" : ""}
              onClick={() => updateSettings({ ratingStyle: "star" })}
            >
              ★ 1-5
            </button>
          </div>
        </div>
        <input type="search" placeholder="Or search for a movie or show you love…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query ? <MediaToggle value={type} onChange={setType} /> : null}
        <SearchStatus status={status} />
      </div>
      <div className="grid" style={{ marginTop: 12 }}>
        {list.map((t) => (
          <Tile key={t.key} title={t} />
        ))}
      </div>
      {searching ? <SearchingHint loading={loading} status={status} /> : null}
      {searching && more.length ? (
        <>
          {results.length ? <h2 className="more-results">More results</h2> : null}
          <div className="grid">
            {more.map((t) => (
              <Tile key={t.key} title={t} />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
