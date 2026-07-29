import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { z } from 'zod';
import { readYamlFile } from '../utils/yaml.js';
import { getProjectRoot } from '../utils/fs.js';
import { loadProjectConfig, saveProjectConfig, AI_PATHS } from '../config/loader.js';
import { isNewerVersion } from '../utils/version.js';
import type { SddRule } from './rules/types.js';
import { RulesConfigSchema, type PackSelection } from '../models/project.js';
// The store is a sibling adapter; both modules reach each other only inside
// function bodies, so the import cycle never runs at module-init time.
import { resolveInstalledPack, packStoreDir, listInstalledPacks } from './packstore.js';

// ---------------------------------------------------------------------------
// Extension packs — wairon's plugin surface.
//
// Wairon core defines the rule contract and the enforcement engine; platform-
// specific profiles and rules are injected from outside so wrappers (e.g. an
// automation-platform SDD tool) never fork core and core never learns about
// their platform. Two pack forms, both listed in `.wai/project.yaml` under
// `extensions.packs`:
//
//   - Declarative YAML (path ending in .yaml/.yml, relative to project root):
//     custom profile definitions and language/platform tables. Data only.
//   - Programmatic JS (anything else — a requireable module id or relative
//     path): the same data plus `rules: SddRule[]` written against wairon's
//     exported rule API. Loaded via createRequire from the project root
//     (Node resolution semantics for module ids).
//
// Packs load identically in the CLI and the MCP server: validateSddTree
// auto-loads them from project config unless the caller passes its own
// LoadedExtensions (the programmatic-wrapper path). A pack that fails to
// load becomes an EXTENSION_LOAD_ERROR issue — never a silent skip.
// ---------------------------------------------------------------------------

/**
 * A pack-defined architectural profile. `family` opts into the built-in
 * stereotype fencing (backend-like ⇒ frontend stereotypes are violations,
 * frontend-like ⇒ backend runtime stereotypes are warned); the explicit
 * stereotype lists carry the profile's own doctrine with a stated reason.
 */
export const ProfileDefSchema = z.object({
  family: z.enum(['backend-like', 'frontend-like', 'neutral']).default('neutral'),
  forbiddenStereotypes: z.array(z.object({ types: z.array(z.string()).min(1), reason: z.string().min(1) })).default([]),
  discouragedStereotypes: z.array(z.object({ types: z.array(z.string()).min(1), reason: z.string().min(1) })).default([]),
  /**
   * Edge deltas — the ALLOW half of the profile-scoped dependency matrix. An
   * entry LICENSES intra-subsystem dependsOn edges the builtin stereotype
   * matrix refuses, for components governed by this profile (the platform's
   * own idiom, e.g. an ECS system reading component Stores directly), with
   * the stated reason. Scoped to the stereotype matrix only: cross-subsystem
   * boundary rules and pattern containment are never relaxable. The DENY
   * half is a `forbid-edge` declarative assertion.
   */
  allowedEdges: z.array(z.object({
    from: z.array(z.string().min(1)).min(1),
    to: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
  })).default([]),
  rules: RulesConfigSchema.partial().optional(),
});
export type ProfileDef = z.infer<typeof ProfileDefSchema>;

/**
 * A pack-defined target language/platform. `unsupportedFlow` maps a narrative
 * flow construct (branch | switch | forEach | for | while | doWhile | try |
 * throw | jump | parallel | detach) to remodeling guidance — merged over the
 * built-in table, so a
 * pack can gate constructs for its platform (warning severity: "possible but
 * not clean" is guidance, not prohibition). `foreignBuiltins` are builtin-type
 * markers unambiguous to THIS language, enabling the foreign-builtin check
 * both ways.
 */
export const LanguagePackDefSchema = z.object({
  unsupportedFlow: z.record(z.string()).default({}),
  foreignBuiltins: z.array(z.string()).default([]),
});
export type LanguagePackDef = z.infer<typeof LanguagePackDefSchema>;

