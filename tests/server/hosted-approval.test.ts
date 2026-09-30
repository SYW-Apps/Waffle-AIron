import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeSpecFile } from '../../src/core/spec-files.js';
import { ComponentSpecSchema, ImplementationSpecSchema, InterfaceSpecSchema } from '../../src/models/index.js';
import * as admin from '../../src/server/admin.js';
import { executeApprovedLock, gateIdentity, LockValidationError } from '../../src/server/admin.js';
import { lockProject, decideRequest, executeApprovedRequest } from '../../src/server/projectlifecycle.js';
import * as hostCore from '../../src/server/adapters/core.js';
import { computeGateStateId, validateAsComplete } from '../../src/server/adapters/validator.js';
import { registerProjectRecord } from '../../src/server/projects.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { setAssignment } from '../../src/server/permissions.js';
import { getApprovalRequestById } from '../../src/server/approvals.js';
import { runWithProjectRoot, setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { readLockRecordAt, type LockRecord } from '../../src/core/lockfile.js';
import { buildApprovalFamily, type ApprovalFamily } from '../helpers/reference-family.js';
import type { ApproverIdentity } from '../../src/models/lock.js';
import type { ApiKeyRecord, Capability, HostConfig, PermissionValue, PrincipalSubject } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage 5 — approval across a family (wave B: hosted).
//
// The hosted lock (admin_orchestrator.executeApprovedLock, which lockProject
// and the approval workflow both reach) runs the same flow as `wairon lock`:
// capture the gate identity, validate as complete, gate on the design half,
// honour composition.requireApprovedMembers, re-confirm the identity, write a
// format-2 record. A lock request pins the identity it was made about, and the
// approved execution refuses a tree that moved since.
//
// Real temp directories throughout: a real instance data dir, the approval
// family registered as a hosted project, and every machine-global location
// (HOME, USERPROFILE, APPDATA) redirected into a temp home.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const APPROVER: ApproverIdentity = { id: 'u-approver', name: 'Approver', source: 'hosted' };
const STAMP = '2026-09-30T00:00:00.000Z';
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'WAIRON_ADMIN_TOKEN'] as const;

let fam: ApprovalFamily;
let home: string;
let dataDir: string;
let cfg: HostConfig;
let savedEnv: (readonly [string, string | undefined])[];

beforeEach(() => {
  savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hosted-approval-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = home;
  process.env.WAIRON_ADMIN_TOKEN = MASTER;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hosted-approval-data-'));
  cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  fam = buildApprovalFamily();
  // The approval family IS the hosted project "top"; its members bind through the mount.
  registerProjectRecord(dataDir, 'top', fam.top);
  invalidateSpecCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of [fam.top, dataDir, home]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
});

const lockFile = (dir: string): string => path.join(dir, '.wai', 'lock.json');
const pin = (record: LockRecord): string => `${record.stateId.algorithm}:${record.stateId.digest}`;

/** A spec edit at `dir`, then a cold cache — the next read sees the new tree. */
function touch(dir: string, note: string): void {
  fam.touch(dir, note);
  invalidateSpecCache();
}

