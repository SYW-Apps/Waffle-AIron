import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadComponentSpec,
  dryRunSerializeSpecs,
  invalidateSpecCache,
  workspaceFor,
} from '../../src/core/specs.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import type {
  ComponentSpec,
  ImplementationSpec,
  InterfaceSpec,
  SubsystemSpec,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Seeded property test for the id-space round-trip fixpoint.
//
// Invariant under test: for ANY spec loaded through the parent root,
// load -> save -> load yields the SAME in-memory ids (component ids, subsystem
// publicInterfaces bindings, impl narrative targetComponents, dependsOn), and
// a second save cycle is also a fixpoint. qualifyId (load) and relativizeId
// (save) must be exact inverses for every reference shape a chained project
// tree can produce.
//
// Deterministic: a fixed-seed mulberry32 PRNG drives every random choice, so
// each tree (and any failure) reproduces bit-identically in CI. Each tree gets
// its own seed derived only from its index — shrinking a failure to a minimal
// repro just means re-running that one index.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

// ------------------------------ PRNG ----------------------------------------

/** mulberry32: tiny deterministic PRNG, returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_SEED = 0x5eed_c0de;
const NUM_TREES = 30;

type Rng = () => number;
const int = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const pick = <T>(rng: Rng, arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const chance = (rng: Rng, p: number): boolean => rng() < p;

// ------------------------------ Shape model ---------------------------------

interface GenStep {
  kind: 'local' | 'call';
  /** Qualified (in-memory, as seen from the top root) target component id. */
  target?: string;
  /** The relative form actually written into the on-disk fixture file. */
  diskForm?: string;
}

interface GenMethod {
  name: string;
  steps: GenStep[];
}

interface GenComp {
  local: string;
  /** Expected in-memory id when loaded through the top root. */
  qualified: string;
  componentType: 'Orchestrator' | 'Portal';
  methods: GenMethod[];
  /** Qualified dependsOn targets + the relative forms written to disk. */
  dependsOn: { target: string; diskForm: string }[];
}

interface GenLevel {
  /** Namespace prefix under the top root ('' for the root project itself). */
  prefix: string;
  dir: string;
  parentIdx: number | null;
  /** Bare mount subsystem id in the parent tree (null for the root level). */
  mountLocalId: string | null;
  systemName: string;
  subsystemLocal: string;
  portalLocal: string | null;
  components: GenComp[];
}

