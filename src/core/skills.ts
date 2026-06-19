import * as path from 'path';
import * as fs from 'fs';
import { ensureDir, fromProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// SDD skills export
//
// The built-in SDD skills (architect / narrative / auditor / implement) are
// copied into each active target tool's skills directory so the host AI tool
// can run them in-session. Skills are how wairon "equips" a session — it does
// not orchestrate sessions itself.
// ---------------------------------------------------------------------------

const SKILL_NAMES = ['sdd-architect', 'sdd-narrative', 'sdd-auditor', 'sdd-implement'];

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

  for (const type of types) {
    const destDir = skillsDirForTarget(type);
    if (!destDir) {
      skipped.push(type);
      continue;
    }
    ensureDir(destDir);
    destinations.push(destDir);

    for (const name of SKILL_NAMES) {
      const srcPath = skillTemplatePath(name);
      if (!fs.existsSync(srcPath)) continue;
      // Copy verbatim — skills are agent-facing and reference MCP tools, not the
      // `wairon` CLI, so there is no dev-path command to substitute.
      const content = fs.readFileSync(srcPath, 'utf-8');
      const destPath = skillDestPath(type, destDir, name);
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

  for (const name of SKILL_NAMES) {
    const destPath = skillDestPath(type, dir, name);
    if (!fs.existsSync(destPath)) { result.missing.push(name); continue; }
    const srcPath = skillTemplatePath(name);
    const want = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf-8') : '';
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
