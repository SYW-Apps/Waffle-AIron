/**
 * What the code reaches, read on principle rather than per shape (round-5
 * trials) — src/core/rules/conformance/call-conformance.ts,
 * dependency-conformance.ts, param-conformance.ts and the type-shape facts of
 * src/core/source-analysis.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - UNOWNED code is transparent: a function in a file no component realizes,
 *    or one that is none of its file's components' modelled methods, is read
 *    as if inlined where it is called (PORTAL_WRITE_SHORTCUT_IN_CODE,
 *    UNDECLARED_WRITE_CALL).
 *  - A REFERENCE to a function or method the code takes as a value is a use:
 *    a Portal handing a data component's write to Reflect.apply is the
 *    shortcut.
 *  - A computed member on a receiver that was a data component before a cast
 *    fails closed (PORTAL_CALL_UNRESOLVED).
 *  - An unresolvable receiver under the name of an unclaimed write fails
 *    closed outside a Portal too (CALL_ORIGIN_UNRESOLVED, the fail-closed half
 *    of UNDECLARED_WRITE_CALL).
 *  - A Portal's unnarrated call to a workflow verb whose effect is not
 *    declared read or none is an unnarrated mutation (UNDECLARED_WRITE_CALL).
 *  - A declared edge is realized by a call the type checker lands across it,
 *    whatever the imports look like (UNREALIZED_DEPENDENCY quiet).
 *  - UNDECLARED_PARAM names an inserted leading parameter the names prove.
 *  - A private field a getter reads is backing storage, not data
 *    (UNDECLARED_TYPE_FIELD quiet).
 */
import { defineRuleFixture } from '../harness.js';

interface Habits {
  /** The Portal's checkIn body, before the narrated dispatch. */
  portalBody?: string;
  /** Extra lines at the top of the Portal file. */
  portalHead?: string;
  /** The tracker's `history` body, before its narrated read. */
  trackerBody?: string;
  /** Whether the tracker's archive verb declares an effect. */
  archiveEffect?: string;
  /** The tracker file, replaced whole. */
  trackerFile?: string;
  files?: Record<string, string>;
}

const STORE_FILE = 'export class CheckinRepository {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n';

/** A habit Portal -> tracker Orchestrator -> check-in Repository, one file each. */
function habitTree(h: Habits = {}) {
  return {
    subsystems: [{ id: 'habits', description: 'Daily habit tracking and check-ins.' }],
    components: [
      { id: 'checkin-repository', componentType: 'Repository', subsystem: 'habits', description: 'Holds the check-ins.' },
      { id: 'habit-tracker', componentType: 'Orchestrator', subsystem: 'habits', description: 'Records and reads check-ins.', dependsOn: ['checkin-repository'] },
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
      {
        id: 'ihabit_tracker',
        component: 'habit-tracker',
        methods: [
          { name: 'checkIn', description: 'Check a habit in for today.', params: [{ name: 'id', type: 'string' }], returns: 'string' },
          { name: 'history', description: 'Read a habit\'s check-ins.', effect: 'read', params: [{ name: 'id', type: 'string' }], returns: 'string' },
          { name: 'archive', description: 'Retire a habit.', ...(h.archiveEffect ? { effect: h.archiveEffect } : {}), params: [{ name: 'id', type: 'string' }], returns: 'string' },
        ],
      },
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
        methods: [
          { name: 'checkIn', narrative: [
            { stepNumber: 1, type: 'call', description: 'Record the check-in', targetComponent: 'checkin-repository', targetMethod: 'record' },
            { stepNumber: 2, type: 'return', description: 'Done', outcome: 'done' },
          ] },
          { name: 'history', narrative: [
            { stepNumber: 1, type: 'call', description: 'Read the check-in', targetComponent: 'checkin-repository', targetMethod: 'find' },
            { stepNumber: 2, type: 'return', description: 'Done', outcome: 'done' },
          ] },
          { name: 'archive', detail: 'intent', intent: 'Marks the habit retired; an unknown habit is refused with an error.' },
        ],
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
      'src/repo.ts': STORE_FILE,
      'src/tracker.ts': h.trackerFile ?? [
        "import type { CheckinRepository } from './repo.js';",
        'export class HabitTracker {',
        '  constructor(private readonly checkins: CheckinRepository) {}',
        '  checkIn(id: string): string { return this.checkins.record(id); }',
        `  history(id: string): string { ${h.trackerBody ?? ''} return this.checkins.find(id); }`,
        '  archive(id: string): string { return id; }',
        '}',
        '',
      ].join('\n'),
      'src/web.ts': [
        "import type { HabitTracker } from './tracker.js';",
        "import type { CheckinRepository } from './repo.js';",
        h.portalHead ?? '',
        'export class HabitPortal {',
        '  constructor(private readonly tracker: HabitTracker, private readonly checkins: CheckinRepository) {}',
        `  checkIn(id: string): string { ${h.portalBody ?? ''} return this.tracker.checkIn(id); }`,
        '}',
        '',
      ].join('\n'),
      ...(h.files ?? {}),
    },
  };
}

