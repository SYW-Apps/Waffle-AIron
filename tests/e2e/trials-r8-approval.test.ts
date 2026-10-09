import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createTrialSandbox, readFile, transcript, writeFile, type TrialSandbox } from './trials-helpers';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// Round-8 trial regression journeys — approval and lock, on the BUILT CLI.
// Each replays a probe the round-8 trials ran by hand and asserts exit codes
// and the words a person reads.
//
//   1  a stamp that is no version or newer than this wairon, deleted gate
//      parts and a duplicated key are reported; `lock` replaces the stamp
//   2  a committed lock with the whole .wai/specs deleted fails closed; a
//      deleted project.yaml is named; an unreadable lock fails status and
//      validate --ci
//   3  a member whose record predates gate parts is named for that at the
//      root, never for unapproved spec changes
//   4  `lock --subsystem <member>::<subsystem>` at the root is refused
//   5  a selected pack that cannot load fails lock-check
//   8  the re-approval of an old record prints the rule tuning it records
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
  sb = createTrialSandbox('r8-approval');
});

afterAll(async () => {
  await sb?.cleanup();
});

function habitlyAt(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  materializeFixtureProject(dir, habitly(id));
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml(id, extra));
}

async function lockIn(dir: string): Promise<string> {
  const lock = await sb.run(['lock', '--yes'], dir);
  expect(lock.code, transcript(lock)).toBe(0);
  return lock.all;
}

const record = (dir: string): Record<string, any> => JSON.parse(readFile(dir, '.wai/lock.json'));
const writeRecord = (dir: string, value: Record<string, unknown>): void => writeFile(dir, '.wai/lock.json', `${JSON.stringify(value, null, 2)}\n`);

describe('1 — stamps and parts never pass silently (round 8: tinkerer, lib-and-app R8-3)', () => {
  for (const stamp of ['banana', '9.9.9'] as const) {
    it(`validatorVersion ${stamp} on a matching record is reported at every surface, and \`lock\` replaces it`, async () => {
      const dir = sb.project(`stamp-${stamp.replace(/\W/g, '')}`);
      habitlyAt(dir, 'habitly');
      await lockIn(dir);
      const approved = record(dir);
      writeRecord(dir, { ...approved, validatorVersion: stamp });

      const check = await sb.run(['lock-check', '--strict'], dir);
      expect(check.code, transcript(check)).toBe(0);
      expect(check.all).toMatch(/Notice: its release stamp .* — the identity alone decided this/);
      const status = await sb.run(['status'], dir);
      expect(status.all).toContain('replaces the stamp');
      const validate = await sb.run(['validate'], dir);
      expect(validate.all).toContain('Approval notice: its release stamp');

      const relock = await lockIn(dir);
      expect(relock).toContain('replaced with');
      expect(record(dir).validatorVersion).not.toBe(stamp);
      expect(record(dir).lockedAt).toBe(approved.lockedAt);
      const after = await sb.run(['lock-check', '--strict'], dir);
      expect(after.all).not.toContain('Notice: its release stamp');
    });
  }

  it('gateParts deleted is noticed as `{}` is; a duplicated stateId key is unreadable whichever copy comes last', async () => {
    const dir = sb.project('parts-gone');
    habitlyAt(dir, 'habitly');
    await lockIn(dir);
    const approved = record(dir);
    const { gateParts: _parts, ...partless } = approved;
    writeRecord(dir, partless);
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(0);
    expect(check.all).toContain('gate parts are ignored — the record carries none');

    const text = `${JSON.stringify(approved, null, 2)}\n`;
    writeFile(dir, '.wai/lock.json', text.replace('{', '{\n  "stateId": { "algorithm": "x", "digest": "0" },'));
    const dupFirst = await sb.run(['lock-check'], dir);
    expect(dupFirst.code, transcript(dupFirst)).toBe(1);
    expect(dupFirst.all).toContain('names the key "stateId" twice');
  });
});

