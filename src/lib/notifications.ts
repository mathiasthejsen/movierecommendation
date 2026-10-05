"use client";

import { useRef, useSyncExternalStore } from "react";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";
import { getSupabase } from "./supabase";
import type { TitleKey } from "./types";

/**
 * In-app "It's a match" notifications (public.notifications, own rows via RLS), cached in
 * localStorage for offline use. Rows are created only by the notify-match Edge Function.
 */

export const NOTIFY_URL = SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/notify-match` : "";
const KEY = "movie-recommender:notifications:v1";
const MAX = 50;

export interface AppNotification {
  id: string;
  userId: string;
  actorId: string;
  key: TitleKey;
  kind: "match";
  createdAt: string;
  readAt: string | null;
}

export interface NotificationsState {
  meId: string | null;
  items: AppNotification[];
  fetchedAt: string | null;
}

interface Row {
  id: string;
  user_id: string;
  actor_id: string;
  title_key: string;
  kind: string;
  created_at: string;
  read_at: string | null;
}

export function fromRow(r: Row): AppNotification {
  return {
    id: r.id, userId: r.user_id, actorId: r.actor_id, key: r.title_key as TitleKey, kind: "match",
    createdAt: r.created_at, readAt: r.read_at,
  };
}

/** Unread badge count: only notifications addressed to me that haven't been read. */
export function unreadCount(items: AppNotification[], meId: string | null): number {
  return items.filter((n) => !n.readAt && (!meId || n.userId === meId)).length;
}

/** Merge by id (incoming wins, but a local read mark is kept), newest first, capped. */
export function mergeNotifications(existing: AppNotification[], incoming: AppNotification[]): AppNotification[] {
  const byId = new Map(existing.map((n) => [n.id, n]));
  for (const n of incoming) {
    const prev = byId.get(n.id);
    byId.set(n.id, prev?.readAt && !n.readAt ? { ...n, readAt: prev.readAt } : n);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX);
}

const empty: NotificationsState = { meId: null, items: [], fetchedAt: null };
let state: NotificationsState = empty;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = { ...empty, ...(JSON.parse(raw) as NotificationsState) };
  } catch {
    state = empty;
  }
}

function set(next: NotificationsState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function getNotifications(): NotificationsState {
  load();
  return state;
}

export function useNotifications<T>(selector: (s: NotificationsState) => T): T {
  const cache = useRef<{ s: NotificationsState | null; v: T }>({ s: null, v: undefined as T });
  const select = (s: NotificationsState) => {
    if (cache.current.s !== s) cache.current = { s, v: selector(s) };
    return cache.current.v;
  };
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(getNotifications()),
    () => select(empty),
  );
}

async function session() {
  const supabase = getSupabase();
  if (!supabase) return null;
  return (await supabase.auth.getSession()).data.session;
}

let inflight: Promise<void> | null = null;

/** Load my latest notifications (on app open, focus and ↻ Refresh). */
export function refreshNotifications(): Promise<void> {
  inflight ??= doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh() {
  const supabase = getSupabase();
  const s = await session();
  if (!supabase || !s) return;
  const { data, error } = await supabase
    .from("notifications")
    .select("id,user_id,actor_id,title_key,kind,created_at,read_at")
    .order("created_at", { ascending: false })
    .limit(MAX);
  if (error) return; // offline or table not deployed yet: keep the cache
  const cur = getNotifications();
  const base = cur.meId === s.user.id ? cur.items : []; // don't mix people on a shared device
  set({ meId: s.user.id, items: mergeNotifications(base.filter((n) => data.some((r) => r.id === n.id)), (data as Row[]).map(fromRow)), fetchedAt: new Date().toISOString() });
}

/** Mark notifications read (optimistic; RLS only lets me update my own read_at). */
export async function markRead(ids: string[]): Promise<void> {
  const cur = getNotifications();
  const unread = ids.filter((id) => cur.items.some((n) => n.id === id && !n.readAt));
  if (!unread.length) return;
  const now = new Date().toISOString();
  set({ ...cur, items: cur.items.map((n) => (unread.includes(n.id) ? { ...n, readAt: now } : n)) });
  const supabase = getSupabase();
  if (!supabase || !(await session())) return;
  await supabase.from("notifications").update({ read_at: now }).in("id", unread);
}

/** Live INSERTs while the app is open (Supabase Realtime; RLS limits it to my rows). */
export function subscribeNotifications(userId: string, onInsert?: () => void): () => void {
  const supabase = getSupabase();
  if (!supabase) return () => undefined;
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` },
      (payload) => {
        const cur = getNotifications();
        if (cur.meId && cur.meId !== userId) return;
        set({ ...cur, meId: userId, items: mergeNotifications(cur.items, [fromRow(payload.new as Row)]) });
        onInsert?.();
      },
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}

export function clearNotifications() {
  set(empty);
}

/**
 * Tell the server I just added `key` to my watchlist. The Edge Function re-checks everything
 * itself and notifies family members who already have it. Fire-and-forget; never throws.
 */
export async function notifyMatch(key: TitleKey): Promise<void> {
  if (!NOTIFY_URL) return;
  try {
    const s = await session();
    if (!s) return;
    await fetch(NOTIFY_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.access_token}`, apikey: SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      keepalive: true,
    });
  } catch {
    /* offline: the partner still sees the match in Together */
  }
}
