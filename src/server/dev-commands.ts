import { authenticateSession } from './auth.js';
import { existingProjectRoot } from './projects.js';
import { runWithProjectRoot } from '../utils/fs.js';
import * as hostCore from './adapters/core.js';
import { ForbiddenError, UnauthenticatedError } from './errors.js';
import type { ReviewNote, ReviewRequest, ReviewStatus } from '../core/reviews.js';
import type { ApprovalVerdict } from '../core/approval.js';
import { describeApprover } from '../models/lock.js';
import type { HostConfig } from './types.js';
import * as path from 'path';
import * as fs from 'fs';
import { declaredExternals, declaredMembers } from '../models/project.js';
import type { DevProducer } from './dev-watcher.js';

// ---------------------------------------------------------------------------
// dev_cockpit_orchestrator (sdd_host) — the dev page's reviews and commands.
//
// Only the local development server has them. The review requests an agent made
// are read and decided through the core adapter, bound to the served project;
// the human's commands (lock, generate, doctor --fix) are the ones the starting
// CLI handed the server in its configuration, so the page runs exactly what the
// terminal runs. One command runs at a time.
// ---------------------------------------------------------------------------

/** What a human command run from the dev page did: whether it succeeded and the lines it printed, colour codes removed. */
export interface DevCommandResult {
  /** `lock`, `generate` or `doctor`. */
  command: string;
  /** Whether it succeeded. */
  ok: boolean;
  /** The lines it printed, colour codes removed. */
  output: string[];
}

/** One human command the CLI that started the dev server hands it to run on the page's behalf; `subsystem` is the one subsystem a lock re-approves, ignored by the others. */
export type DevCommand = (subsystem?: string | null) => Promise<DevCommandResult>;

/** The human commands `wairon dev` hands its server: the CLI's own lock, generate and doctor --fix. */
export interface DevCommands {
  lock: DevCommand;
  generate: DevCommand;
  doctor: DevCommand;
  /** The family panel's commands: one checked family command, run through the CLI's own command parser. */
  family: DevFamilyRunner;
}

/** What the dev page gets back when the human decides a review request: the request as it now stands and, for a lock, what the lock printed. */
export interface DevReviewDecision {
  /** The request after the decision (still pending when the lock failed). */
  request: ReviewRequest;
  /** The lock's result, when the decision was to lock. */
  lock?: DevCommandResult;
}

/** The served project's approval state for the dev page: whether it carries a lock, who locked it when, and what the lock says about the tree now. */
export interface DevApproval {
  /** Whether the project carries a lock record at all. */
  approved: boolean;
  /** When the last lock was taken. */
  approvedAt?: string;
  /** Who took the last lock. */
  approvedBy?: string;
  /** What the lock says about the tree now: drifted, the moved specs, the line to show. */
  verdict: ApprovalVerdict;
}

/** The id of the one project the development server serves. */
const DEV_PROJECT_ID = 'local';

const COMMAND_NAMES: ReadonlySet<string> = new Set(['lock', 'generate', 'doctor']);

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** A command's output with colour codes removed. */
function plain(lines: readonly string[]): string[] {
  return lines.map((l) => l.replace(ANSI, ''));
}

/** Whether a command is running; the dev server runs one at a time. */
let running = false;

/** Authenticate the session and answer the served project's root, refusing a server that is not the local development server. */
function servedRoot(cfg: HostConfig, sessionId: string): string {
  if (cfg.devMode !== true) throw new ForbiddenError('not the local development server');
  const principal = authenticateSession(cfg.dataDir, sessionId);
  if (!principal.authenticated) throw new UnauthenticatedError();
  const root = existingProjectRoot(cfg.dataDir, DEV_PROJECT_ID);
  if (!root) throw new ForbiddenError('the development project is not registered');
  return root;
}

