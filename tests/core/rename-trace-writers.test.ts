import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  loadComponentSpec,
  loadInterfaceSpec,
  loadImplementationSpec,
  loadSubsystemSpec,
  loadSystemSpec,
  loadTypeSpec,
  loadTypeSpecs,
  invalidateSpecCache,
  moveMethods,
} from '../../src/core/specs.js';
import { renameComponent, renameMethod, renameType } from '../../src/core/provision.js';
import { applyRestatement, writeSpec } from '../../src/core/authoring.js';
import { projectOwnSurface } from '../../src/core/surfaces.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The rename trace's writers (wave 4): renameComponent, renameMethod,
// moveMethods and renameType record what an element was called; a retired id
// or method name is refused where a spec would take it again; a published
// name survives the rename through `as`; and a snapshot never carries a trace.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
let roots: string[] = [];

const sub = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'shop-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const comp = (id: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: 'shop', componentType, owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const intf = (id: string, component: string, methods: Record<string, unknown>[]): InterfaceSpec => ({
  id, name: id, description: 'd', component, createdAt: now, updatedAt: now, methods,
} as InterfaceSpec);
const impl = (id: string, contract: string, names: string[]): ImplementationSpec => ({
  id, name: id, description: 'd', contract, createdAt: now, updatedAt: now,
  methods: names.map((name) => ({ name, narrative: [{ stepNumber: 1, description: 'do it', type: 'local' }] })),
} as ImplementationSpec);
const type = (id: string, over: Record<string, unknown> = {}): TypeSpec => ({
  kind: 'value-object', id, name: id, description: 'd', fields: [], methods: [], createdAt: now, updatedAt: now, ...over,
} as TypeSpec);

/**
 * A `shop` subsystem: a `cart` Portal publishing `icart` (L1 without `as`, L0
 * without `as` or id), an `order` type exported at L1 and named at every type
 * position, and a `pricing` Orchestrator to move methods into.
 */
function shop(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-trace-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'shop', id: 'shop', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'shop-sys', vision: 'v', boundaries: [], globalRequirements: [], databases: [],
    publicInterfaces: [{ from: 'shop', component: 'cart', interface: 'icart', audience: 'project' }],
    createdAt: now, updatedAt: now,
  } as any);
  saveSpec('subsystem', sub('shop', {
    publicInterfaces: [
      { type: 'Custom', details: 'the cart', component: 'cart', interface: 'icart' },
      { typeDef: 'order', details: 'an order' },
    ] as any,
  }));
  saveComponentSpec(comp('cart', 'Portal', { portalType: 'Custom', dependsOn: ['pricing'] }));
  saveInterfaceSpec(intf('icart', 'cart', [
    { name: 'add', description: 'd', params: [{ name: 'order', type: 'Order' }], returns: 'list<Order>?' },
    { name: 'total', description: 'd', signature: 'total(): Order', returns: 'Order' },
  ]));
  saveImplementationSpec(impl('cart_impl', 'icart', ['add', 'total']));
  saveComponentSpec(comp('pricing', 'Orchestrator'));
  saveInterfaceSpec(intf('ipricing', 'pricing', [{ name: 'quote', description: 'd', signature: 'quote(): void', returns: 'void' }]));
  saveImplementationSpec(impl('pricing_impl', 'ipricing', ['quote']));
  saveTypeSpec(type('order', { kind: 'entity', name: 'Order', subsystem: 'shop', fields: [{ name: 'id', type: 'string', optional: false }] }));
  saveTypeSpec(type('receipt', { subsystem: 'shop', fields: [{ name: 'orders', type: 'map<string, Order>', optional: false }] }));
  invalidateSpecCache();
  return root;
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* win locks */ } }
  roots = [];
});

