// ---------------------------------------------------------------------------
// Producer Portal (sdd_producers) — the subsystem's published in-process surface.
// The hosting server and the CLI consume producers only through here.
// ---------------------------------------------------------------------------

export { configure, produce, remove, list } from './orchestrator.js';
export { project, projectGraph } from './projection.js';
export type { ProducerConfig, DocPage, GraphModel, GraphNode, GraphEdge } from './types.js';
