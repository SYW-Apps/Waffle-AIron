import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as migrations from '../../src/migrations/index.js';
import type { MigrationRequest } from '../../src/migrations/types.js';
import { at, dirHash, migrate } from '../helpers/family-verbs.js';
import { tempDir, isolateGlobals, writeClinic } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Stage 8 — property atomic-or-nothing for promote and demote. Each verb is
// planned once, then applied with a failure injected at EVERY file-system
// write position of the commit (stage and swap alike): each time the family —
// the clinic and its part — must be byte-identical to before, no transaction
// left behind, and the same plan made again must apply whole. The fs module is
// wrapped (not replaced), exactly as the stage-6 verbs' property wraps it.
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
    unlinkSync: wrap('unlink', actual.unlinkSync),
    mkdirSync: wrap('mkdir', actual.mkdirSync),
    rmdirSync: wrap('rmdir', actual.rmdirSync),
  };
  return { ...mocked, default: mocked };
});

const ioError = (): Error => Object.assign(new Error('injected EIO'), { code: 'EIO' });

describe('stage 8 — property: atomic-or-nothing, for promote and demote', () => {
  const cleanups: (() => void)[] = [];
  beforeEach(() => {
    cleanups.push(isolateGlobals(cleanups));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    hook.before = null;
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const c of cleanups.splice(0).reverse()) {
      try { c(); } catch { /* windows locks */ }
    }
  });

  /** The clinic with its contained part — already promoted when the verb under test is demote. */
  function clinic(verb: string): string {
    const { root } = writeClinic(path.join(tempDir(cleanups, 'wairon-atomic-'), 'clinic'));
    if (verb === 'demote') migrate(root, { verb: 'promote', alias: 'scheduling' });
    return root;
  }

  /** How many wrapped operations a clean apply of the verb performs. */
  function countApplyOperations(request: MigrationRequest): number {
    const root = clinic(request.verb);
    const planned = at(root, () => migrations.plan(request));
    expect(planned.refusals).toEqual([]);
    let n = 0;
    hook.before = () => { n++; return undefined; };
    const report = at(root, () => migrations.apply(planned));
    hook.before = null;
    expect(report.applied).toBe(true);
    return n;
  }

  for (const request of [
    { verb: 'promote', alias: 'scheduling' },
    { verb: 'demote', alias: 'scheduling' },
  ] satisfies MigrationRequest[]) {
    it(`${request.verb}: a failure at every write position of the commit leaves the family byte-identical`, () => {
      const positions = countApplyOperations(request);
      expect(positions).toBeGreaterThan(10);
      for (let k = 1; k <= positions; k++) {
        const root = clinic(request.verb);
        const before = dirHash(root);
        const planned = at(root, () => migrations.plan(request));
        let n = 0;
        hook.before = () => (++n === k ? ioError() : undefined);
        const report = at(root, () => migrations.apply(planned));
        hook.before = null;
        expect({ k, applied: report.applied, restored: report.outcome?.restored, unrestored: report.outcome?.unrestored })
          .toEqual({ k, applied: false, restored: true, unrestored: [] });
        expect(dirHash(root), `position ${k}`).toEqual(before);
        expect(fs.existsSync(planned.rehearsal!.directory), `position ${k}`).toBe(false);
        const again = at(root, () => migrations.plan(request));
        expect(at(root, () => migrations.apply(again)).applied).toBe(true);
        expect(fs.existsSync(path.join(root, '.wai', 'transactions'))).toBe(false);
      }
    }, 300_000);
  }
});
