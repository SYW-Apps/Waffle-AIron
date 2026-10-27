import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createProjectRecord,
  resolveProjectBinding,
  assertMintableNarrowingEntry,
} from '../../src/server/projects.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { seedSubsystem, seedChainedMember } from './helpers.js';
import { upgradeMembers as upgradeMemberRecords } from '../../src/server/members.js';
import type { Principal } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage 7: each member is a hosted record of its own, bound by its own id. A
// member-qualified entry or selector ('projectId::alias') names no record and
// binds nothing, so a principal can never be widened through one: an internal
// subsystem is still no root, and a member-narrowed principal still binds
// neither its family root nor a sibling.
// ---------------------------------------------------------------------------

const principalWith = (projects: string[]): Principal => ({ tokenId: 'tok-x', role: 'editor', projects, authenticated: true });

/** A project root as wairon reads one: a configuration and an L0. */
function initialize(root: string, id: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ntargets: []\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n`);
  fs.writeFileSync(path.join(root, '.wai', 'specs', '.index.yaml'), `schemaVersion: 1.0.0\nname: ${id}\nvision: v\nboundaries: []\nglobalRequirements: []\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n`);
}

describe('hosted members: bound by record id, a qualifier binds nothing, nothing widened', () => {
  let dataDir: string;
  let demoRoot: string;
  let billingDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-member-bind-'));
    demoRoot = createProjectRecord(dataDir, 'demo').rootPath;
    initialize(demoRoot, 'demo');
    // demo -- billing (member) -- payments (member inside billing)
    //     |-- other   (member, a sibling)
    //     `-- plain   (an internal subsystem - never a root)
    billingDir = seedChainedMember(demoRoot, 'billing', 'packages/billing');
    initialize(billingDir, 'billing');
    const paymentsDir = seedChainedMember(billingDir, 'payments', 'sub/payments');
    initialize(paymentsDir, 'payments');
    const otherDir = seedChainedMember(demoRoot, 'other', 'packages/other');
    initialize(otherDir, 'other');
    seedSubsystem(demoRoot, 'plain');
    invalidateSpecCache();
    // Stage 7: billing, payments and other become hosted records.
    expect(upgradeMemberRecords({ dataDir }, true).applied).toBe(true);
  });

  afterEach(() => {
    invalidateSpecCache();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  it('binds each member by its record id and covers the members below it, never its parent or a sibling', () => {
    expect(resolveProjectBinding(dataDir, principalWith(['billing']))).toEqual({ rootPath: path.resolve(billingDir), projectId: 'billing', familyRootId: 'demo' });
    expect(resolveProjectBinding(dataDir, principalWith(['payments']))).toMatchObject({ projectId: 'payments', familyRootId: 'demo' });
    expect(resolveProjectBinding(dataDir, principalWith(['demo']), 'payments')).toMatchObject({ projectId: 'payments' });
    expect(resolveProjectBinding(dataDir, principalWith(['*']), 'other')).toMatchObject({ projectId: 'other', familyRootId: 'demo' });
    expect(resolveProjectBinding(dataDir, principalWith(['billing']), 'payments')).toMatchObject({ projectId: 'payments' });
    expect(resolveProjectBinding(dataDir, principalWith(['billing']), 'demo')).toBeNull();
    expect(resolveProjectBinding(dataDir, principalWith(['billing']), 'other')).toBeNull();
    expect(resolveProjectBinding(dataDir, principalWith(['demo']), 'plain')).toBeNull();
  });

  it('a member-qualified selector or entry resolves to nothing, whichever it names', () => {
    for (const qualified of ['demo::billing', 'demo::billing::payments', 'demo::other', 'demo::plain', 'demo::ghost']) {
      expect(resolveProjectBinding(dataDir, principalWith(['demo']), qualified)).toBeNull();
      expect(resolveProjectBinding(dataDir, principalWith(['*']), qualified)).toBeNull();
      expect(resolveProjectBinding(dataDir, principalWith([qualified]))).toBeNull();
      expect(resolveProjectBinding(dataDir, principalWith([qualified]), 'billing')).toBeNull();
    }
  });

  it('validates narrowing entries at mint time: a project or member record id passes, a qualified entry is refused naming the record id form', () => {
    expect(['demo', 'billing', 'payments', 'other', '*'].map((e) => assertMintableNarrowingEntry(dataDir, e))).toEqual(['demo', 'billing', 'payments', 'other', '*']);
    for (const qualified of ['demo::billing', 'demo::billing::payments', 'demo::plain']) {
      expect(() => assertMintableNarrowingEntry(dataDir, qualified)).toThrow(/name it by its project record id/);
    }
    // The refusal names the member records of the project it names, and how to confine to a subsystem instead.
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::plain')).toThrow(/the member records of "demo": "billing", "other"\)\. A key narrows to whole projects, never to a subsystem/);
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::plain')).toThrow(/wairon host permission set --user <id> --capability project:write --project <id> --subsystem <id>/);
    expect(() => assertMintableNarrowingEntry(dataDir, 'ghost::x')).not.toThrow(/member records/);
    expect(() => assertMintableNarrowingEntry(dataDir, 'ghost')).toThrow(/unknown project "ghost"/);
    expect(() => assertMintableNarrowingEntry(dataDir, 'Not A Project')).toThrow(/invalid project narrowing entry/);
  });
});
