import * as yaml from 'js-yaml';
import {
  EnumValue,
  MethodSignature,
  NamedOpenApiSpec,
  PortalAuth,
  SurfaceContractEntry,
  SurfaceSnapshot,
  SurfaceSnapshotSchema,
  SurfaceTypeDef,
  TypeExpression,
  parseTypeExpression,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// OpenAPI 3.1 codec (openapi_codec) — the first surface-exchange format.
// Export: a snapshot's HTTP-transport entries become an OpenAPI document,
// the embedded type closure becomes JSON-Schema components. Import: a
// 3rd-party OpenAPI document becomes an authored-origin snapshot, so a
// bespoke external API is validated like any declared surface instead of
// being trusted as prose.
// ---------------------------------------------------------------------------

/** Each primitive's JSON-Schema fragment: bytes base64, date/datetime/duration their string formats. */
const PRIMITIVE_SCHEMAS: Record<string, Record<string, unknown>> = {
  string: { type: 'string' },
  int: { type: 'integer' },
  float: { type: 'number' },
  bool: { type: 'boolean' },
  bytes: { type: 'string', contentEncoding: 'base64' },
  date: { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  duration: { type: 'string', format: 'duration' },
  any: {},
  void: {},
};

/** A type position read under the grammar (as a returns may stand, so `async` and `void` read too); null when it has no reading. */
function expressionOf(typeRef: string): TypeExpression | null {
  return parseTypeExpression(typeRef.trim(), 'returns').expression;
}

/** The type id a named reference names in one set of ids, matched by local segment (billing.Invoice / billing::invoice → invoice). */
function idHit(name: string, ids: Iterable<string>): string | undefined {
  const local = name.split(/::|\./).pop()!.toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return [...ids].find(id => id.toLowerCase() === local);
}

/**
 * Where a document's named type references resolve: the snapshot's own type
 * closure, and the pinned snapshot of each external the project declares
 * (`alias::name`), whose types are rendered under `<alias>.<id>`. A scope
 * bound to an alias resolves bare names inside that producer's own closure —
 * the names its types use for each other. Every external type a reference
 * reaches is recorded, so the document renders it as a component.
 */
interface SchemaScope {
  /** The component name a reference resolves to, or undefined. */
  componentOf(name: string): string | undefined;
  /** The scope inside one external's closure. */
  within(alias: string): SchemaScope;
}

/** An external type a document reached: its alias and definition, rendered as `<alias>.<id>`. */
interface ReachedExternal {
  alias: string;
  def: SurfaceTypeDef;
}

/** The scope of a document over its own closure and the pinned externals; `reached` collects the external types it names. */
function schemaScope(ownIds: Set<string>, externals: ReadonlyMap<string, SurfaceSnapshot>, reached: Map<string, ReachedExternal>, alias?: string): SchemaScope {
  const external = (from: string, name: string): string | undefined => {
    const pinned = externals.get(from);
    const id = pinned ? idHit(name, pinned.types.map(t => t.id)) : undefined;
    if (!pinned || id === undefined) return undefined;
    const key = `${from}.${id}`;
    if (!reached.has(key)) reached.set(key, { alias: from, def: pinned.types.find(t => t.id === id)! });
    return key;
  };
  return {
    componentOf(name: string): string | undefined {
      // `alias::name` names another project's export: its pinned snapshot, never an own type of the same last segment.
      const sep = name.indexOf('::');
      if (sep > 0 && externals.has(name.slice(0, sep))) return external(name.slice(0, sep), name.slice(sep + 2));
      if (alias !== undefined) return external(alias, name);
      return idHit(name, ownIds);
    },
    within(next: string): SchemaScope {
      return schemaScope(ownIds, externals, reached, next);
    },
  };
}

/** The schema of one canonical expression. */
function schemaOfExpression(expr: TypeExpression, scope: SchemaScope): Record<string, unknown> {
  switch (expr.form) {
    case 'primitive':
      return { ...(PRIMITIVE_SCHEMAS[expr.name ?? ''] ?? {}) };
    case 'named':
    case 'applied': {
      // An applied generic (Page<T>) is documented as its head: JSON Schema has no type parameters.
      const hit = scope.componentOf(expr.name ?? '');
      return hit ? { $ref: `#/components/schemas/${hit}` } : { description: `Unresolved type: ${expr.name}` };
    }
    case 'list':
      return { type: 'array', items: schemaOfExpression(expr.args[0], scope) };
    case 'set':
      return { type: 'array', uniqueItems: true, items: schemaOfExpression(expr.args[0], scope) };
    case 'map': {
      const key = expr.args[0];
      // A key is string, int or an enum: an enum key names its component, an int key its digits.
      const keyHit = key.form === 'named' ? scope.componentOf(key.name ?? '') : undefined;
      const propertyNames = keyHit
        ? { propertyNames: { $ref: `#/components/schemas/${keyHit}` } }
        : key.form === 'primitive' && key.name === 'int' ? { propertyNames: { pattern: '^-?[0-9]+$' } } : {};
      return { type: 'object', ...propertyNames, additionalProperties: schemaOfExpression(expr.args[1], scope) };
    }
    case 'optional': {
      const inner = schemaOfExpression(expr.args[0], scope);
      if (Object.keys(inner).length === 0) return inner;
      // A plain typed schema admits null beside its type; a $ref or a oneOf is wrapped.
      if (typeof inner.type === 'string') return { ...inner, type: [inner.type, 'null'] };
      return { anyOf: [inner, { type: 'null' }] };
    }
    case 'union':
      return { oneOf: expr.args.map(member => schemaOfExpression(member, scope)) };
    case 'async':
      return schemaOfExpression(expr.args[0], scope);
    case 'result':
      // The success body; a failure is the operation's error response, not part of it.
      return schemaOfExpression(expr.args[0], scope);
  }
}

/**
 * Map a wairon type position to a JSON-Schema fragment, from its parsed
 * canonical expression — never by pattern. A position that is not canonical
 * is documented as unconstrained, with a description naming it; it never
 * becomes an invented object.
 */
function schemaFor(typeRef: string, scope: SchemaScope): Record<string, unknown> {
  const expr = expressionOf(typeRef);
  if (!expr) return { description: `Not a canonical type expression: ${typeRef.trim()}` };
  return schemaOfExpression(expr, scope);
}

/** Whether a returns completes with no value: `void`, `async void`, or a result whose success type is void. */
function returnsNothing(returns: string): boolean {
  const expr = expressionOf(returns);
  const awaited = expr?.form === 'async' ? expr.args[0] : expr;
  const inner = awaited?.form === 'result' ? awaited.args[0] : awaited;
  return inner?.form === 'primitive' && inner.name === 'void';
}

/** The description an enum component carries: one line per value, its description beside it. */
function enumDescription(values: EnumValue[]): string {
  return ['Values:', ...values.map(v => `- \`${v.name}\`${v.description ? `: ${v.description}` : ''}`)].join('\n');
}

/** An enum component's values read back: the names from `enum`, each description from the lines enumDescription writes. */
function enumValuesFrom(schema: Record<string, unknown>): EnumValue[] {
  const described = new Map<string, string>();
  if (typeof schema.description === 'string') {
    for (const line of schema.description.split('\n')) {
      const m = /^- `([^`]+)`: (.+)$/.exec(line.trim());
      if (m) described.set(m[1], m[2]);
    }
  }
  return (schema.enum as unknown[])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map(name => ({ name, ...(described.has(name) ? { description: described.get(name)! } : {}) }));
}

/**
 * The OpenAPI path of one endpoint: the Portal's basePath joined before the
 * method's path, and every placeholder in OpenAPI's `{name}` form. A design
 * may write a placeholder as `{name}` or in the Express idiom `:name` (a
 * segment `/:name`); both are the same placeholder, so `/routes/:id` and
 * `/routes/{id}` document the same operation with `id` in the path.
 */
export function openApiPath(basePath: string | undefined, endpointPath: string): string {
  const join = (a: string, b: string): string => `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
  const base = basePath && basePath.trim() && basePath.trim() !== '/' ? basePath.trim() : '';
  const rootedBase = base.startsWith('/') || !base ? base : `/${base}`;
  // The Portal's root (`/` or nothing under a basePath) is the basePath itself.
  const raw = base ? (endpointPath.replace(/\/+$/, '') === '' ? rootedBase : join(rootedBase, endpointPath)) : endpointPath;
  const rooted = raw.startsWith('/') ? raw : `/${raw}`;
  return rooted.replace(/\/:([A-Za-z_][A-Za-z0-9_]*)/g, '/{$1}');
}

/**
 * The parameter names that carry a Portal's credential, by its auth scheme:
 * the bearer token, the basic credentials, the API key (by the scheme's own
 * key name too). The contract models the header as a parameter because a
 * method has no other place for it; in an OpenAPI document the security
 * scheme carries it, so documenting it again as a query or body parameter
 * would demand the token twice.
 */
const CREDENTIAL_PARAM_NAMES: Record<string, readonly string[]> = {
  bearer: ['token', 'bearer', 'bearertoken', 'accesstoken', 'authtoken', 'authorization', 'jwt', 'idtoken', 'sessiontoken'],
  oauth2: ['token', 'bearer', 'bearertoken', 'accesstoken', 'authtoken', 'authorization', 'jwt', 'idtoken'],
  openIdConnect: ['token', 'bearer', 'bearertoken', 'accesstoken', 'authtoken', 'authorization', 'jwt', 'idtoken'],
  basic: ['credentials', 'basiccredentials', 'basicauth', 'authorization'],
  apiKey: ['apikey', 'key', 'authorization'],
  custom: ['authorization', 'token', 'credentials'],
};

/** A name compared as the credential names are: lower case, letters and digits only. */
function credentialKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The one string parameter of a method that IS the credential its Portal's
 * auth scheme binds (the first such, by name), or undefined — what the
 * document leaves out of the parameters and the body, naming it under
 * `x-wairon-credential-param` instead so a wairon reader can put it back.
 */
export function credentialParam(method: MethodSignature, auth: PortalAuth | undefined): string | undefined {
  if (!auth || auth.scheme === 'none') return undefined;
  const names = new Set(CREDENTIAL_PARAM_NAMES[auth.scheme] ?? []);
  const keyName = auth.name ? credentialKey(auth.name) : undefined;
  const isCredential = (name: string): boolean => {
    const key = credentialKey(name);
    return names.has(key) || (keyName !== undefined && key.length >= 3 && (keyName === key || keyName.endsWith(key)));
  };
  return (method.params ?? []).find((p) => p.type.trim() === 'string' && isCredential(p.name))?.name;
}

/** The parameter names an OpenAPI path template declares: its `{code}` segments. */
function pathTemplateNames(pathTemplate: string): string[] {
  const names: string[] = [];
  for (const m of pathTemplate.matchAll(/\{([^}/]+)\}/g)) names.push(m[1]);
  return names;
}

function operationFor(method: MethodSignature, scope: SchemaScope, entry?: SurfaceContractEntry): Record<string, unknown> {
  const endpoint = method.endpoint;
  const httpVerb = endpoint && endpoint.transport === 'HTTP' ? endpoint.method.toLowerCase() : 'post';
  const bodyVerbs = new Set(['post', 'put', 'patch']);
  // The credential the security scheme carries is never a parameter as well.
  const credential = credentialParam(method, entry?.auth);
  const params = (method.params ?? []).filter((p) => p.name !== credential);

  const op: Record<string, unknown> = {
    operationId: method.name,
    summary: method.description,
    responses: {
      '200': {
        description: method.returns || 'Success',
        ...(method.returns && !returnsNothing(method.returns)
          ? { content: { 'application/json': { schema: schemaFor(method.returns, scope) } } }
          : {}),
      },
    },
  };
  if (method.guarantees?.length) op['x-wairon-guarantees'] = method.guarantees;
  if (method.effect) op['x-wairon-effect'] = method.effect;
  // Opaque pack/tool extension data — emitted verbatim so the OpenAPI form
  // round-trips everything the native YAML snapshot preserves.
  if (method.ext && Object.keys(method.ext).length) op['x-wairon-ext'] = method.ext;

  // A param the path template names (`/stats/{code}`) is a path parameter —
  // always required, the path cannot be built without it — and OpenAPI calls a
  // templated path that declares none invalid. The rest go in the query (a verb
  // without a body) or the JSON body (POST, PUT, PATCH).
  if (credential !== undefined) op['x-wairon-credential-param'] = credential;
  const templated = new Set(endpoint && endpoint.transport === 'HTTP' ? pathTemplateNames(openApiPath(undefined, endpoint.path)) : []);
  const inPath = params.filter(p => templated.has(p.name));
  const rest = params.filter(p => !templated.has(p.name));
  const parameter = (p: (typeof params)[number], where: 'path' | 'query'): Record<string, unknown> => ({
    name: p.name,
    in: where,
    required: where === 'path' ? true : !p.optional,
    ...(p.description ? { description: p.description } : {}),
    schema: schemaFor(p.type, scope),
  });
  const parameters = inPath.map(p => parameter(p, 'path'));
  if (rest.length) {
    if (bodyVerbs.has(httpVerb)) {
      op.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: Object.fromEntries(rest.map(p => [p.name, schemaFor(p.type, scope)])),
              required: rest.filter(p => !p.optional).map(p => p.name),
            },
          },
        },
      };
    } else {
      parameters.push(...rest.map(p => parameter(p, 'query')));
    }
  }
  if (parameters.length) op.parameters = parameters;
  return op;
}

