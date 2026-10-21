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
  l0ExportName,
  parseDeclaredCall,
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
// What it never does is invent design, or keep a retired form: wairon 6
// cannot read a spec holding one. A Portal that was neither a listener nor
// mounted gets no entry (it surfaces as unreached for its author); a
// sibling-subsystem invokedBy no modelled call says is kept as runtime, its
// caller unchanged, and reported with the call the author can model instead;
// an export type that disagrees with the derived kind (or that no Portal
// derives) and a portalType naming no transport are dropped and reported; an endpoint
// outside every old prefix and a router already set otherwise are reported,
// not written.
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

/** Every call the tree models, as component.method, with the first method that makes it: narrative call steps and declared calls. */
function modelledCalls(implementations: ImplementationSpec[], interfaces: InterfaceSpec[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const impl of implementations) {
    const component = interfaces.find((i) => i.id === impl.contract)?.component ?? impl.contract;
    for (const m of impl.methods ?? []) {
      const steps = (m.narrative ?? []).flatMap((s) => (s.type === 'call' && s.targetComponent && s.targetMethod ? [`${s.targetComponent}.${s.targetMethod}`] : []));
      const declared = (m.calls ?? []).flatMap((c) => {
        const call = parseDeclaredCall(c);
        return call ? [`${call.compId}.${call.methodName}`] : [];
      });
      for (const target of [...steps, ...declared]) if (!out.has(target)) out.set(target, `${component}.${m.name}`);
    }
  }
  return out;
}

/**
 * What the author of a sibling-subsystem declaration kept as runtime can
 * model, and which of it the rules allow: the subsystem its stored caller
 * names, when it names one; a call step only where a sibling may reach the
 * method (the subsystem's published Portal, through a client Adapter or a
 * trustedLink), else the route through that Portal. The runtime declaration
 * stays right where the code receives the method at wiring time.
 */
