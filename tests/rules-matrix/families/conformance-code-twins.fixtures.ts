/**
 * The code twins of two design rules — src/core/rules/conformance/dependency-conformance.ts.
 *
 * Documented intents pinned here (rule description):
 *  - PORTAL_WRITE_SHORTCUT_IN_CODE (error): a Portal's own method calls a
 *    write- or lifecycle-effect contract method of a Repository, Index, Store or
 *    Registry — through a collaborator its file types, or a proven binding —
 *    that its narrative does not claim. The code twin of PORTAL_WRITE_SHORTCUT.
 *  - TECH_LEAKAGE_IN_CODE (warning): a file imports a technology's package — a
 *    bare specifier whose package name is one of the technology's declared
 *    tokens, compared exactly — while no component it realizes is that
 *    technology's home. The code twin of TECH_LEAKAGE.
 */
import { defineRuleFixture } from '../harness.js';

/** A Portal whose own method also writes the repository through a constructor-injected, type-only-imported collaborator. */
function habitTree(portalBody: string) {
  return {
    subsystems: [{ id: 'habits', description: 'Daily habit tracking and check-ins.' }],
    components: [
      { id: 'checkin-repository', componentType: 'Repository', subsystem: 'habits', description: 'Holds the check-ins.' },
      { id: 'habit-tracker', componentType: 'Orchestrator', subsystem: 'habits', description: 'Records a check-in.', dependsOn: ['checkin-repository'] },
      { id: 'habit-portal', componentType: 'Portal', transport: 'InProcess', subsystem: 'habits', description: 'The habit API.', dependsOn: ['habit-tracker'] },
    ],
    interfaces: [
      {
        id: 'icheckin_repository',
        component: 'checkin-repository',
        methods: [
          { name: 'record', description: 'Record one check-in.', effect: 'write', params: [{ name: 'id', type: 'string' }], returns: 'string' },
          { name: 'find', description: 'Find one check-in.', effect: 'read', params: [{ name: 'id', type: 'string' }], returns: 'string' },
        ],
      },
      { id: 'ihabit_tracker', component: 'habit-tracker', methods: [{ name: 'checkIn', description: 'Check a habit in for today.', params: [{ name: 'id', type: 'string' }], returns: 'string' }] },
      { id: 'ihabit_portal', component: 'habit-portal', methods: [{ name: 'checkIn', description: 'Check a habit in for today.', params: [{ name: 'id', type: 'string' }], returns: 'string' }] },
    ],
    implementations: [
      {
        id: 'checkin_repository_impl',
        contract: 'icheckin_repository',
        sourcePath: 'src/repo.ts',
        methods: [
          { name: 'record', detail: 'intent', intent: 'Stores the check-in under its id; a duplicate id is refused with an error.' },
          { name: 'find', detail: 'intent', intent: 'Answers the check-in stored under the id; an unknown id answers nothing.' },
        ],
      },
      {
        id: 'habit_tracker_impl',
        contract: 'ihabit_tracker',
        sourcePath: 'src/tracker.ts',
        methods: [{ name: 'checkIn', narrative: [
          { stepNumber: 1, type: 'call', description: 'Record the check-in', targetComponent: 'checkin-repository', targetMethod: 'record' },
          { stepNumber: 2, type: 'return', description: 'Done', outcome: 'done' },
        ] }],
      },
      {
        id: 'habit_portal_impl',
        contract: 'ihabit_portal',
        sourcePath: 'src/web.ts',
        methods: [{ name: 'checkIn', narrative: [
          { stepNumber: 1, type: 'call', description: 'Dispatch to the tracker', targetComponent: 'habit-tracker', targetMethod: 'checkIn' },
          { stepNumber: 2, type: 'return', description: 'Done', outcome: 'done' },
        ] }],
      },
    ],
    files: {
      'src/repo.ts': 'export class CheckinRepository {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n',
      'src/tracker.ts': [
        "import type { CheckinRepository } from './repo.js';",
        'export class HabitTracker {',
        '  constructor(private readonly checkins: CheckinRepository) {}',
        '  checkIn(id: string): string { return this.checkins.record(id); }',
        '}',
        '',
      ].join('\n'),
      'src/web.ts': [
        "import type { HabitTracker } from './tracker.js';",
        "import type { CheckinRepository } from './repo.js';",
        'export class HabitPortal {',
        '  constructor(private readonly tracker: HabitTracker, private readonly checkins: CheckinRepository) {}',
        `  checkIn(id: string): string { ${portalBody} return this.tracker.checkIn(id); }`,
        '}',
        '',
      ].join('\n'),
    },
  };
}

