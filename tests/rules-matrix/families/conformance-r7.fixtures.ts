/**
 * What the code reaches, round seven — src/core/rules/conformance/param-conformance.ts,
 * call-conformance.ts, dependency-conformance.ts, route-coverage.ts and the
 * parameter, receiver, route and cross-project-import facts of
 * src/core/source-analysis.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - A leading underscore means UNUSED and is set aside only where the
 *    analysis proves it; a used `_secret` is judged like any parameter
 *    (UNDECLARED_PARAM).
 *  - A paired parameter whose name differs and whose kind of value differs is
 *    a substitution: the declared one unrealized, the code's undeclared
 *    (UNREALIZED_PARAM); the honest node:http shape has one green path —
 *    the handles injected, the contract's parameters after them.
 *  - The receiver's original type is read the way the code means it: an
 *    `await (x)` outside an async function as x, an optional field as the
 *    class it holds (PORTAL_CALL_UNRESOLVED); a call landing only on a port
 *    no written class realizes, under a planned data component's write, fails
 *    closed too.
 *  - A member of a workflow component's class its contract does not declare is
 *    that component's code: a code-only rename is CALL_STEP_UNREALIZED naming
 *    the method the code calls instead, never PORTAL_WRITE_SHORTCUT_IN_CODE;
 *    a Portal's call to one is UNDECLARED_WRITE_CALL.
 *  - Routes are read through constants, a stripped prefix and route tables;
 *    a table any entry of which does not settle is UNREADABLE_ROUTER.
 *  - An import from another project's source that resolves to nothing is
 *    CROSS_PROJECT_IMPORT_UNRESOLVED.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';
import { habitly, orchestratorFile, type HabitlyOptions } from '../../helpers/conformance-r6-trees.js';
import {
  classPortal,
  HABIT_TABLE,
  PREFIX_ROUTER,
  TABLE_CONSTANTS,
  crossProjectPlatform,
  routePortalTree,
  routerTree,
  tableRouter,
  type RoutePortalOptions,
} from '../../helpers/conformance-r7-trees.js';

/** A tree without its own project.yaml: the harness writes the fixture's. */
function bare(t: FixtureTree): FixtureTree {
  const files = { ...(t.files ?? {}) };
  delete files['.wai/project.yaml'];
  return { ...t, files };
}
const habits = (o: HabitlyOptions = {}): FixtureTree => bare(habitly(o));
const routes = (o: RoutePortalOptions): FixtureTree => bare(routePortalTree(o));

/** The platform gateway importing from the contracts project nested in its repository. */
function platform(importLine: string): FixtureTree {
  const { platform: t, contracts } = crossProjectPlatform(importLine.replace('../../contracts/', '../libs/contracts/'));
  const files: Record<string, string> = { ...bare(t).files };
  for (const [rel, text] of Object.entries(contracts)) files[`libs/contracts/${rel}`] = text;
  return { ...t, files };
}

const portPortal = (call: string): string => [
  "import type { HabitOrchestrator } from './habit-orchestrator.js';",
  'export interface CheckinSink { addCheckIn(id: string): string; find(id: string): string; }',
  'export class HabitPortal {',
  '  constructor(private readonly habits: HabitOrchestrator, private readonly sink: CheckinSink) {}',
  `  checkIn(id: string): string { this.sink.${call}(id); return this.habits.checkIn(id); }`,
  '}', '',
].join('\n');

const callingPortal = (calls: string): string => [
  "import type { HabitOrchestrator } from './habit-orchestrator.js';",
  'export class HabitPortal {',
  '  constructor(private readonly habits: HabitOrchestrator) {}',
  `  checkIn(id: string): string { ${calls} }`,
  '}', '',
].join('\n');

const RENAMED_ORCHESTRATOR = orchestratorFile().replace('checkIn(id: string): string {', 'complete(id: string): string {');

