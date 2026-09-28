"use client";

import { preferenceWeight } from "@/lib/ranking";
import { rate, useStore } from "@/lib/store";
import type { Title } from "@/lib/types";

export function RatingControl({ title }: { title: Title }) {
  const style = useStore((s) => s.settings.ratingStyle);
  const current = useStore((s) => s.ratings[title.key]);
  const active = current && !current.deleted ? current : null;

  if (style === "thumb") {
    const w = active ? preferenceWeight(active.kind, active.value) : 0;
    return (
      <div className="rating" role="group" aria-label={`Rate ${title.title}`}>
        <button
          type="button"
          className={active && w < 0 ? "chip on down" : "chip"}
          aria-pressed={Boolean(active && w < 0)}
          onClick={() => rate(title.key, "thumb", -1, title)}
        >
          👎
        </button>
        <button
          type="button"
          className={active && w > 0 ? "chip on up" : "chip"}
          aria-pressed={Boolean(active && w > 0)}
          onClick={() => rate(title.key, "thumb", 1, title)}
        >
          👍
        </button>
      </div>
    );
  }
  const stars = active ? (active.kind === "star" ? active.value : active.value > 0 ? 5 : 1) : 0;
  return (
    <div className="rating stars" role="group" aria-label={`Rate ${title.title} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          className={n <= stars ? "star on" : "star"}
          aria-label={`${n} star${n > 1 ? "s" : ""}`}
          aria-pressed={n === stars}
          onClick={() => rate(title.key, "star", n, title)}
        >
          ★
        </button>
      ))}
    </div>
  );
}
