import * as fs from 'fs';
import * as path from 'path';
import {
  saveSystemSpec,
  loadSubsystemSpec,
  loadSubsystemSpecs,
  loadSystemSpec,
  loadComponentSpec,
  loadComponentSpecs,
  loadInterfaceSpec,
  loadInterfaceSpecs,
  loadImplementationSpec,
  loadImplementationSpecs,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  getComponentPath,
  getInterfacePath,
  getImplementationPath,
  invalidateSpecCache,
  assertContainedProjectPath,
  // The member moves (moveMountToMembers, normalizeReferences) read the graph
  // and write through the spec repository's two maintenance writes.
  graph,
  deleteMount,
  normalizeReferences as normalizeSpecReferences,
  // The ONE reference-field table (see core/specs.ts). A rename drives it
  // over raw files, a move over the typed store; the list of where a spec
  // names another spec is written once so neither can go stale alone.
  specKind,
  rewriteSpecRefs,
  type RefPosition,
  type SpecRefKind,
} from './specs.js';
import { aiPathsAt } from '../config/paths.js';
import { projectConfigRepository, projectConfigRepositoryAt } from '../config/project-config.js';
import { getProjectRoot, runWithProjectRoot, ensureDir, listFilesRecursive } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { WaironError } from '../utils/errors.js';
import { declaredMembers, effectiveProjectId, EXTERNAL_ALIAS_RE, type ProjectConfig } from '../models/project.js';
import { rekeyAnchor, type CarriedRekey, type IdentityRename } from '../models/identity-rename.js';
import {
  SpecIdSchema,
  type ComponentSpec,
  type ImplementationSpec,
  type InterfaceSpec,
  type ProjectFamily,
} from '../models/index.js';

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

/**
 * A fresh project's default configuration. It declares its id: the one given (a
 * chained child's mount subsystem id), else the name slugified — none when the
 * name yields no id, which the project-identity rule then reports.
 */
