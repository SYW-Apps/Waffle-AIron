import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { storeCredential } from '../../src/commands/remote.js';

// ---------------------------------------------------------------------------
// `wairon mcp install --hosted <url>` without --token (cli_runner.runMcpInstall,
// realized by mcpInstallCommand in src/cli/index.ts): the CLI resolves the bearer
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
});
