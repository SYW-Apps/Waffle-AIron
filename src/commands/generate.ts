import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, AI_PATHS } from '../config/paths.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
// Every sdd_core call goes through the core adapter, never a core module
// directly — generation included: generateAll and resolveExpectedOutputPaths
// came straight out of ../exporters/generate.js until this import moved.
import {
  loadProjectConfig,
  resolveAgentTopology,
  listDirectChainedSubprojects,
  ensureProjectInitialized,
  generateAll,
  resolveExpectedOutputPaths,
  reinjectLocalGuides,
  hasContext,
  syncContextFiles,
} from './adapters/core.js';
import { exportSddSkills } from './adapters/skills.js';
import { WAIRON_MANAGED_MARKER } from '../exporters/base.js';
import { getProjectRoot, runWithProjectRoot, pathExists, isOutsideRoot, backupBeside } from '../utils/fs.js';
import { activeTargetTypes } from '../models/project.js';
import type { AgentRecord } from '../models/agent.js';
import type { ProjectConfig } from '../models/project.js';

/** The extensions the built-in exporters write agent files with: markdown (claude, cursor, copilot, codex, custom) and yaml (gemini, agy). */
const AGENT_FILE_EXTENSION = /\.(md|ya?ml)$/;

/** Filenames that only wairon's topology produces (architect / owners /
 *  implementers). Used as the migration fallback when reconciling a dir whose
 *  pre-existing files predate the managed marker. */
const WAIRON_AGENT_FILE = /-(owner|implementer|architect)\.(md|ya?ml)$/;

/**
 * Reconcile the managed output dirs against the EXPECTED file set — the paths
 * the full topology resolves to, not what any particular run wrote. Deletes
 * agent files that wairon owns but that are no longer expected. A file is
 * "wairon-owned" if it carries the managed marker OR matches the generated
 * agent-file naming (the latter migrates dirs written before the marker
 * existed). Hand-authored files that satisfy neither are never touched. Every
 * extension a built-in exporter writes is reconciled (.md, and .yaml for the
 * gemini/agy agents), so no target's managed files outlive the topology.
 * Returns the number of files pruned.
 *
 * `scanDirs` overrides which directories are reconciled — needed when the
 * expected set is EMPTY (materializeAgentFiles off: the desired state is zero
 * files, so the dirs cannot be derived from the expected paths).
 */
export function pruneStaleAgents(expectedPaths: Set<string>, scanDirs?: Iterable<string>, reach?: { root: string; global: boolean }): number {
  const dirs = new Set(scanDirs ?? [...expectedPaths].map((p) => path.dirname(p)));
  let pruned = 0;
  for (const dir of dirs) {
    // A directory outside the project is reconciled only under --global, and
    // then every file deleted there is kept beside itself first.
    const outside = reach !== undefined && isOutsideRoot(reach.root, dir);
    if (outside && !reach!.global) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!AGENT_FILE_EXTENSION.test(name)) continue;
      const full = path.resolve(dir, name);
      if (expectedPaths.has(full)) continue; // part of the current topology
      let owned = WAIRON_AGENT_FILE.test(name);
      if (!owned) {
        try {
          owned = fs.readFileSync(full, 'utf8').includes(WAIRON_MANAGED_MARKER);
        } catch {
          owned = false;
        }
      }
      if (!owned) continue; // hand-authored — leave it alone
      if (outside) logger.info(`Backed up ${full} to ${backupBeside(full)} before pruning it (outside the project root).`);
      fs.unlinkSync(full);
      pruned++;
      logger.verbose(`Pruned stale: ${full}`);
    }
  }
  return pruned;
}

// ---------------------------------------------------------------------------
// generate command
//
// RECONCILES the generated outputs to the configured state. Safe to run
// repeatedly — output is deterministic. Agent FILES are the opt-in materialized
// view of the live briefs (rules.materializeAgentFiles, default off): off means
// zero agent files (leftover managed files are removed once), on means
// owner/architect files rendered through the same brief composition. Guides,
// skills, and context sync run in both modes. Topology is LAYERED: this
// reconciles only the current project's own layer — there is no cascade into
// members. `--family` walks the members explicitly, generating each
// member's own layer in its own .wai/.claude, so the whole stack can still be
// reconciled by one command while each layer stays proportional to itself.
// ---------------------------------------------------------------------------

