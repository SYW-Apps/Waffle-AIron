import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as files from './family-files.js';
import { transactionRepository as repository } from './transaction-store.js';
import type {
  FileChange,
  RecoveredTransaction,
  Rehearsal,
  TransactionJournal,
  TransactionOutcome,
  TransactionScope,
} from './types.js';

// ---------------------------------------------------------------------------
// family_transaction — applies a family's file changes all-or-nothing.
//
// Layout: the rehearsal at <os tmp>/wairon-migration-<id>/<path from family
// root>/.wai/...; per owner <owner>/.wai/transactions/<id>/{journal.yaml,
// staged/<path>, backup/<path>} with .wai/transactions/.gitignore = `*`. The
// coordinator is always the family root, whose journal lists every owner; its
// phase is the commit point. Phases: staging → staged → swapping → committed |
// rolled-back.
//
// It knows nothing about any verb: it moves bytes it was shown. It holds no
// state of its own — the transaction lives in the Transaction Repository, so a
// crash loses nothing this workflow held.
// ---------------------------------------------------------------------------

/** Staging stopped before anything live moved: a live file moved since the rehearsal, a swap would cross volumes, or a write failed. */
export class StagingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingError';
  }
}

/** A swap stopped part-way: the caller restores every backup. */
export class SwapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwapError';
  }
}

const slash = (p: string): string => p.split(path.sep).join('/');
const liveOf = (owner: string, file: string): string => path.join(owner, ...file.split('/'));
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Swap order within an owner: creates, then writes, then deletes. */
const ORDER: Record<FileChange['action'], number> = { create: 0, write: 1, delete: 2 };

// ── rehearse / diff / discard ───────────────────────────────────────────────

/** ifamily_transaction.rehearse — a private copy of every scoped owner's areas (each project's .wai tree by default). */
export function rehearse(scope: TransactionScope): Rehearsal {
  // Step 1.
  const id = crypto.randomBytes(4).toString('hex');
  // Step 2.
  const directory = repository.openRehearsal(id);
  const familyRoot = path.resolve(scope.familyRoot);
  const projects = [...new Set(scope.projects.map((p) => path.resolve(p)))];
  // Steps 3-4: only .wai trees are copied — every writer run on the copy
  // must read nothing outside them (the rehearsal precondition).
  let baseDigests: Map<string, string>;
  try {
    baseDigests = files.mirror({ familyRoot, projects, ...(scope.areas ? { areas: scope.areas } : {}) }, directory);
  } catch (e) {
    // Steps 6-7.
    repository.dropRehearsal(id);
    throw e;
  }
  // Step 5.
  const roots = new Map(projects.map((p) => [p, path.join(directory, path.relative(familyRoot, p))]));
  return { id, directory, familyRoot, roots, baseDigests, ...(scope.areas ? { areas: [...scope.areas] } : {}) };
}

/** ifamily_transaction.diff — the rehearsal's difference from the live family. */
export function diff(rehearsal: Rehearsal): FileChange[] {
  return files.compare(rehearsal);
}

/** ifamily_transaction.discard — drop a rehearsal without touching the family. */
export function discard(rehearsal: Rehearsal): void {
  repository.dropRehearsal(rehearsal.id);
}

// ── commit ──────────────────────────────────────────────────────────────────

/** ifamily_transaction.commit — make the changes live, all or nothing. */
export function commit(rehearsal: Rehearsal, changes: FileChange[], verb: string): TransactionOutcome {
  const owners = ownerRoots(rehearsal, changes);
  // Steps 1-2: stage every owner; nothing live moves inside this region.
  let journals: TransactionJournal[];
  try {
    journals = stage(rehearsal, changes, verb);
  } catch (e) {
    if (!(e instanceof StagingError)) throw e;
    // Steps 9-11.
    closeAll(rehearsal.id, owners);
    repository.dropRehearsal(rehearsal.id);
    return { committed: false, written: [], failure: `stage: ${e.message}`, restored: true, unrestored: [] };
  }
  // Steps 3-5: swap every owner, then the commit point; any failure before it restores everything.
  try {
    swap(journals);
    journals[0].phase = 'committed';
    try {
      repository.saveJournal(journals[0]);
    } catch (e) {
      throw new SwapError(`commit point: ${errorText(e)}`);
    }
  } catch (e) {
    if (!(e instanceof SwapError)) throw e;
    return swapFailed(rehearsal, journals, owners, e);
  }
  // Steps 6-8.
  closeAll(rehearsal.id, owners);
  repository.dropRehearsal(rehearsal.id);
  return { committed: true, written: changes, restored: false, unrestored: [] };
}

