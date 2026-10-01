import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { listProjectRecords, listFamilyRecords, resolveProjectBinding } from '../../src/server/projects.js';
import { upgradeMemberRecords } from '../../src/server/local-admin.js';
import * as memberRegistration from '../../src/server/members.js';
import { authorize } from '../../src/server/authorization.js';
import { listAssignments } from '../../src/server/permissions.js';
import { upsertUser } from '../../src/server/users.js';
import { placeProject as storePlacement, listProjectPlacements } from '../../src/server/organization.js';
import { createWebSession } from '../../src/server/websessions.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { listCredentials } from '../../src/server/credentials.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { routeData, startHostServer } from '../../src/server/http.js';
import { getGitBinding } from '../../src/server/admin.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { getExternalsStatus, pinExternals } from '../../src/core/surfaces.js';
import { validateFamily } from '../../src/core/validation.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import { runWithProjectRoot, setProjectRoot } from '../../src/utils/fs.js';
import * as transaction from '../../src/migrations/transaction.js';
import { allow, mintUserToken, seedUnit, subjectOf } from './helpers.js';
import { buildHostedFamily, writeProject, type HostedFamily } from './hosted-family.js';
import type { HostConfig, HostedUserRecord, Principal, RoleBinding } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage 7 wave B — hosted membership changes, over the hosted fixture family
// (platform ⊃ billing ⊃ payments, platform ⊃ docs; docs consumes billing as an
// external through the family) in real temp dirs, every machine-global location
// redirected, served through the real data-plane router. Nothing on the path
// under test is mocked.
//
// Properties: membership-change-lists-reach (attach, adopt and detach list
// exactly who gains or loses access, and audit it), hosted detach relocates,
// detach-then-adopt-is-identity (hosted), source.hosted resolution (in reach,
// out of reach, off-host), reconcile after a family-shape tool (register,
// re-key with no widening), hosted-and-family-agree, the root-rename refusal,
// crash recovery under the data directory (at boot and in host doctor), and the
// UI routes (member crumbs, the family canvas links, relation health).
// ---------------------------------------------------------------------------

const MASTER = 'stage7b-master-credential-value-0123456789';
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'WAIRON_ADMIN_TOKEN', 'WAIRON_DATA_DIR'] as const;

let base: string;
let dataDir: string;
let cfg: HostConfig;
let fam: HostedFamily;
let unitId: string;
let savedEnv: (readonly [string, string | undefined])[];
let server: http.Server;
let port: number;

/** docs consumes billing through the family: an external that names it by id. */
function docsConsumesBilling(): void {
  const file = path.join(fam.docs, '.wai', 'project.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'externals:\n  billing: {}\n');
}

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-stage7b-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = home;
  process.env.WAIRON_ADMIN_TOKEN = MASTER;
  dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.WAIRON_DATA_DIR = dataDir;
  cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  ensureInstanceIdentity(dataDir);
  fam = buildHostedFamily(dataDir);
  docsConsumesBilling();
  unitId = seedUnit(dataDir, 'eng').id;
  storePlacement(dataDir, { id: '', projectId: 'platform', unitId, role: 'owner', createdAt: '', createdBy: subjectOf('u-seeder') });
  fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true, requireTls: false }));
  expect(upgradeMemberRecords(dataDir, true).applied).toBe(true);
  invalidateSpecCache();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  server = http.createServer((req, res) => routeData(cfg, req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
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

/** A user's own principal, narrowed to nothing: its permission resolves live. */
const principalOf = (id: string): Principal => ({
  tokenId: id, role: 'editor', projects: ['*'], authenticated: true, subject: subjectOf(id),
  permissionSubject: { subjectId: id, roleBindings: [], instanceAdmin: false },
});

function user(id: string, roleBindings: RoleBinding[] = []): HostedUserRecord {
  return upsertUser(dataDir, { id, subject: subjectOf(id), status: 'active', createdAt: new Date().toISOString(), roleBindings });
}

interface ToolAnswer { text: string; texts: string[]; isError: boolean; structured?: Record<string, unknown> }

/** One data-plane tool call, bound by selector. */
async function call(token: string, tool: string, args: Record<string, unknown>, selector?: string): Promise<ToolAnswer> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp${selector ? `?project=${selector}` : ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } };
  const texts = (body.result?.content ?? []).map((c) => c.text ?? '');
  invalidateSpecCache();
  return { text: texts[0] ?? '', texts, isError: body.result?.isError === true, structured: body.result?.structuredContent };
}

