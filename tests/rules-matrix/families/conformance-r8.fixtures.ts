/**
 * What the code reaches, round eight — src/core/rules/conformance/param-conformance.ts,
 * call-conformance.ts, dependency-conformance.ts, route-coverage.ts and the
 * receiver, parameter, route and cross-project-import facts of
 * src/core/source-analysis.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - A member read by name off an opaque receiver and taken as a value fails
 *    closed (PORTAL_CALL_UNRESOLVED), and so does a cast-away port while the
 *    data component it stands for is planned: the design's write set judges it.
 *  - A transport object where a domain record is declared, an object sharing
 *    none of the record's fields, and a transport handle's name where the code
 *    settles no kind are substitutions (UNREALIZED_PARAM); a date realized as a
 *    string under a fresh name is a rename (PARAM_NAME_MISMATCH); an injection
 *    nothing takes is stale linkage (UNUSED_INJECTED_PARAM, a notice since
 *    round 9: it hides nothing).
 *  - A name imported from another project's source that the project does not
 *    export is reported (CROSS_PROJECT_SOURCE_IMPORT); a declared binding
 *    module is the sanctioned place for that reach.
 *  - A route table is read in a central module, under template-literal keys,
 *    returned unnamed, and under the prefix its router strips.
 *  - A claimed call into code in another language is said once as a notice
 *    (CALL_ACROSS_LANGUAGE), never judged by the call graph.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';
import { habitly, NO_FIELD, portalFile, projectYaml, STORE_FILE } from '../../helpers/conformance-r6-trees.js';
import { classPortal, routePortalTree, routerTree, type RoutePortalOptions } from '../../helpers/conformance-r7-trees.js';
import {
  centralRouterTree,
  PREFIX_KEYED_ROUTER,
  RETURNED_TABLE_ROUTER,
  ROUTES_MODULE,
  rustStoreTree,
  sinkPortal,
  STRIPPING_ROUTER,
} from '../../helpers/conformance-r8-trees.js';

/** A tree without its own project.yaml: the harness writes the fixture's. */
function bare(t: FixtureTree): FixtureTree {
  const files = { ...(t.files ?? {}) };
  delete files['.wai/project.yaml'];
  return { ...t, files };
}
const routes = (o: RoutePortalOptions): FixtureTree => bare(routePortalTree(o));

/** Habitly's check-in Portal with a date parameter beside the id, realized under `signature`. */
function datedCheckIn(signature: string, body: string): FixtureTree {
  const tree = bare(habitly({ portal: portalFile({ signature, field: NO_FIELD, head: '', body }) }));
  (tree.interfaces as Array<{ id: string; methods: Array<{ params: unknown[] }> }>).find(i => i.id === 'ihabit_portal')!.methods[0].params
    .push({ name: 'date', type: 'date', description: 'The day the habit was kept' });
  return tree;
}

