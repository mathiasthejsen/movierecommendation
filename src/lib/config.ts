/** Public, build-time configuration. Everything here ends up in the browser bundle. */

export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
export const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "");
// The anon/publishable key is designed to be public; row-level security protects the data.
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
export const TMDB_PROXY_URL =
  process.env.NEXT_PUBLIC_TMDB_PROXY_URL ||
  (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/tmdb-proxy` : "");

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const ONBOARDING_TARGET = 15;

export function asset(path: string): string {
  return `${BASE_PATH}${path.startsWith("/") ? path : `/${path}`}`;
}

export function posterUrl(path: string | null, size: "w185" | "w342" | "w500" = "w342"): string | null {
  return path ? `https://image.tmdb.org/t/p/${size}${path}` : null;
}
