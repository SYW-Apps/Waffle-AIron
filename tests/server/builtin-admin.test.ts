import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setSecret } from '../../src/utils/secrets.js';
import {
  startSignIn,
  completeSignIn,
  signInWithPassword,
  getCurrentContext,
  serveApp,
  __resetLoginThrottle,
} from '../../src/server/web.js';
import { authenticateSession, verifyBuiltinAdmin, BUILTIN_SUPERADMIN_USER_ID } from '../../src/server/auth.js';
import * as identity from '../../src/server/identity.js';
import { ForbiddenError, UnauthenticatedError } from '../../src/server/identity.js';
import { upsertIdentityProviderRecord } from '../../src/server/policy.js';
import { findUserByExternalSubject, upsertUser as repoUpsertUser, getUserById } from '../../src/server/users.js';
import { getWebSessionById, createWebSession } from '../../src/server/websessions.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { hashToken, findByTokenHash } from '../../src/server/credentials.js';
import { queryAuditEvents as auditQuery } from '../../src/server/audit.js';
import { routeData } from '../../src/server/http.js';
import type {
  HostConfig,
  HostedUserRecord,
  IdentityProviderConfig,
  ProjectGrant,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Crown-jewel auth (sdd_host): the three identity tiers.
//
// 1. Built-in super-admin: WAIRON_ADMIN_USER/_PASSWORD → a web password login
//    minting the ONLY instance-wide *:* session (constant-time verification,
//    disabled when either env value is unset, transient failed-attempt throttle).
// 2. SSO admin: provider adminGroupClaims → the ENUMERATED instance-wide bundle
//    {*, [user:admin, project:create, audit:read]} — never *:*.
// 3. SSO user: empty grants until an admin assigns.
//
// Plus the *:* HARD RESERVATION: no user-record grant and no minted user token
// may ever carry {projectId '*', no orgUnitId, permissions ⊇ '*'} — rejected
// unconditionally, even for a super-admin/master caller.
//
// The OIDC stub provider mirrors web.test.ts / identity-sso.test.ts.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SECRET_REF = 'oidc-client-secret';
const SECRET_VALUE = 'super-secret-value';
const PROVIDER_ID = 'authentik-corp';
const CLIENT_ID = 'test-client';
const ADMIN_GROUP = 'wairon-admins';

const ADMIN_USER = 'root-operator';
const ADMIN_PASSWORD = 'a-very-strong-builtin-password';

const SSO_ADMIN_BUNDLE: ProjectGrant = {
  projectId: '*',
  permissions: ['user:admin', 'project:create', 'audit:read'],
};
const RESERVED: ProjectGrant = { projectId: '*', permissions: ['*'] };

// A real RSA signing key; its public half is published in the stub JWKS so the
// adapter verifies the RS256-signed id_tokens end-to-end during sign-in.
const { publicKey: SIGN_PUB, privateKey: SIGN_PRIV } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const JWK = { ...(SIGN_PUB.export({ format: 'jwk' }) as crypto.JsonWebKey), kid: KID, use: 'sig', alg: 'RS256' };

let tokenResponse: () => { status: number; json: unknown } = () => ({ status: 200, json: {} });
let oidcServer: http.Server;
let issuerUrl: string;

beforeAll(async () => {
  oidcServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', issuerUrl);
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: issuerUrl,
            authorization_endpoint: `${issuerUrl}/authorize`,
            token_endpoint: `${issuerUrl}/token`,
            jwks_uri: `${issuerUrl}/jwks`,
            userinfo_endpoint: `${issuerUrl}/userinfo`,
          }),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [JWK] }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const r = tokenResponse();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.json));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => oidcServer.listen(0, '127.0.0.1', resolve));
  issuerUrl = `http://127.0.0.1:${(oidcServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => oidcServer.close(() => resolve()));
});

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
function signIdToken(claims: Record<string, unknown>): string {
  const input = `${b64url({ alg: 'RS256', typ: 'JWT', kid: KID })}.${b64url(claims)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), SIGN_PRIV).toString('base64url');
  return `${input}.${sig}`;
}
function stubClaims(claims: Record<string, unknown>): void {
  const full = { aud: CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 3600, ...claims };
  tokenResponse = () => ({
    status: 200,
    json: { access_token: 'ACCESS', id_token: signIdToken(full), token_type: 'Bearer' },
  });
}
function providerConfig(over: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig {
  return {
    id: PROVIDER_ID,
    providerType: 'oidc',
    issuerUrl,
    clientId: CLIENT_ID,
    clientSecretRef: SECRET_REF,
    enabled: true,
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...over,
  };
}
function stateFrom(authUrl: string): string {
  return new URL(authUrl).searchParams.get('state') ?? '';
}

/** Run the WEB SSO sign-in round-trip and return the new session id. */
async function webLogin(cfg: HostConfig): Promise<string> {
  const started = await startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb');
  return completeSignIn(cfg, stateFrom(started.url), 'auth-code', started.nonce);
}

// ── Tier 1: built-in super-admin password login ───────────────────────────────

describe('built-in super-admin password login (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-builtin-login-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    __resetLoginThrottle();
    cfg = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
      builtinAdminUser: ADMIN_USER,
      builtinAdminPassword: ADMIN_PASSWORD,
    };
  });
  afterEach(() => {
    __resetLoginThrottle();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('verifyBuiltinAdmin: full match → the stable subject; any mismatch or unset env → null', () => {
    expect(verifyBuiltinAdmin(cfg, ADMIN_USER, ADMIN_PASSWORD)).toEqual({
      userId: BUILTIN_SUPERADMIN_USER_ID,
      kind: 'human',
      issuer: 'local',
    });
    expect(verifyBuiltinAdmin(cfg, ADMIN_USER, 'wrong')).toBeNull();
    expect(verifyBuiltinAdmin(cfg, 'wrong', ADMIN_PASSWORD)).toBeNull();
    expect(verifyBuiltinAdmin(cfg, '', '')).toBeNull();

    const disabled: HostConfig = { ...cfg, builtinAdminUser: undefined, builtinAdminPassword: undefined };
    expect(verifyBuiltinAdmin(disabled, ADMIN_USER, ADMIN_PASSWORD)).toBeNull();
    // Half-configured is disabled too (BOTH are required).
    expect(verifyBuiltinAdmin({ ...cfg, builtinAdminPassword: undefined }, ADMIN_USER, ADMIN_PASSWORD)).toBeNull();
  });

  it('right creds → a resolvable *:* session; the principal IS instance-admin (security audit)', () => {
    const sessionId = signInWithPassword(cfg, ADMIN_USER, ADMIN_PASSWORD);
    expect(sessionId).toMatch(/^ws_[0-9a-f]+$/);

    const session = getWebSessionById(dataDir, sessionId)!;
    expect(session.subject).toEqual({ userId: BUILTIN_SUPERADMIN_USER_ID, kind: 'human', issuer: 'local' });
    expect(session.grants).toEqual([RESERVED]); // the ONLY *:* in the system

    const principal = authenticateSession(dataDir, sessionId);
    expect(principal.authenticated).toBe(true);
    expect(identity.isInstanceAdmin(principal)).toBe(true);
    expect(getCurrentContext(cfg, sessionId).isAdmin).toBe(true);

    // NO hosted user record was created — the built-in admin is not a user record.
    expect(getUserById(dataDir, BUILTIN_SUPERADMIN_USER_ID)).toBeNull();

    const events = auditQuery(dataDir, { action: 'web.signin.password' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
    expect(events[0].actor.userId).toBe(BUILTIN_SUPERADMIN_USER_ID);
  });

  it('wrong password / wrong user → Unauthenticated, and no session is minted', () => {
    expect(() => signInWithPassword(cfg, ADMIN_USER, 'nope')).toThrow(UnauthenticatedError);
    expect(() => signInWithPassword(cfg, 'nope', ADMIN_PASSWORD)).toThrow(UnauthenticatedError);
    expect(auditQuery(dataDir, { action: 'web.signin.password' })).toHaveLength(0);
  });

  it('unset env → password login is DISABLED: even matching strings are rejected', () => {
    const disabled: HostConfig = { ...cfg };
    delete disabled.builtinAdminUser;
    delete disabled.builtinAdminPassword;
    expect(() => signInWithPassword(disabled, ADMIN_USER, ADMIN_PASSWORD)).toThrow(UnauthenticatedError);
  });

  it('throttle: ~5 consecutive failures lock the username out — even the RIGHT password is then rejected', () => {
    for (let i = 0; i < 5; i++) {
      expect(() => signInWithPassword(cfg, ADMIN_USER, 'wrong-' + i)).toThrow(UnauthenticatedError);
    }
    // Locked out: the correct credential is rejected outright.
    expect(() => signInWithPassword(cfg, ADMIN_USER, ADMIN_PASSWORD)).toThrow(UnauthenticatedError);
    // The throttle is transient (in-memory only): resetting it restores login.
    __resetLoginThrottle();
    expect(signInWithPassword(cfg, ADMIN_USER, ADMIN_PASSWORD)).toMatch(/^ws_/);
  });

  it('the login form and /web/login are wired into the served client shell', () => {
    const html = serveApp('/');
    expect(html).toContain('/web/login');
    expect(html).toContain('id="lu"');
    expect(html).toContain('id="lp"');
    expect(html).toContain('type="password"');
    // The login screen is DYNAMIC now: the password form only shows when
    // /web/login-options reports it configured, and SSO renders as one button
    // per ENABLED provider — the old static generic SSO button is gone.
    expect(html).toContain('/web/login-options');
    expect(html).not.toContain('Sign in with SSO');
  });
});

// ── POST /web/login over the real HTTP mount ─────────────────────────────────

describe('POST /web/login HTTP mount (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  function raw(opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-builtin-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    __resetLoginThrottle();
    fs.writeFileSync(
      path.join(dataDir, 'exposure-policy.json'),
      JSON.stringify({ webUiEnabled: true, requireTls: false }),
    );
    cfg = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
      builtinAdminUser: ADMIN_USER,
      builtinAdminPassword: ADMIN_PASSWORD,
    };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    __resetLoginThrottle();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('establishes the session cookie WITHOUT the CSRF header (session-establishing route) and authenticates /web/context as admin', async () => {
    // Deliberately NO X-Wairon-Web header: /web/login establishes a session (no
    // ambient cookie exists to ride), so it is not in the cookie-mutation CSRF set.
    const res = await raw({
      method: 'POST',
      path: '/web/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(200);
    const setCookie = String(res.headers['set-cookie']?.[0] ?? '');
    expect(setCookie).toMatch(/^wairon_session=ws_[0-9a-f]+/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const sessionId = /wairon_session=(ws_[0-9a-f]+)/.exec(setCookie)![1];

    const ctx = await raw({ method: 'GET', path: '/web/context', headers: { cookie: `wairon_session=${sessionId}` } });
    expect(ctx.status).toBe(200);
    const parsed = JSON.parse(ctx.body);
    expect(parsed.subject.userId).toBe(BUILTIN_SUPERADMIN_USER_ID);
    expect(parsed.isAdmin).toBe(true);
  }, 20_000);

  it('an invalid credential answers 401 with no session cookie', async () => {
    const res = await raw({
      method: 'POST',
      path: '/web/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: ADMIN_USER, password: 'wrong' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  }, 20_000);

  it('is gated on webUiEnabled: 404 when the web UI is off', async () => {
    fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: false }));
    const res = await raw({
      method: 'POST',
      path: '/web/login',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: ADMIN_USER, password: ADMIN_PASSWORD }),
    });
    expect(res.status).toBe(404);
  }, 20_000);
});

// ── Piece 2: the *:* hard reservation ─────────────────────────────────────────

describe('hard reservation: *:* can never land on a user record or minted token (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  const mkUser = (over: Partial<HostedUserRecord> = {}): HostedUserRecord => ({
    id: 'u-1',
    subject: { userId: 'u-1', kind: 'human', issuer: 'local' },
    status: 'active',
    grants: [],
    createdAt: new Date().toISOString(),
    ...over,
  });

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reserve-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('isSuperAdminGrant matches exactly the reserved shape', () => {
    expect(identity.isSuperAdminGrant(RESERVED)).toBe(true);
    expect(identity.isSuperAdminGrant({ projectId: '*', permissions: ['mcp:read', '*'] })).toBe(true);
    // Enumerated instance-wide bundle → NOT reserved.
    expect(identity.isSuperAdminGrant(SSO_ADMIN_BUNDLE)).toBe(false);
    // Unit-scoped '*' is bounded to its subtree → NOT reserved.
    expect(identity.isSuperAdminGrant({ projectId: '*', permissions: ['*'], orgUnitId: 'unit-1' })).toBe(false);
    // Project-scoped wildcard permissions → NOT reserved.
    expect(identity.isSuperAdminGrant({ projectId: 'proj-a', permissions: ['*'] })).toBe(false);
  });

  it('replaceUserGrants rejects *:* EVEN for master and for a *:* super-admin session', () => {
    repoUpsertUser(dataDir, mkUser());

    expect(() => identity.replaceUserGrants(cfg, MASTER, 'u-1', [RESERVED])).toThrow(ForbiddenError);
    expect(() => identity.replaceUserGrants(cfg, MASTER, 'u-1', [RESERVED])).toThrow(/reserved to the built-in admin/i);

    // A super-admin *:* SESSION (the built-in admin's own shape) is refused too.
    const admin = createWebSession(dataDir, {
      id: '',
      subject: { userId: BUILTIN_SUPERADMIN_USER_ID, kind: 'human', issuer: 'local' },
      grants: [RESERVED],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(() => identity.replaceUserGrants(cfg, admin.id, 'u-1', [RESERVED])).toThrow(ForbiddenError);

    // The record was never touched.
    expect(getUserById(dataDir, 'u-1')!.grants).toEqual([]);
  });

  it('replaceUserGrants still allows an enumerated instance-wide bundle and scoped grants (as master)', () => {
    repoUpsertUser(dataDir, mkUser());
    expect(identity.replaceUserGrants(cfg, MASTER, 'u-1', [SSO_ADMIN_BUNDLE]).grants).toEqual([SSO_ADMIN_BUNDLE]);
    const scoped: ProjectGrant = { projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'] };
    expect(identity.replaceUserGrants(cfg, MASTER, 'u-1', [scoped]).grants).toEqual([scoped]);
  });

  it('upsertUser rejects a record carrying *:*, even as master', () => {
    expect(() => identity.upsertUser(cfg, MASTER, mkUser({ grants: [RESERVED] }))).toThrow(ForbiddenError);
    expect(getUserById(dataDir, 'u-1')).toBeNull(); // nothing stored

    // A record with the enumerated bundle (or none) is fine.
    expect(identity.upsertUser(cfg, MASTER, mkUser({ grants: [SSO_ADMIN_BUNDLE] })).grants).toEqual([SSO_ADMIN_BUNDLE]);
  });

  it('mintToken rejects a *:* delegation EVEN for master; the enumerated bundle mints fine', () => {
    createProjectRecord(dataDir, 'proj-a');

    expect(() =>
      identity.mintToken(cfg, MASTER, { ownerUserId: 'svc-1', label: 't', grants: [RESERVED] }),
    ).toThrow(/reserved to the built-in admin/i);

    const bundleToken = identity.mintToken(cfg, MASTER, {
      ownerUserId: 'svc-1',
      label: 't',
      grants: [SSO_ADMIN_BUNDLE],
    });
    expect(bundleToken).toMatch(/^wk_/);
    expect(findByTokenHash(dataDir, hashToken(bundleToken))!.grants).toEqual([SSO_ADMIN_BUNDLE]);

    const scopedToken = identity.mintToken(cfg, MASTER, {
      ownerUserId: 'svc-1',
      label: 't',
      grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
    });
    expect(scopedToken).toMatch(/^wk_/);
  });
});

// ── Tiers 2 + 3: adminGroupClaims → the enumerated SSO-admin bundle ──────────

describe('adminGroupClaims → SSO-admin bundle provisioning (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const USER_ID = `sso:${PROVIDER_ID}:ext-1`;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-groups-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    setSecret(SECRET_REF, SECRET_VALUE);
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

  it('web sign-in with a matching group provisions the ENUMERATED bundle — isAdmin stays FALSE, no *:*', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP, 'devs'] });

    const sessionId = await webLogin(cfg);

    // The user record carries EXACTLY the enumerated bundle — not *:*.
    const user = findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!;
    expect(user.grants).toEqual([SSO_ADMIN_BUNDLE]);

    // The session carries the bundle; the principal is NOT instance-admin.
    const session = getWebSessionById(dataDir, sessionId)!;
    expect(session.grants).toEqual([SSO_ADMIN_BUNDLE]);
    const principal = authenticateSession(dataDir, sessionId);
    expect(identity.isInstanceAdmin(principal)).toBe(false);
    expect(session.grants.some((g) => identity.isSuperAdminGrant(g))).toBe(false);
    // The UI affordance flag (WebContext.isAdmin = any instance-wide grant) shows
    // the Admin tab for the delegated SSO admin — but the SECURITY boundary is
    // isInstanceAdmin (requires the '*' permission), which is false above: the
    // instance-admin-only surfaces (IdP/org config) still refuse this session.
    expect(getCurrentContext(cfg, sessionId).isAdmin).toBe(true);
    expect(() => identity.listIdentityProviders(cfg, sessionId)).toThrow(ForbiddenError);
  });

  it('web sign-in with no matching group stays empty-grants (tier 3)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: ['devs'] });

    const sessionId = await webLogin(cfg);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.grants).toEqual([]);
    expect(getWebSessionById(dataDir, sessionId)!.grants).toEqual([]);
  });

  it('unset adminGroupClaims never matches — groups alone confer nothing', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig()); // no adminGroupClaims
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP] });

    await webLogin(cfg);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.grants).toEqual([]);
  });

  it('a follow-on login after removal from the group DROPS the bundle; other grants survive', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));

    // Login 1: in the group → bundle.
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP] });
    await webLogin(cfg);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.grants).toEqual([SSO_ADMIN_BUNDLE]);

    // An admin additionally hands the user a scoped grant in between.
    const scoped: ProjectGrant = { projectId: 'proj-a', permissions: ['mcp:read'] };
    createProjectRecord(dataDir, 'proj-a');
    identity.replaceUserGrants(cfg, MASTER, USER_ID, [SSO_ADMIN_BUNDLE, scoped]);

    // Login 2: dropped from the group → the bundle goes, the scoped grant stays.
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: ['devs'] });
    const session2 = await webLogin(cfg);
    const after = findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!;
    expect(after.grants).toEqual([scoped]);
    expect(getWebSessionById(dataDir, session2)!.grants).toEqual([scoped]);
  });

  it('headless completeSsoLogin provisions/refreshes the bundle identically (token path)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));

    // In the group → token + record carry the bundle (never *:*).
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP] });
    const url1 = await identity.startSsoLogin(cfg, PROVIDER_ID, 'https://cli.example/cb');
    const token1 = await identity.completeSsoLogin(cfg, stateFrom(url1), 'code-1');
    const rec1 = findByTokenHash(dataDir, hashToken(token1))!;
    expect(rec1.grants).toEqual([SSO_ADMIN_BUNDLE]);
    expect(rec1.grants!.some((g) => identity.isSuperAdminGrant(g))).toBe(false);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.grants).toEqual([SSO_ADMIN_BUNDLE]);

    // Dropped from the group → the next login's token carries no bundle.
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [] });
    const url2 = await identity.startSsoLogin(cfg, PROVIDER_ID, 'https://cli.example/cb');
    const token2 = await identity.completeSsoLogin(cfg, stateFrom(url2), 'code-2');
    expect(findByTokenHash(dataDir, hashToken(token2))!.grants).toEqual([]);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.grants).toEqual([]);
  });

  it('REINFORCE: no SSO path can ever yield *:* — even a legacy record carrying it is filtered at mint', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));

    // A legacy user record that (through the repository, predating the orchestrator
    // guard) carries the reserved grant plus a scoped one.
    const scoped: ProjectGrant = { projectId: 'proj-a', permissions: ['mcp:read'] };
    repoUpsertUser(dataDir, {
      id: USER_ID,
      subject: { userId: USER_ID, kind: 'human', issuer: PROVIDER_ID, externalSubject: 'ext-1' },
      status: 'active',
      grants: [RESERVED, scoped],
      createdAt: new Date().toISOString(),
    });

    // Web session: the reserved grant is filtered out of the minted session.
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: ['devs'] });
    const sessionId = await webLogin(cfg);
    const session = getWebSessionById(dataDir, sessionId)!;
    expect(session.grants).toEqual([scoped]);
    expect(identity.isInstanceAdmin(authenticateSession(dataDir, sessionId))).toBe(false);

    // Headless token: the reserved grant is filtered out of the minted credential.
    const url = await identity.startSsoLogin(cfg, PROVIDER_ID, 'https://cli.example/cb');
    const token = await identity.completeSsoLogin(cfg, stateFrom(url), 'code');
    const rec = findByTokenHash(dataDir, hashToken(token))!;
    expect(rec.grants).toEqual([scoped]);
    expect(rec.role).toBe('editor'); // the compatibility projection follows the filtered grants
  });
});
