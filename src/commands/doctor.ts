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
  repairSignatures,
  repairTypeSpellings,
  migrateReachability,
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
  // The family a --fix cascades into, and the plain report summarises per member.
  projectFamily,
} from './adapters/core.js';
import { pathExists, readFileOrNull, fromProjectRoot, getProjectRoot, isOutsideRoot, runWithProjectRoot } from '../utils/fs.js';
import { checkSkillFreshness, exportSddSkills } from './adapters/skills.js';
// A configuration's enabled targets are the project_config type's own behaviour.
import { activeTargetTypes } from '../models/project.js';
import { computeGateStateId, validateFamily } from './validate.js';
// The approver's own projection, taken from the models rather than from
// sdd_core's lock store: rendering a name is the value object's behaviour, and
// a command has no business reaching a Store to get it.
import { describeApprover } from '../models/lock.js';
// cli_lock_adapter.reexpressApproval: the write behind --fix's approval step.
import { checkApproval, reexpressLock } from './lock.js';
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
import type { ReachabilityMigrationPlan, ReachRewrite } from '../core/index.js';

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
    // A project-scoped entry names the CLI relative to the project (the host
    // starts it there); a machine-wide one by its absolute path.
    const scriptPath = entry.args[0];
    if (!fs.existsSync(path.resolve(getProjectRoot(), scriptPath))) {
      return { mark: 'error', note: `registered but the server path is missing — ${scriptPath}` };
    }
  }
  return { mark: 'ok', note: 'registered' };
}

