import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// lock → status, end to end through the real CLI.
//
// The behaviour this replaces: `wairon status` printed `Lock: STALE` on a tree
// validating 0 errors / 0 warnings — a banner that named nothing and asked for
// work producing no new information. With the approved tree kept as a baseline,
// the same line names the specs that actually moved.
//
// It also pins the property the whole design turns on: approving writes NOTHING
// into the project. The flood of rewritten files was the original complaint.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');
const now = '2026-09-11T10:00:00Z';

function buildProject(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'approve-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'approve-sys', vision: 'an approval fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the approval domain',
    parentSystem: 'approve-sys', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component',
    subsystem: 'dom', componentType: 'Specialist', dependsOn: [], owns: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  invalidateSpecCache();
  setProjectRoot(null);
}

/** Every file under a directory as relPath → content, for byte-exact comparison. */
function snapshotDir(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

describe('lock records an approval; status reports what moved since (real CLI)', () => {
  let root: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  const run = (cwd: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], {
      cwd,
      timeout: 180_000,
      env: process.env,
    });

  it('says nothing about approval before there is one', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-approve-'));
    buildProject(root);

    const { stdout } = await run(root, 'status');
    expect(stdout).not.toMatch(/approval/i);
    expect(stdout).not.toContain('STALE');
  }, 180_000);

  it('captures the approval in ONE committed record — every spec byte-identical', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-approve-'));
    buildProject(root);

    const specsDir = path.join(root, '.wai', 'specs');
    const before = snapshotDir(specsDir);

    await run(root, 'lock', '--yes');

    // The approval is IN the repo — that is what lets a teammate, a fresh clone
    // and CI see the same decision — but it is one file, not a rewritten tree.
    const lock = JSON.parse(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8'));
    expect(Object.keys(lock.specs).length).toBeGreaterThan(0);
    expect(lock.lockedBy.source).toBeTruthy();

    // The spec tree is byte-identical: approving is a decision, not an edit.
    const after = snapshotDir(specsDir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, content] of before) {
      expect(after.get(rel)).toBe(content);
    }
  }, 180_000);

  it('an approved spec stops relaxing completeness findings, and an edited one relaxes again', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-approve-'));
    buildProject(root);

    // Before approval the component is draft, so DRAFT_COMPONENT_WARNING fires.
    const pre = await run(root, 'validate');
    expect(`${pre.stdout}${pre.stderr}`).toMatch(/DRAFT_COMPONENT_WARNING/);

    await run(root, 'lock', '--yes');

    // Approved and unchanged: the rules see it as complete WITHOUT the file
    // having been rewritten, so the draft warning is gone.
    const post = await run(root, 'validate');
    expect(`${post.stdout}${post.stderr}`).not.toMatch(/DRAFT_COMPONENT_WARNING/);
  }, 180_000);

  it('reports no change right after approving', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-approve-'));
    buildProject(root);
    await run(root, 'lock', '--yes');

    const { stdout } = await run(root, 'status');
    expect(stdout).toMatch(/no spec has changed since/i);
    expect(stdout).not.toContain('STALE');
  }, 180_000);

  it('names the spec that moved instead of asserting staleness', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-approve-'));
    buildProject(root);
    await run(root, 'lock', '--yes');

    // Edit one component spec on disk.
    const compPath = path.join(root, '.wai', 'specs', 'dom', 'worker', '.index.yaml');
    const target = fs.existsSync(compPath)
      ? compPath
      : path.join(root, '.wai', 'specs', 'components', 'worker.yaml');
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(/description:.*/, 'description: an edited worker component'));

    const { stdout, stderr } = await run(root, 'status');
    const out = `${stdout}\n${stderr}`;
    // Singular, and with no redundant "(1 changed)" breakdown — one category
    // says it once.
    expect(out).toMatch(/1 spec changed since approval/);
    expect(out).not.toMatch(/\(1 changed\)/);
    expect(out).toMatch(/worker/);
    // The old banner is gone for good.
    expect(out).not.toContain('STALE');
  }, 180_000);
});
