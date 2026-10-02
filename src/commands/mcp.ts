import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, isProjectInitialized } from '../config/paths.js';
import { loadProjectConfig } from '../core/index.js';
import { aiDir, getProjectRoot, isOutsideRoot, backupBeside } from '../utils/fs.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
import { WAIRON_VERSION } from '../config/defaults.js';

/** The Gemini/Antigravity home dir. Precedence: override > GEMINI_CONFIG_DIR > ~/.gemini. */
function geminiGlobalDir(override?: string): string {
  return override || process.env['GEMINI_CONFIG_DIR'] || path.join(os.homedir(), '.gemini');
}

/**
 * Where Claude Code reads MCP *server definitions* from.
 *   - project scope: `<projectRoot>/.mcp.json` (shared/committed; same file `claude mcp add -s project` writes)
 *   - user scope (global): the Claude state file `.claude.json` — in CLAUDE_CONFIG_DIR / --config-dir if set,
 *     else `~/.claude.json`; the wairon entry goes under its top-level `mcpServers`.
 *
 * IMPORTANT: `.claude/settings.json` is NOT a server-definition source. It only governs permissions and
 * which `.mcp.json` servers are enabled — so an `mcpServers` block written there is silently ignored by
 * Claude (the tools never load). That mis-targeting was the long-standing reason the sdd_* tools were invisible.
 */
export function claudeMcpConfigPath(useGlobal: boolean, override?: string): string {
  if (!useGlobal) return path.join(process.cwd(), '.mcp.json');
  const dir = override || process.env['CLAUDE_CONFIG_DIR'];
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
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
  const cwd = path.resolve(process.cwd());
  const envDir = process.env['WAIRON_PROJECT_DIR'];

  // Resolve the project root and record HOW we got it, so the stderr log makes a
  // silent mis-attachment (walking up to an ANCESTOR .wai) observable.
  let resolved: string;
  let how: string;
  if (envDir && fs.existsSync(path.join(envDir, '.wai'))) {
    resolved = path.resolve(envDir);
    how = 'WAIRON_PROJECT_DIR (pinned at install)';
  } else {
    const found = findProjectRoot(cwd);
    if (found && found === cwd) {
      resolved = found;
      how = 'cwd';
    } else if (found) {
      resolved = found;
      // cwd has no .wai of its own — we climbed to an ancestor. For nested
      // projects this can attach to the WRONG tree; roots (if the client sends
      // them) will correct it post-connect via scopeToClientWorkspace.
      how = `walked up to ancestor — cwd (${cwd}) has no .wai`;
    } else {
      resolved = cwd;
      how = 'cwd (no .wai found anywhere above)';
    }
  }
  setProjectRoot(resolved);

  const initialized = isProjectInitialized();
  // Log to stderr (never stdout — stdout is the JSON-RPC channel). Visible in the
  // host's MCP server logs, so you can confirm which project the server attached to.
  process.stderr.write(
    `[wairon mcp] v${WAIRON_VERSION} — project root: ${getProjectRoot()} [via ${how}] ` +
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
  /** Register a HOSTED http entry against this instance instead of the local stdio server. */
  hostedUrl?: string;
  /** Hosted only: the project selector to carry on the entry. */
  hostedProject?: string;
  /** Hosted only: the bearer to carry; falls back to the stored credential for the instance. */
  hostedToken?: string;
}

/** What the agent's own MCP configuration says wairon is attached to. */
export interface DetectedMcpSource {
  /** 'local' (stdio over this checkout) or 'hosted' (http on an instance). */
  kind: 'local' | 'hosted';
  /** The config file the entry was read from — named in output so a surprise is traceable. */
  configPath: string;
  url?: string;
  projectId?: string;
  token?: string;
}

/** The config files an AI tool may define the wairon MCP server in, in precedence order. */
function mcpConfigCandidates(cwd: string): string[] {
  return [
    path.join(cwd, '.mcp.json'),
    claudeMcpConfigPath(true),
    path.join(cwd, '.gemini', 'settings.json'),
    path.join(geminiGlobalDir(), 'antigravity-cli', 'mcp_config.json'),
  ];
}

/**
 * cli_mcp_adapter.detectHostedMcpSource — read the wairon entry out of the
 * agent's own MCP configuration and report what it points at.
 *
 * This is what lets `wairon remote` attach without a second round of
 * configuration: if the agent already works against a hosted project, the CLI
 * can address the SAME project with the SAME credential, and the two cannot
 * drift apart. Purely a read, and deliberately total — an unparseable agent
 * config must never break an ordinary wairon command, so anything unreadable
 * simply contributes nothing.
 */
export function detectHostedMcpSource(cwd: string = process.cwd()): DetectedMcpSource | null {
  for (const configPath of mcpConfigCandidates(cwd)) {
    let entry: Record<string, unknown> | undefined;
    try {
      if (!fs.existsSync(configPath)) continue;
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        mcpServers?: Record<string, Record<string, unknown>>;
      };
      entry = parsed.mcpServers?.['wairon'];
    } catch {
      continue; // unreadable or malformed — not our problem to report here
    }
    if (!entry) continue;

    const url = typeof entry.url === 'string' ? entry.url : undefined;
    if (!url) return { kind: 'local', configPath };

    const headers = (entry.headers ?? {}) as Record<string, unknown>;
    const source: DetectedMcpSource = { kind: 'hosted', configPath, url: mcpBaseUrl(url) };
    const project = headerValue(headers, 'x-wairon-project') ?? projectFromQuery(url);
    if (project) source.projectId = project;
    const authorization = headerValue(headers, 'authorization');
    const bearer = authorization && /^bearer\s+/i.test(authorization)
      ? authorization.replace(/^bearer\s+/i, '').trim()
      : undefined;
    if (bearer) source.token = bearer;
    return source;
  }
  return null;
}

