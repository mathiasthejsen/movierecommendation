import { describe, expect, it } from "vitest";
import { CATEGORIES, categoriesOf, categoryCounts, GENRE_TO_CATEGORIES, genresToCategories } from "./categories";
import { filterByCategories, migrateFilters, passesFilters, rankRecommendations } from "./ranking";
import type { Edge, Title, TitleKey } from "./types";

function title(key: TitleKey, genres: number[]): Title {
  const [type, id] = key.split(":");
  return {
    key, type: type as Title["type"], tmdbId: Number(id), title: key, year: 2010, genres, poster: null, runtime: null,
    rating: 7, votes: 5000, popularity: 1, providers: [], overview: "", seasons: null, status: null,
  };
}

describe("category mapping", () => {
  it("maps movie and TV genre IDs to the same category", () => {
    expect([...categoriesOf([28])]).toEqual(["action"]); // movie Action
    expect([...categoriesOf([12])]).toEqual(["action"]); // movie Adventure
    expect([...categoriesOf([10759])]).toEqual(["action"]); // TV Action & Adventure
    expect([...categoriesOf([878])]).toEqual(["scifi"]);
    expect([...categoriesOf([14])]).toEqual(["scifi"]);
    expect([...categoriesOf([10765])]).toEqual(["scifi"]); // TV Sci-Fi & Fantasy
    expect([...categoriesOf([10752])]).toEqual(["war"]);
    expect([...categoriesOf([10768])]).toEqual(["war"]); // TV War & Politics
    expect([...categoriesOf([10762])]).toEqual(["family"]); // TV Kids -> Family
    expect([...categoriesOf([10766])]).toEqual(["drama"]); // TV Soap -> Drama
    expect([...categoriesOf([10764])]).toEqual(["reality"]); // TV Reality
  });

  it("gives a title every category of its genres and ignores unmapped IDs", () => {
    expect([...categoriesOf([28, 12, 878, 10770])].sort()).toEqual(["action", "scifi"]); // 10770 = TV Movie
    expect(categoriesOf([]).size).toBe(0);
  });

  it("uses unique IDs and never maps one genre to conflicting categories", () => {
    expect(new Set(CATEGORIES.map((c) => c.id)).size).toBe(CATEGORIES.length);
    for (const [, cats] of GENRE_TO_CATEGORIES) expect(cats).toHaveLength(1);
  });

  it("counts only categories that occur, most frequent first, keeping selected ones", () => {
    const titles = [title("movie:1", [27]), title("movie:2", [27, 53]), title("tv:3", [10765]), title("movie:4", [53])];
    expect(categoryCounts(titles)).toEqual([
      { id: "thriller", label: "Thriller", count: 2 },
      { id: "horror", label: "Horror", count: 2 },
      { id: "scifi", label: "Sci-Fi & Fantasy", count: 1 },
    ]);
    expect(categoryCounts(titles, ["western"]).map((c) => [c.id, c.count])).toContainEqual(["western", 0]);
    expect(categoryCounts([])).toEqual([]);
  });
});

describe("category filtering", () => {
  const mixed = [
    title("movie:10", [28]), // action film
    title("tv:11", [10759]), // action series (raw TV ID)
    title("tv:12", [10765]), // sci-fi series
    title("movie:13", [35]), // comedy
    title("movie:14", [878, 18]), // sci-fi drama film
  ];

  it("matches ANY selected category (OR) across movies and TV", () => {
    const keys = (cats: string[]) => mixed.filter((t) => passesFilters(t, { categories: cats })).map((t) => t.key);
    expect(keys(["action"])).toEqual(["movie:10", "tv:11"]);
    expect(keys(["scifi"])).toEqual(["tv:12", "movie:14"]);
    expect(keys(["action", "scifi"])).toEqual(["movie:10", "tv:11", "tv:12", "movie:14"]);
    expect(keys([])).toHaveLength(5);
  });

  it("combines with the Movies/TV filter", () => {
    const keys = mixed.filter((t) => passesFilters(t, { categories: ["action", "scifi"], media: "tv" })).map((t) => t.key);
    expect(keys).toEqual(["tv:11", "tv:12"]);
  });

  it("filters an already-ranked mixed list without changing its order", () => {
    const catalog = new Map(mixed.map((t) => [t.key, t]));
    const edges: Edge[] = mixed.map((t, i) => [t.key, 90 - i * 10, 0, 0, 0]);
    const ranked = rankRecommendations(new Map([["movie:99", 1]]), new Map([["movie:99", edges]]), catalog);
    const filtered = filterByCategories(ranked, ["scifi", "action"]);
    expect(filtered.map((r) => r.title.key)).toEqual(["movie:10", "tv:11", "tv:12", "movie:14"]);
    expect(filterByCategories(ranked, [])).toBe(ranked);
    // Same result as ranking with the filter directly.
    const direct = rankRecommendations(new Map([["movie:99", 1]]), new Map([["movie:99", edges]]), catalog, {
      filters: { categories: ["scifi", "action"] },
    });
    expect(direct.map((r) => r.title.key)).toEqual(filtered.map((r) => r.title.key));
  });
});

describe("saved filter migration", () => {
  it("turns an old single genre ID into its category", () => {
    expect(migrateFilters({ genres: [27], yearFrom: 2000 })).toEqual({ yearFrom: 2000, categories: ["horror"] });
    expect(migrateFilters({ genres: [12] })).toEqual({ categories: ["action"] });
    expect(migrateFilters({ genres: [10765] })).toEqual({ categories: ["scifi"] });
  });

  it("merges with existing categories, drops unknowns and the retired curatedOnly flag", () => {
    expect(migrateFilters({ genres: [35], categories: ["horror", "bogus"], curatedOnly: true, media: "tv" })).toEqual({
      media: "tv",
      categories: ["horror", "comedy"],
    });
    expect(migrateFilters({ genres: [10770] })).toEqual({}); // unmapped genre -> no category filter
    expect(migrateFilters({ genres: ["27"] })).toEqual({}); // malformed values are ignored
  });

  it("handles empty or corrupt saved values", () => {
    expect(migrateFilters(null)).toEqual({});
    expect(migrateFilters("nope")).toEqual({});
    expect(migrateFilters({})).toEqual({});
    expect(genresToCategories([28, 12, 10759])).toEqual(["action"]);
  });
});
