import * as path from 'path';
import { listProjectRecords, planMemberRecords, registerMemberRecord } from './projects.js';
import { gatherPermissionWorld } from './authorization.js';
import { listUsers } from './users.js';
import { listCredentials, renarrowCredential } from './credentials.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import { relink, compare, narrowing } from './member-reach.js';
import * as hostMigrations from './adapters/migrations.js';
import type { ProjectBinding } from './projects.js';
import type { MigrationFinding } from './migration.js';
import type { FileChange, RecoveredTransaction, Rehearsal, TransactionOutcome } from '../migrations/types.js';
import type {
  AuditEvent,
  HostedProjectRecord,
  PermissionWorld,
  PlannedMemberRecord,
  PlannedNarrowing,
  Principal,
  PrincipalSubject,
  ReachComparison,
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
// family migration before the tool runs.
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
      refusals.push({ area: 'members', detail: `${m.qualifier}: the member's directory or project.yaml cannot be read, or declares no valid project id` });
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
    return { plan: reported, applied: false, outcome };
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
  return { plan: reported, applied: true, outcome };
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
