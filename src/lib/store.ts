"use client";

import { useRef, useSyncExternalStore } from "react";
import { getSupabase } from "./supabase";
import { mergeRecords } from "./sync";
import { parseKey } from "./keys";
import { withAdded } from "./together";
import type { RatingKind, Title, TitleKey, UserRating, WatchItem } from "./types";

const STORAGE_KEY = "movie-recommender:v2";

export interface Settings {
  ratingStyle: RatingKind;
  onboarded: boolean;
  lastCurator: string;
}

/** A pick added in the app (Share Target or manual form), shared with the family via Supabase. */
export interface UserPick {
  id: string;
  key: TitleKey;
  curator: string;
  postUrl: string | null;
  source: "share" | "manual";
  addedBy: string | null;
  createdAt: string;
  pending?: boolean;
  deleted?: boolean;
}

export interface State {
  ownerId: string | null;
  ratings: Record<TitleKey, UserRating>;
  watchlist: Record<TitleKey, WatchItem>;
  userPicks: Record<string, UserPick>;
  /** Metadata snapshots for titles that aren't in the artifact (live search / sync). */
  titles: Record<TitleKey, Title>;
  dirtyRatings: TitleKey[];
  dirtyWatchlist: TitleKey[];
  settings: Settings;
  lastSync: string | null;
  syncError: string | null;
}

const initialState: State = {
  ownerId: null,
  ratings: {},
  watchlist: {},
  userPicks: {},
  titles: {},
  dirtyRatings: [],
  dirtyWatchlist: [],
  settings: { ratingStyle: "thumb", onboarded: false, lastCurator: "" },
  lastSync: null,
  syncError: null,
};

let state: State = initialState;
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<State>;
      state = { ...initialState, ...parsed, settings: { ...initialState.settings, ...parsed.settings } };
    }
  } catch {
    state = initialState;
  }
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      state = JSON.parse(e.newValue) as State;
      listeners.forEach((l) => l());
    }
  });
}

function setState(update: (s: State) => State): void {
  load();
  state = update(state);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full or unavailable: keep in memory */
  }
  listeners.forEach((l) => l());
}

export function getState(): State {
  load();
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: State) => T): T {
  // Memoise per state object so derived arrays keep a stable identity between renders.
  const cache = useRef<{ state: State | null; value: T }>({ state: null, value: undefined as T });
  const select = (s: State) => {
    if (cache.current.state !== s) cache.current = { state: s, value: selector(s) };
    return cache.current.value;
  };
  return useSyncExternalStore(
    subscribe,
    () => select(getState()),
    () => select(initialState),
  );
}

const now = () => new Date().toISOString();
const addDirty = (list: TitleKey[], key: TitleKey) => (list.includes(key) ? list : [...list, key]);
const snapshot = (s: State, t?: Title) => (t ? { ...s.titles, [t.key]: t } : s.titles);

/** Rate a title; tapping the same rating again clears it. */
export function rate(key: TitleKey, kind: RatingKind, value: number, title?: Title): void {
  setState((s) => {
    const current = s.ratings[key];
    const clear = current && !current.deleted && current.kind === kind && current.value === value;
    const rating: UserRating = clear ? { ...current, deleted: true, updatedAt: now() } : { key, kind, value, updatedAt: now() };
    return { ...s, ratings: { ...s.ratings, [key]: rating }, titles: snapshot(s, title), dirtyRatings: addDirty(s.dirtyRatings, key) };
  });
  void flush();
}

export function toggleWatchlist(key: TitleKey, title?: Title): void {
  setState((s) => {
    const current = s.watchlist[key];
    const item: WatchItem = current && !current.deleted ? { ...current, deleted: true, addedAt: now() } : { key, addedAt: now() };
    return { ...s, watchlist: { ...s.watchlist, [key]: item }, titles: snapshot(s, title), dirtyWatchlist: addDirty(s.dirtyWatchlist, key) };
  });
  void flush();
}

/** "+ Add to mine" from a family member's list: add-only, never removes. */
export function addToWatchlist(key: TitleKey, title?: Title): void {
  let changed = false;
  setState((s) => {
    const watchlist = withAdded(s.watchlist, key, now());
    if (watchlist === s.watchlist) return s;
    changed = true;
    return { ...s, watchlist, titles: snapshot(s, title), dirtyWatchlist: addDirty(s.dirtyWatchlist, key) };
  });
  if (changed) void flush();
}
export function addPicks(items: { title: Title; curator: string; postUrl: string | null; source: "share" | "manual" }[]): void {
  setState((s) => {
    const userPicks = { ...s.userPicks };
    let titles = s.titles;
    for (const it of items) {
      const exists = Object.values(userPicks).some(
        (p) => !p.deleted && p.key === it.title.key && p.curator === it.curator && (p.addedBy === s.ownerId || p.pending),
      );
      if (exists) continue;
      const id = `local-${crypto.randomUUID()}`;
      userPicks[id] = {
        id, key: it.title.key, curator: it.curator, postUrl: it.postUrl, source: it.source,
        addedBy: s.ownerId, createdAt: now(), pending: true,
      };
      titles = { ...titles, [it.title.key]: it.title };
    }
    const last = items[items.length - 1]?.curator;
    return { ...s, userPicks, titles, settings: last ? { ...s.settings, lastCurator: last } : s.settings };
  });
  void flush();
}

