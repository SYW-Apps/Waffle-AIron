import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import {
  createProjectConfig,
  defaultPackSelections,
  ensureProjectInitialized,
} from '../../src/commands/subsystem.js';
import { exportSddSkills } from '../../src/commands/skills.js';
import { runInit } from '../../src/commands/init.js';

// ---------------------------------------------------------------------------
// `wairon init` (runInit steps 13–18), in-process so each adapter call can be
// observed: the default packs are read only when a NEW configuration is
// composed, the L0 is bootstrapped through cli_core_adapter.ensureProjectInitialized,
// and the order is configuration → L0 bootstrap → skills export. The adapters
// are spies that still forward to the real core — except the default packs,
// which answer one known array instance so the test can see that the created
// configuration was seeded with exactly the adapter's answer.
// ---------------------------------------------------------------------------

const { SEEDED } = vi.hoisted(() => ({ SEEDED: [] as { name: string }[] }));

vi.mock('../../src/commands/subsystem.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/subsystem.js')>();
  return {
    ...actual,
    createProjectConfig: vi.fn(actual.createProjectConfig),
    defaultPackSelections: vi.fn(() => SEEDED),
    ensureProjectInitialized: vi.fn(actual.ensureProjectInitialized),
  };
});

vi.mock('../../src/commands/skills.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/skills.js')>();
  return { ...actual, exportSddSkills: vi.fn(actual.exportSddSkills) };
});

// Context seeding is not under test here, and it renders its guide through a
// lazy require('./domains.js') that vitest cannot resolve in-process.
vi.mock('../../src/core/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/context.js')>();
  return { ...actual, syncContextFiles: vi.fn() };
});

describe('cli_runner.runInit: configuration, L0 and skills through the adapters (in-process)', () => {
  const originalCwd = process.cwd();
  let rootDir: string;

  const initIn = async (dir: string) => {
    // runInit reads process.cwd(); the root override keeps every root-relative
    // write inside the temp folder too.
    process.chdir(dir);
    setProjectRoot(dir);
    await runInit({ yes: true });
  };

  const firstCall = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0];

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setProjectRoot(null);
    invalidateSpecCache();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('a fresh folder: seeds the new configuration with the default packs, bootstraps the L0 through core, then exports skills', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-adapters-'));

    await initIn(rootDir);

    expect(vi.mocked(defaultPackSelections)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createProjectConfig)).toHaveBeenCalledTimes(1);
    const created = vi.mocked(createProjectConfig).mock.calls[0][0];
    expect(created.extensions?.packs).toBe(SEEDED);
    expect(created.extensions?.useGlobalPacks).toBe(false);

    expect(vi.mocked(ensureProjectInitialized)).toHaveBeenCalledWith(path.basename(rootDir));
    expect(fs.existsSync(path.join(rootDir, '.wai', 'specs', '.index.yaml'))).toBe(true);

    expect(firstCall(createProjectConfig)).toBeLessThan(firstCall(ensureProjectInitialized));
    expect(firstCall(ensureProjectInitialized)).toBeLessThan(firstCall(exportSddSkills));
  });

  it('a kept configuration: reads no default packs and still bootstraps the L0 through core', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-adapters-keep-'));
    const configPath = path.join(rootDir, '.wai', 'project.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      "schemaVersion: '1.0.0'",
      'name: kept-project',
      'projectType: backend',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      'rules: {}',
      "createdAt: '2026-01-01T00:00:00Z'",
      "updatedAt: '2026-01-01T00:00:00Z'",
      '',
    ].join('\n'));
    const before = fs.readFileSync(configPath);

    await initIn(rootDir);

    expect(vi.mocked(defaultPackSelections)).not.toHaveBeenCalled();
    expect(vi.mocked(createProjectConfig)).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath).equals(before)).toBe(true);
    expect(vi.mocked(ensureProjectInitialized)).toHaveBeenCalledWith(path.basename(rootDir));
    expect(fs.existsSync(path.join(rootDir, '.wai', 'specs', '.index.yaml'))).toBe(true);
  });
});