function siblingCallerAdvice(
  componentId: string, caller: string | undefined,
  componentById: Map<string, ComponentSpec>, subsystems: SubsystemSpec[],
): string {
  const component = componentById.get(componentId);
  const home = component?.subsystem;
  const named = caller === undefined ? [] : subsystems.filter((s) => s.id !== home
    && [s.id, s.name].some((word) => word && new RegExp(`(^|[^a-z0-9_-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_-])`, 'i').test(caller)));
  const homeSpec = subsystems.find((s) => s.id === home);
  const published = component?.componentType === 'Portal' && (homeSpec?.publicInterfaces ?? []).some((e) => {
    const entry = e as { component?: string };
    return entry.component === componentId;
  });
  const said = caller === undefined ? 'It named no caller' : `Its stored caller was "${caller}"${named.length > 0 ? ` (naming ${named.map((s) => s.id).join(', ')})` : ''}`;
  const route = published
    ? `${componentId} is ${home}'s published Portal, so a sibling reaches it legally: model a call step from the caller's client Adapter, or from a component of a subsystem with a trustedLink to ${home}`
    : `${componentId} is not ${home ?? 'its subsystem'}'s published Portal, so no other subsystem may call it directly: model the call through ${home ?? 'the subsystem'}'s Portal, which dispatches to it`;
  return `${said}. It is kept as \`invokedBy: { kind: runtime }\`${caller !== undefined ? ' with that caller' : ''}, so it stays reached; but runtime says the process's own runtime calls it. If the caller is a component the design can show: ${route}, and INVOKED_BY_REDUNDANT then names the runtime declaration to remove. If the code receives it at wiring time (an injected dependency), runtime is right as it stands.`;
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
      touch('component', comp.id, comp);
      rewrite(comp.id, 'portal-type', `portalType ${String(fact.stored)} dropped`, 'portalType is retired, and wairon 6 cannot read a spec that holds it.');
      report(comp.id, 'portal-type', 'no transport written',
        `"${String(fact.stored)}" is not a transport, so none can be written for it: set the Portal's transport (MISSING_PORTAL_TRANSPORT names it until then).`);
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

  // Step 10: the invokedBy kinds. wairon 6 has no sibling-subsystem kind and
  // cannot read a spec that holds one. Where a modelled call says it already,
  // it is dropped; elsewhere it is kept as runtime with its caller unchanged
  // (the method stays reached, as it was), and reported with the call the
  // author can model instead.
  const modelled = modelledCalls(implementations, interfaces);
  for (const fact of facts.filter((f) => f.form === 'invoked-by-kind')) {
    const intf = interfaces.find((i) => i.id === fact.specId);
    if (!intf || fact.at === undefined) continue;
    if (fact.stored === 'sibling-subsystem') {
      const copy = touch('interface', intf.id, intf);
      const method = copy.methods.find((m) => m.name === fact.at);
      if (!method?.invokedBy) continue;
      const caller = method.invokedBy.caller;
      const by = modelled.get(`${intf.component}.${fact.at}`);
      if (by !== undefined) {
        delete method.invokedBy;
        rewrite(intf.id, 'invoked-by-kind', `invokedBy sibling-subsystem on "${fact.at}" dropped`,
          `The call is modelled: ${by} calls ${intf.component}.${fact.at}, so the declaration said nothing the tree does not.`);
        continue;
      }
      method.invokedBy = { ...method.invokedBy, kind: 'runtime' };
      rewrite(intf.id, 'invoked-by-kind', `invokedBy runtime on "${fact.at}"`,
        'wairon 6 has no sibling-subsystem kind and no call in the tree reaches the method yet, so it is kept as runtime, its caller unchanged.');
      report(intf.id, 'invoked-by-kind', `caller of "${fact.at}" not modelled`,
        siblingCallerAdvice(intf.component, caller, componentById, subsystems));
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
      const name = l0ExportName(entry) ?? entry.interface ?? entry.component ?? `#${index + 1}`;
      const derived = derivedKind(entry);
      // wairon 6 derives the kind and cannot read a spec that authors one, so
      // the type is always dropped; one that said something else is reported.
      const copy = touch(kind, id, spec);
      delete (copy.publicInterfaces as typeof entries)[index].type;
      if (derived === entry.type) {
        rewrite(id, 'export-type', `type of "${name}" dropped`, `The export kind is derived from the backing Portal's transport (${derived}); the authored one agrees.`);
        return;
      }
      rewrite(id, 'export-type', `type ${entry.type} of "${name}" dropped`, 'wairon 6 derives the export kind and reads no authored one.');
      report(id, 'export-type', `type ${entry.type} of "${name}" not derived`,
        derived === undefined
          ? (kind === 'system'
            ? `No backing Portal derives an export kind for this entry: back it by a Portal of the kind ${entry.type} names, or remove it (EXPORT_UNCONSUMABLE judges what consumers can use).`
            : `No backing Portal derives an export kind for this entry: a subsystem publishes its Portal, and another subsystem's dependency on anything else is refused where it is declared. Back the entry by a Portal of the kind ${entry.type} names, or remove it.`)
          : `The backing Portal's transport derives ${derived}, not ${entry.type}: if ${entry.type} was right, correct the Portal's transport.`);
    });
  };
  for (const sub of subsystems) exportTypes('subsystem', sub.id, sub);
  if (system) exportTypes('system', 'system', system);

  // Step 12: the L0 export names: `id` becomes `as`, `subsystem` becomes `from`.
  if (system) {
    const entries = (system.publicInterfaces ?? []) as { id?: string; subsystem?: string; as?: string; from?: string; interface?: string; component?: string }[];
    entries.forEach((entry, index) => {
      if (entry.id === undefined && entry.subsystem === undefined) return;
      const name = l0ExportName(entry) ?? entry.interface ?? entry.component ?? `#${index + 1}`;
      const copy = (touch('system', 'system', system).publicInterfaces as typeof entries)[index];
      if (entry.id !== undefined) {
        const taken = entry.as !== undefined;
        if (!taken) copy.as = entry.id;
        delete copy.id;
        rewrite('system', 'export-name', `id of "${name}" is now as`,
          taken ? 'The entry states both `as` and the wairon 5 `id`: `as` wins and `id` is dropped.' : 'The public name is `as`; the wairon 5 `id` is retired.');
      }
      if (entry.subsystem !== undefined) {
        const taken = entry.from !== undefined;
        if (!taken) copy.from = entry.subsystem;
        delete copy.subsystem;
        rewrite('system', 'export-name', `subsystem of "${name}" is now from`,
          taken ? 'The entry states both `from` and the wairon 5 `subsystem`: `from` wins and `subsystem` is dropped.' : 'The source subsystem is `from`; the wairon 5 `subsystem` is retired.');
      }
    });
  }

  // Step 13: the lint allows of retired codes.
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

  // Step 14: without apply, nothing is written — the plan is the rehearsal.
  if (!apply || rewrites.length === 0) return { rewrites, reported, applied: false };

  // Steps 15-22: each rewritten spec once, through the store's writers, told
  // to retire the forms rather than carry them back.
  for (const kind of WRITE_ORDER) {
    for (const spec of dirty.get(kind)!.values()) {
      if (kind === 'component') saveComponentSpec(spec as ComponentSpec, { retireReachForms: true });
      else if (kind === 'interface') saveInterfaceSpec(spec as InterfaceSpec, { retireReachForms: true });
      else saveSpec(kind, spec);
    }
  }
  // Step 23: the cache no longer reflects the migrated tree.
  invalidateSpecCache();
  // Step 24: the plan, applied.
  return { rewrites, reported, applied: true };
}
