import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  loadSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  loadSubsystemSpec,
  loadComponentSpec,
  loadImplementationSpec,
  updateSpec,
  dryRunSerializeSpecs,
  invalidateSpecCache,
  workspaceFor,
} from '../../src/core/specs.js';
import { validateProject } from '../../src/core/validation.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Id-space round-trip: qualifyId (load) and the write-path relativization must
// be exact inverses. These are regression tests for two field bugs:
//  - cross-tree narrative targets silently re-namespaced on every impl re-save
//    (waffler_core::crates-portal → transpiler::crates-portal), and
//  - a root-mounted external subsystem whose qualified publicInterfaces the
//    writer schema refused, blocking `wairon lock`.
// Plus dryRunSerializeSpecs: validate must predict every refusal lock would hit.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function makeRoot(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-idspace-'));
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'root-system',
    vision: 'id-space round-trip fixture',
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
  return rootDir;
}

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: InterfaceSpec['methods']): InterfaceSpec => ({
  id, name: id, description: 'd', component: comp, methods, status: 'draft', createdAt: now, updatedAt: now,
});

/** Recursively read every yaml under dir into one blob for content assertions. */
function yamlBlob(dir: string): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out += yamlBlob(p);
    else if (entry.name.endsWith('.yaml')) out += `\n--- ${p}\n${fs.readFileSync(p, 'utf8')}`;
  }
  return out;
}

describe('standalone child: cross-tree refs are judged by the owner alone (stage 4)', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('a root-name-qualified target (waffler_core::x form, authored from a parent) is EXTERNAL_UNDECLARED from the child root', async () => {
    // Refs stored as `<parent-subsystem>::x` (NOT super::) because they were
    // authored from the parent root. From the child dir the first segment names
    // none of its subsystems, aliases or foreign providers: an undeclared
    // dependency on another project (stage 4), reported once — never a typo flood.
    rootDir = makeRoot();
    saveSpec('subsystem', subsystem('transpiler'));
    saveComponentSpec(component('transpiler-orch', 'transpiler', { dependsOn: ['waffler_core::blueprints-portal'] }));
    invalidateSpecCache();

    const { validateProject } = await import('../../src/core/validation.js');
    const res = validateProject();
    const undeclared = res.issues.filter(i => i.code === 'EXTERNAL_UNDECLARED');
    expect(undeclared.map(i => [i.specId, i.severity, i.resolution?.outcome])).toEqual([['transpiler-orch', 'error', 'forbidden']]);
    expect(res.issues.filter(i => i.code === 'INVALID_DEPENDENCY_REFERENCE')).toHaveLength(0);
  });
});

describe('keyed merges for dispatch and lifecycle arrays', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('a one-entry dispatch delta upserts by capability instead of erasing the table', () => {
    rootDir = makeRoot();
    saveSpec('subsystem', subsystem('sub-a', {
      lifecycle: [
        { phase: 'init', component: 'boot-orch', method: 'hydrate' },
        { phase: 'shutdown', component: 'boot-orch', method: 'drain' },
      ],
    }));
    saveComponentSpec(component('gateway-portal', 'sub-a', {
      componentType: 'Portal', transport: 'Custom',
      dependsOn: ['server-a', 'server-b'],
      dispatch: [
        { capability: 'a.get', component: 'server-a', method: 'get' },
        { capability: 'b.get', component: 'server-b', method: 'get' },
      ],
    } as Partial<ComponentSpec>));
    invalidateSpecCache();

    updateSpec('component', 'gateway-portal', {
      dispatch: [{ capability: 'c.get', component: 'server-a', method: 'getC' }],
    });
    invalidateSpecCache();
    const dispatch = loadComponentSpec('gateway-portal')!.dispatch!;
    expect(dispatch.map(b => b.capability).sort()).toEqual(['a.get', 'b.get', 'c.get']);

    // Upsert an existing capability + delete another.
    updateSpec('component', 'gateway-portal', {
      dispatch: [
        { capability: 'a.get', method: 'getA' },
        { capability: 'b.get', action: 'delete' },
      ],
    });
    invalidateSpecCache();
    const after = loadComponentSpec('gateway-portal')!.dispatch!;
    expect(after.find(b => b.capability === 'a.get')!.method).toBe('getA');
    expect(after.some(b => b.capability === 'b.get')).toBe(false);

    // Lifecycle: patching one entrypoint must not erase the other phase.
    updateSpec('subsystem', 'sub-a', {
      lifecycle: [{ phase: 'init', component: 'boot-orch', method: 'hydrate', description: 'boot read-back' }],
    });
    invalidateSpecCache();
    const lifecycle = loadSubsystemSpec('sub-a')!.lifecycle!;
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle.find(le => le.phase === 'shutdown')).toBeDefined();
  });
});

