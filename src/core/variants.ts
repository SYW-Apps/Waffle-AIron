import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { readYamlFile } from '../utils/yaml.js';
import { getProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// Component variant registry — a DYNAMIC layer that lives ON TOP OF packs.
//
// A variant is a named, base-anchored specialization of a core stereotype (a
// "kind of Adapter/Specialist/…"), carrying implementation guidance so the
// implementer treats every component of the same variant alike — reusing one
// shared approach instead of reimplementing it per instance. The base stereotype
// stays authoritative for all of wairon's generic semantics; the variant adds
// domain vocabulary + a stable rule target + that guidance.
//
// Variants deliberately live OUTSIDE packs: a user can define one on demand — no
// pack edit or release — and share it anywhere (a variant is a tiny, portable
// YAML). Loaded from a machine/org-wide directory and the project, so a decent
// variant can be reused across projects, orgs, and tenants.
// ---------------------------------------------------------------------------

export const VariantDefSchema = z.object({
  /** Variant id referenced by a component's `variant` (e.g. "publisher", "org/external-config-adapter"). */
  id: z.string().min(1),
  /** The core stereotype this variant specializes — authoritative for generic semantics (Adapter, Specialist, …). */
  base: z.string().min(1),
  /** How to implement a component of this variant — the recipe the implementer follows and reuses across same-variant components. */
  guidance: z.string().min(1),
  /** Optional: this variant only applies for the given target language (else it applies everywhere). */
  target: z.string().optional(),
  /** Optional: this variant only applies under the given architectural profile. */
  profile: z.string().optional(),
});
export type VariantDef = z.infer<typeof VariantDefSchema>;

/**
 * The global variants directory: WAIRON_VARIANTS_DIR, else ~/.wairon/variants.
 * Machine/org-wide, auto-loaded for every project on this machine (the shared,
 * cross-project home; project variants win on collision).
 */
export function globalVariantsDir(): string {
  return process.env.WAIRON_VARIANTS_DIR ?? path.join(os.homedir(), '.wairon', 'variants');
}

/**
 * Read every VariantDef from a directory of *.yaml files (each file holds one
 * variant or a list of them). A missing/unreadable directory is an empty set,
 * never an error; a single malformed file is skipped (a diagnostic is logged)
 * so one bad variant never suppresses the rest.
 */
function readVariantsDir(dir: string): VariantDef[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: VariantDef[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !/\.ya?ml$/i.test(e.name)) continue;
    const full = path.join(dir, e.name);
    try {
      const raw = readYamlFile(full);
      if (raw == null) continue;
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) out.push(VariantDefSchema.parse(item));
    } catch (err) {
      console.error(`[variants] skipped "${full}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/**
 * Load the component-variant registry governing the current project: the global
 * variants (machine/org-wide) then the project's own (.wai/variants/), with the
 * project winning on an id collision. An uninitialized project simply has none.
 */
export function loadProjectVariants(): VariantDef[] {
  try {
    const byId = new Map<string, VariantDef>();
    for (const v of readVariantsDir(globalVariantsDir())) byId.set(v.id, v);
    for (const v of readVariantsDir(path.join(getProjectRoot(), '.wai', 'variants'))) byId.set(v.id, v);
    return [...byId.values()];
  } catch {
    return [];
  }
}
