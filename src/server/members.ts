import * as fs from 'fs';
import * as path from 'path';
import {
  declaredSubsystemIds,
  partSubsystemIds,
  listFamilyRecords,
  listProjectRecords,
  planMemberRecords,
  projectRepositoryScope,
  registerMemberRecord,
  registerProjectRecord,
  removeProjectRecord,
  setProjectRecordStatus,
  SUBPROJECT_SEPARATOR,
} from './projects.js';
import { gatherPermissionWorld, resolveFamilyReach } from './authorization.js';
import { listUsers, remapUnitReferences } from './users.js';
import { listCredentials, renarrowCredential } from './credentials.js';
import { remapScope, listAssignments, setAssignment } from './permissions.js';
import { deletePlacement, listProjectPlacements, placeProject } from './organization.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { relink, compare, narrowing, carryPlan } from './member-reach.js';

/** The subject a carry plan names for everyone without settings of their own. */
const EVERYONE = 'everyone';
import * as hostMigrations from './adapters/migrations.js';
import * as hostGit from './adapters/git.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { parseMemberSource } from '../models/project.js';
import type { ProjectBinding } from './projects.js';
import type { MigrationFinding } from './migration.js';
import type { GitPublish } from '../git/types.js';
import type { FileChange, MigrationPlan, MigrationRequest, RecoveredTransaction, Rehearsal, TransactionOutcome } from '../migrations/types.js';
import type {
  AuditEvent,
  CarriedSubsystemRule,
  EffectivePermission,
  HostedProjectRecord,
  MemberAdoption,
  MemberDetachment,
  MemberReconciliation,
  MembershipScreen,
  PermissionAssignment,
  PermissionValue,
  PermissionWorld,
  PlannedMemberRecord,
  PlannedNarrowing,
  Principal,
  PrincipalSubject,
  ProjectParentLink,
  ReachComparison,
  RepositoryScope,
} from './types.js';

// ---------------------------------------------------------------------------
// Member Registration (sdd_host)
//
// The workflow that makes every member of a hosted family a hosted project
// record. It never writes a grant and never a placement: projects nest like
// organization units, so a member's reach is inherited through its chain (its
// own scope, its parents', its family root's units) and the most specific
// setting wins.
//
// (1) The stage-7 upgrade of a data dir (`wairon host doctor`, applied with
// --fix): plan registers every declared member, members of members included,
// rewrites member-qualified API key entries to record ids, and proves before
// writing that nobody's reach changes. Its writes are made by the ordinary
// repositories wired to a rehearsal copy of the data root, and apply commits
// them through stage 6's family transaction — the data directory as the one
// owner, the project-record and credential store files as its areas — all or
// nothing, then audits each member and key.
// (2) Family upkeep around a data-plane tool: recover rolls back a crashed
// family migration before the tool runs; screen lists who gains access through
// an attach and refuses renaming a family root; detach and adopt serve hosted
// detach and adopt whole — each RELOCATES the project between its family's
// tree and an isolated root of its own (the move, the family edits with hosted
// external sources and the host store writes in one transaction) and lists and
// audits the reach it changes; reconcile, after a family-shape tool succeeded,
// registers, relocates, re-keys or disables member records, lists and audits
// the reach those changes altered, and publishes ONE family commit.
// (3) recoverData rolls back what a crash left under the data directory itself
// — a crashed upgrade, or a detach or adopt it coordinated — before serving
// and from `wairon host doctor`.
//
// It holds no state: a plan is a value its caller holds between plan and apply.
// ---------------------------------------------------------------------------

/** The store files the upgrade writes, relative to the data directory. */
const UPGRADE_AREAS = ['projects.json', 'auth/credentials.json'];

/** The journal verb of the upgrade's transaction. */
const UPGRADE_VERB = 'member-upgrade';

/** The operator behind `wairon host doctor --fix`: authority is access to the data directory. */
const OPERATOR: PrincipalSubject = { userId: 'operator:host-doctor', kind: 'service', issuer: 'local' };

/** The stage-7 upgrade, planned and not yet applied. */
export interface MemberUpgradePlan {
  /** Every declared member, family roots' members first, depth-first. */
  members: PlannedMemberRecord[];
  /** The no-widening proof: every subject x capability x member, before and after. */
  reach: ReachComparison[];
  /** Every API key with a member-qualified entry, rewritten to record ids. */
  narrowings: PlannedNarrowing[];
  /** What blocks the whole plan. */
  refusals: MigrationFinding[];
  /** The host store files the apply would replace, from the rehearsal. */
  changes: FileChange[];
  /** The rehearsal the writes were made into; absent once applied or discarded. */
  rehearsal?: Rehearsal;
}

/** The answer of the upgrade: the plan as reported, whether it was applied, and the outcome. */
export interface MemberUpgradeReport {
  plan: MemberUpgradePlan;
  applied: boolean;
  outcome?: TransactionOutcome;
  /** What a crash left unfinished under the data directory, found before planning (resolved with --fix). */
  recovered: RecoveredTransaction[];
}

const isWrite = (m: PlannedMemberRecord): boolean => m.action === 'register' || m.action === 'relocate';

// ── plan ────────────────────────────────────────────────────────────────────

/** imember_registration.plan — plan the stage-7 upgrade; an unblocked plan holds a rehearsal with its writes made. */
export function plan(dataDir: string): MemberUpgradePlan {
  // Step 1.
  const records = listProjectRecords(dataDir);
  // Steps 2-3: every family root's declared members.
  const members = records.filter((r) => !r.parentProjectId).flatMap((r) => planMemberRecords(dataDir, r.id));
  // Step 4.
  const refusals = memberRefusals(records, members);
  // Steps 5-6.
  const world = gatherPermissionWorld(dataDir);
  const users = listUsers(dataDir);
  // Step 7.
  const registering = members.filter((m) => m.action === 'register');
  refusals.push(...settingRefusals(world, users, registering));
  // Step 8.
  const after = relink(world, members.filter(isWrite).map((m) => ({ projectId: m.record.id, parentProjectId: m.record.parentProjectId as string })), [], [], []);
  // Steps 9-10: the no-widening proof.
  const reach = registering.flatMap((m) => compare(users, world, m.familyRootId, after, m.record.id).map((row) => ({ ...row, memberId: m.record.id })));
  for (const row of reach.filter((r) => !r.equal)) {
    refusals.push({ area: 'reach', detail: `${row.memberId}: ${row.subjectId} ${row.capability} would change from ${row.before.value} to ${row.after.value}` });
  }
  // Steps 11-13.
  const narrowings = listCredentials(dataDir, '*')
    .map((key) => narrowing(key, members))
    .filter((n): n is PlannedNarrowing => n !== null);
  const result: MemberUpgradePlan = { members, reach, narrowings, refusals, changes: [] };
  // Steps 14-15: a blocked or empty plan opens no rehearsal.
  if (refusals.length > 0 || (!members.some(isWrite) && narrowings.length === 0)) return result;
  // Steps 16-22.
  return rehearsed(dataDir, result);
}