/** A reminder Adapter reaching into the habit tracker project nested in its repository — its source, or through a binding. */
function reminders(binding: boolean): FixtureTree {
  const importLine = "import { HabitStore } from '../libs/habitly/src/habit-store.js';";
  return {
    system: { name: 'Reminders', vision: 'Reminds people of the habits they keep.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'reminders', description: 'Reminder delivery.' }],
    components: [{
      id: 'reminder_adapter', componentType: 'Adapter', description: 'Sends a habit reminder email.',
      invokedBy: { kind: 'runtime', caller: 'The nightly reminder job the composition root schedules' },
    }],
    interfaces: [{
      id: 'ireminder_adapter', component: 'reminder_adapter',
      methods: [{ name: 'remind', description: 'Sends one reminder.', params: [{ name: 'id', type: 'string' }], returns: 'string', effect: 'io' }],
    }],
    implementations: [{
      id: 'reminder_adapter_impl', contract: 'ireminder_adapter', sourcePath: 'src/reminder.ts',
      ...(binding ? { bindings: ['src/habitly-binding.ts'] } : {}),
      methods: [{ name: 'remind', detail: 'intent', intent: 'Sends the reminder email for one habit; a failed send surfaces as a thrown error.' }],
    }],
    files: {
      'libs/habitly/.wai/project.yaml': projectYaml('habitly'),
      'libs/habitly/src/habit-store.ts': STORE_FILE,
      ...(binding
        ? {
          'src/habitly-binding.ts': `${importLine}\nexport { HabitStore };\n`,
          'src/reminder.ts': "import { HabitStore } from './habitly-binding.js';\nexport function remind(id: string): string { return new HabitStore().addCheckIn(id); }\n",
        }
        : { 'src/reminder.ts': `${importLine}\nexport function remind(id: string): string { return new HabitStore().addCheckIn(id); }\n` }),
    },
  };
}

const TABLE = [
  "{ method: 'GET', path: '/habits', verb: 'listHabits' }",
  "{ method: 'GET', path: '/habits/:habitId', verb: 'getHabit' }",
  "{ method: 'POST', path: '/habits/:habitId/archive', verb: 'archiveHabit' }",
  "{ method: 'GET', path: '/me', verb: 'getMe' }",
];

export default [
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal takes the Store\'s check-in write as a value off a receiver cast to any, and invokes it a line later.',
    tree: bare(habitly({ portal: classPortal({ store: 'required', pre: 'const f = (this.store as any).addCheckIn; f(id);' }) })),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal writes a check-in through its own sink port cast to any, while the check-in Store\'s code is not written yet.',
    tree: bare(habitly({ store: null, portal: sinkPortal('(this.sink as any).addCheckIn(id);') })),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: false,
    reason: 'The cast-away port is called under the Store\'s READ, which a Portal may make.',
    scenario: 'The habit Portal reads a habit through its own sink port cast to any, while the check-in Store\'s code is not written yet.',
    tree: bare(habitly({ store: null, portal: sinkPortal('(this.sink as any).find(id);') })),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The route planner\'s planRoute takes node:http\'s IncomingMessage where its contract declares the plan request record.',
    tree: routes({ planRoute: 'req: IncomingMessage, _url: RequestUrl, _params: Record<string, string>', planBody: 'return String(req.url);' }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The route planner\'s getRouteTiles is an untyped framework handler `(req, res)` where its contract declares the route id and zoom.',
    tree: routes({ getRouteTiles: 'req, res' }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: false,
    reason: 'The handler reads the contract\'s id off the request it declares as injected, which realizes the parameter through the handle.',
    scenario: 'The route planner\'s getRoute is a framework handler `(req, res)` whose request and response are declared injected, reading the route id off the request\'s path parameters.',
    tree: (() => {
      const tree = routes({ getRoute: 'req: { params: Record<string, string> }, res: IncomingMessage', injectedParams: ['req', 'res'] });
      tree.files!['src/route-portal.ts'] = tree.files!['src/route-portal.ts'].replace(
        "getRoute(req: { params: Record<string, string> }, res: IncomingMessage): string { return 'route'; }",
        "getRoute(req: { params: Record<string, string> }, res: IncomingMessage): string { void res; return req.params.id ?? ''; }",
      );
      return tree;
    })(),
  }),
  defineRuleFixture({
    code: 'PARAM_NAME_MISMATCH',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal\'s check-in takes the day it was kept as `when: string` where its contract calls the date `date`.',
    tree: datedCheckIn('id: string, when: string', 'void when;'),
  }),
  defineRuleFixture({
    code: 'PARAM_NAME_MISMATCH',
    expectFire: false,
    reason: 'The code names the date exactly as the contract does.',
    scenario: 'The habit Portal\'s check-in takes the day it was kept as `date: string`, the contract\'s own name.',
    tree: datedCheckIn('id: string, date: string', 'void date;'),
  }),
  defineRuleFixture({
    code: 'UNUSED_INJECTED_PARAM',
    expectFire: true,
    severity: 'notice',
    scenario: 'The route planner\'s implementation still declares the request handle as injected after every handler stopped taking it.',
    tree: routes({ injectedParams: ['req'] }),
  }),
  defineRuleFixture({
    code: 'UNUSED_INJECTED_PARAM',
    expectFire: false,
    reason: 'The route lookup handler takes the request it declares as injected.',
    scenario: 'The route planner\'s getRoute takes the injected request ahead of the route id.',
    tree: routes({ getRoute: 'req: IncomingMessage, id: string', injectedParams: ['req'] }),
  }),
  defineRuleFixture({
    code: 'CROSS_PROJECT_SOURCE_IMPORT',
    expectFire: true,
    severity: 'warning',
    scenario: 'The reminder Adapter imports the habit tracker project\'s check-in Store straight out of its source tree and writes a check-in through it.',
    tree: reminders(false),
  }),
  defineRuleFixture({
    code: 'CROSS_PROJECT_SOURCE_IMPORT',
    expectFire: false,
    reason: 'The reach into the other project is carried by a binding module the implementation declares, which binding conformance compares.',
    scenario: 'The reminder Adapter reaches the habit tracker project\'s check-in Store through a binding module its implementation declares.',
    tree: reminders(true),
  }),
  defineRuleFixture({
    code: 'CALL_ACROSS_LANGUAGE',
    expectFire: true,
    severity: 'notice',
    scenario: 'The TypeScript habit Orchestrator records check-ins in a Store written in Rust, reached through a binding module.',
    tree: bare(rustStoreTree()),
  }),
  defineRuleFixture({
    code: 'CALL_ACROSS_LANGUAGE',
    expectFire: false,
    reason: 'The Store is written in TypeScript, the language of its caller.',
    scenario: 'The TypeScript habit Orchestrator records check-ins in a TypeScript Store.',
    tree: bare(habitly()),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habits API\'s central routes module carries a DELETE entry no contract endpoint declares.',
    tree: bare(centralRouterTree(ROUTES_MODULE([...TABLE, "{ method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' }"]), 'src/routes.ts#ROUTES')),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: false,
    reason: 'Every entry of the central table is a contract endpoint.',
    scenario: 'The habits API Portal names the central routes module\'s table as its router.',
    tree: bare(centralRouterTree(ROUTES_MODULE(TABLE), 'src/routes.ts#ROUTES')),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habits API router strips `/v9` off the path before matching a table written under it, while the Portal\'s basePath is `/v1`.',
    tree: bare(routerTree(STRIPPING_ROUTER('/v9'))),
  }),
  defineRuleFixture({
    code: 'UNROUTED_ENDPOINT',
    expectFire: false,
    reason: 'The prefix the router strips is the Portal\'s basePath, so every endpoint is routed.',
    scenario: 'The habits API router strips `/v1` off the path before matching a table written under it.',
    tree: bare(routerTree(STRIPPING_ROUTER('/v1'))),
  }),
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: false,
    reason: 'Template-literal keys over a const prefix settle like any other value.',
    scenario: 'The habits API router dispatches through an object keyed `VERB ${PREFIX}/…` template literals.',
    tree: bare(routerTree(PREFIX_KEYED_ROUTER())),
  }),
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: false,
    reason: 'A table returned in place is read as one bound to a name.',
    scenario: 'The habits API router reads a route table a helper returns unnamed.',
    tree: bare(routerTree(RETURNED_TABLE_ROUTER())),
  }),
];
