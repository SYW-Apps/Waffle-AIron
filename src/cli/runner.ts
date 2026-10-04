// ---------------------------------------------------------------------------
// cli_runner — the terminal's workflows that live in no command module of
// their own: the lock and its approval gate, attached-checkout routing for
// validate / status / lock, the pack-ecosystem dispatch, agent briefs and the
// hosted MCP registration. The `wairon` binary's argv parsing is cli_portal's
// (src/cli/index.ts); it dispatches every command here or to the command
// module that holds it, and never reaches an adapter itself.
// ---------------------------------------------------------------------------

import * as path from 'path';
import { logger } from '../utils/logger.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
// The runner imports each command adapter module DIRECTLY (not through the
// commands barrel) so the physical import graph mirrors the declared
// cli_runner → adapter edges (dependency conformance).
import { runGenerate } from '../commands/generate.js';
import { runLock as lockTree, checkApproval } from '../commands/lock.js';
import type { LockOptions, LockCheckOptions } from '../commands/lock.js';
import { runValidate, validateAsComplete, computeGateStateId } from '../commands/validate.js';
import { designOnly } from '../models/lock.js';
import { assertProjectInitialized, AI_PATHS } from '../config/paths.js';
import { pathExists, writeFile, getProjectRoot } from '../utils/fs.js';
import { runMcpInstall } from '../commands/mcp.js';
import { runStatus } from '../commands/status.js';
// The pending-transaction banner: unfinished family migrations under this root.
import { recover as recoverMigrations } from '../commands/adapters/migrations.js';
import { listRules } from '../commands/rules.js';
import { listPatterns } from '../commands/patterns.js';
import { listVariants } from '../commands/adapters/variants.js';
import { addPack, listPacks, removePack, initPack, buildPack, installPack, uninstallStorePack, whichPack, usePack, unusePack, bundlePack, syncPacks, impactPack, type PackCommandOptions } from '../commands/packs.js';
import {
  resolveTarget,
  validateAttached,
  statusAttached,
  lockAttached,
  storedCredentialFor,
} from '../commands/remote.js';
import { composeAgentBrief, loadProjectConfig, resolveAgentTopology } from '../commands/adapters/core.js';
import { summarize } from '../models/execution.js';

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

// cli_runner.runLock — the local `wairon lock` workflow: CAPTURE the gate
// identity before anything is judged, gate on the DESIGN half of the
// as-complete dry-run validation (an invalid design is never frozen), lock
// through the lock adapter (which refuses when requireApprovedMembers finds a
// direct member unapproved, and when the identity moved while the lock ran),
// and refresh THIS project's generated outputs. Code-conformance findings never
// refuse the lock: they are recorded beside the claim and printed plainly — CI
// (`wairon validate --ci`) enforces them. A parent lock writes nothing into its
// members, generated outputs included: each member locks at its own root.
//
// Why validate-as-complete: the conformance gate downgrades completeness
// errors to warnings while a spec is `draft`, so a draft tree can "pass" yet
// break the moment it's locked. The gate validates the tree AS IF everything
// were complete (the status flip happens in-memory inside the validator and is
// restored) and the lock is refused unless it is clean at full strictness. A
// failed or cancelled lock leaves every file byte-for-byte unchanged.
async function runLock(options: LockOptions): Promise<void> {
  assertProjectInitialized();

  if (!pathExists(AI_PATHS.specsSystem())) {
    logger.error('No SDD spec tree found (.wai/specs). Nothing to lock.');
    process.exit(1);
  }

  const projectConfig = loadProjectConfig();
  if (!projectConfig) throw new ProjectNotInitializedError();

  // Step 6: capture the identity the record will certify, before anything is judged.
  const captured = computeGateStateId();

  logger.info('Analyzing and validating specifications in-memory...');
  const dry = validateAsComplete({
    rules: projectConfig.rules,
    projectType: projectConfig.projectType,
    scopeSubsystem: options.subsystem,
  });

  // Step 8: the design half is what the approval certifies and the only
  // findings that may refuse it — a design can be approved before its code exists.
  const design = designOnly(dry);
  const errors = design.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    logger.header('Cannot lock — the design does not validate as complete');
    let errorCount = 0;
    const MAX_PRINT = 100;
    let skippedErrors = 0;
    for (const i of errors) {
      if (errorCount < MAX_PRINT) {
        logger.error(`${i.specId ? `[${i.specId}] ` : ''}[${i.code}] ${i.message}`);
        errorCount++;
      } else {
        skippedErrors++;
      }
    }
    if (skippedErrors > 0) {
      logger.error(`... and ${skippedErrors} more error(s) omitted.`);
    }
    logger.blank();
    logger.info('Fix the errors above, then run `wairon lock` again. Nothing was changed.');
    process.exit(1);
  }

  // --- Lock through the adapter (summary, member states, confirmation, re-confirm) ---
  logger.header('Lock SDD specs');
  // A refusal (requireApprovedMembers, inputs that moved while it ran) is a
  // WaironError: printed and exited on by the CLI's own handler, nothing written.
  const record = await lockTree(options, dry, captured);
  if (!record) {
    logger.info('Cancelled. Nothing was changed.');
    return;
  }

  // THIS project's generated outputs only — never --family: a parent lock
  // writes nothing below itself, generated outputs included.
  logger.blank();
  await runGenerate({ domain: options.subsystem });

  logger.blank();
  logger.success('Specs locked and generated outputs reconciled.');
  logger.info(`Lock record written (.wai/lock.json): stateId ${record.stateId.algorithm}:${record.stateId.digest} — status ${record.status}.`);
  for (const [alias, pin] of Object.entries(record.members ?? {})) {
    logger.info(`  member ${alias}: ${pin.state}${pin.subject ? ` (${pin.subject.slice(0, 26)}…)` : ''}`);
  }
  // Printed plainly, on its own line, so an approval taken over failing code is
  // never mistaken for clean code.
  const code = record.code;
  logger.info(code
    ? `code: ${code.errors} error(s), ${code.warnings} warning(s) recorded beside the claim `
      + `(analyzer ${code.analyzer.validatorVersion}, grade ${code.analyzer.grade}) — CI enforces them, not the lock`
    : 'code: no code analysis recorded');
  logger.info(
    'Live agent briefs (sdd_get_agent_brief / wairon-agent://) ' +
      'are composed per call and already current — no session restart needed.',
  );
}

