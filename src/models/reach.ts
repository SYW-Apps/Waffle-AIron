// ---------------------------------------------------------------------------
// The reach model: what reaches each Portal verb, and from where.
//
// Projected from one project's own tree (reach_model_projector.project) or
// composed for a whole family (reach_model_projector.compose). It is the one
// input of the network rules (network_arbiter) and of every derived networking
// output, so the validator and the flow matrix can never disagree about what
// reaches what. Logical only: no address, port or range.
// ---------------------------------------------------------------------------

import type { DeclaredInvocation, Transport } from './specs.js';

/**
 * network_boundary — one declared network of a reach model: the project that
 * declares it, the network it sits inside, and the gateways on it.
 */
export interface NetworkBoundary {
  /** The declaring project's key: the network's stable name in findings, flows and diagrams. */
  id: string;
  /** The enclosing network's id; absent for an outermost network. */
  parent?: string;
  /** The declaration's own description, when it has one. */
  description?: string;
  /** The component keys of the gateway-variant Portals inside it that take outside entries. */
  gateways: string[];
}

/**
 * verb_reach — one Portal verb as the reach model sees it: where it sits, how
 * it is reached, and what entry it has.
 */
export interface VerbReach {
  /** The key of the project holding the Portal. */
  project: string;
  /** The Portal's component key. */
  portal: string;
  /** The contract method's name. */
  verb: string;
  /** The subsystem key holding the Portal, qualified like the portal in a family-scoped model: the unit a deployment usually runs as one workload. */
  subsystem?: string;
  /** The Portal's transport. */
  transport: Transport;
  /** The endpoint as one line (POST /orders, orders.v1.Orders/Create, topic orders.created); absent for InProcess. */
  binding?: string;
  /** The innermost declared network the Portal sits inside; absent when none encloses it. */
  network?: string;
  /** Whether the Portal has the gateway variant. */
  gateway: boolean;
  /** Its effective entry (component_spec.entryFor), when it has one. */
  entry?: DeclaredInvocation;
  /** The widest audience an L0 export entry exposing this verb declares, when one does. */
  audience?: string;
}

/**
 * modelled_call — one modelled call that crosses a subsystem or project
 * boundary into a Portal verb: a call or register step, a declared `calls`
 * entry or a dispatch routed through a table. The evidence a flow and an entry
 * proof rest on.
 */
export interface ModelledCall {
  /** The key of the project holding the caller. */
  fromProject: string;
  /** The calling component's key (the bridging Adapter, or any component for a library call). */
  fromComponent: string;
  /** The calling component's subsystem key, qualified like the component in a family-scoped model; for a cross-project call, read from the consumer's placements. */
  fromSubsystem?: string;
  /** The innermost declared network the caller sits inside; absent when none encloses it. */
  fromNetwork?: string;
  /** The called Portal's component key. */
  toPortal: string;
  /** The called contract method. */
  verb: string;
  /** Where the call is written: <implementation>.<method>#<step>, or <implementation>.<method> calls for a declared call. */
  evidence: string;
}

/**
 * reach_model — what reaches each Portal verb and from where, projected from a
 * tree (scope own) or a whole family (scope family). Deterministic: the same
 * tree gives the same model, in a stable order.
 */
export interface ReachModel {
  /** What it was projected from: own (one project's own gate) or family (the family run at its root). */
  scope: 'own' | 'family';
  /** Every declared network in scope, outermost first. */
  networks: NetworkBoundary[];
  /** Every Portal verb in scope. */
  verbs: VerbReach[];
  /** Every modelled call into a Portal verb that crosses a subsystem or project boundary. */
  calls: ModelledCall[];
  /** Every component in scope, with its project and subsystem: how a party is known, and how a caller is named by its workload. */
  placements: ComponentPlacement[];
  /** Every end of the pub/sub graph in scope, which the family run pairs across projects. */
  topics: TopicEnd[];
  /** The model's network findings, judged and lint-allow filtered, when it was read for the derived networking outputs. */
  findings?: ReachFinding[];
  /** Every subsystem in scope, qualified like the placements, one holding only types included: how such a subsystem is known as a party. */
  subsystems?: string[];
  /** The aliases of the bound project's declared externals: a party named `<alias>::<name>` through one is known. */
  externals?: string[];
  /** The bound root's project id: how the root's own parties and network are named in an encoded matrix, where its key is empty. */
  rootProject?: string;
  /** Each former name of a renamed member project (its previousIds, qualified like its key) mapped to its current key. */
  formerNames?: Record<string, string>;
  /** At a member's own root: the member's key in the enclosing family the model was composed for. */
  focus?: string;
  /** At a member's own root: the root directory of the enclosing family whose network declaration and proofs the model carries. */
  judgedAt?: string;
}

/**
 * component_placement — where one component of a reach model sits: its
 * project, its subsystem (the unit a deployment usually runs as one workload)
 * and its block.
 */
export interface ComponentPlacement {
  /** The key of the project holding it ('' for the bound root). */
  project: string;
  /** Its component key, qualified like the verbs in a family-scoped model. */
  component: string;
  /** Its subsystem key, qualified like the component. */
  subsystem?: string;
  /** Its building block or pattern. */
  componentType: string;
}

/** topic_end — one end of the pub/sub graph: a component emitting or subscribing to one topic. */
export interface TopicEnd {
  /** The component key, as the model names its components. */
  component: string;
  /** The topic, exactly as used on the bus. */
  topic: string;
  /** True on the publishing end, false on the subscribing end. */
  emits: boolean;
}

/**
 * reach_finding — one network finding of a judged reach model: an error
 * refuses the flows it sits on, a warning or notice marks them.
 */
export interface ReachFinding {
  severity: 'error' | 'warning' | 'notice';
  code: string;
  message: string;
  /** The spec it sits on: the verb's Portal, or the call's calling component (family keys). */
  specId?: string;
  /** The site inside that spec: the verb, or the call's evidence; absent on a finding that covers several verbs of one Portal. */
  at?: string;
  /** The verbs of the Portal it sits on that one aggregated finding covers (a Portal-level GATEWAY_BYPASSED). */
  covers?: string[];
}

/**
 * reach_model.callersOf — the modelled calls that land on one Portal verb: the
 * calls naming it, and the dispatches routed through the Portal's table
 * (recorded as `capability:<name>`), which reach its served surface. Pure.
 */
export function callersOf(model: ReachModel, portal: string, verb: string): ModelledCall[] {
  return model.calls.filter((c) => c.toPortal === portal && (c.verb === verb || c.verb.startsWith('capability:')));
}

/**
 * reach_model.enclosing — the chain of declared networks around a network,
 * innermost first, ending at the outermost. None for an absent network. Pure.
 */
export function enclosing(model: ReachModel, network: string | undefined): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current = network;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = model.networks.find((n) => n.id === current)?.parent;
  }
  return chain;
}
