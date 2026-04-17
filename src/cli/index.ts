#!/usr/bin/env node

import { Command } from 'commander';
import { WAIRON_VERSION } from '../config/defaults.js';
import { logger, setLogLevel } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import {
  runAliasesList,
  runAliasesEnable,
  runAliasesDisable,
  runInit,
  runGenerate,
  runValidate,
  runList,
  runShow,
  runAnalyze,
  runSuggestTopology,
  runCreateAgent,
  runCreateBundle,
  runDeprecate,
  runSplit,
  runMerge,
  runDelegate,
  runJobsList,
  runJobsShow,
  runJobsClean,
  runDomainsList,
  runDomainsScan,
  runDomainsAdd,
  runDomainsRemove,
  runUpdate,
  runTemplatesList,
  runBundlesList,
  runTargetsList,
  runTargetsAdd,
  runTargetsRemove,
  runTargetsEnable,
  runTargetsDisable,
  runScaffoldDomains,
  runProfilesList,
  runProfilesCreate,
  runProfilesSetup,
  runProfilesUse,
  runProfilesSetGlobal,
  runProfilesDelete,
  runProfilesShow,
  runContextInit,
  runContextEdit,
  runContextSync,
  runContextShow,
  runRunStart,
  runRunStatus,
  runRunList,
  runRunClean,
  cleanStaleBinary,
} from '../commands/index.js';

// Clean up any .old binary left over from a previous Windows self-update
cleanStaleBinary();

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('wairon')
  .description('SYW Waffle AIron — manage AI coding agent topology across projects')
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
  .description('Initialize wairon in the current project (or rescan if already initialized)')
  .option('-y, --yes', 'use defaults without interactive prompts')
  .action(async (opts) => {
    await runInit({ yes: opts.yes });
  });

// ---------------------------------------------------------------------------
// generate
// ---------------------------------------------------------------------------

program
  .command('generate')
  .description('Generate agent output files from the registry')
  .option('--target <type>', 'limit to a specific target (claude|gemini|custom)')
  .option('--domain <id>', 'limit to agents in a single domain (use "root" for root agents)')
  .option('--domains <ids>', 'limit to a comma-separated list of domain ids')
  .option('--root', 'only generate root-level agents (no domain)')
  .option('--dry-run', 'preview what would be generated without writing files')
  .action(async (opts) => {
    await runGenerate({
      target: opts.target,
      domain: opts.domain,
      domains: opts.domains,
      root: opts.root,
      dryRun: opts.dryRun,
    });
  });

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

program
  .command('validate')
  .description('Validate project config and agent registry')
  .option('--ci', 'treat warnings as errors and exit 1 (for CI pipelines)')
  .action(async (opts) => {
    await runValidate({ ci: opts.ci });
  });

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

program
  .command('list')
  .alias('ls')
  .description('List all agents in the registry')
  .action(async () => {
    await runList();
  });

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

program
  .command('show <agent-id>')
  .description('Show full details of a single agent')
  .action(async (agentId: string) => {
    await runShow(agentId);
  });

// ---------------------------------------------------------------------------
// templates
// ---------------------------------------------------------------------------

const templatesCmd = program
  .command('templates')
  .description('Manage and browse agent templates');

templatesCmd
  .command('list')
  .alias('ls')
  .description('List all available templates (built-in, global, project-local)')
  .action(async () => {
    await runTemplatesList();
  });

// ---------------------------------------------------------------------------
// bundles
// ---------------------------------------------------------------------------

const bundlesCmd = program
  .command('bundles')
  .description('Manage and browse agent bundles');

bundlesCmd
  .command('list')
  .alias('ls')
  .description('List all available bundles (built-in + project-local)')
  .action(async () => {
    await runBundlesList();
  });

// ---------------------------------------------------------------------------
// targets
// ---------------------------------------------------------------------------

const targetsCmd = program
  .command('targets')
  .description('Manage output targets (Claude Code, Gemini CLI, custom)');

targetsCmd
  .command('list')
  .alias('ls')
  .description('List all configured targets and their status')
  .action(async () => {
    await runTargetsList();
  });

targetsCmd
  .command('add')
  .description('Add a new output target to this project')
  .action(async () => {
    await runTargetsAdd();
  });

targetsCmd
  .command('remove <key>')
  .description('Remove a target (use the type or label shown in `targets list`)')
  .action(async (key: string) => {
    await runTargetsRemove(key);
  });

targetsCmd
  .command('enable <key>')
  .description('Enable a disabled target')
  .action(async (key: string) => {
    await runTargetsEnable(key);
  });

targetsCmd
  .command('disable <key>')
  .description('Disable a target without removing it')
  .action(async (key: string) => {
    await runTargetsDisable(key);
  });

