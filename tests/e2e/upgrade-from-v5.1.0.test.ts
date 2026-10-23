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

/** The codes of the WARNING lines (the ones `validate --ci` fails on) an output prints. */
function warningCodes(out: string): string[] {
  return out.split('\n').filter((l) => l.startsWith('⚠')).flatMap((l) => [...l.matchAll(/\[([A-Z][A-Z0-9_]+)\]/g)].map((m) => m[1]));
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
    // The project carries no stamp: it reads as major 5, so the standing guard refuses
    // every project command in CI and names the way forward. Nothing is written.
    const before = snapshot(dir);
    for (const args of [['lock-check'], ['validate', '--ci'], ['status']]) {
      const refused = await run(args);
      expect(refused.code, transcript(refused)).toBe(1);
      expect(refused.all).toContain('written by an older wairon major');
      expect(refused.all).toContain('wairon upgrade');
    }
    expect(snapshot(dir)).toEqual(before);
    expect(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')).not.toContain('waironMajor');
  });

  it('the CHANGELOG still lists the steps this test replays, in order', () => {
    const steps = changelogSteps();
    const has = (n: number, needle: string): void =>
      expect(steps.get(n) ?? '', `CHANGELOG step ${n} must mention ${needle}`).toContain(needle);
    // Steps 3 and 5 still name `doctor --fix` and `doctor --report chaining`: CHANGELOG.md
    // has not been rewritten for `wairon upgrade` yet, so only the steps that survive are pinned.
    has(8, '`wairon validate --ci`');
    has(9, '`wairon lock`');
    expect(steps.get(8) ?? '').toContain('Declare the entries');
  });

  it('step 3: the plan is read-only and names the member migration', async () => {
    const before = snapshot(dir);
    const plan = await run(['upgrade', '--report']);
    ok(plan);
    expect(plan.all).toContain('written by major 5 (unstamped)');
    expect(plan.all).toContain('members: billing (moved from its legacy mount)');
    expect(plan.all).toContain('Nothing was written.');
    // doctor on the un-upgraded tree names the major and the way forward; it writes nothing.
    const doctor = await run(['doctor']);
    expect(doctor.all).toContain('wairon upgrade');
    expect(snapshot(dir)).toEqual(before);
  });

  it('step 5: upgrade --yes migrates the mount into a member and rewrites the reachability model', async () => {
    const up = await run(['upgrade', '--yes']);
    ok(up);
    expect(up.all).toContain('is now on major 6');
    expect(up.all).toContain('members: billing (moved from its legacy mount)');
    // Both roots are stamped with the major that rewrote them.
    for (const root of [dir, billing]) {
      expect(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8')).toMatch(/^waironMajor: 6$/m);
    }
    // The guard now lets commands through; a second upgrade has nothing to do.
    const again = await run(['upgrade', '--yes']);
    ok(again);
    expect(again.all).not.toContain('is now on major');

    // doctor --fix still owns the agent surfaces (the member's folder included).
    const fix = await run(['doctor', '--fix', '--yes']);
    ok(fix);

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

    // The member's own folder is repaired too (U2): an assistant opened there has the
    // wairon tools, a current guide, the context documents and the skills.
    const mcp = JSON.parse(fs.readFileSync(path.join(billing, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, { command?: string }> };
    expect(mcp.mcpServers?.wairon?.command).toBeTruthy();
    expect(fix.all).toContain('[billing] Registered the wairon MCP server in its .mcp.json');
    expect(fs.readFileSync(path.join(billing, '.claude', 'CLAUDE.md'), 'utf8')).toMatch(/wairon-version: \d+\.\d+\.\d+/);
    expect(fs.existsSync(path.join(billing, '.wai', 'context', 'wairon-guide.md'))).toBe(true);
    expect(fs.existsSync(path.join(billing, '.wai', 'context', 'domains.md'))).toBe(true);
    expect(fs.existsSync(path.join(billing, '.claude', 'skills'))).toBe(true);

    // No spec carries the legacy fields any more.
    const all = [...snapshot(dir)].filter(([f]) => f.includes(`${path.sep}specs${path.sep}`) || f.includes('/specs/'));
    expect(all.length).toBeGreaterThan(10);
    for (const [file, text] of all) {
      expect(text, file).not.toContain('projectPath');
      expect(text, file).not.toMatch(/^portalType:/m);
    }
  });

  it('step 8: validate --ci reports no errors and only the documented findings', async () => {
    for (const cwd of [dir, billing]) {
      const res = await run(['validate', '--ci'], cwd);
      const { codes, errors } = findings(res.all);
      expect(errors, transcript(res)).toEqual([]);
      for (const code of codes) {
        // The member is unapproved until step 9 has run.
        if (code === 'MEMBER_UNAPPROVED') continue;
        expect(Object.keys(EXPECTED_CODES), `unexpected finding ${code}\n${transcript(res)}`).toContain(code);
      }
      // The fixture states generateComponentImplementers: true, which 6.1.3 retired: the
      // topology is one owner per subsystem, each owning its spec folders, so no agent
      // is left without owned paths (and none is told to tag itself as meta).
      expect(res.all, transcript(res)).not.toContain('NO_OWNED_PATHS');
      if (res.code !== 0) expect(countCode(res.all, 'UNUSED_COMPONENT')).toBeGreaterThan(0);
    }
  });

  it('step 8: once the entries are declared, only the unlocked member is left (no NO_OWNED_PATHS failure)', async () => {
    // "Declare the entries the migration will not invent": each Portal's callers are outside the design.
    const caller = 'Visitors of the storefront reach this Portal over HTTP from their browsers';
    for (const portal of [
      path.join(dir, '.wai', 'specs', 'catalog', 'catalog-portal', '.index.yaml'),
      path.join(dir, '.wai', 'specs', 'orders', 'orders-portal', '.index.yaml'),
      path.join(billing, '.wai', 'specs', 'charges', 'billing-portal', '.index.yaml'),
    ]) {
      const text = fs.readFileSync(portal, 'utf8').replace(/\r\n/g, '\n');
      expect(text, portal).toContain('transport: HTTP\n');
      fs.writeFileSync(portal, text.replace('transport: HTTP\n', () => `transport: HTTP\ninvokedBy:\n  kind: entry\n  caller: ${caller}\n`));
    }
    const member = await run(['validate', '--ci'], billing);
    expect(findings(member.all).errors, transcript(member)).toEqual([]);
    expect(warningCodes(member.all), transcript(member)).toEqual([]);
    const top = await run(['validate', '--ci']);
    expect(findings(top.all).errors, transcript(top)).toEqual([]);
    // The member is not locked yet (step 9); nothing else fails the family run.
    expect(warningCodes(top.all).filter((c) => c !== 'MEMBER_UNAPPROVED'), transcript(top)).toEqual([]);
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
    // U1: once the steps are followed, nothing fails --ci: not NO_OWNED_PATHS, not anything else.
    expect(after.code, transcript(after)).toBe(0);
    expect(warningCodes(after.all)).toEqual([]);
    ok(await run(['validate', '--ci'], billing));

    // U2: the doctor of the member's own folder has no agent surface left to repair. (The MCP
    // line may still warn about a different `wairon` on this machine's PATH: that is N1's check
    // of the machine, not of the folder.)
    const doctor = await run(['doctor'], billing);
    const warned = doctor.all.split('\n').filter((l) => l.startsWith('  ⚠') && !l.includes('launches wairon')).join('\n');
    expect(warned, transcript(doctor)).not.toMatch(/stale|not generated|not injected|not registered|missing/);
    const parent = await run(['doctor']);
    expect(parent.all).not.toContain('agent surfaces');
  });
});

describe('e2e upgrade: a chained child that does not publish its Portal at L1', () => {
  let sandbox: TrialSandbox;
  let dir: string;
  const run = (args: string[], cwd = dir): Promise<CliResult> => sandbox.run(args, cwd);
  const ok = (r: CliResult): void => expect(r.code, transcript(r)).toBe(0);
  const childIndex = (): string => path.join(dir, 'services', 'billing', '.wai', 'specs', 'charges', '.index.yaml');

  beforeAll(() => {
    sandbox = createTrialSandbox('upgrade-v510-unpublished');
    dir = sandbox.project('shop');
    copyFixture(FIXTURE, dir);
    const published = fs.readFileSync(childIndex(), 'utf8');
    const stripped = published.replace(/publicInterfaces:\n(?:[ \t]+.*\n)+/, 'publicInterfaces: []\n');
    expect(stripped).not.toEqual(published);
    fs.writeFileSync(childIndex(), stripped);
  });
  afterAll(async () => { await sandbox?.cleanup(); });

  it('upgrade names the finding and its hand fix, and stamps the tree it could rewrite', async () => {
    const up = await run(['upgrade', '--yes']);
    ok(up);
    expect(up.all).toContain('target-unpublished [billing]');
    expect(up.all).toContain('publish it at L1 first');
    expect(up.all).toContain('is now on major 6');

    // The reference the finding covers is unresolved: no L0 export was written for it.
    const l0 = fs.readFileSync(path.join(dir, 'services', 'billing', '.wai', 'specs', '.index.yaml'), 'utf8');
    expect(l0).not.toContain('billing-portal');

    // It stays visible where the human works: validation fails on the unexported reference.
    const validate = await run(['validate', '--ci']);
    expect(validate.code, transcript(validate)).toBe(1);
    expect(validate.all).toContain('EXTERNAL_NOT_EXPORTED');
    const status = await run(['doctor']);
    expect(status.all).toContain('written by wairon 6, the running major');
  });

  it('with the Portal published, the upgrade writes the export and the family validates without errors', async () => {
    const clean = sandbox.project('shop-published');
    copyFixture(FIXTURE, clean);
    const up = await run(['upgrade', '--yes'], clean);
    ok(up);
    expect(up.all).not.toContain('target-unpublished');
    expect(fs.readFileSync(path.join(clean, 'services', 'billing', '.wai', 'specs', '.index.yaml'), 'utf8')).toContain('billing-portal');
    const validate = await run(['validate', '--ci'], clean);
    expect(findings(validate.all).errors, transcript(validate)).toEqual([]);
  });
});
