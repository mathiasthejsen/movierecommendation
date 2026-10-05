/**
 * Small persisted UI preferences (localStorage), with one-time migrations.
 * Pure functions take a Storage-like object so they're unit-testable.
 */

type KV = Pick<Storage, "getItem" | "setItem">;

export const HIDE_WATCHLIST_KEY = "movie-recommender:hide-watchlist";
/** Set once the "hide watchlist titles" default flipped to ON; afterwards the user's choice is respected. */
export const HIDE_WATCHLIST_MIGRATED = "movie-recommender:hide-watchlist-migrated:v1";

/**
 * "Hide titles on my watchlist" defaults to ON. Older versions defaulted to OFF (and didn't
 * persist), so the first load after the update turns it on once and records that; any later
 * choice — including switching it off again — sticks.
 */
export function loadHideWatchlist(store: KV | null | undefined): boolean {
  if (!store) return true;
  try {
    if (!store.getItem(HIDE_WATCHLIST_MIGRATED)) {
      const prev = store.getItem(HIDE_WATCHLIST_KEY);
      // Old default (false or never saved) -> true. An explicit old `true` stays true.
      if (prev === null || prev === "false" || prev === "true") store.setItem(HIDE_WATCHLIST_KEY, "true");
      store.setItem(HIDE_WATCHLIST_MIGRATED, "1");
      return true;
    }
    return store.getItem(HIDE_WATCHLIST_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveHideWatchlist(store: KV | null | undefined, value: boolean): void {
  try {
    store?.setItem(HIDE_WATCHLIST_KEY, String(value));
    store?.setItem(HIDE_WATCHLIST_MIGRATED, "1");
  } catch {
    /* storage full or blocked: keep the in-memory value */
  }
}

/** Drop hidden keys (a snapshot taken when the list was pinned, so nothing shifts later). */
export function withoutHidden<T extends { title: { key: string } }>(list: T[], hidden: ReadonlySet<string>): T[] {
  return hidden.size ? list.filter((r) => !hidden.has(r.title.key)) : list;
}
