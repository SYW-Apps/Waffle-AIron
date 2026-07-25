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
  getProjectConfig,
  setProjectType,
} from '../../src/server/policy.js';
import { routeAdmin } from '../../src/server/http.js';
import { createProject } from '../../src/server/admin.js';
import { mintUserToken, allow, seedUnit, createPlacedProject } from './helpers.js';
import { adoptProjectPack, listProjectPacks } from '../../src/server/packs.js';
import { ForbiddenError } from '../../src/server/identity.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
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

  /** Seed a server-global declarative pack CONTRIBUTING one architectural profile —
   *  the only way a profile id outside the built-in set can ever govern a project.
   *  The file stem deliberately differs from the canonical manifest name. */
  function seedProfilePack(stem: string, packName: string, profileId: string): void {
    fs.writeFileSync(
      path.join(packsDir, `${stem}.yaml`),
      [`name: ${packName}`, 'profiles:', `  ${profileId}:`, '    family: backend-like', 'languages: {}', ''].join('\n'),
    );
  }

  /** Read a project's raw .wai/project.yaml (projectType + the recorded profileSelection). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function readRawConfig(root: string): any {
    return readYamlFile(path.join(root, '.wai', 'project.yaml'));
  }

  /** Overwrite a project's raw .wai/project.yaml — the hand-edited/legacy shape the
   *  honest-reporting paths must cope with. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function writeRawConfig(root: string, raw: any): void {
    writeYamlFile(path.join(root, '.wai', 'project.yaml'), raw);
  }

  function packNames(project: string): string[] {
    return listProjectPacks(cfg, MASTER, project).map((d) => d.name);
  }

  /** The metadata payloads of a project's audit events for one action. Order-free:
   *  same-millisecond appends make timestamp ordering unreliable. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function auditMetadata(action: string, projectId: string): any[] {
    return queryAuditEvents(dataDir, { action, projectId }).map((e) => JSON.parse(e.metadata ?? '{}'));
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
    const unitA = seedUnit(dataDir, 'unit-a');
    const unitB = seedUnit(dataDir, 'unit-b');
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

  // ── project config (projectType + lock) ──────────────────────────────────

  it('getProjectConfig: a fresh project defaults to backend, reports unlocked, and reports the profile genuinely in force', () => {
    createPlacedProject(cfg, MASTER, 'cfg-proj');
    expect(getProjectConfig(cfg, MASTER, 'cfg-proj')).toEqual({
      projectType: 'backend',
      locked: false,
      // A built-in profile really governs — reported, not merely echoed back.
      profileSource: 'builtin',
      profileResolvable: true,
      unappliedProfileIds: [],
      overridingSubsystemIds: [],
    });
  });

  it('setProjectType: persists projectType into project.yaml and round-trips through getProjectConfig', () => {
    createPlacedProject(cfg, MASTER, 'cfg-proj');
    const updated = setProjectType(cfg, MASTER, 'cfg-proj', 'frontend-reactive');
    expect(updated.projectType).toBe('frontend-reactive');

    const root = existingProjectRoot(dataDir, 'cfg-proj')!;
    expect(readRawConfig(root).projectType).toBe('frontend-reactive'); // persisted to disk
    expect(getProjectConfig(cfg, MASTER, 'cfg-proj').projectType).toBe('frontend-reactive'); // read back
  });

  it('setProjectType preserves other project.yaml keys (raw read-merge-write)', () => {
    createPlacedProject(cfg, MASTER, 'cfg-proj');
    const root = existingProjectRoot(dataDir, 'cfg-proj')!;
    const before = readRawConfig(root);
    setProjectType(cfg, MASTER, 'cfg-proj', 'game-ecs');
    const after = readRawConfig(root);
    // Every pre-existing key survives; only projectType is (re)written.
    for (const key of Object.keys(before)) {
      if (key === 'projectType') continue;
      expect(after[key]).toEqual(before[key]);
    }
    expect(after.projectType).toBe('game-ecs');
  });

  it('getProjectConfig requires project:read; setProjectType requires project:write', () => {
    createPlacedProject(cfg, MASTER, 'cfg-guard');
    // No grant at all → cannot even read.
    const stranger = mintUserToken(dataDir, { id: 'st', userId: 'u-st' });
    expect(() => getProjectConfig(cfg, stranger, 'cfg-guard')).toThrow(ForbiddenError);
    // project:read alone → may read, but NOT set the type.
    allow(dataDir, 'u-rd', 'project:read', 'project', 'cfg-guard');
    const reader = mintUserToken(dataDir, { id: 'rd', userId: 'u-rd' });
    expect(getProjectConfig(cfg, reader, 'cfg-guard').projectType).toBe('backend');
    expect(() => setProjectType(cfg, reader, 'cfg-guard', 'lowlevel-os')).toThrow(ForbiddenError);
  });

  // ── the governing profile: APPLIED, not merely recorded ──────────────────
  //
  // projectType is what the validator enforces; profileSelection is only the
  // record of what was chosen. The two used to drift freely — a policy could
  // require a profile, init could record it, and nothing would ever apply it — so
  // these cover the whole loop: init applies, setProjectType ensures-then-writes
  // and keeps the record honest, getProjectConfig/evaluate REPORT reality, and
  // reconcile repairs only what is actually broken.

  it('init APPLIES a policy-required profile as the governing projectType, vendoring its pack', () => {
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredProfileIds: ['ddd'] }));

    const unit = seedUnit(dataDir, 'apply-unit');
    const rec = executeApprovedInit(cfg, { id: 'apply-proj', ownerUnitId: unit.id });

    // The headline bug: the required profile now GOVERNS instead of being a name
    // recorded in profileSelection that nothing enforces.
    expect(readRawConfig(rec.rootPath).projectType).toBe('ddd');
    expect(readRawConfig(rec.rootPath).profileSelection.profileIds).toContain('ddd');
    // ...and it genuinely resolves: the contributing pack was vendored in.
    expect(packNames('apply-proj')).toContain('acme-doctrine');
    expect(getProjectConfig(cfg, MASTER, 'apply-proj')).toMatchObject({
      projectType: 'ddd',
      profileSource: 'acme-doctrine',
      profileResolvable: true,
      unappliedProfileIds: [],
    });
    expect(auditMetadata('project.init.policy', 'apply-proj')[0]).toMatchObject({
      appliedProfileId: 'ddd',
      profileSource: 'acme-doctrine',
    });
  });

  it('init with a selection the instance cannot resolve leaves the default projectType and still creates the project', () => {
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredProfileIds: ['ghost-profile'] }));

    const unit = seedUnit(dataDir, 'ghost-unit');
    executeApprovedInit(cfg, { id: 'ghost-proj', ownerUnitId: unit.id });

    // Policy bookkeeping must never be able to fail project creation.
    expect(existingProjectRoot(dataDir, 'ghost-proj')).toBeTruthy();
    expect(getProjectConfig(cfg, MASTER, 'ghost-proj').projectType).toBe('backend');

    // The reason rides on the audit instead of an exception...
    expect(auditMetadata('project.init.policy', 'ghost-proj')[0]).toMatchObject({
      appliedProfileId: null,
      profileNotApplied: expect.stringMatching(/no selected profile is resolvable/i),
      unappliedProfileIds: ['ghost-profile'],
    });
    // ...and the drift is visible in the evaluation rather than invisible.
    const ev = evaluateProjectPolicy(cfg, MASTER, 'ghost-proj');
    expect(ev.governingProfileId).toBe('backend');
    expect(ev.unappliedProfileIds).toEqual(['ghost-profile']);
    expect(ev.messages.some((m) => /recorded but does not govern/.test(m))).toBe(true);
  });

  it('init with TWO selected profiles applies the FIRST and reports the second as the unapplied remainder', () => {
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    seedProfilePack('hex', 'hex-doctrine', 'hexagonal');

    const unit = seedUnit(dataDir, 'two-unit');
    const rec = executeApprovedInit(cfg, {
      id: 'two-proj',
      ownerUnitId: unit.id,
      profileSelection: selection({ profileIds: ['ddd', 'hexagonal'] }),
    });

    // projectType takes exactly one profile: the first, with the rest still recorded.
    const raw = readRawConfig(rec.rootPath);
    expect(raw.projectType).toBe('ddd');
    expect(raw.profileSelection.profileIds).toEqual(['ddd', 'hexagonal']);
    expect(getProjectConfig(cfg, MASTER, 'two-proj').unappliedProfileIds).toEqual(['hexagonal']);
    expect(evaluateProjectPolicy(cfg, MASTER, 'two-proj').unappliedProfileIds).toEqual(['hexagonal']);
    expect(auditMetadata('project.init.policy', 'two-proj')[0]).toMatchObject({
      appliedProfileId: 'ddd',
      unappliedProfileIds: ['hexagonal'],
    });
  });

  it('setProjectType ADOPTS the contributing server-global pack, reports it, and leaves the profile genuinely resolvable', () => {
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    createPlacedProject(cfg, MASTER, 'adopt-proj');

    const view = setProjectType(cfg, MASTER, 'adopt-proj', 'ddd');
    expect(view).toMatchObject({
      projectType: 'ddd',
      profileSource: 'acme-doctrine',
      profileResolvable: true,
      adoptedPackName: 'acme-doctrine',
    });
    expect(packNames('adopt-proj')).toContain('acme-doctrine');

    // Genuinely in force afterwards — and a second write adopts nothing further.
    expect(getProjectConfig(cfg, MASTER, 'adopt-proj')).toMatchObject({
      projectType: 'ddd',
      profileSource: 'acme-doctrine',
      profileResolvable: true,
    });
    expect(setProjectType(cfg, MASTER, 'adopt-proj', 'ddd').adoptedPackName).toBeUndefined();
  });

  it('setProjectType REFUSES a profile id no tier contributes and leaves project.yaml byte-for-byte intact', () => {
    createPlacedProject(cfg, MASTER, 'refuse-proj');
    const root = existingProjectRoot(dataDir, 'refuse-proj')!;
    setProjectType(cfg, MASTER, 'refuse-proj', 'game-ecs');
    const before = fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8');

    // Writing an unresolvable id would silently disable the whole profile
    // doctrine, so it is refused BEFORE anything is written.
    expect(() => setProjectType(cfg, MASTER, 'refuse-proj', 'ghost-profile')).toThrow(/ghost-profile/);
    expect(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8')).toBe(before);
    expect(getProjectConfig(cfg, MASTER, 'refuse-proj').projectType).toBe('game-ecs');
  });

  it('setProjectType folds the applied id to the FRONT of profileSelection without losing the other recorded ids', () => {
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    const unit = seedUnit(dataDir, 'fold-unit');
    executeApprovedInit(cfg, {
      id: 'fold-proj',
      ownerUnitId: unit.id,
      profileSelection: selection({ profileIds: ['ddd', 'hexagonal'] }),
    });

    // 'ddd' governs after init; switching to a built-in must not drop the record.
    const view = setProjectType(cfg, MASTER, 'fold-proj', 'frontend-reactive');
    expect(view.unappliedProfileIds).toEqual(['ddd', 'hexagonal']);

    const raw = readRawConfig(existingProjectRoot(dataDir, 'fold-proj')!);
    expect(raw.projectType).toBe('frontend-reactive');
    expect(raw.profileSelection.profileIds).toEqual(['frontend-reactive', 'ddd', 'hexagonal']);
    expect(raw.profileSelection.selectedBy.userId).toBe('bootstrap'); // the authenticated caller
    expect(Date.parse(raw.profileSelection.selectedAt)).toBeGreaterThan(0);
  });

  it('getProjectConfig REPORTS an unresolvable projectType (profileResolvable false) and repairs nothing', () => {
    createPlacedProject(cfg, MASTER, 'stale-proj');
    const root = existingProjectRoot(dataDir, 'stale-proj')!;
    writeRawConfig(root, { ...readRawConfig(root), projectType: 'ghost-profile' });

    const view = getProjectConfig(cfg, MASTER, 'stale-proj');
    expect(view.projectType).toBe('ghost-profile');
    expect(view.profileResolvable).toBe(false);
    expect(view.profileSource).toBeUndefined();
    expect(readRawConfig(root).projectType).toBe('ghost-profile'); // report-only: nothing repaired

    // A profile only a server-global pack contributes is likewise NOT governing
    // until its pack is adopted into the project.
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    writeRawConfig(root, { ...readRawConfig(root), projectType: 'ddd' });
    expect(getProjectConfig(cfg, MASTER, 'stale-proj').profileResolvable).toBe(false);
  });

  it('reconcileProjectPolicy REPAIRS a policy-required profile that is not governing, and leaves a compliant one alone', () => {
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    createPlacedProject(cfg, MASTER, 'rec-proj'); // projectType 'backend'
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredProfileIds: ['ddd'] }));

    const res = reconcileProjectPolicy(cfg, MASTER, 'rec-proj');
    expect(res.governingProfileId).toBe('ddd');
    expect(readRawConfig(existingProjectRoot(dataDir, 'rec-proj')!).projectType).toBe('ddd');
    expect(packNames('rec-proj')).toContain('acme-doctrine'); // the pack was vendored to make it resolve

    // A second reconcile repairs nothing: the profile is resolvable AND compliant.
    reconcileProjectPolicy(cfg, MASTER, 'rec-proj');
    const repairs = auditMetadata('policy.reconcile', 'rec-proj').filter((m) => m.repairedProfileId);
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ repairedProfileId: 'ddd', previousProfileId: 'backend' });

    // A deliberate, resolvable, POLICY-COMPLIANT projectType survives reconciliation.
    createPlacedProject(cfg, MASTER, 'keep-proj');
    setProjectType(cfg, MASTER, 'keep-proj', 'game-ecs');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredProfileIds: ['game-ecs', 'ddd'] }));
    expect(reconcileProjectPolicy(cfg, MASTER, 'keep-proj').governingProfileId).toBe('game-ecs');
    expect(readRawConfig(existingProjectRoot(dataDir, 'keep-proj')!).projectType).toBe('game-ecs');
    expect(auditMetadata('policy.reconcile', 'keep-proj').filter((m) => m.repairedProfileId)).toEqual([]);
  });

  it('reconcileProjectPolicy CONVERGES: a repair folds into the recorded selection, so compliance is satisfied', () => {
    // The non-convergence trap: compliance reads the RECORDED SELECTION, while a
    // repair writes projectType. A project created BEFORE the policy required a
    // profile has that id in neither place, so a repair that only wrote
    // projectType would leave "Required profile is not selected" reported
    // forever — the operator told to reconcile a project reconciliation just
    // fixed (the same loop the pack-name canonicalization fix removed).
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    createPlacedProject(cfg, MASTER, 'conv-proj'); // created under a policy with NO profile requirement
    const root = existingProjectRoot(dataDir, 'conv-proj')!;
    expect(readRawConfig(root).profileSelection?.profileIds ?? []).not.toContain('ddd');

    // The policy CHANGES afterwards to require the profile.
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredProfileIds: ['ddd'] }));
    expect(evaluateProjectPolicy(cfg, MASTER, 'conv-proj').compliant).toBe(false);

    // One reconcile both repairs the governing profile AND records it.
    const res = reconcileProjectPolicy(cfg, MASTER, 'conv-proj');
    expect(res.governingProfileId).toBe('ddd');
    expect(readRawConfig(root).profileSelection.profileIds[0]).toBe('ddd'); // folded to the FRONT
    expect(res.missingProfileIds).toEqual([]);
    expect(res.compliant).toBe(true); // converged in ONE pass

    // And it STAYS converged: a plain evaluation afterwards agrees, and a second
    // reconcile finds nothing left to repair.
    expect(evaluateProjectPolicy(cfg, MASTER, 'conv-proj').compliant).toBe(true);
    reconcileProjectPolicy(cfg, MASTER, 'conv-proj');
    expect(auditMetadata('policy.reconcile', 'conv-proj').filter((m) => m.repairedProfileId)).toHaveLength(1);
  });

  it('reconcileProjectPolicy repairs a projectType that resolves to nothing, from the recorded selection', () => {
    // The pack-removed recovery: the name is recorded on both projectType and the
    // selection, but no loaded profile carries it until its pack is re-vendored.
    seedProfilePack('acme', 'acme-doctrine', 'ddd');
    createPlacedProject(cfg, MASTER, 'broken-proj');
    const root = existingProjectRoot(dataDir, 'broken-proj')!;
    writeRawConfig(root, {
      ...readRawConfig(root),
      projectType: 'ddd',
      profileSelection: { profileIds: ['ddd'], requiredPackNames: [], selectedAt: '' },
    });
    expect(getProjectConfig(cfg, MASTER, 'broken-proj').profileResolvable).toBe(false);

    // No policy profile requirement at all — condition (b) alone drives the repair.
    const res = reconcileProjectPolicy(cfg, MASTER, 'broken-proj');
    expect(res.governingProfileId).toBe('ddd');
    expect(packNames('broken-proj')).toContain('acme-doctrine');
    expect(getProjectConfig(cfg, MASTER, 'broken-proj')).toMatchObject({
      projectType: 'ddd',
      profileSource: 'acme-doctrine',
      profileResolvable: true,
    });
    expect(auditMetadata('policy.reconcile', 'broken-proj')[0]).toMatchObject({ repairedProfileId: 'ddd' });
  });

  it('a pack adopted AFTER init no longer erases the recorded profileSelection (schema round-trip regression)', () => {
    seedGlobalPack('foo');
    const unit = seedUnit(dataDir, 'rt-unit');
    const rec = executeApprovedInit(cfg, {
      id: 'rt-proj',
      ownerUnitId: unit.id,
      profileSelection: selection({ profileIds: ['frontend-reactive'] }),
    });
    expect(readRawConfig(rec.rootPath).profileSelection.profileIds).toEqual(['frontend-reactive']);

    // adoptProjectPack writes project.yaml back through the ProjectConfig schema.
    // profileSelection used to be un-schema'd, so the round trip STRIPPED it.
    adoptProjectPack(cfg, MASTER, 'rt-proj', 'foo');

    const raw = readRawConfig(rec.rootPath);
    expect(raw.profileSelection.profileIds).toEqual(['frontend-reactive']);
    expect(raw.projectType).toBe('frontend-reactive'); // and the applied profile still governs
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

  it('reconcileProjectPolicy: an EXPLICIT reconcile applies required packs regardless of enforcementMode', () => {
    seedGlobalPack('foo');
    createPlacedProject(cfg, MASTER, 'warn-proj');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['foo'], enforcementMode: 'warn' }));

    // Option A: clicking Reconcile is an explicit, authorized action — it applies
    // the instance policy's own required/default packs even under 'warn'.
    const res = reconcileProjectPolicy(cfg, MASTER, 'warn-proj');
    expect(res.compliant).toBe(true);
    expect(res.missingPackNames).not.toContain('foo');
    expect(packNames('warn-proj')).toContain('foo');
  });

  it('reconcile resolves a required pack that lives ONLY in the immutable image tier', () => {
    // Regression: the policy applier used to read only the instance tier, so
    // image-baked packs (the common hosted case) never applied.
    const imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-policy-image-'));
    fs.writeFileSync(path.join(imageDir, 'imgpack.yaml'), 'name: imgpack\nprofiles: {}\nlanguages: {}\n');
    process.env.WAIRON_IMAGE_PACKS_DIR = imageDir;

    createPlacedProject(cfg, MASTER, 'img-proj');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['imgpack'] }));

    const after = reconcileProjectPolicy(cfg, MASTER, 'img-proj');
    expect(after.compliant).toBe(true);
    expect(after.unresolvedPacks).toEqual([]);
    expect(packNames('img-proj')).toContain('imgpack');
  });

  it('evaluate/reconcile REPORT a required pack the instance cannot resolve, instead of silently skipping it', () => {
    createPlacedProject(cfg, MASTER, 'gap-proj');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['nonexistent'] }));

    const ev = evaluateProjectPolicy(cfg, MASTER, 'gap-proj');
    expect(ev.compliant).toBe(false);
    expect(ev.unresolvedPacks).toContain('nonexistent');
    expect(ev.missingPackNames).not.toContain('nonexistent'); // unresolved, not merely missing
    expect(ev.messages.some((m) => m.includes('not available on the instance'))).toBe(true);

    // Reconcile can't remedy an instance-side gap — it stays reported, never a silent success.
    const rec = reconcileProjectPolicy(cfg, MASTER, 'gap-proj');
    expect(rec.compliant).toBe(false);
    expect(rec.unresolvedPacks).toContain('nonexistent');
    expect(packNames('gap-proj')).not.toContain('nonexistent');
  });

  it('matches a required name by file stem even when the manifest name differs, and converges (no re-install loop)', () => {
    // The file is appender.yaml but its manifest name is appender-make. The policy
    // requires "appender"; compliance must key on the canonical manifest name.
    fs.writeFileSync(path.join(packsDir, 'appender.yaml'), 'name: appender-make\nprofiles: {}\nlanguages: {}\n');
    createPlacedProject(cfg, MASTER, 'stem-proj');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['appender'] }));

    const first = reconcileProjectPolicy(cfg, MASTER, 'stem-proj');
    expect(first.compliant).toBe(true);
    expect(packNames('stem-proj')).toContain('appender-make'); // vendored under canonical name

    // A second reconcile is a no-op: it must not see it as missing and re-install forever.
    const second = reconcileProjectPolicy(cfg, MASTER, 'stem-proj');
    expect(second.compliant).toBe(true);
    expect(second.missingPackNames).toEqual([]);
    expect(packNames('stem-proj').filter((n) => n === 'appender-make')).toHaveLength(1);
  });

  it('reconcile applies a DIRECTORY-form global pack end-to-end (the .wpack shape the old isFile guard rejected)', () => {
    const dir = path.join(packsDir, 'dirpack');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), 'name: dirpack\nprofiles: {}\nlanguages: {}\n');
    createPlacedProject(cfg, MASTER, 'dir-proj');
    setPackPolicy(cfg, MASTER, samplePolicy({ requiredGlobalPacks: ['dirpack'] }));

    const after = reconcileProjectPolicy(cfg, MASTER, 'dir-proj');
    expect(after.compliant).toBe(true);
    expect(after.unresolvedPacks).toEqual([]);
    expect(packNames('dir-proj')).toContain('dirpack');
  });

  it('setPackPolicy rejects an unrecognized enforcementMode (no silently-disabled enforcement)', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setPackPolicy(cfg, MASTER, samplePolicy({ enforcementMode: 'auto-reconcile' as any })),
    ).toThrow(/enforcementMode/);
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
