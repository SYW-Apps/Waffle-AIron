// ---------------------------------------------------------------------------
// flow_check_arbiter — observed live flows compared with the allowed matrix
// and the gate's verdict on it, and nothing else decided. It reports:
//
// - unexpected flows: seen, but no flow allows the pair;
// - disallowed flows: seen on a verb the destination declares (its method and
//   path match one), but no admitted flow allows it from this source — a
//   boundary violation, not a typo in the export;
// - unexercised flows: allowed, but not seen in the window;
// - unknown verbs: seen at L7 on an allowed pair, but matching no verb the
//   destination declares.
//
// A flow the gate refuses (an error sits on it) allows nothing. Observed
// parties are matched to flows through the same bindings the policy was
// generated from. Pure.
// ---------------------------------------------------------------------------

import { transportKind } from '../models/specs.js';
import type { ReachModel } from '../models/reach.js';
import { isNamed } from './types.js';
import type { FlowCheckReport, FlowParty, NetworkBindings, NetworkFlow, ObservedFlow, WorkloadBinding } from './types.js';

/**
 * An observed name in design terms: a binding key as written, else every
 * binding whose selector carries it as a label value (what a mesh export
 * usually names a workload by; several design names may run as one
 * workload), else as written. Outside stays outside.
 */
function designNames(name: string, bindings: NetworkBindings | null, formerNames: Record<string, string>, notes: Set<string>): string[] {
  if (name === 'outside') return [name];
  let names = [name];
  if (bindings !== null && !Object.prototype.hasOwnProperty.call(bindings.workloads, name)) {
    const carries = (b: WorkloadBinding): boolean => Object.values(b.selector).some((v) => v === name || (b.namespace !== undefined && `${b.namespace}/${v}` === name));
    const matches = Object.entries(bindings.workloads).filter(([, b]) => carries(b)).map(([k]) => k);
    if (matches.length > 0) names = matches;
  }
  return names.map((n) => currentName(n, formerNames, notes));
}

/** A design name written as a renamed project's former name (`<former>` or `<former>::…`), read as its current one, noted. */
function currentName(name: string, formerNames: Record<string, string>, notes: Set<string>): string {
  for (const [former, current] of Object.entries(formerNames)) {
    if (name !== former && !name.startsWith(`${former}::`)) continue;
    const renamed = `${current}${name.slice(former.length)}`;
    notes.add(`"${name}" names the renamed project "${current}" by its former name (kept in its previousIds): it was matched as "${renamed}" — rename it in the bindings file or the observed-flow export.`);
    return renamed;
  }
  return name;
}

/** Whether an observed source lies within a flow's caller: a network-wide caller admits any source inside. */
function sourceWithin(party: FlowParty, source: string): boolean {
  if (party.scope === 'network' && source !== 'outside') return true;
  return isNamed(party, source);
}

/** A path segment of a binding: a {template} or :param matches any value. */
function segmentMatches(pattern: string, actual: string): boolean {
  return /^\{[^}]*\}$/.test(pattern) || pattern.startsWith(':') || pattern === actual;
}

/** Whether an L7 observation (method and path) matches a binding. */
function bindingMatches(binding: string | undefined, method: string, path: string): boolean {
  if (binding === undefined) return false;
  const bare = path.replace(/\?.*$/, '');
  // gRPC: the binding is service/method, the observed path /service/method.
  if (binding === bare.replace(/^\//, '')) return true;
  const [bMethod, bPath] = binding.split(' ', 2);
  if (bPath === undefined || bMethod.toUpperCase() !== method.toUpperCase()) return false;
  const want = bPath.split('/').filter(Boolean);
  const got = bare.split('/').filter(Boolean);
  return want.length === got.length && want.every((seg, i) => segmentMatches(seg, got[i]));
}

/** Whether a verb the destination declares (any network-transport verb of the model within it) matches an L7 observation. */
function declaredVerbMatches(model: ReachModel, destinations: string[], method: string, path: string): boolean {
  return model.verbs.some((v) => transportKind(v.transport) === 'network'
    && destinations.some((d) => isNamed({ project: v.project, ...(v.subsystem !== undefined ? { subsystem: v.subsystem } : {}), component: v.portal, verb: v.verb }, d))
    && bindingMatches(v.binding, method, path));
}

/** Whether the gate refuses a flow: an error sits on it, so it allows nothing. */
function isRefused(flow: NetworkFlow): boolean {
  return (flow.refusedBy?.length ?? 0) > 0;
}

/** The model's findings as report lines. */
function gateLines(model: ReachModel): string[] {
  return (model.findings ?? []).map((f) => `${f.code} (${f.severity}): ${f.message}`);
}

/**
 * iflow_check_arbiter.check — observed flows against the matrix and the
 * gate's verdict: unexpected, disallowed, unexercised and unknown verbs. Pure.
 */
export function check(flows: NetworkFlow[], observed: ObservedFlow[], bindings: NetworkBindings | null, model: ReachModel): FlowCheckReport {
  // Step 1: each observed party in design terms.
  const former = model.formerNames ?? {};
  const notes = new Set<string>();
  const named = observed.map((o) => ({ o, sources: designNames(o.source, bindings, former, notes), destinations: designNames(o.destination, bindings, former, notes) }));
  const report: FlowCheckReport = { unexpected: [], unexercised: [], unknownVerbs: [], disallowed: [], gateFindings: gateLines(model) };
  const exercised = new Set<NetworkFlow>();
  // Step 2: each observed flow.
  for (const { o, sources, destinations } of named) {
    // Step 3: the flows on its pair; the gate's refused ones allow nothing.
    const onPair = flows.filter((f) => sources.some((s) => sourceWithin(f.from, s)) && destinations.some((d) => isNamed(f.to, d)));
    const admitted = onPair.filter((f) => !isRefused(f));
    const atL7 = o.method !== undefined && o.path !== undefined;
    const declared = atL7 && declaredVerbMatches(model, destinations, o.method!, o.path!);
    // Steps 4-6: no admitted flow — disallowed when a declared verb (or a refused flow) is on it, else unexpected.
    if (admitted.length === 0) {
      if (declared || onPair.length > 0) report.disallowed.push(o);
      else report.unexpected.push(o);
      continue;
    }
    // Step 7: at L7 the verb must match an admitted flow.
    const matching = atL7 ? admitted.filter((f) => bindingMatches(f.binding, o.method!, o.path!)) : admitted;
    if (atL7 && matching.length === 0) {
      if (declared) report.disallowed.push(o);
      else report.unknownVerbs.push(o);
    }
    // Step 8: every matching admitted flow exercised.
    for (const f of matching) exercised.add(f);
  }
  // Step 9: every admitted flow never seen.
  report.unexercised = flows.filter((f) => !isRefused(f) && !exercised.has(f));
  if (notes.size > 0) report.notes = [...notes];
  // Step 10.
  return report;
}
