import curatorConfig from "../../config/curators.json";
import type { Curator } from "./types";

/** Curators from config/curators.json (public info only: handles and weights). */
export const CURATORS: Curator[] = (curatorConfig.curators as Curator[]).map((c) => ({
  handle: c.handle,
  name: c.name || c.handle,
  instagram: c.instagram || "",
  tiktok: c.tiktok || "",
  youtube: c.youtube || "",
  letterboxd: c.letterboxd || "",
  own: Boolean(c.own),
  weight: typeof c.weight === "number" ? c.weight : 0.6,
  enabled: c.enabled !== false,
}));

export const ENABLED_CURATORS = CURATORS.filter((c) => c.enabled);

/** handle -> weight for enabled curators; unknown handles (added in the app) default to own weight. */
export function curatorWeights(extraHandles: Iterable<string> = []): Map<string, number> {
  const map = new Map(ENABLED_CURATORS.map((c) => [c.handle, c.weight]));
  for (const h of extraHandles) {
    if (!map.has(h) && !CURATORS.some((c) => c.handle === h)) map.set(h, 1);
  }
  return map;
}

/** Social usernames that differ from the handle (e.g. TikTok "itsgoosebumpscinema"). */
export function curatorAliases(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of CURATORS) {
    for (const alias of [c.instagram, c.tiktok, c.youtube, c.letterboxd]) {
      if (alias && alias.toLowerCase() !== c.handle.toLowerCase()) out[alias.toLowerCase()] = c.handle;
    }
  }
  return out;
}

export const HANDLE_RE = /^[A-Za-z0-9._]{1,30}$/;

/**
 * Curators you follow: your own entries in config/curators.json (own: true, enabled),
 * plus any handle you've shared picks from that isn't in the config.
 */
export function isFollowed(handle: string): boolean {
  const c = CURATORS.find((x) => x.handle === handle);
  return c ? c.own && c.enabled : true;
}
