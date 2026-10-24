import * as fs from 'fs';
import * as os from 'os';
import { execFileSync, execSync, type ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as path from 'path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import { AI_PATHS } from '../config/paths.js';
import { LockRecordUnreadableError, ProjectNotInitializedError } from '../utils/errors.js';
import {
  loadProjectConfig,
  projectConfigExists,
  repairForeignStepFields,
  repairSignatures,
  repairTypeSpellings,
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
  staleDerivedDocs,
  // The pack diagnosis is sdd_core's too, and reaches it the same way.
  // The spec tree's write lock as its file stands — reported when present.
  inspectLock,
  diagnoseProjectPacks,
  // The family a --fix cascades into, and the plain report summarises per member.
  projectFamily,
  loadTypeSpecs,
  loadGroupSpecs,
  scanAllSpecs,
} from './adapters/core.js';
import { pathExists, readFileOrNull, fromProjectRoot, getProjectRoot, isOutsideRoot, runWithProjectRoot, renamePath, ensureDir } from '../utils/fs.js';
import { misplacedGroupFiles } from '../models/specs.js';
import { checkSkillFreshness, exportSddSkills } from './adapters/skills.js';
// A configuration's enabled targets are the project_config type's own behaviour.
import { activeTargetTypes, isPart } from '../models/project.js';
import { isNewerVersion } from '../utils/version.js';
import { computeGateStateId, validateFamily } from './validate.js';
// The approver's own projection, taken from the models rather than from
// sdd_core's lock store: rendering a name is the value object's behaviour, and
// a command has no business reaching a Store to get it.
import { approvalStamp } from '../models/lock.js';
import { checkApproval } from './lock.js';
import {
  claudeMcpConfigPath, planMcpInstall, runMcpInstall, findLegacyPlugin, retireLegacyPlugin,
  type McpConfigWrite, type McpInstallOptions,
} from './mcp.js';
// Unfinished family-migration transactions (an upgrade or a member migration a
// crash left half-done) are recovered through the migration portal. Bound as a
// namespace so each call site names the contract method it reaches.
import * as migrations from './adapters/migrations.js';
import type { RecoveredTransaction } from '../migrations/types.js';
import type { TreeLockState } from '../core/index.js';
// Where the tree stands against the running major: a tree another major wrote is `wairon upgrade`'s.
import { standing } from '../cli/adapters/upgrade.js';

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
function mcpEntryHealth(settingsPath: string, checkLaunched = true, projectScoped = true): { mark: Mark; note: string; remedy?: string } {
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
  // Which build the entry would start, against the CLI that is running now: two
  // installs on one machine is how an assistant ends up on an older build.
  const launched = checkLaunched ? launchedVersion(entry) : null;
  if (launched !== null && launched !== WAIRON_VERSION) {
    const how = entry.command === 'node' ? `by the path ${String(entry.args?.[0])}` : 'as `wairon` on the PATH';
    const older = isNewerVersion(WAIRON_VERSION, launched);
    return {
      mark: 'warn',
      note: `registered, but it launches wairon ${launched} ${how}, while this CLI is ${WAIRON_VERSION}`
        + (older ? ': the assistant\'s tools are an OLDER build than the CLI' : ': a different build than this CLI'),
      remedy: entry.command === 'wairon'
        ? 'two installs? find them with `where wairon` (Windows) or `which -a wairon`, update or remove the old one, then reconnect the assistant'
        : 'run `wairon mcp install` to point it at this CLI, then reconnect the assistant',
    };
  }
  // A committed .mcp.json that names one machine's toolchain by an absolute path
  // breaks on every other machine, and keeps launching that toolchain after an upgrade.
  if (projectScoped && entry.command === 'node' && Array.isArray(entry.args) && typeof entry.args[0] === 'string' && path.isAbsolute(entry.args[0])) {
    return {
      mark: 'warn',
      note: `registered, but it launches a toolchain by an absolute path (${entry.args[0]}): machine-specific in a committed file`,
      remedy: 'run `wairon mcp install --backend claude` to write the portable entry',
    };
  }
  // Name the build the entry starts also when it matches, so a reader can tell which install it is.
  return { mark: 'ok', note: launched !== null ? `registered (starts wairon ${launched})` : 'registered' };
}

/**
 * The wairon version a registered MCP entry would start, when it can be told
 * cheaply and safely: `wairon` on the PATH answers `--version` (the same
 * command the developer's shell would run), and a `node <script>` entry names
 * a built @wairon/cli package whose manifest holds the version. Nothing else
 * from a repository's .mcp.json is ever executed. Null when it cannot be told.
 */
function launchedVersion(entry: { command?: string; args?: unknown[] }): string | null {
  const valid = (v: string): string | null => (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(v) && v !== '0.0.0-dev' ? v : null);
  if (entry.command === 'wairon') {
    try {
      // Windows resolves `wairon` through its .cmd shim, which only a shell runs;
      // the command line is a constant, never built from the repository.
      const opts: ExecSyncOptionsWithStringEncoding = { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true };
      const out = process.platform === 'win32' ? execSync('wairon --version', opts) : execFileSync('wairon', ['--version'], opts);
      return valid(out.trim().split(/\s+/).pop() ?? '');
    } catch {
      return null;
    }
  }
  if (entry.command === 'node' && Array.isArray(entry.args) && typeof entry.args[0] === 'string') {
    let dir = path.dirname(path.resolve(getProjectRoot(), entry.args[0]));
    for (;;) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { name?: string; version?: string };
          return pkg.name === '@wairon/cli' && typeof pkg.version === 'string' ? valid(pkg.version) : null;
        } catch {
          return null;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
  return null;
}

/** doctor_options — the flags of `wairon doctor`. */
export interface DoctorOptions {
  /**
   * Apply the repairs before the report: finish unfinished transactions, rebuild the derived
   * documents, skills and guides, repair foreign step fields, signatures and type spellings,
   * register the MCP server. It never moves a tree another wairon major wrote (`wairon upgrade`).
   */
  fix?: boolean;
  /** Answer the confirmation of a write outside the project root, together with `global`. */
  yes?: boolean;
  /** Consent to the --fix writes outside the project root; with --yes it answers their confirmation. */
  global?: boolean;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<void> {
  const tally: Tally = { warn: 0, error: 0 };

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

  // Major: where the tree stands against the running wairon. A tree another
  // major wrote waits for `wairon upgrade`; a newer one for a newer release.
  reportMajor(tally);

  // Transactions: each unfinished family migration under this root, as an
  // error pointing at --fix; silent when there is none.
  reportPendingTransactions(tally);

  // Write lock: a .wai/.spec-write.lock that is present, with its holder;
  // silent when there is none.
  reportTreeLock(tally);

  const hasSystemSpec = pathExists(AI_PATHS.specsSystem());
  if (hasSystemSpec) {
    line(tally, 'ok', 'System spec present (.wai/specs/.index.yaml)');
  } else {
    line(tally, 'warn', 'No system spec yet — design one via the sdd-architect skill / sdd_initialize_system');
  }

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

    // ── Members ────────────────────────────────────────────────────────────
    // The repairs above plan this project's own specs only. Each member's,
    // planned the same way bound to its root, in one line per member with
    // something pending. Silent when no member has anything.
    try {
      reportMemberRepairs(tally);
    } catch (e) {
      line(tally, 'warn', `Could not plan the members' repairs: ${e instanceof Error ? e.message : String(e)}`);
    }

  }

  // ── Generated context files ─────────────────────────────────────────────────
  console.log(chalk.bold(`Generated files ${chalk.gray('(stale = older than installed)')}`));
  // A file stamped by this release can still be stale in CONTENT (the project
  // context it embeds, the domain map): never called current while a
  // regenerate would rewrite it.
  let contentStale: Set<string>;
  try { contentStale = new Set(staleDerivedDocs().map((f) => path.resolve(f))); } catch { contentStale = new Set(); }
  for (const p of derivedDocPaths()) {
    const label = path.relative(getProjectRoot(), p).replace(/\\/g, '/');
    if (!pathExists(p)) {
      line(tally, 'warn', `${label} — not generated yet (run \`wairon generate\`)`);
      continue;
    }
    const { mark, note } = stampVerdict(readFileOrNull(p));
    if (mark === 'ok' && contentStale.has(path.resolve(p))) {
      line(tally, 'warn', `${label} (${note}) — stale: its content differs from what \`wairon generate\` writes now (run \`wairon generate\` or \`wairon doctor --fix\`)`);
      continue;
    }
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
        line(tally, 'ok', `approved at ${approvalStamp(lock.record!)}`);
        if (!lock.record!.specs) {
          line(tally, 'warn', 'this lock predates per-spec approval — re-lock so `wairon status` can name what drifts');
        } else if (lock.record!.specsReading !== 'design') {
          line(tally, 'warn', 'this lock predates lock format 3 and still holds — `wairon upgrade` re-expresses it in the design reading without a review, after which adding or moving a sourcePath never drifts it');
        }
        logger.blank();
      } else if (lock.state === 'stale') {
        // lock-check's own verdict, word for word: an approval a change of the
        // release carried over reads approved (re-validated under this release),
        // one the release finds issues in names them, and any other stale
        // approval says what moved — the inputs by name when the record has them.
        const verdict = checkApproval(false);
        console.log(chalk.bold('Lock'));
        line(tally, verdict.approved ? 'ok' : 'warn', verdict.approved ? verdict.message : `stale — ${verdict.message}`);
        logger.blank();
      }
    } catch (e) {
      // A health check never breaks the health report — but an approval
      // record that cannot be read is the one failure it must name, never
      // swallow: every gate refuses on it.
      if (e instanceof LockRecordUnreadableError) {
        console.log(chalk.bold('Lock'));
        line(tally, 'error', e.message);
        logger.blank();
      }
    }
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
            + 'Select the ones it needs with `wairon pack use <name>` — `wairon doctor --fix` never selects the packs of the machine it runs on into a project.');
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
    line(tally, h.mark, `Claude (project .mcp.json): ${h.note}${h.mark === 'ok' ? '' : ` — ${h.remedy ?? 'run `wairon mcp install --backend claude`'}`}`);
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
      const hg = mcpEntryHealth(path.join(agyHome, 'mcp_config.json'), true, false);
      line(tally, hg.mark, `Antigravity (global mcp_config.json): ${hg.note}${hg.mark === 'ok' ? '' : ` — ${hg.remedy ?? 'run `wairon mcp install --backend gemini --global`'}`}`);
    }
    // The project .gemini/settings.json is the Gemini-CLI convention; Antigravity ignores it.
    const projPath = fromProjectRoot('.gemini', 'settings.json');
    if (fs.existsSync(projPath)) {
      const hp = mcpEntryHealth(projPath);
      line(tally, hp.mark, `Gemini CLI (project): ${hp.note}${hp.mark === 'ok' ? '' : ` — ${hp.remedy ?? 'run `wairon mcp install --backend gemini`'}`} ${chalk.gray('(Antigravity ignores this file)')}`);
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
 * version stamps match the installed wairon), the spec repairs, and the MCP
 * registration. Every write outside the
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

  // A tree another major wrote is not repaired here: the fixes below read the
  // current major's forms, and `wairon upgrade` is what moves the tree.
  try {
    const where = standing(getProjectRoot());
    if (where.state !== 'current') {
      logger.warn(`--fix skipped: this tree was written by another wairon major (${where.state}). ${where.state === 'older' ? 'Run \`wairon upgrade\` first.' : (where.advice ?? 'Install the release that wrote it.')}`);
      logger.blank();
      return;
    }
  } catch (e) {
    logger.warn(`--fix skipped: could not read where the tree stands (${e instanceof Error ? e.message : String(e)}).`);
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

  // The packs installed on this machine are never recorded into the project:
  // what happens to be in a developer's home store is not doctrine, and a
  // selection written from it drifts an approved project and asks for a pack
  // CI cannot obtain. The report names them; `wairon pack use <name>`
  // selects one the project actually wants.

  // The per-project spec repairs — foreign step fields, signatures, type
  // spellings.
  repairProjectSpecs('');

  // The type groups: a group folder or a grouped type's file outside the folder
  // its parent chain or group names is moved there (TYPE_GROUP_MISPLACED).
  repairGroupPlacement('');

  // The members: the repairs above wrote this project only. Cascade into each
  // member below it, the way the family run validates them.
  repairMembers();

  // The derived documents describe the tree as it stands NOW: the first
  // regeneration above ran before the spec repairs and the members' repairs
  // moved it, so it is written once more, last.
  try {
    syncContextFiles();
  } catch (e) {
    console.log(`  ${icon('error')} Regeneration failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  await repairMcpRegistration(options, targets);

  logger.blank();
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
 * The per-project spec repairs, each idempotent and each writing the bound
 * project's own specs only: drop the foreign
 * narrative-step fields, regenerate the stored signatures, rewrite the stored
 * type spellings (printing the int and enum proposals and the positions
 * needing an author, none of which is written). Each failure is printed and
 * the next repair still runs.
 */
function repairProjectSpecs(who: string): void {
  const at = whoPrefix(who);
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
}

/**
 * Move every type group folder and grouped type file that sits outside the
 * folder its parent chain or group names (TYPE_GROUP_MISPLACED) to that folder.
 * Shallowest groups first, so moving a parent carries its children along; a
 * group whose chain is broken, or whose destination is taken, is left for a
 * hand. Only file locations change: nothing resolves through a folder, so no
 * spec is rewritten and the approval is untouched.
 */
function repairGroupPlacement(who: string): void {
  const at = whoPrefix(who);
  try {
    const own = <T extends { id: string }>(spec: T): boolean => !spec.id.includes('::');
    const groups = loadGroupSpecs().filter(own);
    if (groups.length === 0) return;
    const paths = scanAllSpecs().paths;
    const misplaced = misplacedGroupFiles(groups, paths.group, paths.type, loadTypeSpecs().filter(own));
    if (misplaced.length === 0) return;
    // Folders already renamed: a later path under one is remapped to where it went.
    const renamed: Array<[string, string]> = [];
    const remap = (p: string): string => {
      for (const [from, to] of renamed) {
        if (p === from || p.startsWith(from + path.sep)) return to + p.slice(from.length);
      }
      return p;
    };
    const depth = (id: string): number => {
      let n = 0;
      for (let g = groups.find((x) => x.id === id); g?.parent !== undefined && n < groups.length; g = groups.find((x) => x.id === g!.parent)) n++;
      return n;
    };
    const ordered = [...misplaced].sort((a, b) => (a.kind === b.kind ? (a.kind === 'group' ? depth(a.id) - depth(b.id) : 0) : (a.kind === 'group' ? -1 : 1)));
    const moves: string[] = [];
    for (const m of ordered) {
      if (m.expectedDir === undefined) continue;
      // The folder it belongs in was computed from where its group or parent sat; if that moved first, so did this.
      const expected = remap(path.normalize(m.expectedDir));
      if (m.kind === 'group') {
        const from = path.dirname(remap(path.normalize(m.file)));
        if (from === expected || pathExists(expected)) continue;
        ensureDir(path.dirname(expected));
        renamePath(from, expected);
        renamed.push([from, expected]);
        moves.push(`group ${m.id}: ${path.relative(getProjectRoot(), from)} → ${path.relative(getProjectRoot(), expected)}`);
      } else {
        const from = remap(path.normalize(m.file));
        const to = path.join(expected, path.basename(from));
        if (path.dirname(from) === expected || pathExists(to)) continue;
        ensureDir(expected);
        renamePath(from, to);
        moves.push(`type ${m.id}: ${path.relative(getProjectRoot(), from)} → ${path.relative(getProjectRoot(), to)}`);
      }
    }
    if (moves.length > 0) {
      console.log(`  ${icon('ok')} ${at}Moved ${moves.length} type group file(s) to the folder their parent chain names:`);
      for (const move of moves) console.log(`      ${move}`);
    }
  } catch (e) {
    console.log(`  ${icon('error')} ${at}Type-group placement repair failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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
      repairProjectSpecs(member.alias);
      repairGroupPlacement(member.alias);
      repairMemberSurfaces(member.alias);
    });
  }
}

