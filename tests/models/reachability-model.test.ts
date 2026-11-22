/**
 * The reachability model (docs/design/reachability.md, wave 1): the transport
 * vocabulary, entries, roles, networks and language casing as the schemas and
 * pure model functions read them.
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
  componentEntryFor,
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
      .toEqual(['geo::geocoding_provider']);
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