interface GenerateOptions {
  /** Limit to one configured target type (e.g. claude, agy); an unknown one is refused. */
  target?: string;
  /** Limit to a single domain id (or 'root' for root-level agents) */
  domain?: string;
  /** Comma-separated list of domain ids */
  domains?: string;
  /** Only generate root-level agents (no domainRoot) */
  root?: boolean;
  dryRun?: boolean;
  /** --family: also generate each member's own layer in its own root, and
   *  (carried down) its members'. Off by default: generate never cascades. */
  family?: boolean;
  /** Accepted for one release (--no-recurse): this project's layer only is
   *  now the default, so it changes nothing. */
  recurse?: boolean;
  /** Reconcile managed output dirs — prune wairon-owned agent files no longer in
   *  the topology (default true). Set false for --no-prune (write-only). */
  prune?: boolean;
  /** --global: also write and prune a target whose output directory resolves
   *  OUTSIDE the project root, backing up each file replaced or pruned there.
   *  Without it such a target is named and skipped. */
  global?: boolean;
}

/** Where this run may write and prune agent files: inside the root, and outside it only under --global. */
interface WriteReach {
  root: string;
  global: boolean;
}

/** The configured target types whose agent-file directory resolves outside the project root, with that directory. */
function targetsOutsideRoot(projectConfig: ProjectConfig, root: string): { type: string; dir: string }[] {
  const out: { type: string; dir: string }[] = [];
  for (const target of projectConfig.targets) {
    if (typeof target === 'string' || !('outputDir' in target) || !target.outputDir) continue;
    if ('enabled' in target && target.enabled === false) continue;
    const dir = path.resolve(root, target.outputDir);
    if (isOutsideRoot(root, dir)) out.push({ type: target.type, dir });
  }
  return out;
}

/**
 * Step 4 of runGenerate: name every target whose agent files would land
 * outside the project root. Without --global each is skipped — left out of the
 * write and the prune — and the run says so; nothing outside the project is
 * touched unless asked. Answers the target types to leave out.
 */
function announceOutsideTargets(projectConfig: ProjectConfig, reach: WriteReach): string[] {
  const outside = targetsOutsideRoot(projectConfig, reach.root);
  if (!outside.length) return [];
  if (reach.global) {
    for (const t of outside) logger.info(`Target "${t.type}" writes agent files outside the project root, to ${t.dir} (--global): each file replaced or pruned there is backed up beside itself first.`);
    return [];
  }
  for (const t of outside) {
    logger.warn(`Skipped target "${t.type}": its agent files would land outside the project root, in ${t.dir}. Nothing was written or pruned there — re-run with --global to write there (each replaced file is backed up beside itself).`);
  }
  return outside.map((t) => t.type);
}

/** The target types this project configures, in configuration order. */
function configuredTargetTypes(projectConfig: ProjectConfig): string[] {
  const targets = projectConfig.targets as ReadonlyArray<{ type: string } | string>;
  return [...new Set(targets.map((t) => (typeof t === 'string' ? t : t.type)))];
}

/**
 * Refuse a --target this project does not configure. It used to be silently
 * accepted and match nothing, so a typo looked exactly like a clean run.
 */
export class UnknownTargetError extends WaironError {
  constructor(target: string, known: string[]) {
    super(
      `Unknown target "${target}". This project configures: ${known.length ? known.join(', ') : '(none)'}. `
        + 'Pass one of those, or add a target to .wai/project.yaml (`targets`).',
    );
    this.name = 'UnknownTargetError';
  }
}

export async function runGenerate(options: GenerateOptions = {}): Promise<void> {
  await generateLayer(options);

  // Nothing below this project is written unless the member walk is asked for
  // (--family), and never for a dry run or a scoped (--domain/--root) run. With
  // it, one layer at a time: each DIRECT member is ensured-initialized first
  // (non-destructive — an explicitly asked-for write) so a not-yet-runnable
  // member becomes generable in place, then generates its own layer and, since
  // --family carries down, its own members'. No spec-cache invalidation is
  // needed: every project root reads through its own spec workspace, and the
  // bootstrap invalidates whenever it writes.
  const scoped = options.root || options.domain || options.domains;
  if (!options.family || options.dryRun || scoped) return;

  const children = listDirectChainedSubprojects(getProjectRoot());
  for (const child of children) {
    logger.blank();
    logger.info(`↳ Member "${child.alias}" — generating its layer in ${path.relative(getProjectRoot(), child.dir) || '.'}/`);
    await runWithProjectRoot(child.dir, async () => {
      ensureProjectInitialized(child.alias, child.alias); // non-destructive; a member is identified by the alias its parent declares it under
      await runGenerate(options); // --family carries down: this member's layer + its own members'
    });
  }
}

