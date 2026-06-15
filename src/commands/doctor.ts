import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import {
  isProjectInitialized,
  loadProjectConfig,
  AI_PATHS,
} from '../config/loader.js';
import { pathExists, readFileOrNull, fromProjectRoot } from '../utils/fs.js';
import { CONTEXT_PATHS } from '../core/context.js';
import { readStampVersion } from '../core/stamp.js';
import { localGuideFilePath } from '../utils/ai-guide.js';
import { activeTargetTypes, checkSkillFreshness } from '../core/skills.js';

// ---------------------------------------------------------------------------
// doctor command
//
// A health check for a wairon project. Its headline job is staleness
// detection: generated files (the injected guide, the .wai/context guides,
// the global Antigravity plugin skill) carry a version stamp, and doctor warns
// when they were produced by an older wairon than the one installed — the
// classic "the agent is reading an out-of-date guide" trap. It also surfaces
// missing skills, an unregistered MCP server, and spec-tree conformance.
// ---------------------------------------------------------------------------

type Mark = 'ok' | 'warn' | 'error';

interface Tally {
  warn: number;
  error: number;
}

function icon(mark: Mark): string {
  if (mark === 'ok') return chalk.green('✓');
  if (mark === 'warn') return chalk.yellow('⚠');
  return chalk.red('✗');
}

function line(tally: Tally, mark: Mark, msg: string): void {
  console.log(`  ${icon(mark)} ${msg}`);
  if (mark === 'warn') tally.warn++;
  else if (mark === 'error') tally.error++;
}

/** Verdict on a generated file's freshness from its version stamp. */
function stampVerdict(content: string | null): { mark: Mark; note: string } {
  if (content === null) return { mark: 'error', note: 'missing' };
  const v = readStampVersion(content);
  if (v === null) return { mark: 'warn', note: 'unstamped (older wairon)' };
  if (v === WAIRON_VERSION) return { mark: 'ok', note: `v${v}` };
  return { mark: 'warn', note: `v${v} — stale, installed is v${WAIRON_VERSION}` };
}

function mcpRegistered(settingsPath: string): boolean | null {
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { mcpServers?: Record<string, unknown> };
    return !!s.mcpServers?.['wairon'];
  } catch {
    return null;
  }
}

