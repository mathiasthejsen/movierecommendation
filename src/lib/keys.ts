import type { MediaType, TitleKey } from "./types";

const KEY_RE = /^(movie|tv):(\d+)$/;

export function makeKey(type: MediaType, tmdbId: number): TitleKey {
  return `${type}:${tmdbId}`;
}

export function parseKey(key: TitleKey): { type: MediaType; tmdbId: number } {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Invalid title key: ${key}`);
  return { type: m[1] as MediaType, tmdbId: Number(m[2]) };
}

export function isKey(value: unknown): value is TitleKey {
  return typeof value === "string" && KEY_RE.test(value);
}

/** Neighbour shard for a key. Must match shard_of() in pipeline/artifact.py. */
export function shardOf(key: TitleKey, shards: number): number {
  const { type, tmdbId } = parseKey(key);
  return (tmdbId * 2 + (type === "tv" ? 1 : 0)) % shards;
}

export function tmdbUrl(key: TitleKey): string {
  const { type, tmdbId } = parseKey(key);
  return `https://www.themoviedb.org/${type}/${tmdbId}`;
}
