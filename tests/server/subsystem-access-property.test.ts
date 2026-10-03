import { describe, it, expect } from 'vitest';
import { resolvePermission, resolveSubsystemReach, resolveVisibleScopes } from '../../src/server/permission-rules.js';
import type {
  EffectivePermission,
  EffectiveValue,
  OrganizationUnitRecord,
  PermissionAssignment,
  PermissionSubject,
  PermissionValue,
  PermissionWorld,
  ProjectParentLink,
  ProjectPlacement,
  Role,
  RoleBinding,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Subsystem access rules — the NO-WIDENING property, over a generated
// permission matrix (pure: nothing mocked, nothing read).
//
// The subsystem rung is visited only for a subsystem target and only for
// project:write. Three claims, each checked over every subject x capability x
// target of many generated worlds:
//   1. Today's resolver (a verbatim copy of the pre-subsystem walk, kept here)
//      and the new one agree on every unit and project target.
//   2. A subsystem with no settings of its own resolves exactly as its project.
//   3. Adding subsystem settings never changes a unit or project result.
// The generator covers user subjects, roles anchored at the instance, units and
// projects (and, for claim 3, at subsystems), everyone-defaults, every
// capability, member chains (parent links), and every target kind.
// ---------------------------------------------------------------------------

// ── the resolver as it was before subsystem rules (kept verbatim in logic) ──

type OldScope = { kind: 'instance' | 'unit' | 'project'; id?: string };

function oldResolve(subject: PermissionSubject, capability: string, kind: string, id: string, world: PermissionWorld): EffectivePermission {
  if (subject.instanceAdmin) return { value: 'yes', source: 'instance-admin' };
  const unitChain = (unitId: string): OldScope[] => {
    const chain: OldScope[] = [];
    const seen = new Set<string>();
    let current: string | undefined = unitId;
    while (current && !seen.has(current)) {
      seen.add(current);
      chain.push({ kind: 'unit', id: current });
      current = world.units.find((u) => u.id === current)?.parentId;
    }
    return chain;
  };
  const projectChain = (projectId: string): string[] => {
    const chain: string[] = [];
    let current: string | undefined = projectId;
    while (current !== undefined && !chain.includes(current)) {
      chain.push(current);
      const at: string = current;
      current = (world.parents ?? []).find((l) => l.projectId === at)?.parentProjectId;
    }
    return chain;
  };
  let chain: OldScope[];
  if (kind === 'project') {
    const projects = projectChain(id);
    const placement = world.placements.find((p) => p.projectId === projects[projects.length - 1]);
    chain = [...projects.map((p) => ({ kind: 'project' as const, id: p })), ...(placement ? unitChain(placement.unitId) : []), { kind: 'instance' }];
  } else if (kind === 'unit') {
    chain = [...unitChain(id), { kind: 'instance' }];
  } else {
    chain = [{ kind: 'instance' }];
  }
  const rank = (v: PermissionValue): number => (v === 'yes' ? 2 : v === 'approval' ? 1 : 0);
  for (const scope of chain) {
    const here = world.assignments.filter((a) => a.capability === capability && a.scopeKind === scope.kind && (a.scopeId ?? undefined) === scope.id);
    const matches = (sid?: string): boolean => !!sid && (sid === subject.subjectId || (subject.aliasSubjectIds ?? []).includes(sid));
    const user = here.find((a) => a.subjectKind === 'user' && matches(a.subjectId))?.value;
    if (user !== undefined && user !== 'inherit') return { value: user as EffectiveValue, source: 'user', decidedScopeKind: scope.kind, decidedScopeId: scope.id };
    const roleValues: PermissionValue[] = [];
    for (const b of subject.roleBindings) {
      const anchors = !b.scopeKind || !b.scopeId ? scope.kind === 'instance' : b.scopeKind === scope.kind && b.scopeId === scope.id;
      if (!anchors) continue;
      const role = world.roles.find((r) => r.id === b.roleId);
      for (const p of role?.permissions ?? []) if (p.capability === capability) roleValues.push(p.value);
    }
    const best = roleValues.reduce<PermissionValue | undefined>((acc, v) => (acc === undefined || rank(v) > rank(acc) ? v : acc), undefined);
    if (best !== undefined && rank(best) > 0) return { value: best as EffectiveValue, source: 'role', decidedScopeKind: scope.kind, decidedScopeId: scope.id };
    const everyone = here.find((a) => a.subjectKind === 'everyone')?.value;
    if (everyone !== undefined && everyone !== 'inherit') return { value: everyone as EffectiveValue, source: 'everyone-default', decidedScopeKind: scope.kind, decidedScopeId: scope.id };
  }
  return { value: 'no', source: 'instance-default' };
}

// ── the generated matrix ─────────────────────────────────────────────────────

/** A deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CAPS = ['project:read', 'project:create', 'project:write', 'project:admin', 'approval:decide', 'share:create'] as const;
const VALUES: PermissionValue[] = ['yes', 'approval', 'no', 'inherit'];
const actor = { userId: 'seed', kind: 'human' as const, issuer: 'local' };

const UNITS: OrganizationUnitRecord[] = [
  ['acme', undefined], ['acme.it', 'acme'], ['acme.it.web', 'acme.it'], ['globex', undefined],
].map(([id, parentId]) => ({ id: id as string, name: id as string, kind: 'group', slug: id as string, ...(parentId ? { parentId } : {}), status: 'active', createdAt: '', createdBy: actor }));
const PLACEMENTS: ProjectPlacement[] = [['shop', 'acme.it.web'], ['crm', 'acme'], ['ext', 'globex']]
  .map(([projectId, unitId]) => ({ id: `${projectId}@${unitId}`, projectId, unitId, role: 'owner', createdAt: '', createdBy: actor }));
/** Member chains: shop ⊃ billing ⊃ ledger, crm ⊃ portal. */
const PARENTS: ProjectParentLink[] = [
  { projectId: 'billing', parentProjectId: 'shop' },
  { projectId: 'ledger', parentProjectId: 'billing' },
  { projectId: 'portal', parentProjectId: 'crm' },
];
const PROJECTS = ['shop', 'crm', 'ext', 'billing', 'ledger', 'portal'];
const SUBSYSTEMS = ['shop/payments', 'shop/catalog', 'billing/invoices', 'ledger/core', 'crm/sales'];
const ROLES: Role[] = [
  { id: 'writer', name: 'w', permissions: [{ capability: 'project:write', value: 'yes' }, { capability: 'project:read', value: 'yes' }], createdAt: '' },
  { id: 'approver', name: 'a', permissions: [{ capability: 'project:write', value: 'approval' }, { capability: 'approval:decide', value: 'yes' }], createdAt: '' },
  { id: 'admin', name: 'ad', permissions: CAPS.map((c) => ({ capability: c, value: 'yes' as PermissionValue })), createdAt: '' },
  { id: 'denier', name: 'd', permissions: [{ capability: 'project:write', value: 'no' }], createdAt: '' },
];
const SUBJECT_IDS = ['u1', 'u2', 'u3', 'u4'];

/** The unit and project scopes a setting may sit at (the instance root included). */
const BASE_SCOPES: { kind: 'instance' | 'unit' | 'project'; id?: string }[] = [
  { kind: 'instance' },
  ...UNITS.map((u) => ({ kind: 'unit' as const, id: u.id })),
  ...PROJECTS.map((p) => ({ kind: 'project' as const, id: p })),
];

interface Generated {
  base: PermissionWorld;
  subjects: PermissionSubject[];
  withSubsystems: PermissionWorld;
  subjectsWithSubsystems: PermissionSubject[];
}

/** One generated world: random settings at unit/project scopes, then the same world plus subsystem settings. */
function generate(seed: number): Generated {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const assignments: PermissionAssignment[] = [];
  const n = 6 + Math.floor(r() * 18);
  for (let i = 0; i < n; i++) {
    const scope = pick(BASE_SCOPES);
    const everyone = r() < 0.3;
    assignments.push({
      id: `a${i}`, subjectKind: everyone ? 'everyone' : 'user', ...(everyone ? {} : { subjectId: pick(SUBJECT_IDS) }),
      scopeKind: scope.kind, ...(scope.id ? { scopeId: scope.id } : {}), capability: pick(CAPS), value: pick(VALUES), createdAt: '',
    });
  }
  const subjects: PermissionSubject[] = SUBJECT_IDS.map((id) => {
    const bindings: RoleBinding[] = [];
    const k = Math.floor(r() * 3);
    for (let i = 0; i < k; i++) {
      const scope = pick(BASE_SCOPES);
      bindings.push({ roleId: pick(ROLES).id, ...(scope.kind === 'instance' ? {} : { scopeKind: scope.kind, scopeId: scope.id }) });
    }
    return { subjectId: id, roleBindings: bindings, instanceAdmin: false, ...(id === 'u4' ? { aliasSubjectIds: ['u4-old'] } : {}) };
  });
  subjects.push({ subjectId: 'root', roleBindings: [], instanceAdmin: true });
  const base: PermissionWorld = { assignments, roles: ROLES, units: UNITS, placements: PLACEMENTS, parents: PARENTS };

  // The same world with subsystem settings added: assignments of every
  // capability and value (an admin refuses most of them — the resolver must
  // still never let one widen anything) and subsystem role bindings.
  const extra: PermissionAssignment[] = [];
  const m = 3 + Math.floor(r() * 10);
  for (let i = 0; i < m; i++) {
    const everyone = r() < 0.3;
    extra.push({
      id: `s${i}`, subjectKind: everyone ? 'everyone' : 'user', ...(everyone ? {} : { subjectId: pick([...SUBJECT_IDS, 'u4-old']) }),
      scopeKind: 'subsystem', scopeId: pick(SUBSYSTEMS), capability: r() < 0.7 ? 'project:write' : pick(CAPS), value: pick(VALUES), createdAt: '',
    });
  }
  const subjectsWithSubsystems = subjects.map((s) => (s.instanceAdmin ? s : {
    ...s,
    roleBindings: [...s.roleBindings, ...(r() < 0.5 ? [{ roleId: pick(ROLES).id, scopeKind: 'subsystem' as const, scopeId: pick(SUBSYSTEMS) }] : [])],
  }));
  return { base, subjects, withSubsystems: { ...base, assignments: [...assignments, ...extra] }, subjectsWithSubsystems };
}

const WORLDS = 60;
const UNIT_AND_PROJECT_TARGETS = [...UNITS.map((u) => ['unit', u.id] as const), ...PROJECTS.map((p) => ['project', p] as const)];

describe('subsystem access — no widening, over a generated permission matrix', () => {
  it('today\'s resolver and the new one agree on every unit and project target', () => {
    let compared = 0;
    for (let seed = 1; seed <= WORLDS; seed++) {
      const { base, subjects } = generate(seed);
      for (const subject of subjects) {
        for (const capability of CAPS) {
          for (const [kind, id] of UNIT_AND_PROJECT_TARGETS) {
            expect(resolvePermission(subject, capability, kind, id, base), `seed ${seed} ${subject.subjectId} ${capability} ${kind}:${id}`)
              .toEqual(oldResolve(subject, capability, kind, id, base));
            compared++;
          }
        }
      }
    }
    // 60 worlds x 5 subjects x 6 capabilities x 10 targets.
    expect(compared).toBe(WORLDS * 5 * CAPS.length * UNIT_AND_PROJECT_TARGETS.length);
  });

  it('a subsystem with no settings resolves exactly as its project, for every capability', () => {
    let compared = 0;
    for (let seed = 1; seed <= WORLDS; seed++) {
      const { base, subjects } = generate(seed);
      for (const subject of subjects) {
        for (const capability of CAPS) {
          for (const scopeId of SUBSYSTEMS) {
            const project = scopeId.split('/')[0];
            expect(resolvePermission(subject, capability, 'subsystem', scopeId, base), `seed ${seed} ${subject.subjectId} ${capability} ${scopeId}`)
              .toEqual(resolvePermission(subject, capability, 'project', project, base));
            compared++;
          }
        }
        // And nothing differs from the project: no subsystem rung is met.
        for (const project of PROJECTS) expect(resolveSubsystemReach(subject, project, base)).toEqual([]);
      }
    }
    expect(compared).toBe(WORLDS * 5 * CAPS.length * SUBSYSTEMS.length);
  });

  it('adding subsystem settings never changes a unit or project result, nor any capability but project:write at a subsystem', () => {
    let compared = 0;
    for (let seed = 1; seed <= WORLDS; seed++) {
      const { base, subjects, withSubsystems, subjectsWithSubsystems } = generate(seed);
      subjects.forEach((before, i) => {
        const after = subjectsWithSubsystems[i];
        for (const capability of CAPS) {
          for (const [kind, id] of UNIT_AND_PROJECT_TARGETS) {
            const was = oldResolve(before, capability, kind, id, base);
            expect(resolvePermission(after, capability, kind, id, withSubsystems), `seed ${seed} ${after.subjectId} ${capability} ${kind}:${id}`).toEqual(was);
            compared++;
          }
          if (capability === 'project:write') continue;
          for (const scopeId of SUBSYSTEMS) {
            const project = scopeId.split('/')[0];
            expect(resolvePermission(after, capability, 'subsystem', scopeId, withSubsystems))
              .toEqual(resolvePermission(after, capability, 'project', project, withSubsystems));
          }
        }
        // The visible-scope views of units and projects are unchanged for every capability.
        for (const capability of CAPS) {
          const unitsAndProjects = (v: ReturnType<typeof resolveVisibleScopes>) => v.filter((s) => s.scopeKind !== 'subsystem' && !s.context);
          expect(unitsAndProjects(resolveVisibleScopes(after, capability, withSubsystems)))
            .toEqual(unitsAndProjects(resolveVisibleScopes(before, capability, base)));
        }
      });
    }
    expect(compared).toBe(WORLDS * 5 * CAPS.length * UNIT_AND_PROJECT_TARGETS.length);
  });

  it('at a subsystem rung only yes and no decide: an approval there defers to the project', () => {
    const world: PermissionWorld = {
      assignments: [
        { id: 'p', subjectKind: 'user', subjectId: 'u', scopeKind: 'project', scopeId: 'shop', capability: 'project:write', value: 'yes', createdAt: '' },
        { id: 's', subjectKind: 'user', subjectId: 'u', scopeKind: 'subsystem', scopeId: 'shop/payments', capability: 'project:write', value: 'approval', createdAt: '' },
      ],
      roles: ROLES, units: UNITS, placements: PLACEMENTS, parents: PARENTS,
    };
    const u: PermissionSubject = { subjectId: 'u', roleBindings: [{ roleId: 'approver', scopeKind: 'subsystem', scopeId: 'shop/payments' }], instanceAdmin: false };
    expect(resolvePermission(u, 'project:write', 'subsystem', 'shop/payments', world)).toMatchObject({ value: 'yes', decidedScopeKind: 'project', decidedScopeId: 'shop' });
    // A subsystem id without the separator names no scope.
    expect(resolvePermission(u, 'project:write', 'subsystem', 'shop', world)).toEqual({ value: 'no', source: 'instance-default' });
  });

  it('a subsystem no beats the project\'s yes; a subsystem yes works without project write; parts inherit the member chain', () => {
    const world: PermissionWorld = {
      assignments: [
        { id: '1', subjectKind: 'user', subjectId: 'dev', scopeKind: 'project', scopeId: 'shop', capability: 'project:write', value: 'yes', createdAt: '' },
        { id: '2', subjectKind: 'user', subjectId: 'dev', scopeKind: 'subsystem', scopeId: 'shop/payments', capability: 'project:write', value: 'no', createdAt: '' },
        { id: '3', subjectKind: 'user', subjectId: 'team', scopeKind: 'subsystem', scopeId: 'ledger/core', capability: 'project:write', value: 'yes', createdAt: '' },
      ],
      roles: ROLES, units: UNITS, placements: PLACEMENTS, parents: PARENTS,
    };
    const dev: PermissionSubject = { subjectId: 'dev', roleBindings: [], instanceAdmin: false };
    const team: PermissionSubject = { subjectId: 'team', roleBindings: [], instanceAdmin: false };
    expect(resolvePermission(dev, 'project:write', 'subsystem', 'shop/payments', world)).toMatchObject({ value: 'no', source: 'user', decidedScopeKind: 'subsystem', decidedScopeId: 'shop/payments' });
    expect(resolvePermission(dev, 'project:write', 'subsystem', 'shop/catalog', world)).toMatchObject({ value: 'yes', decidedScopeKind: 'project' });
    // A member's subsystem inherits the parent chain: billing/ledger take shop's yes.
    expect(resolvePermission(dev, 'project:write', 'subsystem', 'ledger/core', world)).toMatchObject({ value: 'yes', decidedScopeId: 'shop' });
    expect(resolvePermission(team, 'project:write', 'subsystem', 'ledger/core', world)).toMatchObject({ value: 'yes', decidedScopeKind: 'subsystem' });
    expect(resolvePermission(team, 'project:write', 'project', 'ledger', world).value).toBe('no');
    expect(resolveSubsystemReach(dev, 'shop', world)).toEqual([
      { projectId: 'shop', subsystemId: 'payments', permission: expect.objectContaining({ value: 'no', decidedScopeKind: 'subsystem' }) },
    ]);
    // The project:write view lists the subsystem, with its project and units as breadcrumb.
    const view = resolveVisibleScopes(team, 'project:write', world);
    expect(view).toEqual(expect.arrayContaining([
      { scopeKind: 'subsystem', scopeId: 'ledger/core', value: 'yes', context: false },
      expect.objectContaining({ scopeKind: 'project', scopeId: 'ledger', context: true }),
      expect.objectContaining({ scopeKind: 'unit', scopeId: 'acme.it.web', context: true }),
    ]));
    // An instance-admin meets no subsystem rung.
    expect(resolveSubsystemReach({ subjectId: 'root', roleBindings: [], instanceAdmin: true }, 'shop', world)).toEqual([]);
  });
});
