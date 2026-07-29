import * as fs from 'fs';
import * as path from 'path';
import { runWithProjectRoot, getProjectRoot } from '../utils/fs.js';
import { parseYaml, readYamlFile } from '../utils/yaml.js';
import { loadProjectConfig, saveProjectConfig, AI_PATHS } from '../config/loader.js';
import type { PackScope } from '../core/extensions.js';
import { hostCore, hostSdk } from './adapters.js';
import { authenticateCredential } from './auth.js';
import { authorize } from './authorization.js';
import { AdminAuthError, UnauthenticatedError } from './errors.js';
import { existingProjectRoot } from './projects.js';
import type { AvailableProfile, HostConfig, PackDescriptor, PackResolution, ProfileApplication, ProjectPackReference, ProjectProfileSelection, ResolvedGlobalPack } from './types.js';
import type { PackArchiveInfo, PackExtractionLimits } from '@wairon/sdk';

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
// resolver authorization (instance-level project:admin for the global tier;
// project:admin/project:read over the project for its tier) and scope binding.
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
  const err = hostCore.checkDeclarativePack(parsed);
  if (err) {
    throw new Error(`Not a valid declarative pack (${err}). ${guidance}`);
  }
}

// ── Hosted ZIP (.wpack) archive install (declarative-only) ────────────────────
//
// The archive counterparts of the string-content installs above: inspect the
// envelope via the host SDK adapter and reject a code pack BEFORE any bytes
// touch disk, then safely extract under a HOSTED-STRICT limit profile and
// re-verify the extracted entry is a declarative pack (defense in depth).

/**
 * Hosted extraction caps — deliberately TIGHTER than the SDK default profile
 * (32 MiB total / 8 MiB per entry). Every field is pinned so the hosted
 * zip-bomb guardrails never silently loosen if an SDK default is relaxed; the
 * two tightened caps are the total- and per-entry inflated-size limits.
 */
const HOSTED_STRICT_LIMITS: PackExtractionLimits = {
  maxEntries: 4096, // SDK default
  maxTotalUncompressedBytes: 8 * 1024 * 1024, // 8 MiB (hosted; SDK default 32 MiB)
  maxEntryBytes: 4 * 1024 * 1024, // 4 MiB (hosted; SDK default 8 MiB)
  maxCompressionRatio: 100, // SDK default (zip-bomb guard)
  maxDepth: 16, // SDK default
};

/** Reject a code pack from its inspected envelope — the declarative-only surface
 *  policy — before any bytes touch disk. Code packs install via the trusted
 *  filesystem (a baked image layer, a mounted packs volume, or `wairon packs add`). */
function assertNotCodeArchive(info: PackArchiveInfo): void {
  if (info.kind === 'code') {
    throw new Error(
      `Pack "${info.name}" is a code pack; only declarative packs (profiles + language/platform tables) ` +
      'install over this surface. Install code/rule packs via the trusted filesystem ' +
      '(a baked image layer, a mounted packs volume, or `wairon packs add`).',
    );
  }
}

/** Safely extract a declarative .wpack into a FRESH pack directory under
 *  hosted-strict limits (the SDK enforces zip-slip / entry-count / size /
 *  compression-ratio / depth and verifies integrity), then re-check the
 *  extracted entry parses as a declarative pack, removing the partial
 *  extraction on failure. */
function extractDeclarativeArchive(archive: Uint8Array, destDir: string): void {
  const result = hostSdk.extractArchive(archive, destDir, HOSTED_STRICT_LIMITS);
  try {
    assertDeclarative(fs.readFileSync(path.join(result.directory, result.entryPath), 'utf8'));
  } catch (e) {
    fs.rmSync(destDir, { recursive: true, force: true });
    throw e;
  }
}

/** Load one pack ref in isolation to learn its name and contents. Never throws
 *  for a bad pack — the load error rides on the descriptor. */