export function removePick(id: string): void {
  setState((s) => {
    const p = s.userPicks[id];
    if (!p) return s;
    const userPicks = { ...s.userPicks };
    if (p.pending) delete userPicks[id];
    else userPicks[id] = { ...p, deleted: true };
    return { ...s, userPicks };
  });
  void flush();
}

export function updateSettings(patch: Partial<Settings>): void {
  setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
}

export const activeRatings = (s: State) => Object.values(s.ratings).filter((r) => !r.deleted);
export const activeWatchlist = (s: State) => Object.values(s.watchlist).filter((w) => !w.deleted);
export const activePicks = (s: State) => Object.values(s.userPicks).filter((p) => !p.deleted);

// ---------------------------------------------------------------------------------
// Supabase sync (only when signed in). localStorage stays the source of truth for
// the UI, so the app works offline and without Supabase configured.

interface MetaCols {
  title: string | null;
  year: number | null;
  poster_path: string | null;
}
interface RatingRow extends MetaCols {
  media_key: string;
  kind: RatingKind;
  value: number;
  updated_at: string;
}
interface WatchRow extends MetaCols {
  media_key: string;
  added_at: string;
}
interface PickRow extends MetaCols {
  id: string;
  media_key: string;
  curator: string;
  post_url: string | null;
  source: "share" | "manual";
  added_by: string;
  created_at: string;
}

let lookupTitle: (key: TitleKey) => Title | undefined = () => undefined;
export function setTitleLookup(fn: (key: TitleKey) => Title | undefined): void {
  lookupTitle = fn;
}

function rowMeta(key: TitleKey): MetaCols {
  const t = lookupTitle(key) ?? getState().titles[key];
  return { title: t?.title ?? null, year: t?.year ?? null, poster_path: t?.poster ?? null };
}

function titleFromRow(key: TitleKey, row: MetaCols): Title {
  const { type, tmdbId } = parseKey(key);
  return {
    key, type, tmdbId, title: row.title ?? key, year: row.year ?? 0, genres: [], poster: row.poster_path,
    runtime: null, rating: 0, votes: 0, popularity: 0, providers: [], overview: "", seasons: null, status: null,
  };
}

let syncing: Promise<void> | null = null;

/** Pull server state, merge, and push local changes. */
export function syncNow(): Promise<void> {
  syncing ??= doSync().finally(() => {
    syncing = null;
  });
  return syncing;
}

async function currentUserId(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

async function doSync(): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  if (!supabase || !userId) return;
  if (getState().ownerId && getState().ownerId !== userId) {
    // A different family member signed in on this device: don't mix their data.
    setState((s) => ({ ...initialState, settings: s.settings }));
  }
  try {
    const [ratingsRes, watchRes, picksRes] = await Promise.all([
      supabase.from("ratings").select("media_key,kind,value,updated_at,title,year,poster_path").eq("user_id", userId),
      // Family members can read each other's watchlists now, so "mine" must filter explicitly.
      supabase.from("watchlist").select("media_key,added_at,title,year,poster_path").eq("user_id", userId),
      supabase.from("curator_picks").select("id,media_key,curator,post_url,source,added_by,created_at,title,year,poster_path"),
    ]);
    for (const res of [ratingsRes, watchRes, picksRes]) if (res.error) throw res.error;
    const remoteTitles: Record<TitleKey, Title> = {};
    const remember = (key: TitleKey, row: MetaCols) => {
      if (!lookupTitle(key) && row.title) remoteTitles[key] = titleFromRow(key, row);
    };
    const remoteRatings: Record<TitleKey, UserRating> = {};
    for (const r of ratingsRes.data as RatingRow[]) {
      remoteRatings[r.media_key] = { key: r.media_key, kind: r.kind, value: r.value, updatedAt: r.updated_at };
      remember(r.media_key, r);
    }
    const remoteWatch: Record<TitleKey, WatchItem> = {};
    for (const w of watchRes.data as WatchRow[]) {
      remoteWatch[w.media_key] = { key: w.media_key, addedAt: w.added_at };
      remember(w.media_key, w);
    }
    const remotePicks: Record<string, UserPick> = {};
    for (const p of picksRes.data as PickRow[]) {
      remotePicks[p.id] = {
        id: p.id, key: p.media_key, curator: p.curator, postUrl: p.post_url, source: p.source,
        addedBy: p.added_by, createdAt: p.created_at,
      };
      remember(p.media_key, p);
    }
    const s = getState();
    const r = mergeRecords(s.ratings, remoteRatings, new Set(s.dirtyRatings), (x) => x.updatedAt);
    const w = mergeRecords(s.watchlist, remoteWatch, new Set(s.dirtyWatchlist), (x) => x.addedAt);
    setState((cur) => {
      const localPending = Object.fromEntries(
        Object.entries(cur.userPicks).filter(([id, p]) => p.pending || (p.deleted && remotePicks[id])),
      );
      return {
        ...cur,
        ownerId: userId,
        ratings: r.merged,
        watchlist: w.merged,
        userPicks: { ...remotePicks, ...localPending },
        titles: { ...remoteTitles, ...cur.titles },
        dirtyRatings: [...r.upserts, ...r.deletes],
        dirtyWatchlist: [...w.upserts, ...w.deletes],
      };
    });
    await flush();
  } catch (err) {
    setState((cur) => ({ ...cur, syncError: err instanceof Error ? err.message : String(err) }));
  }
}

