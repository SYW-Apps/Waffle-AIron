#!/usr/bin/env node

import * as path from 'path';
import { Command } from 'commander';
import { WAIRON_VERSION } from '../config/defaults.js';
import { logger, setLogLevel } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
// The runner imports each command adapter module DIRECTLY (not through the
// commands barrel) so the physical import graph mirrors the declared
// cli_runner → adapter edges (dependency conformance).
import { runAliasesList, runAliasesEnable, runAliasesDisable } from '../commands/aliases.js';
import { runInit } from '../commands/init.js';
import { runGenerate } from '../commands/generate.js';
import { runLock as lockTree } from '../commands/lock.js';
import type { LockOptions } from '../commands/lock.js';
import { runValidate, validateAsComplete } from '../commands/validate.js';
import { assertProjectInitialized, loadProjectConfig, loadRegistry, AI_PATHS } from '../config/loader.js';
import { pathExists, writeFile, getProjectRoot } from '../utils/fs.js';
import { runList } from '../commands/list.js';
import { runShow } from '../commands/show.js';
import { runMcpServe, runMcpInstall, runMcpStatus } from '../commands/mcp.js';
import { runUpdate, cleanStaleBinary } from '../commands/update.js';
import { runStatus } from '../commands/status.js';
import { runDomainsList, runDomainsScan, runDomainsAdd, runDomainsRemove } from '../commands/domains.js';
import { runSkillsList, runSkillsInstall } from '../commands/skills.js';
import { runDoctor } from '../commands/doctor.js';
import { runDiagram } from '../commands/diagram.js';
import { listRules } from '../commands/rules.js';
import { listPatterns } from '../commands/patterns.js';
import { listVariants } from '../commands/variants.js';
import { addPack, listPacks, removePack, initPack, buildPack, installPack, uninstallStorePack, whichPack, usePack, unusePack, bundlePack, syncPacks } from '../commands/packs.js';
import {
  runServe,
  runDev,
  runHostProject,
  runHostDemo,
  runHostUnit,
  runHostPermission,
  runHostDoctor,
  runHostKey,
  runHostLock,
  runHostPromote,
  runHostGit,
  runHostProducer,
  runHostSecret,
  runHostPacks,
} from '../commands/host.js';
import { runProduce } from '../commands/produce.js';
import { runSurface, generateChildSnapshots } from '../commands/surface.js';
import {
  runRemote,
  runLogin,
  runLogout,
  resolveTarget,
  validateAttached,
  statusAttached,
  lockAttached,
  storedCredentialFor,
} from '../commands/remote.js';
import {
  runSubsystemAdd,
  runSubsystemMove,
  runSubsystemExternalize,
  runSubsystemInternalize,
  composeAgentBrief,
} from '../commands/subsystem.js';
import { describeBudget } from '../core/budget_policy.js';

// Clean up any .old binary left over from a previous Windows self-update
cleanStaleBinary();

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('wairon')
  .description('SYW Waffle AIron — Spec-Driven Development (SDD) & Agent Topology Orchestration')
  .version(WAIRON_VERSION, '-v, --version')
  .option('--verbose', 'enable verbose output')
  .option('--silent', 'suppress all output except errors')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setLogLevel('verbose');
    else if (opts.silent) setLogLevel('silent');
  });

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Initialize wairon and bootstrap the SDD Spec Tree (.wai/specs/) in the current project')
  .option('-y, --yes', 'use defaults without interactive prompts')
  .option('--pack <source>', 'vendor + register an extension pack right after init (repeatable)', (v: string, all: string[]) => [...all, v], [] as string[])
  .action(async (opts) => {
    await runInit({ yes: opts.yes });
    for (const source of opts.pack as string[]) {
      await addPack(source);
    }
  });

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

program
  .command('generate')
  .description('Generate agent output files from the spec tree')
  .option('--target <type>', 'limit to a specific target (claude|gemini|custom)')
  .option('--domain <id>', 'limit to agents in a single domain')
  .option('--domains <ids>', 'limit to a comma-separated list of domain ids')
  .option('--root', 'only generate root-level agents')
  .option('--no-recurse', 'only generate this project\'s layer; do not cascade into chained subprojects')
  .option('--no-prune', 'do not remove wairon-managed agent files that are no longer in the topology')
  .option('--dry-run', 'preview what would be generated without writing files')
  .action(async (opts) => {
    await runGenerate({
      target: opts.target,
      domain: opts.domain,
      domains: opts.domains,
      root: opts.root,
      // commander maps --no-recurse / --no-prune to opts.recurse/opts.prune === false
      recurse: opts.recurse,
      prune: opts.prune,
      dryRun: opts.dryRun,
    });
  });

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

