import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { pinFamilySurfaces } from '../../src/core/surfaces.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// Pinned surfaces must not churn.
//
// A projection stamps a fresh `generatedAt` and the current `stateId` every
// run. Writing those unconditionally would rewrite every pinned surface on
// every pin, so a child re-pinning after its parent changed one subsystem would
// show its whole surface set as modified in git.
// ---------------------------------------------------------------------------

/** Pin from a chained child of the tree at `root`; the changed paths. */
const pinFrom = (root: string, child: string): string[] =>
  runWithProjectRoot(path.join(root, 'packages', child), () => pinFamilySurfaces() ?? []);

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

describe('pinned surface churn', () => {
  let root: string;
  afterEach(() => {
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  it('pins every family surface on the first run, and none on an unchanged re-run', () => {
    root = buildTree(6, 3);

    // One child pulls 1 family + 5 siblings = 6 surfaces on a cold tree.
    expect(pinFrom(root, 'sub0').length).toBe(6);

    // Nothing about the parent changed — a second pin must rewrite nothing.
    expect(pinFrom(root, 'sub0')).toEqual([]);
  });

  it('leaves the bytes on disk untouched when only provenance would differ', () => {
    root = buildTree(3, 1);

    const [firstPath] = pinFrom(root, 'sub0');
    const before = fs.readFileSync(firstPath, 'utf8');
    const mtimeBefore = fs.statSync(firstPath).mtimeMs;

    pinFrom(root, 'sub0');

    expect(fs.readFileSync(firstPath, 'utf8')).toBe(before);
    expect(fs.statSync(firstPath).mtimeMs).toBe(mtimeBefore);
  });

  it('still rewrites once the published contract actually changes', () => {
    root = buildTree(3, 1);

    pinFrom(root, 'sub0');
    expect(pinFrom(root, 'sub0')).toEqual([]);

    // Add a subsystem: every child's sibling set genuinely changed.
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'subsystems', 'late.yaml'),
      `schemaVersion: 1.0.0\nid: late\nname: late\ndescription: d\nparentSystem: Churn\n${stamp}\n`);
    invalidateSpecCache();

    expect(pinFrom(root, 'sub0').length).toBeGreaterThan(0);
  });

  it('rewrites a snapshot whose on-disk copy is unparseable rather than leaving it broken', () => {
    root = buildTree(2, 1);

    const [p] = pinFrom(root, 'sub0');
    fs.writeFileSync(p, 'not: [valid surface\n');

    expect(pinFrom(root, 'sub0')).toContain(p);
    expect(fs.readFileSync(p, 'utf8')).not.toContain('not: [valid');
  });
});
