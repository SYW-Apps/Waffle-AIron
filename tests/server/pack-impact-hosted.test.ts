import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { routeAdmin, routeData } from '../../src/server/http.js';
import { previewProjectPack, previewProjectPackRemoval, installProjectPack } from '../../src/server/packs.js';
import {
  evaluateInitRequest,
  evaluateProjectPolicy,
  initializeProjectWithProfile,
  reconcileProjectPolicy,
  setPackPolicyRecord,
  setProjectType,
} from '../../src/server/policy.js';
import { decideRequest, executeApprovedRequest, initializeProject } from '../../src/server/projectlifecycle.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import { getApprovalRequestById } from '../../src/server/approvals.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { createWebSession } from '../../src/server/websessions.js';
import { AdminAuthError, ForbiddenError } from '../../src/server/errors.js';
import { allow, mintUserToken, seedUnit, subjectOf, createPlacedProject } from './helpers.js';
import type { HostConfig, InstancePackPolicy } from '../../src/server/types.js';
import type { PackImpact } from '../../src/models/pack-impact.js';

// ---------------------------------------------------------------------------
// The hosted half of the governance stage: every pack write the host performs
// is measured before it happens. A preview (install, adoption, removal) needs
// project:read and writes nothing; the unattended policy writes — reconcile,
// setProjectType, a policy-governed init — carry the impacts they measured in
// their results, on an approval as its executionSummary and in the audit.
//
// Everything is real: a real data directory, real minted credentials, the real
// pack store over temp server-global and image tiers, the real validator. HOME,
// USERPROFILE and APPDATA are redirected so nothing machine-global is touched.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

/** A declarative pack contributing the `acme-svc` profile, which turns a builtin code off. */
const ACME_YAML = [
  'name: acme-svc',
  'version: 1.0.0',
  'profiles:',
  '  acme-svc:',
  '    family: backend-like',
  '    rules:',
  '      sddRuleSeverity:',
  "        UNUSED_COMPONENT: 'off'",
  'languages: {}',
  '',
].join('\n');

function policy(over: Partial<InstancePackPolicy> = {}): InstancePackPolicy {
  return {
    id: 'inst-policy',
    requiredGlobalPacks: [],
    defaultProjectPacks: [],
    allowedProfileIds: [],
    requiredProfileIds: [],
    blockedPackNames: [],
    requireProfileSelection: false,
    enforcementMode: 'warn',
    updatedAt: '',
    ...over,
  };
}

