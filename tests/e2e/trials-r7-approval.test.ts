import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createTrialSandbox, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-7 trial regression journeys — approval and lock, on the BUILT CLI.
// Each replays a probe the round-7 trials ran by hand on their upgrade
// fixtures and asserts exit codes and the words a person reads.
//
//   1  a rule-tuning change is stale with one sentence naming it, and `lock`
//      then takes a real approval (never a restamp)
//   2  a member's release stamp never moves the family root's approval, and a
//      no-op lock leaves .wai/lock.json untouched
//   3  a bogus release stamp (newer, or no version) moves nothing: the release
//      is no part of the approval
//   4  `lock --subsystem` is refused as a first approval
//   5  `member attach --report` announces the findings its result will have
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, id, name: id,
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false },
    ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

const ENTRY = { kind: 'entry', caller: 'Browsers of the habit tracker, over the public internet.' };
const DESIGN_ONLY = { allow: [{ code: 'MISSING_SOURCE_PATH', reason: 'design-only e2e journey — the code lives outside this scratch project' }] };

/** Habitly: one subsystem with a Portal and its orchestrator. */
function habitly(name = 'Habitly'): FixtureTree {
  return {
    system: { name, vision: 'A habit-tracking API for people building routines.' },
    subsystems: [{ id: 'habits', description: 'Habits and their check-ins.' }],
    components: [
      { id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: ENTRY, dependsOn: ['habit_orchestrator'] },
      { id: 'habit_orchestrator', componentType: 'Orchestrator' },
    ],
    interfaces: [
      { id: 'ihabit_portal', component: 'habit_portal', methods: [{ name: 'checkIn', description: 'Record a check-in.', signature: 'checkIn(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/check-ins' } }] },
      { id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [{ name: 'checkIn', description: 'Record a check-in.', signature: 'checkIn(): void', returns: 'void' }] },
    ],
    implementations: [
      { id: 'habit_portal_impl', contract: 'ihabit_portal', lint: DESIGN_ONLY, methods: [{ name: 'checkIn', narrative: [{ stepNumber: 1, type: 'call', description: 'Record it.', targetComponent: 'habit_orchestrator', targetMethod: 'checkIn' }] }] },
      { id: 'habit_orchestrator_impl', contract: 'ihabit_orchestrator', lint: DESIGN_ONLY, methods: [{ name: 'checkIn', detail: 'intent', intent: 'Records one check-in for today on the habit it names, and fails when that habit is unknown or archived.' }] },
    ],
  };
}

let sb: TrialSandbox;

beforeAll(() => {
  sb = createTrialSandbox('r7-approval');
});

afterAll(async () => {
  await sb?.cleanup();
});

/** Materialize Habitly at a directory under its own id. */
function habitlyAt(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  materializeFixtureProject(dir, habitly(id));
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml(id, extra));
}

async function lockIn(dir: string): Promise<void> {
  const lock = await sb.run(['lock', '--yes'], dir);
  expect(lock.code, transcript(lock)).toBe(0);
}

const record = (dir: string): Record<string, any> => JSON.parse(readFile(dir, '.wai/lock.json'));
const writeRecord = (dir: string, value: Record<string, unknown>): void => writeFile(dir, '.wai/lock.json', `${JSON.stringify(value, null, 2)}\n`);

/** The record with another release's stamp over the same design: the stamp is the only thing that differs. */
function stampedBy(dir: string, validatorVersion: string): Record<string, any> {
  const r = record(dir);
  expect(r.parts, 'a format-4 lock records its approval parts').toBeDefined();
  const older = { ...r, validatorVersion };
  writeRecord(dir, older);
  return older;
}

