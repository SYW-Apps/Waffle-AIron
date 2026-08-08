import * as path from 'path';
import * as fs from 'fs';
import { ensureDir, fromProjectRoot } from '../utils/fs.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import { loadProjectExtensions as loadCoreExtensions, LoadedPackSkill } from './extensions.js';
import { buildServerInstructions as composeServerInstructions } from './instructions.js';

// ---------------------------------------------------------------------------
// SDD skills export
//
// The built-in SDD skills (architect / narrative / auditor / implement /
// delegate) are copied into each active target tool's skills directory so the
// host AI tool can run them in-session. Skills are how wairon "equips" a
// session — it does not orchestrate sessions itself.
// ---------------------------------------------------------------------------

const SKILL_NAMES = ['sdd-architect', 'sdd-narrative', 'sdd-auditor', 'sdd-implement', 'sdd-delegate'];

/**
 * skills_core_adapter: forward to the core surface to load the governing
 * extension packs — for their pack-provided skills (the exporter and the
 * resource mirror) and their contributed instruction blocks (the instructions
 * composer). Exported so the composer goes through this ONE adapter rather than
 * reaching into sdd_core itself; it is the single seam this subsystem crosses
 * the boundary through.
 */
export function loadProjectExtensions() {
  return loadCoreExtensions();
}

/**
 * The install/resource id for a pack skill: namespaced by pack id so it never
 * collides with the reserved built-in sdd-* skills or another pack's skills.
 */
function packSkillId(skill: LoadedPackSkill): string {
  return `${packNamespace(skill.pack)}-${skill.id}`;
}