interface GenShape {
  seed: number;
  depth: number;
  levels: GenLevel[];
  /** Max '::' chain length of any generated spec id (mount nesting depth). */
  maxChain: number;
  rootSubsystemIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Every on-disk relative form that qualifyId resolves back to `target` when the
// file lives in namespace `prefix` and is loaded from the TOP root. This is the
// generator's own (one-to-many) inverse of qualifyId; relativizeId must pick
// SOME member of this set such that the loaded id is stable.
// ---------------------------------------------------------------------------
function validDiskForms(target: string, prefix: string, rootSubsystemIds: Set<string>): string[] {
  if (!prefix) {
    // Root-level files are never namespace-qualified on load: the in-memory
    // absolute form is the on-disk form.
    return [target];
  }
  const forms: string[] = [`::${target}`]; // absolute from the loading root — always valid
  if (target.startsWith(`${prefix}::`)) {
    forms.push(target.slice(prefix.length + 2)); // bare local remainder
  }
  const pParts = prefix.split('::');
  const tParts = target.split('::');
  let common = 0;
  while (common < pParts.length && common < tParts.length && pParts[common] === tParts[common]) common++;
  if (common < tParts.length) {
    const supers = pParts.length - common;
    if (supers > 0) forms.push('super::'.repeat(supers) + tParts.slice(common).join('::'));
  }
  // Over-climb: hop all the way to the root, then spell the full path.
  forms.push('super::'.repeat(pParts.length) + target);
  if (rootSubsystemIds.has(tParts[0])) {
    // Root-subsystem anchoring: a bare qualified id whose first segment is a
    // root subsystem resolves absolutely, from any depth.
    forms.push(target);
  }
  return forms;
}

// ------------------------------ Generation ----------------------------------

function generateShape(index: number, rootDir: string): GenShape {
  const seed = (BASE_SEED ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  const rng = mulberry32(seed);
  const depth = index % 4; // even, deterministic coverage of mount depths 0-3

  const levels: GenLevel[] = [
    {
      prefix: '',
      dir: rootDir,
      parentIdx: null,
      mountLocalId: null,
      systemName: 'root-system',
      subsystemLocal: 'sub-l0',
      portalLocal: null,
      components: [],
    },
  ];

  // Main mount chain: level k mounted inside level k-1's tree.
  let prevIdx = 0;
  for (let k = 1; k <= depth; k++) {
    const mount = `mnt-l${k}`;
    const parent = levels[prevIdx];
    levels.push({
      prefix: parent.prefix ? `${parent.prefix}::${mount}` : mount,
      dir: path.join(parent.dir, 'packages', mount),
      parentIdx: prevIdx,
      mountLocalId: mount,
      systemName: mount,
      subsystemLocal: `sub-l${k}`,
      portalLocal: `portal-l${k}`,
      components: [],
    });
    prevIdx = levels.length - 1;
  }

  // Sibling mount at the root (a second, independent external child).
  if (depth >= 1 && chance(rng, 0.6)) {
    levels.push({
      prefix: 'sib-r1',
      dir: path.join(rootDir, 'packages', 'sib-r1'),
      parentIdx: 0,
      mountLocalId: 'sib-r1',
      systemName: 'sib-r1',
      subsystemLocal: 'sub-r1',
      portalLocal: 'portal-r1',
      components: [],
    });
  }

  // Sibling mount inside level 1 (child-of-child next to the main chain).
  if (depth >= 2 && chance(rng, 0.5)) {
    const l1 = levels.findIndex(l => l.mountLocalId === 'mnt-l1');
    levels.push({
      prefix: 'mnt-l1::sib-m1',
      dir: path.join(levels[l1].dir, 'packages', 'sib-m1'),
      parentIdx: l1,
      mountLocalId: 'sib-m1',
      systemName: 'sib-m1',
      subsystemLocal: 'sub-m1s',
      portalLocal: 'portal-m1s',
      components: [],
    });
  }

  const rootSubsystemIds = new Set<string>(['sub-l0']);
  for (const lvl of levels) {
    if (lvl.parentIdx === 0 && lvl.mountLocalId) rootSubsystemIds.add(lvl.mountLocalId);
  }

  // Components (structure only; cross-refs filled once the full pool exists).
  for (const lvl of levels) {
    const tag = lvl.subsystemLocal.replace(/^sub-/, '');
    const n = int(rng, 2, 3);
    for (let c = 0; c < n; c++) {
      const local = `comp-${tag}-${'abc'[c]}`;
      const methods: GenMethod[] = [{ name: 'run', steps: [] }];
      if (chance(rng, 0.5)) methods.push({ name: 'poke', steps: [] });
      lvl.components.push({
        local,
        qualified: lvl.prefix ? `${lvl.prefix}::${local}` : local,
        componentType: 'Orchestrator',
        methods,
        dependsOn: [],
      });
    }
    if (lvl.portalLocal) {
      lvl.components.push({
        local: lvl.portalLocal,
        qualified: `${lvl.prefix}::${lvl.portalLocal}`,
        componentType: 'Portal',
        methods: [{ name: 'run', steps: [] }],
        dependsOn: [],
      });
    }
  }

  // Cross-refs: dependsOn + narrative call targets across random levels
  // (local sibling, parent level, root level, sibling mounts).
  const pool = levels.flatMap(l => l.components.map(c => c.qualified));
  for (const lvl of levels) {
    for (const comp of lvl.components) {
      const nDeps = int(rng, 0, 2);
      for (let d = 0; d < nDeps; d++) {
        const target = pick(rng, pool.filter(q => q !== comp.qualified));
        comp.dependsOn.push({
          target,
          diskForm: pick(rng, validDiskForms(target, lvl.prefix, rootSubsystemIds)),
        });
      }
      for (const method of comp.methods) {
        const nSteps = int(rng, 1, 3);
        for (let s = 0; s < nSteps; s++) {
          if (chance(rng, 0.6)) {
            const target = pick(rng, pool);
            method.steps.push({
              kind: 'call',
              target,
              diskForm: pick(rng, validDiskForms(target, lvl.prefix, rootSubsystemIds)),
            });
          } else {
            method.steps.push({ kind: 'local' });
          }
        }
      }
    }
  }

  const maxChain = Math.max(...levels.map(l => (l.prefix ? l.prefix.split('::').length : 0)));
  return { seed, depth, levels, maxChain, rootSubsystemIds };
}

// ------------------------------ Materialization -----------------------------

const subsystemSpec = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id,
  name: id,
  description: `subsystem ${id}`,
  parentSystem: 'root-system',
  publicInterfaces: [],
  trustedLinks: [],
  status: 'draft',
  createdAt: now,
  updatedAt: now,
  ...over,
});

