import * as fs from 'fs';
import * as path from 'path';
import { listAssignments } from './permissions.js';
import type { HostedUserRecord, UnitIdRemap } from './types.js';

// ---------------------------------------------------------------------------
// User Repository (sdd_host)
//
// File-backed durable state for hosted human and service-principal accounts at
// <dataDir>/users.json, mirroring the credential registry's storage convention.
//
// Internally this is the owned store / registry / index triad from the specs:
//   - store    (loadStore / replaceAll): authoritative record set, disk-backed.
//   - registry (registryUpsert/…):       the write path — mutate + atomic swap.
//   - index    (indexGetById/…):         the read path — pure projection.
// The exported functions are the user_repository facade: pure 1:1 forwarding of
// reads to the index and writes to the registry, with no logic of their own.
// ---------------------------------------------------------------------------

/** Lifecycle statuses a hosted user may hold. The status axis is canonically
 *  `active` | `inactive` (per hosted_user_record); the legacy `suspended` /
 *  `deactivated` / `disabled` values are still accepted and all mean inactive
 *  (any non-`active` status revokes access and blocks sign-in). */
const VALID_STATUSES = ['active', 'inactive', 'suspended', 'deactivated', 'disabled'];

function storePath(dataDir: string): string {
  return path.join(dataDir, 'users.json');
}

// ── Store ────────────────────────────────────────────────────────────────

/**
 * Load the persisted hosted-user set as the authoritative record representation.
 * A missing file yields an empty set (first boot is not an error); an unreadable
 * file or structurally invalid JSON fails with a storage error naming the path so
 * the operator can repair it — persisted users are never silently discarded.
 */
function loadStore(dataDir: string): HostedUserRecord[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Cannot read hosted-user store at ${p}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed hosted-user store at ${p}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed hosted-user store at ${p}: expected a JSON array of user records.`);
  }
  return parsed as HostedUserRecord[];
}

/**
 * Swap the authoritative set to the supplied complete record set in one atomic
 * write-temp-then-rename, so a crash never truncates the file and readers never
 * observe a half-written state. Only called by the registry after a mutation.
 */
function replaceAll(dataDir: string, records: HostedUserRecord[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── Registry (write path) ──────────────────────────────────────────────────

/**
 * Merge the record into the current set by id — inserting when absent, replacing
 * field-for-field when present — stamping createdAt on insert (and preserving the
 * original createdAt on update, so it is stamped exactly once). Persists the whole
 * set atomically, then returns the stored record. NOTE: the intent prose also
 * mentions stamping updatedAt, but HostedUserRecord has no updatedAt field, so the
 * authoritative type wins and no updatedAt is written.
 */
function registryUpsert(dataDir: string, record: HostedUserRecord): HostedUserRecord {
  const records = loadStore(dataDir);
  const idx = records.findIndex((r) => r.id === record.id);
  let stored: HostedUserRecord;
  if (idx === -1) {
    stored = { ...record, createdAt: new Date().toISOString() };
    records.push(stored);
  } else {
    stored = { ...record, createdAt: records[idx].createdAt };
    records[idx] = stored;
  }
  replaceAll(dataDir, records);
  return stored;
}

/**
 * Set a user's lifecycle status while preserving every other field. Invalid status
 * values are rejected before any mutation; an unknown id fails with a not-found
 * error. Persists atomically and returns the updated record.
 */
function registrySetStatus(dataDir: string, id: string, status: string): HostedUserRecord {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid user status "${status}" (allowed: ${VALID_STATUSES.join(', ')}).`);
  }
  const records = loadStore(dataDir);
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw new Error(`Hosted user "${id}" not found.`);
  }
  const stored: HostedUserRecord = { ...records[idx], status };
  records[idx] = stored;
  replaceAll(dataDir, records);
  return stored;
}

/**
 * Rewrite every user's home unitId and role-binding scopeIds per the remap (a
 * unit rename/move), and clear any home unitId or role-binding scoped to a
 * removedScopeId (a cascade-deleted subtree). Persists atomically.
 *
 * Without this, a moved unit would leave users pointing at a qualified id that
 * no longer exists — and a binding orphaned at a reused path would silently
 * resurrect when a unit is later recreated there.
 */
