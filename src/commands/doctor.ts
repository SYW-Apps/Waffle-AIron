import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import { AI_PATHS } from '../config/paths.js';
import { DoctorOptionsError, ProjectNotInitializedError } from '../utils/errors.js';
import {
  loadProjectConfig,
  projectConfigExists,
  retireSpecialists,
  repairForeignStepFields,
  readLockState,
  // Through the core adapter, never ../core/stamp.js or ../utils/ai-guide.js:
  // reading a stamp and refreshing the guides are sdd_core work, and doctor is
  // an sdd_cli command. Eighth instance of that crossing, closed where the
  // other seven were.
  readStampVersion,
  localGuideFilePath,
  reinjectLocalGuides,
  // Same crossing, same place it closes: rebuilding the derived context
  // documents and asking where they live is sdd_core work. `CONTEXT_PATHS` is
  // gone from here for the same reason — the layout of `.wai/context/` is the
  // store's to state, not a list this command spells out for itself.
  syncContextFiles,
  derivedDocPaths,
  // The filename migration, the chained-subproject repair and the pack
  // diagnosis are sdd_core's too, and reach it the same way.
  findLegacySpecFiles,
  findChainingSubprojectsMissingConfig,
  backfillChainedSubprojectConfigs,
  diagnoseProjectPacks,
  pinInstalledPacksAsSelections,
} from './adapters/core.js';
import { pathExists, readFileOrNull, fromProjectRoot, getProjectRoot, isOutsideRoot } from '../utils/fs.js';
import { checkSkillFreshness, exportSddSkills } from './adapters/skills.js';
// A configuration's enabled targets are the project_config type's own behaviour.
import { activeTargetTypes } from '../models/project.js';
import { computeGateStateId, validateProject } from './validate.js';
// The approver's own projection, taken from the models rather than from
// sdd_core's lock store: rendering a name is the value object's behaviour, and
// a command has no business reaching a Store to get it.
import { describeApprover } from '../models/lock.js';
import {
  claudeMcpConfigPath, planMcpInstall, runMcpInstall, findLegacyPlugin, retireLegacyPlugin,
  type McpConfigWrite, type McpInstallOptions,
} from './mcp.js';
// The chaining migration is a family migration of sdd_migrations since stage 6,
// reached through the migration portal: planned, applied through the family
// transaction (rehearsed, staged, swapped all-or-nothing), and recovered after
// a crash. Bound as a namespace so each call site names the contract method it
// reaches (migrations.plan / .apply / .recover). Its values are read as types
// only — the plan is data this command prints.
import * as migrations from './adapters/migrations.js';
import type { ChainingMigrationPlan, PlannedExport, ProjectMigration } from '../migrations/chaining-migration.js';
import type { PlannedRewrite } from '../migrations/position-migration.js';
import type { FamilyMigrationReport, MigrationPlan, RecoveredTransaction } from '../migrations/types.js';
// The stage-4 upgrade report: what the owner's gate changed in each verdict.
import * as verdictChanges from './verdict-changes.js';
import type { UpgradeReport } from './verdict-changes.js';

/** The bound project's enabled targets; none for a project without a configuration. */
function enabledTargets(): string[] {
  const config = loadProjectConfig();
  return config ? activeTargetTypes(config) : [];
}

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

/** doctor_options — the flags of `wairon doctor`. */
export interface DoctorOptions {
  /** Apply the repairs before the report: the fixed steps, then the chaining migration once confirmed. */
  fix?: boolean;
  /** Print one section's report and nothing else, writing nothing: `chaining` or `composed-validation`. */
  report?: string;
  /** Answer the chaining migration's confirmation for a non-interactive run (not a write outside the project root). */
  yes?: boolean;
  /** Consent to the --fix writes outside the project root; with --yes it answers their confirmation. */
  global?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const tally: Tally = { warn: 0, error: 0 };

  // Steps 1-5: --report prints one section's plan and nothing else.
  if (options.report !== undefined) {
    reportOnly(options);
    return;
  }

  logger.blank();
  console.log(`${chalk.bold('wairon doctor')} ${chalk.gray(`— installed v${WAIRON_VERSION}`)}`);
  logger.blank();

  // --fix runs before the report so the output reflects the repaired state.
  if (options.fix) {
    await applyFixes(options, tally);
  }

  // ── Project ───────────────────────────────────────────────────────────────
  console.log(chalk.bold('Project'));
  if (!projectConfigExists()) {
    line(tally, 'error', 'Not a wairon project (no .wai/project.yaml). Run `wairon init`.');
    printSummary(tally);
    process.exit(1);
  }
  line(tally, 'ok', 'Initialized (.wai/ present)');

  let targets: string[] = [];
  let configOk = false;
  try {
    // A configuration gone since the check above reads null; report it as the loader's error did.
    if (!loadProjectConfig()) throw new ProjectNotInitializedError();
    configOk = true;
    line(tally, 'ok', '.wai/project.yaml is valid');
  } catch (e) {
    line(tally, 'error', `.wai/project.yaml is invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (configOk) {
    try { targets = enabledTargets(); } catch { /* leave empty */ }
  }

  // Transactions: each unfinished family migration under this root, as an
  // error pointing at --fix; silent when there is none.
  reportPendingTransactions(tally);

  const hasSystemSpec = pathExists(AI_PATHS.specsSystem());
  if (hasSystemSpec) {
    line(tally, 'ok', 'System spec present (.wai/specs/.index.yaml)');
  } else {
    line(tally, 'warn', 'No system spec yet — design one via the sdd-architect skill / sdd_initialize_system');
  }

  const legacySpecs = findLegacySpecFiles();
  if (legacySpecs.length > 0) {
    line(tally, 'warn', `${legacySpecs.length} legacy spec filename(s) detected (e.g. subsystem.yaml, component.yaml) — wairon now uses .index.yaml, .interface.yaml, and .implementation.yaml. Run \`wairon doctor --fix\` to migrate automatically.`);
  } else {
    line(tally, 'ok', 'Spec filenames are up to date (.index.yaml)');
  }