function materialize(shape: GenShape, rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'root-system',
    vision: 'id-space fixpoint fuzz fixture',
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });

  // 1. Wire every mount (parents are constructed before their children).
  for (const lvl of shape.levels) {
    if (lvl.parentIdx === null || !lvl.mountLocalId) continue;
    const parent = shape.levels[lvl.parentIdx];
    setProjectRoot(parent.dir);
    createChainedSubsystem(
      subsystemSpec(lvl.mountLocalId, {
        parentSystem: parent.systemName,
        projectPath: `packages/${lvl.mountLocalId}`,
        publicInterfaces: [{ type: 'Custom', details: 'd', component: lvl.portalLocal! }],
      }),
      lvl.systemName,
    );
  }
  setProjectRoot(rootDir);

  // 2. Fill each level's own tree through its OWN workspace using the
  //    generated relative forms (bare local ids for the specs themselves).
  //    NOTE: workspaceFor(...) is re-fetched per save on purpose. Every save
  //    runs the global invalidateSpecCache(), which clears the workspace
  //    registry map — but it can only invalidate instances still registered,
  //    so a caller-HELD workspace reference keeps serving its stale cached
  //    index (within the 2s signature TTL) and mis-routes subsequent writes
  //    into `default/` fallback folders. See report: adjacent stale-workspace
  //    hazard in invalidateSpecCache().
  for (const lvl of shape.levels) {
    workspaceFor(lvl.dir).saveSubsystemSpec(subsystemSpec(lvl.subsystemLocal, { parentSystem: lvl.systemName }));
    for (const comp of lvl.components) {
      workspaceFor(lvl.dir).saveComponentSpec({
        id: comp.local,
        name: comp.local,
        description: 'd',
        subsystem: lvl.subsystemLocal,
        componentType: comp.componentType,
        ...(comp.componentType === 'Portal' ? { portalType: 'Custom' } : {}),
        owns: [],
        dependsOn: comp.dependsOn.map(d => d.diskForm),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      } as ComponentSpec);
      workspaceFor(lvl.dir).saveInterfaceSpec({
        id: `i${comp.local}`,
        name: `i${comp.local}`,
        description: 'd',
        component: comp.local,
        methods: comp.methods.map(m => ({
          name: m.name,
          description: `${m.name} method`,
          signature: `${m.name}(): void`,
          returns: 'void',
        })),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      } as InterfaceSpec);
      workspaceFor(lvl.dir).saveImplementationSpec({
        id: `${comp.local}-impl`,
        name: `${comp.local} impl`,
        description: 'd',
        contract: `i${comp.local}`, // child-local contract stays local
        methods: comp.methods.map(m => ({
          name: m.name,
          narrative: m.steps.map((s, idx) =>
            s.kind === 'local'
              ? { stepNumber: idx + 1, description: 'local work', type: 'local' as const }
              : {
                  stepNumber: idx + 1,
                  description: 'cross-component call',
                  type: 'call' as const,
                  targetComponent: s.diskForm!,
                  targetMethod: 'run',
                },
          ),
        })),
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      } as ImplementationSpec);
    }
  }
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

// ------------------------------ Snapshot + cycles ----------------------------

interface LoadedTree {
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
}