/** Push dirty records to Supabase. Safe to call often; no-op when signed out. */
export async function flush(): Promise<void> {
  const supabase = getSupabase();
  const userId = await currentUserId();
  if (!supabase || !userId) return;
  const s = getState();
  if (s.ownerId && s.ownerId !== userId) return; // wait for syncNow() to reconcile
  const ratingKeys = [...s.dirtyRatings];
  const watchKeys = [...s.dirtyWatchlist];
  const newPicks = Object.values(s.userPicks).filter((p) => p.pending && !p.deleted);
  const deletedPicks = Object.values(s.userPicks).filter((p) => p.deleted && !p.pending);
  try {
    const upR = ratingKeys.map((k) => s.ratings[k]).filter((r) => r && !r.deleted);
    const delR = ratingKeys.filter((k) => !s.ratings[k] || s.ratings[k].deleted);
    const upW = watchKeys.map((k) => s.watchlist[k]).filter((w) => w && !w.deleted);
    const delW = watchKeys.filter((k) => !s.watchlist[k] || s.watchlist[k].deleted);
    const ops: PromiseLike<{ error: unknown }>[] = [];
    if (upR.length)
      ops.push(
        supabase.from("ratings").upsert(
          upR.map((r) => ({ user_id: userId, media_key: r.key, kind: r.kind, value: r.value, updated_at: r.updatedAt, ...rowMeta(r.key) })),
        ),
      );
    if (delR.length) ops.push(supabase.from("ratings").delete().eq("user_id", userId).in("media_key", delR));
    if (upW.length)
      ops.push(
        supabase.from("watchlist").upsert(upW.map((w) => ({ user_id: userId, media_key: w.key, added_at: w.addedAt, ...rowMeta(w.key) }))),
      );
    if (delW.length) ops.push(supabase.from("watchlist").delete().eq("user_id", userId).in("media_key", delW));
    if (deletedPicks.length) ops.push(supabase.from("curator_picks").delete().in("id", deletedPicks.map((p) => p.id)));
    let inserted: PickRow[] = [];
    if (newPicks.length) {
      const res = await supabase
        .from("curator_picks")
        .upsert(
          newPicks.map((p) => ({
            media_key: p.key, curator: p.curator, post_url: p.postUrl, source: p.source, added_by: userId, ...rowMeta(p.key),
          })),
          { onConflict: "media_key,curator,added_by" },
        )
        .select("id,media_key,curator,post_url,source,added_by,created_at,title,year,poster_path");
      if (res.error) throw res.error;
      inserted = res.data as PickRow[];
    }
    const results = await Promise.all(ops);
    const failed = results.find((res) => res.error);
    if (failed?.error) throw failed.error;
    setState((cur) => {
      const unchanged = <T,>(key: TitleKey, before: Record<string, T>, after: Record<string, T>) => before[key] === after[key];
      const ratings = { ...cur.ratings };
      for (const k of ratingKeys) if (ratings[k]?.deleted && unchanged(k, s.ratings, cur.ratings)) delete ratings[k];
      const watchlist = { ...cur.watchlist };
      for (const k of watchKeys) if (watchlist[k]?.deleted && unchanged(k, s.watchlist, cur.watchlist)) delete watchlist[k];
      const userPicks = { ...cur.userPicks };
      for (const p of newPicks) delete userPicks[p.id];
      for (const p of deletedPicks) delete userPicks[p.id];
      for (const row of inserted) {
        userPicks[row.id] = {
          id: row.id, key: row.media_key, curator: row.curator, postUrl: row.post_url, source: row.source,
          addedBy: row.added_by, createdAt: row.created_at,
        };
      }
      return {
        ...cur,
        ownerId: userId,
        ratings,
        watchlist,
        userPicks,
        dirtyRatings: cur.dirtyRatings.filter((k) => !ratingKeys.includes(k) || !unchanged(k, s.ratings, cur.ratings)),
        dirtyWatchlist: cur.dirtyWatchlist.filter((k) => !watchKeys.includes(k) || !unchanged(k, s.watchlist, cur.watchlist)),
        lastSync: now(),
        syncError: null,
      };
    });
  } catch (err) {
    setState((cur) => ({ ...cur, syncError: err instanceof Error ? err.message : String(err) }));
  }
}
