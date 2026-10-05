import { describe, expect, it } from "vitest";
import { DEFAULT_WEIGHTS, diversifyMedia, formatReason, rankRecommendations } from "./ranking";
import type { Edge, Title, TitleKey } from "./types";

function title(key: TitleKey, partial: Partial<Title> = {}): Title {
  const [type, id] = key.split(":");
  return {
    key, type: type as Title["type"], tmdbId: Number(id), title: `T${id}`, year: 2005, genres: [80], poster: null,
    runtime: 100, rating: 7, votes: 20000, popularity: 10, providers: [], overview: "", seasons: null, status: null,
    ...partial,
  };
}

const rec = (key: TitleKey, score: number) => ({ title: title(key), score });
const types = (xs: { title: Title }[]) => xs.map((x) => (x.title.type === "tv" ? "T" : "M")).join("");

describe("content source (film <-> series bridge)", () => {
  const heat = title("movie:949", { title: "Heat" });
  const moneyHeist = title("tv:71446", { title: "Money Heist" });
  const catalog = new Map([heat, moneyHeist].map((t) => [t.key, t]));

  it("weighs content at 0.5 of MovieLens by default", () => {
    expect(DEFAULT_WEIGHTS.content).toBe(0.5);
    const viaContent = rankRecommendations(new Map([["movie:949", 1]]), new Map([["movie:949", [["tv:71446", 0, 0, 0, 0, 80]] as Edge[]]]), catalog);
    const viaMl = rankRecommendations(new Map([["movie:949", 1]]), new Map([["movie:949", [["tv:71446", 80, 0, 0, 0, 0]] as Edge[]]]), catalog);
    expect(viaContent[0].title.key).toBe("tv:71446");
    expect(viaContent[0].score / viaMl[0].score).toBeCloseTo(0.5, 5);
  });

  it("explains content-only matches as similar themes", () => {
    const [r] = rankRecommendations(new Map([["movie:949", 1]]), new Map([["movie:949", [["tv:71446", 0, 0, 0, 0, 70]] as Edge[]]]), catalog);
    expect(r.sources).toEqual(["content"]);
    expect(r.reason).toBe("Similar themes to Heat · keywords");
  });

  it("keeps 'Because you liked' when other sources contribute, and reads old 5-score edges", () => {
    expect(formatReason(["Heat"], ["tmdb", "content"], [], false)).toBe("Because you liked Heat · TMDB + keywords");
    const [r] = rankRecommendations(new Map([["movie:949", 1]]), new Map([["movie:949", [["tv:71446", 0, 0, 60, 0]] as Edge[]]]), catalog);
    expect(r.sources).toEqual(["tmdb"]);
  });
});

describe("diversifyMedia", () => {
  it("puts a series in every window of 5 when one scores well enough", () => {
    const recs = [
      ...Array.from({ length: 12 }, (_, i) => rec(`movie:${i + 1}` as TitleKey, 100 - i)),
      rec("tv:1", 60),
      rec("tv:2", 50),
    ];
    const out = diversifyMedia(recs);
    expect(types(out)).toBe("MMMMTMMMMTMMMM");
    expect(out.map((r) => r.title.key).filter((k) => k.startsWith("tv:"))).toEqual(["tv:1", "tv:2"]); // order kept
    expect(out).toHaveLength(recs.length);
  });

  it("never forces badly scoring series", () => {
    const recs = [...Array.from({ length: 10 }, (_, i) => rec(`movie:${i + 1}` as TitleKey, 100)), rec("tv:1", 0.1)];
    expect(types(diversifyMedia(recs))).toBe("MMMMMMMMMMT");
    // Custom threshold lets it in.
    expect(types(diversifyMedia(recs, { minScore: 0.05 }))).toBe("MMMMTMMMMMM");
  });

  it("doesn't move anything when series already appear, or when there are no series", () => {
    const natural = [rec("movie:1", 9), rec("tv:1", 8), rec("movie:2", 7), rec("movie:3", 6), rec("movie:4", 5), rec("movie:5", 4)];
    expect(diversifyMedia(natural)).toEqual(natural);
    const films = [rec("movie:1", 9), rec("movie:2", 8)];
    expect(diversifyMedia(films)).toBe(films);
  });
});