/** One closure type as a component: an enum's values, a named scalar's primitive, a signature, or an object of its fields. */
function typeComponent(t: SurfaceTypeDef, scope: SchemaScope): Record<string, unknown> {
  if (t.kind === 'enum') {
    // An enum is a value domain: a string component with its values as `enum`.
    const values = t.values ?? [];
    return { type: 'string', title: t.name, enum: values.map(v => v.name), description: enumDescription(values) };
  }
  // A named scalar is its primitive's schema under the type's name.
  if (t.holds !== undefined) return { ...schemaFor(t.holds, scope), title: t.name };
  if (t.kind === 'signature') return signatureComponent(t, scope);
  return {
    type: 'object',
    title: t.name,
    properties: Object.fromEntries(t.fields.map(f => [f.name, schemaFor(f.type, scope)])),
    required: t.fields.filter(f => !f.optional).map(f => f.name),
  };
}

/** The extension a signature type's component carries: its params and returns, for a wairon reader. */
const SIGNATURE_EXTENSION = 'x-wairon-signature';

/**
 * A signature type as a component. A function type has no JSON-Schema form
 * and no JSON value can carry a function, so the component invents no shape:
 * no `type` constraint, a description saying what it is, and its params and
 * returns under `x-wairon-signature`, which generic OpenAPI tools ignore.
 */