function probe(loadRef: string, baseRoot: string, scope: PackScope, displayRef: string): PackDescriptor {
  const loaded = hostCore.loadExtensionPacks([{ ref: loadRef, scope }], baseRoot);
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
    // Structured id lists paralleling the counts above — a UI can present a
    // pack's profiles/languages/rules as choices instead of a bare number.
    profileIds: Object.keys(loaded.profiles),
    languageIds: Object.keys(loaded.languages),
    ruleIds: loaded.rules.map((r) => r.name),
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
  return hostCore.discoverPacks(dir).map((full) => {
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
  const instance = probeTier(hostCore.globalPacksDir(), 'instance');
  const instanceNames = new Set(instance.map((d) => d.name));
  const image = probeTier(imagePacksDir(), 'image').map((d) =>
    instanceNames.has(d.name) ? { ...d, shadowed: true } : d,
  );
  return [...instance, ...image];
}

/** One profile a pack contributes: its id, the pack's CANONICAL name (the value
 *  an AvailableProfile.source carries), and its ProfileDef family. */
type ProfileContribution = { id: string; source: string; family?: string };

/**
 * Collect every profile contributed by the SERVER-GLOBAL packs across BOTH tiers
 * — the mutable instance directory first (so it wins a same-name collision), then
 * the immutable image layer — loading each pack in isolation and tagging its
 * contributions with the pack's canonical name and ProfileDef family. A pack that
 * fails to load contributes nothing (its error rides on its descriptor
 * elsewhere); never throws and never mutates any tier.
 *
 * The single two-tier scan behind BOTH profile catalogs: the instance-wide
 * `storeListAvailableProfiles` and the project-scoped `storeListProjectProfiles`,
 * which differ only in what they layer over it and how they mark it.
 */
function scanGlobalPackProfiles(): ProfileContribution[] {
  const out: ProfileContribution[] = [];
  for (const dir of [hostCore.globalPacksDir(), imagePacksDir()]) {
    for (const full of hostCore.discoverPacks(dir)) {
      try {
        const loaded = hostCore.loadExtensionPacks([{ ref: full, scope: 'global' }], path.dirname(full));
        if (loaded.errors.length) continue; // a bad pack contributes nothing
        const source = loaded.packNames[0] ?? path.basename(full);
        for (const [id, def] of Object.entries(loaded.profiles)) out.push({ id, source, family: def.family });
      } catch {
        /* never throw for a bad pack — skip it */
      }
    }
  }
  return out;
}

/**
 * Collect every profile contributed by the packs registered in the BOUND
 * project's own config (.wai/project.yaml -> extensions.packs) — the tier the
 * instance-wide catalog cannot see, so a pack uploaded straight into a project no
 * longer has invisible profiles. Loads each registered ref in isolation against
 * the project root; a pack that fails to load contributes nothing. Assumes a
 * project root is already bound in scope; mutates nothing.
 */
function scanProjectPackProfiles(): ProfileContribution[] {
  const root = getProjectRoot();
  const out: ProfileContribution[] = [];
  for (const entry of loadProjectConfig().extensions?.packs ?? []) {
    try {
      // A by-name selection resolves through the bundle/store first; an
      // unresolvable one contributes no profiles, exactly like a bad pack.
      const ref = hostCore.packEntryRef(entry, root);
      if (!ref) continue;
      const loaded = hostCore.loadExtensionPacks([{ ref, scope: 'project' }], root);
      if (loaded.errors.length) continue; // a bad pack contributes nothing
      const source = loaded.packNames[0] ?? stem(hostCore.packEntryLabel(entry));
      for (const [id, def] of Object.entries(loaded.profiles)) out.push({ id, source, family: def.family });
    } catch {
      /* never throw for a bad pack — skip it */
    }
  }
  return out;
}

/**
 * Aggregate the profiles selectable INSTANCE-WIDE — a pre-authorized internal
 * read (no credential gate). Emits every built-in profile id (via the core
 * adapter) tagged source 'builtin', then every profile contributed by the
 * server-global packs across BOTH tiers, tagged with the contributing pack's
 * canonical name and its ProfileDef family. Deduped by (id, source) so the
 * instance tier wins a same-name collision. A pack that fails to load contributes
 * nothing; this read never throws and never mutates any tier.
 *
 * Deliberately carries NO `installed` flag: project installation is not a
 * meaningful question for an instance-wide catalog, and this catalog cannot see a
 * project's own packs at all — that is what `storeListProjectProfiles` is for.
 */
export function storeListAvailableProfiles(): AvailableProfile[] {
  const out: AvailableProfile[] = [];
  const seen = new Set<string>();
  const emit = (id: string, source: string, family?: string): void => {
    const key = JSON.stringify([id, source]); // dedup by (id, source), collision-safe
    if (seen.has(key)) return;
    seen.add(key);
    out.push(family ? { id, source, family } : { id, source });
  };

  for (const id of hostCore.builtinProfileIds()) emit(id, 'builtin');
  for (const c of scanGlobalPackProfiles()) emit(c.id, c.source, c.family);
  return out;
}

/**
 * Aggregate the profiles selectable for ONE project — the catalog a project-type
 * picker must use, and a pre-authorized internal read (no credential gate).
 * Assumes the project's root is already bound in scope. Three contributions, in
 * this order:
 *
 *   1. the built-in profile ids (source 'builtin', installed) — they always govern;
 *   2. the profiles contributed by the packs registered in THIS project's own
 *      config (source = the pack's canonical name, installed) — the tier the
 *      instance-wide catalog cannot see;
 *   3. the profiles contributed by the server-global packs across both tiers
 *      (NOT installed) — adoptable, and vendored by the write path on selection.
 *
 * Deduped by (id, source) keeping the FIRST emission, so for the same pack name
 * the PROJECT tier wins over the server-global tier and its profile is reported
 * installed rather than adoptable. Carries `family` through from each ProfileDef.
 * A pack that fails to load contributes nothing; never throws, mutates no tier.
 */
function storeListProjectProfiles(): AvailableProfile[] {
  const out: AvailableProfile[] = [];
  const seen = new Set<string>();
  const emit = (id: string, source: string, installed: boolean, family?: string): void => {
    const key = JSON.stringify([id, source]); // dedup by (id, source), collision-safe
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, source, ...(family ? { family } : {}), installed });
  };

  for (const id of hostCore.builtinProfileIds()) emit(id, 'builtin', true);
  for (const c of scanProjectPackProfiles()) emit(c.id, c.source, true, c.family);
  for (const c of scanGlobalPackProfiles()) emit(c.id, c.source, false, c.family);
  return out;
}

