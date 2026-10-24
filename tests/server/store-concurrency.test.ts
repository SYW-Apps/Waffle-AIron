import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { listApprovalRequests } from '../../src/server/approvals.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { listBindings } from '../../src/server/gitbacking.js';
import { getInstanceIdentity } from '../../src/server/instance.js';
import { listOrganizationUnits } from '../../src/server/organization.js';
import { listAssignments } from '../../src/server/permissions.js';
import { listIdentityProviderRecords } from '../../src/server/policy.js';
import { listProjectRelations } from '../../src/server/relations.js';
import { getPublicSurfaceSnapshot } from '../../src/server/surfaces.js';
import { listRoles } from '../../src/server/roles.js';
import { listLinkAccess } from '../../src/server/shareaccesslog.js';
import { listProjectLinks } from '../../src/server/sharelinks.js';
import { listUsers } from '../../src/server/users.js';
import { getWebSessionById } from '../../src/server/websessions.js';

// ---------------------------------------------------------------------------
// Every hosted store does ONE locked read-modify-write: N writers in SEPARATE
// processes, each writing its own record many times, and every record is still
// there afterwards. Real processes, real files; nothing mocked. QA lost grants
// with parallel `host permission set` and units with parallel creates; both
// shapes are here (through the host commands the CLI runs), beside one case per
// store.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '../..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WRITERS = ['a', 'b', 'c', 'd'];
const ROUNDS = 8;
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function scratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-concurrency-'));
  temps.push(dir);
  return dir;
}

const url = (rel: string): string => JSON.stringify(new URL(`file:///${path.join(REPO, rel).replace(/\\/g, '/')}`).href);

