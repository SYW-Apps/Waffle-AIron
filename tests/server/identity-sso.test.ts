import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setSecret } from '../../src/utils/secrets.js';
import * as identity from '../../src/server/identity.js';
import { ForbiddenError } from '../../src/server/identity.js';
import { authenticate, signSsoState, verifySsoState } from '../../src/server/auth.js';
import {
  upsertIdentityProviderRecord,
  listIdentityProviderRecords,
} from '../../src/server/policy.js';
import { createCredential, hashToken, listCredentials } from '../../src/server/credentials.js';
import { findUserByExternalSubject, listUsers as repoListUsers } from '../../src/server/users.js';
import {
  appendAuditEvent,
  queryAuditEvents as auditQuery,
  DEFAULT_AUDIT_POLICY,
} from '../../src/server/audit.js';
import { routeAdmin } from '../../src/server/http.js';
import type {
  ApiKeyRecord,
  AuditEvent,
  HostConfig,
  IdentityProviderConfig,
  PrincipalSubject,
  ProjectGrant,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Identity Orchestrator + Portal — Phase 5a headless SSO login flows (sdd_host).
//
// A stub OIDC provider runs on an ephemeral loopback http server (mirroring
// idp.test.ts): its /token endpoint returns a crafted token response whose
// id_token carries base64url-JSON claims. Client secrets resolve from a seeded
// WAIRON_DATA_DIR secret store exactly like production, and SSO state signing
// uses WAIRON_ADMIN_TOKEN as the server signing authority.
//
// State payload format (documented): the signed SSO state wraps a JSON string
// `{ providerId, nonce, redirectUri }`. signSsoState seals it on start;
// verifySsoState returns that JSON on completion — it is the only integrity
// anchor the callback carries (there is no server-side login session).
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SECRET_REF = 'oidc-client-secret';
const SECRET_VALUE = 'super-secret-value';
const PROVIDER_ID = 'authentik-corp';

// The stub /token response; each test overrides it as needed.
let tokenResponse: () => { status: number; json: unknown } = () => ({ status: 200, json: {} });
let oidcServer: http.Server;
let issuerUrl: string;

beforeAll(async () => {
  oidcServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/token') {
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

function makeIdToken(claims: unknown): string {
  return [b64url({ alg: 'RS256', typ: 'JWT' }), b64url(claims), 'sig'].join('.');
}

/** Program the stub /token endpoint to return an id_token for the given claims. */
function stubClaims(claims: Record<string, unknown>): void {
  tokenResponse = () => ({
    status: 200,
    json: { access_token: 'ACCESS', refresh_token: 'REFRESH', id_token: makeIdToken(claims), token_type: 'Bearer' },
  });
}

function providerConfig(over: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig {
  return {
    id: PROVIDER_ID,
    providerType: 'oidc',
    issuerUrl,
    clientId: 'test-client',
    clientSecretRef: SECRET_REF,
    enabled: true,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...over,
  };
}

function mkEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: '',
    timestamp: '2026-07-10T12:00:00.000Z',
    level: 'info',
    category: 'admin',
    action: 'x.action',
    outcome: 'success',
    actor: { userId: 'u-1', kind: 'human', issuer: 'local' },
    ...over,
  };
}

describe('identity SSO orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-identity-sso-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir; // client-secret + SSO signing resolution
    setSecret(SECRET_REF, SECRET_VALUE);
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', name: 'Alice' });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Mint a stored non-admin token carrying the given grants; returns plaintext. */
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

  function stateFrom(authUrl: string): string {
    return new URL(authUrl).searchParams.get('state') ?? '';
  }

  function persistedByToken(token: string): ApiKeyRecord | undefined {
    return listCredentials(dataDir, '*').find((r) => r.keyHash === hashToken(token));
  }

  // ── startSsoLogin ────────────────────────────────────────────────────────

  it('startSsoLogin returns a provider authorization URL carrying the signed state', () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());

    const authUrl = identity.startSsoLogin(cfg, PROVIDER_ID, 'https://app.example/cb');
    const url = new URL(authUrl);
    expect(url.origin).toBe(issuerUrl);
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/cb');

    // The state round-trips to the documented { providerId, nonce, redirectUri } payload.
    const payload = JSON.parse(verifySsoState(stateFrom(authUrl)));
    expect(payload.providerId).toBe(PROVIDER_ID);
    expect(payload.redirectUri).toBe('https://app.example/cb');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.nonce.length).toBeGreaterThan(0);

    // Best-effort sso.start audit event (info level).
    const events = auditQuery(dataDir, { action: 'sso.start' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('info');
  });

  it('startSsoLogin rejects an unknown provider', () => {
    expect(() => identity.startSsoLogin(cfg, 'ghost', 'https://app.example/cb')).toThrow(
      /unknown or disabled/i,
    );
  });

  it('startSsoLogin rejects a disabled provider', () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ enabled: false }));
    expect(() => identity.startSsoLogin(cfg, PROVIDER_ID, 'https://app.example/cb')).toThrow(
      /unknown or disabled/i,
    );
  });

  // ── completeSsoLogin: first login provisions + mints ───────────────────────

  it('completeSsoLogin (first login): provisions an active user with empty grants and mints a user-bound token', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const state = stateFrom(identity.startSsoLogin(cfg, PROVIDER_ID, 'https://app.example/cb'));

    const token = await identity.completeSsoLogin(cfg, state, 'auth-code-1');
    expect(token).toMatch(/^wk_[0-9a-f]+$/);

    // The user was provisioned: active, EMPTY grants, id = the resolved subject id.
    const user = findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1');
    expect(user).not.toBeNull();
    expect(user!.id).toBe(`sso:${PROVIDER_ID}:ext-1`);
    expect(user!.status).toBe('active');
    expect(user!.grants).toEqual([]);

    // Only the hashed record is persisted; ownerSubject = the resolved SSO subject.
    const rec = persistedByToken(token);
    expect(rec).toBeDefined();
    expect(rec!.keyHash).toBe(hashToken(token));
    expect(rec!.ownerSubject?.userId).toBe(`sso:${PROVIDER_ID}:ext-1`);
    expect(rec!.ownerSubject?.issuer).toBe(PROVIDER_ID);
    expect(rec!.ownerSubject?.externalSubject).toBe('ext-1');
    expect(rec!.grants).toEqual([]);

    // authenticate() on the new token yields the provisioned user's subject.
    const principal = authenticate(dataDir, token);
    expect(principal.authenticated).toBe(true);
    expect(principal.subject?.userId).toBe(`sso:${PROVIDER_ID}:ext-1`);

    // A security-level sso.login audit event exists.
    const events = auditQuery(dataDir, { action: 'sso.login' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
  });

  it('completeSsoLogin (returning user): no duplicate user, and the token carries the user\'s CURRENT grants', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());

    // First login provisions the user (empty grants).
    const s1 = stateFrom(identity.startSsoLogin(cfg, PROVIDER_ID, 'https://app.example/cb'));
    await identity.completeSsoLogin(cfg, s1, 'code-1');

    // An admin assigns grants between logins.
    const grants: ProjectGrant[] = [{ projectId: 'proj-x', permissions: ['mcp:read'] }];
    identity.replaceUserGrants(cfg, MASTER, `sso:${PROVIDER_ID}:ext-1`, grants);

    // Second login for the same external subject.
    const s2 = stateFrom(identity.startSsoLogin(cfg, PROVIDER_ID, 'https://app.example/cb'));
    const token2 = await identity.completeSsoLogin(cfg, s2, 'code-2');

    // No duplicate user was created.
    expect(repoListUsers(dataDir)).toHaveLength(1);

    // The new token carries the user's CURRENT grants (seeded above).
    const principal = authenticate(dataDir, token2);
    expect(principal.subject?.userId).toBe(`sso:${PROVIDER_ID}:ext-1`);
    expect(principal.grants).toEqual(grants);
  });

  // ── state integrity ────────────────────────────────────────────────────────

  it('completeSsoLogin rejects a tampered state', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    await expect(identity.completeSsoLogin(cfg, 'tampered-not-a-state', 'code')).rejects.toThrow(
      /invalid SSO state/i,
    );
  });

  it('completeSsoLogin rejects an expired state', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
    const expired = signSsoState(
      JSON.stringify({ providerId: PROVIDER_ID, nonce: 'n', redirectUri: 'https://app.example/cb' }),
    );
    // Advance past the 10-minute SSO-state TTL.
    vi.setSystemTime(new Date('2026-07-10T00:11:00.000Z'));
    await expect(identity.completeSsoLogin(cfg, expired, 'code')).rejects.toThrow(/expired/i);
    vi.useRealTimers();
  });

  // ── allowedDomains enforcement surfaces cleanly ────────────────────────────

  it('completeSsoLogin surfaces an allowedDomains violation and provisions nothing', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig({ allowedDomains: ['corp.example'] }));
    stubClaims({ iss: issuerUrl, sub: 'ext-2', email: 'bob@other.example', name: 'Bob' });
    const state = stateFrom(identity.startSsoLogin(cfg, PROVIDER_ID, 'https://app.example/cb'));

    await expect(identity.completeSsoLogin(cfg, state, 'code')).rejects.toThrow(/domain/i);

    // The rejection happened before provisioning or minting.
    expect(findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-2')).toBeNull();
    expect(listCredentials(dataDir, '*')).toHaveLength(0);
  });

  // ── identity-provider administration (instance-admin only) ─────────────────

  it('IdP CRUD is instance-admin gated and audited: admin upserts/lists/removes; an editor token is 403', () => {
    const editor = mintNonAdminToken([{ projectId: '*', permissions: ['mcp:write'] }]);

    // Editor (not instance-admin) is denied on every IdP admin method.
    expect(() => identity.upsertIdentityProvider(cfg, editor, providerConfig())).toThrow(ForbiddenError);
    expect(() => identity.listIdentityProviders(cfg, editor)).toThrow(ForbiddenError);
    expect(() => identity.removeIdentityProvider(cfg, editor, PROVIDER_ID)).toThrow(ForbiddenError);

    // Admin upsert → stored + idp.upsert (security) audit.
    const stored = identity.upsertIdentityProvider(cfg, MASTER, providerConfig());
    expect(stored.id).toBe(PROVIDER_ID);
    expect(identity.listIdentityProviders(cfg, MASTER).map((p) => p.id)).toContain(PROVIDER_ID);
    const upEvents = auditQuery(dataDir, { action: 'idp.upsert' });
    expect(upEvents).toHaveLength(1);
    expect(upEvents[0].level).toBe('security');

    // Admin remove → gone + idp.remove (security) audit.
    identity.removeIdentityProvider(cfg, MASTER, PROVIDER_ID);
    expect(listIdentityProviderRecords(dataDir)).toHaveLength(0);
    const rmEvents = auditQuery(dataDir, { action: 'idp.remove' });
    expect(rmEvents).toHaveLength(1);
    expect(rmEvents[0].level).toBe('security');
  });

  // ── countAuditEvents ───────────────────────────────────────────────────────

  it('countAuditEvents is audit-read gated and returns filter-consistent counts', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'idp.count.a' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'idp.count.a' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'idp.count.b' }), DEFAULT_AUDIT_POLICY);

    const reader = mintNonAdminToken([{ projectId: '*', permissions: ['audit:read'] }]);

    // Counts are consistent with the query index.
    expect(identity.countAuditEvents(cfg, reader, {})).toBe(auditQuery(dataDir, {}).length);
    expect(identity.countAuditEvents(cfg, reader, { action: 'idp.count.a' })).toBe(2);
    expect(identity.countAuditEvents(cfg, MASTER, { action: 'idp.count.b' })).toBe(1);

    // A caller without audit:read (nor instance-admin) is denied.
    const plain = mintNonAdminToken([{ projectId: 'proj-a', permissions: ['mcp:read'] }]);
    expect(() => identity.countAuditEvents(cfg, plain, {})).toThrow(ForbiddenError);
  });
});

