import type { CachedCodeModel } from '../../models/lookup.js';

/**
 * An in-process map from resolved project root to its one entry. It lives as
 * long as the server process and is never written to disk: a restart starts
 * empty and the first lookup rebuilds.
 */
const held = new Map<string, CachedCodeModel>();

/** The entry held under the root, or null when nothing is held for it. */
export function get(root: string): CachedCodeModel | null {
  return held.get(root) ?? null;
}

/** Hold the entry under the root, replacing any earlier entry whole. */
export function put(root: string, entry: CachedCodeModel): void {
  held.set(root, entry);
}