// ---------------------------------------------------------------------------
// Attached-checkout routing (cli_runner)
//
// A checkout ATTACHED to a hosted project has no local spec tree, so the three
// commands that read one run against the hosted tree instead. Everything else
// stays honestly local: a command that needs files on disk keeps failing with
// guidance to `wairon remote pull` rather than silently doing nothing.
// ---------------------------------------------------------------------------

/** cli_runner.runLock — hosted when attached, else the local freeze. */
export async function lockCommand(opts: { yes?: boolean; subsystem?: string; recursive?: boolean }): Promise<void> {
  const target = resolveTarget(getProjectRoot(), {});
  if (target) {
    const outcome = await lockAttached(target);
    logger.success(`Hosted lock of "${target.projectId}" on ${target.url}: ${outcome}`);
    return;
  }
  await runLock({ yes: opts.yes, subsystem: opts.subsystem, recursive: opts.recursive });
}

/** cli_runner.runValidate — hosted when attached, else the local validation. */
export async function validateCommand(opts: { ci?: boolean; subsystem?: string; recursive?: boolean; family?: boolean }): Promise<void> {
  const target = resolveTarget(getProjectRoot(), {});
  if (target) {
    const report = (await validateAttached(target, opts.subsystem, opts.family)) as {
      valid?: boolean;
      errors?: { code: string; message: string; specId?: string }[];
      warnings?: { code: string; message: string; specId?: string }[];
      notices?: { code: string; message: string; specId?: string }[];
    };
    const errors = report.errors ?? [];
    const warnings = report.warnings ?? [];
    // An instance older than the notice severity sends no `notices` list.
    const notices = report.notices ?? [];
    logger.info(`Validated "${target.projectId}" on ${target.url} — ${errors.length} error(s), ${warnings.length} warning(s), ${notices.length} notice(s).`);
    for (const e of errors) logger.error(`  [${e.code}] ${e.specId ? `${e.specId}: ` : ''}${e.message}`);
    for (const w of warnings) logger.warn(`  [${w.code}] ${w.specId ? `${w.specId}: ` : ''}${w.message}`);
    for (const n of notices) logger.notice(`  [${n.code}] ${n.specId ? `${n.specId}: ` : ''}${n.message}`);
    // Exit non-zero exactly as a local run would, so CI gates identically:
    // notices never fail it, --ci included.
    if (errors.length || (opts.ci && warnings.length)) process.exit(1);
    return;
  }
  // Not attached: the pending-transaction banner, before the tree is read (a
  // crash mid-swap may leave it unreadable) — a notice, so --ci is unaffected.
  for (const t of recoverMigrations(getProjectRoot(), false)) {
    logger.notice(`[TRANSACTION_PENDING] an unfinished family migration (${t.verb}, transaction ${t.id}, coordinator phase ${t.phase}) — run \`wairon doctor --fix\` to roll it back`);
  }
  await runValidate({ ci: opts.ci, subsystem: opts.subsystem, recursive: opts.recursive, family: opts.family });
}