/** A GET of a /web route with a browser session. */
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

const configOf = (dir: string): Record<string, unknown> => readYamlFile(path.join(dir, '.wai', 'project.yaml')) as Record<string, unknown>;
const recordOf = (id: string) => listProjectRecords(dataDir).find((r) => r.id === id);
const newRootOf = (id: string): string => path.join(dataDir, 'projects', id);
/** The reach lines a hosted detach or adopt answers, as `<member>: <subject> <capability> <before> -> <after>`. */
const reachOf = (a: ToolAnswer): string[] => (JSON.parse(a.text.slice(a.text.indexOf('{'))) as { reach: string[] }).reach;

/** The writer (u-dev) may read and write the family root; the viewer (u-view) may read it; the unit reader (u-unit) reads the whole unit. */
function seedPeople(): { dev: string } {
  user('u-dev');
  user('u-view');
  user('u-unit');
  allow(dataDir, 'u-dev', 'project:read', 'project', 'platform');
  allow(dataDir, 'u-dev', 'project:write', 'project', 'platform');
  allow(dataDir, 'u-view', 'project:read', 'project', 'platform');
  allow(dataDir, 'u-unit', 'project:read', 'unit', unitId);
  return { dev: mintUserToken(dataDir, { id: 'tok-dev', userId: 'u-dev', projects: ['platform'] }) };
}

// ── membership-change-lists-reach, and the hosted detach ────────────────────

