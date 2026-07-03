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

export interface LoadedExtensions {
  packNames: string[];
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
  return { packNames: [], rules: [], profiles: {}, languages: {}, errors: [] };
}

function isRuleShaped(r: unknown): r is SddRule {
  if (!r || typeof r !== 'object') return false;
  const c = r as Record<string, unknown>;
  return typeof c.name === 'string' && Array.isArray(c.codes) && typeof c.check === 'function';
}

function mergePack(out: LoadedExtensions, pack: DeclarativePack): void {
  out.packNames.push(pack.name);
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
 * Load extension packs. `packRefs` come from `.wai/project.yaml`
 * (`extensions.packs`); relative paths resolve against the project root.
 */
export function loadExtensions(packRefs: string[], projectRoot: string): LoadedExtensions {
  const out = emptyExtensions();
  for (const ref of packRefs) {
    try {
      if (/\.ya?ml$/i.test(ref)) {
        const raw = readYamlFile(path.resolve(projectRoot, ref));
        if (raw == null) throw new Error('file not found or empty');
        mergePack(out, DeclarativePackSchema.parse(raw));
      } else {
        const req = createRequire(path.join(projectRoot, 'package.json'));
        const modRaw: unknown = req(ref.startsWith('.') ? path.resolve(projectRoot, ref) : ref);
        const mod = ((modRaw as { default?: unknown })?.default ?? modRaw) as Record<string, unknown>;
        mergePack(out, DeclarativePackSchema.parse({
          name: mod.name ?? ref,
          profiles: mod.profiles ?? {},
          languages: mod.languages ?? {},
        }));
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
 * Load the packs declared in the current project's config. Used by
 * validateSddTree when the caller doesn't inject extensions explicitly;
 * an uninitialized project simply has none.
 */
export function loadProjectExtensions(): LoadedExtensions {
  try {
    const config = loadProjectConfig();
    const packs = config.extensions?.packs ?? [];
    if (packs.length === 0) return emptyExtensions();
    return loadExtensions(packs, getProjectRoot());
  } catch {
    return emptyExtensions();
  }
}
