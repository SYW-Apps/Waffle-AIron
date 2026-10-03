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
  type RefPosition,
  type SpecRefKind,
  assertSpecsInReach,
} from './specs.js';
import { aiPathsAt } from '../config/paths.js';
// git_source_adapter (stage 8): a git member's commit resolved and fetched.
import * as gitSource from './adapters/git-source.js';
import { projectConfigRepository, projectConfigRepositoryAt } from '../config/project-config.js';
import { getProjectRoot, runWithProjectRoot, ensureDir, listFilesRecursive } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { WaironError } from '../utils/errors.js';
import { admits, declaredMembers, DesignDepthSchema, type ExternalSource, effectiveProjectId, memberLocationOf, parseMemberSource, requiredPolicies, EXTERNAL_ALIAS_RE, type InternalizeDestination, type MemberDeclaration, type PackRequirement, type PackSelection, type ProjectConfig } from '../models/project.js';
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
  /** part | project: what was created (stage 8; a part by default). */
  as: string;
  /** contained | path | git: where its files live. */
  storage: string;
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
    ? { ...scaffoldMemberProject(alias, memberDir, description), as: 'project' }
    : { ...scaffoldPart(alias, memberDir, parsed.storage === 'contained'), as: 'part' };
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
export function externalizeSubsystem(subsystemId: string, path: string, as?: string): void {
  externalizeInto(subsystemId, path, as);
}

/** externalizeSubsystem's body, with the path module in scope. */
function externalizeInto(subsystemId: string, partPath: string, as: string | undefined): void {
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
  if (!fs.existsSync(fooDir)) throw new WaironError(`subsystem specs directory not found: ${fooDir}`);
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
  const targetDir = path.join(aiPathsAt(partDir).specsDir(), subsystemId);
  if (fs.existsSync(targetDir)) throw new WaironError(`target already contains a "${subsystemId}" subsystem: ${targetDir}`);
  // Step 8 checked first: an externalize as project is one write or none.
  if (as === 'project') {
    if (joined) throw new WaironError(`cannot externalize "${subsystemId}" as a project into the existing part "${joined.alias}": externalize it into the part, then promote the part (\`wairon member promote ${joined.alias}\`).`);
    const refusals = promoteRefusals(family, specFilesUnder(fooDir), ownSpecFiles(family, fooDir), alias);
    if (refusals.length > 0) throw new WaironError(`cannot externalize "${subsystemId}" as a project: ${refusals.join('; ')}.`);
  }
  // Step 5: the subtree moves into the part; its implementations' file paths re-expressed.
  ensureDir(path.dirname(targetDir));
  fs.renameSync(fooDir, targetDir);
  rebaseImplementationPaths(targetDir, parentRoot, partDir);
  // Step 6: declared under the subsystem id by the shorthand, unless it joined a part.
  if (!joined) projectConfigRepository.declareMember(alias, { source: relPath });
  invalidateSpecCache();
  // Steps 7-8: as a project, the new part is promoted in place.
  if (as === 'project') promoteMember(alias);
  // Step 9.
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

/** The identifiers of a type expression. */
function typeTokens(expression: unknown): string[] {
  return typeof expression === 'string' ? [...expression.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)].map((m) => m[0]) : [];
}

/** Every reference a spec's fields hold, with its position, and the bare type names its type expressions spell. */
function referencesOf(spec: RawSpec, wholeParams: boolean): { ref: string; position: RefPosition | 'bare-type' }[] {
  const out: { ref: string; position: RefPosition | 'bare-type' }[] = [];
  rewriteSpecRefs(JSON.parse(JSON.stringify(spec.raw)), (ref, position) => {
    out.push({ ref, position });
    return ref;
  });
  // Into the new project a parameter's type written as one name is respelled
  // whole (`wholeParams` false); every other type expression — a return, a
  // field, a union, and any type back out — keeps its text and imports the name.
  const expressions: unknown[] = [];
  if (spec.kind === 'interface') {
    for (const m of spec.raw.methods ?? []) {
      expressions.push(m?.returns);
      for (const p of m?.params ?? []) if (wholeParams || !(typeof p?.type === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(p.type))) expressions.push(p?.type);
    }
  }
  if (spec.kind === 'type') for (const f of spec.raw.fields ?? []) expressions.push(f?.type);
  for (const token of expressions.flatMap(typeTokens)) out.push({ ref: token, position: 'bare-type' });
  return out;
}

