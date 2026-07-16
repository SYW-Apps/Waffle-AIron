import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  getPackPolicyRecord,
  setPackPolicyRecord,
  PERMISSIVE_DEFAULT_POLICY,
  getPackPolicy,
  setPackPolicy,
  evaluateInitRequest,
  executeApprovedInit,
  initializeProjectWithProfile,
  evaluateProjectPolicy,
  reconcileProjectPolicy,
} from '../../src/server/policy.js';
import { routeAdmin } from '../../src/server/http.js';
import { createProject } from '../../src/server/admin.js';
import { mintUserToken, allow, seedUnit, createPlacedProject } from './helpers.js';
import { listProjectPacks } from '../../src/server/packs.js';
import { ForbiddenError } from '../../src/server/identity.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import type {
  ApiKeyRecord,
  HostConfig,
  InstancePackPolicy,
  PrincipalSubject,
  ProjectGrant,
  ProjectProfileSelection,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Pack/Profile Policy plane (sdd_host) — Phase 3. Exercised through the exported
// storage facade, orchestrator functions, and the HTTP portal (routeAdmin) over
// a real <dataDir> with real minted credentials, mirroring selfservice.test.ts.
// Covers storage null → permissive-default substitution, policy:manage-gated
// set/get with server-stamped updatedAt + caller updatedBy, pre-creation and
// existing-project evaluation, block-mode rejection, end-to-end init that
// vendors packs + records the profile selection, auto-reconciliation, and the
// five portal routes.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

