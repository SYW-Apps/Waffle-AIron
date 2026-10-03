import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { moveMember } from '../../src/core/index.js';
import * as migrations from '../../src/migrations/index.js';
import * as transaction from '../../src/migrations/transaction.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import type { MigrationRequest } from '../../src/migrations/types.js';
import { at, dirHash, migrate, plan, waiState } from '../helpers/family-verbs.js';
import { tempDir, isolateGlobals, git, projectYaml, writeClinic, writeLedger, writeShop } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Stage 8 follow-up — a sibling checkout joins the family transaction. A part
// or a project member stored at `../x` (beside the family root, on the same
// volume) is an owner like any other: promote, demote, internalize and move
// work for it, all-or-nothing across both roots, while each repository still
// gets its own commit (the plan says so). One on another volume is refused.
// The fs module is wrapped (never replaced) so a test can inject a failure at
// any write, or report another device for a path; nothing else is mocked.
// Also: a pin records a producer's commit only across repositories.
// ---------------------------------------------------------------------------

const hook = vi.hoisted(() => ({
  before: null as null | ((op: string) => Error | undefined),
  dev: null as null | ((p: string) => number | undefined),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const wrap = <A extends unknown[], R>(op: string, fn: (...args: A) => R) => (...args: A): R => {
    const injected = hook.before?.(op);
    if (injected) throw injected;
    return fn(...args);
  };
  const statSync = ((p: fs.PathLike, o?: fs.StatSyncOptions) => {
    const stat = actual.statSync(p, o as fs.StatSyncOptions) as fs.Stats;
    const dev = hook.dev?.(path.resolve(String(p)));
    return dev === undefined ? stat : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev });
  }) as typeof actual.statSync;
  const mocked = {
    ...actual,
    statSync,
    renameSync: wrap('rename', actual.renameSync),
    writeSync: wrap('write', actual.writeSync as (...args: unknown[]) => number),
    writeFileSync: wrap('writeFile', actual.writeFileSync),
    unlinkSync: wrap('unlink', actual.unlinkSync),
    mkdirSync: wrap('mkdir', actual.mkdirSync),
    rmdirSync: wrap('rmdir', actual.rmdirSync),
  };
  return { ...mocked, default: mocked };
});

const ioError = (): Error => Object.assign(new Error('injected EIO'), { code: 'EIO' });

const cleanups: (() => void)[] = [];
beforeEach(() => {
  cleanups.push(isolateGlobals(cleanups));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  hook.before = null;
  hook.dev = null;
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows locks */ }
  }
});

/** The clinic with its scheduling PART in a sibling checkout `../scheduling`; answers the shared base, the clinic and the part. */
function siblingClinic(): { base: string; root: string; part: string } {
  const base = tempDir(cleanups, 'wairon-sibling-');
  const root = path.join(base, 'clinic');
  const { part: contained } = writeClinic(root);
  const part = path.join(base, 'scheduling');
  fs.renameSync(contained, part);
  fs.rmSync(path.join(root, 'services'), { recursive: true, force: true });
  fs.writeFileSync(path.join(part, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf: { project: 'clinic', path: '../clinic' } }));
  projectYaml(root, { id: 'clinic', name: 'Clinic', members: { scheduling: '../scheduling' } });
  return { base, root, part };
}

