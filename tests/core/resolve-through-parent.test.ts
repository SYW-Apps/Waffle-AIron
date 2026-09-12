import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec, saveInterfaceSpec,
  invalidateSpecCache, workspaceFor,
} from '../../src/core/specs.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import { validateSddTree, type ValidationOptions, type ValidationResult } from '../../src/core/validation.js';
import { isCiDraftWaivable } from '../../src/commands/validate.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// A chained subproject must never be judged more leniently from its own root
// than from its parent's.
//
// It used to be. With the parent on disk, validating the child standalone
// turned every reference into the parent into an UNVERIFIED_EXTERNAL_REF warning
// that `--ci` waives — including references the parent judges as hard boundary
// violations. The child passed its gate while the same specs failed the
// parent's, and nothing hosted ever delivered the surface snapshots meant to
// cover the gap, so a hosted subproject lock passed with real violations in it.
//
// The fix resolves through the parent that `findChainingParent` already finds on
// this exact code path. The property was pinned with `it.fails` before the fix
// (step 0) — passing while the hole was open, failing the moment it closed — so
// the fix could not land without these becoming live assertions.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);

/**
 * A parent that publishes one Portal and keeps one Store private, mounting a
 * chained child `kid` whose components exercise each way of crossing into it.
 */
function family(): { root: string; kidDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rtp-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'parent',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'root-system', vision: 'v',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec(subsystem('parent-sub', {
    publicInterfaces: [{ type: 'Custom', details: 'the published portal', component: 'parent-portal' }],
  } as Partial<SubsystemSpec>));
  saveComponentSpec(component('parent-portal', 'parent-sub', { componentType: 'Portal', portalType: 'Custom' } as Partial<ComponentSpec>));
  saveComponentSpec(component('parent-store', 'parent-sub', { componentType: 'Store' }));
  saveInterfaceSpec({
    id: 'iparent-portal', name: 'ip', description: 'd', component: 'parent-portal',
    status: 'complete', createdAt: now, updatedAt: now,
    methods: [{ name: 'realMethod', description: 'd', signature: 'realMethod(): void', returns: 'void' }],
  } as InterfaceSpec);
  createChainedSubsystem(subsystem('kid', { projectPath: 'packages/kid' }), 'kid');

  const kidDir = path.join(root, 'packages', 'kid');
  const kid = workspaceFor(kidDir);
  kid.saveSystemSpec({
    schemaVersion: '1.0.0', name: 'kid-system', vision: 'v',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  kid.saveSubsystemSpec(subsystem('k-core', { parentSystem: 'kid-system' }));
  // An Orchestrator crossing a subsystem boundary: only Adapters may.
  kid.saveComponentSpec(component('k-orch', 'k-core', { dependsOn: ['super::parent-portal'] }));
  // The legitimate crossing — an Adapter into the PUBLISHED portal. The control.
  kid.saveComponentSpec(component('k-adapter', 'k-core', { componentType: 'Adapter', dependsOn: ['super::parent-portal'] }));
  // An Adapter reaching a Store the parent never published.
  kid.saveComponentSpec(component('k-store-adapter', 'k-core', { componentType: 'Adapter', dependsOn: ['super::parent-store'] }));
  // A BARE id: from inside a mount it qualifies to `kid::parent-portal`, which
  // does not exist — a typo-grade error, not a cross-tree reference at all.
  kid.saveComponentSpec(component('k-bare', 'k-core', { dependsOn: ['parent-portal'] }));
  // A legitimate crossing whose narrative calls a method the portal lacks.
  kid.saveComponentSpec(component('k-caller', 'k-core', { componentType: 'Adapter', dependsOn: ['super::parent-portal'] }));
  kid.saveInterfaceSpec({
    id: 'ik-caller', name: 'ik', description: 'd', component: 'k-caller',
    status: 'complete', createdAt: now, updatedAt: now,
    methods: [{ name: 'go', description: 'd', signature: 'go(): void', returns: 'void' }],
  } as InterfaceSpec);
  kid.saveImplementationSpec({
    id: 'k-caller-impl', name: 'i', description: 'd', contract: 'ik-caller',
    status: 'complete', createdAt: now, updatedAt: now,
    methods: [{ name: 'go', narrative: [{
      stepNumber: 1, description: 'call the parent', type: 'call',
      targetComponent: 'super::parent-portal', targetMethod: 'noSuchMethod',
    }] }],
  } as ImplementationSpec);
  invalidateSpecCache();
  return { root, kidDir };
}

function verdict(root: string, opts?: ValidationOptions): ValidationResult {
  invalidateSpecCache();
  setProjectRoot(root);
  return opts ? validateSddTree(opts) : validateSddTree();
}

/** The errors as `CODE @specId`, with a mount prefix stripped so both roots compare. */
function errors(res: ValidationResult, stripPrefix = ''): string[] {
  return res.issues
    .filter((i) => i.severity === 'error')
    .map((i) => {
      const id = i.specId ?? '(none)';
      return `${i.code} @${stripPrefix && id.startsWith(stripPrefix) ? id.slice(stripPrefix.length) : id}`;
    })
    .sort();
}

const PARENT_JUDGEMENT = [
  'CROSS_SUBSYSTEM_NON_ADAPTER @kid::k-orch',
  'CROSS_SUBSYSTEM_PRIVATE_ACCESS @kid::k-store-adapter',
  'INVALID_DEPENDENCY_REFERENCE @kid::k-bare',
  'INVALID_TARGET_METHOD_REFERENCE @kid::k-caller-impl',
];

describe('a chained child judged from its own root vs its parent', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  it('the parent, scoped to the mount, judges each violation as an error — and the clean edge as clean', () => {
    // The fixture's soundness, and the reference verdict. This is true today and
    // must stay true: it is what the child's own verdict is measured against.
    const fam = family();
    root = fam.root;

    const fromParent = verdict(fam.root, { scopeSubsystem: 'kid', recursive: true });

    expect(errors(fromParent)).toEqual(PARENT_JUDGEMENT);
    expect(fromParent.valid).toBe(false);
    expect(fromParent.issues.filter((i) => i.specId === 'kid::k-adapter' && i.code !== 'UNUSED_COMPONENT')).toEqual([]);
  });

  it('a child validated standalone reports every error its parent does', () => {
    const fam = family();
    root = fam.root;
    const parentErrors = errors(verdict(fam.root, { scopeSubsystem: 'kid', recursive: true }), 'kid::');

    const fromChild = verdict(fam.kidDir);

    expect(errors(fromChild)).toEqual(expect.arrayContaining(parentErrors));
    expect(fromChild.valid).toBe(false);
  });

  it('an edge the parent resolves cleanly raises nothing from the child root', () => {
    // The clean Adapter→published-Portal edge used to come back as an unverified
    // external reference, indistinguishable from the real violations beside it.
    const fam = family();
    root = fam.root;

    const fromChild = verdict(fam.kidDir);

    expect(fromChild.issues.filter((i) => i.specId === 'k-adapter' && i.code !== 'UNUSED_COMPONENT')).toEqual([]);
  });
});

describe('step 1a — a mount keeps its own loader issues when its parent validates it', () => {
  // Union with the parent's verdict is only never-quieter if the parent's run
  // actually carries the child's own findings. A malformed spec inside a mount
  // was reported under a bare FILE STEM — `.index`, in the nested layout — which
  // no scope filter can place, so validating the parent scoped to the mount
  // silently dropped the child's schema error.
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  function withBrokenChildSpec(): { root: string; kidDir: string } {
    const fam = family();
    const dir = path.join(fam.kidDir, '.wai', 'specs', 'k-core', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.index.yaml'), [
      'schemaVersion: 1.0.0', 'id: broken', 'name: Broken', 'description: d',
      'subsystem: k-core', 'componentType: NotAStereotype', 'owns: []', 'dependsOn: []',
      'status: complete', `createdAt: '${now}'`, `updatedAt: '${now}'`, '',
    ].join('\n'));
    invalidateSpecCache();
    return fam;
  }

  it('from the child root, the issue names the spec — not the `.index` file it lives in', () => {
    const fam = withBrokenChildSpec();
    root = fam.root;

    const schema = verdict(fam.kidDir).issues.filter((i) => i.code === 'SCHEMA_VALIDATION_ERROR');

    expect(schema.map((i) => i.specId)).toEqual(['broken']);
  });

  it('from the parent root scoped to the mount, the schema error survives the scope', () => {
    const fam = withBrokenChildSpec();
    root = fam.root;

    const scoped = verdict(fam.root, { scopeSubsystem: 'kid', recursive: true });

    expect(scoped.issues.filter((i) => i.code === 'SCHEMA_VALIDATION_ERROR').map((i) => i.specId)).toEqual(['kid::broken']);
    expect(scoped.valid).toBe(false);
  });
});

