import { describe, it, expect, vi, afterEach } from 'vitest';
import * as crypto from 'crypto';
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
import { computeOwnDesignStateIdAsRecorded } from '../../src/core/statehash.js';
import { currentSpecDigests, diffAgainstApproval, reexpress } from '../../src/core/approval.js';
import { readLockRecord, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { GATE_ALGORITHM } from '../../src/core/rules/gate-identity.js';
import { checkApproval, reexpressLock, runLock } from '../../src/commands/lock.js';
import { canonicalize } from '../../src/utils/canonical-json.js';
import { parseYaml } from '../../src/utils/yaml.js';
import {
  componentDesignView, implementationDesignView, interfaceDesignView, subsystemDesignView,
  type ComponentSpec, type ImplementationSpec, type InterfaceSpec, type SubsystemSpec,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Readiness leaves the approval: a spec's `status` (draft/design/complete)
// says how far authoring is, never what the design says, so promoting a spec
// must not reopen the human approval. A format-3 lock taken while the design
// view still carried status keeps passing when nothing but a status moved.
// And an older (format-2) lock over a tree no file of which moved is carried
// into the design reading by doctor --fix, with the stale cause stated as the
// gate that moved — never the design.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const now = '2026-10-06T10:00:00.000Z';
const later = '2026-10-06T11:00:00.000Z';
const EARLIER_DESIGN_GATE = 'sha256+design+doctrine+inputs+members';
const CONTENT_GATE = 'sha256+content+doctrine+inputs+members';

function impl(over: Partial<ImplementationSpec> = {}): ImplementationSpec {
  return {
    id: 'worker_impl', name: 'Worker Implementation', description: 'realizes the worker', contract: 'iworker',
    methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] }],
    status: 'draft', createdAt: now, updatedAt: now, ...over,
  } as ImplementationSpec;
}

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-readiness-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'readiness-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'readiness-sys', vision: 'readiness fixture', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'readiness-sys',
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

function resave(root: string, over: Partial<ImplementationSpec>): void {
  setProjectRoot(root);
  saveSpec('implementation', impl({ updatedAt: later, ...over }));
  invalidateSpecCache();
  setProjectRoot(root);
}

