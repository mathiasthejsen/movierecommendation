/**
 * Stable search results (pure logic; tests in searchMerge.test.ts).
 *
 * The offline catalogue answers instantly; live TMDB answers later. Rows that are already on
 * screen must never move, so live results are only ever *appended* as a separate "More results"
 * group. Both groups are ordered by the same relevance score, and keys are deduplicated.
 */

import { normalizeTitle } from "./search";
import type { MediaType, Title, TitleKey } from "./types";

export interface ParsedQuery {
  text: string;
  words: string[];
  year?: number;
}

export function parseQuery(query: string): ParsedQuery {
  const yearMatch = query.match(/\b(19[89]\d|20\d{2})\b/);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;
  const text = normalizeTitle(yearMatch ? query.replace(yearMatch[0], " ") : query) || normalizeTitle(query);
  return { text, words: text.split(" ").filter(Boolean), year };
}

/** Single relevance score: exact > prefix > contains > all words, + year match, + popularity (votes). */
export function relevance(t: Pick<Title, "title" | "year" | "votes">, q: ParsedQuery): number {
  if (!q.text) return 0;
  const n = normalizeTitle(t.title);
  let s: number;
  if (n === q.text) s = 100;
  else if (n.startsWith(q.text)) s = 60;
  else if (n.includes(q.text)) s = 40;
  else if (q.words.length && q.words.every((w) => n.includes(w))) s = 20;
  else s = 5; // live TMDB may match on alternative titles; keep, but rank low
  if (q.year && Math.abs(t.year - q.year) <= 1) s += 30;
  s += Math.min(10, Math.log10((t.votes ?? 0) + 1) * 2);
  return s;
}

/** Deduplicate by key (first wins), then sort by relevance; ties keep the incoming order. */
export function rankByRelevance(titles: Iterable<Title>, query: string, type?: MediaType | "both"): Title[] {
  const q = parseQuery(query);
  const seen = new Set<TitleKey>();
  const out: { t: Title; s: number; i: number }[] = [];
  let i = 0;
  for (const t of titles) {
    if (seen.has(t.key)) continue;
    if (type && type !== "both" && t.type !== type) continue;
    seen.add(t.key);
    out.push({ t, s: relevance(t, q), i: i++ });
  }
  return out.sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.t);
}

/**
 * Merge live results into what's already shown without moving anything:
 * `primary` is returned unchanged; live titles not already shown become `more`
 * (ranked by relevance, deduplicated). If nothing was shown yet, live becomes `primary`.
 */
export function mergeStable(
  shown: { primary: Title[]; more: Title[] },
  live: Title[],
  query: string,
  type?: MediaType | "both",
): { primary: Title[]; more: Title[] } {
  const visible = new Set([...shown.primary, ...shown.more].map((t) => t.key));
  const fresh = rankByRelevance(
    live.filter((t) => !visible.has(t.key)),
    query,
    type,
  );
  if (!shown.primary.length && !shown.more.length) return { primary: fresh, more: [] };
  return { primary: shown.primary, more: [...shown.more, ...fresh] };
}

/** Request ids: only the latest request may update the UI (a slow earlier one is ignored). */
export function createLatestGuard() {
  let current = 0;
  return {
    next(): number {
      current += 1;
      return current;
    },
    isCurrent(id: number): boolean {
      return id === current;
    },
  };
}
