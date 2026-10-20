import {
  loadComponentSpecs, saveComponentSpec, invalidateSpecCache, scanAllSpecs, saveSpec, deleteSpec,
} from './specs.js';
import { readSpecFile } from './spec-files.js';
import { aiPathsAt } from '../config/paths.js';
import { getProjectRoot, pathExists } from '../utils/fs.js';
import { listProjectVariants, rebaseProjectVariants } from './variants.js';
import { parseDeclaredCall, SystemSpecSchema } from '../models/index.js';
import type { ComponentSpec, DependencyClass, SubsystemSpec, SystemSpec } from '../models/index.js';

// ---------------------------------------------------------------------------
// Specialist retirement (sdd_core, behind `wairon doctor`)
//
// Logic is an Orchestrator, and what it may depend on is its dependencyClass.
// Retiring the Specialist stereotype therefore retypes each Specialist as an
// Orchestrator with the class its dependencies decide: pure when it depends
// only on pure logic, read when it also depends on read logic or a data facade,
// unset — a workflow — when a dependency fits neither. A Specialist's class can
// hang on another Specialist's, so classes are decided in passes over the
// dependency graph, and what a cycle leaves undecided is settled last.
// A Gateway is merged into the Portal it owns (retireGateways, below), or
// refused with the hand steps.
//
// Both retirements read a stereotype wairon 5 wrote, so they run only in the v5
// reading `wairon upgrade` binds: anywhere else a Specialist or Gateway never
// loads.
// ---------------------------------------------------------------------------

/** One retired Specialist and the Orchestrator it becomes (specialist_retype). */
export interface SpecialistRetype {
  /** The component id. */
  component: string;
  /** pure or read; absent when a dependency fits neither, leaving a workflow Orchestrator. */
  dependencyClass?: DependencyClass;
  /** The dependencies that decided the class, as readable text. */
  reason: string;
}

/** The migration off the retired Specialist stereotype, planned or applied (specialist_retirement). */
export interface SpecialistRetirement {
  /** Every Specialist and the Orchestrator it becomes. */
  retyped: SpecialistRetype[];
  /** Ids of the project variants based on Specialist, rebased onto Orchestrator. */
  rebasedVariants: string[];
  /** Whether the plan was written; false for a dry run. */
  applied: boolean;
}

/** A Specialist's decided class: pure, read, or unset for a workflow. */
type LogicClass = DependencyClass | 'unset';

/**
 * How a dependency fits the classification as it stands: pure or read logic, a
 * data facade read logic may depend on, neither, or a Specialist still pending.
 */
type DependencyFit = DependencyClass | 'facade' | 'neither' | 'pending';

/** The data facades read logic may depend on. */
const DATA_FACADES: ReadonlySet<string> = new Set(['Repository', 'Index', 'Adapter']);

/**
 * Plan, and with apply write, the migration off the retired Specialist
 * stereotype: each of the bound project's own Specialists becomes an
 * Orchestrator with the dependencyClass its dependencies decide, and each
 * project variant based on Specialist is rebased onto Orchestrator. A chained
 * subproject's Specialists are retired from its own root, beside its own
 * variants. Without apply nothing is written.
 */
