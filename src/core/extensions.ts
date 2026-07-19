import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { z } from 'zod';
import { readYamlFile } from '../utils/yaml.js';
import { getProjectRoot } from '../utils/fs.js';
import { loadProjectConfig } from '../config/loader.js';
import type { SddRule } from './rules/types.js';
import { RulesConfigSchema } from '../models/project.js';

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
});
export type DeclarativePack = z.infer<typeof DeclarativePackSchema>;

/** A pack skill tagged with the pack that ships it (provenance for install + `skills list`) and the absolute path to its SKILL.md. */
export type LoadedPackSkill = PackSkill & { pack: string; packVersion?: string; sourcePath: string };
/** A pack pattern definition tagged with the pack that declares it. */
export type LoadedPattern = PatternDef & { pack: string };

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
  /** Pack loading failures — surfaced as EXTENSION_LOAD_ERROR (error). */
  errors: string[];
}

export function emptyExtensions(): LoadedExtensions {
  return { packNames: [], packs: [], rules: [], profiles: {}, languages: {}, skills: [], patterns: [], guarantees: [], assertions: [], errors: [] };
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
 * Pack refs discovered in a directory (used for the global packs folder):
 * *.yaml/*.yml/*.cjs/*.js files, and subdirectories containing a pack entry
 * file. Sorted for deterministic load order.
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
    const refs: PackRef[] = [];
    if (config.extensions?.useGlobalPacks ?? true) {
      for (const ref of discoverPacks(globalPacksDir())) refs.push({ ref, scope: 'global' });
    }
    for (const ref of config.extensions?.packs ?? []) refs.push({ ref, scope: 'project' });
    if (refs.length === 0) return emptyExtensions();
    return loadExtensionPacks(refs, getProjectRoot());
  } catch {
    return emptyExtensions();
  }
}
