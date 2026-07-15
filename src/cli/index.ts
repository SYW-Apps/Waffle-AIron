#!/usr/bin/env node

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
import { runLock } from '../commands/lock.js';
import { runValidate } from '../commands/validate.js';
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
import { addPack, listPacks, removePack } from '../commands/packs.js';
import {
  runServe,
  runDev,
  runHostProject,
  runHostKey,
  runHostLock,
  runHostPromote,
  runHostGit,
  runHostProducer,
  runHostSecret,
  runHostPacks,
} from '../commands/host.js';
import { runProduce } from '../commands/produce.js';
import { runSurface } from '../commands/surface.js';
import {
  runSubsystemAdd,
  runSubsystemMove,
  runSubsystemExternalize,
  runSubsystemInternalize,
} from '../commands/subsystem.js';

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

program
  .command('lock')
  .description('Final check before implementation: validate the spec tree as complete, freeze all specs to complete, and (re)generate the agent topology — only if it validates')
  .option('-y, --yes', 'skip the confirmation prompt (for scripts / CI)')
  .option('--subsystem <id>', 'only lock specs in the specified subsystem')
  .option('--no-recursive', 'do not recursively validate subprojects')
  .action(async (opts) => {
    await runLock({ yes: opts.yes, subsystem: opts.subsystem, recursive: opts.recursive });
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
    await runValidate({ ci: opts.ci, subsystem: opts.subsystem, recursive: opts.recursive });
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
    await runStatus({ subsystem: opts.subsystem, recursive: opts.recursive });
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
// packs
// ---------------------------------------------------------------------------

const packsCmd = program
  .command('packs')
  .description('Extension packs: injected profiles, language tables, and conformance rules');

packsCmd
  .command('list')
  .alias('ls')
  .description('List global and project extension packs with what they provide')
  .action(async () => {
    await runPacks('list');
  });

packsCmd
  .command('add <source>')
  .description('Vendor a pack into the project (.wai/packs/ + project.yaml), or install machine-wide with --global')
  .option('-g, --global', 'install into the global packs folder (WAIRON_PACKS_DIR or ~/.wairon/packs)')
  .action(async (source, opts) => {
    await runPacks('add', source, { global: opts.global });
  });

packsCmd
  .command('remove <name>')
  .alias('rm')
  .description('Deregister a pack by name (deletes vendored files under .wai/packs); --global removes a machine-wide pack')
  .option('-g, --global', 'remove from the global packs folder')
  .action(async (name, opts) => {
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
  .description('public surface exchange: export | import | list | generate-children')
  .option('--audience <level>', 'export ceiling: project | department | instance | partner | external (default instance)')
  .option('--format <fmt>', 'export format: native | openapi (default native)')
  .option('--out <path>', 'export output path (else print)')
  .option('--source <path>', 'import: the surface document (native snapshot YAML or OpenAPI)')
  .option('--origin <origin>', 'import provenance: exchanged | authored (default authored)')
  .action(async (action: string, opts) => {
    await runSurface(action, {
      audience: opts.audience,
      format: opts.format,
      out: opts.out,
      source: opts.source,
      origin: opts.origin,
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
  .option('--data-dir <path>', 'data root (default WAIRON_DATA_DIR or ~/.wairon/data)')
  .action(async (action: string, opts) => {
    await runHostProject(action, { id: opts.id, dataDir: opts.dataDir });
  });

hostCmd
  .command('key <action>')
  .description('mint | list | revoke an API key')
  .option('--project <id>', 'project id or * (for mint/list)')
  .option('--role <role>', 'editor | admin (for mint)', 'editor')
  .option('--id <id>', 'key id (for revoke)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostKey(action, { project: opts.project, role: opts.role, id: opts.id, dataDir: opts.dataDir });
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
  .description('enable | disable | sync git backing (repo becomes the source of truth; lock opens a PR)')
  .option('--project <id>', 'project id')
  .option('--remote <url>', 'git remote URL (for enable)')
  .option('--branch <name>', 'default branch PRs target (for enable)', 'main')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostGit(action, { project: opts.project, remote: opts.remote, branch: opts.branch, dataDir: opts.dataDir });
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