/** Reconcile the CURRENT project's own agent layer (no cascade) to the
 *  configured state. Agent-file materialization is OPT-IN via
 *  rules.materializeAgentFiles: when off (the default) the desired state is
 *  ZERO agent files — agents are served as live briefs — and any leftover
 *  managed files are removed once. Skills, context, and guides are (re)injected
 *  in both modes. */
async function generateLayer(options: GenerateOptions = {}): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  if (!projectConfig) throw new ProjectNotInitializedError();
  if (options.target !== undefined) {
    const known = configuredTargetTypes(projectConfig);
    if (!known.includes(options.target)) throw new UnknownTargetError(options.target, known);
  }
  // The live topology through the core adapter — empty while the project has no system spec.
  const agents = resolveAgentTopology();

  if (agents.length === 0) {
    logger.warn('No agents resolved from the spec tree. Define subsystems and components first — see `wairon status`.');
    return;
  }

  // Nothing outside the project root is written or pruned unless --global asks.
  const reach: WriteReach = { root: getProjectRoot(), global: options.global === true };
  const skippedTargets = announceOutsideTargets(projectConfig, reach);

  if (projectConfig.rules.materializeAgentFiles) {
    materializeAgentLayer(agents, projectConfig, options, reach, skippedTargets);
  } else if (options.dryRun) {
    logger.info('Dry run — rules.materializeAgentFiles is off: no agent files are written; leftover managed files would be removed.');
  } else if (options.prune !== false) {
    // The prune machinery with an EMPTY expected set: every wairon-owned agent
    // file (managed marker / -(owner|implementer|architect).md naming) in the
    // topology's output dirs is a leftover. Hand-authored files and
    // .wai/agents/ guidance are never touched.
    const candidateDirs = [...resolveExpectedOutputPaths(agents, projectConfig)]
      .map((p) => path.dirname(p));
    const removed = pruneStaleAgents(new Set(), candidateDirs, reach);
    if (removed > 0) {
      logger.info(`Removed ${removed} previously materialized agent file(s) — agents are served as live briefs (sdd_get_agent_brief); opt back in with rules.materializeAgentFiles: true.`);
    } else {
      // Said at default verbosity: a run that writes no agent file would
      // otherwise print nothing at all and read like it did nothing.
      logger.info('Agent files: off (rules.materializeAgentFiles) — agents are served as live briefs (sdd_get_agent_brief); no agent files written.');
    }
  }

  if (options.dryRun) return;

  // Keep context files current if context has been initialised
  if (hasContext()) {
    syncContextFiles();
    logger.verbose('Context files synced.');
  }

  // Re-export the SDD skills when the spec tree exists.
  if (pathExists(AI_PATHS.specsSystem())) {
    try {
      exportSddSkills();
      logger.verbose('SDD AI Skills synced.');
    } catch (err) {
      logger.warn(`Failed to export SDD Skills: ${String(err)}`);
    }
  }

  // Re-inject the project-local guides so .claude/CLAUDE.md / .gemini/GEMINI.md
  // stay current with the installed wairon (otherwise only `init` writes them),
  // for the configuration's active targets.
  try {
    // STATIC, and through the core adapter: the lazy `require` this replaced
    // both hid an sdd_cli -> sdd_core module reach from a reader and would not
    // have resolved at all once the CLI is bundled — ../core/context.ts carries
    // that same note about that same form.
    //
    // getProjectRoot() (not process.cwd()) so a cascaded subproject layer
    // re-injects ITS guides into ITS own dir, not the original invocation dir.
    reinjectLocalGuides(getProjectRoot(), activeTargetTypes(projectConfig));
    logger.verbose('Local AI guides re-injected.');
    logger.info(`Guides, skills and context reconciled for: ${activeTargetTypes(projectConfig).join(', ') || '(no active targets)'}.`);
  } catch (err) {
    logger.warn(`Failed to re-inject AI guides: ${String(err)}`);
  }
}

/**
 * Under --global, copy every existing agent file this topology owns OUTSIDE
 * the project root beside itself before the run can replace it. Answers each
 * file's backup, by resolved path; without --global nothing outside is written,
 * so nothing is backed up.
 */
