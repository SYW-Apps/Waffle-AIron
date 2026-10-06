// ---------------------------------------------------------------------------
// network_portal — sdd_network's in-process front door, called by the CLI's
// `wairon network` commands, the MCP read tools and the hosted canvas's
// network view. Read-only: every answer is derived from the design and handed
// back for its caller to print or save; no spec, lock or file is written here.
// ---------------------------------------------------------------------------
export { flows, policy, diagram, view, check, why } from './orchestrator.js';
export type {
  FlowCheckReport,
  FlowExplanation,
  FlowParty,
  NetworkBindings,
  NetworkDocument,
  NetworkFlow,
  NetworkOutputFormat,
  NetworkViewModel,
  ObservedFlow,
  WorkloadBinding,
} from './types.js';
