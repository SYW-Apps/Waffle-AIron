import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProjectRecord,
  resolveProjectBinding,
  assertMintableNarrowingEntry,
} from '../../src/server/projects.js';
import { moveMountToMembers } from '../../src/core/provision.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { seedSubsystem, seedChainedMount } from './helpers.js';
import type { Principal } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage 3: a hosted token qualifier keeps its text, and each hop is read as a
// member alias — looked up in project.yaml `members` or, for one release, a
// legacy L1 mount. A qualifier minted against the mount form therefore binds
// the SAME root after the project moves its mounts into `members`, and nothing
// widens: an internal subsystem is still no root, and a qualified principal
// still binds neither its top project nor a sibling.
// ---------------------------------------------------------------------------

const principalWith = (projects: string[]): Principal => ({ tokenId: 'tok-x', role: 'editor', projects, authenticated: true });

/** A project root as wairon reads one: a configuration and an L0. */
function initialize(root: string, id: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ntargets: []\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n`);
  fs.writeFileSync(path.join(root, '.wai', 'specs', '.index.yaml'), `schemaVersion: 1.0.0\nname: ${id}\nvision: v\nboundaries: []\nglobalRequirements: []\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n`);
}

describe('hosted member qualifiers: the same root before and after the mounts move, nothing widened', () => {
  let dataDir: string;
  let demoRoot: string;
  let billingDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-member-bind-'));
    demoRoot = createProjectRecord(dataDir, 'demo').rootPath;
    initialize(demoRoot, 'demo');
    // demo ── billing (legacy mount) ── payments (legacy mount inside billing)
    //     ├── other   (legacy mount, a sibling)
    //     └── plain   (an internal subsystem — never a root)
    billingDir = seedChainedMount(demoRoot, 'billing', 'packages/billing');
    initialize(billingDir, 'billing');
    const paymentsDir = seedChainedMount(billingDir, 'payments', 'sub/payments');
    initialize(paymentsDir, 'payments');
    const otherDir = seedChainedMount(demoRoot, 'other', 'packages/other');
    initialize(otherDir, 'other');
    seedSubsystem(demoRoot, 'plain');
    invalidateSpecCache();
  });

  afterEach(() => {
    invalidateSpecCache();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  /** Every binding the fixture's tokens and selectors produce. */
  function bindings(): Record<string, unknown> {
    return {
      narrowedToBilling: resolveProjectBinding(dataDir, principalWith(['demo::billing'])),
      narrowedToPayments: resolveProjectBinding(dataDir, principalWith(['demo::billing::payments'])),
      selectorFromTop: resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::billing::payments'),
      wildcardSelector: resolveProjectBinding(dataDir, principalWith(['*']), 'demo::other'),
      // What must stay refused.
      internalSubsystem: resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::plain'),
      widenToTop: resolveProjectBinding(dataDir, principalWith(['demo::billing']), 'demo'),
      widenToSibling: resolveProjectBinding(dataDir, principalWith(['demo::billing']), 'demo::other'),
      unknownAlias: resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::ghost'),
    };
  }

  it('binds each qualifier to the same root whether the member is a legacy mount or a `members` entry', () => {
    const before = bindings();
    expect(before.narrowedToBilling).toEqual({ rootPath: path.resolve(billingDir), projectId: 'demo', subproject: 'billing' });
    expect(before.internalSubsystem).toBeNull();
    expect(before.widenToTop).toBeNull();
    expect(before.widenToSibling).toBeNull();
    expect(before.unknownAlias).toBeNull();

    // The chaining migration's member move, hop by hop: each legacy mount
    // becomes a `members` entry and its L1 document goes.
    runWithProjectRoot(demoRoot, () => {
      expect(moveMountToMembers('billing')).toBe(true);
      expect(moveMountToMembers('other')).toBe(true);
    });
    runWithProjectRoot(billingDir, () => expect(moveMountToMembers('payments')).toBe(true));
    invalidateSpecCache();
    expect(fs.readFileSync(path.join(demoRoot, '.wai', 'project.yaml'), 'utf8')).toMatch(/members:/);
    expect(fs.existsSync(path.join(demoRoot, '.wai', 'specs', 'subsystems', 'billing.yaml'))).toBe(false);

    expect(bindings()).toEqual(before);
  });

  it('validates the same narrowing entries at mint time in either form, and refuses an internal subsystem', () => {
    const entries = ['demo', 'demo::billing', 'demo::billing::payments', 'demo::other'];
    for (const entry of entries) expect(() => assertMintableNarrowingEntry(dataDir, entry)).not.toThrow();
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::plain')).toThrow(/an internal subsystem is not a member/);

    runWithProjectRoot(demoRoot, () => { moveMountToMembers('billing'); moveMountToMembers('other'); });
    runWithProjectRoot(billingDir, () => moveMountToMembers('payments'));
    invalidateSpecCache();

    for (const entry of entries) expect(() => assertMintableNarrowingEntry(dataDir, entry)).not.toThrow();
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::plain')).toThrow(/an internal subsystem is not a member/);
  });
});
