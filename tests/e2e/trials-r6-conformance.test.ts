import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FixtureTree } from '../rules-matrix/harness';
import { createTrialSandbox, countCode, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import {
  geoKit, habitly, NO_FIELD, orchestratorFile, portalFile, projectYaml, routePlanner, type HabitlyOptions,
} from '../helpers/conformance-r6-trees';

// ---------------------------------------------------------------------------
// Round-6 user trials, the code gate: two computed-key bypasses still silent
// (solo-app D24, D24d), and the false findings honest code drew — a port to a
// dependency not written yet (platform top-1), a Portal's unnarrated READ
// through an Orchestrator verb declaring no effect (solo-app, platform), a
// node:http handler's imposed parameters (lib-and-app R6-17) — and the two
// misses: a parameter rename under an external type (lib-and-app R6-19) and a
// technology import moved into a helper module (platform).
//
// Every shape runs with its control. Fixture: Habitly — Portal habit_portal ->
// Orchestrator habit_orchestrator -> Store habit_store (addCheckIn write, find
// read); RoutePlanner consuming GeoKit's coordinate type.
// ---------------------------------------------------------------------------

let sb: TrialSandbox;
let seq = 0;
const fresh = (tree: FixtureTree): string => sb.materialize(`p${++seq}`, tree);
const habits = (o: HabitlyOptions = {}): string => fresh(habitly(o));

beforeAll(() => { sb = createTrialSandbox('r6conf'); });
afterAll(async () => { await sb?.cleanup(); });

describe('r6 (solo-app D24 / D24d): a computed key on a data component fails closed however it is cast', () => {
  it('D24d `const name = \'addCheckIn\'; (this.checkins as any)[name](id)` in the Portal → PORTAL_CALL_UNRESOLVED, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ portal: portalFile({ body: "const name = 'addCheckIn'; (this.checkins as any)[name](id);" }) }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/⚠\s+\[habit_portal_impl\] \[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn/);
  });
  it('control — D24d naming the read: --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ portal: portalFile({ body: "const name = 'find'; (this.checkins as any)[name](id);" }) }));
    expect(countCode(r.all, 'PORTAL_CALL_UNRESOLVED'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
  it('D24 a key built from an expression, taken as a value and invoked through call() → PORTAL_CALL_UNRESOLVED, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], habits({
      portal: portalFile({ body: "const k = ('add' + 'CheckIn') as keyof HabitStore; const f = this.checkins[k] as unknown as (x: string) => string; f.call(this.checkins, id);" }),
    }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[PORTAL_CALL_UNRESOLVED\][^\n]*habit_store\.addCheckIn/);
  });
  it('control — the same shape on a local table of formatters: nothing', async () => {
    const r = await sb.run(['validate', '--ci'], habits({
      portal: portalFile({ body: "const table = { plain: (x: string) => x, loud: (x: string) => x }; const k = ('pl' + 'ain') as keyof typeof table; const f = table[k]; f.call(table, id);", field: NO_FIELD, head: '' }),
    }));
    expect(countCode(r.all, 'PORTAL_CALL_UNRESOLVED'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
  it('D24d in the Orchestrator\'s read-narrated streak → CALL_ORIGIN_UNRESOLVED fails closed; control: the read is clean', async () => {
    const loud = await sb.run(['validate', '--ci'], habits({ orchestrator: orchestratorFile({ extra: "const name = 'addCheckIn'; (this.checkins as any)[name](id);" }) }));
    expect(loud.code, transcript(loud)).toBe(1);
    expect(loud.all).toMatch(/\[habit_orchestrator_impl\] \[CALL_ORIGIN_UNRESOLVED\] Method "streak"[^\n]*habit_store\.addCheckIn[^\n]*fails closed/);
    const quiet = await sb.run(['validate', '--ci'], habits({ orchestrator: orchestratorFile({ extra: "const name = 'find'; (this.checkins as any)[name](id);" }) }));
    expect(quiet.code, transcript(quiet)).toBe(0);
  });
});

describe('r6 (platform top-1): honest code with a port to a dependency not written yet', () => {
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

  it('the Store unwritten → CALL_TARGET_PLANNED (a notice), no CALL_ORIGIN_UNRESOLVED, --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ store: null, orchestrator: PORT_ORCHESTRATOR }));
    expect(countCode(r.all, 'CALL_ORIGIN_UNRESOLVED'), transcript(r)).toBe(0);
    expect(r.all).toMatch(/\[habit_orchestrator_impl\] \[CALL_TARGET_PLANNED\][^\n]*habit_store\.addCheckIn[^\n]*src\/habit-store\.ts/);
    expect(r.code, transcript(r)).toBe(0);
  });
  it('control — once the Store\'s file exists and still realizes nothing the port names: CALL_ORIGIN_UNRESOLVED, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ store: 'export const placeholder = 1;\n', orchestrator: PORT_ORCHESTRATOR }));
    expect(countCode(r.all, 'CALL_ORIGIN_UNRESOLVED'), transcript(r)).toBeGreaterThan(0);
    expect(countCode(r.all, 'CALL_TARGET_PLANNED')).toBe(0);
    expect(r.code).toBe(1);
  });
});

describe('r6 (solo-app, platform): a Portal\'s unnarrated call through an Orchestrator verb declaring no effect', () => {
  const calling = portalFile({ body: 'this.habits.archive(id);', field: NO_FIELD, head: '' });

  it('the verb\'s own narrative only reads → no UNDECLARED_WRITE_CALL, --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ portal: calling, archiveCalls: 'find' }));
    expect(countCode(r.all, 'UNDECLARED_WRITE_CALL'), transcript(r)).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
  it('control — its narrative records a check-in → UNDECLARED_WRITE_CALL as a change of state, --ci exits 1', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ portal: calling, archiveCalls: 'addCheckIn' }));
    expect(r.code, transcript(r)).toBe(1);
    expect(r.all).toMatch(/\[habit_portal_impl\] \[UNDECLARED_WRITE_CALL\][^\n]*change state[^\n]*habit_orchestrator\.archive/);
  });
  it('no narrative at all → the call is named as unnarrated with its effect undeclared, never as a write', async () => {
    const r = await sb.run(['validate'], habits({ portal: calling, archiveIntent: true }));
    expect(r.all, transcript(r)).toMatch(/\[UNDECLARED_WRITE_CALL\][^\n]*unnarrated call to habit_orchestrator\.archive \(effect undeclared\)/);
    expect(r.all).not.toMatch(/\[UNDECLARED_WRITE_CALL\][^\n]*change state/);
  });
});