/**
 * A declarative AI-agent skill shipped by a pack: a SKILL.md discovered relative
 * to the pack directory and installed (namespaced `<pack-id>-<skill-id>`) into
 * supported client targets and the MCP resource mirror. Not an MCP tool.
 */
export const PackSkillSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  targets: z.array(z.string()).default([]),
});
export type PackSkill = z.infer<typeof PackSkillSchema>;

/**
 * One block of connecting-agent guidance contributed by a pack, appended to
 * wairon's OWN MCP `initialize` instructions under an attributed heading.
 *
 * The split is deliberate and load-bearing: wairon owns the SDD model, so
 * wairon teaches it by default (see core/instructions.ts). A pack states its
 * platform DELTA only — "and here is what each of those means on my platform" —
 * and never restates the model, which would drift on every wairon release.
 * `profile` scopes a block to the governing profile exactly as declarative
 * assertions scope their doctrine.
 */
export interface PackInstructionBlock {
  /** The guidance itself — the pack's platform delta, never a restatement of wairon's model. */
  text: string;
  /** Optional scope: apply only when the bound project's governing profile is one of these. */
  profile?: string[];
}

// Annotated rather than inferred: the string arm normalizes to the SAME shape as
// the object arm, so consumers see one block type instead of a union they have to
// narrow before reading `profile`.
export const PackInstructionBlockSchema: z.ZodType<PackInstructionBlock, z.ZodTypeDef, unknown> = z.union([
  // Scalar shorthand: `instructions: >- …` — the common case, unscoped.
  z.string().min(1).transform((text) => ({ text })),
  z.object({
    text: z.string().min(1),
    profile: z.array(z.string().min(1)).min(1).optional(),
  }),
]);

/**
 * A pack's `instructions` field, normalized to a list. Accepts a bare string, a
 * single block, or a list of either — so the simple case stays one line of YAML
 * while a pack that needs profile scoping can spell blocks out.
 */
const PackInstructionsSchema = z.preprocess(
  (raw) => (raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw]),
  z.array(PackInstructionBlockSchema),
);

/**
 * A named, versioned reusable architecture pattern declared by a pack. Core
 * resolves references to it and surfaces it in tooling; the actual pattern
 * constraints are enforced by the pack's own programmatic rules.
 */
export const PatternDefSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type PatternDef = z.infer<typeof PatternDefSchema>;

/**
 * Selector for declarative assertions (closed, v1): absent keys match all,
 * present keys AND together. `profile` matches the component's governing
 * profile — how a platform pack scopes doctrine to its own subsystems.
 * `id` is a simple glob (`*` wildcard only).
 */
export const AssertionSelectorSchema = z.object({
  componentType: z.array(z.string().min(1)).optional(),
  profile: z.array(z.string().min(1)).optional(),
  id: z.string().min(1).optional(),
});
export type AssertionSelector = z.infer<typeof AssertionSelectorSchema>;

const assertionBase = {
  /** Pack-local code; surfaced namespaced as <PACK_NAME>_<CODE>. */
  code: z.string().min(1),
  severity: z.enum(['warning', 'error']).default('warning'),
  /** The doctrine, stated for the finding message. */
  reason: z.string().min(1),
};

/**
 * Declarative rule assertions (docs/design/declarative-rule-dsl.md): packs
 * add INSTANCES of closed assertion kinds, never rule logic — the hosted-safe
 * doctrine channel. An unknown `kind` fails the pack load loudly (an old
 * wairon must never silently not-enforce a newer pack's doctrine).
 */
