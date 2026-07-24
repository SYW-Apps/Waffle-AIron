import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as identity from '../../src/server/identity.js';
import { UnauthenticatedError, ForbiddenError } from '../../src/server/identity.js';
import { authenticate, authenticateSession } from '../../src/server/auth.js';
import {
  createCredential,
  hashToken,
  listCredentials,
  revokeAllForOwner,
} from '../../src/server/credentials.js';
import { createWebSession, getWebSessionById } from '../../src/server/websessions.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { upsertUser as repoUpsertUser } from '../../src/server/users.js';
import { createUnit, placeProject } from '../../src/server/organization.js';
import { mintUserToken, allow, seedSubsystem, seedChainedMount } from './helpers.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { appendAuditEvent, queryAuditEvents as auditQuery, DEFAULT_AUDIT_POLICY } from '../../src/server/audit.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  Capability,
  HostConfig,
  HostedUserRecord,
  OrganizationUnitRecord,
  PermissionValue,
  PrincipalSubject,
  ProjectPlacement,
  ScopeKind,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Identity Orchestrator + Portal (sdd_host) — exercised through the exported
// orchestrator functions against a real <dataDir>, mirroring the other server
// suites. Covers authentication (401), resolver-based authorization (403), the
// token/user/audit workflows (mintToken is INSTANCE-ADMIN only — a token acts
// as its owner's live permission), the reserved-subject guard, best-effort
// audit appends, and the audit action distinctions (user.create vs user.update).
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

function mkUser(over: Partial<HostedUserRecord> & Pick<HostedUserRecord, 'id'>): HostedUserRecord {
  return {
    subject: subject(),
    status: 'active',
    roleBindings: [],
    createdAt: '2000-01-01T00:00:00.000Z',
    ...over,
  };
}

// ── organization scaffolding for Phase 6 scoped-administration tests ──────────
const ORG_SUB: PrincipalSubject = { userId: 'org-admin', kind: 'human', issuer: 'local' };

function unit(slug: string, parentId?: string): OrganizationUnitRecord {
  return { id: '', slug, name: slug, kind: 'team', parentId, status: 'active', createdAt: '', createdBy: ORG_SUB };
}
function placement(projectId: string, unitId: string): ProjectPlacement {
  return { id: `${projectId}@${unitId}`, projectId, unitId, role: 'owner', createdAt: '2026-01-01T00:00:00.000Z', createdBy: ORG_SUB };
}

// The QUALIFIED dot-path unit ids the registry computes (parent id + '.' + slug).
const ACME = 'acme';
const ENG = 'acme.eng';
const WEB = 'acme.eng.web';
const SALES = 'acme.sales';

/**
 * A small org used by the scoped-administration tests:
 *   acme(root) → eng → web ; acme → sales
 * with projects p-web@WEB, p-eng@ENG, p-sales@SALES. An assignment scoped to ENG
 * therefore covers units {ENG, WEB} and projects {p-web, p-eng} — never sales.
 */