/** Read a discovered pack's declarative content: the file itself for a file-form
 *  pack, or its pack.yaml/pack.yml entry for a directory-form pack (what a .wpack
 *  install extracts). Null when a directory carries no declarative entry (e.g. a
 *  code-only pack) — the caller treats that as unresolved rather than vendoring it. */
function readPackContent(full: string): string | null {
  const st = fs.statSync(full);
  if (st.isFile()) return fs.readFileSync(full, 'utf8');
  if (st.isDirectory()) {
    for (const entry of ['pack.yaml', 'pack.yml']) {
      const p = path.join(full, entry);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8');
    }
  }
  return null;
}

/**
 * Resolve a set of policy-supplied pack names against the server-global pack set,
 * across BOTH tiers (the mutable instance directory first so it wins on a name
 * collision, then the immutable image layer) and BOTH file- and directory-form
 * packs, matching each requested name against a pack's file stem, basename, OR its
 * loaded manifest name. Returns a PackResolution partitioning the input into
 * resolved packs — each carrying its CANONICAL manifest name, serialized
 * declarative content, and originating tier (deduplicated by canonical name) — and
 * unresolved names with no readable match in either tier. Never mutates any tier;
 * a name that cannot be resolved is REPORTED (never silently dropped).
 */
export function storeResolveGlobalPacks(names: string[]): PackResolution {
  type Candidate = { full: string; manifestName: string; tier: 'instance' | 'image' };
  const index = new Map<string, Candidate>();
  const indexTier = (dir: string, tier: 'instance' | 'image'): void => {
    for (const full of hostCore.discoverPacks(dir)) {
      const manifestName = probe(full, path.dirname(full), 'global', path.basename(full)).name;
      const candidate: Candidate = { full, manifestName, tier };
      // Key by every alias the policy might name it under; the instance tier is
      // indexed first, so its entry wins a collision (never overwritten).
      for (const key of [manifestName, stem(full), path.basename(full)]) {
        if (!index.has(key)) index.set(key, candidate);
      }
    }
  };
  indexTier(hostCore.globalPacksDir(), 'instance');
  indexTier(imagePacksDir(), 'image');

  const resolved: ResolvedGlobalPack[] = [];
  const resolvedCanonical = new Set<string>();
  const unresolved: string[] = [];
  for (const requested of new Set(names)) {
    const candidate = index.get(requested);
    const content = candidate ? readPackContent(candidate.full) : null;
    if (!candidate || content == null) {
      unresolved.push(requested);
      continue;
    }
    if (resolvedCanonical.has(candidate.manifestName)) continue; // dedup by canonical identity
    resolvedCanonical.add(candidate.manifestName);
    resolved.push({ requestedName: requested, name: candidate.manifestName, content, tier: candidate.tier });
  }
  return { resolved, unresolved };
}