// cli_runner.runLock — the local `wairon lock` workflow: gate on the
// as-complete dry-run validation (an invalid tree is never frozen), freeze the
// tree through the lock adapter, and — when the tree mounts chained children —
// regenerate the family and sibling surface snapshots into every child so a
// locked parent ships fresh surfaces.
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

  logger.info('Analyzing and validating specifications in-memory...');
  const dry = validateAsComplete({
    rules: projectConfig.rules,
    projectType: projectConfig.projectType,
    scopeSubsystem: options.subsystem,
    recursive: options.recursive ?? true,
  });

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

  // --- Freeze through the lock adapter (summary + confirmation live there) ---
  logger.header('Lock SDD specs');
  const record = await lockTree(options, dry);
  if (!record) {
    logger.info('Cancelled. Nothing was changed.');
    return;
  }

  // --- A locked parent ships fresh surfaces: regenerate the family and
  // sibling snapshots into every chained child (no-op when none are mounted).
  const childPaths = generateChildSnapshots();
  if (childPaths.length > 0) {
    logger.blank();
    logger.success(`Regenerated the family/sibling surfaces into ${childPaths.length} chained child snapshot(s):`);
    for (const p of childPaths) logger.info(`  ${p}`);
  }

  logger.blank();
  await runGenerate({ domain: options.subsystem });

  logger.blank();
  logger.success('Specs locked and generated outputs reconciled.');
  logger.info(`Lock record written (.wai/lock.json): stateId ${record.stateId.algorithm}:${record.stateId.digest} — status ${record.status}.`);
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
async function lockCommand(opts: { yes?: boolean; subsystem?: string; recursive?: boolean }): Promise<void> {
  const target = resolveTarget(getProjectRoot(), {});
  if (target) {
    const outcome = await lockAttached(target);
    logger.success(`Hosted lock of "${target.projectId}" on ${target.url}: ${outcome}`);
    return;
  }
  await runLock({ yes: opts.yes, subsystem: opts.subsystem, recursive: opts.recursive });
}

/** cli_runner.runValidate — hosted when attached, else the local validation. */
async function validateCommand(opts: { ci?: boolean; subsystem?: string; recursive?: boolean }): Promise<void> {
  const target = resolveTarget(getProjectRoot(), {});
  if (target) {
    const report = (await validateAttached(target, opts.subsystem)) as {
      valid?: boolean;
      errors?: { code: string; message: string; specId?: string }[];
      warnings?: { code: string; message: string; specId?: string }[];
    };
    const errors = report.errors ?? [];
    const warnings = report.warnings ?? [];
    logger.info(`Validated "${target.projectId}" on ${target.url} — ${errors.length} error(s), ${warnings.length} warning(s).`);
    for (const e of errors) logger.error(`  [${e.code}] ${e.specId ? `${e.specId}: ` : ''}${e.message}`);
    for (const w of warnings) logger.warn(`  [${w.code}] ${w.specId ? `${w.specId}: ` : ''}${w.message}`);
    // Exit non-zero exactly as a local run would, so CI gates identically.
    if (errors.length || (opts.ci && warnings.length)) process.exit(1);
    return;
  }
  await runValidate({ ci: opts.ci, subsystem: opts.subsystem, recursive: opts.recursive });
}

/** cli_runner.runStatus — hosted when attached, else the local dashboard. */
async function statusCommand(opts: { subsystem?: string; recursive?: boolean }): Promise<void> {
  const target = resolveTarget(getProjectRoot(), {});
  if (target) {
    logger.info(`Status of "${target.projectId}" on ${target.url}:`);
    process.stdout.write(`${await statusAttached(target, opts.subsystem)}\n`);
    return;
  }
  await runStatus({ subsystem: opts.subsystem, recursive: opts.recursive });
}

program
  .command('lock')
  .description('Final check before implementation: validate the spec tree as complete, freeze all specs to complete, and (re)generate the agent topology — only if it validates. In an attached checkout, locks the hosted project instead.')
  .option('-y, --yes', 'skip the confirmation prompt (for scripts / CI)')
  .option('--subsystem <id>', 'only lock specs in the specified subsystem')
  .option('--no-recursive', 'do not recursively validate subprojects')
  .action(async (opts) => {
    await lockCommand(opts);
  });

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

