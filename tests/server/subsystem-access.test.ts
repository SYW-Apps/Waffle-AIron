import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { createProjectRecord, listProjectRecords } from '../../src/server/projects.js';
import { upgradeMemberRecords, listAssignments as localListAssignments } from '../../src/server/local-admin.js';
import { authorize } from '../../src/server/authorization.js';
import { setAssignment as repoSetAssignment } from '../../src/server/permissions.js';
import { setAssignment, bindRole, explain, listAssignments } from '../../src/server/permissionadmin.js';
import { generateDiagram, downloadDiagram } from '../../src/server/admin.js';
import { listUsers, upsertUser } from '../../src/server/users.js';
import { placeProject as storePlacement } from '../../src/server/organization.js';
import { createWebSession } from '../../src/server/websessions.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { routeData } from '../../src/server/http.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { runHostPermission } from '../../src/commands/host.js';
import { allow, mintUserToken, seedUnit, subjectOf } from './helpers.js';
import { buildHostedFamily, type HostedFamily } from './hosted-family.js';
import { system, subsystem, component } from '../helpers/stage8-family.js';
import type { Capability, HostConfig, HostedUserRecord, PermissionValue, Principal, RoleBinding } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Subsystem access rules on a hosted instance, end to end: real temp dirs, the
// real data-plane router over HTTP, real minted credentials, every
// machine-global location redirected (HOME, USERPROFILE, APPDATA, LOCALAPPDATA
// and a temp WAIRON_CACHE_DIR). Nothing on the path under test is mocked.
//
// The family (platform ⊃ billing ⊃ payments, platform ⊃ docs) carries two
// subsystems in platform: `payments` and `catalog`.
// ---------------------------------------------------------------------------

const MASTER = 'subsystem-access-master-credential-0123456789';
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WAIRON_CACHE_DIR', 'WAIRON_ADMIN_TOKEN', 'WAIRON_DATA_DIR'] as const;

let base: string;
let dataDir: string;
let cfg: HostConfig;
let fam: HostedFamily;
let unitId: string;
let savedEnv: (readonly [string, string | undefined])[];
let server: http.Server;
let port: number;
let dev: string;

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-subsys-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  process.env.WAIRON_CACHE_DIR = path.join(base, 'cache');
  process.env.WAIRON_ADMIN_TOKEN = MASTER;
  dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.WAIRON_DATA_DIR = dataDir;
  cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  ensureInstanceIdentity(dataDir);
  fam = buildHostedFamily(dataDir);
  unitId = seedUnit(dataDir, 'eng').id;
  storePlacement(dataDir, { id: '', projectId: 'platform', unitId, role: 'owner', createdAt: '', createdBy: subjectOf('u-seeder') });
  fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true, requireTls: false }));
  expect(upgradeMemberRecords({ dataDir }, true).applied).toBe(true);
  invalidateSpecCache();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  server = http.createServer((req, res) => routeData(cfg, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
  dev = await seedTree();
});

afterEach(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

function user(id: string, roleBindings: RoleBinding[] = []): HostedUserRecord {
  return upsertUser(dataDir, { id, subject: subjectOf(id), status: 'active', createdAt: new Date().toISOString(), roleBindings });
}

const principalOf = (id: string): Principal => ({
  tokenId: id, role: 'editor', projects: ['*'], authenticated: true, subject: subjectOf(id),
  permissionSubject: { subjectId: id, roleBindings: [], instanceAdmin: false },
});

/** A subsystem rule, stored directly in the grid (the admin plane is exercised separately). */
function rule(userId: string, scopeId: string, value: PermissionValue, capability: Capability = 'project:write'): void {
  repoSetAssignment(dataDir, { id: '', subjectKind: 'user', subjectId: userId, scopeKind: 'subsystem', scopeId, capability, value, createdAt: '' });
}

interface ToolAnswer { text: string; texts: string[]; isError: boolean }

async function call(token: string, tool: string, args: Record<string, unknown>, selector = 'platform'): Promise<ToolAnswer> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp?project=${selector}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  const texts = (body.result?.content ?? []).map((c) => c.text ?? '');
  invalidateSpecCache();
  return { text: texts.join('\n'), texts, isError: body.result?.isError === true };
}

