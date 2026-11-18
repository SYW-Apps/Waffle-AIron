import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateProject, validateAsComplete } from '../../src/core/validation.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSystemSpec, saveSpec, saveComponentSpec } from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// The validation memo, wired to its real collaborators (the spec loader, the
// files adapter, the source fingerprint and the owner's gate). The memo compares
// files by path, size and modification time, so a remembered answer is proven
// by swapping a spec's content for one of the same size with its old
// modification time: a remembered run still names the old content, a fresh one
// the new.

// Result files go to a throwaway cache folder, never the user's.
process.env.WAIRON_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-memo-cache-'));

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

  it('remembers the as-complete gate apart from the owner\'s gate', () => {
    const asComplete = () => runWithProjectRoot(root, () => validateAsComplete({ projectType: 'backend' }));
    const first = asComplete();
    expect(names(first, 'ghostaaa')).toBe(true);
    swapUnseen(root);
    // The as-complete run is remembered, as a copy ...
    const second = asComplete();
    expect(names(second, 'ghostaaa')).toBe(true);
    expect(second).not.toBe(first);
    // ... but never answers the owner's gate, which runs fresh.
    expect(names(run({ projectType: 'backend' }), 'ghostbbb')).toBe(true);
    // A change under .wai/ runs the as-complete gate again.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(workerFile(root), later, later);
    expect(names(asComplete(), 'ghostbbb')).toBe(true);
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

describe('validation memo: memory entries and the result file', () => {
  let root: string;
  let cacheDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-memo2-'));
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-memo2-cache-'));
    previous = process.env.WAIRON_CACHE_DIR;
    process.env.WAIRON_CACHE_DIR = cacheDir;
    makeProject(root);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.WAIRON_CACHE_DIR; else process.env.WAIRON_CACHE_DIR = previous;
    for (const dir of [root, cacheDir]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
    }
  });

  const entry = (n: number) => ({
    optionsKey: 'owner:k', treeFingerprint: `t${n}`, codeFingerprint: `c${n}`,
    result: { valid: true, issues: [], validatorVersion: String(n) },
  }) as never;

  it('keeps up to eight entries per root and options, newest first, found by both fingerprints', async () => {
    const memo = await import('../../src/core/validation-memo.js');
    for (let n = 1; n <= 9; n++) memo.put(root, entry(n));
    expect(memo.get(root, 'owner:k', 't1', 'c1')).toBeUndefined();
    expect(memo.get(root, 'owner:k', 't2', 'c2')).toBeDefined();
    expect(memo.get(root, 'owner:k', 't9', 'c2')).toBeUndefined();
    expect(memo.get(root, 'owner:k', 't9', 'c9')).toBeDefined();
  });

  it('answers a fresh process from the result file, and a corrupt file is a miss', async () => {
    const first = runWithProjectRoot(root, () => validateProject({ projectType: 'backend' }));
    expect(names(first, 'ghostaaa')).toBe(true);
    const resultFiles = fs.readdirSync(path.join(cacheDir, 'validation-results'));
    expect(resultFiles).toHaveLength(1);
    swapUnseenKeepingContent(root);
    // A fresh module graph has an empty memory cache: only the file can answer.
    vi.resetModules();
    const fresh = await import('../../src/core/validation-memo.js');
    const fsUtils = await import('../../src/utils/fs.js');
    const specs = await import('../../src/core/specs.js');
    specs.invalidateSpecCache();
    const second = fsUtils.runWithProjectRoot(root, () => fresh.validateProject({ projectType: 'backend' }));
    expect(second).toEqual(first);
    // Corrupt the file: the next fresh process runs the gate instead of failing.
    fs.writeFileSync(path.join(cacheDir, 'validation-results', resultFiles[0]), '{ not json');
    vi.resetModules();
    const again = await import('../../src/core/validation-memo.js');
    const fsUtils2 = await import('../../src/utils/fs.js');
    const specs2 = await import('../../src/core/specs.js');
    specs2.invalidateSpecCache();
    expect(() => fsUtils2.runWithProjectRoot(root, () => again.validateProject({ projectType: 'backend' }))).not.toThrow();
    expect(again.fileGet(root, 'owner:x', 'a', 'b')).toBeUndefined();
  });
});

/** Rewrite the worker spec with the same bytes it already has, a new modification time: the content is unchanged. */
function swapUnseenKeepingContent(root: string): void {
  const file = workerFile(root);
  fs.writeFileSync(file, fs.readFileSync(file));
  invalidateSpecCache();
}