/** cli_runner.runStatus — hosted when attached, else the local dashboard. */
export async function statusCommand(opts: { subsystem?: string; recursive?: boolean }): Promise<void> {
  const target = resolveTarget(getProjectRoot(), {});
  if (target) {
    logger.info(`Status of "${target.projectId}" on ${target.url}:`);
    process.stdout.write(`${await statusAttached(target, opts.subsystem)}\n`);
    return;
  }
  // The flag at the edge: --no-recursive is a member depth of 0, the default every level.
  await runStatus({ subsystem: opts.subsystem, ...(opts.recursive === false ? { memberDepth: 0 } : {}) });
}

// ---------------------------------------------------------------------------
// lock-check (cli_runner.runLockCheck)
//
// The merge gate, and deliberately NOT a flag on `validate`. Two reasons:
//
//  1. It asks a different question. `validate` asks whether the design is
//     LEGAL; this asks whether it is APPROVED. They are independent — a tree
//     can be approved and illegal, or legal and unapproved — so folding them
//     into one exit code makes a single red check mean two unrelated things.
//  2. It costs a fraction as much. `validate` runs the whole rule set over the
//     whole tree; this loads the tree, hashes it, and reads one committed JSON
//     file. A consumer importing the reusable workflow runs it on every pull
//     request, and should not have to pay for the validator to learn whether
//     someone approved the design.
//
// Local only, with no attached-checkout routing: the subject is the design in
// the commit being merged, which is on disk here. A hosted project's lock is
// `wairon host lock`.
// ---------------------------------------------------------------------------

/** cli_runner.runLockCheck — print the approval verdict and exit on it. */
export async function lockCheckCommand(options: LockCheckOptions): Promise<void> {
  // No assertProjectInitialized(): a repository with no .wai/ at all must be
  // told exactly that, not met with an error about an uninitialized project.
  const verdict = checkApproval(options.strict === true);

  // Print BEFORE deciding — the log carries the verdict whichever way it goes.
  if (!verdict.approved) logger.error(verdict.message);
  else if (verdict.state === 'locked') logger.success(verdict.message);
  else logger.info(verdict.message);

  if (verdict.approved) return;
  // Exit non-zero so the job fails. Whether that BLOCKS a merge is a branch
  // protection setting on the repository — no workflow can declare it.
  process.exit(1);
}

// cli_runner dispatch for the pack-ecosystem commands — consistent with
// runValidate/runGenerate/…: the orchestrator routes each subcommand to its
// command adapter rather than the commander action calling the adapter inline.
export function runRules(): void {
  listRules();
}
export function runPatterns(): void {
  listPatterns();
}
export function runVariants(): void {
  listVariants();
}
export async function runPacks(action: string, arg?: string, options: PackCommandOptions = {}): Promise<void> {
  if (action === 'add') await addPack(arg!, options.global);
  else if (action === 'list') listPacks();
  else if (action === 'remove') await removePack(arg!, options.global);
}
export async function runPack(
  action: string,
  arg?: string,
  options: PackCommandOptions = {},
): Promise<void> {
  // --yes passes through to the commands that select, update or remove a
  // project's pack; without it they show the pack's impact and ask first.
  if (action === 'init') initPack(arg!, { kind: options.kind === 'code' ? 'code' : 'declarative', dir: options.dir, skill: options.skill });
  else if (action === 'build') buildPack(arg ?? '.', { out: options.out });
  else if (action === 'add') await addPack(arg!, options.global, options.yes);
  else if (action === 'list') listPacks();
  else if (action === 'remove') await removePack(arg!, options.global, options.yes);
  else if (action === 'install') await installPack(arg!, options.yes);
  else if (action === 'uninstall') uninstallStorePack(arg!);
  else if (action === 'which') whichPack(arg!);
  else if (action === 'use') await usePack(arg!, { source: options.source, bundle: options.bundle, pin: options.pin, yes: options.yes });
  else if (action === 'unuse') await unusePack(arg!, options.yes);
  else if (action === 'bundle') bundlePack(arg, { all: options.all });
  else if (action === 'sync') await syncPacks();
  else if (action === 'impact') impactPack(arg!);
  else throw new WaironError('unknown pack action (expected init | build | install | uninstall | which | use | unuse | impact | bundle | sync | add | list | remove)');
}

