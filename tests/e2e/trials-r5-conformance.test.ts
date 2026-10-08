import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, type TrialSandbox } from './trials-helpers';

// ---------------------------------------------------------------------------
// Round-5 user trials: the Portal-write bypasses round 4 left open, closed on
// principle (unowned code read as inlined, a reference is a use, a computed
// member fails closed), the Orchestrator's fail-closed twin, a Portal's
// unnarrated workflow verb — and the honest dependency-injection layouts that
// were red (solo-app H5/H6/H7/H9), which must be clean.
//
// Each bypass runs twice: writing (habit_store.addCheckIn, write effect) and,
// as its control, the same spelling READING (habit_store.find).
//
// Fixture: Habitly — Portal habit_portal -> Orchestrator habit_orchestrator ->
// standalone Store habit_store.
// ---------------------------------------------------------------------------

const INTENT = 'Performs its one thing against held state; failures surface as thrown errors.';
const intent = (name: string): Record<string, unknown> => ({ name, detail: 'intent', intent: INTENT });
const method = (name: string, effect?: string): Record<string, unknown> => ({
  name,
  description: `${name} does its one thing, carefully and observably`,
  params: [{ name: 'id', type: 'string', description: 'The id of the habit the call is about' }],
  returns: 'string',
  ...(effect ? { effect } : {}),
});

