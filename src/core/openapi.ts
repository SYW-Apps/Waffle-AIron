import * as yaml from 'js-yaml';
import {
  MethodSignature,
  NamedOpenApiSpec,
  PortalAuth,
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
  // Opaque pack/tool extension data — emitted verbatim so the OpenAPI form
  // round-trips everything the native YAML snapshot preserves.
  if (method.ext && Object.keys(method.ext).length) op['x-wairon-ext'] = method.ext;

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

// ── Security: a Portal's auth → OpenAPI securitySchemes/security ─────────────

/** Map a Portal's auth to an OpenAPI securityScheme object (null for 'none'). */
function securitySchemeObject(auth: PortalAuth): Record<string, unknown> | null {
  if (auth.scheme === 'none') return null;
  const desc = auth.description ? { description: auth.description } : {};
  switch (auth.scheme) {
    case 'apiKey':
      return { type: 'apiKey', in: auth.in ?? 'header', name: auth.name ?? 'X-API-Key', ...desc };
    case 'bearer':
      return { type: 'http', scheme: 'bearer', ...(auth.bearerFormat ? { bearerFormat: auth.bearerFormat } : {}), ...desc };
    case 'basic':
      return { type: 'http', scheme: 'basic', ...desc };
    case 'oauth2': {
      const flow: Record<string, unknown> = { scopes: Object.fromEntries((auth.scopes ?? []).map(s => [s.name, s.description])) };
      if (auth.authorizationUrl) flow.authorizationUrl = auth.authorizationUrl;
      if (auth.tokenUrl) flow.tokenUrl = auth.tokenUrl;
      if (auth.refreshUrl) flow.refreshUrl = auth.refreshUrl;
      return { type: 'oauth2', flows: { [auth.flow ?? 'authorizationCode']: flow }, ...desc };
    }
    case 'openIdConnect':
      return { type: 'openIdConnect', openIdConnectUrl: auth.openIdConnectUrl ?? '', ...desc };
    case 'custom':
      return { type: 'apiKey', in: auth.in ?? 'header', name: auth.name ?? 'Authorization', description: auth.description ?? auth.example ?? 'Custom authentication scheme.' };
    default:
      return null;
  }
}

function schemeBaseName(scheme: string): string {
  return ({ apiKey: 'ApiKeyAuth', bearer: 'BearerAuth', basic: 'BasicAuth', oauth2: 'OAuth2', openIdConnect: 'OpenIdConnect', custom: 'CustomAuth' } as Record<string, string>)[scheme] ?? 'Auth';
}

/** securitySchemes for a set of entries (deduping identical schemes by content) +
 *  the per-entry `security` requirement (scheme name → scope names) to attach. */
function buildSecurity(entries: SurfaceContractEntry[]): {
  schemes: Record<string, unknown>;
  securityByEntry: Map<string, Record<string, string[]>>;
} {
  const schemes: Record<string, unknown> = {};
  const nameByContent = new Map<string, string>();
  const securityByEntry = new Map<string, Record<string, string[]>>();
  for (const entry of entries) {
    if (!entry.auth) continue;
    const obj = securitySchemeObject(entry.auth);
    if (!obj) continue;
    const content = JSON.stringify(obj);
    let name = nameByContent.get(content);
    if (!name) {
      name = schemeBaseName(entry.auth.scheme);
      for (let n = 2; schemes[name]; n++) name = schemeBaseName(entry.auth.scheme) + n;
      schemes[name] = obj;
      nameByContent.set(content, name);
    }
    const scopeNames = entry.auth.scheme === 'oauth2' ? (entry.auth.scopes ?? []).map(s => s.name) : [];
    securityByEntry.set(entry.id, { [name]: scopeNames });
  }
  return { schemes, securityByEntry };
}

function httpEntriesOf(snapshot: SurfaceSnapshot): SurfaceContractEntry[] {
  return snapshot.interfaces.filter(e =>
    e.type === 'REST' || e.methods.some(m => m.endpoint?.transport === 'HTTP'));
}

/** Render ONE OpenAPI document from a chosen subset of entries — all of them for
 *  toOpenApi, one portal's for toOpenApiSet (the latter also emits `servers`). */
function renderDoc(
  snapshot: SurfaceSnapshot,
  entries: SurfaceContractEntry[],
  closureIds: Set<string>,
  opts: { title?: string; servers?: boolean } = {},
): Record<string, unknown> {
  const { schemes, securityByEntry } = buildSecurity(entries);

  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const security = securityByEntry.get(entry.id);
    for (const method of entry.methods) {
      const endpoint = method.endpoint;
      if (!endpoint || endpoint.transport !== 'HTTP') continue;
      const p = endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`;
      paths[p] = paths[p] ?? {};
      paths[p][endpoint.method.toLowerCase()] = {
        tags: [entry.id],
        ...operationFor(method, closureIds),
        ...(security ? { security: [security] } : {}),
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

  const components: Record<string, unknown> = {};
  if (Object.keys(schemas).length) components.schemas = schemas;
  if (Object.keys(schemes).length) components.securitySchemes = schemes;

  // Per-portal specs carry a single `servers` entry from the portal's basePath.
  const basePaths = [...new Set(entries.map(e => e.basePath).filter((b): b is string => !!b))];
  const servers = opts.servers && basePaths.length === 1 ? [{ url: basePaths[0] }] : undefined;

  return {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? snapshot.projectName,
      version: snapshot.version ?? '0.0.0',
      ...(snapshot.stateId ? { 'x-wairon-state-id': snapshot.stateId } : {}),
      'x-wairon-origin': snapshot.origin,
      'x-wairon-generated-at': snapshot.generatedAt,
    },
    ...(servers ? { servers } : {}),
    paths,
    ...(Object.keys(components).length ? { components } : {}),
  };
}

export function toOpenApi(snapshot: SurfaceSnapshot): string {
  const closureIds = new Set(snapshot.types.map(t => t.id));
  return JSON.stringify(renderDoc(snapshot, httpEntriesOf(snapshot), closureIds), null, 2);
}

/**
 * One named OpenAPI document PER PUBLIC PORTAL, partitioned by the backing portal
 * component. A project that models a single gateway portal yields one spec; three
 * separate portals yield three — never merged. Each carries its own `servers`
 * (from the portal's basePath) and its own securitySchemes/security.
 */
export function toOpenApiSet(snapshot: SurfaceSnapshot): NamedOpenApiSpec[] {
  const closureIds = new Set(snapshot.types.map(t => t.id));
  const byPortal = new Map<string, SurfaceContractEntry[]>();
  const order: string[] = [];
  for (const entry of httpEntriesOf(snapshot)) {
    if (!byPortal.has(entry.component)) { byPortal.set(entry.component, []); order.push(entry.component); }
    byPortal.get(entry.component)!.push(entry);
  }
  return order.map(portalId => {
    const entries = byPortal.get(portalId)!;
    const name = entries[0]?.name ?? portalId;
    return { portalId, name, document: JSON.stringify(renderDoc(snapshot, entries, closureIds, { title: name, servers: true }), null, 2) };
  });
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

/** Reconstruct a PortalAuth from an OpenAPI securityScheme (round-trips toOpenApi). */
function authFromSecurityScheme(scheme: Record<string, unknown>): PortalAuth | undefined {
  const desc = typeof scheme.description === 'string' ? { description: scheme.description } : {};
  if (scheme.type === 'apiKey') {
    return {
      scheme: 'apiKey',
      ...(scheme.in === 'header' || scheme.in === 'query' || scheme.in === 'cookie' ? { in: scheme.in } : {}),
      ...(typeof scheme.name === 'string' ? { name: scheme.name } : {}),
      ...desc,
    };
  }
  if (scheme.type === 'http') {
    if (scheme.scheme === 'bearer') return { scheme: 'bearer', ...(typeof scheme.bearerFormat === 'string' ? { bearerFormat: scheme.bearerFormat } : {}), ...desc };
    if (scheme.scheme === 'basic') return { scheme: 'basic', ...desc };
  }
  if (scheme.type === 'oauth2') {
    const flows = (scheme.flows ?? {}) as Record<string, Record<string, unknown>>;
    const flowKey = Object.keys(flows)[0];
    const f = flows[flowKey] ?? {};
    return {
      scheme: 'oauth2',
      ...(flowKey === 'authorizationCode' || flowKey === 'clientCredentials' || flowKey === 'implicit' || flowKey === 'password' ? { flow: flowKey } : {}),
      ...(typeof f.authorizationUrl === 'string' ? { authorizationUrl: f.authorizationUrl } : {}),
      ...(typeof f.tokenUrl === 'string' ? { tokenUrl: f.tokenUrl } : {}),
      ...(typeof f.refreshUrl === 'string' ? { refreshUrl: f.refreshUrl } : {}),
      scopes: Object.entries((f.scopes ?? {}) as Record<string, string>).map(([name, description]) => ({ name, description })),
      ...desc,
    };
  }
  if (scheme.type === 'openIdConnect') {
    return { scheme: 'openIdConnect', openIdConnectUrl: typeof scheme.openIdConnectUrl === 'string' ? scheme.openIdConnectUrl : '', ...desc };
  }
  return undefined;
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

      // Read back the x-wairon-* keys toOpenApi emits, so an OpenAPI-format
      // exchange preserves the same contract the native YAML snapshot does.
      // All three are optional: documents from other producers simply lack
      // them, and a malformed value is ignored rather than failing the import.
      const rawGuarantees = op['x-wairon-guarantees'];
      const guarantees = Array.isArray(rawGuarantees)
        ? rawGuarantees.filter((g): g is string => typeof g === 'string' && g.length > 0)
        : [];
      const rawEffect = op['x-wairon-effect'];
      const effect = rawEffect === 'read' || rawEffect === 'write' ? rawEffect : undefined;
      // Opaque by doctrine — preserved verbatim, never validated beyond "is a map".
      const rawExt = op['x-wairon-ext'];
      const ext = rawExt && typeof rawExt === 'object' && !Array.isArray(rawExt)
        ? (rawExt as Record<string, unknown>)
        : undefined;

      methods.push({
        name,
        description: typeof op.summary === 'string' ? op.summary : (typeof op.description === 'string' ? op.description : name),
        signature: `${name}(${params.map(p => `${p.name}: ${p.type}`).join(', ')}): ${returns}`,
        returns,
        params,
        endpoint: { transport: 'HTTP', method: verb.toUpperCase() as 'GET', path: rawPath },
        ...(guarantees.length ? { guarantees } : {}),
        ...(effect ? { effect } : {}),
        ...(ext ? { ext } : {}),
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

  // Read the first securityScheme back into the entry's auth (round-trips toOpenApi).
  const securitySchemes = ((parsed.components as Record<string, unknown>)?.securitySchemes ?? {}) as Record<string, Record<string, unknown>>;
  const firstScheme = Object.values(securitySchemes)[0];
  const importedAuth = firstScheme ? authFromSecurityScheme(firstScheme) : undefined;

  const entry: SurfaceContractEntry = {
    id: `${projectName}-api`,
    name: typeof info.title === 'string' ? info.title : projectName,
    audience: 'external',
    type: 'REST',
    component: `${projectName}-api`,
    methods,
    details: typeof info.description === 'string' ? info.description : `Imported OpenAPI surface of ${projectName}.`,
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
    ...(importedAuth ? { auth: importedAuth } : {}),
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
