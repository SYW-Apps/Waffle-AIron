import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, writeFile, type TrialSandbox } from './trials-helpers';

// ---------------------------------------------------------------------------
// Round-4 user trials: the code-level Portal write check, attacked shape by
// shape (solo-app's 29-row table, the tinkerer's bypass variants, the platform
// team's probes, lib-and-app R4-33), plus the unnarrated Orchestrator write,
// constructor parameter properties and the TypeScript the analysis reads with.
//
// Every shape that hides a Portal -> Store write runs twice: once writing
// (habit_store.addCheckIn, write effect) and once, as its control, READING
// through exactly the same spelling (habit_store.find) — so a journey proves
// the write is caught AND that the spelling alone accuses nothing.
//
// Fixture: Habitly — Portal habit_portal -> Orchestrator habit_orchestrator ->
// standalone Store habit_store, the trial's own design shape.
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

/** The Orchestrator; `extra` runs inside its read-narrated `streak` method. */
function orchestratorFile(extra = ''): string {
  return [
    "import type { HabitStore } from './habit-store.js';",
    'export class HabitOrchestrator {',
    '  constructor(private readonly checkins: HabitStore) {}',
    '  checkIn(id: string): string { this.checkins.find(id); return this.checkins.addCheckIn(id); }',
    `  streak(id: string): string { ${extra} return this.checkins.find(id); }`,
    '}', '',
  ].join('\n');
}

interface PortalShape {
  /** Statements before the narrated orchestrator call. */
  body: string;
  /** The second collaborator's constructor parameter. */
  field?: string;
  /** The lines that bring the Store's type in (and any other top-level lines). */
  head?: string;
  /** Top-level lines after the class. */
  tail?: string;
  /** Replace the orchestrator call (round 1's "drop the call" shape). */
  dropCall?: boolean;
  /** More files. */
  files?: Record<string, string>;
}

function portalFile(s: PortalShape): string {
  return [
    "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    s.head ?? "import type { HabitStore } from './habit-store.js';",
    'export class HabitPortal {',
    `  constructor(private readonly habits: HabitOrchestrator, ${s.field ?? 'private readonly checkins: HabitStore'}) {}`,
    `  checkIn(id: string): string { ${s.body} ${s.dropCall ? 'return id;' : 'return this.habits.checkIn(id);'} }`,
    '}',
    s.tail ?? '',
    '',
  ].join('\n');
}

interface Options {
  portal?: PortalShape;
  orchestratorExtra?: string;
  storeTechnologies?: unknown[];
  types?: Record<string, unknown>[];
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
      { id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [method('checkIn', 'write'), { ...method('streak', 'read'), invokedBy: { kind: 'runtime', caller: 'The nightly streak digest job the composition root schedules' } }] },
      { id: 'ihabit_portal', component: 'habit_portal', methods: [method('checkIn', 'write')] },
    ],
    implementations: [
      {
        id: 'habit_store_pg', contract: 'ihabit_store', sourcePath: 'src/habit-store.ts',
        ...(o.storeTechnologies ? { technologies: o.storeTechnologies } : {}),
        methods: [intent('addCheckIn'), intent('find')],
      },
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
    ...(o.types ? { types: o.types } : {}),
    files: {
      '.wai/project.yaml': PROJECT_YAML,
      'src/habit-store.ts': STORE_FILE,
      'src/habit-orchestrator.ts': orchestratorFile(o.orchestratorExtra),
      'src/habit-portal.ts': portalFile(o.portal ?? { body: '' }),
      ...(o.portal?.files ?? {}),
      ...(o.files ?? {}),
    },
  };
}

/** The control of a shape: the same spelling, reaching the Store's READ. */
function asRead(shape: PortalShape): PortalShape {
  const swap = (t?: string): string | undefined => t?.replace(/addCheckIn/g, 'find');
  return {
    ...shape,
    body: swap(shape.body)!,
    field: swap(shape.field),
    head: swap(shape.head),
    tail: swap(shape.tail),
    files: shape.files ? Object.fromEntries(Object.entries(shape.files).map(([k, v]) => [k, swap(v)!])) : undefined,
  };
}

