// ---------------------------------------------------------------------------
// Producer Portal (sdd_producers) — the subsystem's published in-process surface.
// The hosting server and the CLI consume producers only through here.
// ---------------------------------------------------------------------------

export { configure, produce, remove, list } from './orchestrator.js';
export { project } from './projection.js';
export type { ProducerConfig, DocPage } from './types.js';
