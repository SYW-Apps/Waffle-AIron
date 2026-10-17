import { describe, it, expect } from 'vitest';
import { fromOpenApi, toOpenApiSet } from '../../src/core/openapi.js';
import type { SurfaceSnapshot } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-4 trial (tinkerer): `surface export --format openapi` emitted every
// parameter of `GET /stats/{code}` as `in: query` — an OpenAPI document whose
// path template declares `{code}` with no `in: path` parameter named `code`
// is invalid, and a generated client sends `?code=` instead of `/stats/abc`.
//
// No OpenAPI meta-schema ships in this repository's dependencies, so the
// validity rule the trial hit is checked directly: every `{name}` of a path
// key has exactly one parameter `in: path` named `name`, required; and no
// `in: path` parameter names a segment the template does not have (OpenAPI
// 3.1, Path Templating + Parameter Object "required: If the parameter
// location is "path", this property is REQUIRED and its value MUST be true").
// ---------------------------------------------------------------------------

const now = '2026-10-07T00:00:00.000Z';

type Verb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function snapshotWith(methods: { name: string; verb: Verb; path: string; params: { name: string; type: string; optional?: boolean }[] }[]): SurfaceSnapshot {
  return {
    projectName: 'linkshort',
    origin: 'generated',
    generatedAt: now,
    interfaces: [{
      id: 'stats', name: 'Stats', audience: 'external', type: 'REST', component: 'stats_portal',
      methods: methods.map((m) => ({
        name: m.name, description: m.name, signature: `${m.name}()`, returns: 'string', params: m.params,
        endpoint: { transport: 'HTTP', method: m.verb, path: m.path },
      })),
    }],
    types: [],
  } as SurfaceSnapshot;
}

function documentOf(snapshot: SurfaceSnapshot): any {
  const specs = toOpenApiSet(snapshot);
  expect(specs).toHaveLength(1);
  return JSON.parse(specs[0].document);
}

/** The OpenAPI path-templating rule, applied to every operation of a document; answers the violations. */
function pathTemplateViolations(doc: any): string[] {
  const out: string[] = [];
  for (const [key, ops] of Object.entries(doc.paths as Record<string, Record<string, any>>)) {
    const templated = [...key.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [verb, op] of Object.entries(ops)) {
      const inPath = (op.parameters ?? []).filter((p: any) => p.in === 'path');
      for (const name of templated) {
        const declared = inPath.filter((p: any) => p.name === name);
        if (declared.length !== 1) out.push(`${verb} ${key}: {${name}} has ${declared.length} in: path parameter(s)`);
        else if (declared[0].required !== true) out.push(`${verb} ${key}: path parameter ${name} is not required: true`);
      }
      for (const p of inPath) if (!templated.includes(p.name)) out.push(`${verb} ${key}: in: path parameter ${p.name} names no template segment`);
    }
  }
  return out;
}

describe('toOpenApiSet — path parameters (round-4 trial)', () => {
  it('declares a templated segment of a GET as in: path, required — the rest stay in the query', () => {
    const doc = documentOf(snapshotWith([
      { name: 'getStats', verb: 'GET', path: '/stats/{code}', params: [{ name: 'code', type: 'string' }, { name: 'since', type: 'datetime', optional: true }] },
    ]));
    const params = doc.paths['/stats/{code}'].get.parameters;
    expect(params).toEqual([
      { name: 'code', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'since', in: 'query', required: false, schema: { type: 'string', format: 'date-time' } },
    ]);
    expect(pathTemplateViolations(doc)).toEqual([]);
  });

  it('takes a path parameter out of the request body of a POST/PUT/PATCH, and a DELETE carries its own', () => {
    const doc = documentOf(snapshotWith([
      { name: 'renameLink', verb: 'PUT', path: '/links/{code}', params: [{ name: 'code', type: 'string' }, { name: 'url', type: 'string' }] },
      { name: 'deleteLink', verb: 'DELETE', path: '/links/{code}', params: [{ name: 'code', type: 'string' }] },
      { name: 'addHit', verb: 'POST', path: '/links/{code}/hits/{day}', params: [{ name: 'code', type: 'string' }, { name: 'day', type: 'date' }, { name: 'count', type: 'int' }] },
    ]));
    const put = doc.paths['/links/{code}'].put;
    expect(put.parameters).toEqual([{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }]);
    expect(Object.keys(put.requestBody.content['application/json'].schema.properties)).toEqual(['url']);
    expect(doc.paths['/links/{code}'].delete.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(['path:code']);
    const post = doc.paths['/links/{code}/hits/{day}'].post;
    expect(post.parameters.map((p: any) => `${p.in}:${p.name}`)).toEqual(['path:code', 'path:day']);
    expect(Object.keys(post.requestBody.content['application/json'].schema.properties)).toEqual(['count']);
    expect(pathTemplateViolations(doc)).toEqual([]);
  });

  it('an optional param named by the template is still required (the path cannot be built without it)', () => {
    const doc = documentOf(snapshotWith([
      { name: 'getStats', verb: 'GET', path: '/stats/{code}', params: [{ name: 'code', type: 'string', optional: true }] },
    ]));
    expect(doc.paths['/stats/{code}'].get.parameters[0]).toMatchObject({ in: 'path', required: true });
  });

  it('round-trips: a path parameter reads back as the method param it was', () => {
    const snapshot = snapshotWith([
      { name: 'getStats', verb: 'GET', path: '/stats/{code}', params: [{ name: 'code', type: 'string' }, { name: 'limit', type: 'int', optional: true }] },
    ]);
    const back = fromOpenApi(toOpenApiSet(snapshot)[0].document, 'linkshort');
    const method = back.interfaces[0].methods[0];
    expect(method.params).toEqual([{ name: 'code', type: 'string' }, { name: 'limit', type: 'int', optional: true }]);
    expect(method.endpoint).toMatchObject({ transport: 'HTTP', method: 'GET', path: '/stats/{code}' });
  });
});
