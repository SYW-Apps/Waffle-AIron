import * as fs from 'fs';
import * as path from 'path';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  loadSubsystemSpec,
  loadSubsystemSpecs,
  loadSystemSpec,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadTypeSpecs,
  collectPromotableSpecs,
  applySpecStatus,
  invalidateSpecCache,
  assertContainedProjectPath,
} from './specs.js';
import { saveProjectConfig, aiPathsAt } from '../config/loader.js';
import { getProjectRoot, runWithProjectRoot, ensureDir, listFilesRecursive } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { WaironError } from '../utils/errors.js';
import type { ProjectConfig } from '../models/project.js';
import type { SubsystemSpec } from '../models/index.js';

// ---------------------------------------------------------------------------
// Project provisioning + bulk status promotion (sdd_core, used by sdd_host)
//
// provisionProject bootstraps a fresh isolated project at the currently-bound
// root: a default project.yaml plus an L0 system spec. promoteAllComplete is the
// lock status write — every promotable spec → complete. Both operate on the
// active (request-scoped) project root, so the hosting server binds the target
// root first and these Just Work against it.
// ---------------------------------------------------------------------------

function defaultProjectConfig(name: string, now: string): ProjectConfig {
  return {
    schemaVersion: '1.0.0',
    name,
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta', 'guardian', 'architect'],
      enforceReproducibility: true,
      generateComponentImplementers: true,
      sddRuleSeverity: {},
    },
    paths: { specsDir: '.wai/specs' },
    createdAt: now,
    updatedAt: now,
  };
}

/** Bootstrap a fresh isolated project (project.yaml + L0 system spec) at the bound root. */
export function provisionProject(name: string): void {
  const now = new Date().toISOString();
  saveProjectConfig(defaultProjectConfig(name, now));
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name,
    vision: `Core vision for ${name}`,
    boundaries: [],
    globalRequirements: [],
    databases: [],
    createdAt: now,
    updatedAt: now,
  });
}

