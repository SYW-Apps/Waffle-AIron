import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeData } from '../../src/server/http.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { createWebSession } from '../../src/server/websessions.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { upsertUser, getUserById } from '../../src/server/users.js';
import { listProjectPlacements, getOrganizationUnit } from '../../src/server/organization.js';
import { resolveSharedView } from '../../src/server/shareaccess.js';
import * as projectops from '../../src/server/projectops.js';
import { initializeProject } from '../../src/server/projectlifecycle.js';
import { allow, createPlacedProject, mintUserToken, seedUnit } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Web portal route characterization (sdd_host).
//
// Pins, over a real loopback listener wired to routeData, what the web_portal
// routes that had no HTTP-level test do TODAY: status, JSON envelope, and — the
// point of the file — that the body fields and query params each route decodes
// actually reach the orchestrator. Wherever possible a write is read back through
// its sibling read (create → list, bind → unbind), so a decoder that passed
// undefined/'' for a field fails here rather than silently.
//
// These are CHARACTERIZATION tests: they pin current behaviour, including the
// odd corners (flagged inline as "current behaviour"), so a refactor that moves
// the decoding out of the handlers cannot change it unnoticed.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

/** A declarative pack carrying one profile, so the profile catalog and the
 *  adoptable catalog have a real id to surface. File stem 'acme', canonical
 *  manifest name 'acme-doctrine'. */
const ACME_PACK = ['name: acme-doctrine', 'profiles:', '  ddd:', '    family: backend-like', ''].join('\n');

/** A second, project-local pack. */
const TENANT_PACK = ['name: tenant-doctrine', 'profiles:', '  hexagonal:', '    family: backend-like', ''].join('\n');

const PROJECT_YAML = [
  'schemaVersion: "1.0.0"',
  'name: demo',
  'projectType: backend',
  'targets:',
  '  - type: claude',
  '    outputDir: .claude/agents',
  '    enabled: true',
  'rules:',
  '  noOverlappingOwnership: true',
  '  requireOwnedPaths: true',
  '  metaAgentTags: [meta]',
  '  enforceReproducibility: true',
  '  generateComponentImplementers: true',
  '  sddRuleSeverity: {}',
  'paths:',
  '  specsDir: .wai/specs',
  'createdAt: "2026-07-04T00:00:00.000Z"',
  'updatedAt: "2026-07-04T00:00:00.000Z"',
  '',
].join('\n');

