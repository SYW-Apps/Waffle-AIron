import * as path from 'path';
import * as core from './adapters/core.js';
import * as chaining from './chaining-migration.js';
import * as membership from './membership.js';
import * as identity from './identity.js';
import * as boundary from './boundary.js';
import * as transaction from './transaction.js';
import { getHostedLookup, getProjectRoot, getRequestParentReach, getWriteReach, runWithHostedLookup, runWithProjectBinding, runWithProjectRoot, writeReachDenials } from '../utils/fs.js';
import type { ChainingMigrationPlan } from './chaining-migration.js';
import type { ProjectFamily } from '../models/project-family.js';
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
  type TransactionScope,
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
  // Step 4: the project graph of the highest root reached, and the bound project's key in it.
  const family = runWithProjectRoot(top, () => core.projectFamily());
  const boundKey = family.nodes.find((n) => path.resolve(n.directory) === path.resolve(bound))?.namespace ?? '';
  // Steps 5-7: an unfinished transaction refuses the plan — under the
  // relocation's coordinator too, which journals a hosted detach or adopt.
  const pending = unfinished(top, bound, request.relocation?.coordinator);
  if (pending.length > 0) return refusedForPending(request, top, whole, pending);
  // Steps 8-23: the verb's planner — a verb reads the live family under the top root's binding; the chaining migration climbs from the caller's.
  const planned = request.verb === 'chaining' ? route(request, family, boundKey) : runWithProjectRoot(top, () => route(request, family, boundKey));
  // Steps 24-25: rehearse (an already-refused plan comes back unchanged).
  return rehearse(request.verb === 'chaining' ? planned : { ...planned, familyRoot: top, whole });
}

