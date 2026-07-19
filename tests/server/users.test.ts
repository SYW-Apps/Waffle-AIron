import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getUserById,
  findUserByExternalSubject,
  findUserByRecordOrSubjectId,
  listUsers,
  upsertUser,
  setUserStatus,
} from '../../src/server/users.js';
import { setAssignment } from '../../src/server/permissions.js';
import { listUsers as orchestratorListUsers } from '../../src/server/identity.js';
import type { HostConfig, HostedUserRecord, PrincipalSubject, RoleBinding } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// User Repository (sdd_host) — the store/registry/index triad exercised through
// the repository facade against a real <dataDir>/users.json, so persistence,
// atomic swap, and the malformed-file storage error are covered end-to-end.
// Permissions live in roleBindings + the assignment grid — never on the record
// as grants (there is no replaceUserGrants).
// ---------------------------------------------------------------------------

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

function mkUser(over: Partial<HostedUserRecord> & Pick<HostedUserRecord, 'id'>): HostedUserRecord {
  return {
    subject: subject(),
    status: 'active',
    roleBindings: [],
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
    const roleBindings: RoleBinding[] = [{ roleId: 'sso-admin' }];
    upsertUser(dataDir, mkUser({ id: 'u-1', roleBindings, subject: subject({ email: 'a@b.co' }) }));

    const suspended = setUserStatus(dataDir, 'u-1', 'suspended');
    expect(suspended.status).toBe('suspended');
    expect(suspended.roleBindings).toEqual(roleBindings);
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

  // ── getById ────────────────────────────────────────────────────────────────

  it('getById returns null for a miss and the record for a hit', () => {
    expect(getUserById(dataDir, 'u-1')).toBeNull();
    upsertUser(dataDir, mkUser({ id: 'u-1' }));
    expect(getUserById(dataDir, 'u-1')?.id).toBe('u-1');
  });

  // ── findByRecordOrSubjectId (the divergent-id-safe lookup) ─────────────────

  it('findByRecordOrSubjectId resolves by record id OR subject userId, record id winning, null on a miss', () => {
    // Admin-created divergent-id user: record id ≠ subject.userId.
    upsertUser(dataDir, mkUser({ id: 'rec-1', subject: subject({ userId: 'subj-1' }) }));

    // Both ids resolve the SAME record — neither can dodge an identity-critical
    // gate (live auth status, mint deactivation guard) keyed on the other.
    expect(findUserByRecordOrSubjectId(dataDir, 'rec-1')?.id).toBe('rec-1');
    expect(findUserByRecordOrSubjectId(dataDir, 'subj-1')?.id).toBe('rec-1');
    expect(findUserByRecordOrSubjectId(dataDir, 'ghost')).toBeNull();

    // Precedence: when another record's SUBJECT claims an id that is also a
    // record id, the exact record-id match wins (mirrors mintToken's original
    // getUserById-first resolution).
    upsertUser(dataDir, mkUser({ id: 'claimer', subject: subject({ userId: 'rec-1' }) }));
    expect(findUserByRecordOrSubjectId(dataDir, 'rec-1')?.id).toBe('rec-1');
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
    // Inserted out of id-order to prove sorting. Project membership lives in the
    // permission grid (direct assignments), never on the user record.
    upsertUser(dataDir, mkUser({ id: 'u-c', status: 'active' }));
    upsertUser(dataDir, mkUser({ id: 'u-a', status: 'active' }));
    upsertUser(dataDir, mkUser({ id: 'u-d', status: 'active' }));
    upsertUser(dataDir, mkUser({ id: 'u-b', status: 'suspended' }));
    setAssignment(dataDir, {
      id: '', subjectKind: 'user', subjectId: 'u-a', scopeKind: 'project', scopeId: 'proj-x',
      capability: 'project:read', value: 'yes', createdAt: '',
    });
    setAssignment(dataDir, {
      id: '', subjectKind: 'user', subjectId: 'u-b', scopeKind: 'project', scopeId: 'proj-y',
      capability: 'project:write', value: 'yes', createdAt: '',
    });
    // u-c holds an INSTANCE-scoped assignment — deliberately NOT a direct project
    // assignment, so the project filter must not surface it.
    setAssignment(dataDir, {
      id: '', subjectKind: 'user', subjectId: 'u-c', scopeKind: 'instance',
      capability: 'project:read', value: 'yes', createdAt: '',
    });
  }

  it('lists all users sorted by id when unfiltered', () => {
    seedForList();
    expect(listUsers(dataDir).map((r) => r.id)).toEqual(['u-a', 'u-b', 'u-c', 'u-d']);
  });

  it('filters by status', () => {
    seedForList();
    expect(listUsers(dataDir, 'active').map((r) => r.id)).toEqual(['u-a', 'u-c', 'u-d']);
  });

  // The project filter is NOT a repository concern anymore: the user store owns
  // no project reference, so the identity ORCHESTRATOR intersects the listing
  // with the grid's direct assignments. Pinned here next to the grid seeding.
  it('orchestrator project filter matches users holding a DIRECT assignment at that project scope', () => {
    seedForList();
    const MASTER = 'master-credential-secret-value';
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    try {
      const cfg: HostConfig = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
      // proj-x: only u-a holds a direct project-scoped assignment. u-c's broader
      // instance-scoped assignment deliberately does NOT match — inherited reach
      // is a resolver question, and the admin filter stays honest (direct only).
      expect(orchestratorListUsers(cfg, MASTER, 'proj-x').map((r) => r.id)).toEqual(['u-a']);
      expect(orchestratorListUsers(cfg, MASTER, 'proj-z').map((r) => r.id)).toEqual([]);
      // proj-y's only direct holder is u-b (suspended is still listed — status is
      // a separate axis the directory shows; deactivation revokes credentials).
      expect(orchestratorListUsers(cfg, MASTER, 'proj-y').map((r) => r.id)).toEqual(['u-b']);
    } finally {
      delete process.env.WAIRON_ADMIN_TOKEN;
    }
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
