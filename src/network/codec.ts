// ---------------------------------------------------------------------------
// network_codec — the flow matrix in its neutral formats (JSON, CSV,
// Markdown) and as generated policy (Kubernetes NetworkPolicy).
//
// A policy is one ingress NetworkPolicy per callee workload: a podSelector
// from the team's binding, and ingress admitting exactly its matrix sources
// (podSelector peers, a namespaceSelector when the source runs in another
// namespace, and the bindings' outside blocks for a flow from outside), with
// the port when the binding names one. Default deny is implied by the policy
// existing. Nothing is guessed: a name the bindings do not map gets the
// placeholder label wairon.dev/workload=<name> (which matches no pod until
// someone labels one) and is listed — in the document and at the head of the
// output — so nothing is silently opened.
//
// Pure and deterministic: the same flows and bindings give byte-identical
// output.
// ---------------------------------------------------------------------------

import { key as partyKey, workload } from './types.js';
import type { FlowParty, NetworkBindings, NetworkDocument, NetworkFlow, NetworkOutputFormat, WorkloadBinding } from './types.js';

const COLUMNS = ['from', 'to', 'transport', 'binding', 'crosses', 'via', 'evidence', 'gate'] as const;

/** Whether the gate refuses a flow: an error sits on it. */
function refusedFlow(flow: NetworkFlow): boolean {
  return (flow.refusedBy?.length ?? 0) > 0;
}

/** The code of a `CODE: message` line. */
function codeOf(line: string): string {
  const cut = line.indexOf(':');
  return cut === -1 ? line : line.slice(0, cut);
}

/** A flow's gate cell: REFUSED with the error codes, or the codes that mark it. */
function gateCell(flow: NetworkFlow): string {
  if (refusedFlow(flow)) return `REFUSED: ${[...new Set(flow.refusedBy!.map(codeOf))].join('; ')}`;
  return [...new Set([...(flow.flaggedBy ?? []), ...(flow.notedBy ?? [])].map(codeOf))].join('; ');
}

/** Step 1: the gate findings on the flows, each `CODE (severity): message` at its own severity, errors first. */
function gateFindingsOf(flows: NetworkFlow[]): string[] {
  const errors = new Set<string>();
  const flags = new Set<string>();
  const notes = new Set<string>();
  for (const f of flows) {
    for (const line of f.refusedBy ?? []) errors.add(line);
    for (const line of f.flaggedBy ?? []) flags.add(line);
    for (const line of f.notedBy ?? []) notes.add(line);
  }
  const withSeverity = (line: string, severity: string): string => `${codeOf(line)} (${severity})${line.slice(codeOf(line).length)}`;
  return [
    ...[...errors].map((l) => withSeverity(l, 'error')),
    ...[...flags].map((l) => withSeverity(l, 'warning')),
    ...[...notes].map((l) => withSeverity(l, 'notice')),
  ];
}

/** A flow with the root's empty project key and network id written as the root project's id, for JSON. */
function namedRoot(flow: NetworkFlow, rootProject: string): NetworkFlow {
  const party = (p: FlowParty): FlowParty => ({
    ...p,
    ...(p.project === '' ? { project: rootProject } : {}),
    ...(p.network === '' ? { network: rootProject } : {}),
  });
  return { ...flow, from: party(flow.from), to: party(flow.to), crosses: flow.crosses.map((n) => (n === '' ? rootProject : n)) };
}

/** A network's display name: the declaring project's key, or the bound root's. */
function networkName(id: string): string {
  return id === '' ? '(root network)' : id;
}

/** One flow as its seven text cells, lists joined with semicolons. */
function cells(flow: NetworkFlow): string[] {
  return [
    partyKey(flow.from),
    partyKey(flow.to),
    flow.transport,
    flow.binding ?? '',
    flow.crosses.map(networkName).join('; '),
    flow.via ?? '',
    flow.evidence.join('; '),
    gateCell(flow),
  ];
}

