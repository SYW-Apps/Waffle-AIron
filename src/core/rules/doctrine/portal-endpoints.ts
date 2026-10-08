import { SddRule, type RuleContext } from '../types.js';
import { transportRequiresEndpoint } from '../../../models/index.js';

/**
 * The PORTAL side of endpoint bindings: a Portal's every interface method needs
 * an endpoint of the Portal's own transport, when that transport requires one
 * (every transport but InProcess and Custom: transport.requiresEndpoint). The verdict reads the
 * component's INTERFACES, so it cannot move to the write boundary — a component
 * is legitimately authored before its L3 contract exists.
 *
 * Field-shape verdicts live in portalFieldsRule; this rule stays silent about
 * them (a Portal with no transport is simply skipped here — that rule reports
 * it, and there is no transport to check against). That anything OTHER than a
 * Portal may not carry an endpoint at all is nonPortalEndpointsRule's verdict.
 */

/** The field names of the type a parameter is typed by (its own text, nullability and namespace stripped), when the tree defines it. */
function fieldsOfType(ctx: RuleContext, typeText: string): string[] {
  const bare = typeText.replace(/\?$/, '').trim();
  const local = bare.slice(bare.lastIndexOf('::') + (bare.includes('::') ? 2 : 0)).split('.').pop() ?? bare;
  const type = ctx.types.find((t) => t.id === local || t.name === local || t.name === bare);
  return (type?.fields ?? []).map((f) => f.name);
}

/**
 * What is wrong with an HTTP path's `{name}` placeholders, one sentence each: a
 * `{` left unclosed or a stray `}`, a name appearing twice, a name that is no
 * parameter of the method — in either spelling, `{name}` or a `:name` segment.
 */
function placeholderProblems(path: string, bindable: string[] | null, params: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let depth = 0;
  let start = -1;
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '{') {
      if (depth > 0) { out.push(`whose placeholder opened at character ${start + 1} is never closed`); break; }
      depth = 1;
      start = i;
    } else if (ch === '}') {
      if (depth === 0) { out.push(`which holds a "}" that closes no placeholder (character ${i + 1})`); continue; }
      depth = 0;
      const name = path.slice(start + 1, i).trim();
      if (name === '') out.push('which holds an empty placeholder "{}"');
      else if (seen.has(name)) out.push(`which names the placeholder "{${name}}" twice`);
      else if (bindable !== null && !bindable.includes(name)) out.push(`whose placeholder "{${name}}" names no parameter of the method (${params.length ? `it has ${params.join(', ')}` : 'it has none'})`);
      seen.add(name);
    }
  }
  if (depth > 0 && !out.some((p) => p.includes('never closed'))) out.push(`whose placeholder opened at character ${start + 1} is never closed`);
  // The Express spelling: a path segment `:name` is the same placeholder.
  for (const segment of path.split('/')) {
    if (!segment.startsWith(':')) continue;
    const name = segment.slice(1).trim();
    if (name === '') out.push('which holds an empty placeholder ":"');
    else if (seen.has(name)) out.push(`which names the placeholder ":${name}" twice`);
    else if (bindable !== null && !bindable.includes(name)) out.push(`whose placeholder ":${name}" names no parameter of the method (${params.length ? `it has ${params.join(', ')}` : 'it has none'})`);
    seen.add(name);
  }
  return out;
}

export const portalsRule: SddRule = {
  name: 'portal-endpoints',
  judges: 'design',
  description:
    "A Portal binds every interface method to a concrete endpoint of its own transport, when that transport requires one (transport.requiresEndpoint): every transport but InProcess, whose verbs are the contract methods themselves, and Custom, whose address is free-form. An HTTP endpoint's path placeholders (`{name}`, or a `:name` segment) bind the method's parameters, so each must be closed, appear once and name a parameter of the method or a field of a parameter's type (a method that states no structured params is not judged on names). One HTTP route binds one verb: two methods bound to the same HTTP method and path — the Portal's basePath joined in, placeholders compared by position whatever their name or spelling (`{id}` and `:code` are the same segment) — within one Portal, or across Portals that declare the same basePath, are a duplicate route: no router can dispatch both and an OpenAPI document holds one operation per path and verb.",
  codes: [
    { code: 'MISSING_ENDPOINT', defaultSeverity: 'error', summary: 'Portal method without a wire endpoint binding, on a transport that requires one' },
    { code: 'ENDPOINT_TRANSPORT_MISMATCH', defaultSeverity: 'error', summary: "Endpoint transport does not match the Portal's transport" },
    { code: 'ENDPOINT_PATH_PLACEHOLDER', defaultSeverity: 'error', summary: 'An HTTP endpoint path holds an unclosed placeholder, one placeholder twice, or a placeholder that names no parameter of its method' },
    { code: 'ENDPOINT_ROUTE_DUPLICATE', defaultSeverity: 'error', summary: 'Two methods bound to the same HTTP method and path (placeholders compared by position) within one Portal, or across Portals declaring the same basePath' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      // Generic endpoint check: every Portal whose transport requires an
      // endpoint requires each interface method to declare a concrete
      // `endpoint` of the SAME transport. One mechanism for HTTP / gRPC /
      // GraphQL / MessageBus / NamedPipe / IPC / CLI / JSONRPC — bound via the
      // generic sdd_set_endpoints tool. No transport ⇒ nothing expected
      // (portalFieldsRule reports it); InProcess and Custom carry no obligation.
      if (comp.componentType !== 'Portal') continue;
      const expected = comp.transport && transportRequiresEndpoint(comp.transport) ? comp.transport : undefined;
      if (!expected) continue;

      const isDraftCtx = ctx.isComponentDraft(comp.id);
      for (const intf of ctx.interfaces.filter(i => i.component === comp.id)) {
        const isIntfDraft = intf.status === 'draft' || intf.status === 'design';
        for (const m of intf.methods) {
          if (!m.endpoint) {
            ctx.addIssue(
              'error',
              'MISSING_ENDPOINT',
              `Method "${m.name}" on interface "${intf.id}" (Portal ${comp.transport}) is missing an "endpoint" mapping. Bind it with sdd_set_endpoints (transport "${expected}").`,
              intf.id,
              isDraftCtx || isIntfDraft,
            );
          } else if (m.endpoint.transport !== expected) {
            ctx.addIssue(
              'error',
              'ENDPOINT_TRANSPORT_MISMATCH',
              `Method "${m.name}" on interface "${intf.id}" declares a "${m.endpoint.transport}" endpoint, but its Portal "${comp.id}" has transport "${comp.transport}" (expects transport "${expected}").`,
              intf.id,
              // A contradiction, not unfinished work: never downgraded on a draft.
              false,
            );
          } else if (m.endpoint.transport === 'HTTP') {
            // Steps 11-12: the path's {placeholders} bind the method's parameters.
            const path = (m.endpoint as { path?: string }).path ?? '';
            // A method with no structured params states its parameters in prose
            // only, so which name a placeholder binds cannot be judged; a
            // placeholder may also bind a field of a parameter's type (PUT
            // /users/{id} with the user record as the body).
            const bindable = m.params?.length
              ? [...m.params.map((p) => p.name), ...m.params.flatMap((p) => fieldsOfType(ctx, p.type))]
              : null;
            for (const problem of placeholderProblems(path, bindable, (m.params ?? []).map((p) => p.name))) {
              ctx.addIssue(
                'error',
                'ENDPOINT_PATH_PLACEHOLDER',
                `Method "${m.name}" on interface "${intf.id}" binds the HTTP path "${path}", ${problem}: a wire request could never bind it, and the OpenAPI document would describe a parameter nobody sends.`,
                intf.id,
                isDraftCtx || isIntfDraft,
              );
            }
          }
        }
      }
    }
    // Steps 13-16: one HTTP route binds one verb.
    duplicateRoutes(ctx);
  },
};

