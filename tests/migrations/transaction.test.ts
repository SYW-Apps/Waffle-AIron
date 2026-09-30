import { describe, it, expect, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as transaction from '../../src/migrations/transaction.js';
import { sameVolume } from '../../src/migrations/family-files.js';
import { transactionRepository } from '../../src/migrations/transaction-store.js';
import type { FileChange, MigrationPlan, Rehearsal } from '../../src/migrations/types.js';
import * as migrations from '../../src/migrations/index.js';
import { plan as planChaining, isEmpty } from '../../src/migrations/chaining-migration.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 6 — the family transaction, on real temp directories. Nothing on the
// path under test is mocked: `fs` is wrapped only to INJECT a failure (or a
// Windows sharing violation, or another volume) at a chosen operation, and
// passes every other call straight through.
//
// The family: a top root and two members, each with its own .wai tree. The
// rehearsed change set touches all three owners with every action — a write,
// a create under directories that do not exist yet, and a delete that empties
// its directory — so a swap makes and prunes directories as well as files.
// ---------------------------------------------------------------------------

const hook = vi.hoisted(() => ({
  /** Called before each wrapped operation; an Error it answers is thrown instead. */
  before: null as null | ((op: string, args: unknown[]) => Error | undefined),
  /** A fake device id for a path, to stand in for another volume. */
  dev: null as null | ((p: string) => number | undefined),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const wrap = <A extends unknown[], R>(op: string, fn: (...args: A) => R) => (...args: A): R => {
    const injected = hook.before?.(op, args);
    if (injected) throw injected;
    return fn(...args);
  };
  const statSync = ((p: fs.PathLike, o?: fs.StatSyncOptions) => {
    const stat = actual.statSync(p, o as fs.StatSyncOptions) as fs.Stats;
    const dev = hook.dev?.(String(p));
    return dev === undefined ? stat : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev });
  }) as typeof actual.statSync;
  const mocked = {
    ...actual,
    renameSync: wrap('rename', actual.renameSync),
    writeSync: wrap('write', actual.writeSync as (...args: unknown[]) => number),
    writeFileSync: wrap('writeFile', actual.writeFileSync),
    unlinkSync: wrap('unlink', actual.unlinkSync),
    mkdirSync: wrap('mkdir', actual.mkdirSync),
    rmdirSync: wrap('rmdir', actual.rmdirSync),
    statSync,
  };
  return { ...mocked, default: mocked };
});

interface Family { root: string; m1: string; m2: string }

const made: string[] = [];

function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function buildFamily(): Family {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-tx-'));
  made.push(root);
  const m1 = path.join(root, 'packages', 'm1');
  const m2 = path.join(root, 'packages', 'm2');
  put(path.join(root, '.wai', 'project.yaml'), 'id: top\nmembers:\n  m1: packages/m1\n  m2: packages/m2\n');
  put(path.join(root, '.wai', 'specs', '.index.yaml'), 'name: Top\n');
  put(path.join(root, '.wai', 'specs', 'sub', 'b.yaml'), 'id: b\n');
  put(path.join(m1, '.wai', 'project.yaml'), 'id: m1\n');
  put(path.join(m1, '.wai', 'specs', 'x.yaml'), 'id: x\n');
  put(path.join(m1, '.wai', 'specs', 'only', 'y.yaml'), 'id: y\n');
  put(path.join(m2, '.wai', 'project.yaml'), 'id: m2\n');
  // Source code beside the trees: never copied, never compared, never touched.
  put(path.join(m1, 'src', 'index.ts'), 'export const x = 1;\n');
  return { root, m1, m2 };
}