/** A Store binding postgres (its package `pg` among its tokens), and a Portal file importing a package. */
function storeTree(portalImport: string) {
  return {
    subsystems: [{ id: 'links', description: 'Short links and their hits.' }],
    components: [
      { id: 'link-store', componentType: 'Store', subsystem: 'links', description: 'Persists the links.', durability: 'read-through' },
      { id: 'link-portal', componentType: 'Portal', transport: 'InProcess', subsystem: 'links', description: 'The link API.' },
    ],
    interfaces: [
      { id: 'ilink_store', component: 'link-store', methods: [{ name: 'save', description: 'Save one link.', effect: 'write' }] },
      { id: 'ilink_portal', component: 'link-portal', methods: [{ name: 'resolve', description: 'Resolve a short code.' }] },
    ],
    implementations: [
      {
        id: 'link_store_impl',
        contract: 'ilink_store',
        sourcePath: 'src/store.ts',
        technologies: [{ name: 'postgres', matches: ['pg', 'postgres'] }],
        methods: [{ name: 'save', detail: 'intent', intent: 'Inserts the link row; a duplicate short code is refused with an error.' }],
      },
      {
        id: 'link_portal_impl',
        contract: 'ilink_portal',
        sourcePath: 'src/portal.ts',
        methods: [{ name: 'resolve', detail: 'intent', intent: 'Answers the target of a short code; an unknown code answers a not-found error.' }],
      },
    ],
    files: {
      'src/store.ts': "import { Pool } from 'pg';\nexport function save(): void { void Pool; }\n",
      'src/portal.ts': `${portalImport}\nexport function resolve(): void {}\n`,
    },
  };
}

export default [
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT_IN_CODE',
    severity: 'error',
    anchoredTo: 'habit_portal_impl',
    expectFire: true,
    scenario:
      'The habit Portal narrates a call to the tracker, but its code also calls the repository\'s write method through a constructor-injected collaborator typed by a type-only import.',
    tree: habitTree('this.checkins.record(id);'),
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT_IN_CODE',
    expectFire: false,
    reason: 'A READ through the same collaborator is the licensed Portal-to-data shortcut; only a write or lifecycle method is the shortcut in disguise.',
    scenario: 'The habit Portal reads the repository through its injected collaborator before dispatching to the tracker.',
    tree: habitTree('this.checkins.find(id);'),
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE_IN_CODE',
    severity: 'warning',
    anchoredTo: 'link_portal_impl',
    expectFire: true,
    scenario: 'The link Portal imports `pg`, the package of the postgres technology the link store binds.',
    tree: storeTree("import { Pool } from 'pg';\nvoid Pool;"),
  }),
  defineRuleFixture({
    code: 'TECH_LEAKAGE_IN_CODE',
    expectFire: false,
    reason: 'A package is a technology\'s only when its tokens, the curated built-in table or a pack name it: a query builder that speaks to many databases is no postgres package, and an HTTP client is never a technology.',
    scenario: 'The link Portal imports `kysely`, a query builder neither the postgres binding nor the built-in table names.',
    tree: storeTree("import { Kysely } from 'kysely';\nvoid Kysely;"),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    severity: 'notice',
    anchoredTo: 'habit_portal_impl',
    expectFire: true,
    scenario:
      'The habit Portal calls `record` — the repository\'s write — on a store it builds through an untyped factory, so nothing in its file says what the receiver is.',
    tree: habitTree('const store = (globalThis as any).makeStore(); store.record(id);'),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: false,
    reason: 'A receiver followed through a non-null assertion is the declared field itself: the write is judged (the shortcut), never left unresolved.',
    scenario: 'The habit Portal calls the repository\'s write through its injected field with a non-null assertion.',
    tree: habitTree('this.checkins!.record(id);'),
  }),
];