function signatureComponent(t: SurfaceTypeDef, scope: SchemaScope): Record<string, unknown> {
  const params = t.params ?? [];
  const returns = t.returns ?? 'any';
  const text = `(${params.map(p => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}): ${returns}`;
  return {
    title: t.name,
    description: `A function type ${text}. A function has no JSON form, so no JSON value of this type can be sent; its params and returns are under ${SIGNATURE_EXTENSION}.`,
    [SIGNATURE_EXTENSION]: {
      // Each type twice: as wairon wrote it (what a wairon reader decodes, exactly),
      // and as a $ref or schema (what an OpenAPI reader can follow).
      params: params.map(p => ({
        name: p.name,
        type: p.type,
        schema: schemaFor(p.type, scope),
        ...(p.optional ? { optional: true } : {}),
        ...(p.description ? { description: p.description } : {}),
      })),
      returns: { type: returns, schema: schemaFor(returns, scope) },
    },
  };
}

/** A component carrying `x-wairon-signature` decoded back into a signature type; undefined for any other component. */
function signatureFromComponent(id: string, schema: Record<string, unknown>): SurfaceTypeDef | undefined {
  const raw = schema[SIGNATURE_EXTENSION];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const ext = raw as Record<string, unknown>;
  // The wairon type text when the entry carries one; else read back from its schema
  // (an empty schema is what any and void render as, so it decodes to any).
  const typeOf = (entry: Record<string, unknown>): string => {
    if (typeof entry.type === 'string' && entry.type.trim()) return entry.type;
    return typeRefFromSchema(entry.schema as Record<string, unknown> | undefined);
  };
  const params = (Array.isArray(ext.params) ? ext.params : [])
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
    .map(p => ({
      name: p.name as string,
      type: typeOf(p),
      ...(p.optional === true ? { optional: true } : {}),
      ...(typeof p.description === 'string' ? { description: p.description } : {}),
    }));
  const returns = ext.returns && typeof ext.returns === 'object' && !Array.isArray(ext.returns)
    ? typeOf(ext.returns as Record<string, unknown>)
    : 'any';
  return { id, name: typeof schema.title === 'string' ? schema.title : id, kind: 'signature', fields: [], params, returns };
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

/** What a rendering knows beyond the snapshot: the pinned externals its types name, and the project's declared version. */
export interface OpenApiRenderContext {
  /** Each declared external's pinned snapshot, by alias: where `alias::name` in a schema resolves. */
  externals?: ReadonlyMap<string, SurfaceSnapshot>;
  /** The project's declared version (its package manifest), for `info.version`. */
  version?: string;
}

/** Render ONE OpenAPI document from a chosen subset of entries: one portal's, for toOpenApiSet. */
function renderDoc(
  snapshot: SurfaceSnapshot,
  entries: SurfaceContractEntry[],
  context: OpenApiRenderContext,
  opts: { title?: string } = {},
): Record<string, unknown> {
  const { schemes, securityByEntry } = buildSecurity(entries);
  const reached = new Map<string, ReachedExternal>();
  const scope = schemaScope(new Set(snapshot.types.map(t => t.id)), context.externals ?? new Map(), reached);

  const paths: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const security = securityByEntry.get(entry.id);
    for (const method of entry.methods) {
      const endpoint = method.endpoint;
      if (!endpoint || endpoint.transport !== 'HTTP') continue;
      // The Portal's basePath is part of every path, and `:name` reads as `{name}`.
      const p = openApiPath(entry.basePath, endpoint.path);
      paths[p] = paths[p] ?? {};
      paths[p][endpoint.method.toLowerCase()] = {
        tags: [entry.id],
        ...operationFor(method, scope, entry),
        ...(security ? { security: [security] } : {}),
      };
    }
  }

  const schemas: Record<string, unknown> = {};
  for (const t of snapshot.types) schemas[t.id] = typeComponent(t, scope);
  // Every pinned external type a schema named, and the ones those name in
  // turn, each resolved inside its own producer's closure.
  const rendered = new Set<string>();
  for (let more = true; more;) {
    more = false;
    for (const [key, { alias, def }] of [...reached]) {
      if (rendered.has(key)) continue;
      rendered.add(key);
      more = true;
      schemas[key] = typeComponent(def, scope.within(alias));
    }
  }

  const components: Record<string, unknown> = {};
  if (Object.keys(schemas).length) components.schemas = schemas;
  if (Object.keys(schemes).length) components.securitySchemes = schemes;

  // The basePath is in every path; the document names it once more so a
  // wairon reader can take it back off. `servers` is deployment, which the
  // design does not model, so the document declares none.
  const basePaths = [...new Set(entries.map(e => e.basePath).filter((b): b is string => !!b && b.trim() !== '/'))];

  return {
    openapi: '3.1.0',
    info: {
      title: opts.title ?? snapshot.projectName,
      version: context.version ?? snapshot.version ?? '0.0.0',
      ...(snapshot.stateId ? { 'x-wairon-state-id': snapshot.stateId } : {}),
      'x-wairon-origin': snapshot.origin,
      'x-wairon-generated-at': snapshot.generatedAt,
    },
    ...(basePaths.length === 1 ? { 'x-wairon-base-path': basePaths[0] } : {}),
    paths,
    ...(Object.keys(components).length ? { components } : {}),
  };
}

