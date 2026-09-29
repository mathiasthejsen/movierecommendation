/**
 * Shared family watchlists: pure logic (unit-tested in together.test.ts).
 *
 * - "Together": titles on my watchlist AND on at least one other member's.
 * - A member's watchlist view is read-only and respects their share_watchlist setting
 *   (the database enforces it too; this is defence in depth for cached data).
 * No emails are ever used for display: names come from profiles.display_name.
 */

import type { Title, TitleKey, WatchItem } from "./types";

export interface Profile {
  userId: string;
  displayName: string;
  shareWatchlist: boolean;
}

export interface FamilyMember {
  userId: string;
  name: string;
  shareWatchlist: boolean;
}

/** One watchlist row as the family sees it (from Supabase; includes display metadata). */
export interface FamilyItem {
  userId: string;
  key: TitleKey;
  addedAt: string;
  title?: string | null;
  year?: number | null;
  poster?: string | null;
}

export interface TogetherEntry {
  key: TitleKey;
  /** Other members who also have it (deduplicated, in member order). */
  with: string[];
  myAddedAt: string;
}

export const UNKNOWN_MEMBER = "Family member";

/** Default display name: the part of the email before "@", trimmed to 40 characters. */
export function defaultDisplayName(email: string | null | undefined): string {
  const local = (email ?? "").split("@")[0]?.trim() ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  const name = cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : "Me";
  return name.slice(0, 40);
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Everyone except me: members with a profile, plus anyone who owns visible watchlist rows
 * but hasn't opened the app since profiles existed (shown as "Family member"; sharing is the default).
 */
export function otherMembers(profiles: Profile[], items: FamilyItem[], meId: string): FamilyMember[] {
  const byId = new Map<string, FamilyMember>();
  for (const p of profiles) {
    if (p.userId === meId) continue;
    byId.set(p.userId, { userId: p.userId, name: p.displayName?.trim() || UNKNOWN_MEMBER, shareWatchlist: p.shareWatchlist !== false });
  }
  for (const it of items) {
    if (it.userId !== meId && !byId.has(it.userId)) byId.set(it.userId, { userId: it.userId, name: UNKNOWN_MEMBER, shareWatchlist: true });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId));
}

/** A member's watchlist: newest first, one entry per title, or "private" if they turned sharing off. */
export function watchlistOf(member: FamilyMember, items: FamilyItem[]): FamilyItem[] | "private" {
  if (!member.shareWatchlist) return "private";
  const byKey = new Map<TitleKey, FamilyItem>();
  for (const it of items) {
    if (it.userId !== member.userId) continue;
    const prev = byKey.get(it.key);
    if (!prev || it.addedAt < prev.addedAt) byKey.set(it.key, it); // keep the first time they added it
  }
  return [...byKey.values()].sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

/** Titles on my watchlist that at least one other (sharing) member also has. */
export function computeTogether(mine: Pick<WatchItem, "key" | "addedAt">[], members: FamilyMember[], items: FamilyItem[]): TogetherEntry[] {
  const myAdded = new Map<TitleKey, string>();
  for (const w of mine) {
    const prev = myAdded.get(w.key);
    if (!prev || w.addedAt < prev) myAdded.set(w.key, w.addedAt);
  }
  const holders = new Map<TitleKey, string[]>();
  for (const m of members) {
    const list = watchlistOf(m, items);
    if (list === "private") continue;
    for (const it of list) {
      if (!myAdded.has(it.key)) continue;
      const h = holders.get(it.key) ?? [];
      if (!h.includes(m.userId)) h.push(m.userId);
      holders.set(it.key, h);
    }
  }
  return [...holders.entries()].map(([key, withIds]) => ({ key, with: withIds, myAddedAt: myAdded.get(key)! }));
}

/** Highest personal recommendation score first; ties by the date I added it (newest first). */
export function rankTogether(entries: TogetherEntry[], score: (key: TitleKey) => number): TogetherEntry[] {
  return [...entries].sort((a, b) => score(b.key) - score(a.key) || b.myAddedAt.localeCompare(a.myAddedAt) || a.key.localeCompare(b.key));
}

/** Read-only view of a member's list, flagging titles that are also on mine. */
export function partnerView(
  member: FamilyMember,
  items: FamilyItem[],
  mineKeys: ReadonlySet<TitleKey>,
): { private: true } | { private: false; items: (FamilyItem & { alsoMine: boolean })[] } {
  const list = watchlistOf(member, items);
  if (list === "private") return { private: true };
  return { private: false, items: list.map((it) => ({ ...it, alsoMine: mineKeys.has(it.key) })) };
}

/** "+ Add to mine": add-only (never removes); returns the same object if it's already there. */
export function withAdded(watchlist: Record<TitleKey, WatchItem>, key: TitleKey, nowIso: string): Record<TitleKey, WatchItem> {
  const cur = watchlist[key];
  if (cur && !cur.deleted) return watchlist;
  return { ...watchlist, [key]: { key, addedAt: nowIso } };
}

/** Tonight's pick: a random title from the top `n` (default 5). */
export function pickTonight<T>(ranked: T[], rand: () => number = Math.random, n = 5): T | null {
  const top = ranked.slice(0, n);
  if (!top.length) return null;
  return top[Math.min(top.length - 1, Math.floor(rand() * top.length))];
}

/** Fallback Title for rows that aren't in the weekly catalogue (e.g. added via live search). */
export function titleFromItem(it: FamilyItem): Title {
  const [type, id] = it.key.split(":");
  return {
    key: it.key, type: type as Title["type"], tmdbId: Number(id), title: it.title || it.key, year: it.year ?? 0, genres: [],
    poster: it.poster ?? null, runtime: null, rating: 0, votes: 0, popularity: 0, providers: [], overview: "", seasons: null, status: null,
  };
}
