import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as identity from '../../src/server/identity.js';
import { UnauthenticatedError, ForbiddenError } from '../../src/server/identity.js';
import { createCredential, hashToken, listCredentials } from '../../src/server/credentials.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { upsertUser as repoUpsertUser } from '../../src/server/users.js';
import { appendAuditEvent, queryAuditEvents as auditQuery, DEFAULT_AUDIT_POLICY } from '../../src/server/audit.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  HostConfig,
  HostedUserRecord,
  PrincipalSubject,
  ProjectGrant,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Identity Orchestrator + Portal (sdd_host) — exercised through the exported
// orchestrator functions against a real <dataDir>, mirroring the other server
// suites. Covers authentication (401), grant-based authorization (403), the
// token/user/audit workflows, best-effort audit appends, and the audit action
// distinctions (user.create vs user.update).
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

function mkUser(over: Partial<HostedUserRecord> & Pick<HostedUserRecord, 'id'>): HostedUserRecord {
  return {
    subject: subject(),
    status: 'active',
    grants: [],
    createdAt: '2000-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('identity orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-identity-'));
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // Mint a stored non-admin token carrying the given grants; returns the plaintext.
  function mintNonAdminToken(grants: ProjectGrant[]): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: crypto.randomBytes(6).toString('hex'),
      keyHash: hashToken(token),
      role: 'editor',
      projects: grants.map((g) => g.projectId),
      grants,
      createdAt: new Date().toISOString(),
    };
    createCredential(dataDir, record);
    return token;
  }

  function persistedByHash(tokenHash: string): ApiKeyRecord | undefined {
    return listCredentials(dataDir, '*').find((r) => r.keyHash === tokenHash);
  }

  // ── mintToken ──────────────────────────────────────────────────────────────

  it('mints a token as instance-admin: returns plaintext, persists a hashed record with owner + grants, and audits token.mint', () => {
    createProjectRecord(dataDir, 'proj-a');
    const grants: ProjectGrant[] = [{ projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'] }];

    const token = identity.mintToken(cfg, MASTER, { ownerUserId: 'u-owner', label: 'ci token', grants });

    expect(token).toMatch(/^wk_[0-9a-f]+$/);
    const rec = persistedByHash(hashToken(token));
    expect(rec).toBeDefined();
    expect(rec!.keyHash).toBe(hashToken(token)); // only the hash is stored
    expect(rec!.ownerSubject?.userId).toBe('u-owner');
    expect(rec!.grants).toEqual(grants);
    expect(rec!.label).toBe('ci token');
    // createdBySubject carries the bootstrap admin identity.
    expect(rec!.createdBySubject?.userId).toBe('bootstrap');

    const events = auditQuery(dataDir, { action: 'token.mint' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
    expect(events[0].target).toBe(rec!.id);
  });

  it('mints a token when a non-admin caller holds key:manage covering every requested project', () => {
    createProjectRecord(dataDir, 'proj-a');
    const caller = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['key:manage'] }]);

    const token = identity.mintToken(cfg, caller, {
      ownerUserId: 'u-owner',
      label: 't',
      grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
    });
    expect(token).toMatch(/^wk_/);
  });

  it('rejects a mint (403) when the caller lacks key:manage for a requested project', () => {
    createProjectRecord(dataDir, 'proj-a');
    const caller = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['mcp:read'] }]);

    expect(() =>
      identity.mintToken(cfg, caller, {
        ownerUserId: 'u-owner',
        label: 't',
        grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
      }),
    ).toThrow(ForbiddenError);
  });

  it('rejects a mint referencing an unknown project', () => {
    // admin passes delegation authz, so the failure is the project-existence check.
    expect(() =>
      identity.mintToken(cfg, MASTER, {
        ownerUserId: 'u-owner',
        label: 't',
        grants: [{ projectId: 'ghost', permissions: ['mcp:read'] }],
      }),
    ).toThrow(/unknown project/i);
  });

  // ── revokeToken ──────────────────────────────────────────────────────────

  it('revokes a token as admin and audits token.revoke', () => {
    const plaintext = 'wk_target';
    createCredential(dataDir, {
      id: 'tok-1',
      keyHash: hashToken(plaintext),
      role: 'editor',
      projects: ['proj-a'],
      createdAt: new Date().toISOString(),
    });

    identity.revokeToken(cfg, MASTER, 'tok-1');

    expect(listCredentials(dataDir, '*').some((r) => r.id === 'tok-1')).toBe(false);
    const events = auditQuery(dataDir, { action: 'token.revoke' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
  });

  it('rejects a revoke (403) when the caller cannot manage the target token scope', () => {
    createCredential(dataDir, {
      id: 'tok-2',
      keyHash: hashToken('wk_x'),
      role: 'editor',
      projects: ['proj-a'],
      createdAt: new Date().toISOString(),
    });
    const caller = mintNonAdminToken([{ projectId: 'proj-b', permissions: ['key:manage'] }]);

    expect(() => identity.revokeToken(cfg, caller, 'tok-2')).toThrow(ForbiddenError);
  });

  // ── replaceUserGrants ──────────────────────────────────────────────────────

  it('replaces a user\'s grants as admin and audits user.grants.replace', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-1' }));
    const grants: ProjectGrant[] = [{ projectId: 'proj-a', permissions: ['mcp:read'] }];

    const updated = identity.replaceUserGrants(cfg, MASTER, 'u-1', grants);
    expect(updated.grants).toEqual(grants);

    expect(auditQuery(dataDir, { action: 'user.grants.replace' })).toHaveLength(1);
  });

  it('rejects replaceUserGrants (403) for a non-admin token', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-1' }));
    const caller = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['key:manage', 'user:admin'] }]);
    expect(() => identity.replaceUserGrants(cfg, caller, 'u-1', [])).toThrow(ForbiddenError);
  });

  // ── upsertUser: create vs update ───────────────────────────────────────────

  it('audits user.create on first upsert and user.update on the second', () => {
    identity.upsertUser(cfg, MASTER, mkUser({ id: 'u-2', subject: subject({ displayName: 'Ada' }) }));
    identity.upsertUser(cfg, MASTER, mkUser({ id: 'u-2', subject: subject({ displayName: 'Ada Lovelace' }) }));

    expect(auditQuery(dataDir, { action: 'user.create' })).toHaveLength(1);
    expect(auditQuery(dataDir, { action: 'user.update' })).toHaveLength(1);
  });

  it('rejects upsertUser (403) for a non-admin token', () => {
    const caller = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['user:admin'] }]);
    expect(() => identity.upsertUser(cfg, caller, mkUser({ id: 'u-9' }))).toThrow(ForbiddenError);
  });

  // ── setUserStatus ──────────────────────────────────────────────────────────

  it('sets user status as admin and audits user.status.set', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-3' }));

    const updated = identity.setUserStatus(cfg, MASTER, 'u-3', 'suspended');
    expect(updated.status).toBe('suspended');

    const events = auditQuery(dataDir, { action: 'user.status.set' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
  });

  it('rejects setUserStatus (403) for a non-admin token', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-3' }));
    const caller = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['user:admin'] }]);
    expect(() => identity.setUserStatus(cfg, caller, 'u-3', 'suspended')).toThrow(ForbiddenError);
  });

  // ── listUsers authorization ─────────────────────────────────────────────────

  it('lists users for a caller carrying a user-administration grant, and rejects one without', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-a' }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-b' }));

    // admin sees all.
    expect(identity.listUsers(cfg, MASTER).map((u) => u.id).sort()).toEqual(['u-a', 'u-b']);

    // non-admin with user:admin grant is authorized.
    const userAdmin = mintNonAdminToken([{ projectId: '*', permissions: ['user:admin'] }]);
    expect(identity.listUsers(cfg, userAdmin)).toHaveLength(2);

    // non-admin without it is denied.
    const plain = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['mcp:read'] }]);
    expect(() => identity.listUsers(cfg, plain)).toThrow(ForbiddenError);
  });

  // ── queryAuditEvents authorization ──────────────────────────────────────────

  it('returns audit events for an audit:read caller and rejects one without', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'token.mint', level: 'security' }), DEFAULT_AUDIT_POLICY);

    const reader = mintNonAdminToken([{ projectId: '*', permissions: ['audit:read'] }]);
    expect(identity.queryAuditEvents(cfg, reader, {}).length).toBeGreaterThanOrEqual(1);

    const plain = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['mcp:read'] }]);
    expect(() => identity.queryAuditEvents(cfg, plain, {})).toThrow(ForbiddenError);
  });

  // ── pruneAuditEvents ─────────────────────────────────────────────────────────

  it('prunes expired audit events as admin and audits audit.prune', () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString(); // beyond 90d retention
    appendAuditEvent(dataDir, mkEvent({ action: 'a.old', timestamp: old }), DEFAULT_AUDIT_POLICY);

    const removed = identity.pruneAuditEvents(cfg, MASTER);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(auditQuery(dataDir, { action: 'audit.prune' })).toHaveLength(1);
  });

  it('rejects pruneAuditEvents (403) for a non-admin token', () => {
    const reader = mintNonAdminToken([{ projectId: '*', permissions: ['audit:read'] }]);
    expect(() => identity.pruneAuditEvents(cfg, reader)).toThrow(ForbiddenError);
  });

  // ── best-effort audit append ────────────────────────────────────────────────

  it('does not fail the primary action when the audit append fails', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-af' }));
    // Make the audit store unwritable/unreadable: a directory where the file goes.
    fs.mkdirSync(path.join(dataDir, 'audit-events.json'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // The status change must still succeed and persist.
    const updated = identity.setUserStatus(cfg, MASTER, 'u-af', 'suspended');
    expect(updated.status).toBe('suspended');
    // The failure was recorded as a server diagnostic.
    expect(errSpy).toHaveBeenCalled();
  });

  // ── authentication ──────────────────────────────────────────────────────────

  it('throws an unauthenticated error for a bogus token and for no credential', () => {
    const req = { ownerUserId: 'u', label: 't', grants: [] };
    expect(() => identity.mintToken(cfg, 'not-a-real-token', req)).toThrow(UnauthenticatedError);
    expect(() => identity.mintToken(cfg, null, req)).toThrow(UnauthenticatedError);
  });
});

const ACTOR: PrincipalSubject = { userId: 'u-1', kind: 'human', issuer: 'local' };

function mkEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: '',
    timestamp: '2026-07-09T12:00:00.000Z',
    level: 'info',
    category: 'admin',
    action: 'x.action',
    outcome: 'success',
    actor: ACTOR,
    ...over,
  };
}
