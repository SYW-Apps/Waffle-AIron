import * as yaml from 'js-yaml';
import {
  MethodSignature,
  SurfaceContractEntry,
  SurfaceSnapshot,
  SurfaceSnapshotSchema,
  SurfaceTypeDef,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// OpenAPI 3.1 codec (openapi_codec) — the first surface-exchange format.
// Export: a snapshot's HTTP-transport entries become an OpenAPI document,
// the embedded type closure becomes JSON-Schema components. Import: a
// 3rd-party OpenAPI document becomes an authored-origin snapshot, so a
// bespoke external API is validated like any declared surface instead of
// being trusted as prose.
// ---------------------------------------------------------------------------

const PRIMITIVES: Record<string, { type: string; format?: string }> = {
  string: { type: 'string' },
  number: { type: 'number' },
  float: { type: 'number' },
  decimal: { type: 'number' },
  int: { type: 'integer' },
  integer: { type: 'integer' },
  boolean: { type: 'boolean' },
  bool: { type: 'boolean' },
  date: { type: 'string', format: 'date-time' },
  datetime: { type: 'string', format: 'date-time' },
  uuid: { type: 'string', format: 'uuid' },
  json: { type: 'object' },
  object: { type: 'object' },
  any: {} as { type: string },
  unknown: {} as { type: string },
  void: {} as { type: string },
};

/** Map a wairon type ref to a JSON-Schema fragment ($ref into components for closure types). */
function schemaFor(typeRef: string, closureIds: Set<string>): Record<string, unknown> {
  const trimmed = typeRef.trim().replace(/^promise\s*<(.+)>$/i, '$1').trim();
  const arrayMatch = /^(.+)\[\]$/.exec(trimmed);
  if (arrayMatch) {
    return { type: 'array', items: schemaFor(arrayMatch[1], closureIds) };
  }
  const lower = trimmed.toLowerCase();
  if (lower in PRIMITIVES) {
    const p = PRIMITIVES[lower];
    return p.type ? { ...p } : {};
  }
  // Closure types match by local segment (billing.Invoice / billing::invoice → invoice).
  const local = trimmed.split(/::|\./).pop()!.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const hit = [...closureIds].find(id => id.toLowerCase() === local);
  if (hit) return { $ref: `#/components/schemas/${hit}` };
  return { type: 'object', description: `Unresolved type: ${trimmed}` };
}

function operationFor(method: MethodSignature, closureIds: Set<string>): Record<string, unknown> {
  const endpoint = method.endpoint;
  const httpVerb = endpoint && endpoint.transport === 'HTTP' ? endpoint.method.toLowerCase() : 'post';
  const bodyVerbs = new Set(['post', 'put', 'patch']);
  const params = method.params ?? [];

  const op: Record<string, unknown> = {
    operationId: method.name,
    summary: method.description,
    responses: {
      '200': {
        description: method.returns || 'Success',
        ...(method.returns && method.returns.toLowerCase() !== 'void'
          ? { content: { 'application/json': { schema: schemaFor(method.returns, closureIds) } } }
          : {}),
      },
    },
  };
  if (method.guarantees?.length) op['x-wairon-guarantees'] = method.guarantees;
  if (method.effect) op['x-wairon-effect'] = method.effect;

  if (params.length) {
    if (bodyVerbs.has(httpVerb)) {
      op.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: Object.fromEntries(params.map(p => [p.name, schemaFor(p.type, closureIds)])),
              required: params.filter(p => !p.optional).map(p => p.name),
            },
          },
        },
      };
    } else {
      op.parameters = params.map(p => ({
        name: p.name,
        in: 'query',
        required: !p.optional,
        ...(p.description ? { description: p.description } : {}),
        schema: schemaFor(p.type, closureIds),
      }));
    }
  }
  return op;
}

