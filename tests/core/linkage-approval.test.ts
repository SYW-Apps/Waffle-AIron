import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  invalidateSpecCache,
  readLockState,
} from '../../src/core/specs.js';
import { computeOwnDesignStateId, computeOwnStateId, stateIdEquals } from '../../src/core/statehash.js';
import { approvalVerdict, currentSpecDigests, diffAgainstApproval, reexpress } from '../../src/core/approval.js';
import { readLockRecord, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { GATE_ALGORITHM } from '../../src/core/rules/gate-identity.js';

/** The gate algorithm every format-2 lock was taken under (full content, code linkage in). */
const CONTENT_GATE_ALGORITHM = 'sha256+content+doctrine+inputs+members';
import { checkApproval, reexpressLock, runLock } from '../../src/commands/lock.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Code linkage leaves the approval (docs/design/linkage-and-drift.md, waves 1
// and 2). The lock approves the DESIGN: pointing a spec at the file that
// realizes it — a sourcePath, a symbol, a simPath — must never reopen it,
// while any change to what the design says must. A lock taken before this
// (format 2) stays valid while nothing it covered moved, and `doctor --fix`
// carries it into the design reading without a review.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const now = '2026-10-06T10:00:00.000Z';
const later = '2026-10-06T11:00:00.000Z';

function impl(over: Partial<ImplementationSpec> = {}): ImplementationSpec {
  return {
    id: 'worker_impl', name: 'Worker Implementation', description: 'realizes the worker', contract: 'iworker',
    methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] }],
    status: 'draft', createdAt: now, updatedAt: now, ...over,
  } as ImplementationSpec;
}

/** A small tree with one implementation — enough for every identity and the lock workflow. */
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-linkage-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'linkage-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'linkage-sys', vision: 'linkage fixture', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'linkage-sys',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker', subsystem: 'dom', componentType: 'Orchestrator',
    owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iworker', name: 'IWorker', description: 'the worker contract', component: 'worker',
    methods: [{ name: 'run', description: 'Runs the work once.', signature: 'run(): void', returns: 'void', params: [] }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as InterfaceSpec);
  saveSpec('implementation', impl());
  invalidateSpecCache();
  setProjectRoot(root);
  return root;
}

/** Re-save the implementation with some fields changed, as an author (or a tool) would. */
function resave(root: string, over: Partial<ImplementationSpec>): void {
  setProjectRoot(root);
  saveSpec('implementation', impl({ updatedAt: later, ...over }));
  invalidateSpecCache();
  setProjectRoot(root);
}

const LINKAGE: Partial<ImplementationSpec> = {
  sourcePath: 'src/worker.ts',
  simPath: 'tests/sim/worker.sim.ts',
  injectedParams: ['config'],
  conformance: 'anchored',
  methods: [{ name: 'run', sourcePath: 'src/run.ts', symbol: 'runWorker', exportedVia: 'workerRule', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] }],
} as Partial<ImplementationSpec>;

/** Write a FORMAT-2 record over the tree as it stands: the full-content gate algorithm, content-reading digests. */
function writeFormat2(root: string): LockRecord {
  setProjectRoot(root);
  // A placeholder under the previous algorithm, so the gate carries asRecorded.
  writeLockRecord({ stateId: { algorithm: CONTENT_GATE_ALGORITHM, digest: '0'.repeat(64) }, lockedAt: now, lockedBy: { id: 'x', source: 'git' }, validatorVersion: 't', validationResult: { valid: true, errors: 0, warnings: 0 }, status: 'ready' });
  const gate = computeGateStateId();
  expect(gate.asRecorded?.algorithm).toBe(CONTENT_GATE_ALGORITHM);
  const record: LockRecord = {
    format: 2,
    stateId: { algorithm: gate.asRecorded!.algorithm, digest: gate.asRecorded!.digest },
    lockedAt: now,
    lockedBy: { id: 'approver <a@example.com>', source: 'git' },
    validatorVersion: '5.1.0',
    validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 },
    status: 'ready',
    specs: currentSpecDigests(root, 'content'),
    members: {},
  };
  writeLockRecord(record);
  return record;
}

let root: string;
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
});

describe('state_hash.ownDesign — the design identity', () => {
  it('code linkage and timestamps never move it, while they do move the full-content identity', () => {
    root = project();
    const design = computeOwnDesignStateId();
    const content = computeOwnStateId();
    expect(design.algorithm).toBe('sha256-design');
    resave(root, LINKAGE);
    expect(stateIdEquals(computeOwnDesignStateId(), design)).toBe(true);
    expect(stateIdEquals(computeOwnStateId(), content)).toBe(false);
  });

  it('any change to what the design says moves it', () => {
    root = project();
    const design = computeOwnDesignStateId();
    resave(root, { description: 'realizes the worker, differently' });
    expect(stateIdEquals(computeOwnDesignStateId(), design)).toBe(false);
  });

  it('is deterministic, and never equal to a content identity', () => {
    root = project();
    expect(computeOwnDesignStateId()).toEqual(computeOwnDesignStateId());
    expect(stateIdEquals(computeOwnDesignStateId(), computeOwnStateId())).toBe(false);
  });
});

