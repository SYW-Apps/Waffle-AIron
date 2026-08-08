import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon agent <action> <id>` — the CLI window into the live delegation
// briefs: `brief` prints the composed brief; `customize` scaffolds the
// user-owned guidance file .wai/agents/<id>.md and refuses to clobber it.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

function buildProject(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'agent-system',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: now,
    updatedAt: now,
  }));
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'agent-system',
    vision: 'an agent-command fixture system',
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
  const sub: SubsystemSpec = {
    id: 'dom-a', name: 'dom-a', description: 'subsystem dom-a — the waffle domain',
    parentSystem: 'agent-system', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  };
  saveSubsystemSpec(sub);
  invalidateSpecCache();
  setProjectRoot(null);
}

describe('cli_runner.runAgent (real CLI)', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const runCli = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'agent', ...args], { cwd, timeout: 180_000 });

  it('`agent brief` prints the live brief for a real agent id and errors usefully on an unknown one', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-agent-brief-'));
    buildProject(rootDir);

    const { stdout } = await runCli(rootDir, 'brief', 'dom-a-owner');
    expect(stdout).toContain('dom-a-owner');
    expect(stdout).toContain('Owned paths');
    // The instruction body is rendered, not a raw template.
    expect(stdout).not.toContain('{{agentId}}');

    await expect(runCli(rootDir, 'brief', 'no-such-agent')).rejects.toMatchObject({
      stderr: expect.stringContaining('Unknown agent id'),
    });
  }, 180_000);

  it('`agent customize` scaffolds .wai/agents/<id>.md once and refuses to clobber the user-owned file', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-agent-customize-'));
    buildProject(rootDir);
    const guidancePath = path.join(rootDir, '.wai', 'agents', 'dom-a-owner.md');

    const { stdout } = await runCli(rootDir, 'customize', 'dom-a-owner');
    expect(stdout).toContain('.wai/agents/dom-a-owner.md');
    const scaffold = fs.readFileSync(guidancePath, 'utf8');
    // Header explains the live-inference contract; the subsystem description
    // seeds the starting content.
    expect(scaffold).toContain('inferred LIVE');
    expect(scaffold).toContain('## Project guidance');
    expect(scaffold).toContain('the waffle domain');

    // A second run refuses — the file is user-owned.
    fs.writeFileSync(guidancePath, 'my edited guidance');
    await expect(runCli(rootDir, 'customize', 'dom-a-owner')).rejects.toMatchObject({
      stderr: expect.stringContaining('user-owned'),
    });
    expect(fs.readFileSync(guidancePath, 'utf8')).toBe('my edited guidance');
  }, 180_000);

  it('an unknown action names the two supported actions', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-agent-unknown-'));
    buildProject(rootDir);

    await expect(runCli(rootDir, 'frobnicate', 'dom-a-owner')).rejects.toMatchObject({
      stderr: expect.stringContaining('expected brief | customize'),
    });
  }, 180_000);
});
