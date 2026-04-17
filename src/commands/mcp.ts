import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { aiDir } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// wairon mcp serve
// ---------------------------------------------------------------------------

export async function runMcpServe(): Promise<void> {
  // Validate that we're in an initialized project before starting.
  assertProjectInitialized();

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
  backend?: 'claude' | 'gemini';
  global?:  boolean;
}

export async function runMcpInstall(options: McpInstallOptions = {}): Promise<void> {
  assertProjectInitialized();

  const backend = options.backend ?? 'claude';

  if (backend === 'gemini') {
    logger.warn('Gemini CLI MCP config auto-install is not yet supported.');
    logger.info('Add the server manually to your Gemini CLI settings.');
    return;
  }

  // ── Resolve where to write settings ──────────────────────────────────────
  const configBase = options.global
    ? path.join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '', '.claude')
    : path.join(process.cwd(), '.claude');

  const settingsPath = path.join(configBase, 'settings.json');

  // ── Read existing settings (or start fresh) ───────────────────────────────
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      logger.warn(`Could not parse ${settingsPath} — starting fresh.`);
    }
  }

  // ── Build the mcpServers entry ────────────────────────────────────────────
  const mcpServers = (settings['mcpServers'] ?? {}) as Record<string, unknown>;

  if (mcpServers['wairon']) {
    logger.info(`wairon MCP server is already registered in ${chalk.gray(settingsPath)}.`);
    return;
  }

  mcpServers['wairon'] = {
    command: 'wairon',
    args:    ['mcp', 'serve'],
    env:     {},
  };
  settings['mcpServers'] = mcpServers;

  // ── Write back ────────────────────────────────────────────────────────────
  if (!fs.existsSync(configBase)) fs.mkdirSync(configBase, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  logger.success(`wairon MCP server registered in ${chalk.cyan(settingsPath)}.`);
  logger.blank();
  logger.info('AI tools using this config will have access to these wairon tools:');
  logger.info('  listAgents · getAgent · listDomains · validateTopology · getProjectConfig');
  logger.info('  listRuns · getRunStatus · getStepResult · listPipelines · getPipeline');
  logger.info('  getPipelineStatus · listSessions · listJobs · getJob');
  logger.blank();
  logger.info(`Restart ${chalk.bold('claude')} (or reload MCP servers) to activate.`);
}

// ---------------------------------------------------------------------------
// wairon mcp status  — show whether the MCP server is configured
// ---------------------------------------------------------------------------

export async function runMcpStatus(): Promise<void> {
  assertProjectInitialized();

  const projectConfig = loadProjectConfig();
  const projectSettings = path.join(process.cwd(), '.claude', 'settings.json');
  const globalSettings  = path.join(
    process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
    '.claude', 'settings.json',
  );

  logger.blank();
  logger.info(`${chalk.bold('wairon MCP Server')}`);
  logger.blank();

  for (const [label, filePath] of [['Project', projectSettings], ['Global', globalSettings]] as [string, string][]) {
    if (!fs.existsSync(filePath)) {
      console.log(`  ${label}: ${chalk.gray('settings.json not found')}`);
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
  logger.info(`To register: ${chalk.bold('wairon mcp install')}`);
  logger.info(`To start manually: ${chalk.bold('wairon mcp serve')}`);
  logger.blank();

  // Also show wai dir location so user knows where context comes from
  const mcpDir = aiDir('mcp');
  if (fs.existsSync(mcpDir)) {
    logger.info(`MCP state dir: ${chalk.gray(mcpDir)}`);
  }
}
