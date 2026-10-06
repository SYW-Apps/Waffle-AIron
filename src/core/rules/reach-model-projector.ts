import { componentEntryFor, parseDeclaredCall, SURFACE_AUDIENCES } from '../../models/index.js';
import type {
  ComponentSpec,
  DeclaredInvocation,
  Endpoint,
  ModelledCall,
  NetworkBoundary,
  NetworkDeclaration,
  ProjectFamily,
  ReachModel,
  VerbReach,
} from '../../models/index.js';
import type { RuleContext } from './types.js';

// ---------------------------------------------------------------------------
// The reach model projector: what reaches each Portal verb, and from where.
//
// `project` derives one project's own model (scope own) from the read model its
// own gate builds; `compose` composes the family's (scope family) from each
// selected project's own model and the family's cross-project references. A
// network is declared by a project and encloses that project and every member
// below it, nested one level per declaring project; a part declares none.
//
// Pure: over the values it is handed, it reads no file and judges nothing. The
// network rules (network_arbiter) and every derived networking output read what
// it projects, so the validator and the flow matrix never disagree about what
// reaches what. It mirrors the narrative graph projector beside it.
// ---------------------------------------------------------------------------

/** One endpoint as one line: `POST /orders`, `orders.v1.Orders/Create`, `topic orders.created`. */
function bindingLine(endpoint: Endpoint | undefined): string | undefined {
  if (!endpoint) return undefined;
  switch (endpoint.transport) {
    case 'HTTP': return `${endpoint.method} ${endpoint.path}`;
    case 'gRPC': return `${endpoint.service}/${endpoint.method}`;
    case 'GraphQL': return `${endpoint.operation} ${endpoint.field}`;
    case 'MessageBus': return `${endpoint.direction} topic ${endpoint.topic} (${endpoint.event})`;
    case 'NamedPipe': return `pipe ${endpoint.pipe}`;
    case 'IPC': return `channel ${endpoint.channel}`;
    case 'CLI': return endpoint.command;
    case 'JSONRPC': return endpoint.method;
    case 'Custom': return endpoint.address;
  }
}

/** Ascending audience rank; an unknown level ranks as instance. */
function audienceRank(audience: string): number {
  const idx = (SURFACE_AUDIENCES as readonly string[]).indexOf(audience);
  return idx === -1 ? (SURFACE_AUDIENCES as readonly string[]).indexOf('instance') : idx;
}

/** Whether an entry is entered from outside its network: kind entry, scope outside or absent. */
function isOutsideEntry(entry: DeclaredInvocation | undefined): boolean {
  return entry?.kind === 'entry' && (entry.scope ?? 'outside') === 'outside';
}

/** The widest audience among the L0 export entries backed by this Portal (and, when an entry narrows, this verb's interface). */
function widestAudience(ctx: RuleContext, portal: string, interfaceId: string): string | undefined {
  // The bound root's own L0 table: a member's project table is owned by the member's key.
  const table = (ctx.exportTables ?? []).find((t) => t.level === 'project' && ctx.projectOf(t.owner) === '');
  let widest: string | undefined;
  for (const entry of table?.entries ?? []) {
    if (entry.kind !== 'component' || entry.component !== portal) continue;
    if (entry.interface !== undefined && entry.interface !== interfaceId) continue;
    const audience = entry.audience ?? 'instance';
    if (widest === undefined || audienceRank(audience) > audienceRank(widest)) widest = audience;
  }
  return widest;
}

/** Stable order: verbs by portal then verb, calls by caller, target and evidence. */
function byVerb(a: VerbReach, b: VerbReach): number {
  return a.project.localeCompare(b.project) || a.portal.localeCompare(b.portal) || a.verb.localeCompare(b.verb);
}
function byCall(a: ModelledCall, b: ModelledCall): number {
  return a.fromProject.localeCompare(b.fromProject) || a.fromComponent.localeCompare(b.fromComponent)
    || a.toPortal.localeCompare(b.toPortal) || a.verb.localeCompare(b.verb) || a.evidence.localeCompare(b.evidence);
}