describe('hosted detach relocates the member and lists who loses access', () => {
  it('a dry run plans the move, the new root and the losers, and writes nothing', async () => {
    const { dev } = seedPeople();
    const stores = ['projects.json', 'organization.json'].map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8'));
    const tree = bytes(fam.platform);
    const dry = await call(dev, 'sdd_detach_member', { alias: 'billing', dryRun: true }, 'platform');
    expect(dry.isError, dry.text).toBe(false);
    const view = JSON.parse(dry.text) as { newRoot: string; applied: boolean; reach: string[]; plan: { edits: { kind: string; detail: string }[]; changes: { action: string }[] } };
    expect(view.applied).toBe(false);
    expect(path.resolve(view.newRoot)).toBe(path.resolve(newRootOf('billing')));
    expect(view.plan.edits.some((e) => e.kind === 'move')).toBe(true);
    expect(view.plan.changes.some((c) => c.action === 'create')).toBe(true);
    expect(view.plan.changes.some((c) => c.action === 'delete')).toBe(true);
    // Exactly the principals who lose: the project rungs are cut; the unit rung stays through the placement.
    expect(view.reach).toContain('billing: u-view project:read yes -> no');
    expect(view.reach).toContain('payments: u-view project:read yes -> no');
    expect(view.reach).toContain('billing: u-dev project:write yes -> no');
    expect(view.reach.some((l) => l.includes('u-unit'))).toBe(false);
    // Nothing written: the stores, the family tree, and no new root.
    expect(['projects.json', 'organization.json'].map((f) => fs.readFileSync(path.join(dataDir, f), 'utf8'))).toEqual(stores);
    expect(bytes(fam.platform)).toEqual(tree);
    expect(fs.existsSync(newRootOf('billing'))).toBe(false);
  });

  it('applied: the member moves byte-identical to an isolated root, its record goes top-level and keeps the units, sources become hosted, and it is audited', async () => {
    const { dev } = seedPeople();
    const memberBytes = bytes(fam.billing);
    const applied = await call(dev, 'sdd_detach_member', { alias: 'billing' }, 'platform');
    expect(applied.isError, applied.text).toBe(false);
    expect(JSON.parse(applied.text)).toMatchObject({ applied: true, memberId: 'billing' });
    // The move: gone from the family tree, byte-identical at the new root, its own member with it.
    expect(fs.existsSync(fam.billing)).toBe(false);
    expect(bytes(newRootOf('billing'))).toEqual(memberBytes);
    expect(fs.existsSync(path.join(newRootOf('billing'), 'sub', 'payments', '.wai', 'project.yaml'))).toBe(true);
    // The records: billing is top-level at its new root; payments still hangs under it, its root derived from there.
    expect(recordOf('billing')).toMatchObject({ rootPath: newRootOf('billing') });
    expect(recordOf('billing')!.parentProjectId).toBeUndefined();
    expect(recordOf('payments')).toMatchObject({ parentProjectId: 'billing', rootPath: path.join(newRootOf('billing'), 'sub', 'payments') });
    expect(listFamilyRecords(dataDir, 'platform').map((r) => r.id)).toEqual(['platform', 'docs']);
    // It keeps its former family root's units, so the unit reader keeps it.
    expect(listProjectPlacements(dataDir, 'billing').map((p) => p.unitId)).toEqual([unitId]);
    const unitReader = principalOf('u-unit');
    expect(authorize(dataDir, unitReader, 'project:read', 'project', 'billing').value).toBe('yes');
    // The family edits name it by its hosted record id: a path cannot cross isolated roots.
    expect((configOf(fam.platform).externals as Record<string, { source?: unknown }>).billing.source).toEqual({ hosted: 'billing' });
    expect((configOf(fam.platform).members as Record<string, unknown>).billing).toBeUndefined();
    expect((configOf(fam.docs).externals as Record<string, { source?: unknown }>).billing.source).toEqual({ hosted: 'billing' });
    // Audited, naming the member, its new root and who lost access.
    const event = queryAuditEvents(dataDir, { action: 'member.detached' })[0];
    expect(event).toMatchObject({ projectId: 'billing', composition: 'platform' });
    expect(JSON.parse(event.metadata!).reachLost).toContain('u-view project:read: yes -> no');
    // The detached project has no git binding of its own: the result and the audit say so, and its status reads not git-backed.
    expect((JSON.parse(applied.text) as { plan: { notes: string[] } }).plan.notes).toContain('no git binding: enable one for this project');
    expect(JSON.parse(event.metadata!).gitBinding).toBe('no git binding: enable one for this project');
    expect(getGitBinding(cfg, MASTER, 'billing').enabled).toBe(false);
    // No transaction is left anywhere.
    expect(fs.existsSync(path.join(dataDir, '.wai', 'transactions'))).toBe(false);
    expect(fs.existsSync(path.join(fam.platform, '.wai', 'transactions'))).toBe(false);
  });

  it('refuses, writing nothing, when the new root holds anything', async () => {
    const { dev } = seedPeople();
    fs.mkdirSync(newRootOf('billing'), { recursive: true });
    fs.writeFileSync(path.join(newRootOf('billing'), 'stray.txt'), 'someone else\'s file\n');
    const tree = bytes(fam.platform);
    const refused = await call(dev, 'sdd_detach_member', { alias: 'billing' }, 'platform');
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/relocation-target-exists/);
    expect(bytes(fam.platform)).toEqual(tree);
  });
});