// ---------------------------------------------------------------------------
// delegate
// ---------------------------------------------------------------------------

program
  .command('delegate <domain-id>')
  .description('Spawn an AI session in a domain directory with a delegated task')
  .option('-p, --prompt <text>', 'task description for the sub-agent')
  .option('--backend <type>', 'AI backend to use: claude (default), gemini, ollama, custom')
  .option('--model <name>', 'model name for ollama/custom backends')
  .option('--async', 'create job and return immediately without spawning a session')
  .option('--context-file <path>', 'add a context file to the job (repeatable)', collect, [])
  .option('--note <text>', 'add a context note to the job (repeatable)', collect, [])
  .action(async (domainId: string, opts) => {
    await runDelegate(domainId, {
      prompt: opts.prompt,
      backend: opts.backend,
      model: opts.model,
      async: opts.async,
      contextFiles: opts.contextFile,
      notes: opts.note,
    });
  });

// ---------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------

const jobsCmd = program
  .command('jobs')
  .description('Inspect and manage delegated job history');

jobsCmd
  .command('list')
  .alias('ls')
  .description('List all jobs')
  .option('--domain <id>', 'filter by domain')
  .option('--status <status>', 'filter by status (pending|running|completed|failed|abandoned)')
  .action(async (opts) => {
    await runJobsList({ domain: opts.domain, status: opts.status });
  });

jobsCmd
  .command('show <job-id>')
  .description('Show details and result for a job')
  .action(async (jobId: string) => {
    await runJobsShow(jobId);
  });

jobsCmd
  .command('clean')
  .description('Remove completed, failed, and abandoned jobs')
  .option('--all', 'also remove pending and running jobs')
  .action(async (opts) => {
    await runJobsClean({ all: opts.all });
  });

// ---------------------------------------------------------------------------
// domains
// ---------------------------------------------------------------------------

const domainsCmd = program
  .command('domains')
  .description('Manage project domains (submodules, repos, packages)');

domainsCmd
  .command('list')
  .alias('ls')
  .description('List all tracked domains')
  .action(async () => {
    await runDomainsList();
  });

domainsCmd
  .command('scan')
  .description('Scan for untracked domain candidates')
  .option('--add', 'interactively add discovered candidates')
  .action(async (opts) => {
    await runDomainsScan({ add: opts.add });
  });

domainsCmd
  .command('add')
  .description('Manually add a domain by path')
  .option('--path <dir>', 'domain directory (relative to project root)')
  .option('--id <id>', 'domain id')
  .action(async (opts) => {
    await runDomainsAdd({ path: opts.path, id: opts.id });
  });

