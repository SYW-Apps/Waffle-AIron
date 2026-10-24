import * as crypto from 'crypto';
import { load, update } from './credential-store.js';
import type { ApiKeyRecord } from './types.js';

// ---------------------------------------------------------------------------
// Credential Registry (sdd_host)
//
// File-backed I/O for hashed API-key records at <dataDir>/auth/credentials.json.
// Keys are stored only as salted SHA-256 hashes and compared in constant time;
// the plaintext is shown once at mint time and never persisted.
// ---------------------------------------------------------------------------

const HASH_NS = 'wairon:token:v1';

/** Salted hash of a bearer token. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(`${HASH_NS}:${token}`).digest('hex');
}

/** Constant-time compare of two hex digests. */
function digestEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Look up a credential by hashed token, or null. */
export function findByTokenHash(dataDir: string, tokenHash: string): ApiKeyRecord | null {
  return load(dataDir).find((r) => digestEquals(r.keyHash, tokenHash)) ?? null;
}

/** Persist a new credential (fails if the id already exists). */
export function createCredential(dataDir: string, record: ApiKeyRecord): void {
  update(dataDir, (records) => {
    if (records.some((r) => r.id === record.id)) {
      throw new Error(`Credential "${record.id}" already exists.`);
    }
    return [...records, record];
  });
}

/** Revoke a credential by id: its record is deleted (idempotent). The audit event is the history. */
export function revokeCredential(dataDir: string, id: string): void {
  update(dataDir, (records) => records.filter((r) => r.id !== id));
}

/**
 * Revoke every credential whose ownerSubject.userId matches ownerUserId: the
 * records are deleted, in one update under the store's write lock, and the
 * number removed is returned. Idempotent — records without an owner subject are
 * skipped; an owner with no credentials removes nothing and returns 0.
 * Backs the identity deactivation flow so authenticate() rejects the user's tokens.
 */
export function revokeAllForOwner(dataDir: string, ownerUserId: string): number {
  let removed = 0;
  update(dataDir, (records) => {
    const kept = records.filter((rec) => rec.ownerSubject?.userId !== ownerUserId);
    removed = records.length - kept.length;
    return kept;
  });
  return removed;
}

/** List credentials authorized for a project (or all, for the wildcard). */
export function listCredentials(dataDir: string, project: string): ApiKeyRecord[] {
  return load(dataDir).filter(
    (r) => project === '*' || r.projects.includes('*') || r.projects.includes(project),
  );
}

/**
 * List every stored credential whose ownerSubject.userId matches ownerUserId — a
 * user's own minted tokens across all projects. Uses the SAME owner-identity match
 * as revokeAllForOwner, so a listed record is exactly one the deactivation sweep
 * would revoke. Each record is returned as stored, carrying only its hashed token
 * (the plaintext is never present in the store); an owner with no records yields an
 * empty list. A pure read — never logs token material.
 */
export function listByOwner(dataDir: string, ownerUserId: string): ApiKeyRecord[] {
  return load(dataDir).filter((r) => r.ownerSubject?.userId === ownerUserId);
}

/**
 * Replace one credential's project narrowing with the given entries (record ids
 * or '*'), leaving the hash, owner, label and expiry untouched — the member
 * upgrade's token rewrite. Refuses an empty narrowing and an unknown id (a
 * revoked credential no longer exists).
 */
export function renarrowCredential(dataDir: string, id: string, projects: string[]): ApiKeyRecord {
  if (projects.length === 0) throw new Error(`Credential "${id}": a narrowing cannot be empty.`);
  let renarrowed!: ApiKeyRecord;
  update(dataDir, (records) => {
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new Error(`Unknown credential "${id}".`);
    rec.projects = [...projects];
    renarrowed = rec;
    return records;
  });
  return renarrowed;
}
