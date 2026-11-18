import * as path from 'path';
import * as files from './files.js';

// ---------------------------------------------------------------------------
// io/git-head — what a checkout has checked out, read without running git
//
// Resolves the git folder (a `.git` folder, or the gitdir a `.git` file names,
// relative to the file), reads HEAD, and resolves `ref: refs/heads/<branch>`
// through the loose ref file, else packed-refs (a worktree's refs live in the
// common folder its `commondir` file names). Any failure answers none.
// ---------------------------------------------------------------------------

/** The branch HEAD names and the commit it points at (a detached HEAD has no branch). */
export interface GitHead {
  branch?: string;
  commit?: string;
}

function readOrNull(file: string): string | null {
  try {
    return files.readText(file);
  } catch {
    return null;
  }
}

/** The git folder of a checkout: a `.git` folder, or the folder a `.git` file's `gitdir:` names. */
function gitFolder(root: string): string | undefined {
  try {
    // The nearest `.git` at or above the folder: a project may sit in a
    // subfolder of its repository.
    let dir = path.resolve(root);
    for (;;) {
      const dot = path.join(dir, '.git');
      const st = files.statOrNull(dot);
      if (st) {
        if (st.isDirectory()) return dot;
        const text = readOrNull(dot);
        const m = text ? /^gitdir:\s*(.+?)\s*$/m.exec(text) : null;
        return m ? path.resolve(dir, m[1]) : undefined;
      }
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    return undefined;
  }
}

/** The folder holding the shared refs: the one `commondir` names, else the git folder itself. */
function commonFolder(git: string): string {
  const text = readOrNull(path.join(git, 'commondir'));
  const rel = text?.trim();
  return rel ? path.resolve(git, rel) : git;
}

function packedCommit(folder: string, ref: string): string | undefined {
  const text = readOrNull(path.join(folder, 'packed-refs'));
  if (!text) return undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#') || line.startsWith('^')) continue;
    const sp = line.indexOf(' ');
    if (sp > 0 && line.slice(sp + 1).trim() === ref) return line.slice(0, sp);
  }
  return undefined;
}

function refCommit(git: string, ref: string): string | undefined {
  const folders = [git, commonFolder(git)];
  for (const f of folders) {
    const loose = readOrNull(path.join(f, ...ref.split('/')))?.trim();
    if (loose) return loose;
  }
  for (const f of new Set(folders)) {
    const c = packedCommit(f, ref);
    if (c) return c;
  }
  return undefined;
}

/** The branch and commit the checkout at this folder has; undefined when it is no git checkout. */
export function head(root: string): GitHead | undefined {
  const git = gitFolder(root);
  if (!git) return undefined;
  const text = readOrNull(path.join(git, 'HEAD'))?.trim();
  if (!text) return undefined;
  const m = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
  if (m) {
    const commit = refCommit(git, `refs/heads/${m[1]}`);
    return { branch: m[1], ...(commit ? { commit } : {}) };
  }
  return /^[0-9a-f]{7,64}$/i.test(text) ? { commit: text } : undefined;
}

/** The path of the checkout's HEAD file; undefined when it is no git checkout. */
export function headFile(root: string): string | undefined {
  const git = gitFolder(root);
  return git ? path.join(git, 'HEAD') : undefined;
}

/** Whether refs/heads/<branch> exists as a loose ref or a packed-refs line. */
export function hasBranch(root: string, branch: string): boolean {
  const git = gitFolder(root);
  if (!git) return false;
  return refCommit(git, `refs/heads/${branch}`) !== undefined;
}
