import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { REPO_ROOT } from './helpers';
import { createTrialSandbox, transcript, type TrialSandbox } from './trials-helpers';
import { writeV6Lock, writeProject } from '../helpers/v6-project';
import { writeYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// The upgrade journeys, replayed against the BUILT CLI.
//
//  - A project written by wairon 5 (tests/fixtures/upgrade-v5.1.0/, written and
//    locked by the published v5.1.0): wairon 7 no longer reads wairon 5 forms.
//    It refuses, by name, points at `npx wairon@6 upgrade`, and writes nothing.
//    (The v5.1.0 -> current conversion journey is gone by design: wairon 6
//    owns that step.)
//  - A project written by wairon 6 (lock format 3, .wai/externals.lock.yaml):
//    `wairon upgrade` writes the format-4 lock record, carries the approval
//    when the design is unchanged, and turns the pins file into
//    .wai/inputs.lock.yaml.
// ---------------------------------------------------------------------------

const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'upgrade-v5.1.0');

/** Copy the fixture, normalising line endings (the files are exactly what v5.1.0 wrote, LF). */
function copyFixture(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyFixture(from, to);
    else if (entry.name === 'GENERATE.md') continue;
    else fs.writeFileSync(to, fs.readFileSync(from, 'utf8').replace(/\r\n/g, '\n'));
  }
}

/** Every file under `dir`, keyed by relative path, for "this wrote nothing" checks. */
function snapshot(dir: string): Map<string, string> {
  const snap = new Map<string, string>();
  const walk = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else snap.set(path.relative(dir, p), fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return snap;
}

describe('e2e upgrade: a project written by wairon 5 is refused and pointed at wairon 6', () => {
  let sandbox: TrialSandbox;
  let dir: string;

  beforeAll(() => {
    sandbox = createTrialSandbox('upgrade-v510');
    dir = sandbox.project('shop');
    copyFixture(FIXTURE, dir);
  });
  afterAll(async () => { await sandbox?.cleanup(); });

  it('starts as v5.1.0 left it: a legacy mount and an approval under the old gate identity', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, '.wai', 'lock.json'), 'utf8')) as { validatorVersion: string };
    expect(lock.validatorVersion).toBe('5.1.0');
    const mount = fs.readFileSync(path.join(dir, '.wai', 'specs', 'billing', '.index.yaml'), 'utf8');
    expect(mount).toContain('projectPath: services/billing');
  });

  it('upgrade --report and upgrade --yes refuse by name, give the way forward, and write nothing', async () => {
    const before = snapshot(dir);
    for (const args of [['upgrade', '--report'], ['upgrade', '--yes']]) {
      const r = await sandbox.run(args, dir);
      expect(r.code, transcript(r)).toBe(1);
      expect(r.all).toContain('written by wairon 5');
      expect(r.all).toContain('no longer reads');
      expect(r.all).toContain('npx wairon@6 upgrade');
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it('every project command is refused with the same way forward, and nothing is written', async () => {
    const before = snapshot(dir);
    for (const args of [['lock-check'], ['validate', '--ci'], ['status'], ['lock', '--yes']]) {
      const r = await sandbox.run(args, dir);
      expect(r.code, transcript(r)).toBe(1);
      expect(r.all).toContain('written by an older wairon major');
      expect(r.all).toContain('npx wairon@6 upgrade');
    }
    expect(snapshot(dir)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')).not.toContain('waironMajor');
  });
});

describe('e2e upgrade: a project written by wairon 6 moves to the wairon 7 lock model', () => {
  let sandbox: TrialSandbox;
  let dir: string;
  let old: Record<string, unknown>;
  const GIT = 'git@example.com:acme/sdk.git#' + 'a'.repeat(40);
  const entry = (name: string): Record<string, unknown> => ({
    project: name, snapshot: `.wai/externals/${name}.yaml`, digest: `sha256:${name}`, used: {},
  });

  beforeAll(() => {
    sandbox = createTrialSandbox('upgrade-v6');
    dir = sandbox.project('shop');
    writeProject(dir, 'shop', { externals: { sdk: { source: GIT }, ledger: { source: '../ledger' } } });
    old = writeV6Lock(dir);
    writeYamlFile(path.join(dir, '.wai', 'externals.lock.yaml'), { externals: { sdk: entry('sdk'), ledger: entry('ledger') } });
    for (const name of ['sdk', 'ledger']) writeYamlFile(path.join(dir, '.wai', 'externals', `${name}.yaml`), { project: name });
  });
  afterAll(async () => { await sandbox?.cleanup(); });

  it('the plan is read-only and says the approval is carried', async () => {
    const before = snapshot(dir);
    const plan = await sandbox.run(['upgrade', '--report'], dir);
    expect(plan.code, transcript(plan)).toBe(0);
    expect(plan.all).toContain('the approval carried');
    expect(plan.all).toContain('.wai/externals.lock.yaml becomes .wai/inputs.lock.yaml');
    expect(plan.all).toContain('Nothing was written.');
    expect(snapshot(dir)).toEqual(before);
  });

  it('upgrade --yes writes format 4, carries the approval, and produces inputs.lock.yaml without the path pin', async () => {
    const up = await sandbox.run(['upgrade', '--yes'], dir);
    expect(up.code, transcript(up)).toBe(0);

    const lock = JSON.parse(fs.readFileSync(path.join(dir, '.wai', 'lock.json'), 'utf8')) as Record<string, unknown>;
    expect(lock.format).toBe(4);
    expect(lock.lockedAt).toBe(old.lockedAt);
    expect(lock.specs).toEqual(old.specs);
    expect(lock).not.toHaveProperty('members');
    expect(lock).not.toHaveProperty('gateParts');
    expect(lock.upgraded).toMatchObject({ fromFormat: 3, carried: true });
    expect((lock.stateId as { algorithm: string }).algorithm).toBe('sha256+design+policy');
    expect(Object.keys(lock.parts as object).sort()).toEqual(expect.arrayContaining(['design', 'rules']));

    expect(fs.existsSync(path.join(dir, '.wai', 'externals.lock.yaml'))).toBe(false);
    const inputs = fs.readFileSync(path.join(dir, '.wai', 'inputs.lock.yaml'), 'utf8');
    expect(inputs).toContain('sdk:');
    expect(inputs).not.toContain('ledger:');
    expect(fs.existsSync(path.join(dir, '.wai', 'externals', 'ledger.yaml'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')).toMatch(/^waironMajor: 7$/m);

    // A second upgrade has nothing to do.
    const again = await sandbox.run(['upgrade', '--yes'], dir);
    expect(again.code, transcript(again)).toBe(0);
    expect(again.all).not.toContain('is now on major');
  });
});