describe('updateSpec kind "system" (the singleton L0)', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('patches L0 fields (vision, databases) in place', () => {
    rootDir = makeRoot();
    updateSpec('system', 'root-system', {
      vision: 'revised vision',
      databases: [{ id: 'main-db', name: 'Main DB', engine: 'postgresql' }],
    });
    invalidateSpecCache();

    const system = loadSystemSpec();
    expect(system!.vision).toBe('revised vision');
    expect(system!.databases).toEqual([{ id: 'main-db', name: 'Main DB', engine: 'postgresql' }]);
    expect(system!.name).toBe('root-system');
  });

  it('rejects a mismatched id so a mis-selected kind cannot silently rewrite the L0', () => {
    rootDir = makeRoot();
    expect(() => updateSpec('system', 'some-subsystem', { description: 'oops' }))
      .toThrow(/singleton L0.*use kind "subsystem"/s);
  });
});

describe('narrative insert vs jump targets (captureJumps)', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function buildFixture(): void {
    rootDir = makeRoot();
    saveSpec('subsystem', subsystem('sub-a'));
    saveComponentSpec(component('orch-a', 'sub-a'));
    saveInterfaceSpec(iface('iorch-a', 'orch-a', [
      { name: 'run', description: 'runs', signature: 'run(): void', returns: 'void' },
    ]));
    saveImplementationSpec({
      id: 'impl-orch-a', name: 'impl', description: 'd', contract: 'iorch-a',
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, description: 'guard', type: 'branch', condition: 'ok', onFalseStep: 3 },
          { stepNumber: 2, description: 'happy path', type: 'local' },
          { stepNumber: 3, description: 'error path', type: 'local' },
        ],
      }],
      status: 'draft', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    invalidateSpecCache();
  }

  it('default insert relocates incoming jumps past the new step and returns a notice', () => {
    buildFixture();
    const { notices } = updateSpec('implementation', 'impl-orch-a', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 3, action: 'insert', description: 'inserted cleanup', type: 'local' }],
      }],
    });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/BYPASS/);
    expect(notices[0]).toMatch(/captureJumps/);

    invalidateSpecCache();
    const run = loadImplementationSpec('impl-orch-a')!.methods[0];
    expect(run.narrative).toHaveLength(4);
    // The jump followed its old referent to step 4; the inserted step at 3 is bypassed.
    expect(run.narrative.find(s => s.type === 'branch')!.onFalseStep).toBe(4);
  });

  it('captureJumps never captures a loop endStep — the region grows to keep its original last step', () => {
    rootDir = makeRoot();
    saveSpec('subsystem', subsystem('sub-a'));
    saveComponentSpec(component('loop-orch', 'sub-a'));
    saveInterfaceSpec(iface('iloop-orch', 'loop-orch', [
      { name: 'run', description: 'runs', signature: 'run(): void', returns: 'void' },
    ]));
    saveImplementationSpec({
      id: 'impl-loop-orch', name: 'impl', description: 'd', contract: 'iloop-orch',
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, description: 'retry loop', type: 'loop', loopKind: 'while', condition: 'pending', endStep: 3 },
          { stepNumber: 2, description: 'attempt', type: 'local' },
          { stepNumber: 3, description: 'record result', type: 'local' },
          { stepNumber: 4, description: 'done', type: 'return', outcome: 'success' },
        ],
      }],
      status: 'draft', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    invalidateSpecCache();

    updateSpec('implementation', 'impl-loop-orch', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 3, action: 'insert', description: 'inserted pre-record step', type: 'local', captureJumps: true }],
      }],
    });
    invalidateSpecCache();
    const run = loadImplementationSpec('impl-loop-orch')!.methods[0];
    // endStep followed the shifted original last body step: the region KEPT
    // "record result" (now step 4) and also contains the inserted step 3.
    expect(run.narrative.find(s => s.type === 'loop')!.endStep).toBe(4);
    expect(run.narrative.find(s => s.stepNumber === 4)!.description).toBe('record result');
  });

  it('captureJumps: true retargets incoming jumps onto the inserted step, no notice', () => {
    buildFixture();
    const { notices } = updateSpec('implementation', 'impl-orch-a', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 3, action: 'insert', description: 'inserted cleanup', type: 'local', captureJumps: true }],
      }],
    });
    expect(notices).toHaveLength(0);

    invalidateSpecCache();
    const run = loadImplementationSpec('impl-orch-a')!.methods[0];
    expect(run.narrative).toHaveLength(4);
    expect(run.narrative.find(s => s.type === 'branch')!.onFalseStep).toBe(3);
    // captureJumps is merge instruction, not narrative content.
    expect((run.narrative.find(s => s.description === 'inserted cleanup') as any).captureJumps).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// File paths across the id space: a chained child's implementation file paths
// are relative to the CHILD root. A write through the parent re-expresses a
// parent-relative path that lands inside the child and leaves every other path
// verbatim — so the child's own gate checks the file the author named, and
// load → save stays a fixpoint.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A member's own subsystem named after its alias is keyed under the member's
// project id at every depth (`extra::extra`), never merged with the mount — and
// a grandchild loads, validates and round-trips exactly as a first-level
// member does (stage 3).
// ---------------------------------------------------------------------------