describe('2 — a missing tree or configuration fails closed (round 8: tinkerer MAJOR 7)', () => {
  it('a committed lock with .wai/specs deleted fails plain lock-check, validate and lock', async () => {
    const dir = sb.project('tree-gone');
    habitlyAt(dir, 'habitly');
    await lockIn(dir);
    fs.rmSync(path.join(dir, '.wai', 'specs'), { recursive: true, force: true });
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('the design it approved is gone');
    const validate = await sb.run(['validate'], dir);
    expect(validate.code, transcript(validate)).toBe(1);
    expect(validate.all).toContain('the design it approved is gone');
    const lock = await sb.run(['lock', '--yes'], dir);
    expect(lock.code, transcript(lock)).toBe(1);
  });

  it('a deleted project.yaml is named by lock-check', async () => {
    const dir = sb.project('config-gone');
    habitlyAt(dir, 'habitly');
    await lockIn(dir);
    fs.rmSync(path.join(dir, '.wai', 'project.yaml'));
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('.wai/project.yaml) is missing');
    expect(check.all).not.toContain('network declaration');
  });

  it('an unreadable lock fails status and validate --ci (exit codes, not only a red glyph)', async () => {
    const dir = sb.project('lock-conflict');
    habitlyAt(dir, 'habitly');
    await lockIn(dir);
    writeFile(dir, '.wai/lock.json', `<<<<<<< HEAD\n${readFile(dir, '.wai/lock.json')}=======\n{}\n>>>>>>> theirs\n`);
    const status = await sb.run(['status'], dir);
    expect(status.code, transcript(status)).toBe(1);
    expect(status.all).toContain('cannot be read as an approval record');
    const validate = await sb.run(['validate', '--ci'], dir);
    expect(validate.code, transcript(validate)).toBe(1);
    expect(validate.all).toContain('cannot be read as an approval record');
  });
});

describe('3/4 — a family root names its members truthfully (round 8: platform, tinkerer)', () => {
  it('a member whose record predates gate parts is named for that; `lock --subsystem <member>::<sub>` is refused', async () => {
    const root = sb.project('family');
    const lib = path.join(root, 'libs', 'lib');
    habitlyAt(lib, 'lib');
    habitlyAt(root, 'shop', { members: { lib: 'libs/lib' } });
    await lockIn(lib);
    await lockIn(root);
    const { gateParts: _parts, ...legacy } = record(lib);
    writeRecord(lib, { ...legacy, stateId: { ...legacy.stateId, digest: 'd'.repeat(64) }, validatorVersion: '5.1.1-dev.110' });

    const check = await sb.run(['lock-check', '--strict'], root);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('its approval predates recorded inputs');
    expect(check.all).not.toContain('spec changes nobody approved');

    const before = readFile(root, '.wai/lock.json');
    const scoped = await sb.run(['lock', '--subsystem', 'lib::habits', '--yes'], root);
    expect(scoped.code, transcript(scoped)).not.toBe(0);
    expect(scoped.all).toContain("a member's subsystem is approved at the member's own root");
    expect(scoped.all).not.toContain('Specs locked');
    expect(readFile(root, '.wai/lock.json')).toBe(before);

    // The root lock now warns that the member locks first.
    const rootLock = await sb.run(['lock', '--yes'], root);
    expect(rootLock.all).toContain('The order is bottom-up');
  });
});

describe('5 — a selected pack that cannot load (round 8: solo-app)', () => {
  it('fails lock-check instead of passing while validate is red', async () => {
    const dir = sb.project('pack-unloadable');
    habitlyAt(dir, 'habitly');
    await lockIn(dir);
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('habitly', { extensions: { packs: ['./vendor/no-such-pack'], useGlobalPacks: false } }));
    const check = await sb.run(['lock-check'], dir);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('cannot load');
  });
});

describe('8 — the re-approval of an old record shows the tuning it records (round 8: solo-app)', () => {
  it('prints the rule severity override', async () => {
    const dir = sb.project('tuning-shown');
    habitlyAt(dir, 'habitly', { rules: { ...BASE_FIXTURE_RULES, sddRuleSeverity: { PORTAL_WRITE_SHORTCUT: 'notice' } } });
    await lockIn(dir);
    const { gateParts: _parts, ...legacy } = record(dir);
    writeRecord(dir, { ...legacy, stateId: { ...legacy.stateId, digest: 'd'.repeat(64) }, validatorVersion: '5.1.1-dev.110' });
    const relock = await lockIn(dir);
    expect(relock).toContain("The project's own inputs this approval records");
    expect(relock).toContain('PORTAL_WRITE_SHORTCUT → notice');
  });
});