async function web(sessionId: string, route: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { cookie: `wairon_session=${sessionId}`, 'x-wairon-web': '1' } });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body };
}

function sessionFor(userId: string): string {
  return createWebSession(dataDir, {
    id: '', subject: subjectOf(userId), projects: ['*'], createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  }).id;
}

/** Every file under a directory by digest (byte identity). */
function bytes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

const comp = (id: string, sub: string, dependsOn: string[] = []) => ({ id, name: id, description: `The ${id} component`, subsystem: sub, componentType: 'Orchestrator', dependsOn });

/** u-dev writes platform's whole tree; the tree gets payments, catalog and orders, each with a component. */
async function seedTree(): Promise<string> {
  user('u-dev');
  allow(dataDir, 'u-dev', 'project:read', 'project', 'platform');
  allow(dataDir, 'u-dev', 'project:write', 'project', 'platform');
  const token = mintUserToken(dataDir, { id: 'tok-dev', userId: 'u-dev', projects: ['platform'] });
  for (const id of ['payments', 'catalog', 'orders']) {
    const added = await call(token, 'sdd_add_subsystem', { id, name: id, description: `The ${id} subsystem` });
    expect(added.isError, added.text).toBe(false);
  }
  for (const [id, sub, deps] of [['cat_store', 'catalog', []], ['pay_gate', 'payments', ['cat_store']], ['order_flow', 'orders', ['cat_store']]] as const) {
    // catalog's front door is a Portal: since round 8 the write gate refuses a
    // cross-subsystem edge into a non-Portal, which no later write can cure.
    const spec = id === 'cat_store' ? { ...comp(id, sub), componentType: 'Portal', transport: 'InProcess' } : comp(id, sub, [...deps]);
    const added = await call(token, 'sdd_add_component', spec);
    expect(added.isError, added.text).toBe(false);
  }
  return token;
}

/** A token for a user reading platform's family, with the given project:write. */
function teamToken(id: string, projectWrite?: PermissionValue): string {
  user(id);
  allow(dataDir, id, 'project:read', 'project', 'platform');
  if (projectWrite) allow(dataDir, id, 'project:write', 'project', 'platform', projectWrite);
  return mintUserToken(dataDir, { id: `tok-${id}`, userId: id, projects: ['platform'] });
}

// ── allow and deny ──────────────────────────────────────────────────────────

