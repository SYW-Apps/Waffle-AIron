import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import * as admin from '../server/admin.js';
import * as packs from '../server/packs.js';
import { AdminAuthError, LockValidationError } from '../server/admin.js';
import { startHostServer } from '../server/http.js';
import type { HostConfig, Role } from '../server/types.js';

// ---------------------------------------------------------------------------
// CLI Host Client Adapter + host command runners (sdd_cli → sdd_host)
//
// The wairon CLI as an in-process client of the hosting control plane: `wairon
// serve` boots the server; `wairon host project|key …`, `wairon host lock`, and
// `wairon host promote` drive the same admin orchestrator functions the HTTP
// admin API uses. The master credential is read from WAIRON_ADMIN_TOKEN, so an
// operator on the box (or via `docker exec`) administers without extra flags.
// ---------------------------------------------------------------------------

export interface HostOptions {
  host?: string;
  port?: string | number;
  adminHost?: string;
  adminPort?: string | number;
  dataDir?: string;
  noAuth?: boolean;
  id?: string;
  project?: string;
  role?: string;
  remote?: string;
  branch?: string;
  target?: string;
  page?: string;
  key?: string;
  value?: string;
  name?: string;
  file?: string;
}

function resolveHostConfig(options: HostOptions): HostConfig {
  const dataDir = options.dataDir || process.env['WAIRON_DATA_DIR'] || path.join(os.homedir(), '.wairon', 'data');
  // Server-global packs live on the data volume so installs persist across
  // container recreation — and so the server, `docker exec`, and validation all
  // resolve the same directory. An explicit WAIRON_PACKS_DIR still wins.
  if (!process.env['WAIRON_PACKS_DIR']) {
    process.env['WAIRON_PACKS_DIR'] = path.join(dataDir, 'packs');
  }
  return {
    host: options.host || '0.0.0.0',
    port: options.port ? Number(options.port) : 8080,
    adminHost: options.adminHost || '127.0.0.1',
    adminPort: options.adminPort ? Number(options.adminPort) : 8081,
    dataDir,
    authEnabled: !options.noAuth,
  };
}

function masterCredential(): string | null {
  return process.env['WAIRON_ADMIN_TOKEN'] ?? null;
}

function mapAdminError(e: unknown): WaironError {
  if (e instanceof AdminAuthError) {
    return new WaironError('Forbidden: set WAIRON_ADMIN_TOKEN to the server\'s admin credential to run host commands.');
  }
  if (e instanceof LockValidationError) {
    const lines = e.errors.map((x) => `  • ${x.specId ? `[${x.specId}] ` : ''}[${x.code}] ${x.message}`).join('\n');
    return new WaironError(`${e.message}\n${lines}`);
  }
  return new WaironError(e instanceof Error ? e.message : String(e));
}

// ── wairon serve ────────────────────────────────────────────────────────────

export async function runServe(options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  let handle;
  try {
    handle = startHostServer(cfg);
  } catch (e) {
    throw new WaironError(e instanceof Error ? e.message : String(e));
  }
  logger.success('wairon hosting server started.');
  logger.info(`  data plane:  ${chalk.cyan(`http://${cfg.host}:${cfg.port}/mcp`)}   (auth ${cfg.authEnabled ? chalk.green('ON') : chalk.yellow('OFF')})`);
  logger.info(`  admin plane: ${chalk.cyan(`http://${cfg.adminHost}:${cfg.adminPort}/admin`)}`);
  logger.info(`  data dir:    ${chalk.gray(cfg.dataDir)}`);
  logger.blank();
  logger.info('Press Ctrl+C to stop.');
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      logger.info('Shutting down…');
      handle!.close();
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });
}

// ── wairon host project <action> ──────────────────────────────────────────────