/**
 * One named OpenAPI document PER PUBLIC PORTAL, partitioned by the backing portal
 * component. A project that models a single gateway portal yields one spec; three
 * separate portals yield three — never merged. Each carries its own paths (the
 * portal's basePath joined in) and its own securitySchemes/security; a type of
 * a pinned external resolves from its pinned snapshot, and `info.version` is the
 * project's declared version when the context gives one.
 */
export function toOpenApiSet(snapshot: SurfaceSnapshot, context: OpenApiRenderContext = {}): NamedOpenApiSpec[] {
  const byPortal = new Map<string, SurfaceContractEntry[]>();
  const order: string[] = [];
  for (const entry of httpEntriesOf(snapshot)) {
    if (!byPortal.has(entry.component)) { byPortal.set(entry.component, []); order.push(entry.component); }
    byPortal.get(entry.component)!.push(entry);
  }
  return order.map(portalId => {
    const entries = byPortal.get(portalId)!;
    const name = entries[0]?.name ?? portalId;
    return { portalId, name, document: JSON.stringify(renderDoc(snapshot, entries, context, { title: name }), null, 2) };
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

/** Whether a schema is the `{type: "null"}` member of a null-admitting anyOf / oneOf. */
function isNullSchema(schema: unknown): boolean {
  return !!schema && typeof schema === 'object' && (schema as Record<string, unknown>).type === 'null';
}

/** Whether a canonical text is a union at its top level (a `|` outside every `<...>` and `(...)`). */
function isTopLevelUnion(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    else if (ch === '|' && depth === 0) return true;
  }
  return false;
}

/**
 * A JSON-Schema fragment read back into its canonical type expression's text:
 * integer int, number float, boolean bool; a string of format date, date-time
 * or duration its primitive, a base64 string bytes; an array list, or with
 * uniqueItems set; additionalProperties map; a null-admitting schema `T?`; a
 * oneOf of $refs a union; a $ref its component; anything else any.
 */
function typeRefFromSchema(schema: Record<string, unknown> | undefined): string {
  if (!schema || typeof schema !== 'object') return 'any';
  const ref = schema.$ref;
  if (typeof ref === 'string') return ref.split('/').pop() ?? 'any';
  for (const key of ['anyOf', 'oneOf'] as const) {
    const members = schema[key];
    if (!Array.isArray(members) || members.length === 0) continue;
    const nullable = members.some(isNullSchema);
    const texts = members.filter(m => !isNullSchema(m)).map(m => typeRefFromSchema(m as Record<string, unknown>));
    if (texts.length === 0 || texts.includes('any')) return 'any';
    const text = texts.join(' | ');
    if (!nullable) return text;
    // A union (several members here, or one member that is itself a oneOf) wears its parentheses under `?`.
    return isTopLevelUnion(text) ? `(${text})?` : `${text}?`;
  }
  const t = schema.type;
  if (Array.isArray(t)) {
    const types = t.filter((x): x is string => typeof x === 'string');
    const nonNull = types.filter(x => x !== 'null');
    if (nonNull.length !== 1) return 'any';
    const inner = typeRefFromSchema({ ...schema, type: nonNull[0] });
    return types.includes('null') && inner !== 'any' ? `${inner}?` : inner;
  }
  if (t === 'array') {
    const elem = typeRefFromSchema(schema.items as Record<string, unknown> | undefined);
    return schema.uniqueItems === true ? `set<${elem}>` : `list<${elem}>`;
  }
  if (t === 'integer') return 'int';
  if (t === 'number') return 'float';
  if (t === 'boolean') return 'bool';
  if (t === 'string') {
    if (schema.format === 'date') return 'date';
    if (schema.format === 'date-time') return 'datetime';
    if (schema.format === 'duration') return 'duration';
    if (schema.contentEncoding === 'base64' || schema.format === 'byte' || schema.format === 'binary') return 'bytes';
    return 'string';
  }
  if (t === 'object' || t === undefined) {
    const additional = schema.additionalProperties;
    if (additional && typeof additional === 'object') {
      const names = schema.propertyNames as Record<string, unknown> | undefined;
      const key = names && typeof names.$ref === 'string' ? typeRefFromSchema(names)
        : names && typeof names.pattern === 'string' && names.pattern.includes('[0-9]') ? 'int' : 'string';
      return `map<${key}, ${typeRefFromSchema(additional as Record<string, unknown>)}>`;
    }
    if (additional === true) return 'map<string, any>';
  }
  return 'any';
}

/** The JSON-Schema types a primitive renders as: a component of one of them, without properties, is a named scalar. */
const SCALAR_SCHEMA_TYPES = new Set(['string', 'integer', 'number', 'boolean']);

/** An inline anonymous enum has no name to become a type: it reads as string, its values named in the description. */
function inlineEnumNote(schema: Record<string, unknown> | undefined): string | undefined {
  if (!schema || schema.$ref !== undefined || !Array.isArray(schema.enum)) return undefined;
  const values = schema.enum.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  return values.length ? `One of: ${values.join(', ')}.` : undefined;
}

/** A description and an inline-enum note, joined. */
function describedWith(description: string | undefined, note: string | undefined): { description?: string } {
  const text = [description, note].filter((x): x is string => !!x).join(' ');
  return text ? { description: text } : {};
}

/** Reconstruct a PortalAuth from an OpenAPI securityScheme (round-trips toOpenApiSet). */
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
  // A wairon document joins its Portal's basePath into every path and names
  // it once: taken back off, so the contract reads as it was designed.
  const basePath = typeof parsed['x-wairon-base-path'] === 'string' ? parsed['x-wairon-base-path'] : undefined;
  const methods: MethodSignature[] = [];
  for (const [documentPath, ops] of Object.entries(parsed.paths as Record<string, Record<string, unknown>>)) {
    const rawPath = basePath && documentPath.startsWith(basePath) && documentPath.length > basePath.length
      ? documentPath.slice(basePath.replace(/\/+$/, '').length) || '/'
      : documentPath;
    for (const [verb, opRaw] of Object.entries(ops ?? {})) {
      if (!['get', 'post', 'put', 'delete', 'patch', 'options', 'head'].includes(verb)) continue;
      const op = (opRaw ?? {}) as Record<string, unknown>;
      const name = typeof op.operationId === 'string' && /^[a-zA-Z0-9_]+$/.test(op.operationId)
        ? op.operationId
        : `${verb}_${rawPath.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;

      const params: { name: string; type: string; optional?: boolean; description?: string }[] = [];
      // The credential the security scheme carried, put back as the parameter the contract declared.
      if (typeof op['x-wairon-credential-param'] === 'string') params.push({ name: op['x-wairon-credential-param'], type: 'string' });
      for (const p of (op.parameters as Record<string, unknown>[] | undefined) ?? []) {
        if (typeof p.name !== 'string') continue;
        const schema = p.schema as Record<string, unknown> | undefined;
        params.push({
          name: p.name,
          type: typeRefFromSchema(schema),
          ...(p.required === true ? {} : { optional: true }),
          ...describedWith(typeof p.description === 'string' ? p.description : undefined, inlineEnumNote(schema)),
        });
      }
      const bodySchema = ((op.requestBody as Record<string, unknown>)?.content as Record<string, Record<string, unknown>>)?.['application/json']?.schema as Record<string, unknown> | undefined;
      if (bodySchema) {
        const props = (bodySchema.properties ?? {}) as Record<string, Record<string, unknown>>;
        const required = new Set((bodySchema.required as string[] | undefined) ?? []);
        if (Object.keys(props).length) {
          for (const [pname, pschema] of Object.entries(props)) {
            params.push({
              name: pname,
              type: typeRefFromSchema(pschema),
              ...(required.has(pname) ? {} : { optional: true }),
              ...describedWith(typeof pschema.description === 'string' ? pschema.description : undefined, inlineEnumNote(pschema)),
            });
          }
        } else {
          params.push({ name: 'body', type: typeRefFromSchema(bodySchema) });
        }
      }

      const okResponse = ((op.responses as Record<string, Record<string, unknown>>)?.['200']
        ?? (op.responses as Record<string, Record<string, unknown>>)?.['201']) as Record<string, unknown> | undefined;
      const responseSchema = ((okResponse?.content as Record<string, Record<string, unknown>>)?.['application/json']?.schema) as Record<string, unknown> | undefined;
      const returns = responseSchema ? typeRefFromSchema(responseSchema) : 'void';

      // Read back the x-wairon-* keys toOpenApiSet emits, so an OpenAPI-format
      // exchange preserves the same contract the native YAML snapshot does.
      // All three are optional: documents from other producers simply lack
      // them, and a malformed value is ignored rather than failing the import.
      const rawGuarantees = op['x-wairon-guarantees'];
      const guarantees = Array.isArray(rawGuarantees)
        ? rawGuarantees.filter((g): g is string => typeof g === 'string' && g.length > 0)
        : [];
      const rawEffect = op['x-wairon-effect'];
      const effect = rawEffect === 'read' || rawEffect === 'write' || rawEffect === 'lifecycle' ? rawEffect : undefined;
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
    const signature = signatureFromComponent(id, schema);
    if (signature) {
      types.push(signature);
      continue;
    }
    // A named string component carrying `enum` is an enum type.
    if (schema.type === 'string' && Array.isArray(schema.enum)) {
      types.push({ id, name: typeof schema.title === 'string' ? schema.title : id, kind: 'enum', fields: [], values: enumValuesFrom(schema) });
      continue;
    }
    // A named component whose schema is one primitive's is a named scalar holding it.
    if (typeof schema.type === 'string' && SCALAR_SCHEMA_TYPES.has(schema.type) && schema.properties === undefined) {
      types.push({ id, name: typeof schema.title === 'string' ? schema.title : id, kind: 'value-object', fields: [], holds: typeRefFromSchema(schema) });
      continue;
    }
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

  // Read the first securityScheme back into the entry's auth (round-trips toOpenApiSet).
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
    ...(basePath ? { basePath } : {}),
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