describe('hosted pack impact (governance stage, wave B)', () => {
  let tmp: string;
  let dataDir: string;
  let packsDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hosted-impact-'));
    dataDir = path.join(tmp, 'data');
    packsDir = path.join(tmp, 'instance-packs');
    const home = path.join(tmp, 'home');
    for (const dir of [dataDir, packsDir, home, path.join(tmp, 'image-packs')]) fs.mkdirSync(dir, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = home;
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_PACKS_DIR = packsDir;
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(tmp, 'image-packs');
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Everything a preview could write: the configuration and the vendored packs. */
  function snapshot(project: string): { config: string; packs: string[] } {
    const root = existingProjectRoot(dataDir, project)!;
    const packsPath = path.join(root, '.wai', 'packs');
    return {
      config: fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8'),
      packs: fs.existsSync(packsPath) ? fs.readdirSync(packsPath).sort() : [],
    };
  }

  function seedGlobal(): void {
    fs.writeFileSync(path.join(packsDir, 'acme-svc.yaml'), ACME_YAML);
  }

  const addedProfile = (impact: { doctrine: PackImpact['doctrine'] }): boolean =>
    impact.doctrine.some((c) => c.axis === 'concept' && c.change === 'added' && c.subject === 'acme-svc');

  // ── previews ───────────────────────────────────────────────────────────────

  it('previews an install with project:read and writes nothing; a principal without read is refused', () => {
    createPlacedProject(cfg, MASTER, 'demo');
    allow(dataDir, 'u-reader', 'project:read', 'project', 'demo');
    const reader = mintUserToken(dataDir, { id: 'k-reader', userId: 'u-reader' });
    const stranger = mintUserToken(dataDir, { id: 'k-stranger', userId: 'u-stranger' });
    const before = snapshot('demo');

    const impact = previewProjectPack(cfg, reader, 'demo', 'acme-svc', ACME_YAML);

    expect(impact.direction).toBe('apply');
    expect(impact.pack).toBe('acme-svc');
    expect(impact.version).toBe('1.0.0');
    expect(addedProfile(impact)).toBe(true);
    // The loosening is reported as a change — stated, never a finding.
    expect(impact.doctrine).toContainEqual(expect.objectContaining({ axis: 'rule', change: 'off', subject: 'UNUSED_COMPONENT', profile: 'acme-svc' }));
    expect(snapshot('demo')).toEqual(before);

    expect(() => previewProjectPack(cfg, stranger, 'demo', 'acme-svc', ACME_YAML)).toThrow(AdminAuthError);
    // The install it previews still needs project:admin.
    expect(() => installProjectPack(cfg, reader, 'demo', 'acme-svc', ACME_YAML)).toThrow(AdminAuthError);
  });

  it('previews an adoption from the server-global set, and refuses content the install would refuse, or an unknown name', () => {
    createPlacedProject(cfg, MASTER, 'demo');
    seedGlobal();
    const before = snapshot('demo');

    const adoption = previewProjectPack(cfg, MASTER, 'demo', 'acme-svc');
    expect(adoption.pack).toBe('acme-svc');
    expect(addedProfile(adoption)).toBe(true);
    expect(snapshot('demo')).toEqual(before);

    expect(() => previewProjectPack(cfg, MASTER, 'demo', 'nowhere')).toThrow(/no such server-global pack/);
    expect(() => previewProjectPack(cfg, MASTER, 'demo', 'broken', 'profiles: 7\n')).toThrow(/Not a valid declarative pack/);
    expect(snapshot('demo')).toEqual(before);
  });

  it('previews a removal as what the pack accounts for now, writing nothing; an unregistered name is rejected', () => {
    createPlacedProject(cfg, MASTER, 'demo');
    installProjectPack(cfg, MASTER, 'demo', 'acme-svc', ACME_YAML);
    allow(dataDir, 'u-reader', 'project:read', 'project', 'demo');
    const reader = mintUserToken(dataDir, { id: 'k-reader', userId: 'u-reader' });
    const before = snapshot('demo');
    expect(before.packs).toEqual(['acme-svc.yaml']);

    const removal = previewProjectPackRemoval(cfg, reader, 'demo', 'acme-svc');
    expect(removal.direction).toBe('remove');
    expect(addedProfile(removal)).toBe(true);
    expect(snapshot('demo')).toEqual(before);

    expect(() => previewProjectPackRemoval(cfg, reader, 'demo', 'ghost')).toThrow(/no registered pack/);
    const stranger = mintUserToken(dataDir, { id: 'k-stranger', userId: 'u-stranger' });
    expect(() => previewProjectPackRemoval(cfg, stranger, 'demo', 'acme-svc')).toThrow(AdminAuthError);
  });

  // ── policy writes carry their impacts ─────────────────────────────────────

  it('evaluate states what a reconcile would apply, writing nothing; reconcile measures each pack before its write and reports it', () => {
    createPlacedProject(cfg, MASTER, 'demo');
    seedGlobal();
    setPackPolicyRecord(dataDir, policy({ requiredGlobalPacks: ['acme-svc'] }));
    const before = snapshot('demo');

    const evaluation = evaluateProjectPolicy(cfg, MASTER, 'demo');
    expect(evaluation.missingPackNames).toEqual(['acme-svc']);
    expect(evaluation.impacts?.map((i) => i.pack)).toEqual(['acme-svc']);
    expect(addedProfile(evaluation.impacts![0])).toBe(true);
    expect(snapshot('demo')).toEqual(before);

    const reconciled = reconcileProjectPolicy(cfg, MASTER, 'demo');
    expect(reconciled.impacts?.map((i) => i.pack)).toEqual(['acme-svc']);
    expect(reconciled.impacts![0].direction).toBe('apply');
    expect(reconciled.messages.some((m) => m.startsWith('Applied pack acme-svc v1.0.0:'))).toBe(true);
    expect(snapshot('demo').packs).toEqual(['acme-svc.yaml']);
    const audit = queryAuditEvents(dataDir, { action: 'policy.reconcile', projectId: 'demo' });
    expect(JSON.parse(audit[0].metadata ?? '{}').impacts[0]).toMatchObject({ pack: 'acme-svc', version: '1.0.0' });

    // Nothing left to apply: the next evaluation measures nothing.
    expect(evaluateProjectPolicy(cfg, MASTER, 'demo').impacts).toEqual([]);
  });

  it('evaluateInitRequest carries each required pack\'s doctrine alone — no project exists, so no finding diff', () => {
    seedGlobal();
    setPackPolicyRecord(dataDir, policy({ defaultProjectPacks: ['acme-svc'] }));
    const unit = seedUnit(dataDir, 'makers');
    const evaluation = evaluateInitRequest(cfg, { id: 'later', ownerUnitId: unit.id });
    expect(evaluation.doctrine?.map((d) => d.pack)).toEqual(['acme-svc']);
    expect(addedProfile({ doctrine: evaluation.doctrine![0].changes })).toBe(true);
    expect(evaluation.doctrine![0]).not.toHaveProperty('findings');
    expect(existingProjectRoot(dataDir, 'later')).toBeNull();
  });

  it('setProjectType returns the impact of the write it made, the adopted pack as the entry', () => {
    createPlacedProject(cfg, MASTER, 'demo');
    seedGlobal();
    const view = setProjectType(cfg, MASTER, 'demo', 'acme-svc');
    expect(view.projectType).toBe('acme-svc');
    expect(view.adoptedPackName).toBe('acme-svc');
    expect(view.impact?.pack).toBe('acme-svc');
    expect(view.impact?.governing).toEqual(['acme-svc']);
    expect(addedProfile(view.impact!)).toBe(true);
  });

  it('a policy-governed init returns a GovernedProjectCreation — each pack and the governing profile measured — and audits them', () => {
    seedGlobal();
    setPackPolicyRecord(dataDir, policy({ requiredGlobalPacks: ['acme-svc'], requiredProfileIds: ['acme-svc'] }));
    const unit = seedUnit(dataDir, 'makers');
    allow(dataDir, 'u-cr', 'project:create', 'unit', unit.id);
    const creator = mintUserToken(dataDir, { id: 'k-cr', userId: 'u-cr' });

    const creation = initializeProjectWithProfile(cfg, creator, { id: 'governed', ownerUnitId: unit.id });

    // The persisted record, unchanged — the wrapper is never stored.
    expect(creation.record.id).toBe('governed');
    expect(Object.keys(creation.record).sort()).toEqual(['createdAt', 'id', 'rootPath', 'status']);
    expect(creation.packImpacts.map((i) => i.pack)).toEqual(['acme-svc']);
    expect(addedProfile(creation.packImpacts[0])).toBe(true);
    // The governing-profile step, measured separately: the profile is contributed
    // by the pack the loop registered, so nothing is adopted and no entry changes.
    expect(creation.profileImpact?.pack).toBe('projectType acme-svc');
    expect(creation.profileImpact?.governing).toEqual([]);

    const events = queryAuditEvents(dataDir, { action: 'project.init.policy', projectId: 'governed' });
    const metadata = JSON.parse(events[0].metadata ?? '{}');
    expect(metadata.packImpacts).toEqual([expect.objectContaining({ pack: 'acme-svc', version: '1.0.0' })]);
    expect(metadata.profileImpact).toMatchObject({ pack: 'projectType acme-svc' });
  });

  it('an approved project:init records what it applied as the approval\'s executionSummary', () => {
    seedGlobal();
    setPackPolicyRecord(dataDir, policy({ requiredGlobalPacks: ['acme-svc'] }));
    const unit = seedUnit(dataDir, 'askers');
    allow(dataDir, 'u-ask', 'project:create', 'unit', unit.id, 'approval');
    allow(dataDir, 'u-dec', 'approval:decide', 'instance', undefined);
    const requester = mintUserToken(dataDir, { id: 'k-ask', userId: 'u-ask' });
    const decider = mintUserToken(dataDir, { id: 'k-dec', userId: 'u-dec' });

    const pending = initializeProject(cfg, requester, { id: 'approved-one', ownerUnitId: unit.id });
    expect(pending.status).toBe('pending-approval');
    expect(pending.creation).toBeUndefined();

    const decided = decideRequest(cfg, decider, {
      requestId: pending.approval!.id,
      approved: true,
      decidedBy: subjectOf('client-supplied'),
      decidedAt: '',
    });
    expect(decided.status).toBe('completed');
    expect(decided.executionSummary).toMatch(/^Applied pack acme-svc v1\.0\.0: \d+ doctrine change\(s\)/);
    expect(getApprovalRequestById(dataDir, decided.id)?.executionSummary).toBe(decided.executionSummary);
  });

  it('the execute-primary init answers the creation on its completed outcome', () => {
    seedGlobal();
    setPackPolicyRecord(dataDir, policy({ defaultProjectPacks: ['acme-svc'] }));
    const unit = seedUnit(dataDir, 'makers');
    allow(dataDir, 'u-cr', 'project:create', 'unit', unit.id);
    const creator = mintUserToken(dataDir, { id: 'k-cr', userId: 'u-cr' });
    const outcome = initializeProject(cfg, creator, { id: 'direct', ownerUnitId: unit.id });
    expect(outcome.status).toBe('completed');
    expect(outcome.creation?.record.id).toBe('direct');
    expect(outcome.creation?.packImpacts.map((i) => i.pack)).toEqual(['acme-svc']);
  });

  it('the manual execution retry also records and answers the executionSummary', () => {
    setPackPolicyRecord(dataDir, policy());
    const unit = seedUnit(dataDir, 'askers');
    allow(dataDir, 'u-ask', 'project:create', 'unit', unit.id, 'approval');
    const requester = mintUserToken(dataDir, { id: 'k-ask', userId: 'u-ask' });
    const pending = initializeProject(cfg, requester, { id: 'retry-one', ownerUnitId: unit.id });
    // Approved but not executed (the auto-execution failed earlier): approve on disk.
    const file = path.join(dataDir, 'approvals.json');
    const records = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; status: string }[];
    fs.writeFileSync(file, JSON.stringify(records.map((r) => (r.id === pending.approval!.id ? { ...r, status: 'approved' } : r))));

    const outcome = executeApprovedRequest(cfg, requester, pending.approval!.id);
    expect(outcome).toMatch(/Initialized project "retry-one"/);
    expect(outcome).toMatch(/The instance policy applied no pack and no governing profile\./);
    expect(getApprovalRequestById(dataDir, pending.approval!.id)?.executionSummary).toBe(
      'The instance policy applied no pack and no governing profile.',
    );
  });

  it('a principal without project:write is still refused the policy writes', () => {
    createPlacedProject(cfg, MASTER, 'demo');
    allow(dataDir, 'u-reader', 'project:read', 'project', 'demo');
    const reader = mintUserToken(dataDir, { id: 'k-reader', userId: 'u-reader' });
    expect(() => evaluateProjectPolicy(cfg, reader, 'demo')).toThrow(ForbiddenError);
  });
});

