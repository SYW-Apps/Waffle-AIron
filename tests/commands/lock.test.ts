import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  loadComponentSpec,
  collectPromotableSpecs,
  invalidateSpecCache,
  readLockState,
} from '../../src/core/specs.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import { runLock } from '../../src/commands/lock.js';
import { readBaseline } from '../../src/core/baseline.js';
import type { ValidationResult } from '../../src/core/validation.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon lock` — two seams:
//
//   1. The cli_lock_adapter (runLock in src/commands/lock.ts, realizing
//      lockTree): freeze every in-scope spec through the core barrel and
//      persist the commit-scoped lock record; a declined confirmation changes
//      nothing.
//   2. The cli_runner workflow (runLock in src/cli/index.ts), driven through
//      the REAL CLI: the as-complete gate refuses an invalid tree, and a
//      successful lock regenerates the family/sibling surfaces into every
//      chained child — and only then.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'lockable-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'component under test', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: InterfaceSpec['methods']): InterfaceSpec => ({
  id, name: id, description: 'interface under test', component: comp, methods,
  status: 'draft', createdAt: now, updatedAt: now,
});

/**
 * A draft project whose tree validates as complete: one published HTTP portal
 * whose single method carries a wire endpoint. `withEndpoint: false` drops the
 * endpoint — a warning while draft, the exact hard error `wairon lock` must
 * refuse on once treated as complete.
 */
function buildLockableProject(rootDir: string, withEndpoint = true): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'lockable-system',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: now,
    updatedAt: now,
  }));
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'lockable-system',
    vision: 'a lockable fixture system',
    boundaries: [],
    globalRequirements: [],
    publicInterfaces: [
      { id: 'gateway', name: 'Gateway API', subsystem: 'core-sub', component: 'gateway-portal', type: 'REST', details: 'api', audience: 'external' },
    ],
    createdAt: now,
    updatedAt: now,
  });
  saveSubsystemSpec(subsystem('core-sub', {
    publicInterfaces: [{ type: 'REST', details: 'api', component: 'gateway-portal' }],
  }));
  saveComponentSpec(component('gateway-portal', 'core-sub', {
    componentType: 'Portal', portalType: 'HTTP_API',
  } as Partial<ComponentSpec>));
  saveInterfaceSpec(iface('igateway-portal', 'gateway-portal', [
    {
      name: 'ping',
      description: 'Pings the gateway for liveness.',
      signature: 'ping(): void',
      returns: 'void',
      params: [],
      ...(withEndpoint ? { endpoint: { transport: 'HTTP', method: 'GET', path: '/ping' } } : {}),
    },
  ]));
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

process.env['WAIRON_BASELINE_DIR'] = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lockstore-'));