program
  .command('validate')
  .description('Validate the project configuration and the SDD Spec Tree')
  .option('--ci', 'treat warnings as errors for CI pipelines')
  .option('--subsystem <id>', 'only validate the specified subsystem (granular)')
  .option('--no-recursive', 'do not recursively validate subprojects')
  .action(async (opts) => {
    await validateCommand(opts);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show a hierarchical completeness graph of the SDD Spec Tree')
  .option('--subsystem <id>', 'only show status for the specified subsystem')
  .option('--no-recursive', 'do not recursively show status for subprojects')
  .action(async (opts) => {
    await statusCommand(opts);
  });

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('Health check: flags stale generated guides/skills, an unregistered MCP server, and spec-tree issues')
  .option('--fix', 'regenerate stale in-project guides/context/skills and register the MCP server')
  .action(async (opts) => {
    await runDoctor({ fix: opts.fix });
  });

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------

// cli_runner dispatch for the pack-ecosystem commands — consistent with
// runValidate/runGenerate/…: the orchestrator routes each subcommand to its
// command adapter rather than the commander action calling the adapter inline.
async function runRules(): Promise<void> {
  await listRules();
}
async function runPatterns(): Promise<void> {
  await listPatterns();
}
async function runVariants(): Promise<void> {
  await listVariants();
}
async function runPacks(action: string, arg?: string, opts: { global?: boolean } = {}): Promise<void> {
  if (action === 'add') await addPack(arg!, opts);
  else if (action === 'list') await listPacks();
  else if (action === 'remove') await removePack(arg!, opts);
}
async function runPack(
  action: string,
  arg?: string,
  opts: { global?: boolean; kind?: string; dir?: string; skill?: boolean; out?: string; source?: string; bundle?: boolean; pin?: boolean; all?: boolean } = {},
): Promise<void> {
  if (action === 'init') await initPack(arg!, { kind: opts.kind === 'code' ? 'code' : 'declarative', dir: opts.dir, skill: opts.skill });
  else if (action === 'build') await buildPack(arg ?? '.', { out: opts.out });
  else if (action === 'add') await addPack(arg!, { global: opts.global });
  else if (action === 'list') await listPacks();
  else if (action === 'remove') await removePack(arg!, { global: opts.global });
  else if (action === 'install') await installPack(arg!);
  else if (action === 'uninstall') await uninstallStorePack(arg!);
  else if (action === 'which') await whichPack(arg!);
  else if (action === 'use') await usePack(arg!, { source: opts.source, bundle: opts.bundle, pin: opts.pin });
  else if (action === 'unuse') await unusePack(arg!);
  else if (action === 'bundle') await bundlePack(arg, { all: opts.all });
  else if (action === 'sync') await syncPacks();
  else throw new WaironError('unknown pack action (expected init | build | install | uninstall | which | use | unuse | bundle | sync | add | list | remove)');
}

const rulesCmd = program
  .command('rules')
  .description('The SDD conformance rule registry (the architecture linter)');

rulesCmd
  .command('list')
  .alias('ls')
  .description('List every conformance rule, its issue codes, default severities, and project overrides')
  .action(async () => {
    await runRules();
  });

// ---------------------------------------------------------------------------
// pack — author, install, and manage extension packs (unified command family)
// ---------------------------------------------------------------------------

const packCmd = program
  .command('pack')
  .description('Author and install extension packs: init a pack project, build a .wpack, add/list/remove');

packCmd
  .command('init <name>')
  .description('Scaffold a new pack project (declarative or code) via the SDK into a target directory')
  .option('--kind <kind>', 'pack variant: declarative | code', 'declarative')
  .option('--dir <path>', 'target directory (default ./<name>)')
  .option('--skill', 'include a skills/<id>/SKILL.md stub')
  .action(async (name: string, opts) => {
    await runPack('init', name, { kind: opts.kind, dir: opts.dir, skill: opts.skill });
  });

packCmd
  .command('build [source]')
  .description('Build an installable .wpack archive from a pack directory (default .) via the SDK')
  .option('--out <file>', 'output file path (default <name>-<version>.wpack)')
  .action(async (source: string | undefined, opts) => {
    await runPack('build', source, { out: opts.out });
  });

packCmd
  .command('install <source>')
  .description('Install a pack into this wairon install\'s store (a .wpack/.zip or a pack directory). Applies to NOTHING until a project selects it')
  .action(async (source: string) => {
    await runPack('install', source);
  });

packCmd
  .command('uninstall <name>')
  .description('Remove a pack from the store (name or name@version; every version when unversioned)')
  .action(async (name: string) => {
    await runPack('uninstall', name);
  });

packCmd
  .command('use <name>')
  .description('Select an installed pack for THIS project (name or name@version), recording it in .wai/project.yaml')
  .option('--source <url>', 'record an explicit fetch URL (overrides the origin recorded at install time)')
  .option('--pin', 'freeze the resolved version and its content digest instead of tracking latest installed')
  .option('--bundle', 'mark for committing a copy under .wai/packs/ so the repo needs no machine setup')
  .action(async (name: string, opts) => {
    await runPack('use', name, { source: opts.source, bundle: opts.bundle, pin: opts.pin });
  });

packCmd
  .command('sync')
  .description('Install every declared-but-missing pack from the source its selection records — the one command a fresh machine or CI runner needs')
  .action(async () => {
    await runPack('sync');
  });

packCmd
  .command('bundle [name]')
  .description('Commit a copy of a selected pack under .wai/packs/ so a clone and CI need no pack store (default: every selection marked --bundle)')
  .option('--all', 'bundle every pack this project selects')
  .action(async (name: string | undefined, opts) => {
    await runPack('bundle', name, { all: opts.all });
  });

packCmd
  .command('unuse <name>')
  .description('Deselect a pack for this project (it stays installed in the store)')
  .action(async (name: string) => {
    await runPack('unuse', name);
  });

packCmd
  .command('which <name>')
  .description('Identify which installed pack a name resolves to: version, path, content digest, and recorded origin')
  .action(async (name: string) => {
    await runPack('which', name);
  });

packCmd
  .command('add <source>')
  .description('Install a pack: a .wpack/.zip is extracted + registered, a plain file/dir is vendored; --global installs machine-wide')
  .option('-g, --global', 'install into the global packs folder (WAIRON_PACKS_DIR or ~/.wairon/packs)')
  .action(async (source: string, opts) => {
    await runPack('add', source, { global: opts.global });
  });

packCmd
  .command('list')
  .alias('ls')
  .description('List global and project extension packs with what they provide')
  .action(async () => {
    await runPack('list');
  });

packCmd
  .command('remove <name>')
  .alias('rm')
  .description('Deregister a pack by name (deletes vendored files under .wai/packs); --global removes a machine-wide pack')
  .option('-g, --global', 'remove from the global packs folder')
  .action(async (name: string, opts) => {
    await runPack('remove', name, { global: opts.global });
  });

// ---------------------------------------------------------------------------
// packs — DEPRECATED alias of `wairon pack` (add | list | remove). Kept working;
// each subcommand prints a one-line deprecation notice then delegates.
// ---------------------------------------------------------------------------

const packsCmd = program
  .command('packs')
  .description('[deprecated] alias of `wairon pack` — extension packs: profiles, language tables, and conformance rules');

packsCmd
  .command('list')
  .alias('ls')
  .description('List global and project extension packs with what they provide')
  .action(async () => {
    logger.warn('`wairon packs` is deprecated — use `wairon pack list`.');
    await runPacks('list');
  });

packsCmd
  .command('add <source>')
  .description('Vendor a pack into the project (.wai/packs/ + project.yaml), or install machine-wide with --global')
  .option('-g, --global', 'install into the global packs folder (WAIRON_PACKS_DIR or ~/.wairon/packs)')
  .action(async (source, opts) => {
    logger.warn('`wairon packs` is deprecated — use `wairon pack add`.');
    await runPacks('add', source, { global: opts.global });
  });

packsCmd
  .command('remove <name>')
  .alias('rm')
  .description('Deregister a pack by name (deletes vendored files under .wai/packs); --global removes a machine-wide pack')
  .option('-g, --global', 'remove from the global packs folder')
  .action(async (name, opts) => {
    logger.warn('`wairon packs` is deprecated — use `wairon pack remove`.');
    await runPacks('remove', name, { global: opts.global });
  });

// ---------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------

const patternsCmd = program
  .command('patterns')
  .description('Reusable, versioned architecture patterns declared by extension packs');

patternsCmd
  .command('list')
  .alias('ls')
  .description('List the reusable pattern definitions declared by loaded packs (id, version, source pack)')
  .action(async () => {
    await runPatterns();
  });

// ---------------------------------------------------------------------------
// variants
// ---------------------------------------------------------------------------

const variantsCmd = program
  .command('variants')
  .description('Component variants — base-anchored kinds + implementation guidance (a dynamic layer on top of packs)');

variantsCmd
  .command('list')
  .alias('ls')
  .description('List the component variants in the registry (global + project) with their base and guidance')
  .action(async () => {
    await runVariants();
  });

// ---------------------------------------------------------------------------
// diagram
// ---------------------------------------------------------------------------

program
  .command('diagram')
  .description('Generate architecture diagrams from the spec tree — interactive canvas by default; Mermaid / draw.io / Excalidraw via --format')
  .option('--subsystem <id>', 'scope the component diagram to one subsystem (plus its external neighbors)')
  .option('--sequence <component:method>', 'emit a sequence diagram derived from the method\'s L5 narrative')
  .option('--depth <n>', 'max call-expansion depth for sequence diagrams (default 3)', (v) => parseInt(v, 10))
  .option('--all', 'write the full diagram set: system, per-subsystem, entrypoint sequences, and the interactive canvas')
  .option('--canvas', 'emit the interactive self-contained HTML canvas (pan/zoom, collapse boundaries, detail panel, issue overlay)')
  .option('--drawio', 'emit an editable draw.io / diagrams.net file (same layout as the canvas)')
  .option('--excalidraw', 'emit an editable Excalidraw scene (same layout as the canvas)')
  .option('--format <fmt>', 'alias for the flags above: mermaid | canvas | drawio | excalidraw')
  .option('--out <path>', 'write to a file (or directory with --all; default .wai/docs/diagrams) instead of stdout')
  .action(async (opts) => {
    await runDiagram({
      subsystem: opts.subsystem,
      sequence: opts.sequence,
      depth: opts.depth,
      all: opts.all,
      canvas: opts.canvas,
      drawio: opts.drawio,
      excalidraw: opts.excalidraw,
      format: opts.format,
      out: opts.out,
    });
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

program
  .command('list')
  .alias('ls')
  .description('List all dynamic agents resolved from the spec tree')
  .action(async () => {
    await runList();
  });

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

program
  .command('show <id>')
  .description('Show details of a specific agent resolved from the spec tree')
  .action(async (id: string) => {
    await runShow(id);
  });

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
async function runAgent(action: string, id: string): Promise<void> {
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
        for (const line of describeBudget(brief.profile, brief.budget)) {
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
      const description = loadRegistry().agents.find((a) => a.id === id)?.description ?? brief.name;
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

program
  .command('agent <action> <id>')
  .description('Live agent briefs: `brief <id>` prints the live delegation brief; `customize <id>` scaffolds the user-owned guidance file .wai/agents/<id>.md')
  .action(async (action: string, id: string) => {
    await runAgent(action, id);
  });

// ---------------------------------------------------------------------------
// aliases
// ---------------------------------------------------------------------------

const aliasesCmd = program
  .command('aliases')
  .description('Manage short command aliases (wai, …)');

aliasesCmd
  .command('list')
  .alias('ls')
  .description('Show all supported aliases and their current status')
  .action(async () => {
    await runAliasesList();
  });

aliasesCmd
  .command('enable <name>')
  .description('Create alias symlink / wrapper')
  .action(async (name: string) => {
    await runAliasesEnable(name);
  });

aliasesCmd
  .command('disable <name>')
  .description('Remove alias and opt out of future re-creation')
  .action(async (name: string) => {
    await runAliasesDisable(name);
  });

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

const mcpCmd = program
  .command('mcp')
  .description('MCP (Model Context Protocol) server for wairon — lets AI tools query and manage this project');

mcpCmd
  .command('serve')
  .description('Start the wairon MCP server (stdio transport — use in mcpServers config)')
  .action(async () => {
    await runMcpServe();
  });

mcpCmd
  .command('install')
  .description('Register the wairon MCP server in the Claude Code settings.json or Antigravity mcp_config.json')
  .option('--global', 'install into the global/home config instead of the project (respects CLAUDE_CONFIG_DIR / GEMINI_CONFIG_DIR)')
  .option('--config-dir <path>', "explicit config dir to install into (validated for the agent; requires --backend). Reliable alternative to relying on the shell's CLAUDE_CONFIG_DIR")
  .option('--backend <type>', 'target AI assistant: claude | gemini (aliases: agy, antigravity → gemini)')
  .option('--hosted <url>', 'register a HOSTED entry against this instance instead of the local stdio server')
  .option('--project <id>', 'hosted: the project the agent should be bound to')
  .option('--token <token>', 'hosted: the bearer to carry (else the credential stored by `wairon login`)')
  .action(async (opts) => {
    // Resolve the credential HERE (the config adapter may not read the
    // credential store) so `wairon login` once is enough to wire an agent.
    const hostedToken = opts.hosted
      ? (opts.token ?? storedCredentialFor(String(opts.hosted).replace(/\/+$/, '')) ?? undefined)
      : undefined;
    await runMcpInstall({
      global: opts.global,
      configDir: opts.configDir,
      backend: opts.backend,
      hostedUrl: opts.hosted,
      hostedProject: opts.project,
      hostedToken,
    });
  });

mcpCmd
  .command('status')
  .description('Show whether the wairon MCP server is registered in Claude Code and Antigravity settings')
  .action(async () => {
    await runMcpStatus();
  });

// ---------------------------------------------------------------------------
// produce  — project the local project to a producer target (sdd_producers)
// ---------------------------------------------------------------------------

program
  .command('produce <target>')
  .description('project the local project\'s specs to a producer target (notion | miro)')
  .option('--page <id>', 'parent page/board id in the target')
  .option('--token <token>', 'integration token (else env, else interactive prompt)')
  .action(async (target: string, opts) => {
    await runProduce(target, { page: opts.page, token: opts.token });
  });

// ---------------------------------------------------------------------------
// surface — Public Surface Exchange (sdd_surfaces)
// ---------------------------------------------------------------------------

program
  .command('surface <action>')
  .description('public surface exchange: export | import | list | generate-children | externals')
  .option('--audience <level>', 'export ceiling: project | department | instance | partner | external (default instance)')
  .option('--format <fmt>', 'export format: native | openapi (default native)')
  .option('--out <path>', 'export output path (else print)')
  .option('--portal <id>', 'export: select one portal\'s OpenAPI spec (a multi-portal project renders one document per portal)')
  .option('--source <path>', 'import: the surface document (native snapshot YAML or OpenAPI)')
  .option('--origin <origin>', 'import provenance: exchanged | authored (default authored)')
  .action(async (action: string, opts) => {
    await runSurface(action, {
      audience: opts.audience,
      format: opts.format,
      out: opts.out,
      source: opts.source,
      origin: opts.origin,
      portal: opts.portal,
    });
  });

// ---------------------------------------------------------------------------
// remote — migrate a spec tree between this checkout and a hosted instance
// ---------------------------------------------------------------------------

program
  .command('login <url>')
  .description('store a bearer credential for a hosted instance on this machine')
  .option('--token <token>', 'the bearer credential (else WAIRON_REMOTE_TOKEN) — mint one in the hosted UI under Tokens')
  .option('--project <id>', 'verify the credential against this project before storing it')
  .action(async (url: string, opts) => {
    await runLogin(url, { token: opts.token, project: opts.project });
  });

program
  .command('logout [url]')
  .description('forget a stored credential for a hosted instance (local only — does NOT revoke it), or list what is stored')
  .action(async (url: string | undefined) => {
    await runLogout(url, {});
  });

program
  .command('remote <action>')
  .description('hosted instance: push | pull (migrate a spec tree) · attach | detach | status (bind this checkout)')
  .option('--url <url>', 'hosted instance base URL (else WAIRON_REMOTE_URL)')
  .option('--project <id>', 'hosted project id, optionally qualified as project::subsystem (else WAIRON_REMOTE_PROJECT)')
  .option('--token <token>', 'bearer credential (else WAIRON_REMOTE_TOKEN) — mint one in the hosted UI under Tokens')
  .option('--unit <id>', 'push: create the destination project first, owned by this organization unit')
  .option('--force', 'replace an authored spec tree at the destination (it is backed up first)')
  .option('--include-derived', 'push: pack regenerable artifacts (diagrams, generated topology) too')
  .option('--archive <path>', 'also write the transferred archive to this path (file or directory)')
  .option('--dir <path>', 'pull: the local project root to import into (default: this project)')
  .action(async (action: string, opts) => {
    await runRemote(action, {
      url: opts.url,
      project: opts.project,
      token: opts.token,
      unit: opts.unit,
      force: opts.force,
      includeDerived: opts.includeDerived,
      archive: opts.archive,
      dir: opts.dir,
    });
  });

// ---------------------------------------------------------------------------
// serve  — run the hosting server (sdd_host)
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Run the wairon hosting server: HTTP MCP for many isolated projects + admin API')
  .option('--host <host>', 'data-plane bind host (default 0.0.0.0)')
  .option('--port <port>', 'data-plane port (default 8080)')
  .option('--admin-host <host>', 'admin-plane bind host (default 127.0.0.1)')
  .option('--admin-port <port>', 'admin-plane port (default 8081)')
  .option('--data-dir <path>', 'data root holding projects/ and auth/ (default WAIRON_DATA_DIR or ~/.wairon/data)')
  .option('--no-auth', 'disable data-plane auth (trusted networks only)')
  .action(async (opts) => {
    await runServe({
      host: opts.host,
      port: opts.port,
      adminHost: opts.adminHost,
      adminPort: opts.adminPort,
      dataDir: opts.dataDir,
      noAuth: !opts.auth,
    });
  });

// ---------------------------------------------------------------------------
// dev  — local single-project developer server (sdd_host)
// ---------------------------------------------------------------------------

program
  .command('dev')
  .description('Run a local single-project dev server: the wairon web UI over the current project, no login/tenancy (loopback, dev only)')
  .option('--port <port>', 'web UI port (default 8080)')
  .option('--open', 'open the dev server in your browser')
  .action(async (opts) => {
    await runDev({ port: opts.port, open: opts.open });
  });

// ---------------------------------------------------------------------------
// host  — administer the hosting server (sdd_host control plane)
// ---------------------------------------------------------------------------

const hostCmd = program
  .command('host')
  .description('Administer the hosting server: projects, API keys, and state-scoped lock/promote');

hostCmd
  .command('project <action>')
  .description('create | list | destroy a hosted project')
  .option('--id <id>', 'project id (for create/destroy)')
  .option('--unit <unitId>', 'owner organization unit (REQUIRED for create — every project is placed at creation)')
  .option('--data-dir <path>', 'data root (default WAIRON_DATA_DIR or ~/.wairon/data)')
  .action(async (action: string, opts) => {
    await runHostProject(action, { id: opts.id, unit: opts.unit, dataDir: opts.dataDir });
  });

hostCmd
  .command('demo')
  .description('provision a project seeded with a rich example spec tree, so the canvas has content to render')
  .option('--id <id>', 'project id', 'demo')
  .option('--unit <unitId>', 'owner unit id (created if absent)', 'demo')
  .option('--force', 'destroy and reseed the project if it already exists')
  .option('--data-dir <path>', 'data root (default WAIRON_DATA_DIR or ~/.wairon/data)')
  .action(async (opts) => {
    await runHostDemo({ id: opts.id, unit: opts.unit, force: opts.force, dataDir: opts.dataDir });
  });

hostCmd
  .command('unit <action>')
  .description('create an organization unit (projects are placed into units at creation)')
  .option('--slug <slug>', 'unit slug (REQUIRED for create; a root unit\'s id IS its slug)')
  .option('--name <name>', 'display name (defaults to the slug)')
  .option('--kind <kind>', 'unit kind (business_entity | department | team | …)', 'team')
  .option('--parent <unitId>', 'qualified id of the parent unit (omit for a root unit)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostUnit(action, { slug: opts.slug, name: opts.name, kind: opts.kind, parent: opts.parent, dataDir: opts.dataDir });
  });

hostCmd
  .command('doctor')
  .description('migrate a hosted data dir to the permission model (grants → assignments, owners, unit ids, placements); dry-run without --fix')
  .option('--fix', 'apply the migration (REQUIRED at rollout — legacy users/tokens otherwise resolve to zero permissions)')
  .option('--data-dir <path>', 'data root')
  .action(async (opts) => {
    await runHostDoctor({ fix: opts.fix, dataDir: opts.dataDir });
  });

hostCmd
  .command('permission <action>')
  .description('set | list | remove a permission assignment (the subject×scope×capability grid)')
  .option('--user <userId>', 'the subject user id (for set; optional filter for list)')
  .option('--capability <capability>', 'project:read | project:create | project:write | project:admin | approval:decide')
  .option('--value <value>', 'yes | approval | no | inherit', 'yes')
  .option('--project <id>', 'anchor the assignment at a project scope')
  .option('--unit <unitId>', 'anchor the assignment at an organization-unit scope')
  .option('--instance', 'anchor the assignment at the instance scope (the default)')
  .option('--id <assignmentId>', 'assignment id (for remove)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostPermission(action, {
      user: opts.user,
      capability: opts.capability,
      value: opts.value,
      project: opts.project,
      unit: opts.unit,
      instance: opts.instance,
      id: opts.id,
      dataDir: opts.dataDir,
    });
  });

hostCmd
  .command('key <action>')
  .description('mint | list | revoke an API key')
  .option('--project <id>', 'project id or * (for mint/list)')
  .option('--owner <userId>', 'mint an owner-bound token acting as this user\'s live permission (assignment model)')
  .option('--label <label>', 'display label for an owner-bound token')
  .option('--role <role>', 'editor | admin (legacy ownerless mint)', 'editor')
  .option('--id <id>', 'key id (for revoke)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostKey(action, { project: opts.project, owner: opts.owner, label: opts.label, role: opts.role, id: opts.id, dataDir: opts.dataDir });
  });

hostCmd
  .command('lock')
  .description('validate-as-complete and write the state-scoped lock record for a hosted project')
  .requiredOption('--project <id>', 'project id')
  .option('--data-dir <path>', 'data root')
  .action(async (opts) => {
    await runHostLock({ project: opts.project, dataDir: opts.dataDir });
  });

hostCmd
  .command('promote')
  .description('promote a locked project after re-checking its StateId (never merges to production)')
  .requiredOption('--project <id>', 'project id')
  .option('--data-dir <path>', 'data root')
  .action(async (opts) => {
    await runHostPromote({ project: opts.project, dataDir: opts.dataDir });
  });

hostCmd
  .command('git <action>')
  .description('enable | disable | sync | commit | status | sync-config — bind a project to its REAL repo (wairon commits ONLY .wai/)')
  .option('--project <id>', 'project id')
  .option('--remote <url>', 'git remote URL (for enable)')
  .option('--branch <name>', 'default branch PRs target (for enable)', 'main')
  .option('--subsystem <id>', 'narrow a commit to .wai/specs/<subsystem>/ (staging convenience — history stays per-repo)')
  .option('-m, --message <message>', 'commit message (for commit)')
  .option('--interval <minutes>', 'periodic-sync interval in minutes (for sync-config; omit to disable)')
  .option('--no-skip-if-clean', 'commit on every periodic tick even when the scoped path is clean (for sync-config)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostGit(action, {
      project: opts.project,
      remote: opts.remote,
      branch: opts.branch,
      subsystem: opts.subsystem,
      message: opts.message,
      interval: opts.interval,
      skipIfClean: opts.skipIfClean,
      dataDir: opts.dataDir,
    });
  });

