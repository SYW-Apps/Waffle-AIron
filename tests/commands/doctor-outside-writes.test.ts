import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

// ---------------------------------------------------------------------------
// `wairon doctor --fix` and writes OUTSIDE the project root (friction F85).
//
// The MCP repair for an Antigravity (agy) target writes Antigravity's GLOBAL
// mcp_config.json, and the legacy-plugin cleanup touches the user's gemini
// home. Both used to happen silently under --fix (and under --yes): not in the
// plan, not confirmed, and the replaced file was not kept. Now each is listed
// in its own plan with the file and the old and new value, needs its own
// consent (--yes counts only with --global), and the replaced file is backed
// up beside itself.
//
// Driven through the real CLI (doctor's fixes reach the MCP adapter, which a
// spawned process exercises as a user would). EVERY home the process could
// resolve — HOME, USERPROFILE, APPDATA, and the config-dir overrides — points
// into a temp directory: these tests must never touch the real user config.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

describe('doctor --fix: writes outside the project root are planned, confirmed and backed up', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
    }
  });

  /** A temp home and an initialized project whose targets include agy (global MCP config) and claude (project .mcp.json). */
  function setup(): { home: string; project: string; globalCfg: string; plugin: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-outside-'));
    dirs.push(base);
    const home = path.join(base, 'home');
    const project = path.join(base, 'project');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(project, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(project, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0',
      name: 'outside-writes',
      targets: [
        { type: 'claude', outputDir: '.claude/agents', enabled: true },
        { type: 'agy', outputDir: '.gemini/agents', enabled: true },
      ],
      rules: {},
      extensions: { packs: [], useGlobalPacks: false },
      createdAt: now,
      updatedAt: now,
    }));

    // The user's global Antigravity config, already holding another server and
    // a stale wairon entry — exactly the file doctor used to rewrite unasked.
    const globalCfg = path.join(home, '.gemini', 'antigravity-cli', 'mcp_config.json');
    fs.mkdirSync(path.dirname(globalCfg), { recursive: true });
    fs.writeFileSync(globalCfg, JSON.stringify({
      mcpServers: {
        other: { command: 'other-server' },
        wairon: { command: 'node', args: ['/moved/repo/dist/cli/index.js', 'mcp', 'serve'], env: {} },
      },
    }, null, 2));

    // A legacy global plugin whose name collides with the MCP server.
    const plugin = path.join(home, '.gemini', 'config', 'plugins', 'wairon');
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'plugin.json'), '{"name":"wairon"}');
    return { home, project, globalCfg, plugin };
  }

  /** Run doctor in the project with every home redirected into the temp dir. */
  const runDoctor = (project: string, home: string, ...args: string[]) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      WAIRON_PACKS_DIR: path.join(home, '.wairon', 'packs'),
    };
    delete env.GEMINI_CONFIG_DIR;
    delete env.CLAUDE_CONFIG_DIR;
    delete env.WAIRON_PROJECT_DIR;
    return execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'doctor', '--fix', ...args], { cwd: project, env, timeout: 180_000 })
      .catch((e: Error & { stdout?: string; stderr?: string }) => e) as Promise<{ stdout?: string; stderr?: string }>;
  };

  const backupsOf = (file: string): string[] =>
    fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith(`${path.basename(file)}.wairon-backup-`));

  it('--fix --yes without --global lists the global writes, skips them and says so; the project-local write still happens', async () => {
    const { home, project, globalCfg, plugin } = setup();
    const before = fs.readFileSync(globalCfg, 'utf8');

    const out = (await runDoctor(project, home, '--yes')).stdout ?? '';

    // The plan names the file and the old and new value.
    expect(out).toContain('Writes outside this project');
    expect(out).toContain(globalCfg);
    expect(out).toContain('/moved/repo/dist/cli/index.js');
    expect(out).toMatch(/mcpServers\.wairon new: \{"command":/);
    expect(out).toContain(plugin);
    // --yes alone is not consent to a machine-wide write.
    expect(out).toContain('Skipped the writes outside this project: --yes does not cover a write outside the project without --global');

    expect(fs.readFileSync(globalCfg, 'utf8')).toBe(before);
    expect(backupsOf(globalCfg)).toEqual([]);
    expect(fs.existsSync(plugin)).toBe(true);
    // The in-project registration is not held hostage by the global one.
    expect(fs.existsSync(path.join(project, '.mcp.json'))).toBe(true);
  }, 240_000);

  it('a non-interactive --fix with neither --yes nor --global skips the global writes', async () => {
    const { home, project, globalCfg } = setup();
    const before = fs.readFileSync(globalCfg, 'utf8');

    const out = (await runDoctor(project, home)).stdout ?? '';

    expect(out).toContain('Skipped the writes outside this project: no terminal to confirm them and no --global');
    expect(fs.readFileSync(globalCfg, 'utf8')).toBe(before);
  }, 240_000);

  it('--fix --yes --global applies them, keeping the replaced config beside itself and moving the plugin aside', async () => {
    const { home, project, globalCfg, plugin } = setup();
    const before = fs.readFileSync(globalCfg, 'utf8');

    const out = (await runDoctor(project, home, '--yes', '--global')).stdout ?? '';

    const after = JSON.parse(fs.readFileSync(globalCfg, 'utf8')) as { mcpServers: Record<string, { args?: string[] }> };
    expect(after.mcpServers.other).toEqual({ command: 'other-server' });
    expect(after.mcpServers.wairon.args).not.toContain('/moved/repo/dist/cli/index.js');

    // The previous value is kept, byte for byte, and its path is printed.
    const backups = backupsOf(globalCfg);
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(globalCfg), backups[0]), 'utf8')).toBe(before);
    expect(out.replace(/\s+/g, ' ')).toContain(backups[0]);

    // The plugin is moved out of the plugins directory, never deleted.
    expect(fs.existsSync(plugin)).toBe(false);
    const configDir = path.join(home, '.gemini', 'config');
    const moved = fs.readdirSync(configDir).filter((f) => f.startsWith('wairon-plugin.wairon-backup-'));
    expect(moved).toHaveLength(1);
    expect(fs.readFileSync(path.join(configDir, moved[0], 'plugin.json'), 'utf8')).toBe('{"name":"wairon"}');
  }, 240_000);
});