/**
 * --fix's cascade, the agent surfaces of one member (bound to its root, inside
 * the parent's): the derived context documents, the skills, the injected guide
 * and the project-scoped .mcp.json, so an assistant opened in the member's own
 * folder has the wairon tools and a current guide. The same rules as the
 * parent's: only this project's own files are written, and the machine-wide
 * registrations (a global Antigravity config) stay the parent's one plan, so a
 * member never asks a second time for a write outside the project root. A
 * part has no agent surfaces of its own: its parent's serve it.
 */
function repairMemberSurfaces(alias: string): void {
  const who = whoPrefix(alias);
  try {
    const config = loadProjectConfig();
    if (!config || isPart(config)) return;
    const targets = activeTargetTypes(config);
    syncContextFiles();
    exportSddSkills(targets);
    const guides = reinjectLocalGuides(getProjectRoot(), targets);
    console.log(`  ${icon('ok')} ${who}Regenerated context files, skills, and ${guides.length} local guide(s).`);
    if (targets.includes('claude')) {
      const install: McpInstallOptions = { backend: 'claude', global: false };
      const writes = planMcpInstall(install);
      if (writes.some((w) => w.outsideProject)) return;
      if (writes.some((w) => !w.upToDate)) {
        runMcpInstall(install);
        console.log(`  ${icon('ok')} ${who}Registered the wairon MCP server in its .mcp.json.`);
      }
    }
  } catch (e) {
    console.log(`  ${icon('warn')} ${who}Could not repair its agent surfaces: ${e instanceof Error ? e.message : String(e)} — run \`wairon doctor --fix\` in ${getProjectRoot()}.`);
  }
}