describe('renameComponent writes the trace and keeps the published name', () => {
  it('appends the old id to the previousIds of the component and of its moving interface and implementation', () => {
    shop();
    renameComponent('cart', 'basket');
    expect(loadComponentSpec('basket')?.previousIds).toEqual(['cart']);
    expect(loadInterfaceSpec('ibasket')?.previousIds).toEqual(['icart']);
    expect(loadImplementationSpec('basket_impl')?.previousIds).toEqual(['cart_impl']);
  });

  it('accumulates the trace across renames, oldest first', () => {
    shop();
    renameComponent('cart', 'basket');
    renameComponent('basket', 'trolley');
    expect(loadComponentSpec('trolley')?.previousIds).toEqual(['cart', 'basket']);
  });

  it('writes `as` on every export entry whose public name derived from the old id, and reports it', () => {
    shop();
    const report = renameComponent('cart', 'basket');
    expect(report.keptPublicNames).toEqual(['icart']);
    const l1 = loadSubsystemSpec('shop')!.publicInterfaces.find((e) => e.component === 'basket');
    expect(l1).toMatchObject({ interface: 'ibasket', as: 'icart' });
    const l0 = (loadSystemSpec()!.publicInterfaces ?? []).find((e: any) => e.component === 'basket') as any;
    expect(l0).toMatchObject({ interface: 'ibasket', as: 'icart' });
  });

  it('refuses an id a renamed component retired (id-retired), writing nothing', () => {
    shop();
    renameComponent('cart', 'basket');
    expect(() => renameComponent('pricing', 'cart')).toThrow(/id-retired.*"basket"/);
    expect(loadComponentSpec('pricing')).not.toBeNull();
  });
});

describe('renameMethod writes the trace', () => {
  it('appends `<contract>.<old name>` to the method\'s previousNames and reports where it is published', () => {
    shop();
    const report = renameMethod('cart', 'add', 'put');
    const put = loadInterfaceSpec('icart')!.methods.find((m) => m.name === 'put');
    expect(put?.previousNames).toEqual(['icart.add']);
    expect(report.publishedIn).toEqual(['icart']);
  });

  it('refuses a name the contract retired (name-retired)', () => {
    shop();
    renameMethod('cart', 'add', 'put');
    expect(() => renameMethod('cart', 'total', 'add')).toThrow(/name-retired/);
    expect(loadInterfaceSpec('icart')!.methods.map((m) => m.name)).toContain('total');
  });

  it('answers an empty publishedIn for an unexported contract', () => {
    shop();
    expect(renameMethod('pricing', 'quote', 'price').publishedIn).toEqual([]);
  });
});

describe('moveMethods writes the trace', () => {
  it('appends `<source contract>.<name>` to each arriving method', () => {
    shop();
    moveMethods('cart', 'pricing', ['total']);
    const total = loadInterfaceSpec('ipricing')!.methods.find((m) => m.name === 'total');
    expect(total?.previousNames).toEqual(['icart.total']);
  });

  it('refuses a name the receiving contract retired (name-retired)', () => {
    shop();
    renameMethod('pricing', 'quote', 'total');
    expect(() => moveMethods('cart', 'pricing', ['total'])).toThrow(/name-taken|already declares/);
    renameMethod('pricing', 'total', 'price');
    // ipricing.price now lists both ipricing.quote and ipricing.total.
    expect(() => moveMethods('cart', 'pricing', ['total'])).toThrow(/name-retired/);
  });
});

describe('renameType', () => {
  it('moves the type under the same owner, tracing its old id', () => {
    shop();
    const report = renameType('order', 'purchase');
    expect(report.from).toBe('shop::order');
    expect(report.to).toBe('shop::purchase');
    expect(loadTypeSpec('order')).toBeNull();
    const moved = loadTypeSpec('purchase');
    expect(moved?.subsystem).toBe('shop');
    expect(moved?.previousIds).toEqual(['order']);
    expect(moved?.name).toBe('Order');
  });

  it('respells every type position naming it, in the style it was written, and re-derives the stored text', () => {
    shop();
    const report = renameType('order', 'purchase');
    const icart = loadInterfaceSpec('icart')!;
    const add = icart.methods.find((m) => m.name === 'add')!;
    expect(add.params?.[0].type).toBe('Purchase');
    expect(add.returns).toBe('list<Purchase>?');
    expect(add.signature).toBe('add(order: Purchase): list<Purchase>?');
    const total = icart.methods.find((m) => m.name === 'total')!;
    expect(total.returns).toBe('Purchase');
    expect(total.signature).toBe('total(): Purchase');
    expect(loadTypeSpec('receipt')!.fields[0].type).toBe('map<string, Purchase>');
    expect([...report.rewritten].sort()).toEqual(['icart', 'receipt', 'shop']);
  });

  it('respells the export entry\'s typeDef, keeping the published name through `as`', () => {
    shop();
    const report = renameType('order', 'purchase');
    expect(report.keptPublicNames).toEqual(['order']);
    const entry = loadSubsystemSpec('shop')!.publicInterfaces.find((e) => e.typeDef !== undefined);
    expect(entry).toMatchObject({ typeDef: 'purchase', as: 'order' });
  });

  it('refuses a missing type, a bad id, a taken id and a retired id, writing nothing', () => {
    shop();
    expect(() => renameType('nothing', 'x')).toThrow(/type-missing/);
    expect(() => renameType('order', 'Not An Id')).toThrow(/invalid-id/);
    expect(() => renameType('order', 'receipt')).toThrow(/id-taken/);
    expect(() => renameType('other::order', 'x')).toThrow(/chained-type/);
    renameType('order', 'purchase');
    expect(() => renameType('receipt', 'order')).toThrow(/id-retired/);
    expect(loadTypeSpecs().map((t) => t.id).sort()).toEqual(['purchase', 'receipt']);
  });

  it('accepts a subsystem-qualified id', () => {
    shop();
    expect(renameType('shop::order', 'purchase').to).toBe('shop::purchase');
  });
});

