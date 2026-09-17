import * as fs from 'fs';
import * as path from 'path';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  loadSubsystemSpec,
  loadSubsystemSpecs,
  loadSystemSpec,
  loadComponentSpec,
  loadComponentSpecs,
  loadInterfaceSpec,
  loadInterfaceSpecs,
  loadImplementationSpec,
  loadImplementationSpecs,
  loadTypeSpecs,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  getComponentPath,
  getInterfacePath,
  getImplementationPath,
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
import { SpecIdSchema, type InterfaceSpec, type SubsystemSpec } from '../models/index.js';

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
 * Bootstrap a fresh isolated project at the bound root: a default project.yaml created
 * through the project config Repository, then an L0 system spec. The Repository refuses
 * a root that already has a configuration; because the configuration comes first, that
 * refusal writes nothing.
 */
export function provisionProject(name: string): void {
  // Step 1: compose the default configuration and the bootstrap L0.
  const now = new Date().toISOString();
  const config = defaultProjectConfig(name, now);
  // Step 2: write the default configuration through the Repository; refused when one exists.
  projectConfigRepository.create(config);
  // Step 3: persist the L0 system spec.
  saveSystemSpec(bootstrapSystemSpec(name, now));
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

/**
 * Where a reference field sits, by what it names. A component: dependsOn, owns
 * and dispatch entries, lifecycle entrypoints, a published interface's
 * component, an interface's component and narrative targets, each qualified by
 * the loader into the namespace its spec loads in. An entity's componentClass:
 * a component matched by name within the entity's own namespace, never
 * qualified. An auth source: the component a narrative step's `auth.from`
 * names as `component:<id>`, matched by its exact id and never qualified. An
 * interface: an implementation's contract or a published interface's. A type:
 * what a method parameter or a type field names. A method: the contract method
 * a dispatch-table binding, a lifecycle entrypoint or a narrative call,
 * register or dispatch step names on a component — so a method reference is
 * only ever read together with the component holding it.
 */
type RefPosition = 'component' | 'entity-class' | 'auth-source' | 'interface' | 'type' | 'method';

/** The `auth.from` prefix that makes a credential source a component reference. */
const COMPONENT_AUTH_SOURCE = 'component:';

/** A spec a reference rewrite changed, by kind and id; the L0 system spec's id is "system". */
interface RewrittenSpec {
  kind: 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type';
  id: string;
}

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
 * An entity's componentClass and a narrative step's component auth source are
 * matched by exact id, never qualified, so they too stay as written. An
 * interface reference — a contract, a published interface — names a contract of
 * a component in the moved subtree, which travels with it.
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
 * What a spec file holds, read from its shape as the loader reads it;
 * undefined for a file holding no spec at all. The order is the loader's: a
 * component and a subsystem are recognized before an interface, whose
 * `component` field a component spec would otherwise answer to.
 */
function specKind(raw: any): RewrittenSpec['kind'] | undefined {
  if ('componentType' in raw) return 'component';
  if ('parentSystem' in raw) return 'subsystem';
  if ('vision' in raw) return 'system';
  if ('component' in raw && Array.isArray(raw.methods)) return 'interface';
  if ('contract' in raw && Array.isArray(raw.methods)) return 'implementation';
  if ('kind' in raw && Array.isArray(raw.fields)) return 'type';
  return undefined;
}

/**
 * Rewrite the reference fields of every spec under `specsDir` through `remap`,
 * skipping `excludeDir`, and return the specs it rewrote. The fields: a
 * component's dependsOn, owns and dispatch components; a subsystem's lifecycle
 * entrypoints and published interfaces; the system's published interfaces; an
 * interface's component and method parameter types; an implementation's
 * contract, narrative targets and narrative `component:` auth sources; an
 * entity's componentClass and field types. A method position is read with the
 * component it hangs off — a dispatch binding's and a lifecycle entrypoint's
 * method, and a narrative step's targetMethod — so a remap can retarget the
 * method of ONE component.
 */
function rewriteRefFields(
  specsDir: string,
  remap: (ref: string, position: RefPosition, owner?: string) => string,
  excludeDir?: string,
): RewrittenSpec[] {
  const rewritten: RewrittenSpec[] = [];
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

    /** Rewrite `holder[key]` in place when it holds a reference. */
    const rewrite = (holder: any, key: string | number, position: RefPosition): void => {
      const ref = holder?.[key];
      if (typeof ref !== 'string') return;
      const next = remap(ref, position);
      if (next !== ref) {
        holder[key] = next;
        changed = true;
      }
    };
    /** Rewrite the method `holder[key]` names on the component `owner` holds. */
    const rewriteMethod = (holder: any, key: string, owner: unknown): void => {
      const name = holder?.[key];
      if (typeof name !== 'string' || typeof owner !== 'string') return;
      const next = remap(name, 'method', owner);
      if (next !== name) {
        holder[key] = next;
        changed = true;
      }
    };
    /** The entries of a list field; none when the field holds no list. */
    const entries = (list: unknown): any[] => (Array.isArray(list) ? list : []);
    /** Rewrite each reference a list field holds. */
    const rewriteEach = (list: unknown, position: RefPosition): void => {
      entries(list).forEach((_, i) => rewrite(list, i, position));
    };
    /** A published interface names the component realizing it and, optionally, its contract. */
    const rewritePublished = (list: unknown): void => {
      for (const published of entries(list)) {
        rewrite(published, 'component', 'component');
        rewrite(published, 'interface', 'interface');
      }
    };

    const kind = specKind(raw);
    if (kind === 'component') {
      rewriteEach(raw.dependsOn, 'component');
      rewriteEach(raw.owns, 'component');
      // A Portal's dispatch table carries component refs of its own, each with
      // the method that component serves the capability with. The method is read
      // against the component as written, before the component itself moves.
      for (const binding of entries(raw.dispatch)) {
        rewriteMethod(binding, 'method', binding?.component);
        rewrite(binding, 'component', 'component');
      }
    } else if (kind === 'subsystem') {
      // Lifecycle entrypoints name components (same-subsystem by rule, but
      // rewrite defensively so a legacy/misdeclared tree can't silently dangle
      // across a migration) and the method the runtime invokes at that phase.
      for (const entrypoint of entries(raw.lifecycle)) {
        rewriteMethod(entrypoint, 'method', entrypoint?.component);
        rewrite(entrypoint, 'component', 'component');
      }
      rewritePublished(raw.publicInterfaces);
    } else if (kind === 'system') {
      rewritePublished(raw.publicInterfaces);
    } else if (kind === 'interface') {
      rewrite(raw, 'component', 'component');
      for (const method of raw.methods) {
        for (const param of entries(method?.params)) rewrite(param, 'type', 'type');
      }
    } else if (kind === 'implementation') {
      rewrite(raw, 'contract', 'interface');
      for (const method of raw.methods) {
        for (const step of entries(method?.narrative)) {
          // A call, register or dispatch step names the method on its target.
          rewriteMethod(step, 'targetMethod', step?.targetComponent);
          rewrite(step, 'targetComponent', 'component');
          // A credential source names its component after the component: prefix.
          const source = step?.auth?.from;
          if (typeof source === 'string' && source.startsWith(COMPONENT_AUTH_SOURCE)) {
            const id = source.slice(COMPONENT_AUTH_SOURCE.length);
            const next = remap(id, 'auth-source');
            if (next !== id) {
              step.auth.from = `${COMPONENT_AUTH_SOURCE}${next}`;
              changed = true;
            }
          }
        }
      }
    } else if (kind === 'type') {
      rewrite(raw, 'componentClass', 'entity-class');
      for (const field of raw.fields) rewrite(field, 'type', 'type');
    }

    if (changed && kind) {
      writeYamlFile(file, raw);
      rewritten.push({ kind, id: kind === 'system' ? 'system' : String(raw.id) });
    }
  }
  return rewritten;
}

