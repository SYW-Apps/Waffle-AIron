import * as fs from 'fs';
import * as path from 'path';
import {
  saveSystemSpec,
  saveSpec,
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
  loadTypeSpecs,
  resolveSubsystemExports,
  // The member moves (moveMountToMembers, normalizeReferences) read the graph
  // and write through the spec repository's two maintenance writes.
  graph,
  deleteMount,
  normalizeReferences as normalizeSpecReferences,
  rewriteReferences as rewriteSpecReferences,
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
import { admits, declaredMembers, effectiveProjectId, memberDeclarationOf, requiredPolicies, EXTERNAL_ALIAS_RE, type InternalizeDestination, type MemberDeclaration, type PackRequirement, type PackSelection, type ProjectConfig } from '../models/project.js';
// extension_orchestrator: the installed packs a member's required packs are pinned from.
import { listInstalledPacks } from './extensions.js';
import type { InstalledPack } from './packstore.js';
import { isNewerVersion } from '../utils/version.js';
import { rekeyAnchor, type CarriedRekey, type IdentityRename } from '../models/identity-rename.js';
import {
  SpecIdSchema,
  PUBLIC_NAME_RE,
  nameKey,
  type ComponentSpec,
  type ImplementationSpec,
  type InterfaceSpec,
  type ProjectFamily,
  type ReferenceEdit,
  type SubsystemSpec,
  type SystemSpec,
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
 * member_creation — what creating a member wrote about packs: whether this call
 * created the member's configuration (only then were requirements scaffolded),
 * the selections written into it, the requirements nothing installed satisfies,
 * and the projectType written.
 */
export interface MemberCreation {
  configCreated: boolean;
  adopted: PackSelection[];
  unadopted: PackRequirement[];
  projectType?: string;
}

/** True for a source a fresh machine or CI runner could fetch. */
const FETCHABLE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Step 11 of createMember: each requirement pinned to the highest installed
 * version its range admits — the selection `pack use --pin` records — or
 * collected as unadopted; the required profile as the projectType when exactly
 * one adopted requirement names one.
 */
function scaffoldRequirements(requirements: PackRequirement[], installed: InstalledPack[]): Omit<MemberCreation, 'configCreated'> {
  const adopted: PackSelection[] = [];
  const unadopted: PackRequirement[] = [];
  const profiles: string[] = [];
  for (const requirement of requirements) {
    let best: InstalledPack | null = null;
    for (const pack of installed) {
      if (pack.name !== requirement.pack || !admits(requirement, pack.version)) continue;
      if (!best || isNewerVersion(best.version, pack.version)) best = pack;
    }
    if (!best) {
      unadopted.push(requirement);
      continue;
    }
    adopted.push({
      name: best.name,
      version: best.version,
      integrity: best.digest,
      ...(best.origin && FETCHABLE_RE.test(best.origin) ? { source: best.origin } : {}),
    });
    if (requirement.profile) profiles.push(requirement.profile);
  }
  return { adopted, unadopted, ...(profiles.length === 1 ? { projectType: profiles[0] } : {}) };
}

/**
 * core_orchestrator.createMember — create a member of the bound project:
 * scaffold its project (configuration declaring the alias as its project id,
 * L0) at the path, each part only when absent, then declare it in `members`.
 * When it creates the member's configuration it also writes the bound
 * project's required packs into it once, each pinned to the highest installed
 * version its range admits; a requirement nothing installed satisfies is
 * returned as unadopted. Afterwards the selections are the member's own.
 */
export function createMember(alias: string, path: string, description?: string): MemberCreation {
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
  // Step 6: the declaring project's own requirements — nothing above it is read.
  const requirements = requiredPolicies(projectConfigRepository.load() ?? {});
  // A bootstrapped L0's vision: the description given, else one line naming
  // the member of this project.
  const parentName = loadSystemSpec()?.name;
  const vision = description ?? `Member ${alias} of ${parentName ? `the ${parentName} project` : 'its parent project'}`;
  // Steps 7-15: scoped to the member, complete only what is missing.
  const creation = runWithProjectRoot(memberDir, (): MemberCreation => {
    ensureDir(aiPathsAt(memberDir).specsDir());
    // Steps 8-9: an existing configuration is the member's own and is never given selections.
    if (projectConfigRepository.exists()) {
      ensureProjectInitialized(alias, alias, vision);
      return { configCreated: false, adopted: [], unadopted: [] };
    }
    // Steps 10-11: the requirements, scaffolded once from what is installed.
    const scaffold = scaffoldRequirements(requirements, listInstalledPacks());
    // Step 12: the member's configuration, carrying the scaffolded selections.
    const name = loadSystemSpec()?.name ?? alias;
    const config = defaultProjectConfig(name, new Date().toISOString(), alias);
    projectConfigRepository.create({
      ...config,
      ...(scaffold.projectType ? { projectType: scaffold.projectType } : {}),
      ...(scaffold.adopted.length > 0 ? { extensions: { packs: scaffold.adopted, useGlobalPacks: false } } : {}),
    });
    // Steps 13-14: an L0 only for a member that has none.
    ensureProjectInitialized(alias, alias, vision);
    return { configCreated: true, ...scaffold };
  });
  // Step 16: declare it in `members`; an equal declaration writes nothing and
  // a different one under the alias is refused.
  projectConfigRepository.declareMember(alias, {
    path: relPath,
    ...(description !== undefined ? { description } : {}),
  });
  invalidateSpecCache();
  // Step 17: member declared and its project ensured; what was scaffolded.
  return creation;
}

/**
 * core_orchestrator.declareMember — declare an EXISTING project as a member of
 * the bound project: the write behind `member attach` and `member adopt`,
 * which scaffold nothing (createMember scaffolds). The containment guard comes
 * first — a path that does not resolve strictly within the bound root,
 * lexically or through a link, is refused — and the Repository refuses a
 * malformed alias, an alias `externals` holds, or one already holding a
 * different member; the same one again writes nothing. Returns whether it wrote.
 */
export function declareMember(alias: string, declaration: MemberDeclaration): boolean {
  // Steps 1-2: the containment guard.
  const relPath = toPosixPath(declaration.path);
  const root = getProjectRoot();
  const memberDir = assertContainedProjectPath(root, relPath);
  if (path.resolve(memberDir) === path.resolve(root)) {
    throw new WaironError(`Refusing to declare the member "${alias}": its path "${relPath}" is the project root itself — a member path must resolve within the project root.`);
  }
  // Step 3.
  return projectConfigRepository.declareMember(alias, { ...declaration, path: relPath });
}

/**
 * core_orchestrator.rewriteReferences — respell references at parsed positions
 * of one spec of the family through the spec repository: each edit replaces
 * exactly its text at exactly its position, and the whole spec is refused,
 * writing nothing, when an edit's text is not there. Returns whether the
 * stored text changed.
 */
export function rewriteReferences(kind: string, id: string, edits: ReferenceEdit[]): boolean {
  // Step 1.
  return rewriteSpecReferences(kind, id, edits);
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
  // Step 4: a legacy declaration moves into `members` first.
  if (member.mountForm === 'mount') {
    // Steps 5-6: never when the mount carries a field the move cannot carry.
    const carried = mountFieldsBeyondPath(member.legacyMount);
    if (carried.length > 0) {
      throw new WaironError(
        `Refusing to move the member "${alias}": its legacy L1 mount carries ${carried.join(', ')}, which a move cannot carry `
        + 'and never drops. Run `wairon doctor --fix` — its chaining migration carries them into the member plan-first — then move it.',
      );
    }
    // Steps 7-8.
    moveMountToMembers(alias);
  }
  // Step 9: relocate the directory under the containment guard.
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
  // Step 10: point the `members` entry at the new path.
  projectConfigRepository.setMemberPath(alias, nextPath);
  invalidateSpecCache();
}

/**
 * The fields of a legacy mount beyond its path and description that its member
 * would have to hold — each named once, empty when a move loses nothing.
 */
function mountFieldsBeyondPath(mount: SubsystemSpec | null): string[] {
  if (!mount) return [];
  const out: string[] = [];
  if (mount.publicInterfaces.length > 0) out.push('publicInterfaces');
  if (mount.trustedLinks.length > 0) out.push('trustedLinks');
  if ((mount.lint?.allow ?? []).length > 0) out.push('lint');
  for (const field of ['lifecycle', 'profile', 'targetLanguage', 'designDepth', 'ext'] as const) {
    const value = mount[field];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0)) out.push(field);
  }
  return out;
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
  // member by its alias — the same text, restated.
  restateReExports(subsystemId, subsystemId);
  // Steps 11-12: what each side's references now need to pass the owner's
  // gate — the exports of what crosses the boundary, and a `use` import for
  // each bare type name (inside a union, too) the other side now owns.
  declareBoundaryCrossings(memberDir, memberKey, subsystemId, parentId);
  invalidateSpecCache();
  // Step 13.
}

