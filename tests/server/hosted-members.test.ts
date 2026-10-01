import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listProjectRecords,
  listFamilyRecords,
  projectRepositoryScope,
  resolveProjectBinding,
  existingProjectRoot,
  createProjectRecord,
  registerMemberRecord,
  removeProjectRecord,
} from '../../src/server/projects.js';
import { upgradeMemberRecords } from '../../src/server/local-admin.js';
import * as memberRegistration from '../../src/server/members.js';
import { authorize } from '../../src/server/authorization.js';
import { setAssignment } from '../../src/server/permissions.js';
import { upsertUser } from '../../src/server/users.js';
import { createRole } from '../../src/server/roles.js';
import { placeProject as storePlacement, listProjectPlacements, deletePlacement } from '../../src/server/organization.js';
import { placeProject as landscapePlace } from '../../src/server/landscape.js';
import { placeProject as webPlace } from '../../src/server/webadmin.js';
import { createWebSession } from '../../src/server/websessions.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { listCredentials } from '../../src/server/credentials.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { handleMcpRequest } from '../../src/server/request.js';
import { warnIfMembersPending } from '../../src/server/http.js';
import { migratePermissionModel } from '../../src/server/migration.js';
import { executeApprovedLock } from '../../src/server/admin.js';
import { executeApprovedRequest } from '../../src/server/projectlifecycle.js';
import { createApprovalRequest, decideApprovalRequest } from '../../src/server/approvals.js';
import * as transaction from '../../src/migrations/transaction.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { mintUserToken, allow, seedUnit, subjectOf } from './helpers.js';
import { buildHostedFamily, type HostedFamily } from './hosted-family.js';
import type {
  Capability,
  EffectiveValue,
  HostConfig,
  HostedUserRecord,
  PermissionValue,
  Principal,
  RoleBinding,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage 7 wave A — hosted members as records, over a real hosted fixture family
// (platform ⊃ billing ⊃ payments, platform ⊃ docs) in real temp dirs, with every
// machine-global location redirected. Nothing on the path under test is mocked.
//
// Properties: member-is-a-project, member-inherits-parent, member-no-wins,
// no-widening (over the RBAC matrix), audit-names-the-member; the upgrade is
// plan-first and idempotent; qualified tokens stay compatible for one release;
// placing a member refuses; the server warns at boot about members awaiting the
// upgrade; a crashed family migration is rolled back on the next bind.
// ---------------------------------------------------------------------------

const MASTER = 'stage7-master-credential-value-0123456789';
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'WAIRON_ADMIN_TOKEN', 'WAIRON_DATA_DIR'] as const;
const CAPABILITIES: Capability[] = ['project:read', 'project:create', 'project:write', 'project:admin', 'approval:decide', 'share:create'];
const MEMBERS = ['billing', 'payments', 'docs'];

let base: string;
let dataDir: string;
let cfg: HostConfig;
let fam: HostedFamily;
let unitId: string;
let savedEnv: (readonly [string, string | undefined])[];

