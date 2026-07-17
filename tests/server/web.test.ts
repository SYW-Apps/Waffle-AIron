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
  signOut,
  signOutEverywhere,
  getCurrentContext,
  getGraph,
  getProjectCanvas,
  getWebProjectCanvasModel,
  serveApp,
  serveLegacyApp,
} from '../../src/server/web.js';
import { allow, seedUnit } from './helpers.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { signSsoState, verifySsoState, authenticate } from '../../src/server/auth.js';
import { ForbiddenError, UnauthenticatedError } from '../../src/server/identity.js';
import * as identity from '../../src/server/identity.js';
import { upsertIdentityProviderRecord } from '../../src/server/policy.js';
import { findUserByExternalSubject, setUserStatus, upsertUser as repoUpsertUser } from '../../src/server/users.js';
import {
  createWebSession,
  getWebSessionById,
  listWebSessionsBySubject,
} from '../../src/server/websessions.js';
import { createProjectRecord, listProjectRecords } from '../../src/server/projects.js';
import * as webproject from '../../src/server/webproject.js';
import { AdminAuthError } from '../../src/server/admin.js';
import { createCredential, hashToken, findByTokenHash } from '../../src/server/credentials.js';
import { queryAuditEvents as auditQuery } from '../../src/server/audit.js';
import { createUnit as createOrgUnit, placeProject, listProjectPlacements } from '../../src/server/organization.js';
import * as webadmin from '../../src/server/webadmin.js';
import { replacePublicSurfaceSnapshot } from '../../src/server/surfaces.js';
import { validateProjectAsComplete } from '../../src/server/adapters.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { provisionProject } from '../../src/core/provision.js';
import {
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { routeData } from '../../src/server/http.js';
import type {
  ApiKeyRecord,
  HostConfig,
  IdentityProviderConfig,
  PrincipalSubject,
  WebSession,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Web Orchestrator + Web Graph Orchestrator + Web Portal (sdd_host) — Phase 7
// wave 3 unified web UI foundation.
//
// The SSO sign-in pair mirrors identity-sso.test.ts's stub OIDC provider; the one
// difference is that sign-in creates a durable WebSession (a first-class credential)
// rather than minting an ApiKeyRecord token. The HTTP mount is driven over a real
// loopback listener wired to routeData so the opt-in gate, the session-cookie auth
// bridge, and the CSRF header rule are exercised end-to-end.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SECRET_REF = 'oidc-client-secret';
const SECRET_VALUE = 'super-secret-value';
const PROVIDER_ID = 'authentik-corp';
const CLIENT_ID = 'test-client';

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
/** RS256-sign an id_token with the stub signing key so it verifies against the JWKS. */
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
    clientId: 'test-client',
    clientSecretRef: SECRET_REF,
    enabled: true,
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...over,
  };
}
function stateFrom(authUrl: string): string {
  return new URL(authUrl).searchParams.get('state') ?? '';
}
/** Run startSignIn and surface the state + nonce for a completeSignIn call. */
function started(started: { url: string; nonce: string }): { state: string; nonce: string } {
  return { state: stateFrom(started.url), nonce: started.nonce };
}

const SUBJECT: PrincipalSubject = { userId: 'u-1', kind: 'human', issuer: 'local', displayName: 'Ada' };

// ── Web orchestrator: SSO sign-in ────────────────────────────────────────────

describe('web orchestrator SSO sign-in (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-web-signin-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
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

  it('startSignIn returns a provider authorization URL for an enabled provider (info audit)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const { url: authUrl } = await startSignIn(cfg, PROVIDER_ID, 'https://app.example/web/sso/callback');
    const url = new URL(authUrl);
    expect(url.origin).toBe(issuerUrl);
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client');

    const payload = JSON.parse(verifySsoState(stateFrom(authUrl)));
    expect(payload.providerId).toBe(PROVIDER_ID);
    expect(payload.redirectUri).toBe('https://app.example/web/sso/callback');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.nonce.length).toBeGreaterThan(0);

    const events = auditQuery(dataDir, { action: 'web.signin.start' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('info');
  });

  it('startSignIn rejects an unknown and a disabled provider', async () => {
    await expect(startSignIn(cfg, 'ghost', 'https://app.example/cb')).rejects.toThrow(/unknown or disabled/i);
    upsertIdentityProviderRecord(dataDir, providerConfig({ enabled: false }));
    await expect(startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb')).rejects.toThrow(/unknown or disabled/i);
  });

  it('completeSignIn (first login): provisions an active binding-free user and creates a resolvable WebSession (no token minted)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const { state, nonce } = started(await startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));

    const sessionId = await completeSignIn(cfg, state, 'auth-code-1', nonce);
    expect(sessionId).toMatch(/^ws_[0-9a-f]+$/);

    // The user was provisioned: active, NO role bindings, id = the resolved subject id.
    const user = findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1');
    expect(user).not.toBeNull();
    expect(user!.id).toBe(`sso:${PROVIDER_ID}:ext-1`);
    expect(user!.status).toBe('active');
    expect(user!.roleBindings).toEqual([]);

    // A resolvable WebSession was created (not a bearer token record); it stores
    // NO permissions — authority resolves live per request.
    const session = getWebSessionById(dataDir, sessionId);
    expect(session).not.toBeNull();
    expect(session!.subject.userId).toBe(`sso:${PROVIDER_ID}:ext-1`);
    expect(session!.projects).toEqual(['*']);
    expect(session!.providerId).toBe(PROVIDER_ID);
    expect(Date.parse(session!.expiresAt)).toBeGreaterThan(Date.now());

    // A security-level web.signin audit event exists.
    const events = auditQuery(dataDir, { action: 'web.signin' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
  });

  it('completeSignIn refuses a returning user who has been deactivated (creates no new session)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const f1 = started(await startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    await completeSignIn(cfg, f1.state, 'code-1', f1.nonce);

    setUserStatus(dataDir, `sso:${PROVIDER_ID}:ext-1`, 'suspended');

    const f2 = started(await startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    await expect(completeSignIn(cfg, f2.state, 'code-2', f2.nonce)).rejects.toThrow(ForbiddenError);

    // Only the first (pre-deactivation) session exists; the refused login minted nothing.
    expect(listWebSessionsBySubject(dataDir, `sso:${PROVIDER_ID}:ext-1`)).toHaveLength(1);
  });

  it('completeSignIn does NOT revoke prior sessions (multi-device): two logins yield two live sessions', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const fA = started(await startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    const idA = await completeSignIn(cfg, fA.state, 'c1', fA.nonce);
    const fB = started(await startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    const idB = await completeSignIn(cfg, fB.state, 'c2', fB.nonce);

    expect(idA).not.toBe(idB);
    expect(getWebSessionById(dataDir, idA)).not.toBeNull();
    expect(getWebSessionById(dataDir, idB)).not.toBeNull();
    expect(listWebSessionsBySubject(dataDir, `sso:${PROVIDER_ID}:ext-1`)).toHaveLength(2);
  });

  it('SECURITY: completeSignIn rejects a login-CSRF callback whose nonce cookie is absent or wrong', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const { state, nonce } = started(await startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));

    // Victim's browser has NO nonce cookie (attacker-delivered callback) → refused.
    await expect(completeSignIn(cfg, state, 'code', null)).rejects.toThrow(ForbiddenError);
    // A DIFFERENT browser's nonce (mismatch) → refused.
    await expect(completeSignIn(cfg, state, 'code', 'deadbeef'.repeat(4))).rejects.toThrow(ForbiddenError);
    // No session was created by either refused attempt.
    expect(listWebSessionsBySubject(dataDir, `sso:${PROVIDER_ID}:ext-1`)).toHaveLength(0);

    // The matching nonce (the browser that started the flow) → succeeds.
    const id = await completeSignIn(cfg, state, 'code', nonce);
    expect(id).toMatch(/^ws_[0-9a-f]+$/);
  });

  it('completeSignIn rejects a tampered and an expired state', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    // state verification runs BEFORE the nonce check, so the nonce arg is irrelevant here.
    await expect(completeSignIn(cfg, 'tampered-not-a-state', 'code', 'n')).rejects.toThrow(/invalid SSO state/i);

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    const expired = signSsoState(
      JSON.stringify({ providerId: PROVIDER_ID, nonce: 'n', redirectUri: 'https://app.example/cb' }),
    );
    vi.setSystemTime(new Date('2026-07-11T00:11:00.000Z')); // past the 10-minute TTL
    await expect(completeSignIn(cfg, expired, 'code', 'n')).rejects.toThrow(/expired/i);
  });
});

// ── Web orchestrator: session lifecycle + context ────────────────────────────

