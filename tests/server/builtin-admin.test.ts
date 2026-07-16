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
import { authenticateSession, verifyBuiltinAdmin } from '../../src/server/auth.js';
import * as identity from '../../src/server/identity.js';
import { UnauthenticatedError } from '../../src/server/identity.js';
import { isInstanceAdmin } from '../../src/server/authorization.js';
import { ensureInstanceIdentity, getInstanceIdentity } from '../../src/server/instance.js';
import { SSO_ADMIN_ROLE_ID } from '../../src/server/roles.js';
import { upsertIdentityProviderRecord } from '../../src/server/policy.js';
import { findUserByExternalSubject, getUserById } from '../../src/server/users.js';
import { getWebSessionById } from '../../src/server/websessions.js';
import { hashToken, findByTokenHash } from '../../src/server/credentials.js';
import { queryAuditEvents as auditQuery } from '../../src/server/audit.js';
import { routeData } from '../../src/server/http.js';
import type { HostConfig, IdentityProviderConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Crown-jewel auth (sdd_host): the three identity tiers.
//
// 1. Built-in super-admin: WAIRON_ADMIN_USER/_PASSWORD → a web password login
//    resolving to the PERSISTED boot-reserved super-admin UUID — the only
//    instance-admin session (constant-time verification, disabled when either
//    env value is unset, transient failed-attempt throttle).
// 2. SSO admin: provider adminGroupClaims → the built-in sso-admin ROLE binding
//    (project:admin + project:create @instance, OVERRIDABLE — never the bypass).
// 3. SSO user: no bindings until an admin assigns roles/assignments.
//
// The reserved-subject guard (built-in ids unclaimable) is pinned in
// identity.test.ts / instance.test.ts. The OIDC stub provider mirrors
// web.test.ts / identity-sso.test.ts.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SECRET_REF = 'oidc-client-secret';
const SECRET_VALUE = 'super-secret-value';
const PROVIDER_ID = 'authentik-corp';
const CLIENT_ID = 'test-client';
const ADMIN_GROUP = 'wairon-admins';

const ADMIN_USER = 'root-operator';
const ADMIN_PASSWORD = 'a-very-strong-builtin-password';

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
    ensureInstanceIdentity(dataDir); // the lifecycle init seeds this at boot
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

  it('verifyBuiltinAdmin: full match → the persisted boot-reserved subject; any mismatch or unset env → null', () => {
    expect(verifyBuiltinAdmin(cfg, ADMIN_USER, ADMIN_PASSWORD)).toEqual({
      userId: getInstanceIdentity(dataDir)!.superadminUserId,
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

  it('right creds → a permission-free session whose subject IS the instance-admin (security audit)', () => {
    const builtin = getInstanceIdentity(dataDir)!.superadminUserId;
    const sessionId = signInWithPassword(cfg, ADMIN_USER, ADMIN_PASSWORD);
    expect(sessionId).toMatch(/^ws_[0-9a-f]+$/);

    const session = getWebSessionById(dataDir, sessionId)!;
    expect(session.subject).toEqual({ userId: builtin, kind: 'human', issuer: 'local' });
    expect(session.projects).toEqual(['*']); // narrowing only — NO stored permissions

    const principal = authenticateSession(dataDir, sessionId);
    expect(principal.authenticated).toBe(true);
    expect(isInstanceAdmin(principal)).toBe(true); // by persisted-UUID identity
    expect(getCurrentContext(cfg, sessionId).isAdmin).toBe(true);

    // NO hosted user record was created — the built-in admin is not a user record.
    expect(getUserById(dataDir, builtin)).toBeNull();

    const events = auditQuery(dataDir, { action: 'web.signin.password' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
    expect(events[0].actor.userId).toBe(builtin);
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
    ensureInstanceIdentity(dataDir); // the lifecycle init seeds this at boot
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
    expect(parsed.subject.userId).toBe(getInstanceIdentity(dataDir)!.superadminUserId);
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

// (The old *:* hard-reservation describe is gone with the grant model: the
// modern equivalent — the RESERVED-SUBJECT guard, which keeps the built-in
// identities unclaimable by user records and token owners — is pinned in
// identity.test.ts and instance.test.ts.)

// ── Tiers 2 + 3: adminGroupClaims → the built-in sso-admin ROLE binding ───────

describe('adminGroupClaims → sso-admin role provisioning (sdd_host)', () => {
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

  it('web sign-in with a matching group binds the sso-admin ROLE — never the instance-admin bypass', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP, 'devs'] });

    const sessionId = await webLogin(cfg);

    // The user record carries EXACTLY the built-in role binding — no grants field.
    const user = findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!;
    expect(user.roleBindings).toEqual([{ roleId: SSO_ADMIN_ROLE_ID }]);

    // The session stores NO permissions; the principal is NOT the bypass — but
    // the sso-admin role resolves project:admin@instance LIVE, so the delegated
    // admin CAN reach the instance-level admin surfaces (overridably).
    const session = getWebSessionById(dataDir, sessionId)!;
    expect(session.projects).toEqual(['*']);
    const principal = authenticateSession(dataDir, sessionId);
    expect(isInstanceAdmin(principal)).toBe(false);
    // WebContext.isAdmin = the env-anchored bypass only; delegated admin chrome
    // is driven client-side by their project:admin visible scopes.
    expect(getCurrentContext(cfg, sessionId).isAdmin).toBe(false);
    // The role's resolved instance-level project:admin authorizes IdP reads.
    expect(Array.isArray(identity.listIdentityProviders(cfg, sessionId))).toBe(true);
  });

  it('web sign-in with no matching group stays binding-free (tier 3)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: ['devs'] });

    const sessionId = await webLogin(cfg);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.roleBindings).toEqual([]);
    expect(getWebSessionById(dataDir, sessionId)!.projects).toEqual(['*']);
  });

  it('unset adminGroupClaims never matches — groups alone confer nothing', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig()); // no adminGroupClaims
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP] });

    await webLogin(cfg);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.roleBindings).toEqual([]);
  });

  it('a follow-on login after removal from the group UNBINDS sso-admin; other bindings survive', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));

    // Login 1: in the group → the sso-admin binding.
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP] });
    await webLogin(cfg);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.roleBindings).toEqual([
      { roleId: SSO_ADMIN_ROLE_ID },
    ]);

    // An admin additionally binds a CUSTOM role in between.
    const provisioned = findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!;
    identity.upsertUser(cfg, MASTER, {
      ...provisioned,
      roleBindings: [{ roleId: SSO_ADMIN_ROLE_ID }, { roleId: 'custom-role' }],
    });

    // Login 2: dropped from the group → sso-admin goes, the custom binding stays.
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: ['devs'] });
    await webLogin(cfg);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.roleBindings).toEqual([
      { roleId: 'custom-role' },
    ]);
  });

  it('headless completeSsoLogin provisions/refreshes the binding identically (token path)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ adminGroupClaims: [ADMIN_GROUP] }));

    // In the group → the record carries the binding; the token carries NOTHING
    // (it acts as the owner's live permission).
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [ADMIN_GROUP] });
    const url1 = await identity.startSsoLogin(cfg, PROVIDER_ID, 'https://cli.example/cb');
    const token1 = await identity.completeSsoLogin(cfg, stateFrom(url1), 'code-1');
    const rec1 = findByTokenHash(dataDir, hashToken(token1))!;
    expect(rec1.projects).toEqual(['*']);
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.roleBindings).toEqual([
      { roleId: SSO_ADMIN_ROLE_ID },
    ]);

    // Dropped from the group → the binding is removed on the next login, and the
    // EXISTING token1 loses its admin reach immediately (resolved live).
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', groups: [] });
    const url2 = await identity.startSsoLogin(cfg, PROVIDER_ID, 'https://cli.example/cb');
    await identity.completeSsoLogin(cfg, stateFrom(url2), 'code-2');
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1')!.roleBindings).toEqual([]);
    expect(() => identity.listIdentityProviders(cfg, token1)).toThrow(/project:admin/i);
  });
});