const PROJECT_YAML = yaml.dump({
  schemaVersion: '1.0.0',
  id: 'habitly',
  name: 'habitly',
  targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
  extensions: { packs: [], useGlobalPacks: false },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const STORE_FILE = [
  'export class HabitStore {',
  '  addCheckIn(id: string): string { return id; }',
  '  find(id: string): string { return id; }',
  '}', '',
].join('\n');

const ORCHESTRATOR_FILE = (opts: { storeImport?: string; field?: string; recv?: string; extra?: string } = {}): string => [
  opts.storeImport ?? "import type { HabitStore } from './habit-store.js';",
  'export class HabitOrchestrator {',
  `  constructor(${opts.field ?? 'private readonly checkins: HabitStore'}) {}`,
  `  checkIn(id: string): string { ${opts.recv ?? 'this.checkins'}.find(id); return ${opts.recv ?? 'this.checkins'}.addCheckIn(id); }`,
  `  streak(id: string): string { ${opts.extra ?? ''} return ${opts.recv ?? 'this.checkins'}.find(id); }`,
  '  archive(id: string): string { return id; }',
  '}', '',
].join('\n');

interface PortalShape {
  body?: string;
  field?: string;
  head?: string;
  /** How the Portal brings its Orchestrator's type in. */
  orchestratorImport?: string;
}

function portalFile(s: PortalShape): string {
  return [
    s.orchestratorImport ?? "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    s.head ?? "import type { HabitStore } from './habit-store.js';",
    'export class HabitPortal {',
    `  constructor(private readonly habits: HabitOrchestrator, ${s.field ?? 'private readonly checkins: HabitStore'}) {}`,
    `  checkIn(id: string): string { ${s.body ?? ''} return this.habits.checkIn(id); }`,
    '}', '',
  ].join('\n');
}

interface Options {
  portal?: PortalShape;
  orchestrator?: string;
  files?: Record<string, string>;
}

function habitly(o: Options = {}): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'A habit tracking API a solo developer can maintain.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habits', description: 'Habits, their check-ins and streaks.' }],
    components: [
      {
        id: 'habit_store', componentType: 'Store', durability: 'read-through',
        description: 'Holds habits and check-ins in Postgres.',
        lint: { allow: [{ code: 'UNOWNED_STORE', reason: 'simple keyed rows; lookups beyond the key are single SQL queries served by Postgres indexes' }] },
      },
      { id: 'habit_orchestrator', componentType: 'Orchestrator', description: 'Owns the check-in workflow and its rules.', dependsOn: ['habit_store'] },
      {
        id: 'habit_portal', componentType: 'Portal', transport: 'InProcess', description: 'The HTTP layer of the habits API.', dependsOn: ['habit_orchestrator'],
        invokedBy: { kind: 'entry', caller: 'The mobile app and the web client of Habitly, over the HTTP router in main.ts' },
      },
    ],
    interfaces: [
      { id: 'ihabit_store', component: 'habit_store', methods: [method('addCheckIn', 'write'), method('find', 'read')] },
      {
        id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [
          method('checkIn', 'write'),
          { ...method('streak', 'read'), invokedBy: { kind: 'runtime', caller: 'The nightly streak digest job the composition root schedules' } },
          { ...method('archive'), invokedBy: { kind: 'runtime', caller: 'The weekly clean-up job the composition root schedules' } },
        ],
      },
      { id: 'ihabit_portal', component: 'habit_portal', methods: [method('checkIn', 'write')] },
    ],
    implementations: [
      { id: 'habit_store_pg', contract: 'ihabit_store', sourcePath: 'src/habit-store.ts', methods: [intent('addCheckIn'), intent('find')] },
      {
        id: 'habit_orchestrator_impl', contract: 'ihabit_orchestrator', sourcePath: 'src/habit-orchestrator.ts',
        methods: [
          {
            name: 'checkIn', narrative: [
              { stepNumber: 1, description: 'Load the habit to check it exists', type: 'call', targetComponent: 'habit_store', targetMethod: 'find' },
              { stepNumber: 2, description: 'Record the check-in', type: 'call', targetComponent: 'habit_store', targetMethod: 'addCheckIn' },
              { stepNumber: 3, description: 'Checked in', type: 'return', outcome: 'success' },
            ],
          },
          {
            name: 'streak', narrative: [
              { stepNumber: 1, description: 'Read the habit', type: 'call', targetComponent: 'habit_store', targetMethod: 'find' },
              { stepNumber: 2, description: 'Answer its streak', type: 'return', outcome: 'success' },
            ],
          },
          { name: 'archive', narrative: [{ stepNumber: 1, description: 'Retire the habit', type: 'return', outcome: 'success' }] },
        ],
      },
      {
        id: 'habit_portal_http', contract: 'ihabit_portal', sourcePath: 'src/habit-portal.ts',
        methods: [{
          name: 'checkIn', narrative: [
            { stepNumber: 1, description: 'Dispatch the check-in to the orchestrator', type: 'call', targetComponent: 'habit_orchestrator', targetMethod: 'checkIn' },
            { stepNumber: 2, description: 'Checked in', type: 'return', outcome: 'success' },
          ],
        }],
      },
    ],
    files: {
      '.wai/project.yaml': PROJECT_YAML,
      'src/habit-store.ts': STORE_FILE,
      'src/habit-orchestrator.ts': o.orchestrator ?? ORCHESTRATOR_FILE(),
      'src/habit-portal.ts': portalFile(o.portal ?? { body: '' }),
      ...(o.files ?? {}),
    },
  };
}

const asRead = (t: string): string => t.replace(/addCheckIn/g, 'find');
function readingTwin(o: Options): Options {
  return {
    ...o,
    portal: o.portal ? { ...o.portal, body: o.portal.body && asRead(o.portal.body) } : undefined,
    orchestrator: o.orchestrator && o.orchestrator.replace(/(streak\(id: string\): string \{[^}]*)addCheckIn/, '$1find'),
    files: o.files ? Object.fromEntries(Object.entries(o.files).map(([k, v]) => [k, asRead(v)])) : undefined,
  };
}

const SHORTCUT = 'PORTAL_WRITE_SHORTCUT_IN_CODE';
const UNRESOLVED = 'PORTAL_CALL_UNRESOLVED';

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);

beforeAll(() => { sb = createTrialSandbox('r5conf'); });
afterAll(async () => { await sb?.cleanup(); });

