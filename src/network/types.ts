// ---------------------------------------------------------------------------
// sdd_network's values: the allowed-flows matrix, the deployment-side inputs a
// team keeps outside .wai/ (bindings, observed flows), and what the derived
// networking answers (documents, the canvas view model, the check report and
// the explanation of one flow). Logical names only: no address ever comes
// from a spec — the bindings file is where deployment facts enter.
// ---------------------------------------------------------------------------

import type { EntryScope, Transport } from '../models/specs.js';
import type { NetworkBoundary } from '../models/reach.js';

/**
 * flow_party — one end of an allowed flow, named by stable design names: a
 * component of a project, a Portal verb, or a scope (callers outside a
 * network, or anywhere inside one) when the callers are not modelled.
 */
export interface FlowParty {
  /** The project key, for a modelled party ('' for the bound root). */
  project?: string;
  /** The subsystem holding the component, for a modelled party, when the model knows it. */
  subsystem?: string;
  /** The component key: the calling component, or the called Portal. */
  component?: string;
  /** The called contract method, on the called end. */
  verb?: string;
  /** For unmodelled callers: outside, or network. */
  scope?: EntryScope;
  /** The declared network the party sits in, or that a network scope names. */
  network?: string;
}

/**
 * flow_party.workload — the party's default workload name: outside for
 * callers outside, network:<id> (or network) for callers anywhere inside a
 * network, the project key for a member's party, and for the bound root's own
 * party (its key is empty) its subsystem, else its component. Pure.
 */
export function workload(party: FlowParty): string {
  if (party.scope === 'outside') return 'outside';
  if (party.scope === 'network') return party.network ? `network:${party.network}` : 'network';
  if (party.project) return party.project;
  return party.subsystem ?? party.component ?? '';
}

/**
 * flow_party.key — the party as one stable line: the component (portal.verb
 * on the called end), or the workload name of a scope. Pure.
 */
export function key(party: FlowParty): string {
  if (party.scope !== undefined) return workload(party);
  return party.verb !== undefined ? `${party.component ?? ''}.${party.verb}` : (party.component ?? workload(party));
}

/**
 * flow_party.isNamed — whether a name denotes this party or a whole it lies
 * within: outside and network[:<id>] name scopes; any other name matches the
 * party's project, subsystem, component, workload name or key. Pure.
 */
export function isNamed(party: FlowParty, name: string): boolean {
  if (name === 'outside') return party.scope === 'outside';
  if (name === 'network' || name.startsWith('network:')) {
    return party.scope === 'network' && (name === 'network' || (party.network ?? '') === name.slice('network:'.length));
  }
  if (party.scope !== undefined || name === '') return false;
  return [party.project, party.subsystem, party.component, workload(party), key(party)].includes(name);
}

/**
 * network_flow — one allowed flow of the matrix: who reaches which verb, over
 * which transport and binding, through which networks and gateway, and on what
 * evidence. Only network transports produce flows.
 */
export interface NetworkFlow {
  /** The caller: a modelled component, or a scope for unmodelled callers. */
  from: FlowParty;
  /** The called Portal verb. */
  to: FlowParty;
  /** The called Portal's transport. */
  transport: Transport;
  /** The endpoint as one line: POST /orders, a gRPC method, a topic. */
  binding?: string;
  /** The declared networks entered, outermost first. */
  crosses: string[];
  /** The gateway entered, when a network is crossed. */
  via?: string;
  /** What allows it: each modelled call's evidence, or the entry with its caller prose. */
  evidence: string[];
  /** On an aggregated edge of the network view: each verb it carries, as portal.verb with its binding. */
  verbs?: string[];
}

/**
 * workload_binding — how one design name maps to a deployed workload, as the
 * team's bindings file says.
 */
export interface WorkloadBinding {
  /** The workload's labels, as the deployment sets them. */
  selector: Record<string, string>;
  /** The namespace it runs in, when the target format has one. */
  namespace?: string;
  /** The port its Portals listen on, when the policy should name one. */
  port?: number;
}

/**
 * network_bindings — the deployment side of the derived networking, kept by
 * the team outside .wai/ and passed by path.
 */
export interface NetworkBindings {
  /** Each design name's workload. */
  workloads: Record<string, WorkloadBinding>;
  /** The address blocks a policy admits for callers from outside the outermost network. */
  outside?: string[];
}

/** network_output_format — the formats the derived networking writes. */
export type NetworkOutputFormat = 'json' | 'csv' | 'markdown' | 'kubernetes-network-policy' | 'mermaid';

/**
 * observed_flow — one flow seen in a live system, already named by the team's
 * bindings (wairon never sees an address).
 */
export interface ObservedFlow {
  /** The calling workload's design name, or outside. */
  source: string;
  /** The called workload's design name. */
  destination: string;
  /** The protocol seen. */
  transport?: string;
  /** At L7: the HTTP method or RPC method seen. */
  method?: string;
  /** At L7: the path seen. */
  path?: string;
  /** How often it was seen in the window. */
  count?: number;
}

/**
 * flow_check_report — observed live flows compared with the allowed matrix.
 */
export interface FlowCheckReport {
  /** Observed, but no flow of the matrix allows it. */
  unexpected: ObservedFlow[];
  /** Allowed, but never observed in the window. */
  unexercised: NetworkFlow[];
  /** Observed at L7 on an allowed workload pair, but no verb of the called Portal has that method and path. */
  unknownVerbs: ObservedFlow[];
}

/**
 * flow_explanation — why one party may reach another, from the design.
 */
export interface FlowExplanation {
  /** Whether any flow allows it. */
  allowed: boolean;
  /** The flows that allow it. */
  flows: NetworkFlow[];
  /** Each step of the justification as one line. */
  chain: string[];
}

/**
 * network_document — one generated networking output: its format, the text to
 * write, and the design names it had no binding for.
 */
export interface NetworkDocument {
  /** What it is. */
  format: NetworkOutputFormat;
  /** The text: JSON, CSV, Markdown, YAML documents or Mermaid. */
  content: string;
  /** The design names the bindings did not map. */
  unbound: string[];
}

/**
 * network_view_model — what the hosted canvas's network view draws.
 */
export interface NetworkViewModel {
  /** The declared networks, outermost first. */
  networks: NetworkBoundary[];
  /** Each project or component that sends or receives a flow, with the network it sits in. */
  workloads: FlowParty[];
  /** The flows aggregated per workload pair and transport, evidence and verbs merged. */
  edges: NetworkFlow[];
}