/**
 * ireach_model_projector.project — one project's own reach model: its own
 * network when it declares one, every Portal verb of its own tree, and its own
 * cross-subsystem calls into Portal verbs. A contained member's specs are not
 * the project's own: the member's own model carries them.
 */
export function project(ctx: RuleContext, network: NetworkDeclaration | undefined): ReachModel {
  // Step 1: the project's own network, named by its key ('' for the bound root).
  const ownNetwork: NetworkBoundary | undefined = network
    ? { id: '', ...(network.description !== undefined ? { description: network.description } : {}), gateways: [] }
    : undefined;
  const isOwn = (comp: ComponentSpec): boolean => !ctx.isInChainedSubproject(comp.subsystem);

  // Steps 2-4: every Portal verb of the own tree, and the own network's gateways.
  const verbs: VerbReach[] = [];
  for (const comp of ctx.components) {
    if (comp.componentType !== 'Portal' || !isOwn(comp) || !comp.transport) continue;
    const gateway = comp.variant === 'gateway';
    let outsideEntered = isOutsideEntry(comp.invokedBy);
    for (const intf of ctx.interfacesByComponent.get(comp.id) ?? []) {
      for (const m of intf.methods) {
        const entry = componentEntryFor(comp, m.invokedBy);
        if (isOutsideEntry(entry)) outsideEntered = true;
        const binding = comp.transport === 'InProcess' ? undefined : bindingLine(m.endpoint);
        const audience = widestAudience(ctx, comp.id, intf.id);
        verbs.push({
          project: '',
          portal: comp.id,
          verb: m.name,
          subsystem: comp.subsystem,
          transport: comp.transport,
          ...(binding !== undefined ? { binding } : {}),
          ...(ownNetwork ? { network: ownNetwork.id } : {}),
          gateway,
          ...(entry ? { entry } : {}),
          ...(audience !== undefined ? { audience } : {}),
        });
      }
    }
    if (ownNetwork && gateway && outsideEntered) ownNetwork.gateways.push(comp.id);
  }

  // Step 5: the own cross-subsystem calls into Portal verbs.
  const calls: ModelledCall[] = [];
  const intoPortal = (from: ComponentSpec, target: string | undefined, verb: string | undefined, evidence: string): void => {
    if (!target || !verb) return;
    const to = ctx.componentMap.get(target);
    if (!to || to.componentType !== 'Portal' || !isOwn(to) || to.subsystem === from.subsystem) return;
    calls.push({
      fromProject: '',
      fromComponent: from.id,
      fromSubsystem: from.subsystem,
      ...(ownNetwork ? { fromNetwork: ownNetwork.id } : {}),
      toPortal: to.id,
      verb,
      evidence,
    });
  };
  for (const impl of ctx.implementations) {
    const contract = ctx.interfaceMap.get(impl.contract);
    const from = contract ? ctx.componentMap.get(contract.component) : undefined;
    if (!from || !isOwn(from)) continue;
    for (const method of impl.methods) {
      for (const step of method.narrative) {
        const evidence = `${impl.id}.${method.name}#${step.stepNumber}`;
        if (step.type === 'call' || step.type === 'register') intoPortal(from, step.targetComponent, step.targetMethod, evidence);
        // A dispatch routed through a Portal's table reaches that Portal's served surface.
        if (step.type === 'dispatch' && step.capability) intoPortal(from, step.targetComponent, `capability:${step.capability}`, evidence);
      }
      for (const entry of method.calls ?? []) {
        const call = parseDeclaredCall(entry);
        if (call) intoPortal(from, call.compId, call.methodName, `${impl.id}.${method.name} calls`);
      }
    }
  }

  // Step 6.
  return {
    scope: 'own',
    networks: ownNetwork ? [{ ...ownNetwork, gateways: [...ownNetwork.gateways].sort() }] : [],
    verbs: verbs.sort(byVerb),
    calls: calls.sort(byCall),
  };
}