export async function runHostProject(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'create': {
        if (!options.id) throw new WaironError('`--id <id>` is required for `host project create`.');
        const rec = admin.createProject(cfg, cred, options.id);
        logger.success(`Created project "${rec.id}" at ${chalk.gray(rec.rootPath)}`);
        break;
      }
      case 'list': {
        const list = admin.listProjects(cfg, cred);
        if (!list.length) {
          logger.info('No projects.');
        } else {
          for (const r of list) logger.info(`  ${r.id.padEnd(20)} ${r.status.padEnd(9)} ${chalk.gray(r.rootPath)}`);
        }
        break;
      }
      case 'destroy': {
        if (!options.id) throw new WaironError('`--id <id>` is required for `host project destroy`.');
        admin.destroyProject(cfg, cred, options.id);
        logger.success(`Destroyed project "${options.id}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown project action "${action}" (create | list | destroy).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host key <action> ──────────────────────────────────────────────────

export async function runHostKey(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'mint': {
        if (!options.project) throw new WaironError('`--project <id|*>` is required for `host key mint`.');
        const role = (options.role ?? 'editor') as Role;
        if (role !== 'editor' && role !== 'admin') throw new WaironError('`--role` must be editor or admin.');
        const key = admin.mintKey(cfg, cred, options.project, role);
        logger.success('API key minted (shown once — store it now):');
        logger.blank();
        console.log(`  ${chalk.bold(key)}`);
        logger.blank();
        break;
      }
      case 'list': {
        const list = admin.listKeys(cfg, cred, options.project ?? '*');
        if (!list.length) {
          logger.info('No keys.');
        } else {
          for (const r of list) logger.info(`  ${r.id}  ${r.role.padEnd(6)} ${r.projects.join(',')}`);
        }
        break;
      }
      case 'revoke': {
        if (!options.id) throw new WaironError('`--id <id>` is required for `host key revoke`.');
        admin.revokeKey(cfg, cred, options.id);
        logger.success(`Revoked key "${options.id}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown key action "${action}" (mint | list | revoke).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host lock / promote ────────────────────────────────────────────────

export async function runHostLock(options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  if (!options.project) throw new WaironError('`--project <id>` is required for `host lock`.');
  try {
    const rec = admin.lockProject(cfg, masterCredential(), options.project);
    logger.success(`Locked "${options.project}" @ ${rec.stateId.algorithm}:${rec.stateId.digest.slice(0, 12)}… (status ${rec.status}).`);
  } catch (e) {
    throw mapAdminError(e);
  }
}

export async function runHostPromote(options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  if (!options.project) throw new WaironError('`--project <id>` is required for `host promote`.');
  try {
    const result = admin.promoteProject(cfg, masterCredential(), options.project);
    const mark = result.status === 'ready' ? chalk.green('✓') : chalk.yellow('✗');
    logger.info(`${mark} ${result.message}`);
    if (result.status !== 'ready') process.exitCode = 1;
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host git <action> ──────────────────────────────────────────────────

// ── wairon host producer <action> ─────────────────────────────────────────────

export async function runHostProducer(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  const target = options.target ?? 'notion';
  try {
    switch (action) {
      case 'configure': {
        if (!options.project || !options.page) throw new WaironError('`--project <id>` and `--page <id>` are required.');
        admin.configureProducer(cfg, cred, options.project, target, options.page);
        logger.success(`Configured "${target}" for project "${options.project}".`);
        break;
      }
      case 'produce': {
        if (!options.project) throw new WaironError('`--project <id>` is required.');
        await admin.produceProducer(cfg, cred, options.project, target);
        logger.success(`Produced "${options.project}" to "${target}".`);
        break;
      }
      case 'remove': {
        if (!options.project) throw new WaironError('`--project <id>` is required.');
        admin.removeProducer(cfg, cred, options.project, target);
        logger.success(`Removed "${target}" from project "${options.project}".`);
        break;
      }
      case 'list': {
        if (!options.project) throw new WaironError('`--project <id>` is required.');
        const list = admin.listProducers(cfg, cred, options.project);
        if (!list.length) logger.info('No producers configured.');
        else for (const p of list) logger.info(`  ${p.target.padEnd(10)} → ${p.parentPageId}`);
        break;
      }
      default:
        throw new WaironError(`Unknown producer action "${action}" (configure | produce | remove | list).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host secret <action> ───────────────────────────────────────────────

export async function runHostSecret(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'set': {
        if (!options.key || options.value === undefined) throw new WaironError('`--key <name>` and `--value <secret>` are required.');
        admin.setSecret(cfg, cred, options.key, options.value);
        logger.success(`Secret "${options.key}" set (read live — no restart needed).`);
        break;
      }
      case 'list': {
        const keys = admin.listSecrets(cfg, cred);
        if (!keys.length) logger.info('No secrets set.');
        else for (const k of keys) logger.info(`  ${k}`);
        break;
      }
      default:
        throw new WaironError(`Unknown secret action "${action}" (set | list).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

// ── wairon host packs <action> ────────────────────────────────────────────────

export async function runHostPacks(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  const project = options.project;
  const scope = project ? `project "${project}"` : 'server-global';
  try {
    switch (action) {
      case 'list': {
        const list = project ? packs.listProjectPacks(cfg, cred, project) : packs.listGlobalPacks(cfg, cred);
        if (!list.length) {
          logger.info(`No ${scope} packs.`);
          break;
        }
        logger.info(`${scope} packs:`);
        for (const p of list) {
          if (p.error) console.log(`  ${chalk.red('✖')} ${chalk.bold(p.name)}  ${chalk.red(p.error)}`);
          else console.log(`  ${chalk.green('●')} ${chalk.bold(p.name.padEnd(20))} ${chalk.gray(`${p.profiles} profile(s), ${p.languages} language(s), ${p.rules} rule(s)`)}`);
        }
        break;
      }
      case 'install': {
        if (!options.file) throw new WaironError('`--file <path>` (a declarative pack YAML) is required for install.');
        const name = options.name ?? path.basename(options.file).replace(/\.(ya?ml)$/i, '');
        const content = fs.readFileSync(path.resolve(options.file), 'utf8');
        const desc = project
          ? packs.installProjectPack(cfg, cred, project, name, content)
          : packs.installGlobalPack(cfg, cred, name, content);
        logger.success(`Installed ${scope} pack "${desc.name}" (${desc.profiles} profile(s), ${desc.languages} language(s)).`);
        if (project) logger.info('Committed with the project — every clone and CI will enforce it.');
        break;
      }
      case 'remove': {
        if (!options.name) throw new WaironError('`--name <name>` is required for `host packs remove`.');
        if (project) packs.removeProjectPack(cfg, cred, project, options.name);
        else packs.removeGlobalPack(cfg, cred, options.name);
        logger.success(`Removed ${scope} pack "${options.name}".`);
        break;
      }
      default:
        throw new WaironError(`Unknown packs action "${action}" (list | install | remove).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}

export async function runHostGit(action: string, options: HostOptions = {}): Promise<void> {
  const cfg = resolveHostConfig(options);
  const cred = masterCredential();
  try {
    switch (action) {
      case 'enable': {
        if (!options.project || !options.remote) {
          throw new WaironError('`--project <id>` and `--remote <url>` are required for `host git enable`.');
        }
        admin.enableGit(cfg, cred, options.project, options.remote, options.branch ?? 'main');
        logger.success(`Git backing enabled for "${options.project}" (cloned ${options.remote}).`);
        break;
      }
      case 'disable': {
        if (!options.project) throw new WaironError('`--project <id>` is required for `host git disable`.');
        admin.disableGit(cfg, cred, options.project);
        logger.success(`Git backing disabled for "${options.project}".`);
        break;
      }
      case 'sync': {
        if (!options.project) throw new WaironError('`--project <id>` is required for `host git sync`.');
        admin.syncGit(cfg, cred, options.project);
        logger.success(`Synced "${options.project}" (default → working branch).`);
        break;
      }
      default:
        throw new WaironError(`Unknown git action "${action}" (enable | disable | sync).`);
    }
  } catch (e) {
    throw mapAdminError(e);
  }
}
