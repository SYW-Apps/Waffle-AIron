import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';

// ---------------------------------------------------------------------------
// Solo-app persona: a solo full-stack developer building a habit-tracking API
// (TypeScript, Postgres), three trial rounds. The journeys replay the probes
// that found real bugs, on the BUILT CLI:
//
//   - the deliberate mistake: the HTTP layer writes straight to the database
//     while the spec still narrates the Orchestrator call — through a runtime
//     import, an injected type-only collaborator, and the shapes that hid it
//     again in round 3 (`x!`, a local alias, destructuring, casts, satisfies);
//   - design-first planned sourcePaths (round 1: an ERROR; round 2: one notice
//     per FILE) and code linkage that must never stale the approval;
//   - a type with no sourcePath, never shape-checked and never said so;
//   - the technology fence that was inert for `technologies: [postgres]`;
//   - the cheaper output/UX findings (empty tree, "Passed with N warning(s)",
//     `exports:` in the L0, field-rename trace, init naming, shared contracts).
//
// Fixture: Habitly — Portal habit_portal → Orchestrator habit_orchestrator →
// standalone Store habit_store (the sanctioned smallest shape, with a reasoned
// UNOWNED_STORE allow), exactly the round-3 design shape.
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

const ORCH_FILE = [
  "import type { HabitStore } from './habit-store.js';",
  'export class HabitOrchestrator {',
  '  constructor(private readonly checkins: HabitStore) {}',
  '  checkIn(id: string): string { this.checkins.find(id); return this.checkins.addCheckIn(id); }',
  '}', '',
].join('\n');

interface PortalShape {
  /** Statements before the narrated orchestrator call (the injected write). */
  body?: string;
  /** Replace the orchestrator call entirely (round 1's "drop the call" shape). */
  dropCall?: boolean;
  /** The second collaborator's field declaration. */
  field?: string;
  /** The import line that brings the Store's type in. */
  storeImport?: string;
  /** Extra top-level lines. */
  extra?: string;
}

/** The Portal's source: a thin HTTP layer that forwards checkIn to the Orchestrator (same method name — round 1's blind spot). */
function portalFile(s: PortalShape = {}): string {
  return [
    "import type { HabitOrchestrator } from './habit-orchestrator.js';",
    s.storeImport ?? "import type { HabitStore } from './habit-store.js';",
    ...(s.extra ? [s.extra] : []),
    'export class HabitPortal {',
    `  constructor(private readonly habits: HabitOrchestrator, ${s.field ?? 'private readonly checkins: HabitStore'}) {}`,
    `  checkIn(id: string): string { ${s.body ?? ''} ${s.dropCall ? 'return id;' : 'return this.habits.checkIn(id);'} }`,
    '}',
    'declare function makeStore(): any;',
    '',
  ].join('\n');
}

interface HabitlyOptions {
  /** Write the source files (false = a design-only tree with planned paths). */
  code?: boolean;
  portal?: PortalShape;
  storeTechnologies?: unknown[];
  types?: Record<string, unknown>[];
  extraFiles?: Record<string, string>;
}

function habitly(o: HabitlyOptions = {}): FixtureTree {
  const code = o.code ?? true;
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
      { id: 'ihabit_store', component: 'habit_store', methods: [method('addCheckIn', 'write'), { ...method('find', 'read'), ...(o.types ? { returns: 'habit' } : {}) }] },
      { id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [method('checkIn', 'write')] },
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
        methods: [{
          name: 'checkIn', narrative: [
            { stepNumber: 1, description: 'Load the habit to check it exists', type: 'call', targetComponent: 'habit_store', targetMethod: 'find' },
            { stepNumber: 2, description: 'Record the check-in', type: 'call', targetComponent: 'habit_store', targetMethod: 'addCheckIn' },
            { stepNumber: 3, description: 'Checked in', type: 'return', outcome: 'success' },
          ],
        }],
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
      ...(code ? {
        'src/habit-store.ts': STORE_FILE,
        'src/habit-orchestrator.ts': ORCH_FILE,
        'src/habit-portal.ts': portalFile(o.portal),
      } : {}),
      ...(o.extraFiles ?? {}),
    },
  };
}

const SHORTCUT = 'PORTAL_WRITE_SHORTCUT_IN_CODE';
const UNRESOLVED = 'PORTAL_CALL_UNRESOLVED';

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);

