import { describe, expect, it } from "vitest";
import { HIDE_WATCHLIST_KEY, HIDE_WATCHLIST_MIGRATED, loadHideWatchlist, saveHideWatchlist, withoutHidden } from "./prefs";

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    dump: () => Object.fromEntries(m),
  };
}

describe("hide watchlist preference", () => {
  it("defaults to ON for new users and records the migration", () => {
    const s = memoryStore();
    expect(loadHideWatchlist(s)).toBe(true);
    expect(s.dump()).toEqual({ [HIDE_WATCHLIST_KEY]: "true", [HIDE_WATCHLIST_MIGRATED]: "1" });
  });

  it("migrates the old default (false) to true exactly once", () => {
    const s = memoryStore({ [HIDE_WATCHLIST_KEY]: "false" });
    expect(loadHideWatchlist(s)).toBe(true);
    // The user switches it off again: that choice is respected from now on.
    saveHideWatchlist(s, false);
    expect(loadHideWatchlist(s)).toBe(false);
    expect(loadHideWatchlist(s)).toBe(false);
  });

  it("keeps an explicit ON and survives missing storage", () => {
    expect(loadHideWatchlist(memoryStore({ [HIDE_WATCHLIST_KEY]: "true" }))).toBe(true);
    expect(loadHideWatchlist(null)).toBe(true);
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => undefined };
    expect(loadHideWatchlist(throwing)).toBe(true);
  });

  it("withoutHidden drops snapshot keys and keeps order", () => {
    const list = ["movie:1", "tv:2", "movie:3"].map((key) => ({ title: { key } }));
    expect(withoutHidden(list, new Set(["tv:2"])).map((r) => r.title.key)).toEqual(["movie:1", "movie:3"]);
    expect(withoutHidden(list, new Set())).toBe(list);
  });
});
