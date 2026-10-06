// ---------------------------------------------------------------------------
// network_diagram_projector — the network picture: declared networks as
// nested boundaries, the gateways on them, an outside node, and the flows
// aggregated per workload pair with their transport and verb count. Answered
// as the view model the hosted canvas's network view draws, and as Mermaid.
// A data-flow diagram with trust boundaries: each boundary an edge crosses is
// a place to ask the STRIDE questions. Pure.
// ---------------------------------------------------------------------------

import type { NetworkBoundary, ReachModel } from '../models/reach.js';
import { key as partyKey, workload } from './types.js';
import type { FlowParty, NetworkDocument, NetworkFlow, NetworkViewModel } from './types.js';

/** Whether a party is a gateway Portal of the network it sits in. */
function isGateway(party: FlowParty, networks: NetworkBoundary[]): boolean {
  return party.component !== undefined && networks.some((n) => n.id === party.network && n.gateways.includes(party.component!));
}

/** A party lifted to its workload: a gateway stays its own node, anything else becomes its default workload. */
function workloadParty(party: FlowParty, networks: NetworkBoundary[]): FlowParty {
  const net = party.network !== undefined ? { network: party.network } : {};
  if (party.scope !== undefined) return { scope: party.scope, ...net };
  if (isGateway(party, networks)) {
    return { project: party.project, ...(party.subsystem !== undefined ? { subsystem: party.subsystem } : {}), component: party.component, ...net };
  }
  if (party.project) return { project: party.project, ...net };
  return { project: '', ...(party.subsystem !== undefined ? { subsystem: party.subsystem } : { component: party.component }), ...net };
}

/** A workload party's node key. */
function nodeKey(party: FlowParty, networks: NetworkBoundary[]): string {
  return isGateway(party, networks) ? partyKey(party) : workload(party);
}

/** One aggregated edge, merged from one flow. */
function mergeInto(edges: Map<string, NetworkFlow>, from: FlowParty, to: FlowParty, flow: NetworkFlow, networks: NetworkBoundary[]): void {
  const id = `${nodeKey(from, networks)}\u0000${nodeKey(to, networks)}\u0000${flow.transport}`;
  const edge = edges.get(id) ?? { from, to, transport: flow.transport, crosses: [...flow.crosses], evidence: [], verbs: [] };
  if (edge.via === undefined && flow.via !== undefined) edge.via = flow.via;
  for (const n of flow.crosses) if (!edge.crosses.includes(n)) edge.crosses.push(n);
  for (const e of flow.evidence) if (!edge.evidence.includes(e)) edge.evidence.push(e);
  const verb = `${partyKey(flow.to)}${flow.binding ? ` (${flow.binding})` : ''}`;
  if (!edge.verbs!.includes(verb)) edge.verbs!.push(verb);
  edges.set(id, edge);
}

/**
 * inetwork_diagram_projector.view — the view model the canvas's network view
 * draws. Pure.
 */
