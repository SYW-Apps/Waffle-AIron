import * as path from 'path';
import * as core from './adapters/core.js';
import * as chaining from './chaining-migration.js';
import * as transaction from './transaction.js';
import { getProjectRoot, getRequestParentReach, runWithProjectBinding, runWithProjectRoot } from '../utils/fs.js';
import type { ChainingMigrationPlan } from './chaining-migration.js';
import {
  blocked,
  isEmpty,
  rehearsalRoot,
  type FamilyMigrationReport,
  type FileChange,
  type MigrationPlan,
  type MigrationRequest,
  type PlannedEdit,
  type RecoveredTransaction,
  type Rehearsal,
} from './types.js';

// ---------------------------------------------------------------------------
// family_migration_orchestrator — the one migration shape every verb shares.
//
// plan: climb to the highest root in reach, read the family graph there,
// refuse while an earlier transaction is unfinished, route the request to the
// verb's planner, and — when nothing refuses — rehearse it: copy the family,
// run the verb's own writes on the copy, and answer the copy's difference as
// the plan's file changes with the projects to re-lock. apply: commit a
// confirmed plan's rehearsal through the family transaction. discard: drop it.
// recover: doctor's entry to the transaction's crash recovery.
//
// It knows the verbs only by which planner and writer to call; the transaction
// knows nothing about verbs. It holds no state (the plan is a value its caller
// holds between plan and apply) and never locks. The caller must gate on reach
// itself.
//
// Stage 6 wave A: the chaining migration is the verb on the transaction; the
// membership, identity and boundary verbs join in wave B.
// ---------------------------------------------------------------------------

/** Steps 1-3: the highest root in reach, and whether it is the family's true top. */
function climb(start: string): { top: string; whole: boolean } {
  let current = start;
  let parent: { parentRoot: string } | null;
  let whole = true;
  do {
    // Step 2: null for a top root — and for a hop the request may not read.
    parent = runWithProjectRoot(current, () => core.resolveChainingParent());
    // Step 3.
    if (parent) current = parent.parentRoot;
  } while (parent);
  const reach = getRequestParentReach();
  if (reach !== null && !reach.parentReach) whole = false;
  return { top: current, whole };
}

/** ifamily_migration_orchestrator.plan — plan a family migration from the bound project. Writes nothing into the family. */
export function plan(request: MigrationRequest): MigrationPlan {
  // Step 1: the bound root; every hop below is a scoped binding, so the caller's binding is restored on every path.
  const bound = getProjectRoot();
  const { top, whole } = climb(bound);
  // Step 4: the project graph of the highest root reached.
  runWithProjectRoot(top, () => core.projectFamily());
  // Steps 5-7: an unfinished transaction refuses the plan.
  const pending = unfinished(top, bound);
  if (pending.length > 0) return refusedForPending(request, top, whole, pending);
  // Steps 8-23: the verb's planner.
  const plan = route(request);
  // Steps 24-25: rehearse (an already-refused plan comes back unchanged).
  return rehearse(plan);
}

/** Step 5: the transactions a crash left under the family root and the bound root, writing nothing. */
function unfinished(top: string, bound: string): RecoveredTransaction[] {
  const found = transaction.recover(top, false);
  if (path.resolve(bound) !== path.resolve(top)) found.push(...transaction.recover(bound, false));
  return found.filter((t, i) => found.findIndex((u) => u.id === t.id) === i);
}

/** Step 7. */
function refusedForPending(request: MigrationRequest, top: string, whole: boolean, pending: RecoveredTransaction[]): MigrationPlan {
  return {
    request, familyRoot: top, whole, edits: [], changes: [], relock: [], notes: [],
    refusals: pending.map((t) => ({
      code: 'transaction-pending',
      project: t.owners[0] ?? top,
      detail: `the ${t.verb} migration ${t.id} is unfinished (coordinator phase ${t.phase}) — run \`wairon doctor --fix\` to roll it back first`,
    })),
  };
}

/** Step 8: route the request to its verb's planner. */
function route(request: MigrationRequest): MigrationPlan {
  switch (request.verb) {
    case 'chaining':
      // Step 21.
      return fromChaining(request, chaining.plan());
    default:
      throw new Error(`the "${request.verb}" family migration is not available yet (stage 6 wave B)`);
  }
}

/** Step 21: the chaining migration's plan carried whole — its blocking findings become refusals, its writes edits. */
function fromChaining(request: MigrationRequest, plan: ChainingMigrationPlan): MigrationPlan {
  return {
    request,
    familyRoot: plan.familyRoot,
    whole: plan.whole,
    edits: chainingEdits(plan),
    refusals: plan.findings.filter((f) => f.blocking).map((f) => ({ code: f.kind, project: f.project, detail: f.detail })),
    changes: [],
    relock: [],
    notes: [],
    chaining: plan,
  };
}

