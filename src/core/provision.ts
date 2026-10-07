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
  loadTypeSpec,
  getTypePath,
  deleteSpec,
  scanAllSpecs,
  specIndexRetiredBy,
  resolveSubsystemExports,
  resolveProjectExports,
  getSubsystemPath,
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
  // The ONE type-expression position table, and the token respelling inside a type string.
  typeExpressionSlots,
  respellTypeNames,
  type RefPosition,
  type SpecRefKind,
  type WritableSpecKind,
  assertSpecsInReach,
  signatureFacts,
} from './specs.js';
import { aiPathsAt } from '../config/paths.js';
// git_source_adapter (stage 8): a git member's commit resolved and fetched.
import * as gitSource from './adapters/git-source.js';
import { projectConfigRepository, projectConfigRepositoryAt } from '../config/project-config.js';
import { getProjectRoot, runWithProjectRoot, ensureDir, listFilesRecursive } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { WaironError } from '../utils/errors.js';
import { admits, declaredMembers, DesignDepthSchema, methodCasingFor, readExternalSource, type ExternalSource, effectiveProjectId, memberLocationOf, parseMemberSource, requiredPolicies, EXTERNAL_ALIAS_RE, type InternalizeDestination, type MemberDeclaration, type MemberKind, type MemberStorage, type PackRequirement, type PackSelection, type ProjectConfig } from '../models/project.js';
// extension_orchestrator: the installed packs a member's required packs are pinned from.
import { listInstalledPacks, loadProjectExtensions } from './extensions.js';
// The built-in subsystem profiles, so internalize stamps only a profile a subsystem can hold.
import { BUILTIN_PROFILES } from './rules/types.js';
import type { InstalledPack } from './packstore.js';
import { isNewerVersion } from '../utils/version.js';
import { rekeyAnchor, type CarriedRekey, type IdentityRename } from '../models/identity-rename.js';
import {
  SpecIdSchema,
  PUBLIC_NAME_RE,
  SURFACE_AUDIENCES,
  nameKey,
  type ComponentSpec,
  type ImplementationSpec,
  type InterfaceSpec,
  type ProjectFamily,
  type ReferenceEdit,
  type SubsystemSpec,
  type SystemSpec,
  type TypeSpec,
  deriveMethodSignature,
  qualifiedTypeId,
  typeMatchesRef,
  parseDeclaredCall,
  transportKind,
  type Transport,
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

/** Whether an existing member directory holds a part: no id, no L0 and no lock (stage 8). */
function isPartDirectory(dir: string): boolean {
  return fs.existsSync(dir) && !holdsProjectContent(dir);
}

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
    // A part (stage 8) is no chained project: its subsystems are this root's
    // own, generated, briefed and backfilled with it — never as a root of its own.
    if (member.problem || member.path === undefined || isPartDirectory(path.resolve(dir, member.path))) continue;
    out.push({ alias: member.alias, path: member.path, form: 'members' });
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
  /** What was created (stage 8; a part by default). */
  as: MemberKind;
  /** Where its files live: contained, path or git, never hosted. */
  storage: MemberStorage;
  /** git: the commit the member was pinned at. */
  commit?: string;
}

/** True for a source a fresh machine or CI runner could fetch. */
const FETCHABLE_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Step 11 of createMember: each requirement pinned to the highest installed
 * version its range admits — the selection `pack use --pin` records — or
 * collected as unadopted; the required profile as the projectType when exactly
 * one adopted requirement names one.
 */
function scaffoldRequirements(requirements: PackRequirement[], installed: InstalledPack[]): Omit<MemberCreation, 'configCreated' | 'as' | 'storage'> {
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
 * core_orchestrator.createMember — create a member of the bound project at a
 * source in the members grammar (stage 8): a PART unless `as` is project —
 * boundaries are earned. A part gets its specs directory (and, stored outside
 * the project, a configuration holding only its PartOf); a project gets its
 * project content, each piece only when absent, with the bound project's
 * required packs written once. A git member is never scaffolded: it is pinned
 * at a commit and its content decides what it is. Then it is declared in
 * `members` by the shorthand.
 */
export function createMember(alias: string, source: string, description?: string, as?: string): MemberCreation {
  // Steps 1-2: guard the alias and the source.
  const written = typeof source === 'string' ? source.trim() : '';
  if (!EXTERNAL_ALIAS_RE.test(alias) || written === '') {
    throw new WaironError(
      `an alias and a path are required to create a member: the alias must fit [a-z0-9-_]+ (got "${alias}") and the source must not be empty.`,
    );
  }
  if (as !== undefined && as !== 'part' && as !== 'project') {
    throw new WaironError(`Refusing to create the member "${alias}": \`as: ${as}\` — a member is a part or a project.`);
  }
  const parsed = parseMemberSource(written);
  if (parsed.storage === 'hosted') {
    throw new WaironError(`Refusing to create the member "${alias}" at "${written}": a hosted record is made by hosted project creation, never here.`);
  }
  // Steps 6-9: a git member is only declared, at a commit.
  if (parsed.storage === 'git') return createGitMember(alias, parsed.source, description, as);
  if (parsed.problem) throw new WaironError(`Refusing to create the member "${alias}": ${parsed.problem}.`);
  // Step 3: the member directory, from the bound project root. Stored with
  // forward slashes so the configuration stays portable across platforms.
  const relPath = toPosixPath(written);
  // Steps 4-5: containment guard for a contained source — absolute,
  // inner-`..` and link-escaping paths are refused before anything is
  // scaffolded; a leading `../` is the explicit way out.
  const root = getProjectRoot();
  const memberDir = parsed.storage === 'contained' ? assertContainedProjectPath(root, relPath) : path.resolve(root, relPath);
  // Step 10: a part (the default) or a project?
  const created = as === 'project'
    ? { ...scaffoldMemberProject(alias, memberDir, description), as: 'project' as const }
    : { ...scaffoldPart(alias, memberDir, parsed.storage === 'contained'), as: 'part' as const };
  // Step 23: declare it by the shorthand — the long form only for a description.
  projectConfigRepository.declareMember(alias, { source: relPath, ...(description !== undefined ? { description } : {}) });
  invalidateSpecCache();
  // Step 24.
  return { ...created, storage: parsed.storage };
}

/** Whether a root holds a project's content: an id, an L0 or a lock (stage 8). */
function holdsProjectContent(dir: string): boolean {
  const paths = aiPathsAt(dir);
  if (fs.existsSync(paths.specsSystem()) || fs.existsSync(path.join(paths.root(), 'lock.json'))) return true;
  try {
    return projectConfigRepositoryAt(dir).load()?.id !== undefined;
  } catch {
    return false;
  }
}

/**
 * Step 22 of createMember: a part's specs directory and — stored outside the
 * project — a configuration holding only its PartOf. A directory already
 * holding a project is refused: adopting one is `member attach`.
 */
function scaffoldPart(alias: string, memberDir: string, contained: boolean): Omit<MemberCreation, 'as' | 'storage'> {
  if (holdsProjectContent(memberDir)) {
    throw new WaironError(`Refusing to create the part "${alias}": ${memberDir} already holds a project (an id, an L0 or a lock) — declare it with \`wairon member attach\`, or pass --project.`);
  }
  const root = getProjectRoot();
  ensureDir(aiPathsAt(memberDir).specsDir());
  let configCreated = false;
  if (!contained) {
    const parentId = effectiveProjectId(projectConfigRepository.load() ?? { name: loadSystemSpec()?.name ?? '' });
    if (parentId === null) throw new WaironError(`Refusing to create the part "${alias}" outside this project: it must name what it is a part of, and this project has no id. Declare one first (\`wairon id set\`).`);
    configCreated = runWithProjectRoot(memberDir, () => projectConfigRepository.setPartOf({ project: parentId, path: toPosixPath(path.relative(memberDir, root)) || '.' }));
  }
  return { configCreated, adopted: [], unadopted: [] };
}

/**
 * Steps 6-9 of createMember: a git member, never scaffolded — the commit given,
 * else the remote's default branch head, is resolved and fetched, and its
 * content decides what it is; `as` only asserts (a contradiction refuses).
 */
function createGitMember(alias: string, source: ExternalSource, description: string | undefined, as: string | undefined): MemberCreation {
  const url = source.git!;
  // Step 7: the commit — given, else the default branch head now.
  const commit = source.commit ?? gitSource.resolve(url, source.ref);
  // Step 8: fetched; the repository must already hold the member.
  const dir = gitSource.fetch(url, commit, source.dir);
  const kind = holdsProjectContent(dir) ? 'project' : 'part';
  if (as !== undefined && as !== kind) {
    throw new WaironError(`Refusing to add the git member "${alias}" as a ${as}: its content at ${commit} makes it a ${kind} — a git member is never scaffolded, so what it is follows from what the repository holds.`);
  }
  // Step 23: declared at the commit.
  projectConfigRepository.declareMember(alias, {
    source: `${url}#${commit}`,
    ...(source.ref !== undefined ? { ref: source.ref } : {}),
    ...(source.dir !== undefined ? { dir: source.dir } : {}),
    ...(description !== undefined ? { description } : {}),
  });
  invalidateSpecCache();
  return { configCreated: false, adopted: [], unadopted: [], as: kind, storage: 'git', commit };
}

/**
 * Steps 11-21 of createMember: a project member's content — its configuration
 * declaring the alias as its id (with the bound project's required packs,
 * once) and its L0 — each only when absent.
 */
function scaffoldMemberProject(alias: string, memberDir: string, description?: string): Omit<MemberCreation, 'as' | 'storage'> {
  // Step 11: the declaring project's own requirements — nothing above it is read.
  const requirements = requiredPolicies(projectConfigRepository.load() ?? {});
  // A bootstrapped L0's vision: the description given, else one line naming
  // the member of this project.
  const parentName = loadSystemSpec()?.name;
  const vision = description ?? `Member ${alias} of ${parentName ? `the ${parentName} project` : 'its parent project'}`;
  // Steps 7-15: scoped to the member, complete only what is missing.
  const creation = runWithProjectRoot(memberDir, (): Omit<MemberCreation, 'as' | 'storage'> => {
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
    // Steps 18-19: an L0 only for a member that has none.
    ensureProjectInitialized(alias, alias, vision);
    return { configCreated: true, ...scaffold };
  });
  // Step 20: the declaring project's scope is back.
  return creation;
}

/**
 * core_orchestrator.updateMember — change an existing member's declaration
 * through the project config Repository (stage 8): the write behind `doctor
 * --fix` rewriting a deprecated long-form `path` to the one location key, and
 * `member update` moving a git member's `#<commit>`. A contained source in the
 * changes is held to the containment guard. Never writes a kind: what a
 * member is follows from its content. Returns whether it wrote.
 */
export function updateMember(alias: string, changes: MemberDeclaration): boolean {
  // Step 1: the containment guard, on a contained path the changes carry.
  const location = memberLocationOf(changes);
  const contained = location !== undefined && parseMemberSource(location).storage === 'contained';
  if (contained) {
    const root = getProjectRoot();
    const resolved = path.resolve(root, location);
    let escapes = false;
    try {
      escapes = path.resolve(assertContainedProjectPath(root, toPosixPath(location))) === path.resolve(root);
    } catch {
      escapes = true;
    }
    // Step 4: a contained path outside the project root.
    if (escapes) throw new WaironError(`PROJECTPATH_ESCAPE: the member "${alias}" source "${location}" resolves to ${resolved}, outside the project root`);
  }
  // Steps 2-3: the write, through the Repository.
  return projectConfigRepository.updateMember(alias, changes);
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
  // Steps 1-2: the containment guard, for a contained source — a leading `../`
  // is the explicit way out, and a git or hosted source names no directory here.
  const location = memberLocationOf(declaration) ?? '';
  if (parseMemberSource(location).storage !== 'contained') {
    return projectConfigRepository.declareMember(alias, { ...declaration, path: undefined, source: location });
  }
  const relPath = toPosixPath(location);
  const root = getProjectRoot();
  const memberDir = assertContainedProjectPath(root, relPath);
  if (path.resolve(memberDir) === path.resolve(root)) {
    throw new WaironError(`Refusing to declare the member "${alias}": its path "${relPath}" is the project root itself — a member path must resolve within the project root.`);
  }
  // Step 3.
  return projectConfigRepository.declareMember(alias, { ...declaration, path: undefined, source: relPath });
}

/**
 * core_orchestrator.rewriteReferences — respell references at parsed positions
 * of one spec of the family through the spec repository: each edit replaces
 * exactly its text at exactly its position, and the whole spec is refused,
 * writing nothing, when an edit's text is not there. Returns whether the
 * stored text changed.
 */
export function rewriteReferences(kind: WritableSpecKind, id: string, edits: ReferenceEdit[]): boolean {
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
  // Step 1: the graph of the bound root — the member the alias declares: a
  // contained project member, or (stage 8) a part or a `../` sibling project member.
  const family = graph();
  const bound = family.nodes.find((n) => n.namespace === '');
  const declaredAs = declaredMembers(projectConfigRepository.load() ?? {}).find((m) => m.alias === alias);
  if (declaredAs?.storage === 'git' || declaredAs?.storage === 'hosted') {
    throw new WaironError(`Refusing to move the member "${alias}": it is ${declaredAs.storage === 'git' ? 'fetched from git — its files are the fetch cache\'s' : 'a hosted record'}; there is no directory of this project's to move.`);
  }
  const member = family.nodes.find((n) => n.parent === '' && n.mountAlias === alias)
    ?? (bound?.parts.some((p) => p.alias === alias) || bound?.externals.some((e) => e.role === 'member' && e.alias === alias)
      ? { mountForm: 'members' as const, legacyMount: null } : undefined);
  // Steps 2-3: guard that the alias declares a member.
  if (!member) {
    throw new WaironError(`no member is declared under that alias: the bound project declares no member "${alias}".`);
  }
  if (declaredAs?.storage === 'path') {
    moveSibling(alias, declaredAs.source.path ?? '', newPath, bound?.parts.some((p) => p.alias === alias) ?? false);
    return;
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
 * Steps 9-10 for a member in a `../` sibling checkout (stage 8): it stays a
 * sibling — a contained target is externalize/internalize's — on the same
 * volume, its directory renamed and its `members` entry pointed there; a part
 * has its PartOf path re-expressed from its new place.
 */
function moveSibling(alias: string, currentPath: string, newPath: string, isPart: boolean): void {
  const root = getProjectRoot();
  const nextPath = toPosixPath(newPath);
  if (parseMemberSource(nextPath).storage !== 'path') {
    throw new WaironError(`Refusing to move the member "${alias}" to "${nextPath}": it is stored in a sibling checkout and a move keeps its storage — moving it inside this project is \`member internalize\` (a part) or a family migration.`);
  }
  const oldDir = path.resolve(root, currentPath);
  const newDir = path.resolve(root, nextPath);
  if (!fs.existsSync(oldDir)) throw new WaironError(`Member directory not found at its current path: ${oldDir}`);
  if (fs.existsSync(newDir)) throw new WaironError(`Target directory already exists: ${newDir}`);
  ensureDir(path.dirname(newDir));
  if (fs.statSync(oldDir).dev !== fs.statSync(path.dirname(newDir)).dev) {
    throw new WaironError(`Refusing to move the member "${alias}" to ${newDir}: it lies on another volume, and a rename across volumes is not atomic.`);
  }
  fs.renameSync(oldDir, newDir);
  if (isPart) {
    const parentId = effectiveProjectId(projectConfigRepository.load() ?? { name: loadSystemSpec()?.name ?? '' });
    if (parentId !== null) runWithProjectRoot(newDir, () => projectConfigRepository.setPartOf({ project: parentId, path: toPosixPath(path.relative(newDir, root)) || '.' }));
  }
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
 * core_orchestrator.externalizeSubsystem — move an internal subsystem's spec
 * subtree out of the bound project's own specs folder into a PART at `path`
 * (stage 8: a storage move, the default): a new contained part declared in
 * `members` under the subsystem id by the shorthand, or the existing part at
 * that directory, which the subsystem joins. Each moved implementation's file
 * paths are re-expressed against the part's root; nothing else changes. With
 * `as: project` it then promotes the new part — the pre-stage-8 externalize —
 * every promote refusal found before anything moves.
 */
export function externalizeSubsystem(subsystemId: string, path: string, as?: string): PromoteResult | undefined {
  return externalizeInto(subsystemId, path, as);
}

/** externalizeSubsystem's body, with the path module in scope. */
function externalizeInto(subsystemId: string, partPath: string, as: string | undefined): PromoteResult | undefined {
  if (subsystemId.includes('::')) {
    throw new WaironError('cannot externalize a nested/namespaced subsystem; run from its owning project.');
  }
  if (as !== undefined && as !== 'part' && as !== 'project') {
    throw new WaironError(`cannot externalize "${subsystemId}": \`as: ${as}\` — a member is a part or a project.`);
  }
  // Step 1: the subsystem.
  const sub = loadSubsystemSpec(subsystemId);
  const family = graph();
  const bound = family.nodes.find((n) => n.namespace === '');
  // Steps 2-3: it exists, is a subsystem, and lives in the bound project's own specs folder.
  const inPart = bound?.parts.some((p) => p.subsystems.includes(subsystemId)) ?? false;
  if (!sub || sub.projectPath || family.owners.get(subsystemId) !== '' || inPart) {
    throw new WaironError(`cannot externalize: the subsystem "${subsystemId}" is missing, already in a part, or a member.`);
  }
  const parentRoot = getProjectRoot();
  const parentSpecsDir = aiPathsAt(parentRoot).specsDir();
  const fooDir = path.join(parentSpecsDir, subsystemId);
  // Every file the subsystem owns, wherever the layout keeps it: its nested folder, and every
  // spec outside it that names it — a shared types/ file, or the flat layout's subsystems/,
  // components/, interfaces/ and implementations/ files.
  const owned = subsystemFiles(subsystemId, parentSpecsDir);
  if (owned.files.length === 0) throw new WaironError(`subsystem specs not found for "${subsystemId}" under ${parentSpecsDir}`);
  // Step 4: the part's directory, under the containment guard; a project there refuses.
  const relPath = toPosixPath(partPath);
  const partDir = assertContainedProjectPath(parentRoot, relPath);
  if (path.resolve(partDir) === path.resolve(parentRoot)) throw new WaironError(`cannot externalize "${subsystemId}": the path "${relPath}" is the project root itself.`);
  if (holdsProjectContent(partDir)) throw new WaironError(`cannot externalize "${subsystemId}": ${partDir} already holds a project.`);
  const joined = bound?.parts.find((p) => p.directory !== undefined && path.resolve(p.directory) === path.resolve(partDir));
  const alias = joined?.alias ?? subsystemId;
  if (!joined && fs.existsSync(aiPathsAt(partDir).projectConfig())) {
    throw new WaironError(`cannot externalize "${subsystemId}": ${partDir} already holds a configuration (.wai/project.yaml) — a new part's directory holds none; creating one never overwrites it.`);
  }
  if (!joined && (declaredMembers(projectConfigRepository.load() ?? {}).some((m) => m.alias === alias) || projectConfigRepository.load()?.externals?.[alias] !== undefined)) {
    throw new WaironError(`cannot externalize "${subsystemId}": this project already declares the alias "${alias}".`);
  }
  const partSpecsDir = aiPathsAt(partDir).specsDir();
  const targetDir = path.join(partSpecsDir, subsystemId);
  if (owned.home !== undefined && fs.existsSync(targetDir)) throw new WaironError(`target already contains a "${subsystemId}" subsystem: ${targetDir}`);
  const destinationOf = (file: string): string => path.join(partSpecsDir, path.relative(parentSpecsDir, file));
  const strays = owned.files.filter((f) => !(owned.home !== undefined && isWithinDir(owned.home, f)));
  const taken = strays.filter((f) => fs.existsSync(destinationOf(f)));
  if (taken.length > 0) throw new WaironError(`cannot externalize "${subsystemId}": the part already holds ${taken.map((f) => toPosixPath(path.relative(partDir, destinationOf(f)))).join(', ')}.`);
  // Step 8 checked first: an externalize as project is one write or none.
  if (as === 'project') {
    if (joined) throw new WaironError(`cannot externalize "${subsystemId}" as a project into the existing part "${joined.alias}": externalize it into the part, then promote the part (\`wairon member promote ${joined.alias}\`).`);
    const inside = new Set(owned.files.map((f) => path.resolve(f)));
    const refusals = promoteRefusals(family, owned.files, ownSpecFiles(family, fooDir).filter((f) => !inside.has(path.resolve(f))), alias);
    if (refusals.length > 0) throw new WaironError(`cannot externalize "${subsystemId}" as a project: ${refusals.join('; ')}.`);
  }
  // Step 5: the subtree moves into the part — its folder whole, every file it owns elsewhere to
  // the same place under the part's specs — and its implementations' file paths re-expressed.
  const moved: string[] = [];
  if (owned.home !== undefined) {
    ensureDir(path.dirname(targetDir));
    fs.renameSync(owned.home, targetDir);
    moved.push(...specFilesUnder(targetDir));
  }
  for (const file of strays) {
    const to = destinationOf(file);
    ensureDir(path.dirname(to));
    fs.renameSync(file, to);
    moved.push(to);
    removeEmptyDirsUpTo(path.dirname(file), parentSpecsDir);
  }
  rebaseImplementationPaths(partSpecsDir, parentRoot, partDir, moved);
  // Step 6: declared under the subsystem id by the shorthand, unless it joined a part.
  if (!joined) projectConfigRepository.declareMember(alias, { source: relPath });
  invalidateSpecCache();
  // Steps 7-8: as a project, the new part is promoted in place.
  // Step 9: answered with what the promote wrote across the new boundary.
  return as === 'project' ? promoteMember(alias) : undefined;
}

/**
 * Every spec file a subsystem of the bound project owns, wherever its layout
 * keeps it. In the nested layout that is its folder (`home`); a spec that names
 * the subsystem from outside it is owned too — a type or group in the shared
 * types/ folder, and in the flat layout its subsystems/ file and each
 * component naming it (a component's folder whole: its contract,
 * implementation and owned members), each contract of those components and
 * each implementation of those contracts. Moving the folder alone would leave
 * those behind in the parent, naming a subsystem it no longer holds.
 */
function subsystemFiles(subsystemId: string, specsDir: string): { home?: string; files: string[] } {
  const subPath = getSubsystemPath(subsystemId);
  const nested = subPath.endsWith('.index.yaml') && path.resolve(path.dirname(subPath)) === path.resolve(path.join(specsDir, subsystemId)) && fs.existsSync(subPath);
  const home = nested ? path.dirname(subPath) : undefined;
  const files = new Set<string>(home !== undefined ? specFilesUnder(home).map((f) => path.resolve(f)) : []);
  if (!nested && fs.existsSync(subPath)) files.add(path.resolve(subPath));
  const l0 = path.resolve(aiPathsAt(getProjectRoot()).specsSystem());
  const others = (): string[] => specFilesUnder(specsDir).filter((f) => path.resolve(f) !== l0 && !files.has(path.resolve(f)));
  const add = (file: string): void => {
    // A component (or group) stored as a folder's .index.yaml carries the folder with it.
    if (path.basename(file) === '.index.yaml') for (const f of specFilesUnder(path.dirname(file))) files.add(path.resolve(f));
    else files.add(path.resolve(file));
  };
  // Each document naming the subsystem — a component, a type, or a group of types (no spec kind of its own).
  for (const file of others()) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    const kind = raw && typeof raw === 'object' ? specKind(raw) : undefined;
    if (kind === 'subsystem' || kind === 'system' || raw?.subsystem !== subsystemId) continue;
    add(file);
  }
  // Then the contracts of its components, and the implementations of its contracts.
  const owned = (): RawSpec[] => rawSpecs([...files]);
  const components = new Set(owned().filter((x) => x.kind === 'component').map((x) => x.id));
  for (const spec of rawSpecs(others())) if (spec.kind === 'interface' && components.has(spec.raw?.component)) add(spec.file);
  const contracts = new Set(owned().filter((x) => x.kind === 'interface').map((x) => x.id));
  for (const spec of rawSpecs(others())) if (spec.kind === 'implementation' && contracts.has(spec.raw?.contract)) add(spec.file);
  return { home, files: [...files] };
}

/** Remove `dir` and each parent above it, up to (not including) `stop`, while empty. */
function removeEmptyDirsUpTo(dir: string, stop: string): void {
  let at = path.resolve(dir);
  const end = path.resolve(stop);
  while (at !== end && isWithinDir(end, at) && fs.existsSync(at) && fs.readdirSync(at).length === 0) {
    fs.rmdirSync(at);
    at = path.dirname(at);
  }
}

// ---------------------------------------------------------------------------
// Stage 8: promote (a part becomes a project IN PLACE) and demote (a project
// member becomes a part IN PLACE). Nothing moves on disk: what changes is the
// member's content — an id, an L0, a lock make a project — and every reference
// across the boundary is re-saved so it keeps its target. The two are each
// other's inverse (promote-then-demote-is-identity).
// ---------------------------------------------------------------------------

/** Every spec file under a specs folder. */
function specFilesUnder(dir: string): string[] {
  return fs.existsSync(dir) ? listFilesRecursive(dir, '.yaml') : [];
}

/** The bound project's own spec files outside `except`: its own specs folder and every part's but the L0. */
function ownSpecFiles(family: ProjectFamily, except: string): string[] {
  const root = getProjectRoot();
  const dirs = [aiPathsAt(root).specsDir(), ...(family.nodes.find((n) => n.namespace === '')?.parts ?? [])
    .filter((p) => p.directory !== undefined).map((p) => aiPathsAt(p.directory!).specsDir())];
  const l0 = path.resolve(aiPathsAt(root).specsSystem());
  return dirs.flatMap(specFilesUnder).filter((f) => !isWithinDir(except, f) && path.resolve(f) !== l0);
}

/** One spec file as read: its kind, its id and the raw document. */
interface RawSpec {
  file: string;
  kind: SpecRefKind;
  id: string;
  raw: any;
}

/** The spec documents of a set of files, each with its kind and id; unreadable files skipped. */
function rawSpecs(files: string[]): RawSpec[] {
  const out: RawSpec[] = [];
  for (const file of files) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    const kind = raw && typeof raw === 'object' ? specKind(raw) : undefined;
    if (kind && (kind === 'system' || typeof raw.id === 'string')) out.push({ file, kind, id: kind === 'system' ? 'system' : String(raw.id), raw });
  }
  return out;
}

/** One reference that crosses a would-be boundary: written in `spec`, naming `target` on the other side. */
interface Crossing {
  spec: RawSpec;
  target: string;
  position: RefPosition | 'bare-type';
}

/**
 * The bare identifiers of a type expression: each name standing alone. A name
 * qualified by `.` or `::` is not bare — the qualified pass (respellQualified)
 * respells it whole, so none of its segments is imported by name.
 */
function typeTokens(expression: unknown): string[] {
  if (typeof expression !== 'string') return [];
  return [...expression.matchAll(/(?:::)?[A-Za-z_][A-Za-z0-9_-]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_-]*)*/g)]
    .map((m) => m[0]).filter((t) => !t.includes('.') && !t.includes('::'));
}