describe('web orchestrator session lifecycle + context (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-web-ctx-'));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  function mkSession(over: Partial<WebSession> = {}): WebSession {
    return createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...over,
    });
  }

  /** A session bound to the persisted built-in super-admin (the instance-admin). */
  function adminCtxSession(): WebSession {
    const instance = ensureInstanceIdentity(dataDir);
    return mkSession({ subject: { userId: instance.superadminUserId, kind: 'human', issuer: 'local' } });
  }

  it('getCurrentContext returns the slim context and touches lastSeenAt', () => {
    const s = mkSession({ lastSeenAt: '2000-01-01T00:00:00.000Z' });

    const ctx = getCurrentContext(cfg, s.id);
    expect(ctx.subject.userId).toBe('u-1');
    expect(ctx.isAdmin).toBe(false);
    // The context carries NO permission projections: the client lists projects
    // via /web/projects (resolver-filtered) and drives admin chrome from its
    // project:admin visible scopes.
    expect('canWriteProjects' in ctx).toBe(false);
    expect('visibleProjectIds' in ctx).toBe(false);

    // lastSeenAt was advanced away from the seeded (old) value.
    const after = getWebSessionById(dataDir, s.id)!.lastSeenAt!;
    expect(after).not.toBe('2000-01-01T00:00:00.000Z');
    expect(Date.parse(after)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00.000Z'));
  });

  it('getCurrentContext: the built-in super-admin session is isAdmin, and the project selector source (listProjects) sees all', () => {
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-b');
    const s = adminCtxSession();
    const ctx = getCurrentContext(cfg, s.id);
    expect(ctx.isAdmin).toBe(true);
    // The selector is fed by the resolver-filtered listing, not the context.
    expect(webproject.listProjects(cfg, s.id).map((r) => r.id).sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('getCurrentContext: a DELEGATED instance-wide admin is NOT flagged isAdmin (the flag is the env-anchored bypass)', () => {
    allow(dataDir, 'u-1', 'project:admin', 'instance', undefined);
    const s = mkSession();
    const ctx = getCurrentContext(cfg, s.id);
    expect(ctx.isAdmin).toBe(false);
  });

  it('getCurrentContext rejects an absent and an expired session', () => {
    expect(() => getCurrentContext(cfg, 'ws_does-not-exist')).toThrow(UnauthenticatedError);
    const expired = mkSession({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(() => getCurrentContext(cfg, expired.id)).toThrow(UnauthenticatedError);
  });

  it('signOut removes one session while the principal\'s other sessions survive (info audit)', () => {
    const a = mkSession();
    const b = mkSession();
    signOut(cfg, a.id);
    expect(getWebSessionById(dataDir, a.id)).toBeNull();
    expect(getWebSessionById(dataDir, b.id)).not.toBeNull();

    const events = auditQuery(dataDir, { action: 'web.signout' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('info');
  });

  it('signOutEverywhere removes all of the subject\'s sessions but not another subject\'s (security audit)', () => {
    const a1 = mkSession();
    const a2 = mkSession();
    const other = mkSession({ subject: { userId: 'u-2', kind: 'human', issuer: 'local' } });

    signOutEverywhere(cfg, a1.id);
    expect(getWebSessionById(dataDir, a1.id)).toBeNull();
    expect(getWebSessionById(dataDir, a2.id)).toBeNull();
    expect(getWebSessionById(dataDir, other.id)).not.toBeNull();

    const events = auditQuery(dataDir, { action: 'web.signout.all' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
  });

  it('signOutEverywhere is an idempotent no-op for an unauthenticated session (no audit, no collateral)', () => {
    const survivor = mkSession();
    expect(() => signOutEverywhere(cfg, 'ws_missing')).not.toThrow();
    expect(getWebSessionById(dataDir, survivor.id)).not.toBeNull();
    expect(auditQuery(dataDir, { action: 'web.signout.all' })).toHaveLength(0);
  });
});

// ── Web graph orchestrator ───────────────────────────────────────────────────

describe('web graph orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-web-graph-'));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    invalidateSpecCache();
  });
  afterEach(() => {
    invalidateSpecCache();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  function session(projects: string[], userId = 'u-1'): WebSession {
    // The subject's authority resolves live; give it project:read over the
    // narrowing so scoped landscape/graph reads see the projects.
    for (const p of projects) {
      if (p !== '*') allow(dataDir, userId, 'project:read', 'project', p);
    }
    return createWebSession(dataDir, {
      id: '',
      subject: { userId, kind: 'human', issuer: 'local' },
      projects,
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  /** A session bound to the persisted built-in super-admin (instance-admin). */
  function adminGraphSession(): WebSession {
    const instance = ensureInstanceIdentity(dataDir);
    return createWebSession(dataDir, {
      id: '',
      subject: { userId: instance.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  const now = new Date().toISOString();
  const createdBy: PrincipalSubject = { userId: 'u-admin', kind: 'human', issuer: 'local' };

  function seedProjectTree(projectRoot: string): void {
    fs.mkdirSync(path.join(projectRoot, '.wai', 'specs'), { recursive: true });
    runWithProjectRoot(projectRoot, () => {
      // provisionProject writes .wai/project.yaml + the L0 system spec 'GraphSys',
      // so the conformance gate (loadProjectConfig) treats the root as a real project.
      provisionProject('GraphSys');
      saveSubsystemSpec({
        id: 'billing',
        name: 'Billing',
        description: 'billing',
        parentSystem: 'GraphSys',
        publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
        createdAt: now,
        updatedAt: now,
      });
      const comp = (over: Record<string, unknown>) => ({
        id: '',
        name: '',
        description: 'd',
        subsystem: 'billing',
        componentType: 'Orchestrator' as const,
        owns: [] as string[],
        dependsOn: [] as string[],
        createdAt: now,
        updatedAt: now,
        ...over,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveComponentSpec(comp({ id: 'billing-portal', name: 'Billing Portal', componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['billing-orchestrator'] }) as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveComponentSpec(comp({ id: 'billing-orchestrator', name: 'Billing Orchestrator', componentType: 'Orchestrator' }) as any);
      saveInterfaceSpec({
        id: 'ibilling-portal',
        name: 'IBillingPortal',
        description: 'contract',
        component: 'billing-portal',
        methods: [{ name: 'authorize', description: 'auth', signature: 'authorize(): void', returns: 'void' }],
        createdAt: now,
        updatedAt: now,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveTypeSpec({ kind: 'entity', id: 'invoice', name: 'Invoice', description: 'a bill', fields: [{ name: 'total', type: 'number', optional: false }], methods: [], createdAt: now, updatedAt: now } as any);
    });
    invalidateSpecCache();
  }

  it('project tier: returns a level-filtered graph with per-node issueCounts overlaid', () => {
    const rec = createProjectRecord(dataDir, 'proj-a');
    seedProjectTree(rec.rootPath);
    // The web project listing gates the graph — a project must be PLACED to be
    // in anyone's visibility view.
    createOrgUnit(dataDir, { id: '', slug: 'unit-g', name: 'G', kind: 'team', status: 'active', createdAt: now, createdBy });
    placeProject(dataDir, { id: 'pl-g', projectId: 'proj-a', unitId: 'unit-g', role: 'owner', createdAt: now, createdBy });
    const s = session(['proj-a']);

    // Expected overlay: the same conformance gate over the same bound tree.
    const expected = runWithProjectRoot(rec.rootPath, () => {
      invalidateSpecCache();
      return validateProjectAsComplete();
    });
    invalidateSpecCache();
    const expectedCounts = new Map<string, number>();
    for (const iss of expected.issues) {
      if (iss.specId) expectedCounts.set(iss.specId, (expectedCounts.get(iss.specId) ?? 0) + 1);
    }

    const graph = getGraph(cfg, s.id, 'project', 'proj-a', 3);
    expect(graph.tier).toBe('project');
    expect(graph.scope).toBe('proj-a');
    expect(graph.level).toBe(3);
    expect(graph.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['GraphSys', 'billing', 'billing-portal', 'billing-orchestrator', 'ibilling-portal', 'invoice']),
    );
    // Every node's issueCount is exactly the count of issues referencing its id.
    for (const n of graph.nodes) {
      expect(n.issueCount).toBe(expectedCounts.get(n.id));
    }

    // Level filtering: level 1 keeps only the project + subsystem tier.
    const l1 = getGraph(cfg, s.id, 'project', 'proj-a', 1);
    expect(l1.nodes.every((n) => n.level <= 1)).toBe(true);
    expect(l1.nodes.some((n) => n.kind === 'component' || n.kind === 'interface')).toBe(false);
  });

  it('project tier: throws Forbidden on a cross-project request', () => {
    createProjectRecord(dataDir, 'proj-a');
    const s = session(['proj-a']);
    expect(() => getGraph(cfg, s.id, 'project', 'proj-b', 3)).toThrow(ForbiddenError);
  });

  it('landscape tier: reshapes the scoped landscape and level-filters (scope instance)', () => {
    createOrgUnit(dataDir, { id: '', slug: 'unit-1', name: 'Team One', kind: 'team', status: 'active', createdAt: now, createdBy });
    createProjectRecord(dataDir, 'proj-a');
    placeProject(dataDir, { id: 'pl-1', projectId: 'proj-a', unitId: 'unit-1', role: 'owner', createdAt: now, createdBy });
    replacePublicSurfaceSnapshot(dataDir, {
      projectId: 'proj-a',
      stateId: 'sha256:abc',
      systemName: 'ProjA',
      interfaces: [{ id: 'iface-1', name: 'Public API', type: 'REST', audience: 'public', methods: ['ping'], details: '' }],
      exportedAt: '',
    });
    const admin = adminGraphSession();

    const g2 = getGraph(cfg, admin.id, 'landscape', '', 2);
    expect(g2.tier).toBe('landscape');
    expect(g2.scope).toBe('instance');
    expect(g2.level).toBe(2);
    const byId = new Map(g2.nodes.map((n) => [n.id, n]));
    expect(byId.get('unit:unit-1')).toMatchObject({ kind: 'unit', level: 0 });
    expect(byId.get('project:proj-a')).toMatchObject({ kind: 'project', level: 0, projectId: 'proj-a' });
    expect(byId.get('iface:proj-a:iface-1')).toMatchObject({ kind: 'interface', level: 2, projectId: 'proj-a' });
    // The placement edge is reused as-is.
    expect(g2.edges.some((e) => e.from === 'unit:unit-1' && e.to === 'project:proj-a')).toBe(true);

    // Level 0 drops the interface (level 2) node and any edge referencing it.
    const g0 = getGraph(cfg, admin.id, 'landscape', '', 0);
    expect(g0.nodes.some((n) => n.kind === 'interface')).toBe(false);
    expect(g0.nodes.some((n) => n.id === 'unit:unit-1')).toBe(true);
    expect(g0.edges.every((e) => e.to !== 'iface:proj-a:iface-1')).toBe(true);
  });

  it('rejects an unknown graph tier', () => {
    const s = adminGraphSession();
    expect(() => getGraph(cfg, s.id, 'galaxy', '', 0)).toThrow(/unsupported graph tier/i);
  });

  it('rejects an absent/expired session before any tier work', () => {
    expect(() => getGraph(cfg, 'ws_missing', 'landscape', '', 0)).toThrow(UnauthenticatedError);
  });

  // ── getProjectCanvas: the REAL renderCanvasHtml canvas, scoped per project ──

  it('getProjectCanvas returns the real interactive canvas HTML for an authorized project', () => {
    const rec = createProjectRecord(dataDir, 'proj-a');
    seedProjectTree(rec.rootPath);
    createOrgUnit(dataDir, { id: '', slug: 'unit-c', name: 'C', kind: 'team', status: 'active', createdAt: now, createdBy });
    placeProject(dataDir, { id: 'pl-c', projectId: 'proj-a', unitId: 'unit-c', role: 'owner', createdAt: now, createdBy });
    const s = session(['proj-a']);

    const cv = getProjectCanvas(cfg, s.id, 'proj-a');
    // The SAME renderCanvasHtml output as the static `wairon diagram --format canvas`
    // export: a self-contained document whose title is "<system> — architecture canvas".
    expect(cv.toLowerCase()).toContain('<!doctype html');
    expect(cv).toContain('architecture canvas');
    // It rendered THIS bound project's spec tree (the seeded system name is present).
    expect(cv).toContain('GraphSys');
  });

  it('getProjectCanvas throws Forbidden for a cross-project / unknown project id', () => {
    createProjectRecord(dataDir, 'proj-a');
    const s = session(['proj-a']);
    expect(() => getProjectCanvas(cfg, s.id, 'proj-b')).toThrow(ForbiddenError);
  });

  it('getProjectCanvas rejects an absent/expired session before any project work', () => {
    expect(() => getProjectCanvas(cfg, 'ws_missing', 'proj-a')).toThrow(UnauthenticatedError);
  });

  // ── getWebProjectCanvasModel: the CanvasModel as JSON (data sibling of the HTML) ──

  it('getWebProjectCanvasModel returns the bound project CanvasModel as data', () => {
    const rec = createProjectRecord(dataDir, 'proj-a');
    seedProjectTree(rec.rootPath);
    createOrgUnit(dataDir, { id: '', slug: 'unit-cm', name: 'CM', kind: 'team', status: 'active', createdAt: now, createdBy });
    placeProject(dataDir, { id: 'pl-cm', projectId: 'proj-a', unitId: 'unit-cm', role: 'owner', createdAt: now, createdBy });
    const s = session(['proj-a']);

    const model = getWebProjectCanvasModel(cfg, s.id, 'proj-a') as {
      system: { name: string };
      components: unknown[];
      subsystems: unknown[];
    };
    // Structured data (not HTML): the seeded system, with component/subsystem arrays.
    expect(model.system.name).toBe('GraphSys');
    expect(Array.isArray(model.components)).toBe(true);
    expect(Array.isArray(model.subsystems)).toBe(true);
  });

  it('getWebProjectCanvasModel throws Forbidden for a cross-project / unknown project id', () => {
    createProjectRecord(dataDir, 'proj-a');
    const s = session(['proj-a']);
    expect(() => getWebProjectCanvasModel(cfg, s.id, 'proj-b')).toThrow(ForbiddenError);
  });

  it('getWebProjectCanvasModel rejects an absent/expired session before any project work', () => {
    expect(() => getWebProjectCanvasModel(cfg, 'ws_missing', 'proj-a')).toThrow(UnauthenticatedError);
  });
});

// ── Web portal: legacy client app shell (serveLegacyApp) ─────────────────────
//
// serveApp now prefers the built React single-page bundle (dist/webapp.html) and
// only falls back to this hand-written shell when the bundle is absent. These
// guards still protect that fallback: while it ships, its inline script must
// parse and its same-origin wiring must hold. They target serveLegacyApp directly
// so they are independent of whether a web/dist bundle happens to be present.

describe('web portal legacy client app shell (sdd_host)', () => {
  const html = serveLegacyApp('/');

  it('returns exactly one self-contained HTML document', () => {
    expect(html.trimStart().slice(0, 15).toLowerCase()).toContain('<!doctype html');
    // A single document — not concatenated shells.
    expect((html.match(/<!doctype html/gi) || []).length).toBe(1);
    expect((html.match(/<\/html>/gi) || []).length).toBe(1);
    // Inline only: exactly one <script> and one <style>, both in-document.
    expect((html.match(/<script/gi) || []).length).toBe(1);
    expect((html.match(/<style/gi) || []).length).toBe(1);
  });

  it('the embedded client script is syntactically valid JS (a parse error would leave the page stuck on "Loading…")', () => {
    // The whole client lives inside serveApp's template literal, so a valid
    // template-literal escape (e.g. \') can still emit INVALID browser JS that
    // kills the entire <script> — the page then never boots. Compile the served
    // script body: new Function() throws SyntaxError on a parse error but never
    // executes it (so document/fetch are never touched).
    const body = /<script>([\s\S]*?)<\/script>/i.exec(html)?.[1];
    expect(body, 'the shell must carry exactly one inline <script>').toBeTruthy();
    expect(() => new Function(body as string)).not.toThrow();
  });

  it('wires every same-origin endpoint the client drives', () => {
    expect(html).toContain('/web/context');
    expect(html).toContain('/web/canvas'); // the embedded real canvas, per project
    expect(html).toContain('/web/sso/start');
    expect(html).toContain('/web/logout');
    expect(html).toContain('/web/logout-all');
    // CSRF header + cookie-attaching credentials mode on every fetch.
    expect(html).toContain('X-Wairon-Web');
    expect(html).toContain("credentials");
    expect(html).toContain('same-origin');
  });

  it('reuses the exported canvas --syw-* theme and embeds the REAL canvas via a same-origin iframe', () => {
    expect(html).toContain('--syw-deep-space');
    expect(html).toContain('--syw-primary-gradient');
    expect(html).toContain('#22ddff'); // cyan
    expect(html).toContain('#8b5cf6'); // purple
    // The shell embeds the SAME canvas engine via a per-project iframe — it does
    // NOT re-render a graph itself.
    expect(html).toContain('<iframe');
    expect(html).toContain('/web/canvas?projectId=');
  });

  it('has dropped the wave-4 from-scratch SVG renderer and the LOD slider entirely', () => {
    // No trace of the hand-rolled layout/renderer or the level-of-detail slider —
    // the iframe IS the canvas. The Specs authoring view DOES fetch /web/graph as a
    // plain JSON component index (not a renderer), so /web/graph is expected now.
    expect(html).not.toContain('data-tier');
    expect(html).not.toContain('data-node');
    expect(html).not.toContain('data-toggle');
    expect(html).not.toContain('levelRange');
    expect(html).not.toContain('renderGraph');
    expect(html).not.toContain('borderPt');
  });

  it('wires the admin management pages and the agent-token self-service page', () => {
    // Admin management routes for Users / Identity Providers / Organization.
    // (The grants editor is gone with the grant model; the roles/assignments
    // editor lands with the permission-admin UI phase.)
    expect(html).toContain('/web/admin/users/status');
    expect(html).not.toContain('/web/admin/users/grants');
    expect(html).toContain('/web/admin/providers');
    expect(html).toContain('/web/admin/providers/remove');
    expect(html).toContain('/web/admin/org/units');
    expect(html).toContain('/web/admin/org/placements');
    // The Identity-Provider form exposes the provider types and the split-horizon
    // override fields that make self-hosted Keycloak/Authentik work.
    expect(html).toContain('google_workspace');
    expect(html).toContain('entra_id');
    expect(html).toContain('clientSecretRef');
    expect(html).toContain('authorizationEndpoint');
    expect(html).toContain('tokenEndpoint');
    expect(html).toContain('jwksUri');
    expect(html).toContain('userinfoEndpoint');
    expect(html).toContain('allowedRedirectUris');
    // The self-service "Connect an agent" token routes render for any signed-in user.
    expect(html).toContain('/web/tokens');
    expect(html).toContain('/web/tokens/revoke');
    // No stale API-key admin surface remains in the client.
    expect(html).not.toContain('/web/admin/keys');
  });

  it('references no external http(s):// assets — everything is inline', () => {
    // No external asset loads (CDN scripts, stylesheets, fonts, images, imports).
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/@import\s+(?:url\()?["']?https?:/i);
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    // And no bare http(s) URL anywhere in the served document.
    expect(html).not.toMatch(/https?:\/\//i);
  });
});

// ── Web portal: app document dispatch (serveApp) ─────────────────────────────

describe('web portal app document (serveApp, sdd_host)', () => {
  it('always returns exactly one self-contained HTML document', () => {
    // Regardless of whether the built React bundle is present (bundle) or absent
    // (legacy fallback), serveApp must yield a single, self-contained document with
    // no external asset loads — the CSP forbids them and the fallback must never
    // ship a half-page. This holds for both branches, so it does not depend on
    // whether web/dist was built in this environment.
    const html = serveApp('/');
    expect(html.trimStart().slice(0, 15).toLowerCase()).toContain('<!doctype html');
    expect((html.match(/<!doctype html/gi) || []).length).toBe(1);
    expect((html.match(/<\/html>/gi) || []).length).toBe(1);
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']https?:/i);
  });

  it('prefers the built React bundle when web/dist/index.html is present', () => {
    // The React SPA mounts into <div id="root">; the legacy shell never uses that
    // marker. When the bundle has been built (as in a full `npm run build:web`),
    // serveApp returns it. When it is absent, this environment has nothing to
    // assert against, so the check is skipped rather than made flaky.
    const bundlePath = path.resolve(process.cwd(), 'web/dist/index.html');
    if (!fs.existsSync(bundlePath)) return;
    const html = serveApp('/');
    expect(html).toContain('id="root"');
  });
});

// ── Web portal HTTP mount (routeData) ────────────────────────────────────────

describe('web portal HTTP mount (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  /** Enable the opt-in web UI (and drop the TLS-only Secure flag for test cookies). */
  function enableWebUi(): void {
    fs.writeFileSync(
      path.join(dataDir, 'exposure-policy.json'),
      JSON.stringify({ webUiEnabled: true, requireTls: false }),
    );
  }

  interface RawResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }
  function raw(opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<RawResponse> {
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-web-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    setSecret(SECRET_REF, SECRET_VALUE);
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    stubClaims({ iss: issuerUrl, sub: 'ext-1', email: 'alice@corp.example', name: 'Alice' });
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  const rpc = (name: string): string =>
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } });

  it('webUiEnabled=false (default): the app shell and every /web path answer 404', async () => {
    expect((await raw({ method: 'GET', path: '/' })).status).toBe(404);
    expect((await raw({ method: 'GET', path: '/web/context' })).status).toBe(404);
    // The agent-token self-service routes are part of /web, so they are gated too.
    expect((await raw({ method: 'GET', path: '/web/tokens' })).status).toBe(404);
    expect(
      (await raw({
        method: 'POST',
        path: '/web/sso/start',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: PROVIDER_ID, redirectUri: 'https://app/cb' }),
      })).status,
    ).toBe(404);
  });

  it('webUiEnabled=true: serves the app shell and completes the SSO callback → session cookie', async () => {
    enableWebUi();
    upsertIdentityProviderRecord(dataDir, providerConfig());

    // App shell.
    const shell = await raw({ method: 'GET', path: '/' });
    expect(shell.status).toBe(200);
    expect(shell.headers['content-type']).toMatch(/text\/html/);
    expect(shell.body).toContain('/web/context');

    // start → 200 with the authorization URL.
    const start = await raw({
      method: 'POST',
      path: '/web/sso/start',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: PROVIDER_ID, redirectUri: 'https://app/cb' }),
    });
    expect(start.status).toBe(200);
    const state = new URL(JSON.parse(start.body).url).searchParams.get('state') ?? '';
    // start installs the HttpOnly SSO-nonce cookie that binds this browser to the flow.
    const startCookie = String(start.headers['set-cookie']?.[0] ?? '');
    expect(startCookie).toMatch(/^wairon_sso_nonce=[0-9a-f]+/);
    expect(startCookie).toMatch(/HttpOnly/);
    const nonceCookie = /wairon_sso_nonce=[0-9a-f]+/.exec(startCookie)![0];

    // callback WITHOUT the nonce cookie is refused (login-CSRF defense).
    const forged = await raw({ method: 'GET', path: `/web/sso/callback?state=${encodeURIComponent(state)}&code=c1` });
    expect(forged.status).toBe(403);

    // callback WITH the matching nonce cookie → 302 to '/', setting the session cookie.
    const cb = await raw({
      method: 'GET',
      path: `/web/sso/callback?state=${encodeURIComponent(state)}&code=c1`,
      headers: { cookie: nonceCookie },
    });
    expect(cb.status).toBe(302);
    expect(cb.headers['location']).toBe('/');
    const setCookie = String(cb.headers['set-cookie']?.[0] ?? '');
    expect(setCookie).toMatch(/^wairon_session=ws_[0-9a-f]+/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const sessionId = /wairon_session=(ws_[0-9a-f]+)/.exec(setCookie)![1];

    // The cookie authenticates /web/context.
    const ctx = await raw({ method: 'GET', path: '/web/context', headers: { cookie: `wairon_session=${sessionId}` } });
    expect(ctx.status).toBe(200);
    expect(JSON.parse(ctx.body).subject.userId).toBe(`sso:${PROVIDER_ID}:ext-1`);

    // logout clears the cookie and removes the session.
    const out = await raw({
      method: 'POST',
      path: '/web/logout',
      headers: { cookie: `wairon_session=${sessionId}`, 'x-wairon-web': '1' },
    });
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie']?.[0] ?? '')).toMatch(/Max-Age=0/);
    expect(getWebSessionById(dataDir, sessionId)).toBeNull();
  });

  it('a cookie-authenticated web mutation without the CSRF header is 403', async () => {
    enableWebUi();
    const s = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // Missing X-Wairon-Web → 403; the session is untouched.
    const res = await raw({ method: 'POST', path: '/web/logout', headers: { cookie: `wairon_session=${s.id}` } });
    expect(res.status).toBe(403);
    expect(getWebSessionById(dataDir, s.id)).not.toBeNull();
  });

  it('the session cookie bridges /mcp (browser session drives spec authoring); no auth → 401', async () => {
    createProjectRecord(dataDir, 'proj-a');
    allow(dataDir, 'u-1', 'project:read', 'project', 'proj-a');
    const s = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      projects: ['proj-a'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const authed = await raw({
      method: 'POST',
      path: '/mcp?project=proj-a',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        cookie: `wairon_session=${s.id}`,
        'x-wairon-web': '1',
      },
      body: rpc('sdd_get_status'),
    });
    expect(authed.status).toBe(200);
    expect(authed.body).not.toContain('unauthorized');

    const anon = await raw({
      method: 'POST',
      path: '/mcp?project=proj-a',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: rpc('sdd_get_status'),
    });
    expect(anon.status).toBe(401);
  }, 20_000);

  it('CSRF: a cookie-auth /mcp mutation needs the header, but a bearer request is exempt', async () => {
    createProjectRecord(dataDir, 'proj-a');
    allow(dataDir, 'u-1', 'project:read', 'project', 'proj-a');
    const s = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      projects: ['proj-a'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // Cookie-authenticated /mcp WITHOUT the header → 403 (never dispatched).
    const blocked = await raw({
      method: 'POST',
      path: '/mcp?project=proj-a',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', cookie: `wairon_session=${s.id}` },
      body: rpc('sdd_get_status'),
    });
    expect(blocked.status).toBe(403);

    // A BEARER token carries no ambient cookie, so it is exempt from the header.
    const bearer = 'wk_' + crypto.randomBytes(8).toString('hex');
    allow(dataDir, 'u-bearer', 'project:read', 'project', 'proj-a');
    const record: ApiKeyRecord = {
      id: 'bearer-1',
      keyHash: hashToken(bearer),
      projects: ['proj-a'],
      createdAt: new Date().toISOString(),
      ownerSubject: { userId: 'u-bearer', kind: 'human', issuer: 'local' },
    };
    createCredential(dataDir, record);
    const ok = await raw({
      method: 'POST',
      path: '/mcp?project=proj-a',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${bearer}`,
      },
      body: rpc('sdd_get_status'),
    });
    expect(ok.status).toBe(200);
  }, 20_000);

  it('GET /web/canvas serves an authorized project canvas (200 text/html) and forbids an out-of-scope project (403)', async () => {
    enableWebUi();
    const rec = createProjectRecord(dataDir, 'proj-a');
    // Seed a minimal real project tree so the canvas renders over actual specs.
    fs.mkdirSync(path.join(rec.rootPath, '.wai', 'specs'), { recursive: true });
    runWithProjectRoot(rec.rootPath, () => provisionProject('CanvasSys'));
    invalidateSpecCache();

    // The canvas gate goes through the visibility view: the project must be
    // PLACED and the subject must have project:read reach.
    createOrgUnit(dataDir, { id: '', slug: 'unit-cv', name: 'CV', kind: 'team', status: 'active', createdAt: new Date().toISOString(), createdBy: SUBJECT });
    placeProject(dataDir, { id: 'pl-cv', projectId: 'proj-a', unitId: 'unit-cv', role: 'owner', createdAt: new Date().toISOString(), createdBy: SUBJECT });
    allow(dataDir, 'u-1', 'project:read', 'project', 'proj-a');

    const s = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      projects: ['proj-a'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    // Authorized: 200 with the SAME renderCanvasHtml document the static export emits.
    const okCv = await raw({
      method: 'GET',
      path: '/web/canvas?projectId=proj-a',
      headers: { cookie: `wairon_session=${s.id}` },
    });
    expect(okCv.status).toBe(200);
    expect(okCv.headers['content-type']).toMatch(/text\/html/);
    expect(okCv.body.toLowerCase()).toContain('<!doctype html');
    expect(okCv.body).toContain('architecture canvas');

    // Out-of-scope project → 403 (no existence leak), never a rendered canvas.
    const forbidden = await raw({
      method: 'GET',
      path: '/web/canvas?projectId=proj-b',
      headers: { cookie: `wairon_session=${s.id}` },
    });
    expect(forbidden.status).toBe(403);
  }, 20_000);

  it('admin routes: an instance-admin session reads the scoped control-plane views', async () => {
    enableWebUi();
    const instance = ensureInstanceIdentity(dataDir);
    const admin = createWebSession(dataDir, {
      id: '',
      subject: { userId: instance.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const cookie = `wairon_session=${admin.id}`;

    const users = await raw({ method: 'GET', path: '/web/admin/users', headers: { cookie } });
    expect(users.status).toBe(200);
    expect(JSON.parse(users.body)).toHaveProperty('users');

    const health = await raw({ method: 'GET', path: '/web/admin/health', headers: { cookie } });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toHaveProperty('status');

    const approvals = await raw({ method: 'GET', path: '/web/admin/approvals', headers: { cookie } });
    expect(approvals.status).toBe(200);
    expect(JSON.parse(approvals.body)).toHaveProperty('requests');

    const landscape = await raw({ method: 'GET', path: '/web/admin/landscape', headers: { cookie } });
    expect(landscape.status).toBe(200);
    expect(JSON.parse(landscape.body)).toHaveProperty('nodes');
  }, 20_000);

  it('admin routes: a viewer session (no admin permission) is refused with 403, no data leak', async () => {
    enableWebUi();
    const viewer = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      projects: ['demo'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const cookie = `wairon_session=${viewer.id}`;

    // listUsers and getHealthReport both throw ForbiddenError on empty scope → 403.
    expect((await raw({ method: 'GET', path: '/web/admin/users', headers: { cookie } })).status).toBe(403);
    expect((await raw({ method: 'GET', path: '/web/admin/health', headers: { cookie } })).status).toBe(403);
  }, 20_000);

  it('admin routes require the web UI to be enabled (404 when disabled)', async () => {
    // webUiEnabled defaults false — the admin routes are part of /web and 404 with it.
    expect((await raw({ method: 'GET', path: '/web/admin/users' })).status).toBe(404);
  });
});

// ── Web admin orchestrator (sdd_host) ────────────────────────────────────────
//
// The bridge exposing the control-plane admin capabilities on the PUBLIC data
// plane. User / IdP / key methods forward to the identity/admin orchestrators
// with the session as the credential; org-unit methods are owned here (require an
// instance-wide admin grant, mutate through the organization repository, audit).

describe('web admin orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-webadmin-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    setSecret(SECRET_REF, SECRET_VALUE);
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

  /** A session bound to the persisted built-in super-admin (the instance-admin). */
  function adminSession(): string {
    const instance = ensureInstanceIdentity(dataDir);
    return createWebSession(dataDir, {
      id: '',
      subject: { userId: instance.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;
  }
  /** The persisted built-in super-admin's userId (token-ownership assertions). */
  function adminUserId(): string {
    return ensureInstanceIdentity(dataDir).superadminUserId;
  }
  function viewerSession(): string {
    return createWebSession(dataDir, {
      id: '',
      subject: { userId: 'viewer', kind: 'human', issuer: 'local' },
      projects: ['demo'],
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;
  }

  it('org-unit methods require an instance-wide admin grant (owned auth) and audit writes', () => {
    const admin = adminSession();
    const viewer = viewerSession();

    // Admin creates + lists organization units; a security-level audit event is written.
    const unit = webadmin.upsertOrganizationUnit(cfg, admin, {
      id: '',
      name: 'Team One',
      slug: 'team-one',
      kind: 'business_entity',
      status: 'active',
      createdAt: '',
      createdBy: SUBJECT,
    });
    expect(unit.id).toBeTruthy();
    expect(webadmin.listOrganizationUnits(cfg, admin).map((u) => u.id)).toContain(unit.id);
    const up = auditQuery(dataDir, { action: 'org.unit.upsert' });
    expect(up).toHaveLength(1);
    expect(up[0].level).toBe('security');

    // A viewer session (no instance-admin grant) is denied on read AND write.
    expect(() => webadmin.listOrganizationUnits(cfg, viewer)).toThrow(ForbiddenError);
    expect(() =>
      webadmin.upsertOrganizationUnit(cfg, viewer, {
        id: '',
        name: 'X',
        slug: 'x',
        kind: 'team',
        status: 'active',
        createdAt: '',
        createdBy: SUBJECT,
      }),
    ).toThrow(ForbiddenError);
    expect(() => webadmin.placeProject(cfg, viewer, 'proj-a', unit.id)).toThrow(ForbiddenError);
  });

  it('placeProject binds a project to a unit through the repository and audits', () => {
    const admin = adminSession();
    const unit = webadmin.upsertOrganizationUnit(cfg, admin, {
      id: '',
      name: 'Team',
      slug: 'unit-1',
      kind: 'business_entity',
      status: 'active',
      createdAt: '',
      createdBy: SUBJECT,
    });
    createProjectRecord(dataDir, 'proj-a');

    webadmin.placeProject(cfg, admin, 'proj-a', unit.id);
    expect(listProjectPlacements(dataDir, 'proj-a', unit.id)).toHaveLength(1);
    const ev = auditQuery(dataDir, { action: 'org.placement.set' });
    expect(ev).toHaveLength(1);
    expect(ev[0].level).toBe('security');
  });

  it('user / IdP methods forward with the session as the credential (upstream scope applies)', () => {
    const admin = adminSession();
    const viewer = viewerSession();

    // IdP upsert/list forward to the identity orchestrator (instance-admin only).
    const stored = webadmin.upsertIdentityProvider(cfg, admin, providerConfig());
    expect(stored.id).toBe(PROVIDER_ID);
    expect(webadmin.listIdentityProviders(cfg, admin).map((p) => p.id)).toContain(PROVIDER_ID);
    // A viewer session is refused by the upstream orchestrator (no new auth surface).
    expect(() => webadmin.listIdentityProviders(cfg, viewer)).toThrow(ForbiddenError);

    // listUsers forwards + scope-filters; an admin sees the directory, a viewer is denied.
    expect(Array.isArray(webadmin.listUsers(cfg, admin))).toBe(true);
    expect(() => webadmin.listUsers(cfg, viewer)).toThrow(ForbiddenError);
  });

  // The exact shape an operator enters for a DELEGATED UNIT ADMIN: a project:admin
  // assignment bounded to org unit X. It must be treated as unit-scoped, NEVER the
  // instance super-admin.
  it('SECURITY (Finding A): a unit-scoped project:admin is NOT instance-admin — org + IdP methods reject it', () => {
    allow(dataDir, 'unit-admin', 'project:admin', 'unit', 'unit-x');
    const unitAdmin = createWebSession(dataDir, {
      id: '',
      subject: { userId: 'unit-admin', kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;

    // Every instance-admin-gated surface must refuse the unit-scoped-wildcard grant.
    expect(() => webadmin.listOrganizationUnits(cfg, unitAdmin)).toThrow(ForbiddenError);
    expect(() =>
      webadmin.upsertOrganizationUnit(cfg, unitAdmin, {
        id: '',
        name: 'X',
        slug: 'x2',
        kind: 'team',
        status: 'active',
        createdAt: '',
        createdBy: SUBJECT,
      }),
    ).toThrow(ForbiddenError);
    expect(() => webadmin.placeProject(cfg, unitAdmin, 'proj-a', 'unit-x')).toThrow(ForbiddenError);
    expect(() => webadmin.upsertIdentityProvider(cfg, unitAdmin, providerConfig())).toThrow(ForbiddenError);

    // A GENUINE instance-admin (projectId '*', no orgUnitId) still passes.
    expect(webadmin.listOrganizationUnits(cfg, adminSession())).toBeDefined();
  });

  it('SECURITY (Finding B): a {projectId:*, orgUnitId} unit read/write holder mints ONLY within its unit, never cross-tenant', () => {
    const admin = adminSession();
    // Unit U owns proj-in-unit; proj-other belongs to a different tenant (unplaced).
    const unit = webadmin.upsertOrganizationUnit(cfg, admin, {
      id: '',
      name: 'U',
      slug: 'unit-u',
      kind: 'business_entity',
      status: 'active',
      createdAt: '',
      createdBy: SUBJECT,
    });
    createProjectRecord(dataDir, 'proj-in-unit');
    createProjectRecord(dataDir, 'proj-other');
    webadmin.placeProject(cfg, admin, 'proj-in-unit', unit.id);

    allow(dataDir, 'unit-rw', 'project:read', 'unit', unit.id);
    allow(dataDir, 'unit-rw', 'project:write', 'unit', unit.id);
    const unitRW = createWebSession(dataDir, {
      id: '',
      subject: { userId: 'unit-rw', kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;

    // In-unit project: the mint is allowed (resolved scope covers it).
    expect(typeof webadmin.mintProjectToken(cfg, unitRW, 'proj-in-unit', true)).toBe('string');
    // Another tenant's project (outside the unit subtree): DENIED — no cross-tenant mint.
    expect(() => webadmin.mintProjectToken(cfg, unitRW, 'proj-other', false)).toThrow(ForbiddenError);
  });

  it('mintProjectToken mints a single-project agent token OWNED by the caller; revokeProjectToken revokes it', () => {
    const admin = adminSession();
    createProjectRecord(dataDir, 'proj-a');

    // A read-only agent token: it authenticates and is NARROWED to exactly one
    // project — it stores no permissions (it acts as the owner's live authority),
    // entirely separate from the human's web session, but OWNED by the minting
    // caller (for lifecycle/revocation).
    const token = webadmin.mintProjectToken(cfg, admin, 'proj-a', false);
    expect(token).toMatch(/^wk_[0-9a-f]+$/);
    const p = authenticate(dataDir, token);
    expect(p.authenticated).toBe(true);
    expect(p.projects).toEqual(['proj-a']);

    // The stored record is OWNED by the caller (the session's subject) — NOT an
    // ownerless service credential with an empty ownerUserId.
    const rec = findByTokenHash(dataDir, hashToken(token))!;
    expect(rec.ownerSubject?.userId).toBe(adminUserId());
    expect(rec.createdBySubject?.userId).toBe(adminUserId());

    // A write token is identically narrowing-only (write authority resolves live).
    const wToken = webadmin.mintProjectToken(cfg, admin, 'proj-a', true);
    expect(authenticate(dataDir, wToken).projects).toEqual(['proj-a']);

    // Revoke by id → the token no longer authenticates.
    webadmin.revokeProjectToken(cfg, admin, rec.id);
    expect(authenticate(dataDir, token).authenticated).toBe(false);
    // token.mint.self + token.revoke.self security events were written upstream.
    expect(auditQuery(dataDir, { action: 'token.mint.self' }).length).toBeGreaterThanOrEqual(1);
    expect(auditQuery(dataDir, { action: 'token.revoke.self' })).toHaveLength(1);
  });

  it('mintProjectToken is self-scoped: a viewer mints read for its own project, but write and out-of-scope are denied', () => {
    const viewer = viewerSession();
    createProjectRecord(dataDir, 'demo');
    // The viewer holds ONLY project:read on demo.
    allow(dataDir, 'viewer', 'project:read', 'project', 'demo');

    // Self-service mint of a READ token for that project SUCCEEDS — the mint is
    // self-scoped and the token acts as the owner's live authority afterwards.
    const token = webadmin.mintProjectToken(cfg, viewer, 'demo', false);
    const p = authenticate(dataDir, token);
    expect(p.projects).toEqual(['demo']);
    // Owned by the viewer (not service/empty).
    const rec = findByTokenHash(dataDir, hashToken(token))!;
    expect(rec.ownerSubject?.userId).toBe('viewer');

    // Requesting WRITE exceeds the viewer's own access (project:read only) → Forbidden.
    expect(() => webadmin.mintProjectToken(cfg, viewer, 'demo', true)).toThrow(ForbiddenError);
    // A project the viewer has NO access to → Forbidden (cannot mint beyond own reach).
    createProjectRecord(dataDir, 'other');
    expect(() => webadmin.mintProjectToken(cfg, viewer, 'other', false)).toThrow(ForbiddenError);
  });

  it('listMyTokens returns only the caller-owned tokens (redacted); revokeSelfToken by a non-owner is rejected', () => {
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-b');
    // Two distinct users, each with their own session + read/write reach on one project.
    allow(dataDir, 'u-a', 'project:read', 'project', 'proj-a');
    allow(dataDir, 'u-a', 'project:write', 'project', 'proj-a');
    allow(dataDir, 'u-b', 'project:read', 'project', 'proj-b');
    const sessA = createWebSession(dataDir, {
      id: '', subject: { userId: 'u-a', kind: 'human', issuer: 'local' },
      projects: ['proj-a'],
      createdAt: '', expiresAt: FUTURE(),
    }).id;
    const sessB = createWebSession(dataDir, {
      id: '', subject: { userId: 'u-b', kind: 'human', issuer: 'local' },
      projects: ['proj-b'],
      createdAt: '', expiresAt: FUTURE(),
    }).id;

    const tokenA = webadmin.mintProjectToken(cfg, sessA, 'proj-a', true);
    webadmin.mintProjectToken(cfg, sessB, 'proj-b', false);

    // Each caller sees ONLY their own token, redacted (hashed token only, no plaintext).
    const myA = webadmin.listMyTokens(cfg, sessA);
    expect(myA).toHaveLength(1);
    expect(myA[0].ownerSubject?.userId).toBe('u-a');
    expect(myA[0].keyHash).toBeTruthy();
    expect((myA[0] as unknown as { token?: string }).token).toBeUndefined();
    expect(myA.some((r) => r.ownerSubject?.userId === 'u-b')).toBe(false);
    expect(webadmin.listMyTokens(cfg, sessB).map((r) => r.ownerSubject?.userId)).toEqual(['u-b']);

    // A non-owner may NOT revoke someone else's token — rejected (not found), no
    // cross-user revocation, and A's token still authenticates.
    const recA = findByTokenHash(dataDir, hashToken(tokenA))!;
    expect(() => webadmin.revokeProjectToken(cfg, sessB, recA.id)).toThrow();
    expect(authenticate(dataDir, tokenA).authenticated).toBe(true);

    // The owner CAN revoke it → it stops authenticating.
    webadmin.revokeProjectToken(cfg, sessA, recA.id);
    expect(authenticate(dataDir, tokenA).authenticated).toBe(false);
  });

  it('SECURITY: deactivating the owning user revokes their self-minted agent token (owned, so the sweep catches it)', () => {
    createProjectRecord(dataDir, 'proj-a');
    // A hosted user who owns an agent token, plus their live session.
    repoUpsertUser(dataDir, {
      id: 'u-agent',
      subject: { userId: 'u-agent', kind: 'human', issuer: 'local' },
      status: 'active',
      roleBindings: [],
      createdAt: new Date().toISOString(),
    });
    allow(dataDir, 'u-agent', 'project:read', 'project', 'proj-a');
    const agentSession = createWebSession(dataDir, {
      id: '', subject: { userId: 'u-agent', kind: 'human', issuer: 'local' },
      projects: ['proj-a'],
      createdAt: '', expiresAt: FUTURE(),
    }).id;

    const token = webadmin.mintProjectToken(cfg, agentSession, 'proj-a', false);
    expect(authenticate(dataDir, token).authenticated).toBe(true);

    // An admin deactivates the OWNER. Because the token is OWNED by that user,
    // setUserStatus's revokeAllForOwner sweep catches it — the defect this closes.
    identity.setUserStatus(cfg, adminSession(), 'u-agent', 'suspended');
    expect(authenticate(dataDir, token).authenticated).toBe(false);
  });
});

// ── Web admin routes over HTTP (routeData) ───────────────────────────────────

describe('web admin routes over HTTP (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

  function raw(opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-webadmin-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true, requireTls: false }));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // The admin session's subject IS the persisted superadmin UUID — instance
  // admin is a subject-identity check now, never a stored assignment.
  function adminSubject(): PrincipalSubject {
    const inst = ensureInstanceIdentity(dataDir);
    return { userId: inst.superadminUserId, kind: 'human', issuer: 'local' };
  }
  function adminCookie(): string {
    const s = createWebSession(dataDir, {
      id: '',
      subject: adminSubject(),
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    });
    return `wairon_session=${s.id}`;
  }

  it('org-unit create forwards through the web admin orchestrator and is CSRF-gated', async () => {
    const cookie = adminCookie();
    const unitBody = JSON.stringify({ name: 'Team', slug: 'team', kind: 'business_entity', createdBy: { userId: 'u-1', kind: 'human', issuer: 'local' } });

    // A cookie-authenticated POST WITHOUT the CSRF header → 403 (never dispatched).
    const noCsrf = await raw({ method: 'POST', path: '/web/admin/org/units', headers: { cookie, 'content-type': 'application/json' }, body: unitBody });
    expect(noCsrf.status).toBe(403);

    // With the X-Wairon-Web header → 200; the unit is created.
    const create = await raw({
      method: 'POST',
      path: '/web/admin/org/units',
      headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body: unitBody,
    });
    expect(create.status).toBe(200);
    const unitId = JSON.parse(create.body).id as string;
    expect(unitId).toBeTruthy();

    // GET lists it back through the same route.
    const list = await raw({ method: 'GET', path: '/web/admin/org/units', headers: { cookie } });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).units.map((u: { id: string }) => u.id)).toContain(unitId);
  }, 20_000);

  it('a viewer session is refused org administration over HTTP (403, no data leak)', async () => {
    const viewer = createWebSession(dataDir, {
      id: '',
      subject: { userId: 'viewer', kind: 'human', issuer: 'local' },
      projects: ['demo'],
      createdAt: '',
      expiresAt: FUTURE(),
    });
    const cookie = `wairon_session=${viewer.id}`;
    expect((await raw({ method: 'GET', path: '/web/admin/org/units', headers: { cookie } })).status).toBe(403);
  }, 20_000);

  it('provider upsert + list forward through /web/admin/providers', async () => {
    const cookie = adminCookie();
    const put = await raw({
      method: 'POST',
      path: '/web/admin/providers',
      headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body: JSON.stringify({ id: PROVIDER_ID, providerType: 'oidc', enabled: true, updatedAt: '' }),
    });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.body).id).toBe(PROVIDER_ID);

    const list = await raw({ method: 'GET', path: '/web/admin/providers', headers: { cookie } });
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).providers.map((p: { id: string }) => p.id)).toContain(PROVIDER_ID);
  }, 20_000);

  it('POST /web/tokens mints a single-project agent token (self-service), CSRF-gated; /web/tokens/revoke revokes it', async () => {
    const cookie = adminCookie();
    createProjectRecord(dataDir, 'proj-a');
    const body = JSON.stringify({ projectId: 'proj-a', write: true });

    // A cookie-authenticated POST WITHOUT the CSRF header → 403 (never dispatched).
    const noCsrf = await raw({ method: 'POST', path: '/web/tokens', headers: { cookie, 'content-type': 'application/json' }, body });
    expect(noCsrf.status).toBe(403);

    // With the X-Wairon-Web header → 201 with the plaintext token (shown once).
    const mint = await raw({
      method: 'POST',
      path: '/web/tokens',
      headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body,
    });
    expect(mint.status).toBe(201);
    const token = JSON.parse(mint.body).token as string;
    expect(token).toMatch(/^wk_[0-9a-f]+$/);
    // The minted token is NARROWED to exactly the one project, never instance-wide.
    const p = authenticate(dataDir, token);
    expect(p.projects).toEqual(['proj-a']);
    expect(p.subject?.userId).toBe(adminSubject().userId);

    // Revoke it by id through the self-service route → 200, and it stops authenticating.
    const rec = findByTokenHash(dataDir, hashToken(token))!;
    const revoke = await raw({
      method: 'POST',
      path: '/web/tokens/revoke',
      headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body: JSON.stringify({ id: rec.id }),
    });
    expect(revoke.status).toBe(200);
    expect(authenticate(dataDir, token).authenticated).toBe(false);
  }, 20_000);

  it('GET /web/tokens lists the caller-owned tokens (no CSRF header needed) and redacts to the hashed token', async () => {
    const cookie = adminCookie();
    createProjectRecord(dataDir, 'proj-a');

    // Mint one token for this session (CSRF-gated POST).
    const mint = await raw({
      method: 'POST',
      path: '/web/tokens',
      headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body: JSON.stringify({ projectId: 'proj-a', write: false }),
    });
    expect(mint.status).toBe(201);
    const token = JSON.parse(mint.body).token as string;
    const rec = findByTokenHash(dataDir, hashToken(token))!;

    // GET is a read — it needs NO X-Wairon-Web header (only cookie POSTs are gated).
    const list = await raw({ method: 'GET', path: '/web/tokens', headers: { cookie } });
    expect(list.status).toBe(200);
    const tokens = JSON.parse(list.body).tokens as ApiKeyRecord[];
    const mine = tokens.find((t) => t.id === rec.id)!;
    expect(mine).toBeTruthy();
    // Owned by the caller, and redacted: hashed token present, plaintext absent.
    expect(mine.ownerSubject?.userId).toBe(adminSubject().userId);
    expect(mine.keyHash).toBeTruthy();
    expect(list.body).not.toContain(token);
  }, 20_000);
});

// ── Web project orchestrator (session-scoped project lifecycle) ──────────────
//
// listProjects is OWNED here (the admin list is master-only): it resolves the
// session to a Principal, computes the caller's project:read visible scopes over
// the org tree, and returns only the in-scope project records (an instance admin
// sees all). create/lock/promote/destroy are thin forwards to the admin
// orchestrator with the session AS the credential, so admin.ts's resolver
// authorization applies unchanged (a caller lacking permission is refused with
// AdminAuthError → 403).

describe('web project orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-webproject-'));
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

  function session(userId: string, projects: string[] = ['*']): string {
    return createWebSession(dataDir, {
      id: '',
      subject: { userId, kind: 'human', issuer: 'local' },
      projects,
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;
  }
  // Instance admin = the persisted boot-UUID subject identity, never an assignment.
  const superAdmin = (): string => {
    const inst = ensureInstanceIdentity(dataDir);
    return createWebSession(dataDir, {
      id: '',
      subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;
  };

  it('listProjects returns only the caller-visible projects; an instance admin sees all', () => {
    const unit = seedUnit(dataDir, 'team-a');
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-b');
    placeProject(dataDir, { id: '', projectId: 'proj-a', unitId: unit.id, role: 'owner', createdAt: '', createdBy: SUBJECT });

    // A reader assigned project:read over the PLACED proj-a sees exactly that.
    allow(dataDir, 'u-proj', 'project:read', 'project', 'proj-a');
    expect(webproject.listProjects(cfg, session('u-proj')).map((r) => r.id)).toEqual(['proj-a']);

    // The instance admin sees every hosted project — including the unplaced
    // proj-b, which no unit-scoped permission can reach.
    expect(webproject.listProjects(cfg, superAdmin()).map((r) => r.id).sort()).toEqual(['proj-a', 'proj-b']);

    // An absent/expired session resolves to no permissions → an empty list (never throws).
    expect(webproject.listProjects(cfg, 'ws_not-a-real-session')).toEqual([]);
  });

  it('listProjects unions read/write/admin — a WRITE-only user still sees (and can open) the project', () => {
    const unit = seedUnit(dataDir, 'team-a');
    createProjectRecord(dataDir, 'proj-a');
    placeProject(dataDir, { id: '', projectId: 'proj-a', unitId: unit.id, role: 'owner', createdAt: '', createdBy: SUBJECT });

    // project:write ONLY (no project:read) must still surface the project — a
    // user who can write specs has to be able to see the project and open its
    // canvas (the canvas gate reuses this listing).
    allow(dataDir, 'u-writer', 'project:write', 'project', 'proj-a');
    expect(webproject.listProjects(cfg, session('u-writer')).map((r) => r.id)).toEqual(['proj-a']);

    // project:admin-only likewise (the consumer-side capability union).
    allow(dataDir, 'u-adm', 'project:admin', 'project', 'proj-a');
    expect(webproject.listProjects(cfg, session('u-adm')).map((r) => r.id)).toEqual(['proj-a']);
  });

  it('listProjects expands a unit-scoped assignment across the org subtree (placed projects only)', () => {
    const eng = seedUnit(dataDir, 'eng');
    const web = seedUnit(dataDir, 'web', { parentId: eng.id });
    createProjectRecord(dataDir, 'web-proj');
    createProjectRecord(dataDir, 'sales-proj');
    placeProject(dataDir, { id: '', projectId: 'web-proj', unitId: web.id, role: 'owner', createdAt: '', createdBy: SUBJECT });

    // project:read assigned on the eng subtree covers the project placed in the
    // child unit — the sales-proj (unplaced) is in nobody's view.
    allow(dataDir, 'u-proj', 'project:read', 'unit', eng.id);
    expect(webproject.listProjects(cfg, session('u-proj')).map((r) => r.id)).toEqual(['web-proj']);
  });

  it('createProject forwards with the session: a permission-holder succeeds, a viewer is Forbidden (403)', () => {
    // The instance admin creates a project into the required unit (provisioned +
    // placed) — the create routes through the POLICY-AWARE initialization, so
    // the instance pack policy applies to web creates exactly as to MCP init.
    const unit = seedUnit(dataDir, 'team');
    const rec = webproject.createProject(cfg, superAdmin(), 'new-proj', unit.id);
    expect(rec.id).toBe('new-proj');
    expect(listProjectRecords(dataDir).some((r) => r.id === 'new-proj')).toBe(true);

    // A viewer (project:read only) holds no project:create authority → refused, nothing allocated.
    allow(dataDir, 'viewer', 'project:read', 'unit', unit.id);
    expect(() => webproject.createProject(cfg, session('viewer'), 'denied', unit.id)).toThrow(ForbiddenError);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'denied')).toBe(false);
  }, 20_000);

  it('destroyProject forwards with the session: a permission-holder succeeds, a viewer is denied (403)', () => {
    const unit = seedUnit(dataDir, 'team');
    webproject.createProject(cfg, superAdmin(), 'gone-soon', unit.id);
    webproject.destroyProject(cfg, superAdmin(), 'gone-soon');
    expect(listProjectRecords(dataDir).some((r) => r.id === 'gone-soon')).toBe(false);

    createProjectRecord(dataDir, 'demo');
    allow(dataDir, 'viewer', 'project:read', 'project', 'demo');
    expect(() => webproject.destroyProject(cfg, session('viewer'), 'demo')).toThrow(AdminAuthError);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'demo')).toBe(true);
  }, 20_000);

  it('lockProject forwards with the session: a viewer is denied (403); a permission-holder passes the gate', () => {
    createProjectRecord(dataDir, 'demo');
    allow(dataDir, 'viewer', 'project:read', 'project', 'demo');
    expect(() => webproject.lockProject(cfg, session('viewer'), 'demo')).toThrow(AdminAuthError);

    // The instance admin passes the authorization gate; the lock itself may fail
    // validate-as-complete, but that must NOT be an authorization denial.
    const unit = seedUnit(dataDir, 'team');
    webproject.createProject(cfg, superAdmin(), 'lockable', unit.id);
    let err: unknown;
    try {
      webproject.lockProject(cfg, superAdmin(), 'lockable');
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(AdminAuthError);
  }, 20_000);

  it('promoteProject forwards with the session: a permission-holder reaches the workflow (not-locked), a viewer is denied (403)', () => {
    const unit = seedUnit(dataDir, 'team');
    webproject.createProject(cfg, superAdmin(), 'promo', unit.id);
    expect(webproject.promoteProject(cfg, superAdmin(), 'promo').status).toBe('not-locked');

    createProjectRecord(dataDir, 'demo');
    allow(dataDir, 'viewer', 'project:read', 'project', 'demo');
    expect(() => webproject.promoteProject(cfg, session('viewer'), 'demo')).toThrow(AdminAuthError);
  }, 20_000);
});

// ── Web project routes over HTTP (routeData) ─────────────────────────────────

describe('web project routes over HTTP (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

  function raw(opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  function enableWebUi(): void {
    fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true, requireTls: false }));
  }
  function adminCookie(): string {
    const inst = ensureInstanceIdentity(dataDir);
    const s = createWebSession(dataDir, {
      id: '', subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'], createdAt: '', expiresAt: FUTURE(),
    });
    return `wairon_session=${s.id}`;
  }
  // The viewer's authority comes from allow() seeding in each test, never the session.
  function viewerCookie(): string {
    const s = createWebSession(dataDir, {
      id: '', subject: { userId: 'viewer', kind: 'human', issuer: 'local' },
      projects: ['demo'], createdAt: '', expiresAt: FUTURE(),
    });
    return `wairon_session=${s.id}`;
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-webproject-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    // webUiEnabled defaults OFF here so the 404 gate is exercised; enableWebUi() turns it on.
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('webUiEnabled=false (default): every /web/projects route answers 404', async () => {
    const cookie = adminCookie(); // a valid session exists, but the surface is gated off
    expect((await raw({ method: 'GET', path: '/web/projects', headers: { cookie } })).status).toBe(404);
    for (const p of ['/web/projects', '/web/projects/lock', '/web/projects/promote', '/web/projects/destroy']) {
      const r = await raw({ method: 'POST', path: p, headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' }, body: '{}' });
      expect(r.status).toBe(404);
    }
  });

  it('webUiEnabled=true: GET /web/projects returns the scoped list; create is CSRF-gated then created', async () => {
    enableWebUi();
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-b');
    const unit = seedUnit(dataDir, 'made-here-home');
    const cookie = adminCookie();

    // GET lists all for the instance admin (a read — no CSRF header needed).
    const list = await raw({ method: 'GET', path: '/web/projects', headers: { cookie } });
    expect(list.status).toBe(200);
    expect((JSON.parse(list.body).projects as { id: string }[]).map((p) => p.id).sort()).toEqual(['proj-a', 'proj-b']);

    // A cookie-authenticated POST WITHOUT the CSRF header → 403 (never dispatched).
    const noCsrf = await raw({ method: 'POST', path: '/web/projects', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'made-here', unitId: unit.id }) });
    expect(noCsrf.status).toBe(403);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'made-here')).toBe(false);

    // With the X-Wairon-Web header → 201 and the project is created into the unit.
    const created = await raw({
      method: 'POST',
      path: '/web/projects',
      headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body: JSON.stringify({ id: 'made-here', unitId: unit.id }),
    });
    expect(created.status).toBe(201);
    expect(JSON.parse(created.body).id).toBe('made-here');
    expect(listProjectRecords(dataDir).some((r) => r.id === 'made-here')).toBe(true);
    expect(listProjectPlacements(dataDir, 'made-here').map((p) => p.unitId)).toEqual([unit.id]);
  }, 20_000);

  it('a viewer is refused create/lock/promote/destroy over HTTP (403, resolver denial) but can still read the scoped list', async () => {
    enableWebUi();
    const unit = seedUnit(dataDir, 'team');
    createProjectRecord(dataDir, 'demo');
    placeProject(dataDir, { id: '', projectId: 'demo', unitId: unit.id, role: 'owner', createdAt: '', createdBy: SUBJECT });
    allow(dataDir, 'viewer', 'project:read', 'project', 'demo');
    const cookie = viewerCookie();
    const post = (p: string, body: string): Promise<{ status: number; body: string }> =>
      raw({ method: 'POST', path: p, headers: { cookie, 'content-type': 'application/json', 'x-wairon-web': '1' }, body });

    expect((await post('/web/projects', JSON.stringify({ id: 'x', unitId: unit.id }))).status).toBe(403);
    expect((await post('/web/projects/lock', JSON.stringify({ projectId: 'demo' }))).status).toBe(403);
    expect((await post('/web/projects/promote', JSON.stringify({ projectId: 'demo' }))).status).toBe(403);
    expect((await post('/web/projects/destroy', JSON.stringify({ id: 'demo' }))).status).toBe(403);
    // Nothing was created or destroyed by the refused mutations.
    expect(listProjectRecords(dataDir).some((r) => r.id === 'demo')).toBe(true);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'x')).toBe(false);

    // The viewer CAN read the scoped list (project:read on the placed demo → visible).
    const list = await raw({ method: 'GET', path: '/web/projects', headers: { cookie } });
    expect(list.status).toBe(200);
    expect((JSON.parse(list.body).projects as { id: string }[]).map((p) => p.id)).toEqual(['demo']);
  }, 20_000);
});
