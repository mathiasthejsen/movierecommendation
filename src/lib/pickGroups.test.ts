import { describe, expect, it } from "vitest";
import { curatorCounts, groupPicks } from "./pickGroups";
import { HIDE_WATCHLIST_KEY, loadHideWatchlist, onHideWatchlistChange, setHideWatchlistPref } from "./prefs";
import type { Title, TitleKey } from "./types";

const title = (key: string, votes = 100): Title => ({
  key: key as TitleKey, type: key.startsWith("tv") ? "tv" : "movie", tmdbId: Number(key.split(":")[1]), title: key, year: 2000,
  genres: [], poster: null, runtime: null, rating: 7, votes, popularity: 1, providers: [], overview: "", seasons: null, status: null,
});
const catalog = new Map(["movie:1", "movie:2", "tv:3", "movie:4"].map((k, i) => [k, title(k, 1000 - i)]));
const getTitle = (k: TitleKey) => catalog.get(k);
const followed = (h: string) => h === "fav";
const picks = [
  { key: "movie:1", curator: "fav" },
  { key: "movie:1", curator: "other" },
  { key: "movie:2", curator: "fav" },
  { key: "tv:3", curator: "other" },
  { key: "movie:4", curator: "other" },
  { key: "movie:99", curator: "other" }, // not in the catalogue
] as { key: TitleKey; curator: string }[];

describe("picks grouping with watchlist hidden", () => {
  it("groups by title, most-picked first, followed flag per group", () => {
    const g = groupPicks(picks, getTitle, { followed });
    expect(g.map((x) => x.title.key)).toEqual(["movie:1", "movie:2", "tv:3", "movie:4"]);
    expect(g[0].curators.size).toBe(2);
    expect(g.filter((x) => x.followed).map((x) => x.title.key)).toEqual(["movie:1", "movie:2"]);
  });

  it("drops watchlist titles from both sections and the section counts follow", () => {
    const hidden = new Set(["movie:1", "tv:3"]);
    const g = groupPicks(picks, getTitle, { followed, hidden });
    expect(g.filter((x) => x.followed).map((x) => x.title.key)).toEqual(["movie:2"]); // followed section: 1
    expect(g.filter((x) => !x.followed).map((x) => x.title.key)).toEqual(["movie:4"]); // other section: 1
  });

  it("per-curator chip counts exclude hidden titles; curator deselection still applies", () => {
    expect(Object.fromEntries(curatorCounts(picks))).toEqual({ fav: 2, other: 4 });
    expect(Object.fromEntries(curatorCounts(picks, new Set(["movie:1", "tv:3"])))).toEqual({ fav: 1, other: 2 });
    // All of a curator's picks hidden: the chip stays (count 0) so it can still be selected.
    expect(Object.fromEntries(curatorCounts(picks, new Set(["movie:1", "movie:2"])))).toEqual({ fav: 0, other: 3 });
    const g = groupPicks(picks, getTitle, { followed, excluded: new Set(["other"]), hidden: new Set(["movie:2"]) });
    expect(g.map((x) => x.title.key)).toEqual(["movie:1"]);
    expect([...g[0].curators]).toEqual(["fav"]);
  });

  it("everything hidden -> empty (the page shows 'All picks are on your watchlist')", () => {
    const all = new Set(picks.map((p) => p.key));
    expect(groupPicks(picks, getTitle, { followed, hidden: all })).toEqual([]);
  });
});

describe("shared hide-watchlist preference (For you + Picks)", () => {
  it("a change on one page is saved and broadcast to the other", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(loadHideWatchlist(store)).toBe(true); // default ON
    const seenByOtherPage: boolean[] = [];
    const off = onHideWatchlistChange((v) => seenByOtherPage.push(v));
    setHideWatchlistPref(store, false); // e.g. toggled on Picks
    expect(seenByOtherPage).toEqual([false]);
    expect(m.get(HIDE_WATCHLIST_KEY)).toBe("false");
    expect(loadHideWatchlist(store)).toBe(false); // For you reads the same value on mount
    off();
    setHideWatchlistPref(store, true);
    expect(seenByOtherPage).toEqual([false]);
  });
});
