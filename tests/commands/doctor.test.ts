import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  loadComponentSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, SubsystemSpec } from '../../src/models/index.js';
import { runLock } from '../../src/commands/lock.js';
import * as subsystemAdapter from '../../src/commands/adapters/core.js';
import * as validateAdapter from '../../src/commands/validate.js';

// ---------------------------------------------------------------------------
// `wairon doctor` (cli_runner_impl.runDoctor) — the report phase's Project
// check, Stereotypes section and Lock section route through the CLI core
// adapter (cli_core_adapter: projectConfigExists, retireSpecialists,
// readLockState) and the CLI validator adapter (cli_validator_adapter:
// validateSddTree, computeGateStateId), not a direct core import.
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
    retireSpecialists: vi.fn(actual.retireSpecialists),
    readLockState: vi.fn(actual.readLockState),
  };
});

vi.mock('../../src/commands/validate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/validate.js')>();
  return {
    ...actual,
    computeGateStateId: vi.fn(actual.computeGateStateId),
    validateSddTree: vi.fn(actual.validateSddTree),
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
const specialist = (id: string, dependsOn: string[]): ComponentSpec => comp(id, 'Specialist', { dependsOn });

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
 * A minimal draft project: one Store and two Specialists — 'leaf' (no
 * dependencies, so it classifies pure) and 'stamp' (depends on the Store,
 * which fits neither pure nor read logic, so it classifies as a workflow) —
 * enough for the Stereotypes section to have something to plan.
 */
function buildProject(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(rootDir, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'doctor-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'doctor-sys', vision: 'a doctor fixture system',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec(sub('calc'));
  saveComponentSpec(comp('ledger', 'Store', { durability: 'durable' }));
  saveComponentSpec(specialist('leaf', []));
  saveComponentSpec(specialist('stamp', ['ledger']));
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

describe('cli_runner_impl.runDoctor — report phase (in-process, through the CLI adapters)', () => {
  const originalCwd = process.cwd();
  let rootDir: string;
  let packsDir: string;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // A tree still carrying a Specialist reports STEREOTYPE_RETIRED as a
    // conformance ERROR (that's exactly the fixture below), so runDoctor's
    // final process.exit(1) is expected — stub it out rather than let it
    // tear down the test worker, and assert on it where it matters.
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

  it('dry run: lists each Specialist under Stereotypes with its class and reason, and writes no file', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-report-'));
    buildProject(rootDir);
    process.chdir(rootDir);
    const before = snapshot(path.join(rootDir, '.wai'));

    const logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    const out = printed(logSpy);

    expect(out).toContain('Stereotypes');
    expect(out).toMatch(/leaf: Specialist → Orchestrator \(pure\)/);
    expect(out).toContain('no dependencies');
    expect(out).toMatch(/stamp: Specialist → Orchestrator \(workflow\)/);
    expect(out).toContain('ledger');
    expect(out).toContain('wairon doctor --fix');

    // A dry run changes nothing on disk.
    invalidateSpecCache();
    expect(snapshot(path.join(rootDir, '.wai'))).toEqual(before);
    expect(loadComponentSpec('leaf')?.componentType).toBe('Specialist');
    expect(loadComponentSpec('stamp')?.componentType).toBe('Specialist');

    // Routed through the CLI core and validator adapters, not a direct core import.
    expect(vi.mocked(subsystemAdapter.projectConfigExists)).toHaveBeenCalled();
    expect(vi.mocked(subsystemAdapter.retireSpecialists)).toHaveBeenCalledWith(false);
    expect(vi.mocked(validateAdapter.validateSddTree)).toHaveBeenCalled();
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

  it('Lock section: silent unlocked, "locked" once frozen, "stale" once the spec tree drifts — against the validator adapter\'s gate identity', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-lock-'));
    buildProject(rootDir);
    process.chdir(rootDir);

    let logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    expect(printed(logSpy)).not.toContain('Lock');
    logSpy.mockRestore();

    await runLock({ yes: true }, { valid: true, issues: [] });
    invalidateSpecCache();
    setProjectRoot(rootDir);

    logSpy = vi.spyOn(console, 'log');
    await runDoctor({});
    let out = printed(logSpy);
    expect(out).toContain('Lock');
    expect(out).toMatch(/frozen at/);
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
});

describe('cli_runner_impl.runDoctor --fix (real CLI): retires Specialists after the filename migration', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  // A tree still carrying a Specialist reports STEREOTYPE_RETIRED as a
  // conformance error, so plain `doctor` (no --fix) exits non-zero — expected
  // here, since retiring them is exactly what's under test. Resolve either way.
  const runCli = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'doctor', ...args], { cwd, timeout: 180_000 })
      .catch((e: Error & { stdout?: string; stderr?: string }) => e);

  it('--fix retypes every Specialist to Orchestrator, and the report then says none are left', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-fix-'));
    buildProject(rootDir);
    setProjectRoot(null);

    const before = await runCli(rootDir);
    expect(before.stdout).toContain('Stereotypes');
    expect(before.stdout).toMatch(/leaf: Specialist → Orchestrator \(pure\)/);

    const fixed = await runCli(rootDir, '--fix');
    expect(fixed.stdout).toContain('Retired 2 Specialist(s) to Orchestrator.');

    setProjectRoot(rootDir);
    invalidateSpecCache();
    expect(loadComponentSpec('leaf')?.componentType).toBe('Orchestrator');
    expect(loadComponentSpec('stamp')?.componentType).toBe('Orchestrator');
    setProjectRoot(null);

    const after = await runCli(rootDir);
    expect(after.stdout).not.toContain('Stereotypes');
  }, 180_000);
});