function loadAll(): LoadedTree {
  invalidateSpecCache();
  return {
    subsystems: loadSubsystemSpecs(),
    components: loadComponentSpecs(),
    interfaces: loadInterfaceSpecs(),
    implementations: loadImplementationSpecs(),
  };
}

/** Everything id-shaped, keyed and canonicalized — timestamps/status excluded. */
function snapshotIds(tree: LoadedTree): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const s of [...tree.subsystems].sort((a, b) => a.id.localeCompare(b.id))) {
    snap[`subsystem ${s.id}`] = {
      publicInterfaces: s.publicInterfaces.map(pi => `${pi.type}|${pi.component ?? ''}|${pi.interface ?? ''}`),
    };
  }
  for (const c of [...tree.components].sort((a, b) => a.id.localeCompare(b.id))) {
    snap[`component ${c.id}`] = { subsystem: c.subsystem, dependsOn: [...c.dependsOn], owns: [...c.owns] };
  }
  for (const i of [...tree.interfaces].sort((a, b) => a.id.localeCompare(b.id))) {
    snap[`interface ${i.id}`] = { component: i.component };
  }
  for (const im of [...tree.implementations].sort((a, b) => a.id.localeCompare(b.id))) {
    const targets: Record<string, (string | null)[]> = {};
    for (const m of im.methods) {
      targets[m.name] = m.narrative.map(st => st.targetComponent ?? null);
    }
    snap[`implementation ${im.id}`] = { contract: im.contract, targets };
  }
  return snap;
}

/** Re-save EVERY loaded spec through the parent root, as any edit/lock does. */
function resaveAllThroughRoot(tree: LoadedTree): void {
  for (const s of tree.subsystems) saveSubsystemSpec(s);
  for (const c of tree.components) saveComponentSpec(c);
  for (const i of tree.interfaces) saveInterfaceSpec(i);
  for (const im of tree.implementations) saveImplementationSpec(im);
}

/** Assert the initial load resolved every generated id/ref as intended. */
function expectIntendedResolution(shape: GenShape, tree: LoadedTree): void {
  const compsById = new Map(tree.components.map(c => [c.id, c]));
  const ifacesById = new Map(tree.interfaces.map(i => [i.id, i]));
  const implsById = new Map(tree.implementations.map(im => [im.id, im]));
  const subsById = new Map(tree.subsystems.map(s => [s.id, s]));

  for (const lvl of shape.levels) {
    const subQ = lvl.prefix ? `${lvl.prefix}::${lvl.subsystemLocal}` : lvl.subsystemLocal;
    expect(subsById.has(subQ), `subsystem ${subQ} missing after initial load`).toBe(true);

    if (lvl.mountLocalId && lvl.parentIdx !== null) {
      const parentPrefix = shape.levels[lvl.parentIdx].prefix;
      const mountQ = parentPrefix ? `${parentPrefix}::${lvl.mountLocalId}` : lvl.mountLocalId;
      const mount = subsById.get(mountQ);
      expect(mount, `mount subsystem ${mountQ} missing after initial load`).toBeDefined();
      expect(
        mount!.publicInterfaces[0]?.component,
        `mount ${mountQ} publicInterfaces binding`,
      ).toBe(`${lvl.prefix}::${lvl.portalLocal}`);
    }

    for (const comp of lvl.components) {
      const loaded = compsById.get(comp.qualified);
      expect(loaded, `component ${comp.qualified} missing after initial load`).toBeDefined();
      expect(loaded!.subsystem, `component ${comp.qualified} subsystem ref`).toBe(subQ);
      expect(loaded!.dependsOn, `component ${comp.qualified} dependsOn`).toEqual(
        comp.dependsOn.map(d => d.target),
      );

      const ifaceQ = lvl.prefix ? `${lvl.prefix}::i${comp.local}` : `i${comp.local}`;
      const iface = ifacesById.get(ifaceQ);
      expect(iface, `interface ${ifaceQ} missing after initial load`).toBeDefined();
      expect(iface!.component, `interface ${ifaceQ} component ref`).toBe(comp.qualified);

      const implQ = lvl.prefix ? `${lvl.prefix}::${comp.local}-impl` : `${comp.local}-impl`;
      const impl = implsById.get(implQ);
      expect(impl, `implementation ${implQ} missing after initial load`).toBeDefined();
      expect(impl!.contract, `implementation ${implQ} contract ref`).toBe(ifaceQ);
      for (const method of comp.methods) {
        const loadedMethod = impl!.methods.find(m => m.name === method.name)!;
        expect(
          loadedMethod.narrative.map(st => st.targetComponent ?? null),
          `implementation ${implQ} method ${method.name} narrative targets`,
        ).toEqual(method.steps.map(s => (s.kind === 'call' ? s.target! : null)));
      }
    }
  }
}