const INDEX_YAML = [
  'schemaVersion: "1.0.0"',
  'name: demo',
  'vision: Seed project for the web route characterization',
  'boundaries: []',
  'globalRequirements: []',
  'createdAt: "2026-07-04T00:00:00.000Z"',
  'updatedAt: "2026-07-04T00:00:00.000Z"',
  '',
].join('\n');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A local bare "remote" seeded with a minimal wairon project on main. */
function seedRemote(base: string): string {
  const remote = path.join(base, 'remote.git');
  fs.mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '-q', '-b', 'main', '.'], remote);
  const seed = path.join(base, 'seed');
  git(['clone', '-q', remote, seed], base);
  fs.mkdirSync(path.join(seed, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.wai', 'project.yaml'), PROJECT_YAML);
  fs.writeFileSync(path.join(seed, '.wai', 'specs', '.index.yaml'), INDEX_YAML);
  git(['-c', 'user.email=s@x', '-c', 'user.name=seed', 'add', '-A'], seed);
  git(['-c', 'user.email=s@x', '-c', 'user.name=seed', 'commit', '-qm', 'init'], seed);
  git(['branch', '-M', 'main'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  return remote;
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

describe('web portal routes over HTTP (characterization, sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

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

  /** GET with an optional session cookie. */
  const get = (p: string, cookie?: string): Promise<RawResponse> =>
    raw({ method: 'GET', path: p, headers: cookie ? { cookie } : {} });

  /** A same-origin JSON POST: the session cookie (if any) plus the CSRF header. */
  const post = (p: string, body: unknown, cookie?: string): Promise<RawResponse> =>
    raw({
      method: 'POST',
      path: p,
      headers: {
        'content-type': 'application/json',
        'x-wairon-web': '1',
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });

  const json = (r: RawResponse): any => JSON.parse(r.body); // eslint-disable-line @typescript-eslint/no-explicit-any

  /** A signed-in session for the built-in super-admin (instance admin). */
  function adminCookie(): string {
    const inst = ensureInstanceIdentity(dataDir);
    const s = createWebSession(dataDir, {
      id: '',
      subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    });
    return `wairon_session=${s.id}`;
  }

  /** A signed-in session for an ordinary (non-admin) user; its authority comes
   *  only from the assignment grid (allow()). */
  function sessionCookieFor(userId: string): string {
    const s = createWebSession(dataDir, {
      id: '',
      subject: { userId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    });
    return `wairon_session=${s.id}`;
  }

  /** A signed-in session for a user holding no grant anywhere. */
  const viewerCookie = (): string => sessionCookieFor('viewer');

  beforeEach(async () => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-web-routes-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    process.env.WAIRON_PACKS_DIR = path.join(dataDir, 'packs');
    // Isolate the image tier so a populated /opt/wairon/packs never leaks in.
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(dataDir, 'image-packs');
    process.env.WAIRON_GIT_NAME = 'wairon-bot';
    process.env.WAIRON_GIT_EMAIL = 'bot@localhost';
    delete process.env.WAIRON_NOTION_TOKEN;
    delete process.env.WAIRON_MIRO_TOKEN;
    delete process.env.WAIRON_GIT_TOKEN;
    fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true, requireTls: false }));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── App shell + graph ──────────────────────────────────────────────────────

  describe('GET / and GET /web/graph', () => {
    it('GET / serves the app document as text/html without a session', async () => {
      const r = await get('/');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(r.body.trimStart().slice(0, 15).toLowerCase()).toContain('<!doctype html');
    });

    it('GET /web/graph defaults to the landscape tier and decodes tier / projectId', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');

      const landscape = await get('/web/graph', cookie);
      expect(landscape.status).toBe(200);
      expect(landscape.headers['content-type']).toMatch(/application\/json/);
      const lg = json(landscape);
      expect(Array.isArray(lg.nodes)).toBe(true);
      expect(Array.isArray(lg.edges)).toBe(true);
      expect(lg).toMatchObject({ tier: 'landscape', level: 0, scope: 'instance' });
      // The landscape carries the placed project.
      expect(JSON.stringify(lg)).toContain('demo');

      // level is decoded (Number(); a non-number becomes NaN, serialized as null).
      expect(json(await get('/web/graph?tier=landscape&level=2', cookie)).level).toBe(2);
      expect(json(await get('/web/graph?tier=landscape&level=abc', cookie)).level).toBeNull();

      // tier is decoded: an unknown tier is refused (400) with the tier error.
      const bogus = await get('/web/graph?tier=bogus', cookie);
      expect(bogus.status).toBe(400);
      expect(json(bogus).error).toMatch(/unsupported graph tier/i);

      // projectId is decoded: the project tier answers for a real project and is
      // refused (403, no existence leak) for an unknown one.
      const project = await get('/web/graph?tier=project&projectId=demo&level=3', cookie);
      expect(project.status).toBe(200);
      expect(Array.isArray(json(project).nodes)).toBe(true);
      const ghost = await get('/web/graph?tier=project&projectId=ghost&level=3', cookie);
      expect(ghost.status).toBe(403);
      expect(json(ghost)).toEqual({ error: 'forbidden' });
    });

    it('GET /web/graph without a session is 401', async () => {
      const r = await get('/web/graph');
      expect(r.status).toBe(401);
      expect(json(r)).toEqual({ error: 'unauthorized' });
    });
  });

  // ── Canvas model + API explorer ────────────────────────────────────────────

  describe('GET /web/canvas-model and GET /web/openapi', () => {
    it('GET /web/canvas-model decodes projectId: the model for a real project, 403 for an unknown one', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');

      const model = await get('/web/canvas-model?projectId=demo', cookie);
      expect(model.status).toBe(200);
      expect(model.headers['content-type']).toMatch(/application\/json/);
      expect(typeof json(model)).toBe('object');

      // No existence leak: an unknown project is refused exactly like a forbidden one.
      const ghost = await get('/web/canvas-model?projectId=ghost', cookie);
      expect(ghost.status).toBe(403);
      expect(json(ghost)).toEqual({ error: 'forbidden' });
    });

    it('GET /web/canvas-model without a session is 401', async () => {
      const r = await get('/web/canvas-model?projectId=demo');
      expect(r.status).toBe(401);
      expect(json(r)).toEqual({ error: 'unauthorized' });
    });

    it('GET /web/openapi decodes projectId and spec: an HTML page for a real project, 403 for an unknown one', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');

      const page = await get('/web/openapi?projectId=demo', cookie);
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');

      // A spec the project does not publish lands on the index page, never on a
      // different API and never on an empty explorer.
      const unknownSpec = await get('/web/openapi?projectId=demo&spec=nope', cookie);
      expect(unknownSpec.status).toBe(200);
      expect(unknownSpec.headers['content-type']).toBe('text/html; charset=utf-8');

      const ghost = await get('/web/openapi?projectId=ghost', cookie);
      expect(ghost.status).toBe(403);
      expect(json(ghost)).toEqual({ error: 'forbidden' });
    });

    it('GET /web/openapi without a session is 401', async () => {
      const r = await get('/web/openapi?projectId=demo');
      expect(r.status).toBe(401);
      expect(json(r)).toEqual({ error: 'unauthorized' });
    });
  });

  // ── Secrets + org-unit removal ─────────────────────────────────────────────

  describe('/web/admin/secrets and /web/admin/org/units/remove', () => {
    it('GET /web/admin/secrets lists the key names (never the values) set through POST', async () => {
      const cookie = adminCookie();
      const before = await get('/web/admin/secrets', cookie);
      expect(before.status).toBe(200);
      expect(json(before).refs).not.toContain('git-token');

      expect((await post('/web/admin/secrets', { key: 'git-token', value: 'pat-value-123' }, cookie)).status).toBe(200);
      const after = await get('/web/admin/secrets', cookie);
      expect(after.status).toBe(200);
      expect(json(after)).toEqual({ refs: expect.arrayContaining(['git-token']) });
      expect(after.body).not.toContain('pat-value-123');
    });

    it('POST /web/admin/org/units/remove decodes unitId and the disposition (cascade / alternative / migrate)', async () => {
      const cookie = adminCookie();

      // cascade: the unit disappears from the listing.
      seedUnit(dataDir, 'doomed');
      const cascade = await post('/web/admin/org/units/remove', { unitId: 'doomed', disposition: { kind: 'cascade' } }, cookie);
      expect(cascade.status).toBe(200);
      expect(json(cascade)).toEqual({ ok: true });
      const units = json(await get('/web/admin/org/units', cookie)).units.map((u: { id: string }) => u.id);
      expect(units).not.toContain('doomed');

      // alternative: disposition.newSlug / newName reach the orchestrator — the
      // replacement unit exists under that slug and name.
      seedUnit(dataDir, 'oldname');
      const alt = await post(
        '/web/admin/org/units/remove',
        { unitId: 'oldname', disposition: { kind: 'alternative', newSlug: 'newname', newName: 'New Name' } },
        cookie,
      );
      expect(alt.status).toBe(200);
      expect(getOrganizationUnit(dataDir, 'oldname')).toBeNull();
      expect(getOrganizationUnit(dataDir, 'newname')?.name).toBe('New Name');

      // migrate: disposition.targetUnitId reaches the orchestrator — the project
      // placed in the removed unit now sits in the target.
      const src = seedUnit(dataDir, 'src');
      seedUnit(dataDir, 'dst');
      createPlacedProject(cfg, MASTER, 'moved', src);
      const mig = await post(
        '/web/admin/org/units/remove',
        { unitId: 'src', disposition: { kind: 'migrate', targetUnitId: 'dst' } },
        cookie,
      );
      expect(mig.status).toBe(200);
      expect(listProjectPlacements(dataDir, 'moved').map((p) => p.unitId)).toEqual(['dst']);
    });

    it('POST /web/admin/org/units/remove with an unknown unit is 404; a missing disposition is 400', async () => {
      const cookie = adminCookie();
      const unknown = await post('/web/admin/org/units/remove', { unitId: 'nope', disposition: { kind: 'cascade' } }, cookie);
      expect(unknown.status).toBe(404);
      expect(json(unknown).error).toMatch(/Unknown organization unit "nope"/);

      // An absent disposition decodes to {} (kind undefined) and is refused by
      // name — it no longer falls through to the 'absorb' branch.
      seedUnit(dataDir, 'rooted');
      const noDisp = await post('/web/admin/org/units/remove', { unitId: 'rooted' }, cookie);
      expect(noDisp.status).toBe(400);
      expect(json(noDisp).error).toBe('A disposition kind is required: migrate, alternative, absorb or cascade');
      expect(getOrganizationUnit(dataDir, 'rooted')).not.toBeNull();
    });

    it('POST /web/admin/org/units/remove refuses an unknown disposition kind on a non-root unit and moves nothing', async () => {
      const cookie = adminCookie();
      const parent = seedUnit(dataDir, 'parent');
      const child = seedUnit(dataDir, 'child', { parentId: parent.id });
      const grandchild = seedUnit(dataDir, 'grandchild', { parentId: child.id });
      createPlacedProject(cfg, MASTER, 'kept', child);
      const before = json(await get('/web/admin/org/units', cookie)).units;

      // A typo of 'absorb' used to absorb: the child's contents moved to its parent.
      const typo = await post('/web/admin/org/units/remove', { unitId: child.id, disposition: { kind: 'absorbb' } }, cookie);
      expect(typo.status).toBe(400);
      expect(json(typo).error).toBe('A disposition kind is required: migrate, alternative, absorb or cascade');

      // The unit, its subtree and its placement are exactly as they were.
      expect(getOrganizationUnit(dataDir, child.id)).not.toBeNull();
      expect(getOrganizationUnit(dataDir, grandchild.id)?.parentId).toBe(child.id);
      expect(listProjectPlacements(dataDir, 'kept').map((p) => p.unitId)).toEqual([child.id]);
      expect(json(await get('/web/admin/org/units', cookie)).units).toEqual(before);
    });

    it('current behaviour: no session is 403 (not 401) on these instance-admin routes; a viewer session: 403', async () => {
      // webadmin's requireInstanceAdminSession never distinguishes an absent session
      // from an insufficient one, so an anonymous caller gets ForbiddenError → 403.
      adminCookie(); // the instance identity exists, as on any bootstrapped instance
      const anon = await get('/web/admin/secrets');
      expect(anon.status).toBe(403);
      expect(json(anon)).toEqual({ error: 'forbidden' });
      expect((await post('/web/admin/org/units/remove', { unitId: 'x', disposition: { kind: 'cascade' } })).status).toBe(403);
      const vc = viewerCookie();
      expect((await get('/web/admin/secrets', vc)).status).toBe(403);
      seedUnit(dataDir, 'kept');
      expect((await post('/web/admin/org/units/remove', { unitId: 'kept', disposition: { kind: 'cascade' } }, vc)).status).toBe(403);
      expect(getOrganizationUnit(dataDir, 'kept')).not.toBeNull();
    });
  });

  // ── Roles ──────────────────────────────────────────────────────────────────

  describe('/web/admin/roles (list / create / update / remove)', () => {
    const intern = {
      id: 'intern',
      name: 'Intern',
      description: 'read-only helper',
      permissions: [{ capability: 'project:read', value: 'yes' }],
      createdAt: '',
    };

    it('create → list → update → list → remove → list round-trips the role body', async () => {
      const cookie = adminCookie();

      const empty = await get('/web/admin/roles', cookie);
      expect(empty.status).toBe(200);
      expect(json(empty)).toEqual({ roles: [] });

      const created = await post('/web/admin/roles', intern, cookie);
      expect(created.status).toBe(200);
      const c = json(created);
      expect(c).toMatchObject({
        id: 'intern',
        name: 'Intern',
        description: 'read-only helper',
        permissions: [{ capability: 'project:read', value: 'yes' }],
      });
      expect(c.createdAt).not.toBe('');
      expect(c.createdBy).toMatchObject({ kind: 'human', issuer: 'local' });

      const listed = json(await get('/web/admin/roles', cookie)).roles;
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({ id: 'intern', name: 'Intern' });

      const updated = await post(
        '/web/admin/roles/update',
        { ...intern, name: 'Senior Intern', permissions: [{ capability: 'project:write', value: 'approval' }] },
        cookie,
      );
      expect(updated.status).toBe(200);
      expect(json(updated)).toMatchObject({
        id: 'intern',
        name: 'Senior Intern',
        permissions: [{ capability: 'project:write', value: 'approval' }],
        createdAt: c.createdAt, // preserved by the update
      });
      expect(json(await get('/web/admin/roles', cookie)).roles[0].name).toBe('Senior Intern');

      const removed = await post('/web/admin/roles/remove', { id: 'intern' }, cookie);
      expect(removed.status).toBe(200);
      expect(json(removed)).toEqual({ ok: true });
      expect(json(await get('/web/admin/roles', cookie)).roles).toEqual([]);
    });

    it('error paths: duplicate create 400, update of an unknown id 404, remove of an unknown id is a 200 no-op', async () => {
      const cookie = adminCookie();
      expect((await post('/web/admin/roles', intern, cookie)).status).toBe(200);
      const dup = await post('/web/admin/roles', intern, cookie);
      expect(dup.status).toBe(400);
      expect(json(dup).error).toMatch(/Role "intern" already exists/);

      const missing = await post('/web/admin/roles/update', { ...intern, id: 'ghost' }, cookie);
      expect(missing.status).toBe(404);
      expect(json(missing).error).toMatch(/Role "ghost" not found/);

      const noop = await post('/web/admin/roles/remove', { id: 'ghost' }, cookie);
      expect(noop.status).toBe(200);
      expect(json(await get('/web/admin/roles', cookie)).roles.map((r: { id: string }) => r.id)).toEqual(['intern']);
    });

    it('no session: 401 on each; a viewer session: 403', async () => {
      expect((await get('/web/admin/roles')).status).toBe(401);
      expect((await post('/web/admin/roles', intern)).status).toBe(401);
      expect((await post('/web/admin/roles/update', intern)).status).toBe(401);
      expect((await post('/web/admin/roles/remove', { id: 'intern' })).status).toBe(401);
      const vc = viewerCookie();
      expect((await get('/web/admin/roles', vc)).status).toBe(403);
      expect((await post('/web/admin/roles', intern, vc)).status).toBe(403);
    });

    it('a cookie POST without the CSRF header is refused before dispatch', async () => {
      const cookie = adminCookie();
      const r = await raw({
        method: 'POST',
        path: '/web/admin/roles',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(intern),
      });
      expect(r.status).toBe(403);
      expect(json(r)).toEqual({ error: 'missing X-Wairon-Web header' });
      expect(json(await get('/web/admin/roles', cookie)).roles).toEqual([]);
    });

    it('the approval decision is a cookie write too: refused without the CSRF header, dispatched with it', async () => {
      const cookie = adminCookie();
      const decision = { requestId: 'no-such-request', approved: true };
      const bare = await raw({
        method: 'POST',
        path: '/web/admin/approvals/decide',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify(decision),
      });
      expect(bare.status).toBe(403);
      expect(json(bare)).toEqual({ error: 'missing X-Wairon-Web header' });
      // With the header it reaches the router, which judges the request itself.
      const sent = await post('/web/admin/approvals/decide', decision, cookie);
      expect(json(sent)).not.toEqual({ error: 'missing X-Wairon-Web header' });
    });
  });

  // ── Permission assignments ────────────────────────────────────────────────

  describe('/web/admin/permissions (list / set / remove)', () => {
    const assignment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      id: '',
      subjectKind: 'user',
      subjectId: 'u-alice',
      scopeKind: 'project',
      scopeId: 'demo',
      capability: 'project:read',
      value: 'yes',
      createdAt: '',
      ...over,
    });

    it('set → list (filtered by the same scope) → remove → list round-trips the assignment', async () => {
      const cookie = adminCookie();

      const set = await post('/web/admin/permissions', assignment(), cookie);
      expect(set.status).toBe(200);
      const stored = json(set);
      expect(stored).toMatchObject({
        subjectKind: 'user',
        subjectId: 'u-alice',
        scopeKind: 'project',
        scopeId: 'demo',
        capability: 'project:read',
        value: 'yes',
      });
      expect(typeof stored.id).toBe('string');
      expect(stored.id).not.toBe('');

      const listed = await get('/web/admin/permissions?scopeKind=project&scopeId=demo', cookie);
      expect(listed.status).toBe(200);
      expect(json(listed).assignments.map((a: { id: string }) => a.id)).toEqual([stored.id]);

      const removed = await post('/web/admin/permissions/remove', { id: stored.id }, cookie);
      expect(removed.status).toBe(200);
      expect(json(removed)).toEqual({ ok: true });
      expect(json(await get('/web/admin/permissions?scopeKind=project&scopeId=demo', cookie)).assignments).toEqual([]);
    });

    it('each query param narrows the listing (scopeKind, scopeId, subjectKind, subjectId)', async () => {
      const cookie = adminCookie();
      const a = json(await post('/web/admin/permissions', assignment(), cookie));
      const b = json(await post('/web/admin/permissions', assignment({ subjectId: 'u-bob', scopeId: 'other' }), cookie));
      const e = json(
        await post('/web/admin/permissions', assignment({ subjectKind: 'everyone', subjectId: undefined, scopeKind: 'unit', scopeId: 'team' }), cookie),
      );
      const ids = async (qs: string): Promise<string[]> =>
        json(await get(`/web/admin/permissions${qs}`, cookie)).assignments.map((x: { id: string }) => x.id).sort();

      expect(await ids('')).toEqual([a.id, b.id, e.id].sort());
      expect(await ids('?scopeKind=project')).toEqual([a.id, b.id].sort());
      expect(await ids('?scopeKind=unit')).toEqual([e.id]);
      expect(await ids('?scopeKind=project&scopeId=other')).toEqual([b.id]);
      expect(await ids('?subjectKind=user&subjectId=u-alice')).toEqual([a.id]);
      expect(await ids('?subjectKind=everyone')).toEqual([e.id]);
    });

    it('error paths: the reserved *@instance marker is 403, removing an unknown id is 404', async () => {
      const cookie = adminCookie();
      const reserved = await post('/web/admin/permissions', assignment({ capability: '*', scopeKind: 'instance', scopeId: undefined }), cookie);
      expect(reserved.status).toBe(403);
      const unknown = await post('/web/admin/permissions/remove', { id: 'no-such-id' }, cookie);
      expect(unknown.status).toBe(404);
      expect(json(unknown).error).toMatch(/Assignment "no-such-id" not found/);
    });

    it('no session: 401; a viewer session: 403', async () => {
      expect((await get('/web/admin/permissions')).status).toBe(401);
      expect((await post('/web/admin/permissions', assignment())).status).toBe(401);
      expect((await post('/web/admin/permissions/remove', { id: 'x' })).status).toBe(401);
      const vc = viewerCookie();
      expect((await get('/web/admin/permissions', vc)).status).toBe(403);
      expect((await post('/web/admin/permissions', assignment(), vc)).status).toBe(403);
    });
  });

  // ── Role bindings ──────────────────────────────────────────────────────────

  describe('/web/admin/roles/bind and /web/admin/roles/unbind', () => {
    function seedAlice(): void {
      upsertUser(dataDir, {
        id: 'u-alice',
        subject: { userId: 'u-alice', kind: 'human', issuer: 'local' },
        status: 'active',
        createdAt: '',
      });
    }

    it('bind adds exactly the decoded {roleId, scopeKind, scopeId}; unbind at another scope is a no-op; unbind at the same scope removes it', async () => {
      const cookie = adminCookie();
      seedAlice();

      const bound = await post('/web/admin/roles/bind', { userId: 'u-alice', roleId: 'intern', scopeKind: 'project', scopeId: 'demo' }, cookie);
      expect(bound.status).toBe(200);
      expect(json(bound)).toMatchObject({ id: 'u-alice', roleBindings: [{ roleId: 'intern', scopeKind: 'project', scopeId: 'demo' }] });
      expect(getUserById(dataDir, 'u-alice')?.roleBindings).toEqual([{ roleId: 'intern', scopeKind: 'project', scopeId: 'demo' }]);

      // Idempotent: the same anchor is not duplicated.
      await post('/web/admin/roles/bind', { userId: 'u-alice', roleId: 'intern', scopeKind: 'project', scopeId: 'demo' }, cookie);
      expect(getUserById(dataDir, 'u-alice')?.roleBindings).toHaveLength(1);

      // An unscoped bind is a distinct (instance) anchor; scopeKind/scopeId are omitted.
      const unscoped = await post('/web/admin/roles/bind', { userId: 'u-alice', roleId: 'intern' }, cookie);
      expect(unscoped.status).toBe(200);
      expect(getUserById(dataDir, 'u-alice')?.roleBindings).toEqual([
        { roleId: 'intern', scopeKind: 'project', scopeId: 'demo' },
        { roleId: 'intern' },
      ]);

      // Unbind at a DIFFERENT scope leaves the project binding alone.
      const other = await post('/web/admin/roles/unbind', { userId: 'u-alice', roleId: 'intern', scopeKind: 'project', scopeId: 'other' }, cookie);
      expect(other.status).toBe(200);
      expect(getUserById(dataDir, 'u-alice')?.roleBindings).toHaveLength(2);

      // Unbind at the same scope removes exactly that binding.
      const unbound = await post('/web/admin/roles/unbind', { userId: 'u-alice', roleId: 'intern', scopeKind: 'project', scopeId: 'demo' }, cookie);
      expect(unbound.status).toBe(200);
      expect(json(unbound).roleBindings).toEqual([{ roleId: 'intern' }]);
      expect(getUserById(dataDir, 'u-alice')?.roleBindings).toEqual([{ roleId: 'intern' }]);
    });

    it('an unknown user is 404 on both', async () => {
      const cookie = adminCookie();
      const b = await post('/web/admin/roles/bind', { userId: 'u-ghost', roleId: 'intern' }, cookie);
      expect(b.status).toBe(404);
      expect(json(b).error).toMatch(/User "u-ghost" not found/);
      const u = await post('/web/admin/roles/unbind', { userId: 'u-ghost', roleId: 'intern' }, cookie);
      expect(u.status).toBe(404);
    });

    it('no session: 401; a viewer session: 403', async () => {
      seedAlice();
      expect((await post('/web/admin/roles/bind', { userId: 'u-alice', roleId: 'intern' })).status).toBe(401);
      expect((await post('/web/admin/roles/unbind', { userId: 'u-alice', roleId: 'intern' })).status).toBe(401);
      const vc = viewerCookie();
      expect((await post('/web/admin/roles/bind', { userId: 'u-alice', roleId: 'intern' }, vc)).status).toBe(403);
      expect(getUserById(dataDir, 'u-alice')?.roleBindings ?? []).toEqual([]);
    });
  });

  // ── Packs: global remove, project remove, adoptable, adopt, profiles ──────

  describe('pack routes (global remove / project remove / adoptable / adopt / profiles)', () => {
    it('POST /web/admin/packs/remove decodes the pack name (the canonical name the listing shows, or the install stem)', async () => {
      const cookie = adminCookie();
      expect((await post('/web/admin/packs', { name: 'acme', content: ACME_PACK }, cookie)).status).toBe(200);
      expect(json(await get('/web/admin/packs', cookie)).packs).toEqual([
        expect.objectContaining({ name: 'acme-doctrine', ref: 'acme.yaml', tier: 'instance' }),
      ]);

      // The canonical name the listing shows (and both clients send) removes the
      // pack even when it differs from the install stem.
      const byCanonical = await post('/web/admin/packs/remove', { name: 'acme-doctrine' }, cookie);
      expect(byCanonical.status).toBe(200);
      expect(json(byCanonical)).toEqual({ ok: true });
      expect(json(await get('/web/admin/packs', cookie)).packs).toEqual([]);

      // The install stem still removes it too.
      expect((await post('/web/admin/packs', { name: 'acme', content: ACME_PACK }, cookie)).status).toBe(200);
      const removed = await post('/web/admin/packs/remove', { name: 'acme' }, cookie);
      expect(removed.status).toBe(200);
      expect(json(removed)).toEqual({ ok: true });
      expect(json(await get('/web/admin/packs', cookie)).packs).toEqual([]);
    });

    it('POST /web/projects/packs/remove decodes projectId and name (the canonical name, or the install stem)', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await post('/web/projects/packs', { projectId: 'demo', name: 'tenant', content: TENANT_PACK }, cookie)).status).toBe(200);
      const names = async (): Promise<string[]> =>
        json(await get('/web/projects/packs?projectId=demo', cookie)).packs.map((p: { name: string }) => p.name);
      expect(await names()).toContain('tenant-doctrine');

      // The canonical name the listing shows removes the pack even when it differs
      // from the stem: the registration is gone and so are the vendored files.
      const byCanonical = await post('/web/projects/packs/remove', { projectId: 'demo', name: 'tenant-doctrine' }, cookie);
      expect(byCanonical.status).toBe(200);
      expect(json(byCanonical)).toEqual({ ok: true });
      expect(await names()).toEqual([]);
      expect(fs.existsSync(path.join(dataDir, 'projects', 'demo', '.wai', 'packs', 'tenant.yaml'))).toBe(false);

      // Reinstalled, the install stem keeps working below.
      expect((await post('/web/projects/packs', { projectId: 'demo', name: 'tenant', content: TENANT_PACK }, cookie)).status).toBe(200);
      expect(await names()).toEqual(['tenant-doctrine']);

      // projectId is decoded: the same name against another project is refused.
      createPlacedProject(cfg, MASTER, 'other');
      expect((await post('/web/projects/packs/remove', { projectId: 'other', name: 'tenant' }, cookie)).status).toBe(400);
      expect(await names()).toEqual(['tenant-doctrine']);

      const removed = await post('/web/projects/packs/remove', { projectId: 'demo', name: 'tenant' }, cookie);
      expect(removed.status).toBe(200);
      expect(json(removed)).toEqual({ ok: true });
      expect(await names()).toEqual([]);
    });

    it('POST /web/admin/packs/remove refuses a manifest name two instance packs declare, naming both files', async () => {
      const cookie = adminCookie();
      expect((await post('/web/admin/packs', { name: 'acme', content: ACME_PACK }, cookie)).status).toBe(200);
      expect((await post('/web/admin/packs', { name: 'acme2', content: ACME_PACK }, cookie)).status).toBe(200);

      const ambiguous = await post('/web/admin/packs/remove', { name: 'acme-doctrine' }, cookie);
      expect(ambiguous.status).toBe(400);
      expect(json(ambiguous).error).toMatch(/Pack name "acme-doctrine" is ambiguous/);
      expect(json(ambiguous).error).toContain('"acme.yaml"');
      expect(json(ambiguous).error).toContain('"acme2.yaml"');
      expect(json(await get('/web/admin/packs', cookie)).packs).toHaveLength(2);

      // A file name stays unambiguous.
      expect((await post('/web/admin/packs/remove', { name: 'acme2' }, cookie)).status).toBe(200);
      expect(json(await get('/web/admin/packs', cookie)).packs).toEqual([
        expect.objectContaining({ name: 'acme-doctrine', ref: 'acme.yaml' }),
      ]);
    });

    it('POST /web/admin/packs/remove names an image-only pack immutable by its manifest name too', async () => {
      const cookie = adminCookie();
      const imageDir = path.join(dataDir, 'image-packs');
      fs.mkdirSync(imageDir, { recursive: true });
      fs.writeFileSync(path.join(imageDir, 'baked.yaml'), ACME_PACK);
      expect(json(await get('/web/admin/packs', cookie)).packs).toEqual([
        expect.objectContaining({ name: 'acme-doctrine', tier: 'image' }),
      ]);

      for (const name of ['acme-doctrine', 'baked']) {
        const r = await post('/web/admin/packs/remove', { name }, cookie);
        expect(r.status).toBe(400);
        expect(json(r).error).toContain(`Pack "${name}" is an immutable image-layer pack`);
      }
      expect(fs.existsSync(path.join(imageDir, 'baked.yaml'))).toBe(true);
    });

    it('POST /web/projects/packs/remove refuses a manifest name two registrations declare, naming both refs', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await post('/web/projects/packs', { projectId: 'demo', name: 'tenant', content: TENANT_PACK }, cookie)).status).toBe(200);
      expect((await post('/web/projects/packs', { projectId: 'demo', name: 'tenant2', content: TENANT_PACK }, cookie)).status).toBe(200);
      const names = async (): Promise<string[]> =>
        json(await get('/web/projects/packs?projectId=demo', cookie)).packs.map((p: { name: string }) => p.name);

      const ambiguous = await post('/web/projects/packs/remove', { projectId: 'demo', name: 'tenant-doctrine' }, cookie);
      expect(ambiguous.status).toBe(400);
      expect(json(ambiguous).error).toMatch(/Pack name "tenant-doctrine" is ambiguous/);
      expect(json(ambiguous).error).toContain('".wai/packs/tenant.yaml"');
      expect(json(ambiguous).error).toContain('".wai/packs/tenant2.yaml"');
      expect(await names()).toEqual(['tenant-doctrine', 'tenant-doctrine']);

      // The stem stays unambiguous.
      expect((await post('/web/projects/packs/remove', { projectId: 'demo', name: 'tenant2' }, cookie)).status).toBe(200);
      expect(await names()).toEqual(['tenant-doctrine']);
    });

    it('GET /web/projects/packs/adoptable + POST /web/projects/packs/adopt round-trip a server-global pack into the project', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await post('/web/admin/packs', { name: 'acme', content: ACME_PACK }, cookie)).status).toBe(200);

      const adoptable = await get('/web/projects/packs/adoptable?projectId=demo', cookie);
      expect(adoptable.status).toBe(200);
      expect(json(adoptable).packs.map((p: { name: string }) => p.name)).toContain('acme-doctrine');

      const adopted = await post('/web/projects/packs/adopt', { projectId: 'demo', name: 'acme-doctrine' }, cookie);
      expect(adopted.status).toBe(200);
      expect(json(adopted)).toMatchObject({ name: 'acme-doctrine' });

      const projectPacks = json(await get('/web/projects/packs?projectId=demo', cookie)).packs;
      expect(projectPacks).toEqual([
        expect.objectContaining({ name: 'acme-doctrine', scope: 'project', ref: '.wai/packs/acme-doctrine.yaml' }),
      ]);
      // projectId is decoded on adopt: a bystander project gained nothing.
      createPlacedProject(cfg, MASTER, 'other');
      expect(json(await get('/web/projects/packs?projectId=other', cookie)).packs).toEqual([]);

      // Current behaviour: the adoptable catalog is project-agnostic — an adopted
      // pack stays listed (the React client filters installed names itself).
      const again = json(await get('/web/projects/packs/adoptable?projectId=demo', cookie)).packs;
      expect(again.map((p: { name: string }) => p.name)).toContain('acme-doctrine');
    });

    it('GET /web/projects/packs/adoptable decodes projectId for authorization only', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      createPlacedProject(cfg, MASTER, 'other');
      // Current behaviour: an unknown project id is not validated — an empty 200.
      const ghost = await get('/web/projects/packs/adoptable?projectId=ghost', cookie);
      expect(ghost.status).toBe(200);
      expect(json(ghost)).toEqual({ packs: [] });

      // The query projectId is what gets authorized: project:read on demo only.
      allow(dataDir, 'reader', 'project:read', 'project', 'demo');
      const rc = sessionCookieFor('reader');
      expect((await get('/web/projects/packs/adoptable?projectId=demo', rc)).status).toBe(200);
      expect((await get('/web/projects/packs/adoptable?projectId=other', rc)).status).toBe(403);
    });

    it('POST /web/projects/packs/adopt of a name the instance does not carry is refused', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      const r = await post('/web/projects/packs/adopt', { projectId: 'demo', name: 'no-such-pack' }, cookie);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(json(await get('/web/projects/packs?projectId=demo', cookie)).packs).toEqual([]);
    });

    it('GET /web/admin/profiles lists built-ins and server-global pack profiles', async () => {
      const cookie = adminCookie();
      const before = await get('/web/admin/profiles', cookie);
      expect(before.status).toBe(200);
      const beforeIds = json(before).profiles.map((p: { id: string }) => p.id);
      expect(beforeIds).toContain('backend');
      expect(beforeIds).not.toContain('ddd');

      await post('/web/admin/packs', { name: 'acme', content: ACME_PACK }, cookie);
      const after = json(await get('/web/admin/profiles', cookie)).profiles;
      expect(after.map((p: { id: string }) => p.id)).toContain('ddd');
    });

    it('no session: 401 on every pack route', async () => {
      expect((await post('/web/admin/packs/remove', { name: 'acme' })).status).toBe(401);
      expect((await post('/web/projects/packs/remove', { projectId: 'demo', name: 'x' })).status).toBe(401);
      expect((await get('/web/projects/packs/adoptable?projectId=demo')).status).toBe(401);
      expect((await post('/web/projects/packs/adopt', { projectId: 'demo', name: 'x' })).status).toBe(401);
      expect((await get('/web/admin/profiles')).status).toBe(401);
    });
  });

  // ── Project config ────────────────────────────────────────────────────────

  describe('/web/projects/config (get / set)', () => {
    it('GET decodes projectId; POST decodes projectId + projectType and the change reads back', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      await post('/web/admin/packs', { name: 'acme', content: ACME_PACK }, cookie);

      const before = await get('/web/projects/config?projectId=demo', cookie);
      expect(before.status).toBe(200);
      const b = json(before);
      expect(b).toMatchObject({ locked: false, profileResolvable: true });
      expect(typeof b.projectType).toBe('string');
      expect(b.projectType).not.toBe('ddd');

      const set = await post('/web/projects/config', { projectId: 'demo', projectType: 'ddd' }, cookie);
      expect(set.status).toBe(200);
      expect(json(set)).toMatchObject({ projectType: 'ddd', profileResolvable: true, adoptedPackName: 'acme-doctrine' });

      expect(json(await get('/web/projects/config?projectId=demo', cookie)).projectType).toBe('ddd');

      const ghost = await get('/web/projects/config?projectId=ghost', cookie);
      expect(ghost.status).toBe(404);
    });

    it('an unknown profile id is refused and the previous type stands', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      const was = json(await get('/web/projects/config?projectId=demo', cookie)).projectType;
      const r = await post('/web/projects/config', { projectId: 'demo', projectType: 'no-such-profile' }, cookie);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(json(await get('/web/projects/config?projectId=demo', cookie)).projectType).toBe(was);
    });

    it('no session: 401; a viewer session: 403', async () => {
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await get('/web/projects/config?projectId=demo')).status).toBe(401);
      expect((await post('/web/projects/config', { projectId: 'demo', projectType: 'backend' })).status).toBe(401);
      const vc = viewerCookie();
      expect((await get('/web/projects/config?projectId=demo', vc)).status).toBe(403);
      expect((await post('/web/projects/config', { projectId: 'demo', projectType: 'backend' }, vc)).status).toBe(403);
    });

    it('a cookie POST WITHOUT the CSRF header is refused before dispatch, like every sibling project write', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      const before = json(await get('/web/projects/config?projectId=demo', cookie));
      const r = await raw({
        method: 'POST',
        path: '/web/projects/config',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ projectId: 'demo', projectType: 'backend' }),
      });
      expect(r.status).toBe(403);
      expect(json(r)).toEqual({ error: 'missing X-Wairon-Web header' });
      expect(json(await get('/web/projects/config?projectId=demo', cookie))).toEqual(before);
    });
  });

  // ── Policy reconcile ──────────────────────────────────────────────────────

  describe('POST /web/projects/policy/reconcile', () => {
    it('decodes projectId: installs the policy-required pack into THAT project', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      createPlacedProject(cfg, MASTER, 'bystander');
      await post('/web/admin/packs', { name: 'acme', content: ACME_PACK }, cookie);
      const policy = json(await get('/web/admin/policy', cookie));
      expect((await post('/web/admin/policy', { ...policy, requiredGlobalPacks: ['acme-doctrine'] }, cookie)).status).toBe(200);

      const before = json(await get('/web/projects/policy?projectId=demo', cookie));
      expect(before.missingPackNames).toContain('acme-doctrine');

      const reconciled = await post('/web/projects/policy/reconcile', { projectId: 'demo' }, cookie);
      expect(reconciled.status).toBe(200);
      const r = json(reconciled);
      expect(r.missingPackNames).toEqual([]);
      expect(typeof r.compliant).toBe('boolean');
      expect(typeof r.mode).toBe('string');

      const packsOf = async (id: string): Promise<string[]> =>
        json(await get(`/web/projects/packs?projectId=${id}`, cookie)).packs.map((p: { name: string }) => p.name);
      expect(await packsOf('demo')).toContain('acme-doctrine');
      expect(await packsOf('bystander')).not.toContain('acme-doctrine');
    });

    it('an unknown project is 404; no session 401; a viewer 403', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await post('/web/projects/policy/reconcile', { projectId: 'ghost' }, cookie)).status).toBe(404);
      expect((await post('/web/projects/policy/reconcile', { projectId: 'demo' })).status).toBe(401);
      expect((await post('/web/projects/policy/reconcile', { projectId: 'demo' }, viewerCookie())).status).toBe(403);
    });
  });

  // ── Producers ─────────────────────────────────────────────────────────────

  describe('/web/projects/producers (list / configure / remove / run)', () => {
    it('configure → list → remove → list round-trips {projectId, target, parentPageId}', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      createPlacedProject(cfg, MASTER, 'other');

      const empty = await get('/web/projects/producers?projectId=demo', cookie);
      expect(empty.status).toBe(200);
      expect(json(empty)).toEqual({ producers: [] });

      const configured = await post('/web/projects/producers', { projectId: 'demo', target: 'notion', parentPageId: 'page-123' }, cookie);
      expect(configured.status).toBe(200);
      expect(json(configured)).toEqual({ ok: true });

      expect(json(await get('/web/projects/producers?projectId=demo', cookie))).toEqual({
        producers: [{ target: 'notion', parentPageId: 'page-123' }],
      });
      // The query projectId is decoded: another project has none.
      expect(json(await get('/web/projects/producers?projectId=other', cookie))).toEqual({ producers: [] });

      const removed = await post('/web/projects/producers/remove', { projectId: 'demo', target: 'notion' }, cookie);
      expect(removed.status).toBe(200);
      expect(json(removed)).toEqual({ ok: true });
      expect(json(await get('/web/projects/producers?projectId=demo', cookie))).toEqual({ producers: [] });
    });

    it('run (external effect only partially pinned): the decoded target reaches the producer', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');

      // The router awaits opsRunProducer inside handleWebRequest's try, so a
      // rejection goes through the error→status mapping (it once escaped as a 500).
      // An unconfigured target: the producer names the decoded target.
      const unconfigured = await post('/web/projects/producers/run', { projectId: 'demo', target: 'miro' }, cookie);
      expect(unconfigured.status).toBe(400);
      expect(json(unconfigured)).toEqual({ error: 'Producer "miro" is not configured for this project.' });

      // A target no producer exists for: refused through the mapping as well.
      const bogus = await post('/web/projects/producers/run', { projectId: 'demo', target: 'bogus' }, cookie);
      expect(bogus.status).toBe(400);
      expect(json(bogus)).toEqual({ error: 'Producer "bogus" is not configured for this project.' });

      // A configured notion target with no token fails before any network call.
      await post('/web/projects/producers', { projectId: 'demo', target: 'notion', parentPageId: 'page-123' }, cookie);
      const noToken = await post('/web/projects/producers/run', { projectId: 'demo', target: 'notion' }, cookie);
      expect(noToken.status).toBe(400);
      expect(json(noToken).error).toMatch(/^No Notion token/);

      // The decoded projectId reaches the producer too: an unknown project is 404.
      const ghost = await post('/web/projects/producers/run', { projectId: 'ghost', target: 'notion' }, cookie);
      expect(ghost.status).toBe(404);
      expect(json(ghost).error).toMatch(/Unknown project "ghost"/);

      // The success envelope, with the external call stubbed out.
      const spy = vi.spyOn(projectops, 'produceProducer').mockResolvedValue(undefined);
      const ok = await post('/web/projects/producers/run', { projectId: 'demo', target: 'notion' }, cookie);
      expect(ok.status).toBe(200);
      expect(json(ok)).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0].slice(2)).toEqual(['demo', 'notion']);
      expect(spy.mock.calls[0][1]).toBe(cookie.slice('wairon_session='.length)); // the session id is the credential
    });

    it('an unknown project is 404; current behaviour: no session is 403 (AdminAuthError); a viewer 403', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await get('/web/projects/producers?projectId=ghost', cookie)).status).toBe(404);
      const anon = await get('/web/projects/producers?projectId=demo');
      expect(anon.status).toBe(403);
      expect(json(anon)).toEqual({ error: 'forbidden' });
      expect((await post('/web/projects/producers', { projectId: 'demo', target: 'notion', parentPageId: 'p' })).status).toBe(403);
      expect((await post('/web/projects/producers/remove', { projectId: 'demo', target: 'notion' })).status).toBe(403);
      // run: awaited, so a missing session maps like its siblings.
      const anonRun = await post('/web/projects/producers/run', { projectId: 'demo', target: 'notion' });
      expect(anonRun.status).toBe(403);
      expect(json(anonRun)).toEqual({ error: 'forbidden' });
      const vc = viewerCookie();
      expect((await get('/web/projects/producers?projectId=demo', vc)).status).toBe(403);
      expect((await post('/web/projects/producers', { projectId: 'demo', target: 'notion', parentPageId: 'p' }, vc)).status).toBe(403);
      // run: a viewer without the grant is refused through the mapping, not a 500.
      const viewerRun = await post('/web/projects/producers/run', { projectId: 'demo', target: 'notion' }, vc);
      expect(viewerRun.status).toBe(403);
      expect(json(viewerRun)).toEqual({ error: 'forbidden' });
    });
  });

  // ── Per-project git ───────────────────────────────────────────────────────

  describe('/web/projects/git (status / bind / sync-config / sync / disconnect)', () => {
    it('bind → status → sync-config → status → sync → disconnect → status, against a local bare remote', async () => {
      const cookie = adminCookie();
      const remote = seedRemote(base);

      const bound = await post('/web/projects/git', { projectId: 'gitproj', remote, branch: 'main' }, cookie);
      expect(bound.status).toBe(200);
      expect(json(bound)).toMatchObject({ id: 'gitproj' });
      const root = path.join(dataDir, 'projects', 'gitproj');
      expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).toBe('wairon/work');

      const status = await get('/web/projects/git?projectId=gitproj', cookie);
      expect(status.status).toBe(200);
      const s = json(status);
      expect(s).toMatchObject({ enabled: true, remote, branch: 'main' });

      const cfgd = await post('/web/projects/git/sync-config', { projectId: 'gitproj', periodicSyncMinutes: 15, skipIfClean: false }, cookie);
      expect(cfgd.status).toBe(200);
      expect(json(cfgd)).toEqual({ ok: true });
      expect(json(await get('/web/projects/git?projectId=gitproj', cookie))).toMatchObject({ periodicSyncMinutes: 15, skipIfClean: false });

      // Non-number / non-boolean values decode to undefined — the interval clears.
      await post('/web/projects/git/sync-config', { projectId: 'gitproj', periodicSyncMinutes: '30' }, cookie);
      expect(json(await get('/web/projects/git?projectId=gitproj', cookie)).periodicSyncMinutes).toBeUndefined();

      // Sync (external effect partially pinned: a local bare remote, nothing new upstream).
      const synced = await post('/web/projects/git/sync', { projectId: 'gitproj' }, cookie);
      expect(synced.status).toBe(200);
      expect(json(synced)).toEqual({ ok: true });

      const disconnected = await post('/web/projects/git/disconnect', { projectId: 'gitproj' }, cookie);
      expect(disconnected.status).toBe(200);
      expect(json(disconnected)).toEqual({ ok: true });
      expect(json(await get('/web/projects/git?projectId=gitproj', cookie)).enabled).toBe(false);
    });

    it('bind decodes the optional pat into the per-project git secret', async () => {
      const cookie = adminCookie();
      const remote = seedRemote(base);
      expect((await post('/web/projects/git', { projectId: 'gitproj', remote, branch: 'main', pat: 'ghp_secret' }, cookie)).status).toBe(200);
      expect(json(await get('/web/admin/secrets', cookie)).refs).toContain('git-project:gitproj');
    });

    it('decoding of projectId on each route: an unknown / existing project is refused', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await get('/web/projects/git?projectId=ghost', cookie)).status).toBe(404);
      expect((await post('/web/projects/git/sync', { projectId: 'ghost' }, cookie)).status).toBe(404);
      expect((await post('/web/projects/git/disconnect', { projectId: 'ghost' }, cookie)).status).toBe(404);
      expect((await post('/web/projects/git/sync-config', { projectId: 'ghost', periodicSyncMinutes: 5 }, cookie)).status).toBe(404);
      // Binding a project id that already exists is refused (400).
      const exists = await post('/web/projects/git', { projectId: 'demo', remote: 'x', branch: 'main' }, cookie);
      expect(exists.status).toBe(400);
      expect(json(exists).error).toMatch(/Project "demo" already exists/);
    });

    it('status of a non-git project reads as not enabled', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      const r = await get('/web/projects/git?projectId=demo', cookie);
      expect(r.status).toBe(200);
      expect(json(r).enabled).toBe(false);
    });

    it('current behaviour: no session is 403 (AdminAuthError), not 401; a viewer session: 403', async () => {
      createPlacedProject(cfg, MASTER, 'demo');
      const anon = await get('/web/projects/git?projectId=demo');
      expect(anon.status).toBe(403);
      expect(json(anon)).toEqual({ error: 'forbidden' });
      expect((await post('/web/projects/git', { projectId: 'x', remote: 'r', branch: 'main' })).status).toBe(403);
      expect((await post('/web/projects/git/disconnect', { projectId: 'demo' })).status).toBe(403);
      expect((await post('/web/projects/git/sync', { projectId: 'demo' })).status).toBe(403);
      expect((await post('/web/projects/git/sync-config', { projectId: 'demo' })).status).toBe(403);
      const vc = viewerCookie();
      expect((await get('/web/projects/git?projectId=demo', vc)).status).toBe(403);
      expect((await post('/web/projects/git/sync', { projectId: 'demo' }, vc)).status).toBe(403);
    });
  });

  // ── Instance git backing: remove + sync ───────────────────────────────────

  describe('/web/admin/git-backing/remove and /web/admin/git-backing/sync', () => {
    it('bind → sync (publishes to a local bare remote) → remove → list', async () => {
      const cookie = adminCookie();
      const remote = seedRemote(base);
      const bound = await post('/web/admin/git-backing', { scopeKind: 'instance', remote, branch: 'main' }, cookie);
      expect(bound.status).toBe(200);
      const id = json(bound).id;
      expect(typeof id).toBe('string');

      const synced = await post('/web/admin/git-backing/sync', { id }, cookie);
      expect(synced.status).toBe(200);
      expect(Object.keys(json(synced))).toEqual(['published']);
      expect(typeof json(synced).published).toBe('boolean');

      const removed = await post('/web/admin/git-backing/remove', { id }, cookie);
      expect(removed.status).toBe(200);
      expect(json(removed)).toEqual({ ok: true });
      expect(json(await get('/web/admin/git-backing', cookie)).bindings).toEqual([]);
    });

    it('the id is decoded: an unknown binding is 404 on both', async () => {
      const cookie = adminCookie();
      const s = await post('/web/admin/git-backing/sync', { id: 'nope' }, cookie);
      expect(s.status).toBe(404);
      expect(json(s).error).toMatch(/Backing binding "nope" not found/);
      const r = await post('/web/admin/git-backing/remove', { id: 'nope' }, cookie);
      expect(r.status).toBe(404);
    });

    it('no session: 401; a viewer session: 403 (and the binding survives)', async () => {
      const cookie = adminCookie();
      const id = json(await post('/web/admin/git-backing', { scopeKind: 'instance', remote: 'file:///nowhere', branch: 'main' }, cookie)).id;
      expect((await post('/web/admin/git-backing/remove', { id })).status).toBe(401);
      expect((await post('/web/admin/git-backing/sync', { id })).status).toBe(401);
      const vc = viewerCookie();
      expect((await post('/web/admin/git-backing/remove', { id }, vc)).status).toBe(403);
      expect((await post('/web/admin/git-backing/sync', { id }, vc)).status).toBe(403);
      expect(json(await get('/web/admin/git-backing', cookie)).bindings.map((b: { id: string }) => b.id)).toEqual([id]);
    });
  });

  // ── Share links ───────────────────────────────────────────────────────────

  describe('/web/admin/share (create / list / refresh / update / remove / access)', () => {
    const input = { projectId: 'demo', view: 'architecture', mode: 'snapshot', artifacts: ['canvas'] };

    it('create → list (by projectId) → update → refresh → access log (limit) → remove → list', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      createPlacedProject(cfg, MASTER, 'other');

      const created = await post('/web/admin/share', { ...input, allowDownloadHtml: true, frameAncestors: ['https://notion.so'] }, cookie);
      expect(created.status).toBe(201);
      const c = json(created);
      expect(typeof c.token).toBe('string');
      expect(c.link).toMatchObject({
        projectId: 'demo',
        view: 'architecture',
        mode: 'snapshot',
        enabled: true,
        allowDownloadHtml: true,
        allowDownloadOpenapi: false,
        frameAncestors: ['https://notion.so'],
      });
      const linkId = c.link.id;

      const listed = await get('/web/admin/share?projectId=demo', cookie);
      expect(listed.status).toBe(200);
      expect(json(listed).links.map((l: { id: string }) => l.id)).toEqual([linkId]);
      expect(listed.body).not.toContain(c.token);
      // The query projectId is decoded: another project lists none.
      expect(json(await get('/web/admin/share?projectId=other', cookie))).toEqual({ links: [] });

      const updated = await post('/web/admin/share/update', { linkId, changes: { enabled: false, allowDownloadHtml: false } }, cookie);
      expect(updated.status).toBe(200);
      expect(json(updated)).toMatchObject({ id: linkId, enabled: false, allowDownloadHtml: false, frameAncestors: ['https://notion.so'] });
      expect(json(await get('/web/admin/share?projectId=demo', cookie)).links[0].enabled).toBe(false);

      const refreshed = await post('/web/admin/share/refresh', { linkId }, cookie);
      expect(refreshed.status).toBe(200);
      expect(json(refreshed).id).toBe(linkId);
      expect(json(refreshed).snapshotId).not.toBe(c.link.snapshotId);

      // Access log: two resolutions of the (disabled) link, then limit narrows.
      const META = { ip: '203.0.113.7', userAgent: 'probe/1.0' };
      resolveSharedView(cfg, c.token, META);
      resolveSharedView(cfg, c.token, META);
      const log = await get(`/web/admin/share/access?linkId=${encodeURIComponent(linkId)}`, cookie);
      expect(log.status).toBe(200);
      expect(json(log).entries).toHaveLength(2);
      expect(json(log).entries[0]).toMatchObject({ linkId, ip: '203.0.113.7', outcome: 'denied-disabled' });
      const limited = await get(`/web/admin/share/access?linkId=${encodeURIComponent(linkId)}&limit=1`, cookie);
      expect(json(limited).entries).toHaveLength(1);

      const removed = await post('/web/admin/share/remove', { linkId }, cookie);
      expect(removed.status).toBe(200);
      expect(json(removed)).toEqual({ ok: true });
      expect(json(await get('/web/admin/share?projectId=demo', cookie))).toEqual({ links: [] });
    });

    it('an unknown linkId is 404 on refresh / update / remove / access', async () => {
      const cookie = adminCookie();
      for (const p of ['/web/admin/share/refresh', '/web/admin/share/update', '/web/admin/share/remove']) {
        const r = await post(p, { linkId: 'nope', changes: {} }, cookie);
        expect(r.status).toBe(404);
        expect(json(r).error).toMatch(/Share link "nope" not found/);
      }
      expect((await get('/web/admin/share/access?linkId=nope', cookie)).status).toBe(404);
    });

    it('no session: 401; a viewer session: 403', async () => {
      createPlacedProject(cfg, MASTER, 'demo');
      expect((await post('/web/admin/share', input)).status).toBe(401);
      expect((await get('/web/admin/share?projectId=demo')).status).toBe(401);
      expect((await post('/web/admin/share/refresh', { linkId: 'x' })).status).toBe(401);
      expect((await post('/web/admin/share/update', { linkId: 'x', changes: {} })).status).toBe(401);
      expect((await post('/web/admin/share/remove', { linkId: 'x' })).status).toBe(401);
      expect((await get('/web/admin/share/access?linkId=x')).status).toBe(401);
      const vc = viewerCookie();
      expect((await post('/web/admin/share', input, vc)).status).toBe(403);
      expect((await get('/web/admin/share?projectId=demo', vc)).status).toBe(403);
    });
  });
  // ── Scoped control-plane reads + the approval decision ─────────────────────

  describe('/web/admin/landscape, health, usage, approvals, approvals/decide', () => {
    /** Seed a pending project:init request from an approval-valued requester, so
     *  the instance admin deciding it is never the original requester. */
    function seedPendingInit(userId: string, projectId: string): string {
      const unit = seedUnit(dataDir, `unit-${projectId}`);
      const requester = mintUserToken(dataDir, { id: `tok-${userId}`, userId });
      allow(dataDir, userId, 'project:create', 'unit', unit.id, 'approval');
      const outcome = initializeProject(cfg, requester, { id: projectId, ownerUnitId: unit.id });
      expect(outcome.status).toBe('pending-approval');
      return outcome.approval!.id;
    }

    it('GET /web/admin/landscape answers the landscape graph model bare, not enveloped', async () => {
      const cookie = adminCookie();
      createPlacedProject(cfg, MASTER, 'demo');
      const r = await get('/web/admin/landscape', cookie);
      expect(r.status).toBe(200);
      const body = json(r);
      expect(Array.isArray(body.nodes)).toBe(true);
      expect(JSON.stringify(body.nodes)).toContain('demo');
    });

    it('GET /web/admin/health answers the health report bare, not enveloped', async () => {
      const r = await get('/web/admin/health', adminCookie());
      expect(r.status).toBe(200);
      expect(json(r)).toHaveProperty('status');
    });

    it('GET /web/admin/usage answers the snapshots inside a { usage } envelope', async () => {
      const r = await get('/web/admin/usage', adminCookie());
      expect(r.status).toBe(200);
      const body = json(r);
      expect(Object.keys(body)).toEqual(['usage']);
      expect(Array.isArray(body.usage)).toBe(true);
    });

    it('GET /web/admin/approvals lists the pending requests inside a { requests } envelope', async () => {
      const id = seedPendingInit('u-pending', 'pending-proj');
      const r = await get('/web/admin/approvals', adminCookie());
      expect(r.status).toBe(200);
      const body = json(r);
      expect(Object.keys(body)).toEqual(['requests']);
      expect(body.requests.map((q: { id: string }) => q.id)).toContain(id);
    });

    it('POST /web/admin/approvals/decide decodes requestId / approved / reason, and decidedBy is the session principal', async () => {
      const id = seedPendingInit('u-deny', 'deny-proj');
      const inst = ensureInstanceIdentity(dataDir);
      const r = await post('/web/admin/approvals/decide', {
        requestId: id,
        approved: false,
        reason: 'not now',
        // A client-supplied decider is never trusted: the server overrides it.
        decidedBy: { userId: 'mallory', kind: 'human', issuer: 'local' },
        decidedAt: '1999-01-01T00:00:00.000Z',
      }, adminCookie());
      expect(r.status).toBe(200);
      const decided = json(r);
      expect(decided.id).toBe(id);
      expect(decided.status).toBe('denied');
      expect(decided.decisionReason).toBe('not now');
      expect(decided.decidedBy.userId).toBe(inst.superadminUserId);
      expect(decided.decidedAt).not.toBe('1999-01-01T00:00:00.000Z');
      // A decided request leaves the pending list.
      expect(json(await get('/web/admin/approvals', adminCookie())).requests).toEqual([]);
    });

    it('POST /web/admin/approvals/decide: approved is true ONLY for a literal true (current behaviour)', async () => {
      const id = seedPendingInit('u-truthy', 'truthy-proj');
      const r = await post('/web/admin/approvals/decide', { requestId: id, approved: 'yes' }, adminCookie());
      expect(r.status).toBe(200);
      expect(json(r).status).toBe('denied');
    });

    it('no session: 401 on each; a viewer session: 403 on each', async () => {
      for (const p of ['/web/admin/landscape', '/web/admin/health', '/web/admin/usage', '/web/admin/approvals']) {
        expect((await get(p)).status).toBe(401);
      }
      expect((await post('/web/admin/approvals/decide', { requestId: 'x', approved: true })).status).toBe(401);
      const vc = viewerCookie();
      for (const p of ['/web/admin/health', '/web/admin/usage', '/web/admin/approvals']) {
        expect((await get(p, vc)).status).toBe(403);
      }
    });
  });
});
