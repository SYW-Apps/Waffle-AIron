import * as http from 'http';
import inquirer from 'inquirer';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Waffler MCP server connection resolution
//
// Resolution order:
//   1. --url argument (user-specified, skip auto-detection entirely)
//   2. waffler.mcpServerUrl in project.yaml (project-level preference)
//   3. Auto-detect: probe WAFFLER_DEFAULT_MCP_URL (localhost:42069/_mcp)
//   4. Prompt: ask the user to enter a custom URL
//
// NOTE: The path `/_mcp` is a placeholder pending confirmation from the
// Waffler project on the reserved path in port 42069's URL space.
// Change WAFFLER_DEFAULT_MCP_PATH when the path is finalized.
// ---------------------------------------------------------------------------

export const WAFFLER_DEFAULT_HOST    = 'localhost';
export const WAFFLER_DEFAULT_PORT    = 42069;
export const WAFFLER_DEFAULT_MCP_PATH = '/_mcp';
export const WAFFLER_DEFAULT_MCP_URL  =
  `http://${WAFFLER_DEFAULT_HOST}:${WAFFLER_DEFAULT_PORT}${WAFFLER_DEFAULT_MCP_PATH}`;

// How long (ms) to wait when probing the local Waffler instance
const PROBE_TIMEOUT_MS = 2500;

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Returns true if the given URL responds with any HTTP status code within the
 * timeout. We do not check the response body — just whether Waffler is up.
 */
export function probeUrl(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { resolve(false); return; }

    const req = http.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || 80,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        timeout:  timeoutMs,
      },
      () => { resolve(true); req.destroy(); },
    );
    req.on('error',   () => resolve(false));
    req.on('timeout', () => { resolve(false); req.destroy(); });
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** --url CLI argument — if provided, use it directly without probing */
  urlArg?: string;
  /** waffler.mcpServerUrl from project.yaml */
  configUrl?: string;
  /** Skip the probe and go straight to prompt (useful in tests) */
  skipProbe?: boolean;
}

export interface ResolvedConnection {
  url:    string;
  source: 'arg' | 'config' | 'auto' | 'prompt';
}

/**
 * Resolve the Waffler MCP server URL to connect to.
 * Returns null if the user cancels at the prompt.
 */
export async function resolveWafflerMcpUrl(
  options: ResolveOptions = {},
): Promise<ResolvedConnection | null> {

  // 1. Explicit --url argument — trust it, no probing
  if (options.urlArg) {
    logger.verbose(`Using Waffler MCP URL from --url argument: ${options.urlArg}`);
    return { url: options.urlArg, source: 'arg' };
  }

  // 2. Project config URL — trust it, no probing
  if (options.configUrl) {
    logger.verbose(`Using Waffler MCP URL from project config: ${options.configUrl}`);
    return { url: options.configUrl, source: 'config' };
  }

  // 3. Auto-detect local instance
  if (!options.skipProbe) {
    logger.verbose(`Probing local Waffler instance at ${WAFFLER_DEFAULT_MCP_URL}…`);
    const reachable = await probeUrl(WAFFLER_DEFAULT_MCP_URL);
    if (reachable) {
      logger.verbose(`Local Waffler instance found.`);
      return { url: WAFFLER_DEFAULT_MCP_URL, source: 'auto' };
    }
    logger.verbose(`Local Waffler instance not reachable.`);
  }

  // 4. Prompt the user
  logger.blank();
  logger.warn(`No local Waffler instance found at ${chalk.gray(WAFFLER_DEFAULT_MCP_URL)}.`);
  logger.info('Waffler must be running with the MCP server package installed.');
  logger.blank();
  logger.info(`To use your local instance: start Waffler and install the ${chalk.bold('mcp_server')} package.`);
  logger.info(`To connect to a remote instance: enter its MCP endpoint URL below.`);
  logger.info(`To save a URL permanently: set ${chalk.bold('waffler.mcpServerUrl')} in ${chalk.gray('.wai/project.yaml')}.`);
  logger.blank();

  const { choice } = await inquirer.prompt<{ choice: string }>([{
    type:    'list',
    name:    'choice',
    message: 'How would you like to connect?',
    choices: [
      { name: `Retry local instance  ${chalk.gray(`(${WAFFLER_DEFAULT_MCP_URL})`)}`, value: 'retry' },
      { name: 'Enter a custom URL',                                                   value: 'custom' },
      { name: 'Cancel',                                                                value: 'cancel' },
    ],
  }]);

  if (choice === 'cancel') return null;

  if (choice === 'retry') {
    const reachable = await probeUrl(WAFFLER_DEFAULT_MCP_URL);
    if (!reachable) {
      logger.error(`Still not reachable. Start Waffler and try again.`);
      return null;
    }
    return { url: WAFFLER_DEFAULT_MCP_URL, source: 'auto' };
  }

  // custom URL
  const { customUrl } = await inquirer.prompt<{ customUrl: string }>([{
    type:     'input',
    name:     'customUrl',
    message:  'Waffler MCP server URL:',
    default:  WAFFLER_DEFAULT_MCP_URL,
    validate: (v: string) => {
      try { new URL(v); return true; }
      catch { return 'Enter a valid URL (e.g. http://localhost:42069/_mcp)'; }
    },
  }]);

  // Probe the custom URL too
  logger.verbose(`Probing ${customUrl}…`);
  const reachable = await probeUrl(customUrl, 4000);
  if (!reachable) {
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([{
      type:    'confirm',
      name:    'proceed',
      message: `${customUrl} did not respond. Connect anyway?`,
      default: false,
    }]);
    if (!proceed) return null;
  }

  return { url: customUrl, source: 'prompt' };
}

// ---------------------------------------------------------------------------
// Display helper
// ---------------------------------------------------------------------------

export function printConnectionInfo(conn: ResolvedConnection): void {
  const sourceLabel: Record<ResolvedConnection['source'], string> = {
    arg:    '--url argument',
    config: 'project.yaml',
    auto:   'auto-detected',
    prompt: 'entered manually',
  };
  logger.info(`Waffler MCP: ${chalk.cyan(conn.url)}  ${chalk.gray(`(${sourceLabel[conn.source]})`)}`);
}
