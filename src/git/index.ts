// ---------------------------------------------------------------------------
// Git Portal (sdd_git) — the subsystem's published in-process surface.
// The hosting server (sdd_host) consumes git backing only through here.
// ---------------------------------------------------------------------------

export { enable, disable, sync, publish } from './orchestrator.js';
export type { GitConfig, GitPublish } from './types.js';