/** Run one handed command (never overlapping another), turning a thrown error into a failed result. */
async function runHanded(cfg: HostConfig, name: string, subsystem?: string | null): Promise<DevCommandResult> {
  const handed = cfg.devCommands;
  if (cfg.devMode !== true || !handed || !COMMAND_NAMES.has(name) || running) {
    throw new Error('the command cannot run');
  }
  running = true;
  try {
    const result = await (handed as unknown as Record<string, DevCommand>)[name](subsystem ?? undefined);
    return { command: name, ok: result.ok, output: plain(result.output) };
  } catch (e) {
    return { command: name, ok: false, output: plain([e instanceof Error ? e.message : String(e)]) };
  } finally {
    running = false;
  }
}

/** dev_cockpit_orchestrator.reviews — the served project's pending review requests. */
export function reviews(cfg: HostConfig, sessionId: string): ReviewRequest[] {
  // Steps 1-2: refused outside the local development server.
  const root = servedRoot(cfg, sessionId);
  // Steps 3-4.
  return runWithProjectRoot(root, () => hostCore.pendingReviews());
}

/**
 * dev_cockpit_orchestrator.decide — the human's answer to a pending request. `locked` runs the
 * CLI's lock first (of the request's subsystem when it names one) and records the request locked
 * only when the lock succeeded; a failed lock leaves the request pending and answers the lock's output.
 */
export async function decide(
  cfg: HostConfig,
  sessionId: string,
  id: string,
  outcome: ReviewStatus,
  comment?: string,
  notes?: ReviewNote[],
): Promise<DevReviewDecision> {
  // Steps 1-2.
  if (cfg.devCommands === undefined) throw new ForbiddenError('not the local development server');
  const root = servedRoot(cfg, sessionId);
  // Step 3: the request brought up to date, for its kind and subsystem.
  const request = runWithProjectRoot(root, () => hostCore.reviewStatus(id));
  let lock: DevCommandResult | undefined;
  // Step 4.
  if (outcome === 'locked') {
    // Only a lock request is answered by a lock; refused before anything runs.
    if (request.kind !== 'lock') throw new Error(`request ${id} asks for a review, not a lock`);
    // Step 5: the CLI's lock, of the request's subsystem when it names one. The CLI binds its own root.
    lock = await runHanded(cfg, 'lock', request.subsystem);
    // Steps 6-7: a failed lock leaves the request pending.
    if (!lock.ok) return { request, lock };
  }
  // Step 10: record the decision with the comment and the notes (a lock request the lock already
  // answered keeps the lock's approver and time and gains them).
  const decided = runWithProjectRoot(root, () => hostCore.decideReview(id, outcome, comment, notes));
  // Step 9.
  return lock ? { request: decided, lock } : { request: decided };
}

/** dev_cockpit_orchestrator.approval — the served project's approval state, which drives the page's lock bar and lock confirmation. */
export function approval(cfg: HostConfig, sessionId: string): DevApproval {
  // Steps 1-4: refused outside the local development server; the session authenticated; the served root.
  const root = servedRoot(cfg, sessionId);
  return runWithProjectRoot(root, () => {
    // Step 5: the lock record, for who locked and when.
    const record = hostCore.approvalRecord();
    // Step 6: what the lock says about the tree now.
    const verdict = hostCore.approvalVerdict();
    // Step 7.
    if (!record) return { approved: false, verdict };
    const state: DevApproval = { approved: true, verdict };
    if (typeof record.lockedAt === 'string' && record.lockedAt !== '') state.approvedAt = record.lockedAt;
    if (record.lockedBy && record.lockedBy.id && record.lockedBy.id !== 'unknown') state.approvedBy = describeApprover(record.lockedBy);
    return state;
  });
}

/** dev_cockpit_orchestrator.run — one human command the CLI handed the server, and what it printed. */
export async function run(cfg: HostConfig, sessionId: string, command: string, subsystem?: string): Promise<DevCommandResult> {
  // Steps 1-2: refused outside the local development server, for a command it was not handed, or while one runs.
  if (cfg.devMode !== true || !cfg.devCommands || !COMMAND_NAMES.has(command) || running) {
    throw new Error('the command cannot run');
  }
  // Step 3: authenticate the session.
  const principal = authenticateSession(cfg.dataDir, sessionId);
  if (!principal.authenticated) throw new UnauthenticatedError();
  // Steps 4-5.
  return runHanded(cfg, command, subsystem);
}