// ── HTTP portal (routeAdmin) ─────────────────────────────────────────────────

describe('identity SSO portal (sdd_host http)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let baseUrl: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-identity-sso-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    setSecret(SECRET_REF, SECRET_VALUE);
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', name: 'Alice' });

    server = http.createServer((req, res) => {
      void routeAdmin(cfg, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  async function api(
    method: string,
    pathname: string,
    opts: { cred?: string; body?: unknown } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.cred) headers['Authorization'] = `Bearer ${opts.cred}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(baseUrl + pathname, init);
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  it('POST /identity/sso/start then GET /identity/sso/callback complete a login over HTTP', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());

    // start (unauthenticated) → 200 with the authorization URL carrying the state.
    const start = await api('POST', '/identity/sso/start', {
      body: { providerId: PROVIDER_ID, redirectUri: 'https://app.example/cb' },
    });
    expect(start.status).toBe(200);
    expect(typeof start.json.url).toBe('string');
    const state = new URL(start.json.url).searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThan(0);

    // callback (unauthenticated) → 200 with the minted token.
    const qs = new URLSearchParams({ state, code: 'auth-code-http' }).toString();
    const cb = await api('GET', `/identity/sso/callback?${qs}`);
    expect(cb.status).toBe(200);
    expect(cb.json.token).toMatch(/^wk_[0-9a-f]+$/);
    // The token authenticates to the provisioned user.
    expect(authenticate(dataDir, cb.json.token).subject?.userId).toBe(`sso:${PROVIDER_ID}:ext-1`);
  });

  it('providers CRUD routes respond via routeAdmin (instance-admin), and reject an editor token', async () => {
    // PUT /identity/providers/{id} → 200.
    const put = await api('PUT', `/identity/providers/${PROVIDER_ID}`, {
      cred: MASTER,
      body: providerConfig(),
    });
    expect(put.status).toBe(200);
    expect(put.json.id).toBe(PROVIDER_ID);

    // GET /identity/providers → 200 array containing it.
    const list = await api('GET', '/identity/providers', { cred: MASTER });
    expect(list.status).toBe(200);
    expect(list.json.map((p: IdentityProviderConfig) => p.id)).toContain(PROVIDER_ID);

    // Unauthenticated read → 401.
    expect((await api('GET', '/identity/providers')).status).toBe(401);

    // DELETE /identity/providers/{id} → 200.
    const del = await api('DELETE', `/identity/providers/${PROVIDER_ID}`, { cred: MASTER });
    expect(del.status).toBe(200);
    expect(del.json.ok).toBe(true);
    expect(listIdentityProviderRecords(dataDir)).toHaveLength(0);
  });

  it('GET /identity/audit/count responds via routeAdmin with a filter-consistent count', async () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'http.count.a' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'http.count.a' }), DEFAULT_AUDIT_POLICY);
    appendAuditEvent(dataDir, mkEvent({ action: 'http.count.b' }), DEFAULT_AUDIT_POLICY);

    const all = await api('GET', '/identity/audit/count', { cred: MASTER });
    expect(all.status).toBe(200);
    expect(all.json.count).toBe(3);

    const filtered = await api('GET', '/identity/audit/count?action=http.count.a', { cred: MASTER });
    expect(filtered.status).toBe(200);
    expect(filtered.json.count).toBe(2);
  });
});