beforeEach(() => {
  savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-stage7-'));
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
  unitId = seedUnit(dataDir, 'eng').id;
  storePlacement(dataDir, { id: '', projectId: 'platform', unitId, role: 'owner', createdAt: '', createdBy: subjectOf('u-seeder') });
  invalidateSpecCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  invalidateSpecCache();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

const upgrade = (): void => {
  const report = upgradeMemberRecords(dataDir, true);
  expect(report.applied, JSON.stringify(report.plan.refusals)).toBe(true);
};

function user(id: string, roleBindings: RoleBinding[] = []): HostedUserRecord {
  return upsertUser(dataDir, { id, subject: subjectOf(id), status: 'active', createdAt: new Date().toISOString(), roleBindings });
}

function principalOf(u: HostedUserRecord): Principal {
  return {
    tokenId: `t-${u.id}`, role: 'editor', projects: ['*'], authenticated: true, subject: u.subject,
    permissionSubject: { subjectId: u.subject.userId, roleBindings: u.roleBindings ?? [], instanceAdmin: false },
  };
}

const everyone = (capability: Capability, value: PermissionValue, scopeKind: 'unit' | 'project', scopeId: string): void => {
  setAssignment(dataDir, { id: '', subjectKind: 'everyone', scopeKind, scopeId, capability, value, createdAt: '' });
};

const valueOf = (p: Principal, capability: Capability, projectId: string): EffectiveValue =>
  authorize(dataDir, p, capability, 'project', projectId).value;

// ── member-is-a-project ─────────────────────────────────────────────────────

describe('member-is-a-project', () => {
  it('registers every declared member, nested included, as a record with parent and path — root derived, never persisted', () => {
    upgrade();
    const records = new Map(listProjectRecords(dataDir).map((r) => [r.id, r]));
    expect(records.get('billing')).toMatchObject({ parentProjectId: 'platform', memberPath: 'packages/billing', rootPath: path.resolve(fam.billing), status: 'active' });
    expect(records.get('payments')).toMatchObject({ parentProjectId: 'billing', memberPath: 'sub/payments', rootPath: path.resolve(fam.payments) });
    expect(records.get('docs')).toMatchObject({ parentProjectId: 'platform', memberPath: 'packages/docs' });
    // The stored record carries no root: it is derived from the parent's.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'projects.json'), 'utf8')) as { id: string; rootPath?: string }[];
    expect(stored.find((r) => r.id === 'payments')!.rootPath).toBeUndefined();
    expect(listFamilyRecords(dataDir, 'payments').map((r) => r.id)).toEqual(['platform', 'billing', 'payments', 'docs']);
    expect(existingProjectRoot(dataDir, 'payments')).toBe(path.resolve(fam.payments));
  });

  it('binds, locks and commits a member as its own project, through its family root repository scope', () => {
    upgrade();
    allow(dataDir, 'u-dev', 'project:read', 'project', 'platform');
    const bound = resolveProjectBinding(dataDir, { tokenId: 't', role: 'editor', projects: ['platform'], authenticated: true }, 'payments');
    expect(bound).toEqual({ rootPath: path.resolve(fam.payments), projectId: 'payments', familyRootId: 'platform' });
    expect(projectRepositoryScope(dataDir, 'payments')).toEqual({
      familyRootId: 'platform', repositoryRoot: fam.platform, pathspecs: ['packages/billing/sub/payments/.wai/'],
    });
    expect(projectRepositoryScope(dataDir, 'platform')!.pathspecs).toEqual(['.wai/']);
    // Its own lock: written at its own root, nothing at its parent's.
    const lock = executeApprovedLock(cfg, 'payments', { id: 'u-approver', source: 'hosted' });
    expect(lock.projectId).toBe('payments');
    expect(fs.existsSync(path.join(fam.payments, '.wai', 'lock.json'))).toBe(true);
    expect(fs.existsSync(path.join(fam.billing, '.wai', 'lock.json'))).toBe(false);
    expect(fs.existsSync(path.join(fam.platform, '.wai', 'lock.json'))).toBe(false);
  });

  it("removing a member record never deletes its directory; a family root with members refuses removal", () => {
    upgrade();
    expect(() => removeProjectRecord(dataDir, 'platform')).toThrow(/still has member record/);
    removeProjectRecord(dataDir, 'docs');
    expect(fs.existsSync(path.join(fam.docs, '.wai', 'project.yaml'))).toBe(true);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'docs')).toBe(false);
  });
});

// ── permissions: inherited through the project chain ────────────────────────

describe('member-inherits-parent / member-no-wins', () => {
  it('a parent grant reaches every member, transitively', () => {
    upgrade();
    const dev = principalOf(user('u-dev'));
    allow(dataDir, 'u-dev', 'project:write', 'project', 'platform');
    for (const id of ['platform', ...MEMBERS]) expect(valueOf(dev, 'project:write', id), id).toBe('yes');
    // A grant on the member reaches ITS members, never its parent.
    const kid = principalOf(user('u-kid'));
    allow(dataDir, 'u-kid', 'project:read', 'project', 'billing');
    expect(valueOf(kid, 'project:read', 'billing')).toBe('yes');
    expect(valueOf(kid, 'project:read', 'payments')).toBe('yes');
    expect(valueOf(kid, 'project:read', 'platform')).toBe('no');
    expect(valueOf(kid, 'project:read', 'docs')).toBe('no');
  });

  it("an explicit no on the member's own record beats an inherited yes — and its members inherit the no", () => {
    upgrade();
    const dev = principalOf(user('u-dev'));
    allow(dataDir, 'u-dev', 'project:read', 'project', 'platform');
    allow(dataDir, 'u-dev', 'project:read', 'project', 'billing', 'no');
    expect(valueOf(dev, 'project:read', 'platform')).toBe('yes');
    expect(valueOf(dev, 'project:read', 'billing')).toBe('no');
    expect(valueOf(dev, 'project:read', 'payments')).toBe('no');
    expect(valueOf(dev, 'project:read', 'docs')).toBe('yes');
    // The unit rung does not override it either.
    allow(dataDir, 'u-dev', 'project:read', 'unit', unitId);
    expect(valueOf(dev, 'project:read', 'billing')).toBe('no');
  });

  it('a member is listed for whoever reaches it through its chain, and its units are its family root\'s', () => {
    upgrade();
    const dev = principalOf(user('u-dev'));
    allow(dataDir, 'u-dev', 'project:read', 'unit', unitId);
    expect(valueOf(dev, 'project:read', 'payments')).toBe('yes');
    // A placement of a member itself is not a rung (refused at the workflows; a stray row decides nothing).
    const other = seedUnit(dataDir, 'other');
    storePlacement(dataDir, { id: '', projectId: 'billing', unitId: other.id, role: 'owner', createdAt: '', createdBy: subjectOf('u-seeder') });
    const outsider = principalOf(user('u-outsider'));
    allow(dataDir, 'u-outsider', 'project:read', 'unit', other.id);
    expect(valueOf(outsider, 'project:read', 'billing')).toBe('no');
  });
});

