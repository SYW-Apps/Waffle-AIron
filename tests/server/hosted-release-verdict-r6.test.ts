import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getProjectConfig } from '../../src/server/policy.js';
import { createPlacedProject } from './helpers.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import {
  saveSpec, saveComponentSpec, saveInterfaceSpec, loadSystemSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import { readLockRecord, writeLockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { checkApproval, runLock } from '../../src/commands/lock.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Round 6: when only the wairon release moved since a project was locked, the
// approved design is re-validated (family_validator.releaseVerdict) and, clean
// at the --ci standard, the approval carries over. The hosted configuration
// view read the bare lock record and called that same project stale, so the
// web UI prompted for a re-lock the local lock-check said was not owed. Both
// now read the one shared verdict.
// ---------------------------------------------------------------------------

vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

const MASTER = 'master-credential-secret-value';
const now = '2026-10-08T10:00:00.000Z';

/** One subsystem; `reached` decides whether the worker's verb is reached (clean) or not (UNUSED_COMPONENT). */
function seedDesign(reached: boolean): void {
  const system = loadSystemSpec()!.name;
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: system,
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
}

/** Lock the design, then rewrite the record as an older release would have taken it: only its release part differs. */
async function lockUnderOlderRelease(): Promise<void> {
  await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
  const record = readLockRecord()!;
  writeLockRecord({
    ...record,
    stateId: { algorithm: record.stateId.algorithm, digest: 'e'.repeat(64) },
    gateParts: { ...record.gateParts!, release: 'older-release-doctrine' },
    validatorVersion: '5.1.1-dev.100',
  });
  invalidateSpecCache();
}

describe('the hosted configuration view reads the shared release verdict (round 6)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hosted-release-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    invalidateSpecCache();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  async function placed(reached: boolean): Promise<{ root: string; local: () => ReturnType<typeof checkApproval> }> {
    createPlacedProject(cfg, MASTER, 'rel-proj');
    const root = existingProjectRoot(dataDir, 'rel-proj')!;
    await runWithProjectRoot(root, async () => {
      invalidateSpecCache();
      seedDesign(reached);
      await lockUnderOlderRelease();
    });
    return { root, local: () => runWithProjectRoot(root, () => { invalidateSpecCache(); return checkApproval(false); }) };
  }

  it('a release change the approved design re-validates clean under is locked, not stale — as lock-check says', async () => {
    const { local } = await placed(true);
    expect(local().approved).toBe(true);
    invalidateSpecCache();
    const view = getProjectConfig(cfg, MASTER, 'rel-proj');
    expect(view.locked).toBe(true);
    expect(view.lockStale).toBeUndefined();
  });

  it('control: a release change that finds issues in the approved design is stale on both surfaces', async () => {
    const { local } = await placed(false); // the worker's verb is never reached: UNUSED_COMPONENT
    expect(local().approved).toBe(false);
    invalidateSpecCache();
    const view = getProjectConfig(cfg, MASTER, 'rel-proj');
    expect(view.locked).toBe(false);
    expect(view.lockStale).toBe(true);
  });
});
