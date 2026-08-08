import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// `wairon init` — the written project config must default component-implementer
// FILE generation OFF: per-subsystem owners are the file granularity, and
// component-level delegation is served as live MCP briefs. This pins the
// written config to the schema default (src/models/project.ts) and subproject
// provisioning (src/core/provision.ts), which init used to contradict.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

describe('cli_runner.runInit: written project config (real CLI)', () => {
  let rootDir: string;

  afterEach(() => {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('writes generateComponentImplementers: false (owners + live briefs are the model)', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-'));

    await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '--yes'], {
      cwd: rootDir, timeout: 180_000,
    });

    const configPath = path.join(rootDir, '.wai', 'project.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as {
      rules: { generateComponentImplementers: boolean };
    };
    expect(config.rules.generateComponentImplementers).toBe(false);
  }, 180_000);
});
