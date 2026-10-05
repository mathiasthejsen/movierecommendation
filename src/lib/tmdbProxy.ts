import { SUPABASE_ANON_KEY, TMDB_PROXY_URL } from "./config";
import { getSupabase } from "./supabase";
import type { MediaType, Title, TitleKey } from "./types";

/**
 * Client for the Supabase Edge Function that proxies TMDB (supabase/functions/tmdb-proxy).
 * The TMDB key lives only in Supabase secrets; the function requires a signed-in user.
 * Every call resolves to null when the proxy is unavailable so callers can fall back
 * to the offline artifact.
 */

export type ProxyStatus = "ok" | "not-configured" | "signed-out" | "error";

async function call<T>(params: Record<string, string>, signal?: AbortSignal): Promise<{ status: ProxyStatus; data: T | null }> {
  if (!TMDB_PROXY_URL) return { status: "not-configured", data: null };
  const supabase = getSupabase();
  const token = supabase ? (await supabase.auth.getSession()).data.session?.access_token : undefined;
  if (!token) return { status: "signed-out", data: null };
  try {
    const url = `${TMDB_PROXY_URL}?${new URLSearchParams(params)}`;
    const res = await fetch(url, { signal, headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } });
    if (!res.ok) return { status: "error", data: null };
    return { status: "ok", data: (await res.json()) as T };
  } catch {
    return { status: "error", data: null };
  }
}

export async function proxySearch(query: string, type: MediaType | "multi" = "multi", year?: number, signal?: AbortSignal) {
  const params: Record<string, string> = { action: "search", q: query, type };
  if (year) params.year = String(year);
  return call<{ results: Title[] }>(params, signal);
}

export async function proxyRecommendations(key: TitleKey) {
  return call<{ recommendations: Title[]; similar: Title[] }>({ action: "recommendations", key });
}

export async function proxyDetails(key: TitleKey) {
  return call<{ title: Title }>({ action: "details", key });
}
