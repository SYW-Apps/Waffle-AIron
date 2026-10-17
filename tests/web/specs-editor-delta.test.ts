import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, saveImplementationSpec, updateSpec,
  loadSystemSpec, loadInterfaceSpec, loadImplementationSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec } from '../../src/models/index.js';
import { buildDelta, listDelta, type SpecKind } from '../../web/src/views/specDelta.js';

// ---------------------------------------------------------------------------
// Round 6: sdd_update_spec MERGES lists of plain values (and upserts lists
// with an identity), so the hosted Specs value-editor — which used to send a
// list whole — silently kept every item a user removed. The editor's save
// delta (web/src/views/specDelta.ts) now sends removal markers and, when the
// merge would not keep the draft's order, removes everything and re-adds the
// draft in order. Each case below edits a spec the way the editor does,
// saves it through the REAL merge and reads it back.
// ---------------------------------------------------------------------------

const now = '2026-10-08T10:00:00Z';
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

function project(boundaries: unknown[] = [], technologies: unknown[] = ['mysql', 'redis', 'sendgrid']): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-editor-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'editor', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'editor', vision: 'editor fixture',
    boundaries: boundaries as never,
    globalRequirements: ['R1 first', { description: 'R2 second' }, 'R3 third', 'R4 fourth'],
    createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'editor',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'worker', description: 'the worker', subsystem: 'dom', componentType: 'Orchestrator',
    dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iworker', name: 'iworker', description: 'contract', component: 'worker',
    methods: [{ name: 'run', description: 'runs', signature: 'run(): void', params: [], returns: 'void', guarantees: ['idempotent', 'atomic', 'transactional'] }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  saveImplementationSpec({
    id: 'worker_impl', name: 'WorkerImpl', description: 'impl', contract: 'iworker', status: 'draft',
    technologies: technologies as never,
    methods: [{ name: 'run', narrative: [] } as never], createdAt: now, updatedAt: now,
  } as ImplementationSpec);
  invalidateSpecCache();
  return root;
}

/** One editor save: the delta the editor builds from what it loaded and what the user left, through the real merge. */
function save(kind: SpecKind, id: string, loaded: unknown, edited: unknown): void {
  const delta = buildDelta(kind, loaded, edited);
  updateSpec(kind as never, id, delta);
  invalidateSpecCache();
}

describe('the Specs value-editor round-trips list edits through the merging update (round 6)', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  it('control: the whole list the editor used to send keeps the removed requirement', () => {
    root = project();
    const loaded = loadSystemSpec()!;
    updateSpec('system', 'system', { globalRequirements: loaded.globalRequirements.filter((r) => r !== 'R3 third') });
    invalidateSpecCache();
    expect(loadSystemSpec()!.globalRequirements).toContain('R3 third');
  });

  it('removes a global requirement — text and { description } alike', () => {
    root = project();
    const loaded = loadSystemSpec()!;
    const edited = clone(loaded);
    edited.globalRequirements = ['R1 first', 'R4 fourth'];
    expect(listDelta('globalRequirements', loaded.globalRequirements, edited.globalRequirements)).toEqual([
      { description: 'R2 second', action: 'delete' }, { value: 'R3 third', action: 'delete' },
    ]);
    save('system', 'system', loaded, edited);
    expect(loadSystemSpec()!.globalRequirements).toEqual(['R1 first', 'R4 fourth']);
  });

  it('keeps the order of a reorder, an edit in place and an insertion', () => {
    root = project();
    const loaded = loadSystemSpec()!;
    const reordered = clone(loaded);
    reordered.globalRequirements = ['R4 fourth', 'R1 first', { description: 'R2 second' }, 'R3 third'];
    save('system', 'system', loaded, reordered);
    expect(loadSystemSpec()!.globalRequirements).toEqual(reordered.globalRequirements);

    const after = loadSystemSpec()!;
    const editedInPlace = clone(after);
    editedInPlace.globalRequirements = ['R4 fourth', 'R1 first (amended)', 'R0 inserted', { description: 'R2 second' }];
    save('system', 'system', after, editedInPlace);
    expect(loadSystemSpec()!.globalRequirements).toEqual(editedInPlace.globalRequirements);
  });

  it('clears a list the user emptied', () => {
    root = project();
    const loaded = loadSystemSpec()!;
    const edited = clone(loaded);
    edited.globalRequirements = [];
    save('system', 'system', loaded, edited);
    expect(loadSystemSpec()!.globalRequirements).toEqual([]);
  });

  it('removes and reorders boundaries written as text, as { name }, and mixed', () => {
    for (const boundaries of [
      ['In: specs', 'Out: billing', 'Out: hosting'],
      [{ name: 'In: specs' }, { name: 'Out: billing', description: 'not ours' }, { name: 'Out: hosting' }],
      ['In: specs', { name: 'Out: billing' }, 'Out: hosting'],
    ]) {
      root = project(boundaries);
      const loaded = loadSystemSpec()!;
      const removed = clone(loaded);
      removed.boundaries = [boundaries[2], boundaries[0]] as never;
      save('system', 'system', loaded, removed);
      expect(loadSystemSpec()!.boundaries).toEqual(removed.boundaries);
      setProjectRoot(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes and reorders an implementation\'s technologies, by name and as { name, matches }', () => {
    for (const technologies of [
      ['mysql', 'redis', 'sendgrid'],
      [{ name: 'mysql', matches: ['mysql2'] }, { name: 'redis', matches: ['ioredis'] }, { name: 'sendgrid', matches: ['@sendgrid/mail'] }],
    ]) {
      root = project([], technologies);
      const loaded = loadImplementationSpec('worker_impl')!;
      const edited = clone(loaded);
      edited.technologies = [technologies[2], technologies[0]] as never;
      save('implementation', 'worker_impl', loaded, edited);
      expect(loadImplementationSpec('worker_impl')!.technologies).toEqual(edited.technologies);
      setProjectRoot(null);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes and reorders a contract method\'s guarantees', () => {
    root = project();
    const loaded = loadInterfaceSpec('iworker')!;
    const removed = clone(loaded);
    removed.methods[0].guarantees = ['transactional', 'idempotent'];
    save('interface', 'iworker', loaded, removed);
    expect(loadInterfaceSpec('iworker')!.methods[0].guarantees).toEqual(['transactional', 'idempotent']);
  });

  it('sends nothing for an unchanged list', () => {
    expect(listDelta('guarantees', ['a', 'b'], ['a', 'b'])).toBeUndefined();
    expect(listDelta('guarantees', undefined, [])).toBeUndefined();
  });
});