// ── The family panel's commands ──────────────────────────────────────────────

/** The family commands the dev page's family panel runs, each one CLI command. */
export type DevFamilyAction =
  | 'externals-pin'
  | 'externals-status'
  | 'network-declare'
  | 'network-undeclare'
  | 'member-add'
  | 'member-update'
  | 'member-move'
  | 'member-attach'
  | 'member-detach'
  | 'member-adopt'
  | 'member-rename-alias'
  | 'member-internalize'
  | 'member-promote'
  | 'member-demote';

/**
 * One family command the dev page asks the server to run: the action, its positional arguments in the
 * CLI's order, the options it takes by long name (a flag has the value `true`), and whether to preview
 * it with the CLI's --report instead of applying it.
 */
export interface DevFamilyCommand {
  action: DevFamilyAction;
  args: string[];
  options: Record<string, string>;
  report: boolean;
}

/** The family commands the CLI that started the dev server hands it: runs one checked command through the CLI's own command parser. */
export type DevFamilyRunner = (command: DevFamilyCommand) => Promise<DevCommandResult>;

/** What one family action takes: its CLI words, its positional count, its options, and whether it has a preview. */
interface FamilyShape {
  /** The CLI words before the arguments (`member add`). */
  words: string[];
  /** The fewest and the most positional arguments. */
  minArgs: number;
  maxArgs: number;
  /** Each option the action takes: a flag (given `true`) or one with a value. */
  options: Record<string, 'flag' | 'value'>;
  /** Whether the CLI command has --report. */
  report: boolean;
}

/** Every family action's shape, as the CLI defines the command. */
export const FAMILY_SHAPES: Readonly<Record<DevFamilyAction, FamilyShape>> = {
  'externals-pin': { words: ['externals', 'pin'], minArgs: 0, maxArgs: 1, options: {}, report: false },
  'externals-status': { words: ['externals', 'status'], minArgs: 0, maxArgs: 0, options: {}, report: false },
  'network-declare': { words: ['network', 'declare'], minArgs: 0, maxArgs: 0, options: { description: 'value' }, report: false },
  'network-undeclare': { words: ['network', 'undeclare'], minArgs: 0, maxArgs: 0, options: {}, report: false },
  'member-add': { words: ['member', 'add'], minArgs: 2, maxArgs: 2, options: { project: 'flag', description: 'value' }, report: true },
  'member-update': { words: ['member', 'update'], minArgs: 1, maxArgs: 1, options: { ref: 'value', commit: 'value' }, report: true },
  'member-move': { words: ['member', 'move'], minArgs: 2, maxArgs: 2, options: {}, report: false },
  'member-attach': { words: ['member', 'attach'], minArgs: 2, maxArgs: 2, options: { description: 'value' }, report: true },
  'member-detach': { words: ['member', 'detach'], minArgs: 1, maxArgs: 1, options: { widen: 'flag' }, report: true },
  'member-adopt': { words: ['member', 'adopt'], minArgs: 1, maxArgs: 1, options: {}, report: true },
  'member-rename-alias': { words: ['member', 'rename-alias'], minArgs: 2, maxArgs: 2, options: {}, report: true },
  'member-internalize': { words: ['member', 'internalize'], minArgs: 1, maxArgs: 1, options: { into: 'value', packs: 'value', export: 'value' }, report: true },
  'member-promote': { words: ['member', 'promote'], minArgs: 1, maxArgs: 1, options: { id: 'value' }, report: true },
  'member-demote': { words: ['member', 'demote'], minArgs: 1, maxArgs: 1, options: { home: 'value', packs: 'value' }, report: true },
};

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);