describe('cli_lock_adapter (lockTree): freeze + commit-scoped record', () => {
  let rootDir: string;

  afterEach(() => {
    vi.clearAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('promotes every promotable spec and writes the lock record at the frozen StateId', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-adapter-'));
    buildLockableProject(rootDir);
    expect(collectPromotableSpecs().length).toBeGreaterThan(0);

    const gate: ValidationResult = {
      valid: true,
      issues: [{ severity: 'warning', code: 'SOME_WARNING', message: 'w' }],
    };
    const record = await runLock({ yes: true }, gate);

    expect(record).not.toBeNull();
    expect(record!.status).toBe('ready');
    // The GATE flavour, not the content one: a lock certifies that these specs
    // passed THIS gate, so the governing doctrine is part of the frozen identity
    // and a later pack change invalidates the lock by state mismatch.
    expect(record!.stateId.algorithm).toBe('sha256+doctrine');
    expect(record!.stateId.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record!.lockedBy).toMatch(/^local/);
    expect(record!.validationResult).toEqual({ valid: true, errors: 0, warnings: 1 });

    // Approving writes NOTHING into the spec tree — the status ratchet that
    // used to rewrite every file is gone, and the approval lives in the
    // baseline instead.
    invalidateSpecCache();
    expect(loadComponentSpec('gateway-portal')?.status).toBe('draft');
    const baseline = readBaseline(rootDir);
    expect(baseline).not.toBeNull();
    expect(Object.keys(baseline!.specs).some((p) => p.includes('gateway-portal'))).toBe(true);

    // ...and the record persisted to .wai/lock.json.
    const onDisk = JSON.parse(fs.readFileSync(path.join(rootDir, '.wai', 'lock.json'), 'utf8'));
    expect(onDisk.stateId).toEqual(record!.stateId);
    expect(onDisk.status).toBe('ready');
  });

  it('--subsystem approves only its own scope, never the whole tree', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-adapter-'));
    buildLockableProject(rootDir);
    saveSubsystemSpec(subsystem('aux-sub'));
    saveComponentSpec(component('aux-orchestrator', 'aux-sub'));
    invalidateSpecCache();
    setProjectRoot(rootDir);

    const record = await runLock({ yes: true, subsystem: 'core-sub' });
    expect(record).not.toBeNull();

    // The approval covers core-sub's specs and nothing outside it: a scoped
    // approval must never silently mark the rest of the tree reviewed.
    const approved = Object.keys(readBaseline(rootDir)!.specs);
    expect(approved.some((p) => p.includes('gateway-portal'))).toBe(true);
    expect(approved.some((p) => p.includes('aux-orchestrator'))).toBe(false);
    expect(approved.some((p) => p.includes('aux-sub'))).toBe(false);

    // And no spec file was rewritten either way.
    invalidateSpecCache();
    expect(loadComponentSpec('gateway-portal')?.status).toBe('draft');
    expect(loadComponentSpec('aux-orchestrator')?.status).toBe('draft');
  });

  it('a declined confirmation returns null and changes nothing', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-adapter-'));
    buildLockableProject(rootDir);
    const promotableBefore = collectPromotableSpecs().length;

    const isTTY = process.stdin.isTTY;
    promptMock.mockResolvedValueOnce({ confirmed: false });
    try {
      (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
      const record = await runLock({});
      expect(record).toBeNull();
    } finally {
      (process.stdin as unknown as { isTTY: boolean | undefined }).isTTY = isTTY;
    }

    expect(promptMock).toHaveBeenCalledTimes(1);
    invalidateSpecCache();
    expect(collectPromotableSpecs()).toHaveLength(promotableBefore);
    expect(fs.existsSync(path.join(rootDir, '.wai', 'lock.json'))).toBe(false);
    // Declining records no approval.
    expect(readBaseline(rootDir)).toBeNull();
  });
});

describe('cli_runner.runLock workflow (real CLI): gate, freeze, child surfaces', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const runCli = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'lock', '--yes', ...args], { cwd, timeout: 180_000 });

  it('a locked parent ships fresh surfaces: chained children get regenerated snapshots', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-e2e-'));
    buildLockableProject(rootDir);
    createChainedSubsystem(subsystem('kid', { projectPath: 'packages/kid' }), 'kid');
    invalidateSpecCache();
    setProjectRoot(null);

    const { stdout } = await runCli(rootDir, '--no-recursive');

    expect(stdout).toContain('Updated');
    expect(stdout).toContain('delivered surface(s)');
    const surfacesDir = path.join(rootDir, 'packages', 'kid', '.wai', 'surfaces');
    expect(fs.existsSync(surfacesDir)).toBe(true);
    const delivered = fs.readdirSync(surfacesDir);
    expect(delivered.length).toBeGreaterThan(0);
    const record = JSON.parse(fs.readFileSync(path.join(rootDir, '.wai', 'lock.json'), 'utf8'));
    expect(record.status).toBe('ready');

    // A second lock over an unchanged tree must not rewrite a single delivered
    // surface: the projection stamps fresh provenance every run, and writing
    // that unconditionally is what buried real spec edits under a flood of
    // modified files in git.
    const before = delivered.map((f) => {
      const p = path.join(surfacesDir, f);
      return { f, bytes: fs.readFileSync(p, 'utf8'), mtime: fs.statSync(p).mtimeMs };
    });

    const second = await runCli(rootDir, '--no-recursive');
    expect(second.stdout).not.toContain('delivered surface(s)');

    for (const { f, bytes, mtime } of before) {
      const p = path.join(surfacesDir, f);
      expect(fs.readFileSync(p, 'utf8')).toBe(bytes);
      expect(fs.statSync(p).mtimeMs).toBe(mtime);
    }
  }, 180_000);

  it('does NOT regenerate child surfaces when the tree mounts no chained children', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-e2e-'));
    buildLockableProject(rootDir);
    setProjectRoot(null);

    const { stdout } = await runCli(rootDir);

    expect(stdout).not.toContain('Regenerated the family/sibling surfaces');
    expect(fs.existsSync(path.join(rootDir, '.wai', 'lock.json'))).toBe(true);
    expect(stdout).toContain('Lock record written');
  }, 180_000);

  it('refuses to lock a tree that does not validate as complete, changing nothing', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-e2e-'));
    buildLockableProject(rootDir, /* withEndpoint */ false);
    setProjectRoot(null);

    const err = await runCli(rootDir).then(
      () => { throw new Error('expected `wairon lock` to exit non-zero'); },
      (e: Error & { code?: number; stdout?: string; stderr?: string }) => e,
    );
    expect(err.code).toBe(1);
    // The blocking findings print on stderr (logger.error), the header on stdout.
    expect(String(err.stderr)).toContain('MISSING_ENDPOINT');
    expect(String(err.stdout)).toContain('Cannot lock');
    expect(fs.existsSync(path.join(rootDir, '.wai', 'lock.json'))).toBe(false);

    // Statuses untouched: everything is still promotable.
    setProjectRoot(rootDir);
    invalidateSpecCache();
    expect(collectPromotableSpecs().length).toBeGreaterThan(0);
    expect(loadComponentSpec('gateway-portal')?.status).toBe('draft');
  }, 180_000);
});