const SHORTCUT = 'PORTAL_WRITE_SHORTCUT_IN_CODE';
const UNRESOLVED = 'PORTAL_CALL_UNRESOLVED';

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);

beforeAll(() => { sb = createTrialSandbox('r4conf'); });
afterAll(async () => { await sb?.cleanup(); });

const STORE_TYPE = "import type { HabitStore } from './habit-store.js';";
const STORE_VALUE = "import { HabitStore } from './habit-store.js';";
const NO_FIELD = 'private readonly unused?: number';

/** Every shape that hides the write behind a receiver the type checker still resolves: the error. */
const CAUGHT: Array<[string, PortalShape]> = [
  // solo-app round 4, the 29-row table
  ['A1 a required field (control shape)', { body: 'this.checkins.addCheckIn(id);' }],
  ['A2 a non-null assertion on a required field', { body: 'this.checkins!.addCheckIn(id);' }],
  ['A3 an optional field with a non-null assertion', { body: 'this.checkins!.addCheckIn(id);', field: 'private readonly checkins?: HabitStore' }],
  ['A4 a local alias', { body: 'const store = this.checkins; store.addCheckIn(id);' }],
  ['A5 destructuring the field', { body: 'const { checkins } = this; checkins.addCheckIn(id);' }],
  ['A6 a cast to the named type', { body: '(this.checkins as HabitStore).addCheckIn(id);' }],
  ['A6b a field typed unknown, cast to the named type', { body: '(this.checkins as HabitStore).addCheckIn(id);', field: 'private readonly checkins: unknown' }],
  ['A8 satisfies', { body: '(this.checkins satisfies HabitStore).addCheckIn(id);' }],
  ['A9 parentheses', { body: '(this.checkins).addCheckIn(id);' }],
  ['A10 a factory field', { body: 'this.stores().addCheckIn(id);', field: 'private readonly stores: () => HabitStore' }],
  ['A11 an annotated local', { body: 'const s: HabitStore = this.checkins; s.addCheckIn(id);' }],
  ['A14 Pick<>', { body: 'this.checkins.addCheckIn(id);', field: "private readonly checkins: Pick<HabitStore, 'addCheckIn'>" }],
  ['A15 a one-hop type alias', { body: 'this.checkins.addCheckIn(id);', field: 'private readonly checkins: Writer', head: `${STORE_TYPE}\ntype Writer = HabitStore;` }],
  ['A16 two alias hops', { body: 'this.checkins.addCheckIn(id);', field: 'private readonly checkins: W2', head: `${STORE_TYPE}\ntype W1 = HabitStore;\ntype W2 = W1;` }],
  ['A17 a dependency bag', { body: 'this.deps.checkins.addCheckIn(id);', field: 'private readonly deps: { checkins: HabitStore }' }],
  ['A18 a module variable set by an exported setter', {
    body: 'store!.addCheckIn(id);', field: NO_FIELD,
    head: `${STORE_TYPE}\nlet store: HabitStore | undefined;\nexport function setStore(s: HabitStore): void { store = s; }`,
  }],
  ['A19 an element access', { body: "this.checkins['addCheckIn'](id);" }],
  ['A20 a same-file helper', { body: 'persist(this.checkins, id);', tail: 'function persist(s: HabitStore, id: string): void { s.addCheckIn(id); }' }],
  ['A21 a constructed instance of a runtime-imported class', { body: 'new HabitStore().addCheckIn(id);', field: NO_FIELD, head: STORE_VALUE }],
  ['C1 a type-only barrel re-export', {
    body: 'this.checkins.addCheckIn(id);', head: "import type { HabitStore } from './contracts.js';",
    files: { 'src/contracts.ts': "export type { HabitStore } from './habit-store.js';\n" },
  }],
  ['C2 a port interface the Portal declares in its own contracts file', {
    body: 'this.checkins.addCheckIn(id);', field: 'private readonly checkins: CheckinPort', head: "import type { CheckinPort } from './contracts.js';",
    files: { 'src/contracts.ts': 'export interface CheckinPort { addCheckIn(id: string): string }\n' },
  }],
  // tinkerer round 4 (bypass-variants/)
  ['tinkerer b: a cast through unknown to an inline shape', { body: '(this.checkins as unknown as { addCheckIn(id: string): string }).addCheckIn(id);' }],
  ['tinkerer d: a destructured method invoked with call()', { body: 'const { addCheckIn } = this.checkins; addCheckIn.call(this.checkins, id);' }],
  ['tinkerer: a destructured method bound and invoked', { body: 'const { addCheckIn } = this.checkins; addCheckIn.bind(this.checkins)(id);' }],
  // platform round 4
  ['platform: optional chaining', { body: 'this.checkins?.addCheckIn(id);', field: 'private readonly checkins?: HabitStore' }],
  ['platform: a destructured method called plainly', { body: 'const { addCheckIn } = this.checkins; addCheckIn(id);' }],
  ['platform: destructuring after an alias', { body: 'const repo = this.checkins; const { addCheckIn } = repo; addCheckIn(id);' }],
  // lib-and-app R4-33: the plain call on a store the Portal's module builds
  ['lib-and-app R4-33: a plain call on a module-level instance', {
    body: 'store.addCheckIn(id);', field: NO_FIELD, head: `${STORE_VALUE}\nconst store = new HabitStore();`,
  }],
  ['lib-and-app R4-33: a plain call on an instance built in the method', { body: 'const store = new HabitStore(); store.addCheckIn(id);', field: NO_FIELD, head: STORE_VALUE }],
];

