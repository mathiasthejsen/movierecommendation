import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { detectMatch, matchMessage, otherMembers, type FamilyItem, type Profile } from "./together";

const ME = "me";
const item = (userId: string, key: string): FamilyItem => ({ userId, key, addedAt: "2026-09-20T10:00:00Z" });

describe("It's a match: detection", () => {
  const profiles: Profile[] = [
    { userId: ME, displayName: "Sam", shareWatchlist: true },
    { userId: "anna", displayName: "Anna", shareWatchlist: true },
    { userId: "bea", displayName: "Bea", shareWatchlist: true },
    { userId: "priv", displayName: "Private Pat", shareWatchlist: false },
  ];
  const items = [
    item("anna", "movie:603"),
    item("anna", "movie:603"), // duplicate row
    item("bea", "movie:603"),
    item("bea", "tv:603"), // same TMDB number, different media type
    item("priv", "movie:949"), // stale cache from before Pat turned sharing off
    item(ME, "movie:949"), // my own row never counts as a match
  ];
  const members = otherMembers(profiles, items, ME);
  const names = (key: string, alreadyMine = false) => detectMatch(key, alreadyMine, members, items).map((m) => m.name);

  it("finds every sharing member who has the title, once each", () => {
    expect(names("movie:603")).toEqual(["Anna", "Bea"]);
  });

  it("keeps movie and TV keys apart", () => {
    expect(names("tv:603")).toEqual(["Bea"]);
    expect(names("movie:1396")).toEqual([]);
  });

  it("ignores members who turned sharing off, and my own rows", () => {
    expect(names("movie:949")).toEqual([]);
  });

  it("stays quiet when the title was already on my list", () => {
    expect(names("movie:603", true)).toEqual([]);
  });

  it("phrases one, two and several names", () => {
    expect(matchMessage(["Anna"])).toBe("🎉 Anna wants to watch this too!");
    expect(matchMessage(["Anna", "Bea"])).toBe("🎉 Anna and Bea want to watch this too!");
    expect(matchMessage(["Anna", "Bea", "Kid"])).toBe("🎉 Anna, Bea and Kid want to watch this too!");
    expect(matchMessage([])).toBe("");
  });
});

describe("It's a match: every add path goes through the hook", () => {
  const SRC = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
    });
  const all = files(SRC).map((p) => ({ path: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }));

  it("only the match-sheet provider calls the store's watchlist mutations", () => {
    const callers = all
      .filter((f) => f.path !== "lib/store.ts")
      .filter((f) => /\b(toggleWatchlist|addToWatchlist)\s*\(/.test(f.text))
      .map((f) => f.path);
    expect(callers).toEqual(["components/MatchSheet.tsx"]);
  });

  it("TitleCard (used by the feed, search, similar, picks and watchlist pages) adds via useWatchlistActions", () => {
    const card = all.find((f) => f.path === "components/TitleCard.tsx")!.text;
    expect(card).toMatch(/useWatchlistActions\(\)/);
    expect(card).toMatch(/watchlist\.toggle\(/);
    expect(card).toMatch(/watchlist\.add\(/); // "+ Add to mine" on a partner's list
  });

  it("every page that shows add buttons renders them through TitleCard", () => {
    const pages = ["app/page.tsx", "app/search/page.tsx", "app/similar/page.tsx", "app/picks/page.tsx", "app/watchlist/page.tsx"];
    for (const p of pages) expect(all.find((f) => f.path === p)?.text, p).toMatch(/<TitleCard\b/);
    // The share page saves curator picks only; it has no watchlist action to route.
    expect(all.find((f) => f.path === "app/share/page.tsx")!.text).not.toMatch(/watchlist/i);
  });

  it("the provider is mounted app-wide", () => {
    expect(all.find((f) => f.path === "app/layout.tsx")!.text).toMatch(/<MatchSheetProvider>/);
  });
});
