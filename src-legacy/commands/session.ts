import { spawn } from 'child_process';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { logger } from '../utils/logger.js';
import { fromProjectRoot } from '../utils/fs.js';
import { assertProjectInitialized, loadProjectConfig } from '../config/loader.js';
import { findDomain } from '../core/domains.js';
import { resolveToolCommand } from '../config/profiles.js';
import {
  findDefaultSession,
  listSessions,
  loadSession,
  saveSession,
  scaffoldSession,
  sessionEnvVars,
  cleanSessions,
  generateSessionId,
} from '../core/sessions.js';
import { Session } from '../models/session.js';

// ---------------------------------------------------------------------------
// session start  (the main entry point — `wairon session`)
// ---------------------------------------------------------------------------

export interface SessionStartOptions {
  backend?:  string;
  domain?:   string;
  model?:    string;
  label?:    string;
  /** Force a fresh session instead of resuming the most recent one */
  new?:      boolean;
  /** Print the tool config dir path and exit (for shell integration) */
  printDir?: boolean;
  /** Extra environment variables merged into the subprocess env */
  extraEnv?: Record<string, string>;
}

export async function runSessionStart(options: SessionStartOptions = {}): Promise<void> {
  assertProjectInitialized();
  const projectConfig = loadProjectConfig();

  const backend  = options.backend  ?? projectConfig.defaultBackend ?? 'claude';
  const domainId = options.domain ?? null;

  // Validate domain if given
  if (domainId) {
    const domain = findDomain(domainId);
    if (!domain) {
      logger.error(`Domain "${domainId}" not found. Run \`wairon domains list\` to see available domains.`);
      process.exit(1);
    }
  }

  // ── Resolve or create session ─────────────────────────────────────────────
  let session: Session | null = null;

  if (!options.new) {
    session = findDefaultSession(backend, domainId);
    if (session) {
      logger.verbose(`Resuming session: ${session.id}`);
    }
  }

  if (!session) {
    const id = generateSessionId(backend, domainId);
    const label = options.label
      ?? (domainId ? `${backend} / ${domainId}` : backend);
    session = {
      id,
      label,
      isDefault:  true,
      backend:    backend as Session['backend'],
      domainId,
      status:     'idle',
      startCount: 0,
      createdAt:  new Date().toISOString(),
    };
    saveSession(session);
    logger.verbose(`Created new session: ${id}`);
  }

  // ── Scaffold workspace (always refresh context file) ─────────────────────
  logger.verbose('Refreshing session context...');
  const toolConfigDir = scaffoldSession(session);

  if (options.printDir) {
    console.log(toolConfigDir);
    return;
  }

  // ── Build spawn env ───────────────────────────────────────────────────────
  const cmd = resolveToolCommand(backend, projectConfig.profile);
  const cwd = domainId
    ? (() => {
        const d = findDomain(domainId);
        return d ? fromProjectRoot(d.path) : fromProjectRoot();
      })()
    : fromProjectRoot();

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    ...sessionEnvVars(session.id, backend),
    ...(options.extraEnv ?? {}),
  };
  if (options.model) {
    env['WAIRON_MODEL'] = options.model;
  }

  // ── Display session info ──────────────────────────────────────────────────
  logger.blank();
  const isNew = session.startCount === 0;
  if (isNew) {
    logger.info(`${chalk.bold('New session:')} ${chalk.cyan(session.id)}`);
  } else {
    logger.info(`${chalk.bold('Resuming:')} ${chalk.cyan(session.id)} (${session.startCount} prior start${session.startCount !== 1 ? 's' : ''})`);
  }
  if (domainId) logger.info(`Domain:  ${chalk.cyan(domainId)}`);
  logger.info(`Backend: ${chalk.bold(cmd)}`);
  logger.info(`Config:  ${chalk.gray(toolConfigDir)}`);
  logger.blank();

  // ── Update status → active ────────────────────────────────────────────────
  session.status        = 'active';
  session.startCount    = (session.startCount ?? 0) + 1;
  session.lastStartedAt = new Date().toISOString();
  saveSession(session);

  logger.info(chalk.gray('─── session start ───────────────────────────────────────────────'));
  logger.blank();

  // ── Spawn ─────────────────────────────────────────────────────────────────
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(cmd, [], {
      cwd,
      stdio:  'inherit',
      shell:  true,
      env,
    });
    child.on('exit',  (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      logger.error(`Failed to start ${cmd}: ${err.message}`);
      logger.info(`Is ${chalk.bold(cmd)} installed and on your PATH?`);
      logger.blank();
      logger.info('Tip: if you use a different command for this tool, set it up with:');
      logger.info(`  wairon profiles create`);
      resolve(1);
    });
  });

  logger.blank();
  logger.info(chalk.gray('─── session end ─────────────────────────────────────────────────'));
  logger.blank();

  // ── Update status → idle / crashed ───────────────────────────────────────
  session.status       = exitCode === 0 ? 'idle' : 'crashed';
  session.lastEndedAt  = new Date().toISOString();
  saveSession(session);

  if (exitCode !== 0) {
    logger.warn(`Session ended with exit code ${exitCode}.`);
    logger.info(`Session workspace kept at: ${chalk.gray(`.wai/sessions/${session.id}/`)}`);
  }
}

