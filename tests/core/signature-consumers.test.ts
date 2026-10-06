import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  invalidateSpecCache,
  saveComponentSpec,
  saveInterfaceSpec,
  saveSpec,
  saveSystemSpec,
  saveTypeSpec,
} from '../../src/core/specs.js';
import { projectOwnSurface } from '../../src/core/surfaces.js';
import { fromOpenApi, toOpenApiSet } from '../../src/core/openapi.js';
import { buildCanvasModel } from '../../src/core/canvas.js';
import { project } from '../../src/producers/projection.js';
import { contentDigest, memberDigest } from '../../src/models/surface-references.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, SurfaceSnapshot, TypeSpec } from '../../src/models/index.js';

/** The OpenAPI document (toOpenApiSet renders one per portal) of the portal that serves `/subscriptions`. */
function subscriptionsDocument(snapshot: SurfaceSnapshot): string {
  const spec = toOpenApiSet(snapshot).find((s) => JSON.parse(s.document).paths?.['/subscriptions']);
  if (!spec) throw new Error('no portal document serves /subscriptions');
  return spec.document;
}

// ---------------------------------------------------------------------------
// Stage 1 signatures, wave 6: every consumer shows the resolved signature. A
// snapshot carries a sourced method's params inline and never its
// signatureFrom; a signature type travels complete, its digest follows its
// params and returns; the OpenAPI codec renders it as a function type with no
// JSON form and decodes it back; the canvas and the doc pages show the source
// and the derived text.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
let rootDir = '';

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  rootDir = '';
});

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'sig-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);

function listenerType(params: TypeSpec['params']): TypeSpec {
  return {
    kind: 'signature', id: 'change-listener', name: 'ChangeListener', description: 'Hears one change.',
    fields: [], methods: [], params, returns: 'void', createdAt: now, updatedAt: now,
  } as TypeSpec;
}

/**
 * A REST portal exported at L0: `subscribe` takes its signature from the
 * orchestrator's method, `notify` from the signature type `change-listener`,
 * whose param is the data type `change-event`.
 */