function runTree(index: number, rootDir: string): void {
  const shape = generateShape(index, rootDir);
  materialize(shape, rootDir);

  // Cycle 0: initial load through the parent root; assert intended resolution.
  const tree1 = loadAll();
  expectIntendedResolution(shape, tree1);
  const snap1 = snapshotIds(tree1);

  // The write pipeline must not predict any refusal for a healthy tree.
  expect(dryRunSerializeSpecs()).toEqual([]);

  // Cycle 1: re-save everything through the parent, reload, compare.
  resaveAllThroughRoot(tree1);
  const tree2 = loadAll();
  expect(snapshotIds(tree2)).toEqual(snap1);

  // Cycle 2: a second save cycle must also be a fixpoint.
  resaveAllThroughRoot(tree2);
  const tree3 = loadAll();
  expect(snapshotIds(tree3)).toEqual(snap1);
}

// ------------------------------ Suite ----------------------------------------

// GENUINE COUNTEREXAMPLE FOUND (2026-07): every tree whose mount chain is 2+
// deep (child-of-child, e.g. `mnt-l1::mnt-l2::comp`) violates the invariant —
// see the "KNOWN COUNTEREXAMPLE" suite below for the minimal repro and the
// mechanism. FIXED: getSubprojectPrefix now resolves the DEEPEST subproject
// prefix, so the full depth 0-3 fuzz matrix is armed.
const SKIP_KNOWN_DEPTH2_COUNTEREXAMPLE = false;

describe('id-space fixpoint fuzz (seeded, deterministic)', () => {
  let rootDir: string | null = null;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) {
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // Windows can transiently hold handles; leaking a tmpdir is acceptable.
      }
      rootDir = null;
    }
  });

  for (let i = 0; i < NUM_TREES; i++) {
    const depth = i % 4;
    // Every generated spec's mount-chain length is bounded by `depth` (the l1
    // sibling mount, chain length 2, is only generated when depth >= 2).
    const runner = depth >= 2 && SKIP_KNOWN_DEPTH2_COUNTEREXAMPLE ? it.skip : it;
    // Each case generates a whole spec tree on disk and round-trips it twice, so a
    // single case can exceed the 5s default under full-suite parallel load (it
    // passes comfortably in isolation). Same contention allowance the git-backed
    // lock test carries — the assertions are unchanged, only the wall clock.
    runner(`tree #${i} (mount depth ${depth}) load->save->load is a fixpoint across two cycles`, { timeout: 30_000 }, () => {
      rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-fuzz-'));
      runTree(i, rootDir);
    });
  }
});

