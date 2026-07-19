import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { PermissionAssignment, UnitIdRemap } from './types.js';

// ---------------------------------------------------------------------------
// Permission Repository (sdd_host)
//
// File-backed durable state for the permission-assignment grid at
// <dataDir>/permissions.json, mirroring the user repository's convention.
//
// Internally this is the owned store / registry / index triad from the specs:
//   - store    (load / replaceAll): authoritative record set, disk-backed.
//   - registry (registrySet/…):          the write path — mutate + atomic swap.
//   - index    (indexList/…):            the read path — pure projection.
// The exported functions are the permission_repository facade: 1:1 forwarding.
//
// The grid holds ONE value per (subjectKind, subjectId, scopeKind, scopeId,
// capability) key — the atom the hierarchical resolver walks.
// ---------------------------------------------------------------------------

function storePath(dataDir: string): string {
  return path.join(dataDir, 'permissions.json');
}

/** The natural key of an assignment — one value per subject × scope × capability. */
function assignmentKey(a: PermissionAssignment): string {
  return [a.subjectKind, a.subjectId ?? '', a.scopeKind, a.scopeId ?? '', a.capability].join('|');
}

// ── Store ────────────────────────────────────────────────────────────────

/**
 * Load the persisted assignment grid as the authoritative record representation.
 * A missing file yields an empty set (first boot is not an error); an unreadable
 * file or structurally invalid JSON fails with a storage error naming the path so
 * the operator can repair it — persisted permissions are never silently dropped
 * (silently dropping them would fail OPEN for denies).
 */
