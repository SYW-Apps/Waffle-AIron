import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, updateSpec,
  loadSystemSpec, loadComponentSpec, loadInterfaceSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round 6 (tinkerer M1): sdd_update_spec REPLACED a list of plain values —
// four L0 requirements became one — while the tool promised that arrays
// upsert. A list of plain values now merges value by value; only an explicit
// removal marker ({ value, action: 'delete' }), [] or an unset takes one away.
// ---------------------------------------------------------------------------

const now = '2026-10-08T10:00:00Z';

function project(): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-plain-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'plain', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'plain', vision: 'plain fixture',
    boundaries: [], globalRequirements: ['R1 first', 'R2 second', 'R3 third', 'R4 fourth'], createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'plain',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  for (const id of ['store_a', 'store_b', 'worker']) {
    saveComponentSpec({
      id, name: id, description: `the ${id}`, subsystem: 'dom',
      componentType: id === 'worker' ? 'Orchestrator' : 'Store',
      dependsOn: id === 'worker' ? ['store_a'] : [], owns: [],
      status: 'draft', createdAt: now, updatedAt: now,
    } as ComponentSpec);
  }
  saveInterfaceSpec({
    id: 'iworker', name: 'iworker', description: 'contract', component: 'worker',
    methods: [{ name: 'run', description: 'runs', signature: 'run(): void', params: [], returns: 'void', guarantees: ['idempotent'] }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  invalidateSpecCache();
  return root;
}

describe('updateSpec merges lists of plain values (round 6, M1)', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  it('adds a requirement to the L0 and keeps the four it held', () => {
    root = project();
    updateSpec('system', 'system', { globalRequirements: ['R5 new'] });
    invalidateSpecCache();
    expect(loadSystemSpec()!.globalRequirements).toEqual(['R1 first', 'R2 second', 'R3 third', 'R4 fourth', 'R5 new']);
  });

  it('restating a held requirement (as text or as { description }) changes nothing', () => {
    root = project();
    const report = updateSpec('system', 'system', { globalRequirements: ['R2 second', { description: 'R3 third' }] });
    invalidateSpecCache();
    expect(loadSystemSpec()!.globalRequirements).toHaveLength(4);
    expect(report.written).toBe(false);
  });

  it('removes a requirement only through an explicit marker, by value or by description', () => {
    root = project();
    updateSpec('system', 'system', { globalRequirements: [{ value: 'R1 first', action: 'delete' }, { description: 'R4 fourth', action: 'delete' }] });
    invalidateSpecCache();
    expect(loadSystemSpec()!.globalRequirements).toEqual(['R2 second', 'R3 third']);
  });

  it('refuses a removal marker naming a value the list does not hold', () => {
    root = project();
    expect(() => updateSpec('system', 'system', { globalRequirements: [{ value: 'nope', action: 'delete' }] }))
      .toThrow(/does not hold it/);
  });

  it('merges dependsOn: a new id is added, the held one kept; a marker removes one', () => {
    root = project();
    updateSpec('component', 'worker', { dependsOn: ['store_b'] });
    invalidateSpecCache();
    expect(loadComponentSpec('worker')!.dependsOn).toEqual(['store_a', 'store_b']);
    updateSpec('component', 'worker', { dependsOn: [{ value: 'store_a', action: 'delete' }] });
    invalidateSpecCache();
    expect(loadComponentSpec('worker')!.dependsOn).toEqual(['store_b']);
  });

  it('merges a plain list one level down (a method\'s guarantees)', () => {
    root = project();
    updateSpec('interface', 'iworker', { methods: [{ name: 'run', guarantees: ['atomic'] }] });
    invalidateSpecCache();
    expect(loadInterfaceSpec('iworker')!.methods[0].guarantees).toEqual(['idempotent', 'atomic']);
  });

  it('[] still clears the list outright', () => {
    root = project();
    updateSpec('system', 'system', { globalRequirements: [] });
    invalidateSpecCache();
    expect(loadSystemSpec()!.globalRequirements).toEqual([]);
  });
});