/** Step 5: the transactions a crash left under the family root and the bound root, writing nothing. */
function unfinished(top: string, bound: string, coordinator?: string): RecoveredTransaction[] {
  const found = transaction.recover(top, false);
  if (path.resolve(bound) !== path.resolve(top)) found.push(...transaction.recover(bound, false));
  if (coordinator !== undefined) found.push(...transaction.recover(coordinator, false));
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
function route(request: MigrationRequest, family: ProjectFamily, bound: string): MigrationPlan {
  switch (request.verb) {
    case 'attach':
      // Step 9.
      return membership.planAttach(family, bound, request);
    case 'detach':
      // Step 11.
      return membership.planDetach(family, bound, request);
    case 'adopt':
      // Step 13.
      return membership.planAdopt(family, bound, request);
    case 'rename':
      // Step 15.
      return identity.planRename(family, bound, request);
    case 'rename-alias':
      // Step 17.
      return identity.planAliasRename(family, bound, request);
    case 'internalize':
    case 'externalize':
    case 'promote':
    case 'demote':
      // Step 19: a boundary or storage verb, through the boundary migration's one entry.
      return boundary.plan(family, bound, request);
    case 'chaining':
      // Step 21: its own climb, from the caller's binding.
      return fromChaining(request, chaining.plan());
    default:
      throw new Error(`there is no "${request.verb}" family migration: attach | detach | adopt | rename | rename-alias | internalize | externalize | promote | demote | chaining`);
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
  // Step 4: every family project, a project the verb brings in (attach, adopt), and every
  // producer a family project names by a path inside the family root (a pin reads it).
  const projects = [...family.nodes.map((n) => n.directory), ...broughtIn(plan, family), ...pathProducers(plan, family), ...partDirectories(plan, family)];
  const rehearsal = transaction.rehearse(scopeOf(plan, projects));
  // Steps 5-14: the verb's own writes on the copy; a writer's refusal ends the region.
  try {
    onCopy(rehearsal, () => relocatedLookup(plan, rehearsal, () => writeVerb(plan, rehearsal)));
  } catch (e) {
    // Steps 18-19.
    transaction.discard(rehearsal);
    const detail = e instanceof Error ? e.message : String(e);
    return { ...plan, refusals: [...plan.refusals, { code: `${plan.request.verb}-refused`, project: '', detail }] };
  }
  // Step 15: the copy's difference from the live family.
  const changes = transaction.diff(rehearsal);
  // Steps 16-18: a hosted request may write only the family records it may
  // write, and a family migration reshapes its projects whole: a plan that must
  // write any other refuses family-partial, and one that must change a project
  // holding a subsystem the request may not change refuses subsystem-denied —
  // each named, the subsystem with the rung that decided it.
  const refused = [
    ...unwritableOwners(changes).map((o) => ({ code: 'family-partial', project: o, detail: `the plan must write ${o}, which this request may not write` })),
    ...deniedSubsystems(changes),
  ];
  if (refused.length > 0) {
    transaction.discard(rehearsal);
    return { ...plan, refusals: [...plan.refusals, ...refused] };
  }
  // Steps 19-20.
  return { ...plan, rehearsal, changes, relock: relockOf(plan, changes) };
}

/** The relocated project's directory and where it goes, when the plan moves one (a hosted detach or adopt). */
function movedOf(plan: MigrationPlan): { from: string; to: string } | null {
  const relocation = plan.request.relocation;
  const move = plan.edits.find((e) => e.write?.call === 'move');
  if (!relocation || !move?.write) return null;
  return { from: path.resolve(move.write.root), to: path.resolve(relocation.to) };
}

/**
 * Step 4: what the rehearsal copies. A family migration copies every project's
 * .wai tree under the family root. A relocated plan is coordinated by the host
 * data directory instead — an owner itself, contributing its store files — and
 * names the moved project's old directory and its new root whole, so the move,
 * the family edits and the host store writes commit as one transaction.
 */
function scopeOf(plan: MigrationPlan, projects: string[]): TransactionScope {
  const relocation = plan.request.relocation;
  const moved = movedOf(plan);
  if (!relocation || !moved) return { familyRoot: plan.familyRoot, projects };
  return {
    familyRoot: relocation.coordinator,
    projects: [relocation.coordinator, ...projects],
    areas: ['.wai', ...relocation.areas],
    whole: [moved.from, moved.to],
  };
}

/**
 * Run the writers with the hosted record lookup answering a project at its
 * image in the copy — the relocated project at its new place — so a pin taken
 * on the copy reads the producer as the commit will leave it. Outside a
 * relocated plan the writers run unchanged.
 */
function relocatedLookup<T>(plan: MigrationPlan, rehearsal: Rehearsal, run: () => T): T {
  const moved = movedOf(plan);
  const live = getHostedLookup();
  if (!moved || !live) return run();
  const copied = [...rehearsal.roots.keys(), ...(rehearsal.whole ?? [])].filter((r) => r !== path.resolve(rehearsal.familyRoot));
  const inside = (root: string, dir: string): boolean => {
    const rel = path.relative(root, dir);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  return runWithHostedLookup((id) => {
    const root = live(id);
    if (root === null) return null;
    const at = path.resolve(root);
    if (inside(moved.from, at)) return path.join(rehearsalRoot(rehearsal, moved.to), path.relative(moved.from, at));
    return copied.some((r) => inside(r, at)) ? rehearsalRoot(rehearsal, at) : at;
  }, run);
}

/** The changed owners the hosted request may not write (none outside a hosted request). */
function unwritableOwners(changes: FileChange[]): string[] {
  const denied = getRequestParentReach()?.unwritableRoots ?? [];
  if (denied.length === 0) return [];
  const owners = [...new Set(changes.map((c) => path.resolve(c.project)))];
  return owners.filter((o) => denied.includes(o));
}

/** Step 16: each subsystem of a changed owner the hosted request may not change (none outside a hosted request). */
function deniedSubsystems(changes: FileChange[]): MigrationPlan['refusals'] {
  const reach = getWriteReach();
  if (!reach) return [];
  const owners = [...new Set(changes.map((c) => path.resolve(c.project)))];
  return owners.flatMap((o) => writeReachDenials(reach, o).map((s) => ({
    code: 'subsystem-denied',
    project: o,
    detail: `the plan must change ${o}, which holds subsystem "${s.subsystemId}" this request may not change (decided by ${s.decidedBy}); a family migration reshapes its projects whole, so it needs write on every subsystem of every project it changes`,
  })));
}

/** Step 4: the producers family projects name by a path inside the family root — a pin taken on the copy reads them there. */
function pathProducers(plan: MigrationPlan, family: ProjectFamily): string[] {
  const inside = (dir: string): boolean => {
    const rel = path.relative(plan.familyRoot, dir);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  return family.nodes.flatMap((n) => n.externals.filter((e) => e.sourceKind === 'path' && e.directory && inside(e.directory)).map((e) => e.directory!));
}

/**
 * Step 4 (stage 8): each family project's parts stored inside the family root
 * — the project's own subsystems in another folder, which a promote, demote,
 * internalize or externalize writes — and the sibling checkout (a part or a
 * project member stored at `../`) the verb acts on: the family transaction
 * lays it out beside the family, so its files change all-or-nothing with the
 * rest (each repository still gets its own commit). A git member is never an
 * owner: its files are the fetch cache's. A folder an externalize creates
 * needs no copy: the rehearsal finds every .wai tree it holds.
 */
function partDirectories(plan: MigrationPlan, family: ProjectFamily): string[] {
  const inside = (dir: string): boolean => {
    const rel = path.relative(plan.familyRoot, dir);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const subject = plan.request.alias;
  const parts = family.nodes.flatMap((n) => n.parts.filter((p) => p.storage !== 'git' && p.directory !== undefined
    && (inside(p.directory) || p.alias === subject)).map((p) => p.directory!));
  const siblings = family.nodes.flatMap((n) => n.externals.filter((e) => e.role === 'member' && e.sourceKind === 'path'
    && e.directory !== undefined && e.alias === subject).map((e) => e.directory!));
  return [...parts, ...siblings];
}

/** Step 4: the roots a verb writes that the family graph does not hold yet — a project attached or adopted. */
function broughtIn(plan: MigrationPlan, family: ProjectFamily): string[] {
  const known = new Set(family.nodes.map((n) => path.resolve(n.directory)));
  return [...new Set(plan.edits.flatMap((e) => (e.write ? [path.resolve(e.write.root)] : [])))].filter((r) => !known.has(r));
}

/** Steps 6-14: which writer. */
function writeVerb(plan: MigrationPlan, rehearsal: Rehearsal): void {
  switch (plan.request.verb) {
    case 'attach':
    case 'detach':
    case 'adopt':
      // Step 7.
      membership.write(plan, rehearsal);
      return;
    case 'rename':
    case 'rename-alias':
      // Step 9.
      identity.write(plan, rehearsal);
      return;
    case 'internalize':
    case 'externalize':
    case 'promote':
    case 'demote':
      // Step 11.
      boundary.write(plan, rehearsal);
      return;
    case 'chaining':
      // Step 13: ids, exports, externals, the position migration, and pins LAST — its order unchanged.
      chaining.write(plan.chaining!, rehearsal);
      return;
    default:
      throw new Error(`there is no "${plan.request.verb}" family migration`);
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

/**
 * Step 16: each changed owner that carries a lock is a project to re-lock. A
 * rename lists every owner it writes, lock or none, the renamed project first:
 * the id is part of what any approval of them names. An owner the plan takes
 * apart (its project.yaml deleted, an internalized member) has nothing left to
 * re-lock.
 */
function relockOf(plan: MigrationPlan, changes: FileChange[]): string[] {
  const ended = new Set(changes.filter((c) => c.action === 'delete' && c.path === '.wai/project.yaml').map((c) => path.resolve(c.project)));
  const owners = [...new Set(changes.map((c) => path.resolve(c.project)))].filter((o) => !ended.has(o));
  // A relocated project carries its lock to its new root, where it is re-locked.
  const moved = movedOf(plan);
  const relocated = moved !== null && core.approvalRecord(moved.from) !== null ? [moved.to] : [];
  if (plan.request.verb !== 'rename') return [...owners.filter((owner) => core.approvalRecord(owner) !== null), ...relocated];
  const renamed = plan.edits.find((e) => e.write?.call === 'renameId')?.write?.root;
  const first = renamed !== undefined ? path.resolve(renamed) : undefined;
  return [...owners.filter((o) => o === first), ...owners.filter((o) => o !== first)];
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
