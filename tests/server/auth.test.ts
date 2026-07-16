import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  authenticate,
  authenticateCredential,
  authenticateMaster,
  authenticateSession,
} from '../../src/server/auth.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { createWebSession, WEB_SESSION_PREFIX } from '../../src/server/websessions.js';
import { upsertUser } from '../../src/server/users.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import type { ApiKeyRecord, PrincipalSubject, WebSession } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Auth Specialist (sdd_host) — subject resolution, the LIVE permissionSubject
// (roleBindings read fresh from the user record; instanceAdmin only for the
// persisted built-in subjects / master), expiry/revocation/deactivation, and
// the dual-credential authenticateCredential entry point. Records are written
// to a real credentials.json via createCredential so the salted-hash lookup is
// exercised end-to-end. A Principal carries NO permissions of its own.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret';

function mkRecord(over: Partial<ApiKeyRecord> & Pick<ApiKeyRecord, 'id' | 'keyHash'>): ApiKeyRecord {
  return {
    projects: ['proj-a'],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('auth specialist (sdd_host)', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-auth-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── authenticate: subject + live permissionSubject resolution ─────────────

  it('resolves the subject and a LIVE permissionSubject (roleBindings from the user record)', () => {
    const token = 'tok-explicit';
    const ownerSubject: PrincipalSubject = { userId: 'u-1', kind: 'human', issuer: 'local', email: 'a@b.co' };
    upsertUser(dataDir, {
      id: 'u-1',
      subject: ownerSubject,
      status: 'active',
      roleBindings: [{ roleId: 'sso-admin' }],
      createdAt: new Date().toISOString(),
    });
    createCredential(dataDir, mkRecord({ id: 'c-1', keyHash: hashToken(token), ownerSubject }));

    const p = authenticate(dataDir, token);
    expect(p.authenticated).toBe(true);
    expect(p.tokenId).toBe('c-1');
    expect(p.subject).toEqual(ownerSubject);
    // The permissionSubject is resolved LIVE from the user record — the token
    // itself stores no permissions.
    expect(p.permissionSubject).toEqual({
      subjectId: 'u-1',
      roleBindings: [{ roleId: 'sso-admin' }],
      instanceAdmin: false,
    });
  });

  it('resolves an owner with NO user record to an empty-bindings permissionSubject (never instanceAdmin)', () => {
    const token = 'tok-norecord';
    const ownerSubject: PrincipalSubject = { userId: 'svc-9', kind: 'service', issuer: 'local' };
    createCredential(dataDir, mkRecord({ id: 'c-nr', keyHash: hashToken(token), ownerSubject }));

    const p = authenticate(dataDir, token);
    expect(p.authenticated).toBe(true);
    expect(p.permissionSubject).toEqual({ subjectId: 'svc-9', roleBindings: [], instanceAdmin: false });
  });

  it('rejects a token whose owner user record is DEACTIVATED (suspension revokes access live)', () => {
    const token = 'tok-deact';
    const ownerSubject: PrincipalSubject = { userId: 'u-gone', kind: 'human', issuer: 'local' };
    upsertUser(dataDir, {
      id: 'u-gone',
      subject: ownerSubject,
      status: 'suspended',
      roleBindings: [],
      createdAt: new Date().toISOString(),
    });
    createCredential(dataDir, mkRecord({ id: 'c-deact', keyHash: hashToken(token), ownerSubject }));

    expect(authenticate(dataDir, token).authenticated).toBe(false);
    expect(authenticateCredential(dataDir, token).authenticated).toBe(false);
  });

  it('a legacy literal builtin subject id never resolves instanceAdmin (the persisted UUIDs are the live ids)', () => {
    ensureInstanceIdentity(dataDir);
    const token = 'tok-legacy-builtin';
    const ownerSubject: PrincipalSubject = { userId: 'builtin:superadmin', kind: 'human', issuer: 'local' };
    createCredential(dataDir, mkRecord({ id: 'c-lb', keyHash: hashToken(token), ownerSubject }));

    const p = authenticate(dataDir, token);
    expect(p.authenticated).toBe(true);
    expect(p.permissionSubject?.instanceAdmin).toBe(false);
  });

  // ── authenticate: expiry / revocation ────────────────────────────────────

  it('rejects an expired record', () => {
    const token = 'tok-exp';
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    createCredential(dataDir, mkRecord({ id: 'c-exp', keyHash: hashToken(token), expiresAt }));

    expect(authenticate(dataDir, token).authenticated).toBe(false);
  });

  it('accepts a record whose expiresAt is still in the future', () => {
    const token = 'tok-future';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    createCredential(dataDir, mkRecord({ id: 'c-fut', keyHash: hashToken(token), expiresAt }));

    expect(authenticate(dataDir, token).authenticated).toBe(true);
  });

  it('rejects a revoked record', () => {
    const token = 'tok-rev';
    createCredential(dataDir, mkRecord({ id: 'c-rev', keyHash: hashToken(token), revokedAt: '2026-07-05T00:00:00.000Z' }));

    expect(authenticate(dataDir, token).authenticated).toBe(false);
  });

  it('rejects an unknown token and a null token', () => {
    expect(authenticate(dataDir, 'no-such-token').authenticated).toBe(false);
    expect(authenticate(dataDir, null).authenticated).toBe(false);
  });

  // ── display projection: role/projects are display-only, never authority ────

  it('keeps the record role/projects as a DISPLAY projection on the Principal', () => {
    const token = 'tok-display';
    createCredential(
      dataDir,
      mkRecord({ id: 'c-disp', keyHash: hashToken(token), role: 'editor', projects: ['proj-a', 'proj-b'] }),
    );

    const p = authenticate(dataDir, token);
    expect({ tokenId: p.tokenId, role: p.role, projects: p.projects, authenticated: p.authenticated }).toEqual({
      tokenId: 'c-disp',
      role: 'editor',
      projects: ['proj-a', 'proj-b'],
      authenticated: true,
    });
    expect(p.subject).toBeUndefined();
  });

  // ── authenticateCredential: dual-credential entry point ───────────────────

  it('accepts the master credential and returns the bootstrap admin principal (instanceAdmin bypass)', () => {
    const p = authenticateCredential(dataDir, MASTER);
    expect(p.authenticated).toBe(true);
    expect(p.role).toBe('admin');
    expect(p.projects).toEqual(['*']);
    expect(p.subject?.kind).toBe('bootstrap');
    expect(p.subject?.userId).toBe('bootstrap');
    expect(p.permissionSubject).toEqual({ subjectId: 'bootstrap', roleBindings: [], instanceAdmin: true });
  });

  it('accepts a valid bearer token via authenticateCredential (same as authenticate)', () => {
    const token = 'tok-dual';
    const ownerSubject: PrincipalSubject = { userId: 'u-2', kind: 'service', issuer: 'local' };
    createCredential(dataDir, mkRecord({ id: 'c-dual', keyHash: hashToken(token), ownerSubject }));

    expect(authenticateCredential(dataDir, token)).toEqual(authenticate(dataDir, token));
  });

  it('rejects an unknown credential and an expired token via authenticateCredential', () => {
    const token = 'tok-dual-exp';
    createCredential(
      dataDir,
      mkRecord({ id: 'c-dual-exp', keyHash: hashToken(token), expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );

    expect(authenticateCredential(dataDir, 'garbage').authenticated).toBe(false);
    expect(authenticateCredential(dataDir, token).authenticated).toBe(false);
  });

  it('does not treat the master credential as an admin token via authenticate', () => {
    // authenticate is the data-plane path: the master credential is not a stored
    // bearer token, so it must not authenticate there.
    expect(authenticate(dataDir, MASTER).authenticated).toBe(false);
  });

  // ── authenticateMaster ─────────────────────────────────────────────────────

  it('authenticateMaster returns the bootstrap admin principal with the resolver bypass', () => {
    const p = authenticateMaster(MASTER);
    expect(p.authenticated).toBe(true);
    expect(p.role).toBe('admin');
    expect(p.projects).toEqual(['*']);
    expect(p.tokenId).toBe('admin:master');
    expect(p.permissionSubject?.instanceAdmin).toBe(true);
    expect(authenticateMaster('wrong').authenticated).toBe(false);
  });

  // ── web-session bridge: authenticateSession + session-id credential ───────
  //
  // A browser session id (reserved prefix) is a first-class credential: it
  // resolves to the same Principal shape a bearer token yields, so every scoped
  // endpoint authenticates a session with no per-endpoint change. Both
  // authenticateSession and the session branch of authenticateCredential share the
  // one resolveSessionPrincipal code path. Sessions store NO permissions.

  const SESSION_SUBJECT: PrincipalSubject = { userId: 'u-web', kind: 'human', issuer: 'oidc', displayName: 'Web User' };

  function seedSession(over: Partial<WebSession> = {}): WebSession {
    return createWebSession(dataDir, {
      id: '', // the registry mints a reserved-prefix id
      subject: SESSION_SUBJECT,
      projects: ['proj-a'],
      createdAt: '1999-01-01T00:00:00.000Z',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...over,
    });
  }

  it('authenticateSession resolves a live session to a Principal with its subject and live permissionSubject', () => {
    const s = seedSession();
    const p = authenticateSession(dataDir, s.id);
    expect(p.authenticated).toBe(true);
    expect(p.subject).toEqual(SESSION_SUBJECT);
    expect(p.permissionSubject).toEqual({ subjectId: 'u-web', roleBindings: [], instanceAdmin: false });
    // coarse compatibility projection: a non-admin keeps the session narrowing.
    expect(p.role).toBe('editor');
    expect(p.projects).toEqual(['proj-a']);
  });

  it('a session bound to the persisted built-in super-admin UUID projects the admin display role', () => {
    const identity = ensureInstanceIdentity(dataDir);
    const s = seedSession({
      subject: { userId: identity.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
    });
    const p = authenticateSession(dataDir, s.id);
    expect(p.permissionSubject?.instanceAdmin).toBe(true);
    expect(p.role).toBe('admin');
    expect(p.projects).toEqual(['*']);
  });

  it('authenticateCredential resolves a valid session id identically to authenticateSession', () => {
    const s = seedSession();
    const viaCredential = authenticateCredential(dataDir, s.id);
    expect(viaCredential.authenticated).toBe(true);
    expect(viaCredential.subject).toEqual(SESSION_SUBJECT);
    // one shared code path → the two entry points return the same Principal
    expect(viaCredential).toEqual(authenticateSession(dataDir, s.id));
  });

  it('rejects an expired session as unauthenticated via both entry points', () => {
    const s = seedSession({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(authenticateSession(dataDir, s.id).authenticated).toBe(false);
    expect(authenticateCredential(dataDir, s.id).authenticated).toBe(false);
  });

  it('rejects an absent (well-formed) session id as unauthenticated via both entry points', () => {
    const ghost = `${WEB_SESSION_PREFIX}deadbeefdeadbeef`;
    expect(authenticateSession(dataDir, ghost).authenticated).toBe(false);
    expect(authenticateCredential(dataDir, ghost).authenticated).toBe(false);
  });

  it('rejects a DEACTIVATED session user as unauthenticated', () => {
    upsertUser(dataDir, {
      id: 'u-web',
      subject: SESSION_SUBJECT,
      status: 'deactivated',
      roleBindings: [],
      createdAt: new Date().toISOString(),
    });
    const s = seedSession();
    expect(authenticateSession(dataDir, s.id).authenticated).toBe(false);
  });

  it('does not treat a bearer token as a session (authenticateSession accepts session ids only)', () => {
    const token = 'tok-not-a-session';
    createCredential(dataDir, mkRecord({ id: 'c-web', keyHash: hashToken(token) }));
    // the token authenticates on the bearer path …
    expect(authenticate(dataDir, token).authenticated).toBe(true);
    // … but must not resolve as a session
    expect(authenticateSession(dataDir, token).authenticated).toBe(false);
  });

  // ── regressions: the pre-existing credential kinds still authenticate ──────

  it('a bearer token still authenticates through authenticateCredential unchanged (regression)', () => {
    const token = 'tok-bridge-regression';
    const ownerSubject: PrincipalSubject = { userId: 'u-3', kind: 'human', issuer: 'local' };
    createCredential(dataDir, mkRecord({ id: 'c-bridge', keyHash: hashToken(token), ownerSubject }));
    expect(authenticateCredential(dataDir, token)).toEqual(authenticate(dataDir, token));
    expect(authenticateCredential(dataDir, token).authenticated).toBe(true);
  });

  it('the master credential still authenticates through authenticateCredential unchanged (regression)', () => {
    const p = authenticateCredential(dataDir, MASTER);
    expect(p.authenticated).toBe(true);
    expect(p.role).toBe('admin');
    expect(p.projects).toEqual(['*']);
    expect(p.subject?.kind).toBe('bootstrap');
  });
});