/** Every shape whose receiver's type is gone: neither proven nor cleared, so it fails closed (a warning). */
const UNFOLLOWABLE: Array<[string, PortalShape]> = [
  ['A7 an `as any` cast', { body: '(this.checkins as any).addCheckIn(id);' }],
  ['A12 `(this as any)`', { body: '(this as any).checkins.addCheckIn(id);' }],
  ['A13 a field typed any', { body: 'this.checkins.addCheckIn(id);', field: 'private readonly checkins: any' }],
  ['A23 a constructor parameter with no annotation', { body: 'this.checkins.addCheckIn(id);', field: 'private readonly checkins' }],
  ['tinkerer h: a dependency bag typed any', { body: 'this.deps.store.addCheckIn(id);', field: 'private readonly deps: any' }],
  ['platform: an `<any>` cast', { body: '(<any>this.checkins).addCheckIn(id);' }],
  ['platform: a resolver answering Promise<any>', {
    body: 'void this.resolve().then((s) => s.addCheckIn(id));', field: 'private readonly resolve: () => Promise<any>',
  }],
  ['lib-and-app R4-33 (v): an untyped global, no import', { body: '(globalThis as any).store.addCheckIn(id);', field: NO_FIELD, head: '' }],
];

describe('r4: a Portal write the type checker resolves is the error, whatever the spelling', () => {
  it('baseline: the Portal only forwards to the Orchestrator — clean, exit 0 under --ci', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly({ portal: { body: '', field: NO_FIELD, head: '' } })));
    expect(r.code, transcript(r)).toBe(0);
    for (const code of [SHORTCUT, UNRESOLVED, 'UNDECLARED_DEPENDENCY', 'UNDECLARED_WRITE_CALL', 'CONFORMANCE_DEGRADED']) {
      expect(countCode(r.all, code), `${code}\n${transcript(r)}`).toBe(0);
    }
  });

  for (const [label, shape] of CAUGHT) {
    it(`${label} → ${SHORTCUT} + UNDECLARED_DEPENDENCY, exit 1`, async () => {
      const r = await sb.run(['validate'], fresh(habitly({ portal: shape })));
      expect(r.code, transcript(r)).toBe(1);
      expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(1);
      expect(r.all).toMatch(/\[habit_portal_http\] \[PORTAL_WRITE_SHORTCUT_IN_CODE\] Portal "habit_portal": its method "checkIn" in "src\/habit-portal\.ts" calls write-effect method habit_store\.addCheckIn directly/);
      expect(countCode(r.all, 'UNDECLARED_DEPENDENCY'), transcript(r)).toBeGreaterThan(0);
      expect(countCode(r.all, UNRESOLVED)).toBe(0);
    });
    it(`control — ${label}, reading instead: no shortcut, nothing unresolved`, async () => {
      const r = await sb.run(['validate'], fresh(habitly({ portal: asRead(shape) })));
      expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(0);
      expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(0);
    });
  }

  it('A22 the narrated call dropped and the store written instead → CALL_STEP_UNREALIZED + the shortcut', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: 'this.checkins!.addCheckIn(id);', dropCall: true } })));
    expect(r.code, transcript(r)).toBe(1);
    expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[habit_portal_http\] \[CALL_STEP_UNREALIZED\][^\n]*habit_orchestrator\.checkIn/);
  });

  it('control — A22 the narrated call kept, nothing written: clean', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: 'this.checkins!.find(id);' } })));
    expect(countCode(r.all, 'CALL_STEP_UNREALIZED'), transcript(r)).toBe(0);
    expect(countCode(r.all, SHORTCUT)).toBe(0);
  });
});

