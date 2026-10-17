import * as fs from 'fs';
import * as os from 'os';
import * as nodePath from 'path';
import * as yaml from 'js-yaml';
import type { TransactionArea, TransactionJournal } from './types.js';

// ---------------------------------------------------------------------------
// transaction_file_adapter — file I/O for the transaction aggregate and nothing
// else: each owner's .wai/transactions/<id>/ (journal.yaml, staged/, backup/,
// and a self-ignoring .gitignore holding `*` at .wai/transactions/ so a
// transaction left by a crash is never committed) and the rehearsal directory
// in the OS temporary directory. Every write is durable before it returns:
// bytes go to a temporary sibling, are fsynced, then renamed over the target
// (the directory is fsynced where the platform supports it; Windows does not,
// and the rename is the barrier there).
// ---------------------------------------------------------------------------

const TRANSACTIONS = nodePath.join('.wai', 'transactions');

const transactionsDir = (owner: string): string => nodePath.join(owner, TRANSACTIONS);
const transactionDir = (owner: string, id: string): string => nodePath.join(transactionsDir(owner), id);
const rehearsalDir = (id: string): string => nodePath.join(os.tmpdir(), `wairon-migration-${id}`);

/** Synchronous sleep, for the bounded removal retries. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Remove a directory tree; ENOENT is success; a Windows sharing error is retried briefly. */
function removeTree(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY')) throw e;
      pause(25 * attempt);
    }
  }
}

/** Write bytes durably: a temporary sibling, fsynced, renamed over the target, the directory fsynced where it can be. */
function writeDurably(file: string, bytes: Uint8Array | string): void {
  fs.mkdirSync(nodePath.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    // A failed write leaves the previous file intact and no temporary sibling behind.
    try { fs.unlinkSync(tmp); } catch { /* never written, or already renamed */ }
    throw e;
  }
  syncDirectory(nodePath.dirname(file));
}

function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch { /* a platform that cannot fsync a directory: the rename is the barrier */ }
}

/** itransaction_file_adapter.openRehearsal — make wairon-migration-<id> under the OS temporary directory. */
export function openRehearsal(id: string): string {
  const dir = rehearsalDir(id);
  // Refuses when it exists already: two plans never share a rehearsal.
  fs.mkdirSync(dir);
  return dir;
}

/** itransaction_file_adapter.dropRehearsal — remove it recursively; ENOENT is success. */
export function dropRehearsal(id: string): void {
  try {
    removeTree(rehearsalDir(id));
  } catch {
    // Left behind outside every family: harmless, and the OS temp directory is swept.
  }
}

/** itransaction_file_adapter.saveJournal — journal.yaml durably, the .gitignore first when absent. */
export function saveJournal(journal: TransactionJournal): void {
  const ignore = nodePath.join(transactionsDir(journal.owner), '.gitignore');
  if (!fs.existsSync(ignore)) writeDurably(ignore, '*\n');
  writeDurably(nodePath.join(transactionDir(journal.owner, journal.id), 'journal.yaml'), yaml.dump(journal, { noRefs: true, lineWidth: 200 }));
}

/** itransaction_file_adapter.readJournal — the owner's journal of a transaction, or null. */
export function readJournal(owner: string, id: string): TransactionJournal | null {
  const file = nodePath.join(transactionDir(owner, id), 'journal.yaml');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return yaml.load(text) as TransactionJournal;
  } catch (e) {
    throw new Error(`${file} is not a readable transaction journal: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * itransaction_file_adapter.listJournals — every journal under the owner. A
 * transaction directory with no journal (a crash before the first save) reads
 * as a journal in phase staging with no entries, so recovery still cleans it.
 */
export function listJournals(owner: string): TransactionJournal[] {
  const dir = transactionsDir(owner);
  let names: string[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {
    return [];
  }
  return names.map((id) => readJournal(owner, id) ?? {
    id, verb: 'unknown', owner, coordinator: '', owners: [''], phase: 'staging', entries: [], dirsCreated: [], dirsRemoved: [], startedAt: '',
  });
}

/** itransaction_file_adapter.putFile — bytes into <owner>/.wai/transactions/<id>/<area>/<path>, durably. */
export function putFile(owner: string, id: string, area: TransactionArea, path: string, bytes: Uint8Array): void {
  writeDurably(locate(owner, id, area, path), bytes);
}

/** itransaction_file_adapter.readFile — the bytes held in an area, or null. */
export function readFile(owner: string, id: string, area: TransactionArea, path: string): Buffer | null {
  try {
    return fs.readFileSync(locate(owner, id, area, path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** itransaction_file_adapter.locate — the absolute path of a file in an area; touches nothing. */
export function locate(owner: string, id: string, area: TransactionArea, path: string): string {
  return nodePath.join(transactionDir(owner, id), area, ...path.split('/'));
}

/**
 * itransaction_file_adapter.close — remove the transaction directory, then
 * .wai/transactions/ once only its .gitignore is left, then the owner's .wai/
 * when that left it empty: a project the migration took apart (an
 * internalized member) leaves no empty .wai behind for a later command to
 * mistake for a project.
 */
export function close(owner: string, id: string): void {
  removeTree(transactionDir(owner, id));
  const dir = transactionsDir(owner);
  let left: string[];
  try {
    left = fs.readdirSync(dir);
  } catch {
    return;
  }
  if (!left.every((name) => name === '.gitignore')) return;
  removeTree(dir);
  const wai = nodePath.dirname(dir);
  try {
    if (fs.readdirSync(wai).length === 0) fs.rmdirSync(wai);
  } catch {
    // already gone, or not empty after all: nothing to prune
  }
  // A relocated project's old place, or a rolled-back relocation's new root,
  // holds nothing at all now: no empty directory is left behind for a later
  // move to find in its way.
  try {
    if (fs.readdirSync(owner).length === 0) fs.rmdirSync(owner);
  } catch {
    // already gone, or not empty: nothing to prune
  }
}