/**
 * Re-express every implementation file path (sourcePath, each method's
 * sourcePath, simPath) under `specsDir` so it is read against `toRoot` instead
 * of `fromRoot`. The file a path names never changes — only the root it is
 * relative to. Empty and absolute paths are left as they are.
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
    /** Rebase `holder[key]` in place when it holds a relative path. */
    const rebase = (holder: any, key: string): void => {
      const p = holder[key];
      if (typeof p !== 'string' || p === '' || path.isAbsolute(p)) return;
      const next = toPosixPath(path.relative(toRoot, path.resolve(fromRoot, p)));
      if (next !== p) {
        holder[key] = next;
        changed = true;
      }
    };
    for (const key of ['sourcePath', 'simPath']) rebase(raw, key);
    if (Array.isArray(raw.methods)) {
      for (const method of raw.methods) {
        if (method && typeof method === 'object') rebase(method, 'sourcePath');
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

// ---------------------------------------------------------------------------
// Component rename
//
// Every other spec names a component by its id, so renaming one is a move and a
// rewrite: the component, with the interface and implementation named after
// it, moves to the new ids and files, and every reference in the bound tree
// follows through the rewriter the subsystem migrations use. Display names are
// the author's to change.
// ---------------------------------------------------------------------------

/** One spec a component rename moved to a new id (spec_rename). */
export interface SpecRename {
  kind: 'component' | 'interface' | 'implementation';
  /** The id before the rename. */
  from: string;
  /** The id after the rename. */
  to: string;
}

/** What renaming a component changed (component_rename). */
export interface ComponentRename {
  /** The component, and each interface and implementation named after it (i<id>, <id>_impl), with its old and new id. */
  renamed: SpecRename[];
  /** Ids of the other specs whose references to a renamed id were rewritten. */
  rewritten: string[];
}

/**
 * Rename a component and every reference to it in the bound tree. The interface
 * named i<componentId> and the implementation named <componentId>_impl that
 * realizes one of the component's contracts move with it; interfaces and
 * implementations named otherwise keep their ids, and only their component and
 * contract references change. Before writing anything it refuses a component
 * that does not exist (component-missing), one inside a chained subproject
 * (chained-component), a new id outside the id grammar (invalid-id), and a new
 * id — or the interface or implementation id it implies — already in use
 * (id-taken).
 */
export function renameComponent(componentId: string, newId: string): ComponentRename {
  // Steps 1–3: the component must exist…
  const component = loadComponentSpec(componentId);
  if (!component) {
    throw new WaironError(`component-missing: no component has the id "${componentId}".`);
  }
  // Steps 4–5: …and belong to the bound project itself.
  if (componentId.includes('::')) {
    throw new WaironError(
      `chained-component: "${componentId}" lives in a chained subproject; rename it from that project's own root.`,
    );
  }
  // Steps 6–7: the new id must be a plain lowercase identifier.
  if (!SpecIdSchema.safeParse(newId).success) {
    throw new WaironError(`invalid-id: "${newId}" is not a lowercase identifier with no namespace separator.`);
  }

  // Steps 8–10: every component, interface and implementation spec.
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();

  // Steps 11–12: nothing may already hold the new ids.
  const interfaceId = `i${newId}`;
  const implementationId = `${newId}_impl`;
  const taken = [
    components.some((c) => c.id === newId) ? `component "${newId}"` : null,
    interfaces.some((i) => i.id === interfaceId) ? `interface "${interfaceId}"` : null,
    implementations.some((impl) => impl.id === implementationId) ? `implementation "${implementationId}"` : null,
  ].filter((holder): holder is string => holder !== null);
  if (taken.length > 0) {
    throw new WaironError(`id-taken: the new id, or an id it implies, is already in use: ${taken.join(', ')}.`);
  }

  // Step 13: what moves — the component's interface named after it, and the
  // implementation named after it that realizes one of its contracts.
  const contracts = interfaces.filter((i) => i.component === componentId);
  const movingInterface = contracts.find((i) => i.id === `i${componentId}`);
  const movingImplementation = implementations.find((impl) =>
    impl.id === `${componentId}_impl` && contracts.some((i) => i.id === impl.contract));
  const renamed: SpecRename[] = [
    { kind: 'component', from: componentId, to: newId },
    ...(movingInterface ? [{ kind: 'interface' as const, from: movingInterface.id, to: interfaceId }] : []),
    ...(movingImplementation ? [{ kind: 'implementation' as const, from: movingImplementation.id, to: implementationId }] : []),
  ];

  // Step 14: every reference to a renamed id across the bound tree, the moved
  // specs' own files included, before anything is saved: placement then finds a
  // renamed member's owner through its rewritten owns. The moved specs report as
  // renamed, not as rewritten.
  const rewritten = rewriteRefFields(aiPathsAt(getProjectRoot()).specsDir(), (ref, position) => {
    if (position === 'component' || position === 'entity-class' || position === 'auth-source') {
      return ref === componentId ? newId : ref;
    }
    if (position === 'interface' && ref === movingInterface?.id) return interfaceId;
    return ref;
  })
    .filter((spec) => !renamed.some((moved) => moved.kind === spec.kind && moved.from === spec.id))
    .map((spec) => spec.id);

  // Step 15: the rewrite changed files outside the save paths.
  invalidateSpecCache();

  // Step 16: the moved specs as the rewrite left them, their references to the
  // component and its contract already following the rename.
  const movedComponent = loadComponentSpec(componentId) ?? component;
  const movedInterface = movingInterface ? loadInterfaceSpec(movingInterface.id) ?? movingInterface : null;
  const movedImplementation = movingImplementation
    ? loadImplementationSpec(movingImplementation.id) ?? movingImplementation
    : null;

  // Step 17: the component under its new id, where the loader places it — an
  // owned member nested under its owner.
  saveComponentSpec({ ...movedComponent, id: newId });
  // Step 18: its own interface, when that moves, under i<newId>.
  if (movedInterface) saveInterfaceSpec({ ...movedInterface, id: interfaceId, component: newId });
  // Step 19: its own implementation, when that moves, under <newId>_impl.
  if (movedImplementation) {
    // The nested layout keeps an implementation's file beside its contract's, so
    // one whose contract keeps its id is written to the very file it moves out
    // of. That file is cleared first: the loader refuses to write over another id.
    const oldFile = getImplementationPath(movedImplementation.id);
    if (path.resolve(getImplementationPath(implementationId, movedImplementation.contract)) === path.resolve(oldFile)) {
      fs.unlinkSync(oldFile);
    }
    saveImplementationSpec({ ...movedImplementation, id: implementationId });
  }

  // Step 20: remove each moved spec's old file, found by its old id — which the
  // loader still indexes beside the new one, so a folder a save moved is followed.
  removeSpecFile(getComponentPath(componentId), componentId);
  if (movingInterface) removeSpecFile(getInterfacePath(movingInterface.id), movingInterface.id);
  if (movingImplementation) removeSpecFile(getImplementationPath(movingImplementation.id), movingImplementation.id);

  // Step 21: the removed files changed the tree outside the save paths.
  invalidateSpecCache();
  // Step 22: what moved, and what was rewritten.
  return { renamed, rewritten };
}

/**
 * Remove a spec file that still holds the spec with `id`, then each folder the
 * removal leaves empty, up to the bound specs root. A file holding anything
 * else — or nothing any more — is left alone.
 */
function removeSpecFile(file: string, id: string): void {
  if (!fs.existsSync(file)) return;
  try {
    if ((readYamlFile(file) as { id?: unknown } | null)?.id !== id) return;
  } catch {
    return;
  }
  fs.unlinkSync(file);
  const specsRoot = path.resolve(aiPathsAt(getProjectRoot()).specsDir());
  for (let dir = path.dirname(path.resolve(file)); dir !== specsRoot && isWithinDir(specsRoot, dir); dir = path.dirname(dir)) {
    if (fs.readdirSync(dir).length > 0) break;
    fs.rmdirSync(dir);
  }
}

// ---------------------------------------------------------------------------
// Contract-method rename
//
// A method name is a reference too: every interface of a component may declare
// it, the implementations of those contracts realize it, and dispatch tables,
// lifecycle entrypoints and narrative steps name it beside the component that
// serves it. Renaming one moves the declaration and retargets those references
// through the same rewriter a component rename uses. What it deliberately does
// NOT touch: prose, and a published wire name — renaming a contract method must
// never silently rename an RPC — so both are reported instead.
// ---------------------------------------------------------------------------

/** The grammar a renamed method is written in: a camel-case identifier, which no namespace separator passes. */
const METHOD_NAME = /^[a-z][a-zA-Z0-9]*$/;

/**
 * The fields a mention is read from — a spec's prose, wherever it nests: every
 * description, a method's intent, a finding's summary, and a narrative step's
 * own text (its condition, iteration source, outcome, raised error, credential
 * note and acknowledged caller). A signature, a symbol and a capability are not
 * prose: the rename either carries them or leaves them by design.
 */
const PROSE_FIELDS = new Set([
  'description', 'intent', 'summary', 'condition', 'over', 'outcome', 'error', 'note', 'caller',
]);

/** What renaming a contract method changed (method_rename). */
export interface MethodRename {
  /** The component whose method was renamed. */
  component: string;
  /** The method name before the rename. */
  from: string;
  /** The method name after it. */
  to: string;
  /** Ids of the specs the method moved in: the contracts that declared it, and the implementations of those contracts that realized it. */
  renamed: string[];
  /** Ids of the specs whose references were retargeted: narrative call, register and dispatch steps, dispatch-table bindings, and lifecycle entrypoints. */
  rewritten: string[];
  /** Ids of the specs whose prose still names the old method, and of the contracts whose gRPC binding keeps it as a wire method. Nothing here was rewritten. */
  mentions: string[];
  /** The code symbol an implementation now declares, when the rename pinned the old name so the existing function still binds. */
  pinnedSymbol?: string;
}

/**
 * Rename a contract method and every reference to it in the bound tree. The
 * method moves on every interface of the component that declares it — its name,
 * and the name inside its signature — and on the implementations of those
 * contracts, carrying narrative, sourcePath, symbol, detail, intent and
 * findings unchanged; an implementation that declared no symbol is pinned to
 * the old name unless `pinSymbol` is false, so the function it already binds to
 * keeps binding. Before writing anything it refuses a component that does not
 * exist (component-missing), one inside a chained subproject
 * (chained-component), a new name outside the identifier grammar
 * (invalid-name), a method the component does not declare (method-missing), and
 * a new name a moving contract already declares (name-taken).
 */
export function renameMethod(componentId: string, methodName: string, newName: string, pinSymbol?: boolean): MethodRename {
  // Steps 1–3: the component must exist…
  const component = loadComponentSpec(componentId);
  if (!component) {
    throw new WaironError(`component-missing: no component has the id "${componentId}".`);
  }
  // Steps 4–5: …and belong to the bound project itself.
  if (componentId.includes('::')) {
    throw new WaironError(
      `chained-component: "${componentId}" lives in a chained subproject; rename its method from that project's own root.`,
    );
  }
  // Steps 6–7: the new name must be a camel-case identifier.
  if (!METHOD_NAME.test(newName)) {
    throw new WaironError(`invalid-name: "${newName}" is not a camel-case identifier.`);
  }

  // Steps 8–9: the component's own contracts, and the ones declaring the method.
  const contracts = loadInterfaceSpecs().filter((i) => i.component === componentId);
  const moving = contracts.filter((i) => i.methods.some((m) => m.name === methodName));
  // Steps 10–11: the component must declare the method…
  if (moving.length === 0) {
    throw new WaironError(`method-missing: no contract of "${componentId}" declares the method "${methodName}".`);
  }
  // Steps 12–13: …and the new name must be free on every contract that moves.
  const taken = moving.filter((i) => i.methods.some((m) => m.name === newName)).map((i) => `"${i.id}"`);
  if (taken.length > 0) {
    throw new WaironError(`name-taken: ${taken.join(', ')} already declares a method under the name "${newName}".`);
  }

  // Step 14: every implementation, for the realizations of those contracts.
  const implementations = loadImplementationSpecs();
  const movingContracts = new Set(moving.map((i) => i.id));
  const renamed: string[] = [];

  // Steps 15–16: the method moves on each of those contracts — its name, and
  // the name inside its signature. Params, returns, description, guarantees,
  // endpoint and findings stay exactly as they are.
  for (const contract of moving) {
    saveInterfaceSpec({
      ...contract,
      methods: contract.methods.map((m) => (m.name === methodName
        ? { ...m, name: newName, signature: renameInSignature(m.signature, methodName, newName) }
        : m)),
    });
    renamed.push(contract.id);
  }

  // Steps 17–20: and on the implementations of those contracts that realize it,
  // carrying narrative, sourcePath, symbol, detail and intent unchanged.
  let pinnedSymbol: string | undefined;
  for (const implementation of implementations) {
    if (!movingContracts.has(implementation.contract)) continue;
    const realization = implementation.methods.find((m) => m.name === methodName);
    if (!realization) continue;
    // Steps 18–19: an implementation that named no symbol needs one now — the
    // function it binds to still carries the old name — unless the caller
    // declined the pin.
    const pin = realization.symbol === undefined && pinSymbol !== false;
    if (pin) pinnedSymbol = methodName;
    saveImplementationSpec({
      ...implementation,
      methods: implementation.methods.map((m) => (m.name === methodName
        ? { ...m, name: newName, ...(pin ? { symbol: methodName } : {}) }
        : m)),
    });
    renamed.push(implementation.id);
  }

  // Step 21: the saves moved names the retargeting below must read.
  invalidateSpecCache();

  // Step 22: every reference to the method on THIS component, retargeted where
  // it is named: a narrative call, register or dispatch step, a dispatch-table
  // binding, and a lifecycle entrypoint. The rewriter persists what it changes.
  const specsDir = aiPathsAt(getProjectRoot()).specsDir();
  const rewritten = rewriteRefFields(specsDir, (ref, position, owner) =>
    (position === 'method' && owner === componentId && ref === methodName ? newName : ref))
    .map((spec) => spec.id);

  // Step 23: what names the method and is left alone.
  const mentions = collectMentions(specsDir, methodName, moving);

  // Step 24: the report.
  return {
    component: componentId,
    from: methodName,
    to: newName,
    renamed,
    rewritten,
    mentions,
    ...(pinnedSymbol ? { pinnedSymbol } : {}),
  };
}

/**
 * A method's signature with the method's own name rewritten: the first
 * occurrence of `from` as a whole identifier, which is the name the signature
 * opens with. A signature that names it nowhere is left as it is — the method's
 * `name` is what the contract is read by.
 */
function renameInSignature(signature: string, from: string, to: string): string {
  return signature.replace(identifierPattern(from), to);
}

/**
 * The specs that still name `methodName` once the rename is written, every one
 * of them left exactly as it was: the specs whose prose carries the name (see
 * PROSE_FIELDS), and the moved contracts whose method keeps it as a gRPC wire
 * method — a rename never edits prose, and never changes a published wire name.
 */
function collectMentions(specsDir: string, methodName: string, moved: InterfaceSpec[]): string[] {
  const mentions = new Set<string>();
  for (const contract of moved) {
    const wireBound = contract.methods.some((m) => {
      const endpoint = m.endpoint;
      return endpoint?.transport === 'gRPC' && endpoint.method === methodName;
    });
    if (wireBound) mentions.add(contract.id);
  }

  const named = identifierPattern(methodName);
  /** Whether any prose field this value nests names the method. */
  const namesMethod = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(namesMethod);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (typeof nested === 'string'
      ? PROSE_FIELDS.has(key) && named.test(nested)
      : namesMethod(nested)));
  };

  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const kind = specKind(raw);
    if (!kind || !namesMethod(raw)) continue;
    mentions.add(kind === 'system' ? 'system' : String(raw.id));
  }
  return [...mentions];
}

/**
 * A method name matched as a whole identifier, so a name a longer word merely
 * contains is not a use of it. No escaping: a method name is alphanumeric by
 * schema, so nothing in one is a regular-expression operator.
 */
function identifierPattern(methodName: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${methodName}(?![A-Za-z0-9_])`);
}
