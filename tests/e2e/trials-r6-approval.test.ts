import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createTrialSandbox, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-6 trial regression journeys — approval across wairon upgrades, the
// inputs a stale approval names, an unreadable L0, and the root CLAUDE.md a
// repository already has. Each replays a probe the round-6 trials ran by hand
// on the BUILT CLI and asserts exit codes and the words a person reads.
//
//   1  a lock taken by an older release over an unchanged design is
//      re-validated and carried over (and `lock` refreshes its stamp); when
//      the new rules find an issue it is stale for exactly that issue
//   2  after `network declare` the stale verdict names the network declaration
//   3  a corrupt or empty L0 with specs below it fails plain lock-check
//   4  init, lock, generate and doctor --fix keep the user's root CLAUDE.md
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

/** Habitly: one subsystem with a Portal and its orchestrator; `unreached` adds a component nothing reaches (UNUSED_COMPONENT). */
function habitly(unreached = false): FixtureTree {
  return {
    system: { name: 'Habitly', vision: 'A habit-tracking API for people building routines.' },
    subsystems: [{ id: 'habits', description: 'Habits and their check-ins.' }],
    components: [
      { id: 'habit_portal', componentType: 'Portal', transport: 'HTTP', invokedBy: ENTRY, dependsOn: ['habit_orchestrator'] },
      { id: 'habit_orchestrator', componentType: 'Orchestrator' },
      ...(unreached ? [{ id: 'streak_orchestrator', componentType: 'Orchestrator' }] : []),
    ],
    interfaces: [
      { id: 'ihabit_portal', component: 'habit_portal', methods: [{ name: 'checkIn', description: 'Record a check-in.', signature: 'checkIn(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/check-ins' } }] },
      { id: 'ihabit_orchestrator', component: 'habit_orchestrator', methods: [{ name: 'checkIn', description: 'Record a check-in.', signature: 'checkIn(): void', returns: 'void' }] },
      ...(unreached ? [{ id: 'istreak_orchestrator', component: 'streak_orchestrator', methods: [{ name: 'streak', description: 'Count a streak.', signature: 'streak(): void', returns: 'void' }] }] : []),
    ],
    implementations: [
      { id: 'habit_portal_impl', contract: 'ihabit_portal', lint: DESIGN_ONLY, methods: [{ name: 'checkIn', narrative: [{ stepNumber: 1, type: 'call', description: 'Record it.', targetComponent: 'habit_orchestrator', targetMethod: 'checkIn' }] }] },
      { id: 'habit_orchestrator_impl', contract: 'ihabit_orchestrator', lint: DESIGN_ONLY, methods: [{ name: 'checkIn', detail: 'intent', intent: 'Records one check-in for today on the habit it names, and fails when that habit is unknown or archived.' }] },
      ...(unreached ? [{ id: 'streak_orchestrator_impl', contract: 'istreak_orchestrator', lint: DESIGN_ONLY, methods: [{ name: 'streak', detail: 'intent', intent: 'Counts the days in a row a habit was checked in, ending today or yesterday.' }] }] : []),
    ],
  };
}

let sb: TrialSandbox;

beforeAll(() => {
  sb = createTrialSandbox('r6-approval');
});

afterAll(async () => {
  await sb?.cleanup();
});

/** A locked Habitly project. */
async function lockedHabitly(name: string, unreached = false): Promise<string> {
  const dir = sb.project(name);
  materializeFixtureProject(dir, habitly(unreached));
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('habitly'));
  const lock = await sb.run(['lock', '--yes'], dir);
  expect(lock.code, transcript(lock)).toBe(0);
  return dir;
}

/** Rewrite the lock record as an older release would have stamped it over the same design: only its release stamp differs. */
function takenByOlderRelease(dir: string): Record<string, any> {
  const record = JSON.parse(readFile(dir, '.wai/lock.json'));
  expect(record.parts, 'a format-4 lock records its approval parts').toBeDefined();
  const older = { ...record, validatorVersion: '5.1.1-dev.100' };
  writeFile(dir, '.wai/lock.json', `${JSON.stringify(older, null, 2)}
`);
  return older;
}