function worker(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, script, ...args], { cwd: REPO, env: { ...process.env, ...env } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * Run `op` (a statement over `m` = the module, `dataDir`, `who` and `i`) ROUNDS
 * times in each of the writer processes at once; every process must exit 0.
 */
async function runWriters(dir: string, modulePath: string, op: string, env: Record<string, string> = {}): Promise<void> {
  const file = path.join(dir, `writer-${path.basename(modulePath)}.mts`);
  fs.writeFileSync(file, [
    `const m0 = await import(${url(modulePath)});`,
    'const m = m0.default ?? m0;',
    'const [dataDir, who] = process.argv.slice(2);',
    `for (let i = 0; i < ${ROUNDS}; i++) {`,
    `  await Promise.resolve(${op});`,
    '}',
  ].join('\n'));
  const runs = await Promise.all(WRITERS.map((who) => worker(file, [dir, who], env)));
  for (const r of runs) expect(r.code, r.out).toBe(0);
}

const TOTAL = WRITERS.length * ROUNDS;
const SUBJECT = "{ userId: 'u-' + who, kind: 'user', issuer: 'local' }";
const NOW = 'new Date().toISOString()';

describe('every store keeps all of N parallel writers (separate processes)', () => {
  it('approval_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/approvals.ts',
      `m.createApprovalRequest(dataDir, { kind: 'project:init', summary: who + i, requestedBy: ${SUBJECT}, projectId: 'p' })`);
    expect(listApprovalRequests(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('audit_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/audit.ts',
      `m.appendAuditEvent(dataDir, { id: who + '-' + i, timestamp: ${NOW}, level: 'info', category: 'test', action: 'x.y', outcome: 'success', actor: ${SUBJECT} }, `
      + "{ enabled: true, minimumLevel: 'info', retentionDays: 30, includeReadEvents: true, metadataMode: 'full' })");
    expect(queryAuditEvents(dir, {})).toHaveLength(TOTAL);
  }, 120_000);

  it('git_backing_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/gitbacking.ts',
      `m.upsertBinding(dataDir, { id: '', scopeKind: 'unit', scopeId: who + i, remote: 'https://example.test/r.git', branch: 'main', createdAt: '', createdBy: ${SUBJECT} })`);
    expect(listBindings(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('instance_identity_store: parallel seeding agrees on one identity', async () => {
    const dir = scratch();
    const file = path.join(dir, 'seed.mts');
    fs.writeFileSync(file, [
      `const m0 = await import(${url('src/server/instance.ts')});`,
      'const m = m0.default ?? m0;',
      'const [dataDir] = process.argv.slice(2);',
      'console.log("IDENTITY " + JSON.stringify(m.ensureInstanceIdentity(dataDir)));',
    ].join('\n'));
    const runs = await Promise.all(WRITERS.map(() => worker(file, [dir])));
    const seen = new Set<string>();
    for (const r of runs) {
      expect(r.code, r.out).toBe(0);
      seen.add(/IDENTITY (.*)/.exec(r.out)?.[1] ?? '');
    }
    expect(seen.size).toBe(1);
    expect(JSON.stringify(getInstanceIdentity(dir))).toBe([...seen][0]);
  }, 120_000);

  it('organization_store: parallel unit creates', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/organization.ts',
      "m.createUnit(dataDir, { id: '', slug: who + i, name: who + i, kind: 'business_entity', status: 'active', createdAt: '' })");
    expect(listOrganizationUnits(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('permission_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/permissions.ts',
      "m.setAssignment(dataDir, { id: '', subjectKind: 'user', subjectId: who, scopeKind: 'project', scopeId: 'p' + i, capability: 'project:read', value: 'yes', createdAt: '' })");
    expect(listAssignments(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('policy_store: the identity-provider collection', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/policy.ts',
      "m.upsertIdentityProviderRecord(dataDir, { id: who + i, providerType: 'oidc', enabled: true, updatedAt: '' })");
    expect(listIdentityProviderRecords(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('project_relation_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/relations.ts',
      `m.upsertProjectRelation(dataDir, { id: '', sourceProjectId: who, targetProjectId: 't' + i, kind: 'consumes', targetPublicInterface: {}, reason: 'r', status: 'active', createdAt: ${NOW}, createdBy: ${SUBJECT} })`);
    expect(listProjectRelations(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('public_surface_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/surfaces.ts',
      "m.replacePublicSurfaceSnapshot(dataDir, { projectId: who + i, stateId: 's', systemName: 'x', interfaces: [], exportedAt: '' })");
    for (const who of WRITERS) for (let i = 0; i < ROUNDS; i++) expect(getPublicSurfaceSnapshot(dir, who + i)).not.toBeNull();
  }, 120_000);

  it('role_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/roles.ts',
      "m.createRole(dataDir, { id: 'role-' + who + i, name: who + i, permissions: [], createdAt: '' })");
    expect(listRoles(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('share_access_store: appends are locked', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/shareaccesslog.ts',
      `m.appendAccess(dataDir, { id: '', linkId: 'l1', at: ${NOW}, ip: '1.2.3.4', userAgent: who, outcome: 'ok' })`);
    expect(listLinkAccess(dir, 'l1', 1000)).toHaveLength(TOTAL);
  }, 120_000);

  it('share_link_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/sharelinks.ts',
      `m.createLink(dataDir, { id: '', tokenHash: who + i, projectId: 'p', view: 'v', snapshotId: 's', mode: 'snapshot', enabled: true, allowDownloadHtml: false, allowDownloadOpenapi: false, frameAncestors: [], createdBy: ${SUBJECT}, createdAt: '' })`);
    expect(listProjectLinks(dir, 'p')).toHaveLength(TOTAL);
  }, 120_000);

  it('user_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/users.ts',
      "m.upsertUser(dataDir, { id: who + i, subject: { userId: who + i, kind: 'user', issuer: 'local' }, status: 'active', createdAt: '', roleBindings: [] })");
    expect(listUsers(dir)).toHaveLength(TOTAL);
  }, 120_000);

  it('web_session_store', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/server/websessions.ts',
      `m.createWebSession(dataDir, { id: 'ws-' + who + i, subject: ${SUBJECT}, projects: ['*'], createdAt: '', expiresAt: '2999-01-01T00:00:00.000Z' })`);
    for (const who of WRITERS) for (let i = 0; i < ROUNDS; i++) expect(getWebSessionById(dir, `ws-${who}${i}`)).not.toBeNull();
  }, 120_000);

  it('secret_store: no fixed temp name, every key survives, the file is not left corrupt', async () => {
    const dir = scratch();
    await runWriters(dir, 'src/utils/secrets.ts', "m.setSecret('key-' + who + i, 'v')", { WAIRON_DATA_DIR: dir });
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'auth', 'secrets.json'), 'utf8')) as Record<string, string>;
    expect(Object.keys(stored)).toHaveLength(TOTAL);
    expect(fs.readdirSync(path.join(dir, 'auth')).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  }, 120_000);
});

describe('the host commands an operator runs in parallel', () => {
  it('parallel `host permission set` keeps every grant and parallel `host unit create` every unit', async () => {
    const dir = scratch();
    const env = { WAIRON_ADMIN_TOKEN: 'store-concurrency-master', WAIRON_DATA_DIR: dir, HOME: dir, USERPROFILE: dir };
    // The unit the grants are scoped to is created first, alone.
    const seed = path.join(dir, 'seed-unit.mts');
    fs.writeFileSync(seed, [
      `const m0 = await import(${url('src/commands/host.ts')});`,
      'const m = m0.default ?? m0;',
      'await m.runHostUnit("create", { dataDir: process.argv[2], slug: "acme" });',
    ].join('\n'));
    const seeded = await worker(seed, [dir], env);
    expect(seeded.code, seeded.out).toBe(0);

    const file = path.join(dir, 'host-commands.mts');
    fs.writeFileSync(file, [
      `const m0 = await import(${url('src/commands/host.ts')});`,
      'const m = m0.default ?? m0;',
      'const [dataDir, who] = process.argv.slice(2);',
      `for (let i = 0; i < ${ROUNDS}; i++) {`,
      '  await m.runHostPermission("set", { dataDir, user: who + i, capability: "project:read", unit: "acme" });',
      '  await m.runHostUnit("create", { dataDir, slug: who + "-" + i });',
      '}',
    ].join('\n'));
    const runs = await Promise.all(WRITERS.map((who) => worker(file, [dir, who], env)));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    expect(listAssignments(dir)).toHaveLength(TOTAL);
    // acme and every created unit.
    expect(listOrganizationUnits(dir)).toHaveLength(TOTAL + 1);
  }, 180_000);
});
