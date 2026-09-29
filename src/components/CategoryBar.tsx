"use client";

import { categoryCounts } from "@/lib/categories";

/**
 * Always-visible, horizontally scrollable category chips for the feed.
 * Multi-select (a title matches ANY selected category); "All" clears the selection.
 */
export function CategoryBar({
  titles,
  selected,
  onChange,
}: {
  titles: { genres: readonly number[] }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const cats = categoryCounts(titles, selected);
  if (!cats.length) return null;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id]);
  return (
    <div className="cat-bar" role="group" aria-label="Categories">
      <button type="button" className={selected.length ? "chip cat" : "chip cat on"} aria-pressed={!selected.length} onClick={() => onChange([])}>
        All
      </button>
      {cats.map((c) => {
        const on = selected.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            className={on ? "chip cat on" : "chip cat"}
            aria-pressed={on}
            aria-label={`${c.label}, ${c.count} title${c.count === 1 ? "" : "s"}`}
            onClick={() => toggle(c.id)}
          >
            {c.label} <span className="cat-count">{c.count}</span>
          </button>
        );
      })}
    </div>
  );
}
