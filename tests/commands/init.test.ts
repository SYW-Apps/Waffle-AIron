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

// ---------------------------------------------------------------------------
// `wairon init` completes only what is missing. Its early return looks for the
// spec tree, so a half-finished init — a configuration but no tree — reaches
// the configuration step. That configuration is kept exactly as it is.
// ---------------------------------------------------------------------------

describe('cli_runner.runInit: completes only what is missing (real CLI)', () => {
  let rootDir: string;

  afterEach(() => {
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  // execFile rejects on a non-zero exit, so a resolved call is the exit-0 check.
  const init = (cwd: string) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '--yes'], { cwd, timeout: 180_000 });

  // The closing summary's two ways of naming the configuration.
  const LISTED_AS_CREATED = /\.wai\/project\.yaml\s+— project config/;
  const LISTED_AS_KEPT = 'Kept .wai/project.yaml as it was (not recreated).';

  it('keeps an existing project.yaml byte-identical and bootstraps the missing tree', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-keep-'));
    const configPath = path.join(rootDir, '.wai', 'project.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, [
      "schemaVersion: '1.0.0'",
      'name: kept-project',
      'projectType: game-ecs',
      'targets:',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '    enabled: true',
      'rules: {}',
      'futureSetting: keep-me',
      "createdAt: '2026-01-01T00:00:00Z'",
      "updatedAt: '2026-01-01T00:00:00Z'",
      '',
    ].join('\n'));
    const before = fs.readFileSync(configPath);

    const { stdout } = await init(rootDir);

    expect(fs.readFileSync(configPath).equals(before)).toBe(true);
    expect(stdout).toContain('Kept the existing .wai/project.yaml');
    expect(stdout).toContain(LISTED_AS_KEPT);
    expect(stdout).not.toMatch(LISTED_AS_CREATED);
    expect(fs.existsSync(path.join(rootDir, '.wai', 'specs', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '.claude', 'skills', 'sdd-architect', 'SKILL.md'))).toBe(true);
  }, 180_000);

  it('still creates the configuration in a fresh folder', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-fresh-'));

    const { stdout } = await init(rootDir);

    const config = yaml.load(fs.readFileSync(path.join(rootDir, '.wai', 'project.yaml'), 'utf8')) as {
      execution: { tier: string };
    };
    expect(config.execution.tier).toBe('off');
    expect(stdout).not.toContain('Kept the existing .wai/project.yaml');
    expect(stdout).toMatch(LISTED_AS_CREATED);
    expect(stdout).not.toContain(LISTED_AS_KEPT);
    expect(fs.existsSync(path.join(rootDir, '.wai', 'specs', '.index.yaml'))).toBe(true);
  }, 180_000);
});
