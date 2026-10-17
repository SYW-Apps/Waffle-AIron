import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import { readLockRecord, readLockRecordAt, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId, familyApprovals, validateAsComplete } from '../../src/core/validation.js';
import { approvalVerdict } from '../../src/core/approval.js';
import { checkApproval, runLock, type LockOptions } from '../../src/commands/lock.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import {
  approvalSubject, designOnly, gatePartsProblem, releaseStampAgainst, staleReleaseSentence,
} from '../../src/models/lock.js';
import { WAIRON_VERSION } from '../../src/config/defaults.js';
import { buildApprovalFamily, type ApprovalFamily } from '../helpers/reference-family.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round 7 (approval and lock). Decided behaviour:
//  1. a record WITHOUT gateParts never carries over automatically — it cannot
//     prove the project's own inputs unchanged — and is stale with one
//     sentence; `lock` then takes a real approval, never a restamp;
//  2. a member's RESTAMP is no re-approval: its parent pins the approval's
//     subject, so the family stays approved; a no-op lock leaves the record
//     (lockedAt, restamp trace) as it is;
//  3. a stamp that is no version, or newer than this wairon, is no upgrade;
//     gate parts must break down the stateId they sit beside, else they are
//     ignored with a notice.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const now = '2026-10-08T10:00:00.000Z';
let root = '';
let fam: ApprovalFamily | null = null;

/** A one-subsystem tree whose worker is reached (it validates clean at the --ci standard). */
function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-release-r7-'));
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
      invokedBy: { kind: 'runtime', caller: 'The process scheduler of the host, once every minute after boot' },
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

/** The record on file rewritten as an older release took it: its release part, digest and stamp differ. */
function takenByOlderRelease(dir: string, edit: (r: LockRecord) => LockRecord = (r) => r): LockRecord {
  const record = readLockRecordAt(dir)!;
  const older = edit({
    ...record,
    stateId: { algorithm: record.stateId.algorithm, digest: `${path.basename(dir).length.toString(16)}${'e'.repeat(63)}`.slice(0, 64) },
    gateParts: { ...record.gateParts!, release: 'older-release-doctrine' },
    validatorVersion: '5.1.1-dev.100',
  });
  setProjectRoot(dir);
  writeLockRecord(older);
  invalidateSpecCache();
  return older;
}

/** Tune a rule in project.yaml (an input the PROJECT decides). */
function tuneRule(dir: string): void {
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...config, rules: { ...config.rules, sddRuleSeverity: { UNOWNED_STORE: 'error' } } }));
  invalidateSpecCache();
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** Lock at a root exactly as `wairon lock` does: capture, validate as complete, gate on the design half. */
async function lockAt(dir: string, options: LockOptions = { yes: true }): Promise<LockRecord | null> {
  bind(dir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const captured = computeGateStateId();
  const config = projectConfigRepositoryAt(dir).load();
  const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
  expect(designOnly(gate).issues.filter((i) => i.severity === 'error')).toEqual([]);
  return runLock(options, gate, captured);
}

afterEach(() => {
  vi.restoreAllMocks();
  promptMock.mockReset();
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows locks */ }
  try { fam?.cleanup(); } catch { /* windows locks */ }
  root = '';
  fam = null;
});

describe('1 — a record without gate parts never carries over (round 7, pre-gate-parts loophole)', () => {
  it('a rule-tuning change made with the upgrade is stale with the one sentence, never "every input is as approved"', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const record = readLockRecord()!;
    const { gateParts: _parts, ...legacy } = record;
    writeLockRecord({ ...legacy, stateId: { ...record.stateId, digest: 'd'.repeat(64) }, validatorVersion: '5.1.1-dev.109' });
    tuneRule(root);

    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('drifted');
    expect(own.release).toMatchObject({ carried: false, from: '5.1.1-dev.109' });
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('Approved under wairon 5.1.1-dev.109 before wairon recorded its inputs separately — re-lock once to record them; later upgrades then carry over.');
    expect(check.message).not.toContain('every input the project decides');
    expect(approvalVerdict(familyApprovals()).text).toContain('before wairon recorded its inputs separately');
  });

  it('`lock` then takes a REAL approval (it asks), never a restamp, and records the gate parts', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const record = readLockRecord()!;
    const { gateParts: _parts, ...legacy } = record;
    writeLockRecord({ ...legacy, stateId: { ...record.stateId, digest: 'd'.repeat(64) }, validatorVersion: '5.1.1-dev.109', lockedAt: '2026-01-01T00:00:00.000Z' });
    invalidateSpecCache();
    const isTTY = process.stdin.isTTY;
    promptMock.mockResolvedValueOnce({ confirmed: true });
    try {
      (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
      const written = (await runLock({}, { valid: true, issues: [] }, computeGateStateId()))!;
      expect(promptMock).toHaveBeenCalledTimes(1);
      expect(written.restamped).toBeUndefined();
      expect(written.lockedAt).not.toBe('2026-01-01T00:00:00.000Z');
      expect(written.gateParts).toBeDefined();
    } finally {
      (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = isTTY;
    }
  });

  it('records WITH gate parts keep the carry-over', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    takenByOlderRelease(root);
    expect(checkApproval(true).approved).toBe(true);
  });
});

