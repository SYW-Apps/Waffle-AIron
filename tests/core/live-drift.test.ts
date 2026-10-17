import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject, validateFamily, adviseExternals, type ValidationIssue } from '../../src/core/validation.js';
import { getExternalsStatus, pinExternals, projectOwnSurface } from '../../src/core/surfaces.js';
import { NOT_COMPARED_OFFLINE } from '../../src/core/external-producers.js';
import { externalsRepository } from '../../src/core/externals.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { contentDigest, memberDigest, relationHealth, type SurfaceSnapshot } from '../../src/models/index.js';
import { statusExitCode } from '../../src/commands/externals.js';
import { buildPathExternalPair, type PathExternalPair } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// The pin gates; live drift is visible (linkage-and-drift D7, D8).
//
// A consumer whose producer broke hears it from plain validate and status as
// an ADVISORY finding — what moved, who uses it, the fix — while its owner's
// gate keeps judging the pin, reproducibly. A rename reads as a rename, and
// the rename trace a snapshot carries moves no digest. Real temp directories,
// nothing mocked on the path under test.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  vi.restoreAllMocks();
  process.exitCode = undefined;
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function pair(source: 'object' | 'string' = 'object'): PathExternalPair {
  const p = buildPathExternalPair(source);
  cleanups.push(() => p.cleanup());
  return p;
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** billing pinned against ledger as it stands. */
function pinned(source: 'object' | 'string' = 'object'): PathExternalPair {
  const p = pair(source);
  bind(p.billing);
  const pins = pinExternals();
  expect(pins.map((x) => [x.alias, x.outcome])).toEqual([['ledger', 'pinned']]);
  return p;
}

/** billing's owner gate under its own configuration — what plain `validate` runs. */
function ownGate(p: PathExternalPair) {
  bind(p.billing);
  const config = projectConfigRepositoryAt(p.billing).load();
  return validateProject({ rules: config?.rules, projectType: config?.projectType });
}

const codes = (issues: ValidationIssue[]): string[] => issues.map((i) => i.code);
const line = (i: ValidationIssue): string => `${i.severity} ${i.code} @${i.specId ?? '-'} ${i.message}`;

describe('the advisory live comparison (family_validator.advise)', () => {
  it('says nothing while the live producer matches the pin', () => {
    const p = pinned();
    bind(p.billing);
    expect(adviseExternals()).toEqual([]);
  });

  it('the trial scenario: a renamed used method is EXTERNAL_LIVE_INCOMPATIBLE naming the new name, the users and the fix — the owner gate is untouched', () => {
    const p = pinned();
    const before = ownGate(p).issues.map(line).sort();
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    // The owner's gate judges the pin: nothing moved for it.
    const after = ownGate(p);
    expect(after.issues.map(line).sort()).toEqual(before);
    bind(p.billing);
    const advised = adviseExternals();
    expect(advised.map((i) => [i.code, i.severity, i.advisory])).toEqual([['EXTERNAL_LIVE_INCOMPATIBLE', 'warning', true]]);
    expect(advised[0].message).toContain('renamed to "ledger-portal.record"');
    expect(advised[0].message).toContain('invoice-poster');
    expect(advised[0].message).toContain('`wairon externals pin ledger`');
    expect(advised[0].message).toContain('follow the rename');
    // The status names the rename, and its health is incompatible: `externals status` exits 1.
    bind(p.billing);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([expect.objectContaining({ publicName: 'ledger-portal', member: 'post', state: 'renamed', renamedTo: 'ledger-portal.record' })]);
    expect(status.uses[0].detail).toContain('its signature is unchanged');
    expect(status.stale).toBe(true);
    expect(relationHealth(status)).toBe('incompatible');
    expect(statusExitCode([status])).toBe(1);
  });

  it('a used method whose signature changed is "changed at signature level"', () => {
    const p = pinned();
    p.setLedgerContract({ amountType: 'string' });
    bind(p.billing);
    const advised = adviseExternals();
    expect(codes(advised)).toEqual(['EXTERNAL_LIVE_INCOMPATIBLE']);
    expect(advised[0].message).toMatch(/"ledger-portal\.post" changed at signature level/);
  });

  it('a rename that also changed the signature says so', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record', amountType: 'string', formerly: ['iledger-portal.post'] });
    bind(p.billing);
    const [status] = getExternalsStatus();
    expect(status.uses[0]).toMatchObject({ state: 'renamed', renamedTo: 'ledger-portal.record' });
    expect(status.uses[0].detail).toContain('and its signature changed');
  });

  it('a method gone without a trace is a removal, not a rename', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record' });
    bind(p.billing);
    const [status] = getExternalsStatus();
    expect(status.uses[0]).toMatchObject({ state: 'removed' });
    expect(adviseExternals()[0].message).toMatch(/"ledger-portal\.post" gone from the producer's live export table/);
  });

  it('a producer that moved while nothing used did is EXTERNAL_DRIFTED (notice, advisory)', () => {
    const p = pinned();
    p.setLedgerContract({ balanceReturns: 'string' });
    bind(p.billing);
    const advised = adviseExternals();
    expect(advised.map((i) => [i.code, i.severity, i.advisory])).toEqual([['EXTERNAL_DRIFTED', 'notice', true]]);
    expect(statusExitCode(getExternalsStatus())).toBe(0);
  });

  it('a producer that cannot be read is EXTERNAL_LIVE_UNCOMPARED (notice, advisory) — never a pass', () => {
    const p = pinned();
    fs.renameSync(p.ledger, path.join(p.root, 'ledger-moved'));
    bind(p.billing);
    const advised = adviseExternals();
    expect(advised.map((i) => [i.code, i.severity, i.advisory])).toEqual([['EXTERNAL_LIVE_UNCOMPARED', 'notice', true]]);
    expect(advised[0].message).toContain('`wairon externals status`');
    expect(statusExitCode(getExternalsStatus())).toBe(2);
  });

  it('offline means offline: a git external is not compared, naming the command that compares it', () => {
    const p = pinned();
    p.setBillingConfig(['id: billing', 'name: Billing', 'externals:', '  ledger:', '    source:', '      git: https://example.invalid/ledger.git']);
    bind(p.billing);
    const advised = adviseExternals();
    expect(codes(advised)).toEqual(['EXTERNAL_LIVE_UNCOMPARED']);
    expect(advised[0].message).toContain(NOT_COMPARED_OFFLINE);
  });

  it('an alias the run composed gets no second word', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    bind(p.billing);
    expect(adviseExternals(['ledger'])).toEqual([]);
  });

  it('the project\'s own sddRuleSeverity turns an advisory code off', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    p.setBillingConfig(['id: billing', 'name: Billing', 'rules:', '  sddRuleSeverity:', '    EXTERNAL_LIVE_INCOMPATIBLE: "off"', 'externals:', '  ledger:', '    source:', '      path: ../ledger']);
    bind(p.billing);
    expect(adviseExternals()).toEqual([]);
  });

  it('the family run still gates: --family composes the producer live as EXTERNAL_INCOMPATIBLE (error), naming the rename, and reports it composed', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    bind(p.billing);
    const run = validateFamily({ family: true });
    const incompatible = run.issues.filter((i) => i.code === 'EXTERNAL_INCOMPATIBLE');
    expect(incompatible.map((i) => i.severity)).toEqual(['error']);
    expect(incompatible[0].message).toContain('was renamed to "ledger-portal.record"');
    expect(run.valid).toBe(false);
    expect(run.composed).toEqual(['ledger']);
    // Handing the composed aliases over, the advisory pass is silent on them.
    bind(p.billing);
    expect(adviseExternals(run.composed)).toEqual([]);
  });
});

