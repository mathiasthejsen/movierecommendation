import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, supabaseConfigured } from "./config";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured || typeof window === "undefined") return null;
  client ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      // Stay signed in on this device; tokens refresh automatically.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: "movie-recommender-auth",
    },
  });
  return client;
}

/** Errors Supabase returns when sign-ups are disabled and the email wasn't invited. */
export function isNotInvitedError(err: { message?: string; code?: string; status?: number } | null): boolean {
  if (!err) return false;
  const text = `${err.code ?? ""} ${err.message ?? ""}`.toLowerCase();
  return /signups? not allowed|signup_disabled|otp_disabled|user not found|user_not_found|not allowed for otp/.test(text);
}