/** Rehearse the family and make the change set on the copy: a write, a create in new directories and a delete per owner. */
function rehearseChanges(f: Family): { rehearsal: Rehearsal; changes: FileChange[] } {
  const rehearsal = transaction.rehearse({ familyRoot: f.root, projects: [f.root, f.m1, f.m2] });
  const at = (live: string, ...rel: string[]): string => path.join(rehearsal.roots.get(live)!, ...rel);
  put(at(f.root, '.wai', 'project.yaml'), 'id: top\nmembers:\n  m1: packages/m1\n  m2: packages/m2\nexternals: {}\n');
  put(at(f.root, '.wai', 'specs', 'new', 'deep', 'c.yaml'), 'id: c\n');
  fs.writeFileSync(at(f.m1, '.wai', 'specs', 'x.yaml'), 'id: x\nrenamed: true\n');
  fs.rmSync(at(f.m1, '.wai', 'specs', 'only', 'y.yaml'));
  put(at(f.m2, '.wai', 'externals.lock.yaml'), 'externals: {}\n');
  put(at(f.m2, '.wai', 'externals', 'p.yaml'), 'alias: p\n');
  return { rehearsal, changes: transaction.diff(rehearsal) };
}

/** Every directory and every file under a root, the files by digest — byte identity, directories included. */
function tree(root: string, skip: (rel: string) => boolean = () => false): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (skip(rel)) continue;
      if (entry.isDirectory()) {
        out[`${rel}/`] = 'dir';
        walk(full);
      } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

/** The files of a tree alone: a rehearsal keeps a directory its writer emptied, the family prunes it. */
const filesOf = (t: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(t).filter(([k]) => !k.endsWith('/')));

function transactionDirsLeft(f: Family): string[] {
  return [f.root, f.m1, f.m2].filter((d) => fs.existsSync(path.join(d, '.wai', 'transactions')));
}

const ioError = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

/** Count the wrapped operations a clean commit performs, up to and including its commit point. */
function countCommitOperations(): number {
  const f = buildFamily();
  const { rehearsal, changes } = rehearseChanges(f);
  let n = 0;
  hook.before = () => { n++; return undefined; };
  const outcome = transaction.commit(rehearsal, changes, 'test');
  hook.before = null;
  expect(outcome.committed).toBe(true);
  return n;
}

afterEach(() => {
  hook.before = null;
  hook.dev = null;
  for (const dir of made.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows locks */ }
  }
});

describe('stage 6 — the family transaction', () => {
  it('rehearses only .wai trees and diffs every action per owner then path', () => {
    const f = buildFamily();
    const { rehearsal, changes } = rehearseChanges(f);
    expect(rehearsal.directory.startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(path.join(rehearsal.roots.get(f.m1)!, 'src'))).toBe(false);
    expect(changes.map((c) => `${path.relative(f.root, c.project) || '.'}|${c.action}|${c.path}`)).toEqual([
      '.|write|.wai/project.yaml',
      '.|create|.wai/specs/new/deep/c.yaml',
      `${path.join('packages', 'm1')}|delete|.wai/specs/only/y.yaml`,
      `${path.join('packages', 'm1')}|write|.wai/specs/x.yaml`,
      `${path.join('packages', 'm2')}|create|.wai/externals.lock.yaml`,
      `${path.join('packages', 'm2')}|create|.wai/externals/p.yaml`,
    ]);
    // A plan writes nothing into the family.
    expect(transactionDirsLeft(f)).toEqual([]);
    transaction.discard(rehearsal);
    expect(fs.existsSync(rehearsal.directory)).toBe(false);
  });

  it('commits every change, writes the self-ignoring .gitignore while staging, and leaves nothing behind', () => {
    const f = buildFamily();
    const { rehearsal, changes } = rehearseChanges(f);
    const expected = tree(rehearsal.directory);
    let ignore: string | null = null;
    hook.before = (op, args) => {
      if (op === 'rename' && String(args[1]).endsWith(path.join('.wai', 'transactions', '.gitignore'))) ignore = fs.readFileSync(String(args[0]), 'utf8');
      return undefined;
    };
    const outcome = transaction.commit(rehearsal, changes, 'test');
    hook.before = null;
    expect(outcome).toMatchObject({ committed: true, restored: false, unrestored: [] });
    expect(ignore).toBe('*\n');
    // The family now holds exactly the rehearsal's .wai bytes (and its own source).
    const live = tree(f.root, (rel) => rel.split('/').includes('src'));
    expect(filesOf(live)).toEqual(filesOf(expected));
    expect(transactionDirsLeft(f)).toEqual([]);
    expect(fs.existsSync(rehearsal.directory)).toBe(false);
    // The emptied directory went with its last file.
    expect(fs.existsSync(path.join(f.m1, '.wai', 'specs', 'only'))).toBe(false);
  });

  it('property: atomic-or-nothing — a failure at EVERY write position of stage and swap leaves the family byte-identical', () => {
    const positions = countCommitOperations();
    expect(positions).toBeGreaterThan(40);
    for (let k = 1; k <= positions; k++) {
      const f = buildFamily();
      const before = tree(f.root);
      const { rehearsal, changes } = rehearseChanges(f);
      let n = 0;
      hook.before = () => (++n === k ? ioError('EIO') : undefined);
      const outcome = transaction.commit(rehearsal, changes, 'test');
      hook.before = null;
      expect({ k, committed: outcome.committed, restored: outcome.restored, unrestored: outcome.unrestored }).toEqual({ k, committed: false, restored: true, unrestored: [] });
      expect(tree(f.root)).toEqual(before);
      expect(fs.existsSync(rehearsal.directory)).toBe(false);
    }
  }, 120_000);

  it('refuses before anything live moves when a live file moved since the rehearsal copied it', () => {
    const f = buildFamily();
    const { rehearsal, changes } = rehearseChanges(f);
    fs.writeFileSync(path.join(f.m1, '.wai', 'specs', 'x.yaml'), 'id: x\nedited: by someone else\n');
    const before = tree(f.root);
    const outcome = transaction.commit(rehearsal, changes, 'test');
    expect(outcome.committed).toBe(false);
    expect(outcome.failure).toMatch(/moved since planned/);
    expect(outcome.restored).toBe(true);
    expect(tree(f.root)).toEqual(before);
  });
});

