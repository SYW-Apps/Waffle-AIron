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
// Composition mirrors the spec tree (like organization.ts):
//   - InstanceIdentityStore    : authoritative record, disk-backed (load /
//                                replace, atomic write-temp-then-rename).
//   - InstanceIdentityRegistry : the create-once write path (seed, idempotent).
//   - InstanceIdentityIndex    : the read path — pure projection (get).
//   - InstanceIdentityRepository facade: ensureSeeded / get, 1:1 forwarding —
//     exported as ensureInstanceIdentity / getInstanceIdentity.
// ---------------------------------------------------------------------------

function storePath(dataDir: string): string {
  return path.join(dataDir, 'instance.json');
}

// ── Store ────────────────────────────────────────────────────────────────────

class InstanceIdentityStore {
  constructor(private readonly dataDir: string) {}

  /**
   * Load the persisted instance identity as the authoritative record. A missing
   * file yields null (the instance has never been seeded — first boot is not an
   * error); an unreadable file or structurally invalid JSON fails with a storage
   * error naming the path so the operator can repair it — a silently dropped
   * identity would orphan the built-in subjects.
   */
  load(): InstanceIdentity | null {
    const p = storePath(this.dataDir);
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
  replace(identity: InstanceIdentity): void {
    const p = storePath(this.dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(identity, null, 2) + '\n');
    fs.renameSync(tmp, p);
  }
}

// ── Registry (create-once write path) ────────────────────────────────────────

class InstanceIdentityRegistry {
  constructor(private readonly store: InstanceIdentityStore) {}

  /**
   * Create-once seeding: when a record already exists, return it UNCHANGED
   * (idempotent — ids are never regenerated or rotated). Otherwise generate
   * cryptographically random UUIDs for the built-in super-admin and
   * local-developer subjects, stamp createdAt, persist atomically, and return
   * the new record. Throws on an unwritable data root; it never partially seeds.
   */
  seed(now: string): InstanceIdentity {
    const existing = this.store.load();
    if (existing) return existing;
    const identity: InstanceIdentity = {
      superadminUserId: randomUUID(),
      localDevUserId: randomUUID(),
      createdAt: now,
    };
    this.store.replace(identity);
    return identity;
  }
}

// ── Index (read path) ────────────────────────────────────────────────────────

class InstanceIdentityIndex {
  constructor(private readonly store: InstanceIdentityStore) {}

  /** The persisted instance identity, or null when never seeded. */
  get(): InstanceIdentity | null {
    return this.store.load();
  }
}

// ── Repository facade (1:1 forwarding) ───────────────────────────────────────

class InstanceIdentityRepository {
  private readonly store: InstanceIdentityStore;
  constructor(dataDir: string) {
    this.store = new InstanceIdentityStore(dataDir);
  }

  /** Seed-or-load through the registry (create-once, idempotent). */
  ensureSeeded(now: string): InstanceIdentity {
    return new InstanceIdentityRegistry(this.store).seed(now);
  }

  /** The persisted record through the index, or null when never seeded. */
  get(): InstanceIdentity | null {
    return new InstanceIdentityIndex(this.store).get();
  }
}

/** Seed-or-load the boot-reserved built-in subject UUIDs (first boot generates
 *  and persists them; every later boot returns the record unchanged). Called
 *  once from the sdd_host lifecycle init entrypoint before the listeners bind. */
export function ensureInstanceIdentity(
  dataDir: string,
  now: string = new Date().toISOString(),
): InstanceIdentity {
  return new InstanceIdentityRepository(dataDir).ensureSeeded(now);
}

/** The persisted instance identity — null when never seeded (callers treat an
 *  unseeded instance as having NO recognizable built-in subjects: fail closed). */
export function getInstanceIdentity(dataDir: string): InstanceIdentity | null {
  return new InstanceIdentityRepository(dataDir).get();
}
