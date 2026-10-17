import type {
  Capability,
  EffectivePermission,
  EffectiveValue,
  PermissionAssignment,
  PermissionSubject,
  PermissionValue,
  PermissionWorld,
  Role,
  ScopeKind,
  SubsystemReach,
  VisibleScope,
} from './types.js';
import { SUBSYSTEM_SCOPE_SEPARATOR, parseSubsystemScope } from './types.js';

// ---------------------------------------------------------------------------
// Permission Rules (sdd_host) — the PURE hierarchical resolution core.
//
// Performs no I/O and never authenticates: the caller has authenticated the
// principal and gathered the PermissionWorld. Deterministic over its inputs.
//
// The model in one paragraph: a permission is `yes` (act), `approval` (raise an
// approval request), or `no` (deny + invisible). Resolution walks the target's
// ancestor chain leaf->root and stops at the NEAREST scope with a definitive
// value. Within a scope: direct-user > role (most-permissive, granting-only) >
// everyone-default. Reaching the root undecided yields the instance default `no`.
//
// SECURITY — role anchoring: a subject's roles are evaluated ONLY at the scope
// their binding anchors to (an unscoped binding anchors at the instance root),
// never re-collected at every step of the walk. Re-pulling them per step would
// let a broadly-bound granting role defeat a nearer per-scope deny — a privilege
// escalation. See the "role anchoring" tests.
//
// Below a project sits one more rung, its subsystems (`<projectId>/<subsystemId>`):
// a subsystem carries only project:write, as yes or no. The rung is visited
// only for a subsystem target and only for project:write, so every unit and
// project resolution is exactly what it is without it (no widening by
// construction), and a subsystem with no setting resolves as its project.
// ---------------------------------------------------------------------------

/** The one capability a subsystem rung carries: changing that subsystem's specs. */
const SUBSYSTEM_CAPABILITY = 'project:write';

/** One rung of the ancestor chain the walk climbs. */
interface Scope {
  kind: ScopeKind;
  /** Absent for the instance root. */
  id?: string;
}

/** The instance root — the final rung of every chain. */
const INSTANCE_ROOT: Scope = { kind: 'instance' };

const scopeKey = (kind: string, id?: string): string => `${kind}:${id ?? ''}`;

/** True when a value decides the walk (anything but `inherit`). */
function isDefinitive(value: PermissionValue | undefined): value is EffectiveValue {
  return value !== undefined && value !== 'inherit';
}

/** Rank used to combine a subject's roles most-permissively at one scope. */
function grantRank(value: PermissionValue): number {
  if (value === 'yes') return 2;
  if (value === 'approval') return 1;
  return 0; // 'no' / 'inherit' — roles grant only, so these are non-deciding.
}

// ── Ancestor chain ─────────────────────────────────────────────────────────

/** Return the unit and each of its ancestors, nearest first, following parentId. */
function unitChain(unitId: string, world: PermissionWorld): Scope[] {
  const chain: Scope[] = [];
  const seen = new Set<string>();
  let current: string | undefined = unitId;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push({ kind: 'unit', id: current });
    current = world.units.find((u) => u.id === current)?.parentId;
  }
  return chain;
}

/**
 * The project rungs of a project's chain, leaf first: its own scope, then —
 * following the world's parent links, each visited once — every parent project
 * up to its family root. Projects nest like units.
 */
function projectChain(projectId: string, world: PermissionWorld): string[] {
  const chain: string[] = [];
  let current: string | undefined = projectId;
  while (current !== undefined && !chain.includes(current)) {
    chain.push(current);
    const at: string = current;
    current = (world.parents ?? []).find((l) => l.projectId === at)?.parentProjectId;
  }
  return chain;
}

/** The units a project takes from its family root's placement: the unit and its ancestors. */
function familyRootUnits(projectId: string, world: PermissionWorld): Scope[] {
  const chain = projectChain(projectId, world);
  const familyRoot = chain[chain.length - 1];
  const placement = world.placements.find((p) => p.projectId === familyRoot);
  return placement ? unitChain(placement.unitId, world) : [];
}

/**
 * Build the target's ancestor chain leaf->root, ending at the instance root.
 * A subsystem's chain is its own subsystem rung for project:write (none for any
 * other capability), then its project's chain; an id without the separator
 * names no scope and is the instance root alone. A project's chain is its own
 * project scope, then each parent project scope up to its family root, then the
 * FAMILY ROOT's placement unit and that unit's ancestors (a placement of a
 * member itself is not a rung) — so a project-scoped setting outranks its
 * parent's, and a parent's outranks the owning unit's.
 */
