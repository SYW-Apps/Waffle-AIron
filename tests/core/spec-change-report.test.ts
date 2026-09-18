import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec,
  saveInterfaceSpec, saveImplementationSpec, updateSpec,
  loadComponentSpec, loadImplementationSpec, loadInterfaceSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Two lies an authoring write used to tell.
//
// A1 — "Successfully updated" was the answer whether the delta rewrote a
//      narrative or landed nowhere at all. A write that changed nothing still
//      re-stamped updatedAt and reported success, so an edit that never
//      happened was indistinguishable from one that did.
//
// A2 — `unset` was a verb at the TOP level only. Nested, it was neither field
//      nor verb: it merged onto the element as data, the writer schema
//      stripped it, and the caller was told the write succeeded. A method's
//      `symbol`, a step's `label`, could be set and never cleared. `[]` had
//      the same hole one level down: a method's `narrative: []` meant "upsert
//      no steps" and left the narrative in place.
// ---------------------------------------------------------------------------

const now = '2026-09-18T10:00:00Z';

function project(): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-report-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'report', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'report', vision: 'change-report fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the reporting domain',
    parentSystem: 'report', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component',
    subsystem: 'dom', componentType: 'Orchestrator', dependencyClass: 'pure', dependsOn: [], owns: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iworker', name: 'iworker', description: 'contract', component: 'worker',
    methods: [
      {
        name: 'runJourney', description: 'runs', signature: 'runJourney(): void',
        params: [], returns: 'void', invokedBy: { kind: 'runtime', caller: 'the scheduler ticks it every minute' },
      },
    ],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  saveImplementationSpec({
    id: 'worker-impl', name: 'worker-impl', description: 'impl', contract: 'iworker',
    detailLevel: 'sketch', technologies: [],
    methods: [{
      name: 'runJourney',
      symbol: 'run_journey',
      narrative: [
        { stepNumber: 1, description: 'first', type: 'local', label: 'entry' },
        { stepNumber: 2, description: 'second', type: 'local' },
      ],
    }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as ImplementationSpec);
  invalidateSpecCache();
  return root;
}

/** Every spec file under the tree, keyed by path — the only witness of a write. */
function specFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full] = fs.readFileSync(full, 'utf-8');
    }
  };
  walk(path.join(root, '.wai', 'specs'));
  return out;
}

describe('A1 — a write that changes nothing writes nothing and says so', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  it('reports written: false and leaves the file byte-identical', () => {
    root = project();
    const before = specFiles(root);

    const report = updateSpec('component', 'worker', { description: 'a worker component' });

    expect(specFiles(root)).toEqual(before); // updatedAt not re-stamped
    expect(report.written).toBe(false);
    expect(report.changes).toEqual([]);
    expect(report.summary).toContain('nothing was written');
  });

  it('reports written: true and names every change it made', () => {
    root = project();
    const report = updateSpec('component', 'worker', { description: 'a better worker component' });

    expect(report.written).toBe(true);
    expect(report.summary).toContain('1 change');
    expect(report.changes).toContainEqual({
      path: 'description',
      change: 'set',
      before: 'a worker component',
      after: 'a better worker component',
    });
    invalidateSpecCache();
    expect(loadComponentSpec('worker')?.description).toBe('a better worker component');
  });

  it('addresses a change inside a narrative by step, not by index', () => {
    root = project();
    const report = updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', narrative: [{ stepNumber: 2, description: 'second, revised' }] }],
    });

    expect(report.written).toBe(true);
    expect(report.changes.map(c => c.path)).toContain('methods.runJourney.narrative.step 2.description');
  });
});

describe('A2 — unset and [] are verbs at every level', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  const method = () => loadImplementationSpec('worker-impl')!.methods[0] as Record<string, any>;

  it('honours a METHOD-level unset instead of reporting success for a no-op', () => {
    root = project();
    expect(method().symbol).toBe('run_journey');

    const report = updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', unset: ['symbol'] }],
    });

    invalidateSpecCache();
    expect(method().symbol).toBeUndefined();
    expect('unset' in method()).toBe(false); // the verb never lands as data
    expect(report.written).toBe(true);
    expect(report.changes).toContainEqual({
      path: 'methods.runJourney.symbol', change: 'removed', before: 'run_journey',
    });
  });

  it('honours a STEP-level unset', () => {
    root = project();
    updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', narrative: [{ stepNumber: 1, unset: ['label'] }] }],
    });

    invalidateSpecCache();
    const step = method().narrative[0];
    expect(step.label).toBeUndefined();
    expect('unset' in step).toBe(false);
    expect(step.description).toBe('first'); // nothing else disturbed
  });

  it('honours an INTERFACE-method-level unset', () => {
    root = project();
    const report = updateSpec('interface', 'iworker', {
      methods: [{ name: 'runJourney', unset: ['invokedBy'] }],
    });

    invalidateSpecCache();
    const m = loadInterfaceSpec('iworker')!.methods[0] as Record<string, any>;
    expect(m.invokedBy).toBeUndefined();
    expect('unset' in m).toBe(false);
    expect(report.written).toBe(true);
  });

  it('clears a method narrative with []', () => {
    root = project();
    const report = updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', narrative: [] }],
    });

    invalidateSpecCache();
    expect(method().narrative).toEqual([]);
    expect(report.written).toBe(true);
  });

  it('an unset naming a field that is not there changes nothing — and says so', () => {
    root = project();
    const report = updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', unset: ['sourcePath'] }],
    });

    expect(report.written).toBe(false);
    expect(report.summary).toContain('nothing was written');
  });
});
