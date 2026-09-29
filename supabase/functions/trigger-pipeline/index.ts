// Supabase Edge Function: start the weekly data pipeline on demand ("Update data now").
//
// * Requires a valid Supabase *user* session JWT (same check as tmdb-proxy); sign-ups are off,
//   so only invited family members can call it. CORS only for ALLOWED_ORIGINS.
// * GH_TOKEN (fine-grained PAT: this one repo, Actions read & write), GH_OWNER and GH_REPO are
//   Supabase secrets and never reach the browser. Optional: GH_WORKFLOW (deploy.yml), GH_REF (main).
// * At most one trigger per hour for the whole family, recorded in public.pipeline_runs
//   (service role only). Won't dispatch while a run is queued or in progress.
//
// GET  -> { configured, run: {status, conclusion, updated_at, ...}, active, cooldownRemainingSeconds }
// POST -> 202 started | 409 already_running | 429 cooldown (retryAfterSeconds) | 502 github_error
//
// Deploy: supabase functions deploy trigger-pipeline --no-verify-jwt --use-api   (see README)

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { COOLDOWN_SECONDS, handleStatus, handleTrigger, isConfigured, type TriggerStore } from "./logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);

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

const PUBLIC_KEY = injectedKey("SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_ANON_KEY");
const admin = createClient(SUPABASE_URL, injectedKey("SUPABASE_SECRET_KEYS", "SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { persistSession: false },
});

const store: TriggerStore = {
  async lastTriggerAt() {
    const { data, error } = await admin
      .from("pipeline_runs")
      .select("created_at")
      .in("github_status", ["pending", "dispatched"])
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    return data?.[0]?.created_at ?? null;
  },
  async reserve(userId, cooldownSeconds) {
    const { data, error } = await admin.rpc("pipeline_reserve", { p_user: userId, p_cooldown_seconds: cooldownSeconds });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return { ok: Boolean(row?.ok), retryAfterSeconds: Number(row?.retry_after_seconds ?? 0), id: row?.run_id ?? null };
  },
  async finish(id, status) {
    await admin.from("pipeline_runs").update({ github_status: status }).eq("id", id);
  },
};

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...corsHeaders(origin), ...extra },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "origin not allowed" }, 403, null);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "GET" && req.method !== "POST") return json({ error: "method not allowed" }, 405, origin);

  // Same auth as tmdb-proxy: a real signed-in user, not just the public key.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign in required" }, 401, origin);
  const userClient = createClient(SUPABASE_URL, PUBLIC_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "invalid session" }, 401, origin);

  const cfg = isConfigured(Deno.env);
  try {
    const reply =
      req.method === "GET"
        ? await handleStatus({ fetchFn: fetch, cfg, store, now: Date.now() })
        : await handleTrigger({ fetchFn: fetch, cfg, store, userId: userData.user.id, now: Date.now(), cooldownSeconds: COOLDOWN_SECONDS });
    const extra: Record<string, string> =
      reply.status === 429 ? { "Retry-After": String(reply.body.retryAfterSeconds ?? COOLDOWN_SECONDS) } : {};
    return json(reply.body, reply.status, origin, extra);
  } catch (err) {
    return json({ error: "internal", message: err instanceof Error ? err.message : "unexpected error" }, 500, origin);
  }
});