// ── no-widening over the RBAC matrix ────────────────────────────────────────

describe('no-widening: every subject x capability equal before and after the upgrade', () => {
  it('holds over the RBAC matrix (unit grant, project grant, denial, everyone-defaults, a role, a later user)', () => {
    createRole(dataDir, {
      id: 'reviewer', name: 'Reviewer', createdAt: '',
      permissions: [{ capability: 'project:read', value: 'yes' }, { capability: 'approval:decide', value: 'yes' }],
    });
    const subjects = [
      user('u-unit'), user('u-proj'), user('u-deny'), user('u-none'),
      user('u-role', [{ roleId: 'reviewer', scopeKind: 'project', scopeId: 'platform' }]),
    ];
    for (const cap of ['project:read', 'project:write'] as Capability[]) allow(dataDir, 'u-unit', cap, 'unit', unitId);
    for (const cap of ['project:read', 'project:write', 'project:admin'] as Capability[]) allow(dataDir, 'u-proj', cap, 'project', 'platform');
    allow(dataDir, 'u-deny', 'project:read', 'unit', unitId);
    allow(dataDir, 'u-deny', 'project:read', 'project', 'platform', 'no');
    allow(dataDir, 'u-deny', 'project:write', 'project', 'platform', 'approval');
    everyone('project:read', 'yes', 'unit', unitId);
    everyone('share:create', 'no', 'project', 'platform');

    // Today's reach: the data plane authorized every member over its family root.
    const before = new Map<string, EffectiveValue>();
    for (const u of subjects) for (const cap of CAPABILITIES) before.set(`${u.id}|${cap}`, valueOf(principalOf(u), cap, 'platform'));

    const dry = upgradeMemberRecords(dataDir, false);
    expect(dry.plan.refusals).toEqual([]);
    // The plan's own proof: every user record (and everyone else) x capability x member, all equal.
    expect(dry.plan.reach).toHaveLength((subjects.length + 1) * CAPABILITIES.length * MEMBERS.length);
    expect(dry.plan.reach.every((r) => r.equal)).toBe(true);
    upgrade();

    let rows = 0;
    for (const memberId of MEMBERS) {
      for (const u of subjects) {
        for (const cap of CAPABILITIES) {
          expect({ memberId, user: u.id, cap, value: valueOf(principalOf(u), cap, memberId) })
            .toEqual({ memberId, user: u.id, cap, value: before.get(`${u.id}|${cap}`) });
          rows++;
        }
      }
    }
    // A user who arrives after the upgrade: a grant on the family root reaches every member.
    const later = user('u-later');
    allow(dataDir, 'u-later', 'project:write', 'project', 'platform');
    for (const memberId of MEMBERS) {
      for (const cap of CAPABILITIES) {
        expect(valueOf(principalOf(later), cap, memberId)).toBe(valueOf(principalOf(later), cap, 'platform'));
        rows++;
      }
    }
    expect(rows).toBe((subjects.length + 1) * CAPABILITIES.length * MEMBERS.length);
  });
});

// ── the upgrade itself ──────────────────────────────────────────────────────