/** A value with every object's keys sorted, so JSON output is stable. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries.map(([k, v]) => [k, sortedKeys(v)]));
}

function csvOf(flows: NetworkFlow[]): string {
  const quote = (cell: string): string => `"${cell.replace(/"/g, '""')}"`;
  return [COLUMNS.map(quote), ...flows.map((f) => cells(f).map(quote))].map((row) => row.join(',')).join('\n') + '\n';
}

function markdownOf(flows: NetworkFlow[]): string {
  const escape = (cell: string): string => (cell === '' ? ' ' : cell.replace(/\|/g, '\\|').replace(/\n/g, ' '));
  const rows = flows.map((f) => `| ${cells(f).map(escape).join(' | ')} |`);
  const header = [`| ${COLUMNS.join(' | ')} |`, `|${COLUMNS.map(() => '---').join('|')}|`];
  // When the design fails the gate, say so first: a REFUSED row is not allowed.
  const refused = flows.filter(refusedFlow);
  const warning = refused.length > 0
    ? [`> **The design fails the gate:** ${refused.length} row(s) marked REFUSED are refused by \`wairon validate\`, not allowed. Fix the design before trusting this matrix.`, ...gateFindingsOf(flows).map((l) => `> - ${l.replace(/\n/g, ' ')}`), '']
    : [];
  return [...warning, ...header, ...rows].join('\n') + '\n' + (flows.length === 0 ? '\n_No network-transport flows: in-process and local verbs never produce one._\n' : '');
}

/**
 * inetwork_codec.encodeFlows — the matrix as JSON, CSV or Markdown: every fact
 * of every flow, in the matrix's order. Pure.
 */
export function encodeFlows(flows: NetworkFlow[], format: NetworkOutputFormat, rootProject?: string): NetworkDocument {
  // Step 1: the gate findings on the flows, and whether any flow is refused.
  const gate = { gateFindings: gateFindingsOf(flows), refused: flows.some(refusedFlow) };
  // Step 2: which format?
  switch (format) {
    case 'json':
      // Step 3.
      return { format, content: JSON.stringify(sortedKeys(rootProject ? flows.map((f) => namedRoot(f, rootProject)) : flows), null, 2) + '\n', unbound: [], ...gate };
    case 'csv':
      // Step 4.
      return { format, content: csvOf(flows), unbound: [], ...gate };
    default:
      // Step 5.
      return { format: 'markdown', content: markdownOf(flows), unbound: [], ...gate };
  }
}

// ---------------------------------------------------------------------------
// Kubernetes NetworkPolicy
// ---------------------------------------------------------------------------

/** A party resolved to its workload: the binding key that won (or the default name) and the binding. */
interface Resolved {
  name: string;
  binding?: WorkloadBinding;
}

/** The names a party could be bound by, most specific first. */
function bindingKeys(party: FlowParty): string[] {
  if (party.scope !== undefined) return [workload(party)];
  return [party.component, party.subsystem, party.project, workload(party)]
    .filter((k): k is string => k !== undefined && k !== '');
}

/** The most specific binding key a party has, or its default workload name, unbound. */
function resolve(party: FlowParty, bindings: NetworkBindings): Resolved {
  const keys = bindingKeys(party);
  const bound = keys.find((k) => Object.prototype.hasOwnProperty.call(bindings.workloads, k));
  return bound !== undefined ? { name: bound, binding: bindings.workloads[bound] } : { name: workload(party) };
}

/** A design name as a valid Kubernetes label value (63 characters of [A-Za-z0-9._-], alphanumeric at both ends). */
function labelValue(name: string): string {
  const cleaned = name.replace(/::/g, '.').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 63);
  return cleaned.replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9]+$/, '') || 'unnamed';
}

/** A design name as a valid object name (a DNS subdomain). */
function objectName(name: string): string {
  const cleaned = name.toLowerCase().replace(/::/g, '.').replace(/[^a-z0-9.-]/g, '-').replace(/-+/g, '-');
  return `wairon-allow-${cleaned.replace(/^[^a-z0-9]+/, '').replace(/[^a-z0-9]+$/, '') || 'unnamed'}`.slice(0, 253);
}