/** What crosses between the `inside` specs and the `outside` ones, both ways, by the ids each side declares. */
function crossingsOf(inside: RawSpec[], outside: RawSpec[]): { out: Crossing[]; in: Crossing[]; insideIds: Set<string>; outsideIds: Set<string> } {
  const idsOf = (specs: RawSpec[]): Set<string> => new Set(specs.filter((s) => s.kind !== 'system').map((s) => s.id));
  const insideIds = idsOf(inside);
  const outsideIds = idsOf(outside);
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
  return { out: collect(inside, outsideIds, outsideTypes, true), in: collect(outside, insideIds, insideTypes, false), insideIds, outsideIds };
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
function rewriteRefsIn(specs: RawSpec[], remap: (ref: string, position: RefPosition) => string): RewrittenSpec[] {
  const rewritten: RewrittenSpec[] = [];
  for (const spec of specs) {
    const raw = readYamlFile(spec.file) as any;
    if (!rewriteSpecRefs(raw, (ref, position) => remap(ref, position))) continue;
    writeYamlFile(spec.file, raw);
    rewritten.push({ kind: spec.kind, id: spec.id });
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
export function promoteMember(alias: string, id?: string): void {
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
  // Step 9: every reference across the new boundary respelled, targets unchanged.
  const parentSide = rewriteRefsIn(crossing.in.map((c) => c.spec).filter(unique), (ref, position) =>
    (INTO_MEMBER_POSITIONS.has(position) && crossing.insideIds.has(ref) ? `${alias}::${ref}` : ref));
  const climbs = climbsOf(family, crossing.insideIds, parentId).map;
  const climbing = inside.filter((s) => family.authoredReferences.some((r) => r.form === 'super' && r.specId === s.id));
  const memberSide = rewriteRefsIn([...crossing.out.map((c) => c.spec), ...climbing].filter(unique), (ref, position) =>
    climbs.get(ref) ?? (MOVED_REF_POSITIONS.has(position) && crossing.outsideIds.has(ref) ? `${parentId}::${ref}` : ref));
  invalidateSpecCache();
  // Step 10: the new project declares the parent as its external when it references it.
  if (crossing.out.length > 0 || [...climbs.values()].some((t) => t.startsWith(`${parentId}::`))) runWithProjectRoot(dir, () => projectConfigRepository.declareExternal(parentId, {}));
  // Step 11: the parent's re-exports of the part's subsystems re-export the member.
  for (const s of inside.filter((x) => x.kind === 'subsystem')) restateReExports(s.id, alias);
  // Steps 12-13: what crosses is exported on its own side, and a bare type name imported by name.
  exportCrossings(crossing.out, dir, alias, parentId, 'out');
  exportCrossings(crossing.in, dir, alias, parentId, 'in');
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
  // Step 14: promoted; nothing locked.
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
function exportCrossings(crossings: Crossing[], memberDir: string, alias: string, parentId: string, direction: 'out' | 'in'): void {
  const targets = [...new Set(crossings.map((c) => c.target))];
  const bare = [...new Set(crossings.filter((c) => c.position === 'bare-type').map((c) => c.target))];
  if (direction === 'out') {
    exportItems(targets);
    if (bare.length > 0) projectConfigRepositoryAt(memberDir).importNames(parentId, bare);
  } else {
    runWithProjectRoot(memberDir, () => exportItems(targets));
    if (bare.length > 0) projectConfigRepository.importNames(alias, bare);
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
  const result: InternalizeResult = { subsystems: scan.subsystems, types: scan.types, placed: [], externals: [], deleted: [], notCarried: [] };
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
  return { subsystems: part.subsystems, types, placed: [], externals: [], deleted, notCarried: [] };
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
    const source = decl.source?.path !== undefined && !path.isAbsolute(decl.source.path)
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
  const result: InternalizeResult = { subsystems, types, placed: [], externals: [], deleted: [], notCarried: [] };
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
  // Step 15.
  return result;
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
  for (const e of retired.filter((x) => x.typeDef !== undefined && x.from === undefined)) {
    const type = loadTypeSpecs().find((t) => t.id === e.typeDef);
    if (!type?.subsystem) continue;
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
  assertSpecsInReach(
    [...renamed.map(({ kind, from }) => ({ kind, id: from })), ...rewriteRefFields(specsDir, remap, undefined, true), ...rekeyLintAllows(specsDir, rename, true)],
    `renaming component "${componentId}"`,
    Array.isArray(registerEdits) && registerEdits.length > 0,
  );
  const rewrittenRefs = rewriteRefFields(specsDir, remap);
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
  const retargeted = rewriteRefFields(specsDir, methodRemap);
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
