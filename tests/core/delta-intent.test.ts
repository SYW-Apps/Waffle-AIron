import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec,
  saveInterfaceSpec, saveImplementationSpec, updateSpec,
  loadImplementationSpec, loadInterfaceSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Delta intent: a misaddressed edit must not read as an addition.
//
// Every keyed array in updateSpec upserts — find by identity, merge if found,
// else append — which made a mistyped address indistinguishable from a new
// element. Editing `compile_manifest_body` when the contract says
// `compileManifestBody` silently added a fourth method; the only signal was an
// UNEXPECTED_IMPLEMENTATION_METHOD *warning* at a later validate.
//
// The same shape made malformed delete markers silent no-ops: `action:
// "remove"` matches no delete branch, gets stripped on write, and the caller
// is told it succeeded while nothing was removed.
// ---------------------------------------------------------------------------

const now = '2026-09-11T10:00:00Z';

function project(): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'delta', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'delta', vision: 'delta fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the delta domain',
    parentSystem: 'delta', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component',
    subsystem: 'dom', componentType: 'Specialist', dependsOn: [], owns: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iworker', name: 'iworker', description: 'contract', component: 'worker',
    methods: [
      { name: 'compileManifestBody', description: 'compiles', signature: 'compileManifestBody(): void', params: [], returns: 'void' },
      { name: 'runJourney', description: 'runs', signature: 'runJourney(): void', params: [], returns: 'void' },
    ],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  saveImplementationSpec({
    id: 'worker-impl', name: 'worker-impl', description: 'impl', contract: 'iworker',
    detailLevel: 'sketch', technologies: [],
    methods: [
      { name: 'compileManifestBody', narrative: [{ stepNumber: 1, description: 'noop', type: 'local' }] },
      { name: 'runJourney', narrative: [{ stepNumber: 1, description: 'noop', type: 'local' }] },
    ],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as ImplementationSpec);
  invalidateSpecCache();
  return root;
}

describe('updateSpec delta intent', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  const methodNames = (): string[] => loadImplementationSpec('worker-impl')!.methods.map((m) => m.name);

  it('refuses the reported bug: a snake_case address for a camelCase method', () => {
    root = project();
    expect(() => updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'compile_manifest_body', narrative: [{ stepNumber: 1, description: 'edited', type: 'local' }] }],
    })).toThrowError(/compileManifestBody/);

    invalidateSpecCache();
    expect(methodNames()).toEqual(['compileManifestBody', 'runJourney']);
  });

  it('refuses a wrong-case address on an interface method', () => {
    root = project();
    expect(() => updateSpec('interface', 'iworker', {
      methods: [{ name: 'RunJourney', description: 'edited' }],
    })).toThrowError(/runJourney/);

    invalidateSpecCache();
    expect(loadInterfaceSpec('iworker')!.methods.map((m) => m.name)).toEqual(['compileManifestBody', 'runJourney']);
  });

  it('still appends a genuinely new method — adding must keep working', () => {
    root = project();
    updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'archiveJourney', narrative: [{ stepNumber: 1, description: 'new', type: 'local' }] }],
    });
    invalidateSpecCache();
    expect(methodNames()).toContain('archiveJourney');
  });

  it('refuses a delete that addressed nothing, instead of reporting success', () => {
    root = project();
    expect(() => updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'neverExisted', remove: true }],
    })).toThrowError(/nothing with that identity exists/);
  });

  it('refuses malformed delete markers that would silently no-op', () => {
    root = project();
    expect(() => updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', action: 'remove' }],
    })).toThrowError(/unknown action/);

    expect(() => updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', remove: 'true' }],
    })).toThrowError(/must be the boolean true/);

    invalidateSpecCache();
    expect(methodNames()).toContain('runJourney');
  });

  it('a real delete still works', () => {
    root = project();
    updateSpec('implementation', 'worker-impl', {
      methods: [{ name: 'runJourney', remove: true }],
    });
    invalidateSpecCache();
    expect(methodNames()).not.toContain('runJourney');
  });

  it('guards identified arrays too — a near-miss lint.allow code is refused', () => {
    root = project();
    updateSpec('component', 'worker', {
      lint: { allow: [{ code: 'UNOWNED_STORE', reason: 'deliberate standalone store' }] },
    });
    invalidateSpecCache();

    expect(() => updateSpec('component', 'worker', {
      lint: { allow: [{ code: 'unowned_store', reason: 'a typo of the above' }] },
    })).toThrowError(/differs only in case or separators/);
  });
});
