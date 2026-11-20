import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { externalsFileAdapter, externalsRepository } from '../../src/core/externals.js';
import { pinExternals, lockedPacks, recordPacks, listPinnedExternals } from '../../src/core/surfaces.js';
import * as surfacePortal from '../../src/core/surface-portal.js';
import { lockedPacks as validatorLockedPacks } from '../../src/core/adapters/validator-surfaces.js';
import { unpinned } from '../../src/core/family-validation.js';
import {
  tempDir, isolateGlobals, bareFrom, approveAt, writeLedger, writeShop,
} from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// sdd_surfaces build inputs: the inputs lock (.wai/inputs.lock.yaml) the file
// adapter / store / repository hold, the pack record the orchestrator and
// portal forward, and pinning from the producer's APPROVED state. Real temp
// directories and a LOCAL bare repository; nothing on the path is mocked.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
beforeEach(() => {
  cleanups.push(isolateGlobals(cleanups));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

const entry = { project: 'ledger', snapshot: '.wai/externals/ledger.yaml', digest: 'sha256:abc', used: {} };
const pack = { declared: '^1.0.0', resolved: '1.2.0', source: 'installed', digest: 'sha256:def' };

describe('externals_file_adapter — .wai/inputs.lock.yaml', () => {
  it('writes aliases and pack names sorted, reads them back, and answers null when absent', () => {
    const dir = tempDir(cleanups, 'wairon-inputs-');
    bind(dir);
    expect(externalsFileAdapter.readLock()).toBeNull();
    externalsFileAdapter.writeLock({ externals: { zeta: { ...entry, project: 'zeta' }, alpha: { ...entry, project: 'alpha' } }, packs: { 'b-pack': pack, 'a-pack': pack } });
    const text = fs.readFileSync(path.join(dir, '.wai', 'inputs.lock.yaml'), 'utf8');
    expect(text.indexOf('alpha:')).toBeLessThan(text.indexOf('zeta:'));
    expect(text.indexOf('a-pack:')).toBeLessThan(text.indexOf('b-pack:'));
    const read = externalsFileAdapter.readLock()!;
    expect(Object.keys(read.externals)).toEqual(['alpha', 'zeta']);
    expect(read.packs['a-pack']).toEqual(pack);
  });

  it('a lock with no external, no parent and no pack deletes the file; a pack alone keeps it', () => {
    const dir = tempDir(cleanups, 'wairon-inputs-');
    bind(dir);
    const file = path.join(dir, '.wai', 'inputs.lock.yaml');
    externalsFileAdapter.writeLock({ externals: {}, packs: { p: pack } });
    expect(fs.existsSync(file)).toBe(true);
    externalsFileAdapter.writeLock({ externals: {}, packs: {} });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('a malformed lock is refused naming the file, never read as empty', () => {
    const dir = tempDir(cleanups, 'wairon-inputs-');
    bind(dir);
    fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'inputs.lock.yaml'), 'externals: [not, a, map]\n');
    expect(() => externalsFileAdapter.readLock()).toThrow(/inputs\.lock\.yaml/);
  });

  it('a leftover v6 externals.lock.yaml is refused, naming `wairon upgrade`, whether or not the new file exists', () => {
    const dir = tempDir(cleanups, 'wairon-inputs-');
    bind(dir);
    fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'externals.lock.yaml'), 'externals: {}\n');
    expect(() => externalsRepository.readLock()).toThrow(/wairon upgrade/);
    externalsFileAdapter.writeLock({ externals: {}, packs: { p: pack } });
    expect(() => externalsRepository.readLock()).toThrow(/wairon upgrade/);
  });
});

describe('lockedPacks / recordPacks — the pack record of the inputs lock', () => {
  it('records the packs, keeps externals and parent, and never churns the file when nothing moved', () => {
    const dir = tempDir(cleanups, 'wairon-inputs-');
    bind(dir);
    expect(lockedPacks()).toEqual({});
    externalsRepository.saveLock({ externals: { ledger: entry }, packs: {} });
    recordPacks({ p: pack });
    expect(lockedPacks()).toEqual({ p: pack });
    expect(externalsRepository.readLock()!.externals.ledger).toMatchObject({ project: 'ledger' });
    const file = path.join(dir, '.wai', 'inputs.lock.yaml');
    const before = fs.statSync(file).mtimeMs;
    recordPacks({ p: pack });
    expect(fs.statSync(file).mtimeMs).toBe(before);
    recordPacks({});
    expect(lockedPacks()).toEqual({});
    expect(externalsRepository.readLock()!.externals.ledger).toBeDefined();
  });

  it('the surface portal and the validator adapter forward the same section', () => {
    const dir = tempDir(cleanups, 'wairon-inputs-');
    bind(dir);
    surfacePortal.recordPacks({ p: pack });
    expect(surfacePortal.lockedPacks()).toEqual({ p: pack });
    expect(validatorLockedPacks()).toEqual({ p: pack });
  });
});

