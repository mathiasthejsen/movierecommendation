"use client";

import { useApp } from "./AppProvider";
import { MediaToggle } from "./TitleSearch";
import type { RankFilters, MediaFilter } from "@/lib/ranking";

const DECADES = [1980, 1990, 2000, 2010, 2020];

export function Filters({ value, onChange }: { value: RankFilters; onChange: (f: RankFilters) => void }) {
  const { meta } = useApp();
  const set = (patch: Partial<RankFilters>) => onChange({ ...value, ...patch });
  const genres = Object.entries(meta?.genres ?? {}).sort((a, b) => a[1].localeCompare(b[1]));
  const providers = Object.entries(meta?.providers ?? {}).slice(0, 12);
  const toggleProvider = (id: number) => {
    const cur = value.providers ?? [];
    set({ providers: cur.includes(id) ? cur.filter((p) => p !== id) : [...cur, id] });
  };
  return (
    <details className="filters">
      <summary>Filters</summary>
      <div className="filter-row">
        <MediaToggle value={value.media ?? "both"} onChange={(m) => set({ media: m as MediaFilter })} />
      </div>
      <div className="filter-row">
        <label>
          Genre{" "}
          <select
            value={value.genres?.[0] ?? ""}
            onChange={(e) => set({ genres: e.target.value ? [Number(e.target.value)] : [] })}
          >
            <option value="">Any</option>
            {genres.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          From{" "}
          <select value={value.yearFrom ?? ""} onChange={(e) => set({ yearFrom: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">1980</option>
            {DECADES.slice(1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label>
          To{" "}
          <select value={value.yearTo ?? ""} onChange={(e) => set({ yearTo: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">Now</option>
            {DECADES.map((d) => (
              <option key={d} value={d + 9}>
                {d + 9}
              </option>
            ))}
          </select>
        </label>
      </div>
      {providers.length ? (
        <div className="filter-row chips" aria-label={`Streaming in ${meta?.region ?? ""}`}>
          {providers.map(([id, p]) => (
            <button
              key={id}
              type="button"
              className={value.providers?.includes(Number(id)) ? "chip on" : "chip"}
              aria-pressed={Boolean(value.providers?.includes(Number(id)))}
              onClick={() => toggleProvider(Number(id))}
            >
              {p.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="filter-row chips">
        <button type="button" className={value.gemsOnly ? "chip on" : "chip"} aria-pressed={Boolean(value.gemsOnly)} onClick={() => set({ gemsOnly: !value.gemsOnly })}>
          💎 Hidden gems
        </button>
        <button type="button" className="chip" onClick={() => onChange({ media: value.media })}>
          Reset
        </button>
      </div>
    </details>
  );
}
