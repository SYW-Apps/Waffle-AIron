import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec,
  saveInterfaceSpec, saveImplementationSpec, saveTypeSpec,
  deleteSubsystemSpec, deleteComponentSpec, deleteInterfaceSpec,
  deleteImplementationSpec, deleteTypeSpec,
  loadSubsystemSpec, loadComponentSpec, loadInterfaceSpec,
  loadImplementationSpec, loadTypeSpec,
  getSubsystemPath, getComponentPath, getInterfacePath,
  getImplementationPath, getTypePath,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { removeSpecFile } from '../../src/core/spec-files.js';
import type {
  SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec, TypeSpec,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Deletes route through the file store (spec_file_store.remove).
//
// The store calls itself "the single file-I/O face of the spec repository" and
// says outright that it is the only spec-tree component that touches the disk.
// While the five delete*Spec methods unlinked files themselves, that claim was
// false: the one place the storage format is chosen never learned that a
// document had stopped existing. These tests hold the three things the move has
// to keep true — the document goes, the directories it emptied go with it, and
// the specs ROOT never does — plus the two a caller depends on: an absent
// document answers false instead of throwing, and the index cache is dropped so
// a read after a delete cannot serve a ghost.
// ---------------------------------------------------------------------------

const now = '2026-09-20T10:00:00Z';

function project(prefix: string): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'deletes', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  return root;
}

const subsystem = (): SubsystemSpec => ({
  id: 'dom', name: 'dom', description: 'the delete fixture domain',
  parentSystem: 'deletes', publicInterfaces: [], trustedLinks: [],
  status: 'draft', createdAt: now, updatedAt: now,
} as unknown as SubsystemSpec);

const component = (): ComponentSpec => ({
  id: 'worker', name: 'Worker', description: 'a worker component',
  subsystem: 'dom', componentType: 'Orchestrator', dependencyClass: 'pure',
  dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now,
} as unknown as ComponentSpec);

const iface = (): InterfaceSpec => ({
  id: 'iworker', name: 'iworker', description: 'contract', component: 'worker',
  methods: [{ name: 'run', description: 'runs', signature: 'run(): void', params: [], returns: 'void' }],
  status: 'draft', createdAt: now, updatedAt: now,
} as unknown as InterfaceSpec);

const impl = (): ImplementationSpec => ({
  id: 'worker_impl', name: 'worker_impl', description: 'impl', contract: 'iworker',
  detailLevel: 'sketch', technologies: [], methods: [],
  status: 'draft', createdAt: now, updatedAt: now,
} as unknown as ImplementationSpec);

const type = (): TypeSpec => ({
  kind: 'value-object', id: 'job', name: 'Job', description: 'a unit of work',
  subsystem: 'dom', fields: [], methods: [], createdAt: now, updatedAt: now,
} as unknown as TypeSpec);