/** A chaining plan's writes as the semantic edits a person reads, owners in walk order. */
function chainingEdits(plan: ChainingMigrationPlan): PlannedEdit[] {
  const edits: PlannedEdit[] = [];
  for (const p of plan.projects) {
    const add = (kind: string, detail: string): void => { edits.push({ project: p.project, kind, detail }); };
    if (p.idToWrite !== undefined) add('id', `id: ${p.idToWrite}`);
    if (p.createsSystem) add('export', 'a minimal L0');
    for (const e of p.exports) add('export', `export ${e.component ?? e.typeDef} as ${e.publicName}`);
    for (const e of p.externals) add('external', `externals: ${e.alias}`);
    for (const m of p.members) add('member', `members: ${m.alias} (moved from its legacy mount)`);
    for (const i of p.imports) add('reference', `use ${i.alias}::${i.name}`);
    for (const key of p.supersededPins) add('pin', `family pin ${key} removed`);
    for (const alias of p.pins) add('pin', `pin ${alias}`);
  }
  for (const r of plan.rewrites) {
    edits.push({ project: r.project, kind: 'reference', detail: `${r.specId} (${r.position}): ${r.from} → ${r.to}`, reference: { kind: r.kind, specId: r.specId, position: r.position, from: r.from, to: r.to } });
  }
  return edits;
}

/** ifamily_migration_orchestrator.rehearse — run the verb's writes on a copy; its difference is the plan's file changes. */
export function rehearse(plan: MigrationPlan): MigrationPlan {
  // Steps 1-2: nothing is rehearsed for a refused plan or a counts-only one.
  if (blocked(plan) || plan.request.rehearse === false) return plan;
  // Step 3: the projects the rehearsal copies.
  const family = runWithProjectRoot(plan.familyRoot, () => core.projectFamily());
  // Step 4.
  const rehearsal = transaction.rehearse({ familyRoot: plan.familyRoot, projects: family.nodes.map((n) => n.directory) });
  // Steps 5-14: the verb's own writes on the copy; a writer's refusal ends the region.
  try {
    onCopy(rehearsal, () => writeVerb(plan, rehearsal));
  } catch (e) {
    // Steps 18-19.
    transaction.discard(rehearsal);
    const detail = e instanceof Error ? e.message : String(e);
    return { ...plan, refusals: [...plan.refusals, { code: `${plan.request.verb}-refused`, project: '', detail }] };
  }
  // Step 15: the copy's difference from the live family.
  const changes = transaction.diff(rehearsal);
  // Steps 16-17.
  return { ...plan, rehearsal, changes, relock: relockOf(changes) };
}

/** Steps 6-14: which writer. */
function writeVerb(plan: MigrationPlan, rehearsal: Rehearsal): void {
  switch (plan.request.verb) {
    case 'chaining':
      // Step 13: ids, exports, externals, the position migration, and pins LAST — its order unchanged.
      chaining.write(plan.chaining!, rehearsal);
      return;
    default:
      throw new Error(`the "${plan.request.verb}" family migration is not available yet (stage 6 wave B)`);
  }
}

/**
 * Run the writers under the caller's reach, carried onto the copy: a hosted
 * request's reach names live roots, and the copy's roots stand in for them —
 * so a writer run on the copy may read exactly as far as it could live.
 */
function onCopy<T>(rehearsal: Rehearsal, run: () => T): T {
  const reach = getRequestParentReach();
  if (reach === null) return run();
  const top = reach.topRoot !== undefined ? rehearsalRoot(rehearsal, reach.topRoot) : rehearsal.directory;
  return runWithProjectBinding(rehearsalRoot(rehearsal, getProjectRoot()), { topRoot: top, parentReach: reach.parentReach, ...(reach.narrowed ? { narrowed: true } : {}) }, run);
}

/** Step 16: each changed owner that carries a lock is a project to re-lock. */
function relockOf(changes: FileChange[]): string[] {
  const owners = [...new Set(changes.map((c) => c.project))];
  return owners.filter((owner) => core.approvalRecord(owner) !== null);
}

/** ifamily_migration_orchestrator.apply — commit a confirmed plan all or nothing. */
export function apply(plan: MigrationPlan): FamilyMigrationReport {
  // Steps 1-3: a refused plan writes nothing.
  if (blocked(plan)) {
    if (plan.rehearsal) transaction.discard(plan.rehearsal);
    return { plan: plan, applied: false, relock: [] };
  }
  // Steps 4-5: a plan made without a rehearsal (doctor's chaining plan, confirmed as printed) is rehearsed now.
  const current = plan.rehearsal ? plan : rehearse({ ...plan, request: { ...plan.request, rehearse: true } });
  // Steps 6-8: refused on the copy, or nothing to do.
  if (blocked(current) || isEmpty(current)) {
    if (current.rehearsal) transaction.discard(current.rehearsal);
    return { plan: current, applied: false, relock: [] };
  }
  // Step 9: all or nothing.
  const outcome = transaction.commit(current.rehearsal!, current.changes, current.request.verb);
  // Step 10: no cached scan is dropped by hand — no contract into sdd_core
  // offers it. The core's spec workspace re-verifies its file signature on the
  // first read of every new root binding (and at most 2 s later otherwise),
  // and every swapped file carries a new mtime and usually a new size, so the
  // next read that re-verifies sees the swapped files.
  // Step 11.
  return { plan: current, applied: outcome.committed, outcome, relock: outcome.committed ? current.relock : [] };
}

/** ifamily_migration_orchestrator.discard — drop a plan's rehearsal, if it holds one. */
export function discard(plan: MigrationPlan): void {
  if (plan.rehearsal) transaction.discard(plan.rehearsal);
}

/** ifamily_migration_orchestrator.recover — report or resolve the unfinished transactions under a root. */
export function recover(root: string, fix: boolean): RecoveredTransaction[] {
  return transaction.recover(root, fix);
}
