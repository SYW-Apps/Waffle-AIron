import { files } from '../io/index.js';
import * as path from 'path';

// ---------------------------------------------------------------------------
// dev_tree_watcher (sdd_host) — the local development server's eyes on the
// served project's .wai/ folder.
//
// One recursive watch, coalesced over a quarter of a second: a burst of writes
// (an agent saving several specs, a lock writing its record) becomes one nudge
// per kind. A change under .local/reviews/ is a `reviews` change; anything else
// (specs, the lock record, configuration) is a `tree` change. The spec tree's
// own write lock and other lock files are not changes of the design and are
// ignored.
// ---------------------------------------------------------------------------

/** What changed: a review request, or anything else in the tree. */
export type DevChangeKind = 'reviews' | 'tree';

/** Told which kind of change settled. */
export type DevChangeListener = (kind: DevChangeKind) => void;

/** Ends the watch; calling it again does nothing. */
export type DevStopWatching = () => void;

/** How long changes are coalesced before the listener is told. */
export const DEV_WATCH_DEBOUNCE_MS = 250;

/** Whether a path below .wai/ is the write lock, another lock file or the local-state folder itself, none of which is a change of the design. */
function isLockPath(rel: string): boolean {
  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  if (segments[0].startsWith('.spec-write.lock')) return true;
  // The folder holding the local state (review requests, the dev server's address) reports its own
  // modification when a file inside it is written; the file's own event follows and carries the kind.
  if (segments.length === 1 && segments[0] === '.local') return true;
  return segments[segments.length - 1].endsWith('.lock');
}

/** Whether a path below .wai/ is a review request. */
function isReviewPath(rel: string): boolean {
  return rel === '.local/reviews' || rel.startsWith('.local/reviews/');
}

/**
 * dev_tree_watcher.watch — watch `<root>/.wai` and call `onChange` with `reviews`
 * and/or `tree` once the changes have settled. Answers the function that clears
 * the timer and stops the watch.
 */
export function watch(root: string, onChange: DevChangeListener): DevStopWatching {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reviews = false;
  let tree = false;

  const stopTree = files.watchTree(path.join(root, '.wai'), (rel) => {
    const p = rel.split('\\').join('/');
    if (isLockPath(p)) return;
    if (isReviewPath(p)) reviews = true;
    else tree = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const sendReviews = reviews;
      const sendTree = tree;
      reviews = false;
      tree = false;
      if (sendTree) onChange('tree');
      if (sendReviews) onChange('reviews');
    }, DEV_WATCH_DEBOUNCE_MS);
  });

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    stopTree();
  };
}

/** Whether a producer is a member of the served project or an external it consumes. */
export type DevProducerRelation = 'member' | 'external';

/** A project on disk that the served project reads, whose .wai/ folder the dev server watches: a member or an external declared by path. */
export interface DevProducer {
  /** The served project's alias for it. */
  alias: string;
  /** Its project root, absolute. */
  root: string;
  /** Member or external. */
  relation: DevProducerRelation;
}

/** Told which producer changed. */
export type DevProducerListener = (producer: DevProducer) => void;

/**
 * dev_tree_watcher.watchProducers — watch each producer's `.wai/` folder and call `onChange` with the
 * producer once its changes have settled (a quarter of a second, per producer). Lock files are no
 * change; a producer whose folder cannot be watched is skipped. Answers the function that stops every
 * watch and clears every timer.
 */
export function watchProducers(producers: readonly DevProducer[], onChange: DevProducerListener): DevStopWatching {
  const stops: DevStopWatching[] = [];
  // Step 1: one watch per producer.
  for (const producer of producers) {
    // Step 2: a timer per producer, so a burst in one never delays another.
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A folder that cannot be watched answers a stop that does nothing: it is skipped.
    const stopTree = files.watchTree(path.join(producer.root, '.wai'), (rel) => {
      // The files adapter already answers the path with forward slashes.
      if (isLockPath(rel)) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        onChange(producer);
      }, DEV_WATCH_DEBOUNCE_MS);
    });
    stops.push(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      stopTree();
    });
  }
  // Step 3.
  return () => {
    for (const stop of stops.splice(0)) stop();
  };
}
