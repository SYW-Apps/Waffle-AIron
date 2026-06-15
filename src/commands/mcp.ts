import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, isProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { aiDir } from '../utils/fs.js';
import { WaironError } from '../utils/errors.js';
import { versionStamp } from '../core/stamp.js';
import { WAIRON_VERSION } from '../config/defaults.js';

/** The Claude config dir for global installs. Precedence: explicit override (--config-dir)
 *  > CLAUDE_CONFIG_DIR > ~/.claude. Lets account aliases (`claude-syw`, …) work. */
function claudeGlobalDir(override?: string): string {
  return override || process.env['CLAUDE_CONFIG_DIR'] || path.join(os.homedir(), '.claude');
}

/** The Gemini/Antigravity home dir. Precedence: override > GEMINI_CONFIG_DIR > ~/.gemini. */
function geminiGlobalDir(override?: string): string {
  return override || process.env['GEMINI_CONFIG_DIR'] || path.join(os.homedir(), '.gemini');
}

/** Validate that `dir` looks like a real config directory for the selected agent. */
export function validateConfigDir(dir: string, backend: 'claude' | 'gemini'): void {
  const resolved = path.resolve(dir);
  const agent = backend === 'claude' ? 'Claude' : 'Gemini/Antigravity';

  if (!fs.existsSync(resolved)) {
    const parent = path.dirname(resolved);
    if (!fs.existsSync(parent)) {
      throw new WaironError(`--config-dir "${dir}" does not exist and its parent is missing — check the path.`);
    }
    logger.warn(`Config dir "${resolved}" does not exist yet; it will be created.`);
    return;
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new WaironError(`--config-dir "${dir}" is not a directory.`);
  }

  const markers = backend === 'claude'
    ? ['settings.json', 'settings.local.json', '.credentials.json', 'projects', 'statsig', 'todos', 'shell-snapshots', 'CLAUDE.md']
    : ['settings.json', 'GEMINI.md', 'oauth_creds.json', 'antigravity-cli', 'tmp'];

  const entries = fs.readdirSync(resolved);
  if (entries.length === 0) {
    logger.warn(`Config dir "${resolved}" is empty; proceeding (treating it as a fresh ${agent} config dir).`);
    return;
  }
  if (!markers.some((m) => fs.existsSync(path.join(resolved, m)))) {
    throw new WaironError(
      `"${dir}" does not look like a ${agent} config directory (none of ${markers.slice(0, 4).join(', ')} found). ` +
      `Point --config-dir at the agent's config directory.`,
    );
  }
}

// ---------------------------------------------------------------------------
// wairon mcp serve
// ---------------------------------------------------------------------------

export async function runMcpServe(): Promise<void> {
  // A host (e.g. Antigravity) may launch this server with a cwd that is NOT the
  // project — especially a globally-registered server shared across projects.
  // Resolve the project root explicitly so the sdd_* tools operate on the right
  // .wai/ tree: WAIRON_PROJECT_DIR env > nearest .wai/ above cwd > cwd.
  const { setProjectRoot, getProjectRoot, findProjectRoot } = await import('../utils/fs.js');
  const envDir = process.env['WAIRON_PROJECT_DIR'];
  const resolved = (envDir && fs.existsSync(path.join(envDir, '.wai')) ? path.resolve(envDir) : null)
    ?? findProjectRoot(process.cwd())
    ?? process.cwd();
  setProjectRoot(resolved);

  const initialized = isProjectInitialized();
  // Log to stderr (never stdout — stdout is the JSON-RPC channel). Visible in the
  // host's MCP server logs, so you can confirm which project the server attached to.
  process.stderr.write(
    `[wairon mcp] v${WAIRON_VERSION} — project root: ${getProjectRoot()} ` +
    `(.wai ${initialized ? 'found' : 'NOT found — sdd_* tools will report no project'})\n`,
  );

  // Dynamic import so the MCP server module is only loaded when this command
  // runs (avoids pulling @modelcontextprotocol/sdk into every command).
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { startMcpServer } = require('../mcp/server.js') as typeof import('../mcp/server.js');
  /* eslint-enable @typescript-eslint/no-require-imports */

  await startMcpServer();
}

