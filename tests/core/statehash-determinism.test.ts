import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { compareOrdinal } from '../../src/utils/canonical-json.js';
import { computeGateIdentity } from '../../src/core/rules/gate-identity.js';
import { emptyExtensions } from '../../src/core/extensions.js';
import { computeStateId } from '../../src/core/statehash.js';
import { invalidateSpecCache, loadComponentSpecs } from '../../src/core/specs.js';
import type { StateId } from '../../src/core/statehash.js';
import type { SddRule } from '../../src/core/rules/types.js';

// ---------------------------------------------------------------------------
// The identity is a property of the SPECS, not of the machine that holds them.
//
// It was not. `computeStateId` digested the loaders' arrays in whatever order
// the filesystem walked the spec files in, and `canonicalize` sorts object keys
// but never arrays — so the same commit hashed one way on Windows (NTFS returns
// names sorted) and another on Linux (ext4 returns them in hash order). A lock
// taken on a laptop therefore read STALE in CI: the approval gate refused the
// very tree the maintainer had just approved, and nothing in the record was
// wrong. Measured on this repo's tree: content 5d7bef12… on Windows against
// 0697076b… on Linux, reading the identical mounted files.
//
// Three properties keep it closed, and each fails on its own if the ordering is
// removed:
//   1. the digest does not move when the loaders return the specs in another
//      order (the property, tested without needing a second platform);
//   2. the digest does not move when the spec FILES are renamed, which is how
//      a real filesystem reorders them;
//   3. a fixture tree's digest equals a pinned constant — the guard that
//      notices a reordering, or any other shift of the canonical form, in a
//      diff rather than in someone's CI six months later.
// ---------------------------------------------------------------------------

/**
 * The permutation the mocked loaders apply. The property under test is about
 * the ORDER the specs arrive in, and only a mock can vary that order with
 * certainty — a rename varies it on NTFS but merely probably on a hash-ordered
 * filesystem, so the rename test below is the corroboration, not the proof.
 */
const loaderOrder = vi.hoisted(() => ({ permute: <T>(specs: T[]): T[] => specs }));

vi.mock('../../src/core/specs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/specs.js')>();
  const permuted = <T>(load: () => T[]) => (): T[] => loaderOrder.permute(load());
  return {
    ...actual,
    loadSubsystemSpecs: permuted(actual.loadSubsystemSpecs),
    loadComponentSpecs: permuted(actual.loadComponentSpecs),
    loadInterfaceSpecs: permuted(actual.loadInterfaceSpecs),
    loadImplementationSpecs: permuted(actual.loadImplementationSpecs),
    loadTypeSpecs: permuted(actual.loadTypeSpecs),
  };
});

const STAMP = "createdAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n";

/**
 * One spec per kind, with the two ids whose relative order actually flipped
 * between the two platforms in the field ("_" sorts before "s" by codepoint,
 * after it under several collations and under a directory hash).
 *
 * `file` is deliberately NOT the id: the rename test needs a layout whose
 * directory order contradicts the id order, and a fixture that happens to agree
 * with both would prove nothing.
 */