domainsCmd
  .command('remove <id>')
  .description('Remove a domain from the registry')
  .action(async (id: string) => {
    await runDomainsRemove(id);
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
  .description('Enable an alias (creates symlink or .cmd wrapper in the install dir)')
  .action(async (name: string) => {
    await runAliasesEnable(name);
  });

aliasesCmd
  .command('disable <name>')
  .description('Disable an alias and remove its file from the install dir')
  .action(async (name: string) => {
    await runAliasesDisable(name);
  });

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

program
  .command('update')
  .description('Check for a newer version and update the binary')
  .option('--check', 'check for updates without installing (exit 1 if update available)')
  .option('--channel <channel>', 'set update channel: stable (default), beta, or preview')
  .action(async (opts) => {
    await runUpdate({ check: opts.check, channel: opts.channel });
  });

// ---------------------------------------------------------------------------
// scaffold-domains
// ---------------------------------------------------------------------------

program
  .command('scaffold-domains')
  .description('Create bundle agents for domains that do not have any agents yet')
  .option('--rescan', 'scan for new domain candidates first, then scaffold')
  .action(async (opts) => {
    await runScaffoldDomains({ rescan: opts.rescan });
  });

// ---------------------------------------------------------------------------
// profiles
// ---------------------------------------------------------------------------

const profilesCmd = program
  .command('profiles')
  .description('Manage work/personal profiles for AI tool command separation');

profilesCmd
  .command('list')
  .alias('ls')
  .description('List all profiles and their tool configurations')
  .action(async () => {
    await runProfilesList();
  });

profilesCmd
  .command('create')
  .description('Create a new profile interactively')
  .action(async () => {
    await runProfilesCreate();
  });

profilesCmd
  .command('setup <id>')
  .description('Create wrapper scripts and copy config dirs for a profile')
  .action(async (id: string) => {
    await runProfilesSetup(id);
  });

profilesCmd
  .command('use <id>')
  .description('Set the active profile for the current project')
  .action(async (id: string) => {
    await runProfilesUse(id);
  });

profilesCmd
  .command('set-global <id>')
  .description('Set the global default profile (used when no project profile is set)')
  .action(async (id: string) => {
    await runProfilesSetGlobal(id);
  });

profilesCmd
  .command('show <id>')
  .description('Show details of a profile')
  .action(async (id: string) => {
    await runProfilesShow(id);
  });

profilesCmd
  .command('delete <id>')
  .description('Delete a profile (wrapper scripts and config dirs are kept)')
  .action(async (id: string) => {
    await runProfilesDelete(id);
  });

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const runCmd = program
  .command('run')
  .description('Start and manage isolated AI sessions with per-session context workspaces');

runCmd
  .command('start')
  .description('Start an isolated AI session with a scaffolded workspace under .wai/runs/')
  .option('-p, --prompt <text>', 'task description for the session')
  .option('--domain <id>', 'scope session to a specific domain')
  .option('--backend <type>', 'AI backend: claude (default), gemini, ollama, custom')
  .option('--model <name>', 'model name for ollama/custom backends')
  .option('--label <text>', 'human-readable label for this run')
  .action(async (opts) => {
    await runRunStart({
      prompt:  opts.prompt,
      domain:  opts.domain,
      backend: opts.backend,
      model:   opts.model,
      label:   opts.label,
    });
  });

runCmd
  .command('status [run-id]')
  .description('Show status of all runs, or details of a specific run')
  .action(async (runId?: string) => {
    await runRunStatus(runId);
  });

runCmd
  .command('list')
  .alias('ls')
  .description('List all run workspaces')
  .action(async () => {
    await runRunList();
  });

runCmd
  .command('clean')
  .description('Remove completed, failed, and cancelled run workspaces')
  .option('--all', 'remove all run workspaces including pending/running')
  .option('--older <days>', 'only remove runs older than N days', parseInt)
  .action(async (opts) => {
    await runRunClean({ all: opts.all, olderThanDays: opts.older });
  });

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

const contextCmd = program
  .command('context')
  .description('Manage shared project context for all AI sessions');

contextCmd
  .command('init')
  .description('Set up the shared project context with a guided wizard')
  .action(async () => {
    await runContextInit();
  });

contextCmd
  .command('edit')
  .description('Open the project context in your editor')
  .option('--architecture', 'edit architecture.md instead of project.md')
  .action(async (opts) => {
    await runContextEdit({ architecture: opts.architecture });
  });

contextCmd
  .command('sync')
  .description('Regenerate domains.md and wairon-guide.md from the current registry')
  .action(async () => {
    await runContextSync();
  });

contextCmd
  .command('show')
  .description('Display the current shared project context')
  .action(async () => {
    await runContextShow();
  });

// ---------------------------------------------------------------------------
// analyze
// ---------------------------------------------------------------------------

program
  .command('analyze')
  .description('Analyze repository coverage and surface topology gaps')
  .action(async () => { await runAnalyze(); });

// ---------------------------------------------------------------------------
// create-agent
// ---------------------------------------------------------------------------

program
  .command('create-agent')
  .description('Interactively create a new agent from a template')
  .action(async () => { await runCreateAgent(); });

// ---------------------------------------------------------------------------
// create-bundle
// ---------------------------------------------------------------------------

program
  .command('create-bundle')
  .description('Scaffold multiple agents from a bundle definition')
  .option('--bundle <id>', 'bundle id to use')
  .option('--scope <name>', 'scope name (becomes agent id prefix)')
  .option('--dir <path>', 'scope directory relative to project root')
  .option('--dry-run', 'preview agents without writing to registry')
  .action(async (opts) => {
    await runCreateBundle({
      bundle: opts.bundle,
      scope: opts.scope,
      dir: opts.dir,
      dryRun: opts.dryRun,
    });
  });

// ---------------------------------------------------------------------------
// deprecate
// ---------------------------------------------------------------------------

program
  .command('deprecate <agent-id>')
  .description('Mark an agent as deprecated without removing it')
  .action(async (agentId: string) => { await runDeprecate(agentId); });

// ---------------------------------------------------------------------------
// suggest-topology
// ---------------------------------------------------------------------------

program
  .command('suggest-topology')
  .description('Suggest topology improvements based on current state')
  .action(async () => { await runSuggestTopology(); });

// ---------------------------------------------------------------------------
// split
// ---------------------------------------------------------------------------

program
  .command('split <agent-id>')
  .description('Split an agent into two or more focused agents')
  .action(async (agentId: string) => { await runSplit(agentId); });

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

program
  .command('merge <agent-id-1> <agent-id-2>')
  .description('Merge two agents into one')
  .action(async (idA: string, idB: string) => { await runMerge(idA, idB); });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Commander helper for repeatable options */
function collect(val: string, acc: string[]): string[] {
  acc.push(val);
  return acc;
}

// ---------------------------------------------------------------------------
// Error handling
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