describe('detach-then-adopt-is-identity, hosted', () => {
  it('the member byte-identical, the parent and its sibling semantically identical, the record and its placements as before', async () => {
    const { dev } = seedPeople();
    const memberBytes = bytes(fam.billing);
    const parentConfig = projectConfigRepositoryAt(fam.platform).load();
    const siblingConfig = projectConfigRepositoryAt(fam.docs).load();
    const before = { billing: recordOf('billing'), payments: recordOf('payments'), placements: listProjectPlacements(dataDir, 'billing') };
    expect((await call(dev, 'sdd_detach_member', { alias: 'billing' }, 'platform')).isError).toBe(false);

    // Adopting needs write on the adopted record too: the detached project keeps the unit, not the parent's rung.
    // ... and a credential whose narrowing covers it: the detached project is no longer below the family root.
    allow(dataDir, 'u-dev', 'project:write', 'project', 'billing');
    allow(dataDir, 'u-dev', 'project:read', 'project', 'billing');
    const both = mintUserToken(dataDir, { id: 'tok-both', userId: 'u-dev', projects: ['platform', 'billing'] });
    const dry = await call(both, 'sdd_adopt_member', { alias: 'billing', path: 'packages/billing', dryRun: true }, 'platform');
    expect(dry.isError, dry.text).toBe(false);
    // Who gains through the new parent chain: the parent's viewer.
    expect(reachOf(dry)).toContain('billing: u-view project:read no -> yes');
    const adopted = await call(both, 'sdd_adopt_member', { alias: 'billing', path: 'packages/billing' }, 'platform');
    expect(adopted.isError, adopted.text).toBe(false);

    expect(bytes(fam.billing)).toEqual(memberBytes);
    expect(fs.existsSync(newRootOf('billing'))).toBe(false);
    expect(projectConfigRepositoryAt(fam.platform).load()).toEqual(parentConfig);
    expect(projectConfigRepositoryAt(fam.docs).load()).toEqual(siblingConfig);
    const pick = (r: ReturnType<typeof recordOf>) => ({ id: r!.id, parentProjectId: r!.parentProjectId, memberPath: r!.memberPath, rootPath: path.resolve(r!.rootPath), status: r!.status, createdAt: r!.createdAt });
    expect(pick(recordOf('billing'))).toEqual(pick(before.billing));
    expect(pick(recordOf('payments'))).toEqual(pick(before.payments));
    expect(listProjectPlacements(dataDir, 'billing')).toEqual(before.placements);
    expect(queryAuditEvents(dataDir, { action: 'member.adopted' })[0]).toMatchObject({ projectId: 'billing', composition: 'platform' });
  });

  it('an EMPTY directory left at the old place does not block adopting back; a non-empty one does', async () => {
    const { dev } = seedPeople();
    expect((await call(dev, 'sdd_detach_member', { alias: 'billing' }, 'platform')).isError).toBe(false);
    allow(dataDir, 'u-dev', 'project:write', 'project', 'billing');
    allow(dataDir, 'u-dev', 'project:read', 'project', 'billing');
    const both = mintUserToken(dataDir, { id: 'tok-both', userId: 'u-dev', projects: ['platform', 'billing'] });
    // What a cut-short cleanup after the committed move can leave: the directory, empty.
    fs.mkdirSync(fam.billing, { recursive: true });
    fs.writeFileSync(path.join(fam.billing, 'stray.txt'), 'x\n');
    const blocked = await call(both, 'sdd_adopt_member', { alias: 'billing', path: 'packages/billing', dryRun: true }, 'platform');
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/relocation-target-exists/);
    fs.rmSync(path.join(fam.billing, 'stray.txt'));
    const adopted = await call(both, 'sdd_adopt_member', { alias: 'billing', path: 'packages/billing' }, 'platform');
    expect(adopted.isError, adopted.text).toBe(false);
    expect(recordOf('billing')).toMatchObject({ parentProjectId: 'platform', memberPath: 'packages/billing' });
    expect(fs.existsSync(path.join(fam.billing, '.wai', 'project.yaml'))).toBe(true);
  });

  it('adopt refuses, writing nothing, when the caller cannot write the adopted record', async () => {
    const { dev } = seedPeople();
    expect((await call(dev, 'sdd_detach_member', { alias: 'billing' }, 'platform')).isError).toBe(false);
    const tree = bytes(fam.platform);
    // It may read the detached project (so the lookup answers it), but not write it.
    allow(dataDir, 'u-dev', 'project:read', 'project', 'billing');
    const reader = mintUserToken(dataDir, { id: 'tok-reader', userId: 'u-dev', projects: ['*'] });
    const refused = await call(reader, 'sdd_adopt_member', { alias: 'billing', path: 'packages/billing' }, 'platform');
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/project:write on both/);
    // A credential that cannot read it learns nothing about it: unknown or out of reach.
    const narrow = await call(dev, 'sdd_adopt_member', { alias: 'billing', path: 'packages/billing' }, 'platform');
    expect(narrow.text).toMatch(/unknown or outside this request's reach/);
    expect(bytes(fam.platform)).toEqual(tree);
    expect(fs.existsSync(newRootOf('billing'))).toBe(true);
  });
});

