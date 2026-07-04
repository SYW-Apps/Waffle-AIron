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

const TARGETS: Record<string, { envKey: string; label: string; noun: string }> = {
  notion: { envKey: 'WAIRON_NOTION_TOKEN', label: 'Notion', noun: 'parent page' },
  miro: { envKey: 'WAIRON_MIRO_TOKEN', label: 'Miro', noun: 'board' },
};

export async function runProduce(target: string, options: ProduceOptions = {}): Promise<void> {
  assertProjectInitialized();
  const t = TARGETS[target];
  if (!t) throw new WaironError(`Unknown producer target "${target}" (supported: ${Object.keys(TARGETS).join(', ')}).`);
  if (!options.page) throw new WaironError(`\`--page <id>\` (the target ${t.noun} id) is required.`);

  // Resolve the credential: --token -> env -> interactive prompt.
  let token = options.token || process.env[t.envKey] || null;
  if (!token) {
    if (!process.stdin.isTTY) throw new WaironError(`No ${t.label} token — pass --token or set ${t.envKey}.`);
    const ans = await inquirer.prompt<{ token: string }>([
      { type: 'password', name: 'token', message: `${t.label} token:`, mask: '*' },
    ]);
    token = ans.token;
  }
  if (!token) throw new WaironError(`A ${t.label} token is required.`);
  process.env[t.envKey] = token; // read via resolveSecret during this run

  producerPortal.configure(target, options.page);
  logger.info(`Projecting the spec tree to ${chalk.bold(t.label)}…`);
  try {
    await producerPortal.produce(target, '');
  } catch (e) {
    throw new WaironError(e instanceof Error ? e.message : String(e));
  }
  logger.success(`Projected the spec tree to ${t.label}.`);
}