function storeInstallGlobalPack(name: string, content: string): PackDescriptor {
  assertName(name);
  assertDeclarative(content);
  // Installs write the MUTABLE instance tier only; the image layer is immutable.
  const dir = hostCore.globalPacksDir();
  const file = path.join(dir, `${name}.yaml`);
  writeFileAtomic(file, content);
  const descriptor = probe(file, dir, 'global', `${name}.yaml`);
  descriptor.tier = 'instance';
  return descriptor;
}

/**
 * Install a declarative pack from a .wpack archive into the MUTABLE instance
 * packs directory (WAIRON_PACKS_DIR); the image tier is never written. Inspect
 * + reject a code pack before disk, derive + sanitize the pack name (envelope,
 * or the optional override), extract into <instance packs dir>/<name> under
 * hosted-strict limits, re-verify it is declarative, and return its probe
 * (tier 'instance').
 */
function storeInstallGlobalPackArchive(archive: Uint8Array, name?: string): PackDescriptor {
  const info = hostSdk.inspectArchive(archive);
  assertNotCodeArchive(info);
  const packName = name ?? info.name;
  assertName(packName);
  const dir = path.join(hostCore.globalPacksDir(), packName);
  extractDeclarativeArchive(archive, dir);
  const descriptor = probe(dir, hostCore.globalPacksDir(), 'global', packName);
  descriptor.tier = 'instance';
  return descriptor;
}