/** A key's local id within its project. */
function localIn(key: string, project: string): string {
  return project && key.startsWith(`${project}::`) ? key.slice(project.length + 2) : key;
}

/**
 * Steps 11-12 of externalizeSubsystem: read the graph from the parent and, for
 * every reference that crosses the new boundary, declare what the owner's gate
 * needs to resolve it on each side. A reference into the other project that
 * names no public name of it is exported there — a type through its own
 * subsystem and the project's L0, a component the subsystem already exports
 * through the L0 (one it does not export stays reported: making a component
 * public is a design decision, never a move's side effect). A bare type name
 * the moving side no longer owns — the parent's union members among them — is
 * imported by name (`use`) from the side that owns it now, and exported there.
 */
function declareBoundaryCrossings(memberDir: string, memberKey: string, alias: string, parentId: string | null): void {
  invalidateSpecCache();
  const family = graph();
  const types = loadTypeSpecs();
  const needs = new Map<string, Set<string>>([['', new Set()], [memberKey, new Set()]]);
  const imports = new Map<string, Set<string>>([['', new Set()], [memberKey, new Set()]]);
  for (const ref of family.authoredReferences) {
    const owner = family.owners.get(ref.specId) ?? '';
    if (owner !== '' && owner !== memberKey) continue;
    const other = owner === '' ? memberKey : '';
    if (ref.producer === other && ref.binding === 'unexported') needs.get(other)!.add(ref.resolved);
    if (ref.form !== 'import' || ref.binding !== 'unresolved' || ref.position !== 'type') continue;
    const owned = types.find((t) => (family.owners.get(t.id) ?? '') === other && nameKey(localIn(t.id, other)) === nameKey(ref.authored));
    if (!owned || !PUBLIC_NAME_RE.test(localIn(owned.id, other))) continue;
    needs.get(other)!.add(owned.id);
    imports.get(owner)!.add(localIn(owned.id, other));
  }
  // Step 11: the exports, each side under its own root.
  exportItems([...needs.get('')!]);
  runWithProjectRoot(memberDir, () => exportItems([...needs.get(memberKey)!].map((k) => localIn(k, memberKey))));
  // Step 12: the `use` imports — the parent imports from its member, the
  // member from the parent it declares as an external.
  if (imports.get('')!.size > 0) projectConfigRepository.importNames(alias, [...imports.get('')!]);
  if (imports.get(memberKey)!.size > 0 && parentId !== null) {
    projectConfigRepositoryAt(memberDir).importNames(parentId, [...imports.get(memberKey)!]);
  }
}

