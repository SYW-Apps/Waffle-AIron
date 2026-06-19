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
import { CONTEXT_PATHS, syncContextFiles } from '../core/context.js';
import { readStampVersion } from '../core/stamp.js';
import { localGuideFilePath, reinjectLocalGuides } from '../utils/ai-guide.js';
import { activeTargetTypes, checkSkillFreshness, exportSddSkills } from '../core/skills.js';
import { claudeMcpConfigPath } from './mcp.js';

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

/**
 * Health of a wairon MCP entry in a settings/mcp_config file. Beyond "is it
 * registered", this validates that a node-launched server actually points at a
 * file that exists — a stale path (moved repo, wrong machine) registers fine but
 * silently fails to launch, leaving the agent with zero wairon tools.
 */
function mcpEntryHealth(settingsPath: string): { mark: Mark; note: string } {
  if (!fs.existsSync(settingsPath)) return { mark: 'warn', note: 'not registered' };
  let entry: { command?: string; args?: unknown[] } | undefined;
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { mcpServers?: Record<string, { command?: string; args?: unknown[] }> };
    entry = s.mcpServers?.['wairon'];
  } catch {
    return { mark: 'error', note: 'parse error' };
  }
  if (!entry) return { mark: 'warn', note: 'not registered' };
  if (entry.command === 'node' && Array.isArray(entry.args) && typeof entry.args[0] === 'string') {
    const scriptPath = entry.args[0];
    if (!fs.existsSync(scriptPath)) {
      return { mark: 'error', note: `registered but the server path is missing — ${scriptPath}` };
    }
  }
  return { mark: 'ok', note: 'registered' };
}

export interface DoctorOptions {
  /** Regenerate stale in-project guides/context/skills and register the MCP server. */
  fix?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const tally: Tally = { warn: 0, error: 0 };

  logger.blank();
  console.log(`${chalk.bold('wairon doctor')} ${chalk.gray(`— installed v${WAIRON_VERSION}`)}`);
  logger.blank();

  // --fix runs before the report so the output reflects the repaired state.
  if (options.fix) {
    await applyFixes();
  }

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
  const wantClaude = targets.includes('claude') || targets.length === 0;
  const wantGemini = targets.includes('gemini') || targets.includes('agy');

  if (wantClaude) {
    // Claude loads server definitions from .mcp.json (project scope) — NOT
    // .claude/settings.json, whose mcpServers block it ignores.
    const h = mcpEntryHealth(claudeMcpConfigPath(false));
    line(tally, h.mark, `Claude (project .mcp.json): ${h.note}${h.mark === 'ok' ? '' : ' — run `wairon mcp install --backend claude`'}`);
  }
  if (wantGemini) {
    // Antigravity loads MCP from its GLOBAL mcp_config.json — that's the file that
    // actually controls whether the agy agent sees the sdd_* tools.
    const globalCfg = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'mcp_config.json');
    const hg = mcpEntryHealth(globalCfg);
    line(tally, hg.mark, `Antigravity (global mcp_config.json): ${hg.note}${hg.mark === 'ok' ? '' : ' — run `wairon mcp install --backend gemini --global`'}`);
    // The project .gemini/settings.json is the Gemini-CLI convention; Antigravity ignores it.
    const projPath = fromProjectRoot('.gemini', 'settings.json');
    if (fs.existsSync(projPath)) {
      const hp = mcpEntryHealth(projPath);
      line(tally, hp.mark === 'error' ? 'error' : 'ok', `Gemini CLI (project): ${hp.note} ${chalk.gray('(Antigravity ignores this file)')}`);
    }
  }

  // ── Legacy global Antigravity plugin — should NOT exist (name collides with
  //    the wairon MCP server). Flag it for removal if a stale copy is present.
  const pluginDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'wairon');
  if (fs.existsSync(pluginDir)) {
    line(tally, 'warn', `Legacy Antigravity plugin present (${pluginDir}) — it collides with the wairon MCP server. Remove it with \`wairon doctor --fix\`.`);
  }
  logger.blank();

  printSummary(tally);
  if (tally.error > 0) process.exit(1);
}

/**
 * Apply the safe, in-project fixes: regenerate context files, skills, and local
 * guides (so their version stamps match the installed wairon), and register the
 * MCP server for any active backend that lacks it. The global Antigravity plugin
 * writes outside the project, so it is reported but not auto-fixed.
 */
async function applyFixes(): Promise<void> {
  if (!isProjectInitialized()) return; // the report below will flag this

  let targets: string[];
  try {
    loadProjectConfig();
    targets = activeTargetTypes();
  } catch (e) {
    logger.warn(`--fix skipped: .wai/project.yaml is invalid (${e instanceof Error ? e.message : String(e)}). Fix it first.`);
    logger.blank();
    return;
  }

  console.log(chalk.bold('Applying fixes…'));

  try {
    syncContextFiles();
    exportSddSkills(targets);
    const guides = reinjectLocalGuides(process.cwd(), targets);
    console.log(`  ${icon('ok')} Regenerated context files, skills, and ${guides.length} local guide(s).`);
  } catch (e) {
    console.log(`  ${icon('error')} Regeneration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Register / repair the MCP server. The install is now self-healing, so this
  // also rewrites a stale launch path. Claude uses the project config; Antigravity
  // (agy) only reads its GLOBAL mcp_config.json, so register there for it.
  const { runMcpInstall } = require('./mcp.js') as typeof import('./mcp.js');
  if (targets.includes('claude')) {
    try {
      await runMcpInstall({ backend: 'claude', global: false });
    } catch (e) {
      console.log(`  ${icon('warn')} MCP install for claude failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (targets.includes('gemini') || targets.includes('agy')) {
    // Global for Antigravity (the file it reads); also fine for the Gemini CLI.
    const global = targets.includes('agy');
    try {
      await runMcpInstall({ backend: 'gemini', global });
    } catch (e) {
      console.log(`  ${icon('warn')} MCP install for gemini failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Cleanup/migration (belongs in --fix, not install): drop the legacy plugin
    // whose name collides with the wairon MCP server.
    try {
      const { removeLegacyGlobalPlugin } = require('./mcp.js') as typeof import('./mcp.js');
      if (removeLegacyGlobalPlugin()) console.log(`  ${icon('ok')} Removed the legacy global Antigravity plugin (name collided with the MCP server).`);
    } catch { /* ignore */ }
  }

  logger.blank();
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