export function toOpenApi(snapshot: SurfaceSnapshot): string {
  const closureIds = new Set(snapshot.types.map(t => t.id));
  const httpEntries = snapshot.interfaces.filter(e =>
    e.type === 'REST' || e.methods.some(m => m.endpoint?.transport === 'HTTP'));

  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of httpEntries) {
    for (const method of entry.methods) {
      const endpoint = method.endpoint;
      if (!endpoint || endpoint.transport !== 'HTTP') continue;
      const p = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`;
      paths[p] = paths[p] ?? {};
      paths[p][endpoint.method.toLowerCase()] = {
        tags: [entry.id],
        ...operationFor(method, closureIds),
      };
    }
  }

  const schemas: Record<string, unknown> = {};
  for (const t of snapshot.types) {
    schemas[t.id] = {
      type: 'object',
      title: t.name,
      properties: Object.fromEntries(t.fields.map(f => [f.name, schemaFor(f.type, closureIds)])),
      required: t.fields.filter(f => !f.optional).map(f => f.name),
    };
  }

  const doc = {
    openapi: '3.1.0',
    info: {
      title: snapshot.projectName,
      version: snapshot.version ?? '0.0.0',
      ...(snapshot.stateId ? { 'x-wairon-state-id': snapshot.stateId } : {}),
      'x-wairon-origin': snapshot.origin,
      'x-wairon-generated-at': snapshot.generatedAt,
    },
    paths,
    ...(Object.keys(schemas).length ? { components: { schemas } } : {}),
  };
  return JSON.stringify(doc, null, 2);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export function isOpenApiDocument(body: string): boolean {
  try {
    const parsed = yaml.load(body) as Record<string, unknown> | null;
    return !!parsed && typeof parsed === 'object' && typeof (parsed as { openapi?: unknown }).openapi === 'string';
  } catch {
    return false;
  }
}

function typeRefFromSchema(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'json';
  const ref = schema.$ref;
  if (typeof ref === 'string') return ref.split('/').pop() ?? 'json';
  if (schema.type === 'array') {
    return `${typeRefFromSchema(schema.items as Record<string, unknown>)}[]`;
  }
  const t = schema.type;
  if (t === 'integer') return 'int';
  if (typeof t === 'string' && t !== 'object') return t;
  return 'json';
}

export function fromOpenApi(document: string, projectName: string): SurfaceSnapshot {
  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(document) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Invalid surface document: not parseable as JSON/YAML (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.openapi !== 'string' || typeof parsed.paths !== 'object') {
    throw new Error('Invalid surface document: missing OpenAPI "openapi"/"paths" structure.');
  }

  const info = (parsed.info ?? {}) as Record<string, unknown>;
  const methods: MethodSignature[] = [];
  for (const [rawPath, ops] of Object.entries(parsed.paths as Record<string, Record<string, unknown>>)) {
    for (const [verb, opRaw] of Object.entries(ops ?? {})) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(verb)) continue;
      const op = (opRaw ?? {}) as Record<string, unknown>;
      const name = typeof op.operationId === 'string' && /^[a-zA-Z0-9_]+$/.test(op.operationId)
        ? op.operationId
        : `${verb}_${rawPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;

      const params: { name: string; type: string; optional?: boolean; description?: string }[] = [];
      for (const p of (op.parameters as Record<string, unknown>[] | undefined) ?? []) {
        if (typeof p.name !== 'string') continue;
        params.push({
          name: p.name,
          type: typeRefFromSchema(p.schema as Record<string, unknown>),
          ...(p.required === true ? {} : { optional: true }),
          ...(typeof p.description === 'string' ? { description: p.description } : {}),
        });
      }
      const bodySchema = ((op.requestBody as Record<string, unknown>)?.content as Record<string, Record<string, unknown>>)?.['application/json']?.schema as Record<string, unknown> | undefined;
      if (bodySchema) {
        const props = (bodySchema.properties ?? {}) as Record<string, Record<string, unknown>>;
        const required = new Set((bodySchema.required as string[] | undefined) ?? []);
        if (Object.keys(props).length) {
          for (const [pname, pschema] of Object.entries(props)) {
            params.push({ name: pname, type: typeRefFromSchema(pschema), ...(required.has(pname) ? {} : { optional: true }) });
          }
        } else {
          params.push({ name: 'body', type: typeRefFromSchema(bodySchema) });
        }
      }

      const okResponse = ((op.responses as Record<string, Record<string, unknown>>)?.['200']
        ?? (op.responses as Record<string, Record<string, unknown>>)?.['201']) as Record<string, unknown> | undefined;
      const responseSchema = ((okResponse?.content as Record<string, Record<string, unknown>>)?.['application/json']?.schema) as Record<string, unknown> | undefined;
      const returns = responseSchema ? typeRefFromSchema(responseSchema) : 'void';

      methods.push({
        name,
        description: typeof op.summary === 'string' ? op.summary : (typeof op.description === 'string' ? op.description : name),
        signature: `${name}(${params.map(p => `${p.name}: ${p.type}`).join(', ')}): ${returns}`,
        returns,
        params,
        endpoint: { transport: 'HTTP', method: verb.toUpperCase() as 'GET', path: rawPath },
      });
    }
  }

  const types: SurfaceTypeDef[] = [];
  const schemas = ((parsed.components as Record<string, unknown>)?.schemas ?? {}) as Record<string, Record<string, unknown>>;
  for (const [id, schema] of Object.entries(schemas)) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set((schema.required as string[] | undefined) ?? []);
    types.push({
      id,
      name: typeof schema.title === 'string' ? schema.title : id,
      kind: 'value-object',
      fields: Object.entries(props).map(([fname, fschema]) => ({
        name: fname,
        type: typeRefFromSchema(fschema),
        ...(required.has(fname) ? {} : { optional: true }),
      })),
    });
  }

  const entry: SurfaceContractEntry = {
    id: `${projectName}-api`,
    name: typeof info.title === 'string' ? info.title : projectName,
    audience: 'external',
    type: 'REST',
    component: `${projectName}-api`,
    methods,
    details: typeof info.description === 'string' ? info.description : `Imported OpenAPI surface of ${projectName}.`,
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
  };

  return SurfaceSnapshotSchema.parse({
    projectName,
    origin: 'authored',
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
    generatedAt: new Date().toISOString(),
    interfaces: [entry],
    types,
  });
}
