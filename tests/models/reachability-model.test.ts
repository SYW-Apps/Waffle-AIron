/**
 * The reachability model (docs/design/reachability.md, wave 1): the transport
 * vocabulary, entries, roles, networks and language casing as the schemas and
 * pure model functions read them, and the retired forms (portalType, listener
 * mounts, the retired invokedBy kinds, authored export types, in-process
 * Custom endpoints) read compatibly and kept as facts — never silently dropped.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ComponentSpecSchema,
  EndpointSchema,
  ImplementationSpecSchema,
  InterfaceSpecSchema,
  MethodSignatureSchema,
  PublicInterfaceSchema,
  SurfaceContractEntrySchema,
  SurfaceSnapshotSchema,
  carryRetiredReachForms,
  componentEntryFor,
  isInProcessAddress,
  readRetiredReachForms,
  retiredMountsOf,
  transportExportKind,
  transportKind,
  transportRequiresEndpoint,
  type Transport,
} from '../../src/models/specs.js';
import { ProjectConfigSchema, methodCasingFor } from '../../src/models/project.js';
import {
  invalidateSpecCache,
  loadComponentSpec,
  loadInterfaceSpec,
  retiredReachFacts,
  saveComponentSpec,
  saveInterfaceSpec,
  updateSpec,
} from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';

const now = '2026-10-06T12:00:00.000Z';

describe('the transport vocabulary', () => {
  const all: Transport[] = ['HTTP', 'gRPC', 'GraphQL', 'MessageBus', 'CLI', 'NamedPipe', 'IPC', 'JSONRPC', 'InProcess', 'Custom'];

  it('sorts every transport into network, local or in-process', () => {
    expect(Object.fromEntries(all.map((t) => [t, transportKind(t)]))).toEqual({
      HTTP: 'network', gRPC: 'network', GraphQL: 'network', MessageBus: 'network', Custom: 'network',
      CLI: 'local', NamedPipe: 'local', IPC: 'local', JSONRPC: 'local',
      InProcess: 'in-process',
    });
  });

  it('requires an endpoint on every transport but InProcess and Custom', () => {
    expect(all.filter((t) => !transportRequiresEndpoint(t))).toEqual(['InProcess', 'Custom']);
  });

  it('derives the export kind instead of authoring it', () => {
    expect(Object.fromEntries(all.map((t) => [t, transportExportKind(t)]))).toEqual({
      HTTP: 'REST', gRPC: 'RPC', GraphQL: 'GraphQL', MessageBus: 'MessageBus', CLI: 'Custom', NamedPipe: 'Custom',
      IPC: 'Custom', JSONRPC: 'RPC', InProcess: 'Custom', Custom: 'Custom',
    });
  });

  it('binds a JSONRPC verb by its method name; InProcess has no endpoint shape at all', () => {
    expect(EndpointSchema.parse({ transport: 'JSONRPC', method: 'textDocument/hover' })).toEqual({ transport: 'JSONRPC', method: 'textDocument/hover' });
    expect(EndpointSchema.safeParse({ transport: 'InProcess' }).success).toBe(false);
  });
});

describe('the new fields parse', () => {
  const portal = (over: Record<string, unknown>) => ({
    id: 'web', name: 'Web', description: 'd', subsystem: 's', componentType: 'Portal', createdAt: now, updatedAt: now, ...over,
  });

  it('a Portal states its transport, an InProcess one its abi, and a Portal-level entry with its scope', () => {
    const c = ComponentSpecSchema.parse(portal({ transport: 'InProcess', abi: 'c', invokedBy: { kind: 'entry', caller: 'Applications that link the crate' } }));
    expect(c).toMatchObject({ transport: 'InProcess', abi: 'c', invokedBy: { kind: 'entry', caller: 'Applications that link the crate' } });
    const scoped = ComponentSpecSchema.parse(portal({ transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Sibling services', scope: 'network' } }));
    expect(scoped.invokedBy?.scope).toBe('network');
  });

  it('the schema no longer types portalType or mounts: a parse drops them, and authoring a retired kind is refused', () => {
    const c = ComponentSpecSchema.parse(portal({ portalType: 'HTTP_API', mounts: [{ portal: 'api', prefixes: ['/api'] }] }));
    expect('portalType' in c).toBe(false);
    expect('mounts' in c).toBe(false);
    const method = (kind: string) => MethodSignatureSchema.safeParse({ name: 'm', description: 'd', signature: 'm(): void', returns: 'void', invokedBy: { kind, caller: 'x' } });
    expect(method('entry').success).toBe(true);
    expect(method('runtime').success).toBe(true);
    expect(method('external').success).toBe(false);
    expect(method('sibling-subsystem').success).toBe(false);
  });

  it('the method effect vocabulary gains none and io', () => {
    for (const effect of ['none', 'read', 'write', 'lifecycle', 'io']) {
      expect(MethodSignatureSchema.safeParse({ name: 'm', description: 'd', signature: 'm(): void', returns: 'void', effect }).success, effect).toBe(true);
    }
  });

  it('a contract may implement an exported extension point; a Portal implementation names its router', () => {
    expect(InterfaceSpecSchema.parse({ id: 'igeo', name: 'G', description: 'd', component: 'geo', implements: 'geo::geocoding_provider', createdAt: now, updatedAt: now }).implements)
      .toBe('geo::geocoding_provider');
    expect(ImplementationSpecSchema.parse({ id: 'web_impl', name: 'W', description: 'd', contract: 'iweb', router: 'handleWebRequest', createdAt: now, updatedAt: now }).router)
      .toBe('handleWebRequest');
  });

  it('an own export entry needs details but no longer an authored type, and may be exported for consumers to implement', () => {
    expect(PublicInterfaceSchema.safeParse({ component: 'web', details: 'the shop API' }).success).toBe(true);
    expect(PublicInterfaceSchema.safeParse({ component: 'geo_port', details: 'the provider port', role: 'implement' }).success).toBe(true);
    expect(PublicInterfaceSchema.safeParse({ component: 'web' }).success).toBe(false);
    // The legacy authored type still parses.
    expect(PublicInterfaceSchema.parse({ component: 'web', details: 'd', type: 'REST' }).type).toBe('REST');
  });

  it('snapshots carry transport, abi, role and the producer targetLanguage, and older ones still parse', () => {
    const entry = SurfaceContractEntrySchema.parse({ id: 'sdk', name: 'sdk', component: 'sdk_portal', transport: 'InProcess', abi: 'c', role: 'call' });
    expect(entry).toMatchObject({ transport: 'InProcess', abi: 'c', role: 'call' });
    const older = SurfaceContractEntrySchema.parse({ id: 'api', name: 'api', component: 'api_portal' });
    expect(older.transport).toBeUndefined();
    expect(SurfaceSnapshotSchema.parse({ projectName: 'p', origin: 'generated', generatedAt: now, targetLanguage: 'rust' }).targetLanguage).toBe('rust');
  });

  it('a project declares a network as `true` or with a description; false is no declaration', () => {
    const config = (network: unknown) => ProjectConfigSchema.parse({ name: 'p', createdAt: now, updatedAt: now, ...(network === undefined ? {} : { network }) }).network;
    expect(config(true)).toEqual({});
    expect(config({ description: 'Order-processing services' })).toEqual({ description: 'Order-processing services' });
    expect(config(false)).toBeUndefined();
    expect(config(undefined)).toBeUndefined();
  });
});

describe('component_spec.entryFor', () => {
  const portal = { componentType: 'Portal' as const, invokedBy: { kind: 'entry' as const, caller: 'Browsers', scope: 'outside' as const } };

  it('a verb inherits the Portal-level entry, and its own scope takes precedence', () => {
    expect(componentEntryFor(portal)).toEqual(portal.invokedBy);
    expect(componentEntryFor(portal, { kind: 'entry', scope: 'network' })).toEqual({ kind: 'entry', caller: 'Browsers', scope: 'network' });
  });

  it('a verb that declares its own is its own; a non-Portal has no entry', () => {
    expect(componentEntryFor({ componentType: 'Portal' }, { kind: 'entry', caller: 'Ops' })).toEqual({ kind: 'entry', caller: 'Ops' });
    expect(componentEntryFor({ componentType: 'Orchestrator', invokedBy: portal.invokedBy })).toBeUndefined();
  });
});

describe('naming_rule_config.methodCasingFor', () => {
  it('the configured casing wins; otherwise the target language decides, camelCase by default', () => {
    expect(methodCasingFor({ methods: 'snake_case' }, 'typescript')).toBe('snake_case');
    expect(methodCasingFor(undefined, 'Rust')).toBe('snake_case');
    expect(methodCasingFor({}, 'python')).toBe('snake_case');
    expect(methodCasingFor(undefined, 'go')).toBe('PascalCase');
    expect(methodCasingFor(undefined, 'typescript')).toBe('camelCase');
    expect(methodCasingFor(undefined, 'cobol')).toBe('camelCase');
    expect(methodCasingFor(undefined)).toBe('camelCase');
  });
});

describe('the retired reachability forms, read compatibly (pure)', () => {
  it('portalType becomes transport (HTTP_API as HTTP), unless a transport is already stated; the stored value is a fact', () => {
    const doc: Record<string, unknown> = { id: 'web', componentType: 'Portal', portalType: 'HTTP_API' };
    expect(readRetiredReachForms('component', doc)).toEqual([{ form: 'portal-type', specId: 'web', stored: 'HTTP_API' }]);
    expect(doc).toEqual({ id: 'web', componentType: 'Portal', transport: 'HTTP' });
    const both: Record<string, unknown> = { id: 'cli', portalType: 'CLI', transport: 'JSONRPC' };
    readRetiredReachForms('component', both);
    expect(both.transport).toBe('JSONRPC');
  });

  it('a listener\'s mounts are facts, one per mounted portal, and stay on the document for the loader to keep', () => {
    const mounts = [{ portal: 'api', prefixes: ['/api'], via: 'apiRouter' }, { portal: 'admin', prefixes: ['/admin'] }];
    const doc: Record<string, unknown> = { id: 'host', mounts };
    expect(readRetiredReachForms('component', doc)).toEqual([
      { form: 'listener-mounts', specId: 'host', at: 'api', stored: mounts[0] },
      { form: 'listener-mounts', specId: 'host', at: 'admin', stored: mounts[1] },
    ]);
    expect(doc.mounts).toBe(mounts);
    expect(readRetiredReachForms('component', { id: 'solo', mounts: [] })).toEqual([{ form: 'listener-mounts', specId: 'solo', stored: [] }]);
    expect(retiredMountsOf({ mounts: [] })).toEqual({ declared: true, mounts: [] });
    expect(retiredMountsOf({})).toEqual({ declared: false, mounts: [] });
    expect(retiredMountsOf({ mounts })).toEqual({ declared: true, mounts });
  });

  it('a retired invokedBy kind reads as runtime, or as entry when external sits on a Portal\'s contract', () => {
    const doc = (kind: string): Record<string, unknown> => ({ id: 'iapi', methods: [{ name: 'run', invokedBy: { kind, caller: 'x' } }] });
    const kindOf = (d: Record<string, unknown>) => ((d.methods as Record<string, any>[])[0].invokedBy.kind);
    const external = doc('external');
    expect(readRetiredReachForms('interface', external)).toEqual([{ form: 'invoked-by-kind', specId: 'iapi', at: 'run', stored: 'external' }]);
    expect(kindOf(external)).toBe('runtime');
    const onPortal = doc('external');
    readRetiredReachForms('interface', onPortal, true);
    expect(kindOf(onPortal)).toBe('entry');
    const sibling = doc('sibling-subsystem');
    readRetiredReachForms('interface', sibling, true);
    expect(kindOf(sibling)).toBe('runtime');
    expect(readRetiredReachForms('interface', doc('runtime'))).toEqual([]);
  });

  it('an in-process Custom endpoint is a fact and still parses', () => {
    expect(isInProcessAddress('in-process migration.plan')).toBe(true);
    expect(isInProcessAddress('@wairon/sdk#defineSpec')).toBe(true);
    expect(isInProcessAddress('mcp tools/call sdd_get_status')).toBe(false);
    const endpoint = { transport: 'Custom', address: '@wairon/sdk#defineSpec' };
    expect(readRetiredReachForms('interface', { id: 'isdk', methods: [{ name: 'defineSpec', endpoint }] }))
      .toEqual([{ form: 'in-process-endpoint', specId: 'isdk', at: 'defineSpec', stored: endpoint }]);
  });

  it('an authored export type is a fact on an L1 and an L0 table', () => {
    expect(readRetiredReachForms('subsystem', { id: 'shop', publicInterfaces: [{ component: 'web', type: 'REST', details: 'd' }, { from: 'other' }] }))
      .toEqual([{ form: 'export-type', specId: 'shop', at: 'web', stored: 'REST' }]);
    expect(readRetiredReachForms('system', { publicInterfaces: [{ as: 'shop-api', component: 'web', type: 'REST' }] }))
      .toEqual([{ form: 'export-type', specId: 'system', at: 'shop-api', stored: 'REST' }]);
  });

  it('the writer carries what a write did not decide to change, and nothing it did', () => {
    const out: Record<string, unknown> = { id: 'host', componentType: 'Portal' };
    carryRetiredReachForms('component', { mounts: [{ portal: 'api', prefixes: ['/api'] }] }, out);
    expect(out.mounts).toEqual([{ portal: 'api', prefixes: ['/api'] }]);
    const retyped: Record<string, unknown> = { id: 'host', componentType: 'Orchestrator' };
    carryRetiredReachForms('component', { mounts: [] }, retyped);
    expect('mounts' in retyped).toBe(false);

    const stored = { methods: [{ name: 'a', invokedBy: { kind: 'external', caller: 'x' } }, { name: 'b', invokedBy: { kind: 'sibling-subsystem', caller: 'y' } }] };
    const written: Record<string, unknown> = { methods: [{ name: 'a', invokedBy: { kind: 'entry', caller: 'x' } }, { name: 'b', invokedBy: { kind: 'runtime', caller: 'changed' } }] };
    carryRetiredReachForms('interface', stored, written);
    expect((written.methods as Record<string, any>[]).map((m) => m.invokedBy.kind)).toEqual(['external', 'runtime']);
  });
});

describe('the loader reads the retired forms compatibly and keeps them as facts', () => {
  let proj: string | undefined;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
    proj = undefined;
  });

  /** A project written in the OLD forms, straight to disk. */
  function oldProject(): string {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reach-'));
    const specs = path.join(proj, '.wai', 'specs');
    writeYamlFile(path.join(proj, '.wai', 'project.yaml'), { schemaVersion: '1.0.0', name: 'shop', targets: [], network: true });
    writeYamlFile(path.join(specs, '.index.yaml'), {
      schemaVersion: '1.0.0', name: 'Shop', vision: 'sells things', boundaries: [], globalRequirements: [],
      publicInterfaces: [{ as: 'shop-api', from: 'shop', component: 'web', type: 'REST', details: 'the shop', audience: 'external' }],
      createdAt: now, updatedAt: now,
    });
    writeYamlFile(path.join(specs, 'shop', '.index.yaml'), {
      id: 'shop', name: 'Shop', description: 'd', parentSystem: 'Shop',
      publicInterfaces: [{ component: 'web', type: 'REST', details: 'the shop API' }], createdAt: now, updatedAt: now,
    });
    writeYamlFile(path.join(specs, 'shop', 'host', '.index.yaml'), {
      id: 'host', name: 'Host', description: 'the listener', subsystem: 'shop', componentType: 'Portal', portalType: 'HTTP_API',
      owns: [], dependsOn: [], mounts: [{ portal: 'web', prefixes: ['/web'], via: 'handleWebRequest' }], createdAt: now, updatedAt: now,
    });
    writeYamlFile(path.join(specs, 'shop', 'web', '.index.yaml'), {
      id: 'web', name: 'Web', description: 'the shop API', subsystem: 'shop', componentType: 'Portal', portalType: 'Custom',
      owns: [], dependsOn: [], createdAt: now, updatedAt: now,
    });
    writeYamlFile(path.join(specs, 'shop', 'web', '.interface.yaml'), {
      id: 'iweb', name: 'IWeb', description: 'd', component: 'web', createdAt: now, updatedAt: now,
      methods: [
        { name: 'browse', description: 'd', signature: 'browse(): void', returns: 'void', invokedBy: { kind: 'external', caller: 'Browsers' } },
        { name: 'sync', description: 'd', signature: 'sync(): void', returns: 'void', invokedBy: { kind: 'sibling-subsystem', caller: 'The ledger' } },
      ],
    });
    setProjectRoot(proj);
    invalidateSpecCache();
    return specs;
  }

  it('loads portalType as transport, keeps mounts read (untyped), and reads external on a Portal\'s contract as an entry', () => {
    oldProject();
    expect(loadComponentSpec('host')?.transport).toBe('HTTP');
    expect(loadComponentSpec('web')?.transport).toBe('Custom');
    expect(retiredMountsOf(loadComponentSpec('host')!).mounts).toEqual([{ portal: 'web', prefixes: ['/web'], via: 'handleWebRequest' }]);
    const methods = loadInterfaceSpec('iweb')!.methods;
    expect(methods.find((m) => m.name === 'browse')?.invokedBy).toEqual({ kind: 'entry', caller: 'Browsers' });
    expect(methods.find((m) => m.name === 'sync')?.invokedBy).toEqual({ kind: 'runtime', caller: 'The ledger' });
  });

  it('records every retired form it met, with what the stored spec held', () => {
    oldProject();
    const facts = retiredReachFacts().map((f) => `${f.form}|${f.specId}|${f.at ?? ''}|${JSON.stringify(f.stored)}`).sort();
    expect(facts).toEqual([
      'export-type|shop|web|"REST"',
      'export-type|system|shop-api|"REST"',
      'in-process-endpoint|web||{"transport":"Custom","endpoints":[]}',
      'invoked-by-kind|iweb|browse|"external"',
      'invoked-by-kind|iweb|sync|"sibling-subsystem"',
      'listener-mounts|host|web|{"portal":"web","prefixes":["/web"],"via":"handleWebRequest"}',
      'portal-type|host||"HTTP_API"',
      'portal-type|web||"Custom"',
    ]);
  });

  it('a write that did not decide to change them keeps the mounts and the retired kinds on the file, and stores the transport', () => {
    const specs = oldProject();
    updateSpec('component', 'host', { description: 'the HTTP listener' });
    const host = readYamlFile(path.join(specs, 'shop', 'host', '.index.yaml')) as Record<string, unknown>;
    expect(host.transport).toBe('HTTP');
    expect('portalType' in host).toBe(false);
    expect(host.mounts).toEqual([{ portal: 'web', prefixes: ['/web'], via: 'handleWebRequest' }]);

    invalidateSpecCache();
    saveInterfaceSpec({ ...loadInterfaceSpec('iweb')!, description: 'the shop contract' });
    const iweb = readYamlFile(path.join(specs, 'shop', 'web', '.interface.yaml')) as { methods: { invokedBy: { kind: string } }[] };
    expect(iweb.methods.map((m) => m.invokedBy.kind)).toEqual(['external', 'sibling-subsystem']);
    invalidateSpecCache();
    expect(retiredReachFacts().filter((f) => f.form === 'listener-mounts' || f.form === 'invoked-by-kind')).toHaveLength(3);
  });

  it('a programmatic save still handing portalType stores the transport it names', () => {
    oldProject();
    saveComponentSpec({
      id: 'admin', name: 'Admin', description: 'd', subsystem: 'shop', componentType: 'Portal', portalType: 'gRPC',
      owns: [], dependsOn: [], createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();
    expect(loadComponentSpec('admin')?.transport).toBe('gRPC');
  });
});
