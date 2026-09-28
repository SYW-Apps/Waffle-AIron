import { describe, it, expect, afterEach, vi } from 'vitest';
import * as path from 'path';

// ---------------------------------------------------------------------------
// no-discovery-standalone (stage 4): the owner's gate reads nothing above the
// project it judges. Every filesystem read the process makes is recorded — the
// reads still happen for real, only their paths are noted — and a member
// validated inside its family on disk must never have touched a path of its
// parent or its siblings.
// ---------------------------------------------------------------------------

const { touched } = vi.hoisted(() => ({ touched: [] as string[] }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const record = <F extends (...args: any[]) => any>(fn: F): F => ((...args: any[]) => {
    if (typeof args[0] === 'string') touched.push(args[0]);
    return fn(...args);
  }) as F;
  const wrapped = {
    ...actual,
    readFileSync: record(actual.readFileSync),
    existsSync: record(actual.existsSync),
    readdirSync: record(actual.readdirSync),
    statSync: record(actual.statSync),
    lstatSync: record(actual.lstatSync),
    realpathSync: Object.assign(record(actual.realpathSync), { native: record(actual.realpathSync.native) }),
  };
  return { ...wrapped, default: wrapped };
});

import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject } from '../../src/core/validation.js';
import { buildReferenceFamily } from '../helpers/reference-family.js';

describe('no-discovery-standalone', () => {
  let cleanup: (() => void) | undefined;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    cleanup?.();
  });

  it('validating a member reads nothing of its parent or its siblings, though the family is on disk', () => {
    const family = buildReferenceFamily();
    cleanup = family.cleanup;
    const under = (dir: string) => (p: string): boolean => {
      const rel = path.relative(dir, path.resolve(p));
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    };
    for (const member of [family.transpiler, family.shared]) {
      setProjectRoot(member);
      invalidateSpecCache();
      touched.length = 0;
      const result = validateProject();
      expect(result.issues.length).toBeGreaterThan(0);
      // Every path inside the family's directory that was read lies inside the member.
      const inFamily = touched.filter(under(family.top));
      expect(inFamily.length).toBeGreaterThan(0);
      expect(inFamily.filter((p) => !under(member)(p))).toEqual([]);
    }
    // The control: the top contains its members, so its own gate does read them
    // (their export tables) — the recording sees reads across directories.
    setProjectRoot(family.top);
    invalidateSpecCache();
    touched.length = 0;
    validateProject();
    expect(touched.some(under(family.transpiler))).toBe(true);
  });
});
