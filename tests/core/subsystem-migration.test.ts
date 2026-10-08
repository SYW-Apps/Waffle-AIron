import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  loadComponentSpecs,
  loadSubsystemSpec,
  loadImplementationSpec,
  scanAllSpecs,
  invalidateSpecCache,
  workspaceFor,
} from '../../src/core/specs.js';
import { externalizeSubsystem, internalizeMember } from '../../src/core/provision.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { writeLegacyMount } from '../helpers/legacy-mount.js';
import { validateProject, type ValidationResult } from '../../src/core/validation.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../../src/models/index.js';

const now = new Date().toISOString();

/** Read a component's dependsOn from its raw parent file. */
function rawDependsOn(root: string, subsystem: string, comp: string): string[] {
  const p = path.join(root, '.wai', 'specs', subsystem, comp, '.index.yaml');
  const y = fs.readFileSync(p, 'utf8');
  const m = y.match(/dependsOn:\n((?:\s*-\s*.+\n?)*)/);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.replace(/\s*-\s*/, '').trim()).filter(Boolean);
}

describe('subsystem migration (externalize <-> internalize)', () => {
  let root: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function seed(): void {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', id: 'root-sys', name: 'root-sys', targets: [],
      rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    setProjectRoot(root);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'root-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });

    // core: a published portal + an orchestrator behind it.
    saveSpec('subsystem', { id: 'core', name: 'core', description: 'the core', parentSystem: 'root-sys', publicInterfaces: [{ type: 'Custom', details: 'core api', component: 'core_portal' }], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now });
    saveComponentSpec({ id: 'core_portal', name: 'Core Portal', description: 'front door', subsystem: 'core', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: ['core_orch'], createdAt: now, updatedAt: now } as any);
    saveComponentSpec({ id: 'core_orch', name: 'Core Orchestrator', description: 'workflow', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [], createdAt: now, updatedAt: now } as any);

    // cli: an adapter that crosses into core's published portal (the cross-subsystem ref).
    saveSpec('subsystem', { id: 'cli', name: 'cli', description: 'the cli', parentSystem: 'root-sys', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now });
    saveComponentSpec({ id: 'cli_core_adapter', name: 'CLI Core Adapter', description: 'hop into core', subsystem: 'cli', componentType: 'Adapter', owns: [], dependsOn: ['core_portal'], createdAt: now, updatedAt: now } as any);

    invalidateSpecCache();
  }

  it('externalizes, rewrites the cross-subsystem ref, then internalizes back to the original tree', () => {
    seed();

    // --- externalize core into ./packages/core ---
    externalizeSubsystem('core', 'packages/core', 'project');
    invalidateSpecCache();

    // core is now a member, declared in project.yaml `members` — no L1 mount is written
    expect(scanAllSpecs().subsystems.map((x: any) => x.id)).not.toContain('core');
    expect(projectConfigRepositoryAt(root).load()?.members).toEqual({ core: 'packages/core' });
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'core'))).toBe(false);

    // core's specs moved into the child project
    const childRoot = path.join(root, 'packages', 'core');
    expect(fs.existsSync(path.join(childRoot, '.wai', 'project.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(childRoot, '.wai', 'specs', 'core', 'core_portal', '.index.yaml'))).toBe(true);
    // parent no longer holds core's components
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'core', 'core_portal'))).toBe(false);

    // federated: the member's own subsystem is keyed under its project (stage 3:
    // `core::core`, never merged with the mount), its portal likewise
    let idx = scanAllSpecs();
    expect(idx.subsystems.filter((s: any) => s.id === 'core').length).toBe(0);
    expect(idx.subsystems.filter((s: any) => s.id === 'core::core').length).toBe(1);
    expect(idx.components.map((c: any) => c.id)).toContain('core::core_portal');

    // the sibling adapter's cross-ref was rewritten and resolves
    expect(rawDependsOn(root, 'cli', 'cli_core_adapter')).toEqual(['core::core_portal']);
    const adapter = loadComponentSpecs().find((c: any) => c.id === 'cli_core_adapter');
    expect(adapter?.dependsOn).toContain('core::core_portal');
    const ids = new Set(idx.components.map((c: any) => c.id));
    expect(ids.has(adapter!.dependsOn[0])).toBe(true); // no dangling ref

    // --- internalize core back ---
    internalizeMember('core', { home: '' });
    invalidateSpecCache();

    // core is internal again, its `members` entry and child project gone
    expect(projectConfigRepositoryAt(root).load()?.members).toBeUndefined();
    expect(loadSubsystemSpec('core')?.projectPath).toBeUndefined();
    expect(fs.existsSync(path.join(childRoot, '.wai'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'core', 'core_portal', '.index.yaml'))).toBe(true);

    // ref restored to the bare id, resolves
    expect(rawDependsOn(root, 'cli', 'cli_core_adapter')).toEqual(['core_portal']);
    idx = scanAllSpecs();
    expect(idx.components.map((c: any) => c.id)).toContain('core_portal');
    expect(idx.components.map((c: any) => c.id)).not.toContain('core::core_portal');
    expect(idx.subsystems.filter((s: any) => s.id === 'core').length).toBe(1);
  });

  it('refuses to externalize a member and to internalize a subsystem that is no member', () => {
    seed();
    externalizeSubsystem('core', 'packages/core', 'project');
    invalidateSpecCache();
    expect(() => externalizeSubsystem('core', 'packages/core2', 'project')).toThrow(/already in a part, or a member/);
    expect(() => internalizeMember('cli', { home: '' })).toThrow(/no member is declared under that alias/);
  });

  it('externalizes a legacy mount: refused, it is already a member', () => {
    seed();
    writeLegacyMount({ id: 'old', name: 'old', description: 'd', parentSystem: 'root-sys', publicInterfaces: [], trustedLinks: [], projectPath: 'packages/old', createdAt: now, updatedAt: now } as SubsystemSpec, 'old');
    invalidateSpecCache();
    expect(() => externalizeSubsystem('old', 'packages/old2', 'project')).toThrow(/already in a part, or a member/);
  });

  it("re-expresses the moved implementations' file paths against the new root — the same files — and back", () => {
    seed();
    saveInterfaceSpec({
      id: 'icore_orch', name: 'icore_orch', description: 'd', component: 'core_orch',
      methods: [{ name: 'run', description: 'd', signature: 'run(): void', returns: 'void' }],
      createdAt: now, updatedAt: now,
    } as any);
    saveImplementationSpec({
      id: 'core_orch_impl', name: 'impl', description: 'd', contract: 'icore_orch',
      // The code already lives under the mount-to-be…
      sourcePath: 'packages/core/src/orch.ts',
      // …and its harness stays outside it.
      simPath: 'sim/orch.sim.ts',
      methods: [{ name: 'run', narrative: [] }],
      createdAt: now, updatedAt: now,
    } as any);
    invalidateSpecCache();

    externalizeSubsystem('core', 'packages/core', 'project');
    invalidateSpecCache();
    const own = workspaceFor(path.join(root, 'packages', 'core')).loadImplementationSpec('core_orch_impl');
    expect(own?.sourcePath).toBe('src/orch.ts');
    // A project never names a file outside its root (round-3 trial): the
    // harness left outside is planned where it lies relative to the family
    // root, now under the member's — the plan says so, the code is not moved.
    expect(own?.simPath).toBe('sim/orch.sim.ts');

    internalizeMember('core', { home: '' });
    invalidateSpecCache();
    const back = loadImplementationSpec('core_orch_impl');
    expect(back?.sourcePath).toBe('packages/core/src/orch.ts');
    expect(back?.simPath).toBe('packages/core/sim/orch.sim.ts');
  });

  it("re-expresses the moved implementations' binding-module paths against the new root and back (round 6)", () => {
    seed();
    saveInterfaceSpec({
      id: 'icore_orch', name: 'icore_orch', description: 'd', component: 'core_orch',
      methods: [{ name: 'run', description: 'd', signature: 'run(): void', returns: 'void' }],
      createdAt: now, updatedAt: now,
    } as any);
    saveImplementationSpec({
      id: 'core_orch_impl', name: 'impl', description: 'd', contract: 'icore_orch',
      sourcePath: 'packages/core/src/orch.ts',
      bindings: ['packages/core/src/geo_binding.ts'],
      methods: [{ name: 'run', narrative: [] }],
      createdAt: now, updatedAt: now,
    } as any);
    invalidateSpecCache();

    externalizeSubsystem('core', 'packages/core', 'project');
    invalidateSpecCache();
    const own = workspaceFor(path.join(root, 'packages', 'core')).loadImplementationSpec('core_orch_impl') as any;
    expect(own?.bindings).toEqual(['src/geo_binding.ts']);

    internalizeMember('core', { home: '' });
    invalidateSpecCache();
    const back = loadImplementationSpec('core_orch_impl') as any;
    expect(back?.bindings).toEqual(['packages/core/src/geo_binding.ts']);
  });

  it("re-expresses each method's own sourcePath against the new root and back, leaving an absolute one alone", () => {
    seed();
    saveInterfaceSpec({
      id: 'icore_orch', name: 'icore_orch', description: 'd', component: 'core_orch',
      methods: [
        { name: 'run', description: 'd', signature: 'run(): void', returns: 'void' },
        { name: 'stop', description: 'd', signature: 'stop(): void', returns: 'void' },
        { name: 'pause', description: 'd', signature: 'pause(): void', returns: 'void' },
      ],
      createdAt: now, updatedAt: now,
    } as any);
    const absolute = path.join(root, 'vendor', 'pause.ts');
    saveImplementationSpec({
      id: 'core_orch_impl', name: 'impl', description: 'd', contract: 'icore_orch',
      sourcePath: 'packages/core/src/orch.ts',
      methods: [
        // Its own file lives under the mount-to-be…
        { name: 'run', sourcePath: 'packages/core/src/commands/run.ts', narrative: [] },
        // …this one stays outside it…
        { name: 'stop', sourcePath: 'tools/stop.ts', narrative: [] },
        // …and an absolute path names the same file from any root.
        { name: 'pause', sourcePath: absolute, narrative: [] },
      ],
      createdAt: now, updatedAt: now,
    } as any);
    invalidateSpecCache();

    /** The implementation as written on disk under a project root, before any load normalization. */
    const rawImpl = (projectDir: string): any => listFilesRecursive(path.join(projectDir, '.wai', 'specs'), '.yaml')
      .map((f) => readYamlFile(f) as any)
      .find((y) => y && y.id === 'core_orch_impl');

    externalizeSubsystem('core', 'packages/core', 'project');
    invalidateSpecCache();
    const childRaw = rawImpl(path.join(root, 'packages', 'core'));
    expect(childRaw.sourcePath).toBe('src/orch.ts');
    // The one left outside the new root is re-expressed member-relative (planned there), never `../../`.
    expect(childRaw.methods.map((m: any) => m.sourcePath)).toEqual(['src/commands/run.ts', 'tools/stop.ts', absolute]);

    internalizeMember('core', { home: '' });
    invalidateSpecCache();
    const parentRaw = rawImpl(root);
    expect(parentRaw.methods.map((m: any) => m.sourcePath)).toEqual(['packages/core/src/commands/run.ts', 'packages/core/tools/stop.ts', absolute]);
  });
});

