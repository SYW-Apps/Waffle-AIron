import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Round 10 (platform, profiled by the conformance agent): the release
// re-verdict re-ran the whole owner's gate on every command for as long as an
// approval carried an older release stamp. It is kept across commands now, in
// wairon's user cache, keyed by the root, the record and the current identity.
// The proof that a second command does not re-validate: the cache's verdict is
// replaced by a sentinel, a fresh module (a fresh process's empty memory)
// answers the sentinel — and any change of the key misses it.
// ---------------------------------------------------------------------------

const now = '2026-10-09T10:00:00.000Z';
let base = '';
const saved = process.env.WAIRON_CACHE_DIR;

afterEach(() => {
  if (saved === undefined) delete process.env.WAIRON_CACHE_DIR;
  else process.env.WAIRON_CACHE_DIR = saved;
  try { if (base) fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows locks */ }
  base = '';
  vi.resetModules();
});

async function fixture(): Promise<{ root: string; cache: string }> {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10-verdict-'));
  const cache = path.join(base, 'cache');
  process.env.WAIRON_CACHE_DIR = cache;
  const root = path.join(base, 'p');
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id: 'p', name: 'p', targets: [], rules: {}, createdAt: now, updatedAt: now,
  }));
  const { setProjectRoot } = await import('../../src/utils/fs.js');
  const specs = await import('../../src/core/specs.js');
  setProjectRoot(root);
  specs.saveSystemSpec({ schemaVersion: '1.0.0', name: 'p', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  specs.saveSpec('subsystem', { id: 'dom', name: 'dom', description: 'd', parentSystem: 'p', publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now } as never);
  specs.invalidateSpecCache();
  return { root, cache };
}

describe('the release verdict is kept across commands (round 10)', () => {
  it('a second command answers the recorded verdict without re-validating; a moved identity misses', async () => {
    const { root, cache } = await fixture();
    const validation = await import('../../src/core/validation.js');
    const lockfile = await import('../../src/core/lockfile.js');
    const fv = await import('../../src/core/family-validation.js');
    const current = validation.computeGateStateId();
    // A record an older release took: only its release part moved.
    const record = {
      format: 3, stateId: { algorithm: current.algorithm, digest: 'e'.repeat(64) },
      gateParts: { ...current.parts!, release: 'older-release-doctrine' },
      lockedAt: now, validatorVersion: '5.1.1-dev.100', status: 'ready',
    } as unknown as Parameters<typeof fv.releaseVerdict>[0];
    lockfile.writeLockRecord(record);
    const first = fv.releaseVerdict(record, current)!;
    expect(first.carried).toBe(true);

    // The cache holds it; a sentinel stands in for it.
    const files = fs.readdirSync(path.join(cache, 'release-verdicts'));
    expect(files).toHaveLength(1);
    const file = path.join(cache, 'release-verdicts', files[0]);
    const held = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ key: held.key, verdict: { from: 'SENTINEL', to: 'x', carried: false, count: 1, findings: ['NOT RE-VALIDATED'] } }));

    // A fresh process: empty memory, the same tree and record.
    vi.resetModules();
    const { setProjectRoot } = await import('../../src/utils/fs.js');
    setProjectRoot(root);
    const fresh = await import('../../src/core/family-validation.js');
    const again = fresh.releaseVerdict(record, current)!;
    expect(again.from).toBe('SENTINEL');

    // A moved identity (the design changed) is another key: re-validated, never the sentinel.
    vi.resetModules();
    const { setProjectRoot: bindAgain } = await import('../../src/utils/fs.js');
    bindAgain(root);
    const moved = await import('../../src/core/family-validation.js');
    const other = moved.releaseVerdict(record, { ...current, digest: 'f'.repeat(64) });
    expect(other?.from).not.toBe('SENTINEL');
  });
});
