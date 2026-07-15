import { describe, it, expect } from 'vitest';
import { resolvePermission, resolveVisibleScopes } from '../../src/server/permission_resolver.js';
import type {
  OrganizationUnitRecord,
  PermissionAssignment,
  PermissionSubject,
  PermissionWorld,
  ProjectPlacement,
  Role,
  RoleBinding,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// permission_resolver — pure hierarchical resolution (no I/O).
//
// Fixture org (qualified dot-path ids):
//   acme                     (root)
//     acme.it                (department)
//       acme.it.web          (team)  ← project "p-web"
//       acme.it.core         (team)  ← project "p-core"
//     acme.mkt               (department) ← project "p-mkt"
//   globex                   (root) ← project "p-globex"
// ---------------------------------------------------------------------------

const actor = { userId: 'seed', kind: 'human', issuer: 'local' };

const unit = (id: string, parentId?: string): OrganizationUnitRecord => ({
  id,
  name: id,
  kind: 'group',
  slug: id.split('.').pop() as string,
  parentId,
  status: 'active',
  createdAt: '',
  createdBy: actor,
});

const place = (projectId: string, unitId: string): ProjectPlacement => ({
  id: `${projectId}@${unitId}`,
  projectId,
  unitId,
  role: 'owner',
  createdAt: '',
  createdBy: actor,
});

const units: OrganizationUnitRecord[] = [
  unit('acme'),
  unit('acme.it', 'acme'),
  unit('acme.it.web', 'acme.it'),
  unit('acme.it.core', 'acme.it'),
  unit('acme.mkt', 'acme'),
  unit('globex'),
];

const placements: ProjectPlacement[] = [
  place('p-web', 'acme.it.web'),
  place('p-core', 'acme.it.core'),
  place('p-mkt', 'acme.mkt'),
  place('p-globex', 'globex'),
];

let assignmentSeq = 0;
/** A direct-user assignment at a scope. */
const userAt = (
  subjectId: string,
  scopeKind: 'instance' | 'unit' | 'project',
  scopeId: string | undefined,
  value: PermissionAssignment['value'],
  capability: PermissionAssignment['capability'] = 'project:read',
): PermissionAssignment => ({
  id: `a${++assignmentSeq}`,
  subjectKind: 'user',
  subjectId,
  scopeKind,
  scopeId,
  capability,
  value,
  createdAt: '',
});

/** An everyone-default (scope default) assignment at a scope. */
const everyoneAt = (
  scopeKind: 'instance' | 'unit' | 'project',
  scopeId: string | undefined,
  value: PermissionAssignment['value'],
  capability: PermissionAssignment['capability'] = 'project:read',
): PermissionAssignment => ({
  id: `a${++assignmentSeq}`,
  subjectKind: 'everyone',
  scopeKind,
  scopeId,
  capability,
  value,
  createdAt: '',
});

const role = (id: string, value: PermissionAssignment['value'], capability: PermissionAssignment['capability'] = 'project:read'): Role => ({
  id,
  name: id,
  permissions: [{ capability, value }],
  createdAt: '',
});

const subjectOf = (roleBindings: RoleBinding[] = [], instanceAdmin = false): PermissionSubject => ({
  subjectId: 'u1',
  roleBindings,
  instanceAdmin,
});

const worldOf = (assignments: PermissionAssignment[], roles: Role[] = []): PermissionWorld => ({
  assignments,
  roles,
  units,
  placements,
});

describe('resolvePermission — instance-admin bypass', () => {
  it('resolves yes everywhere for an instance-admin, ignoring an explicit deny', () => {
    const world = worldOf([userAt('u1', 'unit', 'acme.it.web', 'no')]);
    const result = resolvePermission(subjectOf([], true), 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('yes');
    expect(result.source).toBe('instance-admin');
  });
});

describe('resolvePermission — instance default', () => {
  it('falls back to no when the walk reaches the root with nothing definitive', () => {
    const result = resolvePermission(subjectOf(), 'project:read', 'unit', 'acme.it.web', worldOf([]));
    expect(result.value).toBe('no');
    expect(result.source).toBe('instance-default');
  });
});

describe('resolvePermission — nearest-ancestor walk', () => {
  it('lets a nearer scope override a broader one (no@org + yes@team)', () => {
    const world = worldOf([
      userAt('u1', 'unit', 'acme', 'no'),
      userAt('u1', 'unit', 'acme.it.web', 'yes'),
    ]);
    expect(resolvePermission(subjectOf(), 'project:read', 'unit', 'acme.it.web', world).value).toBe('yes');
    expect(resolvePermission(subjectOf(), 'project:read', 'unit', 'acme.mkt', world).value).toBe('no');
  });

  it('inherits from the nearest ancestor that has a value', () => {
    const world = worldOf([userAt('u1', 'unit', 'acme.it', 'approval')]);
    const result = resolvePermission(subjectOf(), 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('approval');
    expect(result.decidedScopeId).toBe('acme.it');
  });

  it("treats an explicit 'inherit' as non-deciding and continues upward", () => {
    const world = worldOf([
      userAt('u1', 'unit', 'acme', 'yes'),
      userAt('u1', 'unit', 'acme.it.web', 'inherit'),
    ]);
    expect(resolvePermission(subjectOf(), 'project:read', 'unit', 'acme.it.web', world).value).toBe('yes');
  });
});

describe('resolvePermission — project scopes', () => {
  it("begins a project's chain at its placement unit", () => {
    const world = worldOf([userAt('u1', 'unit', 'acme.it.web', 'yes')]);
    expect(resolvePermission(subjectOf(), 'project:read', 'project', 'p-web', world).value).toBe('yes');
    expect(resolvePermission(subjectOf(), 'project:read', 'project', 'p-mkt', world).value).toBe('no');
  });

  it('lets a project-scoped assignment outrank its placement unit', () => {
    const world = worldOf([
      userAt('u1', 'unit', 'acme.it.web', 'no'),
      userAt('u1', 'project', 'p-web', 'yes'),
    ]);
    expect(resolvePermission(subjectOf(), 'project:read', 'project', 'p-web', world).value).toBe('yes');
  });
});

describe('resolvePermission — role anchoring (privilege-escalation guard)', () => {
  it('does NOT let a broadly-bound role defeat a nearer direct-user deny', () => {
    // The role grants yes and is bound instance-wide, so it anchors at the
    // instance ROOT — it must not be re-pulled at the leaf and beat the deny.
    const world = worldOf(
      [userAt('u1', 'unit', 'acme.it.web', 'no')],
      [role('reader', 'yes')],
    );
    const subject = subjectOf([{ roleId: 'reader' }]);
    const result = resolvePermission(subject, 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('no');
    expect(result.source).toBe('user');
  });

  it('applies an unscoped role binding at the instance root when nothing nearer decides', () => {
    const world = worldOf([], [role('reader', 'yes')]);
    const result = resolvePermission(subjectOf([{ roleId: 'reader' }]), 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('yes');
    expect(result.source).toBe('role');
    expect(result.decidedScopeKind).toBe('instance');
  });

  it('applies a scoped role binding only within its own scope', () => {
    const world = worldOf([], [role('reader', 'yes')]);
    const subject = subjectOf([{ roleId: 'reader', scopeKind: 'unit', scopeId: 'acme.it' }]);
    expect(resolvePermission(subject, 'project:read', 'unit', 'acme.it.web', world).value).toBe('yes');
    expect(resolvePermission(subject, 'project:read', 'unit', 'acme.mkt', world).value).toBe('no');
  });

  it('never denies via a role — a role "no" is non-deciding', () => {
    const world = worldOf([], [role('blocked', 'no')]);
    const result = resolvePermission(subjectOf([{ roleId: 'blocked' }]), 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('no');
    expect(result.source).toBe('instance-default');
  });

  it('combines roles anchored at the same scope most-permissively (yes > approval)', () => {
    const world = worldOf([], [role('a', 'approval'), role('b', 'yes')]);
    const subject = subjectOf([{ roleId: 'a' }, { roleId: 'b' }]);
    expect(resolvePermission(subject, 'project:read', 'unit', 'acme.it.web', world).value).toBe('yes');
  });

  it('ignores a binding to a role absent from the world', () => {
    const world = worldOf([], []);
    expect(resolvePermission(subjectOf([{ roleId: 'ghost' }]), 'project:read', 'unit', 'acme.it.web', world).value).toBe('no');
  });
});

describe('resolvePermission — precedence within one scope', () => {
  it('lets a direct-user value outrank a role at the same scope', () => {
    const world = worldOf([userAt('u1', 'instance', undefined, 'approval')], [role('reader', 'yes')]);
    const result = resolvePermission(subjectOf([{ roleId: 'reader' }]), 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('approval');
    expect(result.source).toBe('user');
  });

  it('lets a role outrank the everyone-default at the same scope', () => {
    const world = worldOf([everyoneAt('instance', undefined, 'approval')], [role('reader', 'yes')]);
    const result = resolvePermission(subjectOf([{ roleId: 'reader' }]), 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('yes');
    expect(result.source).toBe('role');
  });

  it('applies the everyone-default when the subject has nothing of their own', () => {
    const world = worldOf([everyoneAt('unit', 'acme', 'yes')]);
    const result = resolvePermission(subjectOf(), 'project:read', 'unit', 'acme.it.web', world);
    expect(result.value).toBe('yes');
    expect(result.source).toBe('everyone-default');
  });

  it('lets a direct-user deny outrank an everyone-default yes at the same scope', () => {
    const world = worldOf([everyoneAt('unit', 'acme', 'yes'), userAt('u1', 'unit', 'acme', 'no')]);
    expect(resolvePermission(subjectOf(), 'project:read', 'unit', 'acme', world).value).toBe('no');
  });

  it('never applies another user\'s assignment', () => {
    const world = worldOf([userAt('someone-else', 'unit', 'acme', 'yes')]);
    expect(resolvePermission(subjectOf(), 'project:read', 'unit', 'acme', world).value).toBe('no');
  });
});

describe('resolvePermission — capability isolation', () => {
  it('resolves each capability independently', () => {
    const world = worldOf([userAt('u1', 'unit', 'acme', 'yes', 'project:read')]);
    expect(resolvePermission(subjectOf(), 'project:read', 'unit', 'acme', world).value).toBe('yes');
    expect(resolvePermission(subjectOf(), 'project:write', 'unit', 'acme', world).value).toBe('no');
  });
});

describe('resolveVisibleScopes', () => {
  it('marks every unit and placed project actionable for an instance-admin', () => {
    const scopes = resolveVisibleScopes(subjectOf([], true), 'project:read', worldOf([]));
    expect(scopes.every((s) => !s.context)).toBe(true);
    expect(scopes.filter((s) => s.scopeKind === 'unit')).toHaveLength(units.length);
    expect(scopes.filter((s) => s.scopeKind === 'project')).toHaveLength(placements.length);
  });

  it('returns nothing when the subject can see nothing', () => {
    expect(resolveVisibleScopes(subjectOf(), 'project:read', worldOf([]))).toEqual([]);
  });

  it('exposes an actionable project plus its ancestor breadcrumb, never a sibling (no@org + yes@one-project)', () => {
    const world = worldOf([
      userAt('u1', 'unit', 'acme', 'no'),
      userAt('u1', 'project', 'p-web', 'yes'),
    ]);
    const scopes = resolveVisibleScopes(subjectOf(), 'project:read', world);
    const byId = new Map(scopes.map((s) => [s.scopeId, s]));

    // The one authorized project is actionable.
    expect(byId.get('p-web')?.context).toBe(false);
    // Its ancestors are navigable breadcrumbs only.
    expect(byId.get('acme.it.web')?.context).toBe(true);
    expect(byId.get('acme.it')?.context).toBe(true);
    expect(byId.get('acme')?.context).toBe(true);
    // Siblings and their projects never leak.
    expect(byId.has('acme.mkt')).toBe(false);
    expect(byId.has('p-mkt')).toBe(false);
    expect(byId.has('acme.it.core')).toBe(false);
    expect(byId.has('globex')).toBe(false);
  });

  it('treats an approval scope as actionable', () => {
    const world = worldOf([userAt('u1', 'project', 'p-web', 'approval')]);
    const scopes = resolveVisibleScopes(subjectOf(), 'project:read', world);
    expect(scopes.find((s) => s.scopeId === 'p-web')).toMatchObject({ value: 'approval', context: false });
  });

  it('lets actionable win over context when a scope is both', () => {
    // acme.it is actionable in its own right AND an ancestor of p-web.
    const world = worldOf([userAt('u1', 'unit', 'acme.it', 'yes')]);
    const scopes = resolveVisibleScopes(subjectOf(), 'project:read', world);
    const it = scopes.filter((s) => s.scopeId === 'acme.it');
    expect(it).toHaveLength(1);
    expect(it[0].context).toBe(false);
  });

  it('resolves visibility for the given capability, not a fixed one', () => {
    const world = worldOf([userAt('u1', 'unit', 'acme.it.web', 'yes', 'project:write')]);
    expect(resolveVisibleScopes(subjectOf(), 'project:write', world).some((s) => s.scopeId === 'acme.it.web')).toBe(true);
    expect(resolveVisibleScopes(subjectOf(), 'project:admin', world)).toEqual([]);
  });
});
