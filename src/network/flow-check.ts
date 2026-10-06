// ---------------------------------------------------------------------------
// flow_check_arbiter — observed live flows compared with the allowed matrix,
// and nothing else decided. It reports:
//
// - unexpected flows: seen, but no flow allows them;
// - unexercised flows: allowed, but not seen in the window;
// - unknown verbs: seen at L7 on an allowed pair, but matching no verb of
//   the called Portal by method and path.
//
// Observed parties are matched to flows through the same bindings the policy
// was generated from. Pure.
// ---------------------------------------------------------------------------

import { isNamed } from './types.js';
import type { FlowCheckReport, FlowParty, NetworkBindings, NetworkFlow, ObservedFlow, WorkloadBinding } from './types.js';

/**
 * An observed name in design terms: a binding key as written, else every
 * binding whose selector carries it as a label value (what a mesh export
 * usually names a workload by; several design names may run as one
 * workload), else as written. Outside stays outside.
 */
function designNames(name: string, bindings: NetworkBindings | null): string[] {
  if (name === 'outside' || bindings === null) return [name];
  if (Object.prototype.hasOwnProperty.call(bindings.workloads, name)) return [name];
  const carries = (b: WorkloadBinding): boolean => Object.values(b.selector).some((v) => v === name || (b.namespace !== undefined && `${b.namespace}/${v}` === name));
  const matches = Object.entries(bindings.workloads).filter(([, b]) => carries(b)).map(([k]) => k);
  return matches.length > 0 ? matches : [name];
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

/** Whether an L7 observation (method and path) matches a flow's binding. */
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

/**
 * iflow_check_arbiter.check — observed flows against the matrix: unexpected,
 * unexercised and unknown verbs. Pure.
 */
export function check(flows: NetworkFlow[], observed: ObservedFlow[], bindings: NetworkBindings | null): FlowCheckReport {
  // Step 1: each observed party in design terms.
  const named = observed.map((o) => ({ o, sources: designNames(o.source, bindings), destinations: designNames(o.destination, bindings) }));
  const report: FlowCheckReport = { unexpected: [], unexercised: [], unknownVerbs: [] };
  const exercised = new Set<NetworkFlow>();
  // Step 2: each observed flow.
  for (const { o, sources, destinations } of named) {
    const onPair = flows.filter((f) => sources.some((s) => sourceWithin(f.from, s)) && destinations.some((d) => isNamed(f.to, d)));
    // Steps 3-4: no flow on the pair — unexpected; go on.
    if (onPair.length === 0) {
      report.unexpected.push(o);
      continue;
    }
    // Step 5: at L7 the verb must match; mark every matching flow exercised.
    const atL7 = o.method !== undefined && o.path !== undefined;
    const matching = atL7 ? onPair.filter((f) => bindingMatches(f.binding, o.method!, o.path!)) : onPair;
    if (atL7 && matching.length === 0) report.unknownVerbs.push(o);
    for (const f of matching) exercised.add(f);
  }
  // Step 6: every flow never seen.
  report.unexercised = flows.filter((f) => !exercised.has(f));
  // Step 7.
  return report;
}
