import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    schemaVersion: '1.0.0', id, name: id,
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

/** Rewrite the lock record as an older release would have taken it over the same design: only its release part differs. */
function takenByOlderRelease(dir: string, legacy = false): Record<string, any> {
  const record = JSON.parse(readFile(dir, '.wai/lock.json'));
  expect(record.gateParts, 'a lock records its gate parts').toBeDefined();
  const older = { ...record, stateId: { ...record.stateId, digest: 'e'.repeat(64) }, validatorVersion: '5.1.1-dev.100' };
  if (legacy) delete older.gateParts;
  else older.gateParts = { ...record.gateParts, release: 'older-release-doctrine' };
  writeFile(dir, '.wai/lock.json', `${JSON.stringify(older, null, 2)}\n`);
  return older;
}

describe('1 — a wairon upgrade never stales an unchanged approval by itself (round 6, M3)', () => {
  it('re-validates the approved design and carries the approval over, saying so on every surface; `lock` refreshes its stamp without a review', async () => {
    const dir = await lockedHabitly('carry');
    const older = takenByOlderRelease(dir);
    const before = readFile(dir, '.wai/lock.json');

    const check = await sb.run(['lock-check', '--strict'], dir);
    expect(check.code, transcript(check)).toBe(0);
    expect(check.all).toContain('Approved under wairon 5.1.1-dev.100, re-validated under');
    expect(check.all).not.toContain('an input the gate identity covers');

    const status = await sb.run(['status'], dir);
    expect(status.all).toContain('re-validated under');
    const validate = await sb.run(['validate'], dir);
    expect(validate.all).toContain('Approval: approved under wairon 5.1.1-dev.100, re-validated under');
    // Nothing was written by any of them.
    expect(readFile(dir, '.wai/lock.json')).toBe(before);

    const lock = await sb.run(['lock'], dir); // no --yes: a refresh asks nothing
    expect(lock.code, transcript(lock)).toBe(0);
    expect(lock.all).toContain('release stamp is refreshed');
    const record = JSON.parse(readFile(dir, '.wai/lock.json'));
    expect(record.lockedAt).toBe(older.lockedAt);
    expect(record.restamped).toMatchObject({ fromVersion: '5.1.1-dev.100', by: 'wairon lock' });
    const after = await sb.run(['lock-check', '--strict'], dir);
    expect(after.code, transcript(after)).toBe(0);
    expect(after.all).not.toContain('re-validated under');
  });

  it('a record from before gate parts is never carried (round 7): it cannot prove its own inputs unchanged', async () => {
    const dir = await lockedHabitly('carry-legacy');
    takenByOlderRelease(dir, true);
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('before wairon recorded its inputs separately');
  });

  it('when the new rules find an issue in the approved design, the approval is stale for exactly that issue', async () => {
    const dir = await lockedHabitly('stale-by-release', true);
    takenByOlderRelease(dir);
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('the new release');
    expect(check.all).toContain('UNUSED_COMPONENT');
    expect(check.all).not.toContain('an input the gate identity covers');
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
