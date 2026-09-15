import { runPeriodicGitSync } from './admin.js';
import { runPeriodicBackingSync } from './gitbacking.js';
import type { HostConfig } from './types.js';

// ---------------------------------------------------------------------------
// Backup Schedule (sdd_host)
//
// The hosted instance's periodic 60-second backup timer: sweeps the
// git-bound projects and the container-level backing repositories each tick,
// isolating a failure in one sweep from the other. Started and stopped by the
// host server; unref'd so it never keeps a closing process alive.
// ---------------------------------------------------------------------------

const TICK_MS = 60_000;

/** The one live timer this schedule owns, if started. */
let timer: NodeJS.Timeout | undefined;

/**
 * One tick: the git-bound projects' backup sweep, then the container-level
 * backing sweep. A failure in either is recorded inside it and never stops
 * the other.
 */
export function sweep(config: HostConfig): void {
  try {
    runPeriodicGitSync(config);
  } catch (err) {
    console.error('[git-sync] project sweep failed: ' + (err instanceof Error ? err.message : String(err)));
  }
  try {
    runPeriodicBackingSync(config);
  } catch (err) {
    console.error('[git-backing] backing sweep failed: ' + (err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Start the 60-second timer with `sweep` as its callback. Unref'd so it never
 * keeps a closing process alive. Starting an already-running schedule
 * replaces the previous timer, so at most one stays live.
 */
export function start(config: HostConfig): void {
  if (timer) clearInterval(timer);
  timer = setInterval(() => sweep(config), TICK_MS);
  timer.unref();
}

/** Cancel the timer; a sweep already running completes. */
export function stop(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