// ── source.hosted ───────────────────────────────────────────────────────────

describe('source.hosted resolves only through the hosting server, within reach', () => {
  beforeEach(async () => {
    const { dev } = seedPeople();
    expect((await call(dev, 'sdd_detach_member', { alias: 'billing' }, 'platform')).isError).toBe(false);
  });

  it('in reach: the status reads the producer at its isolated root', async () => {
    const tok = mintUserToken(dataDir, { id: 'tok-unit', userId: 'u-unit', projects: ['*'] });
    const answer = await call(tok, 'sdd_get_externals_status', {}, 'docs');
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).toMatch(/billing → billing: hosted, not pinned, current — the producer is outside the family/);
  });

  it('out of reach: unavailable, never a pass, and never read', async () => {
    // u-view reads docs through the family root, but the detached billing is no longer below it.
    const tok = mintUserToken(dataDir, { id: 'tok-view', userId: 'u-view', projects: ['*'] });
    const answer = await call(tok, 'sdd_get_externals_status', {}, 'docs');
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.text).toMatch(/billing → billing: unresolved, not pinned, unreachable/);
    expect(answer.text).toMatch(/unknown or outside this request's reach/);
  });

  it('off-host: "hosted-only producer `billing`: available only through the hosted server", for status and pin', () => {
    invalidateSpecCache();
    const status = runWithProjectRoot(fam.docs, () => getExternalsStatus());
    expect(status[0]).toMatchObject({ alias: 'billing', reachable: false });
    expect(status[0].detail).toBe('hosted-only producer `billing`: available only through the hosted server');
    expect(status[0].uses.every((u) => u.state === 'unavailable')).toBe(true);
    const pins = runWithProjectRoot(fam.docs, () => pinExternals());
    expect(pins[0]).toMatchObject({ alias: 'billing', outcome: 'unresolved', detail: 'hosted-only producer `billing`: available only through the hosted server' });
  });
});

// ── reconcile after a family-shape tool ─────────────────────────────────────