function storeRemoveGlobalPack(name: string): void {
  assertName(name);
  // Removals touch the MUTABLE instance tier only; a pack that lives solely in
  // the immutable image layer cannot be removed here. Removing an instance pack
  // that shadowed a same-named image pack re-exposes the image pack.
  const dir = hostCore.globalPacksDir();
  const match = hostCore.discoverPacks(dir).find((ref) => stem(ref) === name || path.basename(ref) === name);
  if (!match) {
    const inImage = hostCore.discoverPacks(imagePacksDir()).some(
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
  const entries = loadProjectConfig().extensions?.packs ?? [];
  // Selections are probed at their resolved location but LISTED under their
  // declared label, so the hosted view shows what the project asked for.
  return entries.map((entry) => {
    const label = hostCore.packEntryLabel(entry);
    const ref = hostCore.packEntryRef(entry, root);
    return probe(ref ?? label, root, 'project', label);
  });
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
    config.extensions = { packs: [...packs, relRef], useGlobalPacks: hostCore.globalPacksEnabled(config) };
    saveProjectConfig(config);
  }
  return probe(relRef, root, 'project', relRef);
}

/**
 * Archive counterpart of storeInstallProjectPack for the bound project: inspect
 * + reject a code pack before disk, safely extract the declarative pack into
 * .wai/packs/<name>/ under hosted-strict limits, and register that
 * project-relative DIRECTORY ref in .wai/project.yaml under extensions.packs
 * (idempotent). Committed with the project, so every clone and CI enforce it.
 * Assumes a project root is already bound in scope.
 */
function storeInstallProjectPackArchive(archive: Uint8Array, name?: string): PackDescriptor {
  const info = hostSdk.inspectArchive(archive);
  assertNotCodeArchive(info);
  const packName = name ?? info.name;
  assertName(packName);
  const root = getProjectRoot();
  const relRef = `.wai/packs/${packName}`;
  extractDeclarativeArchive(archive, path.join(root, '.wai', 'packs', packName));

  const config = loadProjectConfig();
  const packs = config.extensions?.packs ?? [];
  if (!packs.includes(relRef)) {
    config.extensions = { packs: [...packs, relRef], useGlobalPacks: hostCore.globalPacksEnabled(config) };
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
  // Matches either form: a legacy path ref by path/stem/basename, or a by-name
  // selection by its declared name.
  const match = packs.find((entry) => (typeof entry === 'string'
    ? entry === relRef || stem(entry) === name || path.basename(entry) === name
    : entry.name === name));
  if (!match) throw new Error(`Project has no registered pack named "${name}".`);

  config.extensions = { packs: packs.filter((entry) => entry !== match), useGlobalPacks: hostCore.globalPacksEnabled(config) };
  saveProjectConfig(config);

  // Delete the vendored file, but never a path outside .wai/packs (the ref may
  // point at a location the user owns). A selection owns no vendored path here.
  const resolved = path.resolve(root, typeof match === 'string' ? match : path.join('.wai', 'packs', match.name));
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

// ── pack_orchestrator: resolver auth + project-scope binding ──────────────────
//
// Server-global pack management is instance configuration → INSTANCE-level
// project:admin. Per-project install/remove require project:admin over that
// project; the per-project listing requires project:read. The master credential
// and the built-in admin pass via the resolver bypass.

/** Authenticate the caller credential or throw (401-mapping). */
function requirePrincipal(cfg: HostConfig, credential: string | null) {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

/** Require the caller's resolved capability over a scope to be yes. */
function requireCap(
  cfg: HostConfig,
  credential: string | null,
  capability: string,
  scopeKind: 'instance' | 'project',
  scopeId: string,
  denial: string,
): void {
  const principal = requirePrincipal(cfg, credential);
  if (authorize(cfg.dataDir, principal, capability, scopeKind, scopeId).value !== 'yes') {
    throw new AdminAuthError(denial);
  }
}

function boundProject(cfg: HostConfig, project: string): string {
  const root = existingProjectRoot(cfg.dataDir, project);
  if (!root) throw new Error(`Unknown project "${project}".`);
  return root;
}

export function listGlobalPacks(cfg: HostConfig, credential: string | null): PackDescriptor[] {
  requireCap(cfg, credential, 'project:admin', 'instance', '', 'Forbidden — managing server-global packs requires instance-level project:admin');
  return storeListGlobalPacks();
}

export function installGlobalPack(cfg: HostConfig, credential: string | null, name: string, content: string): PackDescriptor {
  requireCap(cfg, credential, 'project:admin', 'instance', '', 'Forbidden — managing server-global packs requires instance-level project:admin');
  return storeInstallGlobalPack(name, content);
}

export function removeGlobalPack(cfg: HostConfig, credential: string | null, name: string): void {
  requireCap(cfg, credential, 'project:admin', 'instance', '', 'Forbidden — managing server-global packs requires instance-level project:admin');
  storeRemoveGlobalPack(name);
}

export function listProjectPacks(cfg: HostConfig, credential: string | null, project: string): PackDescriptor[] {
  requireCap(cfg, credential, 'project:read', 'project', project, 'Forbidden — listing a project\'s packs requires project:read over it');
  return executeApprovedListProjectPacks(cfg, project);
}

export function installProjectPack(cfg: HostConfig, credential: string | null, project: string, name: string, content: string): PackDescriptor {
  requireCap(cfg, credential, 'project:admin', 'project', project, 'Forbidden — installing a project pack requires project:admin over the project');
  return executeApprovedInstallProjectPack(cfg, project, name, content);
}

// ── pack_orchestrator: profile catalog + server-global pack adoption ───────────
//
// The INSTANCE-WIDE selectable-profile catalog is non-sensitive configuration —
// any authenticated principal may read it (no scope authorization). The
// PROJECT-SCOPED catalog names one project, so it mirrors the per-project pack
// listing (project:read over that project). Adopting a server-global pack into a
// project is a per-project install (project:admin); listing what may be adopted
// mirrors the per-project pack listing (project:read).

/** List the selectable architectural profiles (built-in + server-global pack
 *  profiles, each tagged with its source). Authenticate the caller — any
 *  authenticated principal may read the catalog — then return the pre-authorized
 *  store aggregation. No scope authorization: the catalog is instance-wide,
 *  non-sensitive configuration. */
export function listAvailableProfiles(cfg: HostConfig, credential: string | null): AvailableProfile[] {
  requirePrincipal(cfg, credential);
  return storeListAvailableProfiles();
}

/** List the profiles selectable for ONE project, each tagged with its source and
 *  whether it can already govern that project. Requires project:read over the
 *  project (mirrors listProjectPacks / listAdoptableProjectPacks), then returns
 *  the pre-authorized project-scoped store read. This is the catalog a
 *  project-type picker must use: the instance-wide listAvailableProfiles cannot
 *  see a project's own packs and cannot say which profiles would need adopting. */
export function listProjectProfiles(cfg: HostConfig, credential: string | null, project: string): AvailableProfile[] {
  requireCap(cfg, credential, 'project:read', 'project', project, 'Forbidden — listing a project\'s selectable profiles requires project:read over the project');
  return executeApprovedListProjectProfiles(cfg, project);
}

/** List the server-global pack catalog a project may adopt from. Requires
 *  project:read over the project (mirrors listProjectPacks), then returns the
 *  server-global listing. */
export function listAdoptableProjectPacks(cfg: HostConfig, credential: string | null, project: string): PackDescriptor[] {
  requireCap(cfg, credential, 'project:read', 'project', project, 'Forbidden — listing adoptable packs requires project:read over the project');
  return storeListGlobalPacks();
}

/** Adopt a server-global pack into a project by name: require project:admin over
 *  the project, resolve the name against the server-global set (both tiers), and
 *  vendor the resolved pack in by its CANONICAL name. A name the instance does not
 *  carry is rejected — never a silent no-op. */
export function adoptProjectPack(cfg: HostConfig, credential: string | null, project: string, name: string): PackDescriptor {
  requireCap(cfg, credential, 'project:admin', 'project', project, 'Forbidden — adopting a project pack requires project:admin over the project');
  const resolution = executeApprovedResolveGlobalPacks([name]);
  if (resolution.resolved.length === 0) {
    throw new Error(`no such server-global pack "${name}" — cannot adopt a pack the instance does not carry`);
  }
  const resolved = resolution.resolved[0];
  return executeApprovedInstallProjectPack(cfg, project, resolved.name, resolved.content);
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

/** Pre-authorized entry for internal policy/health flows: resolve server-global
 *  pack names to their declarative content across both tiers WITHOUT credential
 *  authentication — the caller (project_policy_orchestrator) has already enforced
 *  grant-based authorization. No project binding (the server-global set is
 *  instance-wide). Never exposed on any portal. */
export function executeApprovedResolveGlobalPacks(names: string[]): PackResolution {
  return storeResolveGlobalPacks(names);
}

/** Pre-authorized entry for the policy plane and the project-scoped catalog
 *  surface: the profiles selectable for one project (built-ins + the project's own
 *  registered packs, installed; + the server-global packs, adoptable) WITHOUT
 *  credential authentication — the caller has already enforced authorization.
 *  Binds the project's isolated root for the project-tier half of the listing.
 *  Never exposed on any portal. */
export function executeApprovedListProjectProfiles(cfg: HostConfig, project: string): AvailableProfile[] {
  return runWithProjectRoot(boundProject(cfg, project), () => storeListProjectProfiles());
}

/**
 * Pre-authorized entry for the policy plane: make one profile id able to actually
 * GOVERN a project, and report what that took. No credential authentication — the
 * caller has already enforced authorization; never exposed on any portal.
 *
 * A known composite project kind or built-in profile id resolves immediately
 * (source 'builtin', nothing adopted). Otherwise the project-scoped catalog
 * decides: a profile already contributed by a pack registered in the project is
 * returned with that pack as its source and nothing adopted; a profile contributed
 * only by a server-global pack has that pack resolved through the two-tier
 * resolution seam and vendored into the project by its CANONICAL name (registering
 * it in extensions.packs), returned with adoptedPackName set so the side effect is
 * reported rather than hidden.
 *
 * A profile id no tier contributes THROWS naming the id and the tiers searched:
 * writing it as the project's projectType would leave the whole profile doctrine
 * silently unenforced (UNKNOWN_PROFILE), so it is refused instead of applied.
 *
 * Idempotent: an already-resolvable profile is returned untouched, and a second
 * call adopts nothing further (the first call's vendoring put the contributing
 * pack in the project tier, where the catalog reports it installed).
 */
export function executeApprovedEnsureProfileInstalled(cfg: HostConfig, project: string, profileId: string): ProfileApplication {
  // A composite project kind or a built-in profile governs as-is — no
  // contributing pack exists to adopt.
  if (hostCore.builtinProjectKinds().includes(profileId) || hostCore.builtinProfileIds().includes(profileId)) {
    return { profileId, source: 'builtin' };
  }

  const contributors = executeApprovedListProjectProfiles(cfg, project).filter((p) => p.id === profileId);

  // Already resolvable: a pack registered in the project contributes it.
  const installed = contributors.find((p) => p.installed);
  if (installed) return { profileId, source: installed.source };

  // Adoptable: only a server-global pack contributes it — vendor that pack in.
  const adoptable = contributors[0];
  const resolved = adoptable ? executeApprovedResolveGlobalPacks([adoptable.source]).resolved[0] : undefined;
  if (!resolved) {
    throw new Error(
      `Unknown profile "${profileId}" — no built-in profile or project kind carries it, no pack registered in ` +
      `project "${project}" contributes it, and no server-global pack (mutable instance tier or immutable ` +
      'image tier) contributes it. Writing an unresolvable id as the projectType would silently disable the ' +
      'whole profile doctrine (UNKNOWN_PROFILE), so it is refused instead of applied.',
    );
  }
  executeApprovedInstallProjectPack(cfg, project, resolved.name, resolved.content);
  return { profileId, source: resolved.name, adoptedPackName: resolved.name };
}

export function removeProjectPack(cfg: HostConfig, credential: string | null, project: string, name: string): void {
  requireCap(cfg, credential, 'project:admin', 'project', project, 'Forbidden — removing a project pack requires project:admin over the project');
  runWithProjectRoot(boundProject(cfg, project), () => storeRemoveProjectPack(name));
}

// ── pack_orchestrator: ZIP (.wpack) archive installs (declarative-only) ────────
//
// The ZIP-primary counterparts of installGlobalPack/installProjectPack. Same
// resolver gates (instance-level project:admin for the global tier; project:admin
// over the project for its tier), same scope binding — the registry inspects the
// envelope and rejects code packs, extracts under hosted-strict limits, and
// re-checks the extracted pack is declarative.

export function installGlobalPackArchive(cfg: HostConfig, credential: string | null, archive: Uint8Array, name?: string): PackDescriptor {
  requireCap(cfg, credential, 'project:admin', 'instance', '', 'Forbidden — managing server-global packs requires instance-level project:admin');
  return storeInstallGlobalPackArchive(archive, name);
}

export function installProjectPackArchive(cfg: HostConfig, credential: string | null, project: string, archive: Uint8Array, name?: string): PackDescriptor {
  requireCap(cfg, credential, 'project:admin', 'project', project, 'Forbidden — installing a project pack requires project:admin over the project');
  return runWithProjectRoot(boundProject(cfg, project), () => storeInstallProjectPackArchive(archive, name));
}
