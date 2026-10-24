import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  loadComponentSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import type { ComponentSpec, SubsystemSpec } from '../../src/models/index.js';
import { runLock } from '../../src/commands/lock.js';
import * as subsystemAdapter from '../../src/commands/adapters/core.js';
import * as validateAdapter from '../../src/commands/validate.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { serializeHolder } from '../../src/utils/lock-holder.js';

// ---------------------------------------------------------------------------
// `wairon doctor` (cli_runner_impl.runDoctor) — the report phase's Project
// check, Major check and Lock section route through the CLI core
// adapter (cli_core_adapter: projectConfigExists, readLockState)
// and the upgrade adapter (cli_upgrade_adapter: standing) and the CLI validator adapter (cli_validator_adapter:
// validateProject, computeGateStateId), not a direct core import.
//
// The report phase is exercised in-process (mocking the two adapter modules
// as spies that still forward to the real implementation, so routing can be
// observed). --fix is exercised through the real CLI: applyFixes reaches the
// MCP adapter via a lazy require() that vitest cannot resolve in-process
// (the same reason src/commands/init.ts's context sync is mocked out of
// tests/commands/init-adapters.test.ts), so a real Node process is required.
// ---------------------------------------------------------------------------

vi.mock('../../src/commands/adapters/core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/adapters/core.js')>();
  return {
    ...actual,
    projectConfigExists: vi.fn(actual.projectConfigExists),
    readLockState: vi.fn(actual.readLockState),
  };
});

vi.mock('../../src/commands/validate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/validate.js')>();
  return {
    ...actual,
    computeGateStateId: vi.fn(actual.computeGateStateId),
    validateProject: vi.fn(actual.validateProject),
    validateFamily: vi.fn(actual.validateFamily),
  };
});

import { runDoctor } from '../../src/commands/doctor.js';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