function ancestorChain(capability: string, targetScopeKind: string, targetScopeId: string, world: PermissionWorld): Scope[] {
  if (targetScopeKind === 'subsystem') {
    const parsed = parseSubsystemScope(targetScopeId);
    if (!parsed) return [INSTANCE_ROOT];
    const own: Scope[] = capability === SUBSYSTEM_CAPABILITY ? [{ kind: 'subsystem', id: targetScopeId }] : [];
    return [...own, ...ancestorChain(capability, 'project', parsed.projectId, world)];
  }
  if (targetScopeKind === 'project') {
    const projects = projectChain(targetScopeId, world).map((id) => ({ kind: 'project' as const, id }));
    return [...projects, ...familyRootUnits(targetScopeId, world), INSTANCE_ROOT];
  }
  if (targetScopeKind === 'unit') {
    return [...unitChain(targetScopeId, world), INSTANCE_ROOT];
  }
  return [INSTANCE_ROOT];
}

// ── Per-scope settings ─────────────────────────────────────────────────────

/** The subject's applicable settings at exactly one scope. */
interface ScopeSettings {
  user?: PermissionValue;
  roleValues: PermissionValue[];
  everyone?: PermissionValue;
}

/** True when the assignment sits at exactly this scope and capability. */
function assignmentAt(a: PermissionAssignment, scope: Scope, capability: string): boolean {
  return a.capability === capability && a.scopeKind === scope.kind && (a.scopeId ?? undefined) === scope.id;
}

/** True when the subject's role binding ANCHORS at this scope (unscoped => instance root). */
function bindingAnchorsAt(binding: { scopeKind?: ScopeKind; scopeId?: string }, scope: Scope): boolean {
  if (!binding.scopeKind || !binding.scopeId) return scope.kind === 'instance';
  return binding.scopeKind === scope.kind && binding.scopeId === scope.id;
}

/** The capability values the subject's roles anchored at this scope confer. */
function roleValuesAt(
  subject: PermissionSubject,
  capability: string,
  scope: Scope,
  roles: Role[],
): PermissionValue[] {
  const values: PermissionValue[] = [];
  for (const binding of subject.roleBindings) {
    if (!bindingAnchorsAt(binding, scope)) continue;
    const role = roles.find((r) => r.id === binding.roleId);
    if (!role) continue; // A binding to an unknown role confers nothing.
    for (const permission of role.permissions) {
      if (permission.capability === capability) values.push(permission.value);
    }
  }
  return values;
}

/**
 * Gather the subject's settings that apply AT THIS SCOPE: their direct-user
 * assignment here, the values from roles whose binding is anchored here, and the
 * everyone-default here. Roles are deliberately not re-pulled at every scope.
 */
function settingsAtScope(
  subject: PermissionSubject,
  capability: string,
  scope: Scope,
  world: PermissionWorld,
): ScopeSettings {
  const here = world.assignments.filter((a) => assignmentAt(a, scope, capability));
  return {
    user: here.find((a) => a.subjectKind === 'user' && subjectIdMatches(subject, a.subjectId))?.value,
    roleValues: roleValuesAt(subject, capability, scope, world.roles),
    everyone: here.find((a) => a.subjectKind === 'everyone')?.value,
  };
}

/**
 * A user-kind assignment applies when keyed by the subject's canonical id OR
 * any of its diverged aliases (a legacy record id ≠ subject userId) — a
 * per-user override must never silently miss a diverged user.
 */
function subjectIdMatches(subject: PermissionSubject, assignmentSubjectId: string | undefined): boolean {
  if (!assignmentSubjectId) return false;
  if (assignmentSubjectId === subject.subjectId) return true;
  return (subject.aliasSubjectIds ?? []).includes(assignmentSubjectId);
}

/** A scope's decision, or null when it defers upward. */
interface ScopeDecision {
  value: EffectiveValue;
  source: EffectivePermission['source'];
}

/**
 * Resolve one scope's value by precedence: a definitive direct-user value wins;
 * else the most-permissive GRANTING role value anchored here (yes > approval — a
 * role never denies, so 'no'/'inherit' is non-deciding); else the
 * everyone-default; else defer upward.
 */
function decideScope(settings: ScopeSettings, kind: ScopeKind): ScopeDecision | null {
  // A subsystem is a yes/no setting: only yes and no decide there, so a role's
  // approval (or an approval value anywhere) defers to the project.
  if (kind === 'subsystem') return decideSubsystemScope(settings);
  if (isDefinitive(settings.user)) return { value: settings.user, source: 'user' };

  const best = settings.roleValues.reduce<PermissionValue | undefined>(
    (acc, v) => (acc === undefined || grantRank(v) > grantRank(acc) ? v : acc),
    undefined,
  );
  if (best !== undefined && grantRank(best) > 0) return { value: best as EffectiveValue, source: 'role' };

  if (isDefinitive(settings.everyone)) return { value: settings.everyone, source: 'everyone-default' };

  return null;
}