describe('r4: a receiver whose type is gone fails closed — PORTAL_CALL_UNRESOLVED is a warning', () => {
  for (const [label, shape] of UNFOLLOWABLE) {
    it(`${label} → ${UNRESOLVED} (warning): validate --ci exits 1`, async () => {
      const dir = fresh(habitly({ portal: shape }));
      const r = await sb.run(['validate', '--ci'], dir);
      expect(r.code, transcript(r)).toBe(1);
      expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(1);
      expect(r.all).toMatch(/⚠\s+\[habit_portal_http\] \[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn[^\n]*fails closed/);
      expect(countCode(r.all, SHORTCUT)).toBe(0);
    });
    it(`control — ${label}, reading instead: no warning`, async () => {
      const r = await sb.run(['validate'], fresh(habitly({ portal: asRead(shape) })));
      expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(0);
      expect(countCode(r.all, SHORTCUT)).toBe(0);
    });
  }
});

describe('r4: technology packages in the Portal (B1, B1b)', () => {
  for (const [label, line, pkg] of [
    ['B1 `pg`', "import pg from 'pg';\nvoid pg;", 'pg'],
    ['B1b `postgres`', "import postgres from 'postgres';\nvoid postgres;", 'postgres'],
  ] as const) {
    it(`${label} in the Portal → TECH_LEAKAGE_IN_CODE`, async () => {
      const r = await sb.run(['validate'], fresh(habitly({ storeTechnologies: ['postgres'], portal: { body: '', tail: line } })));
      expect(countCode(r.all, 'TECH_LEAKAGE_IN_CODE'), transcript(r)).toBe(1);
      expect(r.all).toContain(`imports "${pkg}"`);
    });
  }
  it('an `ioredis` import while no implementation binds redis → TECH_LEAKAGE_IN_CODE naming the missing binding', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: '', tail: "import Redis from 'ioredis';\nvoid Redis;" } })));
    expect(countCode(r.all, 'TECH_LEAKAGE_IN_CODE'), transcript(r)).toBe(1);
    expect(r.all).toContain('which no implementation binds');
  });
  it('control: the same import in the Store that binds postgres is its home', async () => {
    const dir = fresh(habitly({ storeTechnologies: ['postgres'] }));
    writeFile(dir, 'src/habit-store.ts', `import pg from 'pg';\nvoid pg;\n${STORE_FILE}`);
    const r = await sb.run(['validate'], dir);
    expect(countCode(r.all, 'TECH_LEAKAGE_IN_CODE'), transcript(r)).toBe(0);
  });
});