// ---------------------------------------------------------------------------
// KNOWN COUNTEREXAMPLE (minimal repro, found by the fuzz above)
//
// Shape:  root ── mount `mnt-l1` (packages/mnt-l1) ── mount `mnt-l2`
//         (packages/mnt-l1/packages/mnt-l2) containing subsystem `sub-l2`
//         and component `leaf-comp`.
//
// Loading through the root works: `mnt-l1::mnt-l2::leaf-comp` with subsystem
// `mnt-l1::mnt-l2::sub-l2`. Re-saving that loaded spec through the root does
// NOT round-trip:
//
//   prepareComponentForWrite -> getSubprojectPrefix('mnt-l1::mnt-l2::leaf-comp')
//   returns the FIRST prefix that is a mount — 'mnt-l1' — instead of the
//   deepest one ('mnt-l1::mnt-l2'), because the loop in getSubprojectPrefix
//   (src/core/specs.ts) returns on the first hit. relativizeId then strips
//   only 'mnt-l1', producing on-disk id 'mnt-l2::leaf-comp' for a file that
//   lives INSIDE the mnt-l2 tree. The strict on-disk id schema (SpecIdSchema,
//   no '::') refuses it, so the save THROWS:
//
//     Refusing to write invalid component spec "mnt-l1::mnt-l2::leaf-comp":
//     id: Identifier must be lowercase alphanumeric with dashes or underscores
//
// The refusal is loud and pre-write (the child file stays intact), but it
// makes every depth-2+ spec un-editable and un-lockable through the parent
// root. Were the schema lenient, the id would instead re-qualify on reload as
// 'mnt-l1::mnt-l2::mnt-l2::leaf-comp' (duplicated segment), and sibling refs
// would silently re-namespace — the historic cross-tree corruption class.
// Depth-2 SUBSYSTEM saves are unaffected (prepareSubsystemForWrite derives
// the prefix from splitNamespace, not getSubprojectPrefix); only components,
// interfaces, implementations, and types go through getSubprojectPrefix.
//
// Both tests below express the CORRECT behavior — permanent regression tests
// for the fixed shallowest-prefix bug.
// ---------------------------------------------------------------------------

describe('KNOWN COUNTEREXAMPLE: depth-2 (child-of-child) specs cannot be re-saved through the root', () => {
  let rootDir: string | null = null;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) {
      try {
        fs.rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // Windows can transiently hold handles; leaking a tmpdir is acceptable.
      }
      rootDir = null;
    }
  });

  function buildDepth2Fixture(): void {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-fuzz-'));
    fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
    setProjectRoot(rootDir);
    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'root-system',
      vision: 'depth-2 minimal repro',
      boundaries: [],
      globalRequirements: [],
      createdAt: now,
      updatedAt: now,
    });
    createChainedSubsystem(subsystemSpec('mnt-l1', { projectPath: 'packages/mnt-l1' }), 'mnt-l1');
    setProjectRoot(path.join(rootDir, 'packages', 'mnt-l1'));
    createChainedSubsystem(
      subsystemSpec('mnt-l2', { parentSystem: 'mnt-l1', projectPath: 'packages/mnt-l2' }),
      'mnt-l2',
    );
    setProjectRoot(rootDir);

    const l2dir = path.join(rootDir, 'packages', 'mnt-l1', 'packages', 'mnt-l2');
    workspaceFor(l2dir).saveSubsystemSpec(subsystemSpec('sub-l2', { parentSystem: 'mnt-l2' }));
    workspaceFor(l2dir).saveComponentSpec({
      id: 'leaf-comp',
      name: 'leaf-comp',
      description: 'd',
      subsystem: 'sub-l2',
      componentType: 'Orchestrator',
      owns: [],
      dependsOn: [],
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    } as ComponentSpec);
    invalidateSpecCache();
    setProjectRoot(rootDir);
  }

  it('re-saving a loaded depth-2 component through the root round-trips', () => {
    buildDepth2Fixture();

    const loaded = loadComponentSpec('mnt-l1::mnt-l2::leaf-comp');
    expect(loaded).not.toBeNull();
    expect(loaded!.subsystem).toBe('mnt-l1::mnt-l2::sub-l2');

    // Previously threw ('Refusing to write invalid component spec ...')
    // because only 'mnt-l1' was stripped, leaving 'mnt-l2::leaf-comp'.
    expect(() => saveComponentSpec(loaded!)).not.toThrow();

    invalidateSpecCache();
    const reloaded = loadComponentSpec('mnt-l1::mnt-l2::leaf-comp');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.id).toBe('mnt-l1::mnt-l2::leaf-comp');
    expect(reloaded!.subsystem).toBe('mnt-l1::mnt-l2::sub-l2');
  });

  it('dryRunSerializeSpecs is clean on a healthy depth-2 tree', () => {
    buildDepth2Fixture();

    // Warm the cache the way validate does.
    expect(loadComponentSpec('mnt-l1::mnt-l2::leaf-comp')).not.toBeNull();
    expect(dryRunSerializeSpecs()).toEqual([]);
  });
});