hostCmd
  .command('producer <action>')
  .description('configure | produce | remove | list producers (project a hosted project to Notion / Miro)')
  .option('--project <id>', 'project id')
  .option('--target <t>', 'producer target', 'notion')
  .option('--page <id>', 'parent page/board id (for configure)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostProducer(action, { project: opts.project, target: opts.target, page: opts.page, dataDir: opts.dataDir });
  });

hostCmd
  .command('packs <action>')
  .description('list | install | remove extension packs for the server (global) or a hosted --project (declarative packs only; code packs install via the filesystem)')
  .option('--project <id>', 'target a hosted project (omit for server-global)')
  .option('--name <name>', 'pack name / file stem')
  .option('--file <path>', 'declarative pack YAML file (for install)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostPacks(action, { project: opts.project, name: opts.name, file: opts.file, dataDir: opts.dataDir });
  });

hostCmd
  .command('secret <action>')
  .description('set | list integration secrets at runtime (git-token, notion-token, miro-token, signing-secret) — no restart')
  .option('--key <name>', 'secret key')
  .option('--value <secret>', 'secret value (for set)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostSecret(action, { key: opts.key, value: opts.value, dataDir: opts.dataDir });
  });

// ---------------------------------------------------------------------------
// subsystem — create/relocate external (chained) subprojects
// ---------------------------------------------------------------------------