/** A project's local key qualified into the family root's key space. */
function qualify(projectKey: string, local: string): string {
  return projectKey === '' ? local : `${projectKey}::${local}`;
}

/**
 * ireach_model_projector.compose — the family's reach model from each selected
 * project's own model: every declared network nested by membership, each
 * project's verbs and calls placed in its innermost network, and the
 * cross-project calls the family's references record.
 */
export function compose(
  models: Map<string, ReachModel>,
  family: ProjectFamily,
  networks: Map<string, NetworkDeclaration>,
): ReachModel {
  const parentOf = new Map(family.nodes.map((n) => [n.namespace, n.parent] as const));
  /** The nearest project at or above a key that declares a network. */
  const innermost = (key: string | undefined): string | undefined => {
    const seen = new Set<string>();
    let current = key;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      if (networks.has(current)) return current;
      current = parentOf.get(current);
    }
    return undefined;
  };

  // Step 1: nest the networks, outermost first.
  const boundaries = new Map<string, NetworkBoundary>();
  for (const [key, declaration] of networks) {
    const parent = innermost(parentOf.get(key));
    boundaries.set(key, {
      id: key,
      ...(parent !== undefined ? { parent } : {}),
      ...(declaration.description !== undefined ? { description: declaration.description } : {}),
      gateways: [],
    });
  }
  const depth = (id: string): number => {
    let d = 0;
    for (let p = boundaries.get(id)?.parent; p !== undefined && d < boundaries.size; p = boundaries.get(p)?.parent) d++;
    return d;
  };

  // Steps 2-3: each project's verbs and calls, re-placed in its innermost network.
  const verbs: VerbReach[] = [];
  const calls: ModelledCall[] = [];
  for (const [key, model] of models) {
    const net = innermost(key);
    for (const v of model.verbs) {
      const { network: _own, ...rest } = v;
      const placed: VerbReach = {
        ...rest,
        project: key,
        portal: qualify(key, v.portal),
        ...(v.subsystem !== undefined ? { subsystem: qualify(key, v.subsystem) } : {}),
        ...(net !== undefined ? { network: net } : {}),
      };
      verbs.push(placed);
      if (net !== undefined && placed.gateway && isOutsideEntry(placed.entry)) {
        const gateways = boundaries.get(net)!.gateways;
        if (!gateways.includes(placed.portal)) gateways.push(placed.portal);
      }
    }
    for (const c of model.calls) {
      const { fromNetwork: _own, ...rest } = c;
      calls.push({
        ...rest,
        fromProject: key,
        fromComponent: qualify(key, c.fromComponent),
        ...(c.fromSubsystem !== undefined ? { fromSubsystem: qualify(key, c.fromSubsystem) } : {}),
        toPortal: qualify(key, c.toPortal),
        ...(net !== undefined ? { fromNetwork: net } : {}),
      });
    }
  }

  // Step 4: the cross-project calls the family's references record.
  const portals = new Set(verbs.map((v) => v.portal));
  for (const ref of family.references) {
    if (!['call', 'calls', 'register', 'dispatch'].includes(ref.position) || ref.member === undefined) continue;
    if (!portals.has(ref.target)) continue;
    const net = innermost(ref.consumer);
    calls.push({
      fromProject: ref.consumer,
      // The component whose implementation writes the call, as the
      // reference recorded it — never guessed from a matching dependsOn.
      fromComponent: ref.caller ?? ref.specId,
      ...(net !== undefined ? { fromNetwork: net } : {}),
      toPortal: ref.target,
      verb: ref.member,
      evidence: `${ref.specId} (${ref.position} ${ref.authored})`,
    });
  }

  // Step 5.
  return {
    scope: 'family',
    networks: [...boundaries.values()]
      .map((b) => ({ ...b, gateways: [...b.gateways].sort() }))
      .sort((a, b) => depth(a.id) - depth(b.id) || a.id.localeCompare(b.id)),
    verbs: verbs.sort(byVerb),
    calls: calls.sort(byCall),
  };
}