function load(dataDir: string): PermissionAssignment[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Cannot read permission store at ${p}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed permission store at ${p}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed permission store at ${p}: expected a JSON array of assignments.`);
  }
  return parsed as PermissionAssignment[];
}

/**
 * Swap the authoritative grid to the supplied complete set in one atomic
 * write-temp-then-rename, so a crash never truncates the file and readers never
 * observe a half-written state. Only called by the registry after a mutation.
 */
function replaceAll(dataDir: string, assignments: PermissionAssignment[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(assignments, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── Registry (write path) ──────────────────────────────────────────────────

/**
 * Upsert one assignment, replacing any existing value for the same natural key
 * so the grid never holds two values for one subject × scope × capability.
 * Stamps id/createdAt on create and preserves them on replace. Setting the value
 * to 'inherit' CLEARS the override — it is stored as an explicit removal, which
 * is exactly what the resolver treats as non-deciding.
 */
function registrySet(dataDir: string, assignment: PermissionAssignment): PermissionAssignment {
  const assignments = load(dataDir);
  const key = assignmentKey(assignment);
  const idx = assignments.findIndex((a) => assignmentKey(a) === key);

  if (assignment.value === 'inherit') {
    const cleared: PermissionAssignment = {
      ...assignment,
      id: idx === -1 ? assignment.id || randomUUID() : assignments[idx].id,
      createdAt: idx === -1 ? new Date().toISOString() : assignments[idx].createdAt,
    };
    if (idx !== -1) {
      assignments.splice(idx, 1);
      replaceAll(dataDir, assignments);
    }
    return cleared;
  }

  const stored: PermissionAssignment =
    idx === -1
      ? { ...assignment, id: assignment.id || randomUUID(), createdAt: new Date().toISOString() }
      : { ...assignment, id: assignments[idx].id, createdAt: assignments[idx].createdAt };

  if (idx === -1) assignments.push(stored);
  else assignments[idx] = stored;

  replaceAll(dataDir, assignments);
  return stored;
}

/** Remove one assignment by id and persist atomically; an absent id is a no-op. */
function registryRemove(dataDir: string, assignmentId: string): void {
  const assignments = load(dataDir);
  const remaining = assignments.filter((a) => a.id !== assignmentId);
  if (remaining.length === assignments.length) return;
  replaceAll(dataDir, remaining);
}

/**
 * Rewrite the scopeId of every assignment referencing an old unit/project id to
 * its new id, applied when an organization unit is renamed or moved. Without
 * this a `no` scoped at a moved unit would silently vanish — an escalation.
 */
function registryRemapScope(dataDir: string, remap: UnitIdRemap[]): void {
  if (remap.length === 0) return;
  const lookup = new Map(remap.map((r) => [r.oldId, r.newId]));
  const assignments = load(dataDir);
  let changed = false;
  const rewritten = assignments.map((a) => {
    const next = a.scopeId ? lookup.get(a.scopeId) : undefined;
    if (!next) return a;
    changed = true;
    return { ...a, scopeId: next };
  });
  if (!changed) return;
  replaceAll(dataDir, rewritten);
}

/**
 * Remove every assignment scoped to one of the given ids — the scopes of a
 * cascade-deleted unit subtree. Prevents orphaned grants/denies from
 * resurrecting if a unit is later recreated at the same qualified path.
 */
function registryRemoveForScopes(dataDir: string, scopeIds: string[]): void {
  if (scopeIds.length === 0) return;
  const doomed = new Set(scopeIds);
  const assignments = load(dataDir);
  const remaining = assignments.filter((a) => !(a.scopeId && doomed.has(a.scopeId)));
  if (remaining.length === assignments.length) return;
  replaceAll(dataDir, remaining);
}

// ── Index (read path) ──────────────────────────────────────────────────────

/**
 * List assignments narrowed by any combination of scopeIds (the target's
 * ancestor chain), subjectKind, subjectId, and capability. All filters are
 * optional; an empty filter returns every assignment.
 */
function indexList(
  dataDir: string,
  scopeIds?: string[],
  subjectKind?: string,
  subjectId?: string,
  capability?: string,
): PermissionAssignment[] {
  let assignments = load(dataDir);
  if (scopeIds && scopeIds.length > 0) {
    const wanted = new Set(scopeIds);
    assignments = assignments.filter((a) => a.scopeId !== undefined && wanted.has(a.scopeId));
  }
  if (subjectKind) assignments = assignments.filter((a) => a.subjectKind === subjectKind);
  if (subjectId) assignments = assignments.filter((a) => a.subjectId === subjectId);
  if (capability) assignments = assignments.filter((a) => a.capability === capability);
  return assignments;
}

/** Return one assignment by id, or null when absent. */
function indexGet(dataDir: string, assignmentId: string): PermissionAssignment | null {
  return load(dataDir).find((a) => a.id === assignmentId) ?? null;
}

// ── Repository facade (1:1 forwarding) ─────────────────────────────────────

/** Upsert one assignment through the repository facade (atomic). */
export function setAssignment(dataDir: string, assignment: PermissionAssignment): PermissionAssignment {
  return registrySet(dataDir, assignment);
}

/** Remove one assignment by id through the repository facade. */
export function removeAssignment(dataDir: string, assignmentId: string): void {
  registryRemove(dataDir, assignmentId);
}

/** Remap assignment scopes after a unit rename/move through the facade (atomic). */
export function remapScope(dataDir: string, remap: UnitIdRemap[]): void {
  registryRemapScope(dataDir, remap);
}

/** Remove every assignment scoped to a cascade-deleted subtree (atomic). */
export function removeAssignmentsForScopes(dataDir: string, scopeIds: string[]): void {
  registryRemoveForScopes(dataDir, scopeIds);
}

/** List assignments through the repository facade. */
export function listAssignments(
  dataDir: string,
  scopeIds?: string[],
  subjectKind?: string,
  subjectId?: string,
  capability?: string,
): PermissionAssignment[] {
  return indexList(dataDir, scopeIds, subjectKind, subjectId, capability);
}

/** Look up one assignment by id through the repository facade. */
export function getAssignment(dataDir: string, assignmentId: string): PermissionAssignment | null {
  return indexGet(dataDir, assignmentId);
}
