import type { Candidate } from "./extract";
import { normalizeTitle } from "./search";
import type { Title } from "./types";

/** Pick the search result that best matches an extracted candidate (or null). */
export function bestMatch(cand: Candidate, results: Title[]): Title | null {
  const target = normalizeTitle(cand.title);
  let best: Title | null = null;
  let bestScore = 0;
  for (const t of results) {
    const n = normalizeTitle(t.title);
    let s = n === target ? 3 : n.startsWith(target) || target.startsWith(n) ? 1 : 0;
    if (!s) continue;
    if (cand.kind && t.type === cand.kind) s += 1;
    if (cand.year) s += Math.abs(t.year - cand.year) <= 1 ? 2 : -2;
    s += Math.min(1, Math.log10(t.votes + 1) / 5);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return bestScore >= 2.5 ? best : null;
}