function seedOrg(dataDir: string): void {
  createUnit(dataDir, unit('acme'));
  createUnit(dataDir, unit('eng', ACME));
  createUnit(dataDir, unit('web', ENG));
  createUnit(dataDir, unit('sales', ACME));
  placeProject(dataDir, placement('p-web', WEB));
  placeProject(dataDir, placement('p-eng', ENG));
  placeProject(dataDir, placement('p-sales', SALES));
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

  // Mint a grants-free token owned by a FRESH subject holding one assignment.
  let userSeq = 0;
  function tokenWith(capability: Capability, scopeKind: ScopeKind, scopeId?: string, value: PermissionValue = 'yes'): string {
    const userId = `u-tok-${userSeq++}`;
    allow(dataDir, userId, capability, scopeKind, scopeId, value);
    return mintUserToken(dataDir, { id: crypto.randomBytes(6).toString('hex'), userId });
  }
  // A token whose owner holds NO assignments at all.
  function plainToken(): string {
    return mintUserToken(dataDir, { id: crypto.randomBytes(6).toString('hex'), userId: `u-plain-${userSeq++}` });
  }

  // Mint a stored token OWNED by a given user id (ownerSubject.userId); returns the plaintext.
  function mintOwnedToken(ownerUserId: string): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: crypto.randomBytes(6).toString('hex'),
      keyHash: hashToken(token),
      projects: ['*'],
      createdAt: new Date().toISOString(),
      ownerSubject: { userId: ownerUserId, kind: 'human', issuer: 'local' },
    };
    createCredential(dataDir, record);
    return token;
  }

  function persistedByHash(tokenHash: string): ApiKeyRecord | undefined {
    return listCredentials(dataDir, '*').find((r) => r.keyHash === tokenHash);
  }

  // ── mintToken (INSTANCE-ADMIN only: a token acts as its owner's live permission) ──

  it('mints a token as instance-admin: returns plaintext, persists a hashed narrowing-only record, and audits token.mint', () => {
    createProjectRecord(dataDir, 'proj-a');

    const token = identity.mintToken(cfg, MASTER, { ownerUserId: 'u-owner', label: 'ci token', projects: ['proj-a'] });

    expect(token).toMatch(/^wk_[0-9a-f]+$/);
    const rec = persistedByHash(hashToken(token));
    expect(rec).toBeDefined();
    expect(rec!.keyHash).toBe(hashToken(token)); // only the hash is stored
    expect(rec!.ownerSubject?.userId).toBe('u-owner');
    expect(rec!.projects).toEqual(['proj-a']); // a NARROWING, never a grant
    expect(rec!.label).toBe('ci token');
    // createdBySubject carries the bootstrap admin identity.
    expect(rec!.createdBySubject?.userId).toBe('bootstrap');

    const events = auditQuery(dataDir, { action: 'token.mint' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
    expect(events[0].target).toBe(rec!.id);
  });

  it('a DELEGATED instance-level project:admin may NOT mint for another user (confused-deputy guard)', () => {
    createProjectRecord(dataDir, 'proj-a');
    // The minted token would act as its OWNER's live permission, which can
    // exceed the delegated minter's own reach — instance-admin only.
    const delegated = tokenWith('project:admin', 'instance');
    expect(() =>
      identity.mintToken(cfg, delegated, { ownerUserId: 'u-owner', label: 't', projects: ['proj-a'] }),
    ).toThrow(/instance admin/i);
  });

  it('rejects a mint whose narrowing references an unknown project', () => {
    // admin passes the gate, so the failure is the project-existence check.
    expect(() =>
      identity.mintToken(cfg, MASTER, { ownerUserId: 'u-owner', label: 't', projects: ['ghost'] }),
    ).toThrow(/unknown project/i);
  });

  it('rejects a mint whose OWNER claims a reserved built-in subject id (legacy literal or persisted UUID)', () => {
    const instance = ensureInstanceIdentity(dataDir);
    for (const ownerUserId of ['builtin:superadmin', 'builtin:localdev', instance.superadminUserId, instance.localDevUserId]) {
      expect(() => identity.mintToken(cfg, MASTER, { ownerUserId, label: 't' })).toThrow(/reserved/i);
    }
  });

  // Re-review B1: nobody can mint a fresh token for a deactivated user.
  it('refuses to mint a token for a deactivated user', () => {
    createProjectRecord(dataDir, 'proj-a');
    identity.upsertUser(cfg, MASTER, mkUser({ id: 'u-gone', subject: subject({ userId: 'u-gone' }) }));
    identity.setUserStatus(cfg, MASTER, 'u-gone', 'inactive');
    expect(() =>
      identity.mintToken(cfg, MASTER, { ownerUserId: 'u-gone', label: 't', projects: ['proj-a'] }),
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
        identity.mintToken(cfg, MASTER, { ownerUserId, label: 't', projects: ['proj-a'] }),
      ).toThrow(/deactivated user/i);
    }
  });

  // ── subproject-qualified narrowing (validated at MINT time) ────────────────
  //
  // A narrowing entry / mintSelfToken projectId MAY be subproject-qualified
  // ('projectId::subsystemId', nested mounts composing): the named subsystem
  // must exist on that project and carry a projectPath, validated at MINT time
  // so a broken mount is never stored; permission keeps resolving over the TOP
  // project (the qualifier narrows reach, never grants).

  describe('subproject-qualified narrowing', () => {
    beforeEach(() => {
      const projRoot = createProjectRecord(dataDir, 'proj-a').rootPath;
      const billingDir = seedChainedMount(projRoot, 'billing', 'packages/billing');
      seedChainedMount(billingDir, 'payments', 'sub/payments'); // nested chain
      seedSubsystem(projRoot, 'plain'); // exists, but NOT chained (no projectPath)
    });

    it('mintToken accepts valid qualified entries (nested included) and stores them verbatim', () => {
      const token = identity.mintToken(cfg, MASTER, {
        ownerUserId: 'u-owner',
        label: 'sub token',
        projects: ['proj-a::billing', 'proj-a::billing::payments'],
      });
      const rec = persistedByHash(hashToken(token));
      expect(rec!.projects).toEqual(['proj-a::billing', 'proj-a::billing::payments']);
    });

    it('mintToken rejects an UNKNOWN mount with an actionable error — never stored broken', () => {
      expect(() =>
        identity.mintToken(cfg, MASTER, { ownerUserId: 'u-owner', label: 't', projects: ['proj-a::ghost'] }),
      ).toThrow(/unknown subproject mount "ghost" on "proj-a"/);
      // The failed mint persisted nothing.
      expect(listCredentials(dataDir, '*').some((r) => r.projects.includes('proj-a::ghost'))).toBe(false);
    });

    it('mintToken rejects a NON-CHAINED subsystem (exists, but carries no projectPath)', () => {
      expect(() =>
        identity.mintToken(cfg, MASTER, { ownerUserId: 'u-owner', label: 't', projects: ['proj-a::plain'] }),
      ).toThrow(/not a chained subproject/);
    });

    it('mintSelfToken mints a qualified token: permission anchors on the TOP project, entry stored verbatim', () => {
      // The caller holds read over the TOP project only — that is what the
      // qualifier narrows, so the mint is authorized.
      const caller = tokenWith('project:read', 'project', 'proj-a');
      const token = identity.mintSelfToken(cfg, caller, 'proj-a::billing', false);
      const rec = persistedByHash(hashToken(token));
      expect(rec!.projects).toEqual(['proj-a::billing']);
      expect(rec!.label).toContain('proj-a::billing');
      expect(auditQuery(dataDir, { action: 'token.mint.self' })).toHaveLength(1);
    });

    it('mintSelfToken rejects an unknown or non-chained mount with guidance (self-mint variant)', () => {
      const caller = tokenWith('project:read', 'project', 'proj-a');
      expect(() => identity.mintSelfToken(cfg, caller, 'proj-a::ghost', false)).toThrow(
        /unknown subproject mount "ghost" on "proj-a"/,
      );
      expect(() => identity.mintSelfToken(cfg, caller, 'proj-a::plain', false)).toThrow(
        /not a chained subproject/,
      );
    });

    it('mintSelfToken authorization anchors on the TOP project: no proj-a read → 403 even for a valid mount', () => {
      const caller = plainToken(); // owner with NO assignments at all
      expect(() => identity.mintSelfToken(cfg, caller, 'proj-a::billing', false)).toThrow(ForbiddenError);
    });
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

  it('rejects a revoke (403) for a DELEGATED admin — the administrative kill switch is instance-admin only', () => {
    createCredential(dataDir, {
      id: 'tok-2',
      keyHash: hashToken('wk_x'),
      projects: ['proj-a'],
      createdAt: new Date().toISOString(),
    });
    const caller = tokenWith('project:admin', 'instance');

    expect(() => identity.revokeToken(cfg, caller, 'tok-2')).toThrow(ForbiddenError);
  });

  // ── upsertUser: create vs update + the reserved-subject guard ───────────────

  it('audits user.create on first upsert and user.update on the second', () => {
    identity.upsertUser(cfg, MASTER, mkUser({ id: 'u-2', subject: subject({ displayName: 'Ada' }) }));
    identity.upsertUser(cfg, MASTER, mkUser({ id: 'u-2', subject: subject({ displayName: 'Ada Lovelace' }) }));

    expect(auditQuery(dataDir, { action: 'user.create' })).toHaveLength(1);
    expect(auditQuery(dataDir, { action: 'user.update' })).toHaveLength(1);
  });

  it('rejects upsertUser (403) for a caller with no project:admin reach', () => {
    const caller = plainToken();
    expect(() => identity.upsertUser(cfg, caller, mkUser({ id: 'u-9' }))).toThrow(ForbiddenError);
  });

  it('RESERVED-SUBJECT GUARD: even MASTER cannot create a user claiming a built-in subject id', () => {
    const instance = ensureInstanceIdentity(dataDir);
    const claims = ['builtin:superadmin', 'builtin:localdev', instance.superadminUserId, instance.localDevUserId];
    for (const claimed of claims) {
      // Rejected whether claimed as the record id …
      expect(() =>
        identity.upsertUser(cfg, MASTER, mkUser({ id: claimed, subject: subject({ userId: 'harmless' }) })),
      ).toThrow(/reserved/i);
      // … or as the record's subject id.
      expect(() =>
        identity.upsertUser(cfg, MASTER, mkUser({ id: 'harmless', subject: subject({ userId: claimed }) })),
      ).toThrow(/reserved/i);
    }
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

    // The security event carries the revoked-token (and revoked-session) counts.
    const events = auditQuery(dataDir, { action: 'user.deactivate' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
    expect(events[0].metadata).toBe(JSON.stringify({ revokedTokens: 2, revokedSessions: 0 }));

    // Returning to 'active' does NOT restore the revoked tokens, and audits info-level user.status.set.
    identity.setUserStatus(cfg, MASTER, 'u-deact', 'active');
    expect(authenticate(dataDir, t1).authenticated).toBe(false);
    expect(authenticate(dataDir, t2).authenticated).toBe(false);
    const reactivate = auditQuery(dataDir, { action: 'user.status.set' });
    expect(reactivate).toHaveLength(1);
    expect(reactivate[0].level).toBe('info');
  });

  it('rejects setUserStatus (403) for a caller with no project:admin reach', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-3' }));
    const caller = plainToken();
    expect(() => identity.setUserStatus(cfg, caller, 'u-3', 'suspended')).toThrow(ForbiddenError);
  });

  // Adversarial review (web UI wave 3): browser web sessions are a SEPARATE
  // credential store the data-plane auth bridge accepts (a ws_ cookie drives /mcp
  // like a bearer). Deactivation must sweep them too, or a deactivated user keeps a
  // live session — the B1 hole, reintroduced by the session store.
  it('deactivating a user revokes ALL their live web sessions (the auth bridge can no longer resolve them) and counts them in the audit event', () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    repoUpsertUser(dataDir, mkUser({ id: 'u-sess', subject: subject({ userId: 'u-sess' }) }));
    const s1 = createWebSession(dataDir, { id: '', subject: subject({ userId: 'u-sess' }), projects: ['*'], createdAt: '', expiresAt: future });
    const s2 = createWebSession(dataDir, { id: '', subject: subject({ userId: 'u-sess' }), projects: ['*'], createdAt: '', expiresAt: future });
    // A bystander's session must survive the sweep.
    const other = createWebSession(dataDir, { id: '', subject: subject({ userId: 'u-other' }), projects: ['*'], createdAt: '', expiresAt: future });

    // Both of the user's sessions authenticate through the bridge before deactivation.
    expect(authenticateSession(dataDir, s1.id).authenticated).toBe(true);
    expect(authenticateSession(dataDir, s2.id).authenticated).toBe(true);

    identity.setUserStatus(cfg, MASTER, 'u-sess', 'suspended');

    // The user's sessions are gone; the bridge resolves them to UNAUTHENTICATED.
    expect(getWebSessionById(dataDir, s1.id)).toBeNull();
    expect(getWebSessionById(dataDir, s2.id)).toBeNull();
    expect(authenticateSession(dataDir, s1.id).authenticated).toBe(false);
    expect(authenticateSession(dataDir, s2.id).authenticated).toBe(false);
    // The bystander is untouched.
    expect(getWebSessionById(dataDir, other.id)).not.toBeNull();

    // The security event carries the revoked-session count.
    const events = auditQuery(dataDir, { action: 'user.deactivate' });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toBe(JSON.stringify({ revokedTokens: 0, revokedSessions: 2 }));
  });

  // ── listUsers authorization ─────────────────────────────────────────────────

  it('lists users for an instance-level project:admin, and rejects a caller without reach', () => {
    repoUpsertUser(dataDir, mkUser({ id: 'u-a' }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-b' }));

    // admin sees all.
    expect(identity.listUsers(cfg, MASTER).map((u) => u.id).sort()).toEqual(['u-a', 'u-b']);

    // a DELEGATED instance-level project:admin is authorized instance-wide.
    const userAdmin = tokenWith('project:admin', 'instance');
    expect(identity.listUsers(cfg, userAdmin)).toHaveLength(2);

    // a caller without project:admin reach is denied.
    const plain = tokenWith('project:read', 'project', 'proj-a');
    expect(() => identity.listUsers(cfg, plain)).toThrow(ForbiddenError);
  });

  // ── queryAuditEvents authorization ──────────────────────────────────────────

  it('returns audit events for a project:admin caller and rejects one without', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'token.mint', level: 'security' }), DEFAULT_AUDIT_POLICY);

    const reader = tokenWith('project:admin', 'instance');
    expect(identity.queryAuditEvents(cfg, reader, {}).length).toBeGreaterThanOrEqual(1);

    const plain = tokenWith('project:read', 'project', 'proj-a');
    expect(() => identity.queryAuditEvents(cfg, plain, {})).toThrow(ForbiddenError);
  });

  // A project-scoped project:admin is AUTHORIZED but its reads are FILTERED to
  // that project's events (never 403). An instance-level admin reads everything.
  it('S2: a project-scoped admin gets FILTERED audit access to its project, not 403; instance-level sees all', () => {
    // The scoped project must exist AND be placed — the resolver enumerates the
    // org tree, so an unplaced project is in nobody's visibility view.
    const tenant = createUnit(dataDir, unit('tenant'));
    createProjectRecord(dataDir, 'acme');
    placeProject(dataDir, placement('acme', tenant.id));

    appendAuditEvent(dataDir, mkEvent({ action: 'evt.acme', projectId: 'acme' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'evt.other', projectId: 'other' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'evt.global' }), DEFAULT_AUDIT_POLICY); // instance-level, no projectId

    // A project-scoped admin reads ONLY its own project's events.
    const scoped = tokenWith('project:admin', 'project', 'acme');
    const scopedEvents = identity.queryAuditEvents(cfg, scoped, {});
    expect(scopedEvents.map((e) => e.action)).toEqual(['evt.acme']);
    // Never an out-of-scope project's events, nor instance-level (no-projectId) events.
    expect(scopedEvents.some((e) => e.action === 'evt.other')).toBe(false);
    expect(scopedEvents.some((e) => e.action === 'evt.global')).toBe(false);
    // A count is scoped identically.
    expect(identity.countAuditEvents(cfg, scoped, {})).toBe(1);

    // An instance-level admin reads instance-wide.
    const instanceWide = tokenWith('project:admin', 'instance');
    expect(identity.queryAuditEvents(cfg, instanceWide, {})).toHaveLength(3);
  });

  // ── scoped administration (unit-scoped assignments) ──────────────────────────
  //
  // A project:admin assignment scoped to org unit ENG covers units {ENG, WEB}
  // and projects {p-web, p-eng}; SALES / 'p-sales' are out of scope. MASTER is
  // the bootstrap instance-admin → full reach.

  it('queryAuditEvents: a unit-scoped admin sees only its subtree events, never another unit\'s or instance-level ones', () => {
    seedOrg(dataDir);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.web', projectId: 'p-web' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.eng', projectId: 'p-eng' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.sales', projectId: 'p-sales' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'a.global' }), DEFAULT_AUDIT_POLICY); // no projectId

    const caller = tokenWith('project:admin', 'unit', ENG);

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

    // MASTER (instance-admin) still reads instance-wide — all four events.
    expect(identity.queryAuditEvents(cfg, MASTER, {})).toHaveLength(4);
    expect(identity.countAuditEvents(cfg, MASTER, {})).toBe(4);
  });

  it('listUsers: a unit-scoped admin sees only in-scope-unit users; MASTER sees all (incl. no-unit users)', () => {
    seedOrg(dataDir);
    repoUpsertUser(dataDir, mkUser({ id: 'u-web', unitId: WEB }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-sales', unitId: SALES }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-nounit' })); // no home unit

    const caller = tokenWith('project:admin', 'unit', ENG);
    expect(identity.listUsers(cfg, caller).map((u) => u.id)).toEqual(['u-web']);

    // A user with no home unit is visible only to an instance-level admin.
    expect(identity.listUsers(cfg, MASTER).map((u) => u.id).sort()).toEqual(['u-nounit', 'u-sales', 'u-web']);
  });

  it('setUserStatus: a unit-scoped admin may act on an in-scope user but is 403 on an out-of-scope one; MASTER may do both', () => {
    seedOrg(dataDir);
    repoUpsertUser(dataDir, mkUser({ id: 'u-web', unitId: WEB }));
    repoUpsertUser(dataDir, mkUser({ id: 'u-sales', unitId: SALES }));

    const caller = tokenWith('project:admin', 'unit', ENG);

    // In-scope: allowed.
    expect(identity.setUserStatus(cfg, caller, 'u-web', 'suspended').status).toBe('suspended');
    // Out-of-scope: 403.
    expect(() => identity.setUserStatus(cfg, caller, 'u-sales', 'suspended')).toThrow(ForbiddenError);

    // MASTER (instance-admin) may act on both.
    expect(identity.setUserStatus(cfg, MASTER, 'u-sales', 'suspended').status).toBe('suspended');
  });

  it('upsertUser: a unit-scoped admin may only create/update users within its subtree; MASTER anywhere', () => {
    seedOrg(dataDir);
    const caller = tokenWith('project:admin', 'unit', ENG);

    // Create an in-scope user (home unit WEB) → allowed.
    expect(identity.upsertUser(cfg, caller, mkUser({ id: 'nw', unitId: WEB })).id).toBe('nw');
    // Create an out-of-scope user (home unit SALES) → 403.
    expect(() => identity.upsertUser(cfg, caller, mkUser({ id: 'ns', unitId: SALES }))).toThrow(ForbiddenError);
    // Create a user with no home unit → 403 for a scoped admin (instance root).
    expect(() => identity.upsertUser(cfg, caller, mkUser({ id: 'nn' }))).toThrow(ForbiddenError);
    // A scoped admin cannot CAPTURE a foreign user by rewriting their home unit
    // into scope: the existing unit must also be covered.
    repoUpsertUser(dataDir, mkUser({ id: 'u-foreign', unitId: SALES }));
    expect(() => identity.upsertUser(cfg, caller, mkUser({ id: 'u-foreign', unitId: WEB }))).toThrow(ForbiddenError);

    // MASTER may create any of them.
    expect(identity.upsertUser(cfg, MASTER, mkUser({ id: 'ms', unitId: SALES })).id).toBe('ms');
  });

  it('mintToken: even a unit-scoped admin may not mint for another user (a token IS its owner, live)', () => {
    seedOrg(dataDir);
    createProjectRecord(dataDir, 'p-web');
    // A unit admin's own reach is irrelevant: the minted token would resolve the
    // OWNER's live permission, which could exceed the minter's — instance-admin only.
    const caller = tokenWith('project:admin', 'unit', ENG);
    expect(() =>
      identity.mintToken(cfg, caller, { ownerUserId: 'u-o', label: 't', projects: ['p-web'] }),
    ).toThrow(/instance admin/i);

    // MASTER mints; the owner's authority resolves live from THEIR assignments.
    expect(identity.mintToken(cfg, MASTER, { ownerUserId: 'u-o', label: 't', projects: ['p-web'] })).toMatch(/^wk_/);
  });

  // ── pruneAuditEvents ─────────────────────────────────────────────────────────

  it('prunes expired audit events as admin and audits audit.prune', () => {
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString(); // beyond 90d retention
    appendAuditEvent(dataDir, mkEvent({ action: 'a.old', timestamp: old }), DEFAULT_AUDIT_POLICY);

    const removed = identity.pruneAuditEvents(cfg, MASTER);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(auditQuery(dataDir, { action: 'audit.prune' })).toHaveLength(1);
  });

  it('rejects pruneAuditEvents (403) for a caller without instance-level project:admin', () => {
    const reader = tokenWith('project:read', 'instance');
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
    // A token with NO ownerSubject at all (legacy master-minted shape).
    const unownedPlain = 'wk_' + crypto.randomBytes(8).toString('hex');
    createCredential(dataDir, {
      id: 'unowned-1',
      keyHash: hashToken(unownedPlain),
      projects: ['proj-a'],
      createdAt: new Date().toISOString(),
    });
    const unowned = unownedPlain;

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
    const req = { ownerUserId: 'u', label: 't' };
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