export async function runDoctor(): Promise<void> {
  const tally: Tally = { warn: 0, error: 0 };

  logger.blank();
  console.log(`${chalk.bold('wairon doctor')} ${chalk.gray(`— installed v${WAIRON_VERSION}`)}`);
  logger.blank();

  // ── Project ───────────────────────────────────────────────────────────────
  console.log(chalk.bold('Project'));
  if (!isProjectInitialized()) {
    line(tally, 'error', 'Not a wairon project (no .wai/project.yaml). Run `wairon init`.');
    printSummary(tally);
    process.exit(1);
  }
  line(tally, 'ok', 'Initialized (.wai/ present)');

  let targets: string[] = [];
  let configOk = false;
  try {
    loadProjectConfig();
    configOk = true;
    line(tally, 'ok', '.wai/project.yaml is valid');
  } catch (e) {
    line(tally, 'error', `.wai/project.yaml is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (configOk) {
    try { targets = activeTargetTypes(); } catch { /* leave empty */ }
  }

  const hasSystemSpec = pathExists(AI_PATHS.specsSystem());
  if (hasSystemSpec) {
    line(tally, 'ok', 'System spec present (.wai/specs/system.yaml)');
  } else {
    line(tally, 'warn', 'No system spec yet — design one via the sdd-architect skill / sdd_initialize_system');
  }
  logger.blank();

  // ── Spec tree conformance ───────────────────────────────────────────────────
  if (hasSystemSpec && configOk) {
    console.log(chalk.bold('Spec tree'));
    try {
      const { validateSddTree } = require('../core/validation.js') as typeof import('../core/validation.js');
      const cfg = loadProjectConfig();
      const result = validateSddTree(cfg.rules);
      const errs = result.issues.filter((i) => i.severity === 'error').length;
      const warns = result.issues.filter((i) => i.severity === 'warning').length;
      if (errs > 0) line(tally, 'error', `Conformance: ${errs} error(s), ${warns} warning(s) — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else if (warns > 0) line(tally, 'warn', `Conformance: ${warns} warning(s) — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else line(tally, 'ok', 'Conformance: 0 errors, 0 warnings');
    } catch (e) {
      line(tally, 'warn', `Could not run conformance check: ${e instanceof Error ? e.message : String(e)}`);
    }
    logger.blank();
  }

  // ── Generated context files ─────────────────────────────────────────────────
  console.log(chalk.bold(`Generated files ${chalk.gray('(stale = older than installed)')}`));
  for (const [label, p] of [
    ['.wai/context/wairon-guide.md', CONTEXT_PATHS.waironGuideMd()],
    ['.wai/context/domains.md', CONTEXT_PATHS.domainsMd()],
  ] as const) {
    if (!pathExists(p)) {
      line(tally, 'warn', `${label} — not generated yet (run \`wairon generate\`)`);
      continue;
    }
    const { mark, note } = stampVerdict(readFileOrNull(p));
    line(tally, mark, `${label} (${note})`);
  }

  // Injected guides, de-duplicated by path (claude → .claude/CLAUDE.md, gemini/agy → .gemini/GEMINI.md)
  const seenGuides = new Set<string>();
  for (const t of targets) {
    const gp = localGuideFilePath(process.cwd(), t);
    if (!gp || seenGuides.has(gp)) continue;
    seenGuides.add(gp);
    const rel = path.relative(process.cwd(), gp).replace(/\\/g, '/');
    if (!pathExists(gp)) {
      line(tally, 'warn', `${rel} guide — not injected (run \`wairon generate\`)`);
      continue;
    }
    const { mark, note } = stampVerdict(readFileOrNull(gp));
    line(tally, mark === 'error' ? 'warn' : mark, `${rel} guide (${note})`);
  }
  logger.blank();

  // ── Skills ──────────────────────────────────────────────────────────────────
  if (targets.length > 0) {
    console.log(chalk.bold('SDD skills'));
    for (const t of targets) {
      const f = checkSkillFreshness(t);
      if (!f.dir) continue; // target has no skills dir
      const total = f.ok.length + f.stale.length + f.missing.length;
      if (f.missing.length === 0 && f.stale.length === 0) {
        line(tally, 'ok', `${t}: ${f.ok.length}/${total} up to date`);
      } else {
        const parts: string[] = [];
        if (f.stale.length) parts.push(`${f.stale.length} stale`);
        if (f.missing.length) parts.push(`${f.missing.length} missing`);
        line(tally, 'warn', `${t}: ${parts.join(', ')} — run \`wairon generate\``);
      }
    }
    logger.blank();
  }

  // ── MCP server ──────────────────────────────────────────────────────────────
  console.log(chalk.bold('MCP server'));
  const backends = new Set<string>();
  for (const t of targets) {
    if (t === 'claude') backends.add('claude');
    if (t === 'gemini' || t === 'agy') backends.add('gemini');
  }
  if (backends.size === 0) backends.add('claude');
  for (const backend of backends) {
    const label = backend === 'gemini' ? 'Antigravity (project)' : 'Claude (project)';
    const settingsPath = backend === 'gemini'
      ? fromProjectRoot('.gemini', 'settings.json')
      : fromProjectRoot('.claude', 'settings.json');
    const reg = mcpRegistered(settingsPath);
    if (reg === true) line(tally, 'ok', `${label}: registered`);
    else line(tally, 'warn', `${label}: not registered — run \`wairon mcp install --backend ${backend}\``);
  }

  // ── Global Antigravity plugin (best-effort; only if installed) ──────────────
  const pluginSkill = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'wairon', 'skills', 'wairon', 'SKILL.md');
  if (fs.existsSync(pluginSkill)) {
    const { mark, note } = stampVerdict(readFileOrNull(pluginSkill));
    if (mark === 'ok') line(tally, 'ok', `Global plugin SKILL.md (${note})`);
    else line(tally, 'warn', `Global plugin SKILL.md (${note}) — run \`wairon mcp install --backend gemini --global\``);
  }
  logger.blank();

  printSummary(tally);
  if (tally.error > 0) process.exit(1);
}

function printSummary(tally: Tally): void {
  if (tally.error === 0 && tally.warn === 0) {
    logger.success('All checks passed — everything is current.');
  } else {
    const parts: string[] = [];
    if (tally.error > 0) parts.push(chalk.red(`${tally.error} error(s)`));
    if (tally.warn > 0) parts.push(chalk.yellow(`${tally.warn} warning(s)`));
    console.log(`${chalk.bold('Summary:')} ${parts.join(', ')}.`);
    if (tally.warn > 0 && tally.error === 0) {
      logger.info('Most issues clear with `wairon generate` (and `wairon mcp install` for MCP).');
    }
  }
  logger.blank();
}