// ---------------------------------------------------------------------------
// wairon mcp install  — write MCP server config to the project's .claude/settings.json
// ---------------------------------------------------------------------------

export interface McpInstallOptions {
  /** Target AI assistant. Accepts aliases (agy/antigravity → gemini); see normalizeBackend. */
  backend?: string;
  global?:  boolean;
  /** Explicit config dir to install into (highest precedence; validated). Requires backend. */
  configDir?: string;
}

/**
 * Map a user-supplied --backend value to a supported MCP backend. wairon only
 * writes Claude (settings.json) and Gemini/Antigravity (settings.json /
 * mcp_config.json) configs, so every alias resolves to one of those. Unknown
 * backends throw rather than silently defaulting to Claude.
 */
export function normalizeBackend(input: string): 'claude' | 'gemini' {
  const v = input.trim().toLowerCase();
  if (['claude', 'claude-code', 'claudecode', 'cc'].includes(v)) return 'claude';
  if (['gemini', 'gemini-cli', 'google', 'agy', 'antigravity'].includes(v)) return 'gemini';
  throw new WaironError(
    `Unknown --backend "${input}". Supported: claude (Claude Code) or gemini ` +
    `(a.k.a. agy / antigravity — both are Gemini-based). MCP auto-registration ` +
    `for codex / cursor / copilot is not yet supported; configure those manually.`
  );
}

