import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithProjectRoot, setProjectRoot } from '../../src/utils/fs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import {
  saveSystemSpec, saveSpec, invalidateSpecCache, workspaceFor, loadSubsystemSpecs,
} from '../../src/core/specs.js';
import { writeLegacyMount } from '../helpers/legacy-mount.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// A root switch reads the tree as it is NOW.
//
// The spec index serves a cached scan while the tree's file signature is
// unchanged, re-checking it at most once per short TTL. A caller that binds
// ANOTHER project's root — a chained child resolving through its parent, a pin
// projecting the parent's surfaces — must not be served that tree's scan from
// before an edit made outside this process (an editor save, a git pull). The
// callers used to force it with invalidateSpecCache(); the index now owns it:
// the first read after a root switch re-verifies the signature whatever the TTL.
//
// Every edit below goes through fs, never through the store, so no write path
// drops the cache on the test's behalf.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});

const made: string[] = [];

/** A parent with one subsystem, mounting a chained child `kid`. */
function family(): { root: string; kidDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-freshness-'));
  made.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'parent',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'root-system', vision: 'v',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', subsystem('parent-sub'));
  writeLegacyMount(subsystem('kid', { projectPath: 'packages/kid' }), 'kid');
  const kidDir = path.join(root, 'packages', 'kid');
  workspaceFor(kidDir).saveSystemSpec({
    schemaVersion: '1.0.0', name: 'kid-system', vision: 'v',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  return { root, kidDir };
}

/** Rewrite a stored subsystem document behind the store's back. */
function editOnDisk(root: string, id: string, patch: Record<string, unknown>): void {
  const file = workspaceFor(root).getSubsystemPath(id);
  const doc = readYamlFile(file) as Record<string, unknown>;
  writeYamlFile(file, { ...doc, ...patch });
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of made.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win locks */ }
  }
});

describe('the spec index re-verifies a tree on a root switch', () => {
  it('a caller that binds the parent after the child sees an edit made outside the process', () => {
    const { root, kidDir } = family();
    setProjectRoot(kidDir);
    // Warm the parent's cached scan, then return to the child.
    expect(runWithProjectRoot(root, () => loadSubsystemSpecs().find(s => s.id === 'parent-sub')?.description))
      .toBe('subsystem parent-sub');
    workspaceFor(kidDir).loadSubsystemSpecs();

    editOnDisk(root, 'parent-sub', { description: 'edited by an editor, not by wairon' });

    // Well inside the signature TTL: only the root switch can make this read fresh.
    expect(runWithProjectRoot(root, () => loadSubsystemSpecs().find(s => s.id === 'parent-sub')?.description))
      .toBe('edited by an editor, not by wairon');
  });

  it('the parent reads its member as it is now, not as this process last scanned it', () => {
    const { root, kidDir } = family();
    // Warm the parent's scan (it reads its member kid too), then bind the child.
    expect(runWithProjectRoot(root, () => loadSubsystemSpecs().map(s => s.id))).not.toContain('kid::late-sub');
    setProjectRoot(kidDir);
    workspaceFor(kidDir).loadSubsystemSpecs();

    // A subsystem lands in the member (a git pull), behind the store's back.
    const lateFile = path.join(kidDir, '.wai', 'specs', 'late-sub', '.index.yaml');
    fs.mkdirSync(path.dirname(lateFile), { recursive: true });
    writeYamlFile(lateFile, subsystem('late-sub', { parentSystem: 'kid-system' }));

    // Well inside the signature TTL: the root switch makes the parent's read fresh.
    expect(runWithProjectRoot(root, () => loadSubsystemSpecs().map(s => s.id))).toContain('kid::late-sub');
  });
});
