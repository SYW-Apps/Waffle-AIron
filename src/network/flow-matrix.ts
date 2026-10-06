// ---------------------------------------------------------------------------
// flow_matrix_projector — the allowed-flows matrix of a reach model, and the
// explanation of one flow from it. Only network transports produce flows:
// in-process and local verbs never do.
//
// - Each modelled call into a network verb is a flow from its calling
//   component, with the networks it enters and the gateway it crosses.
// - Each outside entry is a flow from outside.
// - Each network entry is a flow from the whole network; in a family-scoped
//   model it is narrowed to its modelled callers when any exist, so the
//   matrix is least-privilege by construction.
//
// Pure: over the model it is handed, it reads nothing and writes nothing.
// ---------------------------------------------------------------------------

import { transportKind } from '../models/specs.js';
import { callersOf, enclosing } from '../models/reach.js';
import type { ModelledCall, ReachModel, VerbReach } from '../models/reach.js';
import { isNamed, key as partyKey } from './types.js';
import type { FlowExplanation, FlowParty, NetworkFlow } from './types.js';

/** The called end of a verb's flows. */
function calleeOf(verb: VerbReach): FlowParty {
  return {
    project: verb.project,
    ...(verb.subsystem !== undefined ? { subsystem: verb.subsystem } : {}),
    component: verb.portal,
    verb: verb.verb,
    ...(verb.network !== undefined ? { network: verb.network } : {}),
  };
}

/** The calling end of a modelled call. */
function callerOf(call: ModelledCall): FlowParty {
  return {
    project: call.fromProject,
    ...(call.fromSubsystem !== undefined ? { subsystem: call.fromSubsystem } : {}),
    component: call.fromComponent,
    ...(call.fromNetwork !== undefined ? { network: call.fromNetwork } : {}),
  };
}

/** The networks around a verb, outermost first. */
function networksAround(model: ReachModel, network: string | undefined): string[] {
  return enclosing(model, network).reverse();
}

/** A flow's shared facts: the callee, its transport and binding, the networks entered and the gateway. */
function flowInto(verb: VerbReach, from: FlowParty, crosses: string[], evidence: string): NetworkFlow {
  return {
    from,
    to: calleeOf(verb),
    transport: verb.transport,
    ...(verb.binding !== undefined ? { binding: verb.binding } : {}),
    crosses,
    ...(crosses.length > 0 && verb.gateway ? { via: verb.portal } : {}),
    evidence: [evidence],
  };
}

/** A modelled call's flow: it enters the verb's networks its caller is not already inside. */
function callFlow(model: ReachModel, verb: VerbReach, call: ModelledCall): NetworkFlow {
  const inside = new Set(enclosing(model, call.fromNetwork));
  const crosses = networksAround(model, verb.network).filter((n) => !inside.has(n));
  return flowInto(verb, callerOf(call), crosses, `call ${call.evidence}`);
}

/** The entry's evidence line: its scope and its caller prose. */
function entryEvidence(verb: VerbReach): string {
  const scope = verb.entry?.scope ?? 'outside';
  return verb.entry?.caller ? `entry (${scope}): ${verb.entry.caller}` : `entry (${scope})`;
}

/**
 * An outside entry's flow. Scopes are relative: outside a nested network is
 * the next network out, so the flow comes from anywhere inside the parent and
 * crosses only the verb's own network; outside the outermost network (or with
 * none declared) it comes from outside everything.
 */
function outsideFlow(model: ReachModel, verb: VerbReach): NetworkFlow {
  const [own, parent] = enclosing(model, verb.network);
  const from: FlowParty = parent !== undefined ? { scope: 'network', network: parent } : { scope: 'outside' };
  return flowInto(verb, from, own !== undefined ? [own] : [], entryEvidence(verb));
}

/** A network entry's flow: from anywhere inside the verb's own network, crossing none. */
function networkFlow(verb: VerbReach): NetworkFlow {
  const from: FlowParty = { scope: 'network', ...(verb.network !== undefined ? { network: verb.network } : {}) };
  return flowInto(verb, from, [], entryEvidence(verb));
}

