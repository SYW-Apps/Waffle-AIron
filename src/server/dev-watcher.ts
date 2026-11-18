import { files, gitHead } from '../io/index.js';
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
// ignored. A second recursive watch on the project's root sees its code: a
// change outside .wai/, git's own folder and any node_modules is a `code` change.
// ---------------------------------------------------------------------------

/** What changed: a review request, the tree, or the project's code. */
export type DevChangeKind = 'reviews' | 'tree' | 'code';

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

/** Whether a path below the project's root is code: outside .wai/ (watched on its own), git's folder and any node_modules. */
export function isCodePath(rel: string): boolean {
  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) return false;
  if (segments[0] === '.wai' || segments[0] === '.git') return false;
  if (segments.includes('node_modules')) return false;
  return !segments[segments.length - 1].endsWith('.lock');
}

/** Whether a path is a folder now; an absent or unreadable path is not. */
function isFolder(p: string): boolean {
  try {
    return files.statOrNull(p)?.isDirectory() === true;
  } catch {
    return false;
  }
}

/**
 * dev_tree_watcher.watch —watch `<root>/.wai`, git's HEAD and `<root>` itself for code,
 * and call `onChange` with `tree`, `code` and/or `reviews` once the changes have settled.
 * Answers the function that clears the timer and stops every watch.
 */
export function watch(root: string, onChange: DevChangeListener): DevStopWatching {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reviews = false;
  let tree = false;
  let code = false;

  // Step 5: one timer for every watch, so a burst across them is one nudge per kind.
  const settle = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const sendTree = tree;
      const sendCode = code;
      const sendReviews = reviews;
      tree = false;
      code = false;
      reviews = false;
      if (sendTree) onChange('tree');
      if (sendCode) onChange('code');
      if (sendReviews) onChange('reviews');
    }, DEV_WATCH_DEBOUNCE_MS);
  };

  // Step 1.
  const stopTree = files.watchTree(path.join(root, '.wai'), (rel) => {
    // The files adapter already answers the path with forward slashes.
    const p = rel;
    if (isLockPath(p)) return;
    if (isReviewPath(p)) reviews = true;
    else tree = true;
    settle();
  });

  // Steps 2-3: the folder of git's HEAD file: a branch switch rewrites HEAD, and that is a change of the tree.
  const headFile = gitHead.headFile(root);
  const stopHead = headFile
    ? files.watchFolder(path.dirname(headFile), (name) => {
        if (name !== 'HEAD') return;
        tree = true;
        settle();
      })
    : () => {};

  // Step 4: the project's code.
  const stopCode = files.watchTree(root, (rel) => {
    if (!isCodePath(rel)) return;
    // A folder reports its own change when an entry inside it changes, also when that entry is
    // below a node_modules folder; the entry's own event carries the change, so a folder is skipped.
    if (isFolder(path.join(root, rel))) return;
    code = true;
    settle();
  });

  // Step 6.
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    stopTree();
    stopHead();
    stopCode();
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
