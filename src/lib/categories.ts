/**
 * Unified categories across movies and TV.
 *
 * TMDB uses different genre IDs for movies and series (e.g. "Action & Adventure" is
 * 28 + 12 for films but 10759 for TV). This is the single place that maps both onto
 * one set of user-facing categories. IDs don't collide between the two lists, so one
 * lookup table works for any title, whether its genres were already normalised by the
 * pipeline or came raw from live TMDB search.
 */

export interface Category {
  id: string;
  label: string;
  movie: number[];
  tv: number[];
}

export const CATEGORIES: Category[] = [
  { id: "action", label: "Action & Adventure", movie: [28, 12], tv: [10759] },
  { id: "scifi", label: "Sci-Fi & Fantasy", movie: [878, 14], tv: [10765] },
  { id: "war", label: "War & Politics", movie: [10752], tv: [10768] },
  { id: "comedy", label: "Comedy", movie: [35], tv: [35] },
  // Soap operas (TV only) read best as drama.
  { id: "drama", label: "Drama", movie: [18], tv: [18, 10766] },
  { id: "thriller", label: "Thriller", movie: [53], tv: [] },
  { id: "crime", label: "Crime", movie: [80], tv: [80] },
  { id: "horror", label: "Horror", movie: [27], tv: [] },
  { id: "mystery", label: "Mystery", movie: [9648], tv: [9648] },
  { id: "romance", label: "Romance", movie: [10749], tv: [] },
  { id: "animation", label: "Animation", movie: [16], tv: [16] },
  { id: "documentary", label: "Documentary", movie: [99], tv: [99] },
  { id: "family", label: "Family", movie: [10751], tv: [10751, 10762] },
  { id: "history", label: "History", movie: [36], tv: [] },
  { id: "music", label: "Music", movie: [10402], tv: [] },
  { id: "western", label: "Western", movie: [37], tv: [37] },
  // TV-only formats without a film equivalent.
  { id: "reality", label: "Reality & Talk", movie: [], tv: [10763, 10764, 10767] },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

/** TMDB genre ID (movie or TV) -> category IDs. */
export const GENRE_TO_CATEGORIES: ReadonlyMap<number, readonly string[]> = (() => {
  const map = new Map<number, string[]>();
  for (const c of CATEGORIES) {
    for (const g of [...c.movie, ...c.tv]) {
      const list = map.get(g) ?? [];
      if (!list.includes(c.id)) list.push(c.id);
      map.set(g, list);
    }
  }
  return map;
})();

export function isCategory(id: unknown): id is string {
  return typeof id === "string" && BY_ID.has(id);
}

export function categoryLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/** Categories of a title from its genre IDs (unmapped IDs, e.g. "TV Movie", are ignored). */
export function categoriesOf(genres: readonly number[]): Set<string> {
  const out = new Set<string>();
  for (const g of genres) for (const c of GENRE_TO_CATEGORIES.get(g) ?? []) out.add(c);
  return out;
}

/** Map old saved genre-ID filters to categories (deduplicated, order preserved). */
export function genresToCategories(genres: readonly number[]): string[] {
  const out: string[] = [];
  for (const g of genres) for (const c of GENRE_TO_CATEGORIES.get(g) ?? []) if (!out.includes(c)) out.push(c);
  return out;
}

/**
 * Categories that occur among the given titles, most frequent first (ties keep
 * CATEGORIES order). `always` keeps selected categories visible even at zero,
 * so a selection can always be undone.
 */
export function categoryCounts(
  titles: Iterable<{ genres: readonly number[] }>,
  always: readonly string[] = [],
): { id: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const t of titles) for (const c of categoriesOf(t.genres)) counts.set(c, (counts.get(c) ?? 0) + 1);
  for (const id of always) if (isCategory(id) && !counts.has(id)) counts.set(id, 0);
  const order = new Map(CATEGORIES.map((c, i) => [c.id, i]));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (order.get(a[0]) ?? 0) - (order.get(b[0]) ?? 0))
    .map(([id, count]) => ({ id, label: categoryLabel(id), count }));
}
