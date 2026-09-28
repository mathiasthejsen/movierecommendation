import { describe, expect, it } from "vitest";
import {
  curatorScore,
  formatReason,
  gemScore,
  indexPicks,
  preferenceWeight,
  rankRecommendations,
  tmdbFallbackEdges,
} from "./ranking";
import type { CuratorPick, Edge, Title, TitleKey } from "./types";

function title(key: TitleKey, partial: Partial<Title> = {}): Title {
  const [type, id] = key.split(":");
  return {
    key, type: type as Title["type"], tmdbId: Number(id), title: `T${id}`, year: 2005, genres: [18], poster: null,
    runtime: 100, rating: 7, votes: 20000, popularity: 10, providers: [], overview: "", seasons: null, status: null,
    ...partial,
  };
}

function catalogOf(...titles: Title[]): Map<TitleKey, Title> {
  return new Map(titles.map((t) => [t.key, t]));
}

const LIKED = "movie:1";
const DISLIKED = "movie:2";

describe("preferenceWeight", () => {
  it("maps thumbs and stars to [-1, 1]", () => {
    expect(preferenceWeight("thumb", 1)).toBe(1);
    expect(preferenceWeight("thumb", -1)).toBe(-1);
    expect(preferenceWeight("star", 5)).toBe(1);
    expect(preferenceWeight("star", 3)).toBe(0);
    expect(preferenceWeight("star", 1)).toBe(-1);
  });
});

describe("gemScore", () => {
  it("rewards high rating with few votes", () => {
    expect(gemScore({ rating: 8.1, votes: 700 })).toBeGreaterThan(0.5);
    expect(gemScore({ rating: 8.7, votes: 27000 })).toBe(0);
    expect(gemScore({ rating: 6.0, votes: 300 })).toBe(0);
    expect(gemScore({ rating: 9.5, votes: 10 })).toBe(0);
  });

  it("doesn't call brand-new releases gems", () => {
    const now = new Date("2026-09-28");
    expect(gemScore({ rating: 8.1, votes: 700, year: 2026 }, now)).toBe(0);
    expect(gemScore({ rating: 8.1, votes: 700, year: 2025 }, now)).toBe(0);
    expect(gemScore({ rating: 8.1, votes: 700, year: 2019 }, now)).toBeGreaterThan(0.5);
  });
});

