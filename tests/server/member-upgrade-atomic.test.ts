import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { upgradeMemberRecords } from '../../src/server/local-admin.js';
import * as memberRegistration from '../../src/server/members.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { mintUserToken } from './helpers.js';
import { buildHostedFamily } from './hosted-family.js';

// ---------------------------------------------------------------------------
// Stage 7 wave A — the member upgrade is all or nothing.
//
// The upgrade is planned once, then applied with a failure injected at EVERY
// file-system write position of the apply (the family transaction's stage and
// swap, and the audit appends after it): each time the host stores
// (projects.json, auth/credentials.json) must be exactly as before — or, when
// the failure struck only after the commit point (an audit append), exactly as
// fully applied. No transaction is left behind, and the rehearsal is gone. The
// fs module is wrapped (the operating-system boundary), not replaced: the hook
// throws an injected error before the k-th wrapped operation and passes every
// other call straight through.
// ---------------------------------------------------------------------------

const hook = vi.hoisted(() => ({
  before: null as null | ((op: string) => Error | undefined),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const wrap = <A extends unknown[], R>(op: string, fn: (...args: A) => R) => (...args: A): R => {
    const injected = hook.before?.(op);
    if (injected) throw injected;
    return fn(...args);
  };
  const mocked = {
    ...actual,
    renameSync: wrap('rename', actual.renameSync),
    writeSync: wrap('write', actual.writeSync as (...args: unknown[]) => number),
    writeFileSync: wrap('writeFile', actual.writeFileSync),
    appendFileSync: wrap('appendFile', actual.appendFileSync),
    unlinkSync: wrap('unlink', actual.unlinkSync),
    mkdirSync: wrap('mkdir', actual.mkdirSync),
    rmdirSync: wrap('rmdir', actual.rmdirSync),
  };
  return { ...mocked, default: mocked };
});

const ioError = (): Error => Object.assign(new Error('injected EIO'), { code: 'EIO' });
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA'] as const;

describe('stage 7 — the member upgrade is atomic-or-nothing', () => {
  let base: string;
  let dataDir: string;
  let savedEnv: (readonly [string, string | undefined])[];

  beforeEach(() => {
    savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-stage7-atomic-'));
    for (const k of ENV_KEYS) process.env[k] = path.join(base, 'home');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    hook.before = null;
    vi.restoreAllMocks();
    invalidateSpecCache();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  /** A fresh data dir holding the fixture family and one member-qualified key. */
  function fresh(k: number): string {
    const dir = path.join(base, `data-${k}`);
    fs.mkdirSync(dir, { recursive: true });
    buildHostedFamily(dir);
    mintUserToken(dir, { id: 'k-q', userId: 'u-q', projects: ['platform::billing'] });
    invalidateSpecCache();
    return dir;
  }

  const stores = (dir: string): string[] => ['projects.json', path.join('auth', 'credentials.json')]
    .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  /** What the stores say, without the per-fixture timestamps and token hashes. */
  const shape = (files: string[]): unknown => [
    (JSON.parse(files[0]) as { id: string; parentProjectId?: string; memberPath?: string; status: string }[])
      .map(({ id, parentProjectId, memberPath, status }) => ({ id, parentProjectId, memberPath, status })),
    (JSON.parse(files[1]) as { id: string; projects: string[] }[]).map(({ id, projects }) => ({ id, projects })),
  ];
  const leftover = (dir: string): string[] => {
    const tx = path.join(dir, '.wai', 'transactions');
    return fs.existsSync(tx) ? fs.readdirSync(tx).filter((e) => e !== '.gitignore') : [];
  };

  it('a failure at every write position of the apply leaves the host stores as before, or as fully applied', () => {
    // Count the wrapped operations of one clean apply, and keep its result.
    dataDir = fresh(0);
    const cleanPlan = memberRegistration.plan(dataDir);
    let positions = 0;
    hook.before = () => { positions++; return undefined; };
    expect(memberRegistration.apply(dataDir, cleanPlan).applied).toBe(true);
    hook.before = null;
    const applied = stores(dataDir);
    expect(positions).toBeGreaterThan(10);

    let rolledBack = 0;
    for (let k = 1; k <= positions; k++) {
      const dir = fresh(k);
      const before = stores(dir);
      const planned = memberRegistration.plan(dir);
      expect(planned.refusals).toEqual([]);
      let n = 0;
      hook.before = () => (++n === k ? ioError() : undefined);
      const report = memberRegistration.apply(dir, planned);
      hook.before = null;
      const now = stores(dir);
      if (report.applied) {
        // The failure struck after the commit point (an audit append): the stores are whole.
        expect(shape(now), `position ${k}`).toEqual(shape(applied));
      } else {
        rolledBack++;
        expect({ k, restored: report.outcome?.restored, unrestored: report.outcome?.unrestored })
          .toEqual({ k, restored: true, unrestored: [] });
        expect(now, `position ${k}`).toEqual(before);
      }
      expect(leftover(dir), `position ${k}`).toEqual([]);
      expect(fs.existsSync(planned.rehearsal!.directory), `position ${k}`).toBe(false);
      // Nothing half-applied is left to find: the upgrade, made again, applies whole.
      if (!report.applied) expect(upgradeMemberRecords(dir, true).applied).toBe(true);
    }
    expect(rolledBack).toBeGreaterThan(0);
  }, 300_000);
});
