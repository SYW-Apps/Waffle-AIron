import * as fs from 'fs';
import * as path from 'path';
import type { HostedUserRecord, ProjectGrant } from './types.js';

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

/** Lifecycle statuses a hosted user may hold. */
const VALID_STATUSES = ['active', 'suspended', 'deactivated'];

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
 * Replace a user's grants wholesale with the supplied set — no merging, since the
 * caller has already computed and authorized the final grant state. An unknown id
 * fails with a not-found error. Persists atomically and returns the updated record.
 */
function registryReplaceGrants(dataDir: string, id: string, grants: ProjectGrant[]): HostedUserRecord {
  const records = loadStore(dataDir);
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) {
    throw new Error(`Hosted user "${id}" not found.`);
  }
  const stored: HostedUserRecord = { ...records[idx], grants };
  records[idx] = stored;
  replaceAll(dataDir, records);
  return stored;
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
 * List users filtered by the optional status and the optional project id — a
 * project filter matches users holding at least one grant scoped to that project
 * or an instance-wide ('*') grant — sorted by id for stable pagination.
 */
function indexList(dataDir: string, status?: string, projectId?: string): HostedUserRecord[] {
  let records = loadStore(dataDir);
  if (status) {
    records = records.filter((r) => r.status === status);
  }
  if (projectId) {
    records = records.filter((r) =>
      r.grants.some((g) => g.projectId === projectId || g.projectId === '*'),
    );
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

/** Replace a user's grants through the repository facade after authorization (atomic). */
export function replaceUserGrants(
  dataDir: string,
  id: string,
  grants: ProjectGrant[],
): HostedUserRecord {
  return registryReplaceGrants(dataDir, id, grants);
}