const subsystemCmd = program
  .command('subsystem')
  .description('Manage subsystems — create and relocate external (chained) subprojects');

subsystemCmd
  .command('add <id>')
  .description('Add an external subsystem: scaffold a child wairon project at --project-path and wire it into this project')
  .requiredOption('--project-path <dir>', 'relative path where the child subproject lives / will be created')
  .option('--name <name>', 'human-readable display name (defaults to id)')
  .action(async (id: string, opts) => {
    await runSubsystemAdd(id, { projectPath: opts.projectPath, name: opts.name });
  });

subsystemCmd
  .command('move <id>')
  .description('Relocate an external subsystem: move its subproject directory and update its projectPath link')
  .requiredOption('--project-path <dir>', 'the new relative path for the subproject directory')
  .action(async (id: string, opts) => {
    await runSubsystemMove(id, { projectPath: opts.projectPath });
  });

subsystemCmd
  .command('externalize <id>')
  .description('Migrate an internal subsystem out into a standalone subproject at --project-path (moves specs, rewrites references; you move the source code)')
  .requiredOption('--project-path <dir>', 'destination directory for the subproject')
  .action(async (id: string, opts) => {
    await runSubsystemExternalize(id, { projectPath: opts.projectPath });
  });

subsystemCmd
  .command('internalize <id>')
  .description('Migrate an external subsystem back into this project (moves specs back, deletes its child .wai project)')
  .action(async (id: string) => {
    await runSubsystemInternalize(id);
  });

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