/** Every reference a spec's fields hold, with its position, and the bare type names its type expressions spell. */
function referencesOf(spec: RawSpec, wholeParams: boolean): { ref: string; position: RefPosition | 'bare-type' }[] {
  const out: { ref: string; position: RefPosition | 'bare-type' }[] = [];
  rewriteSpecRefs(JSON.parse(JSON.stringify(spec.raw)), (ref, position) => {
    out.push({ ref, position });
    return ref;
  });
  // Every type-expression slot (the one table, TYPE_EXPRESSION_PATHS). Into
  // the new project an interface parameter's type written as one name is
  // respelled whole (`wholeParams` false); every other type expression — a
  // return, a field, a type method's signature, a union, and any type back
  // out — keeps its text and imports the name. A prose signature is read only
  // where no structured params state the method's types; a signatureFrom is
  // the reference table's.
  const expressions: unknown[] = [];
  for (const slot of typeExpressionSlots(spec.kind, spec.raw)) {
    const value = slot.holder[slot.key];
    if (slot.path === 'methods.signatureFrom') continue;
    if (slot.path === 'methods.signature' && Array.isArray(slot.method?.params)) continue;
    if (slot.path === 'methods.params.type' && spec.kind === 'interface' && !wholeParams && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(String(value))) continue;
    // A prose signature's types only: its method name and its parameter labels name no type.
    expressions.push(slot.path === 'methods.signature'
      ? String(value).replace(/^\s*[A-Za-z_][\w-]*\s*(?:<[^>]*>)?\s*\(/, '(').replace(/(?<![:\w-])[A-Za-z_][\w-]*\s*\??\s*:(?!:)/g, '')
      : value);
  }
  for (const token of expressions.flatMap(typeTokens)) out.push({ ref: token, position: 'bare-type' });
  return out;
}

/** What crosses between the `inside` specs and the `outside` ones, both ways, by the ids each side declares. */
function crossingsOf(inside: RawSpec[], outside: RawSpec[]): { out: Crossing[]; in: Crossing[]; insideIds: Set<string>; outsideIds: Set<string>; insideTargets: Set<string>; outsideTargets: Set<string> } {
  const idsOf = (specs: RawSpec[]): Set<string> => new Set(specs.filter((s) => s.kind !== 'system').map((s) => s.id));
  const insideIds = idsOf(inside);
  const outsideIds = idsOf(outside);
  // What a whole-value reference position can name: a component, a contract or a type — never a
  // subsystem, whose id a `<subsystem>.<type>` head or a signatureFrom head would otherwise match.
  const targetsOf = (specs: RawSpec[]): Set<string> => new Set(specs.filter((s) => s.kind === 'component' || s.kind === 'interface' || s.kind === 'type').map((s) => s.id));
  const insideTargets = targetsOf(inside);
  const outsideTargets = targetsOf(outside);
  const typeIds = (specs: RawSpec[]): Map<string, string> => new Map(specs.filter((s) => s.kind === 'type').map((s) => [nameKey(s.id), s.id]));
  const insideTypes = typeIds(inside);
  const outsideTypes = typeIds(outside);
  const collect = (specs: RawSpec[], other: Set<string>, otherTypes: Map<string, string>, wholeParams: boolean): Crossing[] => {
    const found: Crossing[] = [];
    for (const spec of specs) {
      for (const { ref, position } of referencesOf(spec, wholeParams)) {
        if (position === 'bare-type') {
          const id = otherTypes.get(nameKey(ref));
          if (id !== undefined && !found.some((c) => c.spec === spec && c.target === id && c.position === 'bare-type')) found.push({ spec, target: id, position });
        } else if (!ref.includes('::') && other.has(ref) && position !== 'method') {
          found.push({ spec, target: ref, position });
        }
      }
    }
    return found;
  };
  return { out: collect(inside, outsideTargets, outsideTypes, true), in: collect(outside, insideTargets, insideTypes, false), insideIds, outsideIds, insideTargets, outsideTargets };
}

/**
 * Every reason a set of the bound project's spec files cannot become a project
 * of its own under `id` (promote step 2, and an externalize as project before
 * anything moves): a trustedLink between its subsystems and the rest, a
 * component either side uses that its subsystem does not publish, an id a
 * family project already answers to, and references back into this project
 * when it has no id to name it by.
 */
function promoteRefusals(family: ProjectFamily, insideFiles: string[], outsideFiles: string[], id: string): string[] {
  const out: string[] = [];
  const inside = rawSpecs(insideFiles);
  const outside = rawSpecs(outsideFiles);
  const crossing = crossingsOf(inside, outside);
  // A signatureFrom or an asserted invariant that would name the parent: no gate reads it across a boundary.
  out.push(...unreachableUpward(inside, outside));
  // A trustedLink across the new boundary, either direction.
  const subsystemsIn = new Set(inside.filter((s) => s.kind === 'subsystem').map((s) => s.id));
  for (const s of [...inside, ...outside].filter((x) => x.kind === 'subsystem')) {
    for (const link of s.raw.trustedLinks ?? []) {
      if (typeof link?.subsystem !== 'string' || subsystemsIn.has(s.id) === subsystemsIn.has(link.subsystem)) continue;
      out.push(`the trustedLink from "${s.id}" to "${link.subsystem}" would cross a project boundary — remove or replace it first`);
    }
  }
  // A component either side uses that its subsystem does not publish.
  for (const c of [...crossing.out, ...crossing.in].filter((x) => x.position === 'component')) {
    const target = [...inside, ...outside].find((s) => s.kind === 'component' && s.id === c.target);
    if (!target) continue;
    const published = resolveSubsystemExports(String(target.raw.subsystem)).entries.some((e) => e.kind === 'component' && e.component === c.target);
    if (!published) out.push(`"${c.spec.id}" uses "${c.target}", which its subsystem "${target.raw.subsystem}" does not publish — making it public is a design decision to make first`);
  }
  // A part fetched from git that names the promoted part cannot be respelled: its files are the fetch cache's.
  const gitDirs = (family.nodes.find((n) => n.namespace === '')?.parts ?? []).filter((p) => p.storage === 'git' && p.directory !== undefined).map((p) => p.directory!);
  for (const c of crossing.in.filter((x) => gitDirs.some((d) => isWithinDir(d, x.spec.file)))) {
    out.push(`"${c.spec.id}" names "${c.target}" from a part fetched from git, which cannot be respelled here — change it in its own repository first`);
  }
  // The id a family project already answers to.
  if (family.nodes.some((n) => n.id === id)) out.push(`the id "${id}" is already a project of the family`);
  if (!PROJECT_ID_RE_LOCAL.test(id)) out.push(`the id "${id}" breaks the project-id grammar`);
  // References back out need this project's id to name it by.
  const parentId = effectiveProjectId(projectConfigRepository.load() ?? { name: loadSystemSpec()?.name ?? '' });
  if (crossing.out.length > 0 && parentId === null) out.push('its specs reference this project, which has no id for it to name — declare one first (`wairon id set`)');
  // A `super::` one level deeper would climb somewhere else: one whose target cannot be named from here refuses.
  const climbs = climbsOf(family, crossing.insideIds, parentId);
  if (climbs.refused.length > 0) {
    out.push(`${climbs.refused.map((r) => `"${r}"`).join(', ')} climb${climbs.refused.length === 1 ? 's' : ''} above this project, where the target cannot be named from here. Run \`wairon doctor --fix\` from the top project first, which rewrites them as \`alias::name\``);
  }
  return [...new Set(out)];
}

/**
 * The `super::` references the specs `ids` of the bound root wrote, each as
 * authored → the text naming the same target from one level deeper:
 * `<project id>::<local>` by the project the scan bound it to (the bound root
 * by `parentId`). A climb whose target the scan could not read is refused.
 */
function climbsOf(family: ProjectFamily, ids: ReadonlySet<string>, parentId: string | null): { map: Map<string, string>; refused: string[] } {
  const map = new Map<string, string>();
  const refused: string[] = [];
  for (const ref of family.authoredReferences) {
    if (ref.form !== 'super' || !ids.has(ref.specId)) continue;
    const producer = ref.producer === undefined ? undefined : family.nodes.find((n) => n.namespace === ref.producer);
    const projectId = producer?.namespace === '' ? parentId : producer?.id;
    const local = producer && producer.namespace !== '' && ref.resolved.startsWith(`${producer.namespace}::`) ? ref.resolved.slice(producer.namespace.length + 2) : ref.resolved;
    if (!producer || !projectId || ref.binding === 'outside' || ref.binding === 'unresolved') refused.push(ref.authored);
    else map.set(ref.authored, `${projectId}::${local}`);
  }
  return { map, refused: [...new Set(refused)] };
}

/** The project-id grammar, restated where promote checks a new id before anything is written. */
const PROJECT_ID_RE_LOCAL = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/** Rewrite the references of each spec in `specs` through `remap`; answers the specs that changed. */
function rewriteRefsIn(specs: RawSpec[], remap: (ref: string, position: RefPosition) => string, record?: { result: PromoteResult; member: boolean }): RewrittenSpec[] {
  const rewritten: RewrittenSpec[] = [];
  for (const spec of specs) {
    const raw = readYamlFile(spec.file) as any;
    const edits: ReferenceEdit[] = [];
    if (!rewriteSpecRefs(raw, (ref, position) => {
      const to = remap(ref, position);
      if (to !== ref) edits.push({ kind: spec.kind as WritableSpecKind, specId: spec.id, position, from: ref, to });
      return to;
    })) continue;
    writeYamlFile(spec.file, raw);
    rewritten.push({ kind: spec.kind, id: spec.id });
    if (record) for (const e of edits) recordRespelling(record.result, e, record.member);
  }
  return rewritten;
}

/** A spec file patched in place with its updatedAt kept: a structural edit, never an authored one. */
function patchKeepingStamp(file: string, mutate: (raw: any) => boolean): void {
  if (!fs.existsSync(file)) return;
  const raw = readYamlFile(file) as any;
  if (mutate(raw)) writeYamlFile(file, raw);
}

/** The part of the bound root under an alias, or the reason there is none to promote. */
function partToPromote(family: ProjectFamily, alias: string): { part: NonNullable<ProjectFamily['nodes'][number]['parts']>[number]; dir: string } {
  const part = family.nodes.find((n) => n.namespace === '')?.parts.find((p) => p.alias === alias);
  if (!part || part.directory === undefined) throw new WaironError(`promote refused: this project declares no part "${alias}"${part ? ` (${part.reason ?? 'it cannot be read'})` : ''}.`);
  if (part.storage === 'git') {
    throw new WaironError(`promote refused: the part "${alias}" is fetched from git — its files are the fetch cache's. Promote it from a checkout of its repository; a cross-repository migration is not planned as one change.`);
  }
  return { part, dir: part.directory };
}

/**
 * core_orchestrator.promoteMember — promote a part of the bound project to an
 * independent project IN PLACE (stage 8): its files stay where they are and
 * its project content is created — a configuration declaring its id and a
 * minimal L0 exporting exactly what the rest of the project uses of it —
 * every reference across the new boundary re-saved (`alias::name` one way,
 * `<parent id>::name` the other), the parent declared as its external and its
 * L0 re-exports re-pointed at the member. Locks nothing.
 */
export function promoteMember(alias: string, id?: string): PromoteResult {
  // Step 1: the graph, and the part with its files on both sides of the boundary.
  const family = graph();
  const { dir } = partToPromote(family, alias);
  const newId = id ?? alias;
  const partSpecsDir = aiPathsAt(dir).specsDir();
  const insideFiles = specFilesUnder(partSpecsDir);
  const outsideFiles = ownSpecFiles(family, partSpecsDir);
  // Steps 2-4: every refusal before anything is written.
  const refusals = promoteRefusals(family, insideFiles, outsideFiles, newId);
  if (refusals.length > 0) throw new WaironError(`promote refused: ${refusals.join('; ')}.`);
  const inside = rawSpecs(insideFiles);
  const outside = rawSpecs(outsideFiles);
  const crossing = crossingsOf(inside, outside);
  const parentId = effectiveProjectId(projectConfigRepository.load() ?? { name: loadSystemSpec()?.name ?? '' }) ?? '';
  const parentName = loadSystemSpec()?.name ?? parentId;
  const declaration = declaredMembers(projectConfigRepository.load() ?? {}).find((m) => m.alias === alias);
  const now = new Date().toISOString();
  runWithProjectRoot(dir, () => {
    // Step 5: a non-contained part's PartOf goes (a contained part has none).
    projectConfigRepository.setPartOf(null);
    // Step 6: its id.
    // A part holding one subsystem is named after it, as an externalized subsystem always was.
    const subs = inside.filter((x) => x.kind === 'subsystem');
    const name = subs.length === 1 && typeof subs[0].raw.name === 'string' && subs[0].raw.name !== '' ? subs[0].raw.name : newId;
    if (projectConfigRepository.exists()) projectConfigRepository.setId(newId);
    else projectConfigRepository.create(defaultProjectConfig(name, now, newId));
    // Step 7: its minimal L0.
    saveSystemSpec(bootstrapSystemSpec(name, now, declaration?.description ?? promotedVision(newId, parentName)));
  });
  // Its subsystems now belong to the new project's L0.
  const projectName = runWithProjectRoot(dir, () => {
    invalidateSpecCache();
    return loadSystemSpec()?.name ?? newId;
  });
  invalidateSpecCache();
  for (const s of inside.filter((x) => x.kind === 'subsystem')) {
    patchKeepingStamp(s.file, (raw) => (raw.parentSystem === projectName ? false : (raw.parentSystem = projectName, true)));
  }
  // Step 8: an asserted `as: part` would now contradict the content.
  if (declaration?.as === 'part') projectConfigRepository.updateMember(alias, { as: '' });
  const result: PromoteResult = { respelled: [], memberRespelled: [], exported: [], imported: [], consumersDropped: [], entriesDeclared: [], topicsCrossing: [], pathsRebased: [], signaturesRederived: [] };
  // Step 9: every reference across the new boundary respelled, targets unchanged.
  const parentSide = rewriteRefsIn(crossing.in.map((c) => c.spec).filter(unique), (ref, position) =>
    (INTO_MEMBER_POSITIONS.has(position) && crossing.insideTargets.has(ref) ? `${alias}::${ref}` : ref), { result, member: false });
  const climbs = climbsOf(family, crossing.insideIds, parentId).map;
  const climbing = inside.filter((s) => family.authoredReferences.some((r) => r.form === 'super' && r.specId === s.id));
  const memberSide = rewriteRefsIn([...crossing.out.map((c) => c.spec), ...climbing].filter(unique), (ref, position) =>
    climbs.get(ref) ?? (MOVED_REF_POSITIONS.has(position) && crossing.outsideTargets.has(ref) ? `${parentId}::${ref}` : ref), { result, member: true });
  // ... and every qualified token of every type expression (`contracts.money`), which no whole-value position holds.
  const qualified = respellQualified(inside, outside, { alias, parentId, newId }, result);
  invalidateSpecCache();
  // Step 10: a consumers entry naming a subsystem across the boundary is dropped.
  dropCrossingConsumers(inside, outside, result);
  // Steps 10-11 (reach): the entries the new boundary made necessary, derived
  // from the parent's modelled calls (read before the respelling), and the
  // topics it now separates from their pair, for the plan.
  declareCrossingEntries(inside, outside, parentId || parentName, result);
  recordCrossingTopics(inside, outside, parentId || parentName, result);
  // Step 10 (declare): the new project declares the parent as its external when it references it.
  if (crossing.out.length > 0 || qualified.out.length > 0 || [...climbs.values()].some((t) => t.startsWith(`${parentId}::`))) runWithProjectRoot(dir, () => projectConfigRepository.declareExternal(parentId, {}));
  // Step 11: the parent's re-exports of the part's subsystems re-export the member.
  for (const s of inside.filter((x) => x.kind === 'subsystem')) restateReExports(s.id, alias);
  // Steps 12-13: what crosses is exported on its own side, and a bare type name imported by name;
  // the new project also exports every name the parent's L0 re-exports from it.
  exportCrossings([...crossing.out, ...qualified.out], dir, alias, parentId, 'out', result);
  exportCrossings([...crossing.in, ...qualified.in], dir, alias, parentId, 'in', result);
  exportReExported(inside, dir, alias, result);
  invalidateSpecCache();
  // Every re-saved spec spelled again from where it lives: a contained member
  // from this root, where the scan reads both sides; one stored outside it from
  // its own root, a reference it cannot spell canonically left as written.
  for (const spec of parentSide) if (spec.kind !== 'system') normalizeSpecReferences(spec.kind, spec.id);
  const memberKey = graph().nodes.find((n) => n.parent === '' && n.mountAlias === alias)?.namespace;
  if (memberKey !== undefined) {
    for (const spec of memberSide) if (spec.kind !== 'system') normalizeSpecReferences(spec.kind, `${memberKey}::${spec.id}`);
  } else {
    runWithProjectRoot(dir, () => {
      invalidateSpecCache();
      for (const spec of memberSide) {
        if (spec.kind === 'system') continue;
        try {
          normalizeSpecReferences(spec.kind, spec.id);
        } catch {
          // A deprecated form it cannot spell from its own root stays as written: `doctor --fix` rewrites it.
        }
      }
    });
  }
  invalidateSpecCache();
  // Step 17: every file path of the new project that escapes its root, re-expressed member-relative.
  rebaseEscapingPaths(dir, getProjectRoot(), result);
  // Step 18: every signature text the respelling left stale, re-derived on either side.
  rederiveSignatures(new Set(result.respelled.map((r) => r.specId)), result.signaturesRederived);
  runWithProjectRoot(dir, () => {
    invalidateSpecCache();
    rederiveSignatures(new Set(result.memberRespelled.map((r) => localIn(r.specId, memberKey ?? alias))), result.signaturesRederived);
  });
  invalidateSpecCache();
  // Step 19: promoted; nothing locked — answered with what crossed.
  return result;
}

/**
 * Step 17 of promoteMember: each file path a new project's implementation or
 * type names (sourcePath, each method's sourcePath, simPath) that escapes its
 * root is re-expressed as the path the file has relative to the family root,
 * read under the member's root — where the code lives once it is moved in. The
 * source is not moved, so until then it is planned code there; a path inside
 * the root, an absolute one, or one escaping the family root too is left
 * alone. Each recorded, naming where the file still lies.
 */
function rebaseEscapingPaths(memberDir: string, familyRoot: string, result: PromoteResult): void {
  const shownMember = toPosixPath(path.relative(familyRoot, memberDir)) || '.';
  for (const file of specFilesUnder(aiPathsAt(memberDir).specsDir())) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const isImplementation = 'contract' in raw;
    if (!isImplementation && specKind(raw) !== 'type') continue;
    let changed = false;
    const rebase = (holder: any, key: string, where: string): void => {
      const p = holder[key];
      if (typeof p !== 'string' || p === '' || path.isAbsolute(p)) return;
      const absolute = path.resolve(memberDir, p);
      if (isWithinDir(memberDir, absolute)) return;
      const next = toPosixPath(path.relative(familyRoot, absolute));
      if (next.startsWith('..') || path.isAbsolute(next)) return;
      holder[key] = next;
      changed = true;
      result.pathsRebased.push(`${raw.id} ${where}: ${p} → ${next} (the code is not moved: it is planned there until ${next} of the parent moves into ${shownMember})`);
    };
    for (const key of isImplementation ? ['sourcePath', 'simPath'] : ['sourcePath']) rebase(raw, key, key);
    if (Array.isArray(raw.methods)) {
      for (const method of raw.methods) {
        if (method && typeof method === 'object') rebase(method, 'sourcePath', `${method.name} sourcePath`);
      }
    }
    if (changed) writeYamlFile(file, raw);
  }
  invalidateSpecCache();
}

