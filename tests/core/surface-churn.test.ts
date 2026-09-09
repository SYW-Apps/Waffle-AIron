import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { saveSnapshot, generateChildSnapshots } from '../../src/core/surfaces.js';

// ---------------------------------------------------------------------------
// Delivered surfaces must not churn.
//
// A projection stamps a fresh `generatedAt` and the current `stateId` every
// run. Writing those unconditionally rewrote every delivered surface on every
// lock, so a lock scoped to one subsystem still showed (children × subsystems)
// modified files in git and buried the specs the human actually edited.
// ---------------------------------------------------------------------------

const stamp = "createdAt: '2026-09-09T10:00:00Z'\nupdatedAt: '2026-09-09T10:00:00Z'";

function buildTree(subsystemCount: number, childCount: number): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-churn-'));
  const specs = path.join(root, '.wai', 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specs, d), { recursive: true });
  }
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'churn', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: '2026-09-09T10:00:00Z', updatedAt: '2026-09-09T10:00:00Z',
  }));
  fs.writeFileSync(path.join(specs, '.index.yaml'),
    `schemaVersion: 1.0.0\nname: Churn\nvision: churn fixture\n${stamp}\n`);

  for (let i = 0; i < subsystemCount; i++) {
    const id = `sub${i}`;
    // The first `childCount` subsystems are chained subprojects with their own .wai.
    const isChild = i < childCount;
    const projectPath = isChild ? `packages/${id}` : undefined;
    fs.writeFileSync(path.join(specs, 'subsystems', `${id}.yaml`),
      `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: Churn\n` +
      (projectPath ? `projectPath: ${projectPath}\n` : '') + `${stamp}\n`);
    if (projectPath) fs.mkdirSync(path.join(root, projectPath, '.wai'), { recursive: true });
  }
  return root;
}

describe('delivered surface churn', () => {
  let root: string;
  afterEach(() => {
    invalidateSpecCache();
    vi.restoreAllMocks();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  it('writes every delivered surface on the first run, and none on an unchanged re-run', () => {
    root = buildTree(6, 3);
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const first = generateChildSnapshots(root);
    // 3 children × (1 family + 5 siblings) = 18 files on a cold tree.
    expect(first.length).toBe(18);

    // Nothing about the tree changed — a second lock must rewrite nothing.
    const second = generateChildSnapshots(root);
    expect(second).toEqual([]);
  });

  it('leaves the bytes on disk untouched when only provenance would differ', () => {
    root = buildTree(3, 1);
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const [firstPath] = generateChildSnapshots(root);
    const before = fs.readFileSync(firstPath, 'utf8');
    const mtimeBefore = fs.statSync(firstPath).mtimeMs;

    generateChildSnapshots(root);

    expect(fs.readFileSync(firstPath, 'utf8')).toBe(before);
    expect(fs.statSync(firstPath).mtimeMs).toBe(mtimeBefore);
  });

  it('still rewrites once the published contract actually changes', () => {
    root = buildTree(3, 1);
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    generateChildSnapshots(root);
    expect(generateChildSnapshots(root)).toEqual([]);

    // Add a subsystem: every child's sibling set genuinely changed.
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'subsystems', 'late.yaml'),
      `schemaVersion: 1.0.0\nid: late\nname: late\ndescription: d\nparentSystem: Churn\n${stamp}\n`);
    invalidateSpecCache();

    expect(generateChildSnapshots(root).length).toBeGreaterThan(0);
  });

  it('rewrites a snapshot whose on-disk copy is unparseable rather than leaving it broken', () => {
    root = buildTree(2, 1);
    vi.spyOn(process, 'cwd').mockReturnValue(root);

    const [p] = generateChildSnapshots(root);
    fs.writeFileSync(p, 'not: [valid surface\n');

    expect(generateChildSnapshots(root)).toContain(p);
    expect(fs.readFileSync(p, 'utf8')).not.toContain('not: [valid');
  });
});