/** Steps 12-17: put every owner back; close only when every file is proven restored. */
function swapFailed(rehearsal: Rehearsal, journals: TransactionJournal[], owners: string[], e: SwapError): TransactionOutcome {
  // Step 12.
  const unrestored = restore(journals);
  // Step 13.
  if (unrestored.length === 0) {
    // Steps 14-16.
    closeAll(rehearsal.id, owners);
    repository.dropRehearsal(rehearsal.id);
    return { committed: false, written: [], failure: `swap: ${e.message}`, restored: true, unrestored: [] };
  }
  // Step 17: the journals stay for `wairon doctor --fix`; the rehearsal is kept for inspection.
  return { committed: false, written: [], failure: `swap: ${e.message}`, restored: false, unrestored };
}

/** The coordinator (the family root) first, then every other owner the changes touch. */
function ownerRoots(rehearsal: Rehearsal, changes: FileChange[]): string[] {
  const others = [...new Set(changes.map((c) => path.resolve(c.project)))].filter((o) => o !== rehearsal.familyRoot).sort();
  return [rehearsal.familyRoot, ...others];
}

/** Remove every owner's transaction directory, the coordinator's (the first) last. */
function closeAll(id: string, owners: string[]): void {
  for (const owner of [...owners.slice(1), owners[0]]) repository.close(owner, id);
}

// ── stage ───────────────────────────────────────────────────────────────────

/** ifamily_transaction.stage — journals, staged files and backups, without touching a live file. */
export function stage(rehearsal: Rehearsal, changes: FileChange[], verb: string): TransactionJournal[] {
  // Step 1: the journals, the coordinator's first, each in phase staging.
  const journals = openJournals(rehearsal, changes, verb);
  // Steps 2-15.
  for (const journal of journals) {
    try {
      stageOwner(rehearsal, journal);
    } catch (e) {
      throw e instanceof StagingError ? e : new StagingError(`${journal.owner}: ${errorText(e)}`);
    }
  }
  // Step 16.
  return journals;
}

/**
 * Step 1: group the changes by owner in swap order. Each journal also records,
 * before anything is staged, the directories a create will need that do not
 * exist yet — so a crash between a create's makeDirs and the owner's next
 * journal save still leaves the journal naming every directory to prune.
 */