program
  .command('update')
  .description('Check and install the latest wairon release')
  .option('--check', 'only check for updates without installing')
  .option('--channel <name>', 'switch release channel (stable|beta|preview|dev)')
  .action(async (opts) => {
    await runUpdate({ check: opts.check, channel: opts.channel });
  });

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------

const domainsCmd = program
  .command('domains')
  .description('List domains (subsystem-derived) and manage free-standing ones');

domainsCmd
  .command('list')
  .alias('ls')
  .description('List all tracked domains')
  .action(async () => {
    await runDomainsList();
  });

domainsCmd
  .command('scan')
  .description('Scan process workspace for new domain candidates')
  .option('--add', 'interactively select and add candidates')
  .action(async (opts) => {
    await runDomainsScan({ add: opts.add });
  });

domainsCmd
  .command('add')
  .description('Manually register a new domain')
  .option('--path <path>', 'relative path to the domain directory')
  .option('--id <id>', 'stable identifier for the domain')
  .action(async (opts) => {
    await runDomainsAdd({ path: opts.path, id: opts.id });
  });

domainsCmd
  .command('remove <id>')
  .alias('rm')
  .description('Remove a free-standing domain from .wai/topology.yaml')
  .action(async (id: string) => {
    await runDomainsRemove(id);
  });

// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------

const skillsCmd = program
  .command('skills')
  .description('Manage the SDD skills installed into your AI tools');

skillsCmd
  .command('list')
  .alias('ls')
  .description('List the built-in SDD skills')
  .action(async () => {
    await runSkillsList();
  });

skillsCmd
  .command('install')
  .alias('sync')
  .description('Install/refresh the SDD skills into each active target tool')
  .action(async () => {
    await runSkillsInstall();
  });

// ---------------------------------------------------------------------------
// Main execution
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof WaironError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main();
