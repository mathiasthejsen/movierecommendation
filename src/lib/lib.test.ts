import { describe, expect, it } from "vitest";
import { parseCatalog } from "./artifact";
import { isKey, parseKey, shardOf } from "./keys";
import { onboardingPicks, searchCatalog } from "./search";
import { mergeRecords } from "./sync";

describe("keys", () => {
  it("parses and shards composite keys like the pipeline", () => {
    expect(parseKey("tv:1396")).toEqual({ type: "tv", tmdbId: 1396 });
    expect(isKey("movie:603")).toBe(true);
    expect(isKey("603")).toBe(false);
    expect(shardOf("movie:603", 32)).toBe((603 * 2) % 32);
    expect(shardOf("tv:603", 32)).toBe((603 * 2 + 1) % 32);
    expect(() => parseKey("person:1")).toThrow();
  });
});

describe("mergeRecords", () => {
  type R = { v: number; t: string; deleted?: boolean };
  const stamp = (r: R) => r.t;

  it("keeps newer dirty local changes and takes remote otherwise", () => {
    const local = { "movie:1": { v: 5, t: "2026-02" }, "movie:2": { v: 1, t: "2026-01" } };
    const remote = { "movie:1": { v: 3, t: "2026-01" }, "movie:2": { v: 4, t: "2026-03" }, "tv:3": { v: 2, t: "2026-01" } };
    const r = mergeRecords<R>(local, remote, new Set(["movie:1", "movie:2"]), stamp);
    expect(r.merged["movie:1"].v).toBe(5);
    expect(r.merged["movie:2"].v).toBe(4);
    expect(r.merged["tv:3"].v).toBe(2);
    expect(r.upserts).toEqual(["movie:1"]);
  });

  it("propagates deletes both ways", () => {
    const local = { "movie:1": { v: 5, t: "2026-02", deleted: true }, "movie:2": { v: 1, t: "2026-01" } };
    const remote = { "movie:1": { v: 5, t: "2026-01" } };
    const r = mergeRecords<R>(local, remote, new Set(["movie:1"]), stamp);
    expect(r.deletes).toEqual(["movie:1"]);
    expect(r.merged).toEqual({}); // movie:2 was clean and is gone remotely -> dropped
  });
});

describe("catalog", () => {
  const catalog = parseCatalog({
    fields: ["key", "title", "year", "genres", "poster", "runtime", "rating", "votes", "popularity", "providers", "overview", "seasons", "status"],
    rows: [
      ["movie:275", "Fargo", 1996, [80], null, 98, 7.9, 7300, 1, [8], "", null, null],
      ["tv:60622", "Fargo", 2014, [80], null, 53, 8.3, 2400, 1, [], "", 5, "ongoing"],
      ["tv:1396", "Breaking Bad", 2008, [18], null, 47, 8.9, 14000, 1, [], "", 5, "ended"],
      ["movie:603", "The Matrix", 1999, [28], null, 136, 8.2, 26000, 1, [], "", null, null],
    ],
  });

  it("parses TV fields", () => {
    expect(catalog.get("tv:1396")).toMatchObject({ type: "tv", tmdbId: 1396, seasons: 5, status: "ended" });
  });

  it("searches offline by title, year and type", () => {
    expect(searchCatalog(catalog.values(), "matrix")[0].key).toBe("movie:603");
    expect(searchCatalog(catalog.values(), "fargo 2014")[0].key).toBe("tv:60622");
    expect(searchCatalog(catalog.values(), "fargo", { type: "movie" }).map((t) => t.key)).toEqual(["movie:275"]);
  });

  it("includes shows in onboarding", () => {
    const picks = onboardingPicks(catalog.values(), 4, 0.5);
    expect(picks.filter((t) => t.type === "tv")).toHaveLength(2);
    expect(picks).toHaveLength(4);
  });
});