const NO_FIELD = 'private readonly unused?: number';
const PERSIST_FILE = "import type { HabitStore } from './habit-store.js';\nexport async function persist(s: HabitStore, id: string): Promise<void> { s.addCheckIn(id); }\n";

/** Round-5 shapes a Portal writes the Store through: each the ERROR, with the path or the spelling named. */
const CAUGHT: Array<[string, Options, RegExp]> = [
  ['platform persistOrder / solo-app D8 / tinkerer bump-helper: a helper in a file no component maps',
    { portal: { body: 'void persist(this.checkins, id);', head: "import type { HabitStore } from './habit-store.js';\nimport { persist } from './persist.js';" }, files: { 'src/persist.ts': PERSIST_FILE } },
    /reached through persist \(src\/persist\.ts\)/],
  ['tinkerer o_reflect / platform N17: Reflect.apply on the method',
    { portal: { body: 'Reflect.apply(this.checkins.addCheckIn, this.checkins, [id]);' } },
    /`this\.checkins\.addCheckIn` \(taken as a value\)/],
  ['platform N17 with no store import: Reflect.apply through a port the Portal declares',
    { portal: { body: 'Reflect.apply(this.checkins.addCheckIn, this.checkins, [id]);', field: 'private readonly checkins: Sink', head: 'interface Sink { addCheckIn(id: string): string }' } },
    /habit_store\.addCheckIn/],
  ['platform N22: a Function-typed reference invoked with call()',
    { portal: { body: 'const fn: Function = this.checkins.addCheckIn; fn.call(this.checkins, id);' } },
    /taken as a value/],
  ['a method passed as a callback',
    { portal: { body: '[id].forEach(this.checkins.addCheckIn);' } },
    /taken as a value/],
];

describe('r5: the Portal write bypasses round 4 left open are the error', () => {
  for (const [label, options, said] of CAUGHT) {
    it(`${label} → ${SHORTCUT}, exit 1`, async () => {
      const r = await sb.run(['validate'], fresh(habitly(options)));
      expect(r.code, transcript(r)).toBe(1);
      expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(1);
      expect(r.all).toMatch(/\[habit_portal_http\] \[PORTAL_WRITE_SHORTCUT_IN_CODE\] Portal "habit_portal": its method "checkIn"[^\n]*write-effect method habit_store\.addCheckIn/);
      expect(r.all).toMatch(said);
    });
    it(`control — ${label}, reading instead: no shortcut, clean under --ci`, async () => {
      const r = await sb.run(['validate'], fresh(habitly(readingTwin(options))));
      expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(0);
      expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(0);
    });
  }

  it('tinkerer ab_record_cast_template: a template key through a cast to Record<string, fn> → PORTAL_CALL_UNRESOLVED (warning), --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly({ portal: { body: '(this.checkins as unknown as Record<string, (x: string) => string>)[`add${\'CheckIn\'}`](id);' } })));
    expect(r.code, transcript(r)).toBe(1);
    expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(1);
    expect(r.all).toMatch(/⚠\s+\[habit_portal_http\] \[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn[^\n]*before the cast/);
  });
  it('control — a computed key on a local table of formatters: nothing', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: 'const formats: Record<string, (x: string) => string> = { plain: (x) => x }; formats[`p${\'lain\'}`](id);' } })));
    expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(0);
    expect(countCode(r.all, SHORTCUT)).toBe(0);
  });
});