/** Two flows between the same parties merge: their evidence joins. */
function addFlow(flows: Map<string, NetworkFlow>, flow: NetworkFlow): void {
  const key = `${partyKey(flow.from)}\u0000${partyKey(flow.to)}`;
  const known = flows.get(key);
  if (!known) flows.set(key, flow);
  else if (!known.evidence.includes(flow.evidence[0])) known.evidence.push(...flow.evidence);
}

/** By callee (project, portal, verb), then caller. */
function byCalleeThenCaller(a: NetworkFlow, b: NetworkFlow): number {
  return (a.to.project ?? '').localeCompare(b.to.project ?? '')
    || partyKey(a.to).localeCompare(partyKey(b.to))
    || partyKey(a.from).localeCompare(partyKey(b.from));
}

/**
 * iflow_matrix_projector.project — the allowed-flows matrix of a reach model,
 * in a stable order. Pure.
 */
export function project(model: ReachModel): NetworkFlow[] {
  const flows = new Map<string, NetworkFlow>();
  // Step 1: each network-transport verb.
  for (const verb of model.verbs.filter((v) => transportKind(v.transport) === 'network')) {
    // Step 2: one flow per modelled caller.
    const callers = callersOf(model, verb.portal, verb.verb);
    for (const call of callers) addFlow(flows, callFlow(model, verb, call));
    // Step 3: a verb with no entry of its own has only its callers' flows.
    if (verb.entry?.kind !== 'entry') continue;
    // Step 4: which scope?
    if (verb.entry.scope === 'network') {
      // Step 5: least privilege — a family-scoped model's modelled callers stand for the network.
      if (!(model.scope === 'family' && callers.length > 0)) addFlow(flows, networkFlow(verb));
      continue;
    }
    // Step 6: an outside entry.
    addFlow(flows, outsideFlow(model, verb));
  }
  // Step 7.
  return [...flows.values()].sort(byCalleeThenCaller);
}

/** A network's display name: the declaring project's key, or the bound root's. */
function networkName(id: string): string {
  return id === '' ? '(root network)' : id;
}

/** One flow's justification, each step one line. */
function chainOf(flow: NetworkFlow): string[] {
  const lines = flow.evidence.map((e) => `${partyKey(flow.from)}: ${e}`);
  for (const network of flow.crosses) lines.push(`enters network ${networkName(network)}`);
  if (flow.via !== undefined) lines.push(`through gateway ${flow.via}`);
  lines.push(`reaches ${partyKey(flow.to)} over ${flow.transport}${flow.binding ? ` (${flow.binding})` : ''}`);
  return lines;
}

/** The answer when nothing allows the pair: what reaches the callee instead. */
function notAllowed(flows: NetworkFlow[], from: string, to: string): FlowExplanation {
  const nearest = flows.filter((f) => isNamed(f.to, to)).slice(0, 10);
  const chain = [`nothing in the design allows ${from} to reach ${to}`];
  if (nearest.length === 0) chain.push(`no flow reaches ${to} at all`);
  for (const f of nearest) chain.push(`allowed instead: ${partyKey(f.from)} -> ${partyKey(f.to)} over ${f.transport}`);
  return { allowed: false, flows: [], chain };
}

/**
 * iflow_matrix_projector.explain — why one party may reach another: the flows
 * from the first to the second, each with its chain. Pure.
 */
export function explain(flows: NetworkFlow[], from: string, to: string): FlowExplanation {
  // Steps 1-2: parse both parties and select the flows between them.
  const selected = flows.filter((f) => isNamed(f.from, from) && isNamed(f.to, to));
  // Steps 3-4: nothing allows it.
  if (selected.length === 0) return notAllowed(flows, from, to);
  // Step 5: each flow's chain.
  const chain = selected.flatMap((f, i) => [...(selected.length > 1 ? [`flow ${i + 1}:`] : []), ...chainOf(f)]);
  // Step 6.
  return { allowed: true, flows: selected, chain };
}