describe('a subsystem rule decides spec writes in its subsystem', () => {
  it('allow: yes on payments only, with no project write, edits payments and is refused elsewhere — the L0 included', async () => {
    const team = teamToken('u-team');
    rule('u-team', 'platform/payments', 'yes');
    const ok = await call(team, 'sdd_add_component', comp('pay_ledger', 'payments'));
    expect(ok.isError, ok.text).toBe(false);
    const updated = await call(team, 'sdd_update_spec', { kind: 'component', id: 'pay_gate', delta: { description: 'Updated by the payments team' } });
    expect(updated.isError, updated.text).toBe(false);

    const tree = bytes(fam.platform);
    const elsewhere = await call(team, 'sdd_add_component', comp('cat_index', 'catalog'));
    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toMatch(/SubsystemWriteDenied/);
    expect(elsewhere.text).toMatch(/subsystem "catalog" of project "platform"/);
    const l0 = await call(team, 'sdd_update_spec', { kind: 'system', id: 'system', delta: { vision: 'taken over' } });
    expect(l0.isError).toBe(true);
    expect(l0.text).toMatch(/project "platform" itself/);
    const newSubsystem = await call(team, 'sdd_add_subsystem', { id: 'fresh', name: 'fresh', description: 'A new subsystem' });
    expect(newSubsystem.isError).toBe(true);
    // A write that is not subsystem-scoped needs the project rung, and says which rung decided.
    const pin = await call(team, 'sdd_pin_externals', {});
    expect(pin.isError).toBe(true);
    expect(pin.text).toMatch(/Forbidden — permission project:write required for sdd_pin_externals, decided at the instance default/);
    expect(bytes(fam.platform)).toEqual(tree);
  });

  it('a user with no subsystem rule and no project write is refused at the door, as before', async () => {
    const reader = teamToken('u-reader');
    const refused = await call(reader, 'sdd_add_component', comp('pay_x', 'payments'));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Forbidden — permission project:write required/);
  });

  it('deny: payments denied to someone with project write — payments is refused, catalog is not', async () => {
    const deny = teamToken('u-deny', 'yes');
    rule('u-deny', 'platform/payments', 'no');
    const tree = bytes(fam.platform);
    const refused = await call(deny, 'sdd_update_spec', { kind: 'component', id: 'pay_gate', delta: { description: 'no' } });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/subsystem "payments" of project "platform" \(decided by a user setting at subsystem payments of project platform\)/);
    const deleted = await call(deny, 'sdd_delete_spec', { kind: 'component', id: 'pay_gate' });
    expect(deleted.isError).toBe(true);
    // Moving a component out of the denied subsystem changes that subsystem too.
    const moved = await call(deny, 'sdd_add_component', comp('pay_gate', 'catalog', ['cat_store']));
    expect(moved.isError).toBe(true);
    expect(bytes(fam.platform)).toEqual(tree);
    const ok = await call(deny, 'sdd_add_component', comp('cat_index', 'catalog'));
    expect(ok.isError, ok.text).toBe(false);
  });

  it('an interface or implementation follows its component', async () => {
    const deny = teamToken('u-deny', 'yes');
    rule('u-deny', 'platform/payments', 'no');
    const contract = { id: 'ipay_gate', name: 'Pay gate', description: 'c', component: 'pay_gate', methods: [{ name: 'charge', description: 'Charge', signature: 'charge(): void', returns: 'void' }] };
    const refused = await call(deny, 'sdd_define_interface', contract);
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/subsystem "payments"/);
    const ok = await call(deny, 'sdd_define_interface', { ...contract, id: 'icat_store', component: 'cat_store' });
    expect(ok.isError, ok.text).toBe(false);
  });
});

// ── multi-subsystem writes ──────────────────────────────────────────────────

describe('a rename or a move is judged whole, before the first write', () => {
  it('a rename that would rewrite references in two denied subsystems refuses naming both, and writes nothing', async () => {
    const deny = teamToken('u-deny', 'yes');
    rule('u-deny', 'platform/payments', 'no');
    rule('u-deny', 'platform/orders', 'no');
    const tree = bytes(fam.platform);
    const renamed = await call(deny, 'sdd_rename_component', { id: 'cat_store', newId: 'catalog_store' });
    expect(renamed.isError).toBe(true);
    expect(renamed.text).toMatch(/subsystem "payments" of project "platform"/);
    expect(renamed.text).toMatch(/subsystem "orders" of project "platform"/);
    expect(renamed.text).toMatch(/Nothing was written/);
    expect(bytes(fam.platform)).toEqual(tree);
    // The writer of the whole project renames it.
    const ok = await call(dev, 'sdd_rename_component', { id: 'cat_store', newId: 'catalog_store' });
    expect(ok.isError, ok.text).toBe(false);
  });

  it('a method move out of a denied subsystem refuses naming it, and writes nothing', async () => {
    for (const [id, owner] of [['ipay_gate', 'pay_gate'], ['icat_store', 'cat_store']] as const) {
      const defined = await call(dev, 'sdd_define_interface', { id, name: id, description: 'c', component: owner, methods: [{ name: owner === 'pay_gate' ? 'quote' : 'lookup', description: 'm', signature: 'm(): void', returns: 'void' }] });
      expect(defined.isError, defined.text).toBe(false);
    }
    const deny = teamToken('u-deny', 'yes');
    rule('u-deny', 'platform/payments', 'no');
    const tree = bytes(fam.platform);
    const moved = await call(deny, 'sdd_move_methods', { from: 'pay_gate', to: 'cat_store', methods: ['quote'] });
    expect(moved.isError).toBe(true);
    expect(moved.text).toMatch(/SubsystemWriteDenied: moving methods from "pay_gate" to "cat_store"/);
    expect(moved.text).toMatch(/subsystem "payments"/);
    expect(bytes(fam.platform)).toEqual(tree);
  });
});