const PERSIST = (method: string) => ({
  'src/persist.ts': `import type { CheckinRepository } from './repo.js';\nexport function persistCheckin(repo: CheckinRepository, id: string): void { repo.${method}(id); }\n`,
});

/** A money value object whose class keeps its data behind getters. */
function moneyTree(constructorParams: string) {
  return {
    subsystems: [{ id: 'ledger', description: 'Amounts and their currencies.' }],
    types: [{
      id: 'money',
      name: 'Money',
      kind: 'value-object',
      subsystem: 'ledger',
      description: 'An amount in minor units of one currency.',
      sourcePath: 'src/money.ts',
      fields: [
        { name: 'amountMinor', type: 'int', description: 'The amount in the currency\'s minor unit.' },
        { name: 'currency', type: 'string', description: 'The ISO 4217 code.' },
      ],
    }],
    files: {
      'src/money.ts': [
        'export class Money {',
        `  constructor(${constructorParams}) {}`,
        '  get amountMinor(): number { return this.minor; }',
        '  get currency(): string { return this.code; }',
        '}',
        '',
      ].join('\n'),
    },
  };
}

/** An order flow whose contract takes the order id alone. */
function fulfilmentTree(signature: string) {
  return {
    subsystems: [{ id: 'orders', description: 'Order intake and fulfilment.' }],
    components: [{ id: 'fulfilment-flow', componentType: 'Orchestrator', subsystem: 'orders', description: 'Fulfils a paid order.' }],
    interfaces: [{
      id: 'ifulfilment_flow',
      component: 'fulfilment-flow',
      methods: [{ name: 'fulfillOrder', description: 'Fulfil one paid order.', params: [{ name: 'orderId', type: 'string', description: 'The paid order.' }], returns: 'string' }],
    }],
    implementations: [{
      id: 'fulfilment_flow_impl',
      contract: 'ifulfilment_flow',
      sourcePath: 'src/fulfil.ts',
      methods: [{ name: 'fulfillOrder', detail: 'intent', intent: 'Ships the paid order and answers its tracking code; an unpaid order is refused.' }],
    }],
    files: { 'src/fulfil.ts': `export function fulfillOrder(${signature}): string { return 'tracked'; }\n` },
  };
}

