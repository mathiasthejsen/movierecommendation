export type MediaType = "movie" | "tv";

/** Composite id such as "movie:603" or "tv:1396". */
export type TitleKey = string;

export interface Title {
  key: TitleKey;
  type: MediaType;
  tmdbId: number;
  title: string;
  year: number;
  genres: number[];
  poster: string | null;
  /** minutes (films) or typical episode length (TV) */
  runtime: number | null;
  /** TMDB vote average, 0-10 */
  rating: number;
  votes: number;
  popularity: number;
  /** TMDB watch-provider ids (flatrate/free/ads) for the artifact's region */
  providers: number[];
  overview: string;
  /** TV only */
  seasons: number | null;
  status: "ended" | "ongoing" | null;
}

/** [neighbor key, movielens, reddit, tmdb, trakt] with scores 0-100 */
export type Edge = [TitleKey, number, number, number, number];

export interface Meta {
  version: number;
  generatedAt: string;
  sample: boolean;
  region: string;
  minYear: number;
  shards: number;
  counts: Record<string, number>;
  genres: Record<string, string>;
  providers: Record<string, { name: string; logo: string | null }>;
  attribution: Record<string, string>;
}

export interface Curator {
  handle: string;
  name: string;
  instagram?: string;
  tiktok?: string;
  youtube?: string;
  letterboxd?: string;
  own: boolean;
  weight: number;
  enabled: boolean;
  verify?: boolean;
  note?: string;
}

export type PickSource = "letterboxd" | "letterboxd-list" | "instagram" | "share" | "manual";

/** A curator pick as used by the ranking (from the artifact or Supabase). */
export interface CuratorPick {
  key: TitleKey;
  curator: string;
  source: PickSource;
  url: string | null;
  /** strength of the pick itself, 0-1 (curator weight is applied separately) */
  weight: number;
}

export type RatingKind = "thumb" | "star";

export interface UserRating {
  key: TitleKey;
  kind: RatingKind;
  /** thumb: -1 | 1, star: 1-5 */
  value: number;
  updatedAt: string;
  deleted?: boolean;
}

export interface WatchItem {
  key: TitleKey;
  addedAt: string;
  deleted?: boolean;
}

export type Source = "reddit" | "movielens" | "tmdb" | "trakt";
