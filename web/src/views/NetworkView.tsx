import { get } from '../api';
import { AsyncView, Badge, EmptyState, useAsync } from '../ui';

/** One end of a flow, as the network view model names it. */
export interface FlowParty {
  project?: string;
  subsystem?: string;
  component?: string;
  verb?: string;
  scope?: 'outside' | 'network';
  network?: string;
}

/** One aggregated edge of the network view. */
export interface NetworkFlow {
  from: FlowParty;
  to: FlowParty;
  transport: string;
  binding?: string;
  crosses: string[];
  via?: string;
  evidence: string[];
  verbs?: string[];
}

/** One declared network: its declaring project's key ('' for the bound root), its parent and gateways. */
export interface NetworkBoundary {
  id: string;
  parent?: string;
  description?: string;
  gateways: string[];
}

/** GET /web/projects/network — what the network view draws. */
export interface NetworkViewModel {
  networks: NetworkBoundary[];
  workloads: FlowParty[];
  edges: NetworkFlow[];
}

/** A party's workload name, the way the server's flow_party.workload names it. */
function workloadName(p: FlowParty): string {
  if (p.scope === 'outside') return 'outside';
  if (p.scope === 'network') return p.network ? `network:${p.network}` : 'network';
  return p.project || p.subsystem || p.component || '';
}

function isGateway(p: FlowParty, networks: NetworkBoundary[]): boolean {
  return !!p.component && networks.some((n) => n.id === p.network && n.gateways.includes(p.component!));
}

/** A party's display name: a gateway by its Portal, anything else by its workload. */
function nameOf(p: FlowParty, networks: NetworkBoundary[]): string {
  return isGateway(p, networks) ? p.component! : workloadName(p);
}

function networkCaption(n: NetworkBoundary): string {
  return n.id === '' ? 'root network' : `network ${n.id}`;
}

function WorkloadChip({ party, networks }: { party: FlowParty; networks: NetworkBoundary[] }) {
  const gateway = isGateway(party, networks);
  return (
    <span className={`net-chip${gateway ? ' net-gateway' : ''}${party.scope ? ' net-scope' : ''}`} title={gateway ? 'Gateway: the only Portal callers from outside this network may enter' : undefined}>
      {gateway ? '⬡ ' : ''}
      {nameOf(party, networks)}
    </span>
  );
}

/** One declared network as a boundary: its gateways on the edge, its workloads, its child networks. */
function Boundary({ network, vm }: { network: NetworkBoundary; vm: NetworkViewModel }) {
  const inside = vm.workloads.filter((w) => w.network === network.id && w.scope !== 'outside');
  const children = vm.networks.filter((n) => n.parent === network.id);
  return (
    <fieldset className="net-boundary">
      <legend>
        <strong>{networkCaption(network)}</strong>
        {network.description ? <span className="hint"> — {network.description}</span> : null}
      </legend>
      <div className="net-row">
        {inside.map((w) => (
          <WorkloadChip key={nameOf(w, vm.networks)} party={w} networks={vm.networks} />
        ))}
        {inside.length === 0 && <span className="hint">no workload sends or receives a flow here</span>}
      </div>
      {children.map((c) => (
        <Boundary key={c.id} network={c} vm={vm} />
      ))}
    </fieldset>
  );
}

/**
 * The hosted canvas's network view (DiagramView `network`): the declared
 * networks as nested trust boundaries with their gateways, an outside node,
 * and the allowed flows aggregated per workload pair — a data-flow diagram
 * with trust boundaries, derived from the design (GET /web/projects/network).
 */
export function NetworkView({ projectId, onComponents }: { projectId: string; onComponents: () => void }) {
  const state = useAsync<NetworkViewModel>(
    () => get('/web/projects/network?projectId=' + encodeURIComponent(projectId)),
    [projectId],
    [`project:${projectId}`, 'projects'],
  );
  return (
    <div className="net-view">
      <div className="canvas-bar">
        <button className="btn btn-ghost btn-sm" onClick={onComponents} title="Back to the component architecture">
          ← Components
        </button>
        <span className="crumb-sep">/</span>
        <strong>Network</strong>
        <span className="hint"> derived from the design: who may reach whom, over which transport, through which gateway</span>
      </div>
      <AsyncView state={state}>
        {(vm) => (vm.edges.length === 0 ? <NoFlows /> : <NetworkPicture vm={vm} />)}
      </AsyncView>
    </div>
  );
}

function NoFlows() {
  return (
    <EmptyState>
      No network-transport flows: every verb of this design is in-process or local (CLI, IPC, JSON-RPC over stdio, a library).
      Flows appear for HTTP, gRPC, GraphQL, MessageBus and Custom Portals reached by a modelled call or a declared entry.
    </EmptyState>
  );
}

function NetworkPicture({ vm }: { vm: NetworkViewModel }) {
  const loose = vm.workloads.filter((w) => w.scope === 'outside' || w.network === undefined || !vm.networks.some((n) => n.id === w.network));
  return (
    <div className="stack-sm net-picture">
      <div className="net-row">
        {loose.map((w) => (
          <WorkloadChip key={nameOf(w, vm.networks)} party={w} networks={vm.networks} />
        ))}
      </div>
      {vm.networks
        .filter((n) => n.parent === undefined)
        .map((n) => (
          <Boundary key={n.id} network={n} vm={vm} />
        ))}
      <h3>Flows ({vm.edges.length})</h3>
      {vm.edges.map((e, i) => (
        <details key={i} className="panel">
          <summary>
            <strong>{nameOf(e.from, vm.networks)}</strong> → <strong>{nameOf(e.to, vm.networks)}</strong>{' '}
            <Badge tone="accent">{e.transport}</Badge> <span className="subtle">{e.verbs?.length ?? 1} verb(s)</span>
            {e.crosses.length > 0 && (
              <span className="hint">
                {' '}
                · enters {e.crosses.map((n) => (n === '' ? 'root network' : n)).join(' › ')}
                {e.via ? ` through ${e.via}` : ' — no gateway'}
              </span>
            )}
          </summary>
          <ul className="finding-list">
            {(e.verbs ?? []).map((v) => (
              <li key={v}>
                <code>{v}</code>
              </li>
            ))}
          </ul>
          <p className="hint">Evidence: {e.evidence.join(' · ')}</p>
        </details>
      ))}
    </div>
  );
}
