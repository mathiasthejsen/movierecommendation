import type { CuratorPick, Edge, MediaType, RatingKind, Source, Title, TitleKey } from "./types";

export interface SourceWeights {
  movielens: number;
  reddit: number;
  tmdb: number;
  trakt: number;
}

export type MediaFilter = MediaType | "both";

export interface RankFilters {
  media?: MediaFilter;
  genres?: number[];
  yearFrom?: number;
  yearTo?: number;
  providers?: number[];
  gemsOnly?: boolean;
  curatedOnly?: boolean;
}

export interface RankOptions {
  minYear?: number;
  weights?: Partial<SourceWeights>;
  /** How strongly similarity to disliked titles is subtracted (0 = ignore dislikes). */
  dislikePenalty?: number;
  /** Multiplier applied to hidden-gem score, e.g. 0.3 = up to +30%. */
  gemBoost?: number;
  /** Bonus multiplier when two or more sources agree on an edge. */
  agreementBonus?: number;
  /** Curator picks: (key -> picks) and curator handle -> weight (disabled curators omitted). */
  picks?: Map<TitleKey, CuratorPick[]>;
  curatorWeights?: Map<string, number>;
  /** Additive score for a curated title, and multiplier on connected ones. */
  curatorBoost?: number;
  filters?: RankFilters;
  exclude?: Iterable<TitleKey>;
  limit?: number;
}

export interface Recommendation {
  title: Title;
  score: number;
  because: { key: TitleKey; title: string }[];
  sources: Source[];
  curators: string[];
  gem: boolean;
  reason: string;
}

export const DEFAULT_WEIGHTS: SourceWeights = { movielens: 1, reddit: 0.9, tmdb: 0.5, trakt: 0.45 };
const SOURCE_ORDER: Source[] = ["reddit", "movielens", "tmdb", "trakt"];
const SOURCE_LABEL: Record<Source, string> = { reddit: "Reddit", movielens: "MovieLens", tmdb: "TMDB", trakt: "Trakt" };
const CURATOR_CAP = 1.5;

/** Map a stored rating to a preference weight in [-1, 1]. 3 stars is neutral. */
export function preferenceWeight(kind: RatingKind, value: number): number {
  if (kind === "thumb") return value > 0 ? 1 : value < 0 ? -1 : 0;
  const table: Record<number, number> = { 1: -1, 2: -0.6, 3: 0, 4: 0.6, 5: 1 };
  return table[Math.round(value)] ?? 0;
}

/** 0..1: high rating and few votes = hidden gem. */
export function gemScore(t: Pick<Title, "rating" | "votes">): number {
  if (t.votes < 50) return 0; // too few votes to trust the rating
  const quality = clamp((t.rating - 6.8) / 1.5, 0, 1);
  const obscurity = 1 - clamp((Math.log10(t.votes + 1) - 2.5) / 1.8, 0, 1);
  return quality * obscurity;
}

