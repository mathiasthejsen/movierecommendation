import { describe, expect, it } from "vitest";
import {
  computeTogether,
  defaultDisplayName,
  initials,
  otherMembers,
  partnerView,
  pickTonight,
  rankTogether,
  watchlistOf,
  withAdded,
  type FamilyItem,
  type Profile,
} from "./together";
import type { WatchItem } from "./types";

const ME = "me";
const PARTNER = "p1";
const KID = "p2";
const item = (userId: string, key: string, addedAt: string, extra: Partial<FamilyItem> = {}): FamilyItem => ({ userId, key, addedAt, ...extra });
const mineItem = (key: string, addedAt: string): WatchItem => ({ key, addedAt });

const profiles: Profile[] = [
  { userId: ME, displayName: "Sam", shareWatchlist: true },
  { userId: PARTNER, displayName: "Anna", shareWatchlist: true },
  { userId: KID, displayName: "Kid", shareWatchlist: true },
];

describe("family members", () => {
  it("lists everyone but me, including row owners without a profile", () => {
    const items = [item("p3", "movie:1", "2026-09-01")];
    expect(otherMembers(profiles, items, ME).map((m) => [m.userId, m.name])).toEqual([
      [PARTNER, "Anna"],
      ["p3", "Family member"],
      [KID, "Kid"],
    ]);
  });

  it("derives names and initials without exposing emails to others", () => {
    expect(defaultDisplayName("jane.doe@example.com")).toBe("Jane doe");
    expect(defaultDisplayName(undefined)).toBe("Me");
    expect(initials("Anna Berg")).toBe("AB");
    expect(initials("kid")).toBe("KI");
  });
});

describe("Together (intersection)", () => {
  const mine = [mineItem("movie:603", "2026-09-10"), mineItem("tv:1396", "2026-09-12"), mineItem("movie:27205", "2026-09-11")];
  const items = [
    item(PARTNER, "movie:603", "2026-09-01"),
    item(PARTNER, "tv:1396", "2026-09-02"),
    item(PARTNER, "tv:1396", "2026-09-03"), // duplicate row for the same title
    item(KID, "tv:1396", "2026-09-04"),
    item(KID, "movie:99999", "2026-09-05"), // not on mine
    item(ME, "movie:27205", "2026-09-11"), // my own server row doesn't count as "someone else"
  ];
  const members = otherMembers(profiles, items, ME);

  it("keeps only my titles that at least one other member has, mixing movies and TV", () => {
    const t = computeTogether(mine, members, items);
    expect(t.map((e) => e.key).sort()).toEqual(["movie:603", "tv:1396"]);
  });

  it("lists each other member once per title, across several members", () => {
    const t = new Map(computeTogether(mine, members, items).map((e) => [e.key, e.with]));
    expect(t.get("tv:1396")).toEqual([PARTNER, KID]);
    expect(t.get("movie:603")).toEqual([PARTNER]);
  });

  it("handles duplicates in my own list", () => {
    const t = computeTogether([...mine, mineItem("movie:603", "2026-09-15")], members, items);
    expect(t.filter((e) => e.key === "movie:603")).toHaveLength(1);
    expect(t.find((e) => e.key === "movie:603")!.myAddedAt).toBe("2026-09-10");
  });

  it("is empty with nothing in common or no other members", () => {
    expect(computeTogether([mineItem("movie:1", "2026-09-01")], members, items)).toEqual([]);
    expect(computeTogether(mine, [], items)).toEqual([]);
  });

  it("ranks by my recommendation score, then by the date I added it", () => {
    const entries = computeTogether(
      [mineItem("movie:1", "2026-09-01"), mineItem("tv:2", "2026-09-03"), mineItem("movie:3", "2026-09-02"), mineItem("tv:4", "2026-09-04")],
      members,
      ["movie:1", "tv:2", "movie:3", "tv:4"].map((k) => item(PARTNER, k, "2026-08-01")),
    );
    const score = new Map([["movie:3", 2.5], ["tv:2", 0.4]]);
    expect(rankTogether(entries, (k) => score.get(k) ?? 0).map((e) => e.key)).toEqual(["movie:3", "tv:2", "tv:4", "movie:1"]);
  });

  it("picks tonight's title from the top 5 only", () => {
    const ranked = ["a", "b", "c", "d", "e", "f", "g"];
    expect(pickTonight(ranked, () => 0)).toBe("a");
    expect(pickTonight(ranked, () => 0.9999)).toBe("e");
    expect(pickTonight(["only"], () => 0.7)).toBe("only");
    expect(pickTonight([], () => 0.5)).toBeNull();
  });
});

describe("share_watchlist off", () => {
  const privateProfiles: Profile[] = [...profiles.filter((p) => p.userId !== PARTNER), { userId: PARTNER, displayName: "Anna", shareWatchlist: false }];
  // Stale cached rows from before Anna turned sharing off must still be ignored.
  const items = [item(PARTNER, "movie:603", "2026-09-01"), item(KID, "movie:603", "2026-09-02")];
  const members = otherMembers(privateProfiles, items, ME);
  const anna = members.find((m) => m.userId === PARTNER)!;

  it("hides the member's list", () => {
    expect(watchlistOf(anna, items)).toBe("private");
    expect(partnerView(anna, items, new Set())).toEqual({ private: true });
  });

  it("excludes them from Together", () => {
    const t = computeTogether([mineItem("movie:603", "2026-09-10")], members, items);
    expect(t).toEqual([{ key: "movie:603", with: [KID], myAddedAt: "2026-09-10" }]);
  });
});

describe("partner view and + Add to mine", () => {
  const items = [item(PARTNER, "movie:603", "2026-09-01"), item(PARTNER, "tv:1396", "2026-09-05"), item(PARTNER, "tv:1396", "2026-09-06")];
  const anna = otherMembers(profiles, items, ME).find((m) => m.userId === PARTNER)!;

  it("shows their list newest first, deduplicated, flagging titles also on mine", () => {
    const v = partnerView(anna, items, new Set(["movie:603"]));
    expect(v.private).toBe(false);
    if (!v.private) expect(v.items.map((i) => [i.key, i.alsoMine])).toEqual([["tv:1396", false], ["movie:603", true]]);
  });

  it("adds a title to mine without touching theirs, and never removes", () => {
    const before: Record<string, WatchItem> = { "movie:603": { key: "movie:603", addedAt: "2026-09-10" } };
    const after = withAdded(before, "tv:1396", "2026-09-29T10:00:00Z");
    expect(after["tv:1396"]).toEqual({ key: "tv:1396", addedAt: "2026-09-29T10:00:00Z" });
    expect(after["movie:603"]).toBe(before["movie:603"]);
    expect(before["tv:1396"]).toBeUndefined(); // no mutation
    expect(withAdded(after, "tv:1396", "2026-09-30")).toBe(after); // already there: unchanged, not toggled off
    const tomb: Record<string, WatchItem> = { "tv:1": { key: "tv:1", addedAt: "2026-09-01", deleted: true } };
    expect(withAdded(tomb, "tv:1", "2026-09-29")["tv:1"]).toEqual({ key: "tv:1", addedAt: "2026-09-29" }); // re-adds after removal
    // Now the partner view flags it as also on mine.
    const v = partnerView(anna, items, new Set(Object.keys(after)));
    if (!v.private) expect(v.items.every((i) => i.alsoMine)).toBe(true);
  });
});
