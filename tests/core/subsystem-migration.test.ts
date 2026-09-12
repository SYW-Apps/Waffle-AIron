import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  loadComponentSpecs,
  loadSubsystemSpec,
  loadImplementationSpec,
  scanAllSpecs,
  invalidateSpecCache,
  workspaceFor,
} from '../../src/core/specs.js';
import { externalizeSubsystem, internalizeSubsystem } from '../../src/core/provision.js';

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
    setProjectRoot(root);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'root-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });

    // core: a published portal + an orchestrator behind it.
    saveSubsystemSpec({ id: 'core', name: 'core', description: 'the core', parentSystem: 'root-sys', publicInterfaces: [{ type: 'Custom', details: 'core api', component: 'core_portal' }], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now });
    saveComponentSpec({ id: 'core_portal', name: 'Core Portal', description: 'front door', subsystem: 'core', componentType: 'Portal', portalType: 'Custom', owns: [], dependsOn: ['core_orch'], createdAt: now, updatedAt: now } as any);
    saveComponentSpec({ id: 'core_orch', name: 'Core Orchestrator', description: 'workflow', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [], createdAt: now, updatedAt: now } as any);

    // cli: an adapter that crosses into core's published portal (the cross-subsystem ref).
    saveSubsystemSpec({ id: 'cli', name: 'cli', description: 'the cli', parentSystem: 'root-sys', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now });
    saveComponentSpec({ id: 'cli_core_adapter', name: 'CLI Core Adapter', description: 'hop into core', subsystem: 'cli', componentType: 'Adapter', owns: [], dependsOn: ['core_portal'], createdAt: now, updatedAt: now } as any);

    invalidateSpecCache();
  }

  it('externalizes, rewrites the cross-subsystem ref, then internalizes back to the original tree', () => {
    seed();

    // --- externalize core into ./packages/core ---
    externalizeSubsystem('core', 'packages/core');
    invalidateSpecCache();

    // parent core is now a mount
    const mount = loadSubsystemSpec('core');
    expect(mount?.projectPath).toBe('packages/core');

    // core's specs moved into the child project
    const childRoot = path.join(root, 'packages', 'core');
    expect(fs.existsSync(path.join(childRoot, '.wai', 'project.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(childRoot, '.wai', 'specs', 'core', 'core_portal', '.index.yaml'))).toBe(true);
    // parent no longer holds core's components
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'core', 'core_portal'))).toBe(false);

    // federated: core is a single flat subsystem, its portal is namespaced
    let idx = scanAllSpecs();
    expect(idx.subsystems.filter((s: any) => s.id === 'core').length).toBe(1);
    expect(idx.components.map((c: any) => c.id)).toContain('core::core_portal');

    // the sibling adapter's cross-ref was rewritten and resolves
    expect(rawDependsOn(root, 'cli', 'cli_core_adapter')).toEqual(['core::core_portal']);
    const adapter = loadComponentSpecs().find((c: any) => c.id === 'cli_core_adapter');
    expect(adapter?.dependsOn).toContain('core::core_portal');
    const ids = new Set(idx.components.map((c: any) => c.id));
    expect(ids.has(adapter!.dependsOn[0])).toBe(true); // no dangling ref

    // --- internalize core back ---
    internalizeSubsystem('core');
    invalidateSpecCache();

    // core is internal again, child project gone
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

  it('refuses to externalize an already-external subsystem and to internalize an internal one', () => {
    seed();
    externalizeSubsystem('core', 'packages/core');
    invalidateSpecCache();
    expect(() => externalizeSubsystem('core', 'packages/core2')).toThrow(/already external/);
    expect(() => internalizeSubsystem('cli')).toThrow(/not external/);
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

    externalizeSubsystem('core', 'packages/core');
    invalidateSpecCache();
    const own = workspaceFor(path.join(root, 'packages', 'core')).loadImplementationSpec('core_orch_impl');
    expect(own?.sourcePath).toBe('src/orch.ts');
    expect(own?.simPath).toBe('../../sim/orch.sim.ts');

    internalizeSubsystem('core');
    invalidateSpecCache();
    const back = loadImplementationSpec('core_orch_impl');
    expect(back?.sourcePath).toBe('packages/core/src/orch.ts');
    expect(back?.simPath).toBe('sim/orch.sim.ts');
  });
});
