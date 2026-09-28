import { describe, expect, it } from "vitest";
import { detectCurator, extractCandidateTitles, extractCaption, parseSharedUrl } from "./extract";
import { bestMatch } from "./match";
import type { Title } from "./types";

const tk = (cs: { title: string; year: number | null; kind: string | null }[]) => cs.map((c) => [c.title, c.year, c.kind]);

describe("extractCaption (share text)", () => {
  it("handles inline numbered lists with emoji", () => {
    const { seeds, picks } = extractCaption("Movies like Donnie Darko 🎬 1. Coherence (2013) 2. Primer");
    expect(tk(seeds)).toEqual([["Donnie Darko", null, "movie"]]);
    expect(tk(picks)).toEqual([["Coherence", 2013, "movie"], ["Primer", null, "movie"]]);
  });

  it("strips hashtags and mentions and detects series", () => {
    const text = "5 shows like Dark you need to binge 🔥\n1. Severance (2022-)\n2. **Twin Peaks** (TV series)\n#tv @goosebumpscinema";
    const { seeds, picks } = extractCaption(text);
    expect(tk(seeds)).toEqual([["Dark", null, "tv"]]);
    expect(tk(picks)).toEqual([["Severance", 2022, "tv"], ["Twin Peaks", null, "tv"]]);
  });

  it("handles bullet captions and ignores the prose line", () => {
    const { picks } = extractCaption("Hidden gems 👇\n• Blue Ruin (2013)\n• Cure (1997)\nSave this for later!");
    expect(tk(picks)).toEqual([["Blue Ruin", 2013, null], ["Cure", 1997, null]]);
  });

  it("splits 'Shows like X: A, B and C' single-line captions", () => {
    const { seeds, picks } = extractCaption("Shows like Stranger Things: **Dark** and Severance (2022-)");
    expect(tk(seeds)).toEqual([["Stranger Things", null, "tv"]]);
    expect(tk(picks)).toEqual([["Dark", null, "tv"], ["Severance", 2022, "tv"]]);
    const plain = extractCaption("Movies like Heat: Thief, Collateral and Ronin");
    expect(tk(plain.picks).map((p) => p[0])).toEqual(["Thief", "Collateral", "Ronin"]);
    // A subtitle colon without a list stays part of the seed title.
    expect(tk(extractCaption("Movies like Mad Max: Fury Road").seeds)[0][0]).toBe("Mad Max: Fury Road");
  });

  it("uses a bare title when that's all that was shared", () => {
    expect(tk(extractCaption("Coherence").picks)).toEqual([["Coherence", null, null]]);
    expect(extractCaption("").picks).toEqual([]);
  });
});

describe("films vs series", () => {
  it("uses markers and year ranges", () => {
    const got = tk(extractCandidateTitles("- The Leftovers (TV)\n- Fargo (2014–2024)\n- Fargo (1996)\n- Mad Max: Fury Road"));
    expect(got).toEqual([
      ["The Leftovers", null, "tv"],
      ["Fargo", 2014, "tv"],
      ["Fargo", 1996, null],
      ["Mad Max: Fury Road", null, null],
    ]);
  });

  it("uses (film) markers against a TV context", () => {
    expect(tk(extractCandidateTitles("**Mindhunter** and **Zodiac** (film)", "tv"))).toEqual([
      ["Mindhunter", null, "tv"],
      ["Zodiac", null, "movie"],
    ]);
  });
});

describe("shared URLs and curators", () => {
  it("reads TMDB and Letterboxd links", () => {
    expect(parseSharedUrl("https://www.themoviedb.org/tv/1396-breaking-bad").key).toBe("tv:1396");
    expect(parseSharedUrl("https://letterboxd.com/sortedcinema/film/coherence/").candidate?.title).toBe("coherence");
    expect(parseSharedUrl("https://www.instagram.com/p/abc123/")).toEqual({});
    expect(parseSharedUrl("not a url")).toEqual({});
  });

  it("detects curator handles and aliases", () => {
    const handles = ["goosebumpscinema", "sortedcinema"];
    expect(detectCurator("via @SortedCinema", null, handles)).toBe("sortedcinema");
    expect(detectCurator("", "https://www.tiktok.com/@itsgoosebumpscinema/video/1", handles, { itsgoosebumpscinema: "goosebumpscinema" })).toBe(
      "goosebumpscinema",
    );
    expect(detectCurator("nothing here", "https://www.instagram.com/p/x/", handles)).toBeNull();
  });
});

describe("bestMatch", () => {
  const t = (key: string, title: string, year: number, votes = 1000): Title => ({
    key, type: key.startsWith("tv") ? "tv" : "movie", tmdbId: 1, title, year, genres: [], poster: null, runtime: null,
    rating: 7, votes, popularity: 1, providers: [], overview: "", seasons: null, status: null,
  });

  it("prefers the right media type and year", () => {
    const results = [t("movie:275", "Fargo", 1996, 7000), t("tv:60622", "Fargo", 2014, 2400)];
    expect(bestMatch({ title: "Fargo", year: 2014, kind: "tv" }, results)?.key).toBe("tv:60622");
    expect(bestMatch({ title: "Fargo", year: 1996, kind: null }, results)?.key).toBe("movie:275");
    expect(bestMatch({ title: "Something Else", year: null, kind: null }, results)).toBeNull();
  });
});