describe('pinExternals — a path producer is read live and never pinned', () => {
  it('answers it unchanged "read live", writes nothing, and removes an entry an earlier pin recorded', () => {
    const base = tempDir(cleanups, 'wairon-inputs-path-');
    writeLedger(path.join(base, 'ledger'));
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { path: '../ledger' } } } });
    bind(shop);
    const pins = pinExternals();
    expect(pins).toMatchObject([{ alias: 'ledger', outcome: 'unchanged' }]);
    expect(pins[0].detail).toMatch(/read live, never pinned/);
    expect(fs.existsSync(path.join(shop, '.wai', 'inputs.lock.yaml'))).toBe(false);
    // An earlier wairon's pin of it goes, snapshot included.
    externalsRepository.saveLock({ externals: { ledger: entry }, packs: {} });
    fs.mkdirSync(path.join(shop, '.wai', 'externals'), { recursive: true });
    fs.writeFileSync(path.join(shop, '.wai', 'externals', 'ledger.yaml'), 'x: 1\n');
    pinExternals();
    expect(externalsRepository.readLock()).toBeNull();
    expect(fs.existsSync(path.join(shop, '.wai', 'externals', 'ledger.yaml'))).toBe(false);
  });

  it('lists hosted and git externals only, and a path external is never owed a pin', () => {
    const base = tempDir(cleanups, 'wairon-inputs-list-');
    writeLedger(path.join(base, 'ledger'));
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { path: '../ledger' } }, remote: { source: { git: 'file:///nowhere.git' } } } });
    bind(shop);
    expect(listPinnedExternals().map((p) => p.alias)).toEqual(['remote']);
    expect(unpinned()).toEqual(['remote']);
  });
});

describe('pinProducer — a pin is taken from the producer\'s approved state', () => {
  it('refuses a git producer with no approved design, naming the commit, and leaves the lock untouched', () => {
    const base = tempDir(cleanups, 'wairon-inputs-git-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    const repo = bareFrom(cleanups, work, 'ledger');
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { git: repo.url } } } });
    bind(shop);
    const [pin] = pinExternals();
    expect(pin.outcome).toBe('unresolved');
    expect(pin.detail).toMatch(/has no approved design: lock it there first/);
    expect(externalsRepository.readLock()).toBeNull();
  });

  it('pins an approved git producer with its commit, then answers unchanged', () => {
    const base = tempDir(cleanups, 'wairon-inputs-git-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    const repo = bareFrom(cleanups, work, 'ledger', { approved: true });
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { git: repo.url } } } });
    bind(shop);
    const [pin] = pinExternals();
    expect(pin).toMatchObject({ alias: 'ledger', outcome: 'pinned' });
    const lock = externalsRepository.readLock()!;
    expect(lock.externals.ledger).toMatchObject({ project: 'ledger', commit: repo.commit });
    expect(fs.existsSync(path.join(shop, '.wai', 'inputs.lock.yaml'))).toBe(true);
    expect(pinExternals()[0].outcome).toBe('unchanged');
  });

  it('refuses a git producer whose tree moved since its approval, naming the specs, and keeps the previous pin', () => {
    const base = tempDir(cleanups, 'wairon-inputs-git-');
    const work = path.join(base, 'ledger-work');
    writeLedger(work);
    approveAt(work);
    // The producer's design moves after its approval; the commit carries both.
    fs.appendFileSync(path.join(work, '.wai', 'specs', 'books', 'ledger-portal', '.interface.yaml'), '\n# moved\n');
    const specFile = path.join(work, '.wai', 'specs', 'books', 'ledger-portal', '.interface.yaml');
    fs.writeFileSync(specFile, fs.readFileSync(specFile, 'utf8').replace('The ledger-portal contract', 'The ledger-portal contract, moved'));
    const repo = bareFrom(cleanups, work, 'ledger');
    const shop = path.join(base, 'shop');
    writeShop(shop, { externals: { ledger: { source: { git: repo.url } } } });
    bind(shop);
    const [pin] = pinExternals();
    expect(pin.outcome).toBe('unresolved');
    expect(pin.detail).toMatch(/has unapproved changes: .*ledger-portal/);
    expect(externalsRepository.readLock()).toBeNull();
  });
});