/** Promote every promotable spec in the bound project to status complete. */
export function promoteAllComplete(): void {
  for (const p of collectPromotableSpecs()) {
    applySpecStatus(p.kind, p.id, 'complete');
  }
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Chained (external) subsystem lifecycle
//
// An external subsystem is an L1 whose `projectPath` points at a sibling wairon
// project; the loader recursively federates that child tree under the parent's
// namespace. These helpers keep the two halves — the parent link and the child
// project — in sync, so authoring one never leaves the other dangling.
// ---------------------------------------------------------------------------

/**
 * Create a chained subproject subsystem: persist the parent L1 subsystem spec
 * (with `projectPath`) at the bound root, then scaffold an isolated child wairon
 * project at that path when one does not already exist. Idempotent — re-running
 * against an already-initialized child wires the parent only.
 */
export function createChainedSubsystem(subsystem: SubsystemSpec, projectName: string): void {
  if (!subsystem.projectPath || subsystem.projectPath.trim() === '') {
    throw new WaironError('projectPath is required to create a chained subsystem.');
  }

  // Store projectPath with forward slashes so the spec tree stays portable
  // across platforms (path.resolve accepts them everywhere).
  const projectPath = toPosixPath(subsystem.projectPath);

  // 1. Persist the parent L1 subsystem spec (with projectPath) at the parent root.
  saveSubsystemSpec({ ...subsystem, projectPath });

  // 2. Resolve + contain the child project directory relative to the bound
  //    (parent) root. Fix B2: reject an absolute or ../-escaping projectPath so
  //    a chained subproject can never scaffold, load, or execute code outside
  //    its parent. Throws before any child scaffolding below.
  const childDir = assertContainedProjectPath(getProjectRoot(), projectPath);

  // 3. Scaffold the child project unless it is already initialized (idempotent).
  const alreadyInitialized = fs.existsSync(aiPathsAt(childDir).projectConfig());
  if (!alreadyInitialized) {
    runWithProjectRoot(childDir, () => {
      ensureDir(aiPathsAt(childDir).specsDir());
      provisionProject(projectName);
    });
  }

  invalidateSpecCache();
}

/**
 * Relocate an external subsystem's subproject: move its directory on disk from
 * the current `projectPath` to `newProjectPath` and persist the updated link.
 * Throws if the subsystem has no `projectPath` (i.e. it is not external).
 */
export function moveSubsystemProject(subsystemId: string, newProjectPath: string): void {
  const sub = loadSubsystemSpec(subsystemId);
  if (!sub) {
    throw new WaironError(`Subsystem "${subsystemId}" does not exist.`);
  }
  if (!sub.projectPath || sub.projectPath.trim() === '') {
    throw new WaironError(
      `Subsystem "${subsystemId}" has no projectPath to move (not an external subproject).`,
    );
  }

  const nextPath = toPosixPath(newProjectPath);
  const root = getProjectRoot();
  // Fix B2: contain BOTH the persisted source and the new target within the
  // bound root before any on-disk relocation or spec write; absolute/../-escaping
  // paths are rejected (the source is attacker-influenced via set-project-path).
  const oldDir = assertContainedProjectPath(root, sub.projectPath);
  const newDir = assertContainedProjectPath(root, nextPath);

  if (oldDir !== newDir) {
    if (!fs.existsSync(oldDir)) {
      throw new WaironError(`Subproject directory not found at its current path: ${oldDir}`);
    }
    if (fs.existsSync(newDir)) {
      throw new WaironError(`Target directory already exists: ${newDir}`);
    }
    ensureDir(path.dirname(newDir));
    fs.renameSync(oldDir, newDir);
  }

  saveSubsystemSpec({ ...sub, projectPath: nextPath, updatedAt: new Date().toISOString() });
  invalidateSpecCache();
}

/** Normalize a filesystem path to forward-slash form for portable storage. */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/** True when `file` is the same as, or nested under, directory `dir`. */
function isWithinDir(dir: string, file: string): boolean {
  const d = path.resolve(dir);
  const f = path.resolve(file);
  return f === d || f.startsWith(d + path.sep);
}

// ---------------------------------------------------------------------------
// Subsystem migration: externalize (internal -> subproject) and internalize
// (subproject -> internal). Only the .wai specs move; the source code is the
// user's responsibility. Both directions keep the tree valid by rewriting the
// cross-subsystem references that change when component ids gain/lose the
// `<subsystem>::` namespace prefix.
// ---------------------------------------------------------------------------

/**
 * Externalize an internal subsystem into a standalone subproject: provision a
 * child wairon project at projectPath, move the subsystem's spec subtree there,
 * reduce the parent entry to a projectPath mount, and rewrite cross-subsystem
 * references to the new namespaced ids. Source code is not moved.
 */
export function externalizeSubsystem(subsystemId: string, projectPath: string): void {
  if (subsystemId.includes('::')) {
    throw new WaironError('cannot externalize a nested/namespaced subsystem; run from its owning project.');
  }
  const foo = loadSubsystemSpec(subsystemId);
  if (!foo || foo.projectPath) {
    throw new WaironError(`cannot externalize: subsystem "${subsystemId}" is missing or already external.`);
  }

  const parentRoot = getProjectRoot();
  const parentSpecsDir = aiPathsAt(parentRoot).specsDir();
  const fooDir = path.join(parentSpecsDir, subsystemId);
  if (!fs.existsSync(fooDir)) {
    throw new WaironError(`subsystem specs directory not found: ${fooDir}`);
  }

  const relPath = toPosixPath(projectPath);
  // Fix B2: contain the child project within the parent root before provisioning
  // or moving any specs; absolute/../-escaping projectPaths are rejected.
  const childDir = assertContainedProjectPath(parentRoot, relPath);
  const childFooDir = path.join(childDir, '.wai', 'specs', subsystemId);
  if (fs.existsSync(childFooDir)) {
    throw new WaironError(`target already contains a "${subsystemId}" subsystem: ${childFooDir}`);
  }

  // Build the rename map (bare id -> namespaced) from foo's public surface BEFORE moving.
  const renameMap = buildRenameMap(subsystemId, /* externalize */ true);

  // Provision the child project (project.yaml + L0), then move foo's subtree in.
  const childSystemName = foo.name || subsystemId;
  runWithProjectRoot(childDir, () => {
    ensureDir(path.join(childDir, '.wai', 'specs'));
    provisionProject(childSystemName);
  });
  ensureDir(path.dirname(childFooDir));
  fs.renameSync(fooDir, childFooDir);

  // Re-home the moved subsystem under the child system; it must not carry projectPath.
  patchSubsystemIndex(path.join(childFooDir, '.index.yaml'), (s) => {
    s.parentSystem = childSystemName;
    delete s.projectPath;
  });

  // Write the minimal parent mount (id + projectPath, empty public surface).
  ensureDir(fooDir);
  writeYamlFile(path.join(fooDir, '.index.yaml'), {
    id: subsystemId,
    name: foo.name,
    description: foo.description,
    parentSystem: foo.parentSystem,
    publicInterfaces: [],
    projectPath: relPath,
    trustedLinks: [],
    status: foo.status ?? 'draft',
    createdAt: foo.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Rewrite cross-subsystem references in the remaining parent specs.
  rewriteRefsInDir(parentSpecsDir, renameMap, fooDir);
  invalidateSpecCache();
}

/**
 * Internalize an external subsystem back into the parent tree: move the
 * subproject's spec subtree back under the parent subsystem, drop projectPath,
 * delete the child .wai project, and rewrite references back to bare ids. Only
 * a flat subproject (whose sole subsystem is the mount id) can be internalized.
 */
export function internalizeSubsystem(subsystemId: string): void {
  if (subsystemId.includes('::')) {
    throw new WaironError('cannot internalize a nested/namespaced subsystem; run from its owning project.');
  }
  const foo = loadSubsystemSpec(subsystemId);
  if (!foo || !foo.projectPath) {
    throw new WaironError(`cannot internalize: subsystem "${subsystemId}" is missing or not external.`);
  }

  const parentRoot = getProjectRoot();
  const parentSpecsDir = aiPathsAt(parentRoot).specsDir();
  // Fix B2: the PERSISTED projectPath is attacker-influenced (a prior
  // set-project-path). Contain it before resolving — otherwise the fs.rmSync of
  // childWai below could delete a directory outside the bound project root.
  const childDir = assertContainedProjectPath(parentRoot, foo.projectPath);
  const childWai = path.join(childDir, '.wai');
  const childFooDir = path.join(childDir, '.wai', 'specs', subsystemId);
  if (!fs.existsSync(childFooDir)) {
    throw new WaironError(`external subproject missing subsystem "${subsystemId}": ${childFooDir}`);
  }

  // Guard: the subproject must be a single flat subsystem matching the mount id.
  const childOwnSubs = runWithProjectRoot(childDir, () => loadSubsystemSpecs()).filter((s) => !s.id.includes('::'));
  if (childOwnSubs.length !== 1 || childOwnSubs[0].id !== subsystemId) {
    throw new WaironError(`cannot internalize: subproject is a multi-subsystem system, not a flat "${subsystemId}".`);
  }

  // Reverse rename map (namespaced -> bare), from the federated parent view, BEFORE moving.
  const renameMap = buildRenameMap(subsystemId, /* externalize */ false);
  const parentSystemName = loadSystemSpec()?.name ?? foo.parentSystem;

  // Replace the parent mount stub with the child's subtree.
  const fooDir = path.join(parentSpecsDir, subsystemId);
  fs.rmSync(fooDir, { recursive: true, force: true });
  ensureDir(path.dirname(fooDir));
  fs.renameSync(childFooDir, fooDir);

  // Re-home the internalized subsystem under the parent system; drop projectPath.
  patchSubsystemIndex(path.join(fooDir, '.index.yaml'), (s) => {
    s.parentSystem = parentSystemName;
    delete s.projectPath;
  });

  // Delete the child .wai project entirely (project.yaml + specs).
  fs.rmSync(childWai, { recursive: true, force: true });

  // Rewrite references back to bare ids.
  rewriteRefsInDir(parentSpecsDir, renameMap, fooDir);
  invalidateSpecCache();
}

/**
 * Map foo's public ids to/from their namespaced form. externalize=true yields
 * bare -> `foo::bare`; externalize=false yields `foo::x` -> `x`. Built from the
 * federated view, so it reflects foo's components, interfaces, and types.
 */
function buildRenameMap(subsystemId: string, externalize: boolean): Map<string, string> {
  const map = new Map<string, string>();
  const prefix = `${subsystemId}::`;
  const add = (bare: string, namespaced: string) =>
    externalize ? map.set(bare, namespaced) : map.set(namespaced, bare);

  const comps = loadComponentSpecs().filter((c) => c.subsystem === subsystemId);
  const compIds = new Set(comps.map((c) => c.id));
  for (const c of comps) {
    const bare = c.id.startsWith(prefix) ? c.id.slice(prefix.length) : c.id;
    add(bare, `${prefix}${bare}`);
  }
  for (const i of loadInterfaceSpecs()) {
    if (!compIds.has(i.component)) continue;
    const bare = i.id.startsWith(prefix) ? i.id.slice(prefix.length) : i.id;
    add(bare, `${prefix}${bare}`);
  }
  for (const t of loadTypeSpecs()) {
    if (t.subsystem !== subsystemId) continue;
    const bare = t.id.startsWith(prefix) ? t.id.slice(prefix.length) : t.id;
    add(bare, `${prefix}${bare}`);
  }
  return map;
}

/** Rewrite cross-subsystem reference fields in every spec under `specsDir`, skipping `excludeDir`. */
function rewriteRefsInDir(specsDir: string, renameMap: Map<string, string>, excludeDir?: string): void {
  if (renameMap.size === 0) return;
  const remap = (id: string | undefined): string | undefined =>
    id !== undefined && renameMap.has(id) ? renameMap.get(id)! : id;

  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    if (excludeDir && isWithinDir(excludeDir, file)) continue;
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    let changed = false;

    if ('componentType' in raw && Array.isArray(raw.dependsOn)) {
      const next = raw.dependsOn.map((d: string) => remap(d));
      if (next.some((v: string, i: number) => v !== raw.dependsOn[i])) {
        raw.dependsOn = next;
        changed = true;
      }
    } else if ('component' in raw && Array.isArray(raw.methods)) {
      for (const m of raw.methods) {
        if (!Array.isArray(m.params)) continue;
        for (const p of m.params) {
          const nt = remap(p.type);
          if (nt !== p.type) {
            p.type = nt;
            changed = true;
          }
        }
      }
    } else if ('contract' in raw && Array.isArray(raw.methods)) {
      for (const m of raw.methods) {
        if (!Array.isArray(m.narrative)) continue;
        for (const step of m.narrative) {
          const nt = remap(step.targetComponent);
          if (nt !== step.targetComponent) {
            step.targetComponent = nt;
            changed = true;
          }
        }
      }
    } else if ('kind' in raw && Array.isArray(raw.fields)) {
      for (const f of raw.fields) {
        const nt = remap(f.type);
        if (nt !== f.type) {
          f.type = nt;
          changed = true;
        }
      }
    }

    if (changed) writeYamlFile(file, raw);
  }
}

/** Load, mutate, and re-persist a subsystem `.index.yaml` in place. */
function patchSubsystemIndex(indexPath: string, mutate: (spec: any) => void): void {
  if (!fs.existsSync(indexPath)) return;
  const raw = readYamlFile(indexPath) as any;
  mutate(raw);
  raw.updatedAt = new Date().toISOString();
  writeYamlFile(indexPath, raw);
}