describe('the gate identity hashes the design identity', () => {
  it('uses the design gate algorithm, and a linkage-only edit leaves it where it was', () => {
    root = project();
    const gate = computeGateStateId();
    expect(gate.algorithm).toBe(GATE_ALGORITHM);
    expect(gate.algorithm).toBe('sha256+design+doctrine+inputs+members');
    expect(gate.asRecorded).toBeUndefined();
    resave(root, LINKAGE);
    expect(stateIdEquals(computeGateStateId(), gate)).toBe(true);
  });

  it('carries asRecorded only while the record on disk is a format-2 one', () => {
    root = project();
    writeFormat2(root);
    expect(computeGateStateId().asRecorded).toBeDefined();
  });
});

describe('lock format 3: a linkage-only edit no longer stales the lock, a design edit does', () => {
  it('writes format 3 in the design reading, and adding sourcePaths keeps it locked with no spec changed', async () => {
    root = project();
    const record = (await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId()))!;
    expect(record.format).toBe(3);
    expect(record.specsReading).toBe('design');
    expect(record.stateId.algorithm).toBe(GATE_ALGORITHM);
    expect(record.reexpressed).toBeUndefined();
    expect(Object.keys(record.stateId)).toEqual(['algorithm', 'digest']);

    resave(root, LINKAGE);
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    expect(diffAgainstApproval()!.changed).toEqual([]);
    expect(approvalVerdict().text).toContain('no spec has changed since');
    expect(checkApproval(true).approved).toBe(true);
  });

  it('a design edit stales it and names the spec', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    resave(root, { description: 'a different design' });
    expect(readLockState(computeGateStateId()).state).toBe('stale');
    expect(diffAgainstApproval()!.changed).toHaveLength(1);
    expect(diffAgainstApproval()!.changed[0]).toContain('.implementation');
    expect(checkApproval(false).approved).toBe(false);
  });

  it('a change-and-revert (only the timestamp moved) is no drift', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    resave(root, { description: 'briefly different' });
    resave(root, { updatedAt: '2026-10-06T12:00:00.000Z' });
    expect(diffAgainstApproval()!.changed).toEqual([]);
    expect(readLockState(computeGateStateId()).state).toBe('locked');
  });
});

describe('a format-2 lock after the upgrade', () => {
  it('an unchanged design passes lock-check without a re-lock, with the doctor hint', () => {
    root = project();
    writeFormat2(root);
    // Old code compared the record against the design gate only: stale.
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    const check = checkApproval(true);
    expect(check.approved, check.message).toBe(true);
    expect(check.message).toContain('wairon doctor --fix');
    expect(approvalVerdict().text).toContain('no spec has changed since');
  });

  it('doctor --fix re-expresses it: format 3, design reading, `reexpressed`, the approver unchanged', () => {
    root = project();
    const before = writeFormat2(root);
    const carried = reexpressLock()!;
    expect(carried).not.toBeNull();
    const written = readLockRecord()!;
    expect(written).toEqual(carried);
    expect(written.format).toBe(3);
    expect(written.specsReading).toBe('design');
    expect(written.stateId.algorithm).toBe(GATE_ALGORITHM);
    expect(written.lockedBy).toEqual(before.lockedBy);
    expect(written.lockedAt).toBe(before.lockedAt);
    expect(written.validatorVersion).toBe(before.validatorVersion);
    expect(written.reexpressed).toMatchObject({ fromAlgorithm: CONTENT_GATE_ALGORITHM, fromReading: 'content', by: 'wairon doctor --fix' });
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    // Idempotent: nothing more to carry.
    expect(reexpressLock()).toBeNull();
    // From now on linkage never drifts it.
    resave(root, LINKAGE);
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    expect(diffAgainstApproval()!.changed).toEqual([]);
  });

  it('a format-2 lock that already drifted (even by linkage alone) reads stale once and says one re-lock clears it', () => {
    root = project();
    writeFormat2(root);
    resave(root, LINKAGE);
    expect(readLockState(computeGateStateId()).state).toBe('stale');
    expect(reexpress(computeGateStateId())).toBeNull();
    expect(reexpressLock()).toBeNull();
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('format-2 lock');
    expect(check.message).toContain('one `wairon lock` clears it for good');
  });
});
