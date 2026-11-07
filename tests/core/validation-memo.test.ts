import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateProject } from '../../src/core/validation.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSystemSpec, saveSpec, saveComponentSpec } from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// The validation memo, wired to its real collaborators (the spec loader, the
// files adapter, the source fingerprint and the owner's gate). The memo compares
// files by path, size and modification time, so a remembered answer is proven
// by swapping a spec's content for one of the same size with its old
// modification time: a remembered run still names the old content, a fresh one
// the new.

const now = '2026-11-07T10:00:00Z';

function makeProject(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'memo-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  runWithProjectRoot(root, () => {
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'memo-sys', vision: 'a memo fixture',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    saveSpec('subsystem', {
      id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'memo-sys',
      publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    saveComponentSpec({
      id: 'worker', name: 'Worker', description: 'a worker component', subsystem: 'dom',
      componentType: 'Orchestrator', dependsOn: ['ghostaaa'], owns: [], status: 'draft', createdAt: now, updatedAt: now,
    } as ComponentSpec);
  });
  // A whole-second modification time, which a later swap can restore exactly.
  fs.utimesSync(workerFile(root), FIXED, FIXED);
  invalidateSpecCache();
}

const FIXED = new Date('2026-01-01T00:00:00Z');

/** The worker's spec file. */
function workerFile(root: string): string {
  return path.join(root, '.wai', 'specs', 'dom', 'worker', '.index.yaml');
}

/** Rename the worker's missing dependency in place, keeping the file's size and modification time. */
function swapUnseen(root: string): void {
  const file = workerFile(root);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('ghostaaa').join('ghostbbb'));
  fs.utimesSync(file, FIXED, FIXED);
  invalidateSpecCache();
}

/** Whether the run's findings name this dependency id. */
function names(result: ReturnType<typeof validateProject>, id: string): boolean {
  return result.issues.some((i) => i.message.includes(id));
}

describe('validation memo', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-memo-'));
    makeProject(root);
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  const run = (options?: Parameters<typeof validateProject>[0]) =>
    runWithProjectRoot(root, () => validateProject(options));

  it('answers an identical run from memory while nothing it reads changed, as a copy', () => {
    const first = run({ projectType: 'backend' });
    expect(names(first, 'ghostaaa')).toBe(true);
    swapUnseen(root);
    const second = run({ projectType: 'backend' });
    expect(names(second, 'ghostaaa')).toBe(true);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    second.issues.length = 0;
    expect(run({ projectType: 'backend' }).issues.length).toBe(first.issues.length);
  });

  it('runs the gate again for other options', () => {
    run({ projectType: 'backend' });
    swapUnseen(root);
    expect(names(run({ projectType: 'backend', treatAllAsComplete: true }), 'ghostbbb')).toBe(true);
  });

  it('runs the gate again once a file under .wai/ changed', () => {
    run({ projectType: 'backend' });
    swapUnseen(root);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(workerFile(root), later, later);
    expect(names(run({ projectType: 'backend' }), 'ghostbbb')).toBe(true);
  });

  it('runs the gate again once a declared member folder changed', () => {
    const member = path.join(root, 'services', 'part');
    fs.mkdirSync(path.join(member, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(member, '.wai', 'note.txt'), 'one');
    const config = JSON.parse(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8'));
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({ ...config, members: { part: 'services/part' } }));
    invalidateSpecCache();
    run({ projectType: 'backend' });
    swapUnseen(root);
    expect(names(run({ projectType: 'backend' }), 'ghostaaa')).toBe(true);
    fs.writeFileSync(path.join(member, '.wai', 'note.txt'), 'two, longer');
    expect(names(run({ projectType: 'backend' }), 'ghostbbb')).toBe(true);
  });
});
