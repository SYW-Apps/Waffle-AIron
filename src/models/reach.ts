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
