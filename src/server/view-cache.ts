import type { ValidationIssue } from '../core/validation.js';
import type { CanvasModel } from '../core/canvas.js';
import type { WebGraphModel } from './types.js';

// ---------------------------------------------------------------------------
// web_view_cache (sdd_host) — the built views the server keeps between reads.
//
// One in-process map from key to view. A read answers the kept view whether or
// not it is current; the reader decides. A change of the tree, the code or a
// producer outdates every view, keeping each one and the findings it was drawn
// with, so the rebuild that follows can draw those findings as stale while the
// gate runs again. The version counts the outdates: a reader takes it before a
// build and again before keeping the result, so a view built across a change is
// kept as not current. No bound on its size: a server keeps a handful of views
// per project (one canvas, a graph per level), each replaced in place.
// ---------------------------------------------------------------------------

/** One built view the server keeps between reads. */
export interface CachedView {
  /** The view as last built and answered. */
  model: CanvasModel | WebGraphModel;
  /** The gate findings the view was drawn with. */
  issues: ValidationIssue[];
  /** True while nothing has changed since the view was built with the gate's current findings. */
  current: boolean;
}

const views = new Map<string, CachedView>();
let outdates = 0;

/** web_view_cache.read — the entry kept under the key, current or not, or undefined. */
export function read(key: string): CachedView | undefined {
  return views.get(key);
}

/** web_view_cache.write — set the entry under the key, replacing whatever was kept there. */
export function write(key: string, view: CachedView): void {
  views.set(key, view);
}

/** web_view_cache.outdate — every entry stops being current, and the version rises by one; entries, models and findings stay. */
export function outdate(): void {
  for (const view of views.values()) view.current = false;
  outdates += 1;
}

/** web_view_cache.version — how many times the kept views have been outdated so far. */
export function version(): number {
  return outdates;
}
