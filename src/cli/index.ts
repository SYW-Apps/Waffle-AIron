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
  runMcpServe,
  runMcpInstall,
  runMcpStatus,
  runUpdate,
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
  .action(async (opts) => {
    await runInit({ yes: opts.yes });
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
  .description('Validate the project configuration and the SDD Spec Tree')
  .option('--ci', 'treat warnings as errors for CI pipelines')
  .action(async (opts) => {
    await runValidate({ ci: opts.ci });
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
  .description('Register the wairon MCP server in the Claude Code settings.json')
  .option('--global', 'install in global ~/.claude/settings.json instead of project .claude/')
  .action(async (opts) => {
    await runMcpInstall({ global: opts.global });
  });

mcpCmd
  .command('status')
  .description('Show whether the wairon MCP server is registered in Claude Code settings')
  .action(async () => {
    await runMcpStatus();
  });

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

program
  .command('update')
  .description('Check and install the latest wairon release')
  .option('--check', 'only check for updates without installing')
  .option('--channel <name>', 'switch release channel (stable|beta|preview)')
  .action(async (opts) => {
    await runUpdate({ check: opts.check, channel: opts.channel });
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