export function retireSpecialists(apply: boolean): SpecialistRetirement {
  // Step 1: every component spec in the bound tree.
  const components = loadComponentSpecs();
  const byId = new Map(components.map((c) => [c.id, c]));

  // Step 2: the Specialists, each unclassified, tried in id order.
  const specialists = components
    .filter((c) => c.componentType === 'Specialist' && !c.id.includes('::'))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const specialistIds = new Set(specialists.map((s) => s.id));
  const decided = new Map<string, LogicClass>();
  const reasons = new Map<string, string>();

  const fitOf = (id: string): DependencyFit => {
    if (specialistIds.has(id)) {
      const decision = decided.get(id);
      if (decision === undefined) return 'pending';
      return decision === 'unset' ? 'neither' : decision;
    }
    const dependency = byId.get(id);
    if (dependency?.componentType === 'Orchestrator' && dependency.dependencyClass) return dependency.dependencyClass;
    if (dependency && DATA_FACADES.has(dependency.componentType)) return 'facade';
    return 'neither';
  };

  /** A dependency named with what it is to the classification, e.g. "prices (Repository)". */
  const described = (id: string): string => {
    const dependency = byId.get(id);
    const fit = fitOf(id);
    let what: string;
    if (!dependency) what = 'missing';
    else if (fit === 'pure' || fit === 'read') what = fit;
    else if (dependency.componentType === 'Orchestrator' || specialistIds.has(id)) what = 'workflow';
    else what = dependency.componentType;
    return `${id} (${what})`;
  };

  /** The dependencies that decided a class, as readable text. */
  const reasonFor = (specialist: ComponentSpec, decision: LogicClass, settled: boolean): string => {
    const dependencies = specialist.dependsOn;
    if (decision === 'pure') {
      return dependencies.length === 0
        ? 'no dependencies'
        : `depends only on pure logic: ${dependencies.map(described).join(', ')}`;
    }
    if (decision === 'read') {
      const deciding = dependencies.filter((id) => fitOf(id) !== 'pure');
      return `${settled ? 'in or behind a dependency cycle; ' : ''}depends on read logic or a data facade: ${deciding.map(described).join(', ')}`;
    }
    const deciding = dependencies.filter((id) => fitOf(id) === 'neither');
    return `depends on ${deciding.map(described).join(', ')}, which neither pure nor read logic may depend on`;
  };

  // Steps 3–14: classify in passes over the dependency graph, until a pass classifies nothing.
  let classifiedAny: boolean;
  do {
    classifiedAny = false;
    // Step 4: each Specialist still unclassified.
    for (const specialist of specialists) {
      if (decided.has(specialist.id)) continue;
      const fits = specialist.dependsOn.map(fitOf);
      // Step 5: one with a dependency still unclassified waits for the next pass.
      if (fits.includes('pending')) continue;
      if (fits.every((fit) => fit === 'pure')) {
        // Steps 6–8: pure when every dependency is pure.
        decided.set(specialist.id, 'pure');
      } else if (fits.every((fit) => fit !== 'neither')) {
        // Steps 9–11: read when every dependency is pure or read logic, or a data facade.
        decided.set(specialist.id, 'read');
      } else {
        // Step 12: unset, a workflow Orchestrator — some dependency fits neither class.
        decided.set(specialist.id, 'unset');
      }
      // Step 13: record the dependencies that decided its class.
      reasons.set(specialist.id, reasonFor(specialist, decided.get(specialist.id)!, false));
      classifiedAny = true;
    }
    // Step 14: the pass closes, noting whether it classified any Specialist.
  } while (classifiedAny);

  // Step 15: settle the Specialists still unclassified — in a dependency cycle
  // or waiting on one — with the weakest class that fits: read when every
  // dependency is pure or read logic, a data facade, or another of them; unset
  // otherwise. One left unset makes those depending on it unset in turn.
  const leftovers = specialists.filter((s) => !decided.has(s.id));
  const leftoverIds = new Set(leftovers.map((s) => s.id));
  const settled = new Map<string, LogicClass>(leftovers.map((s) => [
    s.id,
    s.dependsOn.every((id) => leftoverIds.has(id) || fitOf(id) !== 'neither') ? 'read' : 'unset',
  ]));
  let spread = true;
  while (spread) {
    spread = false;
    for (const specialist of leftovers) {
      if (settled.get(specialist.id) === 'read' && specialist.dependsOn.some((id) => settled.get(id) === 'unset')) {
        settled.set(specialist.id, 'unset');
        spread = true;
      }
    }
  }
  for (const [id, decision] of settled) decided.set(id, decision);
  for (const specialist of leftovers) {
    reasons.set(specialist.id, reasonFor(specialist, decided.get(specialist.id)!, true));
  }

  // Step 16: the project's own variants based on Specialist.
  const specialistVariants = listProjectVariants()
    .filter((variant) => variant.base === 'Specialist')
    .map((variant) => variant.id);

  // Step 17: the plan — each Specialist with its dependencyClass when set, and its reason.
  const retyped: SpecialistRetype[] = specialists.map((specialist) => {
    const decision = decided.get(specialist.id)!;
    return {
      component: specialist.id,
      ...(decision === 'unset' ? {} : { dependencyClass: decision }),
      reason: reasons.get(specialist.id)!,
    };
  });

  // Steps 18–19: without apply, nothing is written.
  if (!apply) return { retyped, rebasedVariants: specialistVariants, applied: false };

  // Steps 20–21: save each retype as an Orchestrator, with its dependencyClass when set.
  for (const retype of retyped) {
    const orchestrator: ComponentSpec = { ...byId.get(retype.component)!, componentType: 'Orchestrator' };
    delete orchestrator.dependencyClass;
    if (retype.dependencyClass) orchestrator.dependencyClass = retype.dependencyClass;
    saveComponentSpec(orchestrator);
  }
  // Step 22: rebase those variant files in place, from base Specialist to base Orchestrator.
  const rebasedVariants = rebaseProjectVariants('Specialist', 'Orchestrator');
  // Step 23: the cache no longer reflects the retyped tree.
  invalidateSpecCache();
  // Step 24: the plan, applied.
  return { retyped, rebasedVariants, applied: true };
}

// ---------------------------------------------------------------------------
// Gateway retirement
// ---------------------------------------------------------------------------