describe('step 1b — a surface held inside a mount decides that mount\'s references from the parent root too', () => {
  // A chained child may consume a FOREIGN project's surface: an authored or
  // exchanged snapshot kept in its own `.wai/surfaces/`. From the child's root
  // that works — `super::crm-portal` resolves against the snapshot. From the
  // parent root it did not: the parent never read the child's surfaces folder,
  // and `super::crm-portal` qualifies to a bare `crm-portal` there, which the
  // rules take for a local typo. The same spec was clean from one root and an
  // INVALID_*_REFERENCE error from the other.
  //
  // The fix must soften nothing: a child's surface decides ONLY references made
  // from inside that mount, and a reference no surface covers stays the error
  // it was.
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  function withChildHeldSurface(): { root: string; kidDir: string } {
    const fam = family();
    writeYamlFile(path.join(fam.kidDir, '.wai', 'surfaces', 'crm.yaml'), {
      projectName: 'crm', origin: 'authored', generatedAt: now, types: [],
      interfaces: [{
        id: 'icrm', name: 'CRM', component: 'crm-portal', audience: 'external', type: 'REST', details: 'crm',
        methods: [{ name: 'getCustomer', description: 'd', signature: 'getCustomer(): void', returns: 'void' }],
      }],
    });
    const kid = workspaceFor(fam.kidDir);
    // The legitimate consumer.
    kid.saveComponentSpec(component('crm-adapter', 'k-core', { componentType: 'Adapter', dependsOn: ['super::crm-portal'] }));
    // A non-Adapter crossing into the foreign surface.
    kid.saveComponentSpec(component('crm-orch', 'k-core', { dependsOn: ['super::crm-portal'] }));
    // An Adapter calling a method the foreign surface does not expose.
    kid.saveComponentSpec(component('crm-caller', 'k-core', { componentType: 'Adapter', dependsOn: ['super::crm-portal'] }));
    kid.saveInterfaceSpec({
      id: 'icrm-caller', name: 'icc', description: 'd', component: 'crm-caller',
      status: 'complete', createdAt: now, updatedAt: now,
      methods: [{ name: 'fetch', description: 'd', signature: 'fetch(): void', returns: 'void' }],
    } as InterfaceSpec);
    kid.saveImplementationSpec({
      id: 'crm-caller-impl', name: 'ci', description: 'd', contract: 'icrm-caller',
      status: 'complete', createdAt: now, updatedAt: now,
      methods: [{ name: 'fetch', narrative: [{
        stepNumber: 1, description: 'ask crm', type: 'call',
        targetComponent: 'super::crm-portal', targetMethod: 'noSuchCall',
      }] }],
    } as ImplementationSpec);
    // The PARENT's own reference to the same name. The child imported crm; the
    // parent did not, so the child's surface must not cover this.
    setProjectRoot(fam.root);
    saveComponentSpec(component('parent-crm-client', 'parent-sub', { componentType: 'Adapter', dependsOn: ['crm-portal'] }));
    invalidateSpecCache();
    return fam;
  }

  /** Errors on the child's crm-* specs as `CODE @localId`. */
  function crmErrors(res: ValidationResult, stripPrefix = ''): string[] {
    return errors(res, stripPrefix).filter((e) => / @crm-/.test(e));
  }

  /** Any finding on crm-adapter beyond it being unused — it should have none. */
  function adapterNoise(res: ValidationResult, id: string): string[] {
    return res.issues.filter((i) => i.specId === id && i.code !== 'UNUSED_COMPONENT').map((i) => i.code);
  }

  const SURFACE_VERDICT = [
    'CROSS_SUBSYSTEM_NON_ADAPTER @crm-orch',
    'SURFACE_REF_NOT_EXPOSED @crm-caller-impl',
  ];

  it('from the child root, the held surface decides each crm edge — the reference verdict', () => {
    const fam = withChildHeldSurface();
    root = fam.root;

    const fromChild = verdict(fam.kidDir);

    expect(crmErrors(fromChild)).toEqual(SURFACE_VERDICT);
    expect(adapterNoise(fromChild, 'crm-adapter')).toEqual([]);
  });

  it('from the parent root, the same held surface decides the same edges the same way', () => {
    const fam = withChildHeldSurface();
    root = fam.root;

    const fromParent = verdict(fam.root);

    expect(crmErrors(fromParent, 'kid::')).toEqual(SURFACE_VERDICT);
    expect(adapterNoise(fromParent, 'kid::crm-adapter')).toEqual([]);
  });

  it("the child's surface never covers the parent's own reference — that stays an error", () => {
    const fam = withChildHeldSurface();
    root = fam.root;

    expect(errors(verdict(fam.root))).toContain('INVALID_DEPENDENCY_REFERENCE @parent-crm-client');
  });

  it('a reference inside the mount that no surface covers stays the error it was', () => {
    const fam = withChildHeldSurface();
    root = fam.root;

    expect(errors(verdict(fam.root))).toEqual(expect.arrayContaining(PARENT_JUDGEMENT));
  });
});

