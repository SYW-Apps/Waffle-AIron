import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec, updateSpec,
  deleteComponentSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  captureBaseline, writeBaseline, readBaseline, clearBaseline,
  diffAgainstBaseline, diffSize, baselineDir,
} from '../../src/core/baseline.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The approval baseline.
//
// The point of storing the approved TREE rather than a hash of it: the question
// stops being "did anything move?" (the `Lock: STALE` banner on a clean tree)
// and becomes "WHAT moved?", which is the only form a human can review.
// ---------------------------------------------------------------------------

const now = '2026-09-11T10:00:00Z';

function project(name = 'baseline-sys'): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-baseline-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name, projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name, vision: 'a baseline fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the baseline domain',
    parentSystem: name, publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component',
    subsystem: 'dom', componentType: 'Specialist', dependsOn: [], owns: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  invalidateSpecCache();
  return root;
}

describe('approval baseline', () => {
  let root: string;
  let store: string;

  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-bstore-'));
    process.env['WAIRON_BASELINE_DIR'] = store;
  });

  afterEach(() => {
    delete process.env['WAIRON_BASELINE_DIR'];
    setProjectRoot(null);
    invalidateSpecCache();
    for (const d of [root, store]) {
      try { if (d) fs.rmSync(d, { recursive: true, force: true }); } catch { /* win locks */ }
    }
  });

  it('never writes inside the project — approving must not dirty the repo', () => {
    root = project();
    const before = fs.readdirSync(path.join(root, '.wai'));

    writeBaseline(captureBaseline('local:tester'));

    expect(fs.readdirSync(path.join(root, '.wai'))).toEqual(before);
    expect(baselineDir()).toBe(store);
    expect(fs.readdirSync(store)).toHaveLength(1);
  });

  it('distinguishes "never approved" from "approved and unchanged"', () => {
    root = project();
    expect(diffAgainstBaseline()).toBeNull();

    writeBaseline(captureBaseline('local:tester'));
    const d = diffAgainstBaseline()!;
    expect(d).not.toBeNull();
    expect(diffSize(d)).toBe(0);
    expect(d.unchangedPaths.length).toBeGreaterThan(0);
  });

  it('names WHAT changed, not merely that something did', () => {
    root = project();
    writeBaseline(captureBaseline('local:tester'));

    updateSpec('component', 'worker', { description: 'a revised worker component' });
    invalidateSpecCache();

    const d = diffAgainstBaseline()!;
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatch(/worker/);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('reports an added spec', () => {
    root = project();
    writeBaseline(captureBaseline('local:tester'));

    saveComponentSpec({
      id: 'second', name: 'Second', description: 'a second component',
      subsystem: 'dom', componentType: 'Specialist', dependsOn: [], owns: [],
      status: 'draft', createdAt: now, updatedAt: now,
    } as ComponentSpec);
    invalidateSpecCache();

    const d = diffAgainstBaseline()!;
    expect(d.added.some((p) => p.includes('second'))).toBe(true);
    expect(d.changed).toEqual([]);
  });

  it('reports a removed spec', () => {
    root = project();
    writeBaseline(captureBaseline('local:tester'));

    deleteComponentSpec('worker');
    invalidateSpecCache();

    const d = diffAgainstBaseline()!;
    expect(d.removed.some((p) => p.includes('worker'))).toBe(true);
  });

  it('re-approving clears the diff', () => {
    root = project();
    writeBaseline(captureBaseline('local:tester'));
    updateSpec('component', 'worker', { description: 'a revised worker component' });
    invalidateSpecCache();
    expect(diffSize(diffAgainstBaseline()!)).toBe(1);

    writeBaseline(captureBaseline('local:tester'));
    expect(diffSize(diffAgainstBaseline()!)).toBe(0);
  });

  it('keys by project root, so two projects never share an approval', () => {
    root = project('alpha-sys');
    writeBaseline(captureBaseline('local:tester'));

    const other = project('beta-sys');
    try {
      // A different root has its own (absent) baseline.
      expect(diffAgainstBaseline()).toBeNull();
      expect(fs.readdirSync(store)).toHaveLength(1);
    } finally {
      setProjectRoot(null);
      try { fs.rmSync(other, { recursive: true, force: true }); } catch { /* win */ }
    }
  });

  it('carries child pins, so a parent can review a child moving without being dirtied by it', () => {
    root = project();
    const rec = captureBaseline('local:tester', { billing: 'sha256:abc123' });
    writeBaseline(rec);

    expect(readBaseline()!.children).toEqual({ billing: 'sha256:abc123' });
    // The pin is metadata about a child; it does not appear as a local change.
    expect(diffSize(diffAgainstBaseline()!)).toBe(0);
  });

  it('reads a corrupt baseline as "never approved" rather than throwing', () => {
    root = project();
    writeBaseline(captureBaseline('local:tester'));
    const [file] = fs.readdirSync(store);
    fs.writeFileSync(path.join(store, file), '{ not json');

    expect(readBaseline()).toBeNull();
    expect(diffAgainstBaseline()).toBeNull();
  });

  it('clearBaseline forgets the approval', () => {
    root = project();
    writeBaseline(captureBaseline('local:tester'));
    expect(clearBaseline()).toBe(true);
    expect(readBaseline()).toBeNull();
    expect(clearBaseline()).toBe(false);
  });

  it('records the gate identity and who approved it', () => {
    root = project();
    const rec = captureBaseline('local:robbe');
    expect(rec.approvedBy).toBe('local:robbe');
    expect(rec.systemName).toBe('baseline-sys');
    expect(rec.stateId.digest).toBeTruthy();
    expect(rec.projectRoot).toBe(path.resolve(root));
  });
});
