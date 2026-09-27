/**
 * The CLI's member commands: `wairon member add|move|internalize`,
 * `wairon subsystem externalize`, and `wairon init` run inside a parent
 * project. A member is declared in the parent's project.yaml `members` and
 * scaffolded as a project of its own; nothing is written into the parent's
 * spec tree, and the L1 mount form (`wairon subsystem add --project-path`,
 * retired in stage 3) is never written.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache, loadSubsystemSpec, saveSpec, saveSystemSpec } from '../../src/core/specs.js';
import { runMemberAdd, runMemberMove, runMemberInternalize, runSubsystemExternalize } from '../../src/commands/subsystem.js';
import type { SubsystemSpec } from '../../src/models/index.js';

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();
let roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
  roots = [];
  invalidateSpecCache();
});

/** An initialized parent project with an L0, bound as the project root. */
function parentProject(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cli-member-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'clinic', name: 'clinic', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
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

/** A root's `members`, as its project.yaml holds them. */
const membersOf = (root: string): unknown => (readYamlFile(path.join(root, '.wai', 'project.yaml')) as { members?: unknown }).members;

describe('wairon member add|move|internalize', () => {
  it('member add scaffolds the member project and declares it in `members` — no L1 spec is written', async () => {
    const root = parentProject();
    const output = captureOutput();
    await runMemberAdd('billing', 'services/billing', { description: 'Invoices' });

    expect(membersOf(root)).toEqual({ billing: { path: 'services/billing', description: 'Invoices' } });
    expect(fs.existsSync(path.join(root, 'services', 'billing', '.wai', 'project.yaml'))).toBe(true);
    expect((readYamlFile(path.join(root, 'services', 'billing', '.wai', 'project.yaml')) as { id?: string }).id).toBe('billing');
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')).toBeNull();
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'billing'))).toBe(false);
    expect(output()).toContain('Added member "billing" → services/billing');
  });

  it('member add again changes nothing; a different path under the alias is refused', async () => {
    const root = parentProject();
    captureOutput();
    await runMemberAdd('billing', 'services/billing');
    const before = fs.readFileSync(path.join(root, '.wai', 'project.yaml'));
    await runMemberAdd('billing', 'services/billing');
    expect(fs.readFileSync(path.join(root, '.wai', 'project.yaml')).equals(before)).toBe(true);
    await expect(runMemberAdd('billing', 'services/other')).rejects.toThrow(/already declared/);
  });

  it('member add requires a path, and an initialized project', async () => {
    parentProject();
    captureOutput();
    await expect(runMemberAdd('billing', '')).rejects.toThrow('a path is required: wairon member add <alias> <path>');
    const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cli-bare-')));
    roots.push(bare);
    setProjectRoot(bare);
    await expect(runMemberAdd('billing', 'services/billing')).rejects.toThrow(/Not inside an initialized wairon project/);
  });

  it('member move relocates a member, and moves a legacy L1 mount into `members` first', async () => {
    const root = parentProject();
    const output = captureOutput();
    await runMemberAdd('billing', 'services/billing');
    await runMemberMove('billing', 'modules/billing');
    expect(membersOf(root)).toEqual({ billing: 'modules/billing' });
    expect(fs.existsSync(path.join(root, 'modules', 'billing', '.wai', 'project.yaml'))).toBe(true);
    expect(output()).toContain('Moved member "billing" → modules/billing');

    // A legacy mount, as a pre-stage-3 wairon wrote it.
    saveSpec('subsystem', {
      id: 'claims', name: 'claims', description: 'Claims', parentSystem: 'Clinic', publicInterfaces: [], trustedLinks: [],
      projectPath: 'services/claims', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    fs.mkdirSync(path.join(root, 'services', 'claims', '.wai', 'specs'), { recursive: true });
    invalidateSpecCache();
    await runMemberMove('claims', 'modules/claims');
    expect(membersOf(root)).toEqual({ billing: 'modules/billing', claims: { path: 'modules/claims', description: 'Claims' } });
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'claims', '.index.yaml'))).toBe(false);
  });

  it('member move requires a new path', async () => {
    parentProject();
    captureOutput();
    await expect(runMemberMove('billing', '')).rejects.toThrow('a new path is required: wairon member move <alias> <path>');
  });

  it('subsystem externalize --path turns a subsystem into a member, and member internalize takes it back', async () => {
    const root = parentProject();
    const output = captureOutput();
    saveSpec('subsystem', {
      id: 'pharmacy', name: 'Pharmacy', description: 'Dispenses', parentSystem: 'Clinic', publicInterfaces: [], trustedLinks: [],
      createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    invalidateSpecCache();

    await expect(runSubsystemExternalize('pharmacy', {})).rejects.toThrow("--path (the member's destination) is required.");
    await runSubsystemExternalize('pharmacy', { path: 'services/pharmacy' });
    expect(membersOf(root)).toEqual({ pharmacy: 'services/pharmacy' });
    expect(output()).toContain('Externalized subsystem "pharmacy" → member at services/pharmacy');
    expect(output()).toContain('wairon doctor --fix');

    await runMemberInternalize('pharmacy');
    expect(membersOf(root)).toBeUndefined();
    invalidateSpecCache();
    expect(loadSubsystemSpec('pharmacy')?.name).toBe('Pharmacy');
    expect(fs.existsSync(path.join(root, 'services', 'pharmacy', '.wai'))).toBe(false);
    expect(output()).toContain('Internalized member "pharmacy" into this project.');
  });
});

describe('the retired subsystem commands (real CLI)', () => {
  it('wairon subsystem add and move are gone, with no aliases; member add is the command', async () => {
    const { stdout } = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'subsystem', '--help'], { timeout: 180_000 });
    expect(stdout).toContain('externalize');
    expect(stdout).not.toMatch(/^\s+add\b/m);
    expect(stdout).not.toMatch(/^\s+move\b/m);
    expect(stdout).not.toMatch(/^\s+internalize\b/m);
    const member = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'member', '--help'], { timeout: 180_000 });
    expect(member.stdout).toMatch(/add \[options\] <alias> <path>/);
    expect(member.stdout).toMatch(/move <alias> <path>/);
    expect(member.stdout).toMatch(/internalize <alias>/);
  }, 360_000);
});

describe('wairon init inside a parent project (real CLI)', () => {
  it('declares this directory a member of the parent and scaffolds it — no L1 spec in the parent', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-init-child-')));
    roots.push(parent);
    await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '--yes'], { cwd: parent, timeout: 180_000 });
    const child = path.join(parent, 'services', 'pharmacy');
    fs.mkdirSync(child, { recursive: true });

    const { stdout } = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '--yes'], { cwd: child, timeout: 180_000 });

    expect(stdout).toContain('Created "services/pharmacy" as the member "pharmacy" of the parent project.');
    expect(membersOf(parent)).toEqual({ pharmacy: 'services/pharmacy' });
    setProjectRoot(parent);
    invalidateSpecCache();
    expect(loadSubsystemSpec('pharmacy')).toBeNull();
    expect((readYamlFile(path.join(child, '.wai', 'project.yaml')) as { id?: string }).id).toBe('pharmacy');
  }, 360_000);
});
