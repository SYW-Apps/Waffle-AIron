import inquirer from 'inquirer';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/loader.js';
import * as producerPortal from '../producers/index.js';

// ---------------------------------------------------------------------------
// CLI Producer Client Adapter + `wairon produce` (sdd_cli → sdd_producers)
//
// Projects the LOCAL project's specs to a producer target (e.g. notion),
// resolving the credential from --token, else env, else an interactive prompt —
// so a local user need not store anything.
// ---------------------------------------------------------------------------

export interface ProduceOptions {
  page?: string;
  token?: string;
}

export async function runProduce(target: string, options: ProduceOptions = {}): Promise<void> {
  assertProjectInitialized();
  if (target !== 'notion') throw new WaironError(`Unknown producer target "${target}" (supported: notion).`);
  if (!options.page) throw new WaironError('`--page <id>` (the target parent page) is required.');

  // Resolve the credential: --token -> env -> interactive prompt.
  let token = options.token || process.env['WAIRON_NOTION_TOKEN'] || null;
  if (!token) {
    if (!process.stdin.isTTY) throw new WaironError('No Notion token — pass --token or set WAIRON_NOTION_TOKEN.');
    const ans = await inquirer.prompt<{ token: string }>([
      { type: 'password', name: 'token', message: 'Notion integration token:', mask: '*' },
    ]);
    token = ans.token;
  }
  if (!token) throw new WaironError('A Notion token is required.');
  process.env['WAIRON_NOTION_TOKEN'] = token; // read via resolveSecret during this run

  producerPortal.configure(target, options.page);
  logger.info(`Projecting the spec tree to ${chalk.bold(target)}…`);
  try {
    await producerPortal.produce(target, '');
  } catch (e) {
    throw new WaironError(e instanceof Error ? e.message : String(e));
  }
  logger.success('Projected the spec tree to Notion (under a "wairon specs" page).');
}
