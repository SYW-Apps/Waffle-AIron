import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as yaml from 'js-yaml';
import { REPO_ROOT } from './helpers';
import {
  createTrialSandbox, runCliIn, transcript, writeFile, readFile, gitInit,
  type TrialSandbox, type CliResult,
} from './trials-helpers';
import type { FixtureTree } from '../rules-matrix/harness';

// ---------------------------------------------------------------------------
// User-trial regression journeys — the TINKERER persona.
//
// The tinkerer stress-tested the edges before recommending wairon to a team:
// upgrading projects locked by older builds, approval vs storage moves and
// inputs, draft trees, family gates, and the documented CI recipe on a fresh
// clone. Each journey replays the trial's probe against the BUILT CLI and
// asserts what the trial observed (exit code and the key words), naming the
// finding it guards (r1 = dev.102, r2 = dev.106, r3 = dev.107).
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const runtime = (caller: string): Record<string, string> => ({ kind: 'runtime', caller });

/** A small two-subsystem design that validates clean (only notices), at one authoring status. */
function linkshort(status: 'draft' | 'complete' = 'complete'): FixtureTree {
  return {
    system: { name: 'Linkshort', vision: 'A link shortener with hit analytics, probed at the edges of approval.', targetLanguage: 'typescript' },
    subsystems: [{ id: 'links', status }, { id: 'analytics', status }],
    components: [
      { id: 'shortener', subsystem: 'links', status, description: 'Shortens links for the deployment host.' },
      { id: 'hit_counter', subsystem: 'analytics', status, dependencyClass: 'pure', description: 'Counts the hits of one code.' },
    ],
    interfaces: [
      {
        id: 'ishortener', component: 'shortener', status,
        methods: [{ name: 'shorten', description: 'Shorten one link.', invokedBy: runtime('The deployment host calls this once per shorten request after start-up.') }],
      },
      {
        id: 'ihit_counter', component: 'hit_counter', status,
        methods: [{ name: 'count', description: 'Count one hit.', invokedBy: runtime('The analytics worker calls this once per recorded hit after start-up.') }],
      },
    ],
    implementations: [
      { id: 'shortener_impl', contract: 'ishortener', status, methods: [{ name: 'shorten', narrative: [{ stepNumber: 1, type: 'return', description: 'Return the short code', outcome: 'success' }] }] },
      { id: 'hit_counter_impl', contract: 'ihit_counter', status, methods: [{ name: 'count', narrative: [{ stepNumber: 1, type: 'return', description: 'Return the hit count', outcome: 'success' }] }] },
    ],
  };
}

/** Give the materialized project an explicit id (as `wairon init` does), so no migration is pending. */
function declareId(dir: string, id: string, extra: Record<string, unknown> = {}): void {
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, yaml.dump({ ...config, id, name: id, ...extra }, { noRefs: true, lineWidth: 200 }));
}

function lockRecord(dir: string): Record<string, unknown> & { specs: Record<string, string>; format: number; stateId: { algorithm: string; digest: string } } {
  return JSON.parse(readFile(dir, '.wai/lock.json'));
}

/** Expect an exit code, with the whole transcript on failure. */
function expectExit(r: CliResult, code: number): void {
  expect(r.code, transcript(r)).toBe(code);
}

/**
 * Rewrite a fresh lock into the shape a dev.102 build wrote (lock format 2):
 * raw-content per-spec digests, no `specsReading`, the content-reading
 * algorithm, and a gate digest the current build can no longer reproduce —
 * exactly the trial's untouched round-1 project.
 */
function downgradeToFormat2(dir: string): void {
  const record = lockRecord(dir);
  for (const key of Object.keys(record.specs)) {
    const content = fs.readFileSync(path.join(dir, ...key.split('/')), 'utf8').replace(/\r\n/g, '\n');
    record.specs[key] = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
  }
  delete (record as Record<string, unknown>).specsReading;
  record.format = 2;
  record.stateId = { algorithm: 'sha256+content+doctrine+inputs+members', digest: 'b959e8c1e21a0425c548748f5c25bbe0b0eea2dd8ec19b222bbf514f97fe6c29' };
  record.validatorVersion = '5.1.1-dev.102';
  writeFile(dir, '.wai/lock.json', JSON.stringify(record, null, 2));
}

