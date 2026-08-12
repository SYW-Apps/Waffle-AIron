import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startDevSession, getCurrentContext, serveLegacyApp } from '../../src/server/web.js';
import {
  registerLocalDevProject,
  listProjectRecords,
  resolveProjectRoot,
} from '../../src/server/projects.js';
import {
  createWebSession,
  getWebSessionById,
  listWebSessionsBySubject,
} from '../../src/server/websessions.js';
import { routeData, initHostInstance } from '../../src/server/http.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import type { HostConfig, Principal } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// wairon dev — local single-project developer server (sdd_host).
//
// The dev server REUSES the whole hosted web pipeline (web_orchestrator,
// web_graph_orchestrator, the auth bridge, serveApp) pointed at the local cwd,
// auto-signed-in, single-project, with no login/tenancy chrome. These tests pin
// the security-critical gating: startDevSession refuses outside devMode and mints
// only a PROJECT-SCOPED session; the devMode HTTP path auto-logs-in on a cookieless
// GET; and the hosted (devMode off) path 404s /web/dev-login and sets no cookie.
// ---------------------------------------------------------------------------

function baseCfg(dataDir: string, over: Partial<HostConfig> = {}): HostConfig {
  return { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true, ...over };
}

// ── startDevSession + getCurrentContext (unit) ───────────────────────────────

