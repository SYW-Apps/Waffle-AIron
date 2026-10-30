import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { buildPathExternalPair, type PathExternalPair } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// A pin over a rename is refused. The 6.1.3 QA gate pinned an external whose
// producer had renamed a used verb BEFORE following the rename in the uses:
// the pin went through with an info line, and once the uses were followed a
// second pin and a second lock were owed. The pin now refuses that alias,
// naming the new name, and keeps the previous pin; after the uses follow it,
// one pin does.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** billing pinned against ledger as it stands. */
function pinned(): PathExternalPair {
  const p = buildPathExternalPair();
  cleanups.push(() => p.cleanup());
  bind(p.billing);
  expect(pinExternals().map((x) => [x.alias, x.outcome])).toEqual([['ledger', 'pinned']]);
  return p;
}

const lockText = (p: PathExternalPair): string => fs.readFileSync(path.join(p.billing, '.wai', 'externals.lock.yaml'), 'utf8');
const narrativeFile = (p: PathExternalPair): string => path.join(p.billing, '.wai', 'specs', 'invoicing', 'invoice-poster', '.implementation.yaml');

describe('a pin over a rename', () => {
  it('is refused while the uses still name the old verb, naming the new one; the previous pin stays', () => {
    const p = pinned();
    const before = lockText(p);
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    bind(p.billing);
    const [pin] = pinExternals();
    expect(pin.outcome).toBe('refused');
    expect(pin.detail).toContain('"ledger-portal.post" (renamed to "ledger-portal.record")');
    expect(pin.detail).toContain('follow it in the uses first');
    expect(pin.detail).toContain('reads as not in the pin until the re-pin records it');
    expect(lockText(p)).toBe(before);
  });

  it('a removed verb is refused the same way, said as removed', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record' });
    bind(p.billing);
    const [pin] = pinExternals();
    expect(pin.outcome).toBe('refused');
    expect(pin.detail).toContain('"ledger-portal.post" (removed)');
  });

  it('once the uses follow the rename, one pin records the new name', () => {
    const p = pinned();
    p.setLedgerContract({ postName: 'record', formerly: ['iledger-portal.post'] });
    const file = narrativeFile(p);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('targetMethod: post', 'targetMethod: record'));
    bind(p.billing);
    const [pin] = pinExternals();
    expect(pin.outcome, pin.detail).toBe('pinned');
    expect(lockText(p)).toContain('record');
  });
});
