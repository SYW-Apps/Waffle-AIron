import { afterEach, describe, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  invalidateSpecCache,
  listProjectRoots,
  loadComponentSpecs,
  loadSubsystemSpecs,
  workspaceFor,
} from '../../src/core/specs.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';
import { buildCanvasModel } from '../../src/core/canvas.js';
import { validateProject } from '../../src/core/validation.js';
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

  it('writes every untouched spec back byte for byte (writer-is-inverse)', () => {
    family = buildReferenceFamily();
    const before = new Map(family.specFiles().map((f) => [f, fs.readFileSync(f)]));
    bind(family.top);
    const ws = workspaceFor(family.top);
    const keep = { preserveUpdatedAt: true };
    const index = ws.scanAll();
    // The subsystem writer behind save('subsystem', …), reached directly for the
    // mechanical re-save's preserveUpdatedAt (the generic save always stamps).
    for (const s of index.subsystems) (ws as unknown as { writeSubsystemSpec(x: unknown, o: unknown): void }).writeSubsystemSpec(s, keep);
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

  it('makes a local id that shadows an alias visible, and keeps the member reachable (shadowing-reachable)', () => {
    family = buildReferenceFamily();
    // The shadowing is core's own finding: its gate reports it, the parent's never does (stage 4).
    bind(family.core);
    const shadow = validateProject().issues.filter((i) => i.code === 'LOCAL_ID_SHADOWS_PROJECT');
    expect(shadow.map((i) => [i.severity, i.specId])).toEqual([['warning', 'transpiler']]);
    bind(family.top);
    expect(validateProject().issues.filter((i) => i.code === 'LOCAL_ID_SHADOWS_PROJECT')).toEqual([]);
    // `transpiler::lowering-portal` from core still reaches the member.
    expect(dependsOnOf('core::engine-portal')).toEqual(['transpiler::lowering-portal']);
    expect(loadSubsystemSpecs().map((s) => s.id)).toContain('core::transpiler');
  });

  it('gives a member no L1 spec in its parent (member-carries-no-content)', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const subsystems = loadSubsystemSpecs().map((s) => s.id).sort();
    expect(subsystems).toEqual(['app', 'core::engine', 'core::transpiler', 'transpiler::lowering']);
    const top = listProjectRoots()[0];
    expect(top.specIds).not.toContain('shared');
    expect(top.specIds).not.toContain('core');
    const shared = projectFamilyGraph().nodes.find((n) => n.namespace === 'shared')!;
    expect(shared.memberDescription).toBe('The vocabulary every project speaks');
  });

  it('reports the family findings stage 3 introduces', () => {
    family = buildReferenceFamily();
    bind(family.top);
    const issues = validateProject().issues;
    const of = (code: string) => issues.filter((i) => i.code === code);
    // A member's findings are its own gate's (stage 4): shared's duplicate id.
    expect(of('DUPLICATE_SPEC_ID')).toEqual([]);
    bind(family.shared);
    expect(validateProject().issues.filter((i) => i.code === 'DUPLICATE_SPEC_ID').map((i) => [i.severity, i.specId])).toEqual([['error', 'mode']]);
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
});

