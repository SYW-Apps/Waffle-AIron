import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, invalidateSpecCache, loadTypeSpec,
} from '../../src/core/specs.js';
import { readLockRecordAt, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId, familyApprovals, validateAsComplete } from '../../src/core/validation.js';
import { checkApproval, runLock, type LockOptions } from '../../src/commands/lock.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { designOnly } from '../../src/models/lock.js';
import { WAIRON_VERSION } from '../../src/config/defaults.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round 10 (approval and lock). Decided behaviour:
//  1. the release-stamp refresh judges members exactly as the ordinary path
//     does: a SIBLING member edited and not re-locked at its own root since
//     the record leaves its subject — and so the gate identity — as recorded,
//     so the release verdict alone cannot see it; the restamp then never
//     happens, and the member is reported and recorded drifted, never approved;
//  2. a restamp refreshes the code evidence recorded beside the approval;
//  3. `lock --subsystem <id>` counts the subsystem's own types inside it.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const now = '2026-10-09T10:00:00.000Z';
let base = '';

/** A one-subsystem tree whose worker is reached (it validates clean at the --ci standard). */
function tree(dir: string, id: string, extraConfig: Record<string, unknown> = {}): string {
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id, name: id, projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now, ...extraConfig,
  }));
  setProjectRoot(dir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: id, vision: 'release fixture', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: `${id}_dom`, name: 'dom', description: 'the domain', parentSystem: id,
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: `${id}_worker`, name: 'Worker', description: 'a worker', subsystem: `${id}_dom`, componentType: 'Orchestrator',
    owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: `i${id}_worker`, name: 'IWorker', description: 'the worker contract', component: `${id}_worker`,
    methods: [{
      name: 'run', description: 'Runs the work once.', signature: 'run(): void', returns: 'void', params: [],
      invokedBy: { kind: 'runtime', caller: 'The process scheduler of the host, once every minute after boot' },
    }],
    status: 'complete', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  saveSpec('implementation', {
    id: `${id}_worker_impl`, name: 'Worker Implementation', description: 'realizes the worker', contract: `i${id}_worker`,
    methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] }],
    status: 'complete', createdAt: now, updatedAt: now,
  } as unknown as ImplementationSpec);
  invalidateSpecCache();
  return dir;
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** Lock at a root exactly as `wairon lock` does: capture, validate as complete, gate on the design half. */
async function lockAt(dir: string, options: LockOptions = { yes: true }): Promise<LockRecord | null> {
  bind(dir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const captured = computeGateStateId();
  const config = projectConfigRepositoryAt(dir).load();
  const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
  expect(designOnly(gate).issues.filter((i) => i.severity === 'error')).toEqual([]);
  return runLock(options, gate, captured);
}

/** The record on file rewritten as an older release took it: its release part, digest, stamp and code evidence differ. */
function takenByOlderRelease(dir: string): LockRecord {
  const record = readLockRecordAt(dir)!;
  const older: LockRecord = {
    ...record,
    stateId: { algorithm: record.stateId.algorithm, digest: `${path.basename(dir).length.toString(16)}${'e'.repeat(63)}`.slice(0, 64) },
    gateParts: { ...record.gateParts!, release: 'older-release-doctrine' },
    validatorVersion: '5.1.1-dev.100',
    ...(record.code ? { code: { ...record.code, warnings: record.code.warnings + 4, analyzer: { ...record.code.analyzer, validatorVersion: '5.1.1-dev.100' } } } : {}),
  };
  setProjectRoot(dir);
  writeLockRecord(older);
  invalidateSpecCache();
  return older;
}

/** A sibling family: `app` declares `geo: ../geo`, both approved under an older release. */
function siblingFamily(): { app: string; geo: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10-sib-'));
  const geo = tree(path.join(base, 'geo'), 'geo');
  const app = tree(path.join(base, 'app'), 'app', { members: { geo: '../geo' } });
  return { app, geo };
}

afterEach(() => {
  vi.restoreAllMocks();
  promptMock.mockReset();
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (base) fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows locks */ }
  base = '';
});