// ── whole-tree writes ───────────────────────────────────────────────────────

describe('a lock and a family migration are whole-tree writes', () => {
  it('a subsystem yes alone cannot lock; a subsystem denial refuses the lock, naming it', async () => {
    const team = teamToken('u-team');
    rule('u-team', 'platform/payments', 'yes');
    const alone = await call(team, 'sdd_host_lock_project', {});
    expect(alone.isError).toBe(true);
    expect(alone.text).toMatch(/caller may not lock this project/);

    const deny = teamToken('u-deny', 'yes');
    rule('u-deny', 'platform/payments', 'no');
    const refused = await call(deny, 'sdd_host_lock_project', {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/a lock signs the whole tree, and the caller may not change these subsystems: payments \(decided by a user setting at subsystem payments of project platform\)/);
    expect(fs.existsSync(path.join(fam.platform, '.wai', 'lock.json'))).toBe(false);
  });

  it('a family migration over a project holding a denied subsystem refuses subsystem-denied, naming it', async () => {
    const deny = teamToken('u-deny', 'yes');
    rule('u-deny', 'platform/orders', 'no');
    const tree = bytes(fam.platform);
    const renamed = await call(deny, 'sdd_rename_member_alias', { alias: 'docs', newAlias: 'handbook', dryRun: true });
    expect(renamed.isError).toBe(true);
    expect(renamed.text).toMatch(/subsystem-denied/);
    expect(renamed.text).toMatch(/holds subsystem \\"orders\\" this request may not change \(decided by a user setting at subsystem orders of project platform\)/);
    expect(bytes(fam.platform)).toEqual(tree);
    // The same plan by the writer of the whole project is not refused.
    const ok = await call(dev, 'sdd_rename_member_alias', { alias: 'docs', newAlias: 'handbook', dryRun: true });
    expect(ok.text).not.toMatch(/subsystem-denied/);
  });
});

// ── parts ───────────────────────────────────────────────────────────────────

describe('a part\'s subsystems are its project\'s own', () => {
  it('a rule at <project>/<part subsystem> decides writes in the part', async () => {
    const added = await call(dev, 'sdd_add_member', { alias: 'ledger', source: 'packages/ledger' });
    expect(added.isError, added.text).toBe(false);
    // The part's subsystem: written into the part's folder.
    const sub = path.join(fam.platform, 'packages', 'ledger', '.wai', 'specs', 'journal');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, '.index.yaml'), ['id: journal', 'name: journal', 'description: The journal', 'parentSystem: platform', 'publicInterfaces: []', 'trustedLinks: []', "createdAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", ''].join('\n'));
    invalidateSpecCache();
    const deny = teamToken('u-deny', 'yes');
    rule('u-deny', 'platform/journal', 'no');
    const tree = bytes(fam.platform);
    const refused = await call(deny, 'sdd_add_component', comp('journal_writer', 'journal'));
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/subsystem "journal" of project "platform"/);
    expect(bytes(fam.platform)).toEqual(tree);
    const ok = await call(dev, 'sdd_add_component', comp('journal_writer', 'journal'));
    expect(ok.isError, ok.text).toBe(false);
  });
});

// ── promote and externalize carry the rules ─────────────────────────────────

