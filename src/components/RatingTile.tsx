"use client";

import { useMemo } from "react";
import { onboardingPicks } from "@/lib/search";
import { activeRatings, useStore } from "@/lib/store";
import type { Title } from "@/lib/types";
import { useApp } from "./AppProvider";
import { RatingControl } from "./RatingControl";
import { Poster, TypeBadge } from "./TitleCard";

/** Poster tile with inline rating (onboarding grid, TV nudge). */
export function RatingTile({ title }: { title: Title }) {
  return (
    <div className="tile">
      <Poster title={title} size="w185" />
      <h3>
        {title.title} <TypeBadge title={title} />
      </h3>
      <span className="muted small">{title.year}</span>
      <RatingControl title={title} />
    </div>
  );
}

/** How many series someone has to rate before the TV nudge goes away. */
export const TV_NUDGE_RATED = 3;

/**
 * "Rate a few shows to improve TV picks": well-known series (the onboarding TV picks) to rate
 * inline. Shown on the For you feed when the TV filter is on and there are few TV candidates.
 */
export function TvRatingNudge({ count = 8 }: { count?: number }) {
  const { catalog } = useApp();
  const ratings = useStore(activeRatings);
  const rated = useMemo(() => new Set(ratings.map((r) => r.key)), [ratings]);
  // Picked once per catalogue; already-rated shows stay visible (dimmed by their rating state) so the grid doesn't jump.
  const shows = useMemo(() => onboardingPicks(catalog.values(), count * 3, 1).filter((t) => t.type === "tv"), [catalog, count]);
  const initial = useMemo(() => shows.filter((t) => !rated.has(t.key)).slice(0, count), [shows]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!initial.length) return null;
  return (
    <section className="notice tv-nudge" aria-labelledby="tv-nudge-heading">
      <h2 id="tv-nudge-heading" style={{ margin: 0 }}>
        📺 Rate a few shows to improve TV picks
      </h2>
      <p className="small muted">
        Your TV picks so far come from films you liked. Rating a handful of series you know makes them much more personal.
      </p>
      <div className="grid">
        {initial.map((t) => (
          <RatingTile key={t.key} title={t} />
        ))}
      </div>
    </section>
  );
}