describe('the gated write refuses a retired id (writeSpec steps 6-9)', () => {
  const COMPONENT_FIELDS = ['id', 'name', 'description', 'subsystem', 'componentType', 'owns', 'dependsOn', 'status'];

  it('refuses a NEW spec under an id a renamed spec of its kind retired, and names the holder', () => {
    shop();
    renameComponent('pricing', 'quoter');
    expect(() => writeSpec({ kind: 'component', spec: comp('pricing', 'Orchestrator') as any, fields: COMPONENT_FIELDS }))
      .toThrow(/id-retired.*"quoter"/);
    expect(loadComponentSpec('pricing')).toBeNull();
  });

  it('refuses a new type under an id its owner retired, and admits it under another owner', () => {
    shop();
    saveSpec('subsystem', sub('billing'));
    invalidateSpecCache();
    renameType('order', 'purchase');
    const fields = ['kind', 'id', 'name', 'description', 'subsystem', 'fields', 'methods'];
    expect(() => writeSpec({ kind: 'type', spec: type('order', { subsystem: 'shop' }) as any, fields })).toThrow(/id-retired/);
    expect(() => writeSpec({ kind: 'type', spec: type('order', { subsystem: 'billing' }) as any, fields })).not.toThrow();
  });
});

describe('spec_restatement.applyTo carries the trace and refuses a retired name', () => {
  const FIELDS = ['id', 'name', 'description', 'component', 'methods', 'status'];

  it('carries previousIds and each restated method\'s previousNames', () => {
    shop();
    renameComponent('cart', 'basket');
    renameMethod('basket', 'add', 'put');
    const stored = loadInterfaceSpec('ibasket')!;
    const restated = intf('ibasket', 'basket', [
      { name: 'put', description: 'restated', params: [{ name: 'order', type: 'Order' }], returns: 'list<Order>?' },
      { name: 'total', description: 'd', signature: 'total(): Order', returns: 'Order' },
    ]);
    const application = applyRestatement({ kind: 'interface', spec: restated as any, fields: FIELDS }, stored, loadComponentSpec('basket'));
    expect(application.refusal).toBeUndefined();
    expect((application.spec as InterfaceSpec).previousIds).toEqual(['icart']);
    expect((application.spec as InterfaceSpec).methods.find((m) => m.name === 'put')?.previousNames).toEqual(['ibasket.add']);
  });

  it('refuses a new method under a name its contract retired (name-retired)', () => {
    shop();
    renameMethod('cart', 'add', 'put');
    const stored = loadInterfaceSpec('icart')!;
    const restated = { ...stored, methods: [...stored.methods, { name: 'add', description: 'again', signature: 'add(): void', returns: 'void' }] };
    const application = applyRestatement({ kind: 'interface', spec: restated as any, fields: FIELDS }, stored, loadComponentSpec('cart'));
    expect(application.refusal).toMatch(/name-retired/);
  });
});

describe('a snapshot carries a trace only as formerly, outside every digest', () => {
  it('drops previousNames for formerly, so a method rename moves only the name it changed', () => {
    shop();
    const before = projectOwnSurface('project');
    renameMethod('cart', 'add', 'put');
    const after = projectOwnSurface('project');
    const methodsOf = (s: typeof before): any[] => s.interfaces.flatMap((e) => e.methods);
    expect(methodsOf(after).some((m) => 'previousNames' in m)).toBe(false);
    // The rename trace travels as `formerly` (linkage-and-drift D8), so a consumer reads a rename.
    expect(methodsOf(after).find((m) => m.name === 'put')?.formerly).toEqual(['add']);
    const strip = (s: typeof before): string => JSON.stringify(methodsOf(s).map(({ name: _n, signature: _s, formerly: _f, ...rest }) => rest));
    expect(strip(after)).toBe(strip(before));
  });
});
