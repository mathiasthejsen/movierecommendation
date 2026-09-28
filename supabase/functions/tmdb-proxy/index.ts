// Supabase Edge Function: a small TMDB proxy for the static site.
//
// * The TMDB key is a Supabase secret (TMDB_API_KEY or TMDB_READ_TOKEN); it never reaches the browser.
// * Requires a valid Supabase *user* session JWT (verified with auth.getUser); the public anon key
//   alone is rejected. Sign-ups are disabled, so only invited family members can get one.
// * CORS only for ALLOWED_ORIGINS (comma-separated, e.g. "https://you.github.io,http://localhost:3000").
// * Per-user fixed-window rate limit (PROXY_RATE_LIMIT requests per hour, default 120) via the
//   tmdb_proxy_consume() SQL function, called with the service role.
//
// GET ?action=search&q=...&type=multi|movie|tv[&year=YYYY]
// GET ?action=recommendations&key=movie:603
// GET ?action=details&key=tv:1396
//
// Deploy: supabase functions deploy tmdb-proxy --no-verify-jwt   (see README)

import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const TMDB = "https://api.themoviedb.org/3";
const TMDB_API_KEY = Deno.env.get("TMDB_API_KEY") ?? "";
const TMDB_READ_TOKEN = Deno.env.get("TMDB_READ_TOKEN") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";

/** New projects expose API keys as JSON maps (SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS); older ones use the legacy vars. */
function injectedKey(jsonVar: string, legacyVar: string): string {
  const raw = Deno.env.get(jsonVar);
  if (raw) {
    try {
      const keys = JSON.parse(raw) as Record<string, string>;
      const key = keys["default"] ?? Object.values(keys)[0];
      if (key) return key;
    } catch {
      /* fall back to the legacy variable */
    }
  }
  return Deno.env.get(legacyVar) ?? "";
}

const SUPABASE_PUBLIC_KEY = injectedKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const SUPABASE_ADMIN_KEY = injectedKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY");
const REGION = (Deno.env.get("WATCH_REGION") ?? "US").toUpperCase();
const RATE_LIMIT = Number(Deno.env.get("PROXY_RATE_LIMIT") ?? "120");
const WINDOW_SECONDS = 3600;
const MIN_YEAR = 1980;
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const TV_GENRE_MAP: Record<number, number[]> = { 10759: [28, 12], 10765: [878, 14], 10768: [10752, 36] };

const admin = createClient(SUPABASE_URL, SUPABASE_ADMIN_KEY, { auth: { persistSession: false } });

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(body: unknown, status: number, origin: string | null, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin), ...extra },
  });
}

async function tmdb(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${TMDB}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (TMDB_READ_TOKEN) headers.Authorization = `Bearer ${TMDB_READ_TOKEN}`;
  else url.searchParams.set("api_key", TMDB_API_KEY);
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  return res.json();
}

function mapGenres(ids: number[]): number[] {
  const out: number[] = [];
  for (const g of ids) for (const m of TV_GENRE_MAP[g] ?? [g]) if (!out.includes(m)) out.push(m);
  return out;
}

/** TMDB result/details -> the app's Title shape. */
function toTitle(r: any, fallbackType: "movie" | "tv"): any | null {
  const type = r.media_type === "tv" || r.media_type === "movie" ? r.media_type : fallbackType;
  const date: string = (type === "tv" ? r.first_air_date : r.release_date) ?? "";
  const year = Number(date.slice(0, 4)) || 0;
  if (r.adult) return null;
  const region = r["watch/providers"]?.results?.[REGION] ?? {};
  const providers = [
    ...new Set(["flatrate", "free", "ads"].flatMap((k) => (region[k] ?? []).map((p: any) => p.provider_id as number))),
  ];
  const runtime = type === "tv" ? (r.episode_run_time?.[0] ?? null) : (r.runtime ?? null);
  return {
    key: `${type}:${r.id}`,
    type,
    tmdbId: r.id,
    title: r.title ?? r.name ?? r.original_title ?? r.original_name ?? "",
    year,
    genres: mapGenres(r.genre_ids ?? (r.genres ?? []).map((g: any) => g.id)),
    poster: r.poster_path ?? null,
    runtime: runtime || null,
    rating: r.vote_average ?? 0,
    votes: r.vote_count ?? 0,
    popularity: r.popularity ?? 0,
    providers,
    overview: (r.overview ?? "").slice(0, 400),
    seasons: type === "tv" ? (r.number_of_seasons ?? null) : null,
    status: type === "tv" && r.status ? (/^(ended|canceled|cancelled)$/i.test(r.status) ? "ended" : "ongoing") : null,
  };
}

const KEY_RE = /^(movie|tv):(\d{1,10})$/;

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, null);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405, origin);
  if (!TMDB_API_KEY && !TMDB_READ_TOKEN) return json({ error: "proxy not configured" }, 503, origin);

  // 1. Require a real signed-in user (not just the public anon key).
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign in required" }, 401, origin);
  const userClient = createClient(SUPABASE_URL, SUPABASE_PUBLIC_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "invalid session" }, 401, origin);

  // 2. Per-user rate limit.
  const { data: allowed, error: rlError } = await admin.rpc("tmdb_proxy_consume", {
    p_user: userData.user.id,
    p_limit: RATE_LIMIT,
    p_window_seconds: WINDOW_SECONDS,
  });
  if (rlError) return json({ error: "rate limiter unavailable" }, 503, origin);
  if (!allowed) return json({ error: "rate limit exceeded" }, 429, origin, { "Retry-After": "600" });

  // 3. Route.
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  try {
    if (action === "search") {
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 100);
      const type = url.searchParams.get("type") ?? "multi";
      const year = url.searchParams.get("year");
      if (q.length < 2 || !["multi", "movie", "tv"].includes(type)) return json({ error: "bad query" }, 400, origin);
      const params: Record<string, string> = { query: q, include_adult: "false" };
      if (year && /^\d{4}$/.test(year)) params[type === "tv" ? "first_air_date_year" : "year"] = year;
      const data = await tmdb(`/search/${type}`, params);
      const results = (data?.results ?? [])
        .filter((r: any) => type !== "multi" || r.media_type === "movie" || r.media_type === "tv")
        .map((r: any) => toTitle(r, type === "tv" ? "tv" : "movie"))
        .filter((t: any) => t && t.year >= MIN_YEAR)
        .slice(0, 20);
      return json({ results }, 200, origin, { "Cache-Control": "private, max-age=3600" });
    }
    const key = url.searchParams.get("key") ?? "";
    const m = KEY_RE.exec(key);
    if (!m) return json({ error: "bad key" }, 400, origin);
    const [, type, id] = m as unknown as [string, "movie" | "tv", string];
    if (action === "recommendations") {
      const [recs, similar] = await Promise.all([tmdb(`/${type}/${id}/recommendations`), tmdb(`/${type}/${id}/similar`)]);
      const clean = (d: any) =>
        (d?.results ?? []).map((r: any) => toTitle(r, type)).filter((t: any) => t && t.year >= MIN_YEAR).slice(0, 20);
      return json({ recommendations: clean(recs), similar: clean(similar) }, 200, origin, { "Cache-Control": "private, max-age=86400" });
    }
    if (action === "details") {
      const d = await tmdb(`/${type}/${id}`, { append_to_response: "watch/providers" });
      if (!d) return json({ error: "not found" }, 404, origin);
      return json({ title: toTitle({ ...d, media_type: type }, type) }, 200, origin, { "Cache-Control": "private, max-age=86400" });
    }
    return json({ error: "unknown action" }, 400, origin);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "upstream error" }, 502, origin);
  }
});