/**
 * Step 18 of promoteMember (and the last of demoteMember): under the bound
 * root, each contract or type among `touched` whose stored signature text its
 * params now contradict re-saved, so the writer derives the text. Each
 * recorded before and after.
 */
function rederiveSignatures(touched: Set<string>, lines: string[]): void {
  if (touched.size === 0) return;
  invalidateSpecCache();
  const stale = signatureFacts().staleTexts.filter((t) => touched.has(t.specId));
  if (stale.length === 0) return;
  const saved = new Set<string>();
  for (const t of stale) {
    const key = `${t.kind}:${t.specId}`;
    if (!saved.has(key)) {
      saved.add(key);
      if (t.kind === 'interface') {
        const intf = loadInterfaceSpec(t.specId);
        if (intf) saveInterfaceSpec(intf);
      } else {
        const type = loadTypeSpec(t.specId);
        if (type) saveSpec('type', type);
      }
    }
    lines.push(`${t.specId}.${t.method}: ${t.stored} → ${t.derived}`);
  }
  invalidateSpecCache();
}

/**
 * promote_result — what a promote (or an externalize as project) wrote across
 * the new boundary, each one named, so a plan lists exactly what its rehearsal
 * wrote.
 */
export interface PromoteResult {
  /** Every reference of the parent's specs respelled across the boundary, at its parsed position. */
  respelled: ReferenceEdit[];
  /** Every reference of the new project's specs respelled: back into the parent, or a self-prefix made bare. */
  memberRespelled: ReferenceEdit[];
  /** One line per export entry written, naming the side. */
  exported: string[];
  /** One line per bare type name imported by name. */
  imported: string[];
  /** One line per consumers entry dropped because it named a subsystem across the boundary. */
  consumersDropped: string[];
  /** One line per entry declared on a verb of the new project that callers left in the parent call. */
  entriesDeclared: string[];
  /** One line per topic the new boundary separates from its pair (the family run pairs it). */
  topicsCrossing: string[];
  /** One line per file path of the new project that escaped its root and was re-expressed member-relative. */
  pathsRebased: string[];
  /** One line per contract or type method whose stored signature text the respelling left stale and was re-derived. */
  signaturesRederived: string[];
}

/** The calls a set of implementations makes into a set of Portals: portal → verb → the calling components. */
function callsInto(callers: RawSpec[], portals: Set<string>): Map<string, Map<string, Set<string>>> {
  const componentOf = new Map(callers.filter((s) => s.kind === 'interface').map((s) => [s.id, String(s.raw.component ?? '')] as const));
  const out = new Map<string, Map<string, Set<string>>>();
  const add = (target: string | undefined, verb: string | undefined, caller: string): void => {
    // A reference the respelling already qualified (`alias::portal`) names the same Portal.
    const portal = target?.includes('::') ? target.slice(target.lastIndexOf('::') + 2) : target;
    if (!portal || !verb || !portals.has(portal)) return;
    const verbs = out.get(portal) ?? new Map<string, Set<string>>();
    verbs.set(verb, new Set([...(verbs.get(verb) ?? []), caller]));
    out.set(portal, verbs);
  };
  for (const impl of callers.filter((s) => s.kind === 'implementation')) {
    const caller = componentOf.get(String(impl.raw.contract ?? ''));
    if (!caller) continue;
    for (const method of Array.isArray(impl.raw.methods) ? impl.raw.methods : []) {
      for (const step of Array.isArray(method?.narrative) ? method.narrative : []) {
        if (step?.type === 'call' || step?.type === 'register') add(step.targetComponent, step.targetMethod, caller);
      }
      for (const entry of Array.isArray(method?.calls) ? method.calls : []) {
        const call = typeof entry === 'string' ? parseDeclaredCall(entry) : null;
        if (call) add(call.compId, call.methodName, caller);
      }
    }
  }
  return out;
}

/**
 * Step 10 (reach): each verb of a new project's Portal that a parent-side
 * implementation calls, with no entry of its own nor from its Portal, gets
 * one on its contract method — kind entry, scope network on a network
 * transport, the callers named — so the Portal is not left unreached in its
 * own gate. Derived from the modelled calls, never invented: a verb nobody
 * calls gets none. Each recorded.
 */
function declareCrossingEntries(inside: RawSpec[], outside: RawSpec[], parent: string, result: PromoteResult): void {
  const portals = new Map(inside.filter((s) => s.kind === 'component' && s.raw.componentType === 'Portal').map((s) => [s.id, s] as const));
  const called = callsInto(outside, new Set(portals.keys()));
  for (const [portalId, verbs] of [...called].sort(([a], [b]) => a.localeCompare(b))) {
    const portal = portals.get(portalId)!;
    if (portal.raw.invokedBy?.kind === 'entry') continue;
    const transport = portal.raw.transport as Transport | undefined;
    const network = transport !== undefined && transportKind(transport) === 'network';
    for (const contract of inside.filter((s) => s.kind === 'interface' && s.raw.component === portalId)) {
      patchKeepingStamp(contract.file, (raw) => {
        let changed = false;
        for (const method of Array.isArray(raw.methods) ? raw.methods : []) {
          const callers = verbs.get(method?.name);
          if (!callers || method.invokedBy !== undefined) continue;
          const names = [...callers].sort().join(', ');
          method.invokedBy = {
            kind: 'entry',
            ...(network ? { scope: 'network' } : {}),
            caller: `${names} of ${parent}, calling ${portalId}.${method.name} across the project boundary (modelled calls in ${parent}; declared when this project was promoted out of it)`,
          };
          result.entriesDeclared.push(`${portalId}.${method.name}: entry${network ? ' (network)' : ''} — called by ${names} of ${parent}`);
          changed = true;
        }
        return changed;
      });
    }
  }
}

