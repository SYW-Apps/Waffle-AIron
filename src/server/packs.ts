import * as fs from 'fs';
import * as path from 'path';
import { runWithProjectRoot, getProjectRoot } from '../utils/fs.js';
import { parseYaml, readYamlFile } from '../utils/yaml.js';
import { loadProjectConfig, saveProjectConfig, AI_PATHS } from '../config/loader.js';
import {
  globalPacksDir,
  discoverPacks,
  loadExtensionPacks,
  DeclarativePackSchema,
  type PackScope,
} from '../core/extensions.js';
import { authenticateMaster } from './auth.js';
import { AdminAuthError } from './admin.js';
import { existingProjectRoot } from './projects.js';
import type { HostConfig, PackDescriptor, ProjectPackReference, ProjectProfileSelection } from './types.js';

// ---------------------------------------------------------------------------
// Pack Registry (store I/O) + Pack Orchestrator (control-plane workflow) — sdd_host
//
// The container's extension-pack store. Server-global packs are discovered from
// TWO tiers and merged: the immutable IMAGE-LAYER directory
// (WAIRON_IMAGE_PACKS_DIR, default /opt/wairon/packs) baked into extended images
// at build time and never written at runtime, and the mutable INSTANCE directory
// (WAIRON_PACKS_DIR, defaulted onto the data volume so installs persist). On a
// name collision the INSTANCE pack wins and the shadowed image pack is surfaced
// as drift; install/remove touch the instance tier ONLY (the image tier is
// immutable). It also manages a bound project's .wai/packs/ plus its project.yaml
// registration, and can read a project's declared pack/profile references for
// drift checks. Installs over this surface are DECLARATIVE-ONLY (profiles +
// language/platform tables — pure data); programmatic rule/code packs are refused
// here and must be installed via the trusted filesystem (a baked image layer, a
// mounted packs volume, or `wairon packs add`). The orchestrator layer adds
// master-credential auth and project-scope binding.
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const PACK_EXT_RE = /\.(ya?ml|cjs|js)$/i;

/** Guard the pack name so it can never traverse out of the packs directory. */
function assertName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid pack name "${name}" (allowed: letters, digits, dot, underscore, hyphen).`);
  }
}

/** Reject anything that isn't a declarative pack (profiles + language tables).
 *  Rule/code packs are executable and must go through the trusted filesystem. */
function assertDeclarative(content: string): void {
  const guidance =
    'Only declarative packs (name + profiles + language/platform tables) install over this surface; ' +
    'rule/code packs are executable and install via the trusted filesystem (mount into WAIRON_PACKS_DIR, ' +
    'or run `wairon packs add`).';
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    throw new Error(`Not a valid declarative pack: ${e instanceof Error ? e.message : String(e)}. ${guidance}`);
  }
  const result = DeclarativePackSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Not a valid declarative pack (${result.error.issues[0]?.message ?? 'shape mismatch'}). ${guidance}`);
  }
}

/** Load one pack ref in isolation to learn its name and contents. Never throws
 *  for a bad pack — the load error rides on the descriptor. */
function probe(loadRef: string, baseRoot: string, scope: PackScope, displayRef: string): PackDescriptor {
  const loaded = loadExtensionPacks([{ ref: loadRef, scope }], baseRoot);
  if (loaded.errors.length) {
    return { name: path.basename(displayRef), scope, ref: displayRef, profiles: 0, languages: 0, rules: 0, error: loaded.errors[0] };
  }
  return {
    name: loaded.packNames[0] ?? path.basename(displayRef),
    scope,
    ref: displayRef,
    profiles: Object.keys(loaded.profiles).length,
    languages: Object.keys(loaded.languages).length,
    rules: loaded.rules.length,
  };
}

/** Write a file atomically (tmp + rename), creating parent dirs. */
function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

/** The name stem of a pack ref (basename without a pack extension). */
function stem(ref: string): string {
  return path.basename(ref).replace(PACK_EXT_RE, '');
}

// ── pack_registry: server-global store (two-tier: image + instance) ───────────

/**
 * The immutable image-layer packs directory (WAIRON_IMAGE_PACKS_DIR, default
 * /opt/wairon/packs): baked into extended images at build time (built FROM the
 * base image + `COPY packs/`) and never written at runtime. An absent directory
 * is simply an empty tier — local/dev deployments have no image layer, which is
 * normal, never an error (discoverPacks returns [] for a missing dir).
 */
