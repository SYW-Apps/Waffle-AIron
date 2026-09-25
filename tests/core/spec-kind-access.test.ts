/**
 * Kind-generic spec access on the core portal (icore_portal loadSpec / saveSpec
 * / deleteSpec → spec_index.load, spec_registry.save / delete).
 *
 * The kind used to be turned into a typed loader, writer or delete by a switch
 * every caller repeated — the delta update, the method move, the MCP delete —
 * and each copy could drift. These pin the one switch that replaced them: every
 * kind reaches its own typed store, a draft save keeps a stored status, and the
 * L0 cannot be deleted through it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { loadSpec, saveSpec, deleteSpec } from '../../src/core/index.js';
import {
  invalidateSpecCache,
  loadComponentSpec,
  loadSystemSpec,
  loadTypeSpec,
  saveComponentSpec,
  saveSubsystemSpec,
  saveSystemSpec,
} from '../../src/core/specs.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../../src/models/specs.js';

const now = new Date().toISOString();
let roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-kind-access-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'kinds', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'kinds-sys', vision: 'v', boundaries: [], globalRequirements: [], databases: [], createdAt: now, updatedAt: now });
  saveSubsystemSpec({
    id: 'shop', name: 'Shop', description: 'd', parentSystem: 'kinds-sys', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  return root;
}

const component = (over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id: 'cart', name: 'Cart', description: 'd', subsystem: 'shop', componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  invalidateSpecCache();
});

describe('loadSpec — one stored spec of the named kind', () => {
  it('reads every kind through its own typed loader', () => {
    project();
    saveComponentSpec(component());
    expect((loadSpec('system', 'system') as { name: string }).name).toBe('kinds-sys');
    expect(loadSpec('subsystem', 'shop')?.name).toBe('Shop');
    expect(loadSpec('component', 'cart')?.name).toBe('Cart');
  });

  it('answers null for an id nothing holds', () => {
    project();
    expect(loadSpec('component', 'nowhere')).toBeNull();
    expect(loadSpec('interface', 'inowhere')).toBeNull();
    expect(loadSpec('implementation', 'nowhere_impl')).toBeNull();
    expect(loadSpec('type', 'nowhere')).toBeNull();
  });

  it('reads the L0 whatever id it is handed — the singleton\'s id is informational', () => {
    project();
    expect((loadSpec('system', 'anything') as { name: string }).name).toBe('kinds-sys');
  });
});

describe('saveSpec — persist through the typed writer of the kind', () => {
  it('writes each kind and answers with the writer\'s placement notices', () => {
    project();
    expect(saveSpec('component', component())).toEqual(expect.any(Array));
    saveSpec('interface', {
      id: 'icart', name: 'ICart', description: 'd', component: 'cart', status: 'draft',
      methods: [{ name: 'add', description: 'd', signature: 'add(): void', returns: 'void' }],
      createdAt: now, updatedAt: now,
    } as InterfaceSpec);
    saveSpec('type', { kind: 'value-object', id: 'line', name: 'Line', fields: [], methods: [], createdAt: now, updatedAt: now } as TypeSpec);
    invalidateSpecCache();
    expect(loadSpec('interface', 'icart')?.name).toBe('ICart');
    expect(loadTypeSpec('line')?.name).toBe('Line');
  });

  it('answers no notices for the L0 and a subsystem, whose writers raise none', () => {
    project();
    const system = loadSystemSpec()!;
    expect(saveSpec('system', { ...system, vision: 'changed' })).toEqual([]);
    expect(saveSpec('subsystem', loadSpec('subsystem', 'shop')!)).toEqual([]);
    invalidateSpecCache();
    expect(loadSystemSpec()?.vision).toBe('changed');
  });

  it('keeps the stored status on a draft save, as the typed writers always have', () => {
    project();
    saveComponentSpec(component({ status: 'complete' }));
    saveSpec('component', component({ description: 'rewritten', status: 'draft' }));
    invalidateSpecCache();
    expect(loadComponentSpec('cart')?.status).toBe('complete');
    expect(loadComponentSpec('cart')?.description).toBe('rewritten');
  });
});

describe('deleteSpec — delete one document of the named kind', () => {
  it('removes the document and answers true', () => {
    project();
    saveComponentSpec(component());
    expect(deleteSpec('component', 'cart')).toBe(true);
    invalidateSpecCache();
    expect(loadComponentSpec('cart')).toBeNull();
  });

  it('answers false when nothing held the id — not a failure, and not a deletion either', () => {
    project();
    expect(deleteSpec('component', 'nowhere')).toBe(false);
  });

  it('refuses the L0: every other spec hangs from it', () => {
    project();
    expect(() => deleteSpec('system', 'system')).toThrow(/cannot be deleted/);
    invalidateSpecCache();
    expect(loadSystemSpec()).not.toBeNull();
  });
});