function samplePolicy(over: Partial<InstancePackPolicy> = {}): InstancePackPolicy {
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

function selection(over: Partial<ProjectProfileSelection> = {}): ProjectProfileSelection {
  return { profileIds: [], requiredPackNames: [], selectedAt: '', ...over };
}

describe('project policy orchestrator (sdd_host)', () => {
  let dataDir: string;
  let packsDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-policy-'));
    packsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-policy-packs-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_PACKS_DIR = packsDir; // isolate the server-global pack set
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    for (const dir of [dataDir, packsDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
    }
  });

  /** Seed a declarative pack named `name` into the server-global pack set. */
  function seedGlobalPack(name: string): void {
    fs.writeFileSync(path.join(packsDir, `${name}.yaml`), `name: ${name}\nprofiles: {}\nlanguages: {}\n`);
  }

  /** Read a project's raw .wai/project.yaml (including the un-schema'd profileSelection). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function readRawConfig(root: string): any {
    return readYamlFile(path.join(root, '.wai', 'project.yaml'));
  }

  function packNames(project: string): string[] {
    return listProjectPacks(cfg, MASTER, project).map((d) => d.name);
  }

  // ── storage facade + permissive default ──────────────────────────────────

  it('get before any set: the storage facade returns null; the orchestrator returns the permissive default', () => {
    expect(getPackPolicyRecord(dataDir)).toBeNull();

    const reader = mintUserToken(dataDir, { id: 'r', userId: 'u-r' });
    const pol = getPackPolicy(cfg, reader);
    expect(pol.enforcementMode).toBe('warn');
    expect(pol.requireProfileSelection).toBe(false);
    expect(pol.requiredGlobalPacks).toEqual([]);
    expect(pol.defaultProjectPacks).toEqual([]);
    expect(pol).toEqual(PERMISSIVE_DEFAULT_POLICY);
  });

  it('setPackPolicyRecord: stamps updatedAt server-side and preserves the caller-supplied updatedBy', () => {
    const stored = setPackPolicyRecord(dataDir, samplePolicy({ updatedBy: subject({ userId: 'u-keep' }) }));
    expect(Date.parse(stored.updatedAt)).toBeGreaterThan(0);
    expect(stored.updatedBy?.userId).toBe('u-keep');
    expect(getPackPolicyRecord(dataDir)?.updatedBy?.userId).toBe('u-keep');
  });

  it('getPackPolicyRecord: a malformed store fails with a storage error naming the path', () => {
    fs.writeFileSync(path.join(dataDir, 'pack-policy.json'), '{ not json');
    expect(() => getPackPolicyRecord(dataDir)).toThrow(/pack-policy\.json/);
  });

  // ── setPackPolicy authorization + stamping + audit ───────────────────────

  it('setPackPolicy: project:admin gated — 403 for a plain writer token, admin stamps caller updatedBy and audits at security level', () => {
    allow(dataDir, 'u-ed', 'project:write', 'instance', undefined);
    const editor = mintUserToken(dataDir, { id: 'ed', userId: 'u-ed' });
    expect(() => setPackPolicy(cfg, editor, samplePolicy())).toThrow(ForbiddenError);

    const before = Date.now();
    const stored = setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['foo'] }));
    expect(Date.parse(stored.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(stored.updatedBy?.userId).toBe('bootstrap'); // caller-derived
    expect(stored.requiredGlobalPacks).toEqual(['foo']);

    // Round-trips through both the orchestrator read and the storage facade.
    expect(getPackPolicy(cfg, MASTER).requiredGlobalPacks).toEqual(['foo']);
    expect(getPackPolicyRecord(dataDir)?.updatedBy?.userId).toBe('bootstrap');

    const audit = queryAuditEvents(dataDir, { action: 'policy.set' });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].level).toBe('security');
  });

  it('setPackPolicy: a delegated instance-level project:admin is authorized and stamps its own subject', () => {
    allow(dataDir, 'u-mg', 'project:admin', 'instance', undefined);
    const mgr = mintUserToken(dataDir, { id: 'mg', userId: 'u-mg' });
    const stored = setPackPolicy(cfg, mgr, samplePolicy());
    expect(stored.updatedBy?.userId).toBe('u-mg');
  });

  // ── S2: policy administration is an INSTANCE capability (cross-tenant) ──────
  //
  // A PROJECT- or UNIT-scoped project:admin must NOT satisfy an instance-level
  // capability. Only an instance-level assignment (or the instance-admin bypass)
  // passes, and a unit-scoped creator cannot create into a foreign unit.

  it('S2: scoped project:admin / project:create never widen to the instance; instance-level passes', () => {
    // Project-scoped project:admin → still denied; instance-level → authorized.
    allow(dataDir, 'u-s2pm', 'project:admin', 'project', 'acme');
    const projMgr = mintUserToken(dataDir, { id: 's2-pm', userId: 'u-s2pm' });
    expect(() => setPackPolicy(cfg, projMgr, samplePolicy())).toThrow(ForbiddenError);
    allow(dataDir, 'u-s2im', 'project:admin', 'instance', undefined);
    const instMgr = mintUserToken(dataDir, { id: 's2-im', userId: 'u-s2im' });
    expect(setPackPolicy(cfg, instMgr, samplePolicy()).id).toBeTruthy();

    // A creator scoped to unit A may NOT create into unit B; nothing is provisioned.
    const unitA = seedUnit(dataDir, 'A');
    const unitB = seedUnit(dataDir, 'B');
    allow(dataDir, 'u-s2pc', 'project:create', 'unit', unitA.id);
    const projCreator = mintUserToken(dataDir, { id: 's2-pc', userId: 'u-s2pc' });
    expect(() =>
      initializeProjectWithProfile(cfg, projCreator, { id: 'nope-s2', ownerUnitId: unitB.id }),
    ).toThrow(ForbiddenError);
    expect(existingProjectRoot(dataDir, 'nope-s2')).toBeNull();
  });

  // ── evaluateInitRequest ──────────────────────────────────────────────────

  it('evaluateInitRequest: flags a missing required profile selection under requireProfileSelection', () => {
    setPackPolicy(cfg, MASTER, samplePolicy({ requireProfileSelection: true }));
    const res = evaluateInitRequest(cfg, { id: 'p' });
    expect(res.compliant).toBe(false);
    expect(res.messages.join(' ')).toMatch(/profile selection is required/i);
  });

  it('evaluateInitRequest: flags a blocked pack requested in the profile selection', () => {
    setPackPolicy(cfg, MASTER, samplePolicy({ blockedPackNames: ['danger'] }));
    const res = evaluateInitRequest(cfg, { id: 'p', profileSelection: selection({ requiredPackNames: ['danger'] }) });
    expect(res.compliant).toBe(false);
    expect(res.blockedPackNames).toContain('danger');
  });

  it('evaluateInitRequest: flags an unknown (disallowed) profile id', () => {
    setPackPolicy(cfg, MASTER, samplePolicy({ allowedProfileIds: ['approved'] }));
    const res = evaluateInitRequest(cfg, { id: 'p', profileSelection: selection({ profileIds: ['rogue'] }) });
    expect(res.compliant).toBe(false);
    expect(res.messages.join(' ')).toMatch(/rogue.*not permitted/i);
  });

  // ── executeApprovedInit ──────────────────────────────────────────────────

  it('executeApprovedInit: block mode with a violation throws and creates no project', () => {
    setPackPolicy(cfg, MASTER, samplePolicy({ enforcementMode: 'block', requireProfileSelection: true }));
    expect(() => executeApprovedInit(cfg, { id: 'blocked-proj', ownerUnitId: 'nowhere' })).toThrow(/policy violation/i);
    expect(existingProjectRoot(dataDir, 'blocked-proj')).toBeNull();
  });

  it('executeApprovedInit: happy path creates + PLACES the project, vendors required+default packs, and records the profile selection', () => {
    seedGlobalPack('foo');
    seedGlobalPack('bar');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['foo'], defaultProjectPacks: ['bar'] }));

    const unit = seedUnit(dataDir, 'happy-unit');
    const rec = executeApprovedInit(cfg, { id: 'happy-proj', ownerUnitId: unit.id });
    expect(rec.id).toBe('happy-proj');

    // Packs really installed — asserted via the packs module list.
    expect(packNames('happy-proj')).toEqual(expect.arrayContaining(['foo', 'bar']));

    // profileSelection recorded into the project config.
    const raw = readRawConfig(rec.rootPath);
    expect(raw.profileSelection.requiredPackNames).toContain('foo');
    expect(raw.profileSelection.defaultPackNames).toContain('bar');

    // Policy-aware init audit event exists.
    expect(queryAuditEvents(dataDir, { action: 'project.init.policy' }).length).toBeGreaterThanOrEqual(1);
  });

  // ── initializeProjectWithProfile (gated) ─────────────────────────────────

  it('initializeProjectWithProfile: instance-level project:create works and attributes selectedBy; a plain writer is 403', () => {
    const unit = seedUnit(dataDir, 'creator-unit');
    allow(dataDir, 'u-cr', 'project:create', 'instance', undefined);
    const creator = mintUserToken(dataDir, { id: 'cr', userId: 'u-cr' });
    allow(dataDir, 'u-wr', 'project:write', 'instance', undefined);
    const writer = mintUserToken(dataDir, { id: 'wr', userId: 'u-wr' });

    expect(() => initializeProjectWithProfile(cfg, writer, { id: 'nope-proj', ownerUnitId: unit.id })).toThrow(ForbiddenError);
    expect(existingProjectRoot(dataDir, 'nope-proj')).toBeNull();

    const rec = initializeProjectWithProfile(cfg, creator, { id: 'creator-proj', ownerUnitId: unit.id });
    expect(existingProjectRoot(dataDir, 'creator-proj')).toBeTruthy();
    expect(readRawConfig(rec.rootPath).profileSelection.selectedBy.userId).toBe('u-cr');
  });

  // ── evaluate + reconcile on an existing project ──────────────────────────

  it('evaluateProjectPolicy: requires project:write over the project (403 for a plain reader)', () => {
    createPlacedProject(cfg, MASTER, 'guard-proj');
    allow(dataDir, 'u-gr', 'project:read', 'project', 'guard-proj');
    const reader = mintUserToken(dataDir, { id: 'gr', userId: 'u-gr' });
    expect(() => evaluateProjectPolicy(cfg, reader, 'guard-proj')).toThrow(ForbiddenError);
  });

  it('evaluate + reconcile: a non-compliant project becomes compliant after auto_reconcile installs the required pack, and both are audited', () => {
    seedGlobalPack('foo');
    createPlacedProject(cfg, MASTER, 'plain-proj'); // provisioned, no packs
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['foo'], enforcementMode: 'auto_reconcile' }));

    const before = evaluateProjectPolicy(cfg, MASTER, 'plain-proj');
    expect(before.compliant).toBe(false);
    expect(before.missingPackNames).toContain('foo');
    expect(before.mode).toBe('auto_reconcile');

    const after = reconcileProjectPolicy(cfg, MASTER, 'plain-proj');
    expect(after.compliant).toBe(true);
    expect(after.missingPackNames).not.toContain('foo');
    expect(packNames('plain-proj')).toContain('foo');

    // Re-evaluation confirms the reconciled state persisted.
    expect(evaluateProjectPolicy(cfg, MASTER, 'plain-proj').compliant).toBe(true);

    expect(queryAuditEvents(dataDir, { action: 'policy.set' }).length).toBeGreaterThanOrEqual(1);
    expect(queryAuditEvents(dataDir, { action: 'policy.reconcile' }).length).toBeGreaterThanOrEqual(1);
  });

  it('reconcileProjectPolicy: leaves gaps in place when the policy mode does not permit auto-reconciliation', () => {
    seedGlobalPack('foo');
    createPlacedProject(cfg, MASTER, 'warn-proj');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['foo'], enforcementMode: 'warn' }));

    const res = reconcileProjectPolicy(cfg, MASTER, 'warn-proj');
    expect(res.compliant).toBe(false);
    expect(res.missingPackNames).toContain('foo');
    expect(packNames('warn-proj')).not.toContain('foo'); // nothing installed under 'warn'
  });

  it('evaluateProjectPolicy: an unknown project is a not-found error', () => {
    expect(() => evaluateProjectPolicy(cfg, MASTER, 'ghost-proj')).toThrow(/unknown project/i);
  });
});

// ── HTTP portal (routeAdmin) ─────────────────────────────────────────────────

describe('project policy portal (sdd_host http)', () => {
  let dataDir: string;
  let packsDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let baseUrl: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-policy-http-'));
    packsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-policy-http-packs-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_PACKS_DIR = packsDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

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
    for (const dir of [dataDir, packsDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* windows file locks */
      }
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

  it('the five policy endpoints respond with the correct statuses through routeAdmin', async () => {
    // PUT /instance/pack-policy (policy administration) → 200.
    const put = await api('PUT', '/instance/pack-policy', { cred: MASTER, body: samplePolicy() });
    expect(put.status).toBe(200);
    expect(put.json.updatedBy.userId).toBe('bootstrap');

    // GET /instance/pack-policy (any authenticated) → 200; unauthenticated → 401.
    expect((await api('GET', '/instance/pack-policy', { cred: MASTER })).status).toBe(200);
    expect((await api('GET', '/instance/pack-policy')).status).toBe(401);

    // POST /projects/init → 201, project provisioned on disk and PLACED in its
    // required owner unit.
    const unit = seedUnit(dataDir, 'http-unit');
    const init = await api('POST', '/projects/init', { cred: MASTER, body: { id: 'http-proj', ownerUnitId: unit.id } });
    expect(init.status).toBe(201);
    expect(init.json.id).toBe('http-proj');
    expect(existingProjectRoot(dataDir, 'http-proj')).toBeTruthy();

    // GET /projects/{id}/policy/evaluation → 200.
    const evaluation = await api('GET', '/projects/http-proj/policy/evaluation', { cred: MASTER });
    expect(evaluation.status).toBe(200);
    expect(evaluation.json.compliant).toBe(true);

    // POST /projects/{id}/policy/reconcile → 200.
    const reconcile = await api('POST', '/projects/http-proj/policy/reconcile', { cred: MASTER });
    expect(reconcile.status).toBe(200);
    expect(typeof reconcile.json.compliant).toBe('boolean');
  });

  it('does not shadow the /admin/projects surface (a bare /admin/projects list still works)', async () => {
    const res = await api('GET', '/admin/projects', { cred: MASTER });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
  });
});