export default [
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The route planner\'s planRoute takes a credential `_secret` it reads, ahead of the plan request — one character away from the unused-parameter mark.',
    tree: routes({ planRoute: '_secret: string, request: PlanRequest', planBody: "return _secret.length > 0 ? 'planned' : 'refused';" }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    expectFire: false,
    reason: 'The leading request handle is underscore-named and provably unused.',
    scenario: 'The route planner\'s getRoute is a node:http handler `(_req, id)` that never reads the request it is handed.',
    tree: routes({ getRoute: '_req: IncomingMessage, id: string' }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The route planner\'s getRoute takes the router\'s whole params record where its contract declares the route id — an object in the place of a string.',
    tree: routes({ getRoute: '_req: IncomingMessage, _url: RequestUrl, params: Record<string, string>' }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_PARAM',
    expectFire: false,
    reason: 'The transport handles are injected, and the handler takes the contract\'s own parameters after them.',
    scenario: 'The route planner\'s getRouteTiles is a node:http handler `(req, url, id, zoom?)` with the request and URL declared as injected.',
    tree: routes({ getRouteTiles: 'req: IncomingMessage, url: RequestUrl, id: string, zoom?: number', injectedParams: ['req', 'url'] }),
  }),
  defineRuleFixture({
    code: 'PARAM_OPTIONALITY',
    expectFire: false,
    reason: 'The URL object is no realization of the optional zoom; the bag is a substitution, reported as such.',
    scenario: 'The route planner\'s getRouteTiles is a node:http handler `(req, url, params)` realizing `getRouteTiles(id, zoom?)`.',
    tree: routes({ getRouteTiles: 'req: IncomingMessage, url: RequestUrl, params: Record<string, string>' }),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal class writes `await (this.store as any).addCheckIn(id)` in a check-in method that is not async, its Store an optional constructor field.',
    tree: habits({ portal: classPortal({ store: 'optional', pre: 'await (this.store as any).addCheckIn(id);' }) }),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal writes a check-in through a sink port of its own while the check-in Store\'s code is not written yet.',
    tree: habits({ store: null, portal: portPortal('addCheckIn') }),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: false,
    reason: 'The port call carries the name of the Store\'s READ, which a Portal may make.',
    scenario: 'The habit Portal reads a habit through a sink port of its own while the check-in Store\'s code is not written yet.',
    tree: habits({ store: null, portal: portPortal('find') }),
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT_IN_CODE',
    expectFire: false,
    reason: 'The Portal calls its Orchestrator, under a name the design has not caught up with — a rename, not a shortcut.',
    scenario: 'The habit Orchestrator\'s checkIn was renamed `complete` in the code only, and the habit Portal calls `this.habits.complete(id)`.',
    tree: habits({ orchestrator: RENAMED_ORCHESTRATOR, portal: callingPortal('return this.habits.complete(id);') }),
  }),
  defineRuleFixture({
    code: 'CALL_STEP_UNREALIZED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Orchestrator\'s checkIn was renamed `complete` in the code only, so the habit Portal\'s narrated call to checkIn no longer lands.',
    tree: habits({ orchestrator: RENAMED_ORCHESTRATOR, portal: callingPortal('return this.habits.complete(id);') }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_WRITE_CALL',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal also calls the Orchestrator\'s `purge`, a method of its class the habit Orchestrator\'s contract never declares.',
    tree: habits({
      orchestrator: orchestratorFile().replace('  archive(id: string): string { return id; }', '  archive(id: string): string { return id; }\n  purge(id: string): string { return this.checkins.addCheckIn(id); }'),
      portal: callingPortal('this.habits.purge(id); return this.habits.checkIn(id);'),
    }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: false,
    reason: 'The router strips BASE = /v1/habits, the same URLs the endpoints name under basePath /v1.',
    scenario: 'The habits API router slices `/v1/habits` off the path before splitting it, while the Portal\'s basePath is `/v1`.',
    tree: bare(routerTree(PREFIX_ROUTER)),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_ROUTE',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habits API route table carries a DELETE /habits/:habitId entry no contract endpoint declares.',
    tree: bare(routerTree(`${TABLE_CONSTANTS}\n${tableRouter([...HABIT_TABLE, "{ method: 'DELETE', path: '/habits/:habitId', verb: 'deleteHabit' }"])}`)),
  }),
  defineRuleFixture({
    code: 'UNROUTED_ENDPOINT',
    expectFire: false,
    reason: 'Every endpoint has a table entry, its path settled through constants and a template literal.',
    scenario: 'The habits API answers through a route table its router reads in a helper, each entry pairing a method with a path.',
    tree: bare(routerTree(`${TABLE_CONSTANTS}\n${tableRouter(HABIT_TABLE)}`)),
  }),
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habits API route table holds an entry whose path is computed at run time, so the table cannot be read without guessing.',
    tree: bare(routerTree(`${TABLE_CONSTANTS}\n${tableRouter([...HABIT_TABLE, "{ method: 'GET', path: String(Date.now()), verb: 'clock' }"])}`)),
  }),
  defineRuleFixture({
    code: 'UNREADABLE_ROUTER',
    expectFire: false,
    reason: 'Every table entry settles, so the table is read.',
    scenario: 'The habits API answers through a route table whose entries are all literal or constant.',
    tree: bare(routerTree(`${TABLE_CONSTANTS}\n${tableRouter(HABIT_TABLE)}`)),
  }),
  defineRuleFixture({
    code: 'CROSS_PROJECT_IMPORT_UNRESOLVED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The platform gateway imports the type CustomerId from the contracts project\'s ids module, which now exports only CustomerRef.',
    tree: platform("import type { CustomerId } from '../../contracts/src/ids.js';"),
  }),
  defineRuleFixture({
    code: 'CROSS_PROJECT_IMPORT_UNRESOLVED',
    expectFire: false,
    reason: 'The imported name is one the contracts module exports.',
    scenario: 'The platform gateway imports the type CustomerRef from the contracts project\'s ids module.',
    tree: platform("import type { CustomerRef } from '../../contracts/src/ids.js';"),
  }),
];
