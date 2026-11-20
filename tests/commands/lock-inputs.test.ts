import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { refreshInputs, assertApprovable, checkApproval } from '../../src/commands/lock.js';
import { familyApprovals } from '../../src/core/validation.js';

// ---------------------------------------------------------------------------
// cli_lock_adapter.refreshInputs — the lock refreshes what the build owes
// before it approves: it records the selected packs, pins only the owed
// externals, and never refuses an input (lock-check refuses what stays owed).
// ---------------------------------------------------------------------------

const PACK = `name: input-pack
version: 1.0.0
profiles:
  my-profile:
    family: neutral
    forbiddenStereotypes:
      - types: [Actor]
        reason: not expressible here
`;

let tempDir: string;
afterEach(() => {
  invalidateSpecCache();
  vi.restoreAllMocks();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
});

function project(packs: string[]): void {
  invalidateSpecCache();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-inputs-'));
  const wai = path.join(tempDir, '.wai');
  fs.mkdirSync(path.join(wai, 'specs', 'subsystems'), { recursive: true });
  const stamp = "createdAt: '2026-07-03T10:00:00Z'\nupdatedAt: '2026-07-03T10:00:00Z'";
  fs.writeFileSync(path.join(wai, 'specs', '.index.yaml'), `schemaVersion: 1.0.0\nname: TestSystem\nvision: testing\n${stamp}\n`);
  fs.writeFileSync(path.join(wai, 'specs', 'subsystems', 'sub-a.yaml'), `schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\n${stamp}\n`);
  fs.mkdirSync(path.join(wai, 'packs'), { recursive: true });
  fs.writeFileSync(path.join(wai, 'packs', 'input-pack.yaml'), PACK);
  fs.writeFileSync(path.join(wai, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'test-project', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {},
    extensions: { useGlobalPacks: false, packs },
    createdAt: '2026-07-03T10:00:00Z', updatedAt: '2026-07-03T10:00:00Z',
  }));
  vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
}

const lockFile = () => path.join(tempDir, '.wai', 'inputs.lock.yaml');

describe('cli_lock_adapter.refreshInputs', () => {
  it('a project with no externals and no packs refreshes nothing and writes no inputs lock', () => {
    project([]);
    expect(refreshInputs()).toEqual({ pins: [], packsRecorded: false });
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('records the selected packs once, then leaves the file alone', () => {
    project(['.wai/packs/input-pack.yaml']);
    expect(refreshInputs()).toEqual({ pins: [], packsRecorded: true });
    expect(fs.readFileSync(lockFile(), 'utf8')).toContain('input-pack');
    const written = fs.readFileSync(lockFile(), 'utf8');
    expect(refreshInputs()).toEqual({ pins: [], packsRecorded: false });
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(written);
    // The pack debt is cleared by the refresh.
    expect(familyApprovals(0).find((a) => a.key === '')!.inputs).toEqual([]);
  });
});

describe('cli_lock_adapter.assertApprovable', () => {
  it('does not refuse on inputs: a never-recorded pack never blocks the lock', () => {
    project(['.wai/packs/input-pack.yaml']);
    expect(() => assertApprovable([], true)).not.toThrow();
  });
});

describe('cli_lock_adapter.checkApproval', () => {
  it('refuses a lock record an older wairon major wrote, naming `wairon upgrade`', () => {
    project([]);
    fs.writeFileSync(path.join(tempDir, '.wai', 'lock.json'), JSON.stringify({
      format: 3, stateId: { algorithm: 'sha256+design+gate', digest: 'abc' }, lockedAt: '2026-01-01T00:00:00Z', specs: {}, parts: {},
    }));
    const verdict = checkApproval(false);
    expect(verdict.approved).toBe(false);
    expect(verdict.message).toContain('wairon upgrade');
  });
});

describe('cli_packs_adapter.syncPacks records the packs', () => {
  it('records the resolved packs in the inputs lock even when nothing needed fetching', async () => {
    const { syncPacks } = await import('../../src/commands/packs.js');
    project(['.wai/packs/input-pack.yaml']);
    expect(fs.existsSync(lockFile())).toBe(false);
    await syncPacks();
    expect(fs.readFileSync(lockFile(), 'utf8')).toContain('input-pack');
    expect(familyApprovals(0).find((a) => a.key === '')!.inputs).toEqual([]);
  });
});
