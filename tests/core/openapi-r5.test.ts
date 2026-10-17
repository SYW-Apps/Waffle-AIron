import { describe, expect, it } from 'vitest';
import { credentialParam, fromOpenApi, openApiPath, toOpenApiSet } from '../../src/core/openapi.js';
import type { SurfaceSnapshot } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-5 trials (solo-app top-2, lib-and-app R5-22): the OpenAPI document of
// a bearer Portal demanded the token twice (security scheme AND a required
// query/body parameter); Express-style `:id` placeholders and the Portal's
// basePath were left out of the paths; a pinned external type rendered as
// "Unresolved type: geo::coordinate"; info.version was always 0.0.0.
// ---------------------------------------------------------------------------

const now = '2026-10-07T00:00:00.000Z';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function habitsSnapshot(over: Record<string, any> = {}): SurfaceSnapshot {
  return {
    projectName: 'habitly', origin: 'generated', generatedAt: now,
    interfaces: [{
      id: 'habit_portal', name: 'Habits API', audience: 'project', type: 'REST', component: 'habit_portal',
      basePath: '/v1', auth: { scheme: 'bearer' },
      methods: [
        { name: 'getHabit', description: 'Read one habit.', signature: 'getHabit()', returns: 'habit',
          params: [{ name: 'bearerToken', type: 'string' }, { name: 'habitId', type: 'string' }],
          endpoint: { transport: 'HTTP', method: 'GET', path: '/habits/:habitId' } },
        { name: 'checkIn', description: 'Record a check-in.', signature: 'checkIn()', returns: 'void',
          params: [{ name: 'token', type: 'string' }, { name: 'habitId', type: 'string' }, { name: 'date', type: 'date' }, { name: 'note', type: 'string', optional: true }],
          endpoint: { transport: 'HTTP', method: 'PUT', path: '/habits/:habitId/check-ins/:date' } },
      ],
      ...over,
    }],
    types: [{ id: 'habit', name: 'Habit', kind: 'value-object', fields: [{ name: 'title', type: 'string' }, { name: 'where', type: 'geo::coordinate' }] }],
  } as unknown as SurfaceSnapshot;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc = (snapshot: SurfaceSnapshot, context = {}): any => JSON.parse(toOpenApiSet(snapshot, context)[0].document);

describe('6a — the credential the security scheme binds is never a parameter too', () => {
  it('bearer: the token param is in neither the query nor the body, and is named for a wairon reader', () => {
    const d = doc(habitsSnapshot());
    const get = d.paths['/v1/habits/{habitId}'].get;
    expect(get.security).toEqual([{ BearerAuth: [] }]);
    expect(get.parameters.map((p: { name: string; in: string }) => `${p.name}:${p.in}`)).toEqual(['habitId:path']);
    expect(get['x-wairon-credential-param']).toBe('bearerToken');
    const put = d.paths['/v1/habits/{habitId}/check-ins/{date}'].put;
    expect(Object.keys(put.requestBody.content['application/json'].schema.properties)).toEqual(['note']);
    expect(put.parameters.map((p: { name: string }) => p.name)).not.toContain('token');
  });

  it('the rule by scheme: an apiKey param matching the key name, basic credentials; never a non-string or without auth', () => {
    const m = (name: string, type = 'string') => ({ name: 'x', description: 'x', signature: 'x()', returns: 'void', params: [{ name, type }] });
    expect(credentialParam(m('apiKey') as never, { scheme: 'apiKey', in: 'header', name: 'X-API-Key' })).toBe('apiKey');
    expect(credentialParam(m('credentials') as never, { scheme: 'basic' })).toBe('credentials');
    expect(credentialParam(m('token', 'int') as never, { scheme: 'bearer' })).toBeUndefined();
    expect(credentialParam(m('token') as never, undefined)).toBeUndefined();
    expect(credentialParam(m('title') as never, { scheme: 'bearer' })).toBeUndefined();
  });

  it('round trip: an import puts the credential param back on the contract', () => {
    const imported = fromOpenApi(toOpenApiSet(habitsSnapshot())[0].document, 'habitly');
    const get = imported.interfaces[0].methods.find((m) => m.name === 'getHabit')!;
    expect(get.params?.map((p) => p.name)).toEqual(['bearerToken', 'habitId']);
    expect(get.endpoint).toMatchObject({ path: '/habits/{habitId}' });
    expect(imported.interfaces[0].basePath).toBe('/v1');
  });
});

describe('6b — `:name` is a placeholder, and the basePath is part of every path', () => {
  it('openApiPath joins the basePath and respells `:name` as `{name}`', () => {
    expect(openApiPath('/v1', '/habits/:habitId/check-ins/:date')).toBe('/v1/habits/{habitId}/check-ins/{date}');
    expect(openApiPath('/v1/', 'habits/{id}')).toBe('/v1/habits/{id}');
    expect(openApiPath(undefined, '/routes/:id')).toBe('/routes/{id}');
    expect(openApiPath('/', '/x')).toBe('/x');
  });

  it('`:habitId` and `:date` are path parameters, never body properties', () => {
    const put = doc(habitsSnapshot()).paths['/v1/habits/{habitId}/check-ins/{date}'].put;
    expect(put.parameters.map((p: { name: string; in: string; required: boolean }) => `${p.name}:${p.in}:${p.required}`)).toEqual(['habitId:path:true', 'date:path:true']);
  });
});

describe('6c/6e — pinned external types resolve from the pin; info.version from the project', () => {
  const geo = {
    projectName: 'geo', origin: 'generated', generatedAt: now, interfaces: [],
    types: [
      { id: 'coordinate', name: 'Coordinate', kind: 'value-object', fields: [{ name: 'latitude', type: 'latitude' }, { name: 'longitude', type: 'float' }] },
      { id: 'latitude', name: 'Latitude', kind: 'value-object', fields: [], holds: 'float' },
    ],
  } as unknown as SurfaceSnapshot;

  it('a field typed geo::coordinate references the pinned definition, and the types it names in turn', () => {
    const d = doc(habitsSnapshot(), { externals: new Map([['geo', geo]]) });
    expect(d.components.schemas.habit.properties.where).toEqual({ $ref: '#/components/schemas/geo.coordinate' });
    expect(d.components.schemas['geo.coordinate'].properties.latitude).toEqual({ $ref: '#/components/schemas/geo.latitude' });
    expect(d.components.schemas['geo.latitude']).toMatchObject({ type: 'number', title: 'Latitude' });
    expect(JSON.stringify(d)).not.toContain('Unresolved type');
  });

  it('control: without the pin it is still named unresolved, never invented', () => {
    expect(doc(habitsSnapshot()).components.schemas.habit.properties.where).toEqual({ description: 'Unresolved type: geo::coordinate' });
  });

  it('info.version is the declared version, else the snapshot\'s, else 0.0.0', () => {
    expect(doc(habitsSnapshot(), { version: '0.1.0' }).info.version).toBe('0.1.0');
    expect(doc(habitsSnapshot()).info.version).toBe('0.0.0');
  });
});
