/**
 * The CLI's authoring door: `wairon subsystem add` and `wairon init` run
 * inside a parent project author a subsystem, so they write through the gated
 * authoring seam (cli_authoring_adapter.writeSpec) exactly as the MCP tools
 * do. The rules for re-authoring a spec then hold whichever door the author
 * came through: what the command cannot say (a published surface, trusted
 * links, a raised status) is carried, and re-running the command on an
 * existing id re-authors in place and says so — it used to overwrite the
 * subsystem with an empty surface at draft.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache, loadSubsystemSpec, saveSystemSpec, updateSpec } from '../../src/core/specs.js';
import { runSubsystemAdd } from '../../src/commands/subsystem.js';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();
let roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
  roots = [];
  invalidateSpecCache();
});

/** An initialized parent project with an L0, bound as the project root. */
function parentProject(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cli-door-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'clinic', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'Clinic', vision: 'books visits', boundaries: [], globalRequirements: [], databases: [], createdAt: now, updatedAt: now });
  invalidateSpecCache();
  return root;
}

/** Everything the command printed, stdout and stderr alike. */
function captureOutput(): () => string {
  const lines: string[] = [];
  const keep = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'warn').mockImplementation(keep);
  return () => lines.join('\n');
}

describe('wairon subsystem add writes through the authoring seam', () => {
  it('adds a new chained subsystem at draft and scaffolds its child project', async () => {
    const root = parentProject();
    const output = captureOutput();
    await runSubsystemAdd('billing', { projectPath: 'services/billing', name: 'Billing' });

    invalidateSpecCache();
    const sub = loadSubsystemSpec('billing');
    expect(sub).toMatchObject({ id: 'billing', name: 'Billing', parentSystem: 'Clinic', projectPath: 'services/billing', status: 'draft' });
    expect(sub?.publicInterfaces).toEqual([]);
    expect(fs.existsSync(path.join(root, 'services', 'billing', '.wai', 'project.yaml'))).toBe(true);
    expect(output()).toContain('Added external subsystem "billing" → services/billing');
  });

  it('run twice on one id keeps the published surface, trusted links and status stored between the runs', async () => {
    parentProject();
    captureOutput();
    await runSubsystemAdd('billing', { projectPath: 'services/billing' });
    await runSubsystemAdd('claims', { projectPath: 'services/claims' });
    const surface = [{ type: 'Custom' as const, details: 'invoice writes', component: 'invoice_portal', consumers: ['claims'] }];
    updateSpec('subsystem', 'billing', {
      description: 'Invoicing and payment collection',
      publicInterfaces: surface,
      trustedLinks: [{ subsystem: 'claims', reason: 'in-process claim hand-off' }],
      status: 'design',
    });

    const output = captureOutput();
    await runSubsystemAdd('billing', { projectPath: 'services/billing', name: 'Billing' });

    invalidateSpecCache();
    const sub = loadSubsystemSpec('billing');
    expect(sub?.name).toBe('Billing');                                   // --name is the command's to state
    expect(sub?.description).toBe('Invoicing and payment collection');  // the placeholder is only for a new one
    // billing is chained, so its members load qualified by its id.
    expect(sub?.publicInterfaces).toEqual([{ ...surface[0], component: 'billing::invoice_portal' }]);
    expect(sub?.trustedLinks).toEqual([{ subsystem: 'claims', reason: 'in-process claim hand-off' }]);
    expect(sub?.status).toBe('design');
    // The re-authoring is announced, not silent.
    expect(output()).toContain('already existed — re-authored in place');
    expect(output()).toMatch(/Carried forward \(not expressible through this tool\):.*description.*publicInterfaces/);
  });

  it('a re-run without --name keeps the stored name', async () => {
    parentProject();
    captureOutput();
    await runSubsystemAdd('billing', { projectPath: 'services/billing', name: 'Billing' });
    await runSubsystemAdd('billing', { projectPath: 'services/billing' });
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')).toMatchObject({ name: 'Billing', description: 'External subsystem Billing' });
  });
});

describe('wairon init inside a parent project (real CLI)', () => {
  it('wires the parent subsystem through the seam and scaffolds this directory as the child', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-child-')));
    roots.push(parent);
    await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '--yes'], { cwd: parent, timeout: 180_000 });
    const child = path.join(parent, 'services', 'pharmacy');
    fs.mkdirSync(child, { recursive: true });

    const { stdout } = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '--yes'], { cwd: child, timeout: 180_000 });

    expect(stdout).toContain('Created "pharmacy" as an external subsystem of the parent project.');
    setProjectRoot(parent);
    invalidateSpecCache();
    const sub = loadSubsystemSpec('pharmacy');
    expect(sub).toMatchObject({ id: 'pharmacy', name: 'pharmacy', projectPath: 'services/pharmacy', status: 'draft' });
    expect(sub?.parentSystem).toBeTruthy();
    expect(fs.existsSync(path.join(child, '.wai', 'project.yaml'))).toBe(true);
  }, 360_000);
});