function buildTree(): void {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sig-consumers-'));
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'sig-system', vision: 'signature consumers', boundaries: [], globalRequirements: [],
    publicInterfaces: [{ id: 'events', name: 'Events API', subsystem: 'core', component: 'events-portal', type: 'REST', details: 'events', audience: 'external' }],
    createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', subsystem('core', { publicInterfaces: [{ type: 'REST', details: 'events', component: 'events-portal' }] }));
  saveComponentSpec(component('events-portal', { componentType: 'Portal', portalType: 'HTTP_API', dependsOn: ['events-orch'] } as Partial<ComponentSpec>));
  saveComponentSpec(component('events-orch'));
  saveInterfaceSpec({
    id: 'ievents-orch', name: 'ievents-orch', description: 'd', component: 'events-orch', status: 'complete', createdAt: now, updatedAt: now,
    methods: [{
      name: 'subscribe', description: 'Subscribe a listener to a topic.', signature: 'subscribe(listener: change-listener, topic?: string): string',
      returns: 'string', params: [{ name: 'listener', type: 'change-listener' }, { name: 'topic', type: 'string', optional: true }],
    }],
  });
  saveInterfaceSpec({
    id: 'ievents-portal', name: 'ievents-portal', description: 'd', component: 'events-portal', status: 'complete', createdAt: now, updatedAt: now,
    methods: [
      { name: 'subscribe', description: 'Subscribe over HTTP.', signatureFrom: 'events-orch.subscribe', endpoint: { transport: 'HTTP', method: 'POST', path: '/subscriptions' } },
      { name: 'notify', description: 'Deliver one change.', signatureFrom: 'change-listener', endpoint: { transport: 'HTTP', method: 'POST', path: '/notify' } },
    ],
  } as unknown as InterfaceSpec);
  saveTypeSpec(listenerType([{ name: 'event', type: 'change-event' }]));
  saveTypeSpec({
    kind: 'value-object', id: 'change-event', name: 'ChangeEvent',
    fields: [{ name: 'path', type: 'string', optional: false }], methods: [], createdAt: now, updatedAt: now,
  } as TypeSpec);
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

describe('surface snapshots carry resolved signatures', () => {
  it('inlines a sourced method\'s params and never carries a signatureFrom', () => {
    buildTree();
    const snap = projectOwnSurface('external');
    const entry = snap.interfaces.find((e) => e.id === 'events')!;
    expect(JSON.stringify(snap)).not.toContain('signatureFrom');
    const subscribe = entry.methods.find((m) => m.name === 'subscribe')!;
    expect(subscribe.params).toEqual([{ name: 'listener', type: 'change-listener' }, { name: 'topic', type: 'string', optional: true }]);
    expect(subscribe.returns).toBe('string');
    expect(subscribe.signature).toBe('subscribe(listener: change-listener, topic?: string): string');
    const notify = entry.methods.find((m) => m.name === 'notify')!;
    expect(notify.params).toEqual([{ name: 'event', type: 'change-event' }]);
    expect(notify.returns).toBe('void');
  });

  it('carries a signature type complete, and follows its params into the closure', () => {
    buildTree();
    const snap = projectOwnSurface('external');
    const listener = snap.types.find((t) => t.id === 'change-listener')!;
    expect(listener).toMatchObject({ kind: 'signature', fields: [], params: [{ name: 'event', type: 'change-event' }], returns: 'void' });
    expect(snap.types.map((t) => t.id).sort()).toEqual(['change-event', 'change-listener']);
  });

  it('moves the digest of every member that names a signature when the signature changes', () => {
    buildTree();
    const before = projectOwnSurface('external');
    saveTypeSpec(listenerType([{ name: 'event', type: 'change-event' }, { name: 'retry', type: 'boolean', optional: true }]));
    invalidateSpecCache();
    setProjectRoot(rootDir);
    const after = projectOwnSurface('external');
    // subscribe's own params did not change; only the signature type its param names did.
    expect(memberDigest(after, 'events', 'subscribe')).not.toBe(memberDigest(before, 'events', 'subscribe'));
    expect(contentDigest(after)).not.toBe(contentDigest(before));
    // A param's name is not part of the shape: renaming it moves nothing.
    saveTypeSpec(listenerType([{ name: 'change', type: 'change-event' }, { name: 'again', type: 'boolean', optional: true }]));
    invalidateSpecCache();
    setProjectRoot(rootDir);
    expect(memberDigest(projectOwnSurface('external'), 'events', 'subscribe')).toBe(memberDigest(after, 'events', 'subscribe'));
  });
});

describe('surface snapshots carry an enum (stage 2)', () => {
  /** change-event gains a field typed by an enum, reached through the signature type's param. */
  function withEnum(values: { name: string; description?: string }[]): void {
    saveTypeSpec({
      kind: 'value-object', id: 'change-event', name: 'ChangeEvent',
      fields: [{ name: 'path', type: 'string', optional: false }, { name: 'kind', type: 'change-kind', optional: false }],
      methods: [], createdAt: now, updatedAt: now,
    } as TypeSpec);
    saveTypeSpec({ kind: 'enum', id: 'change-kind', name: 'ChangeKind', description: 'What changed.', fields: [], methods: [], values, createdAt: now, updatedAt: now } as TypeSpec);
    invalidateSpecCache();
    setProjectRoot(rootDir);
  }

  it('follows a field into an enum and carries its values in declared order', () => {
    buildTree();
    withEnum([{ name: 'added', description: 'A new entry.' }, { name: 'removed' }]);
    const kind = projectOwnSurface('external').types.find((t) => t.id === 'change-kind')!;
    expect(kind).toMatchObject({ kind: 'enum', values: [{ name: 'added', description: 'A new entry.' }, { name: 'removed' }] });
  });

  it('moves the digest when a value is added or reordered, and not when only a description changes', () => {
    buildTree();
    withEnum([{ name: 'added' }, { name: 'removed' }]);
    const base = memberDigest(projectOwnSurface('external'), 'events', 'subscribe');
    withEnum([{ name: 'added', description: 'prose only' }, { name: 'removed' }]);
    expect(memberDigest(projectOwnSurface('external'), 'events', 'subscribe')).toBe(base);
    withEnum([{ name: 'removed' }, { name: 'added' }]);
    expect(memberDigest(projectOwnSurface('external'), 'events', 'subscribe')).not.toBe(base);
    withEnum([{ name: 'added' }, { name: 'removed' }, { name: 'moved' }]);
    expect(memberDigest(projectOwnSurface('external'), 'events', 'subscribe')).not.toBe(base);
  });
});

describe('surface snapshots carry a named scalar', () => {
  /** change-event gains a field typed by a named scalar, reached through the signature type's param. */
  function withScalar(holds: string): void {
    saveTypeSpec({
      kind: 'value-object', id: 'change-event', name: 'ChangeEvent',
      fields: [{ name: 'path', type: 'entry-path', optional: false }],
      methods: [], createdAt: now, updatedAt: now,
    } as TypeSpec);
    saveTypeSpec({ kind: 'value-object', id: 'entry-path', name: 'EntryPath', description: 'Where the entry lives.', fields: [], methods: [], holds, createdAt: now, updatedAt: now } as TypeSpec);
    invalidateSpecCache();
    setProjectRoot(rootDir);
  }

  it('follows a field into a named scalar, carries what it holds, and moves the digest when that changes', () => {
    buildTree();
    withScalar('string');
    const surface = projectOwnSurface('external');
    expect(surface.types.find((t) => t.id === 'entry-path')).toMatchObject({ kind: 'value-object', fields: [], holds: 'string' });
    const base = memberDigest(surface, 'events', 'subscribe');
    withScalar('bytes');
    expect(memberDigest(projectOwnSurface('external'), 'events', 'subscribe')).not.toBe(base);
  });
});

describe('OpenAPI codec — signature types', () => {
  it('renders a signature type with no type constraint, a function-type description and x-wairon-signature', () => {
    buildTree();
    const doc = JSON.parse(subscriptionsDocument(projectOwnSurface('external')));
    const component = doc.components.schemas['change-listener'];
    expect(component.type).toBeUndefined();
    expect(component.properties).toBeUndefined();
    expect(component.description).toMatch(/function type/i);
    expect(component['x-wairon-signature']).toEqual({
      params: [{ name: 'event', type: 'change-event', schema: { $ref: '#/components/schemas/change-event' } }],
      returns: { type: 'void', schema: {} },
    });
    // The operation whose param is typed by the signature still documents it.
    const body = doc.paths['/subscriptions'].post.requestBody.content['application/json'].schema;
    expect(body.properties.listener).toEqual({ $ref: '#/components/schemas/change-listener' });
  });

  it('decodes x-wairon-signature back into a signature type (round trip)', () => {
    buildTree();
    const snap = projectOwnSurface('external');
    const back = fromOpenApi(subscriptionsDocument(snap), 'sig-system');
    const listener = back.types.find((t) => t.id === 'change-listener')!;
    expect(listener).toEqual({
      id: 'change-listener', name: 'ChangeListener', kind: 'signature', fields: [],
      params: [{ name: 'event', type: 'change-event' }], returns: 'void',
    });
    expect(back.types.find((t) => t.id === 'change-event')).toMatchObject({ kind: 'value-object' });
  });

  it('reads a signature from its schemas when the extension carries no wairon type text', () => {
    const doc = {
      openapi: '3.1.0', info: { title: 't', version: '1' }, paths: {},
      components: { schemas: {
        thing: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        visitor: { description: 'fn', 'x-wairon-signature': { params: [{ name: 'item', schema: { $ref: '#/components/schemas/thing' }, optional: true }], returns: { schema: { type: 'boolean' } } } },
      } },
    };
    const visitor = fromOpenApi(JSON.stringify(doc), 'third').types.find((t) => t.id === 'visitor')!;
    expect(visitor).toMatchObject({ kind: 'signature', params: [{ name: 'item', type: 'thing', optional: true }], returns: 'bool' });
  });
});

describe('canvas and doc pages show resolved signatures', () => {
  it('the canvas model carries a sourced method\'s source and a signature type\'s derived text', () => {
    buildTree();
    const model = buildCanvasModel();
    const portal = model.components.find((c) => c.id === 'events-portal')!;
    const subscribe = portal.interfaces[0].methods.find((m) => m.name === 'subscribe')!;
    expect(subscribe.signatureFrom).toBe('events-orch.subscribe');
    expect(subscribe.signature).toBe('subscribe(listener: change-listener, topic?: string): string');
    const listener = model.types.find((t) => t.id === 'change-listener')!;
    expect(listener.signature).toBe('(event: change-event): void');
    expect(model.types.find((t) => t.id === 'change-event')!.signature).toBeUndefined();
  });

  it('the doc pages show the source beside a method and list signature types by their text', () => {
    buildTree();
    const root = project('');
    expect(root.body).toContain('## Signature types');
    expect(root.body).toContain('`(event: change-event): void`');
    const portalPage = root.children[0].children.find((p) => p.title.startsWith('events-portal'))!;
    expect(portalPage.body).toContain('`subscribe(listener: change-listener, topic?: string): string` (from `events-orch.subscribe`)');
  });
});
