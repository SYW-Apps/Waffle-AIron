import { pathKey, type RouteFact } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔contract for the ROUTES: does every route a router actually answers
// have a contract endpoint, and does every contract endpoint have a route that
// answers it?
//
// A portal's endpoints are what its contract promises; its router is what the
// code serves; nothing compared the two. So a route with no contract ran
// unnoticed — including a write: `POST /web/admin/secrets` was found by hand,
// by an agent reading the router line by line, because every rule looked
// straight past it. A listener's mount now names the router function it calls
// (its `via`), and that is what makes the comparison possible: the routes are
// read out of that function's guards, in the mounted portal's own files.
//
// Four decisions make it a reading rather than a guess:
//
//  1. ROUTERS NEST. An outer `if (parts[1] === 'projects')` guards the inner
//     branches, so a branch's route is the conjunction of its own guard and
//     every enclosing one on the path taken. The analyzer does that (see
//     RouteFact); this rule only reads what it recorded.
//
//  2. THE LEADING SEGMENT COMES FROM THE MOUNT. A router never re-checks the
//     segment the listener already routed on — `handleWebRequest` never asks
//     whether `parts[0]` is `web`. A route whose first segment nothing
//     constrains is completed with the first segment of each of the mount's
//     prefixes, and a portal mounted under several prefixes is served under
//     each.
//
//  3. ONE IDIOM, AND UNREAD IS SAID OUT LOUD. Only a method comparison with
//     comparisons on the split path's segments and their count is read. A
//     mounted router that yields no route in that idiom is reported as
//     UNREADABLE_ROUTER, never passed: a check that cannot see a router must
//     say so rather than stay quiet, or its silence reads as a clean router.
//
//  4. BELOW EXACT GRADE, NOTHING. A guard cannot be read as a route from
//     text, and the file's grade is already on every other finding about it —
//     so a router whose body no exact-grade file holds is left alone. A `via`
//     no file exports at all is export-conformance's finding, not this one's.
//
// Matching is by verb and by path segment, both sides normalized the same way:
// an endpoint's template parameter (`{id}` or `:id`) and a route's
// unconstrained `*` are one wildcard, and segments compare equal as written.
// A route that pins no segment count also covers any longer endpoint path
// under the same leading segments, because the router may read past what its
// guard checks.
//
// All three codes are CARRYABLE: each measures this project's code against its
// own contracts at a site the finding names — the mount's router entry — and
// the units are the route or endpoint keys, so a router cannot grow a new
// undeclared route behind a register entry written for the old ones.
// ---------------------------------------------------------------------------

/** Whether `path` lies under `prefix`: equal to it, or continuing it past a slash — the mount's own reading. */
function liesUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

/** One path segment as matching compares it: a template parameter and an unconstrained segment are one wildcard. */
function normalizeSegment(segment: string): string {
  return /^\{.+\}$/.test(segment) || segment.startsWith(':') ? '*' : segment;
}

/** A route after its leading segment has been completed from one mount prefix. */
interface ServedRoute {
  verb: string;
  segments: string[];
  exactLength: boolean;
  /** How a message and a register entry name it. */
  key: string;
}

/** One HTTP endpoint the portal's contract binds. */
interface ContractEndpoint {
  verb: string;
  segments: string[];
  /** How a message and a register entry name it — as the contract writes it. */
  key: string;
}

/**
 * The routes one read route stands for once the mount is applied: a leading
 * segment the router never checks is the one the mount guarantees, so it is
 * completed with each prefix's first segment. With no prefix naming one (a
 * mount at `/`), the segment stays open.
 */
function completed(route: RouteFact, heads: string[]): ServedRoute[] {
  const variants = route.segments[0] === '*' && heads.length > 0
    ? heads.map(head => [head, ...route.segments.slice(1)])
    : [route.segments];
  return variants.map(segments => ({
    verb: route.verb.toUpperCase(),
    segments: segments.map(normalizeSegment),
    exactLength: route.exactLength,
    key: `${route.verb.toUpperCase()} /${segments.join('/')}${route.exactLength ? '' : '/…'}`,
  }));
}

/** Whether a served route answers a contract endpoint. */
function answers(route: ServedRoute, endpoint: ContractEndpoint): boolean {
  if (route.verb !== endpoint.verb) return false;
  if (route.exactLength ? endpoint.segments.length !== route.segments.length
    : endpoint.segments.length < route.segments.length) return false;
  return route.segments.every((segment, index) => segment === endpoint.segments[index]);
}

