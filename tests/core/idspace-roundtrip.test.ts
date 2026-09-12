import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  loadSystemSpec,
  saveSubsystemSpec,
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
import { createChainedSubsystem } from '../../src/core/provision.js';
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

describe('cross-tree narrative targets survive re-save (the re-namespacing bug)', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function buildFixture(): string {
    rootDir = makeRoot();
    // Root-level component the child references across the tree.
    saveSubsystemSpec(subsystem('core-sub'));
    saveComponentSpec(component('crates-portal', 'core-sub', { componentType: 'Portal', portalType: 'Custom' } as Partial<ComponentSpec>));

    // Chained child project mounted as "transpiler".
    createChainedSubsystem(subsystem('transpiler', { projectPath: 'packages/transpiler' }), 'transpiler');
    const childDir = path.join(rootDir, 'packages', 'transpiler');
    const child = workspaceFor(childDir);
    child.saveSubsystemSpec(subsystem('transpiler', { parentSystem: 'transpiler' }));
    child.saveComponentSpec(component('transpiler-orch', 'transpiler', { dependsOn: ['super::crates-portal'] }));
    child.saveInterfaceSpec(iface('itranspiler-orch', 'transpiler-orch', [
      { name: 'run', description: 'runs', signature: 'run(): void', returns: 'void' },
      { name: 'other', description: 'other', signature: 'other(): void', returns: 'void' },
    ]));
    child.saveImplementationSpec({
      id: 'transpiler-impl', name: 'impl', description: 'd', contract: 'itranspiler-orch',
      methods: [
        {
          name: 'run',
          narrative: [
            { stepNumber: 1, description: 'fetch from the parent portal', type: 'call', targetComponent: 'super::crates-portal', targetMethod: 'fetch' },
          ],
        },
        { name: 'other', narrative: [{ stepNumber: 1, description: 'noop', type: 'local' }] },
      ],
      status: 'draft', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    invalidateSpecCache();
    return childDir;
  }

  it('load → save → load is a fixpoint for a super:: cross-tree target', () => {
    const childDir = buildFixture();

    const loaded = loadImplementationSpec('transpiler::transpiler-impl');
    expect(loaded).not.toBeNull();
    // In memory the super:: form resolves to the root-level id.
    expect(loaded!.methods[0].narrative[0].targetComponent).toBe('crates-portal');

    // Re-save the whole impl through the PARENT workspace (what any edit does).
    saveImplementationSpec(loaded!);
    invalidateSpecCache();

    const reloaded = loadImplementationSpec('transpiler::transpiler-impl');
    // THE bug: this used to come back as "transpiler::crates-portal".
    expect(reloaded!.methods[0].narrative[0].targetComponent).toBe('crates-portal');

    // On disk the child file must carry a relative form, never the bare last
    // segment (which re-qualifies into the child namespace on load).
    const childBlob = yamlBlob(path.join(childDir, '.wai'));
    expect(childBlob).toMatch(/targetComponent: ['"]?(::|super::)crates-portal/);

    // Second cycle stays fixed.
    saveImplementationSpec(reloaded!);
    invalidateSpecCache();
    expect(loadImplementationSpec('transpiler::transpiler-impl')!.methods[0].narrative[0].targetComponent).toBe('crates-portal');
  });

  it('editing ONE method via updateSpec re-serializes the file without corrupting cross-tree targets', () => {
    buildFixture();

    // The field report: touching ANY method rewrote the whole impl and
    // re-namespaced stored cross-tree targets.
    updateSpec('implementation', 'transpiler::transpiler-impl', {
      methods: [{ name: 'other', narrative: [{ stepNumber: 1, description: 'updated noop', type: 'local' }] }],
    });
    invalidateSpecCache();

    const reloaded = loadImplementationSpec('transpiler::transpiler-impl');
    expect(reloaded!.methods.find(m => m.name === 'other')!.narrative[0].description).toBe('updated noop');
    expect(reloaded!.methods.find(m => m.name === 'run')!.narrative[0].targetComponent).toBe('crates-portal');
  });

  it('updateSpec deltas may use LOCAL names — they qualify against the spec namespace, not the root', () => {
    buildFixture();
    const childDir = path.join(rootDir, 'packages', 'transpiler');
    workspaceFor(childDir).saveComponentSpec(component('local-helper', 'transpiler'));
    invalidateSpecCache();

    // Bare local name in the delta + a super:: parent ref: both must resolve
    // exactly as the loader would inside the transpiler namespace.
    updateSpec('component', 'transpiler::transpiler-orch', {
      dependsOn: ['local-helper', 'super::crates-portal'],
    });
    invalidateSpecCache();
    expect(loadComponentSpec('transpiler::transpiler-orch')!.dependsOn)
      .toEqual(['transpiler::local-helper', 'crates-portal']);
  });

  it('cross-tree dependsOn survives component re-save', () => {
    buildFixture();

    const loaded = loadComponentSpec('transpiler::transpiler-orch');
    expect(loaded!.dependsOn).toEqual(['crates-portal']);

    saveComponentSpec(loaded!);
    invalidateSpecCache();
    expect(loadComponentSpec('transpiler::transpiler-orch')!.dependsOn).toEqual(['crates-portal']);
  });

  // ── The "different root, different verdict" bug ─────────────────────────────
  // A grandchild (B) references a component in its parent (A). The reference must
  // resolve IDENTICALLY whether the tree is validated from the top project root
  // OR from A's own directory as a standalone root (an agent runs `wairon mcp
  // serve` / `validate` inside A). The fix: the write path stores the RELATIVE
  // super:: hop count (root-invariant), never an absolute ::-anchor whose meaning
  // flips when the root changes.
  it('a cross-subproject ref resolves from BOTH the top root and the parent-subproject root', () => {
    rootDir = makeRoot();

    // Mount `amid` under the top root.
    saveSubsystemSpec(subsystem('amid', { projectPath: 'amid' }));
    const aDir = path.join(rootDir, 'amid');
    fs.mkdirSync(path.join(aDir, '.wai', 'specs'), { recursive: true });

    // amid's own tree (authored via amid's workspace): a-portal + a nested mount bleaf.
    const a = workspaceFor(aDir);
    a.saveSystemSpec({
      schemaVersion: '1.0.0', name: 'amid-system', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    a.saveSubsystemSpec(subsystem('a-core', { parentSystem: 'amid-system' }));
    a.saveComponentSpec(component('a-portal', 'a-core', { componentType: 'Portal', portalType: 'Custom' } as Partial<ComponentSpec>));
    a.saveSubsystemSpec(subsystem('bleaf', { parentSystem: 'amid-system', projectPath: 'bleaf' }));

    // bleaf's tree, authored via bleaf's workspace. b-orch (in bleaf) depends on
    // a-portal (in amid, one level up), authored as the relative super:: form.
    const bDir = path.join(aDir, 'bleaf');
    fs.mkdirSync(path.join(bDir, '.wai', 'specs'), { recursive: true });
    const b = workspaceFor(bDir);
    b.saveSystemSpec({
      schemaVersion: '1.0.0', name: 'bleaf-system', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    b.saveSubsystemSpec(subsystem('b-core', { parentSystem: 'bleaf-system' }));
    b.saveComponentSpec(component('b-orch', 'b-core', { dependsOn: ['super::a-portal'] }));
    invalidateSpecCache();

    // On disk bleaf's reference must be the portable super:: form, never ::a-portal.
    const bBlob = yamlBlob(path.join(bDir, '.wai'));
    expect(bBlob).toMatch(/super::a-portal/);
    expect(bBlob).not.toMatch(/(?<!super)::a-portal/);

    // Verdict from the TOP root: b-orch's dependsOn resolves to amid's a-portal
    // (qualified with amid's mount prefix).
    setProjectRoot(rootDir);
    invalidateSpecCache();
    expect(loadComponentSpec('amid::bleaf::b-orch')!.dependsOn).toEqual(['amid::a-portal']);

    // Verdict from amid's OWN root (the standalone subproject an agent works in):
    // the SAME on-disk spec resolves to a-portal locally. Same specs, same verdict.
    setProjectRoot(aDir);
    invalidateSpecCache();
    expect(loadComponentSpec('bleaf::b-orch')!.dependsOn).toEqual(['a-portal']);
  });
});

describe('root-mounted external subsystem publicInterfaces (the lock-refusal bug)', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function buildFixture(): string {
    rootDir = makeRoot();
    createChainedSubsystem(subsystem('network_http', { projectPath: 'packages/network_http' }), 'network_http');
    const childDir = path.join(rootDir, 'packages', 'network_http');
    const child = workspaceFor(childDir);
    child.saveSubsystemSpec(subsystem('network_http', {
      parentSystem: 'network_http',
      publicInterfaces: [{ type: 'MessageBus', details: 'net.http capability provider', component: 'http-portal' }],
    }));
    child.saveComponentSpec(component('http-portal', 'network_http', { componentType: 'Portal', portalType: 'MessageBus' } as Partial<ComponentSpec>));
    invalidateSpecCache();
    return childDir;
  }

  it('re-saving the loaded (qualified) subsystem does not throw and round-trips', () => {
    const childDir = buildFixture();

    const loaded = loadSubsystemSpec('network_http');
    expect(loaded).not.toBeNull();
    // Loaded through the parent, the member is namespace-qualified.
    expect(loaded!.publicInterfaces[0].component).toBe('network_http::http-portal');

    // THE bug: this threw "Refusing to write invalid subsystem spec" on lock.
    expect(() => saveSubsystemSpec(loaded!)).not.toThrow();

    invalidateSpecCache();
    const reloaded = loadSubsystemSpec('network_http');
    expect(reloaded!.publicInterfaces[0].component).toBe('network_http::http-portal');

    // On disk the child file carries the plain local id.
    const childBlob = yamlBlob(path.join(childDir, '.wai'));
    expect(childBlob).toMatch(/component: ['"]?http-portal/);
    expect(childBlob).not.toMatch(/component: ['"]?network_http::http-portal/);
  });

  it('lifecycle entrypoint component refs round-trip with the same member prefix', () => {
    const childDir = buildFixture();
    const child = workspaceFor(childDir);
    child.saveSubsystemSpec(subsystem('network_http', {
      parentSystem: 'network_http',
      publicInterfaces: [{ type: 'MessageBus', details: 'net.http capability provider', component: 'http-portal' }],
      lifecycle: [{ phase: 'init', component: 'http-portal', method: 'provision' }],
    }));
    invalidateSpecCache();

    const loaded = loadSubsystemSpec('network_http');
    expect(loaded!.lifecycle![0].component).toBe('network_http::http-portal');

    expect(() => saveSubsystemSpec(loaded!)).not.toThrow();
    invalidateSpecCache();
    expect(loadSubsystemSpec('network_http')!.lifecycle![0].component).toBe('network_http::http-portal');
  });

  it('dryRunSerializeSpecs is clean on a healthy tree and predicts a writer refusal', () => {
    buildFixture();

    // Warm the cache the way validate does, then dry-run: clean.
    const loaded = loadSubsystemSpec('network_http');
    expect(dryRunSerializeSpecs()).toEqual([]);

    // Corrupt the in-memory spec so the write pipeline would refuse it: a
    // foreign-namespace ref relativizes to a ::-anchored form the strict
    // publicInterfaces schema rejects.
    loaded!.publicInterfaces[0].component = 'other_ns::sneaky';
    const issues = dryRunSerializeSpecs();
    expect(issues.some(i => i.code === 'ROUNDTRIP_SERIALIZATION' && i.specId === 'network_http')).toBe(true);
    expect(issues[0].severity).toBe('error');
  });
});

describe('standalone child: cross-tree refs warn instead of erroring like typos', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('an unresolvable super:: target raises CROSS_TREE_REF_UNRESOLVED (warning), not INVALID_TARGET_COMPONENT_REFERENCE', async () => {
    // Simulate opening a chained child standalone: its file carries a
    // super:: ref whose target lives in the (absent) parent project.
    rootDir = makeRoot();
    saveSubsystemSpec(subsystem('transpiler'));
    saveComponentSpec(component('transpiler-orch', 'transpiler', { dependsOn: ['super::crates-portal'] }));
    saveInterfaceSpec(iface('itranspiler-orch', 'transpiler-orch', [
      { name: 'run', description: 'runs', signature: 'run(): void', returns: 'void' },
    ]));
    saveImplementationSpec({
      id: 'transpiler-impl', name: 'impl', description: 'd', contract: 'itranspiler-orch',
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, description: 'fetch from the parent portal', type: 'call', targetComponent: 'super::crates-portal', targetMethod: 'fetch' },
        ],
      }],
      status: 'draft', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    invalidateSpecCache();

    const { validateSddTree } = await import('../../src/core/validation.js');
    const res = validateSddTree();
    // Two warnings: the call step (contracts rule) AND the dependsOn edge
    // (stereotype-deps) — both honest, neither a typo-grade error.
    const crossTree = res.issues.filter(i => i.code === 'CROSS_TREE_REF_UNRESOLVED');
    expect(crossTree).toHaveLength(2);
    expect(crossTree.every(i => i.severity === 'warning')).toBe(true);
    expect(crossTree.map(i => i.message).join('\n')).toMatch(/validate from the parent project/);
    expect(res.issues.filter(i => i.code === 'INVALID_TARGET_COMPONENT_REFERENCE')).toHaveLength(0);
    expect(res.issues.filter(i => i.code === 'INVALID_DEPENDENCY_REFERENCE')).toHaveLength(0);
  });

  it('with its parent on disk, a chained child is judged THROUGH the parent — a bare parent id is a real error, not a waived warning', async () => {
    // Parent project mounts `kid` as a chained subproject; kid depends on a
    // parent component BY BARE ID. From inside a mount a bare id qualifies to
    // `kid::parent-portal`, which does not exist — a typo-grade error, and the
    // parent says so.
    rootDir = makeRoot();
    saveSubsystemSpec(subsystem('parent-sub'));
    saveComponentSpec(component('parent-portal', 'parent-sub', { componentType: 'Portal', portalType: 'Custom' } as Partial<ComponentSpec>));
    saveSubsystemSpec(subsystem('kid', { projectPath: 'kid' }));

    const kidDir = path.join(rootDir, 'kid');
    fs.mkdirSync(path.join(kidDir, '.wai', 'specs'), { recursive: true });
    const kid = workspaceFor(kidDir);
    kid.saveSystemSpec({
      schemaVersion: '1.0.0', name: 'kid-system', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    kid.saveSubsystemSpec(subsystem('k-core', { parentSystem: 'kid-system' }));
    // A dependency on a component that only exists in the parent tree.
    kid.saveComponentSpec(component('k-orch', 'k-core', { dependsOn: ['parent-portal'] }));
    invalidateSpecCache();

    const { validateSddTree } = await import('../../src/core/validation.js');

    // From the PARENT root: its verdict, and no chained-subproject notice.
    setProjectRoot(rootDir);
    invalidateSpecCache();
    const fromParent = validateSddTree();
    expect(fromParent.resolvedThrough).toBeUndefined();

    // From KID's own root the verdict is the same one — resolved through the
    // parent and renamed into kid's ids. It used to be REPLACED by a waived
    // UNVERIFIED_EXTERNAL_REF warning, and `validate --ci` passed.
    setProjectRoot(kidDir);
    invalidateSpecCache();
    const fromKid = validateSddTree();
    const invalid = fromKid.issues.filter(i => i.code === 'INVALID_DEPENDENCY_REFERENCE');
    expect(invalid.map(i => [i.specId, i.severity])).toEqual([['k-orch', 'error']]);
    expect(fromKid.resolvedThrough).toEqual({ root: path.resolve(rootDir), scope: 'kid' });
    expect(fromKid.valid).toBe(false);
  });

  it('a root-name-qualified target (waffler_core::x form, authored from a parent) warns, not errors, from the child root', async () => {
    // The exact field report: refs stored as `<parent-subsystem>::x` (NOT super::)
    // because they were authored from the parent root. From the child dir the
    // leading segment names no local subsystem — an honest cross-tree edge, not a
    // typo, so it must warn (CROSS_TREE_REF_UNRESOLVED), not flood hard errors.
    rootDir = makeRoot();
    saveSubsystemSpec(subsystem('transpiler'));
    saveComponentSpec(component('transpiler-orch', 'transpiler', { dependsOn: ['waffler_core::blueprints-portal'] }));
    invalidateSpecCache();

    const { validateSddTree } = await import('../../src/core/validation.js');
    const res = validateSddTree();
    const crossTree = res.issues.filter(i => i.code === 'CROSS_TREE_REF_UNRESOLVED');
    expect(crossTree.length).toBeGreaterThanOrEqual(1);
    expect(crossTree.every(i => i.severity === 'warning')).toBe(true);
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
    saveSubsystemSpec(subsystem('sub-a', {
      lifecycle: [
        { phase: 'init', component: 'boot-orch', method: 'hydrate' },
        { phase: 'shutdown', component: 'boot-orch', method: 'drain' },
      ],
    }));
    saveComponentSpec(component('gateway-portal', 'sub-a', {
      componentType: 'Portal', portalType: 'Custom',
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
    saveSubsystemSpec(subsystem('sub-a'));
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
    const notices = updateSpec('implementation', 'impl-orch-a', {
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
    saveSubsystemSpec(subsystem('sub-a'));
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
    const notices = updateSpec('implementation', 'impl-orch-a', {
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

describe("a chained child's implementation file paths are relative to its own root", () => {
  let rootDir: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
    rootDir = undefined;
  });

  function mountKid(): string {
    rootDir = makeRoot();
    createChainedSubsystem(subsystem('kid', { projectPath: 'packages/kid' }), 'kid');
    const kidDir = path.join(rootDir, 'packages', 'kid');
    const kid = workspaceFor(kidDir);
    kid.saveSubsystemSpec(subsystem('kid', { parentSystem: 'kid' }));
    kid.saveComponentSpec(component('kid-orch', 'kid'));
    kid.saveInterfaceSpec(iface('ikid-orch', 'kid-orch', [
      { name: 'run', description: 'runs', signature: 'run(): void', returns: 'void' },
    ]));
    invalidateSpecCache();
    setProjectRoot(rootDir);
    return kidDir;
  }

  const kidImpl = (over: Partial<ImplementationSpec> = {}): ImplementationSpec => ({
    id: 'kid::kid-impl', name: 'impl', description: 'd', contract: 'kid::ikid-orch',
    methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'run it', type: 'local' }] }],
    status: 'draft', createdAt: now, updatedAt: now, ...over,
  } as ImplementationSpec);

  /** The implementation as the CHILD reads it from its own root. */
  const fromKid = (kidDir: string): ImplementationSpec | null => {
    invalidateSpecCache();
    return workspaceFor(kidDir).loadImplementationSpec('kid-impl');
  };

  it('a path written through the parent, relative to the parent root, is stored relative to the child root', () => {
    const kidDir = mountKid();
    saveImplementationSpec(kidImpl({ sourcePath: 'packages/kid/src/run.ts', simPath: 'packages/kid/sim/run.sim.ts' }));

    const own = fromKid(kidDir);
    expect(own?.sourcePath).toBe('src/run.ts');
    expect(own?.simPath).toBe('sim/run.sim.ts');
    // The parent reads the same child-relative path back.
    setProjectRoot(rootDir!);
    expect(loadImplementationSpec('kid::kid-impl')?.sourcePath).toBe('src/run.ts');
  });

  it('load → save through the parent keeps a child-relative path as it is', () => {
    const kidDir = mountKid();
    workspaceFor(kidDir).saveImplementationSpec(kidImpl({ id: 'kid-impl', contract: 'ikid-orch', sourcePath: 'src/run.ts' }));
    invalidateSpecCache();
    setProjectRoot(rootDir!);

    const loaded = loadImplementationSpec('kid::kid-impl')!;
    expect(loaded.sourcePath).toBe('src/run.ts');
    saveImplementationSpec(loaded);
    saveImplementationSpec(loadImplementationSpec('kid::kid-impl')!);

    expect(fromKid(kidDir)?.sourcePath).toBe('src/run.ts');
  });

  it('a path that does not land inside the child is taken as child-relative and kept verbatim', () => {
    const kidDir = mountKid();
    saveImplementationSpec(kidImpl({ sourcePath: 'src/elsewhere.ts' }));
    expect(fromKid(kidDir)?.sourcePath).toBe('src/elsewhere.ts');
  });

  it("the child's own gate checks the file the parent's author named", async () => {
    const { validateSddTree } = await import('../../src/core/validation.js');
    const kidDir = mountKid();
    fs.mkdirSync(path.join(kidDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(kidDir, 'src', 'run.ts'), 'export function run(): void {}\n');
    const missingFromKid = (): string[] => {
      invalidateSpecCache();
      setProjectRoot(kidDir);
      return validateSddTree().issues
        .filter((i) => i.code === 'MISSING_SOURCE_FILE' || i.code === 'SOURCE_PATH_ESCAPES_ROOT')
        .map((i) => `${i.code} @${i.specId}`);
    };

    // Named from the parent root, it resolves to the real file from the child's.
    saveImplementationSpec(kidImpl({ sourcePath: 'packages/kid/src/run.ts' }));
    expect(missingFromKid()).toEqual([]);

    // The control: a file that does not exist is still reported from the child.
    setProjectRoot(rootDir!);
    saveImplementationSpec(kidImpl({ sourcePath: 'packages/kid/src/missing.ts' }));
    expect(missingFromKid()).toEqual(['MISSING_SOURCE_FILE @kid-impl']);
  });
});
