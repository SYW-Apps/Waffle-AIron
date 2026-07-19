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
  VisibleScope,
} from './types.js';

// ---------------------------------------------------------------------------
// Permission Resolver (sdd_host) — the PURE hierarchical resolution core.
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
// ---------------------------------------------------------------------------

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
 * Build the target's ancestor chain leaf->root, ending at the instance root.
 * A project's chain begins at its own project scope, then continues through the
 * unit it is placed in and that unit's ancestors — so a project-scoped setting
 * outranks its owning unit's.
 */
function ancestorChain(targetScopeKind: string, targetScopeId: string, world: PermissionWorld): Scope[] {
  if (targetScopeKind === 'project') {
    const placement = world.placements.find((p) => p.projectId === targetScopeId);
    const unitPart = placement ? unitChain(placement.unitId, world) : [];
    return [{ kind: 'project', id: targetScopeId }, ...unitPart, INSTANCE_ROOT];
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
function decideScope(settings: ScopeSettings): ScopeDecision | null {
  if (isDefinitive(settings.user)) return { value: settings.user, source: 'user' };

  const best = settings.roleValues.reduce<PermissionValue | undefined>(
    (acc, v) => (acc === undefined || grantRank(v) > grantRank(acc) ? v : acc),
    undefined,
  );
  if (best !== undefined && grantRank(best) > 0) return { value: best as EffectiveValue, source: 'role' };

  if (isDefinitive(settings.everyone)) return { value: settings.everyone, source: 'everyone-default' };

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
  const chain = ancestorChain(targetScopeKind, targetScopeId, world);

  // Step 4: walk the chain, stopping at the nearest scope with a definitive value.
  for (const scope of chain) {
    // Step 5: gather the settings that apply at this scope.
    const settings = settingsAtScope(subject, capability, scope, world);

    // Step 6: resolve this scope's value by precedence.
    const decision = decideScope(settings);

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

/** Every unit and placed project in the world, as resolvable scopes. */
function allScopes(world: PermissionWorld): { kind: 'unit' | 'project'; id: string }[] {
  const projectIds = [...new Set(world.placements.map((p) => p.projectId))];
  return [
    ...world.units.map((u) => ({ kind: 'unit' as const, id: u.id })),
    ...projectIds.map((id) => ({ kind: 'project' as const, id })),
  ];
}

/** The ancestor UNITS of a scope (excluding the scope itself), nearest first. */
function ancestorUnitsOf(scope: { kind: 'unit' | 'project'; id: string }, world: PermissionWorld): string[] {
  if (scope.kind === 'project') {
    const placement = world.placements.find((p) => p.projectId === scope.id);
    return placement ? unitChain(placement.unitId, world).map((s) => s.id as string) : [];
  }
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

  // Step 4: determine the subject's view of every scope.
  for (const scope of allScopes(world)) {
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

/** Capability re-export so consumers share one canonical list. */
export const CAPABILITIES: Capability[] = [
  'project:read',
  'project:create',
  'project:write',
  'project:admin',
  'approval:decide',
  'share:create',
];