describe("rankRecommendations", () => {
  const catalog = catalogOf(
    title(LIKED, { title: "Donnie Darko" }),
    title(DISLIKED, { title: "Superbad" }),
    title("movie:10", { title: "Coherence" }),
    title("movie:11", { title: "Primer" }),
    title("movie:12", { title: "Comedy X" }),
    title("movie:13", { title: "Old Film", year: 1979 }),
  );

  it("blends sources, explains, and excludes rated / pre-1980", () => {
    const neighbors = new Map<TitleKey, Edge[]>([
      [LIKED, [["movie:10", 80, 90, 0, 0], ["movie:11", 60, 0, 0, 0], ["movie:13", 99, 99, 0, 0], [DISLIKED, 50, 0, 0, 0]]],
    ]);
    const recs = rankRecommendations(new Map([[LIKED, 1], [DISLIKED, -1]]), neighbors, catalog);
    expect(recs.map((r) => r.title.key)).toEqual(["movie:10", "movie:11"]);
    expect(recs[0].sources).toEqual(["reddit", "movielens"]);
    expect(recs[0].reason).toBe("Because you liked Donnie Darko · Reddit + MovieLens");
  });

  it("subtracts similarity to disliked titles", () => {
    const neighbors = new Map<TitleKey, Edge[]>([
      [LIKED, [["movie:10", 50, 0, 0, 0], ["movie:12", 55, 0, 0, 0]]],
      [DISLIKED, [["movie:12", 90, 0, 0, 0]]],
    ]);
    const recs = rankRecommendations(new Map([[LIKED, 1], [DISLIKED, -1]]), neighbors, catalog);
    expect(recs.map((r) => r.title.key)).toEqual(["movie:10"]);
  });

  it("boosts agreement across liked titles and sources", () => {
    const cat = catalogOf(...catalog.values(), title("movie:3", { title: "Memento" }));
    const neighbors = new Map<TitleKey, Edge[]>([
      [LIKED, [["movie:10", 50, 0, 0, 0], ["movie:11", 60, 0, 0, 0]]],
      ["movie:3", [["movie:10", 50, 40, 0, 0]]],
    ]);
    const recs = rankRecommendations(new Map([[LIKED, 1], ["movie:3", 0.6]]), neighbors, cat);
    expect(recs[0].title.key).toBe("movie:10");
    // Memento contributes more (two agreeing sources) so it is named first.
    expect(recs[0].reason).toContain("Because you liked Memento and Donnie Darko");
  });

  it("applies the hidden-gem boost and label", () => {
    const cat = catalogOf(
      ...catalog.values(),
      title("movie:20", { title: "Big Hit", rating: 7.2, votes: 30000 }),
      title("movie:21", { title: "Gem", rating: 8.2, votes: 600 }),
    );
    const neighbors = new Map<TitleKey, Edge[]>([[LIKED, [["movie:20", 60, 0, 0, 0], ["movie:21", 55, 0, 0, 0]]]]);
    const recs = rankRecommendations(new Map([[LIKED, 1]]), neighbors, cat);
    expect(recs[0].title.key).toBe("movie:21");
    expect(recs[0].gem).toBe(true);
    expect(recs[0].reason).toMatch(/Hidden gem$/);
    const noBoost = rankRecommendations(new Map([[LIKED, 1]]), neighbors, cat, { gemBoost: 0 });
    expect(noBoost[0].title.key).toBe("movie:20");
  });

  it("filters by genre, year, provider and gems", () => {
    const cat = catalogOf(
      title(LIKED),
      title("movie:30", { genres: [27], year: 1990, providers: [8] }),
      title("movie:31", { genres: [35], year: 2015, providers: [9] }),
    );
    const neighbors = new Map<TitleKey, Edge[]>([[LIKED, [["movie:30", 50, 0, 0, 0], ["movie:31", 50, 0, 0, 0]]]]);
    const likes = new Map([[LIKED, 1]]);
    const keys = (f: object) => rankRecommendations(likes, neighbors, cat, { filters: f }).map((r) => r.title.key);
    expect(keys({ genres: [27] })).toEqual(["movie:30"]);
    expect(keys({ yearFrom: 2000 })).toEqual(["movie:31"]);
    expect(keys({ providers: [9] })).toEqual(["movie:31"]);
    expect(keys({ gemsOnly: true })).toEqual([]);
  });

  it("uses TMDB fallback edges for titles missing from the artifact", () => {
    const edges = tmdbFallbackEdges(["movie:10", "movie:11"], ["movie:11", "movie:12"]);
    expect(edges[0]).toEqual(["movie:10", 0, 0, 90, 0]);
    expect(edges.find((e) => e[0] === "movie:11")![3]).toBe(97);
    const recs = rankRecommendations(new Map([[LIKED, 1]]), new Map([[LIKED, edges]]), catalog);
    expect(recs[0].sources).toEqual(["tmdb"]);
  });
});

describe("mixed media types", () => {
  const catalog = catalogOf(
    title("movie:141", { title: "Donnie Darko" }),
    title("tv:70523", { title: "Dark", seasons: 3, status: "ended" }),
    title("tv:95396", { title: "Severance", seasons: 2, status: "ongoing" }),
    title("movie:220289", { title: "Coherence" }),
    // Same TMDB number, different media type: must not collide.
    title("tv:141", { title: "Some Show" }),
  );
  const neighbors = new Map<TitleKey, Edge[]>([
    ["movie:141", [["tv:70523", 0, 90, 0, 0], ["movie:220289", 80, 80, 0, 0]]],
    ["tv:70523", [["tv:95396", 0, 70, 80, 60], ["movie:220289", 0, 90, 0, 0]]],
  ]);

  it("recommends shows from a liked film and films from a liked show", () => {
    const fromFilm = rankRecommendations(new Map([["movie:141", 1]]), neighbors, catalog);
    expect(fromFilm.map((r) => r.title.key)).toContain("tv:70523");
    const fromShow = rankRecommendations(new Map([["tv:70523", 1]]), neighbors, catalog);
    expect(fromShow.map((r) => r.title.key)).toEqual(["tv:95396", "movie:220289"]);
    expect(fromShow[0].sources).toEqual(["reddit", "tmdb", "trakt"]);
  });

  it("keeps movie:141 and tv:141 distinct", () => {
    const recs = rankRecommendations(new Map([["tv:141", 1]]), neighbors, catalog);
    expect(recs).toEqual([]); // tv:141 has no edges even though movie:141 does
    const excl = rankRecommendations(new Map([["movie:141", 1]]), neighbors, catalog);
    expect(excl.find((r) => r.title.key === "movie:141")).toBeUndefined();
  });

  it("filters by media type", () => {
    const likes = new Map([["movie:141", 1], ["tv:70523", 1]]);
    const media = (m: "movie" | "tv" | "both") =>
      rankRecommendations(likes, neighbors, catalog, { filters: { media: m } }).map((r) => r.title.type);
    expect(new Set(media("tv"))).toEqual(new Set(["tv"]));
    expect(new Set(media("movie"))).toEqual(new Set(["movie"]));
    expect(new Set(media("both"))).toEqual(new Set(["movie", "tv"]));
  });
});