const sub = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'doctor-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
});
const comp = (id: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: `${id} component`, subsystem: 'calc', componentType,
  owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const orchestrator = (id: string, dependsOn: string[]): ComponentSpec => comp(id, 'Orchestrator', { dependsOn });

/** Every file under a directory, by relative path, with its content. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * A minimal draft project: one Store and two Orchestrators — 'leaf' (no
 * dependencies) and 'stamp' (depends on the Store) — stamped with the running
 * major unless `stamped` is false (a tree a v5 wairon wrote carries no stamp).
 */
function buildProject(rootDir: string, stamped = true): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(rootDir, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', ...(stamped ? { waironMajor: WAIRON_MAJOR } : {}), name: 'doctor-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'doctor-sys', vision: 'a doctor fixture system',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', sub('calc'));
  saveComponentSpec(comp('ledger', 'Store', { durability: 'durable' }));
  saveComponentSpec(orchestrator('leaf', []));
  saveComponentSpec(orchestrator('stamp', ['ledger']));
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

describe('cli_runner_impl.runDoctor — report phase (in-process, through the CLI adapters)', () => {
  const originalCwd = process.cwd();
  let rootDir: string;
  let packsDir: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // runDoctor exits non-zero on any error it reports: stub process.exit out
    // rather than let it tear down the test worker, and assert on it where it matters.
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    packsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-packs-'));
    process.env.WAIRON_PACKS_DIR = packsDir;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setProjectRoot(null);
    invalidateSpecCache();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.WAIRON_PACKS_DIR;
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    try { fs.rmSync(packsDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const printed = (spy: ReturnType<typeof vi.spyOn>): string =>
    spy.mock.calls.map((c) => String(c[0])).join('\n');

  it('dry run: reports the Major check ok, no retired-form section, writes no file', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-report-'));
    buildProject(rootDir);
    process.chdir(rootDir);
    const before = snapshot(path.join(rootDir, '.wai'));

    const logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    const out = printed(logSpy);

    expect(out).toMatch(/Major: written by wairon \d+, the running major/);
    // The v5 repairs and their report sections moved to `wairon upgrade`.
    expect(out).not.toContain('Stereotypes');
    expect(out).not.toContain('Reachability');
    expect(out).not.toContain('Chaining');
    expect(out).not.toContain('legacy spec filename');

    // A dry run changes nothing on disk.
    invalidateSpecCache();
    expect(snapshot(path.join(rootDir, '.wai'))).toEqual(before);

    // Routed through the CLI core and validator adapters, not a direct core import.
    expect(vi.mocked(subsystemAdapter.projectConfigExists)).toHaveBeenCalled();
    expect(vi.mocked(validateAdapter.validateFamily)).toHaveBeenCalled();
  });

  it('the Major check names `wairon upgrade` as an error for a tree no stamp marks, and exits non-zero', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-older-'));
    buildProject(rootDir, false);
    process.chdir(rootDir);

    const logSpy = vi.spyOn(console, 'log');
    const exitSpy = vi.spyOn(process, 'exit');
    await runDoctor({});
    const out = printed(logSpy);
    expect(out).toMatch(/Major: written by wairon \d+ \(unstamped\), the running major is \d+ — run `wairon upgrade`/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('the Project check reports "not a wairon project" through the CLI core adapter, for a folder with no configuration', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-uninit-'));
    fs.mkdirSync(rootDir, { recursive: true });
    process.chdir(rootDir);
    setProjectRoot(rootDir);

    const logSpy = vi.spyOn(console, 'log');
    const exitSpy = vi.spyOn(process, 'exit');
    await runDoctor({});
    expect(printed(logSpy)).toContain('Not a wairon project');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(vi.mocked(subsystemAdapter.projectConfigExists)).toHaveBeenCalled();
  });

  it('Lock section: silent unlocked, "approved at" once locked, "stale" once the spec tree drifts — against the validator adapter\'s gate identity', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-lock-'));
    buildProject(rootDir);
    process.chdir(rootDir);

    let logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    expect(printed(logSpy)).not.toContain('Lock');
    logSpy.mockRestore();

    await runLock({ yes: true }, { valid: true, issues: [] }, computeGateStateId());
    invalidateSpecCache();
    setProjectRoot(rootDir);

    logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    let out = printed(logSpy);
    expect(out).toContain('Lock');
    // Approved, never "frozen": the lock approves and rewrites nothing.
    expect(out).toMatch(/approved at/);
    expect(out).not.toMatch(/frozen/);
    logSpy.mockRestore();

    saveComponentSpec({ ...loadComponentSpec('leaf')!, description: 'edited after the freeze' });
    invalidateSpecCache();
    setProjectRoot(rootDir);

    logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    out = printed(logSpy);
    expect(out).toContain('stale');

    expect(vi.mocked(validateAdapter.computeGateStateId)).toHaveBeenCalled();
    expect(vi.mocked(subsystemAdapter.readLockState)).toHaveBeenCalled();
  });

  it('tree lock held from another host or PID namespace: names where the holder is and that only the stale age frees it', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-remote-lock-'));
    buildProject(rootDir);
    process.chdir(rootDir);
    // The fixture's own writes left generations behind: the remote holder takes the next one.
    const lockDir = path.join(rootDir, '.wai', '.spec-write.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    const highest = Math.max(0, ...fs.readdirSync(lockDir).map((n) => /^tree\.lock\.(\d+)/.exec(n)?.[1]).filter(Boolean).map(Number));
    fs.writeFileSync(
      path.join(lockDir, `tree.lock.${highest + 1}`),
      serializeHolder({ pid: 4242, takenAt: Date.now(), host: 'other-machine', pidNamespace: 'pidns=[4026599999]' }, 'nonce'),
    );

    const logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    const out = printed(logSpy);
    expect(out).toContain('another host or PID namespace');
    expect(out).toContain('host other-machine');
    expect(out).toContain('older than the stale age');
    expect(out).not.toContain('has held it longer than any write takes');
  });
});

describe('cli_runner_impl.runDoctor --fix (real CLI): waits for `wairon upgrade` on a tree another major wrote', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  // An unstamped tree reports a Major error, so plain `doctor` exits non-zero —
  // expected here. Resolve either way.
  const runCli = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'doctor', ...args], { cwd, timeout: 180_000 })
      .catch((e: Error & { stdout?: string; stderr?: string }) => e);

  it('--fix is skipped with a warning naming `wairon upgrade`, and writes nothing', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-fix-older-'));
    buildProject(rootDir, false);
    setProjectRoot(null);
    const before = snapshot(path.join(rootDir, '.wai'));

    const fixed = await runCli(rootDir, '--fix');
    expect(fixed.stdout + (fixed.stderr ?? '')).toContain('--fix skipped');
    expect(fixed.stdout + (fixed.stderr ?? '')).toContain('wairon upgrade');
    expect(snapshot(path.join(rootDir, '.wai'))).toEqual(before);
  }, 180_000);

  it('--fix on a current tree runs the repairs it still owns and leaves the Orchestrators as they are', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-fix-current-'));
    buildProject(rootDir);
    setProjectRoot(null);

    const fixed = await runCli(rootDir, '--fix');
    expect(fixed.stdout).toContain('Regenerated context files');
    expect(fixed.stdout).not.toContain('Specialist');
    setProjectRoot(rootDir);
    invalidateSpecCache();
    expect(loadComponentSpec('leaf')?.componentType).toBe('Orchestrator');
  }, 180_000);
});