/** A pack's name reduced to an id-safe namespace. */
function packNamespace(pack: string): string {
  return pack.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Skill composition — a pack EXTENDING a builtin (FR 7.3)
//
// A pack skill may `extends: sdd-implement` instead of standing beside it. Its
// section is appended to the builtin under `## Platform: <pack>`, in pack load
// order, so an implementing agent reads ONE coherent instruction with the
// platform part clearly attributed — rather than noticing two skills and
// reconciling them, or (worse) every wrapper forking the builtin wholesale.
//
// The builtin stays wairon's: an upgrade still updates the base text, and only
// the appended sections come from packs.
// ---------------------------------------------------------------------------

/** The pack sections extending one builtin skill, in pack load order. */
function extensionsFor(builtin: string, packSkills: LoadedPackSkill[]): LoadedPackSkill[] {
  return packSkills.filter((s) => s.extends === builtin && fs.existsSync(s.sourcePath));
}

/**
 * A builtin skill's content with every extending pack's section appended. Returns
 * the builtin verbatim when no pack extends it, so an unextended skill is
 * byte-identical to the template it ships as.
 */
function composeBuiltinSkill(name: string, packSkills: LoadedPackSkill[]): string {
  const srcPath = skillTemplatePath(name);
  const base = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf-8') : '';
  const sections = extensionsFor(name, packSkills);
  if (sections.length === 0) return base;

  const parts = [base.trimEnd()];
  for (const section of sections) {
    // Strip the extending file's own frontmatter: the composed skill keeps the
    // BUILTIN's frontmatter, so its name/description stay wairon's.
    const body = fs.readFileSync(section.sourcePath, 'utf-8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    parts.push(`## Platform: ${section.pack}`, body.trim());
  }
  return `${parts.join('\n\n')}\n`;
}


/** Parse a SKILL.md's YAML frontmatter (name + description) from its raw content. */
function readFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const block = match ? match[1] : '';
  const field = (key: string): string => {
    const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(block);
    return m ? m[1].trim() : '';
  };
  return { name: field('name') || fallbackName, description: field('description') };
}

function builtinSkillsDir(): string {
  return path.resolve(__dirname, '..', 'templates', 'skills');
}

/** Built-in template source for a skill (always flat <name>.md). */
function skillTemplatePath(name: string): string {
  return path.join(builtinSkillsDir(), `${name}.md`);
}

/**
 * Destination path for a skill inside a target's skills dir.
 *
 * Claude, Codex, and Antigravity have all converged on the same packaging:
 * a `<name>/SKILL.md` directory with YAML frontmatter (name + description).
 * Flat `<name>.md` files are silently ignored by these tools (so `Skill(<name>)`
 * reports "Unknown skill"). Only unverified targets fall back to a flat layout.
 */
function skillDestPath(type: string, destDir: string, name: string): string {
  if (type === 'claude' || type === 'codex' || type === 'gemini' || type === 'agy') {
    return path.join(destDir, name, 'SKILL.md');
  }
  return path.join(destDir, `${name}.md`);
}

/**
 * The skills directory for a given target tool, or null if the tool has none.
 *
 * Codex and Antigravity both discover project-scoped skills from `.agents/skills/`
 * (Codex scans it from cwd up to the repo root; Antigravity reads it as project
 * scope), so they share one directory. Claude uses its own `.claude/skills/`.
 */
export function skillsDirForTarget(type: string): string | null {
  switch (type) {
    case 'claude': return fromProjectRoot('.claude', 'skills');
    case 'gemini': // Gemini-based Antigravity
    case 'agy':
    case 'codex':  return fromProjectRoot('.agents', 'skills');
    case 'cursor': return fromProjectRoot('.cursor', 'skills');
    default:       return null;
  }
}

/** Names (without extension) of the built-in SDD skills. */
export function listSkillNames(): string[] {
  return [...SKILL_NAMES];
}

export interface SkillsExportResult {
  /** Skills directories written to. */
  destinations: string[];
  /** Total skill files written. */
  fileCount: number;
  /** Target types that have no skills directory (skipped). */
  skipped: string[];
}

/**
 * Copy the built-in SDD skill templates into each active target's skills dir.
 * If targetTypes is omitted, the active targets are read from project config.
 */
export function exportSddSkills(targetTypes?: string[]): SkillsExportResult {
  const types = targetTypes ?? activeTargetTypes();

  const destinations: string[] = [];
  const skipped: string[] = [];
  let fileCount = 0;

  // Pack-provided skills discovered from the loaded extension packs (empty when
  // no packs declare any — so projects without pack skills see no change).
  const packSkills = loadProjectExtensions().skills;

  for (const type of types) {
    const destDir = skillsDirForTarget(type);
    if (!destDir) {
      skipped.push(type);
      continue;
    }
    ensureDir(destDir);
    destinations.push(destDir);

    for (const name of SKILL_NAMES) {
      if (!fs.existsSync(skillTemplatePath(name))) continue;
      // The builtin, plus any pack sections extending it. Otherwise copied
      // verbatim — skills are agent-facing and reference MCP tools, not the
      // `wairon` CLI, so there is no dev-path command to substitute.
      const content = composeBuiltinSkill(name, packSkills.filter((s) => s.targets.includes(type)));
      const destPath = skillDestPath(type, destDir, name);
      ensureDir(path.dirname(destPath));
      fs.writeFileSync(destPath, content, 'utf-8');
      fileCount++;
    }

    // NEW pack skills targeting this client: installed namespaced
    // <pack-id>-<skill-id>. An `extends` skill is not installed on its own — it
    // composed into its builtin above.
    for (const skill of packSkills) {
      if (skill.extends !== undefined) continue;
      if (!skill.targets.includes(type)) continue;
      if (!fs.existsSync(skill.sourcePath)) continue;
      const id = packSkillId(skill);
      const content = fs.readFileSync(skill.sourcePath, 'utf-8');
      const destPath = skillDestPath(type, destDir, id);
      ensureDir(path.dirname(destPath));
      fs.writeFileSync(destPath, content, 'utf-8');
      fileCount++;
    }
  }

  return { destinations, fileCount, skipped };
}

export interface SkillFreshness {
  /** The skills directory for this target, or null if the target has none. */
  dir: string | null;
  /** Skill files that are missing on disk. */
  missing: string[];
  /** Skill files present on disk but differing from the current built-in template. */
  stale: string[];
  /** Skill files present and byte-identical to the built-in template. */
  ok: string[];
}

/**
 * Compare a target's installed SDD skills against the built-in templates, so
 * `wairon doctor` can report missing or stale (out-of-date) skill files.
 */
export function checkSkillFreshness(type: string): SkillFreshness {
  const dir = skillsDirForTarget(type);
  const result: SkillFreshness = { dir, missing: [], stale: [], ok: [] };
  if (!dir) return result;

  // Compare against what exportSddSkills WOULD write, not against the raw
  // template: a builtin extended by a pack legitimately differs from its
  // template, and comparing to the template would report every extended skill as
  // permanently stale — telling users to run `generate` forever.
  const packSkills = loadProjectExtensions().skills.filter((s) => s.targets.includes(type));

  for (const name of SKILL_NAMES) {
    const destPath = skillDestPath(type, dir, name);
    if (!fs.existsSync(destPath)) { result.missing.push(name); continue; }
    const want = composeBuiltinSkill(name, packSkills);
    const have = fs.readFileSync(destPath, 'utf-8');
    if (have === want) result.ok.push(name);
    else result.stale.push(name);
  }
  return result;
}

export function activeTargetTypes(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadProjectConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
  const config = loadProjectConfig();
  return config.targets
    .filter((t: { enabled?: boolean }) => !('enabled' in t) || t.enabled)
    .map((t: string | { type: string }) => (typeof t === 'string' ? t : t.type));
}

// ---------------------------------------------------------------------------
// SDD skills as MCP resources
//
// Cloud-only agents cannot receive the filesystem-exported skills above, so the
// MCP server also publishes the five built-in SDD skills as read-only MCP
// resources. The functions below resolve the SAME packaged templates that
// exportSddSkills copies to disk (src/templates/skills/*.md) into MCP-safe
// descriptors and markdown content.
//
// Layering (folded into this module, mirroring exportSddSkills):
//   skills_resource_specialist  → listSkillResources / readSkillResource (pure)
//   skills_resource_orchestrator→ validation + dispatch (inside readResource)
//   skills_portal               → listResources / readResource (adapter entry)
// ---------------------------------------------------------------------------

/** MCP resource URI scheme for a built-in SDD skill (e.g. wairon-skill://sdd-architect). */
const SKILL_RESOURCE_SCHEME = 'wairon-skill';

/**
 * The five packaged SDD skills published as MCP resources, in a stable
 * (alphabetical) order. Derived from SKILL_NAMES so the resource set can never
 * drift from the export source of truth.
 */
const RESOURCE_SKILL_IDS: string[] = [...SKILL_NAMES].sort();

/** MCP-safe descriptor for a Wairon-provided built-in skill resource. */
export interface SkillResourceDescriptor {
  /** Stable skill resource id, such as "sdd-architect". */
  id: string;
  /** Human-readable skill name. */
  name: string;
  /** Short description of when an agent should use the skill. */
  description: string;
  /** Skill content version / Wairon version that provides it. */
  version?: string;
  /** MCP resource URI used to fetch the skill content. */
  resourceUri: string;
  /** Whether hosted MCP advertises this skill by default. */
  defaultForHostedMcp: boolean;
}

/** Thrown when a skill resource id is not one of the built-in SDD skills. */
export class SkillResourceNotFoundError extends Error {
  constructor(resourceId: string) {
    super(`Unknown SDD skill resource id: "${resourceId}".`);
    this.name = 'SkillResourceNotFoundError';
  }
}

/** Parse a skill template's YAML frontmatter for its name and description. */
function readSkillFrontmatter(name: string): { name: string; description: string } {
  return readFrontmatter(fs.readFileSync(skillTemplatePath(name), 'utf-8'), name);
}

// ── skills_resource_specialist ─────────────────────────────────────────────

/** List the five built-in SDD skills as MCP-safe resource descriptors. */
export function listSkillResources(): SkillResourceDescriptor[] {
  const builtin: SkillResourceDescriptor[] = RESOURCE_SKILL_IDS.map((id) => {
    const fm = readSkillFrontmatter(id);
    return {
      id,
      name: fm.name,
      description: fm.description,
      version: WAIRON_VERSION,
      resourceUri: `${SKILL_RESOURCE_SCHEME}://${id}`,
      defaultForHostedMcp: true,
    };
  });
  // Pack-provided skills (namespaced by pack id), published alongside the
  // built-ins. An `extends` skill gets no resource of its own — it composed into
  // its builtin's content above, which is the point: one coherent instruction.
  const pack: SkillResourceDescriptor[] = loadProjectExtensions().skills
    .filter((s) => s.extends === undefined && fs.existsSync(s.sourcePath))
    .map((skill) => {
      const id = packSkillId(skill);
      const fm = readFrontmatter(fs.readFileSync(skill.sourcePath, 'utf-8'), id);
      return {
        id,
        name: fm.name,
        description: fm.description,
        version: skill.packVersion ?? WAIRON_VERSION,
        resourceUri: `${SKILL_RESOURCE_SCHEME}://${id}`,
        defaultForHostedMcp: true,
      };
    });
  return [...builtin, ...pack];
}

/**
 * Read one skill's markdown content. A builtin is returned COMPOSED with any pack
 * sections extending it (the same text `exportSddSkills` writes to disk), so a
 * cloud-only agent reading over MCP and a local session reading from disk get the
 * identical instruction.
 */
export function readSkillResource(resourceId: string): string {
  const packSkills = loadProjectExtensions().skills;
  if (SKILL_NAMES.includes(resourceId)) return composeBuiltinSkill(resourceId, packSkills);
  const packSkill = packSkills.find((s) => s.extends === undefined && packSkillId(s) === resourceId);
  if (packSkill) return fs.readFileSync(packSkill.sourcePath, 'utf-8');
  return fs.readFileSync(skillTemplatePath(resourceId), 'utf-8');
}

// ── skills_resource_orchestrator → skills_portal ───────────────────────────

/** Portal: list the built-in SDD skills as MCP resource descriptors. */
export function listResources(): SkillResourceDescriptor[] {
  return listSkillResources();
}

/**
 * Orchestrator + Portal: compose the `instructions` the MCP server returns on
 * the initialize handshake, through the instructions specialist. (That module
 * imports back into this one — see the note in core/instructions.ts.)
 */
export function buildServerInstructions(): string {
  return composeServerInstructions();
}

/**
 * Portal: read one built-in SDD skill's content by MCP resource id. Rejects an
 * unknown id — validated against the listed descriptors — before reading.
 */
export function readResource(resourceId: string): string {
  const known = listSkillResources().some((d) => d.id === resourceId);
  if (!known) throw new SkillResourceNotFoundError(resourceId);
  return readSkillResource(resourceId);
}