/**
 * Export each local id of the bound project that crosses the boundary: a type
 * through its subsystem (as its own) and the L0; a component its subsystem
 * already exports through the L0. Each entry is added only when missing, at
 * the audience a family sees (`project`).
 */
function exportItems(ids: string[]): void {
  if (ids.length === 0) return;
  invalidateSpecCache();
  const system = loadSystemSpec();
  if (!system) return;
  const entries = [...(system.publicInterfaces ?? [])] as { from?: string; component?: string; typeDef?: string; audience?: string }[];
  const types = loadTypeSpecs();
  for (const id of ids) {
    if (!PUBLIC_NAME_RE.test(id)) continue;
    const type = types.find((t) => t.id === id);
    if (type) {
      if (type.subsystem) exportTypeFromSubsystem(type.subsystem, id);
      if (!entries.some((e) => e.typeDef === id && e.from === undefined)) entries.push({ typeDef: id, audience: 'project' });
      continue;
    }
    const component = loadComponentSpec(id);
    if (!component) continue;
    const exported = resolveSubsystemExports(component.subsystem).entries.some((e) => e.kind === 'component' && e.component === id);
    if (exported && !entries.some((e) => e.component === id)) entries.push({ from: component.subsystem, component: id, audience: 'project' });
  }
  if (entries.length !== (system.publicInterfaces ?? []).length) {
    saveSystemSpec({ ...system, publicInterfaces: entries as typeof system.publicInterfaces });
  }
}

/** A type exported as its own by the subsystem that owns it, when it is not already. */
function exportTypeFromSubsystem(subsystemId: string, typeId: string): void {
  const sub = loadSubsystemSpec(subsystemId);
  if (!sub || sub.publicInterfaces.some((pi) => pi.typeDef === typeId && pi.from === undefined)) return;
  saveSpec('subsystem', { ...sub, publicInterfaces: [...sub.publicInterfaces, { typeDef: typeId }] });
}

/**
 * internalize_result — what internalizing a member did with each thing the
 * member held: the subsystems and types it moved, where each piece of the
 * member's own metadata went, the externals the parent now declares, and every
 * file deleted — so no part of the member's .wai disappears unlisted.
 */
