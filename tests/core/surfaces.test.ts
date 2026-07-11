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
  saveTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  projectOwnSurface,
  projectChildSurface,
  exportSurface,
  importSurface,
  listSnapshots,
  generateChildSnapshots,
} from '../../src/core/surfaces.js';
import { toOpenApi, fromOpenApi, isOpenApiDocument } from '../../src/core/openapi.js';
import { validateSddTree } from '../../src/core/validation.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

const now = new Date().toISOString();

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: InterfaceSpec['methods']): InterfaceSpec => ({
  id, name: id, description: 'd', component: comp, methods, status: 'complete', createdAt: now, updatedAt: now,
});

/** Parent fixture: a gateway portal published at L0 with two audience levels + a type chain. */
function buildParent(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'root-system',
    vision: 'surface fixture',
    boundaries: [],
    globalRequirements: [],
    publicInterfaces: [
      { id: 'gateway', name: 'Gateway API', subsystem: 'core-sub', component: 'gateway-portal', type: 'REST', details: 'main api', audience: 'external' },
      { id: 'family-ops', name: 'Family Ops', subsystem: 'core-sub', component: 'family-portal', type: 'Custom', details: 'family-internal ops', audience: 'project' },
    ],
    createdAt: now,
    updatedAt: now,
  });
  saveSubsystemSpec(subsystem('core-sub', {
    publicInterfaces: [
      { type: 'REST', details: 'api', component: 'gateway-portal' },
      { type: 'Custom', details: 'family', component: 'family-portal' },
    ],
  }));
  saveComponentSpec(component('gateway-portal', 'core-sub', {
    componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['core-orch'],
    dispatch: [{ capability: 'spec.get', component: 'core-orch', method: 'getRecord' }],
  } as Partial<ComponentSpec>));
  saveComponentSpec(component('family-portal', 'core-sub', { componentType: 'Portal', portalType: 'Custom' } as Partial<ComponentSpec>));
  saveComponentSpec(component('core-orch', 'core-sub'));
  saveInterfaceSpec(iface('igateway-portal', 'gateway-portal', [
    {
      name: 'fetchRecord',
      description: 'Fetches a record by id.',
      signature: 'fetchRecord(id: string): invoice-record',
      returns: 'invoice-record',
      params: [{ name: 'id', type: 'string' }],
      guarantees: ['idempotent'],
      endpoint: { transport: 'HTTP', method: 'GET', path: '/records/{id}' },
    },
  ]));
  saveInterfaceSpec(iface('ifamily-portal', 'family-portal', [
    { name: 'provision', description: 'family-only provisioning', signature: 'provision(): void', returns: 'void' },
  ]));
  saveInterfaceSpec(iface('icore-orch', 'core-orch', [
    { name: 'getRecord', description: 'reads a record', signature: 'getRecord(id: string): invoice-record', returns: 'invoice-record', params: [{ name: 'id', type: 'string' }] },
  ]));
  saveTypeSpec({
    kind: 'value-object', id: 'invoice-record', name: 'InvoiceRecord',
    fields: [
      { name: 'id', type: 'string', optional: false },
      { name: 'owner', type: 'customer-ref', optional: false },
    ],
    methods: [], createdAt: now, updatedAt: now,
  });
  saveTypeSpec({
    kind: 'value-object', id: 'customer-ref', name: 'CustomerRef',
    fields: [{ name: 'customerId', type: 'string', optional: false }],
    methods: [], createdAt: now, updatedAt: now,
  });
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

describe('surface projection (audience ceilings + type closure)', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('filters by audience ceiling and embeds the transitive type closure + dispatch table', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);

    const instanceGrade = projectOwnSurface('instance');
    expect(instanceGrade.interfaces.map(e => e.id)).toEqual(['gateway']);
    expect(instanceGrade.origin).toBe('generated');
    expect(instanceGrade.stateId).toMatch(/:/);

    const gateway = instanceGrade.interfaces[0];
    expect(gateway.methods.map(m => m.name)).toEqual(['fetchRecord']);
    expect(gateway.methods[0].guarantees).toEqual(['idempotent']);
    expect(gateway.dispatch).toEqual([{ capability: 'spec.get', component: 'core-orch', method: 'getRecord' }]);
    // Transitive closure: invoice-record AND the type its field references.
    expect(instanceGrade.types.map(t => t.id).sort()).toEqual(['customer-ref', 'invoice-record']);

    // Family ceiling includes the project-audience entry.
    const family = projectChildSurface();
    expect(family.interfaces.map(e => e.id).sort()).toEqual(['family-ops', 'gateway']);
  });

  it('exports OpenAPI with paths and JSON-Schema components', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);

    const { rendered } = exportSurface('external', 'openapi');
    expect(rendered).toBeDefined();
    const doc = JSON.parse(rendered!);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBe('root-system');
    expect(doc.paths['/records/{id}'].get.operationId).toBe('fetchRecord');
    expect(doc.paths['/records/{id}'].get['x-wairon-guarantees']).toEqual(['idempotent']);
    expect(doc.components.schemas['invoice-record'].properties.owner.$ref).toBe('#/components/schemas/customer-ref');
  });
});

