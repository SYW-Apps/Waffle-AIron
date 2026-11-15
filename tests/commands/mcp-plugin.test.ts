import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { planMcpInstall, runMcpInstall, findLegacyPlugin } from '../../src/commands/mcp.js';

// ---------------------------------------------------------------------------
// cli_mcp_adapter with the wairon plugin: a backend whose target the plugin
// serves gets its project file's wairon entry REMOVED (no --backend named), an
// explicit --backend still writes (with a warning), and the legacy Antigravity
// plugin is recognised by its old layout only.
// ---------------------------------------------------------------------------

const ENTRY = { command: 'wairon', args: ['mcp', 'serve'] };
const dirs: string[] = [];

function project(targets: unknown[]): string {
  invalidateSpecCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mcp-plugin-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'p', projectType: 'backend', targets, rules: {},
    createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z',
  }));
  setProjectRoot(dir);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  return dir;
}

function writeMcp(dir: string, servers: Record<string, unknown>, extra: Record<string, unknown> = {}, eol = '\n'): string {
  const file = path.join(dir, '.mcp.json');
  fs.writeFileSync(file, JSON.stringify({ ...extra, mcpServers: servers }, null, 2).replace(/\n/g, eol) + eol);
  return file;
}

describe('cli_mcp_adapter: a plugin-served target', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    vi.restoreAllMocks();
    delete process.env.GEMINI_CONFIG_DIR;
    for (const d of dirs.splice(0)) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* win file locks */ }
    }
  });
  const printed = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

  it('removes the wairon entry from the project file, keeping every other server and key', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    const file = writeMcp(dir, { wairon: ENTRY, other: { command: 'x' } }, { note: 'kept' });

    runMcpInstall({ global: false });

    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.mcpServers).toEqual({ other: { command: 'x' } });
    expect(after.note).toBe('kept');
    expect(printed()).toMatch(/Removed the wairon entry/);
  });

  it('keeps the file\'s line endings when it removes the entry', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    const file = writeMcp(dir, { wairon: ENTRY, other: { command: 'x' } }, {}, '\r\n');

    runMcpInstall({ global: false });

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('writes nothing for a project file that holds no wairon entry, and creates none', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    runMcpInstall({ global: false });
    expect(fs.existsSync(path.join(dir, '.mcp.json'))).toBe(false);

    const file = writeMcp(dir, { other: { command: 'x' } });
    const before = fs.readFileSync(file, 'utf8');
    runMcpInstall({ global: false });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('plans the removal with removes: true, and plans none for an absent entry', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    writeMcp(dir, { wairon: ENTRY, other: { command: 'x' } });

    const [removal] = planMcpInstall({ global: false });
    expect(removal.removes).toBe(true);
    expect(removal.upToDate).toBe(false);
    expect(removal.before).toEqual(ENTRY);
    expect(removal.after).toEqual({ other: { command: 'x' } });
    expect(removal.outsideProject).toBe(false);

    writeMcp(dir, { other: { command: 'x' } });
    const [none] = planMcpInstall({ global: false });
    expect(none.removes).toBe(true);
    expect(none.upToDate).toBe(true);
  });

  it('an explicit --backend still writes the entry, with a warning', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents', via: 'plugin' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const [plan] = planMcpInstall({ backend: 'claude', global: false });
    expect(plan.removes).toBeUndefined();

    runMcpInstall({ backend: 'claude', global: false });

    const written = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.wairon).toBeDefined();
    const all = [...warn.mock.calls, ...errSpy.mock.calls, ...logSpy.mock.calls].map((c) => String(c[0])).join('\n');
    expect(all).toMatch(/plugin already provides/);
  });

  it('a project-served target is written as ever', () => {
    const dir = project([{ type: 'claude', outputDir: '.claude/agents' }]);
    runMcpInstall({ global: false });
    const written = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    expect(written.mcpServers.wairon).toBeDefined();
  });

  it('a gemini target is removed from .gemini/settings.json only when every gemini-backend target is plugin-served', () => {
    const dir = project([
      { type: 'gemini', outputDir: '.gemini/agents', via: 'plugin' },
      { type: 'agy', outputDir: '.gemini/agents' },
    ]);
    const settings = path.join(dir, '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: { wairon: ENTRY } }));

    expect(planMcpInstall({ global: false })[0].removes).toBeUndefined();

    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'p', projectType: 'backend', rules: {},
      targets: [{ type: 'agy', outputDir: '.gemini/agents', via: 'plugin' }],
      createdAt: '2026-11-15T10:00:00Z', updatedAt: '2026-11-15T10:00:00Z',
    }));
    invalidateSpecCache();
    expect(planMcpInstall({ global: false })[0].removes).toBe(true);
  });

  describe('findLegacyPlugin', () => {
    const geminiHome = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gemini-home-'));

    it('reports the legacy layout: skills/wairon/SKILL.md and no plugin.json', () => {
      const home = geminiHome(); dirs.push(home);
      process.env.GEMINI_CONFIG_DIR = home;
      const plugin = path.join(home, 'config', 'plugins', 'wairon');
      fs.mkdirSync(path.join(plugin, 'skills', 'wairon'), { recursive: true });
      fs.writeFileSync(path.join(plugin, 'skills', 'wairon', 'SKILL.md'), 'legacy');
      expect(findLegacyPlugin()).toBe(plugin);
    });

    it('never reports the plugin that carries a plugin.json', () => {
      const home = geminiHome(); dirs.push(home);
      process.env.GEMINI_CONFIG_DIR = home;
      const plugin = path.join(home, 'config', 'plugins', 'wairon');
      fs.mkdirSync(path.join(plugin, 'skills', 'wairon'), { recursive: true });
      fs.writeFileSync(path.join(plugin, 'skills', 'wairon', 'SKILL.md'), 'new');
      fs.writeFileSync(path.join(plugin, 'plugin.json'), '{}');
      expect(findLegacyPlugin()).toBeNull();
    });

    it('reports nothing when there is no such directory, or it holds no legacy skill', () => {
      const home = geminiHome(); dirs.push(home);
      process.env.GEMINI_CONFIG_DIR = home;
      expect(findLegacyPlugin()).toBeNull();
      fs.mkdirSync(path.join(home, 'config', 'plugins', 'wairon'), { recursive: true });
      expect(findLegacyPlugin()).toBeNull();
    });
  });
});