/** Case-insensitive header lookup (config files are hand-edited). */
function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/** The `?project=` selector carried on an endpoint URL, when it has one. */
function projectFromQuery(endpoint: string): string | undefined {
  try {
    return new URL(endpoint).searchParams.get('project') ?? undefined;
  } catch {
    return undefined;
  }
}

/** An MCP endpoint URL reduced to the instance base the CLI addresses. */
function mcpBaseUrl(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    return `${parsed.origin}${parsed.pathname.replace(/\/mcp\/?$/, '').replace(/\/+$/, '')}`;
  } catch {
    return endpoint.replace(/\/mcp\/?(\?.*)?$/, '').replace(/\/+$/, '');
  }
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

/**
 * mcp_config_write — one write an MCP install would make, stated before it is
 * made: the backend, the file, whether that file lies outside the project root
 * (a configuration every project on the machine shares), and the wairon entry
 * the file holds now beside the one it would hold.
 */
export interface McpConfigWrite {
  backend: 'claude' | 'gemini';
  path: string;
  outsideProject: boolean;
  /** The wairon entry the file holds now; undefined when none (or no readable file). */
  before?: unknown;
  after: Record<string, unknown>;
  upToDate: boolean;
}

/** One resolved backend's write, with what writing it needs. */
interface InstallTarget extends McpConfigWrite {
  configBase: string;
  settings: Record<string, unknown>;
  useGlobal: boolean;
}

/** Steps 2-3 of installMcpServer: the explicit --backend, else the configured targets' backends, else Claude. */
function resolveBackends(options: McpInstallOptions): ('claude' | 'gemini')[] {
  if (options.backend) return [normalizeBackend(options.backend)];
  const backends: ('claude' | 'gemini')[] = [];
  try {
    // A missing configuration contributes nothing, like an unreadable one.
    const config = loadProjectConfig();
    const enabledTypes = (config?.targets ?? [])
      .filter((t) => !('enabled' in t) || t.enabled)
      .map((t) => t.type);
    if (enabledTypes.includes('claude')) backends.push('claude');
    if (enabledTypes.includes('gemini') || enabledTypes.includes('agy')) backends.push('gemini');
  } catch {
    // Fallback if config loading fails
  }
  return backends.length ? backends : ['claude'];
}