describe('local dev session (startDevSession) (sdd_host)', () => {
  let dataDir: string;
  let devCfg: HostConfig;
  let hostedCfg: HostConfig;
  let devUserId: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dev-unit-'));
    devCfg = baseCfg(dataDir, { authEnabled: false, devMode: true });
    hostedCfg = baseCfg(dataDir);
    // The lifecycle init entrypoint seeds the boot-reserved built-in subject
    // UUIDs; `wairon dev` always runs it before serving.
    devUserId = ensureInstanceIdentity(dataDir).localDevUserId;
  });
  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('refuses to mint outside local developer mode (devMode false → throws, mints nothing)', () => {
    expect(() => startDevSession(hostedCfg)).toThrow(/dev session is only available under wairon dev/i);
    expect(listWebSessionsBySubject(dataDir, devUserId)).toHaveLength(0);
  });

  it('mints a project-scoped local session and REUSES it on a second call (same id, no churn)', () => {
    const id1 = startDevSession(devCfg);
    expect(id1).toMatch(/^ws_[0-9a-f]+$/);

    const id2 = startDevSession(devCfg);
    expect(id2).toBe(id1);
    // Exactly one dev session persisted — reuse, not churn.
    expect(listWebSessionsBySubject(dataDir, devUserId)).toHaveLength(1);

    const s = getWebSessionById(dataDir, id1)!;
    // The subject is the PERSISTED boot-reserved local-developer UUID — never a
    // guessable literal like 'local-dev'.
    expect(s.subject).toEqual({ userId: devUserId, kind: 'human', issuer: 'local', displayName: 'Local developer' });
    // NARROWED to the one local project — never instance-wide '*'. The session
    // stores NO permissions; they resolve live from the subject identity.
    expect(s.projects).toEqual(['local']);
    expect(Date.parse(s.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('never hands back an EXPIRED dev session — it prunes it and mints a fresh live one', () => {
    // A dev session that aged out (the TTL is 30 days, so this is what a project
    // picked back up weeks later looks like). Reusing it would return a dead
    // credential and strand the dev UI on a login screen devMode configures no
    // login method for.
    const dead = createWebSession(dataDir, {
      id: '',
      subject: { userId: devUserId, kind: 'human', issuer: 'local', displayName: 'Local developer' },
      projects: ['local'],
      createdAt: '',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const id = startDevSession(devCfg);

    expect(id).not.toBe(dead.id);
    expect(getWebSessionById(dataDir, dead.id)).toBeNull(); // pruned, not left to rot
    const live = listWebSessionsBySubject(dataDir, devUserId);
    expect(live).toHaveLength(1);
    expect(live[0].id).toBe(id);
    expect(Date.parse(live[0].expiresAt)).toBeGreaterThan(Date.now());
  });

  it('getCurrentContext returns local:true under devMode, as the instance-admin dev subject', () => {
    const id = startDevSession(devCfg);
    const ctx = getCurrentContext(devCfg, id);
    expect(ctx.local).toBe(true);
    // The local-developer subject IS a boot-reserved instance admin (full local access).
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.subject.userId).toBe(devUserId);
  });

  it('getCurrentContext leaves local falsy when the server is NOT in dev mode', () => {
    const s = createWebSession(dataDir, {
      id: '',
      subject: { userId: 'u-1', kind: 'human', issuer: 'local' },
      projects: ['proj-a'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const ctx = getCurrentContext(hostedCfg, s.id);
    expect(ctx.local).toBeFalsy();
  });
});

// ── registerLocalDevProject (projects registry) ──────────────────────────────

describe('registerLocalDevProject (sdd_host)', () => {
  let dataDir: string;
  let cwd: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dev-proj-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dev-cwd-'));
  });
  afterEach(() => {
    for (const d of [dataDir, cwd]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
    }
  });

  it('persists a local record at the given cwd (not under dataDir/projects); resolveProjectRoot returns it', () => {
    const rec = registerLocalDevProject(dataDir, 'local', cwd);
    expect(rec.id).toBe('local');
    expect(rec.rootPath).toBe(cwd);
    expect(rec.status).toBe('active');
    // The rootPath is the arbitrary cwd — NOT forced under <dataDir>/projects.
    expect(rec.rootPath.startsWith(path.join(dataDir, 'projects'))).toBe(false);

    // Persisted, and idempotent (a second call upserts — no duplicate, createdAt preserved).
    expect(listProjectRecords(dataDir).filter((r) => r.id === 'local')).toHaveLength(1);
    const again = registerLocalDevProject(dataDir, 'local', cwd);
    expect(again.createdAt).toBe(rec.createdAt);
    expect(listProjectRecords(dataDir).filter((r) => r.id === 'local')).toHaveLength(1);

    // resolveProjectRoot resolves 'local' → the cwd for a 'local'-scoped principal…
    const principal: Principal = { tokenId: '', role: 'editor', projects: ['local'], authenticated: true };
    expect(resolveProjectRoot(dataDir, principal, 'local')).toBe(cwd);
    // …and without a selector for that single-project principal.
    expect(resolveProjectRoot(dataDir, principal)).toBe(cwd);
  });
});

// ── dev-mode HTTP wiring (routeData) ─────────────────────────────────────────

describe('dev-mode HTTP wiring (routeData) (sdd_host)', () => {
  let dataDir: string;
  let server: http.Server | undefined;
  let port: number;
  const savedEnv = { ...process.env };

  function startServer(cfg: HostConfig): Promise<void> {
    // Mirror startHostServer: the lifecycle init entrypoint runs before the
    // listener binds (seeds the instance identity; devMode also seeds the
    // synthetic 'local' organization unit).
    initHostInstance(cfg);
    server = http.createServer((req, res) => routeData(cfg, req, res));
    return new Promise((resolve) =>
      server!.listen(0, '127.0.0.1', () => {
        port = (server!.address() as AddressInfo).port;
        resolve();
      }),
    );
  }

  interface RawResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }
  function raw(opts: { method: string; path: string; headers?: Record<string, string> }): Promise<RawResponse> {
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
      req.end();
    });
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dev-http-'));
  });
  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** A dev cfg with NO exposurePolicy at all — proving devMode ALONE forces the web UI on. */
  function devCfg(): HostConfig {
    return baseCfg(dataDir, { authEnabled: false, devMode: true });
  }

  it('devMode: a cookieless GET / establishes the dev session (Set-Cookie ws_) and serves the reused client', async () => {
    await startServer(devCfg());

    const shell = await raw({ method: 'GET', path: '/' });
    expect(shell.status).toBe(200);
    expect(shell.headers['content-type']).toMatch(/text\/html/);
    expect(shell.body).toContain('/web/context'); // the reused client app shell

    const setCookie = String(shell.headers['set-cookie']?.[0] ?? '');
    expect(setCookie).toMatch(/^wairon_session=ws_[0-9a-f]+/);
    const sessionId = /wairon_session=(ws_[0-9a-f]+)/.exec(setCookie)![1];

    // Exactly one local-dev session was auto-established (the seeded UUID subject).
    const devUserId = ensureInstanceIdentity(dataDir).localDevUserId;
    expect(listWebSessionsBySubject(dataDir, devUserId)).toHaveLength(1);

    // The cookie authenticates /web/context, which is signed-in and LOCAL.
    const ctx = await raw({ method: 'GET', path: '/web/context', headers: { cookie: `wairon_session=${sessionId}` } });
    expect(ctx.status).toBe(200);
    const parsed = JSON.parse(ctx.body);
    expect(parsed.local).toBe(true);
    expect(parsed.subject.userId).toBe(devUserId);
    expect(parsed.isAdmin).toBe(true); // the dev subject is the boot-reserved instance admin
  });

  it('devMode: a cookieless GET /web/context auto-logs-in inline (the client never sees a 401)', async () => {
    await startServer(devCfg());
    const ctx = await raw({ method: 'GET', path: '/web/context' });
    expect(ctx.status).toBe(200); // NOT 401
    expect(String(ctx.headers['set-cookie']?.[0] ?? '')).toMatch(/^wairon_session=ws_/);
    expect(JSON.parse(ctx.body).local).toBe(true);
  });

  it('devMode: a GET carrying a STALE session cookie is RE-ESTABLISHED, not left unauthenticated', async () => {
    // Session cookies are not port-scoped, so the browser can present a
    // wairon_session from another project's dev server, a hosted instance on the
    // same host, or an ephemeral dev data dir that was cleaned. Trusting it would
    // 401 /web/context and strand the dev UI on a login screen that devMode
    // configures no login method for — so the dev server overrides it.
    await startServer(devCfg());
    const stale = 'wairon_session=ws_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

    const ctx = await raw({ method: 'GET', path: '/web/context', headers: { cookie: stale } });
    expect(ctx.status).toBe(200); // NOT 401
    const setCookie = String(ctx.headers['set-cookie']?.[0] ?? '');
    expect(setCookie).toMatch(/^wairon_session=ws_[0-9a-f]+/);
    expect(setCookie).not.toContain('deadbeef'); // the live dev session, not the stale id
    expect(JSON.parse(ctx.body).local).toBe(true);

    // The app shell gets the same repair, so a hard refresh recovers on its own.
    const shell = await raw({ method: 'GET', path: '/', headers: { cookie: stale } });
    expect(shell.status).toBe(200);
    expect(String(shell.headers['set-cookie']?.[0] ?? '')).toMatch(/^wairon_session=ws_[0-9a-f]+/);

    // One dev session throughout — the repair reuses, it does not churn.
    expect(listWebSessionsBySubject(dataDir, ensureInstanceIdentity(dataDir).localDevUserId)).toHaveLength(1);
  });

  it('devMode: a GET already carrying the LIVE dev cookie re-sends no redundant Set-Cookie', async () => {
    await startServer(devCfg());
    const first = await raw({ method: 'GET', path: '/web/context' });
    const sessionId = /wairon_session=(ws_[0-9a-f]+)/.exec(String(first.headers['set-cookie']?.[0] ?? ''))![1];

    const again = await raw({ method: 'GET', path: '/web/context', headers: { cookie: `wairon_session=${sessionId}` } });
    expect(again.status).toBe(200);
    expect(again.headers['set-cookie']).toBeUndefined();
  });

  it('devMode: GET /web/dev-login mints/reuses the session, sets the cookie, and 302s to /', async () => {
    await startServer(devCfg());
    const res = await raw({ method: 'GET', path: '/web/dev-login' });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/');
    expect(String(res.headers['set-cookie']?.[0] ?? '')).toMatch(/^wairon_session=ws_/);
    expect(listWebSessionsBySubject(dataDir, ensureInstanceIdentity(dataDir).localDevUserId)).toHaveLength(1);
  });

  it('HOSTED (devMode off): /web/dev-login 404s and NO session cookie is ever set — even with the web UI enabled', async () => {
    // Enable the normal hosted web UI, so this isolates the dev-only behavior (not the opt-in gate).
    fs.writeFileSync(
      path.join(dataDir, 'exposure-policy.json'),
      JSON.stringify({ webUiEnabled: true, requireTls: false }),
    );
    await startServer(baseCfg(dataDir)); // devMode undefined

    const dl = await raw({ method: 'GET', path: '/web/dev-login' });
    expect(dl.status).toBe(404);
    expect(dl.headers['set-cookie']).toBeUndefined();

    // The hosted app shell still serves, but with NO auto-login cookie.
    const shell = await raw({ method: 'GET', path: '/' });
    expect(shell.status).toBe(200);
    expect(shell.headers['set-cookie']).toBeUndefined();

    // A cookieless /web/context is a normal 401 in hosted mode (no auto-session).
    const ctx = await raw({ method: 'GET', path: '/web/context' });
    expect(ctx.status).toBe(401);
    expect(ctx.headers['set-cookie']).toBeUndefined();

    // And an UNKNOWN session cookie stays a plain 401: the dev repair that
    // overrides a stale cookie is devMode-only and never mints here.
    const stale = await raw({
      method: 'GET',
      path: '/web/context',
      headers: { cookie: 'wairon_session=ws_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });
    expect(stale.status).toBe(401);
    expect(stale.headers['set-cookie']).toBeUndefined();

    // Nothing was minted the whole time.
    expect(listWebSessionsBySubject(dataDir, ensureInstanceIdentity(dataDir).localDevUserId)).toHaveLength(0);
  });
});

// ── the dev UI reuses the ONE web client (serveApp) ──────────────────────────

describe('dev mode reuses the single web client (serveLegacyApp) (sdd_host)', () => {
  const html = serveLegacyApp('/');

  it('is exactly one self-contained document — the client is reused, not forked', () => {
    expect((html.match(/<!doctype html/gi) || []).length).toBe(1);
    expect((html.match(/<\/html>/gi) || []).length).toBe(1);
    expect((html.match(/<script/gi) || []).length).toBe(1);
    expect((html.match(/<style/gi) || []).length).toBe(1);
  });

  it('drives the local-mode chrome from the fetched context (ctx.local) inside the ONE client', () => {
    expect(html).toContain('ctx.local'); // the conditional dev chrome, not a second UI
    // The same reused endpoints remain present (no forked client). The dev canvas is
    // the SAME embedded canvas route the hosted shell uses, scoped to the local project.
    expect(html).toContain('/web/context');
    expect(html).toContain('/web/canvas');
  });

  it('references no external http(s):// assets — everything stays inline', () => {
    expect(html).not.toMatch(/https?:\/\//i);
  });
});
