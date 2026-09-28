import type { MediaType, Title } from "./types";

export function normalizeTitle(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/^\s*(the|a|an)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Offline search over the artifact catalogue (used when the TMDB proxy is unavailable). */
export function searchCatalog(
  catalog: Iterable<Title>,
  query: string,
  opts: { limit?: number; type?: MediaType | "both"; year?: number } = {},
): Title[] {
  const limit = opts.limit ?? 30;
  const yearMatch = query.match(/\b(19[89]\d|20\d{2})\b/);
  const year = opts.year ?? (yearMatch ? Number(yearMatch[1]) : undefined);
  const q = normalizeTitle(yearMatch && !opts.year ? query.replace(yearMatch[0], "") : query);
  if (!q) return [];
  const words = q.split(" ");
  const scored: { t: Title; s: number }[] = [];
  for (const t of catalog) {
    if (opts.type && opts.type !== "both" && t.type !== opts.type) continue;
    const n = normalizeTitle(t.title);
    let s = 0;
    if (n === q) s = 100;
    else if (n.startsWith(q)) s = 60;
    else if (n.includes(q)) s = 40;
    else if (words.every((w) => n.includes(w))) s = 20;
    else continue;
    if (year && Math.abs(t.year - year) <= 1) s += 30;
    s += Math.min(10, Math.log10(t.votes + 1) * 2);
    scored.push({ t, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.t);
}

/** Well-known titles for onboarding: most voted films spread across genres, plus some series. */
export function onboardingPicks(catalog: Iterable<Title>, count = 48, tvShare = 0.25): Title[] {
  const all = [...catalog].sort((a, b) => b.votes - a.votes);
  const tvCount = Math.round(count * tvShare);
  const pickSpread = (items: Title[], n: number) => {
    const picks: Title[] = [];
    const genreCount = new Map<number, number>();
    for (const t of items) {
      if (picks.length >= n) break;
      const main = t.genres[0] ?? 0;
      const c = genreCount.get(main) ?? 0;
      if (c >= Math.max(3, n / 6)) continue;
      genreCount.set(main, c + 1);
      picks.push(t);
    }
    for (const t of items) {
      if (picks.length >= n) break;
      if (!picks.includes(t)) picks.push(t);
    }
    return picks;
  };
  const shows = pickSpread(all.filter((t) => t.type === "tv"), tvCount);
  const films = pickSpread(all.filter((t) => t.type === "movie"), count - shows.length);
  // Interleave so shows appear throughout the grid.
  const out: Title[] = [];
  const step = shows.length ? Math.max(2, Math.floor((films.length + shows.length) / shows.length)) : Infinity;
  let si = 0;
  for (let i = 0; i < films.length; i++) {
    out.push(films[i]);
    if ((i + 1) % (step - 1) === 0 && si < shows.length) out.push(shows[si++]);
  }
  while (si < shows.length) out.push(shows[si++]);
  return out;
}