export async function runMcpInstall(options: McpInstallOptions = {}): Promise<void> {
  assertProjectInitialized();

  if (options.configDir && !options.backend) {
    throw new WaironError('--config-dir requires --backend (claude or gemini), since a config dir is agent-specific.');
  }

  let backends: ('claude' | 'gemini')[] = [];
  if (options.backend) {
    backends = [normalizeBackend(options.backend)];
  } else {
    try {
      const config = loadProjectConfig();
      const enabledTypes = config.targets
        .filter((t) => !('enabled' in t) || t.enabled)
        .map((t) => t.type);

      if (enabledTypes.includes('claude')) {
        backends.push('claude');
      }
      if (enabledTypes.includes('gemini') || enabledTypes.includes('agy')) {
        backends.push('gemini');
      }
    } catch {
      // Fallback if config loading fails
    }
    if (backends.length === 0) {
      backends = ['claude']; // Default fallback
    }
  }

  for (const backend of backends) {
    if (options.configDir) validateConfigDir(options.configDir, backend);
    // An explicit --config-dir implies a global-style install into that dir.
    const useGlobal = options.global || !!options.configDir;

    // ── Resolve where to write settings ──────────────────────────────────────
    let configBase: string;
    let settingsPath: string;

    if (backend === 'gemini') {
      if (useGlobal) {
        // Global install (opt-in): home config + the global Antigravity plugin.
        configBase = path.join(geminiGlobalDir(options.configDir), 'antigravity-cli');
        settingsPath = path.join(configBase, 'mcp_config.json');
        installGlobalPluginForGemini();
      } else {
        // Project-local Gemini/Antigravity settings — stays within the project.
        configBase = path.join(process.cwd(), '.gemini');
        settingsPath = path.join(configBase, 'settings.json');
      }
    } else {
      // Claude: global resolves --config-dir > CLAUDE_CONFIG_DIR > ~/.claude; else project-local.
      configBase = useGlobal ? claudeGlobalDir(options.configDir) : path.join(process.cwd(), '.claude');
      settingsPath = path.join(configBase, 'settings.json');
    }

    // ── Read existing settings (or start fresh) ───────────────────────────────
    let settings: Record<string, unknown> = {};
    if (fs.existsSync(settingsPath)) {
      try {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        logger.warn(`Could not parse ${settingsPath} — starting fresh.`);
      }
    }

    // ── Build the desired mcpServers entry ────────────────────────────────────
    const mcpServers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;
    const agentLabel = backend === 'gemini' ? 'Antigravity' : 'Claude';

    const scriptPath = process.argv[1] ? path.resolve(process.argv[1]).replace(/\\/g, '/') : null;
    const useDirectNode = scriptPath && (scriptPath.endsWith('.js') || scriptPath.endsWith('.ts'));

    const desiredEntry = useDirectNode
      ? { command: 'node', args: [scriptPath, 'mcp', 'serve'], env: {} }
      : { command: 'wairon', args: ['mcp', 'serve'], env: {} };

    // Self-heal: if an entry already exists but points somewhere else (e.g. a
    // stale path from a moved repo or an earlier machine), rewrite it instead of
    // skipping. Skipping is exactly how a broken `command`/`args` path survives
    // and leaves the agent with no wairon tools.
    const existingEntry = mcpServers['wairon'];
    if (existingEntry && JSON.stringify(existingEntry) === JSON.stringify(desiredEntry)) {
      logger.info(`wairon MCP server already registered (up to date) for ${agentLabel} in ${chalk.gray(settingsPath)}.`);
      continue;
    }
    const wasStale = !!existingEntry;

    mcpServers['wairon'] = desiredEntry;
    settings['mcpServers'] = mcpServers;

    // ── Write back ────────────────────────────────────────────────────────────
    if (!fs.existsSync(configBase)) fs.mkdirSync(configBase, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

    logger.success(`wairon MCP server ${wasStale ? 'updated (was stale)' : 'registered'} for ${agentLabel} in ${chalk.cyan(settingsPath)}.`);
    logger.blank();
    logger.info('AI tools using this config will have access to these wairon tools:');
    logger.info('  listAgents · getAgent · listDomains · validateTopology · getProjectConfig');
    logger.info('  sdd_initialize_system · sdd_add_subsystem · sdd_add_component · sdd_define_interface');
    logger.info('  sdd_write_narrative · sdd_validate_tree · sdd_get_status');
    logger.blank();
    const restartApp = backend === 'gemini' ? 'Antigravity CLI (agy)' : 'claude';
    logger.info(`Restart ${chalk.bold(restartApp)} (or reload MCP servers) to activate.`);

    // Antigravity loads MCP from its global mcp_config.json, NOT the project's
    // .gemini/settings.json — so a project-local install won't surface tools there.
    if (backend === 'gemini' && !useGlobal) {
      logger.warn('Note: Antigravity (agy) reads MCP servers from its global ~/.gemini/antigravity-cli/mcp_config.json, not this project file.');
      logger.warn('If the agent cannot see the sdd_* tools, run: ' + chalk.bold('wairon mcp install --backend gemini --global'));
    }
    logger.blank();
  }
}

// ---------------------------------------------------------------------------
// wairon mcp status  — show whether the MCP server is configured
// ---------------------------------------------------------------------------

export async function runMcpStatus(): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const claudeProject = path.join(process.cwd(), '.claude', 'settings.json');
  const claudeGlobal  = path.join(claudeGlobalDir(), 'settings.json');
  const geminiProject = path.join(process.cwd(), '.gemini', 'settings.json');
  const geminiGlobal  = path.join(geminiGlobalDir(), 'antigravity-cli', 'mcp_config.json');

  logger.blank();
  logger.info(`${chalk.bold('wairon MCP Server')}`);
  logger.blank();

  const checks = [
    { label: 'Claude (project)', filePath: claudeProject, fallbackName: 'settings.json' },
    { label: 'Claude (global)', filePath: claudeGlobal, fallbackName: 'settings.json' },
    { label: 'Antigravity (project)', filePath: geminiProject, fallbackName: 'settings.json' },
    { label: 'Antigravity (global)', filePath: geminiGlobal, fallbackName: 'mcp_config.json' },
  ];

  for (const { label, filePath, fallbackName } of checks) {
    if (!fs.existsSync(filePath)) {
      console.log(`  ${label}: ${chalk.gray(`${fallbackName} not found`)}`);
      continue;
    }
    try {
      const s = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const registered = !!(s['mcpServers'] as Record<string, unknown> | undefined)?.['wairon'];
      const mark = registered ? chalk.green('✓ registered') : chalk.gray('not registered');
      console.log(`  ${label}: ${mark}  ${chalk.gray(filePath)}`);
    } catch {
      console.log(`  ${label}: ${chalk.red('parse error')}  ${chalk.gray(filePath)}`);
    }
  }

  logger.blank();
  logger.info(`Project: ${chalk.bold(projectConfig.name)}`);
  logger.blank();
  logger.info(`To register for Claude: ${chalk.bold('wairon mcp install --backend claude')}`);
  logger.info(`To register for Antigravity (agy): ${chalk.bold('wairon mcp install --backend gemini')}`);
  logger.info(`To start manually: ${chalk.bold('wairon mcp serve')}`);
  logger.blank();

  // Also show wai dir location so user knows where context comes from
  const mcpDir = aiDir('mcp');
  if (fs.existsSync(mcpDir)) {
    logger.info(`MCP state dir: ${chalk.gray(mcpDir)}`);
  }
}