describe('step 3 — a chained child is judged through its parent when the parent is on disk', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  it('reports where the verdict came from', () => {
    const fam = family();
    root = fam.root;

    const fromChild = verdict(fam.kidDir);

    expect(fromChild.resolvedThrough).toEqual({ root: path.resolve(fam.root), scope: 'kid' });
  });

  it("names the parent's errors under the child's own ids — and the child is invalid", () => {
    const fam = family();
    root = fam.root;

    const fromChild = verdict(fam.kidDir);

    expect(errors(fromChild)).toEqual(PARENT_JUDGEMENT.map((e) => e.replace('@kid::', '@')));
    expect(fromChild.valid).toBe(false);
  });

  it("leaves no raw cross-tree warning behind for an edge the parent judged", () => {
    const fam = family();
    root = fam.root;

    const codes = verdict(fam.kidDir).issues.map((i) => i.code);

    expect(codes).not.toContain('CROSS_TREE_REF_UNRESOLVED');
  });

  it("keeps the child's own findings the parent never judges — a union, not a replacement", () => {
    // Code conformance is never judged from a parent for a chained child, so a
    // verdict that REPLACED the child's with the parent's would lose this.
    const fam = family();
    root = fam.root;

    const fromChild = verdict(fam.kidDir);

    expect(fromChild.issues.some((i) => i.code === 'MISSING_SOURCE_PATH' && i.specId === 'k-caller-impl')).toBe(true);
  });

  it('never reports the same finding twice', () => {
    const fam = family();
    root = fam.root;

    const keys = verdict(fam.kidDir).issues.map((i) => `${i.code}|${i.specId ?? ''}|${i.message}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a parent that cannot be loaded leaves every raw verdict standing — nothing rewritten, nothing waived', () => {
    const fam = family();
    root = fam.root;
    // The mount stays discoverable — findChainingParent reads subsystem files —
    // but the parent's L0 no longer parses, so there is no tree to resolve through.
    fs.writeFileSync(path.join(fam.root, '.wai', 'specs', '.index.yaml'), 'name: root-system\n');

    const fromChild = verdict(fam.kidDir);

    expect(fromChild.resolvedThrough).toBeUndefined();
    // A cross-tree form stays the raw warning, and --ci does not waive it: a
    // child that cannot be judged through its parent pins, or fails its gate.
    const crossTree = fromChild.issues.filter((i) => i.code === 'CROSS_TREE_REF_UNRESOLVED');
    expect(crossTree.length).toBeGreaterThan(0);
    expect(crossTree.every((i) => i.severity === 'warning' && !isCiDraftWaivable(i))).toBe(true);
    // A bare typo stays the error it is.
    expect(errors(fromChild)).toContain('INVALID_DEPENDENCY_REFERENCE @k-bare');
    expect(fromChild.valid).toBe(false);
  });

  it('a grandchild resolves through the TOP root, scoped to the whole mount chain', () => {
    const top = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rtp3-'));
    root = top;
    fs.mkdirSync(path.join(top, '.wai', 'specs'), { recursive: true });
    writeYamlFile(path.join(top, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', name: 'grand',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    setProjectRoot(top);
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'grand-system', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec(subsystem('grand-sub', {
      parentSystem: 'grand-system',
      publicInterfaces: [{ type: 'Custom', details: 'the published portal', component: 'grand-portal' }],
    } as Partial<SubsystemSpec>));
    saveComponentSpec(component('grand-portal', 'grand-sub', { componentType: 'Portal', portalType: 'Custom' } as Partial<ComponentSpec>));
    createChainedSubsystem(subsystem('par', { parentSystem: 'grand-system', projectPath: 'packages/par' }), 'par');

    const parDir = path.join(top, 'packages', 'par');
    invalidateSpecCache();
    setProjectRoot(parDir);
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'par-system', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    createChainedSubsystem(subsystem('kid2', { parentSystem: 'par-system', projectPath: 'packages/kid2' }), 'kid2');

    const kid2Dir = path.join(parDir, 'packages', 'kid2');
    const kid2 = workspaceFor(kid2Dir);
    kid2.saveSystemSpec({
      schemaVersion: '1.0.0', name: 'kid2-system', vision: 'v',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    kid2.saveSubsystemSpec(subsystem('k2-core', { parentSystem: 'kid2-system' }));
    kid2.saveComponentSpec(component('k2-orch', 'k2-core', { dependsOn: ['super::super::grand-portal'] }));
    kid2.saveComponentSpec(component('k2-adapter', 'k2-core', { componentType: 'Adapter', dependsOn: ['super::super::grand-portal'] }));
    invalidateSpecCache();

    const fromKid2 = verdict(kid2Dir);

    expect(fromKid2.resolvedThrough).toEqual({ root: path.resolve(top), scope: 'par::kid2' });
    expect(errors(fromKid2)).toEqual(['CROSS_SUBSYSTEM_NON_ADAPTER @k2-orch']);
  });
});
