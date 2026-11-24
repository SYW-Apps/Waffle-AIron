import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, saveImplementationSpec, invalidateSpecCache, loadInterfaceSpec, loadComponentSpec } from '../../src/core/specs.js';
import { renameParam } from '../../src/core/provision.js';
import { exportDesign } from '../../src/core/design-export.js';
import { applyRestatement } from '../../src/core/authoring.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// core_orchestrator.renameParam: a parameter renamed by hand is a delete and an
// add in the contract — a generator reading the design export cannot tell it
// from a signature change, and an HTTP path placeholder keeps the old name.
// The tool keeps the old name on the parameter (previousNames, `formerly` in
// the export), re-derives the signature and respells the placeholder.
// ---------------------------------------------------------------------------

const now = '2026-10-07T10:00:00.000Z';
let root: string;

function project(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rename-param-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'habits', targets: [], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'habits', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', { id: 'core', name: 'core', description: 'd', parentSystem: 'habits', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now } as SubsystemSpec);
  saveComponentSpec({
    id: 'habit-api', name: 'habit-api', description: 'd', subsystem: 'core', componentType: 'Portal', transport: 'HTTP',
    owns: [], dependsOn: [], createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'ihabit-api', name: 'ihabit-api', description: 'contract', component: 'habit-api', createdAt: now, updatedAt: now,
    methods: [{
      name: 'create', description: 'Create a habit.', signature: 'create(habitId: string, frequency: string): void', returns: 'void',
      params: [{ name: 'habitId', type: 'string' }, { name: 'frequency', type: 'string', description: 'How often' }],
      endpoint: { transport: 'HTTP', method: 'PUT', path: '/habits/{habitId}' },
    }],
  });
  invalidateSpecCache();
  setProjectRoot(root);
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
});

describe('renameParam', () => {
  it('renames the parameter, keeps its trace and re-derives the signature', () => {
    project();
    const result = renameParam('habit-api', 'create', 'frequency', 'cadence');
    expect(result).toEqual({ component: 'habit-api', method: 'create', from: 'frequency', to: 'cadence', movedIn: ['ihabit-api'], rewritten: [], publishedIn: [], followed: [] });
    invalidateSpecCache();
    const method = loadInterfaceSpec('ihabit-api')!.methods[0];
    expect(method.params![1]).toMatchObject({ name: 'cadence', type: 'string', description: 'How often', previousNames: ['frequency'] });
    expect(method.signature).toContain('cadence: string');
    expect(method.signature).not.toContain('frequency');
  });

  it('respells the HTTP path placeholder that bound it', () => {
    project();
    const result = renameParam('habit-api', 'create', 'habitId', 'id');
    expect(result.rewritten).toEqual(['ihabit-api.create: {habitId} -> {id}']);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ihabit-api')!.methods[0].endpoint).toMatchObject({ path: '/habits/{id}' });
  });

  it('shows the trace as `formerly` in the design export', () => {
    project();
    renameParam('habit-api', 'create', 'frequency', 'cadence');
    invalidateSpecCache();
    const params: Array<{ name: string; formerly?: string[] }> = [];
    JSON.stringify(exportDesign(), (key, value) => {
      if (key === 'params' && Array.isArray(value)) params.push(...value);
      return value;
    });
    expect(params.find((p) => p.name === 'cadence')?.formerly).toEqual(['frequency']);
    expect(params.find((p) => p.name === 'habitId')?.formerly).toBeUndefined();
  });

  it('a re-authoring that states the parameter again keeps its trace', () => {
    project();
    renameParam('habit-api', 'create', 'frequency', 'cadence');
    invalidateSpecCache();
    const existing = loadInterfaceSpec('ihabit-api')!;
    const restated = {
      ...existing,
      methods: [{ ...existing.methods[0], params: existing.methods[0].params!.map(({ previousNames: _p, ...rest }) => rest) }],
    };
    const FIELDS = ['id', 'name', 'description', 'component', 'methods', 'status'];
    const applied = applyRestatement({ kind: 'interface', spec: restated as never, fields: FIELDS }, existing, loadComponentSpec('habit-api'));
    expect(applied.refusal).toBeUndefined();
    expect((applied.spec as InterfaceSpec).methods[0].params![1].previousNames).toEqual(['frequency']);
  });

  it('refuses, writing nothing', () => {
    project();
    expect(() => renameParam('nope', 'create', 'frequency', 'x')).toThrow(/spec-missing/);
    expect(() => renameParam('habit-api', 'nope', 'frequency', 'x')).toThrow(/method-missing/);
    expect(() => renameParam('habit-api', 'create', 'nope', 'x')).toThrow(/param-missing/);
    expect(() => renameParam('habit-api', 'create', 'frequency', 'habitId')).toThrow(/name-taken/);
    expect(() => renameParam('habit-api', 'create', 'frequency', 'not-an-id')).toThrow(/invalid-name/);
    renameParam('habit-api', 'create', 'frequency', 'cadence');
    invalidateSpecCache();
    expect(() => renameParam('habit-api', 'create', 'habitId', 'frequency')).toThrow(/name-retired/);
  });
});

describe('renameParam codeToRename', () => {
  function chain(): void {
    project();
    for (const id of ['base', 'child']) {
      saveComponentSpec({ id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [], ...(id === 'base' ? { abstract: true } : {}), createdAt: now, updatedAt: now } as ComponentSpec);
    }
    const methods = [{ name: 'run', description: 'Runs.', signature: 'run(item: string): void', returns: 'void', params: [{ name: 'item', type: 'string', description: 'the item' }] }];
    saveInterfaceSpec({ id: 'ibase', name: 'ibase', description: 'c', component: 'base', methods, createdAt: now, updatedAt: now });
    saveInterfaceSpec({ id: 'ichild', name: 'ichild', description: 'c', component: 'child', implements: ['base'], methods, createdAt: now, updatedAt: now } as InterfaceSpec);
    saveImplementationSpec({ id: 'base_impl', name: 'base impl', description: 'd', contract: 'ibase', sourcePath: 'src/base.ts', methods: [{ name: 'run', symbol: 'runBase' }], createdAt: now, updatedAt: now } as never);
    saveImplementationSpec({ id: 'child_impl', name: 'child impl', description: 'd', contract: 'ichild', sourcePath: 'src/child.ts', methods: [{ name: 'run', sourcePath: 'src/child-run.ts' }], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
  }

  it('names each realizing function of the method on the component and each implementer, on a dry run and an apply', () => {
    chain();
    const expected = ['src/base.ts: runBase', 'src/child-run.ts: run'];
    const dry = renameParam('base', 'run', 'item', 'entry', true);
    expect(dry.dryRun).toBe(true);
    expect(dry.codeToRename).toEqual(expected);
    invalidateSpecCache();
    const done = renameParam('base', 'run', 'item', 'entry');
    expect(done.followed).toEqual(['child.run']);
    expect(done.codeToRename).toEqual(expected);
  });

  it('names the file of an implementation that lists no methods (code linkage only)', () => {
    chain();
    saveImplementationSpec({ id: 'base_impl', name: 'base impl', description: 'd', contract: 'ibase', sourcePath: 'src/base.ts', methods: [], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
    expect(renameParam('base', 'run', 'item', 'entry', true).codeToRename).toEqual(['src/base.ts: run', 'src/child-run.ts: run']);
  });

  it('is absent when no implementation names a file', () => {
    project();
    expect(renameParam('habit-api', 'create', 'frequency', 'cadence').codeToRename).toBeUndefined();
  });
});
