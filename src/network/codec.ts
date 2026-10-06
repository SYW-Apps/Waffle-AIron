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

const COLUMNS = ['from', 'to', 'transport', 'binding', 'crosses', 'via', 'evidence'] as const;

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
  return [...header, ...rows].join('\n') + '\n' + (flows.length === 0 ? '\n_No network-transport flows: in-process and local verbs never produce one._\n' : '');
}

/**
 * inetwork_codec.encodeFlows — the matrix as JSON, CSV or Markdown: every fact
 * of every flow, in the matrix's order. Pure.
 */
export function encodeFlows(flows: NetworkFlow[], format: NetworkOutputFormat): NetworkDocument {
  // Step 1: which format?
  switch (format) {
    case 'json':
      // Step 2.
      return { format, content: JSON.stringify(sortedKeys(flows), null, 2) + '\n', unbound: [] };
    case 'csv':
      // Step 3.
      return { format, content: csvOf(flows), unbound: [] };
    default:
      // Step 4.
      return { format: 'markdown', content: markdownOf(flows), unbound: [] };
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

/** The head of the output: what it is, and every name it could not bind. */
function headerOf(unbound: string[], brokered: NetworkFlow[]): string[] {
  const lines = [
    '# Generated by `wairon network policy` from the design\'s allowed-flows matrix. Regenerate; do not edit.',
    '# Default deny is implied: each policy selects its workload and admits only the sources listed.',
  ];
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
export function encodePolicy(flows: NetworkFlow[], bindings: NetworkBindings, format: NetworkOutputFormat): NetworkDocument {
  if (format !== 'kubernetes-network-policy') throw new Error(`"${format}" is not a policy target; the policy target is kubernetes-network-policy`);
  // Step 1: group by callee workload (pod ingress only: a MessageBus flow goes through its broker).
  const brokered = flows.filter((f) => f.transport === 'MessageBus');
  const groups = new Map<string, { callee: Resolved; flows: NetworkFlow[] }>();
  for (const flow of flows.filter((f) => f.transport !== 'MessageBus')) {
    const callee = resolve(flow.to, bindings);
    const group = groups.get(callee.name) ?? { callee, flows: [] };
    group.flows.push(flow);
    groups.set(callee.name, group);
  }
  // Steps 2-4: one policy per callee workload, in name order, each party resolved.
  const unbound = new Set<string>();
  const documents = [...groups.keys()].sort().map((name) => {
    const group = groups.get(name)!;
    return yamlOf(policyFor(group.callee, group.flows, bindings, unbound));
  });
  // Step 5: the documents, headed by what could not be bound.
  const names = [...unbound].sort();
  const content = [...headerOf(names, brokered), ...documents.map((d) => `---\n${d}`)].join('\n') + '\n';
  return { format, content, unbound: names };
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