describe('the rename trace a snapshot carries (formerly) moves no digest', () => {
  /** The snapshot with every `formerly` stripped. */
  function withoutTrace(s: SurfaceSnapshot): SurfaceSnapshot {
    return {
      ...s,
      interfaces: s.interfaces.map(({ formerly: _f, ...e }) => ({ ...e, methods: e.methods.map(({ formerly: _m, ...m }) => m) })),
      types: s.types.map(({ formerly: _t, ...t }) => t),
    };
  }

  it('the projection carries the method trace as formerly, and neither digest reads it', () => {
    const p = pair();
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    bind(p.ledger);
    const snapshot = projectOwnSurface('instance');
    const method = snapshot.interfaces[0].methods.find((m) => m.name === 'record')!;
    expect(method.formerly).toEqual(['post']);
    const bare = withoutTrace(snapshot);
    expect(contentDigest(bare)).toBe(contentDigest(snapshot));
    expect(memberDigest(bare, 'ledger-portal', 'record')).toBe(memberDigest(snapshot, 'ledger-portal', 'record'));
  });

  it('a producer gaining a rename trace moves no digest, and the re-pin refreshes the snapshot it carries', () => {
    const p = pinned();
    bind(p.billing);
    const lockBefore = JSON.stringify(externalsRepository.readLock());
    // The same contract, now carrying a trace of a former name nothing uses.
    p.setLedgerContract({ formerly: ['iledger-portal.enter'] });
    bind(p.billing);
    // The trace is provenance: the lock (digest, used digests) does not move...
    expect(pinExternals().map((x) => [x.alias, x.outcome])).toEqual([['ledger', 'pinned']]);
    expect(JSON.stringify(externalsRepository.readLock())).toBe(lockBefore);
    // ...but the snapshot carries what the producer says now (round-2 R2-30).
    expect(externalsRepository.readSnapshot('ledger')!.interfaces[0].methods.find((m) => m.name === 'post')?.formerly).toEqual(['enter']);
    expect(pinExternals().map((x) => [x.alias, x.outcome])).toEqual([['ledger', 'unchanged']]);
  });

  it('the pin snapshot keeps the trace once the contract itself moves', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    bind(p.billing);
    pinExternals();
    const snapshot = externalsRepository.readSnapshot('ledger')!;
    expect(snapshot.interfaces[0].methods.find((m) => m.name === 'record')?.formerly).toEqual(['post']);
  });

  it('a source written as a location string resolves the same producer', () => {
    const p = pinned('string');
    bind(p.billing);
    expect(adviseExternals()).toEqual([]);
  });
});
