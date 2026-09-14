import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { resolveExpectedOutputPaths } from '../../src/exporters/generate.js';
import { WAIRON_MANAGED_BANNER } from '../../src/exporters/base.js';
import type { AgentRecord } from '../../src/models/agent.js';
import type { ProjectConfig } from '../../src/models/project.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon generate` — a RECONCILER. Agent-file materialization is opt-in via
// rules.materializeAgentFiles (default off): off means the desired state is
// ZERO agent files (leftover managed files are removed once, hand-authored
// files survive); on means owner/architect files whose body is the live brief
// composition, pruned against the FULL topology's expected-file set — never
// against what a (possibly scoped) run happened to write.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'gen-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
});

/** A two-subsystem project: with materializeAgentFiles on, a full generate
 *  writes system-architect.md, dom-a-owner.md, and dom-b-owner.md into
 *  .claude/agents/. */
function buildTwoDomainProject(rootDir: string, rules: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'gen-system',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules,
    createdAt: now,
    updatedAt: now,
  }));
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'gen-system',
    vision: 'a generate fixture system',
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
  saveSubsystemSpec(subsystem('dom-a'));
  saveSubsystemSpec(subsystem('dom-b'));
  invalidateSpecCache();
  setProjectRoot(null);
}

describe('cli_runner.runGenerate: scoped runs prune against the full topology (real CLI)', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const runCli = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'generate', ...args], { cwd, timeout: 180_000 });

  it('a --domain run prunes a stale managed orphan but preserves other domains\' files and hand-authored files', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gen-prune-'));
    buildTwoDomainProject(rootDir, { materializeAgentFiles: true });
    const agentsDir = path.join(rootDir, '.claude', 'agents');

    // Populate the full layer first.
    await runCli(rootDir);
    expect(fs.existsSync(path.join(agentsDir, 'dom-a-owner.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'dom-b-owner.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'system-architect.md'))).toBe(true);

    // A wairon-managed orphan (its component no longer exists)...
    fs.writeFileSync(path.join(agentsDir, 'ghost-component-implementer.md'),
      `${WAIRON_MANAGED_BANNER}\nno longer in the topology`);
    // ...and a hand-authored file (no marker, no wairon naming).
    fs.writeFileSync(path.join(agentsDir, 'team-notes.md'), 'a human wrote this');

    const { stdout } = await runCli(rootDir, '--domain', 'dom-a');

    // The orphan is gone even though the run was scoped to dom-a...
    expect(fs.existsSync(path.join(agentsDir, 'ghost-component-implementer.md'))).toBe(false);
    expect(stdout).toContain('pruned');
    // ...while everything the scoped run did NOT write survives.
    expect(fs.existsSync(path.join(agentsDir, 'dom-a-owner.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'dom-b-owner.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'system-architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir, 'team-notes.md'))).toBe(true);
  }, 180_000);

  it('default (materializeAgentFiles off): removes leftover managed files with a notice, never touching hand-authored files, guides, or .wai/agents/', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gen-reconcile-'));
    buildTwoDomainProject(rootDir); // rules: {} — materializeAgentFiles defaults false
    const agentsDir = path.join(rootDir, '.claude', 'agents');

    // Leftovers from an earlier materialized run...
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'dom-a-owner.md'),
      `${WAIRON_MANAGED_BANNER}\npreviously materialized`);
    fs.writeFileSync(path.join(agentsDir, 'ghost-component-implementer.md'),
      `${WAIRON_MANAGED_BANNER}\nno longer in the topology`);
    // ...a hand-authored file, and user-owned per-agent guidance.
    fs.writeFileSync(path.join(agentsDir, 'team-notes.md'), 'a human wrote this');
    fs.mkdirSync(path.join(rootDir, '.wai', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.wai', 'agents', 'dom-a-owner.md'), 'my guidance');

    const { stdout } = await runCli(rootDir);

    // The desired state is ZERO agent files — leftovers are removed, legibly.
    expect(fs.existsSync(path.join(agentsDir, 'dom-a-owner.md'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir, 'ghost-component-implementer.md'))).toBe(false);
    expect(stdout).toContain('Removed 2 previously materialized agent file(s)');
    // Hand-authored files and .wai/agents/ guidance are never touched...
    expect(fs.readFileSync(path.join(agentsDir, 'team-notes.md'), 'utf8')).toBe('a human wrote this');
    expect(fs.readFileSync(path.join(rootDir, '.wai', 'agents', 'dom-a-owner.md'), 'utf8')).toBe('my guidance');
    // ...and guides + skills are still injected as today.
    expect(fs.existsSync(path.join(rootDir, 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(rootDir, '.claude', 'CLAUDE.md'))).toBe(true);
  }, 180_000);

  it('materializeAgentFiles on: the file body is the live brief composition, including the .wai/agents/ guidance fold', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gen-brief-body-'));
    buildTwoDomainProject(rootDir, { materializeAgentFiles: true });
    fs.mkdirSync(path.join(rootDir, '.wai', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.wai', 'agents', 'dom-a-owner.md'),
      'Always run the waffle-iron smoke test first.');

    await runCli(rootDir);

    const body = fs.readFileSync(path.join(rootDir, '.claude', 'agents', 'dom-a-owner.md'), 'utf8');
    // Frontmatter + managed banner wrapping stayed as-is...
    expect(body.startsWith('---\n')).toBe(true);
    expect(body).toContain(WAIRON_MANAGED_BANNER);
    // ...while the body is the composeAgentBrief-rendered brief: template vars
    // substituted and the user guidance folded under "## Project guidance".
    expect(body).toContain('dom-a');
    expect(body).not.toContain('{{agentId}}');
    expect(body).toContain('## Project guidance');
    expect(body).toContain('Always run the waffle-iron smoke test first.');
  }, 180_000);
});