describe('a promote or an externalize never widens access', () => {
  it('externalize: a principal denied the subsystem is denied the new project; the carried rule is listed and audited', async () => {
    user('u-deny');
    allow(dataDir, 'u-deny', 'project:write', 'project', 'platform');
    // A subsystem nothing else names: it can leave the project as it is.
    expect((await call(dev, 'sdd_add_subsystem', { id: 'tooling', name: 'tooling', description: 'Build tooling' })).isError).toBe(false);
    expect((await call(dev, 'sdd_add_component', comp('tool_runner', 'tooling'))).isError).toBe(false);
    rule('u-deny', 'platform/tooling', 'no');
    // The plan lists the carried rule before anything is written.
    const tree = bytes(fam.platform);
    const dry = await call(dev, 'sdd_externalize_subsystem', { subsystem: 'tooling', path: 'packages/tooling', as: 'project', dryRun: true });
    expect(dry.isError, dry.text).toBe(false);
    const listing = dry.texts.find((t) => t.startsWith('Subsystem rules carried'))!;
    expect(listing).toContain('platform/tooling -> project tooling: u-deny project:write no (carried)');
    expect(bytes(fam.platform)).toEqual(tree);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'tooling')).toBe(false);
    const ext = await call(dev, 'sdd_externalize_subsystem', { subsystem: 'tooling', path: 'packages/tooling', as: 'project' });
    expect(ext.isError, ext.text).toBe(false);
    expect(listProjectRecords(dataDir).find((r) => r.id === 'tooling')).toMatchObject({ parentProjectId: 'platform' });
    // Without the carry the project's write would be inherited from platform's yes.
    expect(authorize(dataDir, principalOf('u-deny'), 'project:write', 'project', 'tooling')).toMatchObject({ value: 'no', decidedScopeKind: 'project', decidedScopeId: 'tooling' });
    expect(authorize(dataDir, principalOf('u-dev'), 'project:write', 'project', 'tooling').value).toBe('yes');
    const registered = queryAuditEvents(dataDir, { action: 'member.registered' }).find((e) => e.projectId === 'tooling');
    expect(JSON.parse(registered!.metadata!).reach).toContain('u-deny project:write: no -> no');
    // The subsystem rule itself is kept — and now labelled.
    const listed = listAssignments(cfg, MASTER, 'subsystem', 'platform/tooling');
    expect(listed).toEqual([expect.objectContaining({ subjectId: 'u-deny', scopeNote: 'subsystem not found' })]);
  });

  it('promote: a principal denied a part\'s subsystem is denied the promoted project', async () => {
    // payments (a member of billing) holds settlement; demoting it makes settlement billing's own.
    fs.mkdirSync(path.join(fam.payments, '.wai', 'specs', 'settlement'), { recursive: true });
    fs.writeFileSync(path.join(fam.payments, '.wai', 'specs', 'settlement', '.index.yaml'), ['id: settlement', 'name: settlement', 'description: Settles payments', 'parentSystem: payments', 'publicInterfaces: []', 'trustedLinks: []', 'status: complete', "createdAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", ''].join('\n'));
    fs.mkdirSync(path.join(fam.payments, '.wai', 'specs', 'refunds'), { recursive: true });
    fs.writeFileSync(path.join(fam.payments, '.wai', 'specs', 'refunds', '.index.yaml'), ['id: refunds', 'name: refunds', 'description: Refunds payments', 'parentSystem: payments', 'publicInterfaces: []', 'trustedLinks: []', 'status: complete', "createdAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", ''].join('\n'));
    const billingDev = dev;
    const demoted = await call(billingDev, 'sdd_demote_member', { alias: 'payments', destination: { home: 'settlement' } }, 'billing');
    expect(demoted.isError, demoted.text).toBe(false);
    user('u-deny');
    allow(dataDir, 'u-deny', 'project:write', 'project', 'platform');
    rule('u-deny', 'billing/settlement', 'no');
    rule('u-deny', 'billing/refunds', 'yes');
    rule('u-one', 'billing/refunds', 'yes');
    user('u-role', [{ roleId: 'writer', scopeKind: 'subsystem', scopeId: 'billing/settlement' }]);
    // While a part, the rule decides settlement's writes through billing.
    expect(authorize(dataDir, principalOf('u-deny'), 'project:write', 'subsystem', 'billing/settlement').value).toBe('no');
    // The plan lists every carried setting before anything is written: a carried
    // rule, a collapse with the resulting value, and a role binding not carried.
    const dry = await call(billingDev, 'sdd_promote_member', { alias: 'payments', dryRun: true }, 'billing');
    expect(dry.isError, dry.text).toBe(false);
    const listing = dry.texts.find((t) => t.startsWith('Subsystem rules carried'))!;
    expect(listing).toContain('billing/refunds, billing/settlement -> project payments: u-deny project:write no (most restrictive wins)');
    expect(listing).toContain('billing/refunds -> project payments: u-one project:write yes (carried)');
    expect(listing).toContain('billing/settlement -> project payments: u-role role writer — not carried (can only narrow)');
    expect(listProjectRecords(dataDir).find((r) => r.id === 'payments')).toMatchObject({ status: 'disabled' });
    const promoted = await call(billingDev, 'sdd_promote_member', { alias: 'payments' }, 'billing');
    expect(promoted.isError, promoted.text).toBe(false);
    expect(authorize(dataDir, principalOf('u-deny'), 'project:write', 'project', 'payments')).toMatchObject({ value: 'no', decidedScopeId: 'payments' });
    expect(authorize(dataDir, principalOf('u-deny'), 'project:write', 'project', 'billing').value).toBe('yes');
  });
});