function defaultProjectConfig(name: string, now: string, id?: string): ProjectConfig {
  const declared = id ?? effectiveProjectId({ name });
  return {
    schemaVersion: '1.0.0',
    ...(declared !== null ? { id: declared } : {}),
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
function bootstrapSystemSpec(name: string, now: string, vision?: string): Parameters<typeof saveSystemSpec>[0] {
  return {
    schemaVersion: '1.0.0',
    name,
    vision: vision ?? `Core vision for ${name}`,
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
export function ensureProjectInitialized(fallbackName: string, id?: string, vision?: string): { wroteConfig: boolean; wroteSystem: boolean } {
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
    projectConfigRepository.create(defaultProjectConfig(name, now, id));
    wroteConfig = true;
  }
  if (!hasSystem) {
    saveSystemSpec(bootstrapSystemSpec(name, now, vision));
    wroteSystem = true;
  }
  if (wroteConfig || wroteSystem) invalidateSpecCache();
  return { wroteConfig, wroteSystem };
}

// ---------------------------------------------------------------------------
// Members (stage 3)
//
// A member is a project the bound project contains: declared in its
// project.yaml `members` (or, for one release, by a legacy L1 subsystem that
// carries projectPath). It is never a subsystem of its parent and carries no
// content there. These writers keep the two halves — the declaration and the
// member project — in step, and never write the L1 mount form.
// ---------------------------------------------------------------------------

/** One member a project declares, as the discovery helpers below read it. */
interface MemberAt {
  alias: string;
  /** The path as written, relative to the declaring root. */
  path: string;
  form: 'members' | 'mount';
}

/**
 * The members a root declares: its `members` entries first (read through that
 * root's binding), then — for one release — each legacy L1 mount of its own
 * spec tree whose alias `members` does not hold. A declaration with a problem,
 * or a mount whose alias `externals` also declares, is not followed.
 */
function memberDeclarationsAt(dir: string): MemberAt[] {
  let config: ProjectConfig | null = null;
  try {
    config = projectConfigRepositoryAt(dir).load();
  } catch {
    config = null;
  }
  const out: MemberAt[] = [];
  const seen = new Set<string>();
  for (const member of config ? declaredMembers(config) : []) {
    seen.add(member.alias);
    if (!member.problem) out.push({ alias: member.alias, path: member.path, form: 'members' });
  }
  const specsDir = aiPathsAt(dir).specsDir();
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
    const id = (raw as { id?: unknown }).id;
    if (typeof pp !== 'string' || pp.trim() === '' || typeof id !== 'string') continue;
    if (seen.has(id) || config?.externals?.[id] !== undefined) continue;
    seen.add(id);
    out.push({ alias: id, path: pp, form: 'mount' });
  }
  return out;
}

/**
 * Walk a project and every member it declares (recursively, either form),
 * invoking `onMember` for each member directory with its alias. Shared scan
 * behind the detection + backfill helpers below.
 */
function walkMembers(projectRoot: string, onMember: (memberDir: string, alias: string) => void): void {
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    const resolved = path.resolve(dir);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    for (const member of memberDeclarationsAt(dir)) {
      let memberDir: string;
      try {
        memberDir = assertContainedProjectPath(dir, member.path);
      } catch {
        continue; // absolute / escaping path — never touch it
      }
      onMember(memberDir, member.alias);
      walk(memberDir); // recurse into the member's own members
    }
  };
  walk(projectRoot);
}

/**
 * core_orchestrator.listDirectChainedSubprojects — the DIRECT members of a
 * project, one level deep: its `members` entries and, for one release, its
 * legacy L1 mounts, each resolved inside the project root as the member's
 * directory, alias and form. An absolute or escaping path is skipped. Used by
 * layered `wairon generate` to cascade one level at a time.
 */
export function listDirectChainedSubprojects(projectRoot: string): { dir: string; alias: string; form: 'members' | 'mount' }[] {
  const out: { dir: string; alias: string; form: 'members' | 'mount' }[] = [];
  // Steps 1-2: the member declarations, `members` entries first.
  for (const member of memberDeclarationsAt(projectRoot)) {
    // Step 3: resolved inside the root; an absolute or escaping path is skipped.
    let dir: string;
    try {
      dir = assertContainedProjectPath(projectRoot, member.path);
    } catch {
      continue;
    }
    // Step 4: the member's directory, alias and form.
    out.push({ dir, alias: member.alias, form: member.form });
  }
  // Step 5.
  return out;
}

/** True when a member dir has a spec tree but no project.yaml (un-runnable standalone). */
function childHasSpecsButNoConfig(childDir: string): boolean {
  return fs.existsSync(aiPathsAt(childDir).specsDir()) && !projectConfigRepositoryAt(childDir).exists();
}

/**
 * Detect members (recursively, either declaration form) that have specs but
 * no project.yaml — the state that makes a member un-runnable standalone
 * (`wairon` reports "No wairon project found"). Pure read; returns the member
 * dirs. Used by the doctor report to point the user at `--fix`.
 */
export function findChainingSubprojectsMissingConfig(projectRoot: string): string[] {
  const missing: string[] = [];
  walkMembers(projectRoot, (memberDir) => {
    if (childHasSpecsButNoConfig(memberDir)) missing.push(memberDir);
  });
  return missing;
}

/**
 * Backfill a missing project.yaml on any member that has a spec tree but no
 * project config, declaring its alias as its project id. Existing specs are
 * never touched. Returns the member dirs repaired. Used by `wairon doctor --fix`.
 */
export function backfillChainedSubprojectConfigs(projectRoot: string): string[] {
  const backfilled: string[] = [];
  walkMembers(projectRoot, (memberDir, alias) => {
    if (childHasSpecsButNoConfig(memberDir)) {
      runWithProjectRoot(memberDir, () => {
        // A member is identified by the alias its parent declares it under.
        ensureProjectInitialized(alias, alias);
      });
      backfilled.push(memberDir);
    }
  });
  return backfilled;
}

/**
 * core_orchestrator.createMember — create a member of the bound project:
 * FULLY yet NON-DESTRUCTIVELY initialize the member project at the path (its
 * specs directory, project.yaml declaring the alias as its id, and an L0 —
 * each only when absent), then declare it in the bound project's `members`.
 * No L1 spec is written: a member carries no content in its parent.
 * Idempotent — a re-run with the same arguments writes nothing.
 */
export function createMember(alias: string, path: string, description?: string): void {
  // Steps 1-2: guard the alias and the path.
  if (!EXTERNAL_ALIAS_RE.test(alias) || typeof path !== 'string' || path.trim() === '') {
    throw new WaironError(
      `an alias and a path are required to create a member: the alias must fit [a-z0-9-_]+ (got "${alias}") and the path must not be empty.`,
    );
  }
  // Step 3: the member directory, from the bound project root. Stored with
  // forward slashes so the configuration stays portable across platforms.
  const relPath = toPosixPath(path);
  // Steps 4-5: containment guard — absolute, ../-escaping and link-escaping
  // paths are refused before anything is scaffolded.
  const memberDir = assertContainedProjectPath(getProjectRoot(), relPath);
  // A bootstrapped L0's vision: the description given, else one line naming
  // the member of this project.
  const parentName = loadSystemSpec()?.name;
  const vision = description ?? `Member ${alias} of ${parentName ? `the ${parentName} project` : 'its parent project'}`;
  // Steps 6-12: scoped to the member, complete only what is missing.
  runWithProjectRoot(memberDir, () => {
    ensureDir(aiPathsAt(memberDir).specsDir());
    ensureProjectInitialized(alias, alias, vision);
  });
  // Step 13: declare it in `members`; an equal declaration writes nothing and
  // a different one under the alias is refused.
  projectConfigRepository.declareMember(alias, {
    path: relPath,
    ...(description !== undefined ? { description } : {}),
  });
  invalidateSpecCache();
  // Step 14: member declared and its project ensured.
}

/**
 * core_orchestrator.moveMember — relocate a member of the bound project: move
 * its directory on disk and point its `members` entry there. A member still
 * declared by a legacy L1 mount is first moved into `members`
 * (moveMountToMembers), so wairon never rewrites the L1 form.
 */
export function moveMember(alias: string, newPath: string): void {
  // Step 1: the graph of the bound root — the member the alias declares.
  const member = graph().nodes.find((n) => n.parent === '' && n.mountAlias === alias);
  // Steps 2-3: guard that the alias declares a member.
  if (!member) {
    throw new WaironError(`no member is declared under that alias: the bound project declares no member "${alias}".`);
  }
  // Steps 4-6: a legacy declaration moves into `members` first.
  if (member.mountForm === 'mount') moveMountToMembers(alias);
  // Step 7: relocate the directory under the containment guard.
  const root = getProjectRoot();
  const declared = declaredMembers(projectConfigRepository.load() ?? {}).find((m) => m.alias === alias);
  const currentPath = declared?.path ?? member.legacyMount?.projectPath ?? '';
  const nextPath = toPosixPath(newPath);
  const oldDir = assertContainedProjectPath(root, currentPath);
  const newDir = assertContainedProjectPath(root, nextPath);
  if (oldDir !== newDir) {
    if (!fs.existsSync(oldDir)) {
      throw new WaironError(`Member directory not found at its current path: ${oldDir}`);
    }
    if (fs.existsSync(newDir)) {
      throw new WaironError(`Target directory already exists: ${newDir}`);
    }
    ensureDir(path.dirname(newDir));
    fs.renameSync(oldDir, newDir);
  }
  // Step 8: point the `members` entry at the new path.
  projectConfigRepository.setMemberPath(alias, nextPath);
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
// Externalize (internal subsystem -> member) and internalize (member -> internal
// subsystem). Only the .wai specs move; the source code is the user's
// responsibility. Every reference keeps its target: before the move, each one
// that will cross the new boundary is re-expressed so it keeps binding what it
// bound — `alias::name` into the member, `<parent id>::name` back out, never
// `super::` — and the re-save through the writer then spells each canonically.
// ---------------------------------------------------------------------------

/**
 * The reference positions a boundary move re-expresses by id: what names a
 * component or a contract, and — on the parent's side — a type the moved
 * subtree takes with it, read through the member's alias. A type the moved
 * subtree names in the parent is matched by name against every loaded type,
 * whichever project the naming spec sits in, so it stays as written.
 */
const MOVED_REF_POSITIONS: ReadonlySet<RefPosition> = new Set<RefPosition>(['component', 'interface']);
const INTO_MEMBER_POSITIONS: ReadonlySet<RefPosition> = new Set<RefPosition>([...MOVED_REF_POSITIONS, 'type']);

/**
 * core_orchestrator.externalizeSubsystem — turn an internal subsystem into a
 * new member project at `memberPath`: provision the member (configuration
 * declaring the subsystem id as its project id, and its L0), move the
 * subsystem's spec subtree there, declare it in `members` under the subsystem
 * id, re-save every reference across the new boundary, declare the parent as
 * the member's external when the moved specs reference it, and restate the
 * parent L0's re-exports of the subsystem as re-exports of the member.
 */
export function externalizeSubsystem(subsystemId: string, memberPath: string): void {
  if (subsystemId.includes('::')) {
    throw new WaironError('cannot externalize a nested/namespaced subsystem; run from its owning project.');
  }
  // Step 1: the subsystem.
  const foo = loadSubsystemSpec(subsystemId);
  // Steps 2-3: it exists and is a subsystem, not a legacy mount (a member declaration).
  // A subsystem of the bound root itself: a member's own subsystem is found by
  // its bare id too, and a legacy mount is a member declaration.
  if (!foo || foo.projectPath || graph().owners.get(subsystemId) !== '') {
    throw new WaironError(`cannot externalize: subsystem "${subsystemId}" is missing or is already a member.`);
  }
  const parentRoot = getProjectRoot();
  const parentSpecsDir = aiPathsAt(parentRoot).specsDir();
  const fooDir = path.join(parentSpecsDir, subsystemId);
  if (!fs.existsSync(fooDir)) {
    throw new WaironError(`subsystem specs directory not found: ${fooDir}`);
  }
  const relPath = toPosixPath(memberPath);
  // The containment guard: the member must lie within the declaring project.
  const memberDir = assertContainedProjectPath(parentRoot, relPath);
  const memberFooDir = path.join(aiPathsAt(memberDir).specsDir(), subsystemId);
  if (fs.existsSync(memberFooDir)) {
    throw new WaironError(`target already contains a "${subsystemId}" subsystem: ${memberFooDir}`);
  }
  // What crosses the new boundary, read BEFORE anything moves: the moved ids,
  // which the parent now names as `<id>::<local>`, and the parent ids the moved
  // subtree names, which it now names as `<parent id>::<local>`.
  const moved = movedIdsUnder(fooDir);
  const parentIds = new Set([...movedIdsUnder(parentSpecsDir)].filter((id) => !moved.has(id)));
  const parentId = effectiveProjectId(projectConfigRepository.load() ?? { name: loadSystemSpec()?.name ?? '' });
  // A `super::` the moved subtree wrote climbs from where the spec lives; one
  // level deeper it would climb somewhere else. Each is re-expressed by the
  // project its target lies in — never as `super::`; one whose target lies
  // beyond this root's reach cannot be, and is refused before anything moves.
  const climbs = climbingReferences(graph(), specIdsUnder(fooDir), parentId);
  if (climbs.refused.length > 0) {
    throw new WaironError(
      `cannot externalize "${subsystemId}": ${climbs.refused.map((r) => `"${r}"`).join(', ')} climb${climbs.refused.length === 1 ? 's' : ''} `
      + 'above this project, where the target cannot be named from here. Run `wairon doctor --fix` from the top project first, which rewrites them as `alias::name`.',
    );
  }
  const outward = climbs.map.size > 0 || referencesUnder(fooDir, (ref) => parentIds.has(ref));
  if (outward && parentId === null) {
    throw new WaironError('cannot externalize: the moved specs reference this project, and it has no project id for the member to declare as its external. Declare one first (`wairon id set`).');
  }

  // Step 4: the member's configuration, declaring the subsystem id as its project id.
  const memberName = foo.name || subsystemId;
  runWithProjectRoot(memberDir, () => {
    const now = new Date().toISOString();
    projectConfigRepository.create(defaultProjectConfig(memberName, now, subsystemId));
    ensureDir(aiPathsAt(memberDir).specsDir());
    // Step 5: the member's bootstrap L0.
    saveSystemSpec(bootstrapSystemSpec(memberName, now));
  });
  // Step 6: move the subtree in, re-express its implementation paths, re-home
  // the subsystem under the member's L0, and re-express the references that
  // now cross the boundary.
  ensureDir(path.dirname(memberFooDir));
  fs.renameSync(fooDir, memberFooDir);
  rebaseImplementationPaths(memberFooDir, parentRoot, memberDir);
  patchSubsystemIndex(path.join(memberFooDir, '.index.yaml'), (s) => {
    s.parentSystem = memberName;
    delete s.projectPath;
  });
  const parentSide = rewriteRefFields(parentSpecsDir, (ref, position) =>
    (INTO_MEMBER_POSITIONS.has(position) && moved.has(ref) ? `${subsystemId}::${ref}` : ref));
  const memberSide = rewriteRefFields(memberFooDir, (ref, position) =>
    climbs.map.get(ref) ?? (MOVED_REF_POSITIONS.has(position) && parentIds.has(ref) ? `${parentId}::${ref}` : ref));
  // Step 7: back in the parent's scope, declare the member — no L1 mount is written.
  projectConfigRepository.declareMember(subsystemId, { path: relPath });
  invalidateSpecCache();
  // Step 8: re-save each spec whose references crossed the boundary, so the
  // writer spells each from where it now lives.
  const memberKey = graph().nodes.find((n) => n.parent === '' && n.mountAlias === subsystemId)?.namespace ?? subsystemId;
  for (const spec of parentSide) if (spec.kind !== 'system') normalizeSpecReferences(spec.kind, spec.id);
  for (const spec of memberSide) if (spec.kind !== 'system') normalizeSpecReferences(spec.kind, `${memberKey}::${spec.id}`);
  // Step 9: the member declares the parent as its external when it references it.
  if (memberSide.length > 0 && parentId !== null) {
    projectConfigRepositoryAt(memberDir).declareExternal(parentId, {});
  }
  // Step 10: the parent L0's re-exports of the subsystem now re-export the
  // member by its alias — the same text, restated; nothing is added.
  restateReExports(subsystemId, subsystemId);
  invalidateSpecCache();
  // Step 11.
}

/**
 * core_orchestrator.internalizeMember — take a single-subsystem member back
 * into the bound project: move its specs in, remove its declaration, delete
 * its .wai project, and re-save every reference that crossed the old boundary
 * as a local id. Refuses a member holding more than one subsystem, or
 * declaring members or externals of its own other than the parent.
 */
export function internalizeMember(alias: string): void {
  // Step 1: the graph of the bound root.
  const family = graph();
  const member = family.nodes.find((n) => n.parent === '' && n.mountAlias === alias);
  // Steps 2-3: the alias declares a member.
  if (!member) {
    throw new WaironError(`cannot internalize: no member is declared under that alias ("${alias}").`);
  }
  // Steps 4-5: the member can be taken in whole.
  const root = family.nodes.find((n) => n.namespace === '');
  const parentId = root?.id;
  const subsystems = loadSubsystemSpecs().filter((s) => family.owners.get(s.id) === member.namespace);
  const ownExternals = Object.keys(configAt(member.directory)?.externals ?? {}).filter((a) => a !== parentId);
  if (subsystems.length !== 1 || member.members.length > 0 || ownExternals.length > 0) {
    throw new WaironError(
      `cannot internalize: the member is not a single subsystem, or declares members or externals of its own (member "${alias}": `
      + `${subsystems.length} subsystem(s), ${member.members.length} member(s), externals ${ownExternals.length ? ownExternals.join(', ') : 'none'}).`,
    );
  }
  const parentRoot = getProjectRoot();
  const parentSpecsDir = aiPathsAt(parentRoot).specsDir();
  const memberDir = assertContainedProjectPath(parentRoot, path.relative(parentRoot, member.directory) || '.');
  const memberSpecsDir = aiPathsAt(memberDir).specsDir();
  const localSub = subsystems[0].id.slice(member.namespace.length + 2);
  // What crosses the old boundary, read BEFORE anything moves: each reference
  // the parent makes into the member, and the member makes back into the
  // parent, by the target the scan bound it to.
  const intoMember = crossingReferences(family, '', member.namespace);
  const backOut = crossingReferences(family, member.namespace, '');
  // Step 6: delete a legacy mount document first, so the moved subsystem can take its folder.
  deleteMount(alias);
  // Step 7: move the member's specs in (refused before anything moves on a collision).
  const movedFiles = moveTreeInto(memberSpecsDir, parentSpecsDir, new Set([path.resolve(aiPathsAt(memberDir).specsSystem())]));
  rebaseImplementationPaths(parentSpecsDir, memberDir, parentRoot, movedFiles);
  const parentSystemName = loadSystemSpec()?.name;
  patchSubsystemIndex(path.join(parentSpecsDir, localSub, '.index.yaml'), (s) => {
    if (parentSystemName) s.parentSystem = parentSystemName;
    delete s.projectPath;
  });
  const rewritten = [
    ...rewriteRefFields(parentSpecsDir, (ref) => intoMember.get(ref) ?? backOut.get(ref) ?? ref),
  ];
  // Step 8: remove the member from `members` (false for a legacy declaration).
  projectConfigRepository.removeMember(alias);
  // Step 9: delete the member's .wai project.
  fs.rmSync(path.join(memberDir, '.wai'), { recursive: true, force: true });
  invalidateSpecCache();
  // Step 10: re-save each spec whose references crossed the old boundary.
  for (const spec of rewritten) if (spec.kind !== 'system') normalizeSpecReferences(spec.kind, spec.id);
  // Step 11: the parent L0's re-exports from the member now re-export the moved subsystem.
  restateReExports(alias, localSub);
  invalidateSpecCache();
  // Step 12.
}

/** A root's configuration read through that root's binding; null when it has none or it fails its schema. */
function configAt(dir: string): ProjectConfig | null {
  try {
    return projectConfigRepositoryAt(dir).load();
  } catch {
    return null;
  }
}

/**
 * The `super::` references the specs `specIds` of the bound root wrote, each
 * as authored → the text that names the same target from one level deeper:
 * `<project id>::<local>` by the project the scan bound it to (the bound root
 * by `parentId`). A climb whose target the scan could not read is refused.
 */
function climbingReferences(
  family: ProjectFamily,
  specIds: ReadonlySet<string>,
  parentId: string | null,
): { map: Map<string, string>; refused: string[] } {
  const map = new Map<string, string>();
  const refused: string[] = [];
  for (const ref of family.authoredReferences) {
    if (ref.form !== 'super' || !specIds.has(ref.specId)) continue;
    const producer = ref.producer === undefined ? undefined : family.nodes.find((n) => n.namespace === ref.producer);
    const projectId = producer?.namespace === '' ? parentId : producer?.id;
    const local = producer && producer.namespace !== '' && ref.resolved.startsWith(`${producer.namespace}::`)
      ? ref.resolved.slice(producer.namespace.length + 2)
      : ref.resolved;
    if (!producer || !projectId || ref.binding === 'outside' || ref.binding === 'unresolved') {
      refused.push(ref.authored);
      continue;
    }
    map.set(ref.authored, `${projectId}::${local}`);
  }
  return { map, refused: [...new Set(refused)] };
}

/** The id of every spec document under `dir`, whatever its kind. */
function specIdsUnder(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const file of listFilesRecursive(dir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (raw && typeof raw === 'object' && typeof raw.id === 'string') ids.add(raw.id);
  }
  return ids;
}

/**
 * Every reference with `::` that a project `from` wrote into the project `to`,
 * as authored → the id it becomes once both live in one project: the local id
 * the scan bound it to.
 */
function crossingReferences(family: ProjectFamily, from: string, to: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const ref of family.authoredReferences) {
    // A leading `::` is anchored at the bound root and names the same target
    // from every depth, so a move never needs to touch it.
    if (ref.form === 'leading') continue;
    if (ref.producer !== to || (family.owners.get(ref.specId) ?? '') !== from) continue;
    const local = to === '' ? ref.resolved : ref.resolved.startsWith(`${to}::`) ? ref.resolved.slice(to.length + 2) : null;
    if (local) out.set(ref.authored, local);
  }
  return out;
}

/** The ids of every component, interface and type the spec files under `dir` declare. */
function movedIdsUnder(dir: string): Set<string> {
  const ids = new Set<string>();
  for (const file of listFilesRecursive(dir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    const kind = raw && typeof raw === 'object' ? specKind(raw) : null;
    if ((kind === 'component' || kind === 'interface' || kind === 'type') && typeof raw.id === 'string') ids.add(raw.id);
  }
  return ids;
}

/** Whether any spec under `dir` references an id `matches` accepts, at a moved position. */
function referencesUnder(dir: string, matches: (ref: string) => boolean): boolean {
  let found = false;
  for (const file of listFilesRecursive(dir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    rewriteSpecRefs(raw, (ref, position) => {
      if (MOVED_REF_POSITIONS.has(position) && matches(ref)) found = true;
      return ref;
    });
  }
  return found;
}

/**
 * Move every file under `src` (except those in `skip`) to the same relative
 * place under `dst`, refusing — before anything moves — when one would land on
 * an existing file. Returns the files at their new place.
 */
function moveTreeInto(src: string, dst: string, skip: ReadonlySet<string>): string[] {
  if (!fs.existsSync(src)) return [];
  const files = listFilesRecursive(src, '').filter((f) => !skip.has(path.resolve(f)));
  const targets = files.map((f) => path.join(dst, path.relative(src, f)));
  const taken = targets.filter((t) => fs.existsSync(t));
  if (taken.length > 0) {
    throw new WaironError(`cannot internalize: the member's specs would overwrite ${taken.map((t) => path.relative(dst, t)).join(', ')} in this project.`);
  }
  files.forEach((file, i) => {
    ensureDir(path.dirname(targets[i]));
    fs.renameSync(file, targets[i]);
  });
  return targets;
}

/**
 * Restate the bound L0's re-exports that name `from` as re-exports of `to`,
 * re-saving the L0 only when one does. The text is the same whenever the
 * member's alias is the subsystem's id, which is how both moves declare it.
 */
function restateReExports(from: string, to: string): void {
  const system = loadSystemSpec();
  const entries = (system?.publicInterfaces ?? []) as { from?: string }[];
  if (!system || !entries.some((e) => e.from === from)) return;
  saveSystemSpec({
    ...system,
    publicInterfaces: entries.map((e) => (e.from === from ? { ...e, from: to } : e)) as typeof system.publicInterfaces,
  });
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
/** A spec a reference rewrite changed, by kind and id; the L0 system spec's id is "system". */
interface RewrittenSpec {
  kind: SpecRefKind;
  id: string;
}

/**
 * Rewrite the reference fields of every spec under `specsDir` through `remap`,
 * skipping `excludeDir`, and return the specs it rewrote.
 *
 * WHICH fields hold a reference is not decided here: that is the one table in
 * core/specs.ts (`rewriteSpecRefs`), so the rename walking files and the move
 * walking the typed store cannot drift apart. This is the file half — read,
 * rewrite, persist what changed.
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
    const kind = specKind(raw);
    if (!rewriteSpecRefs(raw, remap) || !kind) continue;
    writeYamlFile(file, raw);
    rewritten.push({ kind, id: kind === 'system' ? 'system' : String(raw.id) });
  }
  return rewritten;
}

/**
 * Rekey every lint allow under `specsDir` for an identity move and return the
 * specs it rewrote. An allow is keyed like a carried finding — the spec it
 * sits on, its site (`at`), the units it covers — so it follows the move by
 * the same arithmetic (identity_rename.rekeyAnchor): its site follows a
 * renamed method or an edge's renamed component, and every covered unit
 * follows too. Where the allow LIVES is the file walk's business: a spec the
 * rename moves carries its allows with it.
 */
function rekeyLintAllows(specsDir: string, rename: IdentityRename): RewrittenSpec[] {
  const rewritten: RewrittenSpec[] = [];
  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    const allows = raw?.lint?.allow;
    const kind = raw && typeof raw === 'object' ? specKind(raw) : null;
    if (!kind || !Array.isArray(allows)) continue;
    const specId = kind === 'system' ? 'system' : String(raw.id);
    let changed = false;
    for (const allow of allows) {
      if (!allow || typeof allow !== 'object') continue;
      const next = rekeyAnchor(rename, {
        spec: specId,
        ...(typeof allow.at === 'string' ? { at: allow.at } : {}),
        ...(Array.isArray(allow.covers) ? { covers: allow.covers } : {}),
      });
      if (next.at !== undefined && next.at !== allow.at) { allow.at = next.at; changed = true; }
      if (next.covers && JSON.stringify(next.covers) !== JSON.stringify(allow.covers)) { allow.covers = next.covers; changed = true; }
    }
    if (!changed) continue;
    writeYamlFile(file, raw);
    rewritten.push({ kind, id: specId });
  }
  return rewritten;
}

/**
 * Re-express every implementation file path (sourcePath, each method's
 * sourcePath, simPath) under `specsDir` so it is read against `toRoot` instead
 * of `fromRoot`. The file a path names never changes — only the root it is
 * relative to. Empty and absolute paths are left as they are.
 */
function rebaseImplementationPaths(specsDir: string, fromRoot: string, toRoot: string, only?: string[]): void {
  for (const file of only?.filter((f) => f.endsWith('.yaml')) ?? listFilesRecursive(specsDir, '.yaml')) {
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
  /** Ids of the other specs whose references to a renamed id were rewritten — lint allows naming it included. */
  rewritten: string[];
  /**
   * Every edit to the debt register (.wai/project.yaml rules.conformance.carried):
   * an entry anchored on a renamed spec, or naming the component in its site or
   * covered units. Empty when the register names none of them.
   */
  carried: CarriedRekey[];
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
  // Step 14: the move as the register and the lint allows are keyed by it:
  // every renamed spec, and the component wherever a unit or an edge names it.
  const rename: IdentityRename = {
    specs: renamed.map(({ from, to }) => ({ from, to })),
    components: [{ from: componentId, to: newId }],
  };
  // Step 15: refuse before the first write when the register cannot be
  // rewritten precisely: a rename that half-lands with its debt left behind reads as
  // debt paid and debt new.
  projectConfigRepository.rekeyCarried(rename, true);

  // Step 16: every reference to a renamed id across the bound tree, the moved
  // specs' own files included, before anything is saved: placement then finds a
  // renamed member's owner through its rewritten owns. The moved specs report as
  // renamed, not as rewritten.
  const rewrittenRefs = rewriteRefFields(aiPathsAt(getProjectRoot()).specsDir(), (ref, position) => {
    if (position === 'component' || position === 'entity-class' || position === 'auth-source') {
      return ref === componentId ? newId : ref;
    }
    if (position === 'interface' && ref === movingInterface?.id) return interfaceId;
    return ref;
  });
  // Step 17: the lint allows naming it — a site on an edge, a covered unit —
  // follow as the register does.
  const allowsRekeyed = rekeyLintAllows(aiPathsAt(getProjectRoot()).specsDir(), rename);
  const rewritten = [...new Set([...rewrittenRefs, ...allowsRekeyed]
    .filter((spec) => !renamed.some((moved) => moved.kind === spec.kind && moved.from === spec.id))
    .map((spec) => spec.id))];

  // Step 18: the rewrite changed files outside the save paths.
  invalidateSpecCache();

  // Step 19: each moved spec under its new id, and the file it left behind.
  moveRenamedSpecs(componentId, newId, component, movingInterface, movingImplementation);

  // Step 20: the debt register, keyed by exactly the ids just moved.
  const carried = projectConfigRepository.rekeyCarried(rename);

  // Step 21: what moved, what was rewritten, and what the register followed.
  return { renamed, rewritten, carried };
}

/**
 * Move each spec a component rename renames to its new id: reload it as the
 * reference rewrite left it, write it under the new id where the loader places it,
 * then remove the file it left behind and drop the cached index.
 *
 * Separate from `renameComponent` because it is a phase of its own — the rename
 * decides WHAT moves, this writes the move — and because the reload matters: the
 * rewrite already edited the moved specs' own files, so saving the in-memory
 * copies loaded before it would undo their references. A spec the reload cannot
 * find falls back to the copy the rename planned from.
 */
function moveRenamedSpecs(
  componentId: string,
  newId: string,
  component: ComponentSpec,
  movingInterface: InterfaceSpec | undefined,
  movingImplementation: ImplementationSpec | undefined,
): void {
  const interfaceId = `i${newId}`;
  const implementationId = `${newId}_impl`;

  // The moved specs as the rewrite left them, their references to the component
  // and its contract already following the rename.
  const movedComponent = loadComponentSpec(componentId) ?? component;
  const movedInterface = movingInterface ? loadInterfaceSpec(movingInterface.id) ?? movingInterface : null;
  const movedImplementation = movingImplementation
    ? loadImplementationSpec(movingImplementation.id) ?? movingImplementation
    : null;

  // The component under its new id, where the loader places it — an owned member
  // nested under its owner.
  saveComponentSpec({ ...movedComponent, id: newId });
  // Its own interface, when that moves, under i<newId>.
  if (movedInterface) saveInterfaceSpec({ ...movedInterface, id: interfaceId, component: newId });
  // Its own implementation, when that moves, under <newId>_impl.
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

  // Remove each moved spec's old file, found by its old id — which the loader
  // still indexes beside the new one, so a folder a save moved is followed.
  removeSpecFile(getComponentPath(componentId), componentId);
  if (movingInterface) removeSpecFile(getInterfacePath(movingInterface.id), movingInterface.id);
  if (movingImplementation) removeSpecFile(getImplementationPath(movingImplementation.id), movingImplementation.id);

  // The removed files changed the tree outside the save paths.
  invalidateSpecCache();
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
  /**
   * Every edit to the debt register (.wai/project.yaml rules.conformance.carried):
   * an entry anchored at the method on a spec it moved in, or naming
   * `<component>.<method>` in a covered unit. Empty when the register names it
   * nowhere.
   */
  carried: CarriedRekey[];
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

  // Step 8: the component's own contracts, and the ones declaring the method.
  const contracts = loadInterfaceSpecs().filter((i) => i.component === componentId);
  const moving = contracts.filter((i) => i.methods.some((m) => m.name === methodName));
  // Steps 9–10: the component must declare the method…
  if (moving.length === 0) {
    throw new WaironError(`method-missing: no contract of "${componentId}" declares the method "${methodName}".`);
  }
  // Steps 11–12: …and the new name must be free on every contract that moves.
  const taken = moving.filter((i) => i.methods.some((m) => m.name === newName)).map((i) => `"${i.id}"`);
  if (taken.length > 0) {
    throw new WaironError(`name-taken: ${taken.join(', ')} already declares a method under the name "${newName}".`);
  }

  // Step 13: every implementation, for the realizations of those contracts.
  const implementations = loadImplementationSpecs();
  const movingContracts = new Set(moving.map((i) => i.id));
  const renamed: string[] = [];

  // Step 14: the move as the register and the lint allows are keyed by it: the
  // method on the contracts that declare it and the implementations that
  // realize it, and `<component>.<method>` wherever a unit names it. Refused
  // before the first write when the register cannot be rewritten precisely.
  const rename: IdentityRename = {
    methods: [{
      component: componentId,
      method: methodName,
      toComponent: componentId,
      toMethod: newName,
      specs: [
        ...moving.map((i) => i.id),
        ...implementations
          .filter((impl) => movingContracts.has(impl.contract) && impl.methods.some((m) => m.name === methodName))
          .map((impl) => impl.id),
      ],
    }],
  };
  projectConfigRepository.rekeyCarried(rename, true);

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
  const retargeted = rewriteRefFields(specsDir, (ref, position, owner) =>
    (position === 'method' && owner === componentId && ref === methodName ? newName : ref));
  // Still step 22: the lint allows naming it — a site on a spec it moved in, a
  // covered unit — follow as the register does.
  const allowsRekeyed = rekeyLintAllows(specsDir, rename);
  const rewritten = [...new Set([...retargeted, ...allowsRekeyed].map((spec) => spec.id))];

  // Step 23: what names the method and is left alone.
  const mentions = collectMentions(specsDir, methodName, moving);

  // Step 24: the debt register, keyed by exactly the identity just moved.
  const carried = projectConfigRepository.rekeyCarried(rename);

  // Step 25: the report.
  return {
    component: componentId,
    from: methodName,
    to: newName,
    renamed,
    rewritten,
    mentions,
    ...(pinnedSymbol ? { pinnedSymbol } : {}),
    carried,
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

// ---------------------------------------------------------------------------
// Stage 3's member moves (core_orchestrator moveMountToMembers /
// normalizeReferences) — the two writes the chaining migration drives per
// member: a legacy L1 mount becomes a `members` entry, and a spec's
// references are re-written in their canonical form.
// ---------------------------------------------------------------------------

/**
 * core_orchestrator.moveMountToMembers — move one legacy L1 mount of the bound
 * project into its `members`: its projectPath as the member's path and its
 * description as the member's description, then delete the L1 document. The
 * caller carries the mount's other fields first. Idempotent: a mount already
 * moved writes nothing.
 */
export function moveMountToMembers(alias: string): boolean {
  // Step 1: the graph of the bound root — the member the alias declares, with its legacy mount.
  const family = graph();
  const member = family.nodes.find((n) => n.parent === '' && n.mountAlias === alias);
  const mount = member?.legacyMount ?? null;
  // Steps 2-3: no legacy mount under the alias — already moved, or nothing to move.
  if (!mount || member?.mountForm !== 'mount') {
    if (member?.mountForm === 'members') return false;
    throw new WaironError(`Refusing to move "${alias}" into \`members\`: the bound project declares no legacy L1 mount under that alias, and no member.`);
  }
  // Step 4: declare the member — refused there when the alias holds a different one.
  projectConfigRepository.declareMember(alias, {
    path: mount.projectPath!,
    ...(mount.description ? { description: mount.description } : {}),
  });
  // Step 5: delete the L1 mount document, so the member is declared in one place.
  deleteMount(alias);
  // Step 6: it wrote.
  return true;
}

/**
 * core_orchestrator.normalizeReferences — re-save one spec of the family with
 * every reference in its canonical stage-3 form through the spec repository;
 * targets never change.
 */
export function normalizeReferences(kind: string, id: string): boolean {
  // Step 1.
  return normalizeSpecReferences(kind, id);
}
