// Supabase Edge Function: "It's a match" notifications to the *other* family member(s).
//
// POST {key}  (user JWT required) — called by the app right after the user added `key` to their
//             watchlist. Using the service role it re-checks that the title is on the caller's and
//             the recipients' watchlists and that everyone involved shares their watchlist, inserts
//             public.notifications rows (unique per recipient/actor/title, so re-adding doesn't spam)
//             and sends Web Push to the recipients' subscriptions. Dead subscriptions (404/410) are
//             deleted. Rate limit: 20 calls per actor per hour.
// GET         -> { publicKey } (the VAPID *public* key, so the site needs no extra build variable).
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto: or https: URL); optional
// APP_BASE_PATH (default /movierecommendation). ALLOWED_ORIGINS as for the other functions.
// Without the VAPID secrets, in-app notifications still work and push is skipped.
//
// Deploy: supabase functions deploy notify-match --no-verify-jwt --use-api   (see README)

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { handleNotify, vapidFromEnv, type NotifyStore } from "./logic.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const BASE_PATH = Deno.env.get("APP_BASE_PATH") ?? "/movierecommendation";
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

const store: NotifyStore = {
  async consume(actorId, limit, windowSeconds) {
    const { data, error } = await admin.rpc("notify_consume", { p_actor: actorId, p_limit: limit, p_window_seconds: windowSeconds });
    if (error) throw error;
    return data === true;
  },
  async watchRows(key) {
    const { data, error } = await admin.from("watchlist").select("user_id, media_key, title").eq("media_key", key);
    if (error) throw error;
    return data ?? [];
  },
  async profiles(userIds) {
    if (!userIds.length) return [];
    const { data, error } = await admin.from("profiles").select("user_id, display_name, share_watchlist").in("user_id", userIds);
    if (error) throw error;
    return data ?? [];
  },
  async insertNotifications(rows) {
    const { data, error } = await admin
      .from("notifications")
      .upsert(rows, { onConflict: "user_id,actor_id,title_key,kind", ignoreDuplicates: true })
      .select("user_id");
    if (error) throw error;
    return (data ?? []).map((r) => r.user_id as string);
  },
  async subscriptions(userIds) {
    const { data, error } = await admin.from("push_subscriptions").select("user_id, endpoint, p256dh, auth").in("user_id", userIds);
    if (error) throw error;
    return data ?? [];
  },
  async deleteSubscriptions(endpoints) {
    await admin.from("push_subscriptions").delete().in("endpoint", endpoints);
  },
  async touchSubscriptions(endpoints) {
    await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).in("endpoint", endpoints);
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

  const vapid = vapidFromEnv(Deno.env);
  if (req.method === "GET") return json({ publicKey: vapid?.publicKey ?? null }, 200, origin);
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405, origin);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "sign in required" }, 401, origin);
  const userClient = createClient(SUPABASE_URL, PUBLIC_KEY, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await userClient.auth.getUser(token);
  if (userError || !userData?.user) return json({ error: "invalid session" }, 401, origin);

  let body: { key?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400, origin);
  }
  try {
    const reply = await handleNotify({ store, actorId: userData.user.id, key: body.key, vapid, fetchFn: fetch, basePath: BASE_PATH });
    const extra: Record<string, string> = reply.status === 429 ? { "Retry-After": String(reply.body.retryAfterSeconds) } : {};
    return json(reply.body, reply.status, origin, extra);
  } catch (err) {
    return json({ error: "internal", message: err instanceof Error ? err.message : "unexpected error" }, 500, origin);
  }
});