describe('the member upgrade: plan-first, idempotent, refusing', () => {
  const stores = (): string[] => ['projects.json', path.join('auth', 'credentials.json')]
    .map((f) => (fs.existsSync(path.join(dataDir, f)) ? fs.readFileSync(path.join(dataDir, f), 'utf8') : '<absent>'));

  it('a dry run plans every member and writes nothing; apply writes it all; a re-run plans empty', () => {
    mintUserToken(dataDir, { id: 'k-q', userId: 'u-q', projects: ['platform::billing::payments'] });
    const before = stores();
    const dry = upgradeMemberRecords(dataDir, false);
    expect(dry.applied).toBe(false);
    expect(dry.plan.members.map((m) => [m.record.id, m.action, m.qualifier])).toEqual([
      ['billing', 'register', 'platform::billing'],
      ['payments', 'register', 'platform::billing::payments'],
      ['docs', 'register', 'platform::docs'],
    ]);
    expect(dry.plan.narrowings).toEqual([expect.objectContaining({ keyId: 'k-q', before: ['platform::billing::payments'], after: ['payments'] })]);
    expect(dry.plan.changes.map((c) => c.path).sort()).toEqual(['auth/credentials.json', 'projects.json']);
    expect(stores()).toEqual(before);
    expect(memberRegistration.pending(dataDir)).toBe(3);

    upgrade();
    expect(memberRegistration.pending(dataDir)).toBe(0);
    expect(listCredentials(dataDir, '*').find((k) => k.id === 'k-q')!.projects).toEqual(['payments']);

    const after = stores();
    const again = upgradeMemberRecords(dataDir, true);
    expect(again.applied).toBe(false);
    expect(again.plan.members.every((m) => m.action === 'unchanged')).toBe(true);
    expect(again.plan.narrowings).toEqual([]);
    expect(again.plan.rehearsal).toBeUndefined();
    expect(stores()).toEqual(after);
    // No transaction was left behind.
    const tx = path.join(dataDir, '.wai', 'transactions');
    expect(fs.existsSync(tx) ? fs.readdirSync(tx).filter((e) => e !== '.gitignore') : []).toEqual([]);
  });

  it('audits member.registered naming each member (composition: its family root) and token.narrowed per key', () => {
    mintUserToken(dataDir, { id: 'k-q', userId: 'u-q', projects: ['platform::billing'] });
    upgrade();
    const registered = queryAuditEvents(dataDir, { action: 'member.registered' });
    expect(registered.map((e) => [e.projectId, e.composition]).sort()).toEqual([
      ['billing', 'platform'], ['docs', 'platform'], ['payments', 'platform'],
    ]);
    const narrowed = queryAuditEvents(dataDir, { action: 'token.narrowed' });
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0].target).toBe('k-q');
    expect(JSON.parse(narrowed[0].metadata!)).toMatchObject({ before: ['platform::billing'], after: ['billing'] });
  });

  it('refuses the whole plan, writing nothing, for an id another record holds, an unreadable member, or a setting already at a member id', () => {
    createProjectRecord(dataDir, 'docs'); // a family root already holds the member's id
    fs.rmSync(path.join(fam.payments, '.wai', 'project.yaml')); // unreadable
    allow(dataDir, 'u-x', 'project:read', 'project', 'billing'); // a setting scoped at a member id
    const before = stores();
    const report = upgradeMemberRecords(dataDir, true);
    expect(report.applied).toBe(false);
    const details = report.plan.refusals.map((r) => r.detail).join('\n');
    expect(details).toMatch(/platform::docs: the id docs is already held by another record \(a family root\)/);
    // The unreadable member is named, where it is declared, and why it cannot be read.
    expect(details).toMatch(/platform::billing::payments \(at "sub\/payments" in billing\) is unreadable: .*payments holds no \.wai\/project\.yaml/);
    expect(details).toMatch(/platform::billing: the id billing already has a setting scoped at it/);
    expect(stores()).toEqual(before);
  });
});

// ── tokens ──────────────────────────────────────────────────────────────────