/** Why a family command does not fit its action's shape, or undefined when it does. */
export function familyProblem(command: DevFamilyCommand): string | undefined {
  if (command === null || typeof command !== 'object') return 'no command was given';
  const shape = typeof command.action === 'string' && own(FAMILY_SHAPES, command.action) ? FAMILY_SHAPES[command.action] : undefined;
  if (!shape) return `"${String(command.action)}" is not a family command`;
  const label = shape.words.join(' ');
  const args: unknown[] = Array.isArray(command.args) ? command.args : [];
  if (args.length < shape.minArgs || args.length > shape.maxArgs) {
    const expected = shape.minArgs === shape.maxArgs ? `${shape.minArgs}` : `${shape.minArgs} to ${shape.maxArgs}`;
    return `${label} takes ${expected} argument(s), not ${args.length}`;
  }
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.trim() === '') return 'an argument is empty';
    if (arg.startsWith('-')) return `the argument "${arg}" starts with "-"`;
  }
  const options: Record<string, unknown> = command.options && typeof command.options === 'object' ? command.options : {};
  for (const [name, value] of Object.entries(options)) {
    const kind = own(shape.options, name) ? shape.options[name] : undefined;
    if (!kind) return `${label} takes no --${name}`;
    if (typeof value !== 'string') return `--${name} is not text`;
    if (kind === 'flag' && value !== 'true') return `--${name} is a flag: give it the value true`;
    if (kind === 'value' && value.trim() === '') return `--${name} is empty`;
    if (value.startsWith('-')) return `the value of --${name} starts with "-"`;
  }
  if (command.report === true && !shape.report) return `${label} has no preview`;
  return undefined;
}

/** dev_cockpit_orchestrator.family — run one family command the CLI handed the server: a preview, or the change itself. */
export async function family(cfg: HostConfig, sessionId: string, command: DevFamilyCommand): Promise<DevCommandResult> {
  // Steps 1-2: refused outside the local development server, without the handed commands, or while one runs.
  const handed = cfg.devCommands;
  if (cfg.devMode !== true || !handed || running) throw new Error('the command cannot run');
  // Step 3: authenticate the session.
  const principal = authenticateSession(cfg.dataDir, sessionId);
  if (!principal.authenticated) throw new UnauthenticatedError();
  // Steps 4-6: the command against its action's shape.
  const problem = familyProblem(command);
  if (problem !== undefined) throw new Error(`the family command is malformed: ${problem}`);
  // Step 7: one at a time, shared with run; a thrown error is a failed result.
  const name = FAMILY_SHAPES[command.action].words.join(' ');
  const checked: DevFamilyCommand = {
    action: command.action,
    args: [...command.args],
    options: { ...(command.options ?? {}) },
    report: command.report === true,
  };
  running = true;
  try {
    const result = await handed.family(checked);
    // Step 8.
    return { command: name, ok: result.ok, output: plain(result.output) };
  } catch (e) {
    return { command: name, ok: false, output: plain([e instanceof Error ? e.message : String(e)]) };
  } finally {
    running = false;
  }
}

/** dev_cockpit_orchestrator.producers — the projects on disk the served project reads: its members, and its externals declared by path. */
export function producers(root: string): DevProducer[] {
  return runWithProjectRoot(root, () => {
    // Step 1: the served project's configuration.
    let config: ReturnType<typeof hostCore.loadProjectConfig>;
    try {
      config = hostCore.loadProjectConfig();
    } catch {
      config = null;
    }
    // Steps 2-3.
    if (!config) return [];
    const out: DevProducer[] = [];
    // Step 4: members whose location is a folder (contained, or a sibling checkout).
    for (const member of declaredMembers(config)) {
      if (member.storage !== 'contained' && member.storage !== 'path') continue;
      const location = member.path ?? member.source.path;
      if (!location) continue;
      out.push({ alias: member.alias, root: path.resolve(root, location), relation: 'member' });
    }
    // Step 5: externals whose source is a folder; git and hosted sources are skipped.
    for (const external of declaredExternals(config)) {
      if (external.sourcePath === undefined || external.sourceGit !== undefined || external.sourceHosted !== undefined) continue;
      out.push({ alias: external.alias, root: path.resolve(root, external.sourcePath), relation: 'external' });
    }
    // Steps 6-7: only producers whose .wai/ folder exists.
    return out.filter((p) => fs.existsSync(path.join(p.root, '.wai')));
  });
}