function installGlobalPluginForGemini(): void {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  const pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'wairon');
  const skillDir = path.join(pluginDir, 'skills', 'wairon');

  try {
    fs.mkdirSync(skillDir, { recursive: true });

    // Write plugin.json
    fs.writeFileSync(
      path.join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'wairon' }, null, 2) + '\n',
      'utf8'
    );

    // Write SKILL.md — a THIN pointer, not a second copy of the framework. When a
    // project is initialized it has its own .gemini/GEMINI.md guide + sdd-architect
    // skill + sdd_* MCP tools; this global skill only orients and defers to those,
    // so there is exactly one source of truth (and nothing for the agent to hunt).
    const skillContent = `---
name: wairon
description: >
  Spec-Driven Development (SDD) with the Wairon framework. Use when starting a new
  project, designing or modifying software architecture, or working in a repo that
  has a .wai/ spec tree. If a project needs design but has no .wai/ yet, propose
  initializing Wairon SDD first.
---

# Wairon — Spec-Driven Development

Wairon builds software from a typed **spec tree** under \`.wai/specs/\`
(L0 System -> L1 Subsystem -> L2 Component -> L3 Interface -> L4 Implementation ->
L5 Narrative). The agent topology and the implementation are derived from it.

## If the project has NO \`.wai/\` directory
The user wants to design or build something new. Do **not** start writing code or
creating folders. First propose Wairon SDD:

> This project doesn't have a Wairon SDD workspace yet. Want to design the
> architecture, component contracts, and narratives with Wairon before writing code?

If they agree, ask them to run \`wairon init\` in their terminal (that is the human
developer's command). Once initialized, the project gets its own \`.gemini/GEMINI.md\`
guide, the \`sdd-architect\` skill, and the \`sdd_*\` MCP tools — everything you need.

## If the project already HAS a \`.wai/\` directory
You are operating inside an active SDD project. **Your complete operating guide is
the project's own \`.gemini/GEMINI.md\` plus the \`sdd-architect\` skill in
\`.gemini/skills/\` — read those and follow them. You already have full context; do
NOT search the filesystem to figure out what wairon or SDD is.**

- To design or change the system, invoke the **\`sdd-architect\`** skill — it is the
  single source for the component model, naming rules, and YAML schemas.
- Author and validate specs through the **\`sdd_*\` MCP tools** (\`sdd_initialize_system\`,
  \`sdd_add_subsystem\`, \`sdd_add_component\`, \`sdd_define_interface\`,
  \`sdd_write_narrative\`, \`sdd_add_type\`, \`sdd_validate_tree\`, \`sdd_get_status\`).
- **You never run the \`wairon\` CLI** — that is the human developer's tool. To
  validate the tree call \`sdd_validate_tree\` (not \`wairon validate\`); for status
  call \`sdd_get_status\` (not \`wairon status\`).
- Present each spec layer to the user for approval before moving on, and never write
  source for a component until its spec is \`complete\` and validates with zero errors.

${versionStamp()}
`;
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillContent, 'utf8');
    logger.success(`wairon global Antigravity plugin installed at ${chalk.cyan(pluginDir)}.`);
  } catch (e) {
    logger.warn(`Could not install wairon global Antigravity plugin: ${String(e)}`);
  }
}
