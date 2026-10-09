import { describe, it, expect } from 'vitest';
import { fromOpenApi, toOpenApiSet } from '../../src/core/openapi.js';
import type { SurfaceSnapshot } from '../../src/models/index.js';

/** The one OpenAPI document a single-portal snapshot renders to (toOpenApiSet, one spec per portal). */
function singlePortalDocument(snapshot: SurfaceSnapshot): string {
  const specs = toOpenApiSet(snapshot);
  if (specs.length !== 1) throw new Error(`expected one portal's document, got ${specs.length}`);
  return specs[0].document;
}

// ---------------------------------------------------------------------------
// Stage 2 type grammar, wave 5: the OpenAPI codec maps the whole grammar both
// ways (iopenapi_codec.toOpenApiSet / fromOpenApi). Every type is read as its
// parsed canonical expression, never by pattern, and every schema is read back
// into canonical text — so each form round-trips.
// ---------------------------------------------------------------------------

const now = '2026-10-04T00:00:00.000Z';

/** A snapshot with one REST method per type position under test, and a small closure. */
function snapshotOf(params: { name: string; type: string; optional?: boolean }[], returns = 'void', verb: 'POST' | 'GET' = 'POST'): SurfaceSnapshot {
  return {
    projectName: 'shop',
    origin: 'generated',
    generatedAt: now,
    interfaces: [{
      id: 'shop-api', name: 'Shop API', audience: 'external', type: 'REST', component: 'shop-portal',
      methods: [{
        name: 'op', description: 'one operation', signature: 'op()', returns, params,
        endpoint: { transport: 'HTTP', method: verb, path: '/op' },
      }],
    }],
    types: [
      { id: 'invoice', name: 'Invoice', kind: 'value-object', fields: [{ name: 'id', type: 'string' }] },
      { id: 'refund', name: 'Refund', kind: 'value-object', fields: [{ name: 'id', type: 'string' }] },
      {
        id: 'channel', name: 'Channel', kind: 'enum', fields: [],
        values: [{ name: 'stable', description: 'Releases only.' }, { name: 'beta' }, { name: 'dev' }],
      },
      { id: 'order_id', name: 'OrderId', kind: 'value-object', fields: [], holds: 'string' },
      { id: 'issued_on', name: 'IssuedOn', kind: 'value-object', fields: [], holds: 'date' },
    ],
  } as SurfaceSnapshot;
}

/** Params naming the scalar and enum types, so the document references them: it renders only the types it reaches. */
const NAMING_EVERY_TYPE = [{ name: 'orderId', type: 'order_id' }, { name: 'issuedOn', type: 'issued_on' }, { name: 'channel', type: 'channel' }];

const bodyProps = (doc: any): Record<string, any> => doc.paths['/op'].post.requestBody.content['application/json'].schema.properties;

/** The canonical text each form comes back as, through a request body. */
function roundTrip(type: string): string {
  const back = fromOpenApi(singlePortalDocument(snapshotOf([{ name: 'value', type }])), 'shop');
  return back.interfaces[0].methods[0].params!.find((p) => p.name === 'value')!.type;
}