describe('stage 6 — Windows sharing violations and volumes', () => {
  it('a replace blocked with EBUSY that clears after a few tries succeeds', () => {
    const f = buildFamily();
    const { rehearsal, changes } = rehearseChanges(f);
    const target = path.join(f.m1, '.wai', 'specs', 'x.yaml');
    let blocked = 0;
    hook.before = (op, args) => {
      if (op === 'rename' && String(args[1]) === target && blocked < 3) {
        blocked++;
        return ioError('EBUSY');
      }
      return undefined;
    };
    const outcome = transaction.commit(rehearsal, changes, 'test');
    hook.before = null;
    expect(blocked).toBe(3);
    expect(outcome.committed).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('renamed: true');
  });

  it('a replace blocked with EBUSY that never clears is retried 8 times, then the family is restored', () => {
    const f = buildFamily();
    const before = tree(f.root);
    const { rehearsal, changes } = rehearseChanges(f);
    const target = path.join(f.m1, '.wai', 'specs', 'x.yaml');
    let attempts = 0;
    hook.before = (op, args) => {
      // The swap's rename from the staged copy; the restore's own rename is never blocked.
      if (op === 'rename' && String(args[1]) === target && String(args[0]).includes(`${path.sep}staged${path.sep}`)) {
        attempts++;
        return ioError('EBUSY');
      }
      return undefined;
    };
    const outcome = transaction.commit(rehearsal, changes, 'test');
    hook.before = null;
    expect(attempts).toBe(8);
    expect(outcome).toMatchObject({ committed: false, restored: true, unrestored: [] });
    expect(outcome.failure).toMatch(/EBUSY/);
    expect(tree(f.root)).toEqual(before);
  });

  it('a sharing error on a read-only target is not retried', () => {
    const f = buildFamily();
    const before = tree(f.root);
    const { rehearsal, changes } = rehearseChanges(f);
    const target = path.join(f.m1, '.wai', 'specs', 'x.yaml');
    let attempts = 0;
    hook.before = (op, args) => {
      if (op === 'rename' && String(args[1]) === target && String(args[0]).includes(`${path.sep}staged${path.sep}`)) {
        attempts++;
        return ioError('EPERM');
      }
      return undefined;
    };
    fs.chmodSync(target, 0o444);
    try {
      const outcome = transaction.commit(rehearsal, changes, 'test');
      expect(outcome.committed).toBe(false);
    } finally {
      hook.before = null;
      fs.chmodSync(target, 0o644);
    }
    expect(attempts).toBe(1);
    expect(tree(f.root)).toEqual(before);
  });

  it('sameVolume compares device ids; a missing path answers false', () => {
    const f = buildFamily();
    expect(sameVolume(path.join(f.root, '.wai', 'project.yaml'), path.join(f.m1, '.wai'))).toBe(true);
    expect(sameVolume(path.join(f.root, 'nope'), f.root)).toBe(false);
    hook.dev = (p) => (p.startsWith(f.m2) ? 999_999 : undefined);
    expect(sameVolume(path.join(f.root, '.wai', 'project.yaml'), path.join(f.m2, '.wai'))).toBe(false);
  });

  it('refuses a swap that would cross volumes before anything live moves', () => {
    const f = buildFamily();
    const before = tree(f.root);
    const { rehearsal, changes } = rehearseChanges(f);
    // A .wai subtree "linked onto another drive": its staged copies report another device.
    hook.dev = (p) => (p.includes(`${path.sep}staged${path.sep}`) && p.startsWith(f.m2) ? 424_242 : undefined);
    const outcome = transaction.commit(rehearsal, changes, 'test');
    hook.dev = null;
    expect(outcome.committed).toBe(false);
    expect(outcome.failure).toMatch(/cross-volume/);
    expect(tree(f.root)).toEqual(before);
  });
});

