import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { REPO_ROOT } from './helpers';
import { createTrialSandbox, countCode, transcript, type TrialSandbox, type CliResult } from './trials-helpers';

// ---------------------------------------------------------------------------
// The upgrade a v5.1.0 user takes, replayed against the BUILT CLI.
//
// tests/fixtures/upgrade-v5.1.0/ is a project the PUBLISHED v5.1.0 wrote and
// locked (see GENERATE.md beside it): an L0, two subsystems shaped Portal ->
// Orchestrator -> Repository(Store), and a chained subproject in v5.1.0's own
// form (an L1 mount carrying `projectPath`). This test performs the steps the
// CHANGELOG's "Upgrading from v5.1.0" section lists, in that order, and asserts
// the end state. It never works around a step: if a step is wrong or missing,
// the test fails and the CHANGELOG is what gets fixed.
//
// Steps with nothing to do on this fixture (1 upgrade everywhere, 2 hosted,
// 4 + 6 machine-wide packs, 7 hand-settled items, 10 scripts, 11 CI) are not
// replayed. The fixture has no packs, no Gateways and no number positions.
// ---------------------------------------------------------------------------

const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'upgrade-v5.1.0');
const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');

/** Findings the upgraded fixture may still report, and why each is expected.
 *  Anything else (and any error) fails the test. */
const EXPECTED_CODES: Record<string, string> = {
  // CHANGELOG "Every project" and step 8: a Portal verb no modelled caller reaches needs a declared entry.
  UNUSED_COMPONENT: 'step 8 (declare the entries the migration will not invent)',
  // The fixture is a design with no code, as v5.1.0 left it.
  MISSING_SOURCE_PATH: 'design-only fixture, notice',
  SIGNATURE_SOURCE_AVAILABLE: 'optional notice',
  NO_OWNED_PATHS: 'design-only fixture: agents own no paths',
};

/** Copy the fixture, normalising line endings: the files are exactly what v5.1.0
 *  wrote (LF); a checkout that converts them must not change the outcome. */
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

/** The numbered steps of the CHANGELOG's v5.1.0 upgrade section, by step number. */
function changelogSteps(): Map<number, string> {
  const text = fs.readFileSync(CHANGELOG, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('### Upgrading from v5.1.0');
  if (start < 0) throw new Error('CHANGELOG.md has no "### Upgrading from v5.1.0" section');
  const end = text.indexOf('\n### ', start + 1);
  const body = text.slice(start, end < 0 ? undefined : end);
  const steps = new Map<number, string>();
  let current = 0;
  for (const line of body.split('\n')) {
    const m = /^(\d+)\. /.exec(line);
    if (m) { current = Number(m[1]); steps.set(current, line); } else if (current) steps.set(current, `${steps.get(current)}\n${line}`);
  }
  return steps;
}

/** Codes of every finding line an output prints, and how many are errors. */
function findings(out: string): { codes: Set<string>; errors: string[] } {
  const codes = new Set<string>();
  for (const m of out.matchAll(/\[([A-Z][A-Z0-9_]+)\]/g)) codes.add(m[1]);
  const errors = out.split('\n').filter((l) => l.startsWith('✖') && /\[[A-Z][A-Z0-9_]+\]/.test(l));
  return { codes, errors };
}

describe('e2e upgrade: a project written and locked by v5.1.0, upgraded by the CHANGELOG steps', () => {
  let sandbox: TrialSandbox;
  let dir: string;
  let billing: string;
  const run = (args: string[], cwd = dir): Promise<CliResult> => sandbox.run(args, cwd);
  const ok = (r: CliResult): void => expect(r.code, transcript(r)).toBe(0);

  beforeAll(() => {
    sandbox = createTrialSandbox('upgrade-v510');
    dir = sandbox.project('shop');
    copyFixture(FIXTURE, dir);
    billing = path.join(dir, 'services', 'billing');
  });
  afterAll(async () => { await sandbox?.cleanup(); });

  it('starts as v5.1.0 left it: a legacy mount and an approval under the old gate identity', async () => {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, '.wai', 'lock.json'), 'utf8')) as { validatorVersion: string };
    expect(lock.validatorVersion).toBe('5.1.0');
    const mount = fs.readFileSync(path.join(dir, '.wai', 'specs', 'billing', '.index.yaml'), 'utf8');
    expect(mount).toContain('projectPath: services/billing');
    expect(fs.existsSync(path.join(dir, '.wai', 'project.yaml'))).toBe(true);
    // CHANGELOG "Every project": every lock reads stale once.
    const check = await run(['lock-check']);
    expect(check.code, transcript(check)).toBe(1);
    expect(check.all).toContain('earlier gate identity');
  });

  it('the CHANGELOG still lists the steps this test replays, in order', () => {
    const steps = changelogSteps();
    const has = (n: number, needle: string): void =>
      expect(steps.get(n) ?? '', `CHANGELOG step ${n} must mention ${needle}`).toContain(needle);
    has(3, '`wairon doctor`');
    has(3, 'wairon doctor --report chaining');
    has(3, 'wairon doctor --report composed-validation');
    has(5, '`wairon doctor --fix`');
    has(8, '`wairon validate --ci`');
    has(9, '`wairon lock`');
    expect(steps.get(8) ?? '').toContain('Declare the entries');
  });

  it('step 3: the plan is read-only and names the member migration', async () => {
    const before = snapshot(dir);
    const plan = await run(['doctor']);
    const chaining = await run(['doctor', '--report', 'chaining']);
    const composed = await run(['doctor', '--report', 'composed-validation']);
    expect(plan.all).toContain('wairon doctor --fix');
    ok(chaining);
    expect(chaining.all).toContain('member: billing');
    ok(composed);
    expect(snapshot(dir)).toEqual(before);
  });

  it('step 5: doctor --fix --yes migrates the mount into a member and rewrites the reachability model', async () => {
    const fix = await run(['doctor', '--fix', '--yes']);
    ok(fix);
    expect(fix.all).toContain('Applied the chaining migration');
    expect(fix.all).toContain('Migrated onto the reachability model');

    // The chained form is now a member of the project.
    const project = yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as {
      id?: string; members?: Record<string, unknown>;
    };
    expect(project.id).toBe('shop');
    expect(Object.keys(project.members ?? {})).toEqual(['billing']);
    expect(fs.existsSync(path.join(dir, '.wai', 'specs', 'billing'))).toBe(false);
    const child = yaml.load(fs.readFileSync(path.join(billing, '.wai', 'project.yaml'), 'utf8')) as {
      id?: string; externals?: Record<string, unknown>;
    };
    expect(child.id).toBe('billing');
    expect(Object.keys(child.externals ?? {})).toEqual(['shop']);

    // No spec carries the legacy fields any more.
    const all = [...snapshot(dir)].filter(([f]) => f.includes(`${path.sep}specs${path.sep}`) || f.includes('/specs/'));
    expect(all.length).toBeGreaterThan(10);
    for (const [file, text] of all) {
      expect(text, file).not.toContain('projectPath');
      expect(text, file).not.toMatch(/^portalType:/m);
    }
  });

  it('step 8: validate --ci reports no errors, only the documented findings', async () => {
    for (const cwd of [dir, billing]) {
      const res = await run(['validate', '--ci'], cwd);
      const { codes, errors } = findings(res.all);
      expect(errors, transcript(res)).toEqual([]);
      for (const code of codes) {
        // The member is unapproved until step 9 has run.
        if (code === 'MEMBER_UNAPPROVED') continue;
        expect(Object.keys(EXPECTED_CODES), `unexpected finding ${code}\n${transcript(res)}`).toContain(code);
      }
      if (res.code !== 0) expect(countCode(res.all, 'UNUSED_COMPONENT') + countCode(res.all, 'NO_OWNED_PATHS')).toBeGreaterThan(0);
    }
  });

  it('step 9: lock bottom-up, and the approval holds at both roots', async () => {
    ok(await run(['lock', '--yes'], billing));
    ok(await run(['lock', '--yes']));
    const top = await run(['lock-check']);
    ok(top);
    ok(await run(['lock-check'], billing));
    const lock = fs.readFileSync(path.join(dir, '.wai', 'lock.json'), 'utf8');
    expect(lock).not.toContain('"validatorVersion": "5.1.0"');

    // Locking linked nothing new: the family is clean of unapproved members.
    const after = await run(['validate', '--ci']);
    expect(after.all).not.toContain('MEMBER_UNAPPROVED');
    expect(findings(after.all).errors, transcript(after)).toEqual([]);
  });
});

