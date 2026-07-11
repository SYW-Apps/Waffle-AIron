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
  serveApp,
} from '../../src/server/web.js';
import { signSsoState, verifySsoState } from '../../src/server/auth.js';
import { ForbiddenError, UnauthenticatedError } from '../../src/server/identity.js';
import { upsertIdentityProviderRecord } from '../../src/server/policy.js';
import { findUserByExternalSubject, setUserStatus } from '../../src/server/users.js';
import {
  createWebSession,
  getWebSessionById,
  listWebSessionsBySubject,
} from '../../src/server/websessions.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { queryAuditEvents as auditQuery } from '../../src/server/audit.js';
import { upsertOrganizationUnit, placeProject } from '../../src/server/organization.js';
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
  ProjectGrant,
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
function stubClaims(claims: Record<string, unknown>): void {
  tokenResponse = () => ({
    status: 200,
    json: { access_token: 'ACCESS', id_token: makeIdToken(claims), token_type: 'Bearer' },
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

  it('startSignIn returns a provider authorization URL for an enabled provider (info audit)', () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const { url: authUrl } = startSignIn(cfg, PROVIDER_ID, 'https://app.example/web/sso/callback');
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

  it('startSignIn rejects an unknown and a disabled provider', () => {
    expect(() => startSignIn(cfg, 'ghost', 'https://app.example/cb')).toThrow(/unknown or disabled/i);
    upsertIdentityProviderRecord(dataDir, providerConfig({ enabled: false }));
    expect(() => startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb')).toThrow(/unknown or disabled/i);
  });

  it('completeSignIn (first login): provisions an active user with empty grants and creates a resolvable WebSession (no token minted)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const { state, nonce } = started(startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));

    const sessionId = await completeSignIn(cfg, state, 'auth-code-1', nonce);
    expect(sessionId).toMatch(/^ws_[0-9a-f]+$/);

    // The user was provisioned: active, EMPTY grants, id = the resolved subject id.
    const user = findUserByExternalSubject(dataDir, PROVIDER_ID, 'ext-1');
    expect(user).not.toBeNull();
    expect(user!.id).toBe(`sso:${PROVIDER_ID}:ext-1`);
    expect(user!.status).toBe('active');
    expect(user!.grants).toEqual([]);

    // A resolvable WebSession was created (not a bearer token record).
    const session = getWebSessionById(dataDir, sessionId);
    expect(session).not.toBeNull();
    expect(session!.subject.userId).toBe(`sso:${PROVIDER_ID}:ext-1`);
    expect(session!.grants).toEqual([]);
    expect(session!.providerId).toBe(PROVIDER_ID);
    expect(Date.parse(session!.expiresAt)).toBeGreaterThan(Date.now());

    // A security-level web.signin audit event exists.
    const events = auditQuery(dataDir, { action: 'web.signin' });
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('security');
  });

  it('completeSignIn refuses a returning user who has been deactivated (creates no new session)', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const f1 = started(startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    await completeSignIn(cfg, f1.state, 'code-1', f1.nonce);

    setUserStatus(dataDir, `sso:${PROVIDER_ID}:ext-1`, 'suspended');

    const f2 = started(startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    await expect(completeSignIn(cfg, f2.state, 'code-2', f2.nonce)).rejects.toThrow(ForbiddenError);

    // Only the first (pre-deactivation) session exists; the refused login minted nothing.
    expect(listWebSessionsBySubject(dataDir, `sso:${PROVIDER_ID}:ext-1`)).toHaveLength(1);
  });

  it('completeSignIn does NOT revoke prior sessions (multi-device): two logins yield two live sessions', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const fA = started(startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    const idA = await completeSignIn(cfg, fA.state, 'c1', fA.nonce);
    const fB = started(startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));
    const idB = await completeSignIn(cfg, fB.state, 'c2', fB.nonce);

    expect(idA).not.toBe(idB);
    expect(getWebSessionById(dataDir, idA)).not.toBeNull();
    expect(getWebSessionById(dataDir, idB)).not.toBeNull();
    expect(listWebSessionsBySubject(dataDir, `sso:${PROVIDER_ID}:ext-1`)).toHaveLength(2);
  });

  it('SECURITY: completeSignIn rejects a login-CSRF callback whose nonce cookie is absent or wrong', async () => {
    upsertIdentityProviderRecord(dataDir, providerConfig());
    const { state, nonce } = started(startSignIn(cfg, PROVIDER_ID, 'https://app.example/cb'));

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
      grants: [],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      ...over,
    });
  }

  it('getCurrentContext derives the capability flags and touches lastSeenAt', () => {
    const grants: ProjectGrant[] = [
      { projectId: 'proj-a', permissions: ['mcp:read'] },
      { projectId: 'proj-b', permissions: ['mcp:write'], orgUnitId: 'unit-1' },
    ];
    const s = mkSession({ grants, lastSeenAt: '2000-01-01T00:00:00.000Z' });

    const ctx = getCurrentContext(cfg, s.id);
    expect(ctx.subject.userId).toBe('u-1');
    expect(ctx.isAdmin).toBe(false);
    expect(ctx.canWriteProjects).toBe(true); // proj-b carries mcp:write
    expect(ctx.visibleProjectIds.sort()).toEqual(['proj-a', 'proj-b']);
    expect(ctx.visibleUnitIds).toEqual(['unit-1']);

    // lastSeenAt was advanced away from the seeded (old) value.
    const after = getWebSessionById(dataDir, s.id)!.lastSeenAt!;
    expect(after).not.toBe('2000-01-01T00:00:00.000Z');
    expect(Date.parse(after)).toBeGreaterThan(Date.parse('2000-01-01T00:00:00.000Z'));
  });

  it('getCurrentContext marks an instance-wide grant as admin (no specific project/unit ids)', () => {
    const s = mkSession({ grants: [{ projectId: '*', permissions: ['*'] }] });
    const ctx = getCurrentContext(cfg, s.id);
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.canWriteProjects).toBe(true);
    expect(ctx.visibleProjectIds).toEqual([]);
    expect(ctx.visibleUnitIds).toEqual([]);
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

  function session(grants: ProjectGrant[], userId = 'u-1'): WebSession {
    return createWebSession(dataDir, {
      id: '',
      subject: { userId, kind: 'human', issuer: 'local' },
      grants,
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
    const s = session([{ projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'] }]);

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
    const s = session([{ projectId: 'proj-a', permissions: ['mcp:read'] }]);
    expect(() => getGraph(cfg, s.id, 'project', 'proj-b', 3)).toThrow(ForbiddenError);
  });

  it('landscape tier: reshapes the scoped landscape and level-filters (scope instance)', () => {
    upsertOrganizationUnit(dataDir, { id: 'unit-1', name: 'Team One', kind: 'team', status: 'active', createdAt: now, createdBy });
    createProjectRecord(dataDir, 'proj-a');
    placeProject(dataDir, { id: 'pl-1', projectId: 'proj-a', unitId: 'unit-1', role: 'owner', createdAt: now, createdBy });
    replacePublicSurfaceSnapshot(dataDir, {
      projectId: 'proj-a',
      stateId: 'sha256:abc',
      systemName: 'ProjA',
      interfaces: [{ id: 'iface-1', name: 'Public API', type: 'REST', audience: 'public', methods: ['ping'], details: '' }],
      exportedAt: '',
    });
    const admin = session([{ projectId: '*', permissions: ['*'] }], 'admin');

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
    const s = session([{ projectId: '*', permissions: ['*'] }]);
    expect(() => getGraph(cfg, s.id, 'galaxy', '', 0)).toThrow(/unsupported graph tier/i);
  });

  it('rejects an absent/expired session before any tier work', () => {
    expect(() => getGraph(cfg, 'ws_missing', 'landscape', '', 0)).toThrow(UnauthenticatedError);
  });

  // ── getProjectCanvas: the REAL renderCanvasHtml canvas, scoped per project ──

  it('getProjectCanvas returns the real interactive canvas HTML for an authorized project', () => {
    const rec = createProjectRecord(dataDir, 'proj-a');
    seedProjectTree(rec.rootPath);
    const s = session([{ projectId: 'proj-a', permissions: ['mcp:read'] }]);

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
    const s = session([{ projectId: 'proj-a', permissions: ['mcp:read'] }]);
    expect(() => getProjectCanvas(cfg, s.id, 'proj-b')).toThrow(ForbiddenError);
  });

  it('getProjectCanvas rejects an absent/expired session before any project work', () => {
    expect(() => getProjectCanvas(cfg, 'ws_missing', 'proj-a')).toThrow(UnauthenticatedError);
  });
});

// ── Web portal: client app shell (serveApp, Phase 7 wave 4) ──────────────────

describe('web portal client app shell (sdd_host)', () => {
  const html = serveApp('/');

  it('returns exactly one self-contained HTML document', () => {
    expect(html.trimStart().slice(0, 15).toLowerCase()).toContain('<!doctype html');
    // A single document — not concatenated shells.
    expect((html.match(/<!doctype html/gi) || []).length).toBe(1);
    expect((html.match(/<\/html>/gi) || []).length).toBe(1);
    // Inline only: exactly one <script> and one <style>, both in-document.
    expect((html.match(/<script/gi) || []).length).toBe(1);
    expect((html.match(/<style/gi) || []).length).toBe(1);
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
    // No trace of the hand-rolled layout/renderer, the level-of-detail slider, or
    // the project-view use of /web/graph — the iframe IS the canvas now.
    expect(html).not.toContain('data-tier');
    expect(html).not.toContain('data-node');
    expect(html).not.toContain('data-toggle');
    expect(html).not.toContain('levelRange');
    expect(html).not.toContain('renderGraph');
    expect(html).not.toContain('borderPt');
    expect(html).not.toContain('/web/graph');
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
      grants: [],
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
    const s = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
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
    const s = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
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
    const record: ApiKeyRecord = {
      id: 'bearer-1',
      keyHash: hashToken(bearer),
      role: 'editor',
      projects: ['proj-a'],
      grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
      createdAt: new Date().toISOString(),
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

    const s = createWebSession(dataDir, {
      id: '',
      subject: SUBJECT,
      grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
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
});