function openJournals(rehearsal: Rehearsal, changes: FileChange[], verb: string): TransactionJournal[] {
  const owners = ownerRoots(rehearsal, changes);
  const startedAt = new Date().toISOString();
  return owners.map((owner) => {
    const entries = changes
      .filter((c) => path.resolve(c.project) === owner)
      .map((c) => ({ ...c, project: owner }))
      .sort((a, b) => ORDER[a.action] - ORDER[b.action] || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const coordinator = owner === rehearsal.familyRoot;
    return {
      id: rehearsal.id, verb, owner,
      coordinator: coordinator ? '' : slash(path.relative(owner, rehearsal.familyRoot)),
      owners: coordinator ? owners.map((o) => slash(path.relative(rehearsal.familyRoot, o))) : [],
      phase: 'staging' as const, entries, dirsCreated: missingDirs(owner, entries), dirsRemoved: [], startedAt,
    };
  });
}

/** The parent directories the owner's creates need that do not exist yet, shallowest first. */
function missingDirs(owner: string, entries: FileChange[]): string[] {
  const out: string[] = [];
  for (const entry of entries.filter((e) => e.action === 'create')) {
    const missing: string[] = [];
    let at = path.dirname(liveOf(owner, entry.path));
    while (!fs.existsSync(at) && at !== path.dirname(at)) {
      missing.unshift(at);
      at = path.dirname(at);
    }
    for (const d of missing) if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** Steps 3-15 for one owner. */
function stageOwner(rehearsal: Rehearsal, journal: TransactionJournal): void {
  // Step 3: recorded before any byte is staged, so a crash from here on leaves a directory recovery finds.
  repository.saveJournal(journal);
  for (const entry of journal.entries) {
    const target = liveOf(journal.owner, entry.path);
    // Steps 4-6: did a live file move since the rehearsal copied it?
    const live = files.digest(target);
    if ((entry.action === 'create' && live !== null) || (entry.action !== 'create' && live !== entry.baseDigest)) {
      throw new StagingError(`moved since planned: ${target}`);
    }
    if (entry.action !== 'delete') stageBytes(rehearsal, journal, entry);
    // Steps 9-10: back up what the swap replaces or removes.
    if (entry.action !== 'create') repository.putFile(journal.owner, journal.id, 'backup', entry.path, files.read(target)!);
    // Steps 11-14.
    if (entry.action !== 'delete') checkVolume(journal, entry, target);
  }
  // Step 15.
  journal.phase = 'staged';
  repository.saveJournal(journal);
}

/** Steps 7-8: the new bytes, read from the rehearsal and staged in the owner's area. */
function stageBytes(rehearsal: Rehearsal, journal: TransactionJournal, entry: FileChange): void {
  const copy = path.join(rehearsal.directory, path.relative(rehearsal.familyRoot, journal.owner), ...entry.path.split('/'));
  const bytes = files.read(copy);
  if (bytes === null || `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}` !== entry.stagedDigest) {
    throw new StagingError(`the rehearsal no longer holds what was planned: ${copy}`);
  }
  repository.putFile(journal.owner, journal.id, 'staged', entry.path, bytes);
}

/** Steps 11-14: a staged file must share a volume with its target's nearest existing directory. */
function checkVolume(journal: TransactionJournal, entry: FileChange, target: string): void {
  const staged = repository.locate(journal.owner, journal.id, 'staged', entry.path);
  let nearest = path.dirname(target);
  while (!fs.existsSync(nearest) && nearest !== path.dirname(nearest)) nearest = path.dirname(nearest);
  if (!files.sameVolume(staged, nearest)) {
    throw new StagingError(`cross-volume: ${target} lies on another volume than its staged copy; a rename across volumes is not atomic`);
  }
}

// ── swap ────────────────────────────────────────────────────────────────────

/** ifamily_transaction.swap — the staged files in, the coordinator's journal first reading swapping. */
export function swap(journals: TransactionJournal[]): void {
  // Step 1.
  const coordinator = journals[0];
  coordinator.phase = 'swapping';
  guarded(coordinator, 'journal', () => repository.saveJournal(coordinator));
  // Steps 2-8.
  for (const journal of journals) {
    for (const entry of journal.entries) swapEntry(journal, entry);
    journal.phase = 'swapping';
    guarded(journal, 'journal', () => repository.saveJournal(journal));
  }
}

/** Steps 3-7 for one entry. */
function swapEntry(journal: TransactionJournal, entry: FileChange): void {
  const target = liveOf(journal.owner, entry.path);
  if (entry.action === 'delete') {
    // Step 6.
    guarded(journal, `remove ${target}`, () => files.remove(target));
    // Step 7.
    guarded(journal, `prune ${path.dirname(target)}`, () => {
      for (const d of files.prune(path.dirname(target), journal.owner)) if (!journal.dirsRemoved.includes(d)) journal.dirsRemoved.push(d);
    });
    return;
  }
  // Step 3.
  const staged = repository.locate(journal.owner, journal.id, 'staged', entry.path);
  // Step 4.
  if (entry.action === 'create') {
    guarded(journal, `mkdir ${path.dirname(target)}`, () => {
      for (const d of files.makeDirs(path.dirname(target))) if (!journal.dirsCreated.includes(d)) journal.dirsCreated.push(d);
    });
  }
  // Step 5.
  guarded(journal, `replace ${target}`, () => files.replace(staged, target));
}

/** Any failure inside the swap surfaces as a SwapError naming the operation and the file. */
function guarded(journal: TransactionJournal, operation: string, run: () => void): void {
  try {
    run();
  } catch (e) {
    throw new SwapError(`${operation} (${journal.owner}): ${errorText(e)}`);
  }
}

// ── restore ─────────────────────────────────────────────────────────────────

/** ifamily_transaction.restore — every owner back as its backups say; answers the files it could not restore. */
export function restore(journals: TransactionJournal[]): string[] {
  const unrestored: string[] = [];
  // Steps 1-8.
  for (const journal of journals) unrestored.push(...restoreOwner(journal));
  // Step 9.
  return unrestored;
}

function restoreOwner(journal: TransactionJournal): string[] {
  const failed = new Set<string>();
  // A step that fails is not yet a loss: step 7's digest proof decides what is
  // unrestored (a backup that cannot be placed over a file the swap never
  // reached leaves that file exactly as it was).
  const attempt = (run: () => void): void => {
    try { run(); } catch { /* judged by the proof below */ }
  };
  // Step 2: the directories the swap removed, shallowest first.
  for (const d of [...journal.dirsRemoved].sort((a, b) => a.length - b.length)) attempt(() => files.makeDirs(d));
  // Steps 3-4: each write's and delete's backup put back, whether or not the swap reached it.
  for (const entry of journal.entries.filter((e) => e.action !== 'create')) {
    const target = liveOf(journal.owner, entry.path);
    const backup = repository.readFile(journal.owner, journal.id, 'backup', entry.path);
    if (backup !== null) attempt(() => files.place(target, backup));
  }
  // Step 5: each created file removed — only when it is the bytes the swap put there.
  for (const entry of journal.entries.filter((e) => e.action === 'create')) {
    const target = liveOf(journal.owner, entry.path);
    if (files.digest(target) === entry.stagedDigest) attempt(() => files.remove(target));
  }
  // Step 6: the directories the swap created, deepest first, each only when empty.
  for (const d of [...journal.dirsCreated].sort((a, b) => b.length - a.length)) attempt(() => files.prune(d, path.dirname(d)));
  // Step 7: prove every file by digest — a missing backup of a file already at its base is no loss.
  for (const entry of journal.entries) {
    const target = liveOf(journal.owner, entry.path);
    const now = files.digest(target);
    if (entry.action === 'create' ? now !== null : now !== entry.baseDigest) failed.add(target);
  }
  // Step 8.
  const unrestored = [...failed].sort();
  if (unrestored.length === 0) journal.phase = 'rolled-back';
  journal.unrestored = unrestored;
  repository.saveJournal(journal);
  return unrestored;
}

// ── recover ─────────────────────────────────────────────────────────────────

/** ifamily_transaction.recover — find the unfinished transactions under a root; with fix, resolve each. */
export function recover(root: string, fix: boolean): RecoveredTransaction[] {
  const at = path.resolve(root);
  // Step 1.
  const found = repository.listJournals(at);
  // Step 2: each journal re-read where it was found; its coordinator is a recorded path.
  const transactions = found.map((journal) => ({ ...journal, owner: at }));
  // Steps 3-4.
  if (!fix) return transactions.map((t) => pending(t));
  // Steps 5-17.
  return transactions.map((t) => resolveOne(t));
}

const coordinatorRoot = (journal: TransactionJournal): string => path.resolve(journal.owner, journal.coordinator);

/** Read a journal where a path says it lives, re-based on that path; null when absent or unreadable. */
function journalAt(owner: string, id: string): TransactionJournal | null {
  try {
    const journal = fs.existsSync(owner) ? repository.readJournal(owner, id) : null;
    return journal ? { ...journal, owner } : null;
  } catch {
    return null;
  }
}

/** Step 4: a transaction reported, nothing written. */
function pending(journal: TransactionJournal): RecoveredTransaction {
  const coordinator = journal.coordinator === '' ? journal : journalAt(coordinatorRoot(journal), journal.id);
  return {
    id: journal.id,
    verb: journal.verb,
    owners: ownersOf(coordinator ?? journal),
    phase: coordinator?.phase ?? 'unknown',
    action: 'pending',
    detail: coordinator ? `coordinator at ${coordinatorRoot(journal)}` : `coordinator ${coordinatorRoot(journal)} is out of reach`,
  };
}

function ownersOf(coordinator: TransactionJournal): string[] {
  return (coordinator.owners.length > 0 ? coordinator.owners : ['']).map((rel) => path.resolve(coordinator.owner, rel));
}

/** Steps 6-16 for one transaction. */
function resolveOne(journal: TransactionJournal): RecoveredTransaction {
  const base = { id: journal.id, verb: journal.verb };
  // Steps 6-8: without its coordinator's phase nobody knows whether the swap was final.
  const coordinator = journal.coordinator === '' ? journal : journalAt(coordinatorRoot(journal), journal.id);
  if (!coordinator) {
    return { ...base, owners: [journal.owner], phase: 'unknown', action: 'refused', detail: `the coordinator ${coordinatorRoot(journal)} is out of reach or holds no journal of this transaction` };
  }
  const owners = ownersOf(coordinator);
  // The phase as found: restore below records the journals rolled-back.
  const phase = coordinator.phase;
  // Steps 9-11: committed — only its directories remain.
  if (phase === 'committed') {
    for (const owner of [...owners.filter((o) => o !== coordinator.owner), coordinator.owner]) repository.close(owner, journal.id);
    return { ...base, owners, phase, action: 'cleaned', detail: 'it had committed; its transaction directories were removed' };
  }
  // Step 12: every owner's journal; an owner whose root is gone refuses the transaction.
  const absent = owners.filter((o) => !fs.existsSync(o));
  if (absent.length > 0) {
    return { ...base, owners, phase, action: 'refused', detail: `owner(s) out of reach: ${absent.join(', ')}` };
  }
  // An owner with no journal staged nothing: the coordinator is always saved first, and nothing swaps before every owner is staged.
  const journals = owners.map((o) => (o === coordinator.owner ? coordinator : journalAt(o, journal.id))).filter((j): j is TransactionJournal => j !== null);
  // Steps 13-15.
  const unrestored = restore(journals);
  if (unrestored.length > 0) {
    return { ...base, owners, phase, action: 'refused', detail: `could not restore: ${unrestored.join(', ')}` };
  }
  for (const owner of [...owners.filter((o) => o !== coordinator.owner), coordinator.owner]) repository.close(owner, journal.id);
  return { ...base, owners, phase, action: 'rolled-back', detail: `${journals.reduce((n, j) => n + j.entries.length, 0)} file(s) restored from their backups` };
}