export interface InternalizeResult {
  subsystems: string[];
  types: string[];
  placed: string[];
  externals: string[];
  deleted: string[];
}

/** The member's .wai entries this write knows, by the group its deleted list names them under. */
const MEMBER_WAI_GROUPS: ReadonlyMap<string, string> = new Map([
  ['project.yaml', 'project.yaml'],
  ['lock.json', 'lock'],
  ['externals.lock.yaml', 'pins and snapshots'],
  ['externals', 'pins and snapshots'],
  ['surfaces', 'legacy surfaces'],
  ['agents', 'derived outputs'],
  ['context', 'derived outputs'],
  ['docs', 'derived outputs'],
  ['generated', 'derived outputs'],
  ['rules', 'derived outputs'],
  ['templates', 'derived outputs'],
  ['topology.yaml', 'derived outputs'],
]);

/** A member of the bound root as internalize reads it, before anything moves. */
interface InternalizeScan {
  alias: string;
  member: ProjectFamily['nodes'][number];
  memberDir: string;
  config: ProjectConfig | null;
  system: SystemSpec | null;
  subsystems: string[];
  types: string[];
  home: string;
  parentId: string | undefined;
}

/**
 * core_orchestrator.internalizeMember — fold a member back into the bound
 * project, whole: every subsystem and project-level type moves under the bound
 * project's specs, and each piece of the member's own metadata goes to a home
 * instead of being deleted — its L0 vision onto the home subsystem, its L0
 * requirements into the bound L0, its language, profile and depth onto the
 * moved subsystems, its members and externals into the bound configuration,
 * its packs adopted or dropped as the destination says, and the destination's
 * exports as re-exports from the moved subsystems. What has no home (its lock,
 * pins, derived outputs) is deleted and listed. Every refusal is found before
 * anything moves. Pins of the carried externals and references from OTHER
 * family projects are the family migration's, never this write's.
 */
export function internalizeMember(alias: string, destination: InternalizeDestination): InternalizeResult {
  // Step 1: the graph of the bound root.
  const family = graph();
  const member = family.nodes.find((n) => n.parent === '' && n.mountAlias === alias);
  // Steps 2-3.
  if (!member) {
    throw new WaironError(`cannot internalize: no member is declared under that alias ("${alias}").`);
  }
  // Steps 4-7: the home and the member's configuration.
  const scan = scanMember(family, alias, member, destination);
  // Steps 8-10: every refusal before anything moves.
  const refusals = internalizeRefusals(scan, destination);
  if (refusals.length > 0) {
    throw new WaironError(`cannot internalize "${alias}": the member cannot be taken in whole — ${refusals.join('; ')}.`);
  }
  const result: InternalizeResult = { subsystems: scan.subsystems, types: scan.types, placed: [], externals: [], deleted: [] };
  // What crosses the old boundary, read BEFORE anything moves.
  const intoMember = crossingReferences(family, '', member.namespace);
  const backOut = crossingReferences(family, member.namespace, '');
  // Step 11: a legacy mount document goes first, so a moved subsystem can take its folder.
  deleteMount(alias);
  // Step 12: every subsystem and project-level type moves in.
  const rewritten = moveMemberSpecs(scan, (ref) => intoMember.get(ref) ?? backOut.get(ref) ?? ref);
  // Step 13: what the member held for its subsystems.
  placeOnSubsystems(scan, result);
  // Step 14: what it held as a project, into the bound L0.
  placeOnSystem(scan, destination, result);
  // Steps 15-17: its members and externals.
  carryDeclarations(scan, result);
  // Steps 18-19: its packs.
  carryPacks(scan, destination, result);
  // Step 20: the member leaves `members` (false for a legacy declaration).
  projectConfigRepository.removeMember(alias);
  // Step 21: what remains of its .wai, each file listed.
  result.deleted = deleteMemberWai(scan.memberDir);
  invalidateSpecCache();
  // Step 22: every spec that referenced across the old boundary, re-saved.
  for (const spec of rewritten) if (spec.kind !== 'system') normalizeSpecReferences(spec.kind, spec.id);
  invalidateSpecCache();
  // Step 23.
  return result;
}