/** Each component's topic ends on one side of the boundary: topic → emitting or subscribing component ids. */
function topicEnds(specs: RawSpec[]): { emits: Map<string, Set<string>>; subscribes: Map<string, Set<string>> } {
  const emits = new Map<string, Set<string>>();
  const subscribes = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, topic: unknown, component: string): void => {
    if (typeof topic !== 'string' || topic === '') return;
    into.set(topic, new Set([...(into.get(topic) ?? []), component]));
  };
  for (const c of specs.filter((s) => s.kind === 'component')) {
    for (const e of Array.isArray(c.raw.emits) ? c.raw.emits : []) add(emits, e?.topic, c.id);
    for (const e of Array.isArray(c.raw.subscribesTo) ? c.raw.subscribesTo : []) add(subscribes, e?.topic, c.id);
  }
  for (const i of specs.filter((s) => s.kind === 'interface')) {
    for (const m of Array.isArray(i.raw.methods) ? i.raw.methods : []) {
      const ep = m?.endpoint;
      if (ep?.transport !== 'MessageBus') continue;
      add(ep.direction === 'publish' ? emits : subscribes, ep.topic, String(i.raw.component ?? i.id));
    }
  }
  return { emits, subscribes };
}

/**
 * Step 11 (reach): each topic the new boundary separates from its pair —
 * emitted in the new project and consumed only in the parent, or consumed in
 * it and emitted only in the parent. The family run pairs them across
 * projects; the new project's own gate, run alone, reports them.
 */
function recordCrossingTopics(inside: RawSpec[], outside: RawSpec[], parent: string, result: PromoteResult): void {
  const mine = topicEnds(inside);
  const theirs = topicEnds(outside);
  const list = (ids: Set<string> | undefined): string => [...(ids ?? [])].sort().join(', ');
  for (const [topic, emitters] of [...mine.emits].sort(([a], [b]) => a.localeCompare(b))) {
    if (mine.subscribes.has(topic) || !theirs.subscribes.has(topic)) continue;
    result.topicsCrossing.push(`${topic}: emitted by ${list(emitters)} (the new project), consumed in ${parent} by ${list(theirs.subscribes.get(topic))} — the family run pairs it; the new project's own gate alone reports UNCONSUMED_TOPIC`);
  }
  for (const [topic, subscribers] of [...mine.subscribes].sort(([a], [b]) => a.localeCompare(b))) {
    if (mine.emits.has(topic) || !theirs.emits.has(topic)) continue;
    result.topicsCrossing.push(`${topic}: consumed by ${list(subscribers)} (the new project), emitted in ${parent} by ${list(theirs.emits.get(topic))} — the family run pairs it; the new project's own gate alone reports UNSOURCED_SUBSCRIPTION`);
  }
}

/** Record one respelling once. */
function recordRespelling(result: PromoteResult, edit: ReferenceEdit, member: boolean): void {
  if (edit.from === edit.to) return;
  const list = member ? result.memberRespelled : result.respelled;
  if (list.some((e) => e.kind === edit.kind && e.specId === edit.specId && e.position === edit.position && e.from === edit.from)) return;
  list.push(edit);
}

/** The two sides of a promote's new boundary, and the names each side calls the other. */
interface BoundaryNames {
  alias: string;
  parentId: string;
  newId: string;
}

/** The type reference of an asserted invariant (`<type-ref>.<invariant-id>`, split at its last dot); undefined when it has none. */
function assertedTypeRef(ref: string): string | undefined {
  const at = ref.lastIndexOf('.');
  return at > 0 && at < ref.length - 1 ? ref.slice(0, at) : undefined;
}

/**
 * Step 9 for the qualified type tokens: every `<subsystem>.<type>` (or
 * `<subsystem>::<type>`) token of every type-expression slot of either side
 * (TYPE_EXPRESSION_PATHS), and every asserted invariant's type reference,
 * resolved against the types both sides hold BEFORE the boundary exists. A
 * token naming a type across the new boundary is respelled `alias::<type>`
 * into the new project and `<parent id>::<type>` back out; a token of the new
 * project naming its own type by a prefix now equal to its id is respelled
 * bare. Writes each changed file, records each respelling, and answers the
 * crossings each side must export.
 */
/** A type of either side of a would-be boundary, with the side that holds it. */
interface SidedType {
  spec: RawSpec;
  side: 'inside' | 'outside';
}

/**
 * The types both sides hold BEFORE the boundary exists, read the way a
 * reference names one: a qualified `<subsystem>.<type>` (or `::`) token by its
 * subsystem and id, a bare id by its id — each answering the one type it names,
 * or undefined for none or several.
 */
function sidedTypes(inside: RawSpec[], outside: RawSpec[]): { qualified: (token: string) => SidedType | undefined; bare: (token: string) => SidedType | undefined } {
  const types: SidedType[] = [
    ...inside.filter((s) => s.kind === 'type').map((s) => ({ spec: s, side: 'inside' as const })),
    ...outside.filter((s) => s.kind === 'type').map((s) => ({ spec: s, side: 'outside' as const })),
  ];
  const subsystems = new Set([...inside, ...outside].filter((s) => s.kind === 'subsystem').map((s) => nameKey(s.id)));
  return {
    qualified: (token) => {
      const segments = token.split(/::|\./);
      if (segments.length !== 2 || segments.some((x) => x === '') || !subsystems.has(nameKey(segments[0]))) return undefined;
      const found = types.filter((t) => typeof t.spec.raw.subsystem === 'string' && nameKey(t.spec.raw.subsystem) === nameKey(segments[0]) && nameKey(t.spec.id) === nameKey(segments[1]));
      return found.length === 1 ? found[0] : undefined;
    },
    bare: (token) => {
      const found = types.filter((t) => nameKey(t.spec.id) === nameKey(token));
      return found.length === 1 ? found[0] : undefined;
    },
  };
}

/**
 * The references of the would-be member that would name the PARENT at a
 * position no gate resolves across a project boundary: a signatureFrom (a
 * signature type, or a `component.method` source) and an asserted invariant's
 * type. Neither is read through a project's pin, so respelled `<parent id>::x`
 * it would dangle — the promote refuses instead of writing a tree that cannot
 * validate.
 */
function unreachableUpward(inside: RawSpec[], outside: RawSpec[]): string[] {
  const out: string[] = [];
  const types = sidedTypes(inside, outside);
  const outsideComponents = new Set(outside.filter((x) => x.kind === 'component').map((x) => x.id));
  const target = (ref: string): SidedType | undefined => (ref.includes('.') || ref.includes('::') ? types.qualified(ref) : types.bare(ref));
  for (const spec of inside) {
    if (spec.kind === 'interface') {
      for (const m of spec.raw.methods ?? []) {
        const source = m?.signatureFrom;
        if (typeof source !== 'string') continue;
        const head = source.includes('.') ? source.slice(0, source.lastIndexOf('.')) : undefined;
        if (target(source)?.side === 'outside' || (head !== undefined && outsideComponents.has(head))) {
          out.push(`"${spec.id}" method "${m.name}" takes its signature from "${source}", which stays in this project: a signatureFrom is not read across a project boundary — state its params and returns first`);
        }
      }
    }
    if (spec.kind === 'implementation') {
      for (const m of spec.raw.methods ?? []) {
        for (const step of m?.narrative ?? []) {
          for (const ref of step?.assertsInvariants ?? []) {
            const typeRef = typeof ref === 'string' ? assertedTypeRef(ref) : undefined;
            if (typeRef !== undefined && !typeRef.includes('::') && target(typeRef)?.side === 'outside') {
              out.push(`"${spec.id}" asserts the invariant "${ref}" of an entity that stays in this project: an invariant is asserted by its own project's write paths — move the assertion first`);
            }
          }
        }
      }
    }
  }
  return out;
}

function respellQualified(inside: RawSpec[], outside: RawSpec[], names: BoundaryNames, result: PromoteResult): { out: Crossing[]; in: Crossing[] } {
  const crossings: { out: Crossing[]; in: Crossing[] } = { out: [], in: [] };
  const { qualified: qualifiedTarget, bare: bareTarget } = sidedTypes(inside, outside);
  const respell = (spec: RawSpec, side: 'inside' | 'outside', token: string, target: SidedType | undefined, selfPrefix: boolean): string => {
    if (!target) return token;
    if (target.side !== side) {
      const to = `${side === 'outside' ? names.alias : names.parentId}::${target.spec.id}`;
      (side === 'inside' ? crossings.out : crossings.in).push({ spec, target: target.spec.id, position: 'type' });
      return to;
    }
    return side === 'inside' && selfPrefix ? target.spec.id : token;
  };
  for (const [specs, side] of [[inside, 'inside'], [outside, 'outside']] as const) {
    for (const spec of specs) {
      if (!fs.existsSync(spec.file)) continue;
      const raw = readYamlFile(spec.file) as any;
      if (!raw || typeof raw !== 'object') continue;
      const edits: ReferenceEdit[] = [];
      const record = (from: string, to: string): void => {
        if (from !== to) edits.push({ kind: spec.kind as WritableSpecKind, specId: spec.id, position: 'type', from, to });
      };
      const mapToken = (token: string): string => {
        const target = qualifiedTarget(token);
        const to = respell(spec, side, token, target, nameKey(token.split(/::|\./)[0]) === nameKey(names.newId));
        record(token, to);
        return to;
      };
      for (const slot of typeExpressionSlots(spec.kind, raw)) {
        const value = slot.holder[slot.key] as string;
        // A `component.method` source is the reference table's (a component position), never a type token.
        if (slot.path === 'methods.signatureFrom' && !qualifiedTarget(value)) continue;
        slot.holder[slot.key] = respellTypeNames(value, mapToken);
      }
      if (spec.kind === 'implementation') {
        for (const m of raw.methods ?? []) {
          for (const step of m?.narrative ?? []) {
            if (!Array.isArray(step?.assertsInvariants)) continue;
            step.assertsInvariants = step.assertsInvariants.map((ref: unknown) => {
              const typeRef = typeof ref === 'string' ? assertedTypeRef(ref) : undefined;
              if (typeRef === undefined || typeRef.includes('::') && !qualifiedTarget(typeRef)) return ref;
              const target = typeRef.includes('.') || typeRef.includes('::') ? qualifiedTarget(typeRef) : bareTarget(typeRef);
              const to = respell(spec, side, typeRef, target, typeRef.includes('.') && nameKey(typeRef.split('.')[0]) === nameKey(names.newId));
              if (to === typeRef) return ref;
              record(ref as string, `${to}${(ref as string).slice(typeRef.length)}`);
              return `${to}${(ref as string).slice(typeRef.length)}`;
            });
          }
        }
      }
      if (edits.length === 0) continue;
      writeYamlFile(spec.file, raw);
      for (const e of edits) recordRespelling(result, e, side === 'inside');
    }
  }
  return crossings;
}

/**
 * Step 10: each publicInterfaces consumers entry, on either side, naming a
 * subsystem across the new boundary, dropped — a consumers list admits only
 * subsystems of its own tree, and between projects the L0 export table governs
 * who may use a name. A list left empty is removed (absent: anyone of its
 * project may depend). Each drop recorded.
 */
function dropCrossingConsumers(inside: RawSpec[], outside: RawSpec[], result: PromoteResult): void {
  const idsOf = (specs: RawSpec[]): Set<string> => new Set(specs.filter((s) => s.kind === 'subsystem').map((s) => s.id));
  const sides: [RawSpec[], Set<string>][] = [[inside, idsOf(outside)], [outside, idsOf(inside)]];
  for (const [specs, across] of sides) {
    for (const spec of specs.filter((s) => s.kind === 'subsystem')) {
      patchKeepingStamp(spec.file, (raw) => {
        let changed = false;
        for (const entry of raw.publicInterfaces ?? []) {
          if (!Array.isArray(entry?.consumers)) continue;
          const dropped = entry.consumers.filter((c: unknown) => typeof c === 'string' && across.has(c));
          if (dropped.length === 0) continue;
          const kept = entry.consumers.filter((c: unknown) => !dropped.includes(c));
          if (kept.length > 0) entry.consumers = kept;
          else delete entry.consumers;
          changed = true;
          const what = entry.component ?? entry.typeDef ?? entry.interface ?? entry.from ?? '(entry)';
          result.consumersDropped.push(`${spec.id} ${what}: ${dropped.join(', ')}${kept.length === 0 ? ' (the list is gone: the L0 export table governs who outside may use it)' : ''}`);
        }
        return changed;
      });
    }
  }
}

/** Ascending reach rank of an audience; an absent one reads as instance, the default an L0 entry declares. */
function audienceRank(audience: string | undefined): number {
  const idx = (SURFACE_AUDIENCES as readonly string[]).indexOf(audience ?? 'instance');
  return idx === -1 ? (SURFACE_AUDIENCES as readonly string[]).indexOf('instance') : idx;
}

/**
 * Step 15 (completeness): every name the parent's L0 now re-exports from the
 * member — an entry `from: <alias>` naming a component, an interface or a type,
 * or a whole re-export of it — exported by the new project too, at the parent
 * entry's audience or wider, under the public name the parent entry gave it;
 * then each such parent entry re-pointed at that public name, so no re-export
 * names an item the member does not export and none is wider than its source.
 */
function exportReExported(inside: RawSpec[], memberDir: string, alias: string, result: PromoteResult): void {
  invalidateSpecCache();
  const parent = loadSystemSpec();
  const parentEntries = (parent?.publicInterfaces ?? []) as ExportEntry[];
  const entries = parentEntries.filter((e) => e.from === alias);
  if (!parent || entries.length === 0) return;
  const parentId = effectiveProjectId(projectConfigRepository.load() ?? { name: parent.name }) ?? parent.name;
  // The public name each named parent entry requests from the member, by entry.
  const repointed = new Map<ExportEntry, { name: string; field: 'component' | 'typeDef'; item: string }>();
  runWithProjectRoot(memberDir, () => {
    invalidateSpecCache();
    const system = loadSystemSpec();
    if (!system) return;
    const own = [...(system.publicInterfaces ?? [])] as ExportEntry[];
    const types = loadTypeSpecs();
    let changed = false;
    for (const e of entries) {
      const audience = e.audience ?? 'instance';
      // A whole re-export: every subsystem of the part re-exported whole, at the parent's audience.
      if (e.component === undefined && e.typeDef === undefined && e.interface === undefined) {
        for (const s of inside.filter((x) => x.kind === 'subsystem')) {
          const whole = own.find((x) => x.from === s.id && x.component === undefined && x.typeDef === undefined && x.interface === undefined);
          if (whole) {
            if (audienceRank(whole.audience) < audienceRank(audience)) {
              whole.audience = audience;
              changed = true;
              result.exported.push(`${alias} L0: everything ${s.id} exports widened to ${audience} (re-exported whole by the parent)`);
            }
            continue;
          }
          own.push({ from: s.id, audience });
          changed = true;
          result.exported.push(`${alias} L0: everything ${s.id} exports at ${audience} (re-exported whole by the parent)`);
        }
        continue;
      }
      // A named one: the item it names, a type or a component (an interface names its component).
      const type = e.typeDef !== undefined ? types.find((t) => t.id === localIn(e.typeDef!, alias)) : undefined;
      const interfaceId = e.interface !== undefined ? localIn(e.interface, alias) : undefined;
      const componentId = e.component !== undefined
        ? localIn(e.component, alias)
        : interfaceId !== undefined ? loadInterfaceSpec(interfaceId)?.component : undefined;
      const component = type === undefined && componentId !== undefined ? loadComponentSpec(componentId) : null;
      if (type === undefined && !component) continue;
      const field: 'component' | 'typeDef' = type ? 'typeDef' : 'component';
      const item = type ? type.id : component!.id;
      const publicName = e.as ?? (e.id as string | undefined) ?? (interfaceId ?? item);
      if (type?.subsystem) exportTypeFromSubsystem(type.subsystem, type.id);
      // An entry the member already holds for the item keeps its public name, widened to the parent's audience.
      const held = own.find((x) => x[field] === item && (interfaceId === undefined || x.interface === undefined || x.interface === interfaceId));
      if (held) {
        if (audienceRank(held.audience ?? 'project') < audienceRank(audience)) {
          held.audience = audience;
          changed = true;
        }
        const name = (held.as ?? (held.id as string | undefined) ?? (held.interface ?? item)) as string;
        result.exported.push(`${alias} L0: ${item} as ${name} at ${held.audience} (re-exported by the parent)`);
        repointed.set(e, { name, field, item });
        continue;
      }
      const subsystem = type ? type.subsystem : component!.subsystem;
      own.push({
        ...(subsystem ? { from: subsystem } : {}),
        [field]: item,
        ...(interfaceId !== undefined && !type ? { interface: interfaceId } : {}),
        ...(publicName !== (interfaceId ?? item) ? { as: publicName } : {}),
        ...(e.details !== undefined ? { details: e.details } : {}),
        audience,
      });
      changed = true;
      result.exported.push(`${alias} L0: ${item}${publicName !== item ? ` as ${publicName}` : ''} at ${audience} (re-exported by the parent)`);
      repointed.set(e, { name: publicName, field, item });
    }
    if (changed) saveSystemSpec({ ...system, publicInterfaces: own as typeof system.publicInterfaces });
    // The public name each item is exported under, as the member's own table binds it.
    invalidateSpecCache();
    const table = resolveProjectExports();
    for (const [e, to] of repointed) {
      const interfaceId = e.interface !== undefined ? localIn(e.interface, alias) : undefined;
      const bound = table.entries.find((x) => (to.field === 'typeDef'
        ? x.typeDef === to.item
        : x.component === to.item && (interfaceId === undefined || x.interface === undefined || x.interface === interfaceId)));
      if (bound) to.name = bound.publicName;
    }
  });
  invalidateSpecCache();
  if (repointed.size === 0) return;
  // Each named parent entry re-exports the member's public name now, its own `as`, audience and details kept.
  const next = parentEntries.map((e) => {
    const to = repointed.get(e);
    if (!to) return e;
    const { component: _c, interface: _i, typeDef: _t, ...rest } = e;
    const before = e.interface ?? e.component ?? e.typeDef;
    const out: ExportEntry = { ...rest, [to.field]: to.name, ...(e.as === undefined && to.name !== before ? { as: before } : {}) };
    const shownAs = out.as ?? to.name;
    result.exported.push(`${parentId} L0: ${shownAs} re-exported through ${alias} as ${to.name} at ${e.audience ?? 'instance'} (was ${before} from subsystem ${alias})`);
    return out;
  });
  saveSystemSpec({ ...parent, publicInterfaces: next as typeof parent.publicInterfaces });
  invalidateSpecCache();
}