describe('1 — a rule-tuning change is stale with one sentence; `lock` then takes a real approval (round 7: solo-app, tinkerer, platform)', () => {
  it('lock-check names the rule tuning, a lock without --yes asks and writes nothing, the real lock records the new parts', async () => {
    const dir = sb.project('rule-tuned');
    habitlyAt(dir, 'habitly');
    await lockIn(dir);
    const old = record(dir);
    // The team tunes a rule: part of the policy the approval covers.
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('habitly', { rules: { ...BASE_FIXTURE_RULES, sddRuleSeverity: { UNOWNED_STORE: 'off' } } }));

    const check = await sb.run(['lock-check', '--strict'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toMatch(/rule tuning/);
    expect(check.all).not.toMatch(/release stamp/i);
    const status = await sb.run(['status'], dir);
    expect(status.all).toMatch(/rule tuning/);

    // No restamp: without --yes in a non-interactive shell the lock asks, so it writes nothing.
    const asks = await sb.run(['lock'], dir);
    expect(asks.code, transcript(asks)).toBe(1);
    expect(record(dir).lockedAt).toBe(old.lockedAt);
    // A real approval records the new parts.
    await lockIn(dir);
    const approved = record(dir);
    expect(approved.lockedAt).not.toBe(old.lockedAt);
    expect(approved.restamped).toBeUndefined();
    expect(approved.parts.rules).not.toBe(old.parts.rules);
    expect(approved.parts.design).toBe(old.parts.design);
    const after = await sb.run(['lock-check', '--strict'], dir);
    expect(after.code, transcript(after)).toBe(0);
  });
});

describe('2 — a release stamp never moves the family approval (round 7: platform top-1)', () => {
  it('each member is approved at its own root; a stamp change keeps the root approved; a no-op lock leaves .wai/lock.json untouched', async () => {
    const root = sb.project('family');
    const lib = path.join(root, 'libs', 'lib');
    habitlyAt(lib, 'lib');
    habitlyAt(root, 'shop', { members: { lib: 'libs/lib' } });
    await lockIn(lib);
    await lockIn(root);
    stampedBy(lib, '5.1.1-dev.100');
    stampedBy(root, '5.1.1-dev.100');

    const held = await sb.run(['lock-check', '--strict'], root);
    expect(held.code, transcript(held)).toBe(0);
    expect(held.all).not.toContain('re-validated under');

    // The member has nothing to approve: no review asked, no restamp, the file untouched.
    const bytes = readFile(lib, '.wai/lock.json');
    const noop = await sb.run(['lock', '--yes'], lib);
    expect(noop.code, transcript(noop)).toBe(0);
    expect(noop.all).not.toContain('release stamp is refreshed');
    expect(readFile(lib, '.wai/lock.json')).toBe(bytes);
    expect(record(lib).restamped).toBeUndefined();

    // The root is not asked to re-approve anything.
    const rootCheck = await sb.run(['lock-check', '--strict'], root);
    expect(rootCheck.code, transcript(rootCheck)).toBe(0);
    expect(rootCheck.all).not.toContain('re-approved at their own roots');
  });
});

describe('3 — a bogus release stamp moves nothing: the release is no part of the approval (round 7: tinkerer, lib-and-app R7-2)', () => {
  for (const stamp of ['9.9.9', 'banana']) {
    it(`validatorVersion ${stamp}`, async () => {
      const dir = sb.project(`stamp-${stamp.replace(/W/g, '')}`);
      habitlyAt(dir, 'habitly');
      await lockIn(dir);
      stampedBy(dir, stamp);
      const check = await sb.run(['lock-check', '--strict'], dir);
      expect(check.code, transcript(check)).toBe(0);
      expect(check.all).toContain('The design in this tree is the approved design');
      expect(check.all).not.toMatch(/release stamp|re-validated under|newer wairon/);
    });
  }
});

describe('4 — `lock --subsystem` as a first approval (round 7: tinkerer N3)', () => {
  it('is refused, saying a first approval covers the whole tree, and writes nothing', async () => {
    const dir = sb.project('first-subsystem');
    habitlyAt(dir, 'habitly');
    const lock = await sb.run(['lock', '--subsystem', 'habits', '--yes'], dir);
    expect(lock.code, transcript(lock)).not.toBe(0);
    expect(lock.all).toContain('first approval covers the whole tree');
    expect(fs.existsSync(path.join(dir, '.wai', 'lock.json'))).toBe(false);
  });
});

describe('6 — `rules.conformance.requireCode: true`, spelled as cli.md spells it, takes effect (round 7: lib-and-app R7-3)', () => {
  it('reports the unlinked designs as errors naming the setting; without it they are notices', async () => {
    const dir = sb.project('require-code');
    habitlyAt(dir, 'habitly');
    const plain = await sb.run(['validate'], dir);
    expect(plain.code, transcript(plain)).toBe(0);
    expect(plain.all).not.toContain('rules.conformance.requireCode');
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('habitly', { rules: { ...BASE_FIXTURE_RULES, conformance: { requireCode: true } } }));
    const strict = await sb.run(['validate'], dir);
    expect(strict.code, transcript(strict)).toBe(1);
    expect(strict.all).toContain('an error because rules.conformance.requireCode asks every designed implementation to have code');
    expect(strict.all).not.toContain('UNKNOWN_CONFIG_KEY');
  });
});

describe('5 — a migration announces the findings its result will have (round 7: lib-and-app R7-10)', () => {
  it('`member attach --report` names the new finding before anything is written', async () => {
    const root = sb.project('attach');
    habitlyAt(root, 'shop');
    await lockIn(root);
    habitlyAt(path.join(root, 'tools'), 'tools');
    const before = readFile(root, '.wai/project.yaml');
    // Its alias reads like the root's own subsystem "habits": the result reports it, so the plan does.
    const report = await sb.run(['member', 'attach', 'habits', 'tools', '--report'], root);
    expect(report.code, transcript(report)).toBe(0);
    expect(report.all).toMatch(/after attach: 1 new warning\(s\) the projects it changes do not report now: LOCAL_ID_SHADOWS_PROJECT/);
    expect(readFile(root, '.wai/project.yaml')).toBe(before);
  });
});