describe('r6 (lib-and-app R6-17): a node:http handler\'s imposed parameters', () => {
  const handler = (signature: string): string => habits({ portal: portalFile({ signature, field: NO_FIELD, head: '', dispatch: "params.id ?? ''" }) });

  // Round 7 tightened this: an underscore is believed only where the
  // parameter is provably unused, and a params bag in the place of the
  // contract's id is a substitution (tests/e2e/trials-r7-conformance.test.ts).
  // The honest shape takes the contract's own id after the unused handles.
  it('`checkIn(_req, _url, id)` realizing `checkIn(id)`, the handles unused → no UNDECLARED_PARAM, no PARAM_NAME_MISMATCH, --ci exits 0', async () => {
    const r = await sb.run(['validate', '--ci'], habits({ portal: portalFile({ signature: '_req: object, _url: URL, id: string', field: NO_FIELD, head: '' }) }));
    expect(countCode(r.all, 'UNDECLARED_PARAM'), transcript(r)).toBe(0);
    expect(countCode(r.all, 'PARAM_NAME_MISMATCH')).toBe(0);
    expect(r.code, transcript(r)).toBe(0);
  });
  it('control — the request and URL under plain names → UNDECLARED_PARAM', async () => {
    const r = await sb.run(['validate'], handler('req: object, url: URL, params: Record<string, string>'));
    expect(countCode(r.all, 'UNDECLARED_PARAM'), transcript(r)).toBe(1);
  });
});

describe('r6 (lib-and-app R6-19): a rename under an EXTERNAL parameter type', () => {
  const planner = async (signature: string): Promise<{ code: number; all: string; t: string }> => {
    const n = ++seq;
    const geo = sb.materialize(`geo${n}`, geoKit());
    writeFile(geo, '.wai/project.yaml', projectYaml('geo-kit'));
    const rp = sb.materialize(`rp${n}`, routePlanner(signature));
    writeFile(rp, '.wai/project.yaml', projectYaml('route-planner', { externals: { geo: { source: { path: `../geo${n}` } } } }));
    const pin = await sb.run(['externals', 'pin'], rp);
    expect(pin.code, transcript(pin)).toBe(0);
    const r = await sb.run(['validate'], rp);
    return { code: r.code, all: r.all, t: transcript(r) };
  };

  it('`sequence(stops: list<geo::coordinate>)` realized as `sequence(points: Coordinate[])` → PARAM_NAME_MISMATCH', async () => {
    const r = await planner('points: Coordinate[]');
    expect(r.all, r.t).toMatch(/\[stop_sequencer_impl\] \[PARAM_NAME_MISMATCH\][^\n]*"stops" \(the code calls it "points"\)/);
  });
  it('control — the same name: nothing', async () => {
    const r = await planner('stops: Coordinate[]');
    expect(countCode(r.all, 'PARAM_NAME_MISMATCH'), r.t).toBe(0);
  });
});

describe('r6 (platform): a technology import moved into a helper module', () => {
  const DB = "import { Client } from 'pg';\nexport const db = new Client();\n";

  it('the Portal imports src/db.ts, which imports pg → TECH_LEAKAGE_IN_CODE naming the hop', async () => {
    const r = await sb.run(['validate'], habits({
      postgres: true, portal: portalFile({ field: NO_FIELD, head: "import { db } from './db.js';", body: 'void db;' }), files: { 'src/db.ts': DB },
    }));
    expect(r.all, transcript(r)).toMatch(/\[TECH_LEAKAGE_IN_CODE\] "src\/habit-portal\.ts"[^\n]*imports "pg" through "src\/db\.ts"[^\n]*whose home is habit_store/);
  });
  it('control — only the Store, the home, imports the helper: nothing', async () => {
    const r = await sb.run(['validate'], habits({
      postgres: true,
      store: "import { db } from './db.js';\nexport class HabitStore {\n  addCheckIn(id: string): string { void db; return id; }\n  find(id: string): string { return id; }\n}\n",
      files: { 'src/db.ts': DB },
    }));
    expect(countCode(r.all, 'TECH_LEAKAGE_IN_CODE'), transcript(r)).toBe(0);
  });
});
