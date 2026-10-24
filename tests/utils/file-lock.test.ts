import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  acquireFileLock,
  assertLockHeld,
  inspectFileLock,
  releaseFileLock,
  withFileLock,
  type FileLockOptions,
} from '../../src/utils/file-lock.js';
import { holderIsLocal, parseHolder, pidAlive, serializeHolder, type LockHolder } from '../../src/utils/lock-holder.js';
import { readJsonForUpdate, replaceFile } from '../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// The generation lock (file_write_lock_impl): the interleavings its argument
// names, driven deterministically through the `at` hooks (a process "stalls"
// at a point by another one's whole run inside the hook) and the injected
// clock, then real processes doing read-modify-write on one file.
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-lock-'));
  temps.push(dir);
  return dir;
}

const HOST = os.hostname();
/** A pid no live process has. */
const GONE = 999_999_999;
const stop = (): never => { throw new Error('would wait'); };
const waiting: FileLockOptions = { sleep: stop };

const names = (dir: string): string[] => fs.readdirSync(dir).sort();
const record = (pid: number, extra = ''): string => `${pid}\n${Date.now()}\n${HOST}\nnonce\n${extra}`;
const age = (file: string, ms: number): void => {
  const old = new Date(Date.now() - ms);
  fs.utimesSync(file, old, old);
};
/** A generation's lock file written by hand, as a holder would have left it. */
const plant = (target: string, g: number, text: string, ageMs = 0): string => {
  const file = `${target}.lock.${g}`;
  fs.writeFileSync(file, text);
  if (ageMs > 0) age(file, ageMs);
  return file;
};

describe('acquiring and releasing', () => {
  it('takes generation 1, runs the change, ends the generation and deletes nothing', () => {
    const target = path.join(folder(), 'data.json');
    const dir = path.dirname(target);
    expect(withFileLock(target, () => {
      expect(names(dir)).toEqual(['data.json.lock.1']);
      return 'ran';
    })).toBe('ran');
    expect(names(dir)).toEqual(['data.json.lock.1', 'data.json.lock.1.end']);
    // The next holder takes generation 2; the cleanup removes what is below it.
    withFileLock(target, () => undefined);
    expect(names(dir)).toEqual(['data.json.lock.2', 'data.json.lock.2.end']);
  });

  it('releases also when the change throws', () => {
    const target = path.join(folder(), 'data.json');
    expect(() => withFileLock(target, () => { throw new Error('refused'); })).toThrow('refused');
    expect(inspectFileLock(target)).toBeNull();
  });

  it('writes the holder record with a trailing pidns line only where a namespace is known', () => {
    const target = path.join(folder(), 'data.json');
    const here: LockHolder = { pid: 4242, takenAt: 1, host: HOST, pidNamespace: 'pid:[4026531836]' };
    const h = acquireFileLock(target, { here });
    const text = fs.readFileSync(h.lockFile, 'utf8');
    expect(text.split('\n')[0]).toBe('4242');
    expect(text.trimEnd().split('\n').pop()).toBe('pidns=pid:[4026531836]');
    expect(parseHolder(text)).toMatchObject({ pid: 4242, host: HOST, pidNamespace: 'pid:[4026531836]' });
    releaseFileLock(h);
  });

  it('a name is ignored unless it is F.lock.<digits> or F.lock.<digits>.end beside this file', () => {
    const target = path.join(folder(), 'data.json');
    const dir = path.dirname(target);
    for (const n of ['data.json.lock.abc', 'data.json.lock.7.tmp', 'data.json.lock.7.end.end', 'data.jsonx.lock.9', 'other.json.lock.9', 'data.json.lock.']) {
      fs.writeFileSync(path.join(dir, n), 'x');
    }
    const h = acquireFileLock(target);
    expect(h.generation).toBe(1);
    releaseFileLock(h);
  });
});

