import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// `wairon doctor` and the wairon plugin: duplicate built-in skills and a project
// MCP entry for a plugin-served target are warnings pointing at --fix, and the
// tool's own plugin listing (detectPlugin, mocked — no real claude or codex is
// run) is compared with the configuration. An unknown listing reports nothing.
// ---------------------------------------------------------------------------

const { detectPlugin } = vi.hoisted(() => ({ detectPlugin: vi.fn() }));
vi.mock('../../src/commands/agent-plugins.js', () => ({ detectPlugin }));

import { runDoctor } from '../../src/commands/doctor.js';

const now = '2026-11-15T10:00:00Z';

describe('cli_runner.runDoctor: the wairon plugin (in-process)', () => {
  const originalCwd = process.cwd();
  let rootDir: string;
  let packsDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const build = (targets: unknown[]) => {
    fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'doctor-plugin', projectType: 'backend', targets,
      rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    }));
    setProjectRoot(rootDir);
    process.chdir(rootDir);
  };
  const out = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const lineWith = (needle: string): string => out().split('\n').find((l) => l.includes(needle)) ?? '';

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-plugin-'));
    packsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-plugin-packs-'));
    process.env.WAIRON_PACKS_DIR = packsDir;
    detectPlugin.mockReset().mockReturnValue('unknown');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    setProjectRoot(null);
    invalidateSpecCache();
    vi.restoreAllMocks();
    delete process.env.WAIRON_PACKS_DIR;
    for (const d of [rootDir, packsDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* win file locks */ } }
  });

  it('warns about built-in skills still copied into a plugin target, pointing at --fix', async () => {
    build([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    fs.mkdirSync(path.join(rootDir, '.claude', 'skills', 'sdd-architect'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.claude', 'skills', 'sdd-architect', 'SKILL.md'), 'copy');

    await runDoctor({});

    expect(lineWith('still copied into the project')).toMatch(/sdd-architect/);
    expect(lineWith('still copied into the project')).toMatch(/doctor --fix/);
    expect(lineWith('still copied into the project')).toContain('⚠');
  });

  it('is quiet about skills for a plugin target that holds no copy', async () => {
    build([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    await runDoctor({});
    expect(out()).not.toContain('still copied into the project');
    expect(out()).toContain('built-in skills provided by the wairon plugin');
  });

  it('warns about a project wairon entry for a plugin target', async () => {
    build([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    fs.writeFileSync(path.join(rootDir, '.mcp.json'), JSON.stringify({ mcpServers: { wairon: { command: 'wairon', args: ['mcp', 'serve'] } } }));

    await runDoctor({});

    expect(lineWith('the project entry gives the agent every tool twice')).toContain('⚠');
  });

  it('notices a plugin enabled for a target the project serves, suggesting via: plugin', async () => {
    build([{ type: 'claude', outputDir: '.claude/agents' }]);
    detectPlugin.mockReturnValue('enabled');

    await runDoctor({});

    expect(lineWith('mark the target `via: plugin`')).toBeTruthy();
    expect(lineWith('mark the target `via: plugin`')).not.toContain('⚠');
  });

  it('warns when a target is via: plugin but its listing says the plugin is absent', async () => {
    build([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    detectPlugin.mockReturnValue('absent');

    await runDoctor({});

    expect(lineWith('does not list the wairon plugin')).toContain('⚠');
  });

  it('reports nothing for an unknown listing', async () => {
    build([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    detectPlugin.mockReturnValue('unknown');

    await runDoctor({});

    expect(out()).not.toContain('does not list the wairon plugin');
    expect(out()).not.toContain('mark the target `via: plugin`');
  });
});