const FIXTURE: { dir: string; file: string; yaml: string }[] = [
  {
    dir: '', file: '.index',
    yaml: `schemaVersion: 1.0.0\nname: FixtureSystem\nvision: a tree small enough to pin\n${STAMP}`,
  },
  {
    dir: 'subsystems', file: 'm_sub_two',
    yaml: `schemaVersion: 1.0.0\nid: sub_two\nname: SubTwo\ndescription: second subsystem\nparentSystem: FixtureSystem\n${STAMP}`,
  },
  {
    dir: 'subsystems', file: 'n_sub_one',
    yaml: `schemaVersion: 1.0.0\nid: sub_one\nname: SubOne\ndescription: first subsystem\nparentSystem: FixtureSystem\n${STAMP}`,
  },
  {
    dir: 'components', file: 'b_share_snapshots',
    yaml: `id: share_snapshots\nname: Share Snapshots\ndescription: the store\nsubsystem: sub_one\ncomponentType: Store\ndurability: durable\n${STAMP}`,
  },
  {
    dir: 'components', file: 'a_share_snapshot_index',
    yaml: `id: share_snapshot_index\nname: Share Snapshot Index\ndescription: the index\nsubsystem: sub_one\ncomponentType: Index\n${STAMP}`,
  },
  {
    dir: 'interfaces', file: 'z_ishare_snapshots',
    yaml: `id: ishare_snapshots\nname: IShare Snapshots\ndescription: the store contract\ncomponent: share_snapshots\nmethods: []\n${STAMP}`,
  },
  {
    dir: 'implementations', file: 'y_share_snapshots_impl',
    // The sourcePath is here on purpose: the loader re-normalizes it against
    // the project root, and that normalization is the one place a platform's
    // path separator could still reach the digest.
    yaml: `id: share_snapshots_impl\nname: Share Snapshots Impl\ndescription: the store realization\ncontract: ishare_snapshots\nsourcePath: src/share/snapshots.ts\nmethods: []\n${STAMP}`,
  },
  {
    dir: 'types', file: 'x_share_snapshot',
    yaml: `kind: value-object\nid: share_snapshot\nname: ShareSnapshot\ndescription: one pinned contract\nfields: []\nmethods: []\n${STAMP}`,
  },
];