/** A subsystem rung's decision: a user yes/no, else a role's yes, else an everyone yes/no; else defer. */
function decideSubsystemScope(settings: ScopeSettings): ScopeDecision | null {
  const yesOrNo = (v: PermissionValue | undefined): v is 'yes' | 'no' => v === 'yes' || v === 'no';
  if (yesOrNo(settings.user)) return { value: settings.user, source: 'user' };
  if (settings.roleValues.includes('yes')) return { value: 'yes', source: 'role' };
  if (yesOrNo(settings.everyone)) return { value: settings.everyone, source: 'everyone-default' };
  return null;
}

// ── Public contract ────────────────────────────────────────────────────────

/**
 * Compute the subject's effective permission for a capability at a target scope.
 * Pure. Returns the decided value plus the source and scope that decided it.
 */
export function resolvePermission(
  subject: PermissionSubject,
  capability: string,
  targetScopeKind: string,
  targetScopeId: string,
  world: PermissionWorld,
): EffectivePermission {
  // Step 1-2: an instance-admin subject is authorized everywhere — bypass the walk.
  if (subject.instanceAdmin) {
    return { value: 'yes', source: 'instance-admin' };
  }

  // Step 3: build the target's ancestor chain leaf->root, ending at the instance root.
  const chain = ancestorChain(capability, targetScopeKind, targetScopeId, world);

  // Step 4: walk the chain, stopping at the nearest scope with a definitive value.
  for (const scope of chain) {
    // Step 5: gather the settings that apply at this scope.
    const settings = settingsAtScope(subject, capability, scope, world);

    // Step 6: resolve this scope's value by precedence.
    const decision = decideScope(settings, scope.kind);

    // Step 7-8: a definitive value here decides the walk.
    if (decision) {
      return {
        value: decision.value,
        source: decision.source,
        decidedScopeKind: scope.kind,
        decidedScopeId: scope.id,
      };
    }

    // Step 9: nothing definitive here — continue to the next ancestor.
  }

  // Step 10: the walk reached the root with nothing definitive.
  return { value: 'no', source: 'instance-default' };
}

/** Every unit, placed project and member project in the world, as resolvable scopes. */
function allScopes(world: PermissionWorld): { kind: 'unit' | 'project'; id: string }[] {
  const projectIds = [...new Set([...world.placements.map((p) => p.projectId), ...(world.parents ?? []).map((l) => l.projectId)])];
  return [
    ...world.units.map((u) => ({ kind: 'unit' as const, id: u.id })),
    ...projectIds.map((id) => ({ kind: 'project' as const, id })),
  ];
}

/** A scope a visibility view judges. */
type JudgedScope = { kind: 'unit' | 'project' | 'subsystem'; id: string };

/**
 * The subsystem scopes a setting in the world names for this subject: a
 * project:write assignment at a subsystem scope, or one of the subject's role
 * bindings anchored at one — each once.
 */
function namedSubsystemScopes(subject: PermissionSubject, world: PermissionWorld): string[] {
  const ids = [
    ...world.assignments
      .filter((a) => a.scopeKind === 'subsystem' && a.capability === SUBSYSTEM_CAPABILITY && a.scopeId)
      .map((a) => a.scopeId as string),
    ...subject.roleBindings.filter((b) => b.scopeKind === 'subsystem' && b.scopeId).map((b) => b.scopeId as string),
  ];
  return [...new Set(ids)].filter((id) => parseSubsystemScope(id) !== null);
}

/** The scopes a view judges for a capability: every unit and project, and for project:write the named subsystems. */
function judgedScopes(subject: PermissionSubject, capability: string, world: PermissionWorld): JudgedScope[] {
  const subsystems = capability === SUBSYSTEM_CAPABILITY
    ? namedSubsystemScopes(subject, world).map((id) => ({ kind: 'subsystem' as const, id }))
    : [];
  return [...allScopes(world), ...subsystems];
}

/** The ancestor UNITS of a scope (excluding the scope itself), nearest first — a member's are its family root's. */
function ancestorUnitsOf(scope: JudgedScope, world: PermissionWorld): string[] {
  if (scope.kind === 'subsystem') {
    return familyRootUnits(parseSubsystemScope(scope.id)?.projectId ?? '', world).map((s) => s.id as string);
  }
  if (scope.kind === 'project') return familyRootUnits(scope.id, world).map((s) => s.id as string);
  return unitChain(scope.id, world)
    .map((s) => s.id as string)
    .filter((id) => id !== scope.id);
}

