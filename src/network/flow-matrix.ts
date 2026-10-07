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
// - Each flow carries the gate's findings that sit on it: an error refuses
//   it (refusedBy), a warning or notice flags it (flaggedBy). A refused flow
//   is never allowed — not by why, not by check, not by a policy.
//
// Pure: over the model it is handed, it reads nothing and writes nothing.
// ---------------------------------------------------------------------------

import { transportKind } from '../models/specs.js';
import { callersOf, enclosing } from '../models/reach.js';
import type { ModelledCall, ReachFinding, ReachModel, VerbReach } from '../models/reach.js';
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

/** A finding as one line: `CODE: message`. */
function findingLine(f: ReachFinding): string {
  return `${f.code}: ${f.message}`;
}

/**
 * Step 7: mark the flows one finding sits on. A finding sited at a verb (its
 * Portal and the verb) sits on that verb's entry flows; one sited at a call
 * (its calling component and the call's evidence) on the flow that evidence
 * gives. An error refuses them; a warning or notice flags them.
 */
function markFlows(flows: NetworkFlow[], f: ReachFinding): void {
  if (f.specId === undefined) return;
  const onVerb = (flow: NetworkFlow): boolean =>
    flow.from.scope !== undefined && flow.to.component === f.specId
    && (f.at !== undefined ? flow.to.verb === f.at : f.covers === undefined || f.covers.includes(flow.to.verb ?? ''));
  const onCall = (flow: NetworkFlow): boolean =>
    flow.from.scope === undefined && flow.from.component === f.specId && f.at !== undefined && flow.evidence.includes(`call ${f.at}`);
  for (const flow of flows.filter((x) => onVerb(x) || onCall(x))) {
    const field = f.severity === 'error' ? 'refusedBy' : f.severity === 'notice' ? 'notedBy' : 'flaggedBy';
    const list = flow[field] ?? [];
    if (!list.includes(findingLine(f))) list.push(findingLine(f));
    flow[field] = list;
  }
}

/** Whether the gate refuses a flow: an error sits on it. */
function isRefused(flow: NetworkFlow): boolean {
  return (flow.refusedBy?.length ?? 0) > 0;
}

/**
 * iflow_matrix_projector.project — the allowed-flows matrix of a reach model,
 * in a stable order, each flow marked with the gate's findings that sit on
 * it. Pure.
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
  // Step 7: each flow marked with the findings that sit on it.
  const marked = [...flows.values()];
  for (const f of model.findings ?? []) markFlows(marked, f);
  // Step 8: at a member's root, only the flows that start or land inside it.
  const focus = model.focus;
  const inside = (party: FlowParty): boolean =>
    focus !== undefined && party.project !== undefined && (party.project === focus || party.project.startsWith(`${focus}::`));
  const kept = focus === undefined ? marked : marked.filter((f) => inside(f.from) || inside(f.to));
  return kept.sort(byCalleeThenCaller);
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
  for (const flag of [...(flow.flaggedBy ?? []), ...(flow.notedBy ?? [])]) lines.push(`marked by the gate: ${flag}`);
  return lines;
}

/** A verb as the called party of a flow. */
function verbParty(v: VerbReach): FlowParty {
  return { project: v.project, ...(v.subsystem !== undefined ? { subsystem: v.subsystem } : {}), component: v.portal, verb: v.verb };
}

/** Whether any network-transport verb of the model lies within a callee name. */
function reachesOverNetwork(model: ReachModel, to: string): boolean {
  return model.verbs.some((v) => transportKind(v.transport) === 'network' && isNamed(verbParty(v), to));
}

/** The external alias a name is written through (`<alias>::<name>`), when it is one of the model's externals. */
function throughExternal(model: ReachModel, name: string): string | undefined {
  const at = name.indexOf('::');
  const alias = at > 0 ? name.slice(0, at) : name;
  return (model.externals ?? []).includes(alias) ? alias : undefined;
}

/** Whether a name denotes anything in the model: outside, a network, a placement's project, subsystem or component, a subsystem (types only too), an external's party, or a verb. */
function isKnown(model: ReachModel, name: string): boolean {
  if (name === 'outside' || name === 'network') return true;
  // A subsystem (one holding only types too), or a member project holding only such subsystems.
  if ((model.subsystems ?? []).some((s) => s === name || s.startsWith(`${name}::`)) || throughExternal(model, name) !== undefined) return true;
  if (name.startsWith('network:')) return model.networks.some((n) => n.id === name.slice('network:'.length));
  const placed = (model.placements ?? []).some((p) =>
    isNamed({ project: p.project, ...(p.subsystem !== undefined ? { subsystem: p.subsystem } : {}), component: p.component }, name));
  return placed || model.verbs.some((v) => isNamed(verbParty(v), name)) || model.calls.some((c) => isNamed(callerOf(c), name));
}