beforeAll(() => { sb = createTrialSandbox('solo'); });
afterAll(async () => { await sb?.cleanup(); });

describe('solo-app: the HTTP layer writes straight to the database (code changed, spec untouched)', () => {
  // Round 1 MAJOR (DI false positives): a type-only import + constructor
  // injection is the realized edge, never UNREALIZED_DEPENDENCY.
  it('baseline: the Portal only forwards to the Orchestrator — clean, exit 0', async () => {
    const r = await sb.run(['validate'], fresh(habitly()));
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('All checks passed');
    for (const code of [SHORTCUT, UNRESOLVED, 'UNDECLARED_DEPENDENCY', 'UNREALIZED_DEPENDENCY', 'CALL_STEP_UNREALIZED']) {
      expect(countCode(r.all, code), `${code}\n${transcript(r)}`).toBe(0);
    }
  });

  // Round 2 top issue (B3a): the narrated call KEPT plus an added write through
  // an injected type-only collaborator was byte-identical to the baseline.
  // Round 3 top issue: `!` and a local alias hid it again (silent at dev.107);
  // the receiver following added after round 3 closes every one of these.
  const caught: Array<[string, PortalShape]> = [
    ['a plain field call (round 2 B3a)', { body: 'this.checkins.addCheckIn(id);' }],
    ['an optional-chained call', { body: 'this.checkins?.addCheckIn(id);', field: 'private readonly checkins?: HabitStore' }],
    ['an if-guarded optional field', { body: 'if (this.checkins) this.checkins.addCheckIn(id);', field: 'private readonly checkins?: HabitStore' }],
    ['a non-null assertion on a required field (round 3, silent at dev.107)', { body: 'this.checkins!.addCheckIn(id);' }],
    ['a non-null assertion on an optional field (round 3, silent at dev.107)', { body: 'this.checkins!.addCheckIn(id);', field: 'private readonly checkins?: HabitStore' }],
    ['a non-null assertion on a `| null` field (round 3, silent at dev.107)', { body: 'this.checkins!.addCheckIn(id);', field: 'private readonly checkins: HabitStore | null' }],
    ['a one-line local alias (round 3, silent at dev.107)', { body: 'const store = this.checkins; store.addCheckIn(id);' }],
    ['a destructured field', { body: 'const { checkins } = this; checkins.addCheckIn(id);' }],
    ['a renamed destructured field', { body: 'const { checkins: c } = this; c.addCheckIn(id);' }],
    ['an `as` cast receiver', { body: '(this.checkins as HabitStore).addCheckIn(id);' }],
    ['a `satisfies` receiver', { body: '(this.checkins satisfies HabitStore).addCheckIn(id);' }],
  ];
  for (const [label, shape] of caught) {
    it(`${label} → ${SHORTCUT} (error) + UNDECLARED_DEPENDENCY, exit 1`, async () => {
      const r = await sb.run(['validate'], fresh(habitly({ portal: shape })));
      expect(r.code, transcript(r)).toBe(1);
      expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(1);
      expect(r.all).toMatch(/\[habit_portal_http\] \[PORTAL_WRITE_SHORTCUT_IN_CODE\] Portal "habit_portal": its method "checkIn" in "src\/habit-portal\.ts" calls write-effect method habit_store\.addCheckIn directly/);
      expect(r.all).toContain('which its design never narrates');
      expect(r.all).toMatch(/\[UNDECLARED_DEPENDENCY\][^\n]*calls habit_store\.addCheckIn/);
      expect(countCode(r.all, UNRESOLVED)).toBe(0);
    });
  }

  it('a runtime import of the Store class (round 3 B3b) → the shortcut, the undeclared edge and the leaked export', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      portal: { storeImport: "import { HabitStore } from './habit-store.js';", body: 'this.checkins.addCheckIn(id);' },
    })));
    expect(r.code, transcript(r)).toBe(1);
    expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(1);
    expect(countCode(r.all, 'UNDECLARED_DEPENDENCY')).toBeGreaterThan(0);
  });

  // Round 1 Experiment B (borderline BLOCKER): the orchestrator call DROPPED
  // and the store written instead — output identical to the baseline, because
  // the Portal's own same-named method was accepted as the call's realization.
  it('the narrated call dropped and the store written instead (round 1 B) → CALL_STEP_UNREALIZED + the shortcut', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: 'this.checkins.addCheckIn(id);', dropCall: true } })));
    expect(r.code, transcript(r)).toBe(1);
    expect(countCode(r.all, SHORTCUT), transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[habit_portal_http\] \[CALL_STEP_UNREALIZED\][^\n]*habit_orchestrator\.checkIn/);
  });

  // `as any` erases the receiver's type: nothing can prove which component it
  // is. The fixed build does not pass it in silence (round 3's complaint was
  // "no could-not-resolve notice"): it says so with PORTAL_CALL_UNRESOLVED, a
  // NOTICE, because the write is neither proven nor cleared. Exit stays 0.
  it('an `as any` receiver stays unfollowable — said so as a notice, never a pass in silence', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: '(this.checkins as any).addCheckIn(id);' } })));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, SHORTCUT)).toBe(0);
    expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(1);
    expect(r.all).toContain('through a receiver this analysis cannot follow');
    expect(r.all).toContain('habit_store.addCheckIn');
    expect(r.all).toContain('Neither proven a persistence shortcut nor cleared');
  });

  it('a receiver nothing declares (`makeStore()`) → PORTAL_CALL_UNRESOLVED notice naming the write', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: 'const s = makeStore(); s.addCheckIn(id);' } })));
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toMatch(/\[habit_portal_http\] \[PORTAL_CALL_UNRESOLVED\][^\n]*`s\.addCheckIn\(…\)`[^\n]*habit_store\.addCheckIn/);
  });

  it('control: a READ through an unfollowable receiver is no write candidate — no notice', async () => {
    const r = await sb.run(['validate'], fresh(habitly({ portal: { body: 'const s = makeStore(); s.find(id);' } })));
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, UNRESOLVED), transcript(r)).toBe(0);
    expect(countCode(r.all, SHORTCUT)).toBe(0);
  });
});