/** Steps 16-22: the writes made into a rehearsal copy of the host stores, and their file changes. */
function rehearsed(dataDir: string, planned: MemberUpgradePlan): MemberUpgradePlan {
  const root = path.resolve(dataDir);
  // Step 16.
  const rehearsal = hostMigrations.rehearse({ familyRoot: root, projects: [root], areas: UPGRADE_AREAS });
  try {
    const copy = rehearsal.roots.get(root) as string;
    // Steps 17-18: family roots' members first, so a parent record exists before its members.
    for (const m of planned.members.filter(isWrite)) {
      registerMemberRecord(copy, { ...m.record, rootPath: '' });
    }
    // Steps 19-20.
    for (const n of planned.narrowings) renarrowCredential(copy, n.keyId, n.after);
    // Steps 21-22.
    return { ...planned, rehearsal, changes: hostMigrations.diff(rehearsal) };
  } catch (e) {
    hostMigrations.drop(rehearsal);
    throw e;
  }
}

/** Step 4: a member id another record holds, a member declared twice, an unreadable member. */
function memberRefusals(records: HostedProjectRecord[], members: PlannedMemberRecord[]): MigrationFinding[] {
  const refusals: MigrationFinding[] = [];
  const seen = new Map<string, string>();
  for (const m of members) {
    if (m.action === 'unreadable') {
      refusals.push({ area: 'members', detail: `${m.qualifier} (at "${m.record.memberPath}" in ${m.record.parentProjectId}) is unreadable: ${m.reason ?? 'its directory or project.yaml cannot be read'}` });
      continue;
    }
    const twice = seen.get(m.record.id);
    if (twice !== undefined) refusals.push({ area: 'members', detail: `${m.record.id} is declared twice (${twice} and ${m.qualifier})` });
    seen.set(m.record.id, m.qualifier);
    const holder = records.find((r) => r.id === m.record.id);
    if (m.action === 'relocate' && holder && (!holder.parentProjectId || familyRootIdOf(records, holder) !== m.familyRootId)) {
      refusals.push({ area: 'members', detail: `${m.qualifier}: the id ${m.record.id} is already held by another record (${holder.parentProjectId ? 'a member of another family' : 'a family root'})` });
    }
  }
  return refusals;
}