function backUpOutsideFiles(agents: AgentRecord[], projectConfig: ProjectConfig, reach: WriteReach): Map<string, string> {
  const backups = new Map<string, string>();
  if (!reach.global) return backups;
  for (const file of resolveExpectedOutputPaths(agents, projectConfig)) {
    if (isOutsideRoot(reach.root, file) && pathExists(file)) backups.set(path.resolve(file), backupBeside(file));
  }
  return backups;
}

/** Materialize the per-subsystem agent FILES (rules.materializeAgentFiles:
 *  true): write owner/architect files — their body is the live brief
 *  composition — then prune stale managed files against the FULL topology. */
function materializeAgentLayer(
  agents: AgentRecord[],
  projectConfig: ProjectConfig,
  options: GenerateOptions,
  reach: WriteReach,
  skippedTargets: string[],
): void {
  // A target outside the project root is left out unless --global (step 4).
  const configured = activeTargetTypes(projectConfig);
  const filterTargets = options.target
    ? [options.target].filter((t) => !skippedTargets.includes(t))
    : skippedTargets.length ? configured.filter((t) => !skippedTargets.includes(t)) : undefined;

  let filterDomainIds: string[] | undefined;
  if (options.root) {
    filterDomainIds = ['root'];
  } else if (options.domains) {
    filterDomainIds = options.domains.split(',').map((s) => s.trim()).filter(Boolean);
  } else if (options.domain) {
    const matches = agents
      .map(a => a.domainRoot)
      .filter((d): d is string => !!d && (d === options.domain || d.startsWith(`${options.domain}::`)));
    filterDomainIds = Array.from(new Set([options.domain, ...matches]));
  }

  const agentPool = filterDomainIds
    ? agents.filter((a) => filterDomainIds!.includes(a.domainRoot ?? 'root'))
    : agents;

  if (options.dryRun) {
    logger.info('Dry run — no files will be written.');
  }

  logger.info(`Generating ${agentPool.length} agent(s)...`);
  logger.blank();

  // Under --global, every existing file outside the root this run may replace
  // is copied beside itself first; the copy is kept only where the file changed.
  const backups = options.dryRun ? new Map<string, string>() : backUpOutsideFiles(agents, projectConfig, reach);

  const summaries = generateAll(agents, projectConfig, {
    filterTargets,
    filterDomainIds,
    dryRun: options.dryRun,
  });

  let written = 0;
  let skipped = 0;

  for (const summary of summaries) {
    if (options.dryRun) {
      logger.info(`[dry-run] Would generate: ${summary.agent.id}`);
    } else {
      for (const result of summary.results) {
        if (result.unchanged) {
          logger.verbose(`Unchanged: ${result.outputPath}`);
          skipped++;
        } else {
          logger.success(`Written:   ${result.outputPath}`);
          written++;
          const backup = backups.get(path.resolve(result.outputPath));
          if (backup) {
            logger.info(`Backed up the replaced ${result.outputPath} to ${backup}.`);
            backups.delete(path.resolve(result.outputPath));
          }
        }
      }
    }
  }
  // A backup of a file this run did not replace records nothing: drop it.
  for (const backup of backups.values()) fs.rmSync(backup, { force: true });

  // Reconcile: prune wairon-owned agent files no longer in the topology (removed
  // components, or the old flat pile after the switch to layered). ALWAYS runs,
  // scoped or not — the expected set is resolved from the FULL topology
  // (all resolved agents, never the scoped pool or what this run happened to
  // write), so a domain/root/target-scoped run deletes true orphans while every
  // other layer's current files stay recognized and untouched.
  let prunedCount = 0;
  if (!options.dryRun && options.prune !== false) {
    prunedCount = pruneStaleAgents(resolveExpectedOutputPaths(agents, projectConfig), undefined, reach);
  }

  logger.blank();
  if (options.dryRun) {
    logger.success(`Dry run complete. ${summaries.length} agent(s) would be processed.`);
  } else {
    const parts = [];
    if (written > 0) parts.push(`${written} written`);
    if (skipped > 0) parts.push(`${skipped} unchanged`);
    if (prunedCount > 0) parts.push(`${prunedCount} pruned`);
    logger.success(`Done. ${summaries.length} agent(s) processed — ${parts.join(', ') || 'none'}.`);
  }
}
