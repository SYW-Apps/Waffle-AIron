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
import { diffAgainstApproval } from '../../src/core/approval.js';
import { readLockRecord, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeApprovalId } from '../../src/core/validation.js';
import { APPROVAL_ALGORITHM } from '../../src/core/rules/approval-identity.js';
import { runLock } from '../../src/commands/lock.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

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

let root: string;
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
});

describe('status is readiness, never design', () => {
  it('promoting a status under a current lock keeps it locked and moves no spec', async () => {
    root = project();
    await runLock({ yes: true }, { valid: true, issues: [] }, computeApprovalId());
    expect(readLockRecord()!.stateId.algorithm).toBe(APPROVAL_ALGORITHM);
    resave(root, { status: 'complete' });
    expect(readLockState(computeApprovalId()).state).toBe('locked');
    expect(diffAgainstApproval()!.changed).toEqual([]);
  });
});
