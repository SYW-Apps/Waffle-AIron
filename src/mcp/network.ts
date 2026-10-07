// ---------------------------------------------------------------------------
// mcp_network_orchestrator — the network tools' workflows: the allowed-flows
// matrix (optionally filtered to the flows into one project, Portal or verb)
// and the explanation of one flow, both read through the network client
// adapter, and the one write — the project's network declaration, through the
// core client adapter. The tool handlers in server.ts answer them as text and
// structured content. The selection is the request's: the family at a
// project that declares members, within the binding's reach.
// ---------------------------------------------------------------------------

import { flows as matrix, why } from './adapters/network.js';
// flow_party.isNamed: a pure method of the party type, read where the type lives.
import { isNamed } from '../network/types.js';
import { effectiveProjectId } from '../models/index.js';
import { WaironError } from '../utils/errors.js';
import { loadProjectConfig, setNetwork } from './adapters/core.js';
import type { FlowExplanation, NetworkFlow } from './adapters/network.js';

/**
 * A party as written, read as the network commands read one: the bound
 * project's own id (or a former one) written as a prefix — `<project>::<portal>`
 * or `<project>::<portal>.<verb>` — names its own party, which the matrix keys
 * bare (the bound root's project key is empty).
 */
function ownParty(to: string): string {
  let config: ReturnType<typeof loadProjectConfig> = null;
  try { config = loadProjectConfig(); } catch { /* an unreadable configuration: read the name as written */ }
  const own = config ? [effectiveProjectId(config), ...(config.previousIds ?? [])].filter((id): id is string => !!id) : [];
  for (const id of own) if (to.startsWith(`${id}::`)) return to.slice(id.length + 2);
  return to;
}

/** imcp_network_orchestrator.flows — the sdd_get_network_flows workflow. Read-only. */
export function flows(to: string | null): NetworkFlow[] {
  // Step 1: the matrix as JSON, the request's selection.
  const doc = matrix({}, 'json');
  const all = JSON.parse(doc.content) as NetworkFlow[];
  if (!to) return all;
  // Step 2: only the flows whose called end the name denotes.
  const party = ownParty(to);
  const landing = all.filter((f) => isNamed(f.to, party));
  // Steps 3-6: an empty answer must never stand for a name that resolved to nothing.
  if (landing.length === 0) {
    const explanation = why({}, 'outside', party);
    if (explanation.unknown?.includes(party)) {
      throw new WaironError(
        `unknown party "${to}": nothing in the design is named so — name a project, a subsystem or a Portal (bare, or as <project>::<portal>), or a verb as <portal>.<verb>. `
        + 'An empty answer means no flow lands in a party that exists; this one does not exist.',
      );
    }
  }
  return landing;
}

/** imcp_network_orchestrator.explain — the sdd_explain_flow workflow. Read-only. */
export function explain(from: string, to: string): FlowExplanation {
  // Steps 1-2.
  return why({}, from, to);
}

/**
 * imcp_network_orchestrator.declare — the sdd_set_network workflow: declare
 * (with its description) or remove the bound project's network. Returns
 * whether it wrote.
 */
export function declare(declared: boolean, description: string | null): boolean {
  // Step 1: a declaration already held keeps its description unless a new one is given.
  const held = declared ? loadProjectConfig()?.network : undefined;
  const kept = description ?? (typeof held === 'object' && held !== null ? held.description ?? null : null);
  // Step 2: the declaration, or none.
  const network = declared ? (kept ? { description: kept } : {}) : null;
  // Steps 3-4: written through the core client adapter.
  return setNetwork(network);
}
