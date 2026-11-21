import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { familyApprovals, resolvedPacks } from '../../src/core/validation.js';

// ---------------------------------------------------------------------------
// family_validator.inputs — what a project's build inputs owe beside its
// approval: a selected pack that is not recorded in the inputs lock, or whose
// recorded digest differs from what it resolves to now. The approval itself
// is never touched (ProjectApproval.state), only `inputs`.
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-inputs-'));
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

const own = () => familyApprovals(0).find((a) => a.key === '')!;

describe('the build inputs owe beside the approval', () => {
  it('a project that selects no pack owes nothing', () => {
    project([]);
    expect(own().inputs).toEqual([]);
  });

  it('a selected pack with no entry in the inputs lock is a pack debt, never the approval\'s drift', () => {
    project(['.wai/packs/input-pack.yaml']);
    const debts = own().inputs;
    expect(debts).toHaveLength(1);
    expect(debts[0]).toMatchObject({ kind: 'pack', subject: 'input-pack' });
    expect(debts[0].sentence).toContain('wairon pack sync');
    expect(own().state).toBe('never');
  });

  it('a recorded pack owes nothing until its content changes', () => {
    project(['.wai/packs/input-pack.yaml']);
    const recorded = resolvedPacks();
    expect(Object.keys(recorded)).toEqual(['input-pack']);
    fs.writeFileSync(path.join(tempDir, '.wai', 'inputs.lock.yaml'), `externals: {}\npacks:\n  input-pack:\n    resolved: 1.0.0\n    digest: ${recorded['input-pack'].digest}\n`);
    expect(own().inputs).toEqual([]);

    fs.writeFileSync(path.join(tempDir, '.wai', 'packs', 'input-pack.yaml'), PACK.replace('types: [Actor]', 'types: [Actor, Supervisor]'));
    invalidateSpecCache();
    expect(own().inputs).toEqual([expect.objectContaining({ kind: 'pack', subject: 'input-pack', sentence: expect.stringContaining('changed since it was recorded') })]);
  });

  it('a selected pack that cannot load is a pack debt naming it', () => {
    project(['.wai/packs/missing.yaml']);
    expect(own().inputs).toEqual([expect.objectContaining({ kind: 'pack', subject: 'missing', sentence: expect.stringContaining('cannot load') })]);
  });
});