describe('interleavings of the argument', () => {
  it('two acquirers racing for m+1: one wins the exclusive create, the other waits on it', () => {
    const target = path.join(folder(), 'data.json');
    let winner: ReturnType<typeof acquireFileLock> | undefined;
    let fired = false;
    const events: string[] = [];
    // A listed (no lock yet) and stalls; B runs whole inside that stall and takes generation 1.
    expect(() => acquireFileLock(target, {
      sleep: stop,
      at: (point) => {
        events.push(point);
        if (point === 'listed' && !fired) {
          fired = true;
          winner = acquireFileLock(target);
        }
      },
    })).toThrow('would wait');
    expect(winner?.generation).toBe(1);
    // A's exclusive create of generation 1 got EEXIST, it never reached 'created'.
    expect(events).not.toContain('created');
    expect(inspectFileLock(target)).toMatchObject({ generation: 1, state: 'live' });
    expect(fs.readFileSync(winner!.lockFile, 'utf8')).toContain('\n');
    expect(fs.existsSync(winner!.endFile)).toBe(false);
  });

  it('a reclaimer stalled after judging only ends the generation it judged: the newer holder\'s lock is intact', () => {
    const target = path.join(folder(), 'data.json');
    // S: generation 5, left by a holder whose process is gone.
    plant(target, 5, record(GONE));
    let d: ReturnType<typeof acquireFileLock> | undefined;
    let fired = false;
    expect(() => acquireFileLock(target, {
      sleep: stop,
      at: (point, g) => {
        if (point === 'judged' && g === 5 && !fired) {
          fired = true;
          // B judged S stale and stalls. C reclaims S, takes 6 and finishes; D takes 7 and cleans below it.
          const c = acquireFileLock(target);
          expect(c.generation).toBe(6);
          releaseFileLock(c);
          d = acquireFileLock(target);
          expect(d.generation).toBe(7);
        }
      },
    })).toThrow('would wait');
    // B resumed: its whole action was to create F.lock.5.end. D's lock has no marker and still passes its own check.
    expect(d?.generation).toBe(7);
    expect(fs.existsSync(`${target}.lock.7`)).toBe(true);
    expect(fs.existsSync(`${target}.lock.7.end`)).toBe(false);
    expect(() => assertLockHeld(d!)).not.toThrow();
    expect(inspectFileLock(target)).toMatchObject({ generation: 7, state: 'live' });
    releaseFileLock(d!);
  });

  it('an acquirer stalled between listing and creating recreates a cleaned-up lower name and abandons it on relist', () => {
    const target = path.join(folder(), 'data.json');
    // Generation 1 is over; X listed it as the highest.
    plant(target, 1, record(process.pid));
    fs.writeFileSync(`${target}.lock.1.end`, '');
    let z: ReturnType<typeof acquireFileLock> | undefined;
    let fired = false;
    const created: number[] = [];
    expect(() => acquireFileLock(target, {
      sleep: stop,
      at: (point, g) => {
        if (point === 'listed' && !fired) {
          fired = true;
          // Y takes 2 and ends it; Z takes 3 and cleans everything below it, so the name 2 is free again.
          releaseFileLock(acquireFileLock(target));
          z = acquireFileLock(target);
          expect(z.generation).toBe(3);
          expect(fs.existsSync(`${target}.lock.2`)).toBe(false);
        }
        if (point === 'created') created.push(g);
      },
    })).toThrow('would wait');
    // X's exclusive create of 2 succeeded, its relist found 3, so it ended 2 instead of holding it.
    expect(created).toEqual([2]);
    expect(fs.existsSync(`${target}.lock.2.end`)).toBe(true);
    expect(fs.existsSync(`${target}.lock.3.end`)).toBe(false);
    expect(() => assertLockHeld(z!)).not.toThrow();
    releaseFileLock(z!);
  });

  it('the holder\'s release racing a reclaimer: both create the marker, one gets EEXIST, no error, the next holder is intact', () => {
    const target = path.join(folder(), 'data.json');
    const h = acquireFileLock(target);
    // The reclaimer judges H stale by age (clock far ahead), ends the generation and takes the next name; it is
    // stopped before its cleanup so H's marker is still there when H wakes.
    expect(() => acquireFileLock(target, {
      now: () => Date.now() + 10 * 60_000,
      at: (point) => { if (point === 'created') throw new Error('stalled'); },
    })).toThrow('stalled');
    expect(fs.existsSync(h.endFile)).toBe(true);
    const marker = fs.statSync(h.endFile).mtimeMs;
    // H wakes and releases: its marker already exists (EEXIST), no error, the marker is the reclaimer's untouched file.
    expect(() => releaseFileLock(h)).not.toThrow();
    expect(fs.statSync(h.endFile).mtimeMs).toBe(marker);
    expect(fs.existsSync(`${target}.lock.2`)).toBe(true);
    expect(fs.existsSync(`${target}.lock.2.end`)).toBe(false);
    // And the other order: H releases first, the reclaimer then finds the generation ended and just takes the next one.
    const first = acquireFileLock(path.join(folder(), 'x.json'));
    releaseFileLock(first);
    expect(acquireFileLock(first.file).generation).toBe(2);
  });

  it('a holder whose generation was reclaimed abandons the write before the rename, naming the reclaim', () => {
    const target = path.join(folder(), 'data.json');
    fs.writeFileSync(target, '{"n":1}');
    let thief: ReturnType<typeof acquireFileLock> | undefined;
    expect(() => withFileLock(target, () => {
      const current = readJsonForUpdate<{ n: number }>(target, { n: 0 });
      // Held up past the stale age, the lock is reclaimed and the next holder takes it.
      thief = acquireFileLock(target, { now: () => Date.now() + 10 * 60_000 });
      replaceFile(target, JSON.stringify({ n: current.n + 1 }));
    })).toThrow(/reclaimed as stale.*abandoned/);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"n":1}');
    expect(names(path.dirname(target)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // The reclaimer's own lock stays.
    expect(fs.existsSync(`${target}.lock.${thief!.generation}.end`)).toBe(false);
    releaseFileLock(thief!);
  });

  it('a holder that is not reclaimed renames as usual (the check is a no-op)', () => {
    const target = path.join(folder(), 'data.json');
    withFileLock(target, () => replaceFile(target, '{"n":2}'));
    expect(fs.readFileSync(target, 'utf8')).toBe('{"n":2}');
  });
});

describe('judging a live generation', () => {
  it('a local holder whose pid is gone is reclaimed at once; one that is alive is waited for', () => {
    const target = path.join(folder(), 'data.json');
    plant(target, 1, record(GONE));
    const h = acquireFileLock(target, waiting);
    expect(h.generation).toBe(2);
    expect(fs.existsSync(`${target}.lock.1.end`) || !fs.existsSync(`${target}.lock.1`)).toBe(true);
    releaseFileLock(h);
    // A live local holder (this very file's other process: use the test runner's parent) holds.
    const live = path.join(folder(), 'live.json');
    plant(live, 1, record(process.ppid));
    expect(() => acquireFileLock(live, waiting)).toThrow('would wait');
  });

  it('only ESRCH means gone: a pid the platform rejects, or zero, is judged by its rules', () => {
    expect(pidAlive(99_999_999_999)).toBe(true);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-5)).toBe(false);
    expect(pidAlive(GONE)).toBe(false);
  });

  it('an empty or unparseable generation is judged by age against the grace', () => {
    for (const text of ['', 'not a lock', '12345']) {
      const target = path.join(folder(), 'data.json');
      plant(target, 1, text);
      expect(inspectFileLock(target, { graceMs: 5_000 })).toMatchObject({ state: 'unreadable', breaks: false });
      expect(() => acquireFileLock(target, { ...waiting, graceMs: 5_000 })).toThrow('would wait');
      age(`${target}.lock.1`, 6_000);
      expect(inspectFileLock(target, { graceMs: 5_000 })).toMatchObject({ state: 'unreadable', breaks: true });
      const h = acquireFileLock(target, { graceMs: 5_000 });
      expect(h.generation).toBe(2);
      releaseFileLock(h);
    }
  });

  it('a lock older than the stale age is reclaimed whoever holds it', () => {
    const target = path.join(folder(), 'data.json');
    plant(target, 1, record(process.ppid), 20_000);
    expect(inspectFileLock(target, { staleMs: 15_000 })).toMatchObject({ breaks: true });
    expect(inspectFileLock(target, { staleMs: 60_000 })).toMatchObject({ breaks: false });
    const h = acquireFileLock(target, { staleMs: 15_000 });
    expect(h.generation).toBe(2);
    releaseFileLock(h);
  });

  it('a record without a namespace, judged on a namespaced platform, is remote: age only, never a pid probe', () => {
    const target = path.join(folder(), 'data.json');
    const here: LockHolder = { pid: 31337, takenAt: 0, host: HOST, pidNamespace: 'pid:[4026531836]' };
    // Written by an older wairon: pid gone here, same host name, no namespace.
    plant(target, 1, `${GONE}\n${Date.now()}\n${HOST}\n`);
    expect(inspectFileLock(target, { here })).toMatchObject({ state: 'remote', breaks: false });
    expect(() => acquireFileLock(target, { ...waiting, here })).toThrow('would wait');
    age(`${target}.lock.1`, 20_000);
    expect(inspectFileLock(target, { here, staleMs: 15_000 })).toMatchObject({ state: 'remote', breaks: true });
    // The same record judged where neither side names a namespace behaves as before: the host proves locality, the pid is gone.
    const plain = path.join(folder(), 'plain.json');
    plant(plain, 1, `${GONE}\n${Date.now()}\n${HOST}\n`);
    expect(inspectFileLock(plain, { here: { ...here, pidNamespace: undefined } })).toMatchObject({ state: 'gone', breaks: true });
  });

  it('a holder in another namespace on the same host name is remote even when its pid is gone here', () => {
    const target = path.join(folder(), 'data.json');
    const here: LockHolder = { pid: 31337, takenAt: 0, host: HOST, pidNamespace: 'pid:[1]' };
    plant(target, 1, `${GONE}\n${Date.now()}\n${HOST}\nnonce\npidns=pid:[2]\n`);
    expect(inspectFileLock(target, { here })).toMatchObject({ state: 'remote', breaks: false });
    plant(`${target}x`, 1, `${GONE}\n${Date.now()}\n${HOST}\nnonce\npidns=pid:[1]\n`);
    expect(inspectFileLock(`${target}x`, { here })).toMatchObject({ state: 'gone', breaks: true });
  });

  it('a timed-out acquire throws what the caller builds, with the holder and whether it is remote', () => {
    const target = path.join(folder(), 'data.json');
    plant(target, 1, `${process.ppid}\n${Date.now()}\nelsewhere\n`);
    let skew = 0;
    expect(() => acquireFileLock(target, {
      waitMs: 3_000,
      now: () => Date.now() + skew,
      sleep: () => { skew += 1_000; },
      timeoutError: (info) => new Error(`blocked by ${info.holder?.pid} remote=${info.remote} after ${info.waitMs}`),
    })).toThrow(`blocked by ${process.ppid} remote=true after 3000`);
    expect(() => acquireFileLock(target, { waitMs: 1_000, now: () => Date.now() + skew, sleep: () => { skew += 1_000; } })).toThrow(/data\.json is being written by another process/);
  });
});