describe('r5 (platform W2, lib-and-app R5-29): an Orchestrator\'s unnarrated write through `as any` fails closed', () => {
  it('`(this.checkins as any).addCheckIn(id)` in the read-narrated streak → CALL_ORIGIN_UNRESOLVED (warning), --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly({ orchestrator: ORCHESTRATOR_FILE({ extra: '(this.checkins as any).addCheckIn(id);' }) })));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/⚠\s+\[habit_orchestrator_impl\] \[CALL_ORIGIN_UNRESOLVED\] Method "streak"[^\n]*habit_store\.addCheckIn[^\n]*fails closed/);
  });
  it('control — the READ through the same cast: --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly({ orchestrator: ORCHESTRATOR_FILE({ extra: '(this.checkins as any).find(id);' }) })));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'CALL_ORIGIN_UNRESOLVED'), transcript(r)).toBe(0);
  });
  it('the unnarrated write through an unowned helper → UNDECLARED_WRITE_CALL naming the path', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      orchestrator: ORCHESTRATOR_FILE({ storeImport: "import type { HabitStore } from './habit-store.js';\nimport { persist } from './persist.js';", extra: 'void persist(this.checkins, id);' }),
      files: { 'src/persist.ts': PERSIST_FILE },
    })));
    expect(r.all, transcript(r)).toMatch(/\[habit_orchestrator_impl\] \[UNDECLARED_WRITE_CALL\] Method "streak"[^\n]*habit_store\.addCheckIn[^\n]*reached through persist \(src\/persist\.ts\)/);
  });
});

describe('r5 (solo-app D22): a Portal calling a workflow verb its narrative never names', () => {
  // archive declares `effect: write` here: since round 6 a verb that declares
  // no effect has it read off its own narrative, and this fixture's archive
  // narrative only returns — an inferred read (trials-r6-conformance covers
  // the inference itself).
  it('`this.habits.archive(id)` inside checkIn, archive a write → UNDECLARED_WRITE_CALL on the Portal, --ci exits 1', async () => {
    const tree = habitly({ portal: { body: 'this.habits.archive(id);', field: NO_FIELD, head: '' } });
    const orchestrator = (tree.interfaces ?? []).find((i) => i.id === 'ihabit_orchestrator') as { methods: Array<Record<string, unknown>> };
    orchestrator.methods.find((m) => m.name === 'archive')!.effect = 'write';
    const r = await sb.run(['validate', '--ci'], fresh(tree));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[habit_portal_http\] \[UNDECLARED_WRITE_CALL\] Method "checkIn"[^\n]*habit_orchestrator\.archive/);
  });
  it('control — the read verb streak: --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly({ portal: { body: 'this.habits.streak(id);', field: NO_FIELD, head: '' } })));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNDECLARED_WRITE_CALL')).toBe(0);
  });
});

describe('r5 (solo-app top-1): honest dependency-injection layouts are clean under --ci', () => {
  const DI_CODES = ['CALL_ORIGIN_UNRESOLVED', 'UNREALIZED_DEPENDENCY', 'CALL_STEP_UNREALIZED', 'UNDECLARED_DEPENDENCY', SHORTCUT, UNRESOLVED];
  const clean = async (options: Options): Promise<void> => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly(options)));
    for (const code of DI_CODES) expect(countCode(r.all, code), `${code}\n${transcript(r)}`).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  };
  const viaPorts = (ports: string): Options => ({
    portal: { body: '', field: NO_FIELD, head: '', orchestratorImport: "import type { HabitOrchestrator } from './ports.js';" },
    files: { 'src/ports.ts': ports },
  });

  it('baseline: the Portal only forwards to the Orchestrator', async () => {
    await clean({ portal: { body: '', field: NO_FIELD, head: '' } });
  });
  it('H5 a type-only ports.ts barrel the Portal imports its Orchestrator type from', async () => {
    await clean(viaPorts("export type { HabitOrchestrator } from './habit-orchestrator.js';\n"));
  });
  it('H9 an `export *` barrel', async () => {
    await clean(viaPorts("export * from './habit-orchestrator.js';\n"));
  });
  it('H6 a Store port declared in a shared module, realized by the Store class', async () => {
    await clean({
      portal: { body: '', field: NO_FIELD, head: '' },
      orchestrator: ORCHESTRATOR_FILE({ storeImport: "import type { HabitStorePort as HabitStore } from './ports.js';" }),
      files: {
        'src/ports.ts': 'export interface HabitStorePort {\n  addCheckIn(id: string): string;\n  find(id: string): string;\n}\n',
        'src/habit-store.ts': `import type { HabitStorePort } from './ports.js';\n${STORE_FILE.replace('export class HabitStore {', 'export class HabitStore implements HabitStorePort {')}`,
      },
    });
  });
  it('H7 a deps bag typed inline on the Orchestrator', async () => {
    await clean({
      portal: { body: '', field: NO_FIELD, head: '' },
      orchestrator: ORCHESTRATOR_FILE({ field: 'private readonly deps: { habitStore: HabitStore; now?: () => Date }', recv: 'this.deps.habitStore' }),
    });
  });
  it('control — a declared edge the Orchestrator neither imports nor calls is still UNREALIZED_DEPENDENCY', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      portal: { body: '', field: NO_FIELD, head: '' },
      orchestrator: 'export class HabitOrchestrator {\n  checkIn(id: string): string { return id; }\n  streak(id: string): string { return id; }\n  archive(id: string): string { return id; }\n}\n',
    })));
    expect(r.all, transcript(r)).toMatch(/\[UNREALIZED_DEPENDENCY\] Component "habit_orchestrator" declares dependsOn "habit_store"/);
  });
});