/** Steps 4-7: the member's subsystems and types, its home, its L0 and its configuration. */
function scanMember(family: ProjectFamily, alias: string, member: ProjectFamily['nodes'][number], destination: InternalizeDestination): InternalizeScan {
  const root = getProjectRoot();
  const memberDir = assertContainedProjectPath(root, path.relative(root, member.directory) || '.');
  const local = (key: string): string => localIn(key, member.namespace);
  const subsystems = loadSubsystemSpecs().filter((s) => family.owners.get(s.id) === member.namespace).map((s) => local(s.id));
  const types = loadTypeSpecs().filter((t) => family.owners.get(t.id) === member.namespace && !t.subsystem).map((t) => local(t.id));
  const system = runWithProjectRoot(memberDir, () => loadSystemSpec());
  // Step 4: the home it names, else the member's only subsystem.
  const named = destination.home ?? '';
  const home = named !== '' ? named : subsystems.length === 1 ? subsystems[0] : '';
  // Steps 5-6.
  const own = new Set(loadSubsystemSpecs().filter((s) => (family.owners.get(s.id) ?? '') === '' && !s.projectPath).map((s) => s.id));
  if ((home !== '' && !subsystems.includes(home) && !own.has(home)) || (home === '' && saysMoreThanItsName(system))) {
    throw new WaironError(
      `cannot internalize "${alias}": the member's metadata needs a home subsystem (--into) — `
      + `${home === '' ? 'none was named' : `"${home}" is no subsystem of the member or of this project`}; the member's subsystems are ${subsystems.join(', ') || 'none'}.`,
    );
  }
  // Step 7: its configuration, read under its own binding.
  const config = runWithProjectRoot(memberDir, () => {
    try {
      return projectConfigRepository.load();
    } catch {
      return null;
    }
  });
  const parentId = family.nodes.find((n) => n.namespace === '')?.id;
  return { alias, member, memberDir, config, system, subsystems, types, home, parentId };
}

/**
 * Whether a member's L0 says anything a home must keep: a vision beyond its
 * own name. The vision a scaffold wrote from names alone — externalize's
 * `Core vision for <name>`, createMember's `Member <alias> of …` — says
 * nothing more than the names do.
 */
function saysMoreThanItsName(system: SystemSpec | null): boolean {
  const vision = system?.vision?.trim() ?? '';
  const name = system?.name.trim() ?? '';
  const scaffolded = vision === bootstrapSystemSpec(name, '').vision || /^Member [a-z0-9_-]+ of (?:the .+ project|its parent project)$/.test(vision);
  return vision !== '' && vision !== name && !scaffolded;
}

/** Step 8: every reason the member cannot be taken in whole, each named. */
function internalizeRefusals(scan: InternalizeScan, destination: InternalizeDestination): string[] {
  const out: string[] = [];
  const bound = projectConfigRepository.load() ?? ({} as ProjectConfig);
  const specsDir = aiPathsAt(getProjectRoot()).specsDir();
  const memberSpecs = aiPathsAt(scan.memberDir).specsDir();
  // A moved spec file landing on an existing one.
  const skip = path.resolve(aiPathsAt(scan.memberDir).specsSystem());
  const taken = (fs.existsSync(memberSpecs) ? listFilesRecursive(memberSpecs, '') : [])
    .filter((f) => path.resolve(f) !== skip && fs.existsSync(path.join(specsDir, path.relative(memberSpecs, f))))
    .map((f) => toPosixPath(path.relative(memberSpecs, f)));
  if (taken.length > 0) out.push(`its specs would land on this project's ${taken.join(', ')}`);
  // A carried alias declared differently here.
  out.push(...aliasConflicts(scan, bound));
  // A pack only the member selects, with no adopt or drop.
  if (destination.packs === undefined) {
    for (const pack of memberOnlyPacks(scan.config, bound)) out.push(`it selects the pack ${pack}, which this project does not — say --packs adopt or --packs drop`);
  }
  // Conformance debt, or severity overrides this project does not share.
  const carried = scan.config?.rules?.conformance?.carried ?? [];
  if (carried.length > 0) out.push(`it carries conformance debt (${carried.length} group(s) in rules.conformance.carried) — pay it or move it first`);
  const mine = bound.rules?.sddRuleSeverity ?? {};
  for (const [code, severity] of Object.entries(scan.config?.rules?.sddRuleSeverity ?? {})) {
    if (mine[code] !== severity) out.push(`it overrides ${code} to ${severity}, which this project does not`);
  }
  // A destination export colliding with a public name this project exports for another target.
  const exported = resolveSubsystemExportsOfProject();
  for (const name of destination.exports ?? []) {
    const held = exported.get(name);
    if (held !== undefined && held !== scan.alias) out.push(`the export "${name}" is a public name this project already exports for ${held}`);
  }
  // A file of the member's .wai this write does not recognise.
  const wai = path.join(scan.memberDir, '.wai');
  for (const entry of fs.existsSync(wai) ? fs.readdirSync(wai) : []) {
    if (entry === 'specs' || entry === 'transactions' || MEMBER_WAI_GROUPS.has(entry)) continue;
    out.push(`its .wai holds "${entry}", which this write does not recognise — move or delete it by hand`);
  }
  return out;
}