export function view(model: ReachModel, flows: NetworkFlow[]): NetworkViewModel {
  // Step 1: the networks, outermost first, gateways marked.
  const networks = model.networks;
  // Step 2: the workloads that send or receive a flow, each in its network, outside among them.
  const workloads = new Map<string, FlowParty>();
  // Step 3: the flows aggregated per caller workload, callee workload and transport.
  const edges = new Map<string, NetworkFlow>();
  for (const flow of flows) {
    const from = workloadParty(flow.from, networks);
    const to = workloadParty(flow.to, networks);
    workloads.set(nodeKey(from, networks), from);
    workloads.set(nodeKey(to, networks), to);
    mergeInto(edges, from, to, flow, networks);
  }
  for (const edge of edges.values()) edge.verbs!.sort();
  // Step 4.
  const byKey = (a: FlowParty, b: FlowParty): number => nodeKey(a, networks).localeCompare(nodeKey(b, networks));
  return {
    networks,
    workloads: [...workloads.values()].sort(byKey),
    edges: [...edges.values()].sort((a, b) => byKey(a.from, b.from) || byKey(a.to, b.to) || a.transport.localeCompare(b.transport)),
  };
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/** Text safe inside a Mermaid double-quoted label. */
function label(text: string): string {
  return `"${text.replace(/"/g, '#quot;')}"`;
}

/** A network's caption: its name, and its description when it has one. */
function caption(network: NetworkBoundary): string {
  const name = network.id === '' ? 'root network' : `network ${network.id}`;
  return network.description ? `${name}: ${network.description}` : name;
}

/** One workload's node line, shaped by its kind: outside a stadium, a gateway a hexagon, a workload a box. */
function nodeLine(id: string, party: FlowParty, gateway: boolean, indent: string): string {
  if (party.scope === 'outside') return `${indent}${id}([${label('outside')}])`;
  if (party.scope === 'network') return `${indent}${id}([${label(`anywhere in the ${party.network ? `${party.network} network` : 'network'}`)}])`;
  if (gateway) return `${indent}${id}{{${label(`gateway ${partyKey(party)}`)}}}`;
  return `${indent}${id}[${label(workload(party))}]`;
}

/** One network's subgraph: its gateways first, its workloads, then its child networks. */
function subgraphLines(network: NetworkBoundary, vm: NetworkViewModel, ids: Map<FlowParty, string>, netIds: Map<string, string>, indent: string): string[] {
  const lines = [`${indent}subgraph ${netIds.get(network.id)}[${label(caption(network))}]`];
  const inside = vm.workloads.filter((w) => w.network === network.id && w.scope !== 'outside');
  const gateways = inside.filter((w) => isGateway(w, vm.networks));
  for (const w of [...gateways, ...inside.filter((x) => !gateways.includes(x))]) {
    lines.push(nodeLine(ids.get(w)!, w, gateways.includes(w), `${indent}  `));
  }
  for (const child of vm.networks.filter((n) => n.parent === network.id)) {
    lines.push(...subgraphLines(child, vm, ids, netIds, `${indent}  `));
  }
  lines.push(`${indent}end`);
  return lines;
}

/** An aggregated edge's label: its transport and how many verbs it carries. */
function edgeLabel(edge: NetworkFlow): string {
  const count = edge.verbs?.length ?? 1;
  return `${edge.transport}, ${count} verb${count === 1 ? '' : 's'}`;
}

/**
 * inetwork_diagram_projector.mermaid — the same picture as a Mermaid
 * flowchart. Pure.
 */
export function mermaid(view: NetworkViewModel): NetworkDocument {
  const ids = new Map<FlowParty, string>(view.workloads.map((w, i) => [w, `w${i}`]));
  const netIds = new Map<string, string>(view.networks.map((n, i) => [n.id, `net${i}`]));
  const idOf = (party: FlowParty): string => ids.get(view.workloads.find((w) => nodeKey(w, view.networks) === nodeKey(party, view.networks))!)!;
  // Step 1: the networks as nested subgraphs, gateways first.
  const lines = ['flowchart LR'];
  for (const root of view.networks.filter((n) => n.parent === undefined)) lines.push(...subgraphLines(root, view, ids, netIds, '  '));
  // Step 2: outside, and the workloads no network encloses.
  for (const w of view.workloads.filter((x) => x.scope === 'outside' || x.network === undefined || !netIds.has(x.network))) {
    lines.push(nodeLine(ids.get(w)!, w, false, '  '));
  }
  // Step 3: each aggregated edge, in the view's stable order.
  for (const edge of view.edges) lines.push(`  ${idOf(edge.from)} -->|${label(edgeLabel(edge))}| ${idOf(edge.to)}`);
  // Step 4.
  return { format: 'mermaid', content: lines.join('\n') + '\n', unbound: [] };
}