export const PackAssertionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('forbid-edge'),
    ...assertionBase,
    from: AssertionSelectorSchema,
    to: AssertionSelectorSchema,
    relation: z.array(z.enum(['dependsOn', 'owns'])).default(['dependsOn', 'owns']),
  }),
  z.object({
    kind: z.literal('require-field'),
    ...assertionBase,
    on: AssertionSelectorSchema,
    level: z.enum(['component', 'interface', 'implementation']).default('component'),
    /** A top-level spec field name, or one `ext.*` path — nothing else is addressable. */
    field: z.string().min(1),
    /** Optional closed value set (string equality). */
    values: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('endpoint-shape'),
    ...assertionBase,
    on: AssertionSelectorSchema,
    /** Optional transport allowlist. */
    transport: z.array(z.string().min(1)).optional(),
    /** Optional anchored regex over the transport's address field (path/topic/command/…). */
    pathPattern: z.string().min(1).optional(),
  }),
]);
export type PackAssertion = z.infer<typeof PackAssertionSchema>;

/** A pack assertion tagged with provenance and its namespaced finding code. */
export type LoadedAssertion = PackAssertion & { pack: string; fullCode: string };

/** <PACK_NAME>_<CODE>, upper-snake, non-alphanumerics collapsed — collision-free across packs, provenance legible in every finding. */
export function assertionFullCode(packName: string, code: string): string {
  const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${norm(packName)}_${norm(code)}`;
}

export const DeclarativePackSchema = z.object({
  name: z.string().min(1),
  version: z.string().optional(),
  profiles: z.record(ProfileDefSchema).default({}),
  languages: z.record(LanguagePackDefSchema).default({}),
  skills: z.array(PackSkillSchema).default([]),
  patterns: z.array(PatternDefSchema).default([]),
  /** Declarative rule assertions — instances of closed kinds, hosted-safe. */
  assertions: z.array(PackAssertionSchema).default([]),
  /**
   * Semantic guarantee tokens this pack adds to the builtin vocabulary
   * (SEMANTIC_GUARANTEES). Declaring a token makes it legal on L3 method
   * `guarantees` and narrative `assertsGuarantees`; referenced tokens outside
   * builtin + declared are flagged UNKNOWN_GUARANTEE by the validator.
   */
  guarantees: z.array(z.string().min(1)).default([]),
  /**
   * Connecting-agent guidance appended to wairon's own MCP `initialize`
   * instructions, attributed to this pack, in pack load order.
   */
  instructions: PackInstructionsSchema,
});
export type DeclarativePack = z.infer<typeof DeclarativePackSchema>;

/** A pack skill tagged with the pack that ships it (provenance for install + `skills list`) and the absolute path to its SKILL.md. */
export type LoadedPackSkill = PackSkill & { pack: string; packVersion?: string; sourcePath: string };
/** A pack pattern definition tagged with the pack that declares it. */
export type LoadedPattern = PatternDef & { pack: string };
/** A pack instruction block tagged with the pack that contributes it (the attribution rendered into the composed instructions). */
export type LoadedInstructionBlock = PackInstructionBlock & { pack: string };

/**
 * Whether machine-wide packs also apply to a project, when the project has not
 * said. **False**: doctrine is what a project declares. Kept as one exported
 * constant so every reader and every config writer agrees on the default.
 */
export const GLOBAL_PACKS_DEFAULT = false;

/** Does this project apply machine-wide packs on top of its own selections? */
export function globalPacksEnabled(config: { extensions?: { useGlobalPacks?: boolean } }): boolean {
  return config.extensions?.useGlobalPacks ?? GLOBAL_PACKS_DEFAULT;
}

/** Where a pack came from — global installs load before (and lose to) project packs. */
export type PackScope = 'global' | 'project';

export interface PackRef {
  ref: string;
  scope: PackScope;
}

export interface LoadedExtensions {
  packNames: string[];
  /** Per-pack provenance (name, resolved ref, scope). */
  packs: { name: string; ref: string; scope: PackScope; version?: string }[];
  /** Programmatic rules, run after the built-in registry. */
  rules: SddRule[];
  /** Pack-registered profiles, keyed by profile id. */
  profiles: Record<string, ProfileDef>;
  /** Pack-registered language/platform tables, keyed by normalized language. */
  languages: Record<string, LanguagePackDef>;
  /** Pack-provided AI-agent skills across all loaded packs (with provenance). */
  skills: LoadedPackSkill[];
  /** Pack-registered reusable pattern definitions (with provenance). */
  patterns: LoadedPattern[];
  /** Pack-declared semantic guarantee tokens (merged, deduped) — the extension half of the guarantee vocabulary. */
  guarantees: string[];
  /** Declarative rule assertions across all loaded packs (with provenance + namespaced codes). */
  assertions: LoadedAssertion[];
  /**
   * Pack-contributed MCP instruction blocks, with provenance. The one merged
   * field whose ORDER is semantic: preserved in pack LOAD order, because that
   * is the order they are appended to wairon's own instructions.
   */
  instructions: LoadedInstructionBlock[];
  /** Pack loading failures — surfaced as EXTENSION_LOAD_ERROR (error). */
  errors: string[];
}

export function emptyExtensions(): LoadedExtensions {
  return { packNames: [], packs: [], rules: [], profiles: {}, languages: {}, skills: [], patterns: [], guarantees: [], assertions: [], instructions: [], errors: [] };
}

// ---------------------------------------------------------------------------
// Global packs — machine-wide installs, auto-loaded for every project.
// ---------------------------------------------------------------------------

/**
 * The global packs directory: WAIRON_PACKS_DIR or ~/.wairon/packs (same
 * convention as global templates). Every pack found here is loaded for every
 * project on this machine, BEFORE the project's own packs (so project packs
 * win on collision). A project can opt out via
 * `extensions.useGlobalPacks: false`. Note: repo-defining doctrine belongs
 * in project packs (committed, so CI and every clone enforce it); the global
 * folder is for personal/org-wide additions on this machine.
 */
export function globalPacksDir(): string {
  return process.env.WAIRON_PACKS_DIR ?? path.join(os.homedir(), '.wairon', 'packs');
}

/** Entry-file names that make a directory a pack. */
export const PACK_DIR_ENTRIES = ['pack.yaml', 'pack.yml', 'pack.cjs', 'pack.js', 'index.cjs', 'index.js'];

/** The entry file of a directory pack, or null if the directory isn't one. */
export function packDirEntry(dir: string): string | null {
  for (const name of PACK_DIR_ENTRIES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * The newest `<name>/<version>/` subdirectory of a versioned store entry, or null
 * when the directory holds no version subdirectory with a pack entry file.
 */
function latestVersionDir(nameDir: string): string | null {
  let versions: fs.Dirent[];
  try {
    versions = fs.readdirSync(nameDir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { version: string; dir: string } | null = null;
  for (const v of versions) {
    if (!v.isDirectory()) continue;
    const dir = path.join(nameDir, v.name);
    if (!packDirEntry(dir)) continue;
    if (!best || isNewerVersion(best.version, v.name)) best = { version: v.name, dir };
  }
  return best?.dir ?? null;
}

/**
 * Pack refs discovered in a directory (used for the global packs folder):
 * *.yaml/*.yml/*.cjs/*.js files, and subdirectories containing a pack entry
 * file. Sorted for deterministic load order.
 *
 * Also understands the pack store's VERSIONED layout (`<name>/<version>/`,
 * see core/packstore.ts), resolving such an entry to its newest installed
 * version. Without this, a pack installed through `wairon pack install` would be
 * invisible to the legacy auto-load path — the doctrine would silently stop
 * applying, which is the one failure direction that must never happen quietly.
 */
export function discoverPacks(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const refs: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (packDirEntry(full)) refs.push(full);
      else {
        const latest = latestVersionDir(full);
        if (latest) refs.push(latest);
      }
    } else if (/\.(ya?ml|cjs|js)$/i.test(e.name)) {
      refs.push(full);
    }
  }
  return refs;
}

function isRuleShaped(r: unknown): r is SddRule {
  if (!r || typeof r !== 'object') return false;
  const c = r as Record<string, unknown>;
  return typeof c.name === 'string' && Array.isArray(c.codes) && typeof c.check === 'function';
}

function mergePack(out: LoadedExtensions, pack: DeclarativePack, ref: string, scope: PackScope, packDir: string): void {
  out.packNames.push(pack.name);
  out.packs.push({ name: pack.name, ref, scope, version: pack.version });
  // Later packs win on collision — pack order in project.yaml is precedence.
  Object.assign(out.profiles, pack.profiles);
  for (const [lang, def] of Object.entries(pack.languages)) {
    const key = lang.toLowerCase();
    const existing = out.languages[key];
    out.languages[key] = existing
      ? {
        unsupportedFlow: { ...existing.unsupportedFlow, ...def.unsupportedFlow },
        foreignBuiltins: [...new Set([...existing.foreignBuiltins, ...def.foreignBuiltins])],
      }
      : def;
  }
  // Skills and patterns are namespaced by pack id (skills at install time, pattern
  // ids by convention), so they accumulate across packs with their provenance.
  for (const s of pack.skills) out.skills.push({ ...s, pack: pack.name, packVersion: pack.version, sourcePath: path.resolve(packDir, s.source) });
  for (const p of pack.patterns) out.patterns.push({ ...p, pack: pack.name });
  // Guarantee tokens are a flat vocabulary — same token from two packs is one token.
  out.guarantees = [...new Set([...out.guarantees, ...pack.guarantees])];
  // Assertions accumulate with provenance; the namespaced code keeps packs collision-free.
  for (const a of pack.assertions) out.assertions.push({ ...a, pack: pack.name, fullCode: assertionFullCode(pack.name, a.code) });
  // Instruction blocks accumulate in LOAD order — unlike every other merged
  // field, order is meaning here (it is append order in the composed
  // instructions), so blocks are never deduped or overwritten on collision.
  for (const b of pack.instructions) out.instructions.push({ ...b, pack: pack.name });
}

/**
 * Load extension packs from scoped refs. Path-like refs (relative, absolute,
 * or *.yaml) resolve against the project root; a directory ref loads its
 * pack entry file; anything else resolves as a module id from the project
 * root (Node semantics).
 */
const isYamlPath = (p: string): boolean => /\.ya?ml$/i.test(p);

/**
 * Resolve a ref to a concrete load target: a path-like ref (relative, absolute,
 * or *.yaml) against the project root — a directory resolving to its pack entry
 * file (throwing when it has none) — otherwise a Node module id returned as-is
 * for resolution from the project root.
 */
export function resolvePackRef(ref: string, projectRoot: string): string {
  const pathLike = ref.startsWith('.') || path.isAbsolute(ref) || isYamlPath(ref);
  if (!pathLike) return ref;
  const resolved = path.resolve(projectRoot, ref);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const entry = packDirEntry(resolved);
    if (!entry) throw new Error(`directory pack has no entry file (${PACK_DIR_ENTRIES.join(' | ')})`);
    return entry;
  }
  return resolved;
}

/**
 * Read a resolved target's pack manifest, deserializing it into a DeclarativePack
 * (with any programmatic rules attached): a *.yaml/*.yml target is parsed as YAML
 * (throwing on a missing/empty file); any other target is required as a CommonJS
 * module from the project root and its default/module export used. A read/require/
 * parse failure propagates to the caller, which records an EXTENSION_LOAD_ERROR.
 */
export function readManifest(target: string, projectRoot: string): DeclarativePack & { rules: SddRule[] } {
  if (isYamlPath(target)) {
    const raw = readYamlFile(target);
    if (raw == null) throw new Error('file not found or empty');
    return { ...DeclarativePackSchema.parse(raw), rules: [] };
  }
  const req = createRequire(path.join(projectRoot, 'package.json'));
  const modRaw: unknown = req(target);
  const mod = ((modRaw as { default?: unknown })?.default ?? modRaw) as Record<string, unknown>;
  const parsed = DeclarativePackSchema.parse({
    name: mod.name ?? target,
    version: mod.version,
    profiles: mod.profiles ?? {},
    languages: mod.languages ?? {},
    skills: mod.skills ?? [],
    patterns: mod.patterns ?? [],
    guarantees: mod.guarantees ?? [],
    assertions: mod.assertions ?? [],
    instructions: mod.instructions ?? [],
  });
  const rules: SddRule[] = [];
  for (const r of (mod.rules as unknown[] | undefined) ?? []) {
    if (!isRuleShaped(r)) throw new Error('each entry of `rules` must be an SddRule ({ name, description, codes, check })');
    rules.push(r);
  }
  return { ...parsed, rules };
}

export function loadExtensionPacks(refs: PackRef[], projectRoot: string): LoadedExtensions {
  const out = emptyExtensions();
  for (const { ref, scope } of refs) {
    try {
      const target = resolvePackRef(ref, projectRoot);
      const manifest = readManifest(target, projectRoot);
      mergePack(out, manifest, ref, scope, path.dirname(target));
      for (const r of manifest.rules) out.rules.push(r);
    } catch (e) {
      out.errors.push(`Extension pack "${ref}" failed to load: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

/**
 * Load extension packs from plain refs (all project-scoped). The simple
 * programmatic API — see loadExtensionPacks for scoped loading.
 */
export function loadExtensions(packRefs: string[], projectRoot: string): LoadedExtensions {
  return loadExtensionPacks(packRefs.map(ref => ({ ref, scope: 'project' as const })), projectRoot);
}

/**
 * Load everything governing the current project: globally installed packs
 * (unless `extensions.useGlobalPacks: false`), then the packs declared in
 * the project's config — project packs win on collision. Used by
 * validateSddTree when the caller doesn't inject extensions explicitly;
 * an uninitialized project simply has none.
 */
export function loadProjectExtensions(): LoadedExtensions {
  try {
    const config = loadProjectConfig();
    const projectRoot = getProjectRoot();
    const refs: PackRef[] = [];
    const unresolved: string[] = [];

    // Off by default: a project's doctrine is what the project declares.
    if (globalPacksEnabled(config)) {
      for (const ref of discoverPacks(globalPacksDir())) refs.push({ ref, scope: 'global' });
    }

    for (const entry of config.extensions?.packs ?? []) {
      // Legacy path/module ref — resolved as it always was.
      if (typeof entry === 'string') {
        refs.push({ ref: entry, scope: 'project' });
        continue;
      }
      // A SELECTION: resolve it to a concrete pack, or record why it could not be.
      const resolution = resolveSelection(entry, projectRoot);
      if (resolution.ref) refs.push({ ref: resolution.ref, scope: 'project' });
      else unresolved.push(resolution.error);
    }

    if (refs.length === 0 && unresolved.length === 0) return emptyExtensions();
    const loaded = loadExtensionPacks(refs, projectRoot);
    // A declared-but-unresolvable pack rides the SAME error channel as a pack that
    // fails to parse: EXTENSION_LOAD_ERROR, error severity, surfaced by validate,
    // status, lock, generate, and every sdd_* MCP call. Never a silent skip —
    // validation must not appear clean while the declared doctrine is absent.
    loaded.errors.push(...unresolved);
    return loaded;
  } catch {
    return emptyExtensions();
  }
}

// ---------------------------------------------------------------------------
// Migration diagnostics (`wairon doctor`)
//
// Global packs auto-load for every project unless a project opts out, which means
// doctrine can apply to a project that never mentioned it. Moving to explicit
// selection has one dangerous direction: a project that relied on implicit global
// loading would silently lose rules and go QUIET rather than loud. These
// diagnostics make the implicit set visible BEFORE that happens, so `doctor --fix`
// can convert it into explicit selections that survive the change.
// ---------------------------------------------------------------------------

/** What `wairon doctor` reports about this project's packs. */
export interface PackDiagnosis {
  /** True when the project never decided about machine-wide packs — so the default governs it. */
  globalsUndeclared: boolean;
  /**
   * Installed packs this project does NOT apply. When `globalsUndeclared`, these
   * are the packs that WOULD have applied under the old machine-wide default —
   * the migration set, worth flagging in case the project relied on them.
   */
  notApplied: { name: string; version: string; origin?: string }[];
  /** Declared selections that do not resolve; the gate already errors on these. */
  unresolved: { label: string; message: string }[];
  /** Machine-wide packs this project applies because it opted IN explicitly. */
  globalsApplied: { name: string; version: string }[];
}

/**
 * Whether `extensions.useGlobalPacks` is absent from the project file. The parsed
 * config defaults it to true, so the raw file is the only place that distinguishes
 * "never decided" (will change under a new default) from "explicitly true" (will
 * not) — and only the former needs migrating.
 */
function globalPacksLeftUnset(): boolean {
  try {
    const raw = readYamlFile(AI_PATHS.projectConfig()) as { extensions?: Record<string, unknown> } | null;
    return raw?.extensions?.useGlobalPacks === undefined;
  } catch {
    return false;
  }
}

/** Diagnose this project's pack situation for `wairon doctor`. Never throws. */
export function diagnoseProjectPacks(): PackDiagnosis {
  const empty: PackDiagnosis = { globalsUndeclared: false, notApplied: [], unresolved: [], globalsApplied: [] };
  try {
    const config = loadProjectConfig();
    const projectRoot = getProjectRoot();
    const entries = config.extensions?.packs ?? [];
    const globalsUndeclared = globalPacksLeftUnset();

    // Selections that do not resolve — reported with the same message the gate uses.
    const unresolved: PackDiagnosis['unresolved'] = [];
    const selectedNames = new Set<string>();
    for (const entry of entries) {
      if (typeof entry === 'string') continue;
      selectedNames.add(entry.name);
      const resolution = resolveSelection(entry, projectRoot);
      if (!resolution.ref) unresolved.push({ label: packEntryLabel(entry), message: resolution.error });
    }

    const installed = listInstalledPacks();
    const globalsOn = globalPacksEnabled(config);

    // Machine-wide packs this project applies by opting in — surfaced so the
    // dependency on machine state is visible rather than assumed.
    const globalsApplied: PackDiagnosis['globalsApplied'] = [];
    if (globalsOn) {
      for (const ref of discoverPacks(globalPacksDir())) {
        const match = installed.find((p) => path.resolve(p.path) === path.resolve(ref));
        if (match) globalsApplied.push({ name: match.name, version: match.version });
      }
    }

    const applying = new Set([...selectedNames, ...globalsApplied.map((p) => p.name)]);
    const notApplied = installed
      .filter((p) => !applying.has(p.name))
      .map((p) => ({ name: p.name, version: p.version, origin: p.origin }));

    return { globalsUndeclared, notApplied, unresolved, globalsApplied };
  } catch {
    return empty;
  }
}

/**
 * Convert the implicitly-applied global packs into EXPLICIT selections and turn
 * global auto-load off, so this project's doctrine survives a change of default
 * and is visible in a diff. Returns the names recorded.
 */
export function pinInstalledPacksAsSelections(): string[] {
  const diagnosis = diagnoseProjectPacks();
  // Only migrate a project that never decided. One that explicitly set
  // useGlobalPacks, or that simply has packs installed it deliberately does not
  // apply, must not have selections invented for it.
  if (!diagnosis.globalsUndeclared || diagnosis.notApplied.length === 0) return [];

  const config = loadProjectConfig();
  const existing = config.extensions?.packs ?? [];

  const added: string[] = [];
  const selections: PackSelection[] = [];
  for (const pack of diagnosis.notApplied) {
    selections.push({
      name: pack.name,
      version: pack.version,
      // Carry the origin so the selection can be obtained elsewhere; a local
      // path is not fetchable, so it is deliberately not recorded as a source.
      ...(pack.origin && /^[a-z][a-z0-9+.-]*:\/\//i.test(pack.origin) ? { source: pack.origin } : {}),
    });
    added.push(`${pack.name}@${pack.version}`);
  }

  config.extensions = { packs: [...existing, ...selections], useGlobalPacks: false };
  saveProjectConfig(config);
  return added;
}

/**
 * A stable human label for a config pack entry — the path for a legacy ref, or
 * `name[@version]` for a selection. For messages and listings, never for loading.
 */
export function packEntryLabel(entry: string | PackSelection): string {
  if (typeof entry === 'string') return entry;
  return entry.version ? `${entry.name}@${entry.version}` : entry.name;
}

/**
 * The loadable ref for one config pack entry: a legacy path/module ref passes
 * through unchanged; a selection is resolved against the committed bundle, then
 * the store. Returns null when a selection cannot be resolved (the caller decides
 * whether that is an error it reports or an entry it skips).
 */
export function packEntryRef(entry: string | PackSelection, projectRoot: string): string | null {
  if (typeof entry === 'string') return entry;
  return resolveSelection(entry, projectRoot).ref ?? null;
}

/**
 * Resolve one pack selection to a loadable ref: the committed BUNDLE first (so a
 * clone and CI resolve with an empty store and no network), then this wairon
 * install's STORE. Returns the failure message instead of throwing, so one
 * unresolvable selection never suppresses the packs that did resolve.
 */
function resolveSelection(
  selection: PackSelection,
  projectRoot: string,
): { ref?: string; error: string } {
  const wanted = selection.version ? `${selection.name}@${selection.version}` : selection.name;

  // 1. The committed bundle under .wai/packs/<name>/[<version>/].
  const bundled = findBundledPack(projectRoot, selection);
  if (bundled) return { ref: bundled, error: '' };

  // 2. The machine's pack store.
  const installed = resolveInstalledPack(selection.name, selection.version);
  if (!installed) {
    // Only ever suggest commands that exist today: `pack sync` (bulk install from
    // recorded sources) lands with the sync work, so the hint names the concrete
    // install instead of promising a command the user cannot run.
    const hint = selection.source
      ? `Install it from the source this selection records: \`wairon pack install ${selection.source}\`.`
      : `Install it with \`wairon pack install <source>\` and re-select it — this selection records no source, so it cannot be fetched automatically.`;
    return {
      error: `Pack "${wanted}" is declared by this project but is not installed in this wairon install (${packStoreDir()}) and is not bundled under .wai/packs/. ${hint}`,
    };
  }
  if (selection.integrity && selection.integrity !== installed.digest) {
    return {
      error: `Pack "${wanted}" resolved to content that does not match the pinned integrity: expected ${selection.integrity}, found ${installed.digest} (${installed.path}). Reinstall the pinned version, or update the pin if the change is intended.`,
    };
  }
  return { ref: installed.path, error: '' };
}

/**
 * A bundled copy of a selection, if the project commits one. `<name>/<version>/`
 * is preferred; `<name>/` directly is accepted so a hand-placed bundle works.
 */
function findBundledPack(projectRoot: string, selection: PackSelection): string | null {
  const base = path.join(projectRoot, '.wai', 'packs', selection.name);
  if (selection.version) {
    const pinned = path.join(base, selection.version);
    return packDirEntry(pinned) ? pinned : null;
  }
  if (packDirEntry(base)) return base;
  // Unpinned: take the newest bundled version.
  let versions: fs.Dirent[];
  try {
    versions = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return null;
  }
  let best: { version: string; dir: string } | null = null;
  for (const v of versions) {
    if (!v.isDirectory()) continue;
    const dir = path.join(base, v.name);
    if (!packDirEntry(dir)) continue;
    if (!best || isNewerVersion(best.version, v.name)) best = { version: v.name, dir };
  }
  return best?.dir ?? null;
}
