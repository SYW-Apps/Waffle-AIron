import {
  invalidateSpecCache,
  loadComponentSpecs,
  loadImplementationSpecs,
  loadInterfaceSpecs,
  loadSubsystemSpecs,
  loadSystemSpec,
  loadTypeSpecs,
  retiredReachFacts,
  saveComponentSpec,
  saveInterfaceSpec,
  saveSpec,
} from './specs.js';
import {
  isInProcessAddress,
  retiredMountsOf,
  transportExportKind,
  type ComponentSpec,
  type ImplementationSpec,
  type InterfaceSpec,
  type RetiredMount,
  type RetiredReachForm,
  type SubsystemSpec,
  type SystemSpec,
  type Transport,
  type TypeSpec,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// Reachability migration (sdd_core, behind `wairon doctor`)
//
// The one-project migration onto the reachability model. It plans from the
// retired forms the scan recorded (spec_loader.retiredReachFacts) and writes
// only with apply; the plan IS the rehearsal of exactly what apply writes.
//
// What it never does is invent design. A Portal that was neither a listener
// nor mounted gets no entry (it surfaces as unreached for its author); a
// sibling-subsystem invokedBy is reported (its caller is in the tree and must
// be modelled); an export type that disagrees with the derived kind, an
// endpoint outside every old prefix and a router already set otherwise are
// reported, not written.
// ---------------------------------------------------------------------------

/** One rewrite of the reachability migration, or one thing it reports instead (reach_rewrite). */
export interface ReachRewrite {
  /** The spec rewritten (or reported). */
  specId: string;
  /** The retired form it replaces. */
  form: RetiredReachForm;
  /** What it becomes, as one line. */
  to: string;
  /** Why, in one sentence. */
  reason: string;
}

/** The reachability migration of one project, planned and (with apply) written (reachability_migration_plan). */
export interface ReachabilityMigrationPlan {
  /** Every rewrite, in spec order. */
  rewrites: ReachRewrite[];
  /** What it will not write and why. */
  reported: ReachRewrite[];
  /** Whether the rewrites were written. */
  applied: boolean;
}

/** The lint codes the reachability model retired, and the one it renamed. */
const RETIRED_CODES: ReadonlySet<string> = new Set([
  'UNMOUNTED_PORTAL', 'ENDPOINT_OUTSIDE_MOUNT', 'MOUNT_TARGET_NOT_PORTAL',
  'PUBLIC_INTERFACE_TYPE_MISMATCH', 'PUBLIC_INTERFACE_EVENT_MISTYPED',
]);
const RENAMED_CODES: Readonly<Record<string, string>> = { MISSING_PORTAL_TYPE: 'MISSING_PORTAL_TRANSPORT' };

type Kind = 'component' | 'interface' | 'implementation' | 'subsystem' | 'type' | 'system';
type AnySpec = ComponentSpec | InterfaceSpec | ImplementationSpec | SubsystemSpec | TypeSpec | SystemSpec;

/** The write order: components first, then interfaces, implementations, subsystems, types and the system. */
const WRITE_ORDER: readonly Kind[] = ['component', 'interface', 'implementation', 'subsystem', 'type', 'system'];

/** A spec of the bound project itself: a contained member's specs are keyed under its namespace and are its own doctor's. */
const own = (id: string): boolean => !id.includes('::');

/** Whether an HTTP path lies under a prefix: equal to it, or continuing it past a slash. */
function liesUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/** A list of prefixes as one phrase. */
function prefixPhrase(prefixes: string[]): string {
  return prefixes.length > 0 ? prefixes.map((p) => `"${p}"`).join(', ') : 'no prefix';
}

/**
 * ireachability_migration.migrate — plan, and with apply write, the bound
 * project's migration onto the reachability model: transports, listener
 * mounts into Portal-level entries and implementation routers, retired
 * invokedBy kinds, authored export types, in-process Custom endpoints and the
 * lint allows of retired codes. What it cannot decide without inventing
 * design is reported, never written. Idempotent: an applied plan re-plans
 * empty. Without apply nothing is written.
 */
export function migrate(apply: boolean): ReachabilityMigrationPlan {
  // Step 1: the retired forms the scan recorded, the project's own only.
  const facts = retiredReachFacts().filter((f) => f.specId === 'system' || own(f.specId));
  // Steps 2-7: the specs they sit in.
  const components = loadComponentSpecs().filter((c) => own(c.id));
  const interfaces = loadInterfaceSpecs().filter((i) => own(i.id));
  const implementations = loadImplementationSpecs().filter((i) => own(i.id));
  const subsystems = loadSubsystemSpecs().filter((s) => own(s.id));
  const system = loadSystemSpec();
  const types = loadTypeSpecs().filter((t) => own(t.id));

  const rewrites: ReachRewrite[] = [];
  const reported: ReachRewrite[] = [];
  const rewrite = (specId: string, form: RetiredReachForm, to: string, reason: string): void => {
    rewrites.push({ specId, form, to, reason });
  };
  const report = (specId: string, form: RetiredReachForm, to: string, reason: string): void => {
    reported.push({ specId, form, to, reason });
  };

  // The working copies: a loaded spec is the scan's cached object, so every
  // rewrite lands on a copy, taken once per spec, and only a copy is written.
  const dirty = new Map<Kind, Map<string, AnySpec>>(WRITE_ORDER.map((k) => [k, new Map()]));
  const touch = <T extends AnySpec>(kind: Kind, id: string, spec: T): T => {
    const copies = dirty.get(kind)!;
    let copy = copies.get(id) as T | undefined;
    if (!copy) {
      copy = structuredClone(spec);
      copies.set(id, copy);
    }
    return copy;
  };
  /** A spec as it stands in the plan so far: its working copy when it has one. */
  const current = <T extends AnySpec>(kind: Kind, id: string, spec: T): T => (dirty.get(kind)!.get(id) as T | undefined) ?? spec;

  const componentById = new Map(components.map((c) => [c.id, c]));
  const contractsOf = (componentId: string): InterfaceSpec[] => interfaces.filter((i) => i.component === componentId);

  // Step 8: the transports.
  for (const fact of facts.filter((f) => f.form === 'portal-type')) {
    const comp = componentById.get(fact.specId);
    if (!comp) continue;
    const transport = comp.transport;
    if (transport === undefined) {
      report(comp.id, 'portal-type', `portalType ${String(fact.stored)} kept`, `"${String(fact.stored)}" is not a transport, so no transport can be written for it: set the Portal's transport by hand.`);
      continue;
    }
    touch('component', comp.id, comp).transport = transport;
    rewrite(comp.id, 'portal-type', `transport ${transport}`,
      fact.stored === transport
        ? `portalType is retired: the Portal's transport is the one vocabulary its endpoints share.`
        : `portalType ${String(fact.stored)} is retired and read as transport ${transport}.`);
  }
  // A Custom Portal that binds no endpoint, or whose Custom addresses all name
  // in-process calls, is an in-process Portal: its addresses were symbols.
  const inProcessCandidates = new Set<string>();
  for (const fact of facts.filter((f) => f.form === 'in-process-endpoint')) {
    if (componentById.has(fact.specId)) inProcessCandidates.add(fact.specId);
    const intf = interfaces.find((i) => i.id === fact.specId);
    if (intf) inProcessCandidates.add(intf.component);
  }
  for (const id of [...inProcessCandidates].sort()) {
    const comp = componentById.get(id);
    if (!comp || comp.componentType !== 'Portal' || current('component', id, comp).transport !== 'Custom') continue;
    const bound = contractsOf(id).flatMap((intf) => intf.methods.filter((m) => m.endpoint !== undefined).map((m) => ({ intf, m })));
    const wire = bound.filter(({ m }) => !(m.endpoint!.transport === 'Custom' && isInProcessAddress((m.endpoint as { address: string }).address)));
    if (wire.length > 0) {
      report(id, 'in-process-endpoint', 'transport Custom kept',
        `Some Custom addresses name in-process calls, but ${wire.map(({ m }) => `"${m.name}"`).join(', ')} bind${wire.length === 1 ? 's' : ''} a wire address: split the in-process verbs into an InProcess Portal, or keep them Custom.`);
      continue;
    }
    touch('component', id, comp).transport = 'InProcess';
    // Its retired portalType's own rewrite (to Custom) is superseded by this one.
    const superseded = rewrites.findIndex((r) => r.specId === id && r.form === 'portal-type');
    if (superseded !== -1) rewrites.splice(superseded, 1);
    rewrite(id, 'in-process-endpoint', 'transport InProcess',
      bound.length === 0
        ? 'A Custom Portal that binds no endpoint on any verb is entered in-process: no wire address means no other consistent reading.'
        : 'Every Custom address of this Portal names an in-process call, so it is entered in-process and needs no endpoint.');
    for (const { intf, m } of bound) {
      const copy = touch('interface', intf.id, intf);
      const method = copy.methods.find((x) => x.name === m.name)!;
      const address = (m.endpoint as { address: string }).address;
      delete method.endpoint;
      rewrite(intf.id, 'in-process-endpoint', `endpoint of "${m.name}" dropped`,
        `An InProcess verb binds no endpoint; the address "${address}" named its code symbol — keep it as the implementation's symbol or exportedVia where the name differs.`);
    }
  }

  // Step 9: the listeners.
  const listeners = [...new Set(facts.filter((f) => f.form === 'listener-mounts').map((f) => f.specId))].sort();
  /** Each mounted Portal: the listeners and prefixes that routed to it, and the router entries they named. */
  const mounted = new Map<string, { listener: string; mount: RetiredMount }[]>();
  for (const id of listeners) {
    const listener = componentById.get(id);
    if (!listener) continue;
    const { mounts } = retiredMountsOf(listener);
    const copy = touch('component', id, listener) as ComponentSpec & { mounts?: unknown };
    delete copy.mounts;
    if (mounts.length === 0) {
      rewrite(id, 'listener-mounts', 'mounts removed', 'An empty mounts list routed nothing; it only exempted the Portal from a retired rule.');
      report(id, 'listener-mounts', 'no entry written',
        `"${id}" declared an empty mounts list, which the authoring tool once wrote by default, so it does not show the host starts it: if callers outside the design reach it, declare its entry (invokedBy {kind: entry, caller}); otherwise model its caller.`);
      continue;
    }
    rewrite(id, 'listener-mounts', 'mounts removed', `The listener's mounts are retired: it and the Portals it served are entered, and each router moves to the Portal's implementation.`);
    for (const mount of mounts) {
      const target = componentById.get(mount.portal);
      if (!target || target.componentType !== 'Portal') {
        report(id, 'listener-mounts', `mount of "${mount.portal}" dropped`,
          `"${mount.portal}" is ${target ? `a ${target.componentType}` : 'no component of this project'}, so no entry or router can be written for it.`);
        continue;
      }
      mounted.set(target.id, [...(mounted.get(target.id) ?? []), { listener: id, mount }]);
    }
    if (listener.componentType === 'Portal' && !listener.invokedBy) {
      const routed = mounts.map((m) => `${prefixPhrase(m.prefixes)} to ${m.portal}`).join('; ');
      touch('component', id, listener).invokedBy = { kind: 'entry', caller: `Clients the host's listener ${id} serves directly, routing ${routed}` };
      rewrite(id, 'listener-mounts', 'invokedBy entry (outside) on the Portal', 'A listener is started by the host and entered by its clients from outside the design.');
    }
  }
  for (const [portalId, servedBy] of [...mounted].sort(([a], [b]) => a.localeCompare(b))) {
    const portal = componentById.get(portalId)!;
    // The entry: one per mounted Portal, naming every listener that served it.
    if (!current('component', portalId, portal).invokedBy) {
      const through = servedBy.map(({ listener, mount }) => `${listener} under ${prefixPhrase(mount.prefixes)}`).join('; ');
      touch('component', portalId, portal).invokedBy = { kind: 'entry', caller: `Clients served through the listener ${through}` };
      rewrite(portalId, 'listener-mounts', 'invokedBy entry (outside) on the Portal', 'A Portal a listener mounted is entered by the listener\'s clients from outside the design.');
    }
    // The router: each mount's via onto the Portal's implementation.
    const vias = [...new Set(servedBy.map(({ mount }) => mount.via).filter((v): v is string => v !== undefined))];
    if (vias.length > 0) {
      const contractIds = new Set(contractsOf(portalId).map((i) => i.id));
      const impls = implementations.filter((impl) => contractIds.has(impl.contract)).sort((a, b) => a.id.localeCompare(b.id));
      const impl = impls[0];
      if (!impl) {
        report(portalId, 'listener-mounts', `router ${vias.join(', ')} not written`, 'The Portal has no implementation to carry its router: write the implementation, then set its router.');
      } else {
        const stands = current('implementation', impl.id, impl).router;
        if (stands !== undefined && stands !== vias[0]) {
          report(impl.id, 'listener-mounts', `router ${stands} kept`, `The implementation already names router ${stands}; the mount named ${vias[0]}. Decide which entry the Portal's file exports.`);
        } else if (stands === undefined) {
          touch('implementation', impl.id, impl).router = vias[0];
          rewrite(impl.id, 'listener-mounts', `router ${vias[0]}`, `The mount's via is the router entry the Portal's own file exports: it moves onto the Portal's implementation.`);
        }
        for (const other of vias.slice(1)) {
          report(impl.id, 'listener-mounts', `router ${other} not written`, `Another listener named the router ${other}; an implementation names one router.`);
        }
      }
    }
    // An HTTP endpoint outside every prefix a listener routed to it.
    const prefixes = servedBy.flatMap(({ mount }) => mount.prefixes);
    for (const intf of contractsOf(portalId)) {
      for (const m of intf.methods) {
        const ep = m.endpoint;
        if (ep?.transport !== 'HTTP' || prefixes.some((p) => liesUnder(ep.path, p))) continue;
        report(intf.id, 'listener-mounts', `endpoint ${ep.method} ${ep.path} of "${m.name}" kept`,
          `It lies under none of the prefixes its listeners routed (${prefixPhrase(prefixes)}), so no request through them reached it: move the endpoint, or confirm the server routes it.`);
      }
    }
  }

  // Step 10: the invokedBy kinds.
  for (const fact of facts.filter((f) => f.form === 'invoked-by-kind')) {
    const intf = interfaces.find((i) => i.id === fact.specId);
    if (!intf || fact.at === undefined) continue;
    if (fact.stored === 'sibling-subsystem') {
      report(intf.id, 'invoked-by-kind', `invokedBy sibling-subsystem on "${fact.at}" kept`,
        `Its caller lives in this tree, so the call must be modelled (a call step from the sibling's Adapter); a migration cannot invent it.`);
      continue;
    }
    if (fact.stored !== 'external') continue;
    const isPortal = componentById.get(intf.component)?.componentType === 'Portal';
    const copy = touch('interface', intf.id, intf);
    const method = copy.methods.find((m) => m.name === fact.at);
    if (!method?.invokedBy) continue;
    method.invokedBy = { ...method.invokedBy, kind: isPortal ? 'entry' : 'runtime' };
    rewrite(intf.id, 'invoked-by-kind', `invokedBy ${isPortal ? 'entry' : 'runtime'} on "${fact.at}"`,
      isPortal
        ? 'external on a Portal verb is an entry: callers outside the design reach it over the Portal\'s transport.'
        : 'external on a non-Portal method is the process\'s own runtime invoking it; its caller description is kept.');
  }

  // Step 11: the export types.
  /** The backing Portal's transport after the rewrites above, when the entry is backed by one. */
  const derivedKind = (entry: { component?: string; interface?: string }): string | undefined => {
    const id = entry.component ?? (entry.interface !== undefined ? interfaces.find((i) => i.id === entry.interface)?.component : undefined);
    const comp = id !== undefined ? componentById.get(id) : undefined;
    if (!comp || comp.componentType !== 'Portal') return undefined;
    const transport: Transport | undefined = current('component', comp.id, comp).transport;
    return transport ? transportExportKind(transport) : undefined;
  };
  const exportTypes = (kind: 'subsystem' | 'system', id: string, spec: SubsystemSpec | SystemSpec): void => {
    const entries = (spec.publicInterfaces ?? []) as { type?: string; component?: string; interface?: string; as?: string; id?: string }[];
    entries.forEach((entry, index) => {
      if (entry.type === undefined) return;
      const name = entry.as ?? entry.id ?? entry.interface ?? entry.component ?? `#${index + 1}`;
      const derived = derivedKind(entry);
      if (derived === entry.type) {
        const copy = touch(kind, id, spec);
        delete (copy.publicInterfaces as typeof entries)[index].type;
        rewrite(id, 'export-type', `type of "${name}" dropped`, `The export kind is derived from the backing Portal's transport (${derived}); the authored one agrees.`);
      } else {
        report(id, 'export-type', `type ${entry.type} of "${name}" kept`,
          derived === undefined
            ? 'No backing Portal derives an export kind for this entry: drop the type by hand once the entry is backed by a Portal, or remove it.'
            : `The backing Portal's transport derives ${derived}, not ${entry.type}: correct the Portal's transport or drop the type.`);
      }
    });
  };
  for (const sub of subsystems) exportTypes('subsystem', sub.id, sub);
  if (system) exportTypes('system', 'system', system);

  // Step 12: the lint allows of retired codes.
  const allows = (kind: Kind, id: string, spec: AnySpec): void => {
    const stored = (current(kind, id, spec) as { lint?: { allow?: { code: string; at?: string }[] } }).lint?.allow ?? [];
    if (!stored.some((a) => RETIRED_CODES.has(a.code) || RENAMED_CODES[a.code] !== undefined)) return;
    const copy = touch(kind, id, spec) as { lint?: { allow?: { code: string; at?: string }[] } };
    const kept: { code: string; at?: string }[] = [];
    for (const a of copy.lint!.allow!) {
      const at = a.at !== undefined ? ` at "${a.at}"` : '';
      if (RETIRED_CODES.has(a.code)) {
        rewrite(id, 'retired-allow', `allow of ${a.code}${at} removed`, `${a.code} is retired with the rule that reported it.`);
        continue;
      }
      const renamed = RENAMED_CODES[a.code];
      if (renamed !== undefined) {
        rewrite(id, 'retired-allow', `allow of ${a.code}${at} rekeyed to ${renamed}`, `${a.code} is renamed ${renamed}.`);
        kept.push({ ...a, code: renamed });
        continue;
      }
      kept.push(a);
    }
    copy.lint!.allow = kept;
  };
  for (const c of components) allows('component', c.id, c);
  for (const i of interfaces) allows('interface', i.id, i);
  for (const i of implementations) allows('implementation', i.id, i);
  for (const s of subsystems) allows('subsystem', s.id, s);
  for (const t of types) allows('type', t.id, t);

  const bySpec = (a: ReachRewrite, b: ReachRewrite): number => a.specId.localeCompare(b.specId);
  rewrites.sort(bySpec);
  reported.sort(bySpec);

  // Step 13: without apply, nothing is written — the plan is the rehearsal.
  if (!apply || rewrites.length === 0) return { rewrites, reported, applied: false };

  // Steps 14-21: each rewritten spec once, through the store's writers, told
  // to retire the forms rather than carry them back.
  for (const kind of WRITE_ORDER) {
    for (const spec of dirty.get(kind)!.values()) {
      if (kind === 'component') saveComponentSpec(spec as ComponentSpec, { retireReachForms: true });
      else if (kind === 'interface') saveInterfaceSpec(spec as InterfaceSpec, { retireReachForms: true });
      else saveSpec(kind, spec);
    }
  }
  // Step 22: the cache no longer reflects the migrated tree.
  invalidateSpecCache();
  // Step 23: the plan, applied.
  return { rewrites, reported, applied: true };
}