describe('qualified token compatibility (one release)', () => {
  it('an un-upgraded data dir binds no qualified member; after the upgrade a qualifier maps to the member record, never wider', () => {
    const q = { tokenId: 't', role: 'editor' as const, projects: ['platform::billing'], authenticated: true };
    expect(resolveProjectBinding(dataDir, q)).toBeNull();
    upgrade();
    expect(resolveProjectBinding(dataDir, q)).toEqual({ rootPath: path.resolve(fam.billing), projectId: 'billing', familyRootId: 'platform', via: 'platform::billing' });
    // Its member is covered; its parent and sibling are not.
    expect(resolveProjectBinding(dataDir, q, 'payments')?.projectId).toBe('payments');
    expect(resolveProjectBinding(dataDir, q, 'platform')).toBeNull();
    expect(resolveProjectBinding(dataDir, q, 'docs')).toBeNull();
    // A token naming the family root covers every member, with no expansion.
    const root = { ...q, projects: ['platform'] };
    for (const id of MEMBERS) expect(resolveProjectBinding(dataDir, root, id)?.projectId).toBe(id);
  });
});

describe('a pre-upgrade member-qualified lock request (one release)', () => {
  /** An approved project:lock request recorded before stage 7, with a member-qualifier payload. */
  const pending = (subproject: string) => {
    const req = createApprovalRequest(dataDir, {
      id: '', kind: 'project:lock', status: 'pending', requestedBy: subjectOf('u-req'), projectId: 'platform',
      summary: `Lock project platform subproject "${subproject}"`, payloadType: 'SubprojectScope',
      payload: JSON.stringify({ subproject }), createdAt: new Date().toISOString(),
    });
    return decideApprovalRequest(dataDir, { requestId: req.id, approved: true, decidedBy: subjectOf('u-decider'), decidedAt: new Date().toISOString() });
  };

  it("executes on the member record its qualifier maps to, never the parent", () => {
    upgrade();
    const req = pending('billing::payments');
    expect(executeApprovedRequest(cfg, MASTER, req.id)).toContain('Locked project "payments"');
    expect(fs.existsSync(path.join(fam.payments, '.wai', 'lock.json'))).toBe(true);
    expect(fs.existsSync(path.join(fam.platform, '.wai', 'lock.json'))).toBe(false);
  });

  it('refuses rather than widen when the qualifier maps to no record', () => {
    const req = pending('billing'); // the data dir is not upgraded yet
    expect(() => executeApprovedRequest(cfg, MASTER, req.id)).toThrow(/holds no hosted record — refusing to execute/);
    expect(fs.existsSync(path.join(fam.platform, '.wai', 'lock.json'))).toBe(false);
  });
});

// ── placement ───────────────────────────────────────────────────────────────

describe('placing a member refuses: a member takes its units from its family root', () => {
  it('refuses through the landscape and the web instance-admin workflows, writing no placement', () => {
    upgrade();
    const other = seedUnit(dataDir, 'other');
    const placement = { id: '', projectId: 'billing', unitId: other.id, role: 'owner', createdAt: '', createdBy: subjectOf('u-admin') };
    expect(() => landscapePlace(cfg, MASTER, placement)).toThrow(/A member takes its units from its family root/);
    allow(dataDir, 'u-admin', 'project:admin', 'instance', undefined);
    const session = createWebSession(dataDir, {
      id: '', subject: subjectOf('u-admin'), projects: ['*'], createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(() => webPlace(cfg, session.id, 'billing', other.id)).toThrow(/A member takes its units from its family root/);
    expect(listProjectPlacements(dataDir).some((p) => p.projectId === 'billing')).toBe(false);
    // The family root itself is still placeable.
    expect(landscapePlace(cfg, MASTER, { ...placement, projectId: 'platform' }).projectId).toBe('platform');
  });

  it('the permission-model migration never sweeps a member into the unassigned unit', () => {
    upgrade();
    // Unplace the family root: only IT is unplaced; its members never are.
    for (const p of listProjectPlacements(dataDir)) deletePlacement(dataDir, p.id);
    const report = migratePermissionModel(dataDir, true);
    const projectsFinding = report.findings.find((f) => f.area === 'projects');
    expect(projectsFinding?.detail).toMatch(/1 project\(s\) are placed in no organization unit: platform /);
    expect(listProjectPlacements(dataDir).map((p) => p.projectId)).toEqual(['platform']);
  });
});

// ── boot warning ────────────────────────────────────────────────────────────

describe('boot: members awaiting the upgrade', () => {
  it('logs how many members await `host doctor --fix`, and nothing once they are records', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    warnIfMembersPending(cfg);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/3 member\(s\) of hosted families hold no project record yet and await `wairon host doctor --fix`/);
    log.mockClear();
    upgrade();
    warnIfMembersPending(cfg);
    expect(log).not.toHaveBeenCalled();
  });
});

