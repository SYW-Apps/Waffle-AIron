import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithProjectRoot, setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  deleteSubsystemSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  projectOwnSurface,
  exportSurface,
  importSurface,
  listSnapshots,
  surfaceRepository,
  removeSnapshot,
  listFamilyPins,
} from '../../src/core/surfaces.js';
import { computeStateIdAt, loadSystemSpec } from '../../src/core/specs.js';
import { toOpenApiSet, fromOpenApi, isOpenApiDocument } from '../../src/core/openapi.js';
import { validateProject, type ValidationResult } from '../../src/core/validation.js';
import { writeLegacyMount } from '../helpers/legacy-mount.js';
import { SurfaceSnapshotSchema } from '../../src/models/index.js';
import type {
  ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec, SurfaceContractEntry, SurfaceSnapshot,
} from '../../src/models/index.js';

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
  saveSpec('subsystem', subsystem('core-sub', {
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
    const family = projectOwnSurface('project');
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
  /** The one document a single-portal snapshot renders to: toOpenApiSet renders one per portal. */
  const singlePortalDocument = (snapshot: SurfaceSnapshot): string => {
    const specs = toOpenApiSet(snapshot);
    expect(specs).toHaveLength(1);
    return specs[0].document;
  };

  it('emits securitySchemes + per-operation security from a portal auth', () => {
    const doc = JSON.parse(singlePortalDocument(snap([
      { id: 'ext', name: 'Ext API', audience: 'external', type: 'REST', component: 'ext-portal',
        auth: { scheme: 'bearer', bearerFormat: 'JWT' }, methods: [httpMethod('a', '/a')] },
    ])));
    expect(doc.components.securitySchemes.BearerAuth).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
    expect(doc.paths['/a'].get.security).toEqual([{ BearerAuth: [] }]);
  });

  it('a none/absent auth emits no security', () => {
    const doc = JSON.parse(singlePortalDocument(snap([
      { id: 'ext', name: 'Ext', audience: 'external', type: 'REST', component: 'ext', methods: [httpMethod('a', '/a')] },
    ])));
    expect(doc.components?.securitySchemes).toBeUndefined();
    expect(doc.paths['/a'].get.security).toBeUndefined();
  });

  it('toOpenApiSet emits ONE named spec per portal — never merged, each with its own basePath + auth', () => {
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
    expect(Object.keys(ext.paths)).toEqual(['/ext/pub']);
    expect(Object.keys(int.paths)).toEqual(['/int/priv']);
    expect(ext['x-wairon-base-path']).toBe('/ext');
    expect(int['x-wairon-base-path']).toBe('/int');
    expect(ext.components.securitySchemes.ApiKeyAuth).toEqual({ type: 'apiKey', in: 'header', name: 'X-Key' });
    expect(int.components.securitySchemes.BearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
  });

  it('round-trips a bearer auth through fromOpenApi', () => {
    const doc = singlePortalDocument(snap([
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
    expect(m.params.map(p => `${p.name}:${p.type}`).sort()).toEqual(['amount:float', 'customer:Customer']);
    // The partner's create answers 200 where wairon's convention would say 201: kept as the endpoint's stated status.
    expect(m.endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/invoices', status: 200 });
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

  it('guarantees, effect, and method ext survive toOpenApiSet → fromOpenApi identically to the native snapshot path', () => {
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

    // A native export to a .json path is JSON — a file is what its name says —
    // and imports back exactly like the YAML one.
    const jsonPath = path.join(rootDir, 'exchange', 'native.json');
    exportSurface('external', 'yaml', jsonPath);
    expect(() => JSON.parse(fs.readFileSync(jsonPath, 'utf8'))).not.toThrow();
    expect(importSurface(jsonPath, 'exchanged').interfaces).toEqual(native.interfaces);

    // OpenAPI path: toOpenApiSet render → consumer import via fromOpenApi.
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

describe('standalone-child validation against pinned parent snapshots', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function buildFamily(): string {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);
    writeLegacyMount(subsystem('transpiler', { projectPath: 'packages/transpiler', status: 'draft' }), 'transpiler');
    const childDir = path.join(rootDir, 'packages', 'transpiler');

    // Child content: an Adapter consuming the parent's gateway across the tree.
    setProjectRoot(childDir);
    saveSpec('subsystem', subsystem('transpiler', { parentSystem: 'transpiler' }));
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

    // The child holds a stage-1 sibling pin of the parent's core-sub, as
    // `surface pin` once wrote it (stage 3 retired the writer; the pins a child
    // holds are still consulted until stage 4).
    surfaceRepository.saveSnapshot(SurfaceSnapshotSchema.parse({
      projectName: 'root-system::core-sub', origin: 'generated', stateId: 'sha256:pinned', generatedAt: now, types: [],
      interfaces: [{
        id: 'gateway-portal', name: 'gateway-portal', audience: 'project', type: 'REST', component: 'gateway-portal', details: 'api',
        methods: [{ name: 'fetchRecord', description: 'Fetches a record by id.', signature: 'fetchRecord(id: string): json', returns: 'json' }],
      }],
    }), childDir);
    invalidateSpecCache();
    return childDir;
  }

  it('a covered super:: call validates silently; a missing method is SURFACE_REF_NOT_EXPOSED', () => {
    const childDir = buildFamily();

    // Standalone child context.
    setProjectRoot(childDir);
    const res = validateProject();
    const codes = res.issues.map(i => i.code);
    expect(codes).not.toContain('EXTERNAL_CHECK_UNAVAILABLE');
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
    const res2 = validateProject();
    const notExposed = res2.issues.filter(i => i.code === 'SURFACE_REF_NOT_EXPOSED');
    expect(notExposed).toHaveLength(1);
    expect(notExposed[0].message).toMatch(/noSuchMethod.*root-system/s);
    // Covered-but-wrong keeps FULL strength: the vendored snapshot is the
    // verifiable contract, so the mismatch is a hard error even in a chained
    // subproject — never softened.
    expect(notExposed[0].severity).toBe('error');
  });

  it('a non-Adapter crossing the project boundary is still a FULL-STRENGTH boundary violation', () => {
    const childDir = buildFamily();
    setProjectRoot(childDir);
    saveComponentSpec(component('rogue-orch', 'transpiler', {
      componentType: 'Orchestrator', dependsOn: ['super::gateway-portal'],
    } as Partial<ComponentSpec>));
    invalidateSpecCache();
    setProjectRoot(childDir);
    const res = validateProject();
    const violation = res.issues.filter(i => i.code === 'CROSS_SUBSYSTEM_NON_ADAPTER' && i.message.includes('rogue-orch'));
    expect(violation).toHaveLength(1);
    // The ref RESOLVED against a vendored snapshot, so even in a chained
    // subproject validated standalone the boundary verdict stays an error —
    // it is neither downgraded nor waived.
    expect(violation[0].severity).toBe('error');
    expect(res.valid).toBe(false);
  });

  it("a cross-tree ref nothing covers is unavailable in the child's own gate — never resolved through the parent, never a pass", () => {
    const childDir = buildFamily();
    setProjectRoot(childDir);
    saveComponentSpec(component('mystery-adapter', 'transpiler', {
      componentType: 'Adapter', dependsOn: ['super::no-such-portal'],
    } as Partial<ComponentSpec>));
    invalidateSpecCache();
    setProjectRoot(childDir);
    const res = validateProject();
    // The parent is on disk, but the owner's gate never walks up to it (stage
    // 4): a deprecated form naming no alias has nothing to be judged against.
    const unavailable = res.issues.filter(i => i.code === 'EXTERNAL_CHECK_UNAVAILABLE');
    expect(unavailable.map(i => [i.specId, i.severity])).toEqual([['mystery-adapter', 'warning']]);
    expect(unavailable[0].resolution?.outcome).toBe('unavailable');
    expect(res.issues.map(i => i.code)).not.toContain('INVALID_DEPENDENCY_REFERENCE');
  });

  it("a chained child's source paths are its own: a file missing from its root is reported against that root", () => {
    const childDir = buildFamily();
    setProjectRoot(childDir);
    // A complete implementation whose sourcePath resolves nowhere in the child
    // root. A chained child's source paths are relative to its own root, so this
    // is simply code that does not exist — not a path only the parent can read.
    saveComponentSpec(component('trans-orch', 'transpiler'));
    saveInterfaceSpec(iface('itrans-orch', 'trans-orch', [
      { name: 'run', description: 'runs', signature: 'run(): void', returns: 'void' },
    ]));
    saveImplementationSpec({
      id: 'trans-orch-impl', name: 'impl', description: 'd', contract: 'itrans-orch',
      sourcePath: 'src/lives-in-the-parent.ts',
      // The method's own file exists in the child; the implementation's
      // own file does not exist at the child's root, so it is planned there.
      methods: [{ name: 'run', sourcePath: 'src/run.ts', narrative: [] }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    fs.mkdirSync(path.join(childDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(childDir, 'src', 'run.ts'), 'export function run(): void {}');
    invalidateSpecCache();
    setProjectRoot(childDir);
    const res = validateProject();
    // A named file not on disk is planned, judged against the child's own
    // root (never resolved against the parent's).
    const planned = res.issues.filter(i => i.code === 'SOURCE_FILE_PLANNED');
    expect(planned).toHaveLength(1);
    expect(planned[0].message).toContain('src/lives-in-the-parent.ts');
    expect(res.issues.filter(i => i.code === 'MISSING_SOURCE_FILE')).toEqual([]);
  });

});

describe('cross-tree references are matched by the provider they name', () => {
  // Two siblings of one family publish an `invoice-portal` with different
  // contracts: billing's serves invoice.void, archive's also exposes
  // purgeInvoice and serves no capability. A third sibling, ledger, publishes
  // something else. The client below calls purgeInvoice and dispatches
  // invoice.void, so judged against either invoice-portal one of its two steps
  // is not exposed — a verdict against neither shows as no SURFACE_REF_NOT_EXPOSED.
  const dirs: string[] = [];
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    for (const dir of dirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
    }
  });

  const portalEntry = (component: string, methods: string[], capabilities: string[] = []): SurfaceContractEntry => ({
    id: component, name: component, audience: 'project', type: 'Custom', component, details: '',
    methods: methods.map((name) => ({ name, description: `${name} by id`, signature: `${name}(id: string): void`, returns: 'void' })),
    ...(capabilities.length
      ? { dispatch: capabilities.map((capability) => ({ capability, component: 'invoice-orch', method: 'handle' })) }
      : {}),
  });
  const pin = (projectName: string, interfaces: SurfaceContractEntry[]): SurfaceSnapshot => SurfaceSnapshotSchema.parse({
    projectName, origin: 'generated', stateId: 'sha256:pinned', generatedAt: now, interfaces, types: [],
  });

  const BILLING = pin('root-system::billing', [portalEntry('invoice-portal', ['fetchInvoice'], ['invoice.void'])]);
  const ARCHIVE = pin('root-system::archive', [portalEntry('invoice-portal', ['fetchInvoice', 'purgeInvoice'])]);
  const LEDGER = pin('root-system::ledger', [portalEntry('ledger-portal', ['postEntry'])]);

  /**
   * A parent mounting a chained child whose Adapter consumes `ref`: it depends
   * on it, calls `callMethod` on it and dispatches invoice.void through it. The
   * child holds `pins` in its own .wai/surfaces/.
   */
  function family(ref: string, callMethod: string, pins: SurfaceSnapshot[]): { root: string; kidDir: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-provider-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    setProjectRoot(root);
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'root-system', vision: 'provider matching fixture',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    writeLegacyMount(subsystem('kid', { projectPath: 'packages/kid' }), 'kid');
    const kidDir = path.join(root, 'packages', 'kid');

    setProjectRoot(kidDir);
    saveSpec('subsystem', subsystem('desk', { parentSystem: 'kid' }));
    saveComponentSpec(component('invoice-client', 'desk', {
      componentType: 'Adapter', dependsOn: [ref],
    } as Partial<ComponentSpec>));
    saveInterfaceSpec(iface('iinvoice-client', 'invoice-client', [
      { name: 'settle', description: 'settles an invoice', signature: 'settle(id: string): void', returns: 'void' },
    ]));
    saveImplementationSpec({
      id: 'invoice-client-impl', name: 'impl', description: 'd', contract: 'iinvoice-client',
      methods: [{
        name: 'settle',
        narrative: [
          { stepNumber: 1, description: 'call the invoice portal', type: 'call', targetComponent: ref, targetMethod: callMethod },
          { stepNumber: 2, description: 'void through the invoice portal', type: 'dispatch', targetComponent: ref, capability: 'invoice.void' },
        ],
      }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    runWithProjectRoot(kidDir, () => { for (const snapshot of pins) surfaceRepository.saveSnapshot(snapshot); });
    invalidateSpecCache();
    return { root, kidDir };
  }

  /** The child as a clone that never had its parent: the pins are all it has. */
  function cloneWithoutParent(kidDir: string): string {
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-clone-'));
    dirs.push(clone);
    fs.cpSync(kidDir, clone, { recursive: true });
    return clone;
  }

  function verdict(root: string): ValidationResult {
    invalidateSpecCache();
    setProjectRoot(root);
    return validateProject();
  }

  /** The findings of one code as `severity @specId`, sorted. */
  function findings(res: ValidationResult, code: string): string[] {
    return res.issues.filter((i) => i.code === code).map((i) => `${i.severity} @${i.specId}`).sort();
  }

  it('a super:: reference two providers answer with different contracts is SURFACE_REF_AMBIGUOUS, judged against neither', () => {
    const res = verdict(cloneWithoutParent(family('super::invoice-portal', 'purgeInvoice', [BILLING, ARCHIVE, LEDGER]).kidDir));

    // The dependency, the call and the dispatch each report it.
    expect(findings(res, 'SURFACE_REF_AMBIGUOUS')).toEqual([
      'error @invoice-client', 'error @invoice-client-impl', 'error @invoice-client-impl',
    ]);
    for (const finding of res.issues.filter((i) => i.code === 'SURFACE_REF_AMBIGUOUS')) {
      expect(finding.message).toContain('"root-system::billing"');
      expect(finding.message).toContain('"root-system::archive"');
      expect(finding.message).not.toContain('root-system::ledger');
      // The ambiguity is the verdict: it carries the resolution that decided it.
      expect(finding.resolution?.outcome).toBe('ambiguous');
    }
    const codes = res.issues.map((i) => i.code);
    expect(codes).not.toContain('SURFACE_REF_NOT_EXPOSED');
    expect(codes).not.toContain('EXTERNAL_CHECK_UNAVAILABLE');
    expect(res.valid).toBe(false);
  });

  it("from the parent root the child's references are the child's own gate's — the parent reports none of them", () => {
    const res = verdict(family('super::invoice-portal', 'purgeInvoice', [BILLING, ARCHIVE, LEDGER]).root);

    expect(findings(res, 'SURFACE_REF_AMBIGUOUS')).toEqual([]);
    expect(findings(res, 'SURFACE_REF_NOT_EXPOSED')).toEqual([]);
  });

  it('a reference that names its provider is judged against that provider alone', () => {
    // billing never exposed purgeInvoice, and archive — which does — is not consulted.
    const billing = verdict(cloneWithoutParent(
      family('super::billing::invoice-portal', 'purgeInvoice', [BILLING, ARCHIVE, LEDGER]).kidDir,
    ));
    expect(findings(billing, 'SURFACE_REF_AMBIGUOUS')).toEqual([]);
    const billingGaps = billing.issues.filter((i) => i.code === 'SURFACE_REF_NOT_EXPOSED');
    expect(billingGaps.map((i) => i.specId)).toEqual(['invoice-client-impl']);
    expect(billingGaps[0].message).toMatch(/purgeInvoice.*"root-system::billing"/s);

    // archive serves no invoice.void, and billing — which does — is not consulted.
    const archive = verdict(cloneWithoutParent(
      family('super::archive::invoice-portal', 'purgeInvoice', [BILLING, ARCHIVE, LEDGER]).kidDir,
    ));
    expect(findings(archive, 'SURFACE_REF_AMBIGUOUS')).toEqual([]);
    const archiveGaps = archive.issues.filter((i) => i.code === 'SURFACE_REF_NOT_EXPOSED');
    expect(archiveGaps.map((i) => i.specId)).toEqual(['invoice-client-impl']);
    expect(archiveGaps[0].message).toMatch(/invoice\.void.*"root-system::archive"/s);
  });

  it("a provider that does not expose the name never borrows another provider's contract", () => {
    // ledger publishes no invoice-portal; billing and archive do, and neither stands in for it.
    const res = verdict(cloneWithoutParent(
      family('super::ledger::invoice-portal', 'fetchInvoice', [BILLING, ARCHIVE, LEDGER]).kidDir,
    ));

    expect(findings(res, 'EXTERNAL_CHECK_UNAVAILABLE')).toEqual(['warning @invoice-client', 'warning @invoice-client-impl']);
    const codes = res.issues.map((i) => i.code);
    expect(codes).not.toContain('SURFACE_REF_AMBIGUOUS');
    expect(codes).not.toContain('SURFACE_REF_NOT_EXPOSED');
  });

  it('providers exposing the name with the same contract leave nothing ambiguous', () => {
    const sameAsBilling = pin('root-system::archive', BILLING.interfaces);
    const res = verdict(cloneWithoutParent(
      family('super::invoice-portal', 'purgeInvoice', [BILLING, sameAsBilling]).kidDir,
    ));

    expect(findings(res, 'SURFACE_REF_AMBIGUOUS')).toEqual([]);
    // It resolved: the one contract both declare judges the call it does not expose.
    expect(findings(res, 'SURFACE_REF_NOT_EXPOSED')).toEqual(['error @invoice-client-impl']);
  });
});

describe('stage-1 family pins + computeStateIdAt', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  /** Parent + chained child holding a stage-1 family pin, a sibling pin and a foreign import. */
  function buildChainedWorld(): string {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surf-'));
    buildParent(rootDir);
    writeLegacyMount(subsystem('transpiler', { projectPath: 'packages/transpiler', status: 'draft' }), 'transpiler');
    invalidateSpecCache();
    const childDir = path.join(rootDir, 'packages', 'transpiler');
    const snap = (projectName: string, origin: 'generated' | 'authored') => SurfaceSnapshotSchema.parse({
      projectName, origin, stateId: 'sha256:pinned', generatedAt: now, types: [], interfaces: [],
    });
    runWithProjectRoot(childDir, () => {
      surfaceRepository.saveSnapshot(snap('root-system', 'generated'));
      surfaceRepository.saveSnapshot(snap('root-system::core-sub', 'generated'));
      surfaceRepository.saveSnapshot(snap('stripe', 'authored'));
    });
    invalidateSpecCache();
    return childDir;
  }

  it('lists the generated pins a root holds, parent and sibling, never a foreign import', () => {
    const childDir = buildChainedWorld();
    setProjectRoot(childDir);
    expect(listFamilyPins().map((pin) => [pin.key, pin.role])).toEqual([
      ['root-system', 'parent'],
      ['root-system::core-sub', 'sibling'],
    ]);
    // Reads only the bound root: the parent holds no pins of its own.
    setProjectRoot(rootDir);
    expect(listFamilyPins()).toEqual([]);
  });

  it('computeStateIdAt returns the hash, restores the previous binding, and is null for a non-project root', () => {
    const childDir = buildChainedWorld();

    // Bind the CHILD; hash the PARENT.
    setProjectRoot(childDir);
    const parentHash = computeStateIdAt(rootDir);
    expect(parentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Deterministic: same tree, same hash.
    expect(computeStateIdAt(rootDir)).toBe(parentHash);
    // The previous binding is restored — loads still resolve the CHILD tree.
    expect(loadSystemSpec()?.name).toBe('transpiler');

    // A root with no loadable spec tree short-circuits to null (binding still restored).
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-empty-'));
    try {
      expect(computeStateIdAt(emptyDir)).toBeNull();
      expect(loadSystemSpec()?.name).toBe('transpiler');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('surface projection over the resolved export table', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  /** buildParent, plus a declared project id, a subsystem-owned type and re-export entries at L0. */
  function buildExporting(): void {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surface-exports-'));
    buildParent(rootDir);
    fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), [
      "schemaVersion: '1.0.0'", 'name: Root System', 'id: root-sys',
      `createdAt: '${now}'`, `updatedAt: '${now}'`,
    ].join('\n'));
    saveTypeSpec({
      kind: 'value-object', id: 'ledger-entry', name: 'LedgerEntry', subsystem: 'core-sub',
      fields: [{ name: 'amount', type: 'number', optional: false }],
      methods: [], createdAt: now, updatedAt: now,
    });
    saveSpec('subsystem', subsystem('core-sub', {
      publicInterfaces: [
        { type: 'REST', details: 'api', component: 'gateway-portal' },
        { type: 'Custom', details: 'family', component: 'family-portal' },
        { typeDef: 'ledger-entry' },
      ],
    }));
    const system = loadSystemSpec()!;
    saveSystemSpec({
      ...system,
      publicInterfaces: [
        ...(system.publicInterfaces ?? []),
        { from: 'core-sub', component: 'gateway-portal', interface: 'igateway-portal', as: 'records', audience: 'external' },
        { from: 'core-sub', typeDef: 'ledger-entry', audience: 'external' },
      ],
    });
    invalidateSpecCache();
    setProjectRoot(rootDir);
  }

  it('keeps every legacy public name and records the stereotype, the narrowing and the project id', () => {
    buildExporting();
    const snap = projectOwnSurface('project');
    expect(snap.projectName).toBe('root-system');
    expect(snap.projectId).toBe('root-sys');
    expect(snap.interfaces.map((e) => e.id).sort()).toEqual(['family-ops', 'gateway', 'records']);
    const gateway = snap.interfaces.find((e) => e.id === 'gateway')!;
    expect(gateway.componentType).toBe('Portal');
    expect(gateway.interface).toBeUndefined();
    const records = snap.interfaces.find((e) => e.id === 'records')!;
    expect(records).toMatchObject({ component: 'gateway-portal', interface: 'igateway-portal', type: 'REST', details: 'api' });
    expect(records.methods.map((m) => m.name)).toEqual(['fetchRecord']);
  });

  it('lists an exported type apart from the contract entries, with its definition in the closure', () => {
    buildExporting();
    const snap = projectOwnSurface('external');
    expect(snap.exportedTypes).toEqual([{ id: 'ledger-entry', type: 'ledger-entry', audience: 'external' }]);
    expect(snap.types.map((t) => t.id)).toContain('ledger-entry');
    expect(snap.interfaces.some((e) => e.id === 'ledger-entry')).toBe(false);
  });

  it('drops an entry the resolver cannot bind, and reports it through validate as an error (stage 4)', () => {
    buildExporting();
    const system = loadSystemSpec()!;
    saveSystemSpec({ ...system, publicInterfaces: [...(system.publicInterfaces ?? []), { id: 'ghost-api', type: 'REST', details: 'nothing behind it' }] });
    invalidateSpecCache();
    setProjectRoot(rootDir);
    expect(projectOwnSurface('project').interfaces.some((e) => e.id === 'ghost-api')).toBe(false);
    const result = validateProject();
    const invalid = result.issues.filter((i) => i.code === 'EXPORT_INVALID');
    expect(invalid.map((i) => i.severity)).toEqual(['error']);
    expect(invalid[0].message).toContain('ghost-api');
  });
});
