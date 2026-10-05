// Pure logic for the notify-match Edge Function (no Deno globals; unit-tested with vitest).
//
// The client calls POST {key} after adding a title to its watchlist. Nothing the client says is
// trusted: with the service role we re-check that the title really is on the caller's watchlist
// and on the recipients' watchlists, and that everyone involved shares their watchlist.

import { sendPush, type PushSubscriptionKeys, type VapidKeys } from "./webpush.ts";

export const RATE_LIMIT = 20; // notify calls per actor ...
export const RATE_WINDOW_SECONDS = 3600; // ... per hour
export const KEY_RE = /^(movie|tv):[0-9]+$/;

export interface WatchRow {
  user_id: string;
  media_key: string;
  title?: string | null;
}

export interface ProfileRow {
  user_id: string;
  display_name: string | null;
  share_watchlist: boolean | null;
}

export interface SubscriptionRow extends PushSubscriptionKeys {
  user_id: string;
}

export interface NotificationInsert {
  user_id: string;
  actor_id: string;
  title_key: string;
  kind: "match";
}

export interface NotifyStore {
  /** Fixed-window rate limit; true when the call is allowed. */
  consume(actorId: string, limit: number, windowSeconds: number): Promise<boolean>;
  /** Every watchlist row (any user) for this title key. */
  watchRows(key: string): Promise<WatchRow[]>;
  profiles(userIds: string[]): Promise<ProfileRow[]>;
  /** Insert with ON CONFLICT DO NOTHING; returns the recipients whose row was *new*. */
  insertNotifications(rows: NotificationInsert[]): Promise<string[]>;
  subscriptions(userIds: string[]): Promise<SubscriptionRow[]>;
  deleteSubscriptions(endpoints: string[]): Promise<void>;
  touchSubscriptions(endpoints: string[]): Promise<void>;
}

/** A user without a profile row counts as sharing (same rule as the watchlist RLS policy). */
export function isSharing(userId: string, profiles: ProfileRow[]): boolean {
  return profiles.find((p) => p.user_id === userId)?.share_watchlist !== false;
}

/**
 * Who should hear about this match: other members who have `key` on their watchlist and share it.
 * Empty unless the actor really has the title and shares their own watchlist.
 */
export function matchRecipients(actorId: string, key: string, rows: WatchRow[], profiles: ProfileRow[]): string[] {
  if (!KEY_RE.test(key)) return [];
  const onKey = rows.filter((r) => r.media_key === key);
  if (!onKey.some((r) => r.user_id === actorId)) return [];
  if (!isSharing(actorId, profiles)) return [];
  const out = new Set<string>();
  for (const r of onKey) if (r.user_id !== actorId && isSharing(r.user_id, profiles)) out.add(r.user_id);
  return [...out].sort();
}

export function displayName(userId: string, profiles: ProfileRow[]): string {
  const n = profiles.find((p) => p.user_id === userId)?.display_name?.trim();
  return n || "Someone in your family";
}

export function matchPayload(actorName: string, title: string, key: string, basePath: string) {
  const base = basePath.replace(/\/+$/, "");
  return {
    title: "It's a match 🎉",
    body: `🎉 ${actorName} also wants to watch ${title}!`,
    url: `${base}/watchlist/?tab=together&highlight=${encodeURIComponent(key)}`,
    tag: `match:${key}`,
    key,
  };
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export async function handleNotify(args: {
  store: NotifyStore;
  actorId: string;
  key: unknown;
  vapid: VapidKeys | null;
  fetchFn: typeof fetch;
  basePath: string;
}): Promise<Reply> {
  const { store, actorId, vapid, fetchFn, basePath } = args;
  const key = typeof args.key === "string" ? args.key : "";
  if (!KEY_RE.test(key)) return { status: 400, body: { error: "bad key" } };
  if (!(await store.consume(actorId, RATE_LIMIT, RATE_WINDOW_SECONDS))) {
    return { status: 429, body: { error: "rate_limited", retryAfterSeconds: RATE_WINDOW_SECONDS } };
  }
  const rows = await store.watchRows(key);
  const profiles = await store.profiles([...new Set(rows.map((r) => r.user_id))]);
  const recipients = matchRecipients(actorId, key, rows, profiles);
  if (!recipients.length) return { status: 200, body: { notified: 0, pushed: 0, removed: 0 } };

  // Re-adding a title must not spam: only recipients whose (recipient, actor, title, kind) row is new.
  const fresh = await store.insertNotifications(recipients.map((user_id) => ({ user_id, actor_id: actorId, title_key: key, kind: "match" })));
  let pushed = 0;
  let removed = 0;
  if (vapid && fresh.length) {
    const title = rows.find((r) => r.user_id === actorId)?.title?.trim() || rows.find((r) => r.title)?.title?.trim() || "a title";
    const payload = matchPayload(displayName(actorId, profiles), title, key, basePath);
    const subs = await store.subscriptions(fresh);
    const results = await Promise.all(subs.map((s) => sendPush(s, payload, vapid, fetchFn)));
    const gone = results.filter((r) => r.gone).map((r) => r.endpoint);
    const ok = results.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.endpoint);
    if (gone.length) await store.deleteSubscriptions(gone);
    if (ok.length) await store.touchSubscriptions(ok);
    pushed = ok.length;
    removed = gone.length;
  }
  return { status: 200, body: { notified: fresh.length, pushed, removed } };
}

export function vapidFromEnv(env: { get(name: string): string | undefined }): VapidKeys | null {
  const publicKey = env.get("VAPID_PUBLIC_KEY")?.trim();
  const privateKey = env.get("VAPID_PRIVATE_KEY")?.trim();
  const subject = env.get("VAPID_SUBJECT")?.trim();
  return publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null;
}