describe('1 — the release-stamp refresh judges a dirty sibling member (round 10, R10-7)', () => {
  it('a member edited since its own approval is reported drifted and never recorded approved', async () => {
    const { app, geo } = siblingFamily();
    await lockAt(geo);
    takenByOlderRelease(geo);
    await lockAt(app);
    takenByOlderRelease(app);
    // The root's own design is unchanged and its approval carries the release over.
    bind(app);
    expect(familyApprovals(1).find((a) => a.key === '')!.release?.carried).toBe(true);
    // The member edited at its own root, never re-locked there.
    bind(geo);
    saveComponentSpec({
      id: 'geo_worker', name: 'Worker', description: 'a worker that now does more', subsystem: 'geo_dom', componentType: 'Orchestrator',
      owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
    } as ComponentSpec);
    invalidateSpecCache();
    bind(app);
    expect(familyApprovals(1).find((a) => a.alias === 'geo')!.state).toBe('drifted');

    const warned: string[] = [];
    const written = (await (async () => {
      bind(app);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warned.push(args.join(' ')); });
      const captured = computeGateStateId();
      const gate = validateAsComplete({});
      return runLock({ yes: true }, gate, captured);
    })())!;

    // No restamp: the ordinary path judged the member, warned bottom-up, and recorded it drifted.
    expect(written.restamped).toBeUndefined();
    expect(written.members?.geo?.state).toBe('drifted');
    expect(warned.join('\n')).toContain('The order is bottom-up');
    // lock-check --strict agrees with the record.
    bind(app);
    expect(checkApproval(true).approved).toBe(false);
  });

  it('a clean sibling member keeps the restamp — its pin as recorded', async () => {
    const { app, geo } = siblingFamily();
    await lockAt(geo);
    takenByOlderRelease(geo);
    await lockAt(app);
    takenByOlderRelease(app);
    const written = (await lockAt(app))!;
    expect(written.restamped).toBeDefined();
    expect(written.members?.geo?.state).toBe('approved');
  });
});

describe('2 — a restamp refreshes the code evidence beside the approval (round 10, solo-app)', () => {
  it('lock.json#code reads the running analyzer right after the restamp, not after the next no-op lock', async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10-code-'));
    const root = tree(path.join(base, 'p'), 'p');
    await lockAt(root);
    const older = takenByOlderRelease(root);
    const written = (await lockAt(root))!;
    expect(written.restamped).toBeDefined();
    expect(written.lockedAt).toBe(older.lockedAt);
    expect(written.code?.analyzer.validatorVersion).toBe(WAIRON_VERSION);
    expect(written.code?.warnings).not.toBe(older.code?.warnings);
    expect(readLockRecordAt(root)!.code?.analyzer.validatorVersion).toBe(WAIRON_VERSION);
  });
});

describe('3 — `lock --subsystem` counts the subsystem\'s own types inside it (round 10, solo-app)', () => {
  it('an edit of a type owned by the subsystem is in scope; a system-level type is not', async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10-scope-'));
    const root = tree(path.join(base, 'p'), 'p');
    saveSpec('type', {
      kind: 'value-object', id: 'profile', name: 'Profile', description: 'a profile', subsystem: 'p_dom',
      fields: [{ name: 'name', type: 'string', description: 'its name', optional: false }],
      createdAt: now, updatedAt: now,
    } as unknown as TypeSpec);
    saveSpec('type', {
      kind: 'value-object', id: 'shared', name: 'Shared', description: 'shared by all',
      fields: [{ name: 'code', type: 'string', description: 'its code', optional: false }],
      createdAt: now, updatedAt: now,
    } as unknown as TypeSpec);
    invalidateSpecCache();
    await lockAt(root);
    const owned = loadTypeSpec('profile')!;
    saveSpec('type', { ...owned, description: 'a profile, described anew' } as TypeSpec);
    invalidateSpecCache();
    const scoped = (await lockAt(root, { yes: true, subsystem: 'p_dom' }))!;
    expect(scoped).not.toBeNull();

    const shared = loadTypeSpec('shared')!;
    saveSpec('type', { ...shared, description: 'shared by all, described anew' } as TypeSpec);
    invalidateSpecCache();
    await expect(lockAt(root, { yes: true, subsystem: 'p_dom' })).rejects.toThrow(/outside it moved/);
  });
});
