import { pathKey, type RouteFact } from '../../../models/index.js';
import { SddRule } from '../types.js';
import { closedCallSites } from './call-conformance.js';

// ---------------------------------------------------------------------------
// Code↔contract for the ROUTES: does every route a router actually answers
// have a contract endpoint, and does every contract endpoint have a route that
// answers it?
//
// A portal's endpoints are what its contract promises; its router is what the
// code serves; nothing compared the two. So a route with no contract ran
// unnoticed — including a write: `POST /web/admin/secrets` was found by hand,
// by an agent reading the router line by line, because every rule looked
// straight past it. The Portal's own implementation names its router entry
// (`router`, code linkage), and that is what makes the comparison possible:
// the routes are read out of that function's guards, in the portal's own
// files. Which process serves which Portal is implementation, so no listener
// is consulted.
//
// Four decisions make it a reading rather than a guess:
//
//  1. ROUTERS NEST. An outer `if (parts[1] === 'projects')` guards the inner
//     branches, so a branch's route is the conjunction of its own guard and
//     every enclosing one on the path taken. The analyzer does that (see
//     RouteFact); this rule only reads what it recorded.
//
//  2. THE LEADING SEGMENT COMES FROM THE PORTAL'S OWN PATHS. A router never
//     re-checks the segment whatever serves it already routed on —
//     `handleWebRequest` never asks whether `parts[0]` is `web`. A route whose
//     first segment nothing constrains is completed with each first segment of
//     the Portal's own HTTP endpoint paths.
//
//  3. ONE IDIOM, AND UNREAD IS SAID OUT LOUD. Only a method comparison with
//     comparisons on the split path's segments and their count is read. A
//     router that yields no route in that idiom is reported as
//     UNREADABLE_ROUTER, never passed: a check that cannot see a router must
//     say so rather than stay quiet, or its silence reads as a clean router.
//
//  4. BELOW EXACT GRADE, NOTHING. A guard cannot be read as a route from
//     text, and the file's grade is already on every other finding about it —
//     so a router whose body no exact-grade file holds is left alone. A
//     `router` no file exports at all is export-conformance's finding.
//
// Matching is by verb and by path segment, both sides normalized the same way:
// an endpoint's template parameter (`{id}` or `:id`) and a route's
// unconstrained `*` are one wildcard, and segments compare equal as written.
// A route that pins no segment count also covers any longer endpoint path
// under the same leading segments, because the router may read past what its
// guard checks.
//
// All three codes are CARRYABLE: each measures this project's code against its
// own contracts at a site the finding names — the Portal's router entry — and
// the units are the route or endpoint keys, so a router cannot grow a new
// undeclared route behind a register entry written for the old ones.
// ---------------------------------------------------------------------------

/** One path segment as matching compares it: a template parameter and an unconstrained segment are one wildcard. */
function normalizeSegment(segment: string): string {
  return /^\{.+\}$/.test(segment) || segment.startsWith(':') ? '*' : segment;
}

/** A route after its leading segment has been completed from one of the Portal's own first segments. */
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
 * The routes one read route stands for: a leading segment the router never
 * checks is the one whatever serves the Portal routes on, so it is completed
 * with each first segment of the Portal's own HTTP endpoint paths. With none
 * (every endpoint at `/`), the segment stays open.
 */