// ---------------------------------------------------------------------------
// A moved subtree's own references.
//
// Externalize used to rewrite only what the parent's remaining specs point at,
// so a moved spec kept its references exactly as the parent wrote them. Loaded
// from the member, a bare id into a sibling subsystem then named a component
// the member does not have. Stage 3: a reference that leaves the moved subtree
// names the parent by its project id (`<parent id>::name`, the parent declared
// as the member's external) — never `super::` — and internalize takes it back.
// ---------------------------------------------------------------------------

const sub = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const comp = (id: string, subsystem: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem, componentType, owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const intf = (id: string, component: string, method: string, params: { name: string; type: string }[] = []): InterfaceSpec => ({
  id, name: id, description: 'd', component, createdAt: now, updatedAt: now,
  methods: [{
    name: method, description: 'd', returns: 'void',
    signature: `${method}(${params.map((p) => `${p.name}: ${p.type}`).join(', ')}): void`,
    ...(params.length ? { params } : {}),
  }],
} as InterfaceSpec);
const calls = (id: string, contract: string, method: string, targets: [string, string][]): ImplementationSpec => ({
  id, name: id, description: 'd', contract, createdAt: now, updatedAt: now,
  methods: [{
    name: method,
    narrative: targets.map(([targetComponent, targetMethod], i) => ({
      stepNumber: i + 1, description: `call ${targetComponent}`, type: 'call', targetComponent, targetMethod,
    })),
  }],
} as ImplementationSpec);
const valueType = (id: string, subsystem: string, fields: { name: string; type: string }[]): TypeSpec => ({
  id, name: id, description: 'd', kind: 'value-object', subsystem, fields, createdAt: now, updatedAt: now,
} as TypeSpec);

/** A fresh project root with packs pinned off, so no machine-level pack changes a verdict. */
function projectRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(dir, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'top', name: path.basename(dir),
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  return dir;
}

/**
 * A parent whose `billing` subsystem is about to move out. Billing reaches beyond
 * itself in each form a stored reference takes — a bare id into the sibling
 * `shared`, an id qualified by the chained project `ledger`, a root-anchored id —
 * and uses a type `shared` owns, beside references that stay inside billing.
 */
function family(): { root: string; childDir: string } {
  const top = projectRoot('migrate-out-');
  setProjectRoot(top);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'root-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });

  saveSpec('subsystem', sub('shared', { publicInterfaces: [{ type: 'Custom', details: 'shared api', component: 'shared_portal' }] } as Partial<SubsystemSpec>));
  saveComponentSpec(comp('shared_portal', 'shared', 'Portal', { portalType: 'Custom' }));
  saveInterfaceSpec(intf('ishared_portal', 'shared_portal', 'pay', [{ name: 'amount', type: 'money' }]));
  saveTypeSpec(valueType('money', 'shared', [{ name: 'amount', type: 'number' }]));

  writeLegacyMount(sub('ledger', { projectPath: 'packages/ledger' }), 'ledger');
  const ledger = workspaceFor(path.join(top, 'packages', 'ledger'));
  ledger.save('subsystem', sub('ledger', { parentSystem: 'ledger', publicInterfaces: [{ type: 'Custom', details: 'ledger api', component: 'ledger_portal' }] } as Partial<SubsystemSpec>));
  ledger.saveComponentSpec(comp('ledger_portal', 'ledger', 'Portal', { portalType: 'Custom' }));
  ledger.saveInterfaceSpec(intf('iledger_portal', 'ledger_portal', 'post'));

  saveSpec('subsystem', sub('billing', {
    publicInterfaces: [{ type: 'Custom', details: 'billing api', component: 'billing_portal' }],
    lifecycle: [{ phase: 'init', component: 'billing_portal', method: 'open' }],
  } as Partial<SubsystemSpec>));
  saveComponentSpec(comp('billing_portal', 'billing', 'Portal', {
    portalType: 'Custom', dependsOn: ['billing_orch'],
    dispatch: [{ capability: 'billing.charge', component: 'billing_orch', method: 'charge' }],
  }));
  saveInterfaceSpec(intf('ibilling_portal', 'billing_portal', 'open'));
  saveComponentSpec(comp('billing_orch', 'billing', 'Orchestrator', { dependsOn: ['billing_adapter'] }));
  saveInterfaceSpec(intf('ibilling_orch', 'billing_orch', 'charge', [{ name: 'amount', type: 'money' }]));
  saveImplementationSpec(calls('billing_orch_impl', 'ibilling_orch', 'charge', [['billing_adapter', 'charge']]));
  saveComponentSpec(comp('billing_adapter', 'billing', 'Adapter', { dependsOn: ['shared_portal', 'ledger::ledger_portal'] }));
  saveInterfaceSpec(intf('ibilling_adapter', 'billing_adapter', 'charge', [{ name: 'amount', type: 'money' }]));
  saveImplementationSpec(calls('billing_adapter_impl', 'ibilling_adapter', 'charge', [['shared_portal', 'pay'], ['ledger::ledger_portal', 'post']]));
  saveComponentSpec(comp('billing_audit', 'billing', 'Adapter', { dependsOn: ['::shared_portal'] }));
  saveTypeSpec(valueType('invoice', 'billing', [{ name: 'total', type: 'money' }]));
  invalidateSpecCache();
  return { root: top, childDir: path.join(top, 'packages', 'billing') };
}

function verdict(at: string): ValidationResult {
  invalidateSpecCache();
  setProjectRoot(at);
  return validateProject();
}

/** Findings on whether a reference resolves, and on the edge it resolves to, as `CODE @specId` with `strip` removed. */
function referenceFindings(res: ValidationResult, strip = ''): string[] {
  return res.issues
    // A deprecated FORM is a notice about how a reference is written, not
    // whether it resolves: the fixture's root-anchored `::` id is one on purpose.
    .filter((i) => /REFERENCE|UNRESOLVED|ENTRYPOINT|DISPATCH|CAPABILITY|CROSS_SUBSYSTEM/.test(i.code) && i.code !== 'DEPRECATED_REFERENCE_FORM')
    .map((i) => `${i.code} @${strip && i.specId?.startsWith(strip) ? i.specId.slice(strip.length) : i.specId}`)
    .sort();
}

/** A spec file under a project's specs dir, as stored. */
const stored = (projectDir: string, rel: string): any =>
  readYamlFile(path.join(projectDir, '.wai', 'specs', ...rel.split('/')));

const callTargets = (impl: any): string[] =>
  impl.methods.flatMap((m: any) => m.narrative.map((s: any) => s.targetComponent));

/** Every reference a subsystem's spec files store, per file — each field a migration may rewrite. */
function storedReferences(projectDir: string, subsystem: string): Record<string, unknown> {
  const dir = path.join(projectDir, '.wai', 'specs', subsystem);
  const out: Record<string, unknown> = {};
  for (const file of listFilesRecursive(dir, '.yaml')) {
    const raw = readYamlFile(file) as any;
    out[path.relative(dir, file).replace(/\\/g, '/')] = {
      dependsOn: raw.dependsOn,
      dispatch: raw.dispatch?.map((b: any) => b.component),
      lifecycle: raw.lifecycle?.map((le: any) => le.component),
      paramTypes: raw.component ? raw.methods?.flatMap((m: any) => (m.params ?? []).map((p: any) => p.type)) : undefined,
      callTargets: raw.contract ? callTargets(raw) : undefined,
      fieldTypes: raw.fields?.map((f: any) => f.type),
    };
  }
  return out;
}

describe("externalize/internalize keep the moved subtree's outgoing references", () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  it('from the parent root, each moved reference resolves to the target it had — no new reference findings', () => {
    const fam = family();
    root = fam.root;
    const before = referenceFindings(verdict(fam.root));
    // Stage 3 binds the root-anchored id from the bound root: at the top it names
    // the top's own shared_portal, so nothing is unresolved before the move.
    expect(before).toEqual([]);

    externalizeSubsystem('billing', 'packages/billing', 'project');

    expect(referenceFindings(verdict(fam.root), 'billing::').filter((f) => !before.includes(f))).toEqual([]);
    // What the member stores: a bare id into the parent names the parent by its
    // project id; a target qualified by another member stays as written (a
    // deprecated member path, left to `wairon doctor --fix`)…
    expect(stored(fam.childDir, 'billing/billing_adapter/.index.yaml').dependsOn)
      .toEqual(['top::shared_portal', 'ledger::ledger_portal']);
    expect(callTargets(stored(fam.childDir, 'billing/billing_adapter/.implementation.yaml')))
      .toEqual(['top::shared_portal', 'ledger::ledger_portal']);
    // …the parent is declared as the member's external, importing by name the
    // bare type it now owns (stage 4: a bare name resolves locally, then through
    // a `use` import — never by a family-wide suffix match)…
    expect(projectConfigRepositoryAt(fam.childDir).load()?.externals).toEqual({ top: { use: ['money'] } });
    // …and the parent exports what the member reaches across the new boundary:
    // the portal its subsystem already published, and the imported type.
    expect(stored(fam.root, '.index.yaml').publicInterfaces).toEqual([
      { component: 'shared_portal', from: 'shared', audience: 'project' },
      { from: 'shared', typeDef: 'money', audience: 'project' },
    ]);
    expect(stored(fam.root, 'shared/.index.yaml').publicInterfaces).toContainEqual({ typeDef: 'money' });
    // The parent's own gate holds no error after the move.
    expect(verdict(fam.root).issues.filter((i) => i.severity === 'error')).toEqual([]);
    // …a root-anchored target as written: it names the same spec at every depth…
    expect(stored(fam.childDir, 'billing/billing_audit/.index.yaml').dependsOn).toEqual(['::shared_portal']);
    // …and a type as written: the `use` import above is what now resolves it.
    expect(stored(fam.childDir, 'billing/billing_adapter/.interface.yaml').methods[0].params)
      .toEqual([{ name: 'amount', type: 'money' }]);
    expect(stored(fam.childDir, 'billing/types/invoice.yaml').fields.map((f: any) => f.type)).toEqual(['money']);
  });

  it('from the child root the references into the parent are judged against its pins alone — unpinned, unavailable', () => {
    const fam = family();
    root = fam.root;
    externalizeSubsystem('billing', 'packages/billing', 'project');

    const fromChild = verdict(fam.childDir);

    // Stage 4: nothing is resolved through the parent. The member declares the
    // parent as an external; until it is pinned, its references into it have
    // nothing to be judged against — never a pass, never a typo-grade error.
    expect(fromChild.issues.some((i) => i.code === 'EXTERNAL_CHECK_UNAVAILABLE')).toBe(true);
    // The one exception is the deprecated root-anchored `::shared_portal`: a
    // leading `::` reads from whichever root loads it, so from the member's own
    // root it names the member's own (absent) spec — the reason it is
    // deprecated, and `doctor --fix` rewrites it.
    expect(fromChild.issues.filter((i) => i.code === 'INVALID_DEPENDENCY_REFERENCE' || i.code === 'INVALID_TARGET_COMPONENT_REFERENCE').map((i) => i.specId))
      .toEqual(['billing_audit']);
  });

  it('internalizing afterwards restores every reference as the parent wrote it', () => {
    const fam = family();
    root = fam.root;
    const authored = storedReferences(fam.root, 'billing');
    const before = referenceFindings(verdict(fam.root));

    externalizeSubsystem('billing', 'packages/billing', 'project');
    expect(storedReferences(fam.childDir, 'billing')).not.toEqual(authored);
    internalizeMember('billing', { home: '' });

    expect(storedReferences(fam.root, 'billing')).toEqual(authored);
    expect(referenceFindings(verdict(fam.root))).toEqual(before);
  });

  it('references inside the moved subtree stay bare beside the ones that leave it', () => {
    const fam = family();
    root = fam.root;
    // One list naming both a billing component and a component outside billing.
    saveComponentSpec(comp('billing_orch', 'billing', 'Orchestrator', { dependsOn: ['billing_adapter', 'shared_portal'] }));

    externalizeSubsystem('billing', 'packages/billing', 'project');

    expect(stored(fam.childDir, 'billing/billing_orch/.index.yaml').dependsOn).toEqual(['billing_adapter', 'top::shared_portal']);
    expect(callTargets(stored(fam.childDir, 'billing/billing_orch/.implementation.yaml'))).toEqual(['billing_adapter']);
    const portal = stored(fam.childDir, 'billing/billing_portal/.index.yaml');
    expect(portal.dependsOn).toEqual(['billing_orch']);
    expect(portal.dispatch.map((b: any) => b.component)).toEqual(['billing_orch']);
    const index = stored(fam.childDir, 'billing/.index.yaml');
    expect(index.lifecycle.map((le: any) => le.component)).toEqual(['billing_portal']);
    // The subsystem a moved component belongs to is the mount itself.
    expect(stored(fam.childDir, 'billing/billing_adapter/.index.yaml').subsystem).toBe('billing');
  });

  it('a moved super:: whose target lies above the bound root is refused before anything moves', () => {
    // top ─mounts─▶ par, whose billing subsystem moves out into a project of its own.
    const top = projectRoot('migrate-hop-');
    root = top;
    setProjectRoot(top);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'top-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSpec('subsystem', sub('top_sub', { parentSystem: 'top-sys', publicInterfaces: [{ type: 'Custom', details: 'top api', component: 'top_portal' }] } as Partial<SubsystemSpec>));
    saveComponentSpec(comp('top_portal', 'top_sub', 'Portal', { portalType: 'Custom' }));
    saveInterfaceSpec(intf('itop_portal', 'top_portal', 'fetch'));
    writeLegacyMount(sub('par', { parentSystem: 'top-sys', projectPath: 'packages/par' }), 'par');

    const parDir = path.join(top, 'packages', 'par');
    invalidateSpecCache();
    setProjectRoot(parDir);
    saveSpec('subsystem', sub('billing', { parentSystem: 'par' }));
    saveComponentSpec(comp('billing_adapter', 'billing', 'Adapter', { dependsOn: ['super::top_portal'] }));
    saveInterfaceSpec(intf('ibilling_adapter', 'billing_adapter', 'charge'));
    saveImplementationSpec(calls('billing_adapter_impl', 'ibilling_adapter', 'charge', [['super::top_portal', 'fetch']]));
    invalidateSpecCache();
    expect(referenceFindings(verdict(top))).toEqual([]);

    // Bound at par, `super::top_portal` climbs above the bound root: its target
    // cannot be named from here (wairon never writes `super::`), so nothing moves.
    setProjectRoot(parDir);
    invalidateSpecCache();
    expect(() => externalizeSubsystem('billing', 'packages/billing', 'project')).toThrow(/climb.*above this project.*doctor --fix/);
    expect(fs.existsSync(path.join(parDir, 'packages', 'billing'))).toBe(false);
    expect(stored(parDir, 'billing/billing_adapter/.index.yaml').dependsOn).toEqual(['super::top_portal']);
  });

  it('a bare reference back into the parent round-trips through `<parent id>::name`', () => {
    const top = projectRoot('migrate-sib-');
    root = top;
    setProjectRoot(top);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'top-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSpec('subsystem', sub('top_sub', { parentSystem: 'top-sys', publicInterfaces: [{ type: 'Custom', details: 'top api', component: 'top_portal' }] } as Partial<SubsystemSpec>));
    saveComponentSpec(comp('top_portal', 'top_sub', 'Portal', { portalType: 'Custom' }));
    saveSpec('subsystem', sub('billing', { parentSystem: 'top-sys' }));
    saveComponentSpec(comp('billing_adapter', 'billing', 'Adapter', { dependsOn: ['top_portal'] }));
    invalidateSpecCache();

    externalizeSubsystem('billing', 'packages/billing', 'project');
    const billingDir = path.join(top, 'packages', 'billing');
    expect(stored(billingDir, 'billing/billing_adapter/.index.yaml').dependsOn).toEqual(['top::top_portal']);
    expect(referenceFindings(verdict(top))).toEqual([]);

    setProjectRoot(top);
    internalizeMember('billing', { home: '' });
    expect(stored(top, 'billing/billing_adapter/.index.yaml').dependsOn).toEqual(['top_portal']);
    expect(referenceFindings(verdict(top))).toEqual([]);
  });
});