/** doctor_options — the flags of `wairon doctor`. */
export interface DoctorOptions {
  /** Apply the repairs before the report: the fixed steps, then the chaining migration once confirmed. */
  fix?: boolean;
  /** Print one section's report and nothing else, writing nothing: `chaining`, `composed-validation` or `reachability`. */
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
      // The family gate: the bound project's own and every member's, so a clean
      // top never reads as a clean family.
      const result = validateFamily({ rules: cfg.rules, projectType: cfg.projectType });
      const counts = severityCounts(result.issues);
      const { errs, warns, notes } = counts;
      // Notices are counted and named, but alone they leave the check passing.
      const noted = notes > 0 ? `, ${notes} notice(s)` : '';
      if (errs > 0) line(tally, 'error', `Conformance: ${errs} error(s), ${warns} warning(s)${noted} — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else if (warns > 0) line(tally, 'warn', `Conformance: ${warns} warning(s)${noted} — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else if (notes > 0) line(tally, 'ok', `Conformance: 0 errors, 0 warnings, ${notes} notice(s) — see \`wairon validate\` (you: \`sdd_validate_tree\`)`);
      else line(tally, 'ok', 'Conformance: 0 errors, 0 warnings');
      // One line per project of the family with findings, the bound project's own counts included.
      const byProject = new Map<string, typeof result.issues>();
      for (const issue of result.issues) {
        const key = issue.project ?? '';
        byProject.set(key, [...(byProject.get(key) ?? []), issue]);
      }
      if (byProject.size > 1 || (byProject.size === 1 && !byProject.has(''))) {
        for (const [key, issues] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
          const own = severityCounts(issues);
          if (own.errs === 0 && own.warns === 0 && own.notes === 0) continue;
          console.log(`      ${key === '' ? 'this project' : `member ${key}`}: ${own.errs} error(s), ${own.warns} warning(s), ${own.notes} notice(s)`);
        }
      }
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

    // ── Signatures ─────────────────────────────────────────────────────────
    // Stored signature texts their params contradict, and restatements equal
    // to a method's signature source, dry-run: each interface or type named.
    // Silent once every stored signature is in its stored form.
    try {
      const signatures = repairSignatures(false);
      if (signatures.length > 0) {
        console.log(chalk.bold('Signatures'));
        for (const repair of signatures) {
          line(tally, 'warn', `${repair.kind} ${repair.specId}: ${describeSignatureRepair(repair)}`);
        }
        line(tally, 'warn', 'Run `wairon doctor --fix` to write them in their stored form (any save of the spec does too).');
        logger.blank();
      }
    } catch (e) {
      line(tally, 'warn', `Could not plan the signature repair: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Type spellings ─────────────────────────────────────────────────────
    // Stored type positions that are an alias of their canonical spelling,
    // dry-run: each interface or type named; then, apart, the int proposals
    // and the positions only an author can settle. Silent once every stored
    // type position is canonical.
    try {
      const spellings = repairTypeSpellings(false);
      const rewriting = spellings.filter((repair) => repair.rewritten.length > 0);
      const proposals = spellings.flatMap((repair) => repair.proposals);
      const authorNeeded = spellings.flatMap((repair) => repair.authorNeeded);
      if (spellings.length > 0) console.log(chalk.bold('Type spellings'));
      if (rewriting.length > 0) {
        for (const repair of rewriting) {
          line(tally, 'warn', `${repair.kind} ${repair.specId}: ${repair.rewritten.length} position(s) to respell (${describeRespellings(repair.rewritten)})`);
        }
        line(tally, 'warn', 'Run `wairon doctor --fix` to write them in their canonical spelling (any save of the spec does too).');
      }
      if (proposals.length > 0) {
        console.log(`  ${chalk.gray('int proposed — never written: confirm by writing int, or write float')}`);
        for (const proposal of proposals) {
          line(tally, 'warn', `${proposal.kind} ${proposal.specId} ${proposal.path}: "${proposal.written}" → ${proposal.stored} (proposed)`);
        }
      }
      const enumProposals = spellings.flatMap((repair) => repair.enumProposals);
      if (enumProposals.length > 0) {
        console.log(`  ${chalk.gray('enum proposed — never written: define the enum, then write its id here')}`);
        for (const proposal of enumProposals) line(tally, 'warn', describeEnumProposal(proposal));
      }
      if (authorNeeded.length > 0) {
        console.log(`  ${chalk.gray('needs an author — no rewrite can settle these')}`);
        for (const problem of authorNeeded) {
          line(tally, 'warn', `${problem.kind} ${problem.specId} ${problem.path ?? ''}: "${problem.written}" — ${problem.replacement ? `write ${problem.replacement}` : problem.detail}`);
        }
      }
      if (spellings.length > 0) logger.blank();
    } catch (e) {
      line(tally, 'warn', `Could not plan the type-spelling repair: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Reachability ───────────────────────────────────────────────────────
    // The migration onto the reachability model, dry-run: the rewrites it
    // would make by retired form, and what it will only report. Silent once
    // the tree holds no retired form.
    try {
      const plan = migrateReachability(false);
      if (plan.rewrites.length > 0 || plan.reported.length > 0) {
        console.log(chalk.bold('Reachability'));
        if (plan.rewrites.length > 0) {
          line(tally, 'warn', `${plan.rewrites.length} rewrite(s) onto the reachability model: ${describeReachForms(plan.rewrites)}`);
          line(tally, 'warn', 'Run `wairon doctor --fix` to write them (`wairon doctor --report reachability` lists each one); the design changes, so one `wairon lock` follows.');
        }
        if (plan.reported.length > 0) {
          line(tally, 'warn', `${plan.reported.length} form(s) it will not fix — an author decides: ${describeReachForms(plan.reported)} (see \`wairon doctor --report reachability\`)`);
        }
        logger.blank();
      }
    } catch (e) {
      line(tally, 'warn', `Could not plan the reachability migration: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ── Members ────────────────────────────────────────────────────────────
    // The repairs above plan this project's own specs only. Each member's,
    // planned the same way bound to its root, in one line per member with
    // something pending. Silent when no member has anything.
    try {
      reportMemberRepairs(tally);
    } catch (e) {
      line(tally, 'warn', `Could not plan the members' repairs: ${e instanceof Error ? e.message : String(e)}`);
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
        line(tally, 'ok', `approved at ${lock.record!.lockedAt} by ${describeApprover(lock.record!.lockedBy)}`);
        if (!lock.record!.specs) {
          line(tally, 'warn', 'this lock predates per-spec approval — re-lock so `wairon status` can name what drifts');
        } else if (lock.record!.specsReading !== 'design') {
          line(tally, 'warn', 'this lock predates lock format 3 and still holds — `wairon doctor --fix` re-expresses it in the design reading without a review, after which adding or moving a sourcePath never drifts it');
        }
        logger.blank();
      } else if (lock.state === 'stale' && lock.record!.stateId.algorithm !== lock.current.algorithm) {
        // Taken under an earlier gate identity: lock-check's verdict says
        // whether any own spec moved, and when none did, that the gate it was
        // judged under moved — never the design.
        console.log(chalk.bold('Lock'));
        line(tally, 'warn', `stale — ${checkApproval(false).message}`);
        logger.blank();
      } else if (lock.state === 'stale') {
        console.log(chalk.bold('Lock'));
        line(tally, 'warn',
          `stale — the design or something it was approved under changed since ${lock.record!.lockedAt}, so the approval no longer covers it. `
          + 'Run `wairon lock` to approve the current design (`wairon status` names the specs that moved).');
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
    const agyHome = path.join(os.homedir(), '.gemini', 'antigravity-cli');
    if (!fs.existsSync(agyHome)) {
      // No Antigravity on this machine: nothing reads that file, so a missing
      // registration is not something to fix here.
      line(tally, 'ok', `Antigravity: not installed on this machine (no ${agyHome}) — nothing to register. `
        + 'Once it is: `wairon mcp install --backend gemini --global`');
    } else {
      const hg = mcpEntryHealth(path.join(agyHome, 'mcp_config.json'));
      line(tally, hg.mark, `Antigravity (global mcp_config.json): ${hg.note}${hg.mark === 'ok' ? '' : ' — run `wairon mcp install --backend gemini --global`'}`);
    }
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

  // The approval first: an earlier record is compared with the tree it
  // approved, so it is carried before any repair or migration below touches a
  // spec (a repaired file would no longer match the digest it was approved under).
  reexpressApproval();

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
  pinPackSelections('');

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

  // The per-project spec repairs — Specialists, foreign step fields,
  // signatures, type spellings — after the filename migration above, so the
  // specs they re-save are saved under their current names.
  repairProjectSpecs('');

  // The chaining migration — the last spec-touching fix: after the
  // configuration backfill, so every chained child has a project.yaml to
  // declare its id in, and after the filename migration and the spec repairs,
  // so its gated L0 writes save specs under current names into a repaired tree.
  await migrateChaining(options, tally);

  // The members: the repairs above wrote this project only. Cascade into each
  // member below it — after the chaining migration, so a legacy mount it moved
  // into `members` is a member here — the way the family run validates them.
  repairMembers();

  await repairMcpRegistration(options, targets);

  logger.blank();
}


/**
 * Step 23 of --fix: carry a format-2 approval into the design reading when its
 * own identity, recomputed, still matches (cli_lock_adapter.reexpressApproval).
 * Silent when there is nothing to carry; a format-2 lock that no longer
 * matches is named by the report's Lock section that follows (one `wairon
 * lock`, after which code linkage never drifts it again).
 */
function reexpressApproval(): void {
  try {
    const carried = reexpressLock();
    if (carried && carried.stateId.algorithm === carried.reexpressed?.fromAlgorithm) {
      // The reading carried, the claim kept: no spec file moved, the gate did.
      console.log(`  ${icon('ok')} Re-expressed the approval of ${carried.lockedAt} by ${describeApprover(carried.lockedBy)} in the design reading `
        + '(lock format 3): no spec file moved since it was taken, so from now on adding or moving a sourcePath never drifts it. '
        + `It still reads stale because the gate it was judged under moved (wairon ${carried.validatorVersion} took it; the design rules of this `
        + 'release, or the project\'s rule tuning, `composition`, network declaration, consumed contracts or a member\'s approval differ now), '
        + 'so one `wairon lock` re-approves the unchanged design. Commit .wai/lock.json.');
    } else if (carried) {
      console.log(`  ${icon('ok')} Re-expressed the approval of ${carried.lockedAt} by ${describeApprover(carried.lockedBy)} in the current reading `
        + '(lock format 3) — the design is provably the one approved, so no review was needed; from now on adding or moving a sourcePath, or promoting a status, never drifts it. Commit .wai/lock.json.');
    }
  } catch (e) {
    console.log(`  ${icon('error')} Approval re-expression failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── the per-project repairs, and their cascade into the members ─────────────

/** How a project reads in a --fix line: nothing for the bound project, `[alias] ` for a member. */
function whoPrefix(who: string): string {
  return who === '' ? '' : `[${who}] `;
}

/** Errors, warnings and notices of a set of findings. */
function severityCounts(issues: { severity: string }[]): { errs: number; warns: number; notes: number } {
  return {
    errs: issues.filter((i) => i.severity === 'error').length,
    warns: issues.filter((i) => i.severity === 'warning').length,
    notes: issues.filter((i) => i.severity === 'notice').length,
  };
}

/** One enum proposal in a line: where, what is written, and the enum to define. */
function describeEnumProposal(p: { kind: string; specId: string; path: string; written: string; enumId: string; values: string[]; optional: boolean }): string {
  return `${p.kind} ${p.specId} ${p.path}: "${p.written}" → enum ${p.enumId} (${p.values.join(', ')}), written as ${p.enumId}${p.optional ? '?' : ''} (proposed)`;
}

/**
 * Record the installed packs a project no longer applies as explicit
 * selections (one that never declared a position on machine-wide packs), and
 * name the remedy for each recorded selection CI could not obtain: no
 * fetchable source was recorded (a pack installed from a local path has
 * none), and it is not bundled.
 */
function pinPackSelections(who: string): void {
  try {
    const pinned = pinInstalledPacksAsSelections();
    if (pinned.length === 0) return;
    console.log(`  ${icon('ok')} ${whoPrefix(who)}Recorded ${pinned.length} installed pack(s) as explicit selections: ${pinned.join(', ')}.`);
    const pinnedNames = new Set(pinned.map((label) => label.replace(/@[^@]*$/, '')));
    const unobtainable = (loadProjectConfig()?.extensions?.packs ?? [])
      .filter((e): e is Exclude<typeof e, string> => typeof e !== 'string')
      .filter((e) => pinnedNames.has(e.name) && !e.source && !e.bundle)
      .map((e) => e.name);
    if (unobtainable.length > 0) {
      console.log(`  ${icon('warn')} ${whoPrefix(who)}${unobtainable.length} of them record no fetchable source (installed from a local path), so CI and a fresh clone cannot obtain them: ${unobtainable.join(', ')}. `
        + 'Run `wairon pack bundle --all` to commit a copy the repository carries, or `wairon pack use <name> --source <url>` to record where `wairon pack sync` fetches each.');
    }
  } catch (e) {
    console.log(`  ${icon('error')} ${whoPrefix(who)}Could not record pack selections: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The per-project spec repairs, each idempotent and each writing the bound
 * project's own specs only: retire the Specialists, drop the foreign
 * narrative-step fields, regenerate the stored signatures, rewrite the stored
 * type spellings (printing the int and enum proposals and the positions
 * needing an author, none of which is written). Each failure is printed and
 * the next repair still runs.
 */
function repairProjectSpecs(who: string): void {
  const at = whoPrefix(who);
  // Retire the Specialist stereotype: each becomes an Orchestrator with the
  // dependencyClass its dependencies decide, and each Specialist-based project
  // variant rebases onto Orchestrator.
  try {
    const retirement = retireSpecialists(true);
    if (retirement.retyped.length > 0) {
      console.log(`  ${icon('ok')} ${at}Retired ${retirement.retyped.length} Specialist(s) to Orchestrator.`);
    }
    if (retirement.rebasedVariants.length > 0) {
      console.log(`  ${icon('ok')} ${at}Rebased ${retirement.rebasedVariants.length} variant(s) from Specialist to Orchestrator: ${retirement.rebasedVariants.join(', ')}.`);
    }
  } catch (e) {
    console.log(`  ${icon('error')} ${at}Specialist retirement failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Drop every narrative-step field its own step type cannot have — the
  // leftovers of retypes made before the writer rebuilt a retyped step. The
  // field configures nothing, and no step's `type` is ever guessed at from it.
  try {
    const repairs = repairForeignStepFields(true);
    if (repairs.length > 0) {
      console.log(`  ${icon('ok')} ${at}Dropped foreign fields from ${repairs.length} narrative step(s):`);
      for (const repair of repairs) {
        console.log(`      ${repair.implementation}.${repair.method} step ${repair.stepNumber} (${repair.stepType}): ${repair.fields.join(', ')}`);
      }
    }
  } catch (e) {
    console.log(`  ${icon('error')} ${at}Narrative-step repair failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Regenerate every stored signature text its params contradict, and drop
  // every restatement equal to its method's signature source: exactly what any
  // later save of the spec would write.
  try {
    const signatures = repairSignatures(true);
    if (signatures.length > 0) {
      console.log(`  ${icon('ok')} ${at}Rewrote ${signatures.length} spec(s) into their stored signature form:`);
      for (const repair of signatures) {
        console.log(`      ${repair.kind} ${repair.specId}: ${describeSignatureRepair(repair)}`);
      }
    }
  } catch (e) {
    console.log(`  ${icon('error')} ${at}Signature repair failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Rewrite every stored type position that is an alias into its canonical
  // spelling (`Result<(), E>` → `result<void, E>` among them). The int and enum
  // proposals and the positions needing an author are printed, never written.
  try {
    const spellings = repairTypeSpellings(true);
    const rewritten = spellings.filter((repair) => repair.rewritten.length > 0);
    if (rewritten.length > 0) {
      const positions = rewritten.reduce((n, repair) => n + repair.rewritten.length, 0);
      console.log(`  ${icon('ok')} ${at}Rewrote ${positions} type position(s) in ${rewritten.length} spec(s) into their canonical spelling.`);
    }
    const proposals = spellings.flatMap((repair) => repair.proposals);
    if (proposals.length > 0) {
      console.log(`  ${icon('warn')} ${at}${proposals.length} number position(s) with int proposed — not written; confirm by writing int, or write float:`);
      for (const proposal of proposals) console.log(`      ${proposal.kind} ${proposal.specId} ${proposal.path}: "${proposal.written}" → ${proposal.stored} (proposed)`);
    }
    const enumProposals = spellings.flatMap((repair) => repair.enumProposals);
    if (enumProposals.length > 0) {
      console.log(`  ${icon('warn')} ${at}${enumProposals.length} string-literal union(s) with an enum proposed — not written; define the enum (sdd_add_type kind enum), then write its id:`);
      for (const proposal of enumProposals) console.log(`      ${describeEnumProposal(proposal)}`);
    }
    const authorNeeded = spellings.flatMap((repair) => repair.authorNeeded);
    if (authorNeeded.length > 0) {
      console.log(`  ${icon('warn')} ${at}${authorNeeded.length} type position(s) need an author — no rewrite can settle them:`);
      for (const problem of authorNeeded) {
        console.log(`      ${problem.kind} ${problem.specId} ${problem.path ?? ''}: "${problem.written}" — ${problem.replacement ? `write ${problem.replacement}` : problem.detail}`);
      }
    }
  } catch (e) {
    console.log(`  ${icon('error')} ${at}Type-spelling repair failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Migrate onto the reachability model: transports, listener mounts into
  // entries and routers, retired invokedBy kinds, export types, retired
  // allows. It never invents an entry; what it cannot decide is printed.
  try {
    const plan = migrateReachability(true);
    if (plan.applied) {
      console.log(`  ${icon('ok')} ${at}Migrated onto the reachability model: ${plan.rewrites.length} rewrite(s) (${describeReachForms(plan.rewrites)}).`);
      for (const r of plan.rewrites) console.log(`      ${r.specId}: ${r.to}`);
      console.log(`  ${icon('warn')} ${at}The design changed: review it, then run \`wairon lock\` once.`);
    }
    if (plan.reported.length > 0) {
      console.log(`  ${icon('warn')} ${at}${plan.reported.length} reachability form(s) not fixed — an author decides:`);
      for (const r of plan.reported) console.log(`      ${r.specId}: ${r.to} — ${r.reason}`);
    }
  } catch (e) {
    console.log(`  ${icon('error')} ${at}Reachability migration failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** The labels the reachability forms read as in doctor's lines. */
const REACH_FORM_LABELS: Record<string, string> = {
  'portal-type': 'portalType',
  'listener-mounts': 'listener mounts',
  'invoked-by-kind': 'invokedBy kinds',
  'export-type': 'export types',
  'in-process-endpoint': 'in-process endpoints',
  'retired-allow': 'retired allows',
};

/** A list of reachability rewrites counted by form, e.g. "12 portalType, 3 listener mounts". */
function describeReachForms(entries: ReachRewrite[]): string {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.form, (counts.get(e.form) ?? 0) + 1);
  return Object.keys(REACH_FORM_LABELS)
    .filter((form) => counts.has(form))
    .map((form) => `${counts.get(form)} ${REACH_FORM_LABELS[form]}`)
    .join(', ');
}

/** `--report reachability`: every rewrite grouped by form, then what it will not fix, then the totals. */
function printReachabilityPlan(plan: ReachabilityMigrationPlan): void {
  if (plan.rewrites.length === 0 && plan.reported.length === 0) {
    console.log(`  ${icon('ok')} Nothing to migrate: the tree holds no retired reachability form.`);
    logger.blank();
    return;
  }
  for (const form of Object.keys(REACH_FORM_LABELS)) {
    const of = plan.rewrites.filter((r) => r.form === form);
    if (of.length === 0) continue;
    console.log(chalk.bold(`${REACH_FORM_LABELS[form]} (${of.length})`));
    for (const r of of) console.log(`  ${r.specId}: ${r.to} — ${r.reason}`);
    logger.blank();
  }
  if (plan.reported.length > 0) {
    console.log(chalk.bold(`Will not fix (${plan.reported.length}) — an author decides`));
    for (const r of plan.reported) console.log(`  ${r.specId} [${REACH_FORM_LABELS[r.form] ?? r.form}]: ${r.to} — ${r.reason}`);
    logger.blank();
  }
  console.log(`Totals: ${plan.rewrites.length} rewrite(s) (${describeReachForms(plan.rewrites) || 'none'}); ${plan.reported.length} reported (${describeReachForms(plan.reported) || 'none'}).`);
  if (plan.rewrites.length > 0) console.log('`wairon doctor --fix` writes the rewrites; the design changes, so one `wairon lock` follows.');
  logger.blank();
}

/** A member project below the bound root: the alias it is declared under, its directory, and whether it lies inside the root. */
interface MemberProject {
  alias: string;
  directory: string;
  inside: boolean;
}

/** Every member project below the bound root, as the family the tree forms now lists them (nearest first). */
function memberProjects(): MemberProject[] {
  const root = getProjectRoot();
  return projectFamily().nodes
    .filter((node) => node.namespace !== '' && node.directory && pathExists(node.directory))
    .map((node) => ({ alias: node.mountAlias ?? node.namespace, directory: node.directory, inside: !isOutsideRoot(root, node.directory) }));
}

/**
 * --fix's cascade: each member inside the bound root gets the per-project
 * repairs, bound to its own root — the packs it no longer applies pinned, then
 * its spec repairs — each line marked with the member. A member outside the
 * root (a sibling checkout) is not written from here: it is named with the
 * command to run in its own directory.
 */
function repairMembers(): void {
  let members: MemberProject[];
  try {
    members = memberProjects();
  } catch (e) {
    console.log(`  ${icon('error')} Could not read the family's members: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const member of members) {
    if (!member.inside) {
      console.log(`  ${icon('warn')} [${member.alias}] lies outside this project (${member.directory}): run \`wairon doctor --fix\` there to upgrade it.`);
      continue;
    }
    runWithProjectRoot(member.directory, () => {
      if (!projectConfigExists()) return;
      pinPackSelections(member.alias);
      repairProjectSpecs(member.alias);
    });
  }
}

/** Plain doctor: one line per member with repairs pending, planned bound to its root; silent when none has any. */
function reportMemberRepairs(tally: Tally): void {
  const pending: string[] = [];
  for (const member of memberProjects()) {
    const counts = runWithProjectRoot(member.directory, () => {
      if (!projectConfigExists()) return null;
      const spellings = repairTypeSpellings(false);
      const reach = migrateReachability(false);
      return {
        reachRewrites: reach.rewrites.length,
        reachReported: reach.reported.length,
        specialists: retireSpecialists(false).retyped.length,
        stepFields: repairForeignStepFields(false).length,
        signatures: repairSignatures(false).length,
        respell: spellings.reduce((n, r) => n + r.rewritten.length, 0),
        proposals: spellings.reduce((n, r) => n + r.proposals.length + r.enumProposals.length, 0),
        authorNeeded: spellings.reduce((n, r) => n + r.authorNeeded.length, 0),
      };
    });
    if (!counts) continue;
    const parts = [
      counts.specialists ? `${counts.specialists} Specialist(s)` : '',
      counts.stepFields ? `${counts.stepFields} step(s) with foreign fields` : '',
      counts.signatures ? `${counts.signatures} spec(s) with stale signatures` : '',
      counts.respell ? `${counts.respell} type position(s) to respell` : '',
      counts.proposals ? `${counts.proposals} proposal(s)` : '',
      counts.authorNeeded ? `${counts.authorNeeded} position(s) needing an author` : '',
      counts.reachRewrites ? `${counts.reachRewrites} reachability rewrite(s)` : '',
      counts.reachReported ? `${counts.reachReported} reachability form(s) for an author` : '',
    ].filter(Boolean);
    if (parts.length === 0) continue;
    const where = member.inside
      ? '`wairon doctor --fix` here cascades into it'
      : `run \`wairon doctor --fix\` in ${member.directory}`;
    pending.push(`member ${member.alias}: ${parts.join(', ')} — ${where}`);
  }
  if (pending.length === 0) return;
  console.log(chalk.bold('Members'));
  for (const text of pending) line(tally, 'warn', text);
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
    else installMcp(install);
  }

  // Cleanup/migration (belongs in --fix, not install): the legacy plugin whose
  // name collides with the wairon MCP server.
  const plugin = gemini ? findLegacyPlugin() : null;
  if (outside.length === 0 && !plugin) return;

  printOutsideWrites(outside, plugin);
  if (!(await confirmOutsideWrites(options))) return;
  for (const planned of outside) installMcp(planned.install);
  if (plugin) retireLegacyPlugin();
}

/** One install, its failure reported as a warning rather than ending --fix. */
function installMcp(install: McpInstallOptions): void {
  try {
    runMcpInstall(install);
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
  if (options.report !== 'chaining' && options.report !== 'composed-validation' && options.report !== 'reachability') {
    throw new DoctorOptionsError(`--report knows three sections, \`chaining\`, \`composed-validation\` and \`reachability\`; "${options.report}" is not one.`);
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
  if (options.report === 'reachability') {
    // Steps 9-10: the bound project's reachability migration, planned — the
    // same plan --fix writes, rehearsed without a write.
    const plan = migrateReachability(false);
    logger.blank();
    console.log(`${chalk.bold('wairon doctor --report reachability')} ${chalk.gray(`— installed v${WAIRON_VERSION}`)}`);
    logger.blank();
    printReachabilityPlan(plan);
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
 * (attributed to the upgrade only when the lock predates composed validation) — then the
 * entries grouped by code with their reasons and rewrites, then how many
 * findings it could not attribute. The lock records totals only, and the
 * report says so: this is not a per-code diff.
 */
function printUpgradeReport(report: UpgradeReport): void {
  console.log(chalk.bold('Composed validation: what it changed since each lock'));
  console.log(chalk.gray('  A lock records totals only (errors, warnings, notices) and the validator version that took it — nothing per code — so this is not a per-code diff. Today\'s findings are classed by a reason computed now.'));
  for (const p of report.projects) {
    const locked = p.lockedTotals ? `locked by v${p.lockedBy}: ${p.lockedTotals}` : 'never locked';
    const attribution = p.lockedTotals
      ? (p.predatesStage4 ? ' — the lock predates composed validation, so a difference is the upgrade\'s' : ' — the lock was taken under composed validation, so a difference is not the upgrade\'s')
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
        ? 'escalated: once a notice, an error under composed validation'
        : e.reason === 'pinned'
          ? 'pinned: judged against the project\'s own pin, no longer through the parent\'s live tree'
          : `positional: the family's top matches it${e.resolvedAs ? ` to ${e.resolvedAs}` : ''} by position, which is how it passed before${e.rewrite ? ` — the migration writes ${e.rewrite}` : ''}`;
      console.log(`    ${e.severity} ${where}: ${reason}`);
    }
  }
  if (report.entries.length === 0) console.log('  No finding is new for a reason composed validation introduced.');
  console.log(`  ${report.unclassified} finding(s) could not be attributed to composed validation.`);
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
/** One signature repair in a line: the methods whose text is regenerated, and the restatements dropped. */
function describeSignatureRepair(repair: { regenerated: { method: string }[]; dropped: string[] }): string {
  const parts: string[] = [];
  if (repair.regenerated.length > 0) parts.push(`regenerates the text of ${repair.regenerated.map((s) => s.method).join(', ')}`);
  if (repair.dropped.length > 0) parts.push(`drops the restated signature of ${repair.dropped.join(', ')}`);
  return parts.join('; ');
}

/** A spec's planned respellings in a few words: the first ones, `written → stored`, and how many more. */
function describeRespellings(respellings: { written: string; stored: string }[]): string {
  const shown = respellings.slice(0, 3).map((r) => `${r.written} → ${r.stored}`);
  const more = respellings.length - shown.length;
  return more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; ');
}

function pendingCount(migration: ChainingMigrationPlan): number {
  return migration.rewrites.length + migration.projects.reduce((n, p) => n + (p.idToWrite ? 1 : 0) + (p.createsSystem ? 1 : 0)
    + p.exports.length + p.externals.length + p.imports.length + p.pins.length + p.members.length + p.supersededPins.length + p.locations.length, 0);
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
    // Stage 8's one doctor step, named only when there is one to take.
    ...(sum((p) => p.locations.length) > 0 ? [`${sum((p) => p.locations.length)} member location(s) to rewrite`] : []),
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
    const why = x.reason === 'legacy-pin' ? 'replaces the legacy family pin of' : 'its references cross into';
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
    console.log(`    superseded family pins: ${p.supersededPins.length} — deleted once the externals that replace them are pinned; nothing reads them any more`);
  }
  for (const alias of p.locations) {
    console.log(`    member: ${alias}: the deprecated long-form \`path\` rewritten to \`source\` — its meaning unchanged`);
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