// ── the data plane: audit names the member; recover on bind ─────────────────

describe('the data plane binds members as records', () => {
  let server: http.Server;
  let port: number;

  beforeEach(async () => {
    upgrade();
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = undefined; }
        void handleMcpRequest(cfg, req, res, body).catch(() => {
          if (!res.headersSent) { res.writeHead(500); res.end(); }
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const send = async (token: string, tool: string, selector?: string): Promise<{ text: string; isError: boolean }> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp${selector ? `?project=${selector}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: {} } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
    return { text: body.result?.content?.[0]?.text ?? '', isError: body.result?.isError === true };
  };

  it('audit-names-the-member: the event names the member record; a deprecated qualifier adds its family root as composition', async () => {
    allow(dataDir, 'u-dev', 'project:read', 'project', 'platform');
    const byId = mintUserToken(dataDir, { id: 'tok-id', userId: 'u-dev', projects: ['payments'] });
    const byQualifier = mintUserToken(dataDir, { id: 'tok-q', userId: 'u-dev', projects: ['platform::billing::payments'] });
    expect((await send(byId, 'sdd_host_pack_list')).isError).toBe(false);
    expect((await send(byQualifier, 'sdd_host_pack_list')).isError).toBe(false);
    const events = queryAuditEvents(dataDir, { action: 'mcp.tool.call' });
    expect(events.find((e) => e.tokenId === 'tok-id')).toMatchObject({ projectId: 'payments' });
    expect(events.find((e) => e.tokenId === 'tok-id')!.composition).toBeUndefined();
    expect(events.find((e) => e.tokenId === 'tok-q')).toMatchObject({ projectId: 'payments', composition: 'platform' });
  });

  it('an explicit no on the member refuses its data-plane read even though the parent grants it', async () => {
    allow(dataDir, 'u-dev', 'project:read', 'project', 'platform');
    allow(dataDir, 'u-dev', 'project:read', 'project', 'billing', 'no');
    const tok = mintUserToken(dataDir, { id: 'tok-root', userId: 'u-dev', projects: ['platform'] });
    // The binding itself is allowed (the token covers the member); the permission gate refuses.
    const refused = await send(tok, 'sdd_host_pack_list', 'billing');
    expect(refused.isError).toBe(true);
    expect((await send(tok, 'sdd_host_pack_list', 'docs')).isError).toBe(false);
  });

  it('recovers a crashed family migration on bind, before the tool runs, and audits it naming the project', async () => {
    // A family transaction that crashed after staging: journals under the family root and the member.
    const rehearsal = transaction.rehearse({ familyRoot: fam.platform, projects: [fam.platform, fam.billing] });
    const copy = path.join(rehearsal.directory, 'packages', 'billing', '.wai', 'project.yaml');
    fs.writeFileSync(copy, fs.readFileSync(copy, 'utf8').replace('name: billing', 'name: half-applied'));
    const changes = transaction.diff(rehearsal);
    expect(changes).toHaveLength(1);
    transaction.stage(rehearsal, changes, 'rename');
    expect(fs.existsSync(path.join(fam.platform, '.wai', 'transactions', rehearsal.id))).toBe(true);
    transaction.discard(rehearsal);

    allow(dataDir, 'u-dev', 'project:read', 'project', 'platform');
    const tok = mintUserToken(dataDir, { id: 'tok-b', userId: 'u-dev', projects: ['billing'] });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect((await send(tok, 'sdd_host_pack_list')).isError).toBe(false);
    log.mockRestore();

    expect(fs.existsSync(path.join(fam.platform, '.wai', 'transactions', rehearsal.id))).toBe(false);
    expect(fs.existsSync(path.join(fam.billing, '.wai', 'transactions', rehearsal.id))).toBe(false);
    expect(fs.readFileSync(path.join(fam.billing, '.wai', 'project.yaml'), 'utf8')).toContain('name: billing');
    const recovered = queryAuditEvents(dataDir, { action: 'migration.recovered' });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ projectId: 'platform', target: rehearsal.id });
  });

  it('a member registered by hand binds only while its directory still holds its project', () => {
    registerMemberRecord(dataDir, { id: 'ghost', rootPath: '', status: 'active', createdAt: '', parentProjectId: 'platform', memberPath: 'packages/ghost' });
    expect(resolveProjectBinding(dataDir, { tokenId: 't', role: 'editor', projects: ['*'], authenticated: true }, 'ghost')).toBeNull();
  });
});
