import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec, updateSpec, loadComponentSpecs,
  deleteComponentSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  captureBaseline, writeBaseline, readBaseline, clearBaseline,
  diffAgainstBaseline, diffSize, baselineDir, currentChildPins, movedChildren, pinOf,
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

  it('carries child pins as metadata, not as local changes', () => {
    root = project();
    const rec = captureBaseline('local:tester', { billing: 'sha256:abc123' });
    writeBaseline(rec);

    expect(readBaseline()!.children).toEqual({ billing: 'sha256:abc123' });
    expect(diffSize(diffAgainstBaseline()!)).toBe(0);
  });

  it('excludes a REAL chained child’s specs — a child edit must not dirty the parent', () => {
    // Regression. `snapshotSpecFiles` federates recursively, so the parent
    // baseline captured every child spec file: approving the parent silently
    // froze work it does not own, and any child edit showed up in the parent's
    // diff — the exact thing the child PIN exists to replace. The earlier test
    // used a fake pin with no mounted child, so it could not see this.
    root = project();

    // A real mount: the parent subsystem carries projectPath, and the child has
    // its own spec tree on disk underneath it.
    saveSubsystemSpec({
      id: 'billing', name: 'billing', description: 'a chained billing domain',
      parentSystem: 'baseline-sys', publicInterfaces: [], trustedLinks: [],
      projectPath: 'packages/billing',
      status: 'draft', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    const childSpecs = path.join(root, 'packages', 'billing', '.wai', 'specs');
    fs.mkdirSync(path.join(childSpecs, 'subsystems'), { recursive: true });
    fs.mkdirSync(path.join(childSpecs, 'components'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'billing', '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'billing-sys', projectType: 'backend',
      targets: [], rules: {}, createdAt: now, updatedAt: now,
    }));
    const stamp = `createdAt: '${now}'
updatedAt: '${now}'`;
    fs.writeFileSync(path.join(childSpecs, '.index.yaml'),
      `schemaVersion: 1.0.0
name: billing-sys
vision: the child system
${stamp}
`);
    fs.writeFileSync(path.join(childSpecs, 'subsystems', 'ledger.yaml'),
      `schemaVersion: 1.0.0
id: ledger
name: ledger
description: the child ledger domain
parentSystem: billing-sys
${stamp}
`);
    // A COMPONENT is what makes the child appear in the federated spec index —
    // snapshotSpecFiles pulls from index.paths, not from raw directories.
    const childComp = path.join(childSpecs, 'components', 'ledger_store.yaml');
    fs.writeFileSync(childComp,
      `schemaVersion: 1.0.0
id: ledger_store
name: Ledger Store
description: the child store
subsystem: ledger
componentType: Store
dependsOn: []
owns: []
${stamp}
`);
    invalidateSpecCache();

    // Sanity: the child IS federated into the parent's index, so this fixture
    // genuinely exercises the recursion the bug rode on.
    expect(loadComponentSpecs().some((c) => c.id.includes('ledger_store'))).toBe(true);

    writeBaseline(captureBaseline('local:tester'));

    // No child path was captured…
    const approved = Object.keys(readBaseline()!.specs);
    expect(approved.some((p) => p.includes('packages/billing'))).toBe(false);

    // …and editing the child leaves the parent's diff empty.
    fs.writeFileSync(childComp,
      `schemaVersion: 1.0.0
id: ledger_store
name: Ledger Store
description: the child store, revised
subsystem: ledger
componentType: Store
dependsOn: []
owns: []
${stamp}
`);
    invalidateSpecCache();
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

  // -------------------------------------------------------------------------
  // Child pins — the one thing that crosses between separately-approved trees.
  // -------------------------------------------------------------------------

  it('pins only children that have an approval of their own', () => {
    root = project();
    const childRoot = path.join(root, 'packages', 'billing');
    fs.mkdirSync(path.join(childRoot, '.wai'), { recursive: true });

    const mounts = [{ id: 'billing', projectPath: 'packages/billing' }];
    // The child has never been approved — a parent cannot record a decision
    // its owner never made.
    expect(currentChildPins(mounts, root)).toEqual({});

    // Give the child its own approval.
    const childBaseline = { ...captureBaseline('local:child'), projectRoot: path.resolve(childRoot) };
    writeBaseline(childBaseline);

    const pins = currentChildPins(mounts, root);
    expect(pins.billing).toBe(pinOf(childBaseline.stateId));
  });

  it('a child moving is visible to the parent WITHOUT dirtying the parent diff', () => {
    root = project();
    const childRoot = path.join(root, 'packages', 'billing');
    fs.mkdirSync(path.join(childRoot, '.wai'), { recursive: true });
    const mounts = [{ id: 'billing', projectPath: 'packages/billing' }];

    // Child approved, then the parent approves and pins it.
    const first = { ...captureBaseline('local:child'), projectRoot: path.resolve(childRoot) };
    writeBaseline(first);
    writeBaseline(captureBaseline('local:parent', currentChildPins(mounts, root), root));
    expect(movedChildren(mounts, root)).toEqual([]);

    // The child re-approves at a different state.
    const second = {
      ...first,
      stateId: { ...first.stateId, digest: 'f'.repeat(64) },
    };
    writeBaseline(second);

    const moved = movedChildren(mounts, root);
    expect(moved).toHaveLength(1);
    expect(moved[0].id).toBe('billing');
    expect(moved[0].now).toBe(pinOf(second.stateId));

    // …and the parent's OWN spec diff is untouched by it.
    expect(diffSize(diffAgainstBaseline()!)).toBe(0);
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