/** One Gateway merged into the Portal it owned (gateway_merge). */
export interface GatewayMerge {
  /** The Gateway id, deleted by the merge. */
  gateway: string;
  /** The Portal it owned, now the front door with the gateway variant. */
  portal: string;
  /** The Gateway's other owned members, now the Portal's dependencies. */
  members: string[];
  /** The components whose dependency on the Gateway now names the Portal. */
  consumers: string[];
  /** The specs (an L1 subsystem, the L0) whose export entry named the Gateway and now names the Portal. */
  exports: string[];
}

/** The migration off the retired Gateway stereotype, planned or applied (gateway_retirement). */
export interface GatewayRetirement {
  /** Every Gateway merged into its Portal. */
  merged: GatewayMerge[];
  /** Every Gateway the migration cannot merge, each with why and the hand steps. */
  refused: string[];
  /** Whether the plan was written; false for a dry run. */
  applied: boolean;
}

/** The hand steps a refused Gateway's author takes in its spec files. */
const GATEWAY_HAND_STEPS =
  'Migrate it by hand in its spec files: (1) the Portal it owns becomes the front door, with variant: gateway; '
  + '(2) its other members become dependencies of that Portal instead of owned members; '
  + '(3) its consumers depend on that Portal; (4) delete the Gateway spec. '
  + 'sdd_rename_component can then give the Portal the Gateway\'s id.';

/** A list of ids as one phrase, capped. */
const listed = (ids: string[]): string => (ids.length > 4 ? `${ids.slice(0, 4).join(', ')} and ${ids.length - 4} more` : ids.join(', '));

/**
 * Plan, and with apply write, the migration off the retired Gateway
 * stereotype. A Gateway that owns exactly one Portal, and whose own methods no
 * narrative of another spec calls, is merged into that Portal: the Portal takes
 * the gateway variant, the Gateway's other owned members become the Portal's
 * dependencies, every component that depended on the Gateway depends on the
 * Portal, every L1 or L0 export naming the Gateway names the Portal, and the
 * Gateway's spec, contract and implementation are deleted. Any other Gateway is
 * refused, naming why and the hand steps. Without apply nothing is written.
 */