describe('reconcile: the records follow the family on disk', () => {
  it('after sdd_add_member: the new member is registered, inherits through its parent, and the reach it opens is audited', async () => {
    const { dev } = seedPeople();
    const added = await call(dev, 'sdd_add_member', { alias: 'tools', path: 'packages/tools', description: 'build tools' }, 'platform');
    expect(added.isError, added.text).toBe(false);
    expect(recordOf('tools')).toMatchObject({ parentProjectId: 'platform', memberPath: 'packages/tools', status: 'active' });
    const event = queryAuditEvents(dataDir, { action: 'member.registered' }).find((e) => e.projectId === 'tools');
    expect(event).toMatchObject({ composition: 'platform' });
    expect(JSON.parse(event!.metadata!).reach).toContain('u-view project:read: no -> yes');
    // Never a placement and never a grant: it inherits.
    expect(listProjectPlacements(dataDir, 'tools')).toEqual([]);
    expect(listAssignments(dataDir).some((a) => a.scopeId === 'tools')).toBe(false);
  });

  it('attach: the dry run lists who gains access; applied, the member is registered', async () => {
    const { dev } = seedPeople();
    writeProject(path.join(fam.platform, 'packages', 'extra'), 'extra');
    const dry = await call(dev, 'sdd_attach_member', { alias: 'extra', path: 'packages/extra', dryRun: true }, 'platform');
    expect(dry.isError, dry.text).toBe(false);
    const listing = dry.texts.find((t) => t.startsWith('Reach changes'))!;
    expect(listing).toMatch(/u-view project:read no -> yes/);
    expect(listing).toMatch(/u-unit project:read no -> yes/);
    expect(recordOf('extra')).toBeUndefined();
    const applied = await call(dev, 'sdd_attach_member', { alias: 'extra', path: 'packages/extra' }, 'platform');
    expect(applied.isError, applied.text).toBe(false);
    expect(recordOf('extra')).toMatchObject({ parentProjectId: 'platform', memberPath: 'packages/extra' });
  });

  it('externalize: the new member project is registered', async () => {
    const { dev } = seedPeople();
    const sub = await call(dev, 'sdd_add_subsystem', { id: 'tooling', name: 'Tooling', description: 'Build tooling' }, 'platform');
    expect(sub.isError, sub.text).toBe(false);
    const ext = await call(dev, 'sdd_externalize_subsystem', { subsystem: 'tooling', path: 'packages/tooling' }, 'platform');
    expect(ext.isError, ext.text).toBe(false);
    expect(recordOf('tooling')).toMatchObject({ parentProjectId: 'platform', memberPath: 'packages/tooling' });
  });

  it('a member rename re-keys its own settings and key entries, with no widening', async () => {
    const { dev } = seedPeople();
    user('u-x');
    allow(dataDir, 'u-x', 'project:write', 'project', 'billing');
    allow(dataDir, 'u-view', 'project:write', 'project', 'billing', 'no');
    const keyed = mintUserToken(dataDir, { id: 'tok-billing', userId: 'u-x', projects: ['billing'] });
    const subjects = ['u-dev', 'u-view', 'u-unit', 'u-x'].map(principalOf);
    const caps = ['project:read', 'project:write', 'project:admin'];
    const before = subjects.flatMap((p) => caps.map((c) => authorize(dataDir, p, c, 'project', 'billing').value));

    const renamed = await call(dev, 'sdd_rename_project', { newId: 'ledger', project: 'billing' }, 'platform');
    expect(renamed.isError, renamed.text).toBe(false);
    expect(recordOf('billing')).toBeUndefined();
    expect(recordOf('ledger')).toMatchObject({ parentProjectId: 'platform', memberPath: 'packages/billing' });
    expect(recordOf('payments')).toMatchObject({ parentProjectId: 'ledger' });
    // Own-scope settings and key entries moved; nothing widened.
    expect(listAssignments(dataDir).filter((a) => a.scopeId === 'ledger').length).toBe(2);
    expect(listAssignments(dataDir).some((a) => a.scopeId === 'billing')).toBe(false);
    expect(listCredentials(dataDir, '*').find((k) => k.id === 'tok-billing')!.projects).toEqual(['ledger']);
    const after = subjects.flatMap((p) => caps.map((c) => authorize(dataDir, p, c, 'project', 'ledger').value));
    expect(after).toEqual(before);
    expect(queryAuditEvents(dataDir, { action: 'member.renamed' })[0]).toMatchObject({ projectId: 'ledger', composition: 'platform' });
    expect(keyed).toMatch(/^wk_/);
  });

  it('a member that left the family and is declared again returns: active, listed with exactly who regains reach, audited', async () => {
    seedPeople();
    const principal = principalOf('u-dev');
    const config = path.join(fam.platform, '.wai', 'project.yaml');
    const declared = fs.readFileSync(config, 'utf8');
    const subjects = ['u-dev', 'u-view', 'u-unit'].map(principalOf);
    const caps = ['project:read', 'project:write'];
    const reachOfDocs = (): string[] => subjects.flatMap((p) => caps.map((c) => `${p.tokenId} ${c} ${authorize(dataDir, p, c, 'project', 'docs').value}`));
    const before = reachOfDocs();
    // docs leaves the family: its record is disabled, never deleted.
    fs.writeFileSync(config, declared.replace('  docs: packages/docs\n', ''));
    invalidateSpecCache();
    expect(memberRegistration.reconcile(dataDir, principal, 'platform', ['platform']).departed).toEqual(['docs']);
    expect(recordOf('docs')!.status).toBe('disabled');
    // Declared again: it returns, with exactly the reach it had.
    fs.writeFileSync(config, declared);
    invalidateSpecCache();
    const back = memberRegistration.reconcile(dataDir, principal, 'platform', ['platform']);
    expect(back.returned).toEqual(['docs']);
    expect(back.registered).toEqual([]);
    expect(recordOf('docs')!.status).toBe('active');
    expect(reachOfDocs()).toEqual(before);
    // The listing names exactly who regains reach: every subject x capability that resolves yes again, nothing else.
    const regained = before.filter((l) => l.endsWith(' yes')).map((l) => {
      const [subject, capability] = l.split(' ');
      return `${subject} ${capability}`;
    });
    expect(back.reachChanges.filter((r) => caps.includes(r.capability)).map((r) => `${r.subjectId} ${r.capability}`).sort()).toEqual(regained.sort());
    expect(back.reachChanges.every((r) => r.memberId === 'docs' && r.before.value === 'no')).toBe(true);
    const event = queryAuditEvents(dataDir, { action: 'member.returned' })[0];
    expect(event).toMatchObject({ projectId: 'docs', composition: 'platform' });
  });

  it('renaming a hosted family root refuses, writing nothing', async () => {
    const { dev } = seedPeople();
    const tree = bytes(fam.platform);
    const refused = await call(dev, 'sdd_rename_project', { newId: 'plat' }, 'platform');
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe("renaming a hosted family root's id is not supported; a member can be renamed, or the root recreated");
    expect(bytes(fam.platform)).toEqual(tree);
    expect(recordOf('platform')).toBeDefined();
  });
});

