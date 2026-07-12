import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
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

function storePath(dataDir: string): string {
  return path.join(dataDir, 'auth', 'credentials.json');
}

function load(dataDir: string): ApiKeyRecord[] {
  try {
    return JSON.parse(fs.readFileSync(storePath(dataDir), 'utf8')) as ApiKeyRecord[];
  } catch {
    return [];
  }
}

function save(dataDir: string, records: ApiKeyRecord[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, p);
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
  const records = load(dataDir);
  if (records.some((r) => r.id === record.id)) {
    throw new Error(`Credential "${record.id}" already exists.`);
  }
  records.push(record);
  save(dataDir, records);
}

/** Remove a credential by id (idempotent). */
export function revokeCredential(dataDir: string, id: string): void {
  save(dataDir, load(dataDir).filter((r) => r.id !== id));
}

/**
 * Revoke (stamp revokedAt with the current time) every non-revoked credential
 * whose ownerSubject.userId matches ownerUserId, persist the store once, and
 * return the number of records newly revoked. Idempotent — records already
 * carrying a revokedAt (and records without an owner subject) are skipped and not
 * counted; an owner with no active credentials revokes nothing and returns 0.
 * Backs the identity deactivation flow so authenticate() rejects the user's tokens.
 */
export function revokeAllForOwner(dataDir: string, ownerUserId: string): number {
  const records = load(dataDir);
  const now = new Date().toISOString();
  let revoked = 0;
  for (const rec of records) {
    if (rec.ownerSubject?.userId === ownerUserId && !rec.revokedAt) {
      rec.revokedAt = now;
      revoked += 1;
    }
  }
  if (revoked > 0) save(dataDir, records);
  return revoked;
}

/** List credentials authorized for a project (or all, for the wildcard). */
export function listCredentials(dataDir: string, project: string): ApiKeyRecord[] {
  return load(dataDir).filter(
    (r) => project === '*' || r.projects.includes('*') || r.projects.includes(project),
  );
}
