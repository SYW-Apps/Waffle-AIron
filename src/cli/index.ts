#!/usr/bin/env node

import { Command } from 'commander';
import { WAIRON_VERSION } from '../config/defaults.js';
import { logger, setLogLevel } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
// cli_portal — the `wairon` binary's inbound surface. This file parses argv
// and dispatches each command to cli_runner: the workflows in ./runner.ts and
// the command modules that realize cli_runner's methods. It reaches no adapter
// itself, so its import graph is the portal → runner edge and nothing else.
import {
  lockCommand,
  validateCommand,
  statusCommand,
  lockCheckCommand,
  runRules,
  runPatterns,
  runVariants,
  runPacks,
  runPack,
  runAgent,
  mcpInstallCommand,
  announceBinding,
  runNetworkFlows,
  runNetworkPolicy,
  runNetworkDiagram,
  runNetworkCheck,
  runNetworkWhy,
} from './runner.js';
import { runAliasesList, runAliasesEnable, runAliasesDisable } from '../commands/aliases.js';
import { runInit } from '../commands/init.js';
import { runGenerate } from '../commands/generate.js';
import { runList } from '../commands/list.js';
import { runShow } from '../commands/show.js';
import { runMcpServe, runMcpStatus } from '../commands/mcp.js';
import { runUpdate, cleanStaleBinary } from '../commands/update.js';
import { runDomainsList, runDomainsScan, runDomainsAdd, runDomainsRemove } from '../commands/domains.js';
import { runSkillsList, runSkillsInstall } from '../commands/skills.js';
import { runDoctor } from '../commands/doctor.js';
import { runDiagram } from '../commands/diagram.js';
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
  runHostGit,
  runHostProducer,
  runHostSecret,
  runHostPacks,
} from '../commands/host.js';
import { runProduce } from '../commands/produce.js';
import { runSurface, runExport } from '../commands/surface.js';
import { runExternals } from '../commands/externals.js';
import { runRemote, runLogin, runLogout } from '../commands/remote.js';
import {
  runMemberAdd,
  runMemberMove,
  runMemberAttach,
  runMemberDetach,
  runMemberAdopt,
  runMemberRenameAlias,
  runProjectRename,
  runSubsystemExternalize,
  runMemberInternalize,
  runMemberPromote,
  runMemberDemote,
  runMemberUpdate,
} from '../commands/subsystem.js';
import { showExecution, setExecutionTier } from '../commands/execution.js';

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
  .hook('preAction', (thisCommand, actionCommand) => {
    const opts = thisCommand.opts();
    if (opts.verbose) setLogLevel('verbose');
    else if (opts.silent) setLogLevel('silent');
    // Name the project the command is about to act on (stderr; silent under --silent).
    if (!opts.silent) {
      const names: string[] = [];
      for (let c: Command | null = actionCommand; c && c.parent; c = c.parent) names.unshift(c.name());
      announceBinding(names.join(' '));
    }
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
    // Each --pack is the runner's `pack add`, never the packs adapter called from here.
    for (const source of opts.pack as string[]) {
      await runPack('add', source, { global: false, yes: opts.yes });
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
  .option('--family', 'also generate each member\'s own layer in its own root (generate never cascades otherwise)')
  .option('--no-recurse', 'accepted for one release: generating only this project\'s layer is now the default')
  .option('--no-prune', 'do not remove wairon-managed agent files that are no longer in the topology')
  .option('--dry-run', 'preview what would be generated without writing files')
  .option('--global', 'also write (and prune) a target whose output directory resolves outside the project root, backing up each file replaced there')
  .action(async (opts) => {
    await runGenerate({
      global: opts.global === true,
      target: opts.target,
      domain: opts.domain,
      domains: opts.domains,
      root: opts.root,
      // --family walks the members explicitly; --no-recurse is the default now
      // and is accepted for one release. commander maps --no-prune to opts.prune === false.
      family: opts.family === true,
      prune: opts.prune,
      dryRun: opts.dryRun,
    });
  });

// ---------------------------------------------------------------------------
// lock-check · lock — the workflows are cli_runner's (src/cli/runner.ts)
// ---------------------------------------------------------------------------

program
  .command('lock-check')
  .description('Merge gate: is the design in this working tree the design that was approved? Compares the tree\'s gate identity against .wai/lock.json as it is in the working tree (in CI, the file committed in the checked-out revision; locally, an uncommitted record counts too). Exits 1 when the design moved past its approval; passes with a notice when the project never locked, unless --strict.')
  .option('--strict', 'also fail when nothing was ever approved, or when there is no spec tree at all')
  .action(async (opts) => {
    await lockCheckCommand(opts);
  });

program
  .command('lock')
  .description('Record human approval of the design: validate the spec tree as complete, write the approval to .wai/lock.json (one digest per spec; spec files are not rewritten), and refresh this project\'s generated outputs — only if the design validates. Commit .wai/lock.json; `wairon lock-check` gates on it. In an attached checkout, locks the hosted project instead.')
  .option('-y, --yes', 'skip the confirmation prompt (for scripts / CI)')
  .option('--subsystem <id>', 'only lock specs in the specified subsystem')
  .option('--no-recursive', 'accepted for one release and ignored: a lock approves this project only; each member locks at its own root')
  .action(async (opts) => {
    await lockCommand(opts);
  });

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

program
  .command('validate')
  .description('Validate the project configuration and the SDD Spec Tree')
  .option('--ci', 'treat warnings as errors for CI pipelines (notices are printed and counted, never fatal)')
  .option('--subsystem <id>', 'only validate the specified subsystem (granular)')
  .option('--no-recursive', "at a project that declares members: run the owner's gate alone instead of the family run")
  .option('--family', "run the family run from here: every member's own gate, and this project's externals composed against their live producers")
  .option('--all', 'print every finding (by default the first 100 per severity are printed, followed by per-code totals)')
  .action(async (opts) => {
    await validateCommand(opts);
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

program
  .command('status')
  .description('Show the spec tree with its authoring readiness (how far each spec is written out, from its draft/design/complete status) and, separately, its approval state from .wai/lock.json')
  .option('--subsystem <id>', 'only show status for the specified subsystem')
  .option('--no-recursive', 'show this project only, without its members')
  .option('--all', 'list every spec that moved since the approval, not the first few')
  .action(async (opts) => {
    await statusCommand(opts);
  });

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('Health check: flags stale generated guides/skills, an unregistered MCP server, spec-tree issues and the chaining migration still pending')
  .option('--fix', 'regenerate stale in-project guides/context/skills, register the MCP server, then apply the chaining migration once confirmed')
  .option('--report <section>', "print one section's report and nothing else, writing nothing (chaining | composed-validation | reachability); never combines with --fix")
  .option('-y, --yes', "answer the chaining migration's confirmation (for a non-interactive --fix); a write outside the project root also needs --global")
  .option('--global', 'consent to the --fix writes outside the project root (a machine-wide MCP config, the legacy global plugin); with --yes it answers their confirmation, and each replaced file is backed up beside itself')
  .action(async (opts) => {
    await runDoctor({ fix: opts.fix, report: opts.report, yes: opts.yes, global: opts.global === true });
  });

// ---------------------------------------------------------------------------
// rules
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// execution — the resource axis: what each agent's work costs to do
// ---------------------------------------------------------------------------

const executionCmd = program
  .command('execution')
  .description('Execution budgets: what each agent\'s work is like and the model/turn/tool allowance it earns');

executionCmd
  .command('show')
  .alias('ls')
  .description('Show the current budget tier and the derived allowance for every agent')
  .action(async () => {
    await showExecution();
  });

executionCmd
  .command('set-tier <tier>')
  .description('Set the aggressiveness dial: off | free | default | trade | aggressive')
  .action(async (tier: string) => {
    await setExecutionTier(tier);
  });

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
  .description('Install a pack into this wairon install\'s store (a .wpack/.zip or a pack directory). Applies to NOTHING until a project selects it — unless this project selects it floating, then its impact is shown first')
  .option('-y, --yes', 'install without showing the impact report (an update of a floating selection)')
  .action(async (source: string, opts) => {
    await runPack('install', source, { yes: opts.yes });
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
  .option('-y, --yes', 'apply without showing the impact report')
  .action(async (name: string, opts) => {
    await runPack('use', name, { source: opts.source, bundle: opts.bundle, pin: opts.pin, yes: opts.yes });
  });

packCmd
  .command('impact <name>')
  .description('Show what a pack changes (name or name@version), writing nothing: its doctrine against wairon\'s defaults, the profiles that would govern here, and the findings that change on this project')
  .action(async (name: string) => {
    await runPack('impact', name);
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
  .option('-y, --yes', 'deselect without showing the impact report')
  .action(async (name: string, opts) => {
    await runPack('unuse', name, { yes: opts.yes });
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
  .option('-y, --yes', 'apply without showing the impact report')
  .action(async (source: string, opts) => {
    await runPack('add', source, { global: opts.global, yes: opts.yes });
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
  .option('-y, --yes', 'remove without showing the impact report')
  .action(async (name: string, opts) => {
    await runPack('remove', name, { global: opts.global, yes: opts.yes });
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
  .option('--out <path>', 'the file to write (a directory with --all); every format writes a file — default under .wai/docs/diagrams/ (system.md for Mermaid, canvas.html for the canvas); a .mmd path writes raw Mermaid')
  .option('--no-health', 'skip comparing each consumption relation with its live producer: the canvas draws those edges as not checked')
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
      health: opts.health,
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
// agent — live delegation briefs + user-owned per-agent guidance (cli_runner.runAgent)
// ---------------------------------------------------------------------------

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
  .action(mcpInstallCommand);

mcpCmd
  .command('status')
  .description('Show whether the wairon MCP server is registered in Claude Code and Antigravity settings')
  .action(() => {
    runMcpStatus();
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
  .description('public surface exchange: export | import | list')
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
// export — the design export (cli_runner.runExport → sdd_surfaces)
// ---------------------------------------------------------------------------

program
  .command('export')
  .description('the whole design, resolved, as one JSON document (format wairon-design) for generators and translators; stamped with the lock-check approval verdict. Prints to stdout unless --out names a file')
  .option('--out <file>', 'write the JSON to this file (else print it to stdout, and nothing else)')
  .action(async (opts) => {
    await runExport(opts.out);
  });

// ---------------------------------------------------------------------------
// externals — the other projects this project consumes (declared in
// .wai/project.yaml `externals`): add, pin, status, list
// ---------------------------------------------------------------------------

program
  .command('externals <action> [aliases...]')
  .description('declared externals: add <alias> [<source>] | pin [alias…] | status (exit 1 incompatible, 2 not compared) | list')
  .option('--json', 'print the structured answer instead of the table')
  .option('--project <id>', "add: the producer's project id when it differs from the alias")
  .option('--ref <ref>', 'add: git only — the branch, tag or full commit the pin follows')
  .option('--dir <dir>', "add: git only — the producer's root inside the repository")
  .option('--use <names>', "add: public names to import bare, comma-separated ('*' for all)")
  .option('--description <text>', 'add: what the producer is to this project')
  .option('--no-pin', 'add: declare only, without pinning')
  .option('--dry-run', 'add: say what would be declared, write nothing')
  .action(async (action: string, aliases: string[] | undefined, opts) => {
    await runExternals(action, aliases ?? [], {
      json: opts.json,
      project: opts.project,
      ref: opts.ref,
      dir: opts.dir,
      ...(opts.use !== undefined ? { use: String(opts.use).split(',').map((u: string) => u.trim()).filter(Boolean) } : {}),
      description: opts.description,
      pin: opts.pin,
      dryRun: opts.dryRun,
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
    await runLogout(url);
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
  .option(
    '--allow-partial',
    'build the archive even when some chained mounts cannot be packed, listing them as skipped (default: refuse)',
  )
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
      allowPartial: opts.allowPartial,
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
  .description('Administer the hosting server: projects, API keys, and the state-scoped lock');

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
  .option('--kind <kind>', 'unit kind (business_entity | department | team | …); default business_entity for a top-level unit, team under --parent')
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
  .option('--subsystem <id>', 'with --project: anchor at a subsystem of that project (project:write only, yes | no | inherit)')
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
      subsystem: opts.subsystem,
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
  .option('-y, --yes', 'install or remove a project pack without showing its impact or asking (scripts)')
  .option('--data-dir <path>', 'data root')
  .action(async (action: string, opts) => {
    await runHostPacks(action, { project: opts.project, name: opts.name, file: opts.file, dataDir: opts.dataDir, yes: opts.yes });
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
// member — the projects this project contains (project.yaml `members`)
// ---------------------------------------------------------------------------

const memberCmd = program
  .command('member')
  .description('Manage members — the projects this project contains, declared in project.yaml `members`');

memberCmd
  .command('add <alias> <source>')
  .description('Create a member at <source> — services/x (contained), ../x (a sibling checkout) or a git URL[#commit] — a PART by default (its subsystems are this project\'s own), or with --project an independent project')
  .option('--project', 'create an independent project (its id = <alias>, its own L0 and lock) instead of a part')
  .option('--description <text>', 'what the member is to this project (also a project\'s bootstrapped L0 vision)')
  .action(async (alias: string, source: string, opts) => {
    await runMemberAdd(alias, source, { description: opts.description, project: opts.project });
  });

memberCmd
  .command('update <alias>')
  .description("Move a git member's pinned commit to its ref's head (or --ref / --commit), printing the spec files it adds, changes and removes; never locks")
  .option('--ref <ref>', 'the branch or tag to follow this time')
  .option('--commit <sha>', 'an exact commit to pin')
  .option('--report', 'print what would change and write nothing')
  .action(async (alias: string, opts) => {
    await runMemberUpdate(alias, { ref: opts.ref, commit: opts.commit, report: opts.report });
  });

memberCmd
  .command('move <alias> <path>')
  .description('Relocate a member: move its directory and point its `members` entry there (a legacy L1 mount is moved into `members` first)')
  .action(async (alias: string, memberPath: string) => {
    await runMemberMove(alias, memberPath);
  });

// The family migrations: each plans first and prints the plan, applies only
// once confirmed (--yes answers; --report prints and writes nothing), applies
// all or nothing, and never locks — it names the projects to re-lock.
const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

memberCmd
  .command('attach <alias> <path>')
  .description('Make the existing project at <path> a member, keeping its L0, subsystems, packs and lock (`member add` scaffolds a new one)')
  .option('--description <text>', 'what the member is to this project')
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (alias: string, memberPath: string, opts) => {
    await runMemberAttach(alias, memberPath, { description: opts.description, report: opts.report, yes: opts.yes });
  });

memberCmd
  .command('detach <alias>')
  .description('Take a member out of the family: this project and every family consumer then reach it as an external by path, pinned')
  .option('--widen', 'widen exactly the exports the family uses that the member gives the family alone to the instance audience (shown in the plan), instead of refusing')
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (alias: string, opts) => {
    await runMemberDetach(alias, { widen: opts.widen, report: opts.report, yes: opts.yes });
  });

memberCmd
  .command('adopt <alias>')
  .description("Make this project's external found by a path inside it a member again (detach's inverse)")
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (alias: string, opts) => {
    await runMemberAdopt(alias, { report: opts.report, yes: opts.yes });
  });

memberCmd
  .command('rename-alias <old> <new>')
  .description("Rename one alias of this project (a member or an external) and respell this project's references through it; no member or sibling changes")
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (alias: string, newAlias: string, opts) => {
    await runMemberRenameAlias(alias, newAlias, { report: opts.report, yes: opts.yes });
  });

memberCmd
  .command('internalize <alias>')
  .description("Fold a member — every subsystem of it — back into this project, its own metadata sent to explicit homes and every family consumer re-pointed at this project")
  .option('--into <subsystem>', "the subsystem that receives the member's L0 vision (required when it holds several subsystems)")
  .option('--packs <adopt|drop>', 'what to do with a pack only the member selects')
  .option('--export <name>', "a public name of the member this project exports afterwards (repeatable), beyond those the family uses", collect, [])
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (alias: string, opts) => {
    await runMemberInternalize(alias, { into: opts.into, packs: opts.packs, exports: opts.export, report: opts.report, yes: opts.yes });
  });

memberCmd
  .command('promote <alias>')
  .description('Make a part an independent project in place: its id, an L0 exporting what this project uses of it, references respelled alias::name, pins on both sides')
  .option('--id <id>', "the new project's id (default: the alias)")
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (alias: string, opts) => {
    await runMemberPromote(alias, { id: opts.id, report: opts.report, yes: opts.yes });
  });

memberCmd
  .command('demote <alias>')
  .description("Make a project member a part of this project in place (promote's inverse); refused while another family project consumes it")
  .option('--home <subsystem>', "the subsystem that receives the member's L0 vision (required when it holds several subsystems and its vision says more than its name)")
  .option('--packs <adopt|drop>', 'what to do with a pack only the member selects')
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (alias: string, opts) => {
    await runMemberDemote(alias, { into: opts.home, packs: opts.packs, report: opts.report, yes: opts.yes });
  });

// ---------------------------------------------------------------------------
// project rename — a project's id, family-wide
// ---------------------------------------------------------------------------

const projectCmd = program
  .command('project')
  .description('Act on a project of the family');

projectCmd
  .command('rename <new-id>')
  .description("Move a project's id — this project's, or a member's named by --project — and every reference to the old id across the family; lists every project to re-lock")
  .option('--project <alias-path>', "the member whose id moves, as an alias path from this project (e.g. billing/payments)")
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (newId: string, opts) => {
    await runProjectRename(newId, { project: opts.project, report: opts.report, yes: opts.yes });
  });

// ---------------------------------------------------------------------------
// subsystem externalize — move an internal subsystem's specs into a part (or a member project)
// ---------------------------------------------------------------------------

const subsystemCmd = program
  .command('subsystem')
  .description('Act on a subsystem of this project');

subsystemCmd
  .command('externalize <id>')
  .description("Move an internal subsystem's specs into a part at --path — a storage move, nothing else changes — or with --as project into a member project, family-wide and all or nothing (you move the source code)")
  .requiredOption('--path <dir>', "the part's directory (a new one, or an existing part's)")
  .option('--as <part|project>', 'part (default): a storage move; project: the move followed by a promote')
  .option('--report', 'print the plan and write nothing')
  .option('--yes', 'apply without asking (required in a non-interactive shell)')
  .action(async (id: string, opts) => {
    await runSubsystemExternalize(id, { path: opts.path, as: opts.as, report: opts.report, yes: opts.yes });
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
    // The parsed flags are exactly runUpdate's options (--check, --channel).
    await runUpdate(opts);
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
  .action(() => {
    runSkillsList();
  });

skillsCmd
  .command('install')
  .alias('sync')
  .description('Install/refresh the SDD skills into each active target tool')
  .action(() => {
    runSkillsInstall();
  });

// ---------------------------------------------------------------------------
// network — derived from the design; deployment facts come from a bindings
// file kept outside .wai/ (docs/network.md)
// ---------------------------------------------------------------------------

const networkCmd = program
  .command('network')
  .description('Derived networking: the allowed-flows matrix, generated NetworkPolicy, the network diagram, a check of observed live flows, and why one flow is allowed');

networkCmd
  .command('flows')
  .description('Print the allowed-flows matrix: who reaches which verb, over which transport, through which networks and gateway, on what evidence')
  .option('--format <format>', 'json | csv | markdown', 'json')
  .option('--out <file>', 'write it to a file instead of stdout')
  .option('--no-recursive', "at a project that declares members: this project's own flows, not its family's")
  .action(async (opts) => {
    await runNetworkFlows(opts);
  });

networkCmd
  .command('policy')
  .description('Generate Kubernetes NetworkPolicy from the matrix and your bindings file (design names to selectors, namespaces, ports)')
  .option('--bindings <file>', 'the bindings file the team keeps outside .wai/ (required)')
  .option('--format <format>', 'kubernetes-network-policy', 'kubernetes-network-policy')
  .option('--out <file>', 'write it to a file instead of stdout')
  .option('--no-recursive', "at a project that declares members: this project's own flows, not its family's")
  .action(async (opts) => {
    await runNetworkPolicy(opts);
  });

networkCmd
  .command('diagram')
  .description('Print the network picture as a Mermaid flowchart: networks as nested boundaries, gateways, outside, flows per workload pair')
  .option('--out <file>', 'write it to a file instead of stdout')
  .option('--no-recursive', "at a project that declares members: this project's own flows, not its family's")
  .action(async (opts) => {
    await runNetworkDiagram(opts);
  });

networkCmd
  .command('check')
  .description('Compare observed live flows (CSV or JSON: source, destination[, transport, method, path, count]) with the matrix; exits 1 on an unexpected flow or unknown verb')
  .option('--observed <file>', 'the observed-flow export (required)')
  .option('--bindings <file>', 'the bindings file the observed names follow (lets a selector label value stand for its design name)')
  .option('--format <format>', 'text | json', 'text')
  .option('--no-recursive', "at a project that declares members: this project's own flows, not its family's")
  .action(async (opts) => {
    await runNetworkCheck(opts);
  });

networkCmd
  .command('why <from> <to>')
  .description('Explain from the design why <from> (outside, network[:<id>], a project, subsystem or component) may reach <to> (a project, portal or portal.verb); exits 1 when nothing allows it')
  .option('--format <format>', 'text | json', 'text')
  .option('--no-recursive', "at a project that declares members: this project's own flows, not its family's")
  .action(async (from: string, to: string, opts) => {
    await runNetworkWhy({ ...opts, from, to });
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
