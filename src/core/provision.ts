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
  invalidateSpecCache,
  assertContainedProjectPath,
  rebaseReference,
} from './specs.js';
import { aiPathsAt } from '../config/loader.js';
import { projectConfigRepository, projectConfigRepositoryAt } from '../config/project-config.js';
import { getProjectRoot, runWithProjectRoot, ensureDir, listFilesRecursive } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { WaironError } from '../utils/errors.js';
import type { ProjectConfig } from '../models/project.js';
import type { SubsystemSpec } from '../models/index.js';

// ---------------------------------------------------------------------------
// Project provisioning (sdd_core, used by sdd_host)
//
// provisionProject bootstraps a fresh isolated project at the currently-bound
// root: a default project.yaml plus an L0 system spec. It operates on the active
// (request-scoped) project root, so the hosting server binds the target root
// first and this Just Works against it.
//
// There is deliberately no bulk status promotion here any more. A lock used to
// ratchet every spec to `status: complete` on disk; approval is recorded in a
// digest per spec in the committed lock record instead (core/approval.ts),
// and settledness is derived from that. collectPromotableSpecs/applySpecStatus
// remain as per-spec primitives — the bulk sweep is what was the bug.
// ---------------------------------------------------------------------------

function defaultProjectConfig(name: string, now: string): ProjectConfig {
  return {
    schemaVersion: '1.0.0',
    name,
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    execution: { tier: 'off', overrides: {} },
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta', 'guardian', 'architect'],
      enforceReproducibility: true,
      // Lean by default: one owner agent per subsystem, not one per component —
      // a large tree/subproject with per-component implementers emits thousands
      // of agents that every session then loads. Opt in with `true` on small trees.
      generateComponentImplementers: false,
      // Files are the opt-in materialized view of the live briefs — off means
      // `generate` reconciles to zero agent files.
      materializeAgentFiles: false,
      sddRuleSeverity: {},
    },
    paths: { specsDir: '.wai/specs' },
    createdAt: now,
    updatedAt: now,
  };
}

