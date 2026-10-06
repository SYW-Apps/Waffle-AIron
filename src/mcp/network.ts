// ---------------------------------------------------------------------------
// mcp_network_orchestrator — the read-only network tools' workflows: the
// allowed-flows matrix (optionally filtered to the flows into one project,
// Portal or verb) and the explanation of one flow, both through the network
// client adapter. The tool handlers in server.ts answer them as text and
// structured content. The selection is the request's: the family at a
// project that declares members, within the binding's reach.
// ---------------------------------------------------------------------------

import { flows as matrix, why } from './adapters/network.js';
import type { FlowExplanation, NetworkFlow } from './adapters/network.js';

/** Whether a flow lands in the named project, Portal or portal.verb. */
function lands(flow: NetworkFlow, to: string): boolean {
  const verb = `${flow.to.component ?? ''}.${flow.to.verb ?? ''}`;
  return [flow.to.project, flow.to.subsystem, flow.to.component, verb].includes(to);
}

/** imcp_network_orchestrator.flows — the sdd_get_network_flows workflow. Read-only. */
export function flows(to: string | null): NetworkFlow[] {
  // Step 1: the matrix as JSON, the request's selection.
  const doc = matrix({}, 'json');
  // Step 2: its flows, only those into `to` when given.
  const all = JSON.parse(doc.content) as NetworkFlow[];
  // Step 3.
  return to ? all.filter((f) => lands(f, to)) : all;
}

/** imcp_network_orchestrator.explain — the sdd_explain_flow workflow. Read-only. */
export function explain(from: string, to: string): FlowExplanation {
  // Steps 1-2.
  return why({}, from, to);
}
