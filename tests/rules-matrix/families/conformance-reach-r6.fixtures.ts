/**
 * What the code reaches, round six — src/core/rules/conformance/call-conformance.ts,
 * dependency-conformance.ts, param-conformance.ts and the resolved-call and
 * module-import facts of src/core/source-analysis.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - A member picked by a key that names no single member, on a receiver that
 *    was a data component before any cast, fails closed however the receiver
 *    or the key is cast, invoked on the spot or taken as a value; a key the
 *    checker types as one literal names its member by the literal's value
 *    (PORTAL_CALL_UNRESOLVED, CALL_ORIGIN_UNRESOLVED).
 *  - A claimed call through a port to a collaborator whose code is not written
 *    yet is planned, not unresolved (CALL_TARGET_PLANNED, a notice).
 *  - An undeclared workflow verb's effect is read off its own narrative: a
 *    Portal's unnarrated call to a verb that only reads is no unnarrated
 *    mutation (UNDECLARED_WRITE_CALL quiet).
 *  - An underscore-named parameter the analysis proves unused is set aside,
 *    never undeclared (UNDECLARED_PARAM quiet on a node:http handler).
 *  - A technology package imported by an unowned helper module is its
 *    importer's (TECH_LEAKAGE_IN_CODE).
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';
import { habitly, NO_FIELD, orchestratorFile, portalFile, type HabitlyOptions } from '../../helpers/conformance-r6-trees.js';

/** Habitly without its own project.yaml: the harness writes the fixture's. */
function tree(o: HabitlyOptions = {}): FixtureTree {
  const t = habitly(o);
  const files = { ...(t.files ?? {}) };
  delete files['.wai/project.yaml'];
  return { ...t, files };
}

const PORT_ORCHESTRATOR = [
  'export interface Checkins {',
  '  addCheckIn(id: string): string;',
  '  find(id: string): string;',
  '}',
  'export class HabitOrchestrator {',
  '  constructor(private readonly checkins: Checkins) {}',
  '  checkIn(id: string): string { this.checkins.find(id); return this.checkins.addCheckIn(id); }',
  '  streak(id: string): string { return this.checkins.find(id); }',
  '  archive(id: string): string { return id; }',
  '}', '',
].join('\n');

const DB = "import { Client } from 'pg';\nexport const db = new Client();\n";

export default [
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal picks the check-in Store\'s write by a const name through a cast to any — `(this.checkins as any)[name](id)` — so the call names no member the checker can resolve.',
    tree: tree({ portal: portalFile({ body: "const name = 'addCheckIn'; (this.checkins as any)[name](id);" }) }),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: false,
    reason: 'The const key names the Store\'s READ, which a Portal may make.',
    scenario: 'The habit Portal reads a check-in by a const name through a cast to any.',
    tree: tree({ portal: portalFile({ body: "const name = 'find'; (this.checkins as any)[name](id);" }) }),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Orchestrator\'s read-narrated streak takes a Store member by a key built from an expression and invokes it later through call() — an unnarrated write the checker cannot name.',
    tree: tree({ orchestrator: orchestratorFile({ extra: "const k = ('add' + 'CheckIn') as keyof HabitStore; const f = this.checkins[k] as unknown as (x: string) => string; f.call(this.checkins, id);" }) }),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason: 'The Store is unwritten: the port-typed calls are planned, not unresolved.',
    scenario: 'The habit Orchestrator was implemented first from its brief, typing the Store it calls by a port of its own while the Store\'s file is still planned.',
    tree: tree({ store: null, orchestrator: PORT_ORCHESTRATOR }),
  }),
  defineRuleFixture({
    code: 'CALL_TARGET_PLANNED',
    expectFire: true,
    severity: 'notice',
    anchoredTo: 'habit_orchestrator_impl',
    scenario: 'The habit Orchestrator was implemented first from its brief, typing the Store it calls by a port of its own while the Store\'s file is still planned.',
    tree: tree({ store: null, orchestrator: PORT_ORCHESTRATOR }),
  }),
  defineRuleFixture({
    code: 'CALL_TARGET_PLANNED',
    expectFire: false,
    reason: 'The Store\'s file exists, so its realization has begun and the claims are judged as usual.',
    scenario: 'The habit Orchestrator calls the check-in Store it imports, the Store written beside it.',
    tree: tree(),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_WRITE_CALL',
    expectFire: false,
    reason: 'archive declares no effect, but its own narrative only reads the Store: inferred read.',
    scenario: 'The habit Portal looks the habit up through the Orchestrator\'s archive verb, whose narrative only reads the check-in Store, before dispatching the check-in.',
    tree: tree({ portal: portalFile({ body: 'this.habits.archive(id);', field: NO_FIELD, head: '' }), archiveCalls: 'find' }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_WRITE_CALL',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal calls the Orchestrator\'s archive verb, which declares no effect but whose narrative records a check-in, without narrating it.',
    tree: tree({ portal: portalFile({ body: 'this.habits.archive(id);', field: NO_FIELD, head: '' }), archiveCalls: 'addCheckIn' }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    expectFire: false,
    reason: 'The leading request and URL are underscore-named and provably unused, and the handler takes the contract\'s own id after them.',
    scenario: 'The habit Portal\'s check-in is a node:http handler `(_req, _url, id)` realizing `checkIn(id)`, the router unpacking the id.',
    tree: tree({ portal: portalFile({ signature: '_req: object, _url: URL, id: string', field: NO_FIELD, head: '' }) }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal\'s check-in handler takes the request and URL under plain names the contract never mentions.',
    tree: tree({ portal: portalFile({ signature: 'req: object, url: URL, params: Record<string, string>', field: NO_FIELD, head: '', dispatch: "params.id ?? ''" }) }),
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE_IN_CODE',
    expectFire: true,
    severity: 'warning',
    scenario: 'The habit Portal imports a db.ts helper module that opens a Postgres client, while the check-in Store is Postgres\'s home.',
    tree: tree({ postgres: true, portal: portalFile({ field: NO_FIELD, head: "import { db } from './db.js';", body: 'void db;' }), files: { 'src/db.ts': DB } }),
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE_IN_CODE',
    expectFire: false,
    reason: 'Only the Store, Postgres\'s home, imports the helper.',
    scenario: 'The check-in Store imports the db.ts helper module that opens its Postgres client.',
    tree: tree({
      postgres: true,
      store: "import { db } from './db.js';\nexport class HabitStore {\n  addCheckIn(id: string): string { void db; return id; }\n  find(id: string): string { return id; }\n}\n",
      files: { 'src/db.ts': DB },
    }),
  }),
];