// ---------------------------------------------------------------------------
// resolveExpectedOutputPaths — the expected-file set pruning reconciles against.
// Derived from the topology (agent × matching target), never from a written set.
// ---------------------------------------------------------------------------

describe('resolveExpectedOutputPaths (full-topology expected set)', () => {
  const agent = (id: string, targets: AgentRecord['targets']): AgentRecord => ({
    id, name: id, description: `agent ${id}`, template: 'domain-owner',
    creationReason: 'test', ownedPaths: [], readPaths: [], writePaths: [],
    tags: [], dependencies: [], status: 'active', targets,
    createdAt: now, updatedAt: now,
  } as unknown as AgentRecord);

  const projectConfig = {
    schemaVersion: '1.0.0',
    name: 'gen-system',
    targets: [
      { type: 'claude', outputDir: '.claude/agents', enabled: true },
      { type: 'agy', outputDir: '.gemini/agents', enabled: true },
    ],
    rules: {},
    paths: { specsDir: '.wai/specs' },
    createdAt: now,
    updatedAt: now,
  } as unknown as ProjectConfig;

  it('resolves one path per agent × matching target, applying the :: → -- filename mapping', () => {
    const root = path.resolve(os.tmpdir(), 'wairon-expected-root');
    const expected = resolveExpectedOutputPaths(
      [agent('dom-a-owner', ['claude', 'agy']), agent('ns::thing-owner', ['claude'])],
      projectConfig,
      root,
    );

    expect(expected).toEqual(new Set([
      path.resolve(root, '.claude/agents', 'dom-a-owner.md'),
      path.resolve(root, '.gemini/agents', 'dom-a-owner.yaml'),
      path.resolve(root, '.claude/agents', 'ns--thing-owner.md'),
    ]));
  });

  it('skips targets the project does not configure', () => {
    const root = path.resolve(os.tmpdir(), 'wairon-expected-root');
    const expected = resolveExpectedOutputPaths([agent('dom-a-owner', ['codex'])], projectConfig, root);
    expect(expected.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The cascade (runGenerate steps 9–15): after its own layer, `wairon generate`
// generates each DIRECT chained subproject's layer in that subproject's own
// root, completing the child's bootstrap first. It invalidates no spec cache of
// its own: every project root reads through its own spec workspace, and the
// bootstrap invalidates whenever it writes. Covered for both kinds of child — a
// fresh folder the bootstrap writes into, and an initialized child it leaves
// alone (so nothing is invalidated before that child's layer is resolved).
// ---------------------------------------------------------------------------

describe('cli_runner.runGenerate: the chained cascade generates each child layer in its own root (real CLI)', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const runCli = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'generate', ...args], { cwd, timeout: 180_000 });

  const writeProjectYaml = (dir: string, name: string, rules: Record<string, unknown>) => {
    fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0',
      name,
      projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules,
      createdAt: now,
      updatedAt: now,
    }));
  };

  const systemSpec = (name: string) => ({
    schemaVersion: '1.0.0',
    name,
    vision: `a cascade fixture system ${name}`,
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });

  it('bootstraps and generates a fresh child, and generates an initialized child from its own tree', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gen-cascade-'));
    const freshDir = path.join(rootDir, 'fresh');
    const readyDir = path.join(rootDir, 'ready');

    // Parent: agent files on, two chained subsystems.
    writeProjectYaml(rootDir, 'gen-system', { materializeAgentFiles: true });
    setProjectRoot(rootDir);
    saveSystemSpec(systemSpec('gen-system'));
    saveSubsystemSpec({ ...subsystem('fresh'), projectPath: 'fresh' });
    saveSubsystemSpec({ ...subsystem('ready'), projectPath: 'ready' });
    // 'fresh': an empty folder — no configuration and no L0 yet.
    fs.mkdirSync(freshDir, { recursive: true });
    // 'ready': its own configuration (agent files on), its own L0 and one subsystem.
    writeProjectYaml(readyDir, 'ready', { materializeAgentFiles: true });
    setProjectRoot(readyDir);
    invalidateSpecCache();
    saveSystemSpec(systemSpec('ready'));
    saveSubsystemSpec({ ...subsystem('inner'), parentSystem: 'ready' });
    invalidateSpecCache();
    setProjectRoot(null);

    const { stdout } = await runCli(rootDir);

    const agentsDir = (dir: string) => path.join(dir, '.claude', 'agents');
    expect(stdout).toContain('Chained subproject "fresh"');
    expect(stdout).toContain('Chained subproject "ready"');

    // Parent layer: its architect and one delegate per child — never a child's internals.
    expect(fs.existsSync(path.join(agentsDir(rootDir), 'system-architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(rootDir), 'fresh-owner.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(rootDir), 'ready-owner.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(rootDir), 'inner-owner.md'))).toBe(false);

    // Fresh child: bootstrapped in place (default configuration, an L0 named after
    // its subsystem), then its layer generated in its own root — skills and guide
    // there, and no agent files, since its default configuration keeps them off.
    expect(fs.existsSync(path.join(freshDir, '.wai', 'project.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(freshDir, '.wai', 'specs', '.index.yaml'), 'utf8')).toMatch(/^name: ['"]?fresh['"]?\s*$/m);
    expect(fs.existsSync(path.join(freshDir, '.claude', 'skills', 'sdd-architect', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(freshDir, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(freshDir), 'system-architect.md'))).toBe(false);

    // Initialized child: its own layer, resolved from its own tree.
    expect(fs.existsSync(path.join(agentsDir(readyDir), 'system-architect.md'))).toBe(true);
    expect(fs.existsSync(path.join(agentsDir(readyDir), 'inner-owner.md'))).toBe(true);
  }, 180_000);
});