/** The public names the bound L0 exports, each with the alias or subsystem it re-exports from. */
function resolveSubsystemExportsOfProject(): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of (loadSystemSpec()?.publicInterfaces ?? []) as { from?: string; as?: string; component?: string; typeDef?: string }[]) {
    const name = e.as ?? e.component ?? e.typeDef;
    if (name) out.set(name, e.from ?? '');
  }
  return out;
}

/** Each member or external of the member whose alias this project declares for another project. */
function aliasConflicts(scan: InternalizeScan, bound: ProjectConfig): string[] {
  const out: string[] = [];
  for (const m of declaredMembers(scan.config ?? ({} as ProjectConfig))) {
    if (m.alias === scan.alias) continue;
    const here = bound.members?.[m.alias] ?? bound.externals?.[m.alias];
    const dir = path.resolve(scan.memberDir, m.path);
    const same = bound.members?.[m.alias] !== undefined && path.resolve(getProjectRoot(), memberDeclarationOf(bound.members[m.alias]).path) === dir;
    if (here !== undefined && !same) out.push(`its member "${m.alias}" is an alias this project already declares for another project`);
  }
  for (const [a, decl] of Object.entries(scan.config?.externals ?? {})) {
    if (carriedExternal(scan, a, decl) === 'parent') continue;
    const producer = decl.project ?? a;
    const member = bound.members?.[a];
    const external = bound.externals?.[a];
    if (member !== undefined && a !== scan.alias && memberIdAt(memberDeclarationOf(member).path) !== producer) {
      out.push(`its external "${a}" is a member alias this project declares for another project`);
    }
    if (external !== undefined && (external.project ?? a) !== producer) out.push(`its external "${a}" names "${producer}", which this project declares as "${external.project ?? a}"`);
  }
  return out;
}

/** The effective id of the project at a member path of the bound root, when it has one. */
function memberIdAt(memberPath: string): string | undefined {
  const config = configAt(path.resolve(getProjectRoot(), memberPath));
  return config ? effectiveProjectId(config) ?? undefined : undefined;
}

/** How one of the member's externals is carried: the parent itself (dropped), or carried. */
function carriedExternal(scan: InternalizeScan, alias: string, decl: { project?: string }): 'parent' | 'carried' {
  return scan.parentId !== undefined && (decl.project ?? alias) === scan.parentId ? 'parent' : 'carried';
}

/** The member's pack selections this project does not select at the same version, as name@version. */
function memberOnlyPacks(config: ProjectConfig | null, bound: ProjectConfig): string[] {
  const mine = (bound.extensions?.packs ?? []).filter((p): p is PackSelection => typeof p !== 'string');
  return (config?.extensions?.packs ?? []).filter((p): p is PackSelection => typeof p !== 'string')
    .filter((p) => !mine.some((q) => q.name === p.name && (q.version ?? '') === (p.version ?? '')))
    .map((p) => `${p.name}${p.version ? `@${p.version}` : ''}`);
}

/** Step 12: move the member's specs in, keys local, file paths re-expressed; the references that crossed re-expressed. */
function moveMemberSpecs(scan: InternalizeScan, remap: (ref: string) => string): RewrittenSpec[] {
  const parentRoot = getProjectRoot();
  const parentSpecsDir = aiPathsAt(parentRoot).specsDir();
  const memberSpecsDir = aiPathsAt(scan.memberDir).specsDir();
  const movedFiles = moveTreeInto(memberSpecsDir, parentSpecsDir, new Set([path.resolve(aiPathsAt(scan.memberDir).specsSystem())]));
  rebaseImplementationPaths(parentSpecsDir, scan.memberDir, parentRoot, movedFiles);
  const parentSystemName = loadSystemSpec()?.name;
  for (const sub of scan.subsystems) {
    patchSubsystemIndex(path.join(parentSpecsDir, sub, '.index.yaml'), (s) => {
      if (parentSystemName) s.parentSystem = parentSystemName;
      delete s.projectPath;
    });
  }
  const rewritten = rewriteRefFields(parentSpecsDir, remap);
  invalidateSpecCache();
  return rewritten;
}

