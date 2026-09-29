import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Discovering a chained subproject's parent is itself a read above the bound
// root. Since stage 4 the owner's gate never walks up at all, so validating a
// child reads nothing above its root whatever the request's reach; the
// reach-gated detection itself still probes nothing above the top root.
// ---------------------------------------------------------------------------

const { probed } = vi.hoisted(() => ({ probed: [] as string[] }));

// The spec layer's filesystem probes — every existence check and directory
// listing — recorded, so a test can prove what a request did NOT read.
vi.mock('../../src/utils/fs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/fs.js')>();
  return {
    ...actual,
    pathExists: (target: string): boolean => {
      probed.push(target);
      return actual.pathExists(target);
    },
    listFilesRecursive: (dir: string, ext: string): string[] => {
      probed.push(dir);
      return actual.listFilesRecursive(dir, ext);
    },
  };
});

import { setProjectRoot, runWithProjectBinding } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec,
  invalidateSpecCache, workspaceFor, resolveChainingParent,
} from '../../src/core/specs.js';
import { writeLegacyMount } from '../helpers/legacy-mount.js';
import { validateProject, type ValidationResult } from '../../src/core/validation.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, SubsystemSpec } from '../../src/models/index.js';

const now = new Date().toISOString();

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);

/** A parent mounting child `kid`, whose one reference into the parent does not resolve in its own tree — the walk's trigger. */
function family(): { root: string; kidDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reach-'));
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
  saveComponentSpec(component('parent-orch', 'parent-sub'));
  writeLegacyMount(subsystem('kid', { projectPath: 'packages/kid' }), 'kid');

  const kidDir = path.join(root, 'packages', 'kid');
  const kid = workspaceFor(kidDir);
  kid.saveSystemSpec({
    schemaVersion: '1.0.0', name: 'kid-system', vision: 'v',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  kid.save('subsystem', subsystem('k-core', { parentSystem: 'kid-system' }));
  kid.saveComponentSpec(component('k-orch', 'k-core', { dependsOn: ['super::parent-orch'] }));
  invalidateSpecCache();
  return { root, kidDir };
}

/** Whether any recorded probe touched the given project's own spec tree. */
function probedSpecsOf(projectRoot: string): boolean {
  const specs = path.join(projectRoot, '.wai', 'specs');
  return probed.some((p) => {
    const resolved = path.resolve(p);
    return resolved === specs || resolved.startsWith(specs + path.sep);
  });
}

function validateBound(boundRoot: string, topRoot: string, parentReach: boolean): ValidationResult {
  let result: ValidationResult | undefined;
  invalidateSpecCache();
  probed.length = 0;
  runWithProjectBinding(boundRoot, { topRoot, parentReach }, () => {
    result = validateProject();
  });
  return result!;
}

describe('parent discovery sits behind the reach gate', () => {
  let root: string | undefined;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
    root = undefined;
  });

  it('no-discovery-standalone: even a credential that reaches the top project reads nothing above the child (stage 4)', () => {
    const fam = family();
    root = fam.root;

    const reaching = validateBound(fam.kidDir, fam.root, true);
    const narrowed = validateBound(fam.kidDir, fam.root, false);

    // The owner's gate never walks up: the parent's spec tree is never probed,
    // whatever the reach, and the verdict is the same with or without it.
    expect(probedSpecsOf(fam.root)).toBe(false);
    const verdict = (r: ValidationResult) => r.issues.map((i) => `${i.severity} ${i.code} ${i.specId ?? ''}`).sort();
    expect(verdict(reaching)).toEqual(verdict(narrowed));
    expect(verdict(reaching)).toContain('warning EXTERNAL_CHECK_UNAVAILABLE k-orch');
  });

  it('a credential narrowed to the child never reads the parent spec tree, not even to discover it', () => {
    const fam = family();
    root = fam.root;

    const result = validateBound(fam.kidDir, fam.root, false);

    expect(result.hint).toBeUndefined();
    expect(probedSpecsOf(fam.root)).toBe(false);
  });

  it("a child whose request's top root is the child itself probes nothing above it", () => {
    const fam = family();
    root = fam.root;

    const result = validateBound(fam.kidDir, fam.kidDir, true);

    expect(result.hint).toBeUndefined();
    expect(probedSpecsOf(fam.root)).toBe(false);
  });

  it('a top project probes nothing above its own root when looking for a parent', () => {
    const fam = family();
    root = fam.root;
    probed.length = 0;

    runWithProjectBinding(fam.root, { topRoot: fam.root, parentReach: true }, () => {
      expect(resolveChainingParent()).toBeNull();
    });

    const outside = probed
      .map((p) => path.resolve(p))
      .filter((p) => p !== fam.root && !p.startsWith(fam.root + path.sep));
    expect(outside).toEqual([]);
  });
});
