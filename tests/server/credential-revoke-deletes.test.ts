import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCredential, findByTokenHash, hashToken, listByOwner, listCredentials, revokeAllForOwner, revokeCredential } from '../../src/server/credentials.js';
import { load, update } from '../../src/server/credential-store.js';
import { authenticate } from '../../src/server/auth.js';
import { subjectOf } from './helpers.js';
import type { ApiKeyRecord } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// A revoked credential is a deleted record on every path: revoke, revoke-all-
// for-an-owner, and a legacy file that still carries `revokedAt` (older releases
// kept revoked records): not read, not authenticated, dropped at the next write.
// ---------------------------------------------------------------------------

let dataDir: string;
const NOW = new Date().toISOString();
const file = (): string => path.join(dataDir, 'auth', 'credentials.json');
const stored = (): { id: string }[] => JSON.parse(fs.readFileSync(file(), 'utf8')) as { id: string }[];

function mk(id: string, token: string, owner?: string): ApiKeyRecord {
  return { id, keyHash: hashToken(token), projects: ['*'], createdAt: NOW, ...(owner ? { ownerSubject: subjectOf(owner) } : {}) };
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-revoke-'));
});
afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

describe('revoke deletes the record', () => {
  it('revokeCredential removes the record from the file, and a second revoke is a no-op', () => {
    createCredential(dataDir, mk('k1', 'tok-1', 'u1'));
    createCredential(dataDir, mk('k2', 'tok-2', 'u1'));
    revokeCredential(dataDir, 'k1');
    expect(stored().map((r) => r.id)).toEqual(['k2']);
    expect(authenticate(dataDir, 'tok-1').authenticated).toBe(false);
    revokeCredential(dataDir, 'k1');
    expect(stored().map((r) => r.id)).toEqual(['k2']);
  });

  it('revokeAllForOwner deletes the owner\'s records, returns the count removed and leaves the others', () => {
    createCredential(dataDir, mk('a1', 'tok-a1', 'owner-a'));
    createCredential(dataDir, mk('a2', 'tok-a2', 'owner-a'));
    createCredential(dataDir, mk('a3', 'tok-a3', 'owner-a'));
    createCredential(dataDir, mk('b1', 'tok-b1', 'owner-b'));
    createCredential(dataDir, mk('anon', 'tok-anon'));

    expect(revokeAllForOwner(dataDir, 'owner-a')).toBe(3);
    expect(stored().map((r) => r.id).sort()).toEqual(['anon', 'b1']);
    expect(listByOwner(dataDir, 'owner-a')).toEqual([]);
    // Idempotent: nothing left to remove.
    expect(revokeAllForOwner(dataDir, 'owner-a')).toBe(0);
    expect(revokeAllForOwner(dataDir, 'nobody')).toBe(0);
  });
});

describe('a legacy file with a revokedAt record', () => {
  function legacyFile(): void {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify([
      { ...mk('old-revoked', 'tok-old', 'u1'), revokedAt: '2026-01-01T00:00:00.000Z' },
      mk('live', 'tok-live', 'u1'),
    ]));
  }

  it('is not read, not listed and not authenticated', () => {
    legacyFile();
    expect(load(dataDir).map((r) => r.id)).toEqual(['live']);
    expect(listCredentials(dataDir, '*').map((r) => r.id)).toEqual(['live']);
    expect(findByTokenHash(dataDir, hashToken('tok-old'))).toBeNull();
    expect(authenticate(dataDir, 'tok-old').authenticated).toBe(false);
  });

  it('is dropped from the file by the next write, before the change sees the set', () => {
    legacyFile();
    let seen: string[] = [];
    update(dataDir, (records) => {
      seen = records.map((r) => r.id);
      return records;
    });
    expect(seen).toEqual(['live']);
    expect(stored().map((r) => r.id)).toEqual(['live']);
    expect(fs.readFileSync(file(), 'utf8')).not.toContain('revokedAt');
  });
});