describe('spec deletes route through the file store', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes the document and prunes the directories the deletion emptied, stopping at the specs root', () => {
    root = project('wairon-delete-prune-');
    const specsRoot = path.join(root, '.wai', 'specs');
    saveSubsystemSpec(subsystem());
    saveComponentSpec(component());

    const compPath = getComponentPath('worker');
    const compDir = path.dirname(compPath);
    const subPath = getSubsystemPath('dom');
    const subDir = path.dirname(subPath);
    expect(fs.existsSync(compPath)).toBe(true);
    expect(path.resolve(subDir)).not.toBe(path.resolve(compDir));

    // The component's own folder empties and goes; the subsystem's does not,
    // because the subsystem document is still sitting in it.
    expect(deleteComponentSpec('worker')).toBe(true);
    expect(fs.existsSync(compPath)).toBe(false);
    expect(fs.existsSync(compDir)).toBe(false);
    expect(fs.existsSync(subDir)).toBe(true);

    // Now the last document under the subsystem goes, so the walk empties the
    // subsystem folder too and arrives at the specs root — which must survive.
    expect(deleteSubsystemSpec('dom')).toBe(true);
    expect(fs.existsSync(subDir)).toBe(false);
    expect(fs.existsSync(specsRoot)).toBe(true);
    expect(fs.readdirSync(specsRoot)).toEqual([]);
  });

  it('leaves a directory standing while a sibling document is still in it', () => {
    root = project('wairon-delete-sibling-');
    saveSubsystemSpec(subsystem());
    saveTypeSpec(type());
    saveTypeSpec({ ...type(), id: 'invoice', name: 'Invoice' });

    const jobPath = getTypePath('job', 'dom');
    const invoicePath = getTypePath('invoice', 'dom');
    expect(path.dirname(jobPath)).toBe(path.dirname(invoicePath));

    expect(deleteTypeSpec('job')).toBe(true);
    expect(fs.existsSync(jobPath)).toBe(false);
    expect(fs.existsSync(path.dirname(jobPath))).toBe(true);
    expect(fs.existsSync(invoicePath)).toBe(true);
  });

  it('answers false for a document that was never there, without throwing', () => {
    root = project('wairon-delete-absent-');
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'deletes', vision: 'delete fixture',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });

    expect(deleteSubsystemSpec('nope')).toBe(false);
    expect(deleteComponentSpec('nope')).toBe(false);
    expect(deleteInterfaceSpec('nope')).toBe(false);
    expect(deleteImplementationSpec('nope')).toBe(false);
    expect(deleteTypeSpec('nope')).toBe(false);
  });

  it('deletes all five kinds and answers false on the second attempt', () => {
    root = project('wairon-delete-kinds-');
    saveSubsystemSpec(subsystem());
    saveComponentSpec(component());
    saveInterfaceSpec(iface());
    saveImplementationSpec(impl());
    saveTypeSpec(type());

    const paths = {
      implementation: getImplementationPath('worker_impl'),
      iface: getInterfacePath('iworker'),
      type: getTypePath('job', 'dom'),
      component: getComponentPath('worker'),
      subsystem: getSubsystemPath('dom'),
    };
    for (const p of Object.values(paths)) expect(fs.existsSync(p)).toBe(true);

    // Leaves first: an interface's path is resolved through its component, and
    // a type's through its subsystem, so they cannot outlive their parent.
    expect(deleteImplementationSpec('worker_impl')).toBe(true);
    expect(deleteInterfaceSpec('iworker')).toBe(true);
    expect(deleteTypeSpec('job')).toBe(true);
    expect(deleteComponentSpec('worker')).toBe(true);
    expect(deleteSubsystemSpec('dom')).toBe(true);

    for (const p of Object.values(paths)) expect(fs.existsSync(p)).toBe(false);
    expect(loadImplementationSpec('worker_impl')).toBeNull();
    expect(loadInterfaceSpec('iworker')).toBeNull();
    expect(loadTypeSpec('job')).toBeNull();
    expect(loadComponentSpec('worker')).toBeNull();
    expect(loadSubsystemSpec('dom')).toBeNull();

    expect(deleteImplementationSpec('worker_impl')).toBe(false);
    expect(deleteInterfaceSpec('iworker')).toBe(false);
    expect(deleteTypeSpec('job')).toBe(false);
    expect(deleteComponentSpec('worker')).toBe(false);
    expect(deleteSubsystemSpec('dom')).toBe(false);
  });

  it('drops the index cache on delete, so an immediate re-read cannot serve a ghost', () => {
    root = project('wairon-delete-cache-');
    saveSubsystemSpec(subsystem());
    saveComponentSpec(component());

    // Warm the cache: within the freshness TTL the next scan is served from it,
    // so a delete that did not invalidate would answer with the deleted spec.
    expect(loadComponentSpec('worker')?.id).toBe('worker');
    expect(deleteComponentSpec('worker')).toBe(true);
    expect(loadComponentSpec('worker')).toBeNull();
  });
});

describe('spec_file_store.remove', () => {
  let root: string;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('prunes upward only while directories are empty and never past the given root', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-store-remove-'));
    const specsRoot = path.join(root, 'specs');
    const deep = path.join(specsRoot, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'doc.yaml'), 'id: doc\n');
    fs.writeFileSync(path.join(specsRoot, 'a', 'keep.yaml'), 'id: keep\n');

    expect(removeSpecFile(path.join(deep, 'doc.yaml'), specsRoot)).toBe(true);
    expect(fs.existsSync(deep)).toBe(false);
    expect(fs.existsSync(path.join(specsRoot, 'a', 'b'))).toBe(false);
    // `a` still holds keep.yaml, so the walk stops there.
    expect(fs.existsSync(path.join(specsRoot, 'a'))).toBe(true);

    expect(removeSpecFile(path.join(specsRoot, 'a', 'keep.yaml'), specsRoot)).toBe(true);
    expect(fs.existsSync(path.join(specsRoot, 'a'))).toBe(false);
    expect(fs.existsSync(specsRoot)).toBe(true);
  });

  it('answers false for an absent document and leaves the tree alone', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-store-absent-'));
    const specsRoot = path.join(root, 'specs');
    fs.mkdirSync(path.join(specsRoot, 'a'), { recursive: true });

    expect(removeSpecFile(path.join(specsRoot, 'a', 'ghost.yaml'), specsRoot)).toBe(false);
    expect(fs.existsSync(path.join(specsRoot, 'a'))).toBe(true);
  });
});