/** Step 13: the L0 vision onto the home, and the language, profile and depth onto each moved subsystem that states none. */
function placeOnSubsystems(scan: InternalizeScan, result: InternalizeResult): void {
  const boundSystem = loadSystemSpec();
  const bound = projectConfigRepository.load();
  const stamps: [string, string | undefined, string | undefined][] = [
    ['targetLanguage', scan.system?.targetLanguage, boundSystem?.targetLanguage],
    ['profile', scan.config?.projectType, bound?.projectType],
    ['designDepth', scan.config?.rules?.designDepth, bound?.rules?.designDepth],
  ];
  const stamped = new Map<string, string[]>();
  for (const id of scan.subsystems) {
    const sub = loadSubsystemSpec(id);
    if (!sub) continue;
    const next: Record<string, unknown> = { ...sub };
    for (const [field, value, boundValue] of stamps) {
      if (value === undefined || value === boundValue || next[field] !== undefined) continue;
      next[field] = value;
      stamped.set(`${field} ${value}`, [...(stamped.get(`${field} ${value}`) ?? []), id]);
    }
    if (Object.keys(next).length !== Object.keys(sub).length) saveSpec('subsystem', next as SubsystemSpec);
  }
  for (const [what, ids] of stamped) result.placed.push(`${what} → ${ids.join(', ')}`);
  if (!saysMoreThanItsName(scan.system)) return;
  const home = loadSubsystemSpec(scan.home);
  if (!home) return;
  const paragraph = `From the member project "${scan.alias}" (${scan.system!.name}): ${scan.system!.vision.trim()}`;
  if (!home.description.includes(paragraph)) {
    saveSpec('subsystem', { ...home, description: home.description ? `${home.description}\n\n${paragraph}` : paragraph });
  }
  result.placed.push(`L0 vision → ${scan.home} description`);
}

/** Step 14: requirements, boundaries and databases merged by identity; re-exports re-pointed; the destination's exports added. */
function placeOnSystem(scan: InternalizeScan, destination: InternalizeDestination, result: InternalizeResult): void {
  const system = loadSystemSpec();
  if (!system) return;
  const next = { ...system } as SystemSpec;
  const merge = <T>(field: 'boundaries' | 'globalRequirements' | 'databases', key: (item: T) => string): void => {
    const held = (next[field] ?? []) as unknown as T[];
    const theirs = ((scan.system?.[field] ?? []) as unknown as T[]).filter((item) => !held.some((h) => key(h) === key(item)));
    if (theirs.length === 0) return;
    (next as unknown as Record<string, T[]>)[field] = [...held, ...theirs];
    result.placed.push(`${field} (${theirs.length}) → parent L0`);
  };
  // A boundary or requirement may be written as a bare string or an object: its identity is its name or its text.
  const identity = (field: string) => (item: unknown): string => (typeof item === 'string' ? item : String((item as Record<string, unknown>)[field] ?? ''));
  merge<unknown>('boundaries', identity('name'));
  merge<unknown>('globalRequirements', identity('description'));
  merge<unknown>('databases', identity('id'));
  // The re-exports of the member, re-pointed at the moved subsystems; the destination's exports added.
  const entries = (next.publicInterfaces ?? []) as ExportEntry[];
  const memberEntries = (scan.system?.publicInterfaces ?? []) as ExportEntry[];
  const repointed = entries.flatMap((e) => (e.from === scan.alias ? reExportsOf(e, memberEntries) : [e]));
  for (const name of destination.exports ?? []) {
    const source = memberEntries.find((e) => publicNameOf(e) === name);
    if (!source) throw new WaironError(`cannot internalize "${scan.alias}": the export "${name}" is no public name of the member.`);
    const entry = movedEntry(source);
    if (!repointed.some((e) => publicNameOf(e) === name)) {
      repointed.push(entry);
      result.placed.push(`export ${name} → parent L0 (from ${entry.from ?? 'the project'})`);
    }
  }
  next.publicInterfaces = repointed as SystemSpec['publicInterfaces'];
  if (JSON.stringify(next) !== JSON.stringify(system)) saveSystemSpec(next);
}

/** One L0 export entry as written. */
type ExportEntry = { from?: string; as?: string; component?: string; interface?: string; typeDef?: string; audience?: string; [k: string]: unknown };

const publicNameOf = (e: ExportEntry): string | undefined => e.as ?? e.component ?? e.typeDef;

/** A member's L0 entry as the parent writes it once the member's subsystems are its own: from the subsystem realizing it. */
function movedEntry(e: ExportEntry): ExportEntry {
  if (e.from !== undefined) return { ...e };
  const component = e.component !== undefined ? loadComponentSpec(e.component) : null;
  if (component) return { ...e, from: component.subsystem };
  const type = e.typeDef !== undefined ? loadTypeSpecs().find((t) => t.id === e.typeDef) : undefined;
  return type?.subsystem ? { ...e, from: type.subsystem } : { ...e };
}