// ── a member rename re-keys its subsystem rules ─────────────────────────────

describe('a member rename keeps its subsystem rules', () => {
  it('a subject denied <old>/payments is still denied <new>/payments after the rename, role bindings included', async () => {
    user('u-deny', [{ roleId: 'writer', scopeKind: 'subsystem', scopeId: 'billing/payments' }]);
    allow(dataDir, 'u-deny', 'project:write', 'project', 'platform');
    rule('u-deny', 'billing/payments', 'no');
    expect(authorize(dataDir, principalOf('u-deny'), 'project:write', 'subsystem', 'billing/payments').value).toBe('no');
    const renamed = await call(dev, 'sdd_rename_project', { newId: 'ledger', project: 'billing' });
    expect(renamed.isError, renamed.text).toBe(false);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'ledger')).toBe(true);
    // Still denied under the new id; nothing left behind under the old one.
    expect(authorize(dataDir, principalOf('u-deny'), 'project:write', 'subsystem', 'ledger/payments')).toMatchObject({ value: 'no', decidedScopeKind: 'subsystem', decidedScopeId: 'ledger/payments' });
    expect(listAssignments(cfg, MASTER, 'subsystem').map((a) => a.scopeId)).toEqual(['ledger/payments']);
    const record = listUsers(dataDir).find((u) => u.id === 'u-deny')!;
    expect(record.roleBindings).toEqual([{ roleId: 'writer', scopeKind: 'subsystem', scopeId: 'ledger/payments' }]);
    const renamedEvent = queryAuditEvents(dataDir, { action: 'member.renamed' }).find((e) => e.projectId === 'ledger');
    expect(JSON.parse(renamedEvent!.metadata!).subsystemRules).toEqual(['billing/payments -> ledger/payments']);
  });
});

// ── the admin plane ─────────────────────────────────────────────────────────