export const GEM_THRESHOLD = 0.3;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function curatorScore(
  picks: CuratorPick[] | undefined,
  curatorWeights: Map<string, number> | undefined,
): { score: number; handles: string[] } {
  if (!picks?.length) return { score: 0, handles: [] };
  const best = new Map<string, number>();
  for (const p of picks) {
    const cw = curatorWeights ? curatorWeights.get(p.curator) : 1;
    if (cw === undefined || cw <= 0) continue; // unknown or disabled curator
    const s = cw * clamp(p.weight, 0, 1);
    best.set(p.curator, Math.max(best.get(p.curator) ?? 0, s));
  }
  const handles = [...best.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  const score = Math.min(CURATOR_CAP, [...best.values()].reduce((a, b) => a + b, 0));
  return { score, handles };
}

export function passesFilters(t: Title, filters: RankFilters | undefined, curated = false): boolean {
  if (!filters) return true;
  if (filters.media && filters.media !== "both" && t.type !== filters.media) return false;
  if (filters.genres?.length && !t.genres.some((g) => filters.genres!.includes(g))) return false;
  if (filters.yearFrom && t.year < filters.yearFrom) return false;
  if (filters.yearTo && t.year > filters.yearTo) return false;
  if (filters.providers?.length && !t.providers.some((p) => filters.providers!.includes(p))) return false;
  if (filters.gemsOnly && gemScore(t) < GEM_THRESHOLD) return false;
  if (filters.curatedOnly && !curated) return false;
  return true;
}

function joinNames(names: string[], more: number): string {
  if (names.length === 1) return names[0];
  if (more > 0) return `${names.join(", ")} and ${more} more`;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function formatReason(becauseTitles: string[], sources: Source[], curators: string[], gem: boolean): string {
  const parts: string[] = [];
  if (becauseTitles.length) {
    const shown = becauseTitles.slice(0, 2);
    parts.push(`Because you liked ${joinNames(shown, becauseTitles.length - shown.length)}`);
  }
  if (sources.length) parts.push(sources.map((s) => SOURCE_LABEL[s]).join(" + "));
  if (curators.length) {
    const shown = curators.slice(0, 2).map((h) => `@${h}`);
    parts.push(`Picked by ${joinNames(shown, curators.length - shown.length)}`);
  }
  if (gem) parts.push("Hidden gem");
  return parts.join(" · ");
}

interface Accumulator {
  pos: number;
  neg: number;
  bySeed: Map<TitleKey, number>;
  bySource: Record<Source, number>;
}

const emptyAcc = (): Accumulator => ({
  pos: 0,
  neg: 0,
  bySeed: new Map(),
  bySource: { movielens: 0, reddit: 0, tmdb: 0, trakt: 0 },
});

/**
 * Blend neighbour lists of rated titles (films and series, cross-type edges
 * included) into a ranked recommendation list.
 *
 *   sim(c)  = Σ_liked w·s(l→c) − penalty · Σ_disliked |w|·s(d→c)
 *   s       = Σ_source weight·score / 100, ×(1 + agreementBonus) when ≥2 sources agree
 *   base(c) = sim⁺·(1 + 0.3·boost·cur) + boost·cur − penalty·dislikes,  cur = curator score (≤ 1.5)
 *   score   = base · (1 + gemBoost · gemScore)
 *
 * Curator picks are a fourth source: they lift connected titles and let
 * curated titles appear even without a neighbour edge. Only titles with a
 * positive score that pass the year floor, filters and exclusions are returned.
 */
export function rankRecommendations(
  ratings: Map<TitleKey, number>,
  neighbors: Map<TitleKey, Edge[]>,
  catalog: Map<TitleKey, Title>,
  options: RankOptions = {},
): Recommendation[] {
  const minYear = options.minYear ?? 1980;
  const w = { ...DEFAULT_WEIGHTS, ...options.weights };
  const penalty = options.dislikePenalty ?? 0.8;
  const gemBoost = options.gemBoost ?? 0.3;
  const agreement = options.agreementBonus ?? 0.15;
  const curatorBoost = options.curatorBoost ?? 0.5;
  const exclude = new Set(options.exclude ?? []);
  const acc = new Map<TitleKey, Accumulator>();

  for (const [seed, weight] of ratings) {
    if (!weight) continue;
    const edges = neighbors.get(seed);
    if (!edges) continue;
    for (const [target, ml, rd, tm, tr = 0] of edges) {
      const parts: Record<Source, number> = {
        movielens: (w.movielens * ml) / 100,
        reddit: (w.reddit * rd) / 100,
        tmdb: (w.tmdb * tm) / 100,
        trakt: (w.trakt * tr) / 100,
      };
      const present = [ml, rd, tm, tr].filter((v) => v > 0).length;
      const s = (parts.movielens + parts.reddit + parts.tmdb + parts.trakt) * (present >= 2 ? 1 + agreement : 1);
      if (s <= 0) continue;
      let a = acc.get(target);
      if (!a) acc.set(target, (a = emptyAcc()));
      if (weight > 0) {
        a.pos += weight * s;
        a.bySeed.set(seed, (a.bySeed.get(seed) ?? 0) + weight * s);
        for (const src of SOURCE_ORDER) a.bySource[src] += weight * parts[src];
      } else {
        a.neg += -weight * s;
      }
    }
  }
  // Curated titles are candidates even without an edge from the user's ratings.
  for (const key of options.picks?.keys() ?? []) if (!acc.has(key)) acc.set(key, emptyAcc());

  const out: Recommendation[] = [];
  for (const [key, a] of acc) {
    if (ratings.has(key) || exclude.has(key)) continue;
    const title = catalog.get(key);
    if (!title || title.year < minYear) continue;
    const cur = curatorScore(options.picks?.get(key), options.curatorWeights);
    if (!passesFilters(title, options.filters, cur.score > 0)) continue;
    const base = a.pos * (1 + 0.3 * curatorBoost * cur.score) + curatorBoost * cur.score - penalty * a.neg;
    if (base <= 0) continue;
    const gem = gemScore(title);
    const score = base * (1 + gemBoost * gem);
    const because = [...a.bySeed.entries()]
      .sort((x, y) => y[1] - x[1])
      .map(([sk]) => catalog.get(sk))
      .filter((t): t is Title => Boolean(t))
      .map((t) => ({ key: t.key, title: t.title }));
    const total = SOURCE_ORDER.reduce((sum, s) => sum + a.bySource[s], 0);
    const sources = SOURCE_ORDER.filter((s) => a.bySource[s] > 0 && a.bySource[s] >= 0.15 * total);
    const isGem = gem >= GEM_THRESHOLD;
    out.push({
      title,
      score,
      because,
      sources,
      curators: cur.handles,
      gem: isGem,
      reason: formatReason(
        because.map((b) => b.title),
        sources,
        cur.handles,
        isGem,
      ),
    });
  }
  out.sort((x, y) => y.score - x.score || y.title.votes - x.title.votes);
  return options.limit ? out.slice(0, options.limit) : out;
}

/** Convert ranked TMDB recommendations/similar keys into fallback edges (0-100, TMDB slot). */
export function tmdbFallbackEdges(recommendations: TitleKey[], similar: TitleKey[] = []): Edge[] {
  const scores = new Map<TitleKey, number>();
  recommendations.slice(0, 20).forEach((k, i) => scores.set(k, 90 - 3 * i));
  similar.slice(0, 20).forEach((k, i) => {
    const prev = scores.get(k);
    scores.set(k, prev !== undefined ? Math.min(100, prev + 10) : 65 - 2.5 * i);
  });
  return [...scores.entries()].map(([k, s]) => [k, 0, 0, Math.round(s), 0] as Edge);
}

/** Group picks by key for rankRecommendations(). */
export function indexPicks(picks: Iterable<CuratorPick>): Map<TitleKey, CuratorPick[]> {
  const map = new Map<TitleKey, CuratorPick[]>();
  for (const p of picks) {
    const list = map.get(p.key);
    if (list) list.push(p);
    else map.set(p.key, [p]);
  }
  return map;
}
