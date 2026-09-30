import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as migrations from '../../src/migrations/index.js';
import type { MigrationRequest } from '../../src/migrations/types.js';
import { buildContractFamily, type ContractFamily } from '../helpers/reference-family.js';
import { at, dirHash, pinAt, widen } from '../helpers/family-verbs.js';

// ---------------------------------------------------------------------------
// Stage 6 wave B — property atomic-or-nothing for the multi-project verbs.
//
// A project rename writes three projects of the contract family (the renamed
// member, its parent's member entry, the consumer's external, reference and
// pin); a detach writes two and creates a pin. Each is planned once, then
// applied with a failure injected at EVERY file-system write position of the
// commit (stage and swap alike): each time, the family must be byte-identical
// to before — every file, every directory, no transaction left behind — and
// the plan's rehearsal gone. The fs module is wrapped (not replaced): the
// hook throws an injected error before the k-th wrapped operation and passes
// every other call straight through.
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

describe('stage 6 — property: atomic-or-nothing, for the multi-project verbs', () => {
  const made: ContractFamily[] = [];
  const family = (): ContractFamily => {
    const f = buildContractFamily();
    made.push(f);
    widen(f.ledger);
    pinAt(f.billing);
    return f;
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    hook.before = null;
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const f of made.splice(0)) {
      try { f.cleanup(); } catch { /* windows locks */ }
    }
  });

  /** How many wrapped operations a clean apply of the verb performs. */
  function countApplyOperations(request: MigrationRequest): number {
    const f = family();
    const planned = at(f.top, () => migrations.plan(request));
    expect(planned.refusals).toEqual([]);
    let n = 0;
    hook.before = () => { n++; return undefined; };
    const report = at(f.top, () => migrations.apply(planned));
    hook.before = null;
    expect(report.applied).toBe(true);
    return n;
  }

  for (const request of [
    { verb: 'rename', project: 'ledger', newId: 'books-ledger' },
    { verb: 'detach', alias: 'ledger' },
  ] satisfies MigrationRequest[]) {
    it(`${request.verb}: a failure at every write position of the commit leaves the family byte-identical`, () => {
      const positions = countApplyOperations(request);
      expect(positions).toBeGreaterThan(20);
      for (let k = 1; k <= positions; k++) {
        const f = family();
        const before = dirHash(f.top);
        const planned = at(f.top, () => migrations.plan(request));
        let n = 0;
        hook.before = () => (++n === k ? ioError() : undefined);
        const report = at(f.top, () => migrations.apply(planned));
        hook.before = null;
        expect({ k, applied: report.applied, restored: report.outcome?.restored, unrestored: report.outcome?.unrestored })
          .toEqual({ k, applied: false, restored: true, unrestored: [] });
        expect(dirHash(f.top), `position ${k}`).toEqual(before);
        expect(fs.existsSync(planned.rehearsal!.directory), `position ${k}`).toBe(false);
        // Nothing half-applied is left to find: the same plan, made again, applies whole.
        const again = at(f.top, () => migrations.plan(request));
        expect(at(f.top, () => migrations.apply(again)).applied).toBe(true);
        expect(fs.existsSync(path.join(f.top, '.wai', 'transactions'))).toBe(false);
      }
    }, 300_000);
  }
});