/** A promoted part's L0 vision, recognised as saying nothing beyond its names (saysMoreThanItsName). */
function promotedVision(id: string, parentName: string): string {
  return `Project ${id}, promoted from a part of ${parentName}`;
}

/** Array filter: each value once. */
function unique<T>(value: T, index: number, all: T[]): boolean {
  return all.indexOf(value) === index;
}

/**
 * Steps 12-13 of promoteMember: each target of a crossing exported on the
 * side that owns it — the parent's (`out`, the member's references back) under
 * the bound root, the member's (`in`) under its own — and each bare type name
 * imported by name through the alias that now supplies it.
 */
function exportCrossings(crossings: Crossing[], memberDir: string, alias: string, parentId: string, direction: 'out' | 'in', result: PromoteResult): void {
  const targets = [...new Set(crossings.map((c) => c.target))];
  const bare = [...new Set(crossings.filter((c) => c.position === 'bare-type').map((c) => c.target))];
  if (direction === 'out') {
    for (const name of exportItems(targets)) result.exported.push(`${parentId} L0: ${name}`);
    if (bare.length > 0) {
      projectConfigRepositoryAt(memberDir).importNames(parentId, bare);
      result.imported.push(`${alias}: externals.${parentId}.use gains ${bare.join(', ')}`);
    }
  } else {
    for (const name of runWithProjectRoot(memberDir, () => exportItems(targets))) result.exported.push(`${alias} L0: ${name}`);
    if (bare.length > 0) {
      projectConfigRepository.importNames(alias, bare);
      result.imported.push(`${parentId}: members.${alias}.use gains ${bare.join(', ')}`);
    }
  }
}

/** A key's local id within its project. */
function localIn(key: string, project: string): string {
  return project && key.startsWith(`${project}::`) ? key.slice(project.length + 2) : key;
}

/**
 * Export each local id of the bound project that crosses the boundary: a type
 * through its subsystem (as its own) and the L0; a component its subsystem
 * already exports through the L0. Each entry is added only when missing, at
 * the audience a family sees (`project`).
 */
function exportItems(ids: string[]): string[] {
  if (ids.length === 0) return [];
  invalidateSpecCache();
  const system = loadSystemSpec();
  if (!system) return [];
  const entries = [...(system.publicInterfaces ?? [])] as { from?: string; component?: string; typeDef?: string; audience?: string }[];
  const types = loadTypeSpecs();
  const added: string[] = [];
  for (const id of ids) {
    if (!PUBLIC_NAME_RE.test(id)) continue;
    const type = types.find((t) => t.id === id);
    if (type) {
      if (type.subsystem) exportTypeFromSubsystem(type.subsystem, id);
      // A type re-exported from the subsystem that owns it — the canonical form, never an implicit lookup.
      if (!entries.some((e) => e.typeDef === id && (e.from === undefined || e.from === type.subsystem))) {
        entries.push({ ...(type.subsystem ? { from: type.subsystem } : {}), typeDef: id, audience: 'project' });
        added.push(type.subsystem ? `${id} (from ${type.subsystem})` : id);
      }
      continue;
    }
    const component = loadComponentSpec(id);
    if (!component) continue;
    const exported = resolveSubsystemExports(component.subsystem).entries.some((e) => e.kind === 'component' && e.component === id);
    if (exported && !entries.some((e) => e.component === id)) {
      entries.push({ from: component.subsystem, component: id, audience: 'project' });
      added.push(`${id} (from ${component.subsystem})`);
    }
  }
  if (entries.length !== (system.publicInterfaces ?? []).length) {
    saveSystemSpec({ ...system, publicInterfaces: entries as typeof system.publicInterfaces });
  }
  return added;
}