describe('the legacy single-file lock and the cleanup', () => {
  it('a legacy F.lock is ignored on acquire and removed once older than the stale age', () => {
    const target = path.join(folder(), 'data.json');
    fs.writeFileSync(`${target}.lock`, record(process.ppid));
    const young = acquireFileLock(target);
    expect(fs.existsSync(`${target}.lock`)).toBe(true);
    releaseFileLock(young);
    age(`${target}.lock`, 60_000);
    const next = acquireFileLock(target);
    expect(next.generation).toBe(2);
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
    releaseFileLock(next);
  });

  it('the cleanup ignores a removal the platform refuses (EPERM) and never fails or delays the acquire', () => {
    const target = path.join(folder(), 'data.json');
    // Generation 1 is over, and its marker cannot be removed (a non-empty folder of that name: unlink is refused, as
    // Windows refuses a file another process has open).
    plant(target, 1, record(GONE));
    fs.mkdirSync(`${target}.lock.1.end`);
    fs.writeFileSync(path.join(`${target}.lock.1.end`, 'inside'), 'x');
    const h = acquireFileLock(target);
    expect(h.generation).toBe(2);
    expect(fs.existsSync(`${target}.lock.1.end`)).toBe(true);
    expect(fs.existsSync(`${target}.lock.1`)).toBe(false);
    releaseFileLock(h);
    // The next acquire still works over the leftover.
    const next = acquireFileLock(target);
    expect(next.generation).toBe(3);
    releaseFileLock(next);
  });
});

