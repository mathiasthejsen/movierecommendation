/**
 * Title extraction for shared text (PWA Share Target) and captions.
 * Mirrors the rules in pipeline/extract.py: bold/italic text, list items
 * (including inline "1. X 2. Y" lists), "Title (Year)", "(TV series)" and
 * "(2008-2013)" markers for series, and "Movies/Shows like X" seed phrases.
 * Runs entirely in the browser; nothing but the resulting matches is saved.
 */

import { normalizeTitle } from "./search";
import type { MediaType, TitleKey } from "./types";

export interface Candidate {
  title: string;
  year: number | null;
  kind: MediaType | null;
}

const TV_MARKER =
  /\s*[([]\s*(?:tv(?:\s+(?:series|show|mini-?series))?|series|show|mini-?series|limited series|docuseries|anime series)\s*[)\]]|\s+(?:tv series|tv show|miniseries|limited series)\s*$/i;
const FILM_MARKER = /\s*[([]\s*(?:film|movie)\s*[)\]]|\s+\(the movie\)\s*$/i;
const YEAR_RANGE = /[\s,]*[([]\s*((?:19|20)\d{2})\s*[-–—]\s*(?:(?:19|20)\d{2}|present|now)?\s*[)\]]/i;
const YEAR_SUFFIX = /[\s,]*[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$/;
const YEAR_INLINE = /^(.{1,80}?)\s*[([]((?:19|20)\d{2})[)\]]/;
const YEAR_COMMA = /^(.{1,80}?),\s*((?:19|20)\d{2})$/;
const MD_LINK = /\[([^\]]+)\]\([^)]*\)/g;
const URL = /https?:\/\/\S+/g;
const BOLD = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+(.+?)\s*$/;
const TRAILING_DESC = /(?:\s+(?:[-–—|]|[Dd]irected by|[Dd]ir\.)\s+|[:,]\s+(?=[a-z])).*$/;
const TV_CONTEXT = /\b(?:shows?|series|tv|television|sitcoms?|anime|miniseries|binge|seasons?|episodes?)\b/i;
const FILM_CONTEXT = /\b(?:movies?|films?|cinema)\b/i;
const SEED_PATTERNS = [
  /\b(?<w>movies?|films?|shows?|series|tv shows?|tv series|sitcoms?|anime|something|anything|stuff|recommendations?|recs?)\s+(?:just\s+)?(?:like|similar to|in the vein of|along the lines of)\s+(?<x>.+)/i,
  /\bif (?:you|i|u)\s+(?:liked|loved|enjoyed|like|love|enjoy)\s+(?<x>.+)/i,
  /\b(?:looking for|want|need)\s+(?:more\s+)?(?<w>movies?|films?|shows?|series)?\s*(?:like|similar to)\s+(?<x>.+)/i,
];
const SEED_STOP =
  /(?:\?|!|\.\s|\.$|,?\s+(?:what|which|then|try|any|anyone|please|pls|suggest|recommend|you|need|must|worth|i(?:'m| am)|for (?:a|my|the)|but|because|that|with)\b).*$/i;
const SPLIT = /\s*(?:,|;|\/|&|\+|\band\b|\bor\b|\bvs\.?\b)\s*/i;
const STOPWORDS = new Set([
  "edit", "update", "spoiler", "spoilers", "this", "that", "yes", "no", "thanks", "thank you", "imo", "honestly",
  "definitely", "seriously", "also", "note", "tldr", "movie", "movies", "film", "films", "watch", "highly recommend",
  "must watch", "so good", "great", "masterpiece", "underrated", "this one", "anything", "everything", "none",
  "show", "shows", "series", "tv", "season", "episode", "link in bio", "follow", "save this",
]);

export function contextKind(text: string): MediaType | null {
  const tv = TV_CONTEXT.test(text);
  const film = FILM_CONTEXT.test(text);
  return tv && !film ? "tv" : film && !tv ? "movie" : null;
}

function stripMarkdown(text: string): string {
  return text.replace(MD_LINK, "$1").replace(URL, "").replace(/\\/g, "");
}

export function splitYear(raw: string): Candidate {
  let s = raw.trim().replace(/^["'“”‘’*_`]+|["'“”‘’*_`]+$/g, "").trim();
  let kind: MediaType | null = null;
  if (TV_MARKER.test(s)) {
    s = s.replace(TV_MARKER, "").trim();
    kind = "tv";
  } else if (FILM_MARKER.test(s)) {
    s = s.replace(FILM_MARKER, "").trim();
    kind = "movie";
  }
  let m = YEAR_RANGE.exec(s);
  if (m) return { title: s.slice(0, m.index).trim(), year: Number(m[1]), kind: "tv" };
  m = YEAR_SUFFIX.exec(s);
  if (m) return { title: s.slice(0, m.index).trim(), year: Number(m[1]), kind };
  m = YEAR_INLINE.exec(s) ?? YEAR_COMMA.exec(s);
  if (m) return { title: m[1].trim(), year: Number(m[2]), kind };
  return { title: s, year: null, kind };
}

function cleanCandidate(input: string, kind: MediaType | null = null): Candidate | null {
  let raw = stripMarkdown(input).replace(/[*_`]+/g, "").trim();
  const marker = (TV_MARKER.exec(raw) ?? FILM_MARKER.exec(raw))?.[0].trim() ?? "";
  const range = YEAR_RANGE.exec(raw);
  const inline = YEAR_INLINE.exec(raw);
  if (range) raw = raw.slice(0, range.index + range[0].length);
  else if (inline) raw = `${inline[1]} (${inline[2]})`;
  else raw = raw.replace(TRAILING_DESC, "");
  if (!range && marker && !raw.includes(marker)) raw = `${raw} ${marker}`;
  const cand = splitYear(raw);
  const title = cand.title.replace(/^[\s.,:;!?\-–—"'“”‘’]+|[\s.,:;!?\-–—"'“”‘’]+$/g, "");
  if (!title || title.length > 80 || title.split(/\s+/).length > 10) return null;
  if (STOPWORDS.has(normalizeTitle(title)) || STOPWORDS.has(title.toLowerCase())) return null;
  if (!/[A-Za-z0-9]/.test(title)) return null;
  return { title, year: cand.year, kind: cand.kind ?? kind };
}

function compatible(a: Candidate, b: Candidate): boolean {
  if (a.kind && b.kind && a.kind !== b.kind) return false;
  return !(a.year && b.year && Math.abs(a.year - b.year) > 1);
}

function dedupe(cands: (Candidate | null)[]): Candidate[] {
  const out: Candidate[] = [];
  for (const c of cands) {
    if (!c) continue;
    const n = normalizeTitle(c.title);
    if (!n) continue;
    const i = out.findIndex((o) => normalizeTitle(o.title) === n && compatible(o, c));
    if (i >= 0) out[i] = { title: out[i].title, year: out[i].year ?? c.year, kind: out[i].kind ?? c.kind };
    else out.push(c);
  }
  return out;
}

function markerAfter(text: string, pos: number): string {
  const m = /^\s*([([][^)\]]{1,20}[)\]])/.exec(text.slice(pos));
  if (!m) return "";
  const g = m[1];
  return TV_MARKER.test(g) || FILM_MARKER.test(g) || YEAR_RANGE.test(g) || YEAR_SUFFIX.test(g) ? ` ${g}` : "";
}

export function extractCandidateTitles(body: string, kind: MediaType | null = null): Candidate[] {
  if (!body) return [];
  const text = stripMarkdown(body);
  const found: (Candidate | null)[] = [];
  for (const m of text.matchAll(BOLD)) found.push(cleanCandidate(m[2] + markerAfter(text, m.index! + m[0].length), kind));
  for (const line of text.split(/\r?\n/)) {
    const lm = LIST_ITEM.exec(line);
    if (lm) {
      const item = lm[1];
      const bold = new RegExp(BOLD.source).exec(item);
      found.push(cleanCandidate(bold ? bold[2] + markerAfter(item, bold.index + bold[0].length) : item, kind));
      continue;
    }
    for (const ym of line.matchAll(/((?:[A-Z0-9][\w'’:.!-]*\s?){1,8})\s*(\(((?:19|20)\d{2})(?:\s*[-–—]\s*(?:(?:19|20)\d{2}|present)?)?\))/g)) {
      found.push(cleanCandidate(`${ym[1].trim()} ${ym[2]}`, kind));
    }
  }
  const stripped = text.trim();
  if (!stripped.includes("\n") && stripped.split(/\s+/).length <= 6 && !found.some(Boolean)) {
    found.push(cleanCandidate(stripped, kind));
  }
  return dedupe(found);
}

export function extractSeedTitles(title: string): Candidate[] {
  const text = stripMarkdown(title);
  const out: (Candidate | null)[] = [];
  for (const m of text.matchAll(BOLD)) out.push(cleanCandidate(m[2]));
  for (const p of SEED_PATTERNS) {
    const m = p.exec(text);
    if (!m?.groups) continue;
    const word = (m.groups.w ?? "").toLowerCase();
    const kind: MediaType | null = TV_CONTEXT.test(word) ? "tv" : FILM_CONTEXT.test(word) ? "movie" : null;
    const phrase = m.groups.x.replace(SEED_STOP, "").replace(/^[\s.,:;!?"']+|[\s.,:;!?"']+$/g, "");
    if (!phrase) continue;
    out.push(cleanCandidate(phrase, kind));
    for (const part of phrase.split(SPLIT)) out.push(cleanCandidate(part, kind));
    break;
  }
  return dedupe(out);
}

function stripSocial(text: string): string {
  return text
    .replace(/(?<!\w)[#@][\w.]+/g, " ")
    .replace(/[\p{Extended_Pictographic}\p{So}\u200d\ufe0f]/gu, "\n")
    .replace(/(?:(?<=\s)|^)(\d{1,2}[.)])\s+(?=\S)/g, "\n$1 ")
    .replace(/[ \t]*[•|·▪►➡→][ \t]*/g, "\n- ");
}

/** (seeds, picks) from shared text or a caption. */
export function extractCaption(text: string): { seeds: Candidate[]; picks: Candidate[] } {
  if (!text?.trim()) return { seeds: [], picks: [] };
  const kind = contextKind(text);
  const lines = stripSocial(stripMarkdown(text))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let seeds: Candidate[] = [];
  let body = lines;
  if (lines.length && SEED_PATTERNS.some((p) => p.test(lines[0]))) {
    let seedLine = lines[0];
    const rest: string[] = [];
    // "Shows like Stranger Things: **Dark**, Severance and 1899" -> seed line + list.
    const colon = seedLine.search(/:\s+/);
    if (colon > 0) {
      const after = seedLine.slice(colon).replace(/^:\s+/, "");
      if (/\*\*|__|\((?:19|20)\d{2}|,|\band\b/.test(after)) {
        seedLine = seedLine.slice(0, colon);
        rest.push(...after.split(SPLIT).map((s) => `- ${s.trim()}`).filter((s) => s.length > 2));
      }
    }
    seeds = extractSeedTitles(seedLine);
    body = [...rest, ...lines.slice(1)];
  }
  const structured = body.filter((l) => LIST_ITEM.test(l) || new RegExp(BOLD.source).test(l) || /\((?:19|20)\d{2}/.test(l));
  const candidates = structured.length ? structured : body.filter((l) => l.split(/\s+/).length <= 6 && !/[.!?:]$/.test(l));
  const seedKeys = new Set(seeds.map((s) => normalizeTitle(s.title)));
  const picks = dedupe(candidates.flatMap((l) => extractCandidateTitles(l, kind))).filter(
    (p) => !seedKeys.has(normalizeTitle(p.title)),
  );
  return { seeds, picks };
}

/** Direct hits from shared URLs: TMDB links give the key; Letterboxd film slugs give a title. */
export function parseSharedUrl(url: string | null | undefined): { key?: TitleKey; candidate?: Candidate; curator?: string } {
  if (!url) return {};
  let u: URL;
  try {
    u = new globalThis.URL(url);
  } catch {
    return {};
  }
  const host = u.hostname.replace(/^www\./, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "themoviedb.org" && (parts[0] === "movie" || parts[0] === "tv")) {
    const id = parseInt(parts[1] ?? "", 10);
    if (id) return { key: `${parts[0]}:${id}` };
  }
  if (host === "letterboxd.com") {
    const i = parts.indexOf("film");
    if (i >= 0 && parts[i + 1]) {
      const slug = parts[i + 1].replace(/-\d{4}$/, "");
      const title = slug.replace(/-/g, " ");
      return { candidate: { title, year: null, kind: "movie" }, curator: i > 0 ? parts[0] : undefined };
    }
  }
  if (host === "tiktok.com" && parts[0]?.startsWith("@")) return { curator: parts[0].slice(1) };
  if (host === "instagram.com" && parts[0] && !["p", "reel", "reels", "tv", "stories"].includes(parts[0])) {
    return { curator: parts[0] };
  }
  return {};
}

/** Find a known curator handle mentioned in shared text or URL. */
export function detectCurator(text: string, url: string | null | undefined, handles: string[], aliases: Record<string, string> = {}): string | null {
  const lower = `${text} ${url ?? ""}`.toLowerCase();
  for (const h of handles) if (lower.includes(`@${h.toLowerCase()}`)) return h;
  const fromUrl = parseSharedUrl(url).curator?.toLowerCase();
  if (fromUrl) {
    const direct = handles.find((h) => h.toLowerCase() === fromUrl);
    if (direct) return direct;
    if (aliases[fromUrl]) return aliases[fromUrl];
  }
  for (const [alias, h] of Object.entries(aliases)) if (lower.includes(`@${alias}`)) return h;
  return null;
}