/** A type exported as its own by the subsystem that owns it, when it is not already. */
function exportTypeFromSubsystem(subsystemId: string, typeId: string): void {
  const sub = loadSubsystemSpec(subsystemId);
  if (!sub || sub.publicInterfaces.some((pi) => pi.typeDef === typeId && pi.from === undefined)) return;
  // A structural edit, its updatedAt kept, so a demote that retires it restores the file byte for byte.
  patchKeepingStamp(getSubsystemPath(subsystemId), (raw) => {
    raw.publicInterfaces = [...(raw.publicInterfaces ?? []), { typeDef: typeId }];
    return true;
  });
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
  /** Each piece of metadata deliberately not carried, with the reason. */
  notCarried: string[];
  /**
   * Demote only: one line per consumers list widened by the subsystems across
   * the old boundary that depend on the surface it restricts — the use the
   * project boundary's export table granted, kept as the list a part needs.
   */
  consumersRestored: string[];
  /**
   * Demote only: one line per contract or type method whose stored signature
   * text the respelling back left stale and was re-derived from its params.
   */
  signaturesRederived?: string[];
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
  // Step 13 (stage 8): a part's specs are already this project's own — its internalize is a storage move.
  const part = family.nodes.find((n) => n.namespace === '')?.parts.find((p) => p.alias === alias);
  if (part) return internalizePart(alias, part);
  // A project in a `../` sibling checkout: demoted in place first, then moved in as the part it became.
  if (family.nodes.find((n) => n.namespace === '')?.externals.some((e) => e.role === 'member' && e.sourceKind === 'path' && e.alias === alias)) {
    const demoted = demoteMember(alias, destination);
    const nowPart = graph().nodes.find((n) => n.namespace === '')?.parts.find((p) => p.alias === alias);
    if (!nowPart) throw new WaironError(`cannot internalize "${alias}": demoted, it does not read as a part of this project.`);
    const moved = internalizePart(alias, nowPart);
    return { ...demoted, subsystems: moved.subsystems, types: moved.types, deleted: [...demoted.deleted, ...moved.deleted].sort() };
  }
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
  const result: InternalizeResult = { subsystems: scan.subsystems, types: scan.types, placed: [], externals: [], deleted: [], notCarried: [], consumersRestored: [] };
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

/**
 * internalizeMember for a PART (stage 8): a storage move only. Every spec
 * file of the part moves under the bound project's specs folder at the same
 * place, each moved implementation's file paths re-expressed against the bound
 * root; the member entry goes, and what remains of the part's .wai (its
 * PartOf, its pin of the parent) is deleted, each listed. No reference changes:
 * the part's specs are already the project's own.
 */
function internalizePart(alias: string, part: ProjectFamily['nodes'][number]['parts'][number]): InternalizeResult {
  // Step 8: refusals before anything moves.
  if (part.storage === 'git') {
    throw new WaironError(`cannot internalize: the part "${alias}" is fetched from git — its files are the fetch cache's. Internalize it from a checkout of its repository.`);
  }
  if (part.directory === undefined) throw new WaironError(`cannot internalize: the part "${alias}" cannot be read (${part.reason ?? 'its directory is absent'}).`);
  const root = getProjectRoot();
  const specsDir = aiPathsAt(root).specsDir();
  const partDir = part.directory;
  const types = loadTypeSpecs().filter((t) => !t.subsystem && part.specIds.includes(t.id)).map((t) => t.id);
  // Step 12: the files move in — a file landing on an existing one refuses before anything moves.
  const moved = moveTreeInto(aiPathsAt(partDir).specsDir(), specsDir, new Set());
  rebaseImplementationPaths(specsDir, partDir, root, moved);
  // Step 21: the member entry goes.
  projectConfigRepository.removeMember(alias);
  // Step 22: what remains of the part's .wai, each file listed.
  const deleted = deleteMemberWai(partDir);
  invalidateSpecCache();
  // Step 24.
  return { subsystems: part.subsystems, types, placed: [], externals: [], deleted, notCarried: [], consumersRestored: [] };
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
  const scaffolded = vision === bootstrapSystemSpec(name, '').vision || /^Member [a-z0-9_-]+ of (?:the .+ project|its parent project)$/.test(vision)
    || /^Project [a-z0-9._-]+, promoted from a part of .+$/.test(vision);
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
    const dir = path.resolve(scan.memberDir, m.source.path ?? '');
    const boundPath = bound.members?.[m.alias] !== undefined ? memberLocationOf(bound.members[m.alias]) : undefined;
    const same = boundPath !== undefined && path.resolve(getProjectRoot(), boundPath) === dir;
    if (here !== undefined && !same) out.push(`its member "${m.alias}" is an alias this project already declares for another project`);
  }
  for (const [a, decl] of Object.entries(scan.config?.externals ?? {})) {
    if (carriedExternal(scan, a, decl) === 'parent') continue;
    const producer = decl.project ?? a;
    const member = bound.members?.[a];
    const external = bound.externals?.[a];
    if (member !== undefined && a !== scan.alias && memberIdAt(memberLocationOf(member) ?? '') !== producer) {
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
  const refused = new Map<string, string[]>();
  for (const id of scan.subsystems) {
    const sub = loadSubsystemSpec(id);
    if (!sub) continue;
    const next: Record<string, unknown> = { ...sub };
    for (const [field, value, boundValue] of stamps) {
      if (value === undefined || value === boundValue || next[field] !== undefined) continue;
      // A value a subsystem cannot hold is listed, never stamped to raise UNKNOWN_PROFILE.
      const why = unholdable(field, value);
      if (why !== null) {
        refused.set(why, [...(refused.get(why) ?? []), id]);
        continue;
      }
      next[field] = value;
      stamped.set(`${field} ${value}`, [...(stamped.get(`${field} ${value}`) ?? []), id]);
    }
    if (Object.keys(next).length !== Object.keys(sub).length) saveSpec('subsystem', next as SubsystemSpec);
  }
  for (const [what, ids] of stamped) result.placed.push(`${what} → ${ids.join(', ')}`);
  for (const [why, ids] of refused) result.notCarried.push(why.replace('{ids}', ids.join(', ')));
  if (!saysMoreThanItsName(scan.system)) return;
  const home = loadSubsystemSpec(scan.home);
  if (!home) return;
  const paragraph = `From the member project "${scan.alias}" (${scan.system!.name}): ${scan.system!.vision.trim()}`;
  if (!home.description.includes(paragraph)) {
    saveSpec('subsystem', { ...home, description: home.description ? `${home.description}\n\n${paragraph}` : paragraph });
  }
  result.placed.push(`L0 vision → ${scan.home} description`);
}

/**
 * Why a member's value cannot be stamped on a subsystem, with `{ids}` for the
 * subsystems it was not stamped on; null when it can. A projectType becomes a
 * subsystem profile only when it is one — built in, or registered by a pack
 * the bound project loads — and a designDepth only when it is a design depth.
 */
function unholdable(field: string, value: string): string | null {
  if (field === 'profile') {
    const registered = (BUILTIN_PROFILES as readonly string[]).includes(value) || loadProjectExtensions().profiles[value] !== undefined;
    return registered ? null : `projectType ${value} not stamped on {ids}: not a subsystem profile (a project kind, or no built-in profile or loaded pack registers it)`;
  }
  if (field === 'designDepth' && !DesignDepthSchema.safeParse(value).success) {
    return `designDepth ${value} not stamped on {ids}: not a design depth (components | interfaces | implementations | narratives)`;
  }
  return null;
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
    if (m.problem || m.path === undefined) continue;
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
    // A path is re-expressed from the new owner; a hosted record id names the same producer from anywhere.
    const source = externalSourceOf(decl)?.path !== undefined && !path.isAbsolute(externalSourceOf(decl)!.path!)
      ? { path: toPosixPath(path.relative(root, path.resolve(scan.memberDir, externalSourceOf(decl)!.path!))) }
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

/** A project member of the bound root as demote finds it: where it lives, and whether it is contained. */
function memberToDemote(family: ProjectFamily, alias: string): { dir: string; contained: boolean; key?: string } {
  const bound = family.nodes.find((n) => n.namespace === '');
  if (bound?.parts.some((p) => p.alias === alias)) throw new WaironError(`demote refused: "${alias}" is already a part of this project.`);
  const node = family.nodes.find((n) => n.parent === '' && n.mountAlias === alias);
  if (node) return { dir: node.directory, contained: true, key: node.namespace };
  const referenced = bound?.externals.find((e) => e.role === 'member' && e.alias === alias);
  if (referenced?.sourceKind === 'git') {
    throw new WaironError(`demote refused: the member "${alias}" is fetched from git — its files are the fetch cache's. Demote it from a checkout of its repository.`);
  }
  if (referenced?.sourceKind === 'hosted') throw new WaironError(`demote refused: the member "${alias}" is a hosted record of its own — a part is part of its parent's record, so it must live in this project's tree.`);
  if (referenced?.directory !== undefined && fs.existsSync(referenced.directory)) return { dir: referenced.directory, contained: false };
  throw new WaironError(`demote refused: this project declares no project member "${alias}".`);
}

/** A public name of a project's export table → the local id it exports, under that project's own binding. */
function localsOf(root: string): Map<string, string> {
  return runWithProjectRoot(root, () => {
    invalidateSpecCache();
    const table = resolveProjectExports();
    return new Map(table.entries.map((e) => [e.publicName, localIn(e.component ?? e.typeDef ?? e.publicName, '')] as const));
  });
}

/** Every reason a project member cannot become a part of the bound project in place, each named. */
function demoteRefusals(scan: InternalizeScan, destination: InternalizeDestination, memberIds: Set<string>, family: ProjectFamily): string[] {
  const out: string[] = [];
  const bound = projectConfigRepository.load() ?? ({} as ProjectConfig);
  // A spec id of the member that this project's own specs already declare.
  const ownIds = new Set([...family.owners].filter(([, owner]) => owner === '').map(([key]) => key));
  const taken = [...memberIds].filter((id) => ownIds.has(id)).sort();
  if (taken.length > 0) out.push(`its spec ids ${taken.map((t) => `"${t}"`).join(', ')} are already this project's`);
  out.push(...aliasConflicts(scan, bound));
  if (destination.packs === undefined) {
    for (const pack of memberOnlyPacks(scan.config, bound)) out.push(`it selects the pack ${pack}, which this project does not — say --packs adopt or --packs drop`);
  }
  const carried = scan.config?.rules?.conformance?.carried ?? [];
  if (carried.length > 0) out.push(`it carries conformance debt (${carried.length} group(s) in rules.conformance.carried) — pay it or move it first`);
  const mine = bound.rules?.sddRuleSeverity ?? {};
  for (const [code, severity] of Object.entries(scan.config?.rules?.sddRuleSeverity ?? {})) {
    if (mine[code] !== severity) out.push(`it overrides ${code} to ${severity}, which this project does not`);
  }
  const exported = resolveSubsystemExportsOfProject();
  for (const name of destination.exports ?? []) {
    const held = exported.get(name);
    if (held !== undefined && held !== scan.alias) out.push(`the export "${name}" is a public name this project already exports for ${held}`);
  }
  const wai = path.join(scan.memberDir, '.wai');
  for (const entry of fs.existsSync(wai) ? fs.readdirSync(wai) : []) {
    if (entry === 'specs' || entry === 'transactions' || MEMBER_WAI_GROUPS.has(entry)) continue;
    out.push(`its .wai holds "${entry}", which this write does not recognise — move or delete it by hand`);
  }
  return out;
}

/**
 * core_orchestrator.demoteMember — demote a project member of the bound
 * project to a part IN PLACE (stage 8), promoteMember's inverse: its files
 * stay where they are and its project content is removed — each piece of its
 * own metadata sent to a home exactly as internalizeMember sends it, its L0,
 * configuration, lock, pins and derived outputs deleted (a member outside the
 * project keeps a configuration naming its parent), and every reference across
 * the old boundary re-saved as a local id. Locks nothing.
 */
export function demoteMember(alias: string, destination: InternalizeDestination): InternalizeResult {
  // Step 1: the graph — the project member under the alias.
  const family = graph();
  const { dir, contained, key } = memberToDemote(family, alias);
  const root = getProjectRoot();
  // Step 2: its configuration, L0 and specs, read under its own binding.
  const memberSpecs = rawSpecs(specFilesUnder(aiPathsAt(dir).specsDir()).filter((f) => path.resolve(f) !== path.resolve(aiPathsAt(dir).specsSystem())));
  const config = configAt(dir);
  const system = runWithProjectRoot(dir, () => {
    invalidateSpecCache();
    return loadSystemSpec();
  });
  invalidateSpecCache();
  const parentId = effectiveProjectId(projectConfigRepository.load() ?? { name: loadSystemSpec()?.name ?? '' }) ?? undefined;
  const subsystems = memberSpecs.filter((s) => s.kind === 'subsystem').map((s) => s.id);
  const types = memberSpecs.filter((s) => s.kind === 'type' && !s.raw.subsystem).map((s) => s.id);
  const named = destination.home ?? '';
  const home = named !== '' ? named : subsystems.length === 1 ? subsystems[0] : '';
  const scan: InternalizeScan = { alias, member: (key ? family.nodes.find((n) => n.namespace === key) : family.nodes[0])!, memberDir: dir, config, system, subsystems, types, home, parentId };
  // Steps 3-5: every refusal before anything is written.
  const refusals = demoteRefusals(scan, destination, new Set(memberSpecs.filter((s) => s.kind !== 'system').map((s) => s.id)), family);
  if ((home !== '' && !subsystems.includes(home) && !loadSubsystemSpec(home)) || (home === '' && saysMoreThanItsName(system))) {
    refusals.push(`its metadata needs a home subsystem (--home) — ${home === '' ? 'none was named' : `"${home}" is no subsystem of the member or of this project`}; its subsystems are ${subsystems.join(', ') || 'none'}`);
  }
  if (refusals.length > 0) throw new WaironError(`demote refused: "${alias}" cannot become a part — ${refusals.join('; ')}.`);
  const result: InternalizeResult = { subsystems, types, placed: [], externals: [], deleted: [], notCarried: [], consumersRestored: [], signaturesRederived: [] };
  // What crosses the old boundary, by public name on each side, read BEFORE anything is written.
  const intoMember = localsOf(dir);
  const backOut = localsOf(root);
  invalidateSpecCache();
  const parentAliases = new Set(Object.entries(config?.externals ?? {}).filter(([a, d]) => (d?.project ?? a) === parentId).map(([a]) => a));
  const crossed = new Set<string>();
  const across = (aliases: ReadonlySet<string>, table: Map<string, string>, record: boolean) => (ref: string): string => {
    const segments = ref.split('::');
    if (segments.length !== 2 || !aliases.has(segments[0])) return ref;
    const local = table.get(segments[1]) ?? segments[1];
    if (record) crossed.add(local);
    return local;
  };
  // Step 14 (written first, while both sides still answer to their names): every reference across the boundary, local.
  const ownSpecs = rawSpecs(ownSpecFiles(family, aiPathsAt(dir).specsDir()));
  const parentSide = rewriteRefsIn(ownSpecs, across(new Set([alias]), intoMember, false));
  const memberSide = rewriteRefsIn(memberSpecs, across(parentAliases, backOut, true));
  // A bare name the member imported from this project by `use` crossed too.
  for (const pa of parentAliases) for (const name of config?.externals?.[pa]?.use ?? []) if (name !== '*') crossed.add(backOut.get(name) ?? name);
  const memberNow = rawSpecs(specFilesUnder(aiPathsAt(dir).specsDir()).filter((f) => path.resolve(f) !== path.resolve(aiPathsAt(dir).specsSystem())));
  const parentNow = rawSpecs(ownSpecFiles(family, aiPathsAt(dir).specsDir()));
  // ... and every `alias::<type>` token of a type expression or an asserted invariant, which no whole-value position holds.
  respellQualifiedBack(parentNow, memberNow, { intoMember: (a) => a === alias, backOut: (a) => parentAliases.has(a) }, { intoMember, backOut }, crossed);
  // A consumers list still restricting a surface names the subsystems across the old boundary that use it again.
  restoreCrossingConsumers(memberNow, parentNow, result);
  // Its subsystems belong to this project's L0 again.
  const parentName = loadSystemSpec()?.name;
  if (parentName) {
    for (const s of memberSpecs.filter((x) => x.kind === 'subsystem')) {
      patchKeepingStamp(s.file, (raw) => (raw.parentSystem === parentName ? false : (raw.parentSystem = parentName, true)));
    }
  }
  // Steps 11-12: its project content goes — its L0, configuration, lock, pins and derived outputs, each listed.
  result.deleted = deleteProjectContent(dir);
  if (!contained && parentId !== undefined) {
    runWithProjectRoot(dir, () => projectConfigRepository.setPartOf({ project: parentId, path: toPosixPath(path.relative(dir, root)) || '.' }));
  }
  invalidateSpecCache();
  // Step 13: an asserted `as: project` and any `use` dropped from the declaration.
  const declaration = declaredMembers(projectConfigRepository.load() ?? {}).find((m) => m.alias === alias);
  if (declaration?.as !== undefined || (declaration?.use.length ?? 0) > 0) projectConfigRepository.updateMember(alias, { as: '', use: [] });
  invalidateSpecCache();
  // Steps 6-10: what it held as a project, sent home.
  placeOnSubsystems(scan, result);
  placeOnSystem(scan, destination, result);
  carryDeclarations(scan, result);
  carryPacks(scan, destination, result);
  // The exports that existed only for the boundary.
  retireBoundaryExports(family, crossed, key);
  invalidateSpecCache();
  for (const spec of [...parentSide, ...memberSide]) if (spec.kind !== 'system') normalizeSpecReferences(spec.kind, spec.id);
  invalidateSpecCache();
  // Every signature text the respelling back left stale, re-derived from its params.
  rederiveSignatures(new Set([...parentSide, ...memberSide].map((s) => s.id)), result.signaturesRederived ??= []);
  // Step 15.
  return result;
}

/**
 * demoteMember's inverse of promote's qualified-token respelling: every
 * `<alias>::<name>` token of a type-expression slot (a returns, a param or
 * field type, a type method's signature) and every asserted invariant's type
 * reference, naming a type across the old boundary, written back in the form a
 * reference to a type of one's own tree takes — `<subsystem>.<type>` for a
 * subsystem's type, the bare id for a project-level one. A name is read
 * through the side's export table first (a public name may differ from the
 * type's id). Each type that crossed into the parent is recorded, so an export
 * that existed only for the boundary retires with it.
 */
function respellQualifiedBack(
  parentSide: RawSpec[],
  memberSide: RawSpec[],
  aliases: { intoMember: (alias: string) => boolean; backOut: (alias: string) => boolean },
  tables: { intoMember: Map<string, string>; backOut: Map<string, string> },
  crossed: Set<string>,
): void {
  const types = [...parentSide, ...memberSide].filter((s) => s.kind === 'type');
  const localForm = (id: string): string | undefined => {
    const found = types.filter((t) => t.id === id);
    if (found.length !== 1) return undefined;
    const sub = found[0].raw?.subsystem;
    return typeof sub === 'string' && sub !== '' ? `${sub}.${id}` : id;
  };
  for (const [specs, across, table, record] of [
    [parentSide, aliases.intoMember, tables.intoMember, false],
    [memberSide, aliases.backOut, tables.backOut, true],
  ] as const) {
    const local = (token: string): string => {
      const segments = token.split('::');
      if (segments.length !== 2 || !across(segments[0])) return token;
      const id = table.get(segments[1]) ?? segments[1];
      const to = localForm(id);
      if (to === undefined) return token;
      if (record) crossed.add(id);
      return to;
    };
    for (const spec of specs) {
      if (!fs.existsSync(spec.file)) continue;
      const raw = readYamlFile(spec.file) as any;
      if (!raw || typeof raw !== 'object') continue;
      let changed = false;
      for (const slot of typeExpressionSlots(spec.kind, raw)) {
        const value = slot.holder[slot.key] as string;
        const next = respellTypeNames(value, local);
        if (next !== value) {
          slot.holder[slot.key] = next;
          changed = true;
        }
      }
      if (spec.kind === 'implementation') {
        for (const m of raw.methods ?? []) {
          for (const step of m?.narrative ?? []) {
            if (!Array.isArray(step?.assertsInvariants)) continue;
            step.assertsInvariants = step.assertsInvariants.map((ref: unknown) => {
              const typeRef = typeof ref === 'string' ? assertedTypeRef(ref) : undefined;
              if (typeRef === undefined || !typeRef.includes('::')) return ref;
              const to = local(typeRef);
              if (to === typeRef) return ref;
              changed = true;
              return `${to}${(ref as string).slice(typeRef.length)}`;
            });
          }
        }
      }
      if (changed) writeYamlFile(spec.file, raw);
    }
  }
}

/**
 * demoteMember's inverse of promote's step 10. Promote drops each consumers
 * entry naming a subsystem across the new boundary, because between projects
 * the L0 export table governs who may use a name; a part has no export table,
 * so a list that still restricts a surface must name every subsystem across
 * the old boundary that depends on it, or the demote leaves
 * CROSS_SUBSYSTEM_UNLISTED_CONSUMER behind. The subsystems added are exactly
 * the dependents the boundary's exports admitted. A list promote removed
 * whole is not recreated: absent is what it reads as (any subsystem of the
 * project may depend), and no durable record survives the promote to tell it
 * from a list that was never written — the promote's plan named its removal.
 */
function restoreCrossingConsumers(memberSide: RawSpec[], parentSide: RawSpec[], result: InternalizeResult): void {
  const sides: [RawSpec[], RawSpec[]][] = [[memberSide, parentSide], [parentSide, memberSide]];
  for (const [providers, consumers] of sides) {
    const dependents = consumers.filter((c) => c.kind === 'component' && typeof c.raw?.subsystem === 'string' && Array.isArray(c.raw?.dependsOn));
    for (const spec of providers.filter((x) => x.kind === 'subsystem')) {
      patchKeepingStamp(spec.file, (raw) => {
        let changed = false;
        for (const entry of raw.publicInterfaces ?? []) {
          if (!Array.isArray(entry?.consumers) || entry.consumers.length === 0 || typeof entry.component !== 'string') continue;
          const users = [...new Set(dependents.filter((c) => (c.raw.dependsOn as unknown[]).includes(entry.component)).map((c) => c.raw.subsystem as string))]
            .filter((sub) => sub !== spec.id && !entry.consumers.includes(sub));
          if (users.length === 0) continue;
          entry.consumers = [...entry.consumers, ...users];
          changed = true;
          result.consumersRestored.push(`${spec.id} ${entry.component}: ${users.join(', ')}`);
        }
        return changed;
      });
    }
  }
}

/**
 * Steps 11-12 of demoteMember: delete a member's project content — its L0,
 * and everything in its .wai but its specs and an open transaction — listing
 * each file under its group.
 */
function deleteProjectContent(memberDir: string): string[] {
  const wai = path.join(memberDir, '.wai');
  const deleted: string[] = [];
  const l0 = aiPathsAt(memberDir).specsSystem();
  if (fs.existsSync(l0)) {
    fs.rmSync(l0);
    deleted.push(`L0 (its pieces placed): .wai/${toPosixPath(path.relative(wai, l0))}`);
  }
  for (const entry of fs.existsSync(wai) ? fs.readdirSync(wai) : []) {
    if (entry === 'specs' || entry === 'transactions') continue;
    const at = path.join(wai, entry);
    const files = fs.statSync(at).isDirectory() ? listFilesRecursive(at, '') : [at];
    for (const f of files) deleted.push(`${MEMBER_WAI_GROUPS.get(entry) ?? 'derived outputs'}: .wai/${toPosixPath(path.relative(wai, f))}`);
    fs.rmSync(at, { recursive: true, force: true });
  }
  return deleted.sort();
}

/**
 * The bound L0's entries — and the subsystem type exports behind them — that
 * existed only for a boundary that is gone: an entry at audience project
 * naming a target the demoted member used, which no other project of the
 * family uses.
 */
function retireBoundaryExports(family: ProjectFamily, used: ReadonlySet<string>, memberKey: string | undefined): void {
  if (used.size === 0) return;
  const elsewhere = new Set(family.references.filter((r) => r.producer === '' && r.consumer !== '' && r.consumer !== memberKey).map((r) => localIn(r.target, '')));
  const system = loadSystemSpec();
  if (!system) return;
  const entries = (system.publicInterfaces ?? []) as ExportEntry[];
  const retired = entries.filter((e) => e.audience === 'project' && e.as === undefined
    && ((e.component !== undefined && used.has(e.component)) || (e.typeDef !== undefined && used.has(e.typeDef)))
    && !elsewhere.has(e.component ?? e.typeDef ?? ''));
  if (retired.length === 0) return;
  const kept = entries.filter((e) => !retired.includes(e));
  // None left reads as none declared, as before the boundary existed.
  const { publicInterfaces: _dropped, ...rest } = system;
  saveSystemSpec((kept.length > 0 ? { ...rest, publicInterfaces: kept } : rest) as SystemSpec);
  invalidateSpecCache();
  // An entry naming the type alone, or re-exporting it from the subsystem that owns it (the form promote writes).
  for (const e of retired.filter((x) => x.typeDef !== undefined)) {
    const type = loadTypeSpecs().find((t) => t.id === e.typeDef);
    if (!type?.subsystem || (e.from !== undefined && e.from !== type.subsystem)) continue;
    patchKeepingStamp(getSubsystemPath(type.subsystem), (raw) => {
      const before = (raw.publicInterfaces ?? []).length;
      raw.publicInterfaces = (raw.publicInterfaces ?? []).filter((pi: any) => !(pi?.typeDef === e.typeDef && pi?.from === undefined && Object.keys(pi).length === 1));
      return raw.publicInterfaces.length !== before;
    });
  }
}

// ---------------------------------------------------------------------------
// Stage 8: `member update` — a git member's pinned commit moved.
// ---------------------------------------------------------------------------

/** member_advance — what moving a git member's pin did or would do. */
export interface MemberAdvance {
  alias: string;
  from: string;
  to: string;
  ref?: string;
  added: string[];
  changed: string[];
  removed: string[];
  written: boolean;
}

/** Each spec file under a member root's specs folder, by its path inside the member, with its bytes. */
function specContents(dir: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (dir === null) return out;
  const specsDir = aiPathsAt(dir).specsDir();
  for (const f of specFilesUnder(specsDir)) out.set(toPosixPath(path.relative(dir, f)), fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'));
  return out;
}

/**
 * core_orchestrator.advanceMember — `wairon member update <alias>` (stage 8):
 * move a git member's pin. Resolve the ref (or take the commit given), fetch
 * it, compare the member's spec files at the old and the new commit, and —
 * unless dryRun, or nothing moved — write the new commit into its source. The
 * only way a git member's content changes. Locks nothing.
 */
export function advanceMember(alias: string, ref?: string, commit?: string, dryRun?: boolean): MemberAdvance {
  // Step 1: the member's git source and its pinned commit.
  const member = declaredMembers(projectConfigRepository.load() ?? {}).find((m) => m.alias === alias);
  if (!member || member.storage !== 'git' || member.source.git === undefined) {
    throw new WaironError(`Refusing to update "${alias}": this project declares no git member under that alias — \`member update\` moves a git member's pinned commit.`);
  }
  const url = member.source.git;
  const from = member.source.commit ?? '';
  // Steps 2-3: the commit given, else the ref's head now.
  const followed = commit === undefined ? (ref ?? member.source.ref) : undefined;
  const to = commit ?? gitSource.resolve(url, followed);
  // Step 4: both commits in the fetch cache.
  const after = specContents(gitSource.fetch(url, to, member.source.dir));
  const before = specContents(from !== '' ? gitSource.fetch(url, from, member.source.dir) : null);
  // Step 5: the spec files added, changed and removed.
  const added = [...after.keys()].filter((f) => !before.has(f)).sort();
  const removed = [...before.keys()].filter((f) => !after.has(f)).sort();
  const changed = [...after.keys()].filter((f) => before.has(f) && before.get(f) !== after.get(f)).sort();
  // Steps 6-7: the new pin, unless a dry run or nothing moved.
  const written = !dryRun && to !== from && projectConfigRepository.updateMember(alias, { source: `${url}#${to}` });
  if (written) invalidateSpecCache();
  // Step 8.
  return { alias, from, to, ...(commit === undefined ? { ref: followed ?? 'HEAD' } : {}), added, changed, removed, written };
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
  dryRun = false,
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
    if (!dryRun) writeYamlFile(file, raw);
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
function rekeyLintAllows(specsDir: string, rename: IdentityRename, dryRun = false): RewrittenSpec[] {
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
    if (!dryRun) writeYamlFile(file, raw);
    rewritten.push({ kind, id: specId });
  }
  return rewritten;
}

/**
 * Re-express every implementation file path (sourcePath, each method's
 * sourcePath, simPath) and every type's (sourcePath, each method's
 * sourcePath) under `specsDir` so it is read against `toRoot` instead of
 * `fromRoot`. The file a path names never changes — only the root it is
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
    if (!raw || typeof raw !== 'object') continue;
    const isImplementation = 'contract' in raw;
    // A type claims code too: its declaration's file, and each method's own.
    if (!isImplementation && specKind(raw) !== 'type') continue;
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
    for (const key of isImplementation ? ['sourcePath', 'simPath'] : ['sourcePath']) rebase(raw, key);
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

/** The spec kinds a component rename moves to a new id. */
export type RenamedSpecKind = 'component' | 'interface' | 'implementation';

/** One spec a component rename moved to a new id (spec_rename). */
export interface SpecRename {
  kind: RenamedSpecKind;
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
  /**
   * The export entries (L0 and L1) whose public name was derived from the
   * renamed component or its moving interface (no `as`), each by its public
   * name: the rename wrote `as: <that name>` on them, so the published surface
   * and every consumer's pin stay as they were. Empty when none derived it.
   */
  keptPublicNames: string[];
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
      `chained-component: "${componentId}" lives in another project; rename it from that project's own root. ${memberRootWay(componentId, `sdd_rename_component ${componentId.slice(componentId.lastIndexOf('::') + 2)} <new id>`)}`,
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
  // …and no renamed spec may have retired them (spec_index.retiredBy).
  refuseRetiredIds([
    { kind: 'component', id: newId },
    { kind: 'interface', id: interfaceId },
    { kind: 'implementation', id: implementationId },
  ]);

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
  const registerEdits = projectConfigRepository.rekeyCarried(rename, true);

  // Step 16: every reference to a renamed id across the bound tree, the moved
  // specs' own files included, before anything is saved: placement then finds a
  // renamed member's owner through its rewritten owns. The moved specs report as
  // renamed, not as rewritten.
  const remap = (ref: string, position: RefPosition): string => {
    if (position === 'component' || position === 'entity-class' || position === 'auth-source') {
      return ref === componentId ? newId : ref;
    }
    if (position === 'interface' && ref === movingInterface?.id) return interfaceId;
    return ref;
  };
  // Inside a hosted request, every spec the rename would write — the moved
  // specs and every spec whose references it rewrites — is judged against the
  // request's write reach before the first write; nothing is written on a refusal.
  const specsDir = aiPathsAt(getProjectRoot()).specsDir();
  // An export entry whose public name was derived from a renamed id: the one
  // naming the moving interface, or naming the component with no interface.
  const derivesName = (entry: any): boolean => (entry.interface !== undefined
    ? movingInterface !== undefined && entry.interface === movingInterface.id
    : entry.typeDef === undefined && entry.component === componentId);
  const keptDry = keepPublicNames(specsDir, derivesName, true);
  assertSpecsInReach(
    [...renamed.map(({ kind, from }) => ({ kind, id: from })), ...keptDry.specs, ...rewriteRefFields(specsDir, remap, undefined, true), ...rekeyLintAllows(specsDir, rename, true)],
    `renaming component "${componentId}"`,
    Array.isArray(registerEdits) && registerEdits.length > 0,
  );
  // Still step 16: the published names first — an entry that states no `as`
  // gets the name it published, before its component or interface is respelled.
  const kept = keepPublicNames(specsDir, derivesName);
  const rewrittenRefs = [...kept.specs, ...rewriteRefFields(specsDir, remap)];
  // Step 17: the lint allows naming it — a site on an edge, a covered unit —
  // follow as the register does.
  const allowsRekeyed = rekeyLintAllows(specsDir, rename);
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
  return { renamed, rewritten, carried, keptPublicNames: kept.names };
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
  movingInterface?: InterfaceSpec,
  movingImplementation?: ImplementationSpec,
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
  // Each moved spec appends its old id to its rename trace (previousIds).
  saveComponentSpec({ ...movedComponent, id: newId, previousIds: traced(movedComponent.previousIds, componentId) });
  // Its own interface, when that moves, under i<newId>.
  if (movedInterface) {
    saveInterfaceSpec({ ...movedInterface, id: interfaceId, component: newId, previousIds: traced(movedInterface.previousIds, movedInterface.id) });
  }
  // Its own implementation, when that moves, under <newId>_impl.
  if (movedImplementation) {
    // The nested layout keeps an implementation's file beside its contract's, so
    // one whose contract keeps its id is written to the very file it moves out
    // of. That file is cleared first: the loader refuses to write over another id.
    const oldFile = getImplementationPath(movedImplementation.id);
    if (path.resolve(getImplementationPath(implementationId, movedImplementation.contract)) === path.resolve(oldFile)) {
      fs.unlinkSync(oldFile);
    }
    saveImplementationSpec({ ...movedImplementation, id: implementationId, previousIds: traced(movedImplementation.previousIds, movedImplementation.id) });
  }

  // Remove each moved spec's old file, found by its old id — which the loader
  // still indexes beside the new one, so a folder a save moved is followed.
  removeSpecFile(getComponentPath(componentId), componentId);
  if (movingInterface) removeSpecFile(getInterfacePath(movingInterface.id), movingInterface.id);
  if (movingImplementation) removeSpecFile(getImplementationPath(movingImplementation.id), movingImplementation.id);

  // The removed files changed the tree outside the save paths.
  invalidateSpecCache();
}

/** A rename trace with `former` appended (oldest first), never listing one key twice. */
function traced(trace: readonly string[] | undefined, former: string): string[] {
  const out = [...(trace ?? [])];
  if (!out.includes(former)) out.push(former);
  return out;
}

/**
 * Refuse an id a renamed spec of its kind retired (id-retired), naming the
 * holder and the way out (spec_index.retiredBy over the bound tree).
 */
function refuseRetiredIds(wanted: { kind: 'component' | 'interface' | 'implementation' | 'type'; id: string }[]): void {
  const index = scanAllSpecs({ memberDepth: 0 });
  const retired = wanted.flatMap(({ kind, id }) => {
    const holder = specIndexRetiredBy(index, kind, id);
    return holder ? [`${kind} "${id}" is listed in the previousIds of "${holder}"`] : [];
  });
  if (retired.length > 0) {
    throw new WaironError(
      `id-retired: ${retired.join('; ')}. A consumer holding the old key would read the new spec as the renamed one; `
      + "unsetting the holder's previousIds (sdd_update_spec unset) releases the id.",
    );
  }
}

/**
 * Write `as: <public name>` on every L1 and L0 export entry that states none
 * and whose public name `derives` says a rename is about to change — the name
 * was derived from the old id, so without it the published name, and every
 * consumer's pin on it, would move with the rename. An L0 entry that states an
 * `id` already names itself. Answers the public names kept and the specs
 * changed; `dryRun` changes nothing.
 */
function keepPublicNames(
  specsDir: string,
  derives: (entry: any) => boolean,
  dryRun = false,
): { names: string[]; specs: RewrittenSpec[] } {
  const names: string[] = [];
  const specs: RewrittenSpec[] = [];
  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    let raw: any;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const kind = specKind(raw);
    if ((kind !== 'subsystem' && kind !== 'system') || !Array.isArray(raw.publicInterfaces)) continue;
    let changed = false;
    for (const entry of raw.publicInterfaces) {
      if (!entry || typeof entry !== 'object' || entry.as !== undefined || entry.id !== undefined) continue;
      if (!derives(entry)) continue;
      const source = entry.interface ?? entry.component ?? entry.typeDef;
      if (typeof source !== 'string') continue;
      const name = source.split('::').pop() ?? source;
      entry.as = name;
      names.push(name);
      changed = true;
    }
    if (!changed) continue;
    if (!dryRun) writeYamlFile(file, raw);
    specs.push({ kind, id: kind === 'system' ? 'system' : String(raw.id) });
  }
  return { names: [...new Set(names)], specs };
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

/**
 * The identifier grammar of each method casing a tree may ask for — the
 * casings the naming-conventions rule knows. None admits a namespace separator.
 */
const METHOD_CASINGS: Readonly<Record<string, RegExp>> = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  snake_case: /^[a-z0-9]+(_[a-z0-9]+)*$/,
  'kebab-case': /^[a-z0-9]+(-[a-z0-9]+)*$/,
  UPPER_CASE: /^[A-Z0-9]+(_[A-Z0-9]+)*$/,
};

/** An identifier at all: what a configured regular expression still has to admit. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a new method name is an identifier in the tree's method casing:
 * naming_rule_config.methodCasingFor(the configured naming, the subsystem's
 * effective targetLanguage) — the casing the naming-conventions rule judges
 * by, so define and rename accept the same names (snake_case in a Rust or
 * Python tree, camelCase in a TypeScript one). A configured regular
 * expression is honoured, on top of the identifier grammar.
 */
function methodNameFits(name: string, casing: string): boolean {
  const known = METHOD_CASINGS[casing];
  if (known) return known.test(name);
  if (!IDENTIFIER.test(name)) return false;
  try {
    return new RegExp(casing).test(name);
  } catch {
    return METHOD_CASINGS.camelCase.test(name);
  }
}

/** The method casing of a component's tree: its subsystem's targetLanguage, else the system's, against the configured naming. */
function methodCasingOf(component: { subsystem: string }): string {
  const language = loadSubsystemSpec(component.subsystem)?.targetLanguage ?? loadSystemSpec()?.targetLanguage;
  return methodCasingFor(projectConfigRepository.load()?.rules?.naming, language);
}

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
  /**
   * The public names of the export entries (L0 and L1) whose contract carries
   * the renamed method: consumers pinning them see one member removed and one
   * added. Reported, never prevented. Empty when the contract is not exported.
   */
  publishedIn: string[];
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
      `chained-component: "${componentId}" lives in another project; rename its method from that project's own root. ${memberRootWay(componentId, `sdd_rename_method ${componentId.slice(componentId.lastIndexOf('::') + 2)} <method> <new name>`)}`,
    );
  }
  // Steps 6–7: the new name must be an identifier in the tree's method casing —
  // unless a contract of the component implements another project's extension
  // point, whose producer names those methods in its own language: then any
  // identifier, and IMPLEMENTS_MISMATCH judges it against the producer's.
  const casing = methodCasingOf(component);
  const dictated = loadInterfaceSpecs().some((i) => i.component === componentId && i.implements !== undefined);
  if (dictated ? !IDENTIFIER.test(newName) : !methodNameFits(newName, casing)) {
    throw new WaironError(dictated
      ? `invalid-name: "${newName}" is not an identifier (a letter or underscore, then letters, digits or underscores).`
      : `invalid-name: "${newName}" is not an identifier in this tree's method casing (${casing}).`);
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
  // …and not retired there: a method listing `<contract>.<newName>` in its
  // rename trace holds the name.
  const retiredOn = moving.flatMap((i) => i.methods
    .filter((m) => (m.previousNames ?? []).includes(`${i.id}.${newName}`))
    .map((m) => `"${i.id}.${m.name}"`));
  if (retiredOn.length > 0) {
    throw new WaironError(
      `name-retired: ${retiredOn.join(', ')} lists "${newName}" in its previousNames — the name is retired on that contract. `
      + 'Unsetting that previousNames releases it.',
    );
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
  const registerEdits = projectConfigRepository.rekeyCarried(rename, true);

  // Inside a hosted request, every spec the rename would write — the contracts
  // and implementations it moves the method in, and every spec whose
  // references it retargets — is judged against the request's write reach
  // before the first write; nothing is written on a refusal.
  const methodRemap = (ref: string, position: RefPosition, owner?: string): string =>
    (position === 'method' && owner === componentId && ref === methodName ? newName : ref);
  const reachDir = aiPathsAt(getProjectRoot()).specsDir();
  assertSpecsInReach(
    [
      ...(rename.methods?.[0]?.specs ?? []).map((id) => ({ kind: moving.some((i) => i.id === id) ? 'interface' : 'implementation', id })),
      ...rewriteRefFields(reachDir, methodRemap, undefined, true),
      ...rekeyLintAllows(reachDir, rename, true),
    ],
    `renaming method "${componentId}.${methodName}"`,
    Array.isArray(registerEdits) && registerEdits.length > 0,
  );

  // Steps 15–16: the method moves on each of those contracts — its name, and,
  // for a prose method, the name inside its signature. A method with params has
  // its text derived from the new name by the writer, and a sourced method
  // stores no text at all. Params, returns, signatureFrom, description,
  // guarantees, endpoint and findings stay exactly as they are.
  for (const contract of moving) {
    saveInterfaceSpec({
      ...contract,
      methods: contract.methods.map((m) => (m.name === methodName
        ? {
          ...m,
          name: newName,
          previousNames: traced(m.previousNames, `${contract.id}.${methodName}`),
          ...(m.params === undefined && m.signatureFrom === undefined
            ? { signature: renameInSignature(m.signature, methodName, newName) }
            : {}),
        }
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
  const retargeted = rewriteRefFields(specsDir, methodRemap);
  // Still step 22: the lint allows naming it — a site on a spec it moved in, a
  // covered unit — follow as the register does.
  const allowsRekeyed = rekeyLintAllows(specsDir, rename);
  const rewritten = [...new Set([...retargeted, ...allowsRekeyed].map((spec) => spec.id))];

  // Step 23: what names the method and is left alone — and the export
  // entries publishing it, whose consumers see a member renamed.
  const mentions = collectMentions(specsDir, methodName, moving);
  const publishedIn = exportsPublishing(componentId, new Set(moving.map((i) => i.id)));

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
    publishedIn,
  };
}

/**
 * The public names of the L1 and L0 export entries that publish a contract of
 * `componentId` among `contracts`: an entry narrowed to one of them, or one
 * exporting the component whole.
 */
function exportsPublishing(componentId: string, contracts: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  const tables = [
    ...loadSubsystemSpecs().filter((s) => !s.id.includes('::')).map((s) => resolveSubsystemExports(s.id)),
    resolveProjectExports(),
  ];
  for (const table of tables) {
    for (const entry of table.entries) {
      if (entry.kind !== 'component' || entry.component !== componentId) continue;
      if (entry.interface !== undefined && !contracts.has(entry.interface)) continue;
      names.add(entry.publicName);
    }
  }
  return [...names].sort();
}

/**
 * A prose method's signature with the method's own name rewritten: the first
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
// Type rename
//
// A type is named at every type position of the tree — params, returns,
// fields, signature types, a signatureFrom read as a type — and by an export
// entry's typeDef. A position is a type EXPRESSION (`list<Invoice>?`), so the
// rename respells the named members of the expression that name this type and
// leaves the rest of the text as written. A named member names the type when
// it reads as the type's id (type_spec.matchesRef) and, when it would read as
// another type of the same name too, when the spec writing it belongs to the
// type's own owner — the reading the loader binds.
// ---------------------------------------------------------------------------

/** What renaming a type changed (type_rename). */
export interface TypeRename {
  /** The type's id before the rename, qualified by its owning subsystem when it has one. */
  from: string;
  /** The type's id after the rename, qualified the same way. */
  to: string;
  /** Ids of the other specs whose type positions, typeDef or lint allows naming the type were rewritten. */
  rewritten: string[];
  /** The export entries (L0 and L1) that exported the type without an `as`: the rename wrote `as: <old name>` on them. */
  keptPublicNames: string[];
  /** Every edit the rename made to the debt register: an entry anchored on the type. */
  carried: CarriedRekey[];
}

/** An id respelled in the style a written reference spelled the old one: snake id, PascalCase, camelCase or kebab-case. */
function respellLike(written: string, oldId: string, newId: string): string {
  const words = (id: string): string[] => id.split(/[_-]+/).filter(Boolean);
  const pascal = (id: string): string => words(id).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  const camel = (id: string): string => { const p = pascal(id); return p.charAt(0).toLowerCase() + p.slice(1); };
  const kebab = (id: string): string => words(id).join('-');
  if (written === oldId) return newId;
  if (written === pascal(oldId)) return pascal(newId);
  if (written === camel(oldId)) return camel(newId);
  if (written === kebab(oldId)) return kebab(newId);
  if (written.includes('-')) return kebab(newId);
  return /^[A-Z]/.test(written) ? pascal(newId) : newId;
}

/**
 * Rename a type and every reference to it in the bound tree (core_orchestrator.renameType).
 * The type moves to the new id under the same owner, its old id appended to
 * its rename trace; every type position naming it is respelled, and an export
 * entry's typeDef — one that stated no `as` first keeping its public name.
 * Before writing anything it refuses a type that does not exist
 * (type-missing), one in another project (chained-type), a new id outside the
 * id grammar (invalid-id), and a new id another type of the same owner holds
 * or retired (id-taken, id-retired).
 */
/**
 * The exact way to change something a member project owns: the doctrine says a
 * member project is written from its own root, never through its parent's
 * tree, so a refusal names the member's folder and the call to make there.
 */
function memberRootWay(qualifiedId: string, call: string): string {
  const alias = qualifiedId.slice(0, qualifiedId.indexOf('::'));
  let folder: string | undefined;
  try {
    const node = graph().nodes.find((n) => n.namespace === alias || (n.parent === '' && n.mountAlias === alias));
    if (node) folder = path.relative(getProjectRoot(), node.directory).split(path.sep).join('/') || '.';
  } catch { /* a graph that cannot be read names no folder */ }
  const where = folder ? `the member project "${alias}" at ${folder}` : `the member project "${alias}"`;
  return `It belongs to ${where}: open a session in that folder (its own guide and .mcp.json — run \`wairon generate\` and \`wairon mcp install --backend claude\` there first if it has none) and call ${call} there.`;
}

export function renameType(typeId: string, newId: string): TypeRename {
  // Steps 1–3: the type must exist. A subsystem-qualified id names the type within its owner.
  const all = loadTypeSpecs();
  const cut = typeId.lastIndexOf('::');
  const qualifier = cut >= 0 ? typeId.slice(0, cut) : undefined;
  const ownSubsystem = qualifier !== undefined && loadSubsystemSpecs().some((s) => s.id === qualifier);
  // Steps 4–5: …and belong to the bound project itself — an alias:: prefix names another project.
  if (qualifier !== undefined && !ownSubsystem) {
    throw new WaironError(`chained-type: "${typeId}" lives in another project; rename it from that project's own root. ${memberRootWay(typeId, `sdd_rename_type ${typeId.slice(cut + 2)} <new id>`)} An exported type keeps its public name through \`as\`, so this project's references do not break.`);
  }
  const type: TypeSpec | null = qualifier !== undefined
    ? all.find((t) => t.id === typeId.slice(cut + 2) && t.subsystem === qualifier) ?? null
    : loadTypeSpec(typeId);
  if (!type) throw new WaironError(`type-missing: no type has the id "${typeId}".`);
  if (type.id.includes('::')) {
    throw new WaironError(`chained-type: "${type.id}" lives in another project; rename it from that project's own root. ${memberRootWay(type.id, `sdd_rename_type ${type.id.slice(type.id.lastIndexOf('::') + 2)} <new id>`)}`);
  }
  const oldId = type.id;
  // Steps 6–7: the new id must be a plain lowercase identifier.
  if (!SpecIdSchema.safeParse(newId).success) {
    throw new WaironError(`invalid-id: "${newId}" is not a lowercase identifier with no namespace separator.`);
  }
  // Steps 8–10: no type of the same owner may hold or have retired the new id.
  const sameOwner = (t: TypeSpec): boolean => (t.subsystem ?? '') === (type.subsystem ?? '');
  if (all.some((t) => t !== type && t.id === newId && sameOwner(t))) {
    throw new WaironError(`id-taken: another type of ${type.subsystem ? `"${type.subsystem}"` : 'the system'} already has the id "${newId}".`);
  }
  refuseRetiredIds([{ kind: 'type', id: qualifiedTypeId({ id: newId, subsystem: type.subsystem }) }]);

  // Step 11: the move as the register and the lint allows key it, proven
  // rewritable before the first write.
  const rename: IdentityRename = { specs: [{ from: oldId, to: newId }] };
  const registerEdits = projectConfigRepository.rekeyCarried(rename, true);

  // Step 12: every type position naming the type, respelled.
  const components = new Map(loadComponentSpecs().map((c) => [c.id, c.subsystem]));
  const others = all.filter((t) => t !== type);
  /** Whether a written named member, in a spec owned by `owner`, names the renamed type. */
  const namesType = (token: string, owner: string | undefined): boolean => {
    if (!typeMatchesRef(type, token)) return false;
    if (!others.some((t) => typeMatchesRef(t, token))) return true;
    return (owner ?? '') === (type.subsystem ?? '');
  };
  const respellText = (text: unknown, owner: string | undefined): unknown => {
    if (typeof text !== 'string') return text;
    return text.replace(/[A-Za-z_][A-Za-z0-9_-]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_-]*)*/g, (token) => {
      if (!namesType(token, owner)) return token;
      const parts = token.split(/(::|\.)/);
      parts[parts.length - 1] = respellLike(parts[parts.length - 1], oldId, newId);
      return parts.join('');
    });
  };
  const specsDir = aiPathsAt(getProjectRoot()).specsDir();
  const derivesName = (entry: any): boolean => entry.interface === undefined && entry.component === undefined
    && typeof entry.typeDef === 'string' && namesType(entry.typeDef, undefined);
  /** Respell one spec's type positions in place; answers whether any changed. */
  const respellSpec = (raw: any): boolean => {
    const kind = specKind(raw);
    const before = JSON.stringify(raw);
    const at = (holder: any, key: string, owner: string | undefined): void => {
      if (holder && typeof holder[key] === 'string') holder[key] = respellText(holder[key], owner);
    };
    const methodPositions = (method: any, owner: string | undefined, sourced: boolean): void => {
      if (!method || typeof method !== 'object') return;
      for (const p of Array.isArray(method.params) ? method.params : []) at(p, 'type', owner);
      at(method, 'returns', owner);
      if (sourced && typeof method.signatureFrom === 'string' && namesType(method.signatureFrom, owner)) at(method, 'signatureFrom', owner);
      // A stored text derives from params; a prose text names its result after the parameter list.
      if (typeof method.signature === 'string') {
        if (Array.isArray(method.params)) method.signature = deriveMethodSignature(method) ?? method.signature;
        else {
          const close = method.signature.lastIndexOf(')');
          if (close >= 0) method.signature = method.signature.slice(0, close + 1) + respellText(method.signature.slice(close + 1), owner);
        }
      }
    };
    if (kind === 'interface') {
      const owner = components.get(String(raw.component));
      for (const m of Array.isArray(raw.methods) ? raw.methods : []) methodPositions(m, owner, true);
    } else if (kind === 'type') {
      const owner = typeof raw.subsystem === 'string' ? raw.subsystem : undefined;
      for (const f of Array.isArray(raw.fields) ? raw.fields : []) {
        at(f, 'type', owner);
        if (typeof f?.references === 'string') {
          const [head, ...rest] = f.references.split('.');
          if (namesType(head, owner)) f.references = [respellText(head, owner), ...rest].join('.');
        }
      }
      for (const p of Array.isArray(raw.params) ? raw.params : []) at(p, 'type', owner);
      at(raw, 'returns', owner);
      if (typeof raw.linkedEntity === 'string' && namesType(raw.linkedEntity, owner)) at(raw, 'linkedEntity', owner);
      for (const m of Array.isArray(raw.methods) ? raw.methods : []) methodPositions(m, owner, false);
    } else if (kind === 'subsystem' || kind === 'system') {
      const owner = kind === 'subsystem' ? String(raw.id) : undefined;
      for (const e of Array.isArray(raw.publicInterfaces) ? raw.publicInterfaces : []) {
        if (e && typeof e.typeDef === 'string' && namesType(e.typeDef, owner)) at(e, 'typeDef', owner);
      }
    }
    return JSON.stringify(raw) !== before;
  };
  /** The specs whose type positions name the type; `dryRun` writes nothing. The type's own file is the move's. */
  const respellAll = (dryRun: boolean): RewrittenSpec[] => {
    const out: RewrittenSpec[] = [];
    for (const file of listFilesRecursive(specsDir, '.yaml')) {
      let raw: any;
      try {
        raw = readYamlFile(file);
      } catch {
        continue;
      }
      const kind = raw && typeof raw === 'object' ? specKind(raw) : undefined;
      if (!kind || !respellSpec(raw)) continue;
      if (!dryRun) writeYamlFile(file, raw);
      out.push({ kind, id: kind === 'system' ? 'system' : String(raw.id) });
    }
    return out;
  };
  // Inside a hosted request, every spec the rename would write is judged
  // against the request's write reach before the first write.
  assertSpecsInReach(
    [{ kind: 'type', id: oldId }, ...keepPublicNames(specsDir, derivesName, true).specs, ...respellAll(true), ...rekeyLintAllows(specsDir, rename, true)],
    `renaming type "${typeId}"`,
    Array.isArray(registerEdits) && registerEdits.length > 0,
  );
  // The published names first, then the positions; traces are never touched.
  const kept = keepPublicNames(specsDir, derivesName);
  const respelled = respellAll(false);
  const allowsRekeyed = rekeyLintAllows(specsDir, rename);
  const rewritten = [...new Set([...kept.specs, ...respelled, ...allowsRekeyed]
    .filter((spec) => !(spec.kind === 'type' && spec.id === oldId))
    .map((spec) => spec.id))];

  // Step 13: the rewrite changed files outside the save paths.
  invalidateSpecCache();
  // Step 14: the type, as the rewrite left it, under its new id and the same owner.
  const moved = loadTypeSpecs().find((t) => t.id === oldId && (t.subsystem ?? '') === (type.subsystem ?? '')) ?? type;
  saveSpec('type', { ...moved, id: newId, previousIds: traced(moved.previousIds, oldId) } as TypeSpec);
  invalidateSpecCache();
  // Step 15: the file it left behind.
  removeSpecFile(typeFileOf(oldId, type), oldId);
  if (loadTypeSpecs().some((t) => t.id === oldId && (t.subsystem ?? '') === (type.subsystem ?? ''))) deleteSpec('type', oldId);
  invalidateSpecCache();
  // Step 16: the debt register, keyed by the move.
  const carried = projectConfigRepository.rekeyCarried(rename);
  // Step 17.
  return {
    from: qualifiedTypeId(type),
    to: qualifiedTypeId({ id: newId, subsystem: type.subsystem }),
    rewritten,
    keptPublicNames: kept.names,
    carried,
  };
}

/** What renaming a field of a type changed (field_rename). */
export interface FieldRename {
  /** The type whose field moved, qualified by its owning subsystem when it has one. */
  type: string;
  /** The field's name before the rename. */
  from: string;
  /** The field's name after the rename. */
  to: string;
  /** Ids of the other specs whose references to the field were respelled. */
  rewritten: string[];
}

/**
 * Rename a field of a type and every reference to it in the bound tree
 * (core_orchestrator.renameField). The field keeps its place, type and
 * description under the new name, its old name appended to its rename trace
 * (previousNames — `formerly` in the design export); every foreign key
 * `references: <type>.<field>` naming it is respelled. Traces and prose are
 * never rewritten. Refuses before any write: a type that does not exist
 * (type-missing), one in another project (chained-type), a field it does not
 * declare (field-missing), a new name that is not an identifier
 * (invalid-name), and a name another field holds or retired (name-taken,
 * name-retired).
 */
export function renameField(typeId: string, field: string, newName: string): FieldRename {
  // Steps 1-2: the type, resolved as renameType resolves it.
  const all = loadTypeSpecs();
  const cut = typeId.lastIndexOf('::');
  const qualifier = cut >= 0 ? typeId.slice(0, cut) : undefined;
  const ownSubsystem = qualifier !== undefined && loadSubsystemSpecs().some((s) => s.id === qualifier);
  if (qualifier !== undefined && !ownSubsystem) {
    throw new WaironError(`chained-type: "${typeId}" lives in another project; rename its field from that project's own root. ${memberRootWay(typeId, `sdd_rename_field ${typeId.slice(cut + 2)} ${field} <new name>`)}`);
  }
  const type: TypeSpec | null = qualifier !== undefined
    ? all.find((t) => t.id === typeId.slice(cut + 2) && t.subsystem === qualifier) ?? null
    : loadTypeSpec(typeId);
  if (!type) throw new WaironError(`type-missing: no type has the id "${typeId}".`);
  if (type.id.includes('::')) {
    throw new WaironError(`chained-type: "${type.id}" lives in another project; rename its field from that project's own root.`);
  }
  // Step 3: the field, the new name, and the names the type holds or retired.
  const fields = type.fields ?? [];
  const moving = fields.find((f) => f.name === field);
  if (!moving) {
    throw new WaironError(`field-missing: type "${type.id}" declares no field "${field}"${fields.length ? ` (it declares ${fields.map((f) => f.name).join(', ')})` : ''}.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newName)) {
    throw new WaironError(`invalid-name: "${newName}" is not an identifier (a letter or underscore, then letters, digits or underscores).`);
  }
  const taken = fields.find((f) => f !== moving && f.name === newName);
  if (taken) throw new WaironError(`name-taken: type "${type.id}" already has a field "${newName}".`);
  const retired = fields.find((f) => f !== moving && (f.previousNames ?? []).includes(newName));
  if (retired) {
    throw new WaironError(`name-retired: field "${retired.name}" of type "${type.id}" lists "${newName}" in its previousNames — the name is retired on this type. Unsetting that previousNames releases it.`);
  }
  if (newName === field) return { type: qualifiedTypeId(type), from: field, to: newName, rewritten: [] };

  // Step 4: every foreign key naming the field, collected without writing.
  const others = all.filter((t) => t !== type);
  /** Whether a `references` value names this type's moving field. */
  const namesField = (ref: unknown, owner: string | undefined): boolean => {
    if (typeof ref !== 'string') return false;
    const dot = ref.lastIndexOf('.');
    if (dot <= 0 || ref.slice(dot + 1) !== field) return false;
    const head = ref.slice(0, dot);
    if (!typeMatchesRef(type, head)) return false;
    if (!others.some((t) => typeMatchesRef(t, head))) return true;
    return (owner ?? '') === (type.subsystem ?? '');
  };
  const specsDir = aiPathsAt(getProjectRoot()).specsDir();
  const respell = (dryRun: boolean): RewrittenSpec[] => {
    const out: RewrittenSpec[] = [];
    for (const file of listFilesRecursive(specsDir, '.yaml')) {
      let raw: any;
      try {
        raw = readYamlFile(file);
      } catch {
        continue;
      }
      if (!raw || typeof raw !== 'object' || specKind(raw) !== 'type') continue;
      // The type's own self-references move with it below.
      if (raw.id === type.id && (raw.subsystem ?? '') === (type.subsystem ?? '')) continue;
      const owner = typeof raw.subsystem === 'string' ? raw.subsystem : undefined;
      let changed = false;
      for (const f of Array.isArray(raw.fields) ? raw.fields : []) {
        if (!namesField(f?.references, owner)) continue;
        f.references = `${f.references.slice(0, f.references.lastIndexOf('.'))}.${newName}`;
        changed = true;
      }
      if (!changed) continue;
      if (!dryRun) writeYamlFile(file, raw);
      out.push({ kind: 'type', id: String(raw.id) });
    }
    return out;
  };
  assertSpecsInReach([{ kind: 'type', id: type.id }, ...respell(true)], `renaming field "${field}" of type "${typeId}"`, false);
  // Step 5: the references.
  const rewritten = respell(false).map((spec) => spec.id);
  invalidateSpecCache();
  // Step 6: the field under its new name, its old one traced; a self-reference moves with it.
  const stored = loadTypeSpecs().find((t) => t.id === type.id && (t.subsystem ?? '') === (type.subsystem ?? '')) ?? type;
  const renamed = (stored.fields ?? []).map((f) => {
    const self = namesField(f.references, type.subsystem)
      ? { references: `${f.references!.slice(0, f.references!.lastIndexOf('.'))}.${newName}` }
      : {};
    return f.name === field
      ? { ...f, ...self, name: newName, previousNames: [...(f.previousNames ?? []), field] }
      : { ...f, ...self };
  });
  saveSpec('type', { ...stored, fields: renamed } as TypeSpec);
  invalidateSpecCache();
  // Step 7.
  return { type: qualifiedTypeId(type), from: field, to: newName, rewritten };
}

/** What renaming a parameter of a contract method changed (param_rename). */
export interface ParamRename {
  /** The component whose contract method's parameter moved. */
  component: string;
  /** The contract method the parameter belongs to. */
  method: string;
  /** The parameter's name before the rename. */
  from: string;
  /** The parameter's name after it. */
  to: string;
  /** Ids of the interfaces the parameter was renamed in. */
  movedIn: string[];
  /** The endpoint path placeholders respelled, `<interface>.<method>: {old} -> {new}`. */
  rewritten: string[];
}

/**
 * Rename a parameter of a contract method (core_orchestrator.renameParam). The
 * parameter moves on every interface of the component that declares the
 * method, keeping its place, type, description and optionality, its old name
 * appended to its rename trace (previousNames — `formerly` in the design
 * export); the writer re-derives each signature from the params, and an HTTP
 * path placeholder `{old}` on the method's own binding is respelled. Prose is
 * never rewritten. Refuses before any write: component-missing,
 * chained-component, method-missing, param-missing, invalid-name, name-taken
 * and name-retired.
 */
export function renameParam(componentId: string, methodName: string, param: string, newName: string): ParamRename {
  // Steps 1-2: the component, in this project.
  const component = loadComponentSpec(componentId);
  if (!component) throw new WaironError(`component-missing: no component has the id "${componentId}".`);
  if (componentId.includes('::')) {
    throw new WaironError(
      `chained-component: "${componentId}" lives in another project; rename its parameter from that project's own root. ${memberRootWay(componentId, `sdd_rename_param ${componentId.slice(componentId.lastIndexOf('::') + 2)} ${methodName} ${param} <new name>`)}`,
    );
  }
  // Step 3: the contracts that declare the method.
  const contracts = loadInterfaceSpecs().filter((i) => i.component === componentId);
  const moving = contracts.filter((i) => i.methods.some((m) => m.name === methodName));
  // Step 4: every guard, before any write.
  if (moving.length === 0) throw new WaironError(`method-missing: no contract of "${componentId}" declares the method "${methodName}".`);
  for (const contract of moving) {
    const method = contract.methods.find((m) => m.name === methodName)!;
    const params = method.params ?? [];
    if (method.signatureFrom !== undefined) {
      throw new WaironError(`param-missing: "${contract.id}.${methodName}" takes its parameters from ${method.signatureFrom}; rename the parameter there.`);
    }
    if (!params.some((p) => p.name === param)) {
      throw new WaironError(`param-missing: "${contract.id}.${methodName}" declares no parameter "${param}"${params.length ? ` (it declares ${params.map((p) => p.name).join(', ')})` : ''}.`);
    }
    if (params.some((p) => p.name === newName && p.name !== param)) {
      throw new WaironError(`name-taken: "${contract.id}.${methodName}" already has a parameter "${newName}".`);
    }
    const retired = params.find((p) => p.name !== param && (p.previousNames ?? []).includes(newName));
    if (retired) {
      throw new WaironError(`name-retired: parameter "${retired.name}" of "${contract.id}.${methodName}" lists "${newName}" in its previousNames — the name is retired on this method. Unsetting that previousNames releases it.`);
    }
  }
  if (!IDENTIFIER.test(newName)) {
    throw new WaironError(`invalid-name: "${newName}" is not an identifier (a letter or underscore, then letters, digits or underscores).`);
  }
  // A producer names the parameters of an extension point this component implements.
  const variables = projectConfigRepository.load()?.rules?.naming?.variables;
  const dictated = contracts.some((i) => i.implements !== undefined);
  if (variables && !dictated && !methodNameFits(newName, variables)) {
    throw new WaironError(`invalid-name: "${newName}" does not match this tree's parameter naming (rules.naming.variables: ${variables}).`);
  }
  if (newName === param) return { component: componentId, method: methodName, from: param, to: newName, movedIn: [], rewritten: [] };
  // Step 5: the hosted request's write reach, before the first write.
  assertSpecsInReach(moving.map((i) => ({ kind: 'interface', id: i.id })), `renaming parameter "${param}" of "${componentId}.${methodName}"`, false);
  // Steps 6-8: the parameter moves on each contract; the writer derives the signature.
  const rewritten: string[] = [];
  const placeholder = `{${param}}`;
  for (const contract of moving) {
    saveInterfaceSpec({
      ...contract,
      methods: contract.methods.map((m) => {
        if (m.name !== methodName) return m;
        const params = (m.params ?? []).map((p) => (p.name === param
          ? { ...p, name: newName, previousNames: [...(p.previousNames ?? []), param] }
          : p));
        let endpoint = m.endpoint;
        if (endpoint && endpoint.transport === 'HTTP' && endpoint.path.includes(placeholder)) {
          endpoint = { ...endpoint, path: endpoint.path.split(placeholder).join(`{${newName}}`) };
          rewritten.push(`${contract.id}.${methodName}: {${param}} -> {${newName}}`);
        }
        return { ...m, params, ...(endpoint ? { endpoint } : {}) };
      }),
    });
  }
  // Step 9.
  invalidateSpecCache();
  // Step 10.
  return { component: componentId, method: methodName, from: param, to: newName, movedIn: moving.map((i) => i.id), rewritten };
}

/** The file the loader keeps a type in, by its id, owner and group. */
function typeFileOf(id: string, type: TypeSpec): string {
  return getTypePath(id, type.subsystem, type.group);
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
export function normalizeReferences(kind: WritableSpecKind, id: string): boolean {
  // Step 1.
  return normalizeSpecReferences(kind, id);
}

/** An external declaration's source in its object form, whichever form was written (readExternalSource). */
function externalSourceOf(declaration: { source?: unknown } | undefined): ExternalSource | undefined {
  return readExternalSource(declaration?.source).source;
}