describe('r5 (platform): type shapes and signatures', () => {
  const money = (fields: string[]): Record<string, unknown> => ({
    id: 'money', kind: 'value-object', name: 'Money', subsystem: 'habits', description: 'An amount in minor units.',
    sourcePath: 'src/money.ts', fields: fields.map((name) => ({ name, type: name === 'currency' ? 'string' : 'int' })),
  });
  const moneyFile = (params: string): string =>
    `export class Money {\n  constructor(${params}) {}\n  get amountMinor(): number { return this.a; }\n  get currency(): string { return this.c; }\n}\n`;

  it('private backing fields behind getters are no undeclared data', async () => {
    const tree = habitly({ files: { 'src/money.ts': moneyFile('private readonly a: number, private readonly c: string') } });
    const r = await sb.run(['validate'], fresh({ ...tree, types: [money(['amountMinor', 'currency'])] }));
    expect(countCode(r.all, 'UNDECLARED_TYPE_FIELD'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNREALIZED_TYPE_FIELD')).toBe(0);
  });
  it('control — a private field no getter reads is UNDECLARED_TYPE_FIELD', async () => {
    const tree = habitly({ files: { 'src/money.ts': moneyFile('private readonly a: number, private readonly c: string, private readonly rounding: number') } });
    const r = await sb.run(['validate'], fresh({ ...tree, types: [money(['amountMinor', 'currency'])] }));
    expect(countCode(r.all, 'UNDECLARED_TYPE_FIELD'), transcript(r)).toBe(1);
    expect(r.all).toContain('"rounding"');
  });

  it('UNDECLARED_PARAM names the inserted LEADING parameter, not the declared one it pushed along', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      portal: { body: '', field: NO_FIELD, head: '' },
      orchestrator: ORCHESTRATOR_FILE().replace('archive(id: string)', 'archive(requester: string, id: string)'),
    })));
    expect(r.all, transcript(r)).toMatch(/\[UNDECLARED_PARAM\][^\n]*archive[^\n]*"requester"/);
    expect(r.all).not.toMatch(/\[UNDECLARED_PARAM\][^\n]*— "id"/);
  });
  it('control — a trailing extra parameter is the one named', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      portal: { body: '', field: NO_FIELD, head: '' },
      orchestrator: ORCHESTRATOR_FILE().replace('archive(id: string)', 'archive(id: string, reason: string)'),
    })));
    expect(r.all, transcript(r)).toMatch(/\[UNDECLARED_PARAM\][^\n]*archive[^\n]*"reason"/);
  });
});
