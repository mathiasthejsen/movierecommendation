/** Pure merge logic for local-first sync (unit tested). */

export interface Stamped {
  deleted?: boolean;
}

export interface MergeResult<T> {
  merged: Record<string, T>;
  upserts: string[];
  deletes: string[];
}

/**
 * Merge local records with the server copy (keys are "movie:603"-style ids).
 *
 * - `dirty` keys have local changes not yet pushed; they win when at least as new.
 * - A clean local record missing on the server was deleted elsewhere, so it is dropped.
 * - Local tombstones (deleted: true) that are dirty become server deletes.
 */
export function mergeRecords<T extends Stamped>(
  local: Record<string, T>,
  remote: Record<string, T>,
  dirty: Set<string>,
  stamp: (t: T) => string,
): MergeResult<T> {
  const merged: Record<string, T> = {};
  const upserts: string[] = [];
  const deletes: string[] = [];
  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const l = local[key];
    const r = remote[key];
    if (l && dirty.has(key) && (!r || stamp(l) >= stamp(r))) {
      if (l.deleted) {
        if (r) deletes.push(key);
      } else {
        merged[key] = l;
        upserts.push(key);
      }
    } else if (r) {
      merged[key] = r;
    }
    // else: clean local-only record -> deleted on another device, drop it.
  }
  return { merged, upserts, deletes };
}
