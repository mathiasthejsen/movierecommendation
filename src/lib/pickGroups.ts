import { isFollowed } from "./curators";
import type { CuratorPick, Title, TitleKey } from "./types";

/** One title on the Picks page with every (selected) curator who picked it. */
export interface PickGroup {
  title: Title;
  curators: Set<string>;
  followed: boolean;
}

/**
 * Group picks by title for the Picks page: skips deselected curators, titles missing from the
 * catalogue, and titles in `hidden` (the watchlist snapshot when "Hide titles on my watchlist" is on).
 * Most-picked first, then most-voted.
 */
export function groupPicks(
  picks: Iterable<Pick<CuratorPick, "key" | "curator">>,
  getTitle: (key: TitleKey) => Title | null | undefined,
  options: { excluded?: ReadonlySet<string>; hidden?: ReadonlySet<string>; followed?: (handle: string) => boolean } = {},
): PickGroup[] {
  const { excluded, hidden, followed = isFollowed } = options;
  const byKey = new Map<string, PickGroup>();
  for (const p of picks) {
    if (excluded?.has(p.curator) || hidden?.has(p.key)) continue;
    const t = getTitle(p.key);
    if (!t) continue;
    const g = byKey.get(p.key) ?? { title: t, curators: new Set<string>(), followed: false };
    g.curators.add(p.curator);
    g.followed ||= followed(p.curator);
    byKey.set(p.key, g);
  }
  return [...byKey.values()].sort((a, b) => b.curators.size - a.curators.size || b.title.votes - a.title.votes);
}

/**
 * Distinct titles per curator for the curator chips; hidden (watchlist) titles don't count.
 * A curator whose picks are all hidden stays in the map with 0, so its chip can still be toggled.
 */
export function curatorCounts(picks: Iterable<Pick<CuratorPick, "key" | "curator">>, hidden?: ReadonlySet<string>): Map<string, number> {
  const per = new Map<string, Set<string>>();
  for (const p of picks) {
    const s = per.get(p.curator) ?? new Set<string>();
    if (!hidden?.has(p.key)) s.add(p.key);
    per.set(p.curator, s);
  }
  return new Map([...per].map(([h, s]) => [h, s.size]));
}