/** Write the fixture tree, optionally renaming every file to reverse the directory order. */
function writeFixtureTree(opts: { reverseFileNames?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-identity-'));
  const specsDir = path.join(root, '.wai', 'specs');
  for (const entry of FIXTURE) {
    // "a_x" ↔ "z_x": same content, same id, opposite position in the directory.
    const stem = opts.reverseFileNames && entry.file !== '.index'
      ? entry.file.replace(/^([a-z])_/, (_m, c: string) => `${String.fromCharCode(219 - c.charCodeAt(0))}_`)
      : entry.file;
    const dir = path.join(specsDir, entry.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stem}.yaml`), entry.yaml);
  }
  invalidateSpecCache();
  setProjectRoot(root);
  return root;
}

const roots: string[] = [];
const fixture = (opts: { reverseFileNames?: boolean } = {}): string => {
  const root = writeFixtureTree(opts);
  roots.push(root);
  return root;
};

afterEach(() => {
  loaderOrder.permute = <T>(specs: T[]): T[] => specs;
  invalidateSpecCache();
  setProjectRoot(null);
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
});

describe('content identity — order independence', () => {
  it('does not move when the loaders return the specs in another order', () => {
    fixture();

    const asLoaded = computeStateId().digest;

    loaderOrder.permute = <T>(specs: T[]): T[] => [...specs].reverse();
    const reversed = computeStateId().digest;

    // A rotation, so the test is not satisfied by a comparator that only
    // happens to be symmetric.
    loaderOrder.permute = <T>(specs: T[]): T[] => (specs.length < 2 ? specs : [...specs.slice(1), specs[0]]);
    const rotated = computeStateId().digest;

    expect(reversed).toBe(asLoaded);
    expect(rotated).toBe(asLoaded);
  });

  it('the permutation really does reorder the specs — the control on the test above', () => {
    fixture();
    const asLoaded = loadComponentSpecs().map((c) => c.id);

    loaderOrder.permute = <T>(specs: T[]): T[] => [...specs].reverse();
    expect(loadComponentSpecs().map((c) => c.id)).toEqual([...asLoaded].reverse());
    expect(asLoaded.length).toBeGreaterThan(1);
  });

  it('does not move when the spec files are renamed so the directory order flips', () => {
    fixture();
    const before = computeStateId().digest;

    fixture({ reverseFileNames: true });
    expect(computeStateId().digest).toBe(before);
  });
});

describe('content identity — the fixture pin', () => {
  /**
   * Generated, not guessed: printed from this fixture on win32 AND from the same
   * fixture under node:20 on Linux (docker, ext4), which agreed — the point of
   * the pin.
   *
   * It is expected to hold across platforms and releases. It legitimately moves
   * when the canonical FORM of a spec changes (a new defaulted schema field, a
   * changed normalization) — and when it does, EVERY project's lock is void and
   * every project must re-lock, so the constant is updated deliberately, in the
   * same change that explains itself in the CHANGELOG. A silent update defeats
   * the guard.
   */
  const PINNED_CONTENT_DIGEST = 'de7baf1c24f5111083d46fcc149cb327f5c640fbc9a05450709e523b2df5a832';

  it('a known tree digests to a known constant, on every platform', () => {
    fixture();
    expect(computeStateId().digest).toBe(PINNED_CONTENT_DIGEST);
  });

  it('the fixture is not vacuous — every kind of spec is in it', () => {
    fixture();
    expect(loadComponentSpecs().map((c) => c.id).sort()).toEqual(['share_snapshot_index', 'share_snapshots']);
  });
});

// ---------------------------------------------------------------------------
// The gate identity's own sort
//
// The doctrine half of the gate sorted its rules, packs, patterns and
// assertions with `localeCompare`, which is locale- and ICU-dependent and
// re-weights exactly the characters rule names are made of. Measured here
// (node 26, full ICU, nl-NL): "x-y".localeCompare("x_y") is 1 while the
// codepoints say -1 — so two machines could digest the same rule set into two
// identities, and neither would be wrong.
// ---------------------------------------------------------------------------

const fixtureRule = (name: string, code: string): SddRule => ({
  name,
  description: `fixture rule ${name}`,
  codes: [{ code, defaultSeverity: 'error', summary: 'fixture code' }],
  check: () => { /* never run: only its identity is digested */ },
});

const CONTENT: StateId = { algorithm: 'sha256', digest: 'f'.repeat(64) };

describe('gate identity — ordinal, not locale-aware', () => {
  /**
   * Generated from this exact input. Two rule names that differ only by hyphen
   * versus underscore sort one way by codepoint and the other way under several
   * collations, so this constant is what separates the two comparators: it is
   * the ordinal order's digest, and a localeCompare sort of the same two rules
   * produces a different one.
   */
  const PINNED_GATE_DIGEST = 'cbda97f9a35987d05d439f8a446b9e7259c9eb1160fd1f9608b8a6117d068e4e';

  const rules = [fixtureRule('zz-a', 'ZZ_DASH'), fixtureRule('zz_a', 'ZZ_UNDERSCORE')];

  it('digests a hyphen/underscore rule pair in codepoint order', () => {
    expect(computeGateIdentity(CONTENT, emptyExtensions(), rules, [], {}).digest).toBe(PINNED_GATE_DIGEST);
  });

  it('does not depend on the order the rules were registered in', () => {
    const forward = computeGateIdentity(CONTENT, emptyExtensions(), rules, [], {});
    const backward = computeGateIdentity(CONTENT, emptyExtensions(), [...rules].reverse(), [], {});
    expect(backward.digest).toBe(forward.digest);
  });

  it('does not depend on the order the consumed contract inputs were gathered in', () => {
    const forward = computeGateIdentity(CONTENT, emptyExtensions(), rules, ['b-key', 'a_key'], {});
    const backward = computeGateIdentity(CONTENT, emptyExtensions(), rules, ['a_key', 'b-key'], {});
    expect(backward.digest).toBe(forward.digest);
  });
});

describe('compareOrdinal', () => {
  it('orders by codepoint, including the characters collations re-weight', () => {
    // "-" is U+002D, "_" is U+005F: the hyphen sorts first, everywhere.
    expect(compareOrdinal('x-y', 'x_y')).toBeLessThan(0);
    // The pair that flipped between the two platforms in the field.
    expect(compareOrdinal('share_snapshot_index', 'share_snapshots')).toBeLessThan(0);
    // Uppercase before lowercase; collations case-fold instead.
    expect(compareOrdinal('A', 'a')).toBeLessThan(0);
    expect(compareOrdinal('a', 'a')).toBe(0);
    expect(compareOrdinal('b', 'a')).toBeGreaterThan(0);
  });

  it('sorts a list into codepoint order', () => {
    expect(['x_y', 'x-y', 'A', 'a'].sort(compareOrdinal)).toEqual(['A', 'a', 'x-y', 'x_y']);
  });
});