/** A resolved workload's pod selector: its binding's labels, or the placeholder label. */
function selectorOf(workloadName: Resolved): Record<string, string> {
  return workloadName.binding?.selector ?? { 'wairon.dev/workload': labelValue(workloadName.name) };
}

/** One ingress rule admitting one source, or null when the source cannot be expressed (outside with no blocks). */
function ingressRule(source: Resolved, outside: boolean, networkWide: boolean, callee: Resolved, bindings: NetworkBindings): Record<string, unknown> | null {
  const ports = callee.binding?.port !== undefined ? { ports: [{ protocol: 'TCP', port: callee.binding.port }] } : {};
  if (outside) {
    const blocks = bindings.outside ?? [];
    if (blocks.length === 0) return null;
    return { from: blocks.map((cidr) => ({ ipBlock: { cidr } })), ...ports };
  }
  const peer: Record<string, unknown> = { podSelector: { matchLabels: selectorOf(source) } };
  const ns = source.binding?.namespace;
  if (ns !== undefined && ns !== callee.binding?.namespace) {
    peer.namespaceSelector = { matchLabels: { 'kubernetes.io/metadata.name': ns } };
  } else if (ns === undefined && networkWide && source.binding) {
    // Anywhere inside a network spans namespaces: its pods match in any of them.
    peer.namespaceSelector = {};
  }
  return { from: [peer], ...ports };
}

/** One callee workload's sources: each resolved caller, outside first, then by name. */
function sourcesOf(flows: NetworkFlow[], bindings: NetworkBindings): { source: Resolved; outside: boolean; networkWide: boolean; evidence: string[] }[] {
  const byName = new Map<string, { source: Resolved; outside: boolean; networkWide: boolean; evidence: string[] }>();
  for (const flow of flows) {
    const outside = flow.from.scope === 'outside';
    const source = outside ? { name: 'outside' } : resolve(flow.from, bindings);
    const known = byName.get(source.name) ?? { source, outside, networkWide: flow.from.scope === 'network', evidence: [] };
    known.evidence.push(`${partyKey(flow.from)} -> ${partyKey(flow.to)}`);
    byName.set(source.name, known);
  }
  return [...byName.values()].sort((a, b) => Number(b.outside) - Number(a.outside) || a.source.name.localeCompare(b.source.name));
}

/** One NetworkPolicy object for a callee workload, recording what it could not bind. */
function policyFor(callee: Resolved, flows: NetworkFlow[], bindings: NetworkBindings, unbound: Set<string>): Record<string, unknown> {
  if (!callee.binding) unbound.add(callee.name);
  const ingress: Record<string, unknown>[] = [];
  for (const { source, outside, networkWide } of sourcesOf(flows, bindings)) {
    const rule = ingressRule(source, outside, networkWide, callee, bindings);
    if (rule === null) unbound.add('outside');
    else ingress.push(rule);
    if (!outside && !source.binding) unbound.add(source.name);
  }
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: objectName(callee.name),
      ...(callee.binding?.namespace !== undefined ? { namespace: callee.binding.namespace } : {}),
      labels: { 'app.kubernetes.io/managed-by': 'wairon' },
      annotations: { 'wairon.dev/design-name': callee.name },
    },
    spec: { podSelector: { matchLabels: selectorOf(callee) }, policyTypes: ['Ingress'], ingress },
  };
}