describe('solo-app: design-first planned sourcePaths', () => {
  // Round 1 MAJOR: a sourcePath to a file not written yet was MISSING_SOURCE_FILE
  // (an error) — the design could not name its files before the code existed.
  // Round 2 MINOR: one SOURCE_FILE_PLANNED notice per planned FILE.
  it('a design-only tree naming its files validates (exit 0, --ci too): one SOURCE_FILE_PLANNED per implementation', async () => {
    const tree = habitly({ code: false });
    // A second planned file on one method: still ONE notice for that implementation, naming both.
    const store = (tree.implementations as Record<string, unknown>[])[0];
    store.methods = [{ ...intent('addCheckIn'), sourcePath: 'src/habit-store-writes.ts' }, intent('find')];
    const dir = fresh(tree);

    const r = await sb.run(['validate'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(countCode(r.all, 'MISSING_SOURCE_FILE'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'SOURCE_FILE_PLANNED'), transcript(r)).toBe(3);
    const storeLine = r.all.split('\n').find((l) => l.includes('[habit_store_pg] [SOURCE_FILE_PLANNED]')) ?? '';
    expect(storeLine, transcript(r)).toContain('src/habit-store.ts');
    expect(storeLine).toContain('src/habit-store-writes.ts');

    const ci = await sb.run(['validate', '--ci'], dir);
    expect(ci.code, transcript(ci)).toBe(0);

    // Round 2 MINOR: status shouted "(File Missing!)" for a planned file.
    const st = await sb.run(['status'], dir);
    expect(st.code, transcript(st)).toBe(0);
    expect(st.stdout).toContain('src/habit-portal.ts (planned — not written yet)');
    expect(st.stdout).not.toContain('File Missing');
  });
});

describe('solo-app: code linkage never stales the approval', () => {
  // Round 1 MAJOR: adding sourcePath/simPath while implementing drifted the
  // approval — re-lock per component. Linkage is outside the approved digests.
  it('lock a planned design, write the code, move a file, add a symbol → lock-check stays green; a design edit does not', async () => {
    const dir = fresh(habitly({ code: false }));
    const lock = await sb.run(['lock', '-y'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
    expect(fs.existsSync(path.join(dir, '.wai', 'lock.json'))).toBe(true);
    expect((await sb.run(['lock-check'], dir)).code).toBe(0);

    // The implementation wave: the planned files are written.
    writeFile(dir, 'src/habit-store.ts', STORE_FILE);
    writeFile(dir, 'src/habit-orchestrator.ts', ORCH_FILE);
    writeFile(dir, 'src/http/habit-portal.ts', portalFile().replace(/'\.\/habit-/g, "'../habit-"));
    // ...the Portal landed in another folder than planned: the spec's linkage follows.
    const implFile = path.join(dir, '.wai', 'specs', 'implementations', 'habit_portal_http.yaml');
    const impl = yaml.load(fs.readFileSync(implFile, 'utf8')) as Record<string, unknown>;
    impl.sourcePath = 'src/http/habit-portal.ts';
    (impl.methods as Array<Record<string, unknown>>)[0].symbol = 'checkIn';
    fs.writeFileSync(implFile, yaml.dump(impl, { lineWidth: 200 }));

    const v = await sb.run(['validate'], dir);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all, transcript(v)).toContain('All checks passed');
    expect(countCode(v.all, 'SOURCE_FILE_PLANNED')).toBe(0);

    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(0);
    expect(check.all).toContain('is the approved design');
    const st = await sb.run(['status'], dir);
    expect(st.all, transcript(st)).toContain('no spec has changed since');

    // Negative control: a real design change (a contract method's meaning) moves the approval.
    const intfFile = path.join(dir, '.wai', 'specs', 'interfaces', 'ihabit_store.yaml');
    fs.writeFileSync(intfFile, fs.readFileSync(intfFile, 'utf8').replace('addCheckIn does its one thing', 'addCheckIn records a check-in for a day'));
    const moved = await sb.run(['lock-check'], dir);
    expect(moved.code, transcript(moved)).toBe(1);
    expect(moved.all).toMatch(/What moved: 1 own spec file/);
  });

  it('a misplaced top-level `symbol:` is an unknown key: status and lock-check agree nothing moved', async () => {
    // Round 3: `status` said "1 spec changed since approval" while `lock-check`
    // stayed green. The schema has no top-level symbol on an implementation (it
    // belongs on a method), so the loader drops it — and neither reading counts it.
    const dir = fresh(habitly({ code: false }));
    const lock = await sb.run(['lock', '-y'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
    const implFile = path.join(dir, '.wai', 'specs', 'implementations', 'habit_portal_http.yaml');
    const impl = yaml.load(fs.readFileSync(implFile, 'utf8')) as Record<string, unknown>;
    impl.symbol = 'checkIn';
    fs.writeFileSync(implFile, yaml.dump(impl, { lineWidth: 200 }));

    const v = await sb.run(['validate'], dir);
    expect(v.all, transcript(v)).toContain('[UNKNOWN_SPEC_KEY]');
    expect(v.all).toContain('set it on that method (`methods[].symbol`)');

    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(0);
    expect(check.all).toContain('is the approved design');
    const st = await sb.run(['status'], dir);
    expect(st.all, transcript(st)).toContain('no spec has changed since');
    expect(st.all).not.toMatch(/spec changed since approval/);
  });
});

describe('solo-app: a type with no sourcePath is said so (MISSING_TYPE_SOURCE_PATH)', () => {
  // Round 3 MINOR: 10 of 11 types had no sourcePath, so only one was ever
  // shape-checked — and nothing said so.
  const habitType = { id: 'habit', subsystem: 'habits', kind: 'entity', fields: [{ name: 'id', type: 'string' }, { name: 'cadence', type: 'string' }] };

  it('a notice while the subsystem has no code, a warning once it has ("Passed with N warning(s)", --ci fails)', async () => {
    const planned = await sb.run(['validate'], fresh(habitly({ code: false, types: [habitType] })));
    expect(planned.code, transcript(planned)).toBe(0);
    expect(planned.all).toMatch(/notice \[habit\] \[MISSING_TYPE_SOURCE_PATH\]/);

    const dir = fresh(habitly({ types: [habitType] }));
    const coded = await sb.run(['validate'], dir);
    expect(coded.code, transcript(coded)).toBe(0);
    expect(coded.all).toMatch(/⚠\s+\[habit\] \[MISSING_TYPE_SOURCE_PATH\]/);
    // Round 2 MINOR: "✔ All checks passed." was printed under warnings.
    expect(coded.all).toContain('Passed with 1 warning(s)');
    expect(coded.all).not.toContain('All checks passed');
    expect((await sb.run(['validate', '--ci'], dir)).code).toBe(1);
  });

  it('control: a type naming its file is shape-checked, not reported', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      types: [{ ...habitType, sourcePath: 'src/habit.ts' }],
      extraFiles: { 'src/habit.ts': 'export interface Habit { id: string; cadence: string }\n' },
    })));
    expect(countCode(r.all, 'MISSING_TYPE_SOURCE_PATH'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
});

describe('solo-app: the technology fence on a plain design (TECH_LEAKAGE_IN_CODE)', () => {
  // Round 2 MAJOR (B2b) and round 3 MAJOR: a Portal importing `pg` and running
  // its own INSERT was silent while the design said `technologies: [postgres]`
  // — the rule compared `pg` with `postgres`. The curated package table fixes it.
  it('`technologies: [postgres]` alone: a Portal importing `pg` → TECH_LEAKAGE_IN_CODE naming the home', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      storeTechnologies: ['postgres'],
      portal: { extra: "import pg from 'pg';\nconst pool = new pg.Pool(); void pool;" },
    })));
    expect(r.all).toMatch(/\[habit_portal_http\] \[TECH_LEAKAGE_IN_CODE\] "src\/habit-portal\.ts" \(realizing habit_portal\) imports "pg", the package of technology "postgres", whose home is habit_store/);
    expect(countCode(r.all, 'TECH_LEAKAGE_IN_CODE'), transcript(r)).toBe(1);
  });

  it('`technologies: [redis]` alone: a Portal importing `ioredis` → TECH_LEAKAGE_IN_CODE', async () => {
    const r = await sb.run(['validate'], fresh(habitly({
      storeTechnologies: ['redis'],
      portal: { extra: "import Redis from 'ioredis';\nvoid Redis;" },
    })));
    expect(r.all, transcript(r)).toMatch(/\[TECH_LEAKAGE_IN_CODE\] "src\/habit-portal\.ts" \(realizing habit_portal\) imports "ioredis", the package of technology "redis"/);
  });

  it('control: an HTTP client in the Portal is no technology leak, and the store importing its own driver is home', async () => {
    const tree = habitly({ storeTechnologies: ['postgres'], portal: { extra: "import axios from 'axios';\nvoid axios;" } });
    (tree.files as Record<string, string>)['src/habit-store.ts'] = `import pg from 'pg';\nvoid pg;\n${STORE_FILE}`;
    const r = await sb.run(['validate'], fresh(tree));
    expect(countCode(r.all, 'TECH_LEAKAGE_IN_CODE'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });

  // Round 3 MINOR: mixing `postgres` and `{name: postgres, matches: [pg]}` on
  // two Stores raised two spurious spec-side TECH_LEAKAGE warnings.
  it('control: a string and an object notation of one technology raise no spurious TECH_LEAKAGE', async () => {
    const tree = habitly({ storeTechnologies: [{ name: 'postgres', matches: ['pg'] }] });
    (tree.components as Record<string, unknown>[]).push({
      id: 'user_store', componentType: 'Store', durability: 'read-through', description: 'Users kept in postgres.',
      lint: { allow: [{ code: 'UNOWNED_STORE', reason: 'simple keyed rows; lookups beyond the key are single SQL queries served by Postgres indexes' }] },
    });
    (tree.interfaces as Record<string, unknown>[]).push({ id: 'iuser_store', component: 'user_store', methods: [{ ...method('addUser', 'write'), invokedBy: { kind: 'runtime', caller: 'The sign-up worker, once per accepted registration.' } }] });
    (tree.implementations as Record<string, unknown>[]).push({ id: 'user_store_pg', contract: 'iuser_store', sourcePath: 'src/user-store.ts', technologies: ['postgres'], methods: [intent('addUser')] });
    (tree.files as Record<string, string>)['src/user-store.ts'] = 'export class UserStore { addUser(id: string): string { return id; } }\n';
    const r = await sb.run(['validate'], fresh(tree));
    expect(countCode(r.all, 'TECH_LEAKAGE'), transcript(r)).toBe(0);
  });
});

describe('solo-app: smaller fixed findings', () => {
  // Rounds 1-2 MINOR: init named the project after the folder; validate on the
  // empty tree said "All checks passed".
  it('init -y names the project from package.json; validate on the empty tree says there is nothing to check yet', async () => {
    const dir = sb.project('solo-app-r3');
    writeFile(dir, 'package.json', JSON.stringify({ name: 'habitly-api', description: 'Habit tracking API', version: '0.1.0' }));
    const init = await sb.run(['init', '-y'], dir);
    expect(init.code, transcript(init)).toBe(0);
    expect(init.all).toContain('habitly-api');
    expect(readFile(dir, '.wai/project.yaml')).toMatch(/id: habitly-api/);

    const v = await sb.run(['validate'], dir);
    expect(v.code, transcript(v)).toBe(0);
    expect(v.all).toContain('Nothing to check yet');
    expect(v.all).not.toContain('All checks passed');
  });

  // Round 2 MINOR/MAJOR: an `exports:` table in the L0 was accepted silently.
  it('an `exports:` block in the L0 → UNKNOWN_SPEC_KEY pointing at publicInterfaces', async () => {
    const dir = fresh(habitly());
    fs.appendFileSync(path.join(dir, '.wai', 'specs', '.index.yaml'), 'exports:\n  - component: habit_portal\n');
    const r = await sb.run(['validate'], dir);
    expect(r.all, transcript(r)).toMatch(/\[UNKNOWN_SPEC_KEY\][^\n]*exports[^\n]*The L0 export table is `?publicInterfaces/);
    expect(r.all).toContain('Passed with 1 warning(s)');
    expect(r.code).toBe(0);
  });

  // Rounds 1-2 MAJOR: a field rename had no tool and no trace.
  it('type rename-field keeps the old name in previousNames and the export says formerly', async () => {
    const dir = fresh(habitly({
      types: [{ id: 'habit', subsystem: 'habits', kind: 'entity', sourcePath: 'src/habit.ts', fields: [{ name: 'id', type: 'string' }, { name: 'frequency', type: 'string' }] }],
      extraFiles: { 'src/habit.ts': 'export interface Habit { id: string; frequency: string }\n' },
    }));
    const r = await sb.run(['type', 'rename-field', 'habit', 'frequency', 'cadence'], dir);
    expect(r.code, transcript(r)).toBe(0);
    expect(r.all).toContain('Renamed field "frequency"');
    expect(r.all).toContain('"cadence"');
    const typeFile = fs.readdirSync(path.join(dir, '.wai', 'specs', 'types')).find((f) => f.startsWith('habit'))!;
    const spec = yaml.load(readFile(dir, `.wai/specs/types/${typeFile}`)) as { fields: Array<{ name: string; previousNames?: string[] }> };
    expect(spec.fields.find((f) => f.name === 'cadence')?.previousNames).toEqual(['frequency']);

    const exp = await sb.run(['export'], dir);
    expect(exp.code, transcript(exp)).toBe(0);
    expect(exp.stdout).toMatch(/"formerly":\s*\[\s*"frequency"\s*\]/);
    // The code still says `frequency`: type-shape conformance sees the pair.
    const v = await sb.run(['validate'], dir);
    expect(v.all, transcript(v)).toContain('[UNREALIZED_TYPE_FIELD]');
    expect(v.all).toContain('[UNDECLARED_TYPE_FIELD]');
  });

  // Round 3 MINOR/MAJOR: interfaces in one shared contracts.ts made the call
  // tracer give up (22 warnings) until the code was restructured.
  it('interfaces in a shared contracts.ts: the narrated calls are still traced', async () => {
    const tree = habitly();
    const files = tree.files as Record<string, string>;
    files['src/contracts.ts'] = [
      'export interface IHabitStore { addCheckIn(id: string): string; find(id: string): string }',
      'export interface IHabitOrchestrator { checkIn(id: string): string }', '',
    ].join('\n');
    files['src/habit-store.ts'] = `import type { IHabitStore } from './contracts.js';\n${STORE_FILE.replace('class HabitStore', 'class HabitStore implements IHabitStore')}`;
    files['src/habit-orchestrator.ts'] = ORCH_FILE
      .replace("import type { HabitStore } from './habit-store.js';", "import type { IHabitStore, IHabitOrchestrator } from './contracts.js';")
      .replace('class HabitOrchestrator', 'class HabitOrchestrator implements IHabitOrchestrator')
      .replace('checkins: HabitStore', 'checkins: IHabitStore');
    files['src/habit-portal.ts'] = portalFile({ storeImport: "import type { IHabitOrchestrator } from './contracts.js';", field: 'private readonly unused?: string' })
      .replace("import type { HabitOrchestrator } from './habit-orchestrator.js';\n", '')
      .replace('habits: HabitOrchestrator', 'habits: IHabitOrchestrator');
    const r = await sb.run(['validate'], fresh(tree));
    expect(countCode(r.all, 'CALL_STEP_UNREALIZED'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'CALL_ORIGIN_UNRESOLVED'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
});