// ---------------------------------------------------------------------------
// agent — live delegation briefs + user-owned per-agent guidance
// ---------------------------------------------------------------------------

/** Thrown when `wairon agent customize` targets a guidance file that already
 *  exists — it is user-owned and is never regenerated or overwritten. */
class GuidanceFileExistsError extends WaironError {
  constructor(relPath: string) {
    super(`${relPath} already exists. It is user-owned — edit it directly; wairon never regenerates or prunes it.`);
    this.name = 'GuidanceFileExistsError';
  }
}

// cli_runner.runAgent — `wairon agent <action> <id>`. `brief` prints the
// agent's LIVE delegation brief (the CLI window into what sdd_get_agent_brief
// serves); `customize` scaffolds the user-owned guidance file
// .wai/agents/<id>.md from the current brief and REFUSES when it exists.
export async function runAgent(action: string, id: string): Promise<void> {
  assertProjectInitialized();

  switch (action) {
    case 'brief': {
      const brief = composeAgentBrief(id);
      logger.header(`${brief.name} (${brief.agentId})`);
      if (brief.domainRoot) logger.info(`Domain:      ${brief.domainRoot}`);
      if (brief.ownedPaths.length > 0) {
        logger.info('Owned paths:');
        for (const p of brief.ownedPaths) logger.info(`  ${p}`);
      }
      if (brief.readPaths && brief.readPaths.length > 0) {
        logger.info('Read paths:');
        for (const p of brief.readPaths) logger.info(`  ${p}`);
      }
      if (brief.budget && brief.profile) {
        logger.blank();
        logger.info('Execution budget (advisory — apply when spawning):');
        for (const line of summarize(brief.budget, brief.profile)) {
          logger.info(`  ${line.replace(/^- \*\*(.+?)\*\*: /, '$1: ')}`);
        }
      }
      logger.blank();
      console.log(brief.instructions);
      return;
    }
    case 'customize': {
      // Composing first also validates the id (UnknownAgentError on a miss).
      const brief = composeAgentBrief(id);
      const guidancePath = path.join(AI_PATHS.root(), 'agents', `${id}.md`);
      const relPath = `.wai/agents/${id}.md`;
      if (pathExists(guidancePath)) {
        throw new GuidanceFileExistsError(relPath);
      }
      // Starting content: the agent's (subsystem-derived) description. The
      // spec-derived facts themselves stay OUT of the file — they are inferred
      // live on every brief composition.
      const description = resolveAgentTopology().find((a) => a.id === id)?.description ?? brief.name;
      writeFile(guidancePath, [
        `<!-- Project guidance for agent "${id}" — user-owned; wairon never regenerates or prunes this file.`,
        '     Spec-derived facts (ownership, paths, workflow) are inferred LIVE from the spec tree on every',
        '     brief composition — do not duplicate them here. Everything below this header is folded into',
        `     every "${id}" brief under "## Project guidance". -->`,
        '',
        description,
        '',
      ].join('\n'));
      logger.success(`Created ${relPath}`);
      logger.info('Edit it freely — its content is folded into every future brief for this agent under "## Project guidance".');
      return;
    }
    default:
      throw new WaironError(`Unknown agent action "${action}" (expected brief | customize).`);
  }
}

/**
 * cli_runner.runMcpInstall — register (or self-heal) the wairon MCP entry. For a
 * HOSTED registration the bearer is resolved HERE — the explicit --token, else
 * the credential stored for that instance — because the config adapter may not
 * read the credential store; `wairon login` once is enough to wire an agent.
 */
export function mcpInstallCommand(opts: {
  global?: boolean;
  configDir?: string;
  backend?: string;
  hosted?: string;
  project?: string;
  token?: string;
}): void {
  const hostedToken = opts.hosted
    ? (opts.token ?? storedCredentialFor(String(opts.hosted).replace(/\/+$/, '')) ?? undefined)
    : undefined;
  runMcpInstall({
    global: opts.global,
    configDir: opts.configDir,
    backend: opts.backend,
    hostedUrl: opts.hosted,
    hostedProject: opts.project,
    hostedToken,
  });
}
