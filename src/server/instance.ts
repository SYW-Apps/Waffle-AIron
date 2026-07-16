import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { InstanceIdentity } from './types.js';

// ---------------------------------------------------------------------------
// Instance Identity Repository (sdd_host)
//
// File-backed durable state for the SINGLETON instance-identity record at
// <dataDir>/instance.json: the boot-reserved UUIDs identifying the built-in
// subjects (super-admin, devMode local developer). Seeded ONCE by the lifecycle
// init entrypoint at first boot and never rotated — instance-admin recognition
// compares issuer 'local' AND userId === one of these persisted UUIDs, so an
// account NAME is never a subject id and stops being an attack surface. The
// legacy literals 'builtin:superadmin' / 'builtin:localdev' remain reserved
// (unclaimable by user records) for defense-in-depth but are no longer live
// subject ids.
//
// Internally this is the owned store / registry / index triad from the specs:
//   - store    (loadStore / replace):  authoritative record, disk-backed.
//   - registry (registrySeed):         the create-once write path (idempotent).
//   - index    (indexGet):             the read path — pure projection.
// The exported functions are the instance_identity_repository facade: 1:1
// forwarding, mirroring permissions.ts / roles.ts.
// ---------------------------------------------------------------------------

function storePath(dataDir: string): string {
  return path.join(dataDir, 'instance.json');
}

// ── Store ────────────────────────────────────────────────────────────────

/**
 * Load the persisted instance identity as the authoritative record. A missing
 * file yields null (the instance has never been seeded — first boot is not an
 * error); an unreadable file or structurally invalid JSON fails with a storage
 * error naming the path so the operator can repair it — a silently dropped
 * identity would orphan the built-in subjects.
 */
function loadStore(dataDir: string): InstanceIdentity | null {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read instance identity at ${p}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed instance identity at ${p}: ${(err as Error).message}`);
  }
  const rec = parsed as Partial<InstanceIdentity> | null;
  if (!rec || typeof rec !== 'object' || !rec.superadminUserId || !rec.localDevUserId) {
    throw new Error(
      `Malformed instance identity at ${p}: expected { superadminUserId, localDevUserId, createdAt }.`,
    );
  }
  return rec as InstanceIdentity;
}

/** Swap the persisted record in one atomic write-temp-then-rename, so a crash
 *  never truncates the file. Only called by the registry's create-once seed. */
function replace(dataDir: string, identity: InstanceIdentity): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── Registry (create-once write path) ───────────────────────────────────────

/**
 * Create-once seeding: when a record already exists, return it UNCHANGED
 * (idempotent — ids are never regenerated or rotated). Otherwise generate
 * cryptographically random UUIDs for the built-in super-admin and local-developer
 * subjects, stamp createdAt, persist atomically, and return the new record.
 * Throws on an unwritable data root; it never partially seeds.
 */
function registrySeed(dataDir: string, now: string): InstanceIdentity {
  const existing = loadStore(dataDir);
  if (existing) return existing;
  const identity: InstanceIdentity = {
    superadminUserId: randomUUID(),
    localDevUserId: randomUUID(),
    createdAt: now,
  };
  replace(dataDir, identity);
  return identity;
}

// ── Index (read path) ────────────────────────────────────────────────────────

/** The persisted instance identity, or null when never seeded. */
function indexGet(dataDir: string): InstanceIdentity | null {
  return loadStore(dataDir);
}

// ── Repository facade (1:1 forwarding) ───────────────────────────────────────

/** Seed-or-load the boot-reserved built-in subject UUIDs (first boot generates
 *  and persists them; every later boot returns the record unchanged). Called
 *  once from the sdd_host lifecycle init entrypoint before the listeners bind. */
export function ensureInstanceIdentity(
  dataDir: string,
  now: string = new Date().toISOString(),
): InstanceIdentity {
  return registrySeed(dataDir, now);
}

/** The persisted instance identity — null when never seeded (callers treat an
 *  unseeded instance as having NO recognizable built-in subjects: fail closed). */
export function getInstanceIdentity(dataDir: string): InstanceIdentity | null {
  return indexGet(dataDir);
}