export default [
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT_IN_CODE',
    severity: 'error',
    anchoredTo: 'habit_portal_impl',
    expectFire: true,
    scenario: 'The habit Portal hands its repository to a persistence helper in a module no component maps, and the helper records the check-in.',
    tree: habitTree({ portalHead: "import { persistCheckin } from './persist.js';", portalBody: 'persistCheckin(this.checkins, id);', files: PERSIST('record') }),
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT_IN_CODE',
    expectFire: false,
    reason: 'The unowned helper only READS the repository, which a Portal may do: reading the helper as inlined finds the read and nothing to refuse.',
    scenario: 'The habit Portal hands its repository to a helper in a module no component maps, and the helper only looks the check-in up.',
    tree: habitTree({ portalHead: "import { persistCheckin } from './persist.js';", portalBody: 'persistCheckin(this.checkins, id);', files: PERSIST('find') }),
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT_IN_CODE',
    severity: 'error',
    anchoredTo: 'habit_portal_impl',
    expectFire: true,
    scenario: 'The habit Portal invokes the repository\'s write through Reflect.apply, passing the method as a value.',
    tree: habitTree({ portalBody: 'Reflect.apply(this.checkins.record, this.checkins, [id]);' }),
  }),
  defineRuleFixture({
    code: 'PORTAL_WRITE_SHORTCUT_IN_CODE',
    expectFire: false,
    reason: 'A reference to the repository\'s READ is a use too, and a read is the licensed Portal-to-data path.',
    scenario: 'The habit Portal invokes the repository\'s read through Reflect.apply before dispatching to the tracker.',
    tree: habitTree({ portalBody: 'Reflect.apply(this.checkins.find, this.checkins, [id]);' }),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'habit_portal_impl',
    expectFire: true,
    scenario: 'The habit Portal casts its repository to a string-keyed record of functions and calls a member whose name it assembles from a template.',
    tree: habitTree({ portalBody: '(this.checkins as unknown as Record<string, (x: string) => string>)[`rec${\'ord\'}`](id);' }),
  }),
  defineRuleFixture({
    code: 'PORTAL_CALL_UNRESOLVED',
    expectFire: false,
    reason: 'The computed key picks a member of a table that never was a data component, so nothing a cast hid is in question.',
    scenario: 'The habit Portal formats the habit id through a local table of formatters it indexes with a computed key.',
    tree: habitTree({ portalBody: 'const formats: Record<string, (x: string) => string> = { plain: (x) => x }; formats[`p${\'lain\'}`](id);' }),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'habit_tracker_impl',
    expectFire: true,
    scenario: 'The tracker\'s read-narrated history method also records a check-in through its repository cast to any.',
    tree: habitTree({ trackerBody: '(this.checkins as any).record(id);' }),
  }),
  defineRuleFixture({
    code: 'CALL_ORIGIN_UNRESOLVED',
    expectFire: false,
    reason: 'Only the name of a write fails closed: a read through the same cast is no unnarrated mutation in disguise.',
    scenario: 'The tracker\'s history method reads a check-in through its repository cast to any.',
    tree: habitTree({ trackerBody: '(this.checkins as any).find(id);' }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_WRITE_CALL',
    severity: 'warning',
    anchoredTo: 'habit_portal_impl',
    expectFire: true,
    scenario: 'The habit Portal also archives the habit through the tracker\'s archive verb, which declares no effect and which its narrative never names.',
    tree: habitTree({ portalBody: 'this.tracker.archive(id);' }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_WRITE_CALL',
    expectFire: false,
    reason: 'A workflow verb the contract declares read changes no state, so a Portal reaching it unnarrated is no hidden mutation.',
    scenario: 'The habit Portal also calls the tracker\'s archive verb, which the contract declares a read.',
    tree: habitTree({ portalBody: 'this.tracker.archive(id);', archiveEffect: 'read' }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_DEPENDENCY',
    expectFire: false,
    reason: 'The tracker types its repository by a port declared in a shared module and imports nothing of the repository\'s file, but the type checker lands its calls on the class realizing the port — the declared edge is realized.',
    scenario: 'The tracker reaches the check-in repository through a port interface declared in a shared ports module, which the repository class implements.',
    tree: habitTree({
      trackerFile: [
        "import type { CheckinPort } from './ports.js';",
        'export class HabitTracker {',
        '  constructor(private readonly checkins: CheckinPort) {}',
        '  checkIn(id: string): string { return this.checkins.record(id); }',
        '  history(id: string): string { return this.checkins.find(id); }',
        '  archive(id: string): string { return id; }',
        '}',
        '',
      ].join('\n'),
      files: {
        'src/ports.ts': 'export interface CheckinPort {\n  record(id: string): string;\n  find(id: string): string;\n}\n',
        'src/repo.ts': "import type { CheckinPort } from './ports.js';\nexport class CheckinRepository implements CheckinPort {\n  record(id: string): string { return id; }\n  find(id: string): string { return id; }\n}\n",
      },
    }),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_DEPENDENCY',
    severity: 'warning',
    expectFire: true,
    scenario: 'The tracker declares the check-in repository but neither imports it nor calls it: it keeps check-ins in memory of its own.',
    tree: habitTree({
      trackerFile: [
        'export class HabitTracker {',
        '  checkIn(id: string): string { return id; }',
        '  history(id: string): string { return id; }',
        '  archive(id: string): string { return id; }',
        '}',
        '',
      ].join('\n'),
    }),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    severity: 'warning',
    anchoredTo: 'fulfilment_flow_impl',
    expectFire: true,
    scenario: 'The fulfilment flow grew a leading requester parameter in front of the order id its contract declares.',
    tree: fulfilmentTree('requester: string, orderId: string'),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_PARAM',
    expectFire: false,
    reason: 'The realization takes exactly the order id the contract declares.',
    scenario: 'The fulfilment flow takes the order id its contract declares and nothing else.',
    tree: fulfilmentTree('orderId: string'),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_TYPE_FIELD',
    expectFire: false,
    reason: 'The private fields are the getters\' backing storage — implementation, not the value\'s data — and the getters answer for the two declared fields.',
    scenario: 'The money value keeps its amount and currency in private constructor fields read by public getters.',
    tree: moneyTree('private readonly minor: number, private readonly code: string'),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_TYPE_FIELD',
    severity: 'warning',
    anchoredTo: 'money',
    expectFire: true,
    scenario: 'The money value keeps a private rounding mode no getter exposes beside the fields its getters read.',
    tree: moneyTree('private readonly minor: number, private readonly code: string, private readonly rounding: number'),
  }),
];