function registryRemapUnitReferences(
  dataDir: string,
  remap: UnitIdRemap[],
  removedScopeIds: string[],
): void {
  if (remap.length === 0 && removedScopeIds.length === 0) return;
  const lookup = new Map(remap.map((r) => [r.oldId, r.newId]));
  const removed = new Set(removedScopeIds);
  const records = loadStore(dataDir);
  let changed = false;

  const rewritten = records.map((record) => {
    const next: HostedUserRecord = { ...record };

    if (next.unitId) {
      const moved = lookup.get(next.unitId);
      if (moved) {
        next.unitId = moved;
        changed = true;
      } else if (removed.has(next.unitId)) {
        delete next.unitId;
        changed = true;
      }
    }

    if (next.roleBindings && next.roleBindings.length > 0) {
      const bindings = next.roleBindings
        .filter((b) => !(b.scopeId && removed.has(b.scopeId)))
        .map((b) => (b.scopeId && lookup.has(b.scopeId) ? { ...b, scopeId: lookup.get(b.scopeId) } : b));
      if (
        bindings.length !== next.roleBindings.length ||
        bindings.some((b, i) => b.scopeId !== next.roleBindings?.[i]?.scopeId)
      ) {
        next.roleBindings = bindings;
        changed = true;
      }
    }

    return next;
  });

  if (!changed) return;
  replaceAll(dataDir, rewritten);
}

// ── Index (read path) ──────────────────────────────────────────────────────

/** Return the record whose id matches exactly, or null when absent. */
function indexGetById(dataDir: string, id: string): HostedUserRecord | null {
  return loadStore(dataDir).find((r) => r.id === id) ?? null;
}

/**
 * Return the record bound to both the issuer and external subject exactly, or null.
 * Comparison is exact and case-sensitive because provider subjects are opaque ids.
 */
function indexFindByExternalSubject(
  dataDir: string,
  issuer: string,
  externalSubject: string,
): HostedUserRecord | null {
  return (
    loadStore(dataDir).find(
      (r) => r.subject.issuer === issuer && r.subject.externalSubject === externalSubject,
    ) ?? null
  );
}

/**
 * List users filtered by the optional status and the optional project id, sorted
 * by id for stable pagination.
 *
 * The project filter matches users holding a direct permission assignment scoped
 * to that project. Grants are gone, so a user record no longer carries any
 * project reference of its own — "who is on project X" is now a question for the
 * permission grid, and answering it from the grid keeps the admin filter honest
 * rather than silently widening to every user. It deliberately does NOT resolve
 * inherited access (a broader unit/instance grant): that is a resolver question,
 * and admins inspect effective access through the assignment views.
 */
function indexList(dataDir: string, status?: string, projectId?: string): HostedUserRecord[] {
  let records = loadStore(dataDir);
  if (status) {
    records = records.filter((r) => r.status === status);
  }
  if (projectId) {
    const holders = new Set(
      listAssignments(dataDir, [projectId], 'user')
        .map((a) => a.subjectId)
        .filter((id): id is string => id !== undefined),
    );
    records = records.filter((r) => holders.has(r.id));
  }
  return records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── Repository facade (1:1 forwarding) ─────────────────────────────────────

/** Return one hosted user by Wairon user id or null when absent. */
export function getUserById(dataDir: string, id: string): HostedUserRecord | null {
  return indexGetById(dataDir, id);
}

/** Return one hosted user by external issuer subject or null when absent. */
export function findUserByExternalSubject(
  dataDir: string,
  issuer: string,
  externalSubject: string,
): HostedUserRecord | null {
  return indexFindByExternalSubject(dataDir, issuer, externalSubject);
}

/** List hosted users, optionally narrowed by status or project id. */
export function listUsers(dataDir: string, status?: string, projectId?: string): HostedUserRecord[] {
  return indexList(dataDir, status, projectId);
}

/** Create or update a hosted user through the repository facade (atomic). */
export function upsertUser(dataDir: string, record: HostedUserRecord): HostedUserRecord {
  return registryUpsert(dataDir, record);
}

/** Set a user's lifecycle status through the repository facade (atomic). */
export function setUserStatus(dataDir: string, id: string, status: string): HostedUserRecord {
  return registrySetStatus(dataDir, id, status);
}

/**
 * Rewrite/clear user home units and role-binding scopes for a unit
 * rename/move/cascade through the repository facade (atomic).
 *
 * (There is no replaceUserGrants: grants are gone. A user's permissions are
 * managed through role bindings and the assignment grid — see
 * permission_admin_orchestrator's bindRole / setAssignment.)
 */
export function remapUnitReferences(
  dataDir: string,
  remap: UnitIdRemap[],
  removedScopeIds: string[],
): void {
  registryRemapUnitReferences(dataDir, remap, removedScopeIds);
}
