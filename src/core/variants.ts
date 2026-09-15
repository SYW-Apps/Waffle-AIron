import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { z } from 'zod';
import { parseYaml, readYamlFile, serializeYaml } from '../utils/yaml.js';
import { getProjectRoot, readFileOrNull, writeFile } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// Component variant registry — a DYNAMIC layer that lives ON TOP OF packs.
//
// A variant is a named, base-anchored specialization of a core stereotype (a
// "kind of Adapter/Orchestrator/…"), carrying implementation guidance so the
// implementer treats every component of the same variant alike — reusing one
// shared approach instead of reimplementing it per instance. The base stereotype
// stays authoritative for all of wairon's generic semantics; the variant adds
// domain vocabulary + a stable rule target + that guidance.
//
// The registry loads in three layers, a later layer overriding an earlier one by
// id: wairon's built-in variants (shipped in its templates — the logic shapes on
// Orchestrator, the gateway on Portal), then a machine/org-wide directory, then
// the project's own. Variants deliberately live OUTSIDE packs: a user can define
// one on demand — no pack edit or release — and share it anywhere (a variant is
// a tiny, portable YAML), so a decent variant can be reused across projects,
// orgs, and tenants.
// ---------------------------------------------------------------------------

export const VariantDefSchema = z.object({
  /** Variant id referenced by a component's `variant` (e.g. "publisher", "org/external-config-adapter"). */
  id: z.string().min(1),
  /** The core stereotype this variant specializes — authoritative for generic semantics (Adapter, Orchestrator, …). */
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
 * wairon's built-in variants, shipped with its templates: src/templates when run
 * from source, dist/templates once built — which the packaged binary carries as
 * snapshot assets beside its bundled entry.
 */
function builtinVariantsDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'templates', 'variants'), // src/core & dist/cli
    path.resolve(__dirname, 'templates', 'variants'),       // dist (library entry)
  ];
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

/** The project's own variants directory, .wai/variants/. */
function projectVariantsDir(): string {
  return path.join(getProjectRoot(), '.wai', 'variants');
}

/** A directory's *.yaml files in name order; a missing or unreadable directory has none. */
function variantFiles(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => path.join(dir, e.name));
}