describe('the permission admin plane at a subsystem scope', () => {
  const at = (capability: string, value: string, scopeId = 'platform/payments') => ({
    id: '', subjectKind: 'user' as const, subjectId: 'u-x', scopeKind: 'subsystem' as const, scopeId, capability: capability as Capability, value: value as PermissionValue, createdAt: '',
  });

  it('refuses any capability other than project:write, refuses approval, and refuses a malformed scope id', () => {
    user('u-x');
    for (const capability of ['project:read', 'project:admin', 'project:create', 'approval:decide', 'share:create']) {
      expect(() => setAssignment(cfg, MASTER, at(capability, 'yes'))).toThrow(/a subsystem scope carries only project:write/);
    }
    expect(() => setAssignment(cfg, MASTER, at('project:write', 'approval'))).toThrow(/only project:write, yes or no/);
    expect(() => setAssignment(cfg, MASTER, at('project:write', 'yes', 'platform'))).toThrow(/<projectId>\/<subsystemId>/);
    expect(() => bindRole(cfg, MASTER, 'u-x', 'writer', 'subsystem', 'platform')).toThrow(/a subsystem scope id is <projectId>\/<subsystemId>/);
    // yes, no and inherit are accepted.
    expect(setAssignment(cfg, MASTER, at('project:write', 'no')).value).toBe('no');
    expect(bindRole(cfg, MASTER, 'u-x', 'writer', 'subsystem', 'platform/payments').roleBindings).toEqual([{ roleId: 'writer', scopeKind: 'subsystem', scopeId: 'platform/payments' }]);
  });

  it('managing a subsystem\'s rules is administering its project', async () => {
    user('u-admin');
    allow(dataDir, 'u-admin', 'project:admin', 'project', 'platform');
    const credential = mintUserToken(dataDir, { id: 'tok-admin', userId: 'u-admin', projects: ['platform'] });
    user('u-x');
    expect(setAssignment(cfg, credential, at('project:write', 'yes')).scopeId).toBe('platform/payments');
    createProjectRecord(dataDir, 'other');
    expect(() => setAssignment(cfg, credential, at('project:write', 'yes', 'other/core'))).toThrow(/requires project:admin/);
  });

  it('the explanation names the deciding rung; a missing subsystem is labelled in the explanation, the listing and the CLI', async () => {
    user('u-x');
    allow(dataDir, 'u-x', 'project:write', 'project', 'platform');
    setAssignment(cfg, MASTER, at('project:write', 'no'));
    expect(explain(cfg, MASTER, 'u-x', 'project:write', 'subsystem', 'platform/payments'))
      .toEqual({ value: 'no', source: 'user', decidedScopeKind: 'subsystem', decidedScopeId: 'platform/payments' });
    expect(explain(cfg, MASTER, 'u-x', 'project:write', 'subsystem', 'platform/catalog'))
      .toEqual({ value: 'yes', source: 'user', decidedScopeKind: 'project', decidedScopeId: 'platform' });
    expect(explain(cfg, MASTER, 'u-x', 'project:read', 'project', 'platform')).toMatchObject({ value: 'no', source: 'instance-default' });

    // A rule naming a subsystem the tree does not declare is kept and labelled.
    setAssignment(cfg, MASTER, at('project:write', 'no', 'platform/gone'));
    expect(explain(cfg, MASTER, 'u-x', 'project:write', 'subsystem', 'platform/gone')).toMatchObject({ value: 'no', scopeNote: 'subsystem not found' });
    const listed = listAssignments(cfg, MASTER, 'subsystem');
    expect(listed.find((a) => a.scopeId === 'platform/gone')?.scopeNote).toBe('subsystem not found');
    expect(listed.find((a) => a.scopeId === 'platform/payments')?.scopeNote).toBeUndefined();
    expect(localListAssignments(cfg, MASTER, 'subsystem', 'platform/gone')[0]?.scopeNote).toBe('subsystem not found');

    // Over the web route, with the decisive rung.
    user('u-admin');
    allow(dataDir, 'u-admin', 'project:admin', 'project', 'platform');
    const explained = await web(sessionFor('u-admin'), '/web/admin/permissions/explain?userId=u-x&capability=project:write&scopeKind=subsystem&scopeId=platform/payments');
    expect(explained).toEqual({ status: 200, body: { value: 'no', source: 'user', decidedScopeKind: 'subsystem', decidedScopeId: 'platform/payments' } });
    const grid = await web(sessionFor('u-admin'), '/web/admin/permissions?scopeKind=subsystem&scopeId=platform/gone');
    expect((grid.body as { assignments: { scopeNote?: string }[] }).assignments[0].scopeNote).toBe('subsystem not found');
    // Only an administrator of the scope may ask.
    user('u-out');
    expect((await web(sessionFor('u-out'), '/web/admin/permissions/explain?userId=u-x&capability=project:write&scopeKind=subsystem&scopeId=platform/payments')).status).toBe(403);
  });

  it('the CLI sets and lists a subsystem rule with --project and --subsystem, labelling a missing one', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    user('u-x');
    await runHostPermission('set', { dataDir, user: 'u-x', capability: 'project:write', value: 'no', project: 'platform', subsystem: 'gone' });
    expect(listAssignments(cfg, MASTER, 'subsystem', 'platform/gone')).toEqual([expect.objectContaining({ subjectId: 'u-x', value: 'no' })]);
    await runHostPermission('list', { dataDir, project: 'platform', subsystem: 'gone' });
    expect(lines.some((l) => /subsystem platform\/gone\s+\(subsystem not found\)/.test(l))).toBe(true);
    await expect(runHostPermission('set', { dataDir, user: 'u-x', capability: 'project:read', value: 'yes', project: 'platform', subsystem: 'payments' })).rejects.toThrow(/only project:write/);
    await expect(runHostPermission('set', { dataDir, user: 'u-x', capability: 'project:write', value: 'yes', subsystem: 'payments' })).rejects.toThrow(/needs `--project/);
  });
});

// ── canvas relation health ──────────────────────────────────────────────────

describe('relation health on the HTML canvas and the admin diagrams', () => {
  /** platform's gate consumes billing's exported portal: a consumption edge into a contained member. */
  function platformConsumesBilling(): void {
    system(fam.billing, 'billing', [{ from: 'ops', component: 'billing-portal', audience: 'project' }]);
    subsystem(fam.billing, 'billing', 'ops', { publicInterfaces: [{ type: 'Custom', details: 'Billing', component: 'billing-portal' }] });
    component(fam.billing, 'ops', 'billing-portal', 'Portal');
    system(fam.platform, 'platform');
    subsystem(fam.platform, 'platform', 'core');
    component(fam.platform, 'core', 'gate', 'Adapter', ['billing::billing-portal']);
    invalidateSpecCache();
  }

  it('GET /web/canvas carries the relation health within the caller\'s reach, unavailable beyond it', async () => {
    platformConsumesBilling();
    user('u-view');
    allow(dataDir, 'u-view', 'project:read', 'project', 'platform');
    const html = (await web(sessionFor('u-view'), '/web/canvas?projectId=platform')).body as string;
    expect(html).toMatch(/"relations":\[\{[^\]]*"id":"→billing"[^\]]*"health":"ok"/);
    allow(dataDir, 'u-view', 'project:read', 'project', 'billing', 'no');
    const narrowed = (await web(sessionFor('u-view'), '/web/canvas?projectId=platform')).body as string;
    expect(narrowed).toMatch(/"health":"unavailable"/);
    expect(narrowed).not.toMatch(/"health":"ok"/);
  });

  it('the admin canvas diagram and its download carry the health with the whole instance in reach; other formats are unchanged', () => {
    platformConsumesBilling();
    for (const render of [generateDiagram, downloadDiagram]) {
      const canvas = render(cfg, MASTER, 'platform', 'canvas');
      expect(canvas).toMatch(/"relations":\[\{[^\]]*"health":"ok"/);
    }
    expect(generateDiagram(cfg, MASTER, 'platform', 'mermaid')).not.toMatch(/"relations"/);
  });
});