describe('stage 6 — the crash journal', () => {
  /** Stage (and swap, up to a crash) without the in-process restore a crash never gets to run. */
  function crashDuring(f: Family, phase: 'staging' | 'staged' | 'swapping' | 'committed', crashAt = 0): { committed: Record<string, string> } {
    const { rehearsal, changes } = rehearseChanges(f);
    const committed = tree(rehearsal.directory);
    const crash = (): Error => new Error('process died');
    if (phase === 'staging') {
      let journaled = false;
      // Past the coordinator's first journal save: the staged bytes are being written.
      hook.before = (op, args) => {
        if (journaled) return crash();
        if (op === 'rename' && String(args[1]).endsWith('journal.yaml')) journaled = true;
        return undefined;
      };
      expect(() => transaction.stage(rehearsal, changes, 'test')).toThrow();
      hook.before = null;
      return { committed };
    }
    const journals = transaction.stage(rehearsal, changes, 'test');
    if (phase === 'staged') return { committed };
    if (phase === 'swapping') {
      let n = 0;
      hook.before = () => (++n === crashAt ? crash() : undefined);
      try { transaction.swap(journals); } catch { /* the process died here */ }
      hook.before = null;
      return { committed };
    }
    transaction.swap(journals);
    // The commit point is recorded, and the process dies before closing.
    const coordinator = { ...journals[0], phase: 'committed' as const };
    transactionRepository.saveJournal(coordinator);
    return { committed };
  }

  for (const phase of ['staging', 'staged'] as const) {
    it(`property: crash-journal-rolls-back — a crash while ${phase} is rolled back to byte-identical`, () => {
      const f = buildFamily();
      const before = tree(f.root);
      crashDuring(f, phase);
      expect(transactionDirsLeft(f).length).toBeGreaterThan(0);
      // Plain doctor only reports; nothing is written.
      const reported = transaction.recover(f.root, false);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatchObject({ action: 'pending', verb: 'test' });
      const recovered = transaction.recover(f.root, true);
      expect(recovered.map((r) => r.action)).toEqual(['rolled-back']);
      expect(tree(f.root)).toEqual(before);
      // Idempotent: nothing is left to find.
      expect(transaction.recover(f.root, true)).toEqual([]);
    });
  }

  it('property: crash-journal-rolls-back — a crash at EVERY operation of the swap is rolled back to byte-identical', () => {
    // How many wrapped operations one swap performs.
    const probe = buildFamily();
    const { rehearsal, changes } = rehearseChanges(probe);
    const journals = transaction.stage(rehearsal, changes, 'test');
    let total = 0;
    hook.before = () => { total++; return undefined; };
    transaction.swap(journals);
    hook.before = null;
    expect(total).toBeGreaterThan(10);
    for (let k = 1; k <= total; k++) {
      const f = buildFamily();
      const before = tree(f.root);
      crashDuring(f, 'swapping', k);
      // Recovered from a MEMBER's root: its journal names the coordinator by a recorded path.
      const recovered = transaction.recover(f.m1, true);
      expect({ k, actions: recovered.map((r) => r.action) }).toEqual({ k, actions: ['rolled-back'] });
      expect(transactionDirsLeft(f)).toEqual([]);
      expect(tree(f.root)).toEqual(before);
    }
  }, 120_000);

  it('property: crash-journal-rolls-back — a crash after the commit point is only cleaned up: the committed state stays', () => {
    const f = buildFamily();
    const { committed } = crashDuring(f, 'committed');
    const recovered = transaction.recover(f.root, true);
    expect(recovered.map((r) => r.action)).toEqual(['cleaned']);
    expect(transactionDirsLeft(f)).toEqual([]);
    expect(filesOf(tree(f.root, (rel) => rel.split('/').includes('src')))).toEqual(filesOf(committed));
    expect(fs.existsSync(path.join(f.m1, '.wai', 'specs', 'only'))).toBe(false);
  });

  it('a member whose coordinator is out of reach is refused, not guessed', () => {
    const f = buildFamily();
    crashDuring(f, 'staged');
    // The coordinator's journal is gone: nobody can know whether the swap was final.
    const coordinatorTx = path.join(f.root, '.wai', 'transactions');
    const id = fs.readdirSync(coordinatorTx).find((n) => n !== '.gitignore')!;
    fs.rmSync(path.join(coordinatorTx, id), { recursive: true, force: true });
    const recovered = transaction.recover(f.m1, true);
    expect(recovered.map((r) => r.action)).toEqual(['refused']);
    expect(recovered[0].detail).toMatch(/coordinator/);
  });
});