/**
 * What an assistant opened in this project's own folder lacks, bound to the
 * project's root: the project-scoped .mcp.json entry, the injected guide, the
 * derived context documents, the skills. Read-only; none for a part.
 */
function memberSurfaceProblems(): string[] {
  const config = loadProjectConfig();
  if (!config || isPart(config)) return [];
  const targets = activeTargetTypes(config);
  const problems: string[] = [];
  if (targets.includes('claude') && mcpEntryHealth(claudeMcpConfigPath(false), false).mark !== 'ok') problems.push('no working .mcp.json entry');
  const stale = new Set(staleDerivedDocs().map((f) => path.resolve(f)));
  if (derivedDocPaths().some((p) => !pathExists(p) || stampVerdict(readFileOrNull(p)).mark !== 'ok' || stale.has(path.resolve(p)))) problems.push('stale or missing context');
  const guides = targets.map((t) => localGuideFilePath(getProjectRoot(), t)).filter((g): g is string => g !== null);
  if (guides.some((g) => !pathExists(g) || stampVerdict(readFileOrNull(g)).mark !== 'ok')) problems.push('stale or missing guide');
  if (targets.some((t) => { const f = checkSkillFreshness(t); return f.dir && (f.stale.length > 0 || f.missing.length > 0); })) problems.push('stale or missing skills');
  return problems;
}