// ── hosted-and-family-agree ─────────────────────────────────────────────────

describe('hosted-and-family-agree', () => {
  it('the hosted family run answers the verdicts the local family run does', async () => {
    const { dev } = seedPeople();
    const hosted = await call(dev, 'sdd_validate_tree', { family: true }, 'platform');
    expect(hosted.isError, hosted.text).toBe(false);
    const findings = (s: Record<string, unknown> | undefined): string[] =>
      (['errors', 'warnings', 'notices'] as const).flatMap((k) => ((s?.[k] as { code: string; message: string }[] | undefined) ?? []).map((i) => `${k} ${i.code} ${i.message}`)).sort();
    invalidateSpecCache();
    setProjectRoot(fam.platform);
    const local = validateFamily({ family: true });
    const localLines = local.issues.map((i) => `${i.severity === 'error' ? 'errors' : i.severity === 'warning' ? 'warnings' : 'notices'} ${i.code} ${i.message}`).sort();
    expect(findings(hosted.structured)).toEqual(localLines);
    expect(hosted.structured?.valid).toBe(local.valid);
  });
});

// ── crash recovery under the data directory ─────────────────────────────────

describe('a crashed transaction under the data directory is recovered', () => {
  /** A member upgrade that crashed mid-swap: the stores half moved, the journal at the data directory. */
  function crashedUpgrade(): { before: string; id: string } {
    const record = listProjectRecords(dataDir);
    fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify(record.filter((r) => r.id !== 'docs').map(({ rootPath, ...r }) => (r.parentProjectId ? r : { ...r, rootPath })), null, 2) + '\n');
    const before = fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8');
    const plan = memberRegistration.plan(dataDir);
    expect(plan.rehearsal).toBeDefined();
    const journals = transaction.stage(plan.rehearsal!, plan.changes, 'member-upgrade');
    transaction.swap(journals);
    expect(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).not.toBe(before);
    transaction.discard(plan.rehearsal!);
    return { before, id: plan.rehearsal!.id };
  }

  it('at boot, before serving: rolled back and audited', () => {
    const { before, id } = crashedUpgrade();
    const handle = startHostServer({ ...cfg, port: 0, adminPort: 0 });
    handle.close();
    expect(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dataDir, '.wai', 'transactions'))).toBe(false);
    expect(queryAuditEvents(dataDir, { action: 'migration.recovered' }).find((e) => e.target === id)).toMatchObject({ outcome: 'success' });
  });

  it('by host doctor: reported on a dry run, rolled back with --fix before the upgrade applies', () => {
    const { id } = crashedUpgrade();
    const dry = upgradeMemberRecords(dataDir, false);
    expect(dry.recovered).toEqual([expect.objectContaining({ id, action: 'pending' })]);
    expect(fs.existsSync(path.join(dataDir, '.wai', 'transactions', id))).toBe(true);
    const fixed = upgradeMemberRecords(dataDir, true);
    expect(fixed.recovered).toEqual([expect.objectContaining({ id, action: 'rolled-back' })]);
    expect(fixed.applied).toBe(true);
    expect(recordOf('docs')).toMatchObject({ parentProjectId: 'platform' });
    expect(queryAuditEvents(dataDir, { action: 'migration.recovered' }).some((e) => e.target === id)).toBe(true);
  });
});