// ---------------------------------------------------------------------------
// readLockState — the ONE authority for "is this project locked?".
//
// Staleness used to be compared in exactly one place (the hosted promote gate)
// while the project config view answered from the mere EXISTENCE of a record. So a
// project whose specs changed after locking still reported itself locked, claiming
// a freeze that did not hold — the same time-of-check gap the lock exists to close,
// reintroduced in the reporting surface. Every caller now shares this verdict.
// ---------------------------------------------------------------------------

describe('readLockState (the shared lock verdict)', () => {
  let rootDir: string;

  afterEach(() => {
    vi.clearAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  function project(): void {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lockstate-'));
    buildLockableProject(rootDir);
  }

  it('unlocked when no record exists', () => {
    project();
    expect(readLockState().state).toBe('unlocked');
  });

  it('locked immediately after a lock, against the CURRENT gate identity', async () => {
    project();
    await runLock({ yes: true }, { valid: true, issues: [] });

    const { state, record, current } = readLockState();
    expect(state).toBe('locked');
    // The verdict is decided against the gate flavour, and they agree.
    expect(current.algorithm).toBe('sha256+doctrine');
    expect(record!.stateId.digest).toBe(current.digest);
  });

  it('STALE once the spec tree changes after locking — the case that used to report "locked"', async () => {
    project();
    await runLock({ yes: true }, { valid: true, issues: [] });
    expect(readLockState().state).toBe('locked');

    // Any edit moves the tree past what was frozen.
    saveComponentSpec(component('gateway-portal', 'core-sub', {
      componentType: 'Portal', portalType: 'HTTP_API', description: 'edited after the freeze',
      status: 'complete',
    } as Partial<ComponentSpec>));
    invalidateSpecCache();
    setProjectRoot(rootDir);

    const after = readLockState();
    expect(after.state).toBe('stale');
    // The record survives: staleness is a verdict ABOUT it, not its deletion, so a
    // caller can prompt for a re-lock rather than pretend it never happened.
    expect(after.record).not.toBeNull();
    expect(after.record!.stateId.digest).not.toBe(after.current.digest);
  });

  it('re-locking after the edit restores the freeze', async () => {
    project();
    await runLock({ yes: true }, { valid: true, issues: [] });
    saveComponentSpec(component('gateway-portal', 'core-sub', {
      componentType: 'Portal', portalType: 'HTTP_API', description: 'edited after the freeze',
      status: 'complete',
    } as Partial<ComponentSpec>));
    invalidateSpecCache();
    setProjectRoot(rootDir);
    expect(readLockState().state).toBe('stale');

    await runLock({ yes: true }, { valid: true, issues: [] });
    expect(readLockState().state).toBe('locked');
  });
});