describe("r4 (tinkerer): an Orchestrator's write that no narrative step claims", () => {
  it('a store write added to a read-narrated method → UNDECLARED_WRITE_CALL; validate --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly({ orchestratorExtra: 'this.checkins.addCheckIn(id);' })));
    expect(r.code, transcript(r)).toBe(1);
    expect(countCode(r.all, 'UNDECLARED_WRITE_CALL'), transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[habit_orchestrator_impl\] \[UNDECLARED_WRITE_CALL\] Method "streak"[^\n]*habit_store\.addCheckIn/);
  });
  it('the same write through an element access is still the unnarrated write', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ orchestratorExtra: "this.checkins['addCheckIn'](id);" })));
    expect(countCode(r.all, 'UNDECLARED_WRITE_CALL'), transcript(r)).toBe(1);
  });
  it('control: an extra READ in the read-narrated method is no unnarrated write', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly({ orchestratorExtra: 'this.checkins.find(id);' })));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNDECLARED_WRITE_CALL'), transcript(r)).toBe(0);
  });
});

describe('r4 (platform): constructor parameter properties are fields', () => {
  const money = (fields: string[]): Record<string, unknown> => ({
    id: 'money', kind: 'value-object', name: 'Money', subsystem: 'habits', description: 'An amount in minor units.',
    sourcePath: 'src/money.ts', fields: fields.map((name) => ({ name, type: name === 'currency' ? 'string' : 'int' })),
  });
  it('`constructor(public readonly amountMinor: number, public readonly currency: string)` carries both fields', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      types: [money(['amountMinor', 'currency'])],
      files: { 'src/money.ts': 'export class Money {\n  constructor(public readonly amountMinor: number, public readonly currency: string) {}\n}\n' },
    })));
    expect(countCode(r.all, 'UNREALIZED_TYPE_FIELD'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'UNDECLARED_TYPE_FIELD'), transcript(r)).toBe(0);
  });
  it('control: an undeclared parameter property is UNDECLARED_TYPE_FIELD', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      types: [money(['amountMinor', 'currency'])],
      files: { 'src/money.ts': 'export class Money {\n  constructor(public readonly amountMinor: number, public readonly currency: string, public readonly rounding: number) {}\n}\n' },
    })));
    expect(countCode(r.all, 'UNDECLARED_TYPE_FIELD'), transcript(r)).toBe(1);
    expect(r.all).toContain('"rounding"');
  });
});

describe('r4: the TypeScript the analysis reads with', () => {
  it('a project on TypeScript 7 (no JavaScript compiler API) is read at exact grade — no CONFORMANCE_DEGRADED', async () => {
    const dir = fresh(habitly({ portal: { body: 'this.checkins.addCheckIn(id);' } }));
    writeFile(dir, 'package.json', '{ "name": "habitly", "version": "1.0.0", "devDependencies": { "typescript": "^7.0.0" } }\n');
    writeFile(dir, 'node_modules/typescript/package.json', '{ "name": "typescript", "version": "7.0.2", "main": "index.js" }\n');
    writeFile(dir, 'node_modules/typescript/index.js', 'module.exports = { version: "7.0.2" };\n');
    const r = await sb.run(['validate'], dir);
    expect(countCode(r.all, 'CONFORMANCE_DEGRADED'), transcript(r)).toBe(0);
    // Exact grade: the shortcut is judged at all.
    expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(1);
  });
  it('control: a project with no TypeScript installed reads at exact grade too', async () => {
    const r = await sb.run(['validate', '--ci'], fresh(habitly()));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'CONFORMANCE_DEGRADED')).toBe(0);
  });
});
