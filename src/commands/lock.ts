import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, AI_PATHS } from '../config/loader.js';
import { pathExists } from '../utils/fs.js';
import { validateSddTree } from '../core/validation.js';
import {
  collectPromotableSpecs,
  applySpecStatus,
  invalidateSpecCache,
  scanAllSpecs,
} from '../core/specs.js';
import { runGenerate } from './generate.js';

// ---------------------------------------------------------------------------
// lock command
//
// The single human "final check" before implementation: validate the spec tree
// AS IF COMPLETE, freeze every spec to `complete`, and regenerate the agent
// topology — but only if it validates. This is the gate that unlocks the
// implementer agents.
//
// Why validate-as-complete: the conformance gate downgrades completeness errors
// to warnings while a spec is `draft`, so a draft tree can "pass" yet break the
// moment it's locked. We therefore dry-run the promotion (snapshot → set all
// complete → validate → restore) and refuse to lock unless it's clean at full
// strictness. A failed or cancelled lock leaves every file byte-for-byte
// unchanged.
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** Skip the interactive confirmation (for scripts / CI). */
  yes?: boolean;
}

export async function runLock(options: LockOptions = {}): Promise<void> {
  assertProjectInitialized();

  if (!pathExists(AI_PATHS.specsSystem())) {
    logger.error('No SDD spec tree found (.wai/specs). Nothing to lock.');
    process.exit(1);
  }

  const projectConfig = loadProjectConfig();

  logger.info('Analyzing and validating specifications in-memory...');
  const index = scanAllSpecs();
  const promotable = collectPromotableSpecs();

  // --- Dry run: validate the tree in-memory as if everything were already complete ---
  const originalStatuses = new Map<any, string | undefined>();
  for (const s of index.subsystems) { originalStatuses.set(s, s.status); s.status = 'complete'; }
  for (const c of index.components) { originalStatuses.set(c, c.status); c.status = 'complete'; }
  for (const i of index.interfaces) { originalStatuses.set(i, i.status); i.status = 'complete'; }
  for (const m of index.implementations) { originalStatuses.set(m, m.status); m.status = 'complete'; }

  const dry = validateSddTree(projectConfig.rules, projectConfig.projectType);

  // Restore original statuses in-memory
  for (const [spec, status] of originalStatuses.entries()) {
    spec.status = status;
  }

  const errors = dry.issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    logger.header('Cannot lock — the spec tree does not validate as complete');
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

  // --- Summary ---
  logger.header('Lock SDD specs');
  if (promotable.length === 0) {
    logger.info('All specs are already complete — this will re-validate and regenerate the agent topology.');
  } else {
    logger.info(`${promotable.length} spec(s) will be frozen as complete:`);
    for (const p of promotable) {
      logger.info(`  • ${p.kind.padEnd(14)} ${p.id}  (${p.status} → complete)`);
    }
  }
  logger.blank();
  logger.warn('This freezes the design as the source of truth and (re)generates the agent topology.');

  // --- Confirm (the "are you sure?" gate) ---
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      logger.error('Non-interactive shell — re-run with --yes to confirm the lock.');
      process.exit(1);
    }
    const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Lock these specs and generate the agent topology? This freezes the design.',
        default: false,
      },
    ]);
    if (!confirmed) {
      logger.info('Cancelled. Nothing was changed.');
      return;
    }
  }

  // --- Commit: promote for real, then generate ---
  for (const p of promotable) applySpecStatus(p.kind, p.id, 'complete');
  invalidateSpecCache();
  if (promotable.length > 0) {
    logger.success(`Locked ${promotable.length} spec(s) as complete.`);
  }

  logger.blank();
  await runGenerate({});

  logger.blank();
  logger.success('Specs locked and agent topology generated.');
  logger.warn(
    'Restart any running AI agent sessions (Claude Code / Antigravity / Codex) so the newly ' +
      'generated implementer agents load — they are not picked up mid-session.',
  );
}
