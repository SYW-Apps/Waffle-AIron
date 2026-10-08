import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
//   1  a record from before gate parts plus a rule-tuning change is stale with
//      one sentence, and `lock` then takes a real approval (never a restamp)
//   2  a member's restamp keeps the family root approved, and a no-op lock
//      leaves .wai/lock.json untouched
//   3  a bogus release stamp (newer, or no version) is no upgrade
//   4  `lock --subsystem` is refused as a first approval
//   5  `member attach --report` announces the findings its result will have
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id,
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

/** The record as an older release took it over the same design: its release part, digest and stamp differ. */
function takenByOlderRelease(dir: string, fill: string, edit: (r: Record<string, any>) => Record<string, any> = (r) => r): Record<string, any> {
  const r = record(dir);
  expect(r.gateParts, 'a lock records its gate parts').toBeDefined();
  const older = edit({ ...r, stateId: { ...r.stateId, digest: fill.repeat(64) }, gateParts: { ...r.gateParts, release: 'older-release-doctrine' }, validatorVersion: '5.1.1-dev.100' });
  writeRecord(dir, older);
  return older;
}

describe('1 — a record from before gate parts never carries over (round 7: solo-app, tinkerer, platform)', () => {
  it('with a rule tuned in the same upgrade it is stale with one sentence; `lock` then takes a real approval', async () => {
    const dir = sb.project('pre-parts');
    habitlyAt(dir, 'habitly');
    await lockIn(dir);
    // A round-1..5 record: no gate parts, an older stamp — and the team tunes a rule in the same PR.
    const { gateParts: _parts, ...legacy } = record(dir);
    const old = { ...legacy, stateId: { ...legacy.stateId, digest: 'd'.repeat(64) }, validatorVersion: '5.1.1-dev.109', lockedAt: '2026-01-02T00:00:00.000Z' };
    writeRecord(dir, old);
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('habitly', { rules: { ...BASE_FIXTURE_RULES, sddRuleSeverity: { UNOWNED_STORE: 'off' } } }));

    const check = await sb.run(['lock-check', '--strict'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('Approved under wairon 5.1.1-dev.109 before wairon recorded its inputs separately — re-lock once to record them; later upgrades then carry over.');
    expect(check.all).not.toContain('every input the project decides are as approved');
    const status = await sb.run(['status'], dir);
    expect(status.all).toContain('before wairon recorded its inputs separately');

    // No restamp: without --yes in a non-interactive shell the lock asks, so it writes nothing.
    const asks = await sb.run(['lock'], dir);
    expect(asks.code, transcript(asks)).toBe(1);
    expect(asks.all).not.toContain('release stamp is refreshed');
    expect(record(dir).lockedAt).toBe(old.lockedAt);
    // A real approval records the parts.
    await lockIn(dir);
    const approved = record(dir);
    expect(approved.lockedAt).not.toBe(old.lockedAt);
    expect(approved.restamped).toBeUndefined();
    expect(approved.gateParts).toBeDefined();
    const after = await sb.run(['lock-check', '--strict'], dir);
    expect(after.code, transcript(after)).toBe(0);
  });
});

describe('2 — a restamp is no re-approval, for a family too (round 7: platform top-1)', () => {
  it('a member\'s restamp keeps the root approved; a no-op lock leaves .wai/lock.json untouched', async () => {
    const root = sb.project('family');
    const lib = path.join(root, 'libs', 'lib');
    habitlyAt(lib, 'lib');
    habitlyAt(root, 'shop', { members: { lib: 'libs/lib' } });
    await lockIn(lib);
    takenByOlderRelease(lib, 'a');
    await lockIn(root);
    takenByOlderRelease(root, 'b');

    const carried = await sb.run(['lock-check', '--strict'], root);
    expect(carried.code, transcript(carried)).toBe(0);
    expect(carried.all).toContain('re-validated under');

    // The member restamps under the new release: no review asked, the approval kept.
    const restamp = await sb.run(['lock'], lib);
    expect(restamp.code, transcript(restamp)).toBe(0);
    expect(restamp.all).toContain('release stamp is refreshed');
    expect(record(lib).restamped.subject).toBeDefined();

    // The root is not asked to re-approve anything.
    const rootCheck = await sb.run(['lock-check', '--strict'], root);
    expect(rootCheck.code, transcript(rootCheck)).toBe(0);
    expect(rootCheck.all).not.toContain('re-approved at their own roots');

    // A no-op lock at the member: the file stays byte for byte, and it says so.
    const bytes = readFile(lib, '.wai/lock.json');
    const noop = await sb.run(['lock', '--yes'], lib);
    expect(noop.code, transcript(noop)).toBe(0);
    expect(noop.all).toContain('left untouched');
    expect(readFile(lib, '.wai/lock.json')).toBe(bytes);
  });
});

describe('3 — a bogus release stamp is no upgrade (round 7: tinkerer, lib-and-app R7-2)', () => {
  for (const [stamp, words] of [['9.9.9', 'written by a newer wairon (9.9.9)'], ['banana', 'is no wairon version']] as const) {
    it(`validatorVersion ${stamp}`, async () => {
      const dir = sb.project(`stamp-${stamp.replace(/\W/g, '')}`);
      habitlyAt(dir, 'habitly');
      await lockIn(dir);
      takenByOlderRelease(dir, 'c', (r) => ({ ...r, validatorVersion: stamp }));
      const check = await sb.run(['lock-check'], dir);
      expect(check.code, transcript(check)).toBe(1);
      expect(check.all).toContain(words);
      expect(check.all).not.toContain('re-validated under');
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