/** The head of the output: what it is, every flow the gate refused, and every name it could not bind. */
function headerOf(unbound: string[], brokered: NetworkFlow[], refused: NetworkFlow[]): string[] {
  const lines = [
    '# Generated by `wairon network policy` from the design\'s allowed-flows matrix. Regenerate; do not edit.',
    '# Default deny is implied: each policy selects its workload and admits only the sources listed.',
  ];
  if (refused.length > 0) {
    lines.push('# THE DESIGN FAILS THE GATE: the flows below are REFUSED BY THE GATE and NOT admitted by any policy here.');
    lines.push('#   Fix the design (`wairon validate`) before applying this file.');
    for (const f of refused) {
      lines.push(`# REFUSED: ${partyKey(f.from)} -> ${partyKey(f.to)}${f.binding ? ` (${f.binding})` : ''}`);
      for (const line of f.refusedBy ?? []) lines.push(`#   ${line.replace(/\n/g, ' ')}`);
    }
  }
  if (unbound.length > 0) {
    lines.push(`# UNBOUND: ${unbound.join(', ')}`);
    lines.push('#   Each has no entry in the bindings file. Its pods are selected by the placeholder label');
    lines.push('#   wairon.dev/workload=<name>, which matches nothing until a binding (or that label) exists;');
    lines.push('#   outside unbound means no `outside:` blocks, so nothing from outside is admitted.');
  }
  for (const f of brokered) lines.push(`# NOT EXPRESSED (MessageBus, reached through the broker): ${partyKey(f.from)} -> ${partyKey(f.to)}`);
  return lines;
}

/**
 * inetwork_codec.encodePolicy — the matrix as Kubernetes NetworkPolicy
 * documents, one ingress policy per callee workload. Deterministic. Pure.
 */
export function encodePolicy(flows: NetworkFlow[], bindings: NetworkBindings, format: NetworkOutputFormat, formerNames?: Record<string, string>): NetworkDocument {
  if (format !== 'kubernetes-network-policy') throw new Error(`"${format}" is not a policy target; the policy target is kubernetes-network-policy`);
  // Step 4's first half: a key naming a renamed project's former name still binds it, and says so.
  const notes: string[] = [];
  const bound = throughFormerNames(bindings, formerNames ?? {}, notes);
  // Step 1: a flow the gate refuses is never admitted — no outside block is opened for an illegal entry.
  const refused = flows.filter(refusedFlow);
  const admitted = flows.filter((f) => !refusedFlow(f));
  // Step 2: group by callee workload (pod ingress only: a MessageBus flow goes through its broker).
  const brokered = admitted.filter((f) => f.transport === 'MessageBus');
  const groups = new Map<string, { callee: Resolved; flows: NetworkFlow[] }>();
  for (const flow of admitted.filter((f) => f.transport !== 'MessageBus')) {
    const callee = resolve(flow.to, bound);
    const group = groups.get(callee.name) ?? { callee, flows: [] };
    group.flows.push(flow);
    groups.set(callee.name, group);
  }
  // Steps 3-5: one policy per callee workload, in name order, each party resolved.
  const unbound = new Set<string>();
  const documents = [...groups.keys()].sort().map((name) => {
    const group = groups.get(name)!;
    const mixed = mixedReach(group.callee.name, group.flows, bound);
    if (mixed !== null) notes.push(mixed);
    return yamlOf(policyFor(group.callee, group.flows, bound, unbound));
  });
  // Step 6: the documents, headed by what was refused, what could not be bound, and the notes.
  const names = [...unbound].sort();
  const content = [...headerOf(names, brokered, refused), ...notes.map((n) => `# NOTE: ${n}`), ...documents.map((d) => `---\n${d}`)].join('\n') + '\n';
  return { format, content, unbound: names, gateFindings: gateFindingsOf(flows), refused: refused.length > 0, ...(notes.length > 0 ? { notes } : {}) };
}

/**
 * The bindings with every key that names a renamed project by its former name
 * (`<former>` or `<former>::…`) also keyed by the current name, when that has
 * no binding of its own; each such key adds a note naming the key to rename.
 */