  // Chained subprojects that have specs but no project.yaml are un-runnable
  // standalone (`wairon` reports "No wairon project found"). Detect + point at --fix.
  try {
    const missing = findChainingSubprojectsMissingConfig(getProjectRoot());
    if (missing.length > 0) {
      line(tally, 'warn', `${missing.length} chained subproject(s) have specs but no project.yaml (un-runnable standalone): ${missing.map(d => path.relative(getProjectRoot(), d) || '.').join(', ')}. Run \`wairon doctor --fix\` to initialize them.`);
    }
  } catch { /* non-fatal detection */ }
  logger.blank();

  // ── Spec tree conformance ───────────────────────────────────────────────────
  if (hasSystemSpec && configOk) {
    console.log(chalk.bold('Spec tree'));
    try {
      const cfg = loadProjectConfig();
      if (!cfg) throw new ProjectNotInitializedError();
      const result = validateProject({ rules: cfg.rules, projectType: cfg.projectType });
      const errs = result.issues.filter((i) => i.severity === 'error').length;
      const warns = result.issues.filter((i) => i.severity === 'warning').length;
      // Notices are counted and named, but alone they leave the check passing.
      const notes = result.issues.filter((i) => i.severity === 'notice').length;
      const noted = notes > 0 ? `, ${notes} notice(s)` : '';
      if (errs > 0) line(tally, 'error', `Conformance: ${errs} error(s), ${warns} warning(s)${noted} — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else if (warns > 0) line(tally, 'warn', `Conformance: ${warns} warning(s)${noted} — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else if (notes > 0) line(tally, 'ok', `Conformance: 0 errors, 0 warnings, ${notes} notice(s) — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else line(tally, 'ok', 'Conformance: 0 errors, 0 warnings');
    } catch (e) {
      line(tally, 'warn', `Could not run conformance check: ${e instanceof Error ? e.message : String(e)}`);
    }
    logger.blank();

    // ── Stereotypes ────────────────────────────────────────────────────────
    // The Specialist retirement plan, dry-run: each remaining Specialist with
    // the dependencyClass it would take as an Orchestrator, and each project
    // variant that would rebase. Silent once none remain.
    try {
      const plan = retireSpecialists(false);
      if (plan.retyped.length > 0) {
        console.log(chalk.bold('Stereotypes'));
        for (const retype of plan.retyped) {
          const cls = retype.dependencyClass ?? 'workflow';
          line(tally, 'warn', `${retype.component}: Specialist → Orchestrator (${cls}) — ${retype.reason}`);
        }
        if (plan.rebasedVariants.length > 0) {
          line(tally, 'warn', `${plan.rebasedVariants.length} project variant(s) to rebase from Specialist to Orchestrator: ${plan.rebasedVariants.join(', ')}`);
        }
        line(tally, 'warn', 'Run `wairon doctor --fix` to retire the Specialist stereotype.');
        logger.blank();
      }
    } catch (e) {
      line(tally, 'warn', `Could not plan Specialist retirement: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Narrative steps ────────────────────────────────────────────────────
    // Fields a step's own type cannot have, dry-run: each one named with the
    // step it sits on. They configure nothing — what a retype left behind
    // before the writer rebuilt retyped steps. Silent once none remain.
    try {
      const foreign = repairForeignStepFields(false);
      if (foreign.length > 0) {
        console.log(chalk.bold('Narrative steps'));
        for (const repair of foreign) {
          line(
            tally,
            'warn',
            `${repair.implementation}.${repair.method} step ${repair.stepNumber} (${repair.stepType}) carries `
            + `${repair.fields.join(', ')} — a ${repair.stepType} step cannot.`,
          );
        }
        line(tally, 'warn', 'Run `wairon doctor --fix` to drop them (or give each step the type that carries them).');
        logger.blank();
      }
    } catch (e) {
      line(tally, 'warn', `Could not plan the narrative-step repair: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Chaining ───────────────────────────────────────────────────────────
    // What the chaining migration still has to write, counted. Silent when
    // nothing is planned or reported; after an applied --fix this plan is
    // empty, which is the run's own idempotence check.
    try {
      // Planned without a rehearsal: this line prints counts and never applies.
      const planned = migrations.plan({ verb: 'chaining', rehearse: false });
      const pending = planned.chaining;
      if (pending && (pendingCount(pending) > 0 || pending.findings.length > 0)) {
        console.log(chalk.bold('Chaining'));
        line(tally, 'warn', `Chaining: ${pendingCount(pending)} pending (${chainingTotals(pending)}) — see \`wairon doctor --report chaining\`, apply with \`wairon doctor --fix\``);
        logger.blank();
      }
    } catch (e) {
      line(tally, 'warn', `Could not plan the chaining migration: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Generated context files ─────────────────────────────────────────────────
  console.log(chalk.bold(`Generated files ${chalk.gray('(stale = older than installed)')}`));
  for (const p of derivedDocPaths()) {
    const label = path.relative(getProjectRoot(), p).replace(/\\/g, '/');
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

  // ── Lock ────────────────────────────────────────────────────────────────────
  // A voided lock used to be discoverable only by attempting the next gated
  // action, which fails closed but tells you late. Silent for a project that was never locked.
  if (projectConfigExists()) {
    try {
      const lock = readLockState(computeGateStateId());
      if (lock.state === 'locked') {
        console.log(chalk.bold('Lock'));
        line(tally, 'ok', `frozen at ${lock.record!.lockedAt} by ${describeApprover(lock.record!.lockedBy)}`);
        if (!lock.record!.specs) {
          line(tally, 'warn', 'this lock predates per-spec approval — re-lock so `wairon status` can name what drifts');
        }
        logger.blank();
      } else if (lock.state === 'stale' && lock.record!.stateId.algorithm !== lock.current.algorithm) {
        console.log(chalk.bold('Lock'));
        line(tally, 'warn',
          `stale — the lock of ${lock.record!.lockedAt} was taken under an earlier gate identity: the gate identity gained `
          + 'inputs in stage 5 (members\' composition subjects, `composition`; code conformance moved beside the claim). '
          + 'Re-lock once (`wairon lock`).');
      } else if (lock.state === 'stale') {
        console.log(chalk.bold('Lock'));
        line(tally, 'warn',
          `stale — the design or something it was approved under changed since ${lock.record!.lockedAt}, so this lock no longer holds. `
          + 'Re-run `wairon lock` to freeze the current state.');
        logger.blank();
      }
    } catch { /* a health check must never break the health report */ }
  }

  // Approvals used to be kept outside every project, in ~/.wairon/baselines/.
  // They live in the committed lock record now, so anything still there is dead
  // weight from an older install — reported, never deleted: it is the user's
  // data and removing it is their call, not a health check's.
  try {
    const legacy = path.join(os.homedir(), '.wairon', 'baselines');
    const leftovers = fs.existsSync(legacy) ? fs.readdirSync(legacy).filter((f) => f.endsWith('.json')) : [];
    if (leftovers.length) {
      console.log(chalk.bold('Approvals'));
      line(tally, 'warn',
        `${leftovers.length} leftover approval baseline(s) in ${legacy} — approvals moved into `
        + '.wai/lock.json, so these are no longer read. Safe to delete.');
      logger.blank();
    }
  } catch { /* a health check must never break the health report */ }

  // ── Extension packs ─────────────────────────────────────────────────────────
  // The migration surface: which packs govern this project, and which govern it
  // only because nobody said otherwise.
  if (projectConfigExists()) {
    const packs = diagnoseProjectPacks();
    if (packs.unresolved.length || packs.notApplied.length || packs.globalsApplied.length) {
      console.log(chalk.bold('Extension packs'));

      // Declared but absent — the gate already fails on these; repeat them here
      // because doctor is where a user looks when something is off.
      for (const bad of packs.unresolved) {
        line(tally, 'error', `${bad.label}: declared but unresolvable — ${bad.message}`);
      }

      // Installed and NOT applied. When the project never declared a position on
      // machine-wide packs, these are exactly the packs that used to apply
      // automatically — the migration set.
      if (packs.notApplied.length > 0) {
        const names = packs.notApplied.map((p) => `${p.name}@${p.version}`).join(', ');
        if (packs.globalsUndeclared) {
          line(tally, 'warn',
            `${packs.notApplied.length} installed pack(s) are NOT applied to this project: ${names}. `
            + 'Machine-wide packs no longer apply unless a project selects them, so if this project relied on them its gate is now weaker. '
            + 'Run `wairon doctor --fix` to record them as explicit selections, or `wairon pack use <name>` for the ones you want.');
        } else {
          line(tally, 'ok', `${packs.notApplied.length} installed pack(s) are available but deliberately not applied: ${names}.`);
        }
      }

      // Opted into machine-wide packs: legal, but the doctrine does not travel.
      if (packs.globalsApplied.length > 0) {
        line(tally, 'warn',
          `${packs.globalsApplied.length} pack(s) apply from the machine-wide store via extensions.useGlobalPacks: true — `
          + `${packs.globalsApplied.map((p) => `${p.name}@${p.version}`).join(', ')}. `
          + 'That doctrine does not travel with the repository, so a clone or CI enforces different rules. '
          + 'Prefer selecting each pack by name (`wairon pack use <name>`).');
      }
      logger.blank();
    }
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
  //    the wairon MCP server). Flag it for retirement if a stale copy is present.
  const pluginDir = findLegacyPlugin();
  if (pluginDir) {
    line(tally, 'warn', `Legacy Antigravity plugin present (${pluginDir}) — it collides with the wairon MCP server. Move it aside with \`wairon doctor --fix --global\` (it is outside the project, so --fix asks first).`);
  }
  logger.blank();

  printSummary(tally);
  if (tally.error > 0) process.exit(1);
}

/**
 * Apply the fixes: regenerate context files, skills, and local guides (so their
 * version stamps match the installed wairon), the spec repairs, the chaining
 * migration once confirmed, and the MCP registration. Every write outside the
 * project root — a machine-wide MCP config, the legacy global plugin — is
 * listed in its own plan and made only with its own confirmation.
 */
async function applyFixes(options: DoctorOptions, tally: Tally): Promise<void> {
  // The heading first, so every line below — the recovery's included — reads as a fix applied.
  console.log(chalk.bold('Applying fixes…'));
  // First: a family migration a crash left unfinished is resolved before any
  // other repair reads a file that transaction may have half-swapped.
  recoverTransactions(tally);
  if (!projectConfigExists()) return; // the report below will flag this

  let targets: string[];
  try {
    if (!loadProjectConfig()) throw new ProjectNotInitializedError();
    targets = enabledTargets();
  } catch (e) {
    logger.warn(`--fix skipped: .wai/project.yaml is invalid (${e instanceof Error ? e.message : String(e)}). Fix it first.`);
    logger.blank();
    return;
  }

  try {
    syncContextFiles();
    exportSddSkills(targets);
    const guides = reinjectLocalGuides(process.cwd(), targets);
    console.log(`  ${icon('ok')} Regenerated context files, skills, and ${guides.length} local guide(s).`);
  } catch (e) {
    console.log(`  ${icon('error')} Regeneration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Migrate a project that never declared a position on machine-wide packs:
  // record the installed packs it is no longer applying as explicit selections.
  // Doctrine that governs a project must be declared BY that project, or a clone
  // and CI enforce a different rule set and the difference is invisible.
  try {
    const pinned = pinInstalledPacksAsSelections();
    if (pinned.length > 0) {
      console.log(`  ${icon('ok')} Recorded ${pinned.length} installed pack(s) as explicit selections: ${pinned.join(', ')}.`);
    }
  } catch (e) {
    console.log(`  ${icon('error')} Could not record pack selections: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Migrate legacy spec filenames
  try {
    const legacySpecs = findLegacySpecFiles();
    if (legacySpecs.length > 0) {
      for (const { path: oldPath, expected: newPath } of legacySpecs) {
        fs.renameSync(oldPath, newPath);
      }
      console.log(`  ${icon('ok')} Migrated ${legacySpecs.length} legacy spec file(s) to the new dot-prefixed unified schema.`);
    }
  } catch (e) {
    console.log(`  ${icon('error')} Spec migration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Backfill project.yaml on any chained subproject that has specs but no config
  // (the "un-runnable standalone" state). Non-destructive — existing specs are
  // never touched.
  try {
    const repaired = backfillChainedSubprojectConfigs(getProjectRoot());
    if (repaired.length > 0) {
      console.log(`  ${icon('ok')} Initialized ${repaired.length} chained subproject(s) that were missing project.yaml (now runnable standalone).`);
    }
  } catch (e) {
    console.log(`  ${icon('error')} Chained-subproject backfill failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Retire the Specialist stereotype: each becomes an Orchestrator with the
  // dependencyClass its dependencies decide, and each Specialist-based project
  // variant rebases onto Orchestrator. Runs after the filename migration
  // above, so the retyped specs are saved under their current names.
  try {
    const retirement = retireSpecialists(true);
    if (retirement.retyped.length > 0) {
      console.log(`  ${icon('ok')} Retired ${retirement.retyped.length} Specialist(s) to Orchestrator.`);
    }
    if (retirement.rebasedVariants.length > 0) {
      console.log(`  ${icon('ok')} Rebased ${retirement.rebasedVariants.length} variant(s) from Specialist to Orchestrator: ${retirement.rebasedVariants.join(', ')}.`);
    }
  } catch (e) {
    console.log(`  ${icon('error')} Specialist retirement failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Drop every narrative-step field its own step type cannot have — the
  // leftovers of retypes made before the writer rebuilt a retyped step. A
  // mechanical repair like the filename migration: the field configures
  // nothing, and no step's `type` is ever guessed at from it.
  try {
    const repairs = repairForeignStepFields(true);
    if (repairs.length > 0) {
      console.log(`  ${icon('ok')} Dropped foreign fields from ${repairs.length} narrative step(s):`);
      for (const repair of repairs) {
        console.log(`      ${repair.implementation}.${repair.method} step ${repair.stepNumber} (${repair.stepType}): ${repair.fields.join(', ')}`);
      }
    }
  } catch (e) {
    console.log(`  ${icon('error')} Narrative-step repair failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // The chaining migration — the last spec-touching fix: after the
  // configuration backfill, so every chained child has a project.yaml to
  // declare its id in, and after the filename migration and the spec repairs,
  // so its gated L0 writes save specs under current names into a repaired tree.
  await migrateChaining(options, tally);

  await repairMcpRegistration(options, targets);

  logger.blank();
}


// ── writes outside the project root ─────────────────────────────────────────

/** One MCP install doctor makes, with what it would write. */
interface PlannedInstall {
  install: McpInstallOptions;
  writes: McpConfigWrite[];
}

/**
 * Steps 26-33 of --fix: register or repair the MCP server. Claude uses the
 * project's .mcp.json; Antigravity (agy) only reads its GLOBAL mcp_config.json,
 * so for it the registration is a write outside the project. Every install is
 * planned first: one that stays inside the project root runs at once, as it
 * always has; one that would replace a machine-wide file — and the legacy
 * global plugin's retirement — is printed as its own plan and made only once
 * confirmed (--yes counts only together with --global).
 */
async function repairMcpRegistration(options: DoctorOptions, targets: string[]): Promise<void> {
  const installs: McpInstallOptions[] = [];
  if (targets.includes('claude')) installs.push({ backend: 'claude', global: false });
  const gemini = targets.includes('gemini') || targets.includes('agy');
  // Global for Antigravity (the file it reads); also fine for the Gemini CLI.
  if (gemini) installs.push({ backend: 'gemini', global: targets.includes('agy') });

  const outside: PlannedInstall[] = [];
  for (const install of installs) {
    let writes: McpConfigWrite[];
    try {
      writes = planMcpInstall(install);
    } catch (e) {
      console.log(`  ${icon('warn')} MCP install for ${install.backend} could not be planned: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    if (writes.some((w) => w.outsideProject && !w.upToDate)) outside.push({ install, writes });
    else await installMcp(install);
  }

  // Cleanup/migration (belongs in --fix, not install): the legacy plugin whose
  // name collides with the wairon MCP server.
  const plugin = gemini ? findLegacyPlugin() : null;
  if (outside.length === 0 && !plugin) return;

  printOutsideWrites(outside, plugin);
  if (!(await confirmOutsideWrites(options))) return;
  for (const planned of outside) await installMcp(planned.install);
  if (plugin) retireLegacyPlugin();
}

/** One install, its failure reported as a warning rather than ending --fix. */
async function installMcp(install: McpInstallOptions): Promise<void> {
  try {
    await runMcpInstall(install);
  } catch (e) {
    console.log(`  ${icon('warn')} MCP install for ${install.backend} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Step 30: every write outside the project root, as its own plan — file, old value, new value. */
function printOutsideWrites(outside: PlannedInstall[], plugin: string | null): void {
  console.log(`  ${icon('warn')} ${chalk.bold('Writes outside this project')} — machine-wide state every project on this machine shares:`);
  for (const { writes } of outside) {
    for (const w of writes.filter((x) => x.outsideProject && !x.upToDate)) {
      console.log(`      ${w.path} (${w.backend} MCP registration)`);
      console.log(`        mcpServers.wairon now: ${describeMcpEntry(w.before)}`);
      console.log(`        mcpServers.wairon new: ${describeMcpEntry(w.after)}`);
      console.log('        the file is backed up beside itself before it is replaced');
    }
  }
  if (plugin) console.log(`      ${plugin} (legacy Antigravity plugin) — moved aside, not deleted`);
}

/** An MCP entry as the plan prints it: its JSON, any bearer credential redacted, summarised when large. */
function describeMcpEntry(entry: unknown): string {
  if (entry === undefined || entry === null) return '(none)';
  const text = JSON.stringify(entry, (key, value) =>
    (key === 'Authorization' && typeof value === 'string' ? value.replace(/^(\S+\s+).+$/, '$1***') : value));
  const LIMIT = 200;
  return text.length <= LIMIT ? text : `${text.slice(0, LIMIT)}… (${text.length} characters)`;
}

/**
 * Step 30's question: the writes outside the project root take their OWN
 * consent. --yes answers it only together with --global; a terminal asks; a run
 * with neither skips every one of them and says so.
 */
async function confirmOutsideWrites(options: DoctorOptions): Promise<boolean> {
  if (options.yes && options.global) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const why = options.global
      ? 'no terminal to confirm them'
      : (options.yes ? '--yes does not cover a write outside the project without --global' : 'no terminal to confirm them and no --global');
    console.log(`  ${icon('warn')} Skipped the writes outside this project: ${why}. Nothing outside the project was written — re-run with \`wairon doctor --fix --yes --global\` to apply them.`);
    return false;
  }
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    { type: 'confirm', name: 'confirmed', message: 'Apply the writes outside this project listed above?', default: false },
  ]);
  if (!confirmed) console.log(`  ${icon('warn')} Skipped the writes outside this project. Nothing outside the project was written.`);
  return confirmed;
}

// ── the chaining migration ──────────────────────────────────────────────────

/** Steps 1-8: `--report <section>` alone prints that section and writes nothing. */
function reportOnly(options: DoctorOptions): void {
  // Steps 2-3: only a lone `--report` of a known section.
  if (options.fix) {
    throw new DoctorOptionsError('--report prints a plan and writes nothing, so it never combines with --fix.');
  }
  if (options.report !== 'chaining' && options.report !== 'composed-validation') {
    throw new DoctorOptionsError(`--report knows two sections, \`chaining\` and \`composed-validation\`; "${options.report}" is not one.`);
  }
  // Step 4: which section?
  if (options.report === 'composed-validation') {
    // Steps 5-6: what stage 4 changed in each project's verdict.
    const report = verdictChanges.explain();
    logger.blank();
    console.log(`${chalk.bold('wairon doctor --report composed-validation')} ${chalk.gray(`— installed v${WAIRON_VERSION}`)}`);
    logger.blank();
    printUpgradeReport(report);
    console.log(chalk.gray('Nothing was written.'));
    logger.blank();
    return;
  }
  // Steps 7-8: the chaining plan, without a rehearsal — the report writes nothing, so there is nothing to discard.
  const planned = migrations.plan({ verb: 'chaining', rehearse: false });
  logger.blank();
  console.log(`${chalk.bold('wairon doctor --report chaining')} ${chalk.gray(`— installed v${WAIRON_VERSION}`)}`);
  logger.blank();
  if (planned.chaining) printChainingPlan(planned.chaining);
  else printRefusals(planned);
  console.log(chalk.gray('Nothing was written.'));
  logger.blank();
}

/** How a project key reads in the report. */
function reportLabel(key: string): string {
  return key === '' ? '(this project)' : key;
}

/**
 * Step 6: the upgrade report per project — the lock's totals beside today's
 * (attributed to the upgrade only when the lock predates stage 4) — then the
 * entries grouped by code with their reasons and rewrites, then how many
 * findings it could not attribute. The lock records totals only, and the
 * report says so: this is not a per-code diff.
 */
function printUpgradeReport(report: UpgradeReport): void {
  console.log(chalk.bold('Composed validation: what stage 4 changed'));
  console.log(chalk.gray('  A lock records totals only (errors, warnings, notices) and the validator version that took it — nothing per code — so this is not a per-code diff. Today\'s findings are classed by a reason computed now.'));
  for (const p of report.projects) {
    const locked = p.lockedTotals ? `locked by v${p.lockedBy}: ${p.lockedTotals}` : 'never locked';
    const attribution = p.lockedTotals
      ? (p.predatesStage4 ? ' — the lock predates stage 4, so a difference is the upgrade\'s' : ' — the lock was taken by a stage-4 validator, so a difference is not the upgrade\'s')
      : '';
    console.log(`  ${reportLabel(p.key)}: ${locked}; today (as-complete): ${p.currentTotals}${attribution}`);
  }
  const byCode = new Map<string, UpgradeReport['entries']>();
  for (const e of report.entries) byCode.set(e.code, [...(byCode.get(e.code) ?? []), e]);
  for (const [code, entries] of [...byCode].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${chalk.bold(code)} (${entries.length})`);
    for (const e of entries) {
      const where = `${reportLabel(e.project)}${e.specId ? ` ${e.specId}` : ''}`;
      const reason = e.reason === 'escalated'
        ? 'escalated: a stage-2 notice that is an error since stage 4'
        : e.reason === 'pinned'
          ? 'pinned: judged against the project\'s own pin, no longer through the parent\'s live tree'
          : `positional: the family's top matches it${e.resolvedAs ? ` to ${e.resolvedAs}` : ''} by position, which is how it passed before${e.rewrite ? ` — the migration writes ${e.rewrite}` : ''}`;
      console.log(`    ${e.severity} ${where}: ${reason}`);
    }
  }
  if (report.entries.length === 0) console.log('  No finding is new for a reason stage 4 introduced.');
  console.log(`  ${report.unclassified} finding(s) could not be attributed to stage 4.`);
  if (report.unmatched.length > 0) {
    console.log(`  ${chalk.bold('Positional matches no rule decides')} (${report.unmatched.length}) — counted above; a person picks:`);
    for (const m of report.unmatched) {
      const what = m.kind === 'ambiguous' ? `matches ${(m.candidates ?? []).join(' and ')} (${m.reason})` : `matches nothing in the family${m.reason ? ` (${m.reason})` : ''}`;
      console.log(`    ${reportLabel(m.consumer)} ${m.specId}: "${m.authored}" ${what}`);
    }
  }
}

/**
 * Steps 17-21 of --fix: plan the chaining migration, print it, and apply it
 * only once confirmed. --yes answers yes; a run with no terminal to ask and no
 * --yes, or a no, writes none of it.
 */
async function migrateChaining(options: DoctorOptions, tally: Tally): Promise<void> {
  let planned: MigrationPlan;
  try {
    // Without a rehearsal: what is printed and confirmed is the chaining plan; apply rehearses it.
    planned = migrations.plan({ verb: 'chaining', rehearse: false });
  } catch (e) {
    console.log(`  ${icon('error')} Could not plan the chaining migration: ${e instanceof Error ? e.message : String(e)}`);
    tally.error++;
    return;
  }
  if (!planned.chaining) {
    printRefusals(planned);
    tally.error++;
    return;
  }
  if (pendingCount(planned.chaining) === 0) return;
  printChainingPlan(planned.chaining);
  if (!(await confirmChaining(options))) return;
  // Rehearsed, staged and swapped all-or-nothing.
  const report = migrations.apply(planned);
  if (report.applied) {
    printApplied(report);
    return;
  }
  printNotApplied(report);
  tally.error++;
}

/** A refused, failed or restored apply: what stopped it and whether the family is as it was. */
function printNotApplied(report: FamilyMigrationReport): void {
  if (report.outcome === undefined) {
    console.log(`  ${icon('error')} The chaining migration was not applied; nothing was written:`);
    for (const r of report.plan.refusals) console.log(`      ${r.code}${r.project ? ` (${r.project})` : ''}: ${r.detail}`);
    return;
  }
  const outcome = report.outcome;
  if (outcome.restored) {
    console.log(`  ${icon('error')} The chaining migration failed and was rolled back; the family is byte-identical to before: ${outcome.failure ?? 'unknown failure'}`);
    return;
  }
  console.log(`  ${icon('error')} The chaining migration failed and ${outcome.unrestored.length} file(s) could not be restored — run \`wairon doctor --fix\` to finish the rollback: ${outcome.failure ?? 'unknown failure'}`);
  for (const file of outcome.unrestored) console.log(`      ${file}`);
}

/** A plan refused before it was made (an unfinished transaction): each refusal, naming what unblocks it. */
function printRefusals(planned: MigrationPlan): void {
  for (const r of planned.refusals) console.log(`  ${icon('error')} ${r.code}: ${r.detail}`);
}

/** doctor --fix, first: roll back (or clean up) every family migration a crash left unfinished under this root. */
function recoverTransactions(tally: Tally): void {
  let recovered: RecoveredTransaction[];
  try {
    recovered = migrations.recover(getProjectRoot(), true);
  } catch (e) {
    console.log(`  ${icon('error')} Could not recover unfinished family migrations: ${e instanceof Error ? e.message : String(e)}`);
    tally.error++;
    return;
  }
  for (const t of recovered) {
    const what = `the ${t.verb} migration ${t.id} (coordinator phase ${t.phase})`;
    if (t.action === 'rolled-back') console.log(`  ${icon('ok')} Rolled back ${what}: ${t.detail}.`);
    else if (t.action === 'cleaned') console.log(`  ${icon('ok')} Cleaned up ${what}: ${t.detail}.`);
    else {
      console.log(`  ${icon('error')} Could not resolve ${what}: ${t.detail}.`);
      tally.error++;
    }
  }
}

/** Plain doctor: each unfinished family migration under this root, as an error pointing at --fix. */
function reportPendingTransactions(tally: Tally): void {
  let pending: RecoveredTransaction[];
  try {
    pending = migrations.recover(getProjectRoot(), false);
  } catch (e) {
    line(tally, 'error', `Could not read the family-migration transactions: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const t of pending) {
    line(tally, 'error', `Unfinished family migration ${t.id} (${t.verb}, coordinator phase ${t.phase}; owners: ${t.owners.map((o) => path.relative(getProjectRoot(), o) || '.').join(', ')}) — run \`wairon doctor --fix\` to roll it back`);
  }
}

/** Step 19: the person's answer — --yes, a terminal prompt, or no when there is no terminal to ask. */
async function confirmChaining(options: DoctorOptions): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(`  ${icon('warn')} Chaining migration skipped: no terminal to confirm it — re-run with \`--fix --yes\` to apply it. Nothing of it was written.`);
    return false;
  }
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    { type: 'confirm', name: 'confirmed', message: 'Apply the chaining migration above?', default: false },
  ]);
  if (!confirmed) console.log(`  ${icon('warn')} Chaining migration skipped. Nothing of it was written.`);
  return confirmed;
}

function printApplied(report: FamilyMigrationReport): void {
  const written = report.outcome?.written ?? [];
  console.log(`  ${icon('ok')} Applied the chaining migration: ${written.length} file(s) written.`);
  for (const change of written) console.log(`      ${change.action} ${path.join(change.project, ...change.path.split('/'))}`);
  if (report.relock.length === 0) return;
  console.log(`  ${icon('warn')} The writes staled the approval of ${report.relock.length} project(s); nothing was locked here. Re-lock each with \`wairon lock\`:`);
  for (const dir of report.relock) console.log(`      ${dir}`);
}

/** How many writes the plan holds: ids, L0s, entries, externals, imports, pins, mounts, rewrites and family pins. */
function pendingCount(migration: ChainingMigrationPlan): number {
  return migration.rewrites.length + migration.projects.reduce((n, p) => n + (p.idToWrite ? 1 : 0) + (p.createsSystem ? 1 : 0)
    + p.exports.length + p.externals.length + p.imports.length + p.pins.length + p.members.length + p.supersededPins.length, 0);
}

/** The totals the report ends with — the P1 probe's counts. */
function chainingTotals(migration: ChainingMigrationPlan): string {
  const sum = (f: (p: ProjectMigration) => number): number => migration.projects.reduce((n, p) => n + f(p), 0);
  const entries = sum((p) => p.exports.length);
  return [
    `${sum((p) => (p.idToWrite ? 1 : 0))} id(s)`,
    `${sum((p) => (p.createsSystem ? 1 : 0))} L0(s) to create`,
    `${entries} L0 entr${entries === 1 ? 'y' : 'ies'}`,
    `${sum((p) => p.externals.length)} external(s)`,
    `${sum((p) => p.imports.length)} import(s)`,
    `${sum((p) => p.pins.length)} pin(s)`,
    `${sum((p) => p.members.length)} mount(s) to move`,
    `${migration.rewrites.length} rewrite(s)`,
    `${sum((p) => p.supersededPins.length)} family pin(s) to delete`,
    `${sum((p) => p.droppedKeys.length)} dropped key(s)`,
    `${migration.newDependencies.length} new dependenc${migration.newDependencies.length === 1 ? 'y' : 'ies'}`,
    `${migration.findings.length} finding(s)`,
  ].join(', ');
}

/** The new dependencies first, then the plan per project, then every rewrite, every finding and the totals. */
function printChainingPlan(migration: ChainingMigrationPlan): void {
  console.log(chalk.bold('Chaining migration'));
  console.log(chalk.gray(`  family root: ${migration.familyRoot}${migration.whole ? '' : ' (partial: a hop above was out of reach)'}`));
  if (migration.newDependencies.length > 0) {
    console.log(`  ${icon('warn')} ${chalk.bold(`New dependencies (${migration.newDependencies.length})`)} — edges no external or pin had before, added exactly as the specs resolve today; whether each should exist is yours to decide:`);
    for (const d of migration.newDependencies) console.log(`      ${chalk.bold(d)}`);
  }
  if (pendingCount(migration) === 0) console.log('  Nothing to migrate.');
  for (const p of migration.projects) printProjectMigration(p);
  printRewrites(migration);
  for (const f of migration.findings) {
    const where = f.project === '' ? 'top root' : f.project;
    console.log(`  ${icon(f.blocking ? 'error' : 'warn')} ${f.kind} [${where}]${f.blocking ? ' (blocks apply)' : ''}: ${f.detail}`);
  }
  console.log(`  Totals: ${chainingTotals(migration)}.`);
  logger.blank();
}

const projectLabel = (project: string): string => (project === '' ? '(top root)' : project);

function printProjectMigration(p: ProjectMigration): void {
  // A chained member's family can sit ABOVE this project: its writes are in
  // this plan and its confirmation, and marked so nobody misreads their reach.
  const above = isOutsideRoot(getProjectRoot(), p.directory) ? chalk.yellow(' (outside this project\'s root — the family above it)') : '';
  console.log(`  ${chalk.bold(projectLabel(p.project))} ${chalk.gray(p.directory)}${above}`);
  if (p.idToWrite) console.log(`    id: declare "${p.idToWrite}"`);
  if (p.createsSystem) console.log('    L0: create a minimal one — the project exports and has none');
  for (const e of p.exports) console.log(`    L0 entry: ${describeEntry(e)}`);
  if (p.droppedKeys.length > 0) {
    console.log(`    will be removed from its stored L0 by the first write (the schema does not know them): ${p.droppedKeys.join('; ')}`);
  }
  for (const x of p.externals) {
    const why = x.reason === 'legacy-pin' ? 'replaces the stage-1 family pin of' : 'its references cross into';
    console.log(`    external: ${x.alias}: {} — ${why} ${projectLabel(x.producer)}`);
  }
  for (const i of p.imports) {
    const needs = [i.exportPlanned ? 'its export planned above' : undefined, i.declaresExternal ? 'its external planned above' : undefined].filter(Boolean);
    const byPlan = i.reason === 'declared-producer' && p.externals.some((x) => x.alias === i.alias) ? ' (declared by this plan)' : '';
    console.log(`    use: ${i.alias}: [${i.name}] — ${i.target}, ${i.reason}${byPlan}; resolves ${i.references.length} reference(s)${needs.length > 0 ? `, with ${needs.join(' and ')}` : ''}`);
  }
  if (p.pins.length > 0) console.log(`    pin (last): ${p.pins.join(', ')}`);
  for (const m of p.members) {
    const described = m.description !== undefined ? ', its description carried' : '';
    const carried = m.carried.length > 0 ? `; carries ${m.carried.length} L0 entr${m.carried.length === 1 ? 'y' : 'ies'} into ${projectLabel(m.member)}` : '';
    console.log(`    member: ${m.alias}: ${m.path} — moved from its legacy L1 mount${described}${carried}`);
    if (m.retired.length > 0) console.log(`      retires with the mount: ${m.retired.join('; ')}`);
  }
  if (p.supersededPins.length > 0) {
    console.log(`    superseded family pins: ${p.supersededPins.length} — deleted once the externals that replace them are pinned; nothing reads them since stage 3`);
  }
}

/** One planned L0 entry, its item, where it came from and whom it serves. */
function describeEntry(e: PlannedExport): string {
  const item = [
    e.from !== undefined ? `from: ${e.from}` : undefined,
    e.component !== undefined ? `component: ${e.component}` : `typeDef: ${e.typeDef}`,
    e.interface !== undefined ? `interface: ${e.interface}` : undefined,
    e.type !== undefined ? `type: ${e.type}` : undefined,
    `audience: ${e.audience}`,
  ].filter((x) => x !== undefined).join(', ');
  const why = e.reason === 'mount'
    ? `carried from its legacy mount${e.publishAtL1 ? `, published at L1 in ${e.from} first (its subsystem does not publish it yet)` : ''}`
    : `${e.from === undefined ? 'its own project-level type, ' : ''}${e.reason === 'positional' ? 'positional, ' : ''}for ${e.consumers.map(projectLabel).join(', ')}${e.members.length > 0 ? `, reaching ${e.members.join(', ')}` : ''}`;
  return `{ ${item} } as "${e.publicName}" — ${why}`;
}

/** Every rewrite, grouped per project and spec, each group with its count. */
function printRewrites(migration: ChainingMigrationPlan): void {
  if (migration.rewrites.length === 0) return;
  console.log(`  ${chalk.bold('Rewrites')} (${migration.rewrites.length}) — each reference out of a deprecated form, to the text the writer emits:`);
  const byProject = new Map<string, PlannedRewrite[]>();
  for (const r of migration.rewrites) byProject.set(r.project, [...(byProject.get(r.project) ?? []), r]);
  for (const [project, rewrites] of byProject) {
    console.log(`    ${projectLabel(project)} (${rewrites.length}):`);
    const bySpec = new Map<string, PlannedRewrite[]>();
    for (const r of rewrites) bySpec.set(r.specId, [...(bySpec.get(r.specId) ?? []), r]);
    for (const [specId, own] of bySpec) {
      console.log(`      ${own[0].kind} ${specId} (${own.length}): ${own.map((r) => `${r.from} → ${r.to} [${r.position}]`).join('; ')}`);
    }
  }
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