describe('stage 8 — a sibling checkout joins the family transaction', () => {
  it('promote and demote a part in a sibling checkout: both roots move together, the plan says one commit per repository, and the round trip is the identity', () => {
    const { root, part } = siblingClinic();
    const partBytes = waiState(part);
    const parentConfig = projectConfigRepositoryAt(root).load();
    const promoted = migrate(root, { verb: 'promote', alias: 'scheduling' });
    expect(promoted.applied).toBe(true);
    expect(promoted.plan.notes.join('\n')).toMatch(/files: all-or-nothing across .*; commits: one per repository/);
    expect(projectConfigRepositoryAt(part).load()).toMatchObject({ id: 'scheduling' });
    expect(promoted.plan.changes.some((c) => path.resolve(c.project) === path.resolve(part))).toBe(true);
    const demoted = migrate(root, { verb: 'demote', alias: 'scheduling' });
    expect(demoted.applied).toBe(true);
    expect(waiState(part)).toEqual(partBytes);
    expect(projectConfigRepositoryAt(root).load()).toEqual(parentConfig);
  });

  it('internalize a project in a sibling checkout: demoted and moved in, the sibling\'s .wai gone, in one transaction', () => {
    const { root, part } = siblingClinic();
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const report = migrate(root, { verb: 'internalize', alias: 'scheduling' });
    expect(report.applied).toBe(true);
    expect(projectConfigRepositoryAt(root).load()?.members).toBeUndefined();
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'scheduling', 'booking-client', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(part, '.wai'))).toBe(false);
  });

  it('move relocates a sibling part to another sibling path, its PartOf re-expressed; a move into the project refuses', () => {
    const { base, root } = siblingClinic();
    at(root, () => moveMember('scheduling', '../agenda'));
    expect(projectConfigRepositoryAt(root).load()?.members).toEqual({ scheduling: '../agenda' });
    expect(projectConfigRepositoryAt(path.join(base, 'agenda')).load()?.partOf).toEqual({ project: 'clinic', path: '../clinic' });
    expect(() => at(root, () => moveMember('scheduling', 'services/agenda'))).toThrow(/keeps its storage/);
  });

  for (const request of [
    { verb: 'promote', alias: 'scheduling' },
    { verb: 'demote', alias: 'scheduling' },
  ] satisfies MigrationRequest[]) {
    it(`${request.verb} across a parent and its sibling: a failure at every write position leaves BOTH byte-identical`, () => {
      const fresh = (): { base: string; root: string } => {
        const f = siblingClinic();
        if (request.verb === 'demote') migrate(f.root, { verb: 'promote', alias: 'scheduling' });
        return f;
      };
      // How many wrapped operations a clean apply performs.
      const probe = fresh();
      const counted = at(probe.root, () => migrations.plan(request));
      expect(counted.refusals).toEqual([]);
      let positions = 0;
      hook.before = () => { positions++; return undefined; };
      expect(at(probe.root, () => migrations.apply(counted)).applied).toBe(true);
      hook.before = null;
      expect(positions).toBeGreaterThan(10);
      for (let k = 1; k <= positions; k++) {
        const { base, root } = fresh();
        const before = dirHash(base);
        const planned = at(root, () => migrations.plan(request));
        let n = 0;
        hook.before = () => (++n === k ? ioError() : undefined);
        const report = at(root, () => migrations.apply(planned));
        hook.before = null;
        expect({ k, applied: report.applied, restored: report.outcome?.restored, unrestored: report.outcome?.unrestored })
          .toEqual({ k, applied: false, restored: true, unrestored: [] });
        expect(dirHash(base), `position ${k}`).toEqual(before);
      }
    }, 600_000);
  }

  for (const from of ['the family root', 'the sibling'] as const) {
    it(`a crash mid-swap is recovered from ${from}: both roots byte-identical again, no transaction left`, () => {
      const { base, root, part } = siblingClinic();
      const before = dirHash(base);
      const planned = at(root, () => migrations.plan({ verb: 'promote', alias: 'scheduling' }));
      expect(planned.refusals).toEqual([]);
      const journals = transaction.stage(planned.rehearsal!, planned.changes, 'promote');
      expect(journals.map((j) => path.resolve(j.owner))).toEqual(expect.arrayContaining([path.resolve(root), path.resolve(part)]));
      // The process dies after three swapped files: no in-process restore runs.
      let renames = 0;
      hook.before = (op) => (op === 'rename' && ++renames > 3 ? ioError() : undefined);
      expect(() => transaction.swap(journals)).toThrow();
      hook.before = null;
      expect(dirHash(base)).not.toEqual(before);
      const recovered = transaction.recover(from === 'the sibling' ? part : root, true);
      expect(recovered.map((r) => r.action)).toEqual(['rolled-back']);
      expect(recovered[0].owners.map((o) => path.resolve(o)).sort()).toEqual([path.resolve(root), path.resolve(part)].sort());
      migrations.drop(planned.rehearsal!);
      expect(dirHash(base)).toEqual(before);
      expect(fs.existsSync(path.join(root, '.wai', 'transactions'))).toBe(false);
      expect(fs.existsSync(path.join(part, '.wai', 'transactions'))).toBe(false);
    });
  }

  it('a sibling on another volume is refused with that reason, writing nothing', () => {
    const { base, root, part } = siblingClinic();
    const before = dirHash(base);
    hook.dev = (p) => (p.startsWith(path.resolve(part)) ? 424_242 : undefined);
    const planned = plan(root, { verb: 'promote', alias: 'scheduling' });
    hook.dev = null;
    expect(planned.refusals.map((r) => r.code)).toEqual(['cross-volume']);
    expect(planned.refusals[0].detail).toMatch(/another volume/);
    expect(dirHash(base)).toEqual(before);
  });

  it('demote names every L0 export entry it removes — a promote\'s and a hand-written one', () => {
    const { root } = writeClinic(path.join(tempDir(cleanups, 'wairon-demote-exports-'), 'clinic'));
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    // A hand-written entry the member alone uses: re-export the patient type from its subsystem.
    const l0 = path.join(root, '.wai', 'specs', '.index.yaml');
    const doc = yaml.load(fs.readFileSync(l0, 'utf8')) as { publicInterfaces: Record<string, unknown>[] };
    expect(doc.publicInterfaces).toEqual([
      { component: 'patient-portal', from: 'frontdesk', audience: 'project' },
      { typeDef: 'patient', audience: 'project' },
    ]);
    const planned = plan(root, { verb: 'demote', alias: 'scheduling' });
    const named = planned.edits.filter((e) => e.kind === 'export').map((e) => e.detail);
    expect(named).toEqual([
      expect.stringMatching(/L0 export patient-portal \(from frontdesk\) removed/),
      expect.stringMatching(/L0 export patient removed/),
    ]);
    migrations.discard(planned);
  });
});