function imagePacksDir(): string {
  return process.env.WAIRON_IMAGE_PACKS_DIR ?? '/opt/wairon/packs';
}

/** Probe every pack in one server-global tier, tagging each descriptor's tier. */
function probeTier(dir: string, tier: 'image' | 'instance'): PackDescriptor[] {
  return discoverPacks(dir).map((full) => {
    const d = probe(full, path.dirname(full), 'global', path.basename(full));
    d.tier = tier;
    return d;
  });
}

/**
 * List the server-global packs across BOTH tiers — the immutable image layer
 * (WAIRON_IMAGE_PACKS_DIR) and the mutable instance directory (WAIRON_PACKS_DIR)
 * — probing each in isolation and returning their union as tier-tagged
 * descriptors. The instance pack wins on a name collision: the image copy stays
 * in the listing marked `shadowed: true` (the instance copy is the effective
 * one), so drift is visible in the listing itself. Never throws for a bad pack —
 * the error rides on its descriptor.
 *
 * Exported as the pre-authorized server-internal read: the gated
 * `listGlobalPacks` wraps it with admin auth for the admin plane, while the
 * operations orchestrator calls it directly after its own operations:read check.
 */
export function storeListGlobalPacks(): PackDescriptor[] {
  const instance = probeTier(globalPacksDir(), 'instance');
  const instanceNames = new Set(instance.map((d) => d.name));
  const image = probeTier(imagePacksDir(), 'image').map((d) =>
    instanceNames.has(d.name) ? { ...d, shadowed: true } : d,
  );
  return [...instance, ...image];
}

function storeInstallGlobalPack(name: string, content: string): PackDescriptor {
  assertName(name);
  assertDeclarative(content);
  // Installs write the MUTABLE instance tier only; the image layer is immutable.
  const dir = globalPacksDir();
  const file = path.join(dir, `${name}.yaml`);
  writeFileAtomic(file, content);
  const descriptor = probe(file, dir, 'global', `${name}.yaml`);
  descriptor.tier = 'instance';
  return descriptor;
}

function storeRemoveGlobalPack(name: string): void {
  assertName(name);
  // Removals touch the MUTABLE instance tier only; a pack that lives solely in
  // the immutable image layer cannot be removed here. Removing an instance pack
  // that shadowed a same-named image pack re-exposes the image pack.
  const dir = globalPacksDir();
  const match = discoverPacks(dir).find((ref) => stem(ref) === name || path.basename(ref) === name);
  if (!match) {
    const inImage = discoverPacks(imagePacksDir()).some(
      (ref) => stem(ref) === name || path.basename(ref) === name,
    );
    throw new Error(
      inImage
        ? `Pack "${name}" is an immutable image-layer pack (WAIRON_IMAGE_PACKS_DIR) and cannot be removed at runtime; rebuild the extension image without it.`
        : `No server-global instance pack named "${name}".`,
    );
  }
  fs.rmSync(match, { recursive: true, force: true });
}

// ── pack_registry: bound-project store (assumes a project root is bound) ───────

function storeListProjectPacks(): PackDescriptor[] {
  const root = getProjectRoot();
  const refs = loadProjectConfig().extensions?.packs ?? [];
  return refs.map((ref) => probe(ref, root, 'project', ref));
}

function storeInstallProjectPack(name: string, content: string): PackDescriptor {
  assertName(name);
  assertDeclarative(content);
  const root = getProjectRoot();
  const relRef = `.wai/packs/${name}.yaml`;
  writeFileAtomic(path.join(root, '.wai', 'packs', `${name}.yaml`), content);

  const config = loadProjectConfig();
  const packs = config.extensions?.packs ?? [];
  if (!packs.includes(relRef)) {
    config.extensions = { packs: [...packs, relRef], useGlobalPacks: config.extensions?.useGlobalPacks ?? true };
    saveProjectConfig(config);
  }
  return probe(relRef, root, 'project', relRef);
}

