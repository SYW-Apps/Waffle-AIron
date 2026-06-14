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

const SKILL_FILES = ['sdd-architect.md', 'sdd-narrative.md', 'sdd-auditor.md', 'sdd-implement.md'];

function builtinSkillsDir(): string {
  return path.resolve(__dirname, '..', 'templates', 'skills');
}

/** The skills directory for a given target tool, or null if the tool has none. */
export function skillsDirForTarget(type: string): string | null {
  switch (type) {
    case 'claude': return fromProjectRoot('.claude', 'skills');
    case 'gemini': return fromProjectRoot('.gemini', 'skills');
    case 'agy':    return fromProjectRoot('.agy', 'skills');
    case 'codex':  return fromProjectRoot('.codex', 'skills');
    case 'cursor': return fromProjectRoot('.cursor', 'skills');
    default:       return null;
  }
}

/** Names (without extension) of the built-in SDD skills. */
export function listSkillNames(): string[] {
  return SKILL_FILES.map((f) => f.replace(/\.md$/, ''));
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

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCliCommandString } = require('../utils/ai-guide.js') as typeof import('../utils/ai-guide.js');
  const command = getCliCommandString();

  const sourceDir = builtinSkillsDir();
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

    for (const file of SKILL_FILES) {
      const srcPath = path.join(sourceDir, file);
      if (!fs.existsSync(srcPath)) continue;
      const content = fs.readFileSync(srcPath, 'utf-8').replace(/\bwairon\b/g, command);
      fs.writeFileSync(path.join(destDir, file), content, 'utf-8');
      fileCount++;
    }
  }

  return { destinations, fileCount, skipped };
}

function activeTargetTypes(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadProjectConfig } = require('../config/loader.js') as typeof import('../config/loader.js');
  const config = loadProjectConfig();
  return config.targets
    .filter((t: { enabled?: boolean }) => !('enabled' in t) || t.enabled)
    .map((t: string | { type: string }) => (typeof t === 'string' ? t : t.type));
}