export function retireGateways(apply: boolean): GatewayRetirement {
  // Step 1: every component spec of the bound project, and — from the same scan,
  // which this component answers itself — the contracts, implementations and
  // subsystems whose narratives and exports can name a Gateway, and the L0.
  const components = loadComponentSpecs();
  const byId = new Map(components.map((c) => [c.id, c]));
  const index = scanAllSpecs();
  const interfaces = index.interfaces;
  const implementations = index.implementations;
  const subsystems = index.subsystems.filter((s) => !s.id.includes('::'));
  const l0File = aiPathsAt(getProjectRoot()).specsSystem();
  const system: SystemSpec | null = pathExists(l0File) ? SystemSpecSchema.parse(readSpecFile(l0File)) : null;

  // Step 2: the Gateways, and what the other specs say about each.
  const gateways = components
    .filter((c) => c.componentType === 'Gateway' && !c.id.includes('::'))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const contractsOf = (id: string) => interfaces.filter((i) => i.component === id);
  const contractIdsOf = (id: string) => new Set(contractsOf(id).map((i) => i.id));
  const ownImplementationsOf = (id: string) => implementations.filter((m) => contractIdsOf(id).has(m.contract));
  /** The places outside the Gateway's own implementations that call one of its methods. */
  const callersOf = (id: string): string[] => {
    const own = new Set(ownImplementationsOf(id).map((m) => m.id));
    const callers: string[] = [];
    for (const impl of implementations) {
      if (own.has(impl.id)) continue;
      for (const method of impl.methods) {
        const stepCall = (method.narrative ?? []).some((s) => s.targetComponent === id);
        const declared = (method.calls ?? []).some((c) => parseDeclaredCall(c)?.compId === id);
        if (stepCall || declared) callers.push(`${impl.id}.${method.name}`);
      }
    }
    for (const c of components) {
      if (c.id !== id && (c.dispatch ?? []).some((d) => d.component === id)) callers.push(`${c.id} (dispatch)`);
    }
    for (const s of subsystems) {
      if ((s.lifecycle ?? []).some((l) => l.component === id)) callers.push(`${s.id} (lifecycle)`);
    }
    return callers.sort();
  };

  // Steps 3-8: judge each Gateway; a mergeable one is planned onto working copies.
  const working = new Map<string, ComponentSpec>();
  const edit = (id: string): ComponentSpec => {
    let copy = working.get(id);
    if (!copy) {
      copy = structuredClone(byId.get(id)!);
      working.set(id, copy);
    }
    return copy;
  };
  const workingSubsystems = new Map<string, SubsystemSpec>();
  let workingSystem: SystemSpec | null = null;
  const merged: GatewayMerge[] = [];
  const refused: string[] = [];
  const planned: ComponentSpec[] = [];
  const refuse = (gateway: ComponentSpec, why: string): void => {
    refused.push(`Gateway "${gateway.id}" cannot be merged into a Portal: ${why}. ${GATEWAY_HAND_STEPS}`);
  };
  for (const gateway of gateways) {
    const portals = gateway.owns.filter((id) => byId.get(id)?.componentType === 'Portal');
    // Step 4: owns exactly one Portal, and no other narrative calls one of its own methods.
    if (portals.length === 0) { refuse(gateway, 'it owns no Portal'); continue; }
    if (portals.length > 1) { refuse(gateway, `it owns ${portals.length} Portals (${listed(portals)}), and a Gateway merges into exactly one`); continue; }
    const callers = callersOf(gateway.id);
    if (callers.length > 0) { refuse(gateway, `its own methods are called by ${listed(callers)}, and the Portal does not carry them`); continue; }
    const owners = components.filter((c) => c.id !== gateway.id && c.owns.includes(gateway.id)).map((c) => c.id);
    if (owners.length > 0) { refuse(gateway, `it is owned by ${listed(owners)}`); continue; }
    const portal = byId.get(portals[0])!;
    if (portal.variant !== undefined && portal.variant !== 'gateway') {
      refuse(gateway, `the Portal "${portal.id}" already has the variant "${portal.variant}"`);
      continue;
    }
    const ownContracts = contractIdsOf(gateway.id);
    const holders = [
      ...subsystems.map((s) => ({ id: s.id, entries: s.publicInterfaces })),
      ...(system ? [{ id: 'system', entries: system.publicInterfaces ?? [] }] : []),
    ];
    const narrowing = holders
      .filter((h) => h.entries.some((e) => e.component === gateway.id && e.interface !== undefined && ownContracts.has(e.interface)))
      .map((h) => h.id);
    if (narrowing.length > 0) { refuse(gateway, `the export of ${listed(narrowing)} narrows to its own contract`); continue; }

    // Step 5: the Portal takes the variant; the other owned members become its dependencies.
    const members = gateway.owns.filter((id) => id !== portal.id);
    const front = edit(portal.id);
    front.variant = 'gateway';
    front.dependsOn = [...new Set([...front.dependsOn.filter((d) => d !== gateway.id), ...members])];
    // Each consumer's dependency on the Gateway names the Portal.
    const consumers: string[] = [];
    for (const c of components) {
      if (c.id === gateway.id || c.id === portal.id || !c.dependsOn.includes(gateway.id)) continue;
      const copy = edit(c.id);
      copy.dependsOn = [...new Set(copy.dependsOn.map((d) => (d === gateway.id ? portal.id : d)))];
      consumers.push(c.id);
    }
    // Each L1 or L0 export naming the Gateway names the Portal.
    const exports: string[] = [];
    for (const s of subsystems) {
      const base = workingSubsystems.get(s.id) ?? s;
      if (!base.publicInterfaces.some((e) => e.component === gateway.id)) continue;
      const copy = structuredClone(base);
      copy.publicInterfaces = copy.publicInterfaces.map((e) => (e.component === gateway.id ? { ...e, component: portal.id } : e));
      workingSubsystems.set(s.id, copy);
      exports.push(s.id);
    }
    const l0: SystemSpec | null = workingSystem ?? system;
    if (l0?.publicInterfaces?.some((e) => e.component === gateway.id)) {
      const copy: SystemSpec = structuredClone(l0);
      copy.publicInterfaces = (copy.publicInterfaces ?? []).map((e) => (e.component === gateway.id ? { ...e, component: portal.id } : e));
      workingSystem = copy;
      exports.push('system');
    }
    merged.push({ gateway: gateway.id, portal: portal.id, members, consumers: consumers.sort(), exports });
    planned.push(gateway);
  }

  // Steps 9-10: without apply, nothing is written.
  if (!apply) return { merged, refused, applied: false };

  // Steps 11-14: write each merge — the Portals and consumers, the exports, then the deletions.
  const deleted = new Set(planned.map((g) => g.id));
  for (const copy of working.values()) if (!deleted.has(copy.id)) saveComponentSpec(copy);
  for (const copy of workingSubsystems.values()) saveSpec('subsystem', copy);
  if (workingSystem) saveSpec('system', workingSystem);
  for (const gateway of planned) {
    for (const impl of ownImplementationsOf(gateway.id)) deleteSpec('implementation', impl.id);
    for (const contract of contractsOf(gateway.id)) deleteSpec('interface', contract.id);
    deleteSpec('component', gateway.id);
  }
  // Step 15: the cache no longer reflects the merged tree.
  invalidateSpecCache();
  // Step 16: the plan, applied.
  return { merged, refused, applied: true };
}