function throughFormerNames(bindings: NetworkBindings, formerNames: Record<string, string>, notes: string[]): NetworkBindings {
  const workloads = { ...bindings.workloads };
  for (const key of Object.keys(bindings.workloads).sort()) {
    for (const [former, current] of Object.entries(formerNames)) {
      if (key !== former && !key.startsWith(`${former}::`)) continue;
      const renamed = `${current}${key.slice(former.length)}`;
      if (Object.prototype.hasOwnProperty.call(workloads, renamed)) continue;
      workloads[renamed] = bindings.workloads[key];
      notes.push(`bindings key "${key}" names the renamed project "${current}" by its former name (kept in its previousIds): it still binds "${renamed}" — rename the key to "${renamed}".`);
    }
  }
  return { ...bindings, workloads };
}

/**
 * A workload serving a verb entered from outside beside one outside may not
 * reach, said as a note: a NetworkPolicy admits per pod and port, so outside
 * reaches every verb on that port. Names the Portal-level binding that splits
 * it, or, for verbs of one Portal, that only an L7 policy can. Null when every
 * verb is entered from outside, or none is.
 */
function mixedReach(callee: string, flows: NetworkFlow[], bindings: NetworkBindings): string | null {
  const sourcesOfVerb = new Map<string, Set<string>>();
  const portalOf = new Map<string, string>();
  for (const flow of flows) {
    const verb = partyKey(flow.to);
    const source = flow.from.scope === 'outside' ? 'outside' : resolve(flow.from, bindings).name;
    sourcesOfVerb.set(verb, (sourcesOfVerb.get(verb) ?? new Set()).add(source));
    portalOf.set(verb, flow.to.component ?? '');
  }
  const signature = (verb: string): string => [...sourcesOfVerb.get(verb)!].sort().join(', ');
  // Only an outside-entered verb beside one outside may not reach is a gap a reader must act on.
  const fromOutside = [...sourcesOfVerb.values()].map((s) => s.has('outside'));
  if (!fromOutside.includes(true) || !fromOutside.includes(false)) return null;
  const verbs = [...sourcesOfVerb.keys()].sort().map((v) => `${v} (from ${signature(v)})`);
  const portals = [...new Set(portalOf.values())].sort();
  const outsidePortal = [...sourcesOfVerb.keys()].sort().find((v) => sourcesOfVerb.get(v)!.has('outside'));
  const toSplit = outsidePortal !== undefined ? portalOf.get(outsidePortal)! : portals[0];
  const split = portals.length > 1
    ? `bind a Portal on its own in the bindings file (workloads: { ${toSplit}: { selector, port } }, on its own port) so it gets a policy of its own`
    : `these verbs share one Portal, so only an L7 policy (a mesh or gateway route rule) can separate them`;
  return `workload "${callee}" serves verbs that differ in who may reach them — ${verbs.join('; ')} — but a NetworkPolicy admits per pod and port, so every source above reaches every verb on that port: ${split}.`;
}

// ---------------------------------------------------------------------------
// A minimal, deterministic YAML writer: block maps and sequences, every string
// double-quoted (a JSON string is a valid YAML double-quoted scalar).
// ---------------------------------------------------------------------------

function scalar(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function keyOf(k: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(k) ? k : JSON.stringify(k);
}

function isBlock(value: unknown): boolean {
  return value !== null && typeof value === 'object' && (Array.isArray(value) ? value.length > 0 : Object.keys(value).length > 0);
}

function emptyOf(value: unknown): string {
  return Array.isArray(value) ? '[]' : '{}';
}

function yamlLines(value: unknown, indent: string): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (!isBlock(item)) return [`${indent}- ${typeof item === 'object' && item !== null ? emptyOf(item) : scalar(item)}`];
      const [first, ...rest] = yamlLines(item, `${indent}  `);
      return [`${indent}- ${first.slice(indent.length + 2)}`, ...rest];
    });
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    if (isBlock(v)) return [`${indent}${keyOf(k)}:`, ...yamlLines(v, Array.isArray(v) ? indent : `${indent}  `)];
    return [`${indent}${keyOf(k)}: ${typeof v === 'object' && v !== null ? emptyOf(v) : scalar(v)}`];
  });
}

function yamlOf(value: Record<string, unknown>): string {
  return yamlLines(value, '').join('\n');
}