/** The family root id a record climbs to. */
function familyRootIdOf(records: HostedProjectRecord[], record: HostedProjectRecord): string {
  let current = record;
  const seen = new Set<string>();
  while (current.parentProjectId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = records.find((r) => r.id === current.parentProjectId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

/** Step 7: a member to register whose id already has a setting scoped at it would decide before the inherited chain. */
function settingRefusals(
  world: PermissionWorld,
  users: { id: string; roleBindings?: { scopeKind?: string; scopeId?: string }[] }[],
  registering: PlannedMemberRecord[],
): MigrationFinding[] {
  const refusals: MigrationFinding[] = [];
  for (const m of registering) {
    const id = m.record.id;
    const assigned = world.assignments.some((a) => a.scopeKind === 'project' && a.scopeId === id);
    const bound = users.some((u) => (u.roleBindings ?? []).some((b) => b.scopeKind === 'project' && b.scopeId === id));
    if (assigned || bound) {
      refusals.push({ area: 'reach', detail: `${m.qualifier}: the id ${id} already has a setting scoped at it (an assignment or role binding left by an earlier record) — it would decide before the inherited chain` });
    }
  }
  return refusals;
}

// ── apply / discard ─────────────────────────────────────────────────────────

/** imember_registration.apply — commit a confirmed, unblocked plan all or nothing, and audit it. */
export function apply(dataDir: string, plan: MemberUpgradePlan): MemberUpgradeReport {
  const planned = plan;
  // Steps 1-2.
  if (planned.refusals.length > 0 || !planned.rehearsal) {
    throw new Error('the member upgrade plan is blocked or holds nothing to apply');
  }
  // Step 3.
  const outcome = hostMigrations.commit(planned.rehearsal, planned.changes, UPGRADE_VERB);
  const reported: MemberUpgradePlan = { ...planned, rehearsal: undefined };
  // Step 4.
  if (!outcome.committed) {
    // Steps 10-11.
    audit(dataDir, {
      action: 'member.upgrade', outcome: 'failed', level: 'warning',
      metadata: JSON.stringify({ failure: outcome.failure, restored: outcome.restored, unrestored: outcome.unrestored }),
    });
    return { plan: reported, applied: false, outcome, recovered: [] };
  }
  // Steps 5-6.
  for (const m of planned.members.filter(isWrite)) {
    const rows = planned.reach.filter((r) => r.memberId === m.record.id);
    audit(dataDir, {
      action: 'member.registered', outcome: 'success', level: 'info',
      projectId: m.record.id, composition: m.familyRootId, target: m.record.id,
      metadata: JSON.stringify({ parent: m.record.parentProjectId, memberPath: m.record.memberPath, action: m.action, reachRows: rows.length, allEqual: rows.every((r) => r.equal) }),
    });
  }
  // Steps 7-8.
  for (const n of planned.narrowings) {
    audit(dataDir, {
      action: 'token.narrowed', outcome: 'success', level: 'security', target: n.keyId,
      metadata: JSON.stringify({ before: n.before, after: n.after, widening: n.widening }),
    });
  }
  // Step 9.
  return { plan: reported, applied: true, outcome, recovered: [] };
}

/** imember_registration.discard — drop a plan's rehearsal without applying it. */
export function discard(plan: MemberUpgradePlan): void {
  // Steps 1-2.
  if (plan.rehearsal) hostMigrations.drop(plan.rehearsal);
}

/** One best-effort upgrade audit event by the operator. */
function audit(dataDir: string, fields: Partial<AuditEvent> & { action: string; outcome: string; level: string }): void {
  const event: AuditEvent = { id: '', timestamp: '', category: 'project', actor: OPERATOR, ...fields };
  try {
    appendAuditEvent(dataDir, event, DEFAULT_AUDIT_POLICY);
  } catch (e) {
    console.error(`[sdd_host] audit append failed for ${event.action}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── pending ─────────────────────────────────────────────────────────────────

/** imember_registration.pending — how many declared members hold no record yet. Reads only. */
export function pending(dataDir: string): number {
  // Steps 1-4.
  return listProjectRecords(dataDir)
    .filter((r) => !r.parentProjectId)
    .flatMap((r) => planMemberRecords(dataDir, r.id))
    .filter((m) => m.action === 'register').length;
}

// ── recover ─────────────────────────────────────────────────────────────────

/**
 * imember_registration.recover — roll back every family migration a crash left
 * unfinished under the bound family's roots (the family root's root and, when
 * different, the bound project's), and audit each as migration.recovered. A
 * failure is logged and never fails the request.
 */
export function recoverUnfinishedMigrations(dataDir: string, principal: Principal, binding: ProjectBinding): RecoveredTransaction[] {
  const familyRoot = listProjectRecords(dataDir).find((r) => r.id === binding.familyRootId);
  const roots: { root: string; projectId: string }[] = [];
  if (familyRoot?.rootPath) roots.push({ root: familyRoot.rootPath, projectId: familyRoot.id });
  if (!roots.some((r) => path.resolve(r.root) === path.resolve(binding.rootPath))) roots.push({ root: binding.rootPath, projectId: binding.projectId });
  const found: RecoveredTransaction[] = [];
  // Steps 1-2.
  for (const { root, projectId } of roots) {
    let here: RecoveredTransaction[];
    try {
      here = hostMigrations.recover(root, true);
    } catch (e) {
      console.error(`[sdd_host] family-migration recovery failed for project ${projectId}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    // Steps 3-4.
    for (const t of here) auditRecovery(dataDir, principal, projectId, t);
    found.push(...here);
  }
  // Step 5.
  return found;
}

/** Step 4: one migration.recovered audit event and server log line per transaction. */
function auditRecovery(dataDir: string, principal: Principal, projectId: string, t: RecoveredTransaction): void {
  console.error(`[sdd_host] project ${projectId}: unfinished family migration ${t.id} (${t.verb}, coordinator phase ${t.phase}) — ${t.action}`);
  const actor: PrincipalSubject = principal.subject ?? { userId: `token:${principal.tokenId}`, kind: 'service', issuer: 'local' };
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level: t.action === 'refused' ? 'warning' : 'info',
    category: 'project',
    action: 'migration.recovered',
    outcome: t.action === 'refused' ? 'failed' : 'success',
    actor,
    tokenId: principal.tokenId,
    projectId,
    target: t.id,
    metadata: JSON.stringify({ verb: t.verb, phase: t.phase, action: t.action }),
  };
  try {
    appendAuditEvent(dataDir, event, DEFAULT_AUDIT_POLICY);
  } catch (e) {
    console.error(`[sdd_host] audit append failed for migration.recovered (target=${t.id}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── recoverData ─────────────────────────────────────────────────────────────

/**
 * imember_registration.recoverData — every transaction a crash left unfinished
 * under the data directory (a crashed upgrade, or a hosted detach or adopt the
 * data directory coordinated), resolved and audited with fix, only reported
 * without it. A failure is logged and answers nothing; it never prevents the
 * server from starting.
 */
export function recoverData(dataDir: string, fix: boolean): RecoveredTransaction[] {
  // Step 1.
  let found: RecoveredTransaction[];
  try {
    found = hostMigrations.recover(path.resolve(dataDir), fix);
  } catch (e) {
    console.error(`[sdd_host] recovery under the data directory failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
  // Steps 2-3: a resolved transaction is audited and logged; a report-only pass writes nothing.
  if (fix) {
    for (const t of found) {
      console.error(`[sdd_host] data directory: unfinished ${t.verb} transaction ${t.id} (coordinator phase ${t.phase}) — ${t.action}`);
      audit(dataDir, {
        action: 'migration.recovered', outcome: t.action === 'refused' ? 'failed' : 'success', level: t.action === 'refused' ? 'warning' : 'info',
        target: t.id, metadata: JSON.stringify({ verb: t.verb, phase: t.phase, action: t.action, owners: t.owners.length }),
      });
    }
  }
  // Step 4.
  return found;
}

// ── screen ──────────────────────────────────────────────────────────────────

/** The refusal of a hosted family root's rename. */
export const ROOT_RENAME_REFUSED = "renaming a hosted family root's id is not supported; a member can be renamed, or the root recreated";

/**
 * imember_registration.screen — before the data plane dispatches attach or a
 * project rename: who gains access through an attach (the incoming member
 * inherits the bound project's chain), or the refusal of renaming a family
 * root. A member rename is let through; reconcile re-keys it.
 */
export function screen(dataDir: string, binding: ProjectBinding, tool: string, alias: string, path?: string, newId?: string): MembershipScreen {
  // Stage 8: a hosted root reaches another only by a `hosted:` source — a `../` or git source is refused before dispatch.
  if (path !== undefined && (tool === 'sdd_add_member' || tool === 'sdd_attach_member')) {
    const storage = parseMemberSource(path).storage;
    if (storage === 'path' || storage === 'git') {
      return { refusal: `a member declared with a ${storage === 'git' ? 'git' : '`../` sibling'} source is refused on a hosted instance: hosted projects are isolated roots, and one reaches another only by a \`hosted:\` source`, reachChanges: [] };
    }
  }
  // A member created in this project's own tree changes nobody's reach: a part is reached through this record, a project inherits it.
  if (tool === 'sdd_add_member') return { reachChanges: [] };
  // Stage 8: a demote retires the member's record — its specs are reached through this project's record alone.
  if (tool === 'sdd_demote_member') return screenDemote(dataDir, binding, alias);
  // Step 1.
  if (tool === 'sdd_rename_project') {
    // Step 2.
    const family = listFamilyRecords(dataDir, binding.projectId);
    // Step 3: the renamed project is the family root when bound there and naming no member path.
    const root = family[0]?.id === binding.projectId && alias.trim() === '';
    // Step 4.
    return root ? { refusal: ROOT_RENAME_REFUSED, reachChanges: [] } : { reachChanges: [] };
  }
  // Steps 5-6.
  const world = gatherPermissionWorld(dataDir);
  const users = listUsers(dataDir);
  // Step 7: the incoming member holds no record yet — its qualified alias stands in for its id.
  const incoming = standIn(binding.projectId, alias, path);
  const after = relink(world, [{ projectId: incoming, parentProjectId: binding.projectId }], [], [], []);
  // Step 8: who gains access.
  const reachChanges = compare(users, world, null, after, incoming).filter((r) => !r.equal);
  // Steps 9-11: a promote or an externalize as a project moves subsystems into a
  // new project — the plan lists every setting it carries before anything is written.
  if (tool !== 'sdd_promote_member' && tool !== 'sdd_externalize_subsystem') return { reachChanges };
  const moved = tool === 'sdd_externalize_subsystem' ? [alias] : partSubsystemIds(dataDir, binding.projectId, alias) ?? [];
  // Step 12.
  return { reachChanges, carried: carryPlan(users, world, binding.projectId, newId || alias, moved) };
}

/**
 * Steps 5-8 for a demote (stage 8): the member's record retired — its parent
 * link and its member-own settings gone, its specs reached through the bound
 * project's chain alone. Lists whoever a member-own `no` denied (they gain
 * access) and every token narrowed to the member alone (it loses its reach).
 */
function screenDemote(dataDir: string, binding: ProjectBinding, alias: string): MembershipScreen {
  const declared = planMemberRecords(dataDir, binding.projectId)
    .find((d) => d.record.parentProjectId === binding.projectId && d.qualifier.endsWith(`${SUBPROJECT_SEPARATOR}${alias}`) && d.action !== 'unreadable');
  if (!declared || declared.action === 'register') return { reachChanges: [] };
  const world = gatherPermissionWorld(dataDir);
  const users = listUsers(dataDir);
  const after = relink(world, [], [declared.record.id], [], []);
  return { reachChanges: compare(users, world, declared.record.id, after, binding.projectId).filter((r) => !r.equal) };
}

/** The id an incoming member stands under before it has a record: never a record id (it carries the separator). */
function standIn(parentId: string, alias: string, memberPath?: string): string {
  return `${parentId}${SUBPROJECT_SEPARATOR}${alias || memberPath || 'member'}`;
}

// ── reconcile ───────────────────────────────────────────────────────────────

/** One membership change reconcile made, for the reach listing and the audit. */
interface MembershipChange {
  kind: 'registered' | 'returned' | 'relocated' | 'renamed' | 'departed' | 'retired';
  id: string;
  previousId?: string;
  detail: Record<string, unknown>;
}

/**
 * imember_registration.reconcile — after a hosted family-shape tool succeeded,
 * make the family's records agree with the family on disk: register, relocate,
 * re-key (a member rename) or disable records, list and audit the reach those
 * changes altered, and publish ONE commit covering every touched project.
 */
export function reconcile(dataDir: string, principal: Principal, projectId: string, touched: string[]): MemberReconciliation {
  // Steps 1-2.
  const family = listFamilyRecords(dataDir, projectId);
  const familyRoot = family[0];
  const declared = familyRoot ? planMemberRecords(dataDir, familyRoot.id) : [];
  // Steps 3-4.
  const world = gatherPermissionWorld(dataDir);
  const users = listUsers(dataDir);
  // Steps 5-14: register, return, relocate and re-key, family roots first.
  const changes: MembershipChange[] = [];
  const kindOf = { register: 'registered', return: 'returned', relocate: 'relocated' } as const;
  for (const m of declared.filter((d) => d.action === 'register' || d.action === 'return' || d.action === 'relocate' || d.action === 'rename')) {
    if (m.action === 'rename' && m.previousId !== undefined) changes.push(rekey(dataDir, world, users, m));
    // Step 13: a returning member's record is active again; it kept its own-scope settings.
    if (m.action === 'return') setProjectRecordStatus(dataDir, m.record.id, 'active');
    registerMemberRecord(dataDir, { ...m.record, status: 'active', rootPath: '' });
    if (m.action !== 'rename') changes.push({ kind: kindOf[m.action as keyof typeof kindOf], id: m.record.id, detail: { parent: m.record.parentProjectId, memberPath: m.record.memberPath } });
  }
  // Steps 15-16: a record whose member the family no longer declares as a project is disabled,
  // never deleted — departed, or retired because its member is now a part of its parent (stage 8).
  for (const m of declared.filter((d) => d.action === 'retire')) {
    setProjectRecordStatus(dataDir, m.record.id, 'disabled', `part of ${m.record.parentProjectId}`);
    changes.push({ kind: 'retired', id: m.record.id, detail: { parent: m.record.parentProjectId, memberPath: m.record.memberPath, reason: `part of ${m.record.parentProjectId}` } });
  }
  for (const r of departedRecords(family, declared, changes)) {
    setProjectRecordStatus(dataDir, r.id, 'disabled');
    changes.push({ kind: 'departed', id: r.id, detail: { parent: r.parentProjectId, memberPath: r.memberPath } });
  }
  // Step 17: a promote or an externalize never widens access — the subsystem
  // rules that governed a registered or returned member's specs are carried
  // onto the member's own scope, each listed and audited.
  const carried = carrySubsystemRules(dataDir, listChangedLinks(changes.filter((c) => c.kind === 'registered' || c.kind === 'returned')));
  // Steps 18-20: the reach the membership changes altered, over an after-world
  // holding the carried rules; every carried rule listed besides.
  const reachChanges = [...reachOf(users, world, changes, listAssignments(dataDir)), ...carried];
  // Steps 20-22: every touched project audited as its own event, and its repository scope.
  const ids = [...new Set([...touched, ...changes.map((c) => c.id)])];
  for (const id of ids) auditTouched(dataDir, principal, projectId, id, changes.find((c) => c.id === id), reachChanges);
  // Step 23: one commit over every touched project's own .wai/.
  const commit = publishFamily(dataDir, ids, `wairon: reconcile the family of ${projectId} (${ids.join(', ')})`);
  // Step 24.
  return {
    registered: changes.filter((c) => c.kind === 'registered').map((c) => c.id),
    returned: changes.filter((c) => c.kind === 'returned').map((c) => c.id),
    relocated: changes.filter((c) => c.kind === 'relocated').map((c) => c.id),
    renamed: changes.filter((c) => c.kind === 'renamed').map((c) => `${c.previousId}->${c.id}`),
    departed: changes.filter((c) => c.kind === 'departed').map((c) => c.id),
    retired: changes.filter((c) => c.kind === 'retired').map((c) => c.id),
    reachChanges,
    ...(commit ? { commit } : {}),
  };
}

/**
 * Steps 6-12: a member a project rename gave a new id. Its OWN-scope settings
 * and the key entries naming it move to the new id and the old record is
 * deleted — nothing inherited is stored on it, so nothing else moves. Refused
 * (an operator moves them by hand; the old record is disabled as departed)
 * when the new id already holds settings of its own, or either id is also an
 * organization unit id: the scope remaps are kind-blind.
 */
function rekey(dataDir: string, world: PermissionWorld, users: HostedUserRecordLike[], m: PlannedMemberRecord): MembershipChange {
  const oldId = m.previousId as string;
  const newId = m.record.id;
  // Step 7.
  const unitIds = new Set(world.units.map((u) => u.id));
  const refused = hasOwnSettings(world, users, newId) || unitIds.has(oldId) || unitIds.has(newId);
  if (refused) {
    // Step 7: refused, it goes straight on to registering the new id.
    return { kind: 'registered', id: newId, detail: { parent: m.record.parentProjectId, memberPath: m.record.memberPath, rekeyRefused: oldId } };
  }
  // Steps 8-9: the own-scope assignments and role bindings, and the subsystem
  // rules (`<old>/<subsystem>` -> `<new>/<subsystem>`) with them: one left
  // behind would name no subsystem and stop applying — a widening.
  const subsystemRemap = subsystemScopesOf(world, users, oldId)
    .map((scopeId) => ({ oldId: scopeId, newId: `${newId}${scopeId.slice(oldId.length)}` }));
  const moved = {
    assignments: world.assignments.filter((a) => a.scopeKind === 'project' && a.scopeId === oldId).length,
    subsystemRules: subsystemRemap.map((r) => `${r.oldId} -> ${r.newId}`),
  };
  remapScope(dataDir, [{ oldId, newId }, ...subsystemRemap]);
  remapUnitReferences(dataDir, [{ oldId, newId }, ...subsystemRemap], []);
  // Steps 10-11: the key entries naming the old id.
  const keys = listCredentials(dataDir, oldId).filter((k) => k.projects.includes(oldId) && !k.revokedAt);
  for (const k of keys) renarrowCredential(dataDir, k.id, [...new Set(k.projects.map((e) => (e === oldId ? newId : e)))]);
  // Step 12: the old record; its children are relocated under the new id as the loop reaches them.
  removeProjectRecord(dataDir, oldId);
  return { kind: 'renamed', id: newId, previousId: oldId, detail: { ...moved, keys: keys.map((k) => k.id) } };
}

/** The subjects' role bindings as reconcile reads them. */
type HostedUserRecordLike = { roleBindings?: { scopeKind?: string; scopeId?: string }[] };

/** Every subsystem scope of a record a setting names: an assignment or a role binding at `<id>/<subsystem>`. */
function subsystemScopesOf(world: PermissionWorld, users: HostedUserRecordLike[], id: string): string[] {
  const prefix = `${id}/`;
  const ids = [
    ...world.assignments.filter((a) => a.scopeKind === 'subsystem' && a.scopeId?.startsWith(prefix)).map((a) => a.scopeId as string),
    ...users.flatMap((u) => (u.roleBindings ?? []).filter((b) => b.scopeKind === 'subsystem' && b.scopeId?.startsWith(prefix)).map((b) => b.scopeId as string)),
  ];
  return [...new Set(ids)];
}

/** Whether an id already holds a setting on its own project scope or one of its subsystem scopes: an assignment or a role binding anchored there. */
function hasOwnSettings(world: PermissionWorld, users: HostedUserRecordLike[], id: string): boolean {
  return world.assignments.some((a) => a.scopeKind === 'project' && a.scopeId === id)
    || users.some((u) => (u.roleBindings ?? []).some((b) => b.scopeKind === 'project' && b.scopeId === id))
    || subsystemScopesOf(world, users, id).length > 0;
}

/** Step 15: the family's member records the family no longer declares (an unreadable declaration keeps the record it names). */
function departedRecords(family: HostedProjectRecord[], declared: PlannedMemberRecord[], changes: MembershipChange[]): HostedProjectRecord[] {
  const live = new Set(declared.filter((d) => d.action !== 'unreadable').map((d) => d.record.id));
  const held = declared.filter((d) => d.action === 'unreadable').map((d) => `${d.record.parentProjectId}/${d.record.memberPath}`);
  const rekeyed = new Set(changes.filter((c) => c.kind === 'renamed').map((c) => c.previousId));
  return family.filter((r) => r.parentProjectId !== undefined && r.status === 'active' && !live.has(r.id) && !rekeyed.has(r.id)
    && !held.includes(`${r.parentProjectId}/${r.memberPath}`));
}

/** Steps 18-20: the rows whose effective permission a membership change altered (a re-key is equal by construction). */
function reachOf(users: Parameters<typeof compare>[0], world: PermissionWorld, changes: MembershipChange[], assignmentsAfter: PermissionAssignment[]): ReachComparison[] {
  const links: ProjectParentLink[] = listChangedLinks(changes);
  const departed = changes.filter((c) => c.kind === 'departed' || c.kind === 'retired').map((c) => c.id);
  const after = { ...relink(world, links, departed, [], []), assignments: assignmentsAfter };
  return changes.filter((c) => c.kind !== 'renamed').flatMap((c) => {
    const before = c.kind === 'registered' || c.kind === 'returned' ? null : c.id;
    // A retired record's specs are reached through its parent's record from now on (stage 8).
    const now = c.kind === 'departed' ? null : c.kind === 'retired' ? String(c.detail.parent ?? '') || null : c.id;
    return compare(users, world, before, after, now).filter((r) => !r.equal).map((r) => ({ ...r, memberId: c.id }));
  });
}

/**
 * imember_registration.carrySubsystemRules — keep a promote or an externalize
 * from widening access: for each member and its parent, every subsystem rule of
 * the parent (`<parent>/<subsystem>`, project:write yes or no) whose subsystem
 * the member's tree declares and the parent's no longer does is set on the
 * member's own project scope — per subject the most restrictive value, unless
 * the subject already holds a project:write setting there. The subsystem rule
 * itself is kept. Answers one reach row per carried rule.
 */
export function carrySubsystemRules(dataDir: string, members: ProjectParentLink[]): ReachComparison[] {
  const rows: ReachComparison[] = [];
  // Step 1.
  for (const { projectId: memberId, parentProjectId: parentId } of members) {
    // Step 2: the subsystems that moved from the parent into the member.
    const parentHolds = declaredSubsystemIds(dataDir, parentId) ?? [];
    const moved = (declaredSubsystemIds(dataDir, memberId) ?? []).filter((s) => !parentHolds.includes(s));
    if (moved.length === 0) continue;
    // Steps 3-5: the plan — one rule per subject, the most restrictive when several subsystems name it.
    const plan = carryPlan(listUsers(dataDir), gatherPermissionWorld(dataDir), parentId, memberId, moved);
    for (const rule of plan.filter((r) => r.kind === 'assignment')) {
      // Step 6.
      const everyone = rule.subject === EVERYONE;
      setAssignment(dataDir, {
        id: '', subjectKind: everyone ? 'everyone' : 'user', ...(everyone ? {} : { subjectId: rule.subject }),
        scopeKind: 'project', scopeId: memberId, capability: 'project:write', value: rule.value as PermissionValue, createdAt: '',
      });
      // Step 7.
      rows.push(carriedRow(rule));
    }
  }
  // Step 8.
  return rows;
}

/** The reach row of one carried rule: before at the subsystem scope(s), after at the member's project scope. */
function carriedRow(rule: CarriedSubsystemRule): ReachComparison {
  const source: EffectivePermission['source'] = rule.subject === EVERYONE ? 'everyone-default' : 'user';
  const value = rule.value as EffectivePermission['value'];
  return {
    memberId: rule.to,
    subjectId: rule.subject,
    capability: 'project:write',
    before: { value, source, decidedScopeKind: 'subsystem', decidedScopeId: rule.from.join(', ') },
    after: { value, source, decidedScopeKind: 'project', decidedScopeId: rule.to },
    equal: true,
  };
}

/** The parent links the registered and relocated members hold now. */
function listChangedLinks(changes: MembershipChange[]): ProjectParentLink[] {
  return changes
    .filter((c) => c.kind === 'registered' || c.kind === 'returned' || c.kind === 'relocated')
    .map((c) => ({ projectId: c.id, parentProjectId: String(c.detail.parent) }));
}

/** Step 21: one event per touched project, naming it, with the initiating project as composition. */
function auditTouched(dataDir: string, principal: Principal, projectId: string, id: string, change: MembershipChange | undefined, reach: ReachComparison[]): void {
  const rows = reach.filter((r) => r.memberId === id);
  audit(dataDir, {
    action: change ? `member.${change.kind}` : 'family.changed', outcome: 'success', level: 'info',
    actor: actorOf(principal), tokenId: principal.tokenId, projectId: id, composition: projectId, target: id,
    metadata: JSON.stringify({ ...(change ? { ...change.detail, ...(change.previousId ? { previousId: change.previousId } : {}) } : {}), reach: reachSummary(rows) }),
  });
}

/** Who gains or loses what, one line per principal and capability. */
function reachSummary(rows: ReachComparison[]): string[] {
  return rows.map((r) => `${r.subjectId} ${r.capability}: ${r.before.value} -> ${r.after.value}`);
}

/**
 * Step 23: ONE commit per family repository whose pathspecs are exactly the
 * touched projects' own .wai/ — never another member's tree, never source
 * code. A family that is not git-backed, or clean paths, publish nothing.
 */
function publishFamily(dataDir: string, ids: string[], message: string): GitPublish | undefined {
  return publishScopes(ids.map((id) => projectRepositoryScope(dataDir, id)).filter((s): s is RepositoryScope => s !== null), message);
}

/** One commit at the family's repository root over the scopes' pathspecs; the first family's when several (never the case for one family). */
function publishScopes(scopes: RepositoryScope[], message: string): GitPublish | undefined {
  if (scopes.length === 0) return undefined;
  const root = scopes[0].repositoryRoot;
  const pathspecs = [...new Set(scopes.filter((s) => s.repositoryRoot === root).flatMap((s) => s.pathspecs))];
  try {
    return runWithProjectRoot(root, () => hostGit.publish(message, pathspecs));
  } catch (e) {
    console.error(`[sdd_host] family commit failed at ${root}: ${e instanceof Error ? e.message : String(e)}`);
    return { published: false };
  }
}

// ── detach ──────────────────────────────────────────────────────────────────

/** What a detached project is told about git: the family's repository stays with the family, and none is created. */
export const NO_GIT_BINDING = 'no git binding: enable one for this project';

/** The host store files a relocation's coordinator contributes: the project records and the organization (placements). */
const RELOCATION_AREAS = ['projects.json', 'organization.json'];

/**
 * imember_registration.detach — serve a hosted sdd_detach_member: the member
 * is RELOCATED to an isolated root of its own in one transaction with the
 * family edits (hosted sources) and the host store writes (its record made
 * top-level, placed in its former family root's units); the plan lists who
 * loses access.
 */
export function detach(dataDir: string, principal: Principal, binding: ProjectBinding, alias: string, apply: boolean): MemberDetachment {
  // Steps 1-2.
  const family = listFamilyRecords(dataDir, binding.projectId);
  const declared = family[0] ? planMemberRecords(dataDir, family[0].id) : [];
  const member = declared.find((d) => d.record.parentProjectId === binding.projectId && d.qualifier.endsWith(`${SUBPROJECT_SEPARATOR}${alias}`) && d.action !== 'unreadable');
  // Step 3: the new root; refused when a record or a directory holds it.
  const memberId = member?.record.id ?? alias;
  const newRoot = isolatedRoot(dataDir, memberId);
  const unfit = detachUnfit(dataDir, family, member, newRoot, alias);
  if (unfit !== null) return refusedDetach(memberId, newRoot, alias, unfit);
  // Steps 4-8: who loses access when the inherited project rungs are cut.
  const placements = listProjectPlacements(dataDir, family[0].id);
  const reachLost = detachReach(dataDir, family, memberId, placements);
  // Step 9.
  const relocation = { to: newRoot, coordinator: path.resolve(dataDir), areas: RELOCATION_AREAS };
  const plan = hostMigrations.plan({ verb: 'detach', alias, relocation });
  // Steps 10-11.
  const refusal = plan.refusals.length > 0 ? null : hostedIdMismatch(plan, family);
  if (refusal) plan.refusals.push(refusal);
  if (plan.refusals.length > 0 || !plan.rehearsal) {
    if (plan.rehearsal) hostMigrations.drop(plan.rehearsal);
    return { memberId, plan: { ...plan, rehearsal: undefined }, newRoot, reachLost, applied: false };
  }
  // Steps 12-14: the host store writes, made in the rehearsal's copy of the data root.
  const changes = detachHostWrites(plan, dataDir, memberId, newRoot, placements);
  const scopes = touchedScopes(dataDir, family, changes);
  // The family's repository stays with the family: the detached project has no git binding of its own.
  const planned: MigrationPlan = { ...plan, changes, notes: [...plan.notes, NO_GIT_BINDING] };
  // Step 15.
  if (!apply) {
    // Steps 24-25.
    hostMigrations.drop(plan.rehearsal);
    return { memberId, plan: { ...planned, rehearsal: undefined }, newRoot, reachLost, applied: false };
  }
  // Step 16.
  const outcome = hostMigrations.commit(plan.rehearsal, changes, 'detach');
  // Step 17.
  if (!outcome.committed) {
    // Steps 22-23.
    audit(dataDir, {
      action: 'member.detach', outcome: 'failed', level: 'warning', actor: actorOf(principal), tokenId: principal.tokenId,
      projectId: memberId, composition: binding.projectId, target: memberId,
      metadata: JSON.stringify({ failure: outcome.failure, restored: outcome.restored, unrestored: outcome.unrestored }),
    });
    return { memberId, plan: { ...planned, rehearsal: undefined }, newRoot, reachLost, applied: false, outcome };
  }
  // Step 18.
  audit(dataDir, {
    action: 'member.detached', outcome: 'success', level: 'info', actor: actorOf(principal), tokenId: principal.tokenId,
    projectId: memberId, composition: binding.projectId, target: memberId,
    metadata: JSON.stringify({ newRoot, reachLost: reachSummary(reachLost), gitBinding: NO_GIT_BINDING }),
  });
  // Steps 19-20.
  const commit = publishScopes(scopes, `wairon: detach ${memberId} from ${binding.projectId} (it moves to its own root)`);
  // Step 21.
  return { memberId, plan: { ...planned, rehearsal: undefined }, newRoot, reachLost, applied: true, outcome, ...(commit ? { commit } : {}) };
}

/** The isolated root a new hosted project with this id is allocated (as project creation allocates it). */
function isolatedRoot(dataDir: string, id: string): string {
  return path.join(path.resolve(dataDir), 'projects', id);
}

/** Step 3: why the member cannot be detached to the new root, or null. */
function detachUnfit(dataDir: string, family: HostedProjectRecord[], member: PlannedMemberRecord | undefined, newRoot: string, alias: string): MigrationPlan['refusals'][number] | null {
  if (!member) return { code: 'not-a-member', project: '', detail: `the bound project declares no readable member "${alias}"` };
  if (member.action === 'register') return { code: 'not-a-member', project: '', detail: `the member "${alias}" holds no hosted record yet — run \`wairon host doctor --fix\` first` };
  const held = listProjectRecords(dataDir).some((r) => r.rootPath && path.resolve(r.rootPath) === path.resolve(newRoot));
  if (held || occupied(newRoot)) return { code: 'relocation-target-exists', project: '', detail: `the member's new root ${newRoot} is already held by a record or a non-empty directory` };
  return family.length === 0 ? { code: 'not-a-member', project: '', detail: 'the bound project belongs to no hosted family' } : null;
}

/** Whether the new root is taken: it exists and is not an empty directory (an empty one a cut-short cleanup left is free). */
function occupied(dir: string): boolean {
  try {
    return !fs.statSync(dir).isDirectory() || fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** A refused detachment answered before anything was planned or rehearsed. */
function refusedDetach(memberId: string, newRoot: string, alias: string, refusal: MigrationPlan['refusals'][number]): MemberDetachment {
  const plan: MigrationPlan = {
    request: { verb: 'detach', alias }, familyRoot: '', whole: true, edits: [], changes: [], relock: [], notes: [],
    refusals: [refusal],
  };
  return { memberId, plan, newRoot, reachLost: [], applied: false };
}

/** Steps 4-8: every subject x capability over the member (and each member below it) that drops. */
function detachReach(dataDir: string, family: HostedProjectRecord[], memberId: string, placements: PermissionWorld['placements']): ReachComparison[] {
  const world = gatherPermissionWorld(dataDir);
  const users = listUsers(dataDir);
  const kept = placements.map((p) => ({ ...p, projectId: memberId }));
  const after = relink(world, [], [memberId], kept, []);
  return familyBelow(family, memberId).flatMap((id) => compare(users, world, id, after, id).filter((r) => !r.equal));
}

/** A record and every record below it in the family. */
function familyBelow(family: HostedProjectRecord[], id: string): string[] {
  const out = [id];
  for (let i = 0; i < out.length; i++) out.push(...family.filter((r) => r.parentProjectId === out[i]).map((r) => r.id));
  return out;
}

/** A hosted source names a producer by record id: every id the plan writes must be a family record's (else a project id differs from its record id). */
function hostedIdMismatch(plan: MigrationPlan, family: HostedProjectRecord[]): MigrationPlan['refusals'][number] | null {
  const ids = new Set(family.map((r) => r.id));
  const named = plan.edits.flatMap((e) => (e.write?.args ?? []).filter((a): a is { hosted: string } => !!a && typeof a === 'object' && typeof (a as { hosted?: unknown }).hosted === 'string'));
  const nested = plan.edits.flatMap((e) => (e.write?.args ?? []).map((a) => (a as { source?: { hosted?: string } } | null)?.source?.hosted).filter((h): h is string => typeof h === 'string'));
  const stray = [...named.map((n) => n.hosted), ...nested].find((h) => !ids.has(h));
  return stray === undefined ? null : {
    code: 'family-partial', project: '',
    detail: `a hosted source would name "${stray}", which no record of this family holds — a family project's record id differs from its project id`,
  };
}

/** Steps 12-14: the member's record made top-level at its new root and placed in its former family root's units, in the copy; every file change. */
function detachHostWrites(plan: MigrationPlan, dataDir: string, memberId: string, newRoot: string, placements: PermissionWorld['placements']): FileChange[] {
  const rehearsal = plan.rehearsal as Rehearsal;
  const copy = rehearsalDataRoot(rehearsal, dataDir);
  registerProjectRecord(copy, memberId, newRoot);
  for (const p of placements) placeProject(copy, { id: '', projectId: memberId, unitId: p.unitId, role: p.role, createdAt: '', createdBy: p.createdBy });
  return hostMigrations.diff(rehearsal);
}

/** The rehearsal's copy of the data root. */
function rehearsalDataRoot(rehearsal: Rehearsal, dataDir: string): string {
  return rehearsal.roots.get(path.resolve(dataDir)) ?? path.join(rehearsal.directory);
}

/** The repository scope of every family record whose own .wai/ a change touches — a moved member's nested members included. */
function touchedScopes(dataDir: string, family: HostedProjectRecord[], changes: FileChange[]): RepositoryScope[] {
  const files = changes.map((c) => path.join(path.resolve(c.project), ...c.path.split('/')));
  return family.filter((r) => r.rootPath && files.some((f) => liesWithin(f, path.join(r.rootPath, '.wai'))))
    .map((r) => projectRepositoryScope(dataDir, r.id))
    .filter((s): s is RepositoryScope => s !== null);
}

// ── adopt ───────────────────────────────────────────────────────────────────

/**
 * imember_registration.adopt — serve a hosted sdd_adopt_member, detach's
 * inverse: the project the external names by source.hosted is RELOCATED back
 * into the bound project's tree at the member path, its record converted into a
 * member and its own placements removed, in one transaction; the plan lists
 * every reach change.
 */
export function adopt(dataDir: string, principal: Principal, binding: ProjectBinding, alias: string, path: string, apply: boolean): MemberAdoption {
  const memberPath = path;
  // Step 1: the planner resolves the hosted producer's root through the request's record lookup.
  const relocation = { to: memberTarget(binding, memberPath), coordinator: hostedRoot(dataDir), areas: RELOCATION_AREAS };
  const request: MigrationRequest = { verb: 'adopt', alias, path: memberPath, relocation };
  const plan = hostMigrations.plan(request);
  const adoptedId = plan.edits.find((e) => e.write?.call === 'move')?.project ?? alias;
  // Steps 2-5.
  const refusal = plan.refusals.length > 0 ? null : adoptUnfit(dataDir, principal, binding, adoptedId, relocation.to);
  if (refusal) plan.refusals.push(refusal);
  if (plan.refusals.length > 0 || !plan.rehearsal) {
    // Steps 6-7.
    if (plan.rehearsal) hostMigrations.drop(plan.rehearsal);
    return { memberId: adoptedId, plan: { ...plan, rehearsal: undefined }, memberPath, reachChanges: [], applied: false };
  }
  // Steps 8-11.
  const world = gatherPermissionWorld(dataDir);
  const reachChanges = adoptReach(dataDir, world, binding, adoptedId);
  // Steps 12-14.
  const changes = adoptHostWrites(plan, dataDir, world, binding, adoptedId, memberPath);
  const planned: MigrationPlan = { ...plan, changes };
  // Step 15.
  if (!apply) {
    // Steps 24-25.
    hostMigrations.drop(plan.rehearsal);
    return { memberId: adoptedId, plan: { ...planned, rehearsal: undefined }, memberPath, reachChanges, applied: false };
  }
  // Steps 16-17.
  const outcome = hostMigrations.commit(plan.rehearsal, changes, 'adopt');
  if (!outcome.committed) {
    // Steps 22-23.
    audit(dataDir, {
      action: 'member.adopt', outcome: 'failed', level: 'warning', actor: actorOf(principal), tokenId: principal.tokenId,
      projectId: adoptedId, composition: binding.projectId, target: adoptedId,
      metadata: JSON.stringify({ failure: outcome.failure, restored: outcome.restored, unrestored: outcome.unrestored }),
    });
    return { memberId: adoptedId, plan: { ...planned, rehearsal: undefined }, memberPath, reachChanges, applied: false, outcome };
  }
  // Step 18.
  const removed = world.placements.filter((p) => p.projectId === adoptedId).map((p) => p.unitId);
  audit(dataDir, {
    action: 'member.adopted', outcome: 'success', level: 'info', actor: actorOf(principal), tokenId: principal.tokenId,
    projectId: adoptedId, composition: binding.projectId, target: adoptedId,
    metadata: JSON.stringify({ memberPath, placementsRemoved: removed, reach: reachSummary(reachChanges) }),
  });
  // Steps 19-20: the adopted member's scope is read now that it is a member.
  const scopes = touchedScopes(dataDir, listFamilyRecords(dataDir, binding.projectId), changes);
  const commit = publishScopes(scopes, `wairon: adopt ${adoptedId} into ${binding.projectId} at ${memberPath}`);
  // Step 21.
  return { memberId: adoptedId, plan: { ...planned, rehearsal: undefined }, memberPath, reachChanges, applied: true, outcome, ...(commit ? { commit } : {}) };
}

/** Whether a path is (or lies within) a root. */
function liesWithin(dir: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The member path's absolute target under the bound project's root. */
function memberTarget(binding: ProjectBinding, memberPath: string): string {
  return path.resolve(binding.rootPath, memberPath ?? '');
}

/** The data directory, absolute — the relocation's coordinator. */
function hostedRoot(dataDir: string): string {
  return path.resolve(dataDir);
}

/**
 * Steps 3-5: the adopted record must be a top-level project the caller may
 * write, as the bound project too, and every member it carries must derive a
 * root under the target that is free.
 */
function adoptUnfit(dataDir: string, principal: Principal, binding: ProjectBinding, adoptedId: string, target: string): MigrationPlan['refusals'][number] | null {
  // Step 3.
  const adopted = listFamilyRecords(dataDir, adoptedId);
  if (adopted.length === 0 || adopted[0].id !== adoptedId) {
    return { code: 'not-a-project', project: '', detail: `"${adoptedId}" is not a top-level hosted project — a member of another family is detached from it first` };
  }
  // Step 4.
  const reach = resolveFamilyReach(dataDir, principal, [binding.projectId, adoptedId]);
  const unwritable = [binding.projectId, adoptedId].filter((id) => !reach.writable.includes(id));
  if (unwritable.length > 0) {
    return { code: 'family-partial', project: '', detail: `adopting needs project:write on both the bound project and the adopted one; the caller may not write ${unwritable.join(', ')}` };
  }
  // Step 5: the members it carries, at the roots they would derive under the target.
  const from = adopted[0].rootPath;
  const blocked = adopted.slice(1).find((m) => m.rootPath && fs.existsSync(path.join(target, path.relative(from, m.rootPath))));
  return blocked ? { code: 'relocation-target-exists', project: '', detail: `the member ${blocked.id} it carries cannot be held at ${path.join(target, path.relative(from, blocked.rootPath))}` } : null;
}

/** Steps 8-11: every subject x capability over the adopted project (and its members) that changes. */
function adoptReach(dataDir: string, world: PermissionWorld, binding: ProjectBinding, adoptedId: string): ReachComparison[] {
  const users = listUsers(dataDir);
  const after = relink(world, [{ projectId: adoptedId, parentProjectId: binding.projectId }], [], [], [adoptedId]);
  return familyBelow(listFamilyRecords(dataDir, adoptedId), adoptedId).flatMap((id) => compare(users, world, id, after, id).filter((r) => !r.equal));
}

/** Steps 12-14: the record converted into a member and its own placements removed, in the copy; every file change. */
function adoptHostWrites(plan: MigrationPlan, dataDir: string, world: PermissionWorld, binding: ProjectBinding, adoptedId: string, memberPath: string): FileChange[] {
  const rehearsal = plan.rehearsal as Rehearsal;
  const copy = rehearsalDataRoot(rehearsal, dataDir);
  registerMemberRecord(copy, { id: adoptedId, rootPath: '', status: 'active', createdAt: '', parentProjectId: binding.projectId, memberPath });
  for (const p of world.placements.filter((x) => x.projectId === adoptedId)) deletePlacement(copy, p.id);
  return hostMigrations.diff(rehearsal);
}

/** A principal as the actor of an event. */
function actorOf(principal: Principal): PrincipalSubject {
  return principal.subject ?? { userId: `token:${principal.tokenId}`, kind: 'service', issuer: 'local' };
}
