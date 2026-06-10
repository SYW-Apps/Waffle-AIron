import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { assertProjectInitialized, loadProjectConfig, saveProjectConfig } from '../config/loader.js';
import {
  resolveWafflerMcpUrl,
  printConnectionInfo,
  WAFFLER_DEFAULT_MCP_URL,
} from '../waffler/connection.js';

// ---------------------------------------------------------------------------
// wairon waffler session
//
// Starts an AI session connected to a Waffler MCP server. The session is a
// standard wairon session (wairon session) with additional environment
// variables pointing the AI at the Waffler MCP endpoint.
//
// The AI uses the MCP tools exposed by the Waffler mcp_server package to
// discover capabilities, build blueprints node by node, and validate each
// step. It never reads blueprint JSON directly.
// ---------------------------------------------------------------------------

export interface WafflerSessionOptions {
  /** Explicit MCP server URL — skips auto-detection and config lookup */
  url?:     string;
  backend?: string;
  model?:   string;
  label?:   string;
  new?:     boolean;
}

export async function runWafflerSession(options: WafflerSessionOptions = {}): Promise<void> {
  assertProjectInitialized();
  const projectConfig = loadProjectConfig();

  // Resolve MCP server URL
  const conn = await resolveWafflerMcpUrl({
    urlArg:    options.url,
    configUrl: projectConfig.waffler?.mcpServerUrl,
  });

  if (!conn) {
    logger.info('Waffler session cancelled.');
    return;
  }

  printConnectionInfo(conn);
  logger.blank();

  // Delegate to the standard session start with Waffler env vars injected.
  // We lazy-require to avoid pulling all of sessions.ts into this module.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { runSessionStart } = require('./session.js') as typeof import('./session.js');
  /* eslint-enable @typescript-eslint/no-require-imports */

  await runSessionStart({
    backend: options.backend ?? projectConfig.defaultBackend ?? 'claude',
    model:   options.model,
    label:   options.label ?? 'Waffler Blueprint Builder',
    new:     options.new,
    // Extra env vars injected into the session subprocess so the AI's MCP
    // client (Claude Code / Gemini CLI) can find the Waffler MCP server.
    extraEnv: {
      WAFFLER_MCP_URL: conn.url,
    },
  });
}

// ---------------------------------------------------------------------------
// wairon waffler connect  — test the connection and show status
// ---------------------------------------------------------------------------

export async function runWafflerConnect(options: { url?: string } = {}): Promise<void> {
  assertProjectInitialized();
  const projectConfig = loadProjectConfig();

  logger.blank();
  logger.info(chalk.bold('Waffler MCP connection check'));
  logger.blank();

  const conn = await resolveWafflerMcpUrl({
    urlArg:    options.url,
    configUrl: projectConfig.waffler?.mcpServerUrl,
    skipProbe: false,
  });

  if (!conn) {
    logger.error('Could not connect to a Waffler MCP server.');
    return;
  }

  printConnectionInfo(conn);
  logger.success('Connection successful.');
  logger.blank();

  if (conn.source === 'prompt' || conn.source === 'auto') {
    logger.info(`To save this URL permanently, add to ${chalk.gray('.wai/project.yaml')}:`);
    logger.info(chalk.gray(`  waffler:\n    mcpServerUrl: "${conn.url}"`));
    logger.blank();
  }
}

// ---------------------------------------------------------------------------
// wairon waffler set-url  — save the MCP server URL to project config
// ---------------------------------------------------------------------------

export async function runWafflerSetUrl(url: string): Promise<void> {
  assertProjectInitialized();

  try { new URL(url); }
  catch {
    logger.error(`"${url}" is not a valid URL.`);
    process.exit(1);
  }

  const config = loadProjectConfig();
  config.waffler = { ...config.waffler, mcpServerUrl: url };
  config.updatedAt = new Date().toISOString();
  saveProjectConfig(config);

  logger.success(`Waffler MCP URL saved: ${chalk.cyan(url)}`);
  logger.info(`Run ${chalk.bold('wairon waffler connect')} to verify the connection.`);
}

// ---------------------------------------------------------------------------
// wairon waffler status  — show current Waffler integration config
// ---------------------------------------------------------------------------

export async function runWafflerStatus(): Promise<void> {
  assertProjectInitialized();
  const config = loadProjectConfig();

  logger.blank();
  logger.info(chalk.bold('Waffler Integration'));
  logger.blank();

  const configuredUrl = config.waffler?.mcpServerUrl;
  if (configuredUrl) {
    console.log(`  Configured URL: ${chalk.cyan(configuredUrl)}`);
  } else {
    console.log(`  Configured URL: ${chalk.gray('(none — will auto-detect local instance)')}`);
    console.log(`  Default probe:  ${chalk.gray(WAFFLER_DEFAULT_MCP_URL)}`);
  }

  logger.blank();
  logger.info(`Test connection:  ${chalk.bold('wairon waffler connect')}`);
  logger.info(`Set a custom URL: ${chalk.bold('wairon waffler set-url <url>')}`);
  logger.info(`Start a session:  ${chalk.bold('wairon waffler session')}`);
  logger.blank();
}