describe('stage 8 — a pin records a commit only across repositories', () => {
  it('a producer in the consumer\'s repository records none; a sibling that is its own repository records its head', () => {
    const base = tempDir(cleanups, 'wairon-pincommit-');
    // One repository holding both: a monorepo.
    const mono = path.join(base, 'mono');
    writeLedger(path.join(mono, 'ledger'));
    writeShop(path.join(mono, 'shop'), { externals: { ledger: { source: { path: '../ledger' } } } });
    git(mono, 'init', '-q');
    git(mono, 'add', '-A');
    git(mono, 'commit', '-q', '-m', 'mono');
    at(path.join(mono, 'shop'), () => pinExternals());
    const monoLock = yaml.load(fs.readFileSync(path.join(mono, 'shop', '.wai', 'externals.lock.yaml'), 'utf8')) as { externals: Record<string, Record<string, unknown>> };
    expect(monoLock.externals.ledger.commit).toBeUndefined();
    // Two repositories side by side.
    writeLedger(path.join(base, 'ledger'));
    git(path.join(base, 'ledger'), 'init', '-q');
    git(path.join(base, 'ledger'), 'add', '-A');
    git(path.join(base, 'ledger'), 'commit', '-q', '-m', 'ledger');
    const head = git(path.join(base, 'ledger'), 'rev-parse', 'HEAD');
    writeShop(path.join(base, 'shop'), { externals: { ledger: { source: { path: '../ledger' } } } });
    git(path.join(base, 'shop'), 'init', '-q');
    at(path.join(base, 'shop'), () => pinExternals());
    const lock = yaml.load(fs.readFileSync(path.join(base, 'shop', '.wai', 'externals.lock.yaml'), 'utf8')) as { externals: Record<string, Record<string, unknown>> };
    expect(lock.externals.ledger.commit).toBe(head);
  });
});
