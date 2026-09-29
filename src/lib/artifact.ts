import { asset } from "./config";
import { parseKey, shardOf } from "./keys";
import type { Curator, CuratorPick, Edge, Meta, Title, TitleKey } from "./types";

interface CatalogFile {
  fields: string[];
  rows: unknown[][];
}

interface CuratorsFile {
  sample?: boolean;
  curators: Curator[];
  picks: (CuratorPick & { first_seen?: string })[];
}

let metaPromise: Promise<Meta> | null = null;
let catalogPromise: Promise<Map<TitleKey, Title>> | null = null;
let curatorsPromise: Promise<CuratorsFile> | null = null;
const shardPromises = new Map<number, Promise<Record<string, Edge[]>>>();

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(asset(path));
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return (await res.json()) as T;
}

function once<T>(get: () => Promise<T> | null, set: (p: Promise<T> | null) => void, load: () => Promise<T>): Promise<T> {
  const existing = get();
  if (existing) return existing;
  const p = load().catch((e) => {
    set(null);
    throw e;
  });
  set(p);
  return p;
}

export function parseCatalog(file: CatalogFile): Map<TitleKey, Title> {
  const idx = (name: string) => file.fields.indexOf(name);
  const f = {
    key: idx("key"), title: idx("title"), year: idx("year"), genres: idx("genres"), poster: idx("poster"),
    runtime: idx("runtime"), rating: idx("rating"), votes: idx("votes"), popularity: idx("popularity"),
    providers: idx("providers"), overview: idx("overview"), seasons: idx("seasons"), status: idx("status"),
  };
  if (f.key < 0 || f.title < 0) throw new Error("catalog.json is missing key/title fields (old artifact?)");
  const get = <T>(r: unknown[], i: number, fallback: T): T => (i >= 0 && r[i] != null ? (r[i] as T) : fallback);
  const map = new Map<TitleKey, Title>();
  for (const r of file.rows) {
    const key = r[f.key] as string;
    const { type, tmdbId } = parseKey(key);
    map.set(key, {
      key,
      type,
      tmdbId,
      title: r[f.title] as string,
      year: get(r, f.year, 0),
      genres: get(r, f.genres, [] as number[]),
      poster: get<string | null>(r, f.poster, null),
      runtime: get<number | null>(r, f.runtime, null),
      rating: get(r, f.rating, 0),
      votes: get(r, f.votes, 0),
      popularity: get(r, f.popularity, 0),
      providers: get(r, f.providers, [] as number[]),
      overview: get(r, f.overview, ""),
      seasons: get<number | null>(r, f.seasons, null),
      status: get<"ended" | "ongoing" | null>(r, f.status, null),
    });
  }
  return map;
}

export function loadMeta(): Promise<Meta> {
  return once(() => metaPromise, (p) => (metaPromise = p), () => getJson<Meta>("/data/meta.json"));
}

export function loadCatalog(): Promise<Map<TitleKey, Title>> {
  return once(
    () => catalogPromise,
    (p) => (catalogPromise = p),
    () => getJson<CatalogFile>("/data/catalog.json").then(parseCatalog),
  );
}

/** Accumulated curator picks from the pipeline (Letterboxd RSS / optional Instagram). */
export function loadArtifactCurators(): Promise<CuratorsFile> {
  return once(
    () => curatorsPromise,
    (p) => (curatorsPromise = p),
    () => getJson<CuratorsFile>("/data/curators.json").catch(() => ({ curators: [], picks: [] })),
  );
}

function loadShard(shard: number): Promise<Record<string, Edge[]>> {
  let p = shardPromises.get(shard);
  if (!p) {
    p = getJson<Record<string, Edge[]>>(`/data/neighbors/${shard}.json`).catch((e) => {
      shardPromises.delete(shard);
      throw e;
    });
    shardPromises.set(shard, p);
  }
  return p;
}

/** Lazily load only the neighbour shards needed for the given keys. */
export async function loadNeighbors(keys: Iterable<TitleKey>): Promise<Map<TitleKey, Edge[]>> {
  const meta = await loadMeta();
  const wanted = [...new Set(keys)];
  const shards = [...new Set(wanted.map((k) => shardOf(k, meta.shards)))];
  const loaded = await Promise.all(shards.map(loadShard));
  const byShard = new Map(shards.map((s, i) => [s, loaded[i]]));
  const out = new Map<TitleKey, Edge[]>();
  for (const key of wanted) {
    const edges = byShard.get(shardOf(key, meta.shards))?.[key];
    if (edges) out.set(key, edges);
  }
  return out;
}

/**
 * Has a newer data artifact been deployed? Fetches meta.json fresh (query string busts the
 * Pages CDN; the service worker passes query-string data requests straight to the network)
 * and compares its build time with the one this page loaded.
 */
export async function isNewDataAvailable(loadedGeneratedAt: string): Promise<boolean> {
  try {
    const res = await fetch(asset(`/data/meta.json?check=${Date.now()}`), { cache: "no-store" });
    if (!res.ok) return false;
    const fresh = (await res.json()) as Meta;
    return Boolean(fresh.generatedAt && fresh.generatedAt !== loadedGeneratedAt);
  } catch {
    return false;
  }
}