// ---------------------------------------------------------------------------
// session list
// ---------------------------------------------------------------------------

export async function runSessionList(): Promise<void> {
  assertProjectInitialized();

  const sessions = listSessions();

  if (sessions.length === 0) {
    logger.info('No sessions yet. Start one with `wairon session`.');
    return;
  }

  logger.blank();
  for (const s of sessions) {
    const sc      = _statusColor(s.status);
    const domain  = s.domainId ? chalk.gray(` [@${s.domainId}]`) : '';
    const label   = s.label ? chalk.gray(` — ${s.label}`) : '';
    const starts  = chalk.gray(` (${s.startCount ?? 0} start${s.startCount !== 1 ? 's' : ''})`);
    const last    = s.lastStartedAt
      ? chalk.gray(` · ${_relativeTime(s.lastStartedAt)}`)
      : '';
    console.log(`  ${sc(s.status.padEnd(8))}  ${chalk.bold(s.id)}${domain}${label}${starts}${last}`);
  }
  logger.blank();
  logger.info(`Resume a session: ${chalk.bold('wairon session --backend <backend>')}`);
  logger.info(`New session:      ${chalk.bold('wairon session --new')}`);
}

// ---------------------------------------------------------------------------
// session show <id>
// ---------------------------------------------------------------------------

export async function runSessionShow(id: string): Promise<void> {
  assertProjectInitialized();

  let session: Session;
  try { session = loadSession(id); }
  catch { logger.error(`Session "${id}" not found.`); process.exit(1); }

  logger.blank();
  const sc = _statusColor(session.status);
  console.log(`${chalk.bold('Id:')}      ${session.id}`);
  if (session.label)   console.log(`${chalk.bold('Label:')}   ${session.label}`);
  console.log(`${chalk.bold('Status:')}  ${sc(session.status)}`);
  console.log(`${chalk.bold('Backend:')} ${session.backend}`);
  if (session.domainId) console.log(`${chalk.bold('Domain:')}  ${session.domainId}`);
  console.log(`${chalk.bold('Starts:')}  ${session.startCount ?? 0}`);
  console.log(`${chalk.bold('Created:')} ${session.createdAt}`);
  if (session.lastStartedAt) console.log(`${chalk.bold('Last run:')} ${session.lastStartedAt}`);
  logger.blank();
  console.log(`Workspace: ${chalk.gray(`.wai/sessions/${session.id}/`)}`);
  logger.blank();
}

// ---------------------------------------------------------------------------
// session clean
// ---------------------------------------------------------------------------

export interface SessionCleanOptions {
  all?:        boolean;
  keepRecent?: number;
}

export async function runSessionClean(options: SessionCleanOptions = {}): Promise<void> {
  assertProjectInitialized();

  const keepRecent = options.keepRecent ?? (options.all ? 0 : 3);
  const sessions   = listSessions().filter((s) => s.status !== 'active');

  const toRemove = options.all
    ? sessions
    : sessions.slice(keepRecent);

  if (toRemove.length === 0) {
    logger.info(`Nothing to clean (keeping ${keepRecent} most recent session${keepRecent !== 1 ? 's' : ''}).`);
    return;
  }

  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([{
    type:    'confirm',
    name:    'confirmed',
    message: `Remove ${toRemove.length} session workspace${toRemove.length !== 1 ? 's' : ''}?`,
    default: true,
  }]);
  if (!confirmed) { logger.info('Cancelled.'); return; }

  const removed = cleanSessions({ keepRecent, all: options.all });
  logger.success(`Removed ${removed} session workspace${removed !== 1 ? 's' : ''}.`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _statusColor(status: string): (s: string) => string {
  switch (status) {
    case 'active':  return chalk.green;
    case 'idle':    return chalk.blue;
    case 'crashed': return chalk.red;
    default:        return chalk.gray;
  }
}

function _relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  if (mins < 1)   return 'just now';
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