/** Plain doctor: one line per member with repairs pending, planned bound to its root; silent when none has any. */
function reportMemberRepairs(tally: Tally): void {
  const pending: string[] = [];
  for (const member of memberProjects()) {
    const counts = runWithProjectRoot(member.directory, () => {
      if (!projectConfigExists()) return null;
      const spellings = repairTypeSpellings(false);
      return {
        surfaces: memberSurfaceProblems(),
        stepFields: repairForeignStepFields(false).length,
        signatures: repairSignatures(false).length,
        respell: spellings.reduce((n, r) => n + r.rewritten.length, 0),
        proposals: spellings.reduce((n, r) => n + r.proposals.length + r.enumProposals.length, 0),
        authorNeeded: spellings.reduce((n, r) => n + r.authorNeeded.length, 0),
      };
    });
    if (!counts) continue;
    const parts = [
      counts.stepFields ? `${counts.stepFields} step(s) with foreign fields` : '',
      counts.signatures ? `${counts.signatures} spec(s) with stale signatures` : '',
      counts.respell ? `${counts.respell} type position(s) to respell` : '',
      counts.proposals ? `${counts.proposals} proposal(s)` : '',
      counts.authorNeeded ? `${counts.authorNeeded} position(s) needing an author` : '',
      counts.surfaces.length ? `agent surfaces: ${counts.surfaces.join(', ')}` : '',
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
  // An Antigravity install writes only the machine-wide file; a project
  // .gemini/settings.json that is already there is registered and reported by
  // doctor too, so --fix repairs it with the same install (the project-scoped one).
  if (targets.includes('agy') && fs.existsSync(fromProjectRoot('.gemini', 'settings.json'))) {
    installs.push({ backend: 'gemini', global: false });
  }

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

/** Plain doctor: where the tree stands against the running wairon major. */
function reportMajor(tally: Tally): void {
  let where;
  try {
    where = standing(getProjectRoot());
  } catch (e) {
    line(tally, 'warn', `Could not read where the tree stands: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (where.state === 'current') {
    line(tally, 'ok', `Major: written by wairon ${where.writtenMajor}, the running major`);
  } else if (where.state === 'older') {
    line(tally, 'error', `Major: written by wairon ${where.writtenMajor}${where.stamped ? '' : ' (unstamped)'}, the running major is ${where.runningMajor} — run \`wairon upgrade\`; the fixes and the commands wait for it`);
  } else {
    line(tally, 'error', `Major: written by wairon ${where.writtenMajor}, the running major is ${where.runningMajor} (${where.state === 'newer' ? 'newer' : 'out of the upgrade window'}) — ${where.advice ?? 'install the release that can read it'}`);
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

/** Plain doctor: the spec tree's write lock, when its file is present — who holds it, and whether the next write waits or breaks it. */
function reportTreeLock(tally: Tally): void {
  let lock: TreeLockState | null;
  try {
    lock = inspectLock();
  } catch {
    return;
  }
  if (!lock) return;
  const rel = path.relative(getProjectRoot(), lock.file).split(path.sep).join('/');
  const age = `${Math.round(lock.ageMs / 1000)}s old`;
  if (lock.holder === 'live' && !lock.breaks) {
    line(tally, 'warn', `${rel} is held by process ${lock.pid} (${age}): a spec write is under way, and every other write waits for it. Run doctor again once it finishes.`);
    return;
  }
  if (lock.holder === 'remote') {
    // Another host or PID namespace: its liveness cannot be probed from here, so only the stale age frees it.
    const where = [
      lock.identity?.host !== undefined && lock.identity.host !== '' ? `host ${lock.identity.host}` : '',
      lock.identity?.pidNamespace !== undefined ? `PID namespace ${lock.identity.pidNamespace}` : '',
    ].filter(Boolean).join(', ');
    line(tally, 'warn', `${rel} is present (${age}) and its holder is on another host or PID namespace${where ? ` (${where})` : ''}, so its liveness cannot be checked from here: it is taken over only once it is older than the stale age${lock.breaks ? ' (it is now, so the next spec write takes it over)' : ', until then every other write waits'}. Nothing is lost — it is a lock, not a spec.`);
    return;
  }
  const why = lock.holder === 'unreadable'
    ? 'no holder can be read from it (a foreign or truncated file)'
    : lock.holder === 'gone' ? `the process it names (${lock.pid}) is gone` : `process ${lock.pid} has held it longer than any write takes`;
  line(tally, 'warn', `${rel} is present (${age}) and ${why}: ${lock.breaks ? 'the next spec write breaks it and goes ahead' : 'the next spec write breaks it once it is 10s old'}. Nothing is lost — it is a lock, not a spec; deleting it by hand is safe when no wairon session is writing.`);
}

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

function printSummary(tally: Tally): void {
  if (tally.error === 0 && tally.warn === 0) {
    logger.success('All checks passed — everything is current.');
  } else {
    const parts: string[] = [];
    if (tally.error > 0) parts.push(chalk.red(`${tally.error} error(s)`));
    if (tally.warn > 0) parts.push(chalk.yellow(`${tally.warn} warning(s)`));
    console.log(`${chalk.bold('Summary:')} ${parts.join(', ')}.`);
    if (tally.warn > 0 && tally.error === 0) {
      // Each warning line names its own remedy; a generic one (`wairon generate`) misled when
      // only, say, conformance warnings were left.
      logger.info('Each warning above names how to clear it.');
    }
  }
  logger.blank();
}