/** sha256 over every file below a directory (relative path + bytes). */
function dirHash(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** Each member approved at its own root, bottom-up, through the hosted member-scoped lock. */
function lockMembers(): void {
  executeApprovedLock(cfg, 'top', APPROVER, 'mid::leaf');
  executeApprovedLock(cfg, 'top', APPROVER, 'mid');
  executeApprovedLock(cfg, 'top', APPROVER, 'sib');
  invalidateSpecCache();
}

/**
 * Give `sib` one component whose implementation names a source file that does
 * not exist: a CODE finding (MISSING_SOURCE_FILE, an error) with a design that
 * is otherwise sound.
 */
function addUnimplementedComponent(): void {
  const dir = path.join(fam.sib, '.wai', 'specs', 'aside', 'engine');
  writeSpecFile(path.join(dir, '.index.yaml'), ComponentSpecSchema.parse({
    id: 'engine', name: 'engine', description: 'The engine component', subsystem: 'aside',
    componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(path.join(dir, '.interface.yaml'), InterfaceSpecSchema.parse({
    id: 'iengine', name: 'iengine', description: 'The engine contract', component: 'engine',
    methods: [{ name: 'run', description: 'Run once', signature: 'run(): void', returns: 'void', params: [] }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  writeSpecFile(path.join(dir, '.implementation.yaml'), ImplementationSpecSchema.parse({
    id: 'engine_impl', name: 'engine_impl', description: 'The engine, not written yet', contract: 'iengine',
    sourcePath: 'src/engine.ts',
    methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the one thing', type: 'local' }] }],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
  invalidateSpecCache();
}

describe('hosted lock — format 2', () => {
  it('records format 2: members (subject + state), code beside the claim, the design half, the approver, never children', () => {
    executeApprovedLock(cfg, 'top', APPROVER, 'mid::leaf');
    const mid = executeApprovedLock(cfg, 'top', APPROVER, 'mid');
    invalidateSpecCache();

    const record = executeApprovedLock(cfg, 'top', APPROVER);

    expect(record.format).toBe(2);
    expect(record.children).toBeUndefined();
    expect(record.lockedBy).toEqual(APPROVER);
    expect(record.members).toEqual({
      mid: { project: 'mid', subject: pin(mid), state: 'approved' },
      sib: { project: 'sib', state: 'never' },
    });
    expect(record.code).toBeDefined();
    expect(record.code!.analyzer.doctrineDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.code!.codes).toBeUndefined();
    expect(record.validationResult).toMatchObject({ valid: true, errors: 0 });
    expect(record.stateId.algorithm).toBe('sha256+content+doctrine+inputs+members');
    // What was written is what was returned, and it carries no `children`.
    expect(readLockRecordAt(fam.top)).toMatchObject({ format: 2, stateId: record.stateId });
    expect(fs.readFileSync(lockFile(fam.top), 'utf8')).not.toContain('"children"');
    // The record certifies the tree as it stands: the hosted lock state reads locked.
    expect(runWithProjectRoot(fam.top, () => hostCore.readLockState(computeGateStateId())).state).toBe('locked');
  });

  it('a member-scoped lock records the member at its own root and writes nothing at the parent', () => {
    const leaf = executeApprovedLock(cfg, 'top', APPROVER, 'mid::leaf');
    expect(leaf.format).toBe(2);
    expect(readLockRecordAt(fam.leaf)).toMatchObject({ stateId: leaf.stateId });
    expect(fs.existsSync(lockFile(fam.mid))).toBe(false);
    expect(fs.existsSync(lockFile(fam.top))).toBe(false);
  });
});

describe('hosted lock — code findings are recorded beside the claim and never refuse', () => {
  it('a design with no code yet locks; the code errors are counted under `code`, not in validationResult', () => {
    addUnimplementedComponent();
    // The as-complete run does report the code finding, as an error …
    const run = runWithProjectRoot(fam.sib, () => validateAsComplete());
    expect(run.issues.filter((i) => i.code === 'MISSING_SOURCE_FILE' && i.severity === 'error')).not.toHaveLength(0);

    const record = executeApprovedLock(cfg, 'top', APPROVER, 'sib');

    expect(record.code!.errors).toBeGreaterThanOrEqual(1);
    expect(record.validationResult).toMatchObject({ valid: true, errors: 0 });
    expect(readLockRecordAt(fam.sib)).toMatchObject({ stateId: record.stateId });
  });

  it('the lockProject outcome states the code findings beside the claim', () => {
    addUnimplementedComponent();
    const outcome = lockProject(cfg, MASTER, 'top', 'sib');
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toMatch(/code: [1-9]\d* errors recorded beside the claim/);
    expect(outcome.lock!.code!.errors).toBeGreaterThanOrEqual(1);
  });

  it('a DESIGN error still refuses, and writes nothing', () => {
    // A component whose contract references a type nobody declares: a design error.
    addUnimplementedComponent();
    const iface = path.join(fam.sib, '.wai', 'specs', 'aside', 'engine', '.interface.yaml');
    fs.writeFileSync(iface, fs.readFileSync(iface, 'utf8').replace("returns: void", 'returns: NoSuchType'));
    invalidateSpecCache();
    expect(() => executeApprovedLock(cfg, 'top', APPROVER, 'sib')).toThrow(LockValidationError);
    expect(fs.existsSync(lockFile(fam.sib))).toBe(false);
  });
});

describe('hosted lock — composition.requireApprovedMembers', () => {
  it('refuses, naming each direct member not approved and its state, and writes nothing', () => {
    fam.setComposition(['requireApprovedMembers: true']);
    executeApprovedLock(cfg, 'top', APPROVER, 'mid::leaf');
    executeApprovedLock(cfg, 'top', APPROVER, 'mid');
    touch(fam.mid, 'edited after its lock');

    expect(() => executeApprovedLock(cfg, 'top', APPROVER))
      .toThrow(/requireApprovedMembers.*mid \(drifted\).*sib \(never\)/);
    expect(fs.existsSync(lockFile(fam.top))).toBe(false);

    executeApprovedLock(cfg, 'top', APPROVER, 'mid');
    executeApprovedLock(cfg, 'top', APPROVER, 'sib');
    invalidateSpecCache();
    const record = executeApprovedLock(cfg, 'top', APPROVER);
    expect(record.members).toMatchObject({ mid: { state: 'approved' }, sib: { state: 'approved' } });
  });

  it('without the flag the hosted lock proceeds and records each member\'s state', () => {
    const record = executeApprovedLock(cfg, 'top', APPROVER);
    expect(record.members).toEqual({ mid: { project: 'mid', state: 'never' }, sib: { project: 'sib', state: 'never' } });
  });
});

describe('hosted lock — inputs captured before validation, confirmed before writing', () => {
  it('a spec written between the capture and the write refuses the lock and writes nothing', () => {
    // The injection point is the last collaborator before the confirmation:
    // the real capture still runs, after a real spec write lands on disk.
    const original = hostCore.captureApprovedSpecs;
    vi.spyOn(hostCore, 'captureApprovedSpecs').mockImplementation((...args: Parameters<typeof original>) => {
      touch(fam.top, 'written while the lock ran');
      return original(...args);
    });

    expect(() => executeApprovedLock(cfg, 'top', APPROVER)).toThrow(/inputs changed while it ran/);
    expect(fs.existsSync(lockFile(fam.top))).toBe(false);
  });

  it('a member re-approving between the capture and the write refuses too', () => {
    const original = hostCore.captureApprovedSpecs;
    let once = false;
    vi.spyOn(hostCore, 'captureApprovedSpecs').mockImplementation((...args: Parameters<typeof original>) => {
      if (!once) {
        once = true;
        // A member lock is its own hosted lock at its own root.
        const bound = original(...args);
        executeApprovedLock(cfg, 'top', APPROVER, 'sib');
        invalidateSpecCache();
        return bound;
      }
      return original(...args);
    });

    expect(() => executeApprovedLock(cfg, 'top', APPROVER)).toThrow(/inputs changed while it ran/);
    expect(fs.existsSync(lockFile(fam.top))).toBe(false);
    expect(fs.existsSync(lockFile(fam.sib))).toBe(true);
  });
});

describe('hosted property: parent-lock-writes-nothing-below', () => {
  it('a parent lock leaves every byte below it as it was', () => {
    lockMembers();
    const before = { mid: dirHash(fam.mid), sib: dirHash(fam.sib) };

    const record = executeApprovedLock(cfg, 'top', APPROVER);

    expect(record.members).toMatchObject({ mid: { state: 'approved' }, sib: { state: 'approved' } });
    expect(fs.existsSync(lockFile(fam.top))).toBe(true);
    expect({ mid: dirHash(fam.mid), sib: dirHash(fam.sib) }).toEqual(before);
  });
});

describe('lockProject routes through executeApprovedLock', () => {
  it('the admin plane\'s lockProject writes the same format-2 record, with the authenticated approver', () => {
    const record = admin.lockProject(cfg, MASTER, 'top');
    expect(record.format).toBe(2);
    expect(record.members).toBeDefined();
    expect(record.lockedBy).toMatchObject({ source: 'hosted' });
    expect(readLockRecordAt(fam.top)).toMatchObject({ stateId: record.stateId });
  });

  it('the lifecycle lockProject (yes) completes with a format-2 record and states the code line', () => {
    const outcome = lockProject(cfg, MASTER, 'top');
    expect(outcome.status).toBe('completed');
    expect(outcome.lock!.format).toBe(2);
    expect(outcome.lock!.members).toBeDefined();
    expect(outcome.summary).toMatch(/Locked project "top" \(status: ready\)\. code: \d+ errors recorded beside the claim/);
  });
});

describe('hosted approval requests pin the gate identity at request time', () => {
  function subject(userId: string): PrincipalSubject {
    return { userId, kind: 'human', issuer: 'local' };
  }

  function mintToken(id: string, userId: string): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: `${id}-${crypto.randomBytes(3).toString('hex')}`, keyHash: hashToken(token), projects: ['*'], createdAt: new Date().toISOString(), ownerSubject: subject(userId),
    };
    createCredential(dataDir, record);
    return token;
  }

  function allow(userId: string, capability: Capability, value: PermissionValue): void {
    setAssignment(dataDir, {
      id: '', subjectKind: 'user', subjectId: userId, scopeKind: 'project', scopeId: 'top', capability, value, createdAt: '',
    });
  }

  /** A pending project:lock request from a requester who needs approval, and a decider who may decide. */
  function requestLock(subproject?: string): { id: string; gateStateId?: string; decider: string } {
    const requester = mintToken('rq', 'u-requester');
    allow('u-requester', 'project:write', 'approval');
    const outcome = lockProject(cfg, requester, 'top', subproject);
    expect(outcome.status).toBe('pending-approval');
    const decider = mintToken('dc', 'u-decider');
    allow('u-decider', 'approval:decide', 'yes');
    return { id: outcome.approval!.id, gateStateId: outcome.approval!.gateStateId, decider };
  }

  const approve = (decider: string, requestId: string) => decideRequest(cfg, decider, {
    requestId, approved: true, decidedBy: subject('ignored'), decidedAt: '',
  });

  it('the request records the identity of the tree it was made about', () => {
    const { id, gateStateId } = requestLock();
    expect(gateStateId).toBe(gateIdentity(cfg, 'top'));
    expect(getApprovalRequestById(dataDir, id)!.gateStateId).toBe(gateStateId);
    // A member-scoped request pins the member's identity, not the project's.
    const member = requestLock('sib');
    expect(member.gateStateId).toBe(gateIdentity(cfg, 'top', 'sib'));
    expect(member.gateStateId).not.toBe(gateStateId);
  });

  it('unchanged: approving executes the lock, and the record certifies exactly the requested identity', () => {
    const { id, gateStateId, decider } = requestLock();
    const decided = approve(decider, id);
    expect(decided.status).toBe('completed');
    expect(pin(readLockRecordAt(fam.top)!)).toBe(gateStateId);
  });

  it('moved: the approved execution refuses, says why, writes nothing, and the retry path refuses too', () => {
    const { id, decider } = requestLock();
    touch(fam.top, 'edited after the request');

    expect(() => approve(decider, id)).toThrow(/design changed since the lock was requested.*requester asks again/);
    expect(fs.existsSync(lockFile(fam.top))).toBe(false);
    // The decision stands; the execution did not happen, so it is approved, not completed.
    expect(getApprovalRequestById(dataDir, id)!.status).toBe('approved');

    const requester = mintToken('rq2', 'u-requester');
    expect(() => executeApprovedRequest(cfg, requester, id)).toThrow(/design changed since the lock was requested/);
    expect(fs.existsSync(lockFile(fam.top))).toBe(false);
  });

  it('a member moving after the request moves the parent\'s identity too, and refuses', () => {
    const { id, decider } = requestLock();
    executeApprovedLock(cfg, 'top', APPROVER, 'sib');
    invalidateSpecCache();
    expect(() => approve(decider, id)).toThrow(/design changed since the lock was requested/);
    expect(fs.existsSync(lockFile(fam.top))).toBe(false);
  });
});