/** The bootstrap L0 system spec a fresh project starts from. */
function bootstrapSystemSpec(name: string, now: string): Parameters<typeof saveSystemSpec>[0] {
  return {
    schemaVersion: '1.0.0',
    name,
    vision: `Core vision for ${name}`,
    boundaries: [],
    globalRequirements: [],
    databases: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Bootstrap a fresh isolated project at the bound root: an L0 system spec, then a
 * default project.yaml created through the project config Repository, which refuses
 * a root that already has a configuration.
 */
export function provisionProject(name: string): void {
  // Step 1: compose the default configuration and the bootstrap L0.
  const now = new Date().toISOString();
  const config = defaultProjectConfig(name, now);
  // Step 2: persist the L0 system spec.
  saveSystemSpec(bootstrapSystemSpec(name, now));
  // Step 3: write the default configuration through the Repository.
  projectConfigRepository.create(config);
}

/**
 * NON-DESTRUCTIVELY complete a project's bootstrap at the bound root: write the
 * default project.yaml and/or the L0 system spec ONLY when each is absent. Unlike
 * provisionProject (which always writes both, overwriting an existing system
 * spec), this preserves any spec tree already present — used to fully initialize
 * a chained subproject on creation and to backfill a partially-scaffolded one
 * (specs present but project.yaml missing, the state that makes a subproject
 * un-runnable standalone) without clobbering it. Prefers the existing system
 * spec's name so a backfilled project.yaml stays consistent with its tree.
 * Returns which files it created.
 */
export function ensureProjectInitialized(fallbackName: string): { wroteConfig: boolean; wroteSystem: boolean } {
  const now = new Date().toISOString();
  const paths = aiPathsAt(getProjectRoot());
  const hasSystem = fs.existsSync(paths.specsSystem());
  let name = fallbackName;
  if (hasSystem) {
    const existing = loadSystemSpec();
    if (existing?.name) name = existing.name;
  }
  let wroteConfig = false;
  let wroteSystem = false;
  // Complete only what is missing: an existing configuration is never overwritten.
  if (!projectConfigRepository.exists()) {
    projectConfigRepository.create(defaultProjectConfig(name, now));
    wroteConfig = true;
  }
  if (!hasSystem) {
    saveSystemSpec(bootstrapSystemSpec(name, now));
    wroteSystem = true;
  }
  if (wroteConfig || wroteSystem) invalidateSpecCache();
  return { wroteConfig, wroteSystem };
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
 * Walk a project and every chained subproject it links (recursively), invoking
 * `onChild` for each child dir together with the subsystem id that mounts it.
 * Shared scan behind the detection + backfill helpers below.
 */
function walkChainedSubprojects(
  projectRoot: string,
  onChild: (childDir: string, subsystemId: string) => void,
): void {
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    const resolved = path.resolve(dir);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const specsDir = aiPathsAt(dir).specsDir();
    if (!fs.existsSync(specsDir)) return;
    for (const file of listFilesRecursive(specsDir, '.yaml')) {
      let raw: unknown;
      try {
        raw = readYamlFile(file);
      } catch {
        continue;
      }
      if (!(raw && typeof raw === 'object' && 'parentSystem' in raw)) continue;
      const pp = (raw as { projectPath?: unknown }).projectPath;
      if (typeof pp !== 'string' || pp.trim() === '') continue;
      let childDir: string;
      try {
        childDir = assertContainedProjectPath(dir, pp);
      } catch {
        continue; // absolute / escaping projectPath — never touch it
      }
      const id = (raw as { id?: unknown }).id;
      onChild(childDir, typeof id === 'string' ? id : path.basename(childDir));
      walk(childDir); // recurse into the chain (handles multi-level subprojects)
    }
  };
  walk(projectRoot);
}

/**
 * The DIRECT chained subprojects of a project (one level — the projectPath
 * subsystems declared in THIS project's own spec tree, not those nested deeper
 * inside a child). Each entry is the resolved child dir + the mounting subsystem
 * id. Used by layered `wairon generate` to cascade one level at a time (each
 * child then lists its own direct subprojects), so every layer is generated in
 * its own .wai without the parent enumerating the whole deep tree.
 */
export function listDirectChainedSubprojects(projectRoot: string): { dir: string; subsystemId: string }[] {
  const out: { dir: string; subsystemId: string }[] = [];
  const specsDir = aiPathsAt(projectRoot).specsDir();
  if (!fs.existsSync(specsDir)) return out;
  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    let raw: unknown;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (!(raw && typeof raw === 'object' && 'parentSystem' in raw)) continue;
    const pp = (raw as { projectPath?: unknown }).projectPath;
    if (typeof pp !== 'string' || pp.trim() === '') continue;
    let dir: string;
    try {
      dir = assertContainedProjectPath(projectRoot, pp);
    } catch {
      continue;
    }
    const id = (raw as { id?: unknown }).id;
    out.push({ dir, subsystemId: typeof id === 'string' ? id : path.basename(dir) });
  }
  return out;
}

/** True when a child dir has a spec tree but no project.yaml (un-runnable standalone). */
function childHasSpecsButNoConfig(childDir: string): boolean {
  return fs.existsSync(aiPathsAt(childDir).specsDir()) && !projectConfigRepositoryAt(childDir).exists();
}

/**
 * Detect chained subprojects (recursively) that have specs but no project.yaml —
 * the state that makes a subproject un-runnable standalone (`wairon` reports "No
 * wairon project found"). Pure read; returns the child dirs. Used by the doctor
 * report to point the user at `--fix`.
 */
export function findChainingSubprojectsMissingConfig(projectRoot: string): string[] {
  const missing: string[] = [];
  walkChainedSubprojects(projectRoot, (childDir) => {
    if (childHasSpecsButNoConfig(childDir)) missing.push(childDir);
  });
  return missing;
}

/**
 * Backfill a missing project.yaml on any chained subproject that has a spec tree
 * but no project config. Existing specs are never touched. Returns the child dirs
 * repaired. Used by `wairon doctor --fix`.
 */
export function backfillChainedSubprojectConfigs(projectRoot: string): string[] {
  const backfilled: string[] = [];
  walkChainedSubprojects(projectRoot, (childDir, subsystemId) => {
    if (childHasSpecsButNoConfig(childDir)) {
      runWithProjectRoot(childDir, () => {
        ensureProjectInitialized(subsystemId);
      });
      backfilled.push(childDir);
    }
  });
  return backfilled;
}

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

  // 3. Fully initialize the child project in the SAME action — but
    //    NON-DESTRUCTIVELY: create the specs dir, project.yaml, and L0 system
    //    spec only when each is absent. A fresh child gets a complete, runnable
    //    project (so an agent never has to hand-author project.yaml); an
    //    already-scaffolded or partially-scaffolded child (specs but no
    //    project.yaml) is completed without clobbering its existing spec tree.
  runWithProjectRoot(childDir, () => {
    ensureDir(aiPathsAt(childDir).specsDir());
    ensureProjectInitialized(projectName);
  });

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
// references that change: the parent's cross-subsystem references, whose
// targets gain/lose the `<subsystem>::` namespace prefix, and the moved
// subtree's own references, which now load one mount deeper/shallower.
// ---------------------------------------------------------------------------

/**
 * Externalize an internal subsystem into a standalone subproject: provision a
 * child wairon project at projectPath, move the subsystem's spec subtree there,
 * reduce the parent entry to a projectPath mount, rewrite cross-subsystem
 * references to the new namespaced ids, and rewrite the moved subtree's outgoing
 * references into super:: form. Source code is not moved.
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

  // Provision the child project, then move foo's subtree in. The child's configuration
  // comes first, through the Repository. It refuses a child that already has one,
  // before anything has moved. The child's bootstrap L0 follows.
  const childSystemName = foo.name || subsystemId;
  runWithProjectRoot(childDir, () => {
    const now = new Date().toISOString();
    projectConfigRepository.create(defaultProjectConfig(childSystemName, now));
    ensureDir(path.join(childDir, '.wai', 'specs'));
    saveSystemSpec(bootstrapSystemSpec(childSystemName, now));
  });
  ensureDir(path.dirname(childFooDir));
  fs.renameSync(fooDir, childFooDir);
  // The moved implementations' file paths were read against the parent root; a
  // chained child's are read against its own. Re-express them — the same files,
  // so code left outside the child now reads as escaping it.
  rebaseImplementationPaths(childFooDir, parentRoot, childDir);

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

  // Rewrite cross-subsystem references in the remaining parent specs…
  rewriteRefsInDir(parentSpecsDir, renameMap, fooDir);
  // …and the moved subtree's own, which now load one mount deeper: a reference
  // leaving the subtree climbs out with super::, one inside it stays as written.
  rebaseMovedRefs(childFooDir, subsystemId, 'into');
  invalidateSpecCache();
}

/**
 * Internalize an external subsystem back into the parent tree: move the
 * subproject's spec subtree back under the parent subsystem, drop projectPath,
 * delete the child .wai project, rewrite references back to bare ids, and take
 * the moved subtree's super:: references back to their parent-local form. Only
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
  // …and back: the child's paths were read against its own root.
  rebaseImplementationPaths(fooDir, childDir, parentRoot);

  // Re-home the internalized subsystem under the parent system; drop projectPath.
  patchSubsystemIndex(path.join(fooDir, '.index.yaml'), (s) => {
    s.parentSystem = parentSystemName;
    delete s.projectPath;
  });

  // Delete the child .wai project entirely (project.yaml + specs).
  fs.rmSync(childWai, { recursive: true, force: true });

  // Rewrite references back to bare ids…
  rewriteRefsInDir(parentSpecsDir, renameMap, fooDir);
  // …and the moved subtree's own, one mount shallower: each super:: hop it took
  // out of the subproject is one it no longer needs.
  rebaseMovedRefs(fooDir, subsystemId, 'outOf');
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

/** Where a reference field sits: a component id, or a type a method parameter or type field names. */
type RefPosition = 'component' | 'type';

/** Rewrite cross-subsystem reference fields in every spec under `specsDir`, skipping `excludeDir`. */
function rewriteRefsInDir(specsDir: string, renameMap: Map<string, string>, excludeDir?: string): void {
  if (renameMap.size === 0) return;
  rewriteRefFields(specsDir, (ref) => renameMap.get(ref) ?? ref, excludeDir);
}

/**
 * Re-express the references a moved subtree's specs store for the namespace the
 * subtree now loads in — one mount deeper (`into`) or shallower (`outOf`) — so
 * each names the target it named before; rebaseReference does the id-space
 * arithmetic. Going into the mount, the components the subtree declares travel
 * with it; going out, everything inside the mount does.
 *
 * Only component positions are rebased. A type is matched by name against every
 * loaded type, whichever namespace the naming spec sits in — the loader never
 * qualifies a parameter or field type — so moving the spec cannot change what it
 * resolves to, and a super:: hop written into one would match no type at all.
 */
function rebaseMovedRefs(movedDir: string, mount: string, direction: 'into' | 'outOf'): void {
  const declared = componentIdsUnder(movedDir);
  rewriteRefFields(movedDir, (ref, position) =>
    (position === 'component' ? rebaseReference(ref, mount, direction, (id) => declared.has(id)) : ref));
}

/** The ids of the components declared by the spec files under `dir`. */
function componentIdsUnder(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const file of listFilesRecursive(dir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (raw && typeof raw === 'object' && 'componentType' in raw && typeof raw.id === 'string') ids.add(raw.id);
  }
  return ids;
}

/**
 * Rewrite the reference fields of every spec under `specsDir` through `remap`,
 * skipping `excludeDir`: dependsOn, dispatch and lifecycle components and
 * narrative call targets (component positions), and method parameter and type
 * field types (type positions).
 */
function rewriteRefFields(
  specsDir: string,
  remap: (ref: string, position: RefPosition) => string,
  excludeDir?: string,
): void {
  const at = (ref: unknown, position: RefPosition): unknown =>
    (typeof ref === 'string' ? remap(ref, position) : ref);

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
      const next = raw.dependsOn.map((d: unknown) => at(d, 'component'));
      if (next.some((v: unknown, i: number) => v !== raw.dependsOn[i])) {
        raw.dependsOn = next;
        changed = true;
      }
      // A Portal's dispatch table carries component refs of its own.
      if (Array.isArray(raw.dispatch)) {
        for (const b of raw.dispatch) {
          const nc = at(b.component, 'component');
          if (nc !== b.component) {
            b.component = nc;
            changed = true;
          }
        }
      }
    } else if ('parentSystem' in raw && Array.isArray(raw.lifecycle)) {
      // Subsystem index: lifecycle entrypoints name components (same-subsystem
      // by rule, but rewrite defensively so a legacy/misdeclared tree can't
      // silently dangle across a migration).
      for (const le of raw.lifecycle) {
        const nc = at(le.component, 'component');
        if (nc !== le.component) {
          le.component = nc;
          changed = true;
        }
      }
    } else if ('component' in raw && Array.isArray(raw.methods)) {
      for (const m of raw.methods) {
        if (!Array.isArray(m.params)) continue;
        for (const p of m.params) {
          const nt = at(p.type, 'type');
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
          const nt = at(step.targetComponent, 'component');
          if (nt !== step.targetComponent) {
            step.targetComponent = nt;
            changed = true;
          }
        }
      }
    } else if ('kind' in raw && Array.isArray(raw.fields)) {
      for (const f of raw.fields) {
        const nt = at(f.type, 'type');
        if (nt !== f.type) {
          f.type = nt;
          changed = true;
        }
      }
    }

    if (changed) writeYamlFile(file, raw);
  }
}

/**
 * Re-express every implementation file path (sourcePath, simPath) under
 * `specsDir` so it is read against `toRoot` instead of `fromRoot`. The file a
 * path names never changes — only the root it is relative to.
 */
function rebaseImplementationPaths(specsDir: string, fromRoot: string, toRoot: string): void {
  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || !('contract' in raw)) continue;
    let changed = false;
    for (const key of ['sourcePath', 'simPath']) {
      const p = raw[key];
      if (typeof p !== 'string' || p === '' || path.isAbsolute(p)) continue;
      const next = toPosixPath(path.relative(toRoot, path.resolve(fromRoot, p)));
      if (next !== p) {
        raw[key] = next;
        changed = true;
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