describe('externalize moves every file the subsystem owns, whatever the layout keeps it in', () => {
  let top: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (top) fs.rmSync(top, { recursive: true, force: true });
  });

  /** A project with billing (an orchestrator, its contract and implementation, a type) beside ledger; flat when `flat`. */
  function seedLayout(flat: boolean): void {
    top = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-layout-'));
    const specsDir = path.join(top, '.wai', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    writeYamlFile(path.join(top, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', id: 'shop', name: 'shop', targets: [],
      rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    // The flat layout: subsystems live as subsystems/<id>.yaml once that folder holds one.
    if (flat) {
      fs.mkdirSync(path.join(specsDir, 'subsystems'), { recursive: true });
      writeYamlFile(path.join(specsDir, 'subsystems', 'ledger.yaml'), { id: 'ledger', name: 'ledger', description: 'the ledger', parentSystem: 'shop', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now });
    }
    setProjectRoot(top);
    invalidateSpecCache();
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'shop', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    if (!flat) saveSpec('subsystem', { id: 'ledger', name: 'ledger', description: 'the ledger', parentSystem: 'shop', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now } as SubsystemSpec);
    saveSpec('subsystem', { id: 'billing', name: 'billing', description: 'billing', parentSystem: 'shop', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now } as SubsystemSpec);
    saveComponentSpec({ id: 'bill_orch', name: 'Bill', description: 'workflow', subsystem: 'billing', componentType: 'Orchestrator', owns: [], dependsOn: [], createdAt: now, updatedAt: now } as any);
    saveInterfaceSpec({ id: 'ibill_orch', name: 'IBill', description: 'c', component: 'bill_orch', methods: [{ name: 'charge', description: 'charge', params: [{ name: 'r', type: 'receipt' }], returns: 'void' }], createdAt: now, updatedAt: now } as any);
    saveImplementationSpec({ id: 'bill_orch_impl', name: 'Bill impl', description: 'i', contract: 'ibill_orch', sourcePath: 'src/billing/orch.ts', methods: [{ name: 'charge', narrative: [{ stepNumber: 1, description: 'Charge', type: 'local' }] }], createdAt: now, updatedAt: now } as any);
    saveTypeSpec({ id: 'receipt', name: 'Receipt', description: 'r', subsystem: 'billing', kind: 'value-object', fields: [{ name: 'amount', type: 'int' }], methods: [], createdAt: now, updatedAt: now } as any);
    invalidateSpecCache();
  }

  /** Every spec document under a specs folder naming the subsystem, as a path relative to it. */
  function naming(dir: string, subsystem: string): string[] {
    return listFilesRecursive(path.join(dir, '.wai', 'specs'), '.yaml')
      .filter((f) => {
        const raw = readYamlFile(f) as any;
        return raw?.subsystem === subsystem || raw?.id === subsystem || raw?.component === 'bill_orch' || raw?.contract === 'ibill_orch';
      })
      .map((f) => path.relative(path.join(dir, '.wai', 'specs'), f).replace(/\\/g, '/'))
      .sort();
  }

  it('flat layout: the subsystems/ file, its components, contracts, implementations and shared types/ files all move', () => {
    seedLayout(true);
    const before = naming(top, 'billing');
    expect(before).toContain('types/receipt.yaml');
    expect(before).toContain('subsystems/billing.yaml');

    externalizeSubsystem('billing', 'packages/billing');

    const part = path.join(top, 'packages', 'billing');
    // Nothing of billing is left in the parent; each file sits at the same place under the part.
    expect(naming(top, 'billing')).toEqual([]);
    expect(naming(part, 'billing')).toEqual(before);
    // The implementation's source path is re-expressed from the part's root.
    const impl = listFilesRecursive(path.join(part, '.wai', 'specs'), '.yaml').map((f) => readYamlFile(f) as any).find((r) => r?.id === 'bill_orch_impl');
    expect(impl.sourcePath).toBe('../../src/billing/orch.ts');
    // ledger stays, and the tree still reads the moved type as billing's.
    expect(fs.existsSync(path.join(top, '.wai', 'specs', 'subsystems', 'ledger.yaml'))).toBe(true);
    expect(referenceFindings(verdict(top))).toEqual([]);
  });

  it('nested layout: a type of the subsystem kept in the shared types/ folder moves with its folder', () => {
    seedLayout(false);
    // A shared types/ file naming billing, as a hand-written or flat-era type is kept.
    const stray = path.join(top, '.wai', 'specs', 'types', 'refund.yaml');
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    writeYamlFile(stray, { id: 'refund', name: 'Refund', description: 'r', subsystem: 'billing', kind: 'value-object', fields: [{ name: 'amount', type: 'int' }], methods: [], createdAt: now, updatedAt: now });
    invalidateSpecCache();

    externalizeSubsystem('billing', 'packages/billing');

    const part = path.join(top, 'packages', 'billing');
    expect(naming(top, 'billing')).toEqual([]);
    expect(fs.existsSync(path.join(part, '.wai', 'specs', 'types', 'refund.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(part, '.wai', 'specs', 'billing', '.index.yaml'))).toBe(true);
    // The emptied shared folder goes with it.
    expect(fs.existsSync(path.join(top, '.wai', 'specs', 'types'))).toBe(false);
    expect(referenceFindings(verdict(top))).toEqual([]);
  });
});