/**
 * An HTTP route as a router matches it: the basePath joined in, slashes
 * collapsed, a trailing slash dropped, and every placeholder — `{name}` or a
 * `:name` segment — reduced to one positional marker, since a router (and an
 * OpenAPI document) binds a placeholder by its position, never by its name.
 */
function routeKey(basePath: string | undefined, path: string): string {
  const base = (basePath ?? '').trim();
  const joined = `/${base}/${path.trim()}`.replace(/\/+/g, '/');
  const trimmed = joined.length > 1 ? joined.replace(/\/+$/, '') : joined;
  return trimmed
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '{}' : segment.replace(/\{[^}]*\}/g, '{}')))
    .join('/') || '/';
}

/** A Portal's basePath as a scope two Portals can share: normalized, or none for `/` and an empty one. */
function sharedBase(basePath: string | undefined): string | undefined {
  const base = (basePath ?? '').trim().replace(/\/+/g, '/').replace(/\/+$/, '');
  if (base === '' || base === '/') return undefined;
  return base.startsWith('/') ? base : `/${base}`;
}

/**
 * Steps 13-16 of portal-endpoints: every HTTP route of the tree, grouped by
 * scope (its Portal, or the basePath Portals declaring one share), verb and
 * normalized path; a group two or more methods bind is ENDPOINT_ROUTE_DUPLICATE
 * on each interface in it — a contradiction, never downgraded on a draft.
 */
function duplicateRoutes(ctx: RuleContext): void {
  interface Route { portal: string; intf: string; method: string; verb: string; shown: string }
  const groups = new Map<string, Route[]>();
  for (const comp of ctx.components) {
    if (comp.componentType !== 'Portal' || comp.transport !== 'HTTP') continue;
    const scope = sharedBase(comp.basePath) !== undefined ? `base ${sharedBase(comp.basePath)}` : `portal ${comp.id}`;
    for (const intf of ctx.interfaces.filter((i) => i.component === comp.id)) {
      for (const m of intf.methods) {
        const endpoint = m.endpoint as { transport?: string; method?: string; path?: string } | undefined;
        if (!endpoint || endpoint.transport !== 'HTTP' || typeof endpoint.path !== 'string') continue;
        const verb = String(endpoint.method ?? '').toUpperCase();
        const key = `${scope} ${verb} ${routeKey(comp.basePath, endpoint.path)}`;
        const shown = `/${(comp.basePath ?? '').trim()}/${endpoint.path.trim()}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
        groups.set(key, [...(groups.get(key) ?? []), { portal: comp.id, intf: intf.id, method: m.name, verb, shown }]);
      }
    }
  }
  for (const routes of groups.values()) {
    if (routes.length < 2) continue;
    const named = routes.map((r) => `"${r.method}" (${r.verb} ${r.shown}, interface "${r.intf}" of Portal "${r.portal}")`).join(' and ');
    for (const intf of [...new Set(routes.map((r) => r.intf))]) {
      ctx.addIssue(
        'error',
        'ENDPOINT_ROUTE_DUPLICATE',
        `Methods ${named} bind the same HTTP route (placeholders compared by position, whatever their name): no router can dispatch both, so one of them is never reached on the wire, and an OpenAPI document holds one operation per path and verb. Bind each to its own route with sdd_set_endpoints.`,
        intf,
        // A contradiction, not unfinished work: never downgraded on a draft.
        false,
      );
    }
  }
}
