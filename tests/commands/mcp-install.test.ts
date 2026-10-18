import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { storeCredential } from '../../src/commands/remote.js';

// ---------------------------------------------------------------------------
// `wairon mcp install --hosted <url>` without --token (cli_runner.runMcpInstall,
// realized by mcpInstallCommand in src/cli/runner.ts): the CLI resolves the bearer
// from this machine's credential store, and the MCP adapter embeds it. The
// adapter never reads the store itself, so without the CLI's fallback the
// install refuses with "No credential".
//
// Driven through the real CLI: src/cli/index.ts parses process.argv as soon as
// it is imported and does not export its commands, so mcpInstallCommand cannot
// be called in-process.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

describe('cli_runner.runMcpInstall: a hosted install without --token (real CLI)', () => {
  const dirs: string[] = [];
  const savedHome = process.env.HOME;
  const savedProfile = process.env.USERPROFILE;

  const mkTmp = (prefix: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
    for (const dir of dirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
    }
  });

  it('embeds the credential stored for the instance', async () => {
    const home = mkTmp('wairon-mcp-home-');
    const project = mkTmp('wairon-mcp-project-');
    const now = new Date().toISOString();
    fs.mkdirSync(path.join(project, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(project, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0',
      name: 'mcp-install',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {},
      createdAt: now,
      updatedAt: now,
    }));

    // Seed this machine's credential store, in a home redirected for the test.
    // No project is named, so nothing is probed against the (absent) instance.
    const url = 'http://127.0.0.1:9';
    const token = 'wk_stored-by-login';
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await storeCredential(url, token);

    await execFileP(
      process.execPath,
      [TSX_CLI, WAIRON_CLI, 'mcp', 'install', '--hosted', `${url}/`, '--project', 'demo', '--backend', 'claude'],
      { cwd: project, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 180_000 },
    );

    const settings = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(settings.mcpServers.wairon).toEqual({
      type: 'http',
      url: `${url}/mcp`,
      headers: { Authorization: `Bearer ${token}`, 'X-Wairon-Project': 'demo' },
    });
  }, 180_000);

  it('works in an empty folder: a hosted user has no checkout, and only the entry is written', async () => {
    const home = mkTmp('wairon-mcp-home-');
    const empty = mkTmp('wairon-mcp-empty-');
    const url = 'http://127.0.0.1:9';

    const { stdout, stderr } = await execFileP(
      process.execPath,
      [TSX_CLI, WAIRON_CLI, 'mcp', 'install', '--hosted', url, '--project', 'kbase', '--token', 'wk_given', '--backend', 'claude'],
      { cwd: empty, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 180_000 },
    );

    // Exactly the registration: no spec tree, no guide, no agent folder.
    expect(fs.readdirSync(empty)).toEqual(['.mcp.json']);
    const settings = JSON.parse(fs.readFileSync(path.join(empty, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(settings.mcpServers.wairon).toEqual({
      type: 'http',
      url: `${url}/mcp`,
      headers: { Authorization: 'Bearer wk_given', 'X-Wairon-Project': 'kbase' },
    });
    // The file now carries a credential: the install says to keep it out of version control.
    expect(stdout + stderr).toMatch(/keep it out of version control/);
  }, 180_000);

  it('a LOCAL install in an empty folder still refuses, naming wairon init', async () => {
    const home = mkTmp('wairon-mcp-home-');
    const empty = mkTmp('wairon-mcp-empty-');
    const run = execFileP(
      process.execPath,
      [TSX_CLI, WAIRON_CLI, 'mcp', 'install', '--backend', 'claude'],
      { cwd: empty, env: { ...process.env, HOME: home, USERPROFILE: home }, timeout: 180_000 },
    );
    await expect(run).rejects.toMatchObject({ stderr: expect.stringMatching(/wairon init/) });
    expect(fs.readdirSync(empty)).toEqual([]);
  }, 180_000);

  it('names the Gemini CLI, not Antigravity, for the project .gemini/settings.json', async () => {
    // Antigravity reads only its global mcp_config.json; telling the user the
    // project file was written "for Antigravity" sent them to the wrong tool.
    const home = mkTmp('wairon-mcp-home-');
    const project = mkTmp('wairon-mcp-gemini-');
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '-y'], { cwd: project, env, timeout: 180_000 });
    const { stdout } = await execFileP(
      process.execPath,
      [TSX_CLI, WAIRON_CLI, 'mcp', 'install', '--backend', 'gemini'],
      { cwd: project, env, timeout: 180_000 },
    );
    expect(fs.existsSync(path.join(project, '.gemini', 'settings.json'))).toBe(true);
    expect(stdout).toMatch(/for Gemini CLI in .*settings\.json/);
    expect(stdout).not.toMatch(/for Antigravity in/);
    expect(stdout).toMatch(/Restart .*Gemini CLI/);
  }, 360_000);
});
