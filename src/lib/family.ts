"use client";

import { useRef, useSyncExternalStore } from "react";
import { getSupabase } from "./supabase";
import { defaultDisplayName, type FamilyItem, type Profile } from "./together";

/**
 * Family data (profiles + everyone's shared watchlists), cached in localStorage for offline use.
 * My own watchlist edits live in lib/store.ts; this is the read-only family view.
 */

const KEY = "movie-recommender:family:v1";

export interface FamilyState {
  meId: string | null;
  profiles: Profile[];
  items: FamilyItem[];
  fetchedAt: string | null;
  error: string | null;
}

const empty: FamilyState = { meId: null, profiles: [], items: [], fetchedAt: null, error: null };
let state: FamilyState = empty;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) state = { ...empty, ...(JSON.parse(raw) as FamilyState) };
  } catch {
    state = empty;
  }
}

function set(next: FamilyState) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function getFamily(): FamilyState {
  load();
  return state;
}

export function useFamily<T>(selector: (s: FamilyState) => T): T {
  const cache = useRef<{ s: FamilyState | null; v: T }>({ s: null, v: undefined as T });
  const select = (s: FamilyState) => {
    if (cache.current.s !== s) cache.current = { s, v: selector(s) };
    return cache.current.v;
  };
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(getFamily()),
    () => select(empty),
  );
}

async function currentUser() {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user ?? null;
}

/** Create my profile on first sign-in (name = part of my email before "@"). */
export async function ensureProfile(): Promise<void> {
  const supabase = getSupabase();
  const user = await currentUser();
  if (!supabase || !user) return;
  const { data, error } = await supabase.from("profiles").select("user_id").eq("user_id", user.id).maybeSingle();
  if (error || data) return;
  await supabase.from("profiles").insert({ user_id: user.id, display_name: defaultDisplayName(user.email) });
}

export async function saveProfile(patch: { displayName?: string; shareWatchlist?: boolean }): Promise<string | null> {
  const supabase = getSupabase();
  const user = await currentUser();
  if (!supabase || !user) return "Not signed in.";
  const row: Record<string, unknown> = { user_id: user.id };
  if (patch.displayName !== undefined) row.display_name = patch.displayName.trim().slice(0, 40) || defaultDisplayName(user.email);
  if (patch.shareWatchlist !== undefined) row.share_watchlist = patch.shareWatchlist;
  const existing = getFamily().profiles.find((p) => p.userId === user.id);
  if (!("display_name" in row)) row.display_name = existing?.displayName || defaultDisplayName(user.email);
  const { error } = await supabase.from("profiles").upsert(row, { onConflict: "user_id" });
  if (error) return error.message;
  await refreshFamily();
  return null;
}

let inflight: Promise<void> | null = null;

/** Reload profiles and every visible watchlist (RLS hides members who turned sharing off). */
export function refreshFamily(): Promise<void> {
  inflight ??= doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(): Promise<void> {
  const supabase = getSupabase();
  const user = await currentUser();
  if (!supabase || !user) return;
  const cur = getFamily();
  const base = cur.meId && cur.meId !== user.id ? empty : cur; // don't mix people on a shared device
  try {
    const [p, w] = await Promise.all([
      supabase.from("profiles").select("user_id,display_name,share_watchlist"),
      supabase.from("watchlist").select("user_id,media_key,added_at,title,year,poster_path"),
    ]);
    if (p.error) throw p.error;
    if (w.error) throw w.error;
    set({
      meId: user.id,
      profiles: (p.data ?? []).map((r) => ({ userId: r.user_id, displayName: r.display_name, shareWatchlist: r.share_watchlist !== false })),
      items: (w.data ?? []).map((r) => ({
        userId: r.user_id, key: r.media_key, addedAt: r.added_at, title: r.title, year: r.year, poster: r.poster_path,
      })),
      fetchedAt: new Date().toISOString(),
      error: null,
    });
  } catch (err) {
    set({ ...base, meId: user.id, error: err instanceof Error ? err.message : String(err) });
  }
}

export function clearFamily() {
  set(empty);
}