describe('1 — a wairon release never moves an approval (round 6 M3, wairon 7: approval = own design + policy only)', () => {
  it('a record stamped by another release still approves the unchanged design, on every surface, and nothing writes the record', async () => {
    const dir = await lockedHabitly('carry');
    takenByOlderRelease(dir);
    const before = readFile(dir, '.wai/lock.json');

    const check = await sb.run(['lock-check', '--strict'], dir);
    expect(check.code, transcript(check)).toBe(0);
    expect(check.all).toContain('The design in this tree is the approved design');
    // The release is no part of the approval: no re-validation, restamp or release notice anywhere.
    expect(check.all).not.toContain('re-validated under');
    expect(check.all).not.toMatch(/release stamp/i);

    const status = await sb.run(['status'], dir);
    expect(status.all).not.toContain('re-validated under');
    expect(status.all).not.toMatch(/drifted/);
    const validate = await sb.run(['validate'], dir);
    expect(validate.all).not.toContain('re-validated under');
    expect(readFile(dir, '.wai/lock.json')).toBe(before);

    // `lock` has nothing to approve and leaves the record, release stamp included, exactly as it is.
    const lock = await sb.run(['lock', '--yes'], dir);
    expect(lock.code, transcript(lock)).toBe(0);
    expect(lock.all).toContain('Nothing has changed since the last approval');
    expect(lock.all).not.toContain('release stamp is refreshed');
    expect(readFile(dir, '.wai/lock.json')).toBe(before);
    expect(JSON.parse(readFile(dir, '.wai/lock.json')).restamped).toBeUndefined();
  });

  it('a record from before approval parts (format 3, wairon 6) is refused by name with the upgrade — never judged, never carried by a check', async () => {
    const dir = await lockedHabitly('carry-legacy');
    const record = JSON.parse(readFile(dir, '.wai/lock.json'));
    delete record.parts;
    record.format = 3;
    writeFile(dir, '.wai/lock.json', `${JSON.stringify(record, null, 2)}
`);
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('it is lock record format 3, written by an earlier wairon major (this release reads format 4)');
    expect(check.all).toContain('Run `wairon upgrade`');
  });

  it('a finding the rules raise on the approved design is for validate to report, never a stale approval: lock-check holds, validate names it', async () => {
    const dir = await lockedHabitly('stale-by-release', true);
    takenByOlderRelease(dir);
    const check = await sb.run(['lock-check', '--strict'], dir);
    expect(check.code, transcript(check)).toBe(0);
    expect(check.all).not.toContain('the new release');
    const validate = await sb.run(['validate'], dir);
    expect(validate.all).toContain('UNUSED_COMPONENT');
  });
});

describe('2 — a stale approval names the input that moved (round 6)', () => {
  it('after `network declare` the verdict names the network declaration', async () => {
    const dir = await lockedHabitly('network');
    const declare = await sb.run(['network', 'declare', '--description', 'the habit tracker mesh'], dir);
    expect(declare.code, transcript(declare)).toBe(0);
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('the network declaration');
    expect(check.all).not.toContain('the doctrine, the network declaration, a consumed contract');
  });
});

describe('3 — an unreadable L0 with specs below it fails plain lock-check (round 6, tinkerer M2)', () => {
  for (const [what, text] of [['not YAML', 'x: ['], ['empty', '']] as const) {
    it(`an L0 that is ${what}`, async () => {
      const dir = await lockedHabitly(`l0-${what.replace(/\W/g, '')}`);
      writeFile(dir, '.wai/specs/.index.yaml', text);
      const check = await sb.run(['lock-check'], dir);
      expect(check.code, transcript(check)).toBe(1);
      expect(check.all).toContain('cannot be read as an L0');
      expect(check.all).not.toContain('nothing is gated');
      const status = await sb.run(['status'], dir);
      expect(status.code).toBe(1);
      expect(status.all).not.toContain('"code"');
    });
  }
});

describe('4 — the root CLAUDE.md a repository already has survives init, lock, generate and doctor --fix (round 6, B1)', () => {
  it('keeps the user\'s text and the team notes appended later', async () => {
    const dir = sb.project('own-claude');
    writeFile(dir, 'CLAUDE.md', '# My project\nOur own instructions: always run npm test.\n');
    const init = await sb.run(['init', '--yes'], dir);
    expect(init.code, transcript(init)).toBe(0);
    let text = readFile(dir, 'CLAUDE.md');
    expect(text.startsWith('# My project\nOur own instructions: always run npm test.\n')).toBe(true);
    expect(text).toContain('@.claude/CLAUDE.md');

    fs.appendFileSync(path.join(dir, 'CLAUDE.md'), '\n# Team notes\nrun npm test before every commit\n');
    const keep = (): void => {
      text = readFile(dir, 'CLAUDE.md');
      expect(text).toContain('always run npm test');
      expect(text).toContain('run npm test before every commit');
      expect(text.match(/@\.claude\/CLAUDE\.md/g)).toHaveLength(1);
    };
    // A design to approve, so the lock reconciles the guides as it does on a real project.
    const lockFiles = path.join(dir, '.wai', 'specs');
    fs.rmSync(lockFiles, { recursive: true, force: true });
    materializeFixtureProject(dir, habitly());
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('own-claude'));
    for (const args of [['lock', '--yes'], ['generate'], ['doctor', '--fix', '--yes']]) {
      const r = await sb.run(args, dir);
      expect(r.code, transcript(r)).toBe(0);
      keep();
    }
  });
});
