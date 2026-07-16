// ---------------------------------------------------------------------------
// Git Portal (sdd_git) — the subsystem's published in-process surface.
// The hosting server (sdd_host) consumes git backing only through here.
// ---------------------------------------------------------------------------

export { enable, disable, sync, publish, status, configureSync } from './orchestrator.js';
export type { GitConfig, GitPublish, GitBackingStatus } from './types.js';
