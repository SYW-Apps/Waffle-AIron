import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, saveComponentSpec, invalidateSpecCache } from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon execution show | set-tier` — the resource axis at the CLI.
//
// Driven through the real CLI so the command wiring, config round-trip, and
// the tier dial are exercised together; the derivation itself is unit-tested
// in tests/core/execution-budget.test.ts.
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
    name: 'budget-system',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { generateComponentImplementers: true },
    createdAt: now,
    updatedAt: now,
  }));
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'budget-system',
    vision: 'a budget fixture system',
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
  const sub: SubsystemSpec = {
    id: 'dom-a', name: 'dom-a', description: 'subsystem dom-a — the budget domain',
    parentSystem: 'budget-system', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  };
  saveSubsystemSpec(sub);
  // One mechanical and one decision-carrying component, so the tiers have
  // something to actually differentiate.
  const comp = (id: string, name: string, componentType: string): ComponentSpec => ({
    id, name, description: `${name} component`, subsystem: 'dom-a',
    componentType: componentType as ComponentSpec['componentType'],
    dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveComponentSpec(comp('ledger_store', 'Ledger Store', 'Store'));
  saveComponentSpec(comp('billing_flow', 'Billing Flow', 'Orchestrator'));
  invalidateSpecCache();
  setProjectRoot(null);
}

describe('wairon execution (real CLI)', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const runCli = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'execution', ...args], { cwd, timeout: 180_000 });

  /** The fixture is written as JSON; saveProjectConfig rewrites it as YAML.
   *  js-yaml parses both, so read it this way on either side of a write. */
  const readConfig = (dir: string): { execution?: { tier?: string } } =>
    yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as { execution?: { tier?: string } };

  it('reports budgets as off until the project opts in', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exec-off-'));
    buildProject(rootDir);

    const { stdout } = await runCli(rootDir, 'show');
    expect(stdout).toContain('Tier: off');
    expect(stdout).toContain('No budgets are derived');
    // No per-agent rows while off.
    expect(stdout).not.toContain('ledger_store-implementer');
  });

  it('set-tier writes the dial back to project.yaml and show then differentiates by stereotype', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exec-set-'));
    buildProject(rootDir);

    const set = await runCli(rootDir, 'set-tier', 'default');
    expect(set.stdout).toContain('off');
    expect(set.stdout).toContain('default');

    expect(readConfig(rootDir).execution?.tier).toBe('default');

    const { stdout } = await runCli(rootDir, 'show');
    // Mechanical work drops a tier; work carrying decisions does not.
    expect(stdout).toMatch(/ledger_store-implementer\s+small/);
    expect(stdout).toMatch(/billing_flow-implementer\s+large/);
    // The rationale is shown, so the choice is auditable rather than magic.
    expect(stdout).toContain('specified by its contract and narrative');
  });

  it('warns when moving onto a tier that trades quality', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exec-warn-'));
    buildProject(rootDir);

    // logger.warn writes to stderr.
    const { stderr } = await runCli(rootDir, 'set-tier', 'aggressive');
    expect(stderr).toContain('trades quality for cost');
  });

  it('rejects an unknown tier and names the valid ones', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-exec-bad-'));
    buildProject(rootDir);

    await expect(runCli(rootDir, 'set-tier', 'banana')).rejects.toThrow(
      /off, free, default, trade, aggressive/,
    );
    // A rejected write leaves the dial where it was.
    expect(readConfig(rootDir).execution?.tier ?? 'off').toBe('off');
  });
});
