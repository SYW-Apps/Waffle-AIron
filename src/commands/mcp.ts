import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, isProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { aiDir } from '../utils/fs.js';
import { WaironError } from '../utils/errors.js';
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
        // Global install (opt-in): just the Antigravity home MCP config. We do NOT
        // install a plugin — a plugin named "wairon" collides with the "wairon" MCP
        // server in Antigravity. Clean up any plugin left by an older install.
        configBase = path.join(geminiGlobalDir(options.configDir), 'antigravity-cli');
        settingsPath = path.join(configBase, 'mcp_config.json');
        removeGlobalPluginForGemini();
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

/**
 * Remove the legacy global Antigravity plugin (~/.gemini/config/plugins/wairon).
 * A plugin named "wairon" collides with the "wairon" MCP server in Antigravity
 * ("server wairon is not allowed in this context"), so we no longer install one —
 * the MCP server plus the project's own GEMINI.md guide cover everything it did.
 * This cleans up any copy left by an older `mcp install --global`.
 */
function removeGlobalPluginForGemini(): void {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? os.homedir();
  const pluginDir = path.join(home, '.gemini', 'config', 'plugins', 'wairon');
  try {
    if (fs.existsSync(pluginDir)) {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      logger.info(`Removed legacy global Antigravity plugin at ${chalk.gray(pluginDir)} (it collides with the wairon MCP server).`);
    }
  } catch (e) {
    logger.warn(`Could not remove legacy wairon Antigravity plugin: ${String(e)}`);
  }
}