// ── the routes and the hosted MCP tool ──────────────────────────────────────

describe('hosted pack impact over HTTP (admin API, web routes, sdd_host_pack_impact)', () => {
  let tmp: string;
  let dataDir: string;
  let packsDir: string;
  let cfg: HostConfig;
  let data: http.Server;
  let admin: http.Server;
  let dataPort: number;
  let adminPort: number;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

  function send(port: number, opts: { method: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers }, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
      });
      req.on('error', reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hosted-impact-http-'));
    dataDir = path.join(tmp, 'data');
    packsDir = path.join(tmp, 'instance-packs');
    const home = path.join(tmp, 'home');
    for (const dir of [dataDir, packsDir, home, path.join(tmp, 'image-packs')]) fs.mkdirSync(dir, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.APPDATA = home;
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    process.env.WAIRON_PACKS_DIR = packsDir;
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(tmp, 'image-packs');
    fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true, requireTls: false }));
    fs.writeFileSync(path.join(packsDir, 'acme-svc.yaml'), ACME_YAML);
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    data = http.createServer((req, res) => routeData(cfg, req, res));
    admin = http.createServer((req, res) => void routeAdmin(cfg, req, res));
    await new Promise<void>((resolve) => data.listen(0, '127.0.0.1', () => resolve()));
    await new Promise<void>((resolve) => admin.listen(0, '127.0.0.1', () => resolve()));
    dataPort = (data.address() as AddressInfo).port;
    adminPort = (admin.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const server of [data, admin]) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    process.env = { ...savedEnv };
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  function configOf(project: string): string {
    return fs.readFileSync(path.join(existingProjectRoot(dataDir, project)!, '.wai', 'project.yaml'), 'utf8');
  }

  it('the admin API answers both previews and writes nothing', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    const before = configOf('demo');
    const headers = { authorization: `Bearer ${MASTER}`, 'content-type': 'application/json' };

    const install = await send(adminPort, { method: 'POST', path: '/admin/projects/demo/packs/acme-svc/impact', headers, body: JSON.stringify({ content: ACME_YAML }) });
    expect(install.status).toBe(200);
    expect(JSON.parse(install.body)).toMatchObject({ pack: 'acme-svc', direction: 'apply' });

    const adopt = await send(adminPort, { method: 'POST', path: '/admin/projects/demo/packs/acme-svc/impact', headers, body: '{}' });
    expect(JSON.parse(adopt.body)).toMatchObject({ pack: 'acme-svc', direction: 'apply' });
    expect(configOf('demo')).toBe(before);

    await send(adminPort, { method: 'PUT', path: '/admin/projects/demo/packs/acme-svc', headers, body: JSON.stringify({ content: ACME_YAML }) });
    const registered = configOf('demo');
    const removal = await send(adminPort, { method: 'POST', path: '/admin/projects/demo/packs/acme-svc/removal-impact', headers, body: '{}' });
    expect(removal.status).toBe(200);
    expect(JSON.parse(removal.body)).toMatchObject({ pack: 'acme-svc', direction: 'remove' });
    expect(configOf('demo')).toBe(registered);
  });

  it('the web routes answer both previews for a reader, are CSRF-gated, and refuse a session without read', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    allow(dataDir, 'u-reader', 'project:read', 'project', 'demo');
    const reader = createWebSession(dataDir, { id: '', subject: subjectOf('u-reader'), projects: ['*'], createdAt: '', expiresAt: FUTURE() });
    const stranger = createWebSession(dataDir, { id: '', subject: subjectOf('u-stranger'), projects: ['*'], createdAt: '', expiresAt: FUTURE() });
    const headers = (session: string, csrf = true): Record<string, string> => ({
      cookie: `wairon_session=${session}`,
      'content-type': 'application/json',
      ...(csrf ? { 'x-wairon-web': '1' } : {}),
    });
    const before = configOf('demo');

    const preview = await send(dataPort, {
      method: 'POST', path: '/web/projects/packs/impact', headers: headers(reader.id),
      body: JSON.stringify({ projectId: 'demo', name: 'acme-svc', content: ACME_YAML }),
    });
    expect(preview.status).toBe(200);
    expect(JSON.parse(preview.body)).toMatchObject({ pack: 'acme-svc', version: '1.0.0', direction: 'apply' });

    const adoption = await send(dataPort, {
      method: 'POST', path: '/web/projects/packs/impact', headers: headers(reader.id),
      body: JSON.stringify({ projectId: 'demo', name: 'acme-svc' }),
    });
    expect(JSON.parse(adoption.body).governing).toEqual([]);
    expect(configOf('demo')).toBe(before);

    const noCsrf = await send(dataPort, {
      method: 'POST', path: '/web/projects/packs/impact', headers: headers(reader.id, false),
      body: JSON.stringify({ projectId: 'demo', name: 'acme-svc' }),
    });
    expect(noCsrf.status).toBe(403);

    const refused = await send(dataPort, {
      method: 'POST', path: '/web/projects/packs/impact', headers: headers(stranger.id),
      body: JSON.stringify({ projectId: 'demo', name: 'acme-svc' }),
    });
    expect(refused.status).toBe(403);

    const unregistered = await send(dataPort, {
      method: 'POST', path: '/web/projects/packs/removal-impact', headers: headers(reader.id),
      body: JSON.stringify({ projectId: 'demo', name: 'acme-svc' }),
    });
    expect(unregistered.status).toBeGreaterThanOrEqual(400);

    const inst = ensureInstanceIdentity(dataDir);
    const adminSession = createWebSession(dataDir, {
      id: '', subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' }, projects: ['*'], createdAt: '', expiresAt: FUTURE(),
    });
    await send(dataPort, {
      method: 'POST', path: '/web/projects/packs/adopt', headers: headers(adminSession.id),
      body: JSON.stringify({ projectId: 'demo', name: 'acme-svc' }),
    });
    const removal = await send(dataPort, {
      method: 'POST', path: '/web/projects/packs/removal-impact', headers: headers(reader.id),
      body: JSON.stringify({ projectId: 'demo', name: 'acme-svc' }),
    });
    expect(removal.status).toBe(200);
    expect(JSON.parse(removal.body)).toMatchObject({ pack: 'acme-svc', direction: 'remove' });
  });

  it('the web create answers the GovernedProjectCreation', async () => {
    setPackPolicyRecord(dataDir, policy({ requiredGlobalPacks: ['acme-svc'] }));
    const inst = ensureInstanceIdentity(dataDir);
    const session = createWebSession(dataDir, {
      id: '', subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' }, projects: ['*'], createdAt: '', expiresAt: FUTURE(),
    });
    const unit = seedUnit(dataDir, 'makers');
    const created = await send(dataPort, {
      method: 'POST', path: '/web/projects',
      headers: { cookie: `wairon_session=${session.id}`, 'content-type': 'application/json', 'x-wairon-web': '1' },
      body: JSON.stringify({ id: 'from-web', unitId: unit.id }),
    });
    expect(created.status).toBe(201);
    const creation = JSON.parse(created.body);
    expect(creation.record.id).toBe('from-web');
    expect(creation.packImpacts.map((i: PackImpact) => i.pack)).toEqual(['acme-svc']);
  });

  it('sdd_host_pack_impact measures on the BOUND project with project:read, writing nothing', async () => {
    createPlacedProject(cfg, MASTER, 'demo');
    allow(dataDir, 'u-agent', 'project:read', 'project', 'demo');
    const token = mintUserToken(dataDir, { id: 'k-agent', userId: 'u-agent', projects: ['demo'] });
    const call = (name: string, args: Record<string, unknown>) =>
      send(dataPort, {
        method: 'POST',
        path: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
    const before = configOf('demo');

    const measured = JSON.parse((await call('sdd_host_pack_impact', { name: 'acme-svc', content: ACME_YAML })).body).result;
    expect(measured.isError).toBeFalsy();
    expect(JSON.parse(measured.content[0].text)).toMatchObject({ pack: 'acme-svc', direction: 'apply' });
    // A project id in the arguments is ignored: the tool acts on the bound project.
    const adopted = JSON.parse((await call('sdd_host_pack_impact', { name: 'acme-svc', projectId: 'elsewhere' })).body).result;
    expect(adopted.isError).toBeFalsy();
    expect(configOf('demo')).toBe(before);

    // The install it previews still needs project:admin.
    const install = JSON.parse((await call('sdd_host_pack_install', { name: 'acme-svc', content: ACME_YAML })).body).result;
    expect(install.isError).toBe(true);
    expect(configOf('demo')).toBe(before);
  });
});