/** A variant file's parsed content — one variant or a list of them. Throws when any entry is malformed. */
function parseVariants(raw: unknown): VariantDef[] {
  if (raw == null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((item) => VariantDefSchema.parse(item));
}

function reportSkippedFile(file: string, err: unknown): void {
  console.error(`[variants] skipped "${file}": ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Read every VariantDef from a directory of *.yaml files. A missing/unreadable
 * directory is an empty set, never an error; a malformed file is skipped whole
 * (a diagnostic is logged) so one bad variant never suppresses the rest.
 */
function readVariantsDir(dir: string): VariantDef[] {
  const out: VariantDef[] = [];
  for (const file of variantFiles(dir)) {
    try {
      out.push(...parseVariants(readYamlFile(file)));
    } catch (err) {
      reportSkippedFile(file, err);
    }
  }
  return out;
}

/** Merge variant layers in order, a later layer's variant replacing an earlier one with the same id. */
function mergeById(...layers: VariantDef[][]): VariantDef[] {
  const byId = new Map<string, VariantDef>();
  for (const layer of layers) {
    for (const v of layer) byId.set(v.id, v);
  }
  return [...byId.values()];
}

/** A component's resolved variant, with the same-variant siblings to implement alike. */
export interface ResolvedVariantGuidance {
  /** The variant id the component declares. */
  variant: string;
  /** The core stereotype it specializes — authoritative for generic semantics. */
  base: string;
  /** How to implement a component of this variant. */
  guidance: string;
  /** Other components of the same variant, to implement consistently. */
  siblings: string[];
  /** Only applies for this target language, when the variant scopes itself. */
  target?: string;
  /** Only applies under this architectural profile, when the variant scopes itself. */
  profile?: string;
}

/**
 * Resolve one component's variant guidance, or null when it declares none (or one
 * that does not resolve).
 *
 * The payoff of a variant is that every component of the same kind is implemented
 * alike, so the siblings travel WITH the guidance. Shared by the generated-agent
 * renderer and the MCP `sdd_get_spec` path — the same resolution, so a hosted agent
 * and a local session are told the same thing.
 */
export function resolveVariantGuidance(
  component: { id: string; variant?: string },
  allComponents: { id: string; variant?: string }[],
  variantsById: Map<string, VariantDef>,
): ResolvedVariantGuidance | null {
  if (!component.variant) return null;
  const def = variantsById.get(component.variant);
  if (!def) return null;
  return {
    variant: component.variant,
    base: def.base,
    guidance: def.guidance,
    siblings: allComponents
      .filter((o) => o.variant === component.variant && o.id !== component.id)
      .map((o) => o.id),
    ...(def.target ? { target: def.target } : {}),
    ...(def.profile ? { profile: def.profile } : {}),
  };
}

/**
 * The "Component variants" block injected into an owner/implementer agent for its
 * variant-tagged components. Empty when none of them declare a known variant.
 */
export function composeVariantGuidance(
  comps: { id: string; variant?: string }[],
  allComponents: { id: string; variant?: string }[],
  variantsById: Map<string, VariantDef>,
): string {
  const resolved = comps
    .map((c) => ({ id: c.id, guidance: resolveVariantGuidance(c, allComponents, variantsById) }))
    .filter((r): r is { id: string; guidance: ResolvedVariantGuidance } => r.guidance !== null);
  if (resolved.length === 0) return '';

  const lines = [
    '## Component variants — reuse the shared approach',
    '',
    'One or more of your components declare a variant — a base-anchored kind with implementation guidance. Implement every component of the same variant alike, reusing one shared approach instead of reinventing it per instance:',
    '',
  ];
  for (const { id, guidance } of resolved) {
    let line = `- **${id}** — variant \`${guidance.variant}\` (a kind of ${guidance.base}): ${guidance.guidance}`;
    if (guidance.siblings.length > 0) {
      line += ` Same-variant components elsewhere: ${guidance.siblings.join(', ')} — implement them consistently, reusing the same logic/concept.`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/**
 * Load the component-variant registry governing the current project: wairon's
 * built-in variants, then the global variants (machine/org-wide), then the
 * project's own (.wai/variants/), a later layer winning on an id collision.
 */
export function loadProjectVariants(): VariantDef[] {
  try {
    return mergeById(
      readVariantsDir(builtinVariantsDir()),
      readVariantsDir(globalVariantsDir()),
      readVariantsDir(projectVariantsDir()),
    );
  } catch {
    return [];
  }
}

/**
 * The variants the project's own .wai/variants/ files define, without the
 * built-in or global layers: the variants a migration may rewrite.
 */
export function listProjectVariants(): VariantDef[] {
  return mergeById(readVariantsDir(projectVariantsDir()));
}

/**
 * Rewrite, in place, the base of every project variant whose base is fromBase to
 * toBase, and return the ids rebased. Only the project's .wai/variants/ files are
 * touched: a file with no such variant is left as it is, and a malformed one is
 * skipped with a diagnostic, as the loader skips it.
 */
export function rebaseProjectVariants(fromBase: string, toBase: string): string[] {
  const rebased: string[] = [];
  for (const file of variantFiles(projectVariantsDir())) {
    const content = readFileOrNull(file);
    if (content === null) continue;
    let raw: unknown;
    let variants: VariantDef[];
    try {
      raw = parseYaml(content, file);
      variants = parseVariants(raw);
    } catch (err) {
      reportSkippedFile(file, err);
      continue;
    }
    const matching = variants.filter((v) => v.base === fromBase);
    if (matching.length === 0) continue;

    writeFile(file, rebasedText(content, fromBase, toBase, withRebasedEntries(raw, fromBase, toBase)));
    for (const v of matching) {
      if (!rebased.includes(v.id)) rebased.push(v.id);
    }
  }
  return rebased;
}

/** A variant file's parsed content with each matching entry's base replaced, every other key kept in place. */
function withRebasedEntries(raw: unknown, fromBase: string, toBase: string): unknown {
  const rebase = (entry: Record<string, unknown>) => (entry.base === fromBase ? { ...entry, base: toBase } : entry);
  return Array.isArray(raw) ? raw.map(rebase) : rebase(raw as Record<string, unknown>);
}

/**
 * The file text carrying the rebased content. Editing only the `base:` lines
 * keeps the file's comments and formatting; when that edit does not parse to
 * exactly the rebased content (a flow-style entry, or guidance text that holds a
 * base line of its own), the rebased content is serialized instead.
 */
function rebasedText(content: string, fromBase: string, toBase: string, rebasedContent: unknown): string {
  const escaped = fromBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const baseLine = new RegExp(`^([ \\t]*(?:-[ \\t]+)?base:[ \\t]*)(["']?)${escaped}\\2(?=[ \\t]*(?:#.*)?$)`, 'gm');
  const edited = content.replace(baseLine, (_line, key: string, quote: string) => `${key}${quote}${toBase}${quote}`);
  try {
    if (JSON.stringify(parseYaml(edited)) === JSON.stringify(rebasedContent)) return edited;
  } catch {
    // An edit that no longer parses falls back to serializing the content.
  }
  return serializeYaml(rebasedContent);
}