/**
 * Compute the scopes the subject can act on for a capability (actionable), plus
 * their ancestor units as navigation breadcrumbs (context). Never includes an
 * ancestor's other children, so a single deep-authorized project stays reachable
 * without leaking its siblings.
 */
export function resolveVisibleScopes(
  subject: PermissionSubject,
  capability: string,
  world: PermissionWorld,
): VisibleScope[] {
  // Step 1-2: an instance-admin sees every scope as actionable.
  if (subject.instanceAdmin) {
    return allScopes(world).map((s) => ({
      scopeKind: s.kind,
      scopeId: s.id,
      value: 'yes' as EffectiveValue,
      context: false,
    }));
  }

  // Step 3: prepare the visibility accumulator (actionable set and context set).
  const actionable = new Map<string, VisibleScope>();
  const context = new Map<string, VisibleScope>();

  // Step 4: determine the subject's view of every scope (for project:write, the
  // subsystem scopes a setting names too).
  for (const scope of judgedScopes(subject, capability, world)) {
    // Step 5: resolve this scope's effective permission for the given capability.
    const effective = resolvePermission(subject, capability, scope.kind, scope.id, world);

    // Step 6: a yes/approval scope is actionable.
    if (effective.value === 'yes' || effective.value === 'approval') {
      // Step 7: record it, and add its ancestor units as context breadcrumbs.
      actionable.set(scopeKey(scope.kind, scope.id), {
        scopeKind: scope.kind,
        scopeId: scope.id,
        value: effective.value,
        context: false,
      });
      // A subsystem's breadcrumb starts at its project.
      const project = scope.kind === 'subsystem' ? parseSubsystemScope(scope.id)?.projectId : undefined;
      if (project !== undefined && !context.has(scopeKey('project', project))) {
        context.set(scopeKey('project', project), {
          scopeKind: 'project',
          scopeId: project,
          value: resolvePermission(subject, capability, 'project', project, world).value,
          context: true,
        });
      }
      for (const unitId of ancestorUnitsOf(scope, world)) {
        const key = scopeKey('unit', unitId);
        if (context.has(key)) continue;
        context.set(key, {
          scopeKind: 'unit',
          scopeId: unitId,
          value: resolvePermission(subject, capability, 'unit', unitId, world).value,
          context: true,
        });
      }
    }

    // Step 8: advance to the next scope.
  }

  // Step 9: return the view, deduplicated by scope with actionable winning over context.
  const contextOnly = [...context.entries()]
    .filter(([key]) => !actionable.has(key))
    .map(([, scope]) => scope);
  return [...actionable.values(), ...contextOnly];
}

/**
 * The subsystem rungs the subject meets in one project: every subsystem scope
 * of the project carrying a setting that applies to the subject (a direct-user
 * assignment keyed by its id or an alias, an everyone-default, or one of its
 * role bindings anchored there), each with project:write resolved at it through
 * resolvePermission's walk. Every subsystem not listed resolves exactly as the
 * project. An instance-admin meets none: the bypass decides every scope.
 */
export function resolveSubsystemReach(
  subject: PermissionSubject,
  projectId: string,
  world: PermissionWorld,
): SubsystemReach[] {
  // Steps 1-2: the bypass decides every scope.
  if (subject.instanceAdmin) return [];
  // Step 3: the project's subsystem scopes whose settings apply to the subject, each once.
  const prefix = `${projectId}${SUBSYSTEM_SCOPE_SEPARATOR}`;
  const applies = (a: PermissionAssignment): boolean =>
    a.subjectKind === 'everyone' || (a.subjectKind === 'user' && subjectIdMatches(subject, a.subjectId));
  const scopeIds = [
    ...world.assignments
      .filter((a) => a.scopeKind === 'subsystem' && a.scopeId?.startsWith(prefix) && applies(a))
      .map((a) => a.scopeId as string),
    ...subject.roleBindings
      .filter((b) => b.scopeKind === 'subsystem' && b.scopeId?.startsWith(prefix))
      .map((b) => b.scopeId as string),
  ];
  const reach: SubsystemReach[] = [];
  // Steps 4-6: each judged through the same walk resolvePermission takes.
  for (const scopeId of new Set(scopeIds)) {
    const parsed = parseSubsystemScope(scopeId);
    if (!parsed || parsed.projectId !== projectId) continue;
    reach.push({
      projectId,
      subsystemId: parsed.subsystemId,
      permission: resolvePermission(subject, SUBSYSTEM_CAPABILITY, 'subsystem', scopeId, world),
    });
  }
  // Step 7: every subsystem not listed resolves exactly as the project.
  return reach;
}

/** Capability re-export so consumers share one canonical list. */
export const CAPABILITIES: Capability[] = [
  'project:read',
  'project:create',
  'project:write',
  'project:admin',
  'approval:decide',
  'share:create',
];