/** A parent entry re-exporting from the member, as re-exports from the moved subsystems. */
function reExportsOf(e: ExportEntry, memberEntries: ExportEntry[]): ExportEntry[] {
  const named = e.component ?? e.typeDef;
  const matches = named === undefined ? memberEntries : memberEntries.filter((m) => publicNameOf(m) === named);
  return matches.map((m) => {
    const moved = movedEntry(m);
    const component = moved.component;
    const typeDef = moved.typeDef;
    return {
      ...e,
      ...(moved.from !== undefined ? { from: moved.from } : { from: undefined }),
      ...(component !== undefined ? { component } : {}),
      ...(typeDef !== undefined ? { typeDef } : {}),
      ...(e.as === undefined && publicNameOf(m) !== (component ?? typeDef) ? { as: publicNameOf(m) } : {}),
    };
  }).map((x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as ExportEntry);
}

/** Steps 15-17: the member's members and externals, declared here; the `use` each external carried, imported. */
function carryDeclarations(scan: InternalizeScan, result: InternalizeResult): void {
  const root = getProjectRoot();
  for (const m of declaredMembers(scan.config ?? ({} as ProjectConfig))) {
    if (m.problem) continue;
    const relPath = toPosixPath(path.relative(root, path.resolve(scan.memberDir, m.path)));
    projectConfigRepository.declareMember(m.alias, {
      path: relPath,
      ...(m.description !== undefined ? { description: m.description } : {}),
      ...(m.use.length > 0 ? { use: m.use } : {}),
    });
    result.placed.push(`member ${m.alias} → parent members as ${m.alias} (${relPath})`);
  }
  const bound = projectConfigRepository.load() ?? ({} as ProjectConfig);
  for (const [alias, decl] of Object.entries(scan.config?.externals ?? {})) {
    if (carriedExternal(scan, alias, decl) === 'parent') continue;
    const source = decl.source && !path.isAbsolute(decl.source.path)
      ? { path: toPosixPath(path.relative(root, path.resolve(scan.memberDir, decl.source.path))) }
      : decl.source;
    if (bound.members?.[alias] === undefined) {
      projectConfigRepository.declareExternal(alias, {
        ...(decl.project !== undefined ? { project: decl.project } : {}),
        ...(source ? { source } : {}),
        ...(decl.description !== undefined ? { description: decl.description } : {}),
      });
      result.externals.push(alias);
    }
    // Step 17: the names its `use` held, so the moved specs' bare names still resolve.
    if ((decl.use ?? []).length > 0) projectConfigRepository.importNames(alias, decl.use!);
    result.placed.push(`external ${alias} → parent externals as ${alias}`);
  }
}

/** Steps 18-19: each pack only the member selects, adopted (pinned at its version and digest) or dropped. */
function carryPacks(scan: InternalizeScan, destination: InternalizeDestination, result: InternalizeResult): void {
  const bound = projectConfigRepository.load() ?? ({} as ProjectConfig);
  const only = memberOnlyPacks(scan.config, bound);
  const selections = (scan.config?.extensions?.packs ?? []).filter((p): p is PackSelection => typeof p !== 'string');
  for (const label of only) {
    const selection = selections.find((p) => `${p.name}${p.version ? `@${p.version}` : ''}` === label)!;
    if (destination.packs === 'adopt') {
      projectConfigRepository.upsertPackSelection(selection);
      result.placed.push(`pack ${label} adopted`);
    } else {
      result.placed.push(`pack ${label} dropped`);
    }
  }
}

/** Step 21: delete what remains of the member's .wai, every file listed under its group. */
function deleteMemberWai(memberDir: string): string[] {
  const wai = path.join(memberDir, '.wai');
  if (!fs.existsSync(wai)) return [];
  const deleted = listFilesRecursive(wai, '')
    .filter((f) => !path.relative(wai, f).split(path.sep).includes('transactions'))
    .map((f) => {
      const rel = toPosixPath(path.relative(wai, f));
      // What is left under specs/ once its subsystems and types moved is its L0, whose pieces were placed above.
      return `${MEMBER_WAI_GROUPS.get(rel.split('/')[0]) ?? 'L0 (its pieces placed)'}: .wai/${rel}`;
    });
  for (const entry of fs.readdirSync(wai)) {
    if (entry !== 'transactions') fs.rmSync(path.join(wai, entry), { recursive: true, force: true });
  }
  if (fs.readdirSync(wai).length === 0) fs.rmdirSync(wai);
  return deleted.sort();
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
