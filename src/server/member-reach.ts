import { resolvePermission } from './permission-rules.js';
import type {
  ApiKeyRecord,
  Capability,
  EffectivePermission,
  HostedUserRecord,
  PermissionSubject,
  PermissionWorld,
  PlannedMemberRecord,
  PlannedNarrowing,
  ProjectParentLink,
  ProjectPlacement,
  ReachComparison,
} from './types.js';

// ---------------------------------------------------------------------------
// Member Reach Rules (sdd_host) — pure rules over supplied values, no I/O.
//
// Projects nest like organization units, so a member's reach comes through its
// parent chain; these rules never write a grant. relink answers the permission
// world after a membership change, compare resolves every subject x capability
// before and after it (the upgrade's no-widening proof, or a membership
// change's reach listing), and narrowing rewrites an API key's member-QUALIFIED
// entries to record ids.
// ---------------------------------------------------------------------------

/** Every capability a comparison resolves — the whole RBAC capability set. */
const COMPARED_CAPABILITIES: Capability[] = [
  'project:read',
  'project:create',
  'project:write',
  'project:admin',
  'approval:decide',
  'share:create',
];

/** The subject id standing for everyone without settings of their own. */
export const EVERYONE_ELSE = 'everyone';

/** The documented widening of a rewritten qualified entry. */
const NARROWING_WIDENING =
  'record-level tools (status, approval, lock requests, packs, policy, producers, commit, landscape discovery) '
  + "now act on the member's own record — within the member only";

/**
 * imember_reach_rules.relink — the world with the given parent links added
 * (replacing any link a member already had), the given member ids unlinked,
 * every placement of the unplaced projects removed, and the given placements
 * added. Assignments, roles and units are untouched.
 */
export function relink(
  world: PermissionWorld,
  added: ProjectParentLink[],
  removed: string[],
  placements: ProjectPlacement[],
  unplaced: string[],
): PermissionWorld {
  // Step 1.
  const addedIds = new Set(added.map((l) => l.projectId));
  const parents = [
    ...world.parents.filter((l) => !removed.includes(l.projectId) && !addedIds.has(l.projectId)),
    ...added,
  ];
  const kept = world.placements.filter((p) => !unplaced.includes(p.projectId));
  // Step 2.
  return { ...world, parents, placements: [...kept, ...placements] };
}

/** A user record as its permission subject: its id, its diverged subject id as alias, its role bindings. */
function subjectOf(user: HostedUserRecord): PermissionSubject {
  const subjectId = user.subject.userId || user.id;
  const aliases = [user.id, user.subject.userId].filter((id) => !!id && id !== subjectId);
  return {
    subjectId,
    ...(aliases.length ? { aliasSubjectIds: [...new Set(aliases)] } : {}),
    roleBindings: user.roleBindings ?? [],
    instanceAdmin: false,
  };
}

const NO_RECORD: EffectivePermission = { value: 'no', source: 'instance-default' };

/**
 * imember_reach_rules.compare — every subject (each user record, plus one
 * subject with no settings of its own standing for everyone else) x every
 * capability, resolved over (project, beforeId) in before and (project,
 * afterId) in after; a null id resolves to no.
 */
export function compare(
  users: HostedUserRecord[],
  before: PermissionWorld,
  beforeId: string | null,
  after: PermissionWorld,
  afterId: string | null,
): ReachComparison[] {
  // Step 1.
  const subjects: PermissionSubject[] = [
    ...users.map(subjectOf),
    { subjectId: EVERYONE_ELSE, roleBindings: [], instanceAdmin: false },
  ];
  const rows: ReachComparison[] = [];
  // Step 2.
  for (const subject of subjects) {
    for (const capability of COMPARED_CAPABILITIES) {
      // Step 3.
      const was = beforeId === null ? NO_RECORD : resolvePermission(subject, capability, 'project', beforeId, before);
      // Step 4.
      const now = afterId === null ? NO_RECORD : resolvePermission(subject, capability, 'project', afterId, after);
      // Step 5.
      rows.push({
        memberId: afterId ?? beforeId ?? '',
        subjectId: subject.subjectId,
        capability,
        before: was,
        after: now,
        equal: was.value === now.value,
      });
    }
  }
  // Step 6.
  return rows;
}

/**
 * imember_reach_rules.narrowing — a key's member-QUALIFIED entries rewritten to
 * the record id of the member whose qualifier equals it; every other entry kept;
 * duplicates collapsed, first order kept. Null when no entry is qualified.
 */
export function narrowing(key: ApiKeyRecord, members: PlannedMemberRecord[]): PlannedNarrowing | null {
  // Step 1.
  if (!key.projects.some((e) => e.includes('::'))) {
    // Step 2: a project entry covers its members through the chain.
    return null;
  }
  // Step 3.
  const after: string[] = [];
  for (const entry of key.projects) {
    const id = entry.includes('::') ? members.find((m) => m.qualifier === entry)?.record.id ?? entry : entry;
    if (!after.includes(id)) after.push(id);
  }
  // Steps 4-5.
  return { keyId: key.id, before: [...key.projects], after, widening: NARROWING_WIDENING };
}
