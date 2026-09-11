import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec,
  saveInterfaceSpec, saveImplementationSpec,
  loadInterfaceSpec, loadImplementationSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Path-collision refusal.
//
// In the nested layout a spec's path comes from its PARENT — a component for
// an interface, a contract for an implementation — and the spec's own id is
// not part of it. Two ids bound to the same parent therefore resolve to one
// file. Unguarded, the second write destroyed the first silently: the
// `existing` lookup is by the NEW id, finds nothing, and every re-author
// notice stays quiet. An agent "renaming" by defining a new id lost the old
// contract, its narratives and its lint.allows, and was told it succeeded.
// ---------------------------------------------------------------------------

const now = '2026-09-11T10:00:00Z';

function project(): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-collision-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'collide', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'collide', vision: 'collision fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the collision domain',
    parentSystem: 'collide', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component',
    subsystem: 'dom', componentType: 'Specialist', dependsOn: [], owns: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  return root;
}

const iface = (id: string): InterfaceSpec => ({
  id, name: id, description: 'contract', component: 'worker',
  methods: [{ name: 'run', description: 'runs', signature: 'run(): void', params: [], returns: 'void' }],
  status: 'draft', createdAt: now, updatedAt: now,
} as unknown as InterfaceSpec);

const impl = (id: string, contract: string): ImplementationSpec => ({
  id, name: id, description: 'impl', contract,
  detailLevel: 'sketch', technologies: [], methods: [],
  status: 'draft', createdAt: now, updatedAt: now,
} as unknown as ImplementationSpec);

describe('spec path collisions are refused, not silently overwritten', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  it('refuses a second interface id on a component that already has one', () => {
    root = project();
    saveInterfaceSpec(iface('iworker'));
    invalidateSpecCache();

    expect(() => saveInterfaceSpec(iface('iworker-admin'))).toThrowError(/already served by "iworker"/);

    // The original survives intact.
    invalidateSpecCache();
    expect(loadInterfaceSpec('iworker')?.id).toBe('iworker');
  });

  it('refuses a second implementation id for a contract that already has one', () => {
    root = project();
    saveInterfaceSpec(iface('iworker'));
    saveImplementationSpec(impl('worker-impl', 'iworker'));
    invalidateSpecCache();

    expect(() => saveImplementationSpec(impl('worker-impl-v2', 'iworker')))
      .toThrowError(/already implemented by "worker-impl"/);

    invalidateSpecCache();
    expect(loadImplementationSpec('worker-impl')?.id).toBe('worker-impl');
  });

  it('still allows re-authoring the SAME id in place', () => {
    root = project();
    saveInterfaceSpec(iface('iworker'));
    invalidateSpecCache();

    const revised = { ...iface('iworker'), description: 'revised contract' };
    expect(() => saveInterfaceSpec(revised as InterfaceSpec)).not.toThrow();
    invalidateSpecCache();
    expect(loadInterfaceSpec('iworker')?.description).toBe('revised contract');
  });

  it('names the occupant and the file, so the agent can recover without guessing', () => {
    root = project();
    saveInterfaceSpec(iface('iworker'));
    invalidateSpecCache();

    let message = '';
    try { saveInterfaceSpec(iface('iworker-v2')); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('iworker');
    expect(message).toContain('.interface.yaml');
    expect(message).toMatch(/Re-author .* or delete it first/);
  });
});