let sb: TrialSandbox;

beforeAll(() => { sb = createTrialSandbox('tinkerer'); });
afterAll(async () => { await sb?.cleanup(); });

// ---------------------------------------------------------------------------
describe('tinkerer: upgrading a lock taken by an older wairon (format 2)', () => {
  // r2 MAJOR M3 (re-checked FIXED in r3): an untouched dev.102 project read
  // stale with "something it covered moved since — the design, or only code
  // linkage" (blaming the user's tree), and `doctor --fix` never carried the
  // record into format 3 as cli.md promised. Fixed: the message blames the gate,
  // doctor re-expresses in place (approver and timestamp kept), one lock clears it.
  let dir: string;
  let lockedAt: string;

  beforeAll(async () => {
    dir = sb.materialize('upgrade-format2', linkshort());
    declareId(dir, 'linkshort');
    expectExit(await sb.run(['lock', '--yes'], dir), 0);
    downgradeToFormat2(dir);
    lockedAt = lockRecord(dir).lockedAt as string;
  });

  it('lock-check and lock-check --strict agree: stale, and the cause is the gate, not the design', async () => {
    for (const args of [['lock-check'], ['lock-check', '--strict']]) {
      const r = await sb.run(args, dir);
      expectExit(r, 1);
      expect(r.all).toContain('taken by wairon 5.1.1-dev.102');
      expect(r.all).toContain('no own spec file changed since it was taken — not even its code linkage — so what moved is the gate it was judged under');
      expect(r.all).toContain('`wairon doctor --fix` first carries this format-2 record into the design reading');
      // The round-2 wording blamed the tree.
      expect(r.all).not.toContain('the design, or only code linkage');
    }
  });

  it('doctor names the stale lock; doctor --fix re-expresses it as format 3, keeping the approval the approver\'s', async () => {
    const report = await sb.run(['doctor'], dir);
    expectExit(report, 0);
    expect(report.all).toMatch(/Lock\s+⚠ stale — The approval on record/);
    expect(lockRecord(dir).format).toBe(2); // plain doctor writes nothing

    const fix = await sb.run(['doctor', '--fix', '--yes'], dir);
    expectExit(fix, 0);
    expect(fix.all).toContain(`Re-expressed the approval of ${lockedAt}`);
    expect(fix.all).toContain('in the design reading (lock format 3): no spec file moved since it was taken');
    expect(fix.all).toContain('It still reads stale because the gate it was judged under moved');

    const record = lockRecord(dir);
    expect(record.format).toBe(3);
    expect(record.specsReading).toBe('design');
    expect(record.lockedAt).toBe(lockedAt);
    expect(record.reexpressed).toMatchObject({ fromAlgorithm: 'sha256+content+doctrine+inputs+members', fromReading: 'content', by: 'wairon doctor --fix' });
  });

  it('after the carry: still stale (the gate moved), and one lock names that cause and clears it for both checks', async () => {
    const stale = await sb.run(['lock-check'], dir);
    expectExit(stale, 1);
    expect(stale.all).toContain('what moved is the gate it was judged under');

    const lock = await sb.run(['lock', '--yes'], dir);
    expectExit(lock, 0);
    expect(lock.all).toContain('No spec changed since the last approval, but what the design is approved under did: the gate identity this wairon release computes (approved by wairon 5.1.1-dev.102)');
    expect(lock.all).not.toContain('Nothing has changed since the last approval');

    for (const args of [['lock-check'], ['lock-check', '--strict']]) {
      const r = await sb.run(args, dir);
      expectExit(r, 0);
      expect(r.all).toContain('The design in this tree is the approved design');
    }
  });

  it('negative control: a format-2 lock over an edited spec is NOT carried — it says something it covered moved', async () => {
    const edited = sb.materialize('upgrade-format2-edited', linkshort());
    declareId(edited, 'linkshort');
    expectExit(await sb.run(['lock', '--yes'], edited), 0);
    downgradeToFormat2(edited);
    const file = '.wai/specs/components/shortener.yaml';
    writeFile(edited, file, readFile(edited, file).replace('Shortens links for the deployment host.', 'Shortens and expands links.'));

    const r = await sb.run(['lock-check'], edited);
    expectExit(r, 1);
    expect(r.all).toContain('is a format-2 lock taken before code linkage');
    expect(r.all).toContain('1 own spec file(s) changed since the approval');
    expect(r.all).not.toContain('what moved is the gate it was judged under');

    const fix = await sb.run(['doctor', '--fix', '--yes'], edited);
    expectExit(fix, 0);
    expect(fix.all).not.toContain('Re-expressed the approval');
    expect(lockRecord(edited).format).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('tinkerer: a storage move is no design change', () => {
  // r3 (famlab GOOD, and the round-3 fix "storage moves no longer ask for a
  // re-lock"): `subsystem externalize` into a part is a storage move. Before
  // the fix `lock-check` read the approval as holding while `lock` listed
  // every moved spec as a change; now both agree it moved storage only.
  let dir: string;

  beforeAll(async () => {
    dir = sb.materialize('storage-move', linkshort());
    declareId(dir, 'linkshort');
    expectExit(await sb.run(['lock', '--yes'], dir), 0);
  });

  it('the --report plan writes nothing and calls it a storage move', async () => {
    const r = await sb.run(['subsystem', 'externalize', 'analytics', '--path', 'parts/analytics', '--report'], dir);
    expectExit(r, 0);
    expect(r.all).toContain('a storage move; no reference, export or pin changes');
    expect(r.all).toContain('Report only (--report): nothing was written.');
    expect(fs.existsSync(path.join(dir, 'parts', 'analytics'))).toBe(false);
  });

  it('after externalize --yes: lock-check --strict and validate --ci stay green, no re-lock asked', async () => {
    const move = await sb.run(['subsystem', 'externalize', 'analytics', '--path', 'parts/analytics', '--yes'], dir);
    expectExit(move, 0);
    expect(move.all).toContain('Applied the externalize migration');
    expect(fs.existsSync(path.join(dir, 'parts', 'analytics', '.wai', 'specs', 'subsystems', 'analytics.yaml'))).toBe(true);

    const check = await sb.run(['lock-check', '--strict'], dir);
    expectExit(check, 0);
    expect(check.all).toContain('The design in this tree is the approved design');

    const ci = await sb.run(['validate', '--ci'], dir);
    expectExit(ci, 0);
    expect(ci.all).toMatch(/linkshort \(bound\) — ok: 0 error\(s\), 0 warning\(s\)/);
  });

  it('lock agrees with lock-check: nothing changed, the four files are named as moved — never as added', async () => {
    const r = await sb.run(['lock', '--yes'], dir);
    expectExit(r, 0);
    expect(r.all).toContain('Nothing has changed since the last approval');
    expect(r.all).toContain('4 spec file(s) moved storage with their content unchanged (no design change):');
    expect(r.all).toContain('→ .wai/specs/subsystems/analytics.yaml -> members/analytics/.wai/specs/subsystems/analytics.yaml');
    expect(r.all).not.toMatch(/spec\(s\) changed since the last approval/);
    expect(r.all).not.toMatch(/^\S*\s+\+ /m);
  });

  it('negative control: a real design change inside the part does ask for a re-lock, naming it', async () => {
    const file = 'parts/analytics/.wai/specs/components/hit_counter.yaml';
    writeFile(dir, file, readFile(dir, file).replace('Counts the hits of one code.', 'Counts and ranks the hits of one code.'));
    const check = await sb.run(['lock-check'], dir);
    expectExit(check, 1);
    expect(check.all).toContain('What moved: 1 own spec file(s) changed since the approval');

    const lock = await sb.run(['lock', '--yes'], dir);
    expectExit(lock, 0);
    expect(lock.all).toContain('1 spec(s) changed since the last approval:');
    expect(lock.all).toContain('~ members/analytics/.wai/specs/components/hit_counter.yaml');
  });
});

// ---------------------------------------------------------------------------
describe('tinkerer: lock messages say what they approve', () => {
  it('an all-draft tree locks, says so plainly, and its approval is the same identity as the complete tree', async () => {
    // r3 MINOR (all-draft trees lock without a word; status is readiness,
    // never approval) — the lock now warns, and status stays outside the digest.
    const draft = sb.materialize('lock-all-draft', linkshort('draft'));
    declareId(draft, 'linkshort');
    const r = await sb.run(['lock', '--yes'], draft);
    expectExit(r, 0);
    expect(r.all).toContain('Every component (2) is still draft or design: this approves the design as it stands, drafts included. Status is readiness, never approval');

    const complete = sb.materialize('lock-all-complete', linkshort('complete'));
    declareId(complete, 'linkshort');
    const c = await sb.run(['lock', '--yes'], complete);
    expectExit(c, 0);
    expect(c.all).not.toContain('still draft or design');
    expect(lockRecord(draft).stateId).toEqual(lockRecord(complete).stateId);

    // Promoting the statuses afterwards never reopens the approval.
    for (const rel of ['.wai/specs/components/shortener.yaml', '.wai/specs/components/hit_counter.yaml', '.wai/specs/subsystems/links.yaml', '.wai/specs/subsystems/analytics.yaml']) {
      writeFile(draft, rel, readFile(draft, rel).replace(/^status: draft$/m, 'status: complete'));
    }
    const check = await sb.run(['lock-check', '--strict'], draft);
    expectExit(check, 0);
    expect(check.all).toContain('The design in this tree is the approved design');
  });

  it('a moved input (network declare) is named by lock, never "Nothing has changed"; a true no-op still is', async () => {
    // r3 MINOR (solo-app + tinkerer): lock-check said an input moved while
    // `wairon lock` opened with "Nothing has changed since the last approval".
    const dir = sb.materialize('lock-input-moved', linkshort());
    declareId(dir, 'linkshort');
    expectExit(await sb.run(['lock', '--yes'], dir), 0);

    const declare = await sb.run(['network', 'declare', '--description', 'the links platform'], dir);
    expectExit(declare, 0);
    expect(declare.all).toContain('The declaration is part of the gate identity — re-lock (`wairon lock`) once it validates.');

    // r3 MINOR: lock-check said "the doctrine, a declared input or `composition`"
    // where lock named the network declaration: both now print the one sentence.
    const check = await sb.run(['lock-check'], dir);
    expectExit(check, 1);
    expect(check.all).toContain('No own spec file and no direct member\'s approval moved, so what changed is an input the gate identity covers');
    expect(check.all).toContain('the network declaration');
    expect(check.all).not.toContain('a declared input or `composition`.');

    const lock = await sb.run(['lock', '--yes'], dir);
    expectExit(lock, 0);
    expect(lock.all).toContain('No spec changed since the last approval, but what the design is approved under did: an input the gate identity covers');
    expect(lock.all).toContain('the network declaration');
    expect(lock.all).not.toContain('Nothing has changed since the last approval');

    const again = await sb.run(['lock', '--yes'], dir);
    expectExit(again, 0);
    expect(again.all).toContain('Nothing has changed since the last approval — this re-records the approval');
    expectExit(await sb.run(['lock-check', '--strict'], dir), 0);
  });

  it('a project id rename is a notice asking for a lock, and that lock names the rename', async () => {
    // r3 MINOR (the assistant renamed the project id `outer` -> `linkshort`;
    // validate said PROJECT_ID_RENAMED "run wairon lock to approve the new id")
    // and the round-3 fix: the lock that clears it names the rename instead of
    // "Nothing has changed since the last approval".
    const dir = sb.materialize('lock-id-renamed', linkshort());
    declareId(dir, 'outer');
    expectExit(await sb.run(['lock', '--yes'], dir), 0);

    const rename = await sb.run(['project', 'rename', 'linkshort', '--yes'], dir);
    expectExit(rename, 0);
    const validate = await sb.run(['validate'], dir);
    expectExit(validate, 0);
    expect(validate.all).toContain('[PROJECT_ID_RENAMED]');
    // The re-lock the rename owes is owed to the merge gate too.
    const owed = await sb.run(['lock-check'], dir);
    expectExit(owed, 1);
    expect(owed.all).toContain('The project was renamed from "outer" to "linkshort" after the approval (PROJECT_ID_RENAMED)');

    const lock = await sb.run(['lock', '--yes'], dir);
    expectExit(lock, 0);
    expect(lock.all).toContain('No spec changed since the last approval, but what the design is approved under did: the project id (outer → linkshort)');
    expect(lock.all).not.toContain('Nothing has changed since the last approval');
    const after = await sb.run(['validate'], dir);
    expect(after.all).not.toContain('[PROJECT_ID_RENAMED]');
    expectExit(await sb.run(['lock-check', '--strict'], dir), 0);
  });

  it('negative control: a HAND-edited id is an error the lock refuses (rename deliberately instead)', async () => {
    const dir = sb.materialize('lock-id-hand-edited', linkshort());
    declareId(dir, 'outer');
    expectExit(await sb.run(['lock', '--yes'], dir), 0);
    declareId(dir, 'linkshort');
    const validate = await sb.run(['validate'], dir);
    expectExit(validate, 1);
    expect(validate.all).toContain('[PROJECT_ID_CHANGED]');
    const lock = await sb.run(['lock', '--yes'], dir);
    expectExit(lock, 1);
    expect(lock.all).toContain('Nothing was changed.');
    // r3: lock-check stayed green here. The approval verdict now matches the
    // lock's refusal at every strictness, and names the id change and its fix.
    for (const args of [['lock-check'], ['lock-check', '--strict']]) {
      const check = await sb.run(args, dir);
      expectExit(check, 1);
      expect(check.all).toContain('approved "outer", and .wai/project.yaml now resolves to "linkshort" (PROJECT_ID_CHANGED)');
      expect(check.all).toContain('Fix: restore `id: outer` in .wai/project.yaml; to change the id, run `wairon project rename <id>` and re-lock.');
    }
  });

  // r3 tinkerer MINOR: `wairon lock --yes` on a tree holding only the L0
  // recorded an approval of an empty design ("First approval of this tree")
  // while `validate` said "Nothing to check yet". Now nothing is approved.
  it('lock on an L0-only tree says there is nothing designed to approve, and writes no lock', async () => {
    const dir = sb.materialize('lock-empty', {});
    declareId(dir, 'empty');
    const validate = await sb.run(['validate'], dir);
    expectExit(validate, 0);
    expect(validate.all).toContain('Nothing to check yet');
    const lock = await sb.run(['lock', '--yes'], dir);
    expectExit(lock, 0);
    expect(lock.all).toMatch(/nothing (designed|below the L0)|empty design|Nothing to (approve|check)/i);
    expect(lock.all).toContain('Add a subsystem first');
    expect(lock.all).not.toContain('First approval of this tree');
    expect(fs.existsSync(path.join(dir, '.wai', 'lock.json'))).toBe(false);

    // lock-check and status read the same: nothing to approve yet.
    const check = await sb.run(['lock-check'], dir);
    expectExit(check, 0);
    expect(check.all).toContain('Nothing designed to approve yet');
    const strict = await sb.run(['lock-check', '--strict'], dir);
    expectExit(strict, 1);
    expect(strict.all).toContain('Nothing designed to approve yet');
    expect(strict.all).not.toContain('Run `wairon lock` and commit the record.');
    const status = await sb.run(['status'], dir);
    expectExit(status, 0);
    expect(status.all).toContain('Approval: nothing to approve yet');
    expect(status.all).not.toContain('never approved (`wairon lock` approves the design)');
  });
});

// ---------------------------------------------------------------------------
describe('tinkerer: validate --ci waives draft-related warnings, and counts them', () => {
  // r3 (solo-app + tinkerer GOOD; r2 MINOR "Passed with N warning(s)"): a draft
  // tree passes --ci with the waived count said, plain validate says --ci
  // would fail on warnings "(except the N draft-related one(s))".
  let dir: string;

  beforeAll(() => {
    dir = sb.materialize('ci-waived-draft', linkshort('draft'));
    declareId(dir, 'linkshort');
  });

  it('plain validate passes with the draft count in the summary', async () => {
    const r = await sb.run(['validate'], dir);
    expectExit(r, 0);
    expect(r.all).toContain('[DRAFT_COMPONENT_WARNING]');
    expect(r.all).toContain('Passed with 4 warning(s) — not a failure here, but `wairon validate --ci` fails on them (except the 4 draft-related one(s)).');
    expect(r.all).not.toContain('All checks passed.');
  });

  it('validate --ci passes and names the 4 waived warnings', async () => {
    const r = await sb.run(['validate', '--ci'], dir);
    expectExit(r, 0);
    expect(r.all).toContain('--ci waived 4 draft-related warning(s): excluded from the failure decision');
    expect(r.all).toContain('— 4 draft-related warning(s) waived.');
  });

  it('negative control: a warning that is not draft-related (a mistyped setting) fails --ci, the waiver still said', async () => {
    // r2 MINOR (re-checked FIXED in r3): `requireCod` was accepted silently.
    const typo = sb.materialize('ci-waived-draft-typo', linkshort('draft'));
    declareId(typo, 'linkshort');
    const config = yaml.load(readFile(typo, '.wai/project.yaml')) as Record<string, Record<string, unknown>>;
    config.rules = { ...config.rules, conformance: { requireCod: true } };
    writeFile(typo, '.wai/project.yaml', yaml.dump(config));

    const plain = await sb.run(['validate'], typo);
    expectExit(plain, 0);
    expect(plain.all).toContain('[UNKNOWN_CONFIG_KEY]');
    expect(plain.all).toContain('rules.conformance.requireCod');
    expect(plain.all).toContain('Passed with 5 warning(s)');
    expect(plain.all).toContain('(except the 4 draft-related one(s))');

    const ci = await sb.run(['validate', '--ci'], typo);
    expectExit(ci, 1);
    expect(ci.all).toContain('--ci waived 4 draft-related warning(s)');
    expect(ci.all).toContain('Validation failed: warnings are treated as errors in --ci mode.');
  });
});

// ---------------------------------------------------------------------------
describe('tinkerer: the CI gate fails closed where the docs say it must', () => {
  it('a deleted lock record: plain lock-check passes but says CI should run --strict; --strict fails', async () => {
    // r1 MAJOR M8 (FIXED by UX in r2): a PR deleting .wai/lock.json switched
    // the gate off silently.
    const dir = sb.materialize('ci-deleted-lock', linkshort());
    declareId(dir, 'linkshort');
    expectExit(await sb.run(['lock', '--yes'], dir), 0);
    fs.rmSync(path.join(dir, '.wai', 'lock.json'));

    const plain = await sb.run(['lock-check'], dir);
    expectExit(plain, 0);
    expect(plain.all).toContain('never locked, or the record deleted — reads the same. CI should run `wairon lock-check --strict`, which fails here.');
    const strict = await sb.run(['lock-check', '--strict'], dir);
    expectExit(strict, 1);
    expect(strict.all).toContain('No approval on record (.wai/lock.json is absent), and --strict asks for one.');
  });

  it('a family whose member project was never approved: validate --ci and lock-check --strict both fail', async () => {
    // r1 MAJOR M9 (FIXED in r2): at the parent `validate --ci` failed on
    // MEMBER_UNAPPROVED while `lock-check --strict` said "approved".
    const projectYaml = (id: string, extra: Record<string, unknown> = {}): string => yaml.dump({
      schemaVersion: '1.0.0', id, name: id, targets: [], createdAt: TS, updatedAt: TS, ...extra,
    });
    const dir = sb.materialize('ci-family-never', {
      ...linkshort(),
      files: {
        'child2/.wai/project.yaml': projectYaml('child2'),
        'child2/.wai/specs/.index.yaml': yaml.dump({ schemaVersion: '1.0.0', name: 'child2', vision: 'A member project nobody has approved yet.', createdAt: TS, updatedAt: TS }),
      },
    });
    writeFile(dir, '.wai/project.yaml', projectYaml('straywai', { members: { child2: 'child2' } }));

    const ci = await sb.run(['validate', '--ci'], dir);
    expectExit(ci, 1);
    expect(ci.all).toContain('[MEMBER_UNAPPROVED]');

    expectExit(await sb.run(['lock', '--yes'], dir), 0);
    const plain = await sb.run(['lock-check'], dir);
    expectExit(plain, 0);
    expect(plain.all).toContain('NOT gated: child2');
    const strict = await sb.run(['lock-check', '--strict'], dir);
    expectExit(strict, 1);
    expect(strict.all).toContain('--strict asks for an approved family and member project(s) were never approved by anyone');
    expect(strict.all).toContain('child2');
  });
});

// ---------------------------------------------------------------------------
describe('tinkerer: the documented CI recipe on a fresh clone', () => {
  // r3 MAJOR: "the documented CI path is red on a fresh clone" — `wairon
  // validate --ci` without node_modules fails on CONFORMANCE_DEGRADED (a
  // runner-toolchain finding) and nothing in the docs said to install the
  // project's dependencies first. Fixed: docs/cli.md "Without the reusable
  // workflow" installs them before `validate --ci`. This replays THAT recipe,
  // read from the docs, with the BUILT CLI on a real `git clone`.
  //
  // The install is simulated offline (the repo's typescript linked into the
  // clone), and the CLI runs with a preload that lets `typescript` resolve
  // only from inside the clone — the published install's situation, since the
  // published CLI carries no TypeScript of its own.
  let clone: string;
  let fence: string;
  let steps: string[];

  const wairon = (args: string[]): Promise<CliResult> => runCliIn(args, clone, {
    ...sb.env,
    WAIRON_TEST_TYPESCRIPT_ONLY_FROM: clone,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${JSON.stringify(fence)}`.trim(),
  });

  beforeAll(async () => {
    // The recipe, as docs/cli.md gives it.
    const md = fs.readFileSync(path.join(REPO_ROOT, 'docs', 'cli.md'), 'utf8').replace(/\r\n/g, '\n');
    const at = md.indexOf('#### Without the reusable workflow');
    expect(at, 'docs/cli.md: the "Without the reusable workflow" section').toBeGreaterThan(-1);
    const block = /```yaml\n([\s\S]*?)\n```/.exec(md.slice(at));
    const workflow = yaml.load(block![1]) as { jobs: Record<string, { steps: { run?: string }[] }> };
    steps = Object.values(workflow.jobs).flatMap((j) => j.steps).filter((s) => typeof s.run === 'string').map((s) => s.run!.replace(/#.*$/, '').trim());

    // The author's machine: a TS project with one implemented component, approved and committed.
    const origin = sb.materialize('ci-origin', {
      system: { name: 'ci-fixture', vision: 'Price an order.', targetLanguage: 'typescript' },
      subsystems: [{ id: 'pricing', lifecycle: [{ phase: 'init', component: 'price_calculator', method: 'total' }] }],
      components: [{ id: 'price_calculator', dependencyClass: 'pure', description: 'Computes a gross price.' }],
      interfaces: [{
        id: 'iprice_calculator',
        methods: [{ name: 'total', description: 'The gross price of a net amount.', returns: 'float', params: [{ name: 'net', type: 'float' }, { name: 'rate', type: 'float' }] }],
      }],
      implementations: [{
        id: 'price_calculator_impl', sourcePath: 'src/pricing.ts',
        methods: [{ name: 'total', narrative: [{ stepNumber: 1, description: 'Add the tax to the net amount', type: 'return', outcome: 'the gross price' }] }],
      }],
      files: {
        'package.json': `${JSON.stringify({ name: 'ci-fixture', version: '1.0.0', private: true, devDependencies: { typescript: '^5.5.2' } }, null, 2)}\n`,
        'package-lock.json': `${JSON.stringify({ name: 'ci-fixture', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} }, null, 2)}\n`,
        '.gitignore': 'node_modules/\n',
        'src/pricing.ts': 'export class PriceCalculator {\n  total(net: number, rate: number): number {\n    return net + net * rate;\n  }\n}\n',
      },
    });
    declareId(origin, 'ci-fixture');
    expectExit(await sb.run(['lock', '--yes'], origin), 0);
    gitInit(origin);

    // CI: a fresh clone, no node_modules. Long (non-8.3) path: the fence compares the analyzer's file names.
    const parent = fs.realpathSync.native(sb.project('ci-runner'));
    clone = path.join(parent, 'clone');
    execFileSync('git', ['-c', 'core.autocrlf=false', 'clone', '-q', origin, clone], { stdio: 'ignore' });
    expect(fs.existsSync(path.join(clone, 'node_modules'))).toBe(false);
    expect(fs.existsSync(path.join(clone, '.wai', 'lock.json'))).toBe(true);

    fence = path.join(parent, 'typescript-fence.cjs');
    fs.writeFileSync(fence, [
      "const Module = require('module');",
      "const path = require('path');",
      'const only = path.resolve(process.env.WAIRON_TEST_TYPESCRIPT_ONLY_FROM).toLowerCase() + path.sep;',
      'const resolve = Module._resolveFilename;',
      'Module._resolveFilename = function (request, parent, ...rest) {',
      "  if (request === 'typescript' || request.startsWith('typescript/')) {",
      "    const from = parent && parent.filename ? path.resolve(parent.filename).toLowerCase() : '';",
      '    if (!from.startsWith(only)) {',
      "      const e = new Error(\"Cannot find module 'typescript' (outside the project under test)\");",
      "      e.code = 'MODULE_NOT_FOUND';",
      '      throw e;',
      '    }',
      '  }',
      '  return resolve.call(this, request, parent, ...rest);',
      '};',
      '',
    ].join('\n'));
  });

  it('the docs install the project\'s dependencies between lock-check --strict and validate --ci', () => {
    const install = steps.findIndex((s) => /^(npm ci|pnpm install|yarn install)\b/.test(s));
    expect(steps.indexOf('wairon lock-check --strict'), JSON.stringify(steps)).toBeGreaterThan(-1);
    expect(install, JSON.stringify(steps)).toBeGreaterThan(steps.indexOf('wairon lock-check --strict'));
    expect(install).toBeLessThan(steps.indexOf('wairon validate --ci'));
  });

  it('skipping the install: validate --ci is red on CONFORMANCE_DEGRADED (what the trial hit), lock-check --strict green', async () => {
    const strict = await wairon(['lock-check', '--strict']);
    expectExit(strict, 0);
    expect(strict.all).toContain('The design in this tree is the approved design');
    const ci = await wairon(['validate', '--ci']);
    expectExit(ci, 1);
    expect(ci.all).toContain('[CONFORMANCE_DEGRADED]');
    expect(ci.all).toContain('no TypeScript compiler API could be loaded');
  });

  it('the documented steps, in order, all pass on the clone', async () => {
    let installed = false;
    for (const step of steps) {
      if (/^npm install --global @wairon\/cli@/.test(step)) continue; // the built CLI stands in for the published one
      if (/^(npm ci|pnpm install|yarn install)\b/.test(step)) {
        fs.mkdirSync(path.join(clone, 'node_modules'), { recursive: true });
        fs.symlinkSync(path.join(REPO_ROOT, 'node_modules', 'typescript'), path.join(clone, 'node_modules', 'typescript'), 'junction');
        installed = true;
        continue;
      }
      expect(step, 'a recipe step this journey does not know how to run').toMatch(/^wairon /);
      const r = await wairon(step.split(/\s+/).slice(1));
      expect(r.code, `${step}\n${transcript(r)}`).toBe(0);
      if (step === 'wairon validate --ci') expect(r.all).not.toContain('CONFORMANCE_DEGRADED');
    }
    expect(installed).toBe(true);
  });
});
