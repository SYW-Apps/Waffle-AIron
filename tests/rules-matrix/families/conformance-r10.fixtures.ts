/**
 * What the code reaches, round ten — src/core/rules/conformance/param-conformance.ts,
 * route-coverage.ts, export-conformance.ts and the parameter and table facts
 * of src/core/source-analysis.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - The one record parameter left unpaired is realized by the request handed
 *    as a call's first argument to any function but a collaborator's method,
 *    whose result the handler binds and uses whole
 *    (`const hit = await readJsonBody(req)`); a result only read for members
 *    is named reads, never the body (UNREALIZED_PARAM).
 *  - A scalar realized by an opaque parameter the body reads as an object is
 *    PARAM_TYPE_MISMATCH.
 *  - A Portal served by a class's method names it `Class.method`
 *    (UNREALIZED_EXPORT_HANDLE only when the class or the method is missing).
 *  - A router naming a table a sibling aggregate leaves out is
 *    ROUTER_NOT_DISPATCHED (a notice).
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';
import { analyticsTree } from '../../helpers/conformance-r9-trees.js';
import { bodyTree, checkInTree, classRouterTree, dispatchedRoutes } from '../../helpers/conformance-r10-trees.js';

/** A tree without its own project.yaml: the harness writes the fixture's. */
function bare(t: FixtureTree): FixtureTree {
  const files = { ...(t.files ?? {}) };
  delete files['.wai/project.yaml'];
  return { ...t, files };
}

/** The analytics Portals each naming its own table, the service's aggregate spreading the ones given. */
const ownTables = (dispatched: string[]): FixtureTree =>
  bare(analyticsTree({ routesFile: dispatchedRoutes(dispatched), router: { hit_ingest_portal: 'ingestRoutes', stats_portal: 'statsRoutes' } }));

export default [
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: false,
    reason: 'The request is handed to a body helper whose result the handler binds and passes on whole: the body read whole is the record.',
    scenario: 'The link stats hit handler reads its JSON body through a helper module and hands the parsed hit to its recorder.',
    tree: bare(bodyTree('const hit = await readJsonBody<HitEvent>(req); return record(hit);')),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The link stats hit handler parses its body through a helper but only reads the code field off the result.',
    tree: bare(bodyTree('const hit = await readJsonBody<HitEvent>(req); return hit.code;')),
  }),
  defineRuleFixture({
    code: 'PARAM_TYPE_MISMATCH',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit check-in takes one any-typed args object and reads the habit id and the date off it, where its contract declares the date as a string.',
    tree: bare(checkInTree({ signature: 'authorization: string, args: any', body: 'return authorization + args.habitId + args.date;' })),
  }),
  defineRuleFixture({
    code: 'PARAM_TYPE_MISMATCH',
    expectFire: false,
    reason: 'The any-typed date is read only as the string it is.',
    scenario: 'The habit check-in takes the habit id as a string and the date typed any, trimming it as a string.',
    tree: bare(checkInTree({ signature: 'authorization: string, habitId: string, date: any', body: 'return authorization + habitId + date.trim();' })),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_EXPORT_HANDLE',
    expectFire: false,
    reason: 'A class\'s method is named `Class.method`, the class being the export that holds it.',
    scenario: 'The habits API Portal is served by the handle method of its exported class, named as its router.',
    tree: bare(classRouterTree('HabitPortal.handle')),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_EXPORT_HANDLE',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habits API Portal names a dispatch method its exported class does not have as its router.',
    tree: bare(classRouterTree('HabitPortal.dispatch')),
  }),
  defineRuleFixture({
    code: 'ROUTER_NOT_DISPATCHED',
    expectFire: true,
    severity: 'notice',
    scenario: 'The analytics service\'s stats Portal names its own route table while the service\'s aggregate table spreads only the ingest table.',
    tree: ownTables(['ingestRoutes']),
  }),
  defineRuleFixture({
    code: 'ROUTER_NOT_DISPATCHED',
    expectFire: false,
    reason: 'Both Portals\' tables are spread into the aggregate the server dispatches.',
    scenario: 'The analytics service\'s Portals each name their own route table, and the aggregate spreads both.',
    tree: ownTables(['ingestRoutes', 'statsRoutes']),
  }),
];