describe('e2e upgrade: a chained child that does not publish its Portal at L1', () => {
  let sandbox: TrialSandbox;
  let dir: string;
  const run = (args: string[], cwd = dir): Promise<CliResult> => sandbox.run(args, cwd);
  const childIndex = (): string => path.join(dir, 'services', 'billing', '.wai', 'specs', 'charges', '.index.yaml');
  let published = '';

  beforeAll(() => {
    sandbox = createTrialSandbox('upgrade-v510-unpublished');
    dir = sandbox.project('shop');
    copyFixture(FIXTURE, dir);
    published = fs.readFileSync(childIndex(), 'utf8');
    const stripped = published.replace(/publicInterfaces:\n(?:[ \t]+.*\n)+/, 'publicInterfaces: []\n');
    expect(stripped).not.toEqual(published);
    fs.writeFileSync(childIndex(), stripped);
  });
  afterAll(async () => { await sandbox?.cleanup(); });

  it('doctor --fix names the finding and its hand fix, and the status line stops advising --fix', async () => {
    const fix = await run(['doctor', '--fix', '--yes']);
    // The references the finding covers still fail validation, so doctor ends on an error.
    expect(fix.code, transcript(fix)).toBe(1);
    expect(fix.all).toContain('need a hand fix');
    expect(fix.all).toContain('target-unpublished [billing]');
    expect(fix.all).toContain('publish it at L1 first');
    expect(fix.all).toContain('nothing was written for the items above');
    expect(fix.all).toContain('re-run `wairon doctor --fix`');

    // The reference the finding covers is unresolved: no L0 export was written for it.
    expect(fs.existsSync(path.join(dir, 'services', 'billing', '.wai', 'specs', '.index.yaml'))).toBe(true);
    const l0 = fs.readFileSync(path.join(dir, 'services', 'billing', '.wai', 'specs', '.index.yaml'), 'utf8');
    expect(l0).not.toContain('billing-portal');

    const status = await run(['doctor']);
    const line = status.all.split('\n').find((l) => l.includes('Chaining:')) ?? '';
    expect(line, transcript(status)).toContain('need a hand fix');
    expect(line).not.toContain('apply with `wairon doctor --fix`');
  });

  it('after the Portal is published, a re-run applies the rest', async () => {
    fs.writeFileSync(childIndex(), published);
    const fix = await run(['doctor', '--fix', '--yes']);
    expect(fix.code, transcript(fix)).toBe(0);
    expect(fix.all).toContain('Applied the chaining migration');
    expect(fix.all).not.toContain('need a hand fix');
    expect(fs.readFileSync(path.join(dir, 'services', 'billing', '.wai', 'specs', '.index.yaml'), 'utf8')).toContain('billing-portal');
    const status = await run(['doctor']);
    expect(status.all).not.toContain('Chaining:');
    const validate = await run(['validate', '--ci']);
    expect(findings(validate.all).errors, transcript(validate)).toEqual([]);
  });
});