function storeRemoveProjectPack(name: string): void {
  assertName(name);
  const root = getProjectRoot();
  const config = loadProjectConfig();
  const packs = config.extensions?.packs ?? [];
  const relRef = `.wai/packs/${name}.yaml`;
  const match = packs.find((ref) => ref === relRef || stem(ref) === name || path.basename(ref) === name);
  if (!match) throw new Error(`Project has no registered pack named "${name}".`);

  config.extensions = { packs: packs.filter((ref) => ref !== match), useGlobalPacks: config.extensions?.useGlobalPacks ?? true };
  saveProjectConfig(config);

  // Delete the vendored file, but never a path outside .wai/packs (the ref may
  // point at a location the user owns).
  const resolved = path.resolve(root, match);
  const vendorDir = path.resolve(root, '.wai', 'packs');
  if (resolved.startsWith(vendorDir + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

// ── pack_registry: project reference read (operational drift checks) ───────────
//
// A path-free read of a GIVEN project's declared pack/profile references straight
// from its .wai/project.yaml, for operational drift checks. Pre-authorized and
// server-internal (the operations orchestrator already authorized operations:read
// before calling), so it is never gated and never portal-exposed. Never throws: a
// missing/empty config yields an empty reference. Carries no filesystem paths
// (only the project id plus declared pack/profile names), so the result is safe
// for redacted diagnostics.

/**
 * Read the given project's declared pack/profile references as a
 * ProjectPackReference: the pack names registered under extensions.packs (by file
 * stem), unioned with the required/default pack names recorded in its
 * profileSelection, plus the selected profile ids. Returns empty reference lists
 * (never throws) when the project has no config or no extensions/profile
 * selection. Reads the raw project.yaml (policy.ts pattern) so the un-schema'd
 * profileSelection survives the read.
 */
export function readProjectReferences(rootPath: string): ProjectPackReference {
  const projectId = path.basename(rootPath);
  const empty: ProjectPackReference = { projectId, packNames: [] };
  try {
    return runWithProjectRoot(rootPath, () => {
      const raw = readYamlFile(AI_PATHS.projectConfig()) as
        | { extensions?: { packs?: string[] }; profileSelection?: ProjectProfileSelection }
        | null;
      if (!raw) return empty;
      const sel = raw.profileSelection;
      const packNames = [
        ...new Set([
          ...(raw.extensions?.packs ?? []).map((ref) => stem(ref)),
          ...(sel?.requiredPackNames ?? []),
          ...(sel?.defaultPackNames ?? []),
        ]),
      ];
      const reference: ProjectPackReference = { projectId, packNames };
      const profileIds = [...new Set(sel?.profileIds ?? [])];
      if (profileIds.length > 0) reference.profileIds = profileIds;
      return reference;
    });
  } catch {
    return empty;
  }
}

// ── pack_orchestrator: master-credential auth + project-scope binding ──────────

function requireAdmin(credential: string | null): void {
  if (!authenticateMaster(credential).authenticated) throw new AdminAuthError();
}

function boundProject(cfg: HostConfig, project: string): string {
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  return root;
}

export function listGlobalPacks(_cfg: HostConfig, credential: string | null): PackDescriptor[] {
  requireAdmin(credential);
  return storeListGlobalPacks();
}

export function installGlobalPack(_cfg: HostConfig, credential: string | null, name: string, content: string): PackDescriptor {
  requireAdmin(credential);
  return storeInstallGlobalPack(name, content);
}

export function removeGlobalPack(_cfg: HostConfig, credential: string | null, name: string): void {
  requireAdmin(credential);
  storeRemoveGlobalPack(name);
}

export function listProjectPacks(cfg: HostConfig, credential: string | null, project: string): PackDescriptor[] {
  requireAdmin(credential);
  return executeApprovedListProjectPacks(cfg, project);
}

export function installProjectPack(cfg: HostConfig, credential: string | null, project: string, name: string, content: string): PackDescriptor {
  requireAdmin(credential);
  return executeApprovedInstallProjectPack(cfg, project, name, content);
}

/** Pre-authorized entries for the policy plane's init/reconcile workflows: same work as the
 *  gated variants but WITHOUT credential authentication — the caller (project_policy_orchestrator)
 *  has already enforced approval- or grant-based authorization. Never exposed on a portal. */
export function executeApprovedListProjectPacks(cfg: HostConfig, project: string): PackDescriptor[] {
  return runWithProjectRoot(boundProject(cfg, project), () => storeListProjectPacks());
}

export function executeApprovedInstallProjectPack(cfg: HostConfig, project: string, name: string, content: string): PackDescriptor {
  return runWithProjectRoot(boundProject(cfg, project), () => storeInstallProjectPack(name, content));
}

export function removeProjectPack(cfg: HostConfig, credential: string | null, project: string, name: string): void {
  requireAdmin(credential);
  runWithProjectRoot(boundProject(cfg, project), () => storeRemoveProjectPack(name));
}