describe('toOpenApiSet — every form from its parsed expression', () => {
  const schemaOf = (type: string): any => bodyProps(JSON.parse(singlePortalDocument(snapshotOf([{ name: 'value', type }])))).value;

  it('maps the primitives and their formats', () => {
    expect(schemaOf('string')).toEqual({ type: 'string' });
    expect(schemaOf('int')).toEqual({ type: 'integer' });
    expect(schemaOf('float')).toEqual({ type: 'number' });
    expect(schemaOf('bool')).toEqual({ type: 'boolean' });
    expect(schemaOf('bytes')).toEqual({ type: 'string', contentEncoding: 'base64' });
    expect(schemaOf('date')).toEqual({ type: 'string', format: 'date' });
    expect(schemaOf('datetime')).toEqual({ type: 'string', format: 'date-time' });
    expect(schemaOf('duration')).toEqual({ type: 'string', format: 'duration' });
    expect(schemaOf('any')).toEqual({});
  });

  it('maps the collections, none, unions and named types', () => {
    expect(schemaOf('list<Invoice>')).toEqual({ type: 'array', items: { $ref: '#/components/schemas/invoice' } });
    expect(schemaOf('set<string>')).toEqual({ type: 'array', uniqueItems: true, items: { type: 'string' } });
    expect(schemaOf('map<string, int>')).toEqual({ type: 'object', additionalProperties: { type: 'integer' } });
    expect(schemaOf('map<Channel, int>')).toEqual({
      type: 'object', propertyNames: { $ref: '#/components/schemas/channel' }, additionalProperties: { type: 'integer' },
    });
    expect(schemaOf('string?')).toEqual({ type: ['string', 'null'] });
    expect(schemaOf('Invoice?')).toEqual({ anyOf: [{ $ref: '#/components/schemas/invoice' }, { type: 'null' }] });
    expect(schemaOf('Invoice | Refund')).toEqual({ oneOf: [{ $ref: '#/components/schemas/invoice' }, { $ref: '#/components/schemas/refund' }] });
  });

  it('reads an alias as its canonical form, and documents a position with no canonical reading without inventing an object', () => {
    expect(schemaOf('Invoice[]')).toEqual(schemaOf('list<Invoice>'));
    expect(schemaOf('Record<string, number>')).toEqual({ type: 'object', additionalProperties: { type: 'number' } });
    expect(schemaOf('{ a: string }')).toEqual({ description: 'Not a canonical type expression: { a: string }' });
    expect(schemaOf('Missing')).toEqual({ description: 'Unresolved type: Missing' });
  });

  it('unwraps async on a returns, and an async void has no response body', () => {
    const doc = JSON.parse(singlePortalDocument(snapshotOf([], 'async list<Invoice>')));
    // Round 7: a POST that does not create (`op`, no lifecycle effect) answers 200, and a method returning nothing 204 with no content.
    expect(doc.paths['/op'].post.responses['200'].content['application/json'].schema)
      .toEqual({ type: 'array', items: { $ref: '#/components/schemas/invoice' } });
    const none = JSON.parse(singlePortalDocument(snapshotOf([], 'async void')));
    expect(none.paths['/op'].post.responses['204'].content).toBeUndefined();
    expect(none.paths['/op'].post.responses['200']).toBeUndefined();
  });

  it("renders a named scalar as its primitive's schema under the type's name", () => {
    const doc = JSON.parse(singlePortalDocument(snapshotOf(NAMING_EVERY_TYPE)));
    expect(doc.components.schemas.order_id).toEqual({ type: 'string', title: 'OrderId' });
    expect(doc.components.schemas.issued_on).toEqual({ type: 'string', format: 'date', title: 'IssuedOn' });
  });

  it('renders an enum as a string component with its values, their descriptions in its description', () => {
    const doc = JSON.parse(singlePortalDocument(snapshotOf(NAMING_EVERY_TYPE)));
    const channel = doc.components.schemas.channel;
    expect(channel).toMatchObject({ type: 'string', title: 'Channel', enum: ['stable', 'beta', 'dev'] });
    expect(channel.description).toContain('`stable`: Releases only.');
  });
});

describe('fromOpenApi — every schema read back canonical', () => {
  // A named type comes back as the component id its $ref names.
  it('round-trips each form', () => {
    for (const type of [
      'string', 'int', 'float', 'bool', 'bytes', 'date', 'datetime', 'duration', 'any',
      'list<invoice>', 'set<string>', 'map<string, list<int>>', 'map<channel, int>', 'map<int, string>',
      'string?', 'invoice?', 'invoice | refund', '(invoice | refund)?', 'list<invoice?>',
    ]) {
      expect(roundTrip(type), type).toBe(type);
    }
  });

  it('round-trips a returns', () => {
    const back = fromOpenApi(singlePortalDocument(snapshotOf([], 'async map<string, invoice>')), 'shop');
    expect(back.interfaces[0].methods[0].returns).toBe('map<string, invoice>');
  });

  it('decodes a named primitive component into a named scalar holding it', () => {
    const back = fromOpenApi(singlePortalDocument(snapshotOf(NAMING_EVERY_TYPE)), 'shop');
    expect(back.types.find((t) => t.id === 'order_id')).toEqual({ id: 'order_id', name: 'OrderId', kind: 'value-object', fields: [], holds: 'string' });
    expect(back.types.find((t) => t.id === 'issued_on')).toEqual({ id: 'issued_on', name: 'IssuedOn', kind: 'value-object', fields: [], holds: 'date' });
  });

  it('decodes a named string component carrying enum into an enum type, descriptions kept', () => {
    const back = fromOpenApi(singlePortalDocument(snapshotOf(NAMING_EVERY_TYPE)), 'shop');
    expect(back.types.find((t) => t.id === 'channel')).toEqual({
      id: 'channel', name: 'Channel', kind: 'enum', fields: [],
      values: [{ name: 'stable', description: 'Releases only.' }, { name: 'beta' }, { name: 'dev' }],
    });
  });

  it('reads a third-party document: integer, number, formats, nullable lists, and an inline enum as string with its values noted', () => {
    const doc = {
      openapi: '3.1.0', info: { title: 'third', version: '1' },
      paths: {
        '/things': {
          get: {
            operationId: 'listThings',
            parameters: [
              { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
              { name: 'order', in: 'query', description: 'Sort order.', schema: { type: 'string', enum: ['asc', 'desc'] } },
              { name: 'since', in: 'query', schema: { type: 'string', format: 'date-time' } },
            ],
            responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: ['array', 'null'], items: { type: 'number' } } } } } },
          },
        },
      },
    };
    const method = fromOpenApi(JSON.stringify(doc), 'third').interfaces[0].methods[0];
    expect(method.params).toEqual([
      { name: 'limit', type: 'int' },
      { name: 'order', type: 'string', optional: true, description: 'Sort order. One of: asc, desc.' },
      { name: 'since', type: 'datetime', optional: true },
    ]);
    expect(method.returns).toBe('list<float>?');
  });
});