export const routeCoverageRule: SddRule = {
  name: 'route-coverage',
  description: 'Code-to-contract for the ROUTES: does every route a router actually answers have a contract endpoint, and does every contract endpoint have a route that answers it? A portal\'s endpoints are what its contract promises; the router is what the code serves; nothing compared the two, so a route with no contract — including a write — could run for months without a single rule noticing. The listener\'s mount names the router function (its `via`), and the routes are read out of that function\'s guards; the path segment the router never checks is the one the mount\'s prefix guarantees. One idiom is read — a method comparison with comparisons on the path\'s split segments — and a mounted router that yields no route in it is reported as unread, never passed: a check that cannot see a router must say so rather than stay quiet.',
  codes: [
    {
      code: 'UNDECLARED_ROUTE',
      defaultSeverity: 'warning',
      summary: 'A router answers a route that no contract endpoint of the portal it serves declares — a surface the code serves and the design never promised',
      // Measured code↔contract drift, route by route, at the mount's router
      // entry — which is why every one of them hands over `parts`.
      carryable: true,
    },
    {
      code: 'UNROUTED_ENDPOINT',
      defaultSeverity: 'warning',
      summary: 'A contract endpoint no route of the portal\'s router answers — the contract promises a route that no request can reach',
      carryable: true,
    },
    {
      code: 'UNREADABLE_ROUTER',
      defaultSeverity: 'warning',
      summary: 'A mounted portal\'s router yields no route this analysis can read, so its routes were not checked against the contract at all',
      carryable: true,
    },
  ],

  check(ctx): void {
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();

    for (const listener of ctx.components) {
      if (listener.componentType !== 'Portal') continue;
      for (const mount of listener.mounts ?? []) {
        // ---- 1. a mount that names a router entry, and the routes read from it ----
        // A mount with no `via` calls the portal's methods one by one and has
        // no router of its own to read. A mount naming no Portal is
        // portal-mounts' finding.
        const via = mount.via;
        if (!via) continue;
        const portal = ctx.componentMap.get(mount.portal);
        if (!portal || portal.componentType !== 'Portal') continue;
        const [anchor] = realization.implementationsOf(portal.id).map(impl => impl.id).sort();
        if (!anchor) continue;

        // ---- 2. is there a router to judge? ----
        // The entry's file is the exact-grade file of the portal that holds a
        // BODY under the entry's name — a file that only imports or
        // re-exports it holds nothing to read. No such file, and this rule
        // says nothing (step 7): below exact grade a guard cannot be read as
        // a route, and a `via` nobody exports is export-conformance's finding.
        const holders = realization.filesOf(portal.id).map(pathKey).filter((file) => {
          const facts = code.factsAt(file);
          return !!facts && facts.status === 'analyzed' && facts.analysisGrade === 'exact'
            && !!facts.functionParams && Object.prototype.hasOwnProperty.call(facts.functionParams, via);
        });
        if (holders.length === 0) continue;
        const read: RouteFact[] = holders.flatMap((file) => {
          const routes = code.factsAt(file)!.functionRoutes;
          return routes && Object.prototype.hasOwnProperty.call(routes, via) ? routes[via] : [];
        });
        const draftContext = ctx.isComponentDraft(listener.id) || ctx.isComponentDraft(portal.id);
        const where = holders.map(file => `"${file}"`).join(', ');

        // ---- 3 / 4. the idiom recognised at all? ----
        if (read.length === 0) {
          ctx.addIssue(
            'warning',
            'UNREADABLE_ROUTER',
            `Listener "${listener.id}" mounts portal "${portal.id}" through "${via}" in ${where}, but no branch of `
            + `"${via}" reads as a route — so none of its routes were checked against the contract at all. Only one `
            + 'idiom is read: an `if` whose conditions, together with those of every enclosing `if`, compare '
            + '`<request>.method` with a string and `parts[i]` / `parts.length` with literals. Silence here would '
            + 'read as a clean router; it is only one this analysis cannot see. Write the router in that idiom, or '
            + 'carry this finding with the reason it cannot be.',
            anchor,
            draftContext,
            undefined,
            { at: via },
          );
          continue;
        }

        // ---- 5. complete each route with the mount, and match ----
        const heads = [...new Set(mount.prefixes
          .map(prefix => prefix.split('/').filter(Boolean)[0])
          .filter((head): head is string => !!head))];
        const served = read.map(route => completed(route, heads));
        // Only HTTP endpoints under this mount's prefixes: one outside them is
        // ENDPOINT_OUTSIDE_MOUNT's finding, and no other transport is routed
        // by a path.
        const endpoints: ContractEndpoint[] = ctx.interfaceMethodsOf(portal.id).flatMap((method) => {
          const endpoint = method.endpoint;
          if (endpoint?.transport !== 'HTTP') return [];
          if (!mount.prefixes.some(prefix => liesUnder(endpoint.path, prefix))) return [];
          return [{
            verb: endpoint.method.toUpperCase(),
            segments: endpoint.path.split('/').filter(Boolean).map(normalizeSegment),
            key: `${endpoint.method.toUpperCase()} ${endpoint.path}`,
          }];
        });

        // ---- 6. both directions of the drift ----
        const undeclared = [...new Set(served
          .filter(variants => !variants.some(route => endpoints.some(endpoint => answers(route, endpoint))))
          .flatMap(variants => variants.map(route => route.key)))].sort();
        if (undeclared.length > 0) {
          ctx.addIssue(
            'warning',
            'UNDECLARED_ROUTE',
            `Portal "${portal.id}"'s router "${via}" (${where}), mounted by listener "${listener.id}", answers `
            + `${undeclared.length} route(s) no contract endpoint of "${portal.id}" declares — `
            + `${undeclared.map(key => `"${key}"`).join(', ')}. A surface the code serves and the design never `
            + 'promised is how a write runs with no contract: no brief, no auth review, no rule reading it. Declare '
            + 'each as a contract method with its endpoint, or take the route out of the router.',
            anchor,
            draftContext,
            undefined,
            { at: via, covers: undeclared },
          );
        }

        const unrouted = [...new Set(endpoints
          .filter(endpoint => !served.some(variants => variants.some(route => answers(route, endpoint))))
          .map(endpoint => endpoint.key))].sort();
        if (unrouted.length > 0) {
          ctx.addIssue(
            'warning',
            'UNROUTED_ENDPOINT',
            `Portal "${portal.id}" binds ${unrouted.length} HTTP endpoint(s) under listener "${listener.id}"'s mount `
            + `that no route of its router "${via}" (${where}) answers — ${unrouted.map(key => `"${key}"`).join(', ')}. `
            + 'The contract promises a route no request can reach. Route it in the router, or drop the endpoint '
            + 'from the contract.',
            anchor,
            draftContext,
            undefined,
            { at: via, covers: unrouted },
          );
        }
      }
    }
  },
};