// ── the UI routes ───────────────────────────────────────────────────────────

describe('the UI routes', () => {
  it('GET /web/projects: member records carry parentProjectId; a member is listed only when readable', async () => {
    seedPeople();
    allow(dataDir, 'u-view', 'project:read', 'project', 'docs', 'no');
    const listed = (await web(sessionFor('u-view'), '/web/projects')).body as { projects: { id: string; parentProjectId?: string }[] };
    const byId = new Map(listed.projects.map((p) => [p.id, p]));
    expect(byId.get('billing')?.parentProjectId).toBe('platform');
    expect(byId.get('payments')?.parentProjectId).toBe('billing');
    expect(byId.has('docs')).toBe(false);
  });

  it('GET /web/canvas-model: member project nodes are linked only when the caller can read them', async () => {
    seedPeople();
    allow(dataDir, 'u-view', 'project:read', 'project', 'docs', 'no');
    const model = (await web(sessionFor('u-view'), '/web/canvas-model?projectId=platform')).body as { subsystems: { id: string; project?: boolean; recordId?: string }[] };
    const nodes = new Map(model.subsystems.filter((s) => s.project).map((s) => [s.id, s]));
    expect(nodes.get('billing')?.recordId).toBe('billing');
    expect(nodes.has('docs')).toBe(true);
    expect(nodes.get('docs')?.recordId).toBeUndefined();
  });

  it('GET /web/projects/externals: relation health per external; another project is Forbidden', async () => {
    seedPeople();
    const session = sessionFor('u-view');
    const answer = (await web(session, '/web/projects/externals?projectId=docs')).body as { externals: { alias: string; sourceKind: string; reachable: boolean }[] };
    expect(answer.externals).toEqual([expect.objectContaining({ alias: 'billing', sourceKind: 'family', reachable: true })]);
    user('u-out');
    expect((await web(sessionFor('u-out'), '/web/projects/externals?projectId=docs')).status).toBe(403);
  });
});

// ── the binding still resolves the detached member ──────────────────────────

describe('a detached member binds at its new root', () => {
  it('resolves through its own record, with no deprecated qualifier', async () => {
    const { dev } = seedPeople();
    expect((await call(dev, 'sdd_detach_member', { alias: 'billing' }, 'platform')).isError).toBe(false);
    const all: Principal = { tokenId: 't', role: 'editor', projects: ['*'], authenticated: true };
    expect(resolveProjectBinding(dataDir, all, 'billing')).toMatchObject({ rootPath: newRootOf('billing'), familyRootId: 'billing' });
    expect(resolveProjectBinding(dataDir, all, 'payments')).toMatchObject({ familyRootId: 'billing' });
  });
});
