import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  invalidateSpecCache,
  listProjectRoots,
  loadComponentSpecs,
  loadSubsystemSpecs,
  normalizeReferences,
  workspaceFor,
} from '../../src/core/specs.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';
import { buildCanvasModel } from '../../src/core/canvas.js';
import { moveMountToMembers } from '../../src/core/provision.js';
import { deleteMount } from '../../src/core/specs.js';
import * as yaml from 'js-yaml';
import { validateSddTree } from '../../src/core/validation.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 3's properties over the reference family (tests/helpers): the loader
// without position. Real temp directories, the real scan and the real writer.
// ---------------------------------------------------------------------------

let family: ReferenceFamily | null = null;

function bind(root: string): void {
  invalidateSpecCache();
  setProjectRoot(root);
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  family?.cleanup();
  family = null;
});

const dependsOnOf = (id: string): string[] => loadComponentSpecs().find((c) => c.id === id)?.dependsOn ?? [];

describe('reference family: the loader without position', () => {
  it('keys every member by its project id, at every depth (depth-invariance)', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const keys = listProjectRoots().map((r) => r.namespace);
    expect(keys).toEqual(['', 'core', 'transpiler', 'shared']);
    // transpiler sits two levels down from the top and one from core: one key.
    const fromTop = loadComponentSpecs().map((c) => c.id).filter((id) => id.startsWith('transpiler::')).sort();
    bind(family.core);
    const fromCore = loadComponentSpecs().map((c) => c.id).filter((id) => id.startsWith('transpiler::')).sort();
    expect(fromTop).toEqual(['transpiler::lowering-core', 'transpiler::lowering-portal']);
    expect(fromCore).toEqual(fromTop);
  });

  it('binds the same reference to the same key from every root that reads it (root-invariance)', () => {
    family = buildReferenceFamily();
    bind(family.top);
    expect(dependsOnOf('core::engine-portal')).toEqual(['transpiler::lowering-portal']);
    bind(family.core);
    // core is the bound root here, so its own spec is bare — the reference is not.
    expect(dependsOnOf('engine-portal')).toEqual(['transpiler::lowering-portal']);
  });

  it('binds the deprecated forms for one release, each with its rewrite', () => {
    family = buildReferenceFamily();
    bind(family.top);
    // leading `::` from the top, through the member alias.
    expect(dependsOnOf('app-worker')).toEqual(['core::engine-portal']);
    // super:: climbs to core; a member path lands back home; `::` walks from the top.
    expect(dependsOnOf('transpiler::lowering-core')).toEqual(['core::engine-portal', 'transpiler::lowering-portal', 'core::engine-portal']);
    const refs = projectFamilyGraph().authoredReferences.filter((r) => r.specId === 'transpiler::lowering-core');
    expect(refs.map((r) => [r.authored, r.form, r.binding, r.rewrite])).toEqual([
      ['super::engine-portal', 'super', 'undeclared', 'core::engine-portal'],
      ['core::transpiler::lowering-portal', 'path', 'local', 'lowering-portal'],
      ['::core::engine-portal', 'leading', 'undeclared', 'core::engine-portal'],
    ]);
  });

  it('writes every untouched spec back byte for byte (writer-is-inverse)', () => {
    family = buildReferenceFamily();
    const before = new Map(family.specFiles().map((f) => [f, fs.readFileSync(f)]));
    bind(family.top);
    const ws = workspaceFor(family.top);
    const keep = { preserveUpdatedAt: true };
    const index = ws.scanAll();
    for (const s of index.subsystems) ws.saveSubsystemSpec(s, keep);
    for (const c of workspaceFor(family.top).scanAll().components) workspaceFor(family.top).saveComponentSpec(c, keep);
    for (const i of workspaceFor(family.top).scanAll().interfaces) workspaceFor(family.top).saveInterfaceSpec(i, keep);
    for (const t of workspaceFor(family.top).scanAll().types) workspaceFor(family.top).saveTypeSpec(t, keep);
    const after = new Map(family.specFiles().map((f) => [f, fs.readFileSync(f)]));
    expect([...after.keys()]).toEqual([...before.keys()]);
    for (const [file, bytes] of before) expect(after.get(file)!.equals(bytes), file).toBe(true);
  });

  it('never writes super::, a leading :: or a member path for a new reference', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const ws = workspaceFor(family.top);
    const portal = ws.scanAll().components.find((c) => c.id === 'transpiler::lowering-portal')!;
    // New references, handed over as in-memory keys: bare at home, alias::name
    // (the owning project's alias, else the producer's id) anywhere else.
    const written = ws.prepareComponentForWrite({ ...portal, dependsOn: ['core::engine-portal', 'transpiler::lowering-core', 'app-worker'] });
    expect(written.dependsOn).toEqual(['core::engine-portal', 'lowering-core', 'waffly::app-worker']);
  });

  it('normalizes the references of a spec to their canonical text, once', () => {
    family = buildReferenceFamily();
    bind(family.top);
    expect(normalizeReferences('component', 'transpiler::lowering-core')).toBe(true);
    const text = fs.readFileSync(path.join(family.transpiler, '.wai', 'specs', 'lowering', 'lowering-core', '.index.yaml'), 'utf8');
    const dependsOn = text.split(/\r?\n/).filter((line) => line.startsWith('  - '));
    expect(dependsOn).toEqual(['  - core::engine-portal', '  - lowering-portal', '  - core::engine-portal']);
    expect(text).not.toMatch(/super::|- ::/);
    bind(family.top);
    // The targets did not move, and a second run writes nothing.
    expect(dependsOnOf('transpiler::lowering-core')).toEqual(['core::engine-portal', 'transpiler::lowering-portal', 'core::engine-portal']);
    expect(normalizeReferences('component', 'transpiler::lowering-core')).toBe(false);
  });

  it('makes a local id that shadows an alias visible, and keeps the member reachable (shadowing-reachable)', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const issues = validateSddTree().issues;
    const shadow = issues.filter((i) => i.code === 'LOCAL_ID_SHADOWS_PROJECT');
    expect(shadow.map((i) => [i.severity, i.specId])).toEqual([['warning', 'core::transpiler']]);
    // `transpiler::lowering-portal` from core still reaches the member.
    expect(dependsOnOf('core::engine-portal')).toEqual(['transpiler::lowering-portal']);
    expect(loadSubsystemSpecs().map((s) => s.id)).toContain('core::transpiler');
  });

  it('gives a member no L1 spec in its parent, in either form (mount-carries-no-content)', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const subsystems = loadSubsystemSpecs().map((s) => s.id).sort();
    expect(subsystems).toEqual(['app', 'core::engine', 'core::transpiler', 'transpiler::lowering']);
    const top = listProjectRoots()[0];
    expect(top.specIds).not.toContain('shared');
    expect(top.specIds).not.toContain('core');
    const shared = projectFamilyGraph().nodes.find((n) => n.namespace === 'shared')!;
    expect(shared.mountForm).toBe('mount');
    expect(shared.legacyMount?.description).toBe('The vocabulary every project speaks');
    expect(shared.legacyMount?.publicInterfaces).toHaveLength(1);
    expect(projectFamilyGraph().nodes.find((n) => n.namespace === 'core')!.legacyMount).toBeNull();
  });

  it('reports the family findings stage 3 introduces', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const issues = validateSddTree().issues;
    const of = (code: string) => issues.filter((i) => i.code === code);
    expect(of('DEPRECATED_MOUNT_FORM').map((i) => i.specId)).toEqual(['shared']);
    expect(of('DUPLICATE_SPEC_ID').map((i) => [i.severity, i.specId])).toEqual([['error', 'shared::mode']]);
    // core, transpiler and shared are one strongly connected set: one loop, on each.
    expect(of('PROJECT_DEPENDENCY_CYCLE').map((i) => i.specId).sort()).toEqual(['core', 'shared', 'transpiler']);
    expect(of('DEPRECATED_REFERENCE_FORM').map((i) => i.message.match(/writes "([^"]+)"/)?.[1]).sort())
      .toEqual(['::core::engine-portal', '::core::engine-portal', 'core::transpiler::lowering-portal', 'super::engine-portal']);
    expect(of('PROJECT_ID_COLLISION')).toEqual([]);
  });

  it('draws a project node per member, its specs under it, ids honest', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const model = buildCanvasModel();
    const projects = model.subsystems.filter((s) => s.project).map((s) => [s.id, s.name, s.description]);
    expect(projects).toEqual([
      ['core', 'core', 'Core'],
      ['transpiler', 'transpiler', 'Transpiler'],
      ['shared', 'shared', 'The vocabulary every project speaks'],
    ]);
    // A member's own subsystems keep their honest keys, under its node.
    expect(model.subsystems.map((s) => s.id)).toContain('core::engine');
    expect(model.components.find((c) => c.id === 'core::engine-portal')?.subsystem).toBe('core::engine');
  });

  it('moves a legacy mount into `members` — its path and description — and deletes the L1 document, once', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const mountFile = path.join(family.top, '.wai', 'specs', 'shared', '.index.yaml');
    expect(fs.existsSync(mountFile)).toBe(true);
    expect(moveMountToMembers('shared')).toBe(true);
    expect(fs.existsSync(mountFile)).toBe(false);
    const config = yaml.load(fs.readFileSync(path.join(family.top, '.wai', 'project.yaml'), 'utf8')) as { members: unknown };
    expect(config.members).toEqual({ core: 'core', shared: { path: 'shared', description: 'The vocabulary every project speaks' } });
    bind(family.top);
    const shared = projectFamilyGraph().nodes.find((n) => n.namespace === 'shared')!;
    expect(shared.mountForm).toBe('members');
    expect(validateSddTree().issues.filter((i) => i.code === 'DEPRECATED_MOUNT_FORM')).toEqual([]);
    // Moved already: nothing to write.
    expect(moveMountToMembers('shared')).toBe(false);
    expect(() => moveMountToMembers('nowhere')).toThrow(/no legacy L1 mount/);
  });

  it('deletes only a legacy mount by its alias, refusing a subsystem with content', () => {
    family = buildReferenceFamily();
    bind(family.top);
    expect(() => deleteMount('app')).toThrow(/not a member declaration/);
    expect(deleteMount('nothing-here')).toBe(false);
    expect(deleteMount('shared')).toBe(true);
    expect(deleteMount('shared')).toBe(false);
  });
});