describe('2 — a restamp is not a re-approval (round 7, the family carry-over)', () => {
  it('a member\'s restamp keeps its parent approved: the parent pins the approval\'s subject', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.mid);
    const midOlder = takenByOlderRelease(fam.mid);
    await lockAt(fam.top);
    takenByOlderRelease(fam.top);
    bind(fam.top);
    expect(familyApprovals(0).find((a) => a.key === '')!.state).toBe('approved');

    // The member's restamp: a new stateId, the approval's subject kept.
    const restamped = (await lockAt(fam.mid, {}))!;
    expect(restamped.restamped?.subject).toBe(approvalSubject(midOlder));
    expect(restamped.stateId.digest).not.toBe(midOlder.stateId.digest);
    expect(approvalSubject(restamped)).toBe(approvalSubject(midOlder));

    // The root: still approved, its members part unmoved, no "re-approved" verdict.
    bind(fam.top);
    const top = familyApprovals(1);
    expect(top.find((a) => a.key === '')!.state).toBe('approved');
    expect(top.find((a) => a.alias === 'mid')!.pinned).toBe('matches');
    const check = checkApproval(false);
    expect(check.approved).toBe(true);
    expect(check.message).not.toContain('re-approved at their own roots');
  });

  it('the first no-op lock after a restamp keeps lockedAt and the restamp trace', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const older = takenByOlderRelease(root);
    const restamped = (await runLock({}, { valid: true, issues: [] }, computeGateStateId()))!;
    expect(restamped.restamped).toBeDefined();
    invalidateSpecCache();
    const again = (await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId()))!;
    expect(again.lockedAt).toBe(older.lockedAt);
    expect(again.restamped).toEqual(restamped.restamped);
    expect(readLockRecord()!.restamped).toEqual(restamped.restamped);
    // And with nothing beside the approval moved either, the file is untouched.
    const bytes = fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8');
    invalidateSpecCache();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    expect(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8')).toBe(bytes);
  });
});

describe('3 — release-stamp sanity (round 7)', () => {
  it('reads a stamp against the running release', () => {
    expect(releaseStampAgainst({ validatorVersion: '9.9.9' }, '5.1.1-dev.111')).toBe('newer');
    expect(releaseStampAgainst({ validatorVersion: 'banana' }, '5.1.1-dev.111')).toBe('invalid');
    expect(releaseStampAgainst({}, '5.1.1-dev.111')).toBe('invalid');
    expect(releaseStampAgainst({ validatorVersion: '5.1.1-dev.100' }, '5.1.1-dev.111')).toBe('older');
    expect(releaseStampAgainst({ validatorVersion: '5.1.1-dev.111' }, '5.1.1-dev.111')).toBe('same');
  });

  for (const [stamp, words] of [['9.9.9', 'written by a newer wairon (9.9.9)'], ['banana', 'is no wairon version']] as const) {
    it(`a ${stamp} stamp is no upgrade: stale, saying ${words}`, async () => {
      root = project();
      await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
      takenByOlderRelease(root, (r) => ({ ...r, validatorVersion: stamp }));
      const own = familyApprovals().find((a) => a.key === '')!;
      expect(own.state).toBe('drifted');
      expect(own.release?.carried).toBe(false);
      const check = checkApproval(false);
      expect(check.approved).toBe(false);
      expect(check.message).toContain(words);
      expect(check.message).not.toContain('re-validated under');
    });
  }

  it('a dev.110 record hand-bumped to this release names what moved: the stamp was edited, an earlier wairon took it', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    const record = readLockRecord()!;
    const { gateParts: _parts, ...legacy } = record;
    writeLockRecord({ ...legacy, stateId: { ...record.stateId, digest: 'c'.repeat(64) }, validatorVersion: WAIRON_VERSION });
    invalidateSpecCache();
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('carries no gate parts');
    expect(check.message).toContain('the stamp was edited');
    expect(check.message).not.toContain('the doctrine, the network declaration, a consumed contract');
  });

  it('gate parts that do not break down a matching stateId are ignored with a notice, and `lock` rewrites them keeping lockedAt', async () => {
    root = project();
    const first = (await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId()))!;
    writeLockRecord({ ...first, gateParts: { ...first.gateParts!, rules: 'tampered' } });
    invalidateSpecCache();
    expect(gatePartsProblem(readLockRecord()!, computeGateStateId())).toContain('rules');
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('approved');
    expect(own.partsIgnored).toContain('rules');
    const check = checkApproval(false);
    expect(check.approved).toBe(true);
    expect(check.message).toContain('gate parts are ignored');
    const repaired = (await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId()))!;
    expect(repaired.lockedAt).toBe(first.lockedAt);
    expect(repaired.gateParts).toEqual(computeGateStateId().parts);
  });

  it('tampered parts never carry an approval over: a release-only claim from parts that break nothing down is stale', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    // The identity moved but the parts claim nothing did: inconsistent.
    const record = readLockRecord()!;
    writeLockRecord({ ...record, stateId: { ...record.stateId, digest: 'b'.repeat(64) }, validatorVersion: '5.1.1-dev.100' });
    invalidateSpecCache();
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('drifted');
    expect(own.release?.reason).toContain('do not break down its identity');
  });

  it('release_verdict.staleSentence is the reason when there is one, else the findings', () => {
    expect(staleReleaseSentence({ from: 'a', to: 'b', carried: false, reason: 'Because.' })).toBe('Because.');
    expect(staleReleaseSentence({ from: 'a', to: 'b', carried: false, count: 2, findings: ['X [s] m'] }))
      .toBe('It was approved under wairon a, and the new release (b) finds 2 issue(s) in the approved design: X [s] m; ….');
  });
});
