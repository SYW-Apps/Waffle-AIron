import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import { readLockRecord, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId, familyApprovals } from '../../src/core/validation.js';
import { approvalVerdict } from '../../src/core/approval.js';
import { checkApproval, runLock } from '../../src/commands/lock.js';
import { approvalStamp, movedGateParts } from '../../src/models/lock.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round 6 (M3, every persona): every wairon upgrade staled every approval, and
// the message blamed five inputs nobody had touched. Decided behaviour: when
// the approved design and every input the project decides are unchanged and
// only the release's built-in doctrine moved, the approved design is
// re-validated under the current rules in the same command — clean at the
// --ci standard it CARRIES OVER (nothing written), otherwise it is stale for
// exactly the findings the new release reports. The project's own inputs
// (rule tuning, packs, network, pins) stay in the identity, and a moved one is
// named, not guessed.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const now = '2026-10-08T10:00:00.000Z';
let root = '';

/** A one-subsystem tree; `reached` decides whether the worker's verb is reached (clean) or not (UNUSED_COMPONENT). */
function project(reached: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-release-'));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'release-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(dir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'release-sys', vision: 'release fixture', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'release-sys',
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker', subsystem: 'dom', componentType: 'Orchestrator',
    owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iworker', name: 'IWorker', description: 'the worker contract', component: 'worker',
    methods: [{
      name: 'run', description: 'Runs the work once.', signature: 'run(): void', returns: 'void', params: [],
      ...(reached ? { invokedBy: { kind: 'runtime', caller: 'The process scheduler of the host, once every minute after boot' } } : {}),
    }],
    status: 'complete', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  saveSpec('implementation', {
    id: 'worker_impl', name: 'Worker Implementation', description: 'realizes the worker', contract: 'iworker',
    methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] }],
    status: 'complete', createdAt: now, updatedAt: now,
  } as unknown as ImplementationSpec);
  invalidateSpecCache();
  return dir;
}

/** The record on file as an older release would have written it: only its release part (and so its digest) differs. */
function takenByOlderRelease(): LockRecord {
  const record = readLockRecord()!;
  const older: LockRecord = {
    ...record,
    stateId: { algorithm: record.stateId.algorithm, digest: 'e'.repeat(64) },
    gateParts: { ...record.gateParts!, release: 'older-release-doctrine' },
    validatorVersion: '5.1.1-dev.100',
  };
  writeLockRecord(older);
  invalidateSpecCache();
  return older;
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows locks */ }
});

describe('a lock records each input of its gate identity (gateParts)', () => {
  it('records the parts beside the identity, and names exactly the one that moved', async () => {
    root = project(true);
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const record = readLockRecord()!;
    expect(Object.keys(record.gateParts ?? {}).sort()).toEqual(['composition', 'contracts', 'design', 'members', 'packs', 'release', 'rules']);
    expect(movedGateParts(record, computeGateStateId().parts)).toEqual([]);
    // Declaring a network moves exactly that input, and every verdict names it.
    const config = JSON.parse(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8'));
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({ ...config, network: { description: 'the service mesh' } }));
    invalidateSpecCache();
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('the network declaration');
    expect(check.message).not.toContain('the doctrine, the network declaration, a consumed contract');
    expect(approvalVerdict(familyApprovals()).text).toContain('the network declaration');
  });
});

describe('a release change is judged by re-validation (round 6)', () => {
  it('carries the approval over when the approved design re-validates clean — nothing written, every surface says so', async () => {
    root = project(true);
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    takenByOlderRelease();
    const before = fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8');
    const check = checkApproval(true);
    expect(check.approved).toBe(true);
    expect(check.message).toContain('Approved under wairon 5.1.1-dev.100, re-validated under');
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('approved');
    expect(own.release).toMatchObject({ from: '5.1.1-dev.100', carried: true });
    expect(approvalVerdict(familyApprovals()).text).toContain('re-validated under');
    // Nothing written by the read.
    expect(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8')).toBe(before);
  });

  it('`wairon lock` refreshes the record\'s release stamp without a re-approval', async () => {
    root = project(true);
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const older = takenByOlderRelease();
    promptMock.mockReset();
    const restamped = await runLock({}, { valid: true, issues: [] }, computeGateStateId());
    expect(promptMock).not.toHaveBeenCalled();
    expect(restamped!.lockedAt).toBe(older.lockedAt);
    expect(restamped!.restamped).toMatchObject({ fromVersion: '5.1.1-dev.100', by: 'wairon lock' });
    invalidateSpecCache();
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('approved');
    expect(own.release).toBeUndefined();
  });

  it('is stale for exactly the findings the new release reports, never the generic candidate sentence', async () => {
    root = project(false); // the worker's verb is never reached: UNUSED_COMPONENT
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    takenByOlderRelease();
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('the new release');
    expect(check.message).toContain('UNUSED_COMPONENT');
    expect(check.message).not.toContain('an input the gate identity covers');
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('drifted');
    expect(own.release).toMatchObject({ carried: false, count: 1 });
  });

  it('a change of the project\'s own inputs together with the release is never carried', async () => {
    root = project(true);
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const record = takenByOlderRelease();
    writeLockRecord({ ...record, gateParts: { ...record.gateParts!, rules: 'other-rule-tuning' } });
    invalidateSpecCache();
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('drifted');
    expect(own.release).toBeUndefined();
    expect(own.inputsMoved).toEqual(['release', 'rules']);
  });

  it('a record from before gate parts is never carried (round 7): it cannot prove its own inputs unchanged', async () => {
    root = project(true);
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const record = readLockRecord()!;
    const { gateParts: _parts, ...legacy } = record;
    writeLockRecord({ ...legacy, stateId: { ...record.stateId, digest: 'd'.repeat(64) }, validatorVersion: '5.1.1-dev.109' });
    invalidateSpecCache();
    const check = checkApproval(true);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('Approved under wairon 5.1.1-dev.109 before wairon recorded its inputs separately — re-lock once to record them; later upgrades then carry over.');
  });
});

describe('lock_record.approvalStamp (round 6)', () => {
  it('never prints "undefined by unknown"', () => {
    expect(approvalStamp({ lockedAt: undefined, lockedBy: { id: 'unknown', source: 'legacy' } })).toBe('at an unrecorded time by an unrecorded approver');
    expect(approvalStamp({ lockedAt: '2026-10-08', lockedBy: { id: 'robbe', source: 'git' } })).toBe('2026-10-08 by robbe');
  });
});