describe('lock_holder', () => {
  const a: LockHolder = { pid: 1, takenAt: 2, host: 'h', pidNamespace: 'pid:[1]' };

  it('is local only when the host AND the namespace are equal; both absent counts as equal', () => {
    expect(holderIsLocal(a, { ...a })).toBe(true);
    expect(holderIsLocal({ ...a, host: 'other' }, a)).toBe(false);
    expect(holderIsLocal({ ...a, pidNamespace: 'pid:[2]' }, a)).toBe(false);
    expect(holderIsLocal({ pid: 1, takenAt: 2, host: 'h' }, { pid: 3, takenAt: 4, host: 'h' })).toBe(true);
    // A namespace on one side only: remote.
    expect(holderIsLocal({ pid: 1, takenAt: 2, host: 'h' }, a)).toBe(false);
    expect(holderIsLocal(a, { pid: 1, takenAt: 2, host: 'h' })).toBe(false);
    // An absent host counts as equal.
    expect(holderIsLocal({ pid: 1, takenAt: 2, pidNamespace: 'pid:[1]' }, a)).toBe(true);
  });

  it('serializes with the namespace as a trailing line, so the positional lines of an older reader do not move', () => {
    const text = serializeHolder(a, 'abc');
    expect(text).toBe('1\n2\nh\nabc\npidns=pid:[1]\n');
    expect(text.split('\n').slice(0, 3)).toEqual(['1', '2', 'h']);
    expect(parseHolder(text)).toEqual(a);
    expect(serializeHolder({ pid: 1, takenAt: 2, host: 'h' }, 'abc')).toBe('1\n2\nh\nabc\n');
    expect(parseHolder('1\n2\n')).toEqual({ pid: 1, takenAt: 2 });
    expect(parseHolder('')).toBeNull();
    expect(parseHolder('x\n2\n')).toBeNull();
  });
});