describe('OpenAPI import (authored 3rd-party surfaces)', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('decodes an OpenAPI document into an authored snapshot and stores it', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);

    const openapi = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Partner Billing', version: '2.1.0' },
      paths: {
        '/invoices': {
          post: {
            operationId: 'createInvoice',
            summary: 'Creates an invoice',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { amount: { type: 'number' }, customer: { $ref: '#/components/schemas/Customer' } }, required: ['amount'] } } } },
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } } } },
          },
        },
      },
      components: { schemas: {
        Invoice: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        Customer: { type: 'object', properties: { name: { type: 'string' } } },
      } },
    });
    expect(isOpenApiDocument(openapi)).toBe(true);

    const src = path.join(rootDir, 'partner-billing.json');
    fs.writeFileSync(src, openapi);
    const snapshot = importSurface(src, 'authored');

    expect(snapshot.projectName).toBe('partner-billing');
    expect(snapshot.origin).toBe('authored');
    expect(snapshot.version).toBe('2.1.0');
    const m = snapshot.interfaces[0].methods.find(mm => mm.name === 'createInvoice')!;
    expect(m.returns).toBe('Invoice');
    expect(m.params.map(p => `${p.name}:${p.type}`).sort()).toEqual(['amount:number', 'customer:Customer']);
    expect(m.endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/invoices' });
    expect(snapshot.types.map(t => t.id).sort()).toEqual(['Customer', 'Invoice']);

    expect(listSnapshots().map(s => s.projectName)).toContain('partner-billing');
  });
});

describe('standalone-child validation against generated parent snapshots', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function buildFamily(): string {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);
    createChainedSubsystem(subsystem('transpiler', { projectPath: 'packages/transpiler', status: 'draft' }), 'transpiler');
    const childDir = path.join(rootDir, 'packages', 'transpiler');

    // Child content: an Adapter consuming the parent's gateway across the tree.
    setProjectRoot(childDir);
    saveSubsystemSpec(subsystem('transpiler', { parentSystem: 'transpiler' }));
    saveComponentSpec(component('parent-gateway-adapter', 'transpiler', {
      componentType: 'Adapter', dependsOn: ['super::gateway-portal'],
    } as Partial<ComponentSpec>));
    saveInterfaceSpec(iface('iparent-gateway-adapter', 'parent-gateway-adapter', [
      { name: 'fetchRecord', description: 'fetches via the parent gateway', signature: 'fetchRecord(id: string): json', returns: 'json' },
    ]));
    saveImplementationSpec({
      id: 'parent-gateway-adapter-impl', name: 'impl', description: 'd', contract: 'iparent-gateway-adapter',
      methods: [{
        name: 'fetchRecord',
        narrative: [
          { stepNumber: 1, description: 'call the parent gateway', type: 'call', targetComponent: 'super::gateway-portal', targetMethod: 'fetchRecord' },
        ],
      }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    invalidateSpecCache();

    // Parent generates the family surface into the child.
    setProjectRoot(rootDir);
    const written = generateChildSnapshots();
    expect(written).toHaveLength(1);
    invalidateSpecCache();
    return childDir;
  }

  it('a covered super:: call validates silently; a missing method is SURFACE_REF_NOT_EXPOSED', () => {
    const childDir = buildFamily();

    // Standalone child context.
    setProjectRoot(childDir);
    const res = validateSddTree();
    const codes = res.issues.map(i => i.code);
    expect(codes).not.toContain('CROSS_TREE_REF_UNRESOLVED');
    expect(codes).not.toContain('SURFACE_REF_NOT_EXPOSED');
    expect(codes).not.toContain('INVALID_TARGET_COMPONENT_REFERENCE');
    expect(codes).not.toContain('CROSS_SUBSYSTEM_NON_ADAPTER');

    // Now call a method the surface does not expose.
    saveImplementationSpec({
      id: 'parent-gateway-adapter-impl', name: 'impl', description: 'd', contract: 'iparent-gateway-adapter',
      methods: [{
        name: 'fetchRecord',
        narrative: [
          { stepNumber: 1, description: 'call a method the parent never exposed', type: 'call', targetComponent: 'super::gateway-portal', targetMethod: 'noSuchMethod' },
        ],
      }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    invalidateSpecCache();
    setProjectRoot(childDir);
    const res2 = validateSddTree();
    const notExposed = res2.issues.filter(i => i.code === 'SURFACE_REF_NOT_EXPOSED');
    expect(notExposed).toHaveLength(1);
    expect(notExposed[0].message).toMatch(/noSuchMethod.*root-system/s);
  });

  it('a non-Adapter crossing the project boundary is still a boundary violation', () => {
    const childDir = buildFamily();
    setProjectRoot(childDir);
    saveComponentSpec(component('rogue-orch', 'transpiler', {
      componentType: 'Orchestrator', dependsOn: ['super::gateway-portal'],
    } as Partial<ComponentSpec>));
    invalidateSpecCache();
    setProjectRoot(childDir);
    const res = validateSddTree();
    expect(res.issues.some(i => i.code === 'CROSS_SUBSYSTEM_NON_ADAPTER' && i.message.includes('rogue-orch'))).toBe(true);
  });

  it('parent-side SURFACE_STALE fires when the exported contracts drift after generation', () => {
    buildFamily();

    // Parent context first: fresh snapshot → no staleness.
    setProjectRoot(rootDir);
    expect(validateSddTree().issues.some(i => i.code === 'SURFACE_STALE')).toBe(false);

    // Drift the exported contract: rename the gateway method.
    saveInterfaceSpec(iface('igateway-portal', 'gateway-portal', [
      {
        name: 'fetchRecordV2',
        description: 'Fetches a record by id (renamed).',
        signature: 'fetchRecordV2(id: string): invoice-record',
        returns: 'invoice-record',
        params: [{ name: 'id', type: 'string' }],
        endpoint: { transport: 'HTTP', method: 'GET', path: '/records/{id}' },
      },
    ]));
    invalidateSpecCache();
    setProjectRoot(rootDir);
    const stale = validateSddTree().issues.filter(i => i.code === 'SURFACE_STALE');
    expect(stale).toHaveLength(1);
    expect(stale[0].specId).toBe('transpiler');
    expect(stale[0].message).toMatch(/generate-children/);
  });
});
