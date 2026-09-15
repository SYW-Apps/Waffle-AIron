import { loadComponentSpecs, saveComponentSpec, invalidateSpecCache } from './specs.js';
import { listProjectVariants, rebaseProjectVariants } from './variants.js';
import type { ComponentSpec, DependencyClass } from '../models/index.js';

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
// Gateways are not migrated here: STEREOTYPE_RETIRED gives their manual steps.
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
