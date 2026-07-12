import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getUserById,
  findUserByExternalSubject,
  listUsers,
  upsertUser,
  setUserStatus,
  replaceUserGrants,
} from '../../src/server/users.js';
import type { HostedUserRecord, PrincipalSubject, ProjectGrant } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// User Repository (sdd_host) — the store/registry/index triad exercised through
// the repository facade against a real <dataDir>/users.json, so persistence,
// atomic swap, and the malformed-file storage error are covered end-to-end.
// ---------------------------------------------------------------------------

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

function mkUser(over: Partial<HostedUserRecord> & Pick<HostedUserRecord, 'id'>): HostedUserRecord {
  return {
    subject: subject(),
    status: 'active',
    grants: [],
    createdAt: '2000-01-01T00:00:00.000Z', // placeholder; the store stamps its own on insert
    ...over,
  };
}

describe('user repository (sdd_host)', () => {
  let dataDir: string;
  let usersPath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-users-'));
    usersPath = path.join(dataDir, 'users.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── upsert: insert + update ────────────────────────────────────────────────

  it('inserts then updates a user, and the change survives a reload', () => {
    const inserted = upsertUser(dataDir, mkUser({ id: 'u-1', subject: subject({ displayName: 'Ada' }) }));
    expect(inserted.id).toBe('u-1');

    // Read path re-reads from disk — proves the insert was persisted.
    expect(getUserById(dataDir, 'u-1')?.subject.displayName).toBe('Ada');

    const updated = upsertUser(
      dataDir,
      mkUser({ id: 'u-1', status: 'suspended', subject: subject({ displayName: 'Ada Lovelace' }) }),
    );
    expect(updated.status).toBe('suspended');
    expect(updated.subject.displayName).toBe('Ada Lovelace');

    const reloaded = getUserById(dataDir, 'u-1');
    expect(reloaded).toEqual(updated);
    // Still a single record — update replaced, not appended.
    expect(listUsers(dataDir)).toHaveLength(1);
  });

  it('stamps createdAt exactly once — on insert, preserved across updates', () => {
    const inserted = upsertUser(dataDir, mkUser({ id: 'u-1' }));
    // Server-stamped, not the caller-supplied placeholder.
    expect(inserted.createdAt).not.toBe('2000-01-01T00:00:00.000Z');
    expect(() => new Date(inserted.createdAt).toISOString()).not.toThrow();

    const updated = upsertUser(
      dataDir,
      mkUser({ id: 'u-1', status: 'deactivated', createdAt: '1999-12-31T00:00:00.000Z' }),
    );
    expect(updated.createdAt).toBe(inserted.createdAt);
    expect(getUserById(dataDir, 'u-1')?.createdAt).toBe(inserted.createdAt);
  });

  // ── setStatus ──────────────────────────────────────────────────────────────

  it('sets a valid status while preserving all other fields', () => {
    const grants: ProjectGrant[] = [{ projectId: 'proj-a', permissions: ['mcp:read'] }];
    upsertUser(dataDir, mkUser({ id: 'u-1', grants, subject: subject({ email: 'a@b.co' }) }));

    const suspended = setUserStatus(dataDir, 'u-1', 'suspended');
    expect(suspended.status).toBe('suspended');
    expect(suspended.grants).toEqual(grants);
    expect(suspended.subject.email).toBe('a@b.co');
    expect(getUserById(dataDir, 'u-1')?.status).toBe('suspended');
  });

  it('rejects setStatus on an unknown id', () => {
    expect(() => setUserStatus(dataDir, 'nope', 'active')).toThrow('not found');
  });

  it('rejects an invalid status value and does not mutate the record', () => {
    upsertUser(dataDir, mkUser({ id: 'u-1', status: 'active' }));
    expect(() => setUserStatus(dataDir, 'u-1', 'banned')).toThrow('Invalid user status');
    expect(getUserById(dataDir, 'u-1')?.status).toBe('active');
  });

  // ── replaceGrants ────────────────────────────────────────────────────────

  it('replaces grants wholesale (no merging)', () => {
    const initial: ProjectGrant[] = [{ projectId: 'proj-a', permissions: ['mcp:read'] }];
    upsertUser(dataDir, mkUser({ id: 'u-1', grants: initial }));

    const next: ProjectGrant[] = [
      { projectId: 'proj-b', permissions: ['mcp:write'] },
      { projectId: '*', permissions: ['mcp:read'] },
    ];
    const updated = replaceUserGrants(dataDir, 'u-1', next);
    expect(updated.grants).toEqual(next); // proj-a is gone — wholesale replace
    expect(getUserById(dataDir, 'u-1')?.grants).toEqual(next);
  });

  it('rejects replaceGrants on an unknown id', () => {
    expect(() => replaceUserGrants(dataDir, 'nope', [])).toThrow('not found');
  });

  // ── getById ────────────────────────────────────────────────────────────────

  it('getById returns null for a miss and the record for a hit', () => {
    expect(getUserById(dataDir, 'u-1')).toBeNull();
    upsertUser(dataDir, mkUser({ id: 'u-1' }));
    expect(getUserById(dataDir, 'u-1')?.id).toBe('u-1');
  });

  // ── findByExternalSubject ──────────────────────────────────────────────────

  it('findByExternalSubject matches issuer + external subject exactly and case-sensitively', () => {
    upsertUser(
      dataDir,
      mkUser({ id: 'u-1', subject: subject({ issuer: 'oidc-google', externalSubject: 'SUB-123' }) }),
    );

    expect(findUserByExternalSubject(dataDir, 'oidc-google', 'SUB-123')?.id).toBe('u-1');
    expect(findUserByExternalSubject(dataDir, 'oidc-google', 'sub-123')).toBeNull(); // subject case
    expect(findUserByExternalSubject(dataDir, 'OIDC-GOOGLE', 'SUB-123')).toBeNull(); // issuer case
    expect(findUserByExternalSubject(dataDir, 'oidc-google', 'SUB-999')).toBeNull(); // unknown
  });

  it('findByExternalSubject does not match a record that has no externalSubject', () => {
    upsertUser(dataDir, mkUser({ id: 'u-1', subject: subject({ issuer: 'local' }) }));
    expect(findUserByExternalSubject(dataDir, 'local', 'anything')).toBeNull();
  });

  // ── list filters ────────────────────────────────────────────────────────

  function seedForList(): void {
    // Inserted out of id-order to prove sorting.
    upsertUser(dataDir, mkUser({ id: 'u-c', status: 'active', grants: [{ projectId: '*', permissions: ['mcp:read'] }] }));
    upsertUser(dataDir, mkUser({ id: 'u-a', status: 'active', grants: [{ projectId: 'proj-x', permissions: ['mcp:read'] }] }));
    upsertUser(dataDir, mkUser({ id: 'u-d', status: 'active', grants: [] }));
    upsertUser(dataDir, mkUser({ id: 'u-b', status: 'suspended', grants: [{ projectId: 'proj-y', permissions: ['mcp:read'] }] }));
  }

  it('lists all users sorted by id when unfiltered', () => {
    seedForList();
    expect(listUsers(dataDir).map((r) => r.id)).toEqual(['u-a', 'u-b', 'u-c', 'u-d']);
  });

  it('filters by status', () => {
    seedForList();
    expect(listUsers(dataDir, 'active').map((r) => r.id)).toEqual(['u-a', 'u-c', 'u-d']);
  });

  it('filters by project id, matching both direct and instance-wide (*) grants', () => {
    seedForList();
    // proj-x: u-a holds it directly; u-c matches via its instance-wide '*' grant.
    expect(listUsers(dataDir, undefined, 'proj-x').map((r) => r.id)).toEqual(['u-a', 'u-c']);
    // proj-z: only the instance-wide grant holder matches any project.
    expect(listUsers(dataDir, undefined, 'proj-z').map((r) => r.id)).toEqual(['u-c']);
  });

  it('filters by status and project id together', () => {
    seedForList();
    // active AND (proj-y or *): u-b holds proj-y but is suspended; u-c is active with '*'.
    expect(listUsers(dataDir, 'active', 'proj-y').map((r) => r.id)).toEqual(['u-c']);
  });

  // ── malformed store ────────────────────────────────────────────────────────

  it('missing store file reads as an empty set', () => {
    expect(listUsers(dataDir)).toEqual([]);
    expect(getUserById(dataDir, 'anything')).toBeNull();
  });

  it('malformed store JSON fails with a storage error naming the path', () => {
    fs.writeFileSync(usersPath, '{ this is not valid json');
    let message = '';
    try {
      listUsers(dataDir);
      throw new Error('expected listUsers to throw');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('Malformed hosted-user store');
    expect(message).toContain(usersPath);
  });

  it('a structurally invalid (non-array) store fails with a storage error naming the path', () => {
    fs.writeFileSync(usersPath, JSON.stringify({ not: 'an array' }));
    expect(() => getUserById(dataDir, 'u-1')).toThrow(usersPath);
  });
});