function completed(route: RouteFact, heads: string[], base: string[]): ServedRoute[] {
  // A route that states the whole path carries the Portal's basePath in
  // front, where the contract's endpoint paths are written under it.
  const stated = base.length > 0 && base.every((segment, index) => route.segments[index] === segment)
    ? route.segments.slice(base.length) : route.segments;
  const variants = !route.fullPath && stated[0] === '*' && heads.length > 0
    ? heads.map(head => [head, ...stated.slice(1)])
    : [stated];
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
  judges: 'code',
  description:
    "Code-to-contract for the ROUTES: does every route a router actually answers have a contract endpoint, and does every contract endpoint have a route that answers it? A portal's endpoints are what its contract promises; the router is what the code serves; nothing compared the two, so a route with no contract (including a write) could run for months without a single rule noticing. The Portal's own implementation names its router entry (`router`, code linkage), and the routes are read out of that function and the functions of its file it calls by name. Two idioms are read: guards (a method comparison with comparisons on the path's split segments), where a prefix the router strips before splitting the path is folded in front; and a route table the router names (an array of objects pairing a method with a `/a/:b` template or an anchored regular expression, or an object keyed `VERB /path`), read only when every entry settles. Every compared value is a literal or one the code's constants, concatenations and template literals settle — through the type checker, any module's constant and any expression it types as one string literal — and never a guess. A route that states the whole path is read under the Portal's basePath, which the contract's endpoint paths are written beneath; a leading path segment a guard router never checks is completed from the first segments of the Portal's own HTTP endpoint paths, the segments whatever serves the Portal routes on. Which process serves which Portal is implementation, so no listener is consulted. A router that yields no route in either idiom is reported as unread, never passed: a check that cannot see a router must say so rather than stay quiet.",
  codes: [
    {
      code: 'UNDECLARED_ROUTE',
      defaultSeverity: 'warning',
      summary: 'A router answers a route that no contract endpoint of the portal it serves declares — a surface the code serves and the design never promised',
      // Measured code↔contract drift, route by route, at the Portal's router
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
      summary: "A Portal's router entry yields no route this analysis can read, so its routes were not checked against the contract at all",
      carryable: true,
    },
  ],

  check(ctx): void {
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();

    // ---- 1. each Portal implementation naming a router entry ----
    // A Portal with no router entry is served method by method and has no
    // router of its own to read.
    for (const portal of ctx.components) {
      if (portal.componentType !== 'Portal') continue;
      for (const impl of realization.implementationsOf(portal.id)) {
        const via = impl.router;
        if (!via) continue;
        const anchor = impl.id;

        // ---- 2. is there a router to judge? ----
        // The entry's file is the exact-grade file of the portal that holds a
        // BODY under the entry's name — a file that only imports or
        // re-exports it holds nothing to read. No such file, and this rule
        // says nothing (step 7): below exact grade a guard cannot be read as
        // a route, and a `router` nobody exports is export-conformance's finding.
        const holders = realization.filesOf(portal.id).map(pathKey).filter((file) => {
          const facts = code.factsAt(file);
          return !!facts && facts.status === 'analyzed' && facts.analysisGrade === 'exact'
            && !!facts.functionParams && Object.prototype.hasOwnProperty.call(facts.functionParams, via);
        });
        if (holders.length === 0) continue;
        // The entry's own routes, and those of the functions of its file it
        // calls by name — a router delegating its matching to a helper that
        // reads the route table is one router.
        const read: RouteFact[] = holders.flatMap((file) => {
          const routes = code.factsAt(file)!.functionRoutes;
          if (!routes) return [];
          const names = new Set<string>([via]);
          for (const site of closedCallSites(code, file, via) ?? []) {
            if (!site.member && pathKey(site.from ?? file) === file) names.add(site.name);
          }
          return [...names].flatMap(name => (Object.prototype.hasOwnProperty.call(routes, name) ? routes[name] : []));
        });
        const draftContext = ctx.isComponentDraft(portal.id) || ctx.isImplementationDraft(impl);
        const where = holders.map(file => `"${file}"`).join(', ');

        // ---- 3 / 4. the idiom recognised at all? ----
        if (read.length === 0) {
          ctx.addIssue(
            'warning',
            'UNREADABLE_ROUTER',
            `Portal "${portal.id}" names its router "${via}" (in ${where}), but no branch of `
            + `"${via}" reads as a route — so none of its routes were checked against the contract at all. Only `
            + 'two idioms are read, in the entry and in the functions of its file it calls by name: an `if` whose '
            + 'conditions, together with those of every enclosing `if`, compare `<request>.method` with a string and '
            + '`parts[i]` / `parts.length` with values the code spells out or its constants settle; and a route table '
            + 'it names — an array of objects pairing a method with a path pattern (a `/a/:b` template or an anchored '
            + 'regular expression), or an object keyed `VERB /path` — every entry of which settles. Silence here would '
            + 'read as a clean router; it is only one this analysis cannot see. Write the router in one of those idioms, '
            + 'or carry this finding with the reason it cannot be.',
            anchor,
            draftContext,
            undefined,
            { at: via },
          );
          continue;
        }

        // ---- 5. complete each route from the Portal's own endpoints, and match ----
        // Only HTTP endpoints: no other transport is routed by a path.
        const endpoints: ContractEndpoint[] = ctx.interfaceMethodsOf(portal.id).flatMap((method) => {
          const endpoint = method.endpoint;
          if (endpoint?.transport !== 'HTTP') return [];
          return [{
            verb: endpoint.method.toUpperCase(),
            segments: endpoint.path.split('/').filter(Boolean).map(normalizeSegment),
            key: `${endpoint.method.toUpperCase()} ${endpoint.path}`,
          }];
        });
        const heads = [...new Set(endpoints
          .map(endpoint => endpoint.segments[0])
          .filter((head): head is string => !!head && head !== '*'))].sort();
        const base = (portal.basePath ?? '').split('/').filter(Boolean);
        const served = read.map(route => completed(route, heads, base));

        // ---- 6. both directions of the drift ----
        const undeclared = [...new Set(served
          .filter(variants => !variants.some(route => endpoints.some(endpoint => answers(route, endpoint))))
          .flatMap(variants => variants.map(route => route.key)))].sort();
        if (undeclared.length > 0) {
          ctx.addIssue(
            'warning',
            'UNDECLARED_ROUTE',
            `Portal "${portal.id}"'s router "${via}" (${where}) answers `
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
            `Portal "${portal.id}" binds ${unrouted.length} HTTP endpoint(s) `
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