/** One spec file's digest the way the EARLIER design reading took it: its design view with its status kept. */
function earlierDigest(file: string): string {
  const parsed = parseYaml(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const view = 'contract' in parsed ? implementationDesignView(parsed)
    : 'componentType' in parsed ? componentDesignView(parsed)
      : 'parentSystem' in parsed ? subsystemDesignView(parsed)
        : 'component' in parsed ? interfaceDesignView(parsed)
          : parsed;
  const kept = parsed.status === undefined ? view : { ...view, status: parsed.status };
  return crypto.createHash('sha256').update(canonicalize(kept), 'utf8').digest('hex');
}

/** A format-3 record exactly as a release whose design view still carried status wrote it. */
function writeEarlierFormat3(root: string): LockRecord {
  setProjectRoot(root);
  // A placeholder under the earlier algorithm, so the gate carries asRecorded.
  writeLockRecord({ format: 3, specsReading: 'design', stateId: { algorithm: EARLIER_DESIGN_GATE, digest: '0'.repeat(64) }, lockedAt: now, lockedBy: { id: 'x', source: 'git' }, validatorVersion: 't', validationResult: { valid: true, errors: 0, warnings: 0 }, status: 'ready', specs: {} });
  const gate = computeGateStateId();
  expect(gate.asRecorded?.algorithm).toBe(EARLIER_DESIGN_GATE);
  const specs: Record<string, string> = {};
  for (const key of Object.keys(currentSpecDigests(root, 'design'))) specs[key] = earlierDigest(path.join(root, key));
  const record: LockRecord = {
    format: 3,
    specsReading: 'design',
    stateId: { algorithm: gate.asRecorded!.algorithm, digest: gate.asRecorded!.digest },
    lockedAt: now,
    lockedBy: { id: 'approver <a@example.com>', source: 'git' },
    validatorVersion: '5.1.1-dev.106',
    validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 },
    status: 'ready',
    specs,
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

describe('status is readiness, never design', () => {
  it('promoting a status under a current lock keeps it locked and moves no spec', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    expect(readLockRecord()!.stateId.algorithm).toBe(GATE_ALGORITHM);
    resave(root, { status: 'complete' });
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    expect(diffAgainstApproval()!.changed).toEqual([]);
  });

  it('a format-3 lock taken while status was in the view keeps passing when only a status moved', () => {
    root = project();
    writeEarlierFormat3(root);
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    resave(root, { status: 'complete' });
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    expect(diffAgainstApproval()!.changed).toEqual([]);
    expect(checkApproval(true).approved).toBe(true);
    // ...and a design edit still stales it, naming the spec.
    resave(root, { status: 'complete', description: 'realizes the worker differently' });
    expect(readLockState(computeGateStateId()).state).toBe('stale');
    expect(diffAgainstApproval()!.changed).toEqual(['.wai/specs/dom/worker/.implementation.yaml']);
  });

  it('the earlier reading recomputes with the approved statuses put back', () => {
    root = project();
    writeEarlierFormat3(root);
    const asRecorded = computeOwnDesignStateIdAsRecorded(new Map());
    expect(asRecorded.algorithm).toBe('sha256-design');
  });

  it('doctor --fix carries an earlier-reading lock into the current reading without a review', () => {
    root = project();
    const before = writeEarlierFormat3(root);
    resave(root, { status: 'complete' });
    const carried = reexpressLock()!;
    expect(carried).not.toBeNull();
    expect(carried.stateId.algorithm).toBe(GATE_ALGORITHM);
    expect(carried.lockedBy).toEqual(before.lockedBy);
    expect(carried.reexpressed).toMatchObject({ fromAlgorithm: EARLIER_DESIGN_GATE, fromReading: 'design' });
    expect(readLockState(computeGateStateId()).state).toBe('locked');
  });
});

describe('an older lock over an untouched tree whose gate moved', () => {
  /** A format-2 record whose per-spec digests match the tree, but whose identity was taken under another gate. */
  function writeFormat2UnderOtherGate(): LockRecord {
    const record: LockRecord = {
      format: 2,
      stateId: { algorithm: CONTENT_GATE, digest: 'f'.repeat(64) },
      lockedAt: now,
      lockedBy: { id: 'approver <a@example.com>', source: 'git' },
      validatorVersion: '5.1.1-dev.102',
      validationResult: { valid: true, errors: 0, warnings: 0, notices: 0 },
      status: 'ready',
      specs: currentSpecDigests(root, 'content'),
      members: {},
    };
    writeLockRecord(record);
    return record;
  }

  it('lock-check names why a record from before gate parts is not carried over, never the design or code linkage (round 7)', () => {
    root = project();
    writeFormat2UnderOtherGate();
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    // The record cannot prove the project's own inputs unchanged: stale with
    // one sentence, never re-validated and never "every input is as approved".
    expect(check.message).toContain('Approved under wairon 5.1.1-dev.102 before wairon recorded its inputs separately');
    expect(check.message).not.toContain('every input the project decides');
    expect(check.message).not.toContain('the design, or only code linkage');
  });

  it('doctor --fix re-expresses its reading to format 3 and keeps the claim as certified', () => {
    root = project();
    const before = writeFormat2UnderOtherGate();
    expect(reexpress(computeGateStateId())).not.toBeNull();
    const carried = reexpressLock()!;
    expect(carried.format).toBe(3);
    expect(carried.specsReading).toBe('design');
    expect(carried.stateId).toEqual(before.stateId);
    expect(readLockRecord()!.format).toBe(3);
    // Still stale — for the gate — and one lock clears it.
    expect(readLockState(computeGateStateId()).state).toBe('stale');
    expect(checkApproval(false).message).toContain('before wairon recorded its inputs separately');
    // Idempotent.
    expect(reexpressLock()).toBeNull();
  });
});