/** The answer when nothing admitted allows the pair: refused, in-process, or what reaches the callee instead. */
function notAllowed(model: ReachModel, flows: NetworkFlow[], refused: NetworkFlow[], from: string, to: string): FlowExplanation {
  // The design names the flow, and the gate refuses it.
  if (refused.length > 0) {
    const refusedBy = [...new Set(refused.flatMap((f) => f.refusedBy ?? []))];
    const chain = [`the design names ${refused.length === 1 ? 'a flow' : `${refused.length} flows`} from ${from} to ${to}, but the gate refuses ${refused.length === 1 ? 'it' : 'them'}: nothing admits it until the design passes \`wairon validate\``];
    for (const f of refused) chain.push(`refused: ${partyKey(f.from)} -> ${partyKey(f.to)} over ${f.transport}${f.binding ? ` (${f.binding})` : ''}`);
    for (const line of refusedBy) chain.push(`  ${line}`);
    return { allowed: false, flows: [], chain, refusedBy };
  }
  // A callee that takes no network flow at all is reached in-process.
  if (!reachesOverNetwork(model, to)) {
    const alias = throughExternal(model, to);
    if (alias !== undefined) {
      return {
        allowed: false,
        flows: [],
        inProcess: true,
        chain: [
          `${to} is consumed through the external "${alias}": this design's network model holds no verb of it, so it neither allows nor forbids a network flow to it here`,
          `a library is reached in-process; a network producer's flows are derived and judged in its own project (\`wairon network flows\` there)`,
        ],
      };
    }
    return {
      allowed: false,
      flows: [],
      inProcess: true,
      chain: [
        `${to} takes no network flow: it is reached in-process (a direct call, or a local transport, inside one process), so the design neither allows nor forbids a network flow to it`,
        'network flows are made only by verbs of Portals with a network transport (HTTP, gRPC, GraphQL, MessageBus, Custom)',
      ],
    };
  }
  const nearest = flows.filter((f) => isNamed(f.to, to) && !isRefused(f)).slice(0, 10);
  const chain = [`nothing in the design allows ${from} to reach ${to}`];
  if (nearest.length === 0) chain.push(`no flow reaches ${to} at all`);
  for (const f of nearest) chain.push(`allowed instead: ${partyKey(f.from)} -> ${partyKey(f.to)} over ${f.transport}`);
  return { allowed: false, flows: [], chain };
}

/**
 * iflow_matrix_projector.explain — why one party may reach another: the flows
 * from the first to the second, each with its chain; or why not, said as what
 * it is (an unknown party, a refused flow, an in-process collaborator, or
 * nothing). Pure.
 */
export function explain(flows: NetworkFlow[], from: string, to: string, model: ReachModel): FlowExplanation {
  // Steps 1-3: parse both parties; a name the model does not know is a typo, not a refusal.
  const unknown = [from, to].filter((n) => !isKnown(model, n));
  if (unknown.length > 0) {
    return {
      allowed: false,
      flows: [],
      unknown,
      chain: [
        ...unknown.map((n) => `unknown party "${n}": nothing in the design is named so`),
        'name a party as outside, network[:<id>], a project, a subsystem or a component, and a callee also as portal.verb; a subsystem of this project is named bare (a project is reached as <alias>::<name>)',
      ],
    };
  }
  // Step 4: the flows between them.
  const selected = flows.filter((f) => isNamed(f.from, from) && isNamed(f.to, to));
  // Step 5: a flow the gate refuses allows nothing.
  const admitted = selected.filter((f) => !isRefused(f));
  // Steps 6-7: nothing admitted allows it.
  if (admitted.length === 0) return notAllowed(model, flows, selected.filter(isRefused), from, to);
  // Step 8: each flow's chain.
  const chain = admitted.flatMap((f, i) => [...(admitted.length > 1 ? [`flow ${i + 1}:`] : []), ...chainOf(f)]);
  // Step 9.
  return { allowed: true, flows: admitted, chain };
}
