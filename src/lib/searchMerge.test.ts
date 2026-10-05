import { describe, expect, it } from "vitest";
import { createLatestGuard, mergeStable, parseQuery, rankByRelevance, relevance } from "./searchMerge";
import type { Title } from "./types";

const t = (key: string, title: string, year: number, votes = 1000): Title => ({
  key: key as Title["key"], type: key.startsWith("tv") ? "tv" : "movie", tmdbId: Number(key.split(":")[1]), title, year,
  genres: [], poster: null, runtime: null, rating: 7, votes, popularity: 1, providers: [], overview: "", seasons: null, status: null,
});

const heat = t("movie:949", "Heat", 1995, 8000);
const heat86 = t("movie:10000", "Heat", 1986, 200);
const heatwave = t("movie:20000", "Heatwave", 2022, 50);
const theHeat = t("movie:136795", "Red Heat", 1988, 4000);
const heatTv = t("tv:30000", "Heat", 2023, 10);

describe("relevance", () => {
  it("ranks exact > prefix > contains, then year, then votes", () => {
    const q = parseQuery("heat");
    expect(relevance(heat, q)).toBeGreaterThan(relevance(heatwave, q));
    expect(relevance(heatwave, q)).toBeGreaterThan(relevance(theHeat, q));
    expect(relevance(heat, q)).toBeGreaterThan(relevance(heat86, q)); // more votes
    const q86 = parseQuery("heat 1986");
    expect(q86.year).toBe(1986);
    expect(relevance(heat86, q86)).toBeGreaterThan(relevance(heat, q86));
  });
});

describe("rankByRelevance", () => {
  it("deduplicates by key and filters by media type", () => {
    const out = rankByRelevance([heatwave, heat, heat, heatTv, theHeat], "heat");
    expect(out.map((x) => x.key)).toEqual(["movie:949", "tv:30000", "movie:20000", "movie:136795"]);
    expect(rankByRelevance([heat, heatTv], "heat", "tv").map((x) => x.key)).toEqual(["tv:30000"]);
  });
});

describe("mergeStable", () => {
  it("never reorders visible rows; live results are appended as 'more'", () => {
    const shown = { primary: [heatwave, theHeat], more: [] };
    // Live returns the better match first and repeats one we already show.
    const merged = mergeStable(shown, [heat, theHeat, heat86], "heat");
    expect(merged.primary).toBe(shown.primary); // same array, untouched
    expect(merged.primary.map((x) => x.key)).toEqual(["movie:20000", "movie:136795"]);
    expect(merged.more.map((x) => x.key)).toEqual(["movie:949", "movie:10000"]);
  });

  it("deduplicates live results against both groups and within themselves", () => {
    const first = mergeStable({ primary: [heat], more: [] }, [heat86, heat86, heat], "heat");
    expect(first.more.map((x) => x.key)).toEqual(["movie:10000"]);
    const second = mergeStable(first, [heat86, heatTv], "heat");
    expect(second.more.map((x) => x.key)).toEqual(["movie:10000", "tv:30000"]);
    expect(second.primary).toBe(first.primary);
  });

  it("uses live results as the primary list when nothing local was shown", () => {
    const merged = mergeStable({ primary: [], more: [] }, [theHeat, heat], "heat");
    expect(merged.primary.map((x) => x.key)).toEqual(["movie:949", "movie:136795"]);
    expect(merged.more).toEqual([]);
  });
});

describe("createLatestGuard (stale response guard)", () => {
  it("ignores a slow earlier response once a newer query started", async () => {
    const guard = createLatestGuard();
    let shown = "";
    const run = async (q: string, delay: number) => {
      const id = guard.next();
      await new Promise((r) => setTimeout(r, delay));
      if (guard.isCurrent(id)) shown = q;
    };
    await Promise.all([run("he", 30), run("heat", 5)]);
    expect(shown).toBe("heat");
  });
});
