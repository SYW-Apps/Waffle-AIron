import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as identity from '../../src/server/identity.js';
import { UnauthenticatedError, ForbiddenError } from '../../src/server/identity.js';
import { authenticate } from '../../src/server/auth.js';
import {
  createCredential,
  hashToken,
  listCredentials,
  revokeAllForOwner,
} from '../../src/server/credentials.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { upsertUser as repoUpsertUser } from '../../src/server/users.js';
import { upsertOrganizationUnit, placeProject } from '../../src/server/organization.js';
import { appendAuditEvent, queryAuditEvents as auditQuery, DEFAULT_AUDIT_POLICY } from '../../src/server/audit.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  HostConfig,
  HostedUserRecord,
  OrganizationUnitRecord,
  PrincipalSubject,
  ProjectGrant,
  ProjectPlacement,
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

// ── organization scaffolding for Phase 6 scoped-administration tests ──────────
const ORG_SUB: PrincipalSubject = { userId: 'org-admin', kind: 'human', issuer: 'local' };

function unit(id: string, parentId?: string): OrganizationUnitRecord {
  return { id, name: id, kind: 'team', parentId, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', createdBy: ORG_SUB };
}
function placement(projectId: string, unitId: string): ProjectPlacement {
  return { id: `${projectId}@${unitId}`, projectId, unitId, role: 'owner', createdAt: '2026-01-01T00:00:00.000Z', createdBy: ORG_SUB };
}

/**
 * A small org used by the scoped-administration tests, mirroring scope.test.ts:
 *   acme(root) → eng → web ; acme → sales
 * with projects p-web@web, p-eng@eng, p-sales@sales. A grant scoped to 'eng'
 * therefore covers units {eng, web} and projects {p-web, p-eng} — but never sales.
 */
function seedOrg(dataDir: string): void {
  upsertOrganizationUnit(dataDir, unit('acme'));
  upsertOrganizationUnit(dataDir, unit('eng', 'acme'));
  upsertOrganizationUnit(dataDir, unit('web', 'eng'));
  upsertOrganizationUnit(dataDir, unit('sales', 'acme'));
  placeProject(dataDir, placement('p-web', 'web'));
  placeProject(dataDir, placement('p-eng', 'eng'));
  placeProject(dataDir, placement('p-sales', 'sales'));
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

  // Mint a stored token OWNED by a given user id (ownerSubject.userId); returns the plaintext.
  function mintOwnedToken(ownerUserId: string, grants: ProjectGrant[] = []): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: crypto.randomBytes(6).toString('hex'),
      keyHash: hashToken(token),
      role: 'editor',
      projects: grants.map((g) => g.projectId),
      grants,
      createdAt: new Date().toISOString(),
      ownerSubject: { userId: ownerUserId, kind: 'human', issuer: 'local' },
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

  it('mints a token when a non-admin caller holds key:manage AND the delegated permission for every requested project', () => {
    createProjectRecord(dataDir, 'proj-a');
    // The caller may only delegate permissions it itself holds (S5): key:manage + mcp:read.
    const caller = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['key:manage', 'mcp:read'] }]);

    const token = identity.mintToken(cfg, caller, {
      ownerUserId: 'u-owner',
      label: 't',
      grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
    });
    expect(token).toMatch(/^wk_/);
  });

  it('S5: a key:manage-only caller cannot mint a token carrying a permission it lacks for the project', () => {
    createProjectRecord(dataDir, 'proj-a');
    // Caller holds key:manage + mcp:read for proj-a, but NOT mcp:write.
    const caller = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['key:manage', 'mcp:read'] }]);

    // Delegating mcp:write (which the caller does not hold) is refused …
    expect(() =>
      identity.mintToken(cfg, caller, {
        ownerUserId: 'u-owner',
        label: 't',
        grants: [{ projectId: 'proj-a', permissions: ['mcp:write'] }],
      }),
    ).toThrow(ForbiddenError);

    // … while delegating a permission the caller DOES hold succeeds.
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

  // Re-review S5: an empty permissions[] must NOT vacuously pass delegation.
  it('rejects a grant carrying no permissions (empty-array delegation bypass)', () => {
    createProjectRecord(dataDir, 'proj-a');
    // A non-admin caller who could otherwise ride the vacuous .every([]) path.
    const caller = mintOwnedToken('u-weak', [{ projectId: 'proj-a', permissions: ['mcp:read'] }]);
    expect(() =>
      identity.mintToken(cfg, caller, {
        ownerUserId: 'u-weak',
        label: 't',
        grants: [{ projectId: 'proj-a', permissions: [] }],
      }),
    ).toThrow(/at least one permission/i);
  });

  // Re-review B1: a delegator cannot mint a fresh token for a deactivated user.
  it('refuses to mint a token for a deactivated user', () => {
    createProjectRecord(dataDir, 'proj-a');
    identity.upsertUser(cfg, MASTER, mkUser({ id: 'u-gone', subject: subject({ userId: 'u-gone' }) }));
    identity.setUserStatus(cfg, MASTER, 'u-gone', 'inactive');
    expect(() =>
      identity.mintToken(cfg, MASTER, {
        ownerUserId: 'u-gone',
        label: 't',
        grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
      }),
    ).toThrow(/deactivated user/i);
  });

  // Re-review B1: deactivation revokes tokens even when the record id differs
  // from the subject's userId (admin-created user with a divergent id).
  it('revokes tokens owned under the subject id when it diverges from the record id', () => {
    identity.upsertUser(
      cfg,
      MASTER,
      mkUser({ id: 'rec-42', subject: subject({ userId: 'subj-42' }) }),
    );
    const tokenBySubject = mintOwnedToken('subj-42', []);
    identity.setUserStatus(cfg, MASTER, 'rec-42', 'inactive');
    const rec = persistedByHash(hashToken(tokenBySubject));
    expect(rec?.revokedAt).toBeTruthy();
  });

  // 3rd-review B1: the mint deactivation guard must resolve the owner by the
  // subject id too, or minting with the subject id of a divergent-id user dodges
  // it and re-enables the deactivated identity.
  it('refuses to mint for a deactivated user addressed by their subject id (divergent id)', () => {
    createProjectRecord(dataDir, 'proj-a');
    identity.upsertUser(cfg, MASTER, mkUser({ id: 'rec-9', subject: subject({ userId: 'subj-9' }) }));
    identity.setUserStatus(cfg, MASTER, 'rec-9', 'inactive');
    // Both the record id AND the subject id must be refused.
    for (const ownerUserId of ['rec-9', 'subj-9']) {
      expect(() =>
        identity.mintToken(cfg, MASTER, {
          ownerUserId,
          label: 't',
          grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
        }),
      ).toThrow(/deactivated user/i);
    }
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

  it('deactivates a user as admin (non-active status) and audits a security-level user.deactivate', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-3' }));

    const updated = identity.setUserStatus(cfg, MASTER, 'u-3', 'suspended');
    expect(updated.status).toBe('suspended');

    const events = auditQuery(dataDir, { action: 'user.deactivate' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
    // No user.status.set event for a deactivation.
    expect(auditQuery(dataDir, { action: 'user.status.set' })).toHaveLength(0);
  });

  it('B1: deactivating a user revokes ALL their tokens (authenticate now fails), audits the revoked count, and reactivation does not restore them', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-deact' }));
    const t1 = mintOwnedToken('u-deact');
    const t2 = mintOwnedToken('u-deact');
    // Both tokens authenticate before deactivation.
    expect(authenticate(dataDir, t1).authenticated).toBe(true);
    expect(authenticate(dataDir, t2).authenticated).toBe(true);

    const updated = identity.setUserStatus(cfg, MASTER, 'u-deact', 'suspended');
    expect(updated.status).toBe('suspended');

    // Existing sessions are cut off at the credential layer.
    expect(authenticate(dataDir, t1).authenticated).toBe(false);
    expect(authenticate(dataDir, t2).authenticated).toBe(false);

    // The security event carries the revoked-token count in its metadata.
    const events = auditQuery(dataDir, { action: 'user.deactivate' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
    expect(events[0].metadata).toBe(JSON.stringify({ revokedTokens: 2 }));

    // Returning to 'active' does NOT restore the revoked tokens, and audits info-level user.status.set.
    identity.setUserStatus(cfg, MASTER, 'u-deact', 'active');
    expect(authenticate(dataDir, t1).authenticated).toBe(false);
    expect(authenticate(dataDir, t2).authenticated).toBe(false);
    const reactivate = auditQuery(dataDir, { action: 'user.status.set' });
    expect(reactivate).toHaveLength(1);
    expect(reactivate[0].level).toBe('info');
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

  // Phase 6 REPLACES the old instance-wide-only gate: a project-scoped audit:read
  // grant is now AUTHORIZED but its reads are FILTERED to that project's events
  // (it no longer 403s). An instance-wide grant still reads everything.
  it('S2 (Phase 6): a project-scoped audit:read grant confers FILTERED access to its project, not 403; instance-wide sees all', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'evt.acme', projectId: 'acme' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'evt.other', projectId: 'other' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'evt.global' }), DEFAULT_AUDIT_POLICY); // instance-level, no projectId

    // A project-scoped grant carrying audit:read now reads ONLY its own project's events.
    const scoped = mintNonAdminToken([{ projectId: 'acme', permissions: ['audit:read'] }]);
    const scopedEvents = identity.queryAuditEvents(cfg, scoped, {});
    expect(scopedEvents.map((e) => e.action)).toEqual(['evt.acme']);
    // Never an out-of-scope project's events, nor instance-level (no-projectId) events.
    expect(scopedEvents.some((e) => e.action === 'evt.other')).toBe(false);
    expect(scopedEvents.some((e) => e.action === 'evt.global')).toBe(false);
    // A count is scoped identically.
    expect(identity.countAuditEvents(cfg, scoped, {})).toBe(1);

    // The same permission scoped to ALL projects ('*') reads instance-wide.
    const instanceWide = mintNonAdminToken([{ projectId: '*', permissions: ['audit:read'] }]);
    expect(identity.queryAuditEvents(cfg, instanceWide, {})).toHaveLength(3);
  });

  // ── Phase 6: scoped administration (unit-scoped grants) ──────────────────────
  //
  // A grant scoped to org unit 'eng' resolves (via the scope specialist) to units
  // {eng, web} and projects {p-web, p-eng}; 'sales' / 'p-sales' are out of scope.
  // MASTER is the '*'/'*' bootstrap → scope.all → full super-admin reach.

  it('queryAuditEvents: a unit-scoped audit:read caller sees only its subtree events, never another unit\'s or instance-level ones', () => {
    seedOrg(dataDir);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.web', projectId: 'p-web' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.eng', projectId: 'p-eng' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.sales', projectId: 'p-sales' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.global' }), DEFAULT_AUDIT_POLICY); // no projectId

    const caller = mintNonAdminToken([{ projectId: '', orgUnitId: 'eng', permissions: ['audit:read'] }]);

    const events = identity.queryAuditEvents(cfg, caller, {});
    expect(new Set(events.map((e) => e.projectId))).toEqual(new Set(['p-web', 'p-eng']));
    // Never the out-of-scope unit's events nor the instance-level (no-projectId) event.
    expect(events.some((e) => e.action === 'a.sales')).toBe(false);
    expect(events.some((e) => e.action === 'a.global')).toBe(false);
    expect(identity.countAuditEvents(cfg, caller, {})).toBe(2);

    // A caller-supplied projectId filter intersects with scope: in-scope narrows,
    // out-of-scope yields nothing (never leaks another project's events).
    expect(identity.queryAuditEvents(cfg, caller, { projectId: 'p-web' })).toHaveLength(1);
    expect(identity.queryAuditEvents(cfg, caller, { projectId: 'p-sales' })).toHaveLength(0);

    // MASTER (super-admin) still reads instance-wide — all four events.
    expect(identity.queryAuditEvents(cfg, MASTER, {})).toHaveLength(4);
    expect(identity.countAuditEvents(cfg, MASTER, {})).toBe(4);
  });

  it('listUsers: a unit-scoped user:admin caller sees only in-scope-unit users; MASTER sees all (incl. no-unit users)', () => {
    seedOrg(dataDir);
    repoUpsertUser(dataDir, mkUser({ id: 'u-web', unitId: 'web' }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-sales', unitId: 'sales' }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-nounit' })); // no home unit

    const caller = mintNonAdminToken([{ projectId: '', orgUnitId: 'eng', permissions: ['user:admin'] }]);
    expect(identity.listUsers(cfg, caller).map((u) => u.id)).toEqual(['u-web']);

    // A user with no home unit is visible only to a super-admin.
    expect(identity.listUsers(cfg, MASTER).map((u) => u.id).sort()).toEqual(['u-nounit', 'u-sales', 'u-web']);
  });

  it('setUserStatus: a unit-scoped admin may act on an in-scope user but is 403 on an out-of-scope one; MASTER may do both', () => {
    seedOrg(dataDir);
    repoUpsertUser(dataDir, mkUser({ id: 'u-web', unitId: 'web' }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-sales', unitId: 'sales' }));

    const caller = mintNonAdminToken([{ projectId: '', orgUnitId: 'eng', permissions: ['user:admin'] }]);

    // In-scope: allowed.
    expect(identity.setUserStatus(cfg, caller, 'u-web', 'suspended').status).toBe('suspended');
    // Out-of-scope: 403.
    expect(() => identity.setUserStatus(cfg, caller, 'u-sales', 'suspended')).toThrow(ForbiddenError);

    // MASTER (super-admin) may act on both.
    expect(identity.setUserStatus(cfg, MASTER, 'u-sales', 'suspended').status).toBe('suspended');
  });

  it('upsertUser: a unit-scoped admin may only create/update users within its subtree; MASTER anywhere', () => {
    seedOrg(dataDir);
    const caller = mintNonAdminToken([{ projectId: '', orgUnitId: 'eng', permissions: ['user:admin'] }]);

    // Create an in-scope user (home unit web) → allowed.
    expect(identity.upsertUser(cfg, caller, mkUser({ id: 'nw', unitId: 'web' })).id).toBe('nw');
    // Create an out-of-scope user (home unit sales) → 403.
    expect(() => identity.upsertUser(cfg, caller, mkUser({ id: 'ns', unitId: 'sales' }))).toThrow(ForbiddenError);
    // Create a user with no home unit → 403 for a scoped admin.
    expect(() => identity.upsertUser(cfg, caller, mkUser({ id: 'nn' }))).toThrow(ForbiddenError);

    // MASTER may create any of them.
    expect(identity.upsertUser(cfg, MASTER, mkUser({ id: 'ms', unitId: 'sales' })).id).toBe('ms');
  });

  it('replaceUserGrants: escalation guard — a unit admin cannot grant "*" or an out-of-scope unit/project; in-scope grants pass', () => {
    seedOrg(dataDir);
    repoUpsertUser(dataDir, mkUser({ id: 'u-web', unitId: 'web' }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-sales', unitId: 'sales' }));

    const caller = mintNonAdminToken([{ projectId: '', orgUnitId: 'eng', permissions: ['user:admin'] }]);

    // In-scope project grant → allowed.
    expect(
      identity.replaceUserGrants(cfg, caller, 'u-web', [{ projectId: 'p-web', permissions: ['mcp:read'] }]).grants,
    ).toEqual([{ projectId: 'p-web', permissions: ['mcp:read'] }]);
    // In-scope unit grant → allowed.
    expect(
      identity.replaceUserGrants(cfg, caller, 'u-web', [{ projectId: '', orgUnitId: 'web', permissions: ['mcp:read'] }])
        .grants,
    ).toHaveLength(1);

    // Escalation attempts are all rejected: instance-wide '*', an out-of-scope
    // unit, and an out-of-scope specific project.
    expect(() => identity.replaceUserGrants(cfg, caller, 'u-web', [{ projectId: '*', permissions: ['mcp:read'] }])).toThrow(
      ForbiddenError,
    );
    expect(() =>
      identity.replaceUserGrants(cfg, caller, 'u-web', [{ projectId: '', orgUnitId: 'sales', permissions: ['mcp:read'] }]),
    ).toThrow(ForbiddenError);
    expect(() =>
      identity.replaceUserGrants(cfg, caller, 'u-web', [{ projectId: 'p-sales', permissions: ['mcp:read'] }]),
    ).toThrow(ForbiddenError);

    // The target itself must be in scope: u-sales (home unit sales) is 403 even for an in-scope grant.
    expect(() =>
      identity.replaceUserGrants(cfg, caller, 'u-sales', [{ projectId: 'p-web', permissions: ['mcp:read'] }]),
    ).toThrow(ForbiddenError);

    // MASTER (super-admin) may assign an instance-wide '*' grant unrestricted.
    expect(
      identity.replaceUserGrants(cfg, MASTER, 'u-web', [{ projectId: '*', permissions: ['mcp:read'] }]).grants,
    ).toEqual([{ projectId: '*', permissions: ['mcp:read'] }]);
  });

  it('mintToken: a scoped caller may only delegate within its own scope; MASTER may delegate beyond it', () => {
    seedOrg(dataDir);
    createProjectRecord(dataDir, 'p-web');
    createProjectRecord(dataDir, 'p-sales');
    // Caller holds key:manage + mcp:read for the in-scope project p-web only.
    const caller = mintNonAdminToken([{ projectId: 'p-web', permissions: ['key:manage', 'mcp:read'] }]);

    // Delegating within scope → succeeds.
    expect(
      identity.mintToken(cfg, caller, { ownerUserId: 'u-o', label: 't', grants: [{ projectId: 'p-web', permissions: ['mcp:read'] }] }),
    ).toMatch(/^wk_/);

    // Delegating for an out-of-scope project → 403.
    expect(() =>
      identity.mintToken(cfg, caller, { ownerUserId: 'u-o', label: 't', grants: [{ projectId: 'p-sales', permissions: ['mcp:read'] }] }),
    ).toThrow(ForbiddenError);

    // Delegating an instance-wide '*' grant → 403 (only a super-admin may).
    expect(() =>
      identity.mintToken(cfg, caller, { ownerUserId: 'u-o', label: 't', grants: [{ projectId: '*', permissions: ['mcp:read'] }] }),
    ).toThrow(ForbiddenError);

    // MASTER (super-admin) may mint the very grant the scoped caller could not.
    expect(
      identity.mintToken(cfg, MASTER, { ownerUserId: 'u-o', label: 't', grants: [{ projectId: 'p-sales', permissions: ['mcp:read'] }] }),
    ).toMatch(/^wk_/);
  });

  it('mintToken: an unknown organization unit in a requested grant is rejected', () => {
    seedOrg(dataDir);
    // MASTER passes delegation authz, so the failure is the unit-existence check.
    expect(() =>
      identity.mintToken(cfg, MASTER, {
        ownerUserId: 'u-o',
        label: 't',
        grants: [{ projectId: '', orgUnitId: 'ghost-unit', permissions: ['mcp:read'] }],
      }),
    ).toThrow(/unknown organization unit/i);
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

  // ── revokeAllForOwner (credential registry) ─────────────────────────────────

  it('revokeAllForOwner revokes every non-revoked credential owned by the user, returns the count, and leaves others intact', () => {
    const owned1 = mintOwnedToken('owner-1');
    const owned2 = mintOwnedToken('owner-1');
    const otherOwner = mintOwnedToken('owner-2');
    const unowned = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['mcp:read'] }]); // no ownerSubject

    const count = revokeAllForOwner(dataDir, 'owner-1');
    expect(count).toBe(2);

    // owner-1's tokens no longer authenticate and carry a revokedAt timestamp.
    expect(authenticate(dataDir, owned1).authenticated).toBe(false);
    expect(authenticate(dataDir, owned2).authenticated).toBe(false);
    const owner1Recs = listCredentials(dataDir, '*').filter((r) => r.ownerSubject?.userId === 'owner-1');
    expect(owner1Recs.every((r) => typeof r.revokedAt === 'string')).toBe(true);

    // A different owner's token and an unowned token are untouched.
    expect(authenticate(dataDir, otherOwner).authenticated).toBe(true);
    expect(authenticate(dataDir, unowned).authenticated).toBe(true);
  });

  it('revokeAllForOwner is idempotent (already-revoked skipped) and returns 0 for an owner with no active credentials', () => {
    mintOwnedToken('owner-x');

    expect(revokeAllForOwner(dataDir, 'owner-x')).toBe(1);
    // A second pass revokes nothing — already-revoked records are skipped.
    expect(revokeAllForOwner(dataDir, 'owner-x')).toBe(0);
    // An owner with no credentials at all revokes nothing.
    expect(revokeAllForOwner(dataDir, 'nobody')).toBe(0);
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