describe('stage 6 — a crash mid-swap during a chaining migration', () => {
  it('property: nothing is half-migrated — a crash at every swap operation is rolled back to byte-identical, and the migration then applies whole', () => {
    const plannedOn = (f: ReferenceFamily): MigrationPlan => {
      invalidateSpecCache();
      setProjectRoot(f.top);
      try {
        return migrations.plan({ verb: 'chaining' });
      } finally {
        setProjectRoot(null);
      }
    };
    // How many wrapped operations the chaining migration's swap performs.
    const probe = buildReferenceFamily();
    made.push(probe.top);
    const probePlan = plannedOn(probe);
    expect(probePlan.refusals).toEqual([]);
    const probeJournals = transaction.stage(probePlan.rehearsal!, probePlan.changes, 'chaining');
    let total = 0;
    hook.before = () => { total++; return undefined; };
    transaction.swap(probeJournals);
    hook.before = null;
    transaction.discard(probePlan.rehearsal!);
    expect(total).toBeGreaterThan(probePlan.changes.length);

    for (let k = 1; k <= total; k++) {
      const f = buildReferenceFamily();
      made.push(f.top);
      const before = tree(f.top);
      const planned = plannedOn(f);
      const journals = transaction.stage(planned.rehearsal!, planned.changes, 'chaining');
      let n = 0;
      hook.before = () => (++n === k ? new Error('process died mid-swap') : undefined);
      try { transaction.swap(journals); } catch { /* the process died here */ }
      hook.before = null;
      transaction.discard(planned.rehearsal!);
      // doctor --fix, from the top root.
      const recovered = migrations.recover(f.top, true);
      expect({ k, actions: recovered.map((r) => r.action) }).toEqual({ k, actions: ['rolled-back'] });
      expect(tree(f.top)).toEqual(before);
    }

    // After a rollback the migration applies whole, and re-plans empty.
    const f = buildReferenceFamily();
    made.push(f.top);
    const planned = plannedOn(f);
    invalidateSpecCache();
    setProjectRoot(f.top);
    try {
      expect(migrations.apply(planned).applied).toBe(true);
      expect(isEmpty(planChaining())).toBe(true);
    } finally {
      setProjectRoot(null);
    }
  }, 300_000);
});
