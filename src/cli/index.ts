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
  runLock,
  runValidate,
  runList,
  runShow,
  runMcpServe,
  runMcpInstall,
  runMcpStatus,
  runUpdate,
  runStatus,
  cleanStaleBinary,
  runDomainsList,
  runDomainsScan,
  runDomainsAdd,
  runDomainsRemove,
  runSkillsList,
  runSkillsInstall,
  runDoctor,
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
// lock
// ---------------------------------------------------------------------------

program
  .command('lock')
  .description('Final check before implementation: validate the spec tree as complete, freeze all specs to complete, and (re)generate the agent topology — only if it validates')
  .option('-y, --yes', 'skip the confirmation prompt (for scripts / CI)')
  .action(async (opts) => {
    await runLock({ yes: opts.yes });
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
// status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show a hierarchical completeness graph of the SDD Spec Tree')
  .action(async () => {
    await runStatus();
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
  .description('Register the wairon MCP server in the Claude Code settings.json or Antigravity mcp_config.json')
  .option('--global', 'install into the global/home config instead of the project (respects CLAUDE_CONFIG_DIR / GEMINI_CONFIG_DIR)')
  .option('--config-dir <path>', "explicit config dir to install into (validated for the agent; requires --backend). Reliable alternative to relying on the shell's CLAUDE_CONFIG_DIR")
  .option('--backend <type>', 'target AI assistant: claude | gemini (aliases: agy, antigravity → gemini)')
  .action(async (opts) => {
    await runMcpInstall({ global: opts.global, configDir: opts.configDir, backend: opts.backend });
  });

mcpCmd
  .command('status')
  .description('Show whether the wairon MCP server is registered in Claude Code and Antigravity settings')
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