describe("curator picks", () => {
  const catalog = catalogOf(
    title(LIKED, { title: "Donnie Darko" }),
    title("movie:10", { title: "Coherence" }),
    title("movie:11", { title: "Primer" }),
    title("tv:5", { title: "Unconnected Show" }),
  );
  const neighbors = new Map<TitleKey, Edge[]>([[LIKED, [["movie:10", 50, 0, 0, 0], ["movie:11", 52, 0, 0, 0]]]]);
  const pick = (key: TitleKey, curator: string, weight = 1): CuratorPick => ({ key, curator, source: "manual", url: null, weight });
  const weights = new Map([["goosebumpscinema", 1], ["davidehrlich", 0.6]]);

  it("gives a moderate boost and a reason", () => {
    const picks = indexPicks([pick("movie:10", "goosebumpscinema")]);
    const recs = rankRecommendations(new Map([[LIKED, 1]]), neighbors, catalog, { picks, curatorWeights: weights });
    expect(recs[0].title.key).toBe("movie:10");
    expect(recs[0].reason).toBe("Because you liked Donnie Darko · MovieLens · Picked by @goosebumpscinema");
    // Moderate: a curated title with no edge ranks below connected ones.
    const withUnconnected = rankRecommendations(new Map([[LIKED, 1]]), neighbors, catalog, {
      picks: indexPicks([pick("tv:5", "goosebumpscinema")]), curatorWeights: weights,
    });
    expect(withUnconnected.map((r) => r.title.key)).toEqual(["movie:11", "movie:10", "tv:5"]);
    expect(withUnconnected[2].reason).toBe("Picked by @goosebumpscinema");
  });

  it("weights own curators above discovered ones and ignores disabled/unknown", () => {
    expect(curatorScore([pick("x", "goosebumpscinema")], weights).score).toBe(1);
    expect(curatorScore([pick("x", "davidehrlich")], weights).score).toBe(0.6);
    expect(curatorScore([pick("x", "disabled")], weights).score).toBe(0);
    const s = curatorScore([pick("x", "goosebumpscinema", 0.9), pick("x", "goosebumpscinema", 1), pick("x", "davidehrlich")], weights);
    expect(s.score).toBeCloseTo(1.5); // capped, one vote per curator
    expect(s.handles).toEqual(["goosebumpscinema", "davidehrlich"]);
  });

  it("keeps heavily-picked but unconnected titles below modest taste matches", () => {
    const many = ["a", "b", "c", "d", "e"].map((h) => pick("tv:5", h));
    const w = new Map(["a", "b", "c", "d", "e"].map((h) => [h, 1]));
    const nb = new Map<TitleKey, Edge[]>([[LIKED, [["movie:10", 25, 0, 0, 0]]]]);
    const recs = rankRecommendations(new Map([[LIKED, 1]]), nb, catalog, { picks: indexPicks(many), curatorWeights: w });
    expect(recs.map((r) => r.title.key)).toEqual(["movie:10", "tv:5"]);
  });

  it("supports a curator-picks-only filter", () => {    const picks = indexPicks([pick("movie:11", "davidehrlich"), pick("tv:5", "goosebumpscinema")]);
    const recs = rankRecommendations(new Map([[LIKED, 1]]), neighbors, catalog, {
      picks, curatorWeights: weights, filters: { curatedOnly: true },
    });
    expect(recs.map((r) => r.title.key).sort()).toEqual(["movie:11", "tv:5"]);
  });

  it("formats multiple curators", () => {
    expect(formatReason([], [], ["a", "b", "c"], false)).toBe("Picked by @a, @b and 1 more");
  });
});
