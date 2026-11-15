import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// `wairon init` with the wairon plugin: --plugin names tools that already have
// it, and the tool's own plugin listing (detectPlugin, mocked here — no real
// claude or codex is run) records the rest. A plugin target is recorded
// `via: plugin` and gets neither built-in skills nor a project MCP entry.
// ---------------------------------------------------------------------------

const { detectPlugin } = vi.hoisted(() => ({ detectPlugin: vi.fn() }));

vi.mock('../../src/commands/agent-plugins.js', () => ({ detectPlugin }));

// Context seeding renders its guide through a lazy require vitest cannot resolve in-process.
vi.mock('../../src/core/context.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/context.js')>();
  return { ...actual, syncContextFiles: vi.fn() };
});

import { runInit } from '../../src/commands/init.js';

describe('cli_runner.runInit: the wairon plugin (in-process)', () => {
  const originalCwd = process.cwd();
  let rootDir: string;
  let logs: string[];

  const initIn = async (options: { plugin?: string[] }) => {
    process.chdir(rootDir);
    setProjectRoot(rootDir);
    await runInit({ yes: true, ...options });
  };
  const written = () => yaml.load(fs.readFileSync(path.join(rootDir, '.wai', 'project.yaml'), 'utf8')) as {
    targets: { type: string; via?: string }[];
  };

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-plugin-'));
    logs = [];
    detectPlugin.mockReset().mockReturnValue('unknown');
    const grab = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(grab);
    vi.spyOn(console, 'warn').mockImplementation(grab);
    vi.spyOn(console, 'error').mockImplementation(grab);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setProjectRoot(null);
    invalidateSpecCache();
    vi.restoreAllMocks();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('--plugin claude records via: plugin, without asking the tool, and writes no skills and no .mcp.json', async () => {
    await initIn({ plugin: ['claude'] });

    expect(written().targets).toEqual([expect.objectContaining({ type: 'claude', via: 'plugin' })]);
    expect(detectPlugin).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(rootDir, '.claude', 'skills', 'sdd-architect'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '.mcp.json'))).toBe(false);
  });

  it('a tool whose listing says the plugin is enabled is recorded via: plugin, and the report says which listing', async () => {
    detectPlugin.mockReturnValue('enabled');
    await initIn({});

    expect(detectPlugin).toHaveBeenCalledWith('claude');
    expect(written().targets[0]).toMatchObject({ type: 'claude', via: 'plugin' });
    expect(logs.join('\n')).toMatch(/claude plugin list/);
    expect(fs.existsSync(path.join(rootDir, '.mcp.json'))).toBe(false);
  });

  it.each(['absent', 'unknown'])('a listing that answers %s leaves the target served by the project', async (answer) => {
    detectPlugin.mockReturnValue(answer);
    await initIn({});

    expect(written().targets[0].via).toBeUndefined();
    expect(fs.existsSync(path.join(rootDir, '.claude', 'skills', 'sdd-architect', 'SKILL.md'))).toBe(true);
  });

  it('refuses --plugin copilot before anything is written', async () => {
    await expect(initIn({ plugin: ['copilot'] })).rejects.toThrow(/copilot/);
    expect(fs.existsSync(path.join(rootDir, '.wai'))).toBe(false);
  });

  it('refuses --plugin naming a tool that is not a chosen target before anything is written', async () => {
    await expect(initIn({ plugin: ['codex'] })).rejects.toThrow(/not one of the chosen targets/);
    expect(fs.existsSync(path.join(rootDir, '.wai'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, '.mcp.json'))).toBe(false);
  });
});
