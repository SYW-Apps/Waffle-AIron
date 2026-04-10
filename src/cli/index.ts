#!/usr/bin/env node

import { Command } from 'commander';
import { WAFFAGENT_VERSION } from '../config/defaults.js';
import { logger, setLogLevel } from '../utils/logger.js';
import { WaffagentError } from '../utils/errors.js';
import {
  runAliasesList,
  runAliasesEnable,
  runAliasesDisable,
  runInit,
  runGenerate,
  runValidate,
  runList,
  runDelegate,
  runJobsList,
  runJobsShow,
  runJobsClean,
  runDomainsList,
  runDomainsScan,
  runDomainsAdd,
  runDomainsRemove,
  runUpdate,
  runAnalyze,
  runSuggestTopology,
  runCreateAgent,
  runCreateBundle,
  runSplit,
  runMerge,
} from '../commands/index.js';

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

const program = new Command();

program
  .name('waffagent')
  .description('SYW Waffler Agents — manage AI coding agent topology across projects')
  .version(WAFFAGENT_VERSION, '-v, --version')
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
  .description('Initialize waffagent in the current project (or rescan if already initialized)')
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
  .option('--target <type>', 'limit generation to a specific target (claude|gemini|custom)')
  .option('--domain <id>', 'limit generation to agents in a specific domain')
  .option('--dry-run', 'preview what would be generated without writing files')
  .action(async (opts) => {
    await runGenerate({ target: opts.target, dryRun: opts.dryRun });
  });

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

program
  .command('validate')
  .description('Validate project config and agent registry')
  .action(async () => {
    await runValidate();
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
  .description('Manage short command aliases (wagent, …)');

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
// Planned commands (stubs)
// ---------------------------------------------------------------------------

program
  .command('analyze')
  .description('[planned] Analyze the repository and suggest agent topology')
  .action(async () => { await runAnalyze(); });

program
  .command('suggest-topology')
  .description('[planned] Suggest topology improvements based on current state')
  .action(async () => { await runSuggestTopology(); });

program
  .command('create-agent')
  .description('[planned] Create a new agent from a template')
  .action(async () => { await runCreateAgent(); });

program
  .command('create-bundle')
  .description('[planned] Scaffold multiple agents from a bundle')
  .action(async () => { await runCreateBundle(); });

program
  .command('split')
  .description('[planned] Split an agent into more focused agents')
  .action(async () => { await runSplit(); });

program
  .command('merge')
  .description('[planned] Merge two agents into one')
  .action(async () => { await runMerge(); });

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
    if (err instanceof WaffagentError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

main();