describe('real processes', () => {
  it('N processes doing read-modify-write increments on one file lose none', async () => {
    const dir = folder();
    const data = path.join(dir, 'counter.json');
    fs.writeFileSync(data, '{"n":0}');
    const url = (rel: string): string => JSON.stringify(new URL(`file:///${path.resolve(__dirname, '../..', rel).replace(/\\/g, '/')}`).href);
    const worker = path.join(dir, 'worker.mts');
    fs.writeFileSync(worker, [
      `const lock = await import(${url('src/utils/file-lock.ts')});`,
      `const fsu = await import(${url('src/utils/fs.ts')});`,
      'const { withFileLock } = lock.default ?? lock;',
      'const { readJsonForUpdate, replaceFile } = fsu.default ?? fsu;',
      'const [file, count] = process.argv.slice(2);',
      'for (let i = 0; i < Number(count); i++) {',
      '  withFileLock(file, () => {',
      '    const cur = readJsonForUpdate(file, { n: 0 });',
      '    replaceFile(file, JSON.stringify({ n: cur.n + 1 }));',
      '  });',
      '}',
    ].join('\n'));
    const tsx = path.resolve(__dirname, '../..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const N = 4;
    const PER = 25;
    const runs = await Promise.all(Array.from({ length: N }, () => new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [tsx, worker, data, String(PER)], { cwd: path.resolve(__dirname, '../..') });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    })));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    expect(JSON.parse(fs.readFileSync(data, 'utf8'))).toEqual({ n: N * PER });
    // Every generation ended, exactly one lock file left as the highest, no temporary file.
    const left = names(dir);
    expect(left.filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect(inspectFileLock(data)).toBeNull();
  }, 120_000);
});
