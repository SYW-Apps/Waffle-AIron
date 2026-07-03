import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { z } from 'zod';
import { readYamlFile } from '../utils/yaml.js';
import { getProjectRoot } from '../utils/fs.js';
import { loadProjectConfig } from '../config/loader.js';
import type { SddRule } from './rules/types.js';

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
//     exported rule API. Loaded via createRequire from the project root, so
//     npm-installed packs resolve like any dependency.
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
});
export type ProfileDef = z.infer<typeof ProfileDefSchema>;

/**
 * A pack-defined target language/platform. `unsupportedFlow` maps a narrative
 * flow construct (branch | switch | forEach | for | while | doWhile | try |
 * throw | jump) to remodeling guidance — merged over the built-in table, so a
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

export const DeclarativePackSchema = z.object({
  name: z.string().min(1),
  profiles: z.record(ProfileDefSchema).default({}),
  languages: z.record(LanguagePackDefSchema).default({}),
});
export type DeclarativePack = z.infer<typeof DeclarativePackSchema>;

/** Where a pack came from — global installs load before (and lose to) project packs. */
export type PackScope = 'global' | 'project';

export interface PackRef {
  ref: string;
  scope: PackScope;
}

export interface LoadedExtensions {
  packNames: string[];
  /** Per-pack provenance (name, resolved ref, scope). */
  packs: { name: string; ref: string; scope: PackScope }[];
  /** Programmatic rules, run after the built-in registry. */
  rules: SddRule[];
  /** Pack-registered profiles, keyed by profile id. */
  profiles: Record<string, ProfileDef>;
  /** Pack-registered language/platform tables, keyed by normalized language. */
  languages: Record<string, LanguagePackDef>;
  /** Pack loading failures — surfaced as EXTENSION_LOAD_ERROR (error). */
  errors: string[];
}

export function emptyExtensions(): LoadedExtensions {
  return { packNames: [], packs: [], rules: [], profiles: {}, languages: {}, errors: [] };
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

function mergePack(out: LoadedExtensions, pack: DeclarativePack, ref: string, scope: PackScope): void {
  out.packNames.push(pack.name);
  out.packs.push({ name: pack.name, ref, scope });
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
}

/**
 * Load extension packs from scoped refs. Path-like refs (relative, absolute,
 * or *.yaml) resolve against the project root; a directory ref loads its
 * pack entry file; anything else resolves as a module id from the project
 * root (Node semantics).
 */
export function loadExtensionPacks(refs: PackRef[], projectRoot: string): LoadedExtensions {
  const out = emptyExtensions();
  const isYaml = (p: string): boolean => /\.ya?ml$/i.test(p);

  for (const { ref, scope } of refs) {
    try {
      let target = ref;
      const pathLike = ref.startsWith('.') || path.isAbsolute(ref) || isYaml(ref);
      if (pathLike) {
        const resolved = path.resolve(projectRoot, ref);
        if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
          const entry = packDirEntry(resolved);
          if (!entry) throw new Error(`directory pack has no entry file (${PACK_DIR_ENTRIES.join(' | ')})`);
          target = entry;
        } else {
          target = resolved;
        }
      }

      if (isYaml(target)) {
        const raw = readYamlFile(target);
        if (raw == null) throw new Error('file not found or empty');
        mergePack(out, DeclarativePackSchema.parse(raw), ref, scope);
      } else {
        const req = createRequire(path.join(projectRoot, 'package.json'));
        const modRaw: unknown = req(target);
        const mod = ((modRaw as { default?: unknown })?.default ?? modRaw) as Record<string, unknown>;
        mergePack(out, DeclarativePackSchema.parse({
          name: mod.name ?? ref,
          profiles: mod.profiles ?? {},
          languages: mod.languages ?? {},
        }), ref, scope);
        for (const r of (mod.rules as unknown[] | undefined) ?? []) {
          if (!isRuleShaped(r)) throw new Error('each entry of `rules` must be an SddRule ({ name, description, codes, check })');
          out.rules.push(r);
        }
      }
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