/**
 * Steps 1-10 of installMcpServer, writing nothing: per backend, the file it
 * loads server definitions from, what that file holds, and the entry an
 * install would put there. planMcpInstall answers exactly this, so a caller's
 * plan and the install it confirms can never disagree.
 */
function resolveInstallTargets(options: McpInstallOptions): InstallTarget[] {
  assertProjectInitialized();
  if (options.configDir && !options.backend) {
    throw new WaironError('--config-dir requires --backend (claude or gemini), since a config dir is agent-specific.');
  }
  const root = getProjectRoot();
  return resolveBackends(options).map((backend) => {
    if (options.configDir) validateConfigDir(options.configDir, backend);
    // An explicit --config-dir implies a global-style install into that dir.
    const useGlobal = !!(options.global || options.configDir);

    // ── Resolve where to write settings ──────────────────────────────────────
    let configBase: string;
    let settingsPath: string;
    if (backend === 'gemini') {
      if (useGlobal) {
        // Global install (opt-in): just the Antigravity home MCP config. We do NOT
        // install a plugin — a plugin named "wairon" collides with the "wairon" MCP
        // server. (Any leftover plugin from older installs is retired by
        // `wairon doctor --fix`, not here — install only installs.)
        configBase = path.join(geminiGlobalDir(options.configDir), 'antigravity-cli');
        settingsPath = path.join(configBase, 'mcp_config.json');
      } else {
        // Project-local Gemini/Antigravity settings — stays within the project.
        configBase = path.join(process.cwd(), '.gemini');
        settingsPath = path.join(configBase, 'settings.json');
      }
    } else {
      // Claude reads server definitions from .mcp.json (project) or .claude.json (user scope),
      // NOT .claude/settings.json. claudeMcpConfigPath resolves the correct one.
      settingsPath = claudeMcpConfigPath(useGlobal, options.configDir);
      configBase = path.dirname(settingsPath);
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
    const mcpServers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;

    const isPackaged = typeof (process as any).pkg !== 'undefined';
    const scriptPath = process.argv[1] ? path.resolve(process.argv[1]).replace(/\\/g, '/') : null;
    const useDirectNode = !isPackaged && scriptPath && (scriptPath.endsWith('.js') || scriptPath.endsWith('.ts'));

    // Project-local installs know the exact project, so pin it: the server then
    // attaches deterministically regardless of the cwd the host spawns it with,
    // and never silently climbs to an ancestor .wai (e.g. a parent repo's tree).
    // Global installs are intentionally shared across projects, so they stay
    // unpinned and rely on MCP roots / cwd to scope per session.
    const env: Record<string, string> = useGlobal
      ? {}
      : { WAIRON_PROJECT_DIR: process.cwd().replace(/\\/g, '/') };

    // A HOSTED registration points the agent at an INSTANCE rather than at this
    // checkout: the same http endpoint, bearer and project selector the CLI's
    // remote surface uses, so `wairon remote` can read this entry back and the
    // agent and CLI provably work on the same project.
    const desiredEntry: Record<string, unknown> = options.hostedUrl
      ? hostedMcpEntry(options)
      : useDirectNode
        ? { command: 'node', args: [scriptPath, 'mcp', 'serve'], env }
        : { command: 'wairon', args: ['mcp', 'serve'], env };

    const existingEntry = mcpServers['wairon'];
    return {
      backend,
      path: settingsPath,
      outsideProject: isOutsideRoot(root, settingsPath),
      ...(existingEntry !== undefined ? { before: existingEntry } : {}),
      after: desiredEntry,
      upToDate: !!existingEntry && JSON.stringify(existingEntry) === JSON.stringify(desiredEntry),
      configBase,
      settings,
      useGlobal,
    };
  });
}

/**
 * planInstall — what runMcpInstall would write for these options, computed the
 * same way and writing nothing: one entry per resolved backend, naming the file,
 * whether it lies outside the project root, and the wairon entry before and
 * after. The plan a caller prints and confirms before an install may touch a
 * machine-wide file.
 */
export function planMcpInstall(options: McpInstallOptions): McpConfigWrite[] {
  return resolveInstallTargets(options).map(({ backend, path: file, outsideProject, before, after, upToDate }) => ({
    backend, path: file, outsideProject, ...(before !== undefined ? { before } : {}), after, upToDate,
  }));
}

export async function runMcpInstall(options: McpInstallOptions = {}): Promise<void> {
  for (const target of resolveInstallTargets(options)) {
    const agentLabel = target.backend === 'gemini' ? 'Antigravity' : 'Claude';
    // Self-heal: if an entry already exists but points somewhere else (e.g. a
    // stale path from a moved repo or an earlier machine), rewrite it instead of
    // skipping. Skipping is exactly how a broken `command`/`args` path survives
    // and leaves the agent with no wairon tools.
    if (target.upToDate) {
      logger.info(`wairon MCP server already registered (up to date) for ${agentLabel} in ${chalk.gray(target.path)}.`);
      continue;
    }
    writeInstallTarget(target);
    reportInstalled(target, agentLabel);
  }
}

/**
 * Step 11: write the entry under mcpServers.wairon, every other key kept. A
 * file outside the project root that already exists is first copied beside
 * itself, so a machine-wide configuration is never replaced without its
 * previous value kept.
 */
function writeInstallTarget(target: InstallTarget): void {
  const mcpServers = (target.settings['mcpServers'] ?? {}) as Record<string, unknown>;
  mcpServers['wairon'] = target.after;
  target.settings['mcpServers'] = mcpServers;
  if (!fs.existsSync(target.configBase)) fs.mkdirSync(target.configBase, { recursive: true });
  if (target.outsideProject && fs.existsSync(target.path)) {
    logger.info(`Backed up ${chalk.gray(target.path)} to ${chalk.cyan(backupBeside(target.path))} before replacing it (outside the project root).`);
  }
  fs.writeFileSync(target.path, JSON.stringify(target.settings, null, 2) + '\n');
}

/** Step 12: where it wrote, what the entry points at, and what the agent must do to pick it up. */
function reportInstalled(target: InstallTarget, agentLabel: string): void {
  const wasStale = target.before !== undefined;
  logger.success(`wairon MCP server ${wasStale ? 'updated (was stale)' : 'registered'} for ${agentLabel} in ${chalk.cyan(target.path)}.`);
  logger.blank();
  logger.info('AI tools using this config will have access to these wairon tools:');
  logger.info('  listAgents · getAgent · listDomains · validateTopology · getProjectConfig');
  logger.info('  sdd_initialize_system · sdd_add_subsystem · sdd_add_component · sdd_define_interface');
  logger.info('  sdd_write_narrative · sdd_validate_tree · sdd_get_status');
  logger.blank();
  const restartApp = target.backend === 'gemini' ? 'Antigravity CLI (agy)' : 'claude';
  logger.info(`Restart ${chalk.bold(restartApp)} (or reload MCP servers) to activate.`);

  // A project-scoped .mcp.json server needs a one-time trust approval the next
  // time Claude launches in this project (it shows as "⏸ Pending approval").
  if (target.backend === 'claude' && !target.useGlobal) {
    logger.warn('Claude shows project .mcp.json servers as "⏸ Pending approval" — approve wairon once on next launch (or run `claude` and accept the trust prompt).');
  }

  // Antigravity loads MCP from its global mcp_config.json, NOT the project's
  // .gemini/settings.json — so a project-local install won't surface tools there.
  if (target.backend === 'gemini' && !target.useGlobal) {
    logger.warn('Note: Antigravity (agy) reads MCP servers from its global ~/.gemini/antigravity-cli/mcp_config.json, not this project file.');
    logger.warn('If the agent cannot see the sdd_* tools, run: ' + chalk.bold('wairon mcp install --backend gemini --global'));
  }
  logger.blank();
}

// ---------------------------------------------------------------------------
// wairon mcp status  — show whether the MCP server is configured
// ---------------------------------------------------------------------------

export async function runMcpStatus(): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  if (!projectConfig) throw new ProjectNotInitializedError();
  const claudeProject = claudeMcpConfigPath(false);
  const claudeGlobal  = claudeMcpConfigPath(true);
  const geminiProject = path.join(process.cwd(), '.gemini', 'settings.json');
  const geminiGlobal  = path.join(geminiGlobalDir(), 'antigravity-cli', 'mcp_config.json');

  logger.blank();
  logger.info(`${chalk.bold('wairon MCP Server')}`);
  logger.blank();

  const checks = [
    { label: 'Claude (project)', filePath: claudeProject, fallbackName: '.mcp.json' },
    { label: 'Claude (user/global)', filePath: claudeGlobal, fallbackName: '.claude.json' },
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
 * The hosted (http) MCP entry: the instance's /mcp endpoint plus the headers the
 * data plane reads — the bearer it authenticates, and the project it binds. The
 * token comes from the flag, else the machine's stored credential for that
 * instance, so `wairon login` once is enough to wire an agent.
 */
function hostedMcpEntry(options: McpInstallOptions): Record<string, unknown> {
  const base = options.hostedUrl!.replace(/\/+$/, '');
  // The credential is RESOLVED BY THE CALLER, never read here: this adapter's
  // job is the config file, and reaching into the credential store would make
  // it depend on state it has no business knowing about.
  const token = (options.hostedToken ?? '').trim();
  if (!token) {
    throw new WaironError(
      `No credential for ${base}. Run \`wairon login ${base}\` first, or pass --token.`,
    );
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (options.hostedProject) headers['X-Wairon-Project'] = options.hostedProject;
  return { type: 'http', url: `${base}/mcp`, headers };
}

/** Where a legacy global Antigravity plugin would sit, under the same gemini home a global install writes into. */
function legacyPluginDir(): string {
  return path.join(geminiGlobalDir(), 'config', 'plugins', 'wairon');
}

/**
 * The legacy global Antigravity plugin (`<gemini home>/config/plugins/wairon`),
 * or null when there is none. A plugin named "wairon" collides with the
 * "wairon" MCP server in Antigravity ("server wairon is not allowed in this
 * context"); we no longer install one, and `wairon doctor --fix` retires it.
 */
export function findLegacyPlugin(): string | null {
  const dir = legacyPluginDir();
  return fs.existsSync(dir) ? dir : null;
}

/**
 * Retire the legacy plugin WITHOUT deleting it: move it out of the plugins
 * directory (where it would still load) to
 * `<gemini home>/config/wairon-plugin.wairon-backup-<timestamp>`, and answer
 * that path; null when there was none, or when the move failed (warned).
 */
export function retireLegacyPlugin(): string | null {
  const dir = findLegacyPlugin();
  if (!dir) return null;
  const backup = path.join(path.dirname(path.dirname(dir)), `wairon-plugin.wairon-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    fs.renameSync(dir, backup);
    logger.info(`Moved the legacy global Antigravity plugin ${chalk.gray(dir)} aside to ${chalk.cyan(backup)} (it collides with the wairon MCP server).`);
    return backup;
  } catch (e) {
    logger.warn(`Could not move the legacy wairon Antigravity plugin aside: ${String(e)}`);
    return null;
  }
}
