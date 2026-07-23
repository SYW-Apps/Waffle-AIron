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
import { toOpenApi, toOpenApiSet, fromOpenApi, isOpenApiDocument } from '../../src/core/openapi.js';
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
    expect(rendered).toBeDefined(); // single public portal → the convenience single doc
    const doc = JSON.parse(rendered!);
    expect(doc.openapi).toBe('3.1.0');
    // Per-portal specs are titled by the portal (each is one API), not the project.
    expect(doc.info.title).toBe('Gateway API');
    expect(doc.paths['/records/{id}'].get.operationId).toBe('fetchRecord');
    expect(doc.paths['/records/{id}'].get['x-wairon-guarantees']).toEqual(['idempotent']);
    expect(doc.components.schemas['invoice-record'].properties.owner.$ref).toBe('#/components/schemas/customer-ref');
  });
});

describe('OpenAPI codec — portal auth + honest multi-spec', () => {
  const httpMethod = (name: string, endpointPath: string) => ({
    name, description: `${name} does a thing`, signature: `${name}(): void`, returns: 'void',
    params: [], endpoint: { transport: 'HTTP' as const, method: 'GET' as const, path: endpointPath },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const snap = (entries: any[]): any => ({ projectName: 'multi', origin: 'generated', generatedAt: now, interfaces: entries, types: [] });

  it('emits securitySchemes + per-operation security from a portal auth', () => {
    const doc = JSON.parse(toOpenApi(snap([
      { id: 'ext', name: 'Ext API', audience: 'external', type: 'REST', component: 'ext-portal',
        auth: { scheme: 'bearer', bearerFormat: 'JWT' }, methods: [httpMethod('a', '/a')] },
    ])));
    expect(doc.components.securitySchemes.BearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(doc.paths['/a'].get.security).toEqual([{ BearerAuth: [] }]);
  });

  it('a none/absent auth emits no security', () => {
    const doc = JSON.parse(toOpenApi(snap([
      { id: 'ext', name: 'Ext', audience: 'external', type: 'REST', component: 'ext', methods: [httpMethod('a', '/a')] },
    ])));
    expect(doc.components?.securitySchemes).toBeUndefined();
    expect(doc.paths['/a'].get.security).toBeUndefined();
  });

  it('toOpenApiSet emits ONE named spec per portal — never merged, each with its own servers + auth', () => {
    const specs = toOpenApiSet(snap([
      { id: 'ext', name: 'External API', audience: 'external', type: 'REST', component: 'ext-portal',
        basePath: '/ext', auth: { scheme: 'apiKey', in: 'header', name: 'X-Key' }, methods: [httpMethod('pub', '/pub')] },
      { id: 'int', name: 'Internal API', audience: 'external', type: 'REST', component: 'int-portal',
        basePath: '/int', auth: { scheme: 'bearer' }, methods: [httpMethod('priv', '/priv')] },
    ]));
    expect(specs.map(s => s.portalId)).toEqual(['ext-portal', 'int-portal']);
    expect(specs.map(s => s.name)).toEqual(['External API', 'Internal API']);
    const ext = JSON.parse(specs[0].document);
    const int = JSON.parse(specs[1].document);
    // Each spec is scoped to its own portal — no cross-contamination of paths.
    expect(Object.keys(ext.paths)).toEqual(['/pub']);
    expect(Object.keys(int.paths)).toEqual(['/priv']);
    expect(ext.servers).toEqual([{ url: '/ext' }]);
    expect(int.servers).toEqual([{ url: '/int' }]);
    expect(ext.components.securitySchemes.ApiKeyAuth).toEqual({ type: 'apiKey', in: 'header', name: 'X-Key' });
    expect(int.components.securitySchemes.BearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
  });

  it('round-trips a bearer auth through fromOpenApi', () => {
    const doc = toOpenApi(snap([
      { id: 'ext', name: 'Ext', audience: 'external', type: 'REST', component: 'ext',
        auth: { scheme: 'bearer', bearerFormat: 'JWT' }, methods: [httpMethod('a', '/a')] },
    ]));
    expect(fromOpenApi(doc, 'ext').interfaces[0].auth).toMatchObject({ scheme: 'bearer', bearerFormat: 'JWT' });
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

  it('tolerates documents without x-wairon-* keys and ignores malformed ones', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);

    const openapi = JSON.stringify({
      openapi: '3.0.3',
      info: { title: 'Plain Partner', version: '1.0.0' },
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } },
          },
          post: {
            operationId: 'makeThing',
            'x-wairon-guarantees': 'not-an-array',
            'x-wairon-effect': 'purge',
            'x-wairon-ext': ['not', 'a', 'map'],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const src = path.join(rootDir, 'plain-partner.json');
    fs.writeFileSync(src, openapi);
    const snapshot = importSurface(src, 'authored');

    // A producer that never heard of wairon: the keys are simply absent.
    const listThings = snapshot.interfaces[0].methods.find(m => m.name === 'listThings')!;
    expect(listThings.guarantees).toBeUndefined();
    expect(listThings.effect).toBeUndefined();
    expect(listThings.ext).toBeUndefined();

    // Malformed x-wairon-* values are ignored, never a failed import.
    const makeThing = snapshot.interfaces[0].methods.find(m => m.name === 'makeThing')!;
    expect(makeThing.guarantees).toBeUndefined();
    expect(makeThing.effect).toBeUndefined();
    expect(makeThing.ext).toBeUndefined();
  });
});

describe('OpenAPI round-trip of x-wairon-* contract keys', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('guarantees, effect, and method ext survive toOpenApi → fromOpenApi identically to the native snapshot path', () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);

    const settleExt = {
      'mypack:priority': 3,
      'mypack:route': { queue: 'billing', retries: 2 },
      'mypack:tags': ['fast', 'ledger'],
    };
    saveInterfaceSpec(iface('igateway-portal', 'gateway-portal', [
      {
        name: 'fetchRecord',
        description: 'Fetches a record by id.',
        signature: 'fetchRecord(id: string): invoice-record',
        returns: 'invoice-record',
        params: [{ name: 'id', type: 'string' }],
        guarantees: ['idempotent'],
        effect: 'read',
        ext: { 'mypack:cache': 'hot' },
        endpoint: { transport: 'HTTP', method: 'GET', path: '/records/{id}' },
      },
      {
        name: 'settleInvoice',
        description: 'Settles an invoice against the ledger.',
        signature: 'settleInvoice(id: string, amount: number): void',
        returns: 'void',
        params: [{ name: 'id', type: 'string' }, { name: 'amount', type: 'number' }],
        // Pack-style non-builtin token alongside a builtin — both must survive.
        guarantees: ['atomic', 'billing:settles-ledger'],
        effect: 'write',
        ext: settleExt,
        endpoint: { transport: 'HTTP', method: 'POST', path: '/invoices/{id}/settle' },
      },
    ]));
    invalidateSpecCache();
    setProjectRoot(rootDir);

    // Native snapshot path: YAML export → consumer import.
    const yamlPath = path.join(rootDir, 'exchange', 'native.yaml');
    exportSurface('external', 'yaml', yamlPath);
    const native = importSurface(yamlPath, 'exchanged');

    // OpenAPI path: toOpenApi render → consumer import via fromOpenApi.
    const apiPath = path.join(rootDir, 'exchange', 'via-openapi.json');
    const { rendered } = exportSurface('external', 'openapi', apiPath);
    const doc = JSON.parse(rendered!);
    expect(doc.paths['/records/{id}'].get['x-wairon-guarantees']).toEqual(['idempotent']);
    expect(doc.paths['/records/{id}'].get['x-wairon-effect']).toBe('read');
    expect(doc.paths['/records/{id}'].get['x-wairon-ext']).toEqual({ 'mypack:cache': 'hot' });
    expect(doc.paths['/invoices/{id}/settle'].post['x-wairon-guarantees']).toEqual(['atomic', 'billing:settles-ledger']);
    expect(doc.paths['/invoices/{id}/settle'].post['x-wairon-effect']).toBe('write');
    expect(doc.paths['/invoices/{id}/settle'].post['x-wairon-ext']).toEqual(settleExt);

    const viaOpenApi = importSurface(apiPath, 'exchanged');

    // The OpenAPI exchange must preserve exactly what the native path preserves.
    const pick = (m: { guarantees?: string[]; effect?: string; ext?: Record<string, unknown> }) =>
      ({ guarantees: m.guarantees, effect: m.effect, ext: m.ext });
    for (const name of ['fetchRecord', 'settleInvoice']) {
      const nativeMethod = native.interfaces.flatMap(e => e.methods).find(m => m.name === name)!;
      const openApiMethod = viaOpenApi.interfaces.flatMap(e => e.methods).find(m => m.name === name)!;
      expect(pick(openApiMethod)).toEqual(pick(nativeMethod));
    }

    // Pin the concrete contract so the parity check cannot pass vacuously.
    const settled = viaOpenApi.interfaces[0].methods.find(m => m.name === 'settleInvoice')!;
    expect(settled.guarantees).toEqual(['atomic', 'billing:settles-ledger']);
    expect(settled.effect).toBe('write');
    expect(settled.ext).toEqual(settleExt);
    const fetched = viaOpenApi.interfaces[0].methods.find(m => m.name === 'fetchRecord')!;
    expect(fetched.guarantees).toEqual(['idempotent']);
    expect(fetched.effect).toBe('read');
    expect(fetched.ext).toEqual({ 'mypack:cache': 'hot' });
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
