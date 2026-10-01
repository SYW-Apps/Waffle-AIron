import * as crypto from 'crypto';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { FileChange, Rehearsal, TransactionScope } from './types.js';

// ---------------------------------------------------------------------------
// family_file_adapter — file I/O on the LIVE family's .wai trees for a staged
// transaction: mirror them into a rehearsal, compare a rehearsal with them,
// read and digest a live file, replace a live file with a staged one, remove
// one, and prune or recreate directories.
//
// The swap is a same-volume rename (MoveFileEx with replace-existing on
// Windows, rename(2) elsewhere), so a reader sees the old file or the new one
// and never a torn one. On Windows a replace, place or remove that fails with
// EPERM, EBUSY or EACCES — a scanner, indexer or editor holding the file
// without delete-sharing — is retried: up to 8 attempts, 25 ms doubling to
// 400 ms, about two seconds in all. A target carrying the read-only attribute
// fails at once. A rename across volumes is never attempted: sameVolume is
// asked first. Standalone: it holds no state.
// ---------------------------------------------------------------------------

const WAI = '.wai';
/** The transaction area inside a .wai tree: never mirrored, never compared. */
const TRANSACTIONS = 'transactions';
const RETRIED = new Set(['EPERM', 'EBUSY', 'EACCES']);
const ATTEMPTS = 8;

const sha256 = (bytes: Uint8Array): string => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const slash = (p: string): string => p.split(nodePath.sep).join('/');

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A target carrying the read-only attribute: a retry would never clear it. */
function readOnly(target: string): boolean {
  try {
    return (fs.statSync(target).mode & 0o200) === 0;
  } catch {
    return false;
  }
}

/** Run one live-file mutation, retrying a transient sharing violation with the bounded backoff. */
function retrying(operation: string, file: string, run: () => void): void {
  let delay = 25;
  for (let attempt = 1; ; attempt++) {
    try {
      run();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRIED.has(code) || attempt >= ATTEMPTS || readOnly(file)) {
        throw new Error(`${operation} ${file} failed: ${code ? `${code} ` : ''}${e instanceof Error ? e.message : String(e)}`);
      }
      pause(delay);
      delay = Math.min(delay * 2, 400);
    }
  }
}

/** Every file under a .wai directory except its transaction area, as paths relative to that .wai's parent. */
function waiFiles(owner: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (relPath === `${WAI}/${TRANSACTIONS}`) continue;
      // Following no link: a linked subtree is not the family's own bytes.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(nodePath.join(owner, WAI), WAI);
  return out.sort();
}

/** Every directory holding a .wai tree under a root (the root included), not descending into any .wai. */
function waiOwners(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === WAI) out.push(dir);
      else walk(nodePath.join(dir, entry.name));
    }
  };
  walk(root);
  return out.sort();
}

function within(root: string, candidate: string): boolean {
  const rel = nodePath.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !nodePath.isAbsolute(rel));
}

/** Every file under an area of an owner (a file area answers itself), relative to the owner, forward slashes; .wai/transactions/ never. */
function areaFiles(owner: string, area: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    if (rel === `${WAI}/${TRANSACTIONS}`) return;
    const abs = nodePath.join(owner, ...rel.split('/'));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      return;
    }
    // Following no link: a linked subtree is not the owner's own bytes.
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      out.push(rel);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`);
  };
  walk(area.split(nodePath.sep).join('/').replace(/\/+$/, ''));
  return out.sort();
}

/** The files a scope copies from one owner: its .wai tree, or exactly its areas. */
function scopedFiles(owner: string, areas: string[] | undefined): string[] {
  return areas ? [...new Set(areas.flatMap((a) => areaFiles(owner, a)))].sort() : waiFiles(owner);
}

/** ifamily_file_adapter.mirror — copy each scoped owner's areas (its .wai tree by default) into the target at its path from the coordinator root. */
export function mirror(scope: TransactionScope, target: string): Map<string, string> {
  const digests = new Map<string, string>();
  for (const project of scope.projects) {
    if (!within(scope.familyRoot, project)) {
      throw new Error(`${project} does not lie within the family root ${scope.familyRoot}; a rehearsal copies only the family's own trees`);
    }
    const at = nodePath.join(target, nodePath.relative(scope.familyRoot, project));
    fs.mkdirSync(at, { recursive: true });
    for (const rel of scopedFiles(project, scope.areas)) {
      const live = nodePath.join(project, ...rel.split('/'));
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(live);
      } catch (e) {
        throw new Error(`could not copy ${live} into the rehearsal: ${e instanceof Error ? e.message : String(e)}`);
      }
      const copy = nodePath.join(at, ...rel.split('/'));
      fs.mkdirSync(nodePath.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, bytes);
      digests.set(live, sha256(bytes));
    }
  }
  return digests;
}

/** ifamily_file_adapter.compare — the rehearsal's byte difference from the live owners, per owner then path. */
export function compare(rehearsal: Rehearsal): FileChange[] {
  const changes: FileChange[] = [];
  const seen = new Set<string>();
  const visit = (live: string, copyRoot: string, rel: string): void => {
    seen.add(nodePath.join(live, ...rel.split('/')));
    const change = changeOf(rehearsal, live, rel, sha256(fs.readFileSync(nodePath.join(copyRoot, ...rel.split('/')))));
    if (change) changes.push(change);
  };
  if (rehearsal.areas) {
    // A scope that names areas: only those areas of each copied owner.
    for (const [live, copyRoot] of rehearsal.roots) {
      for (const rel of scopedFiles(copyRoot, rehearsal.areas)) visit(live, copyRoot, rel);
    }
  } else {
    for (const owner of waiOwners(rehearsal.directory)) {
      const live = nodePath.join(rehearsal.familyRoot, nodePath.relative(rehearsal.directory, owner));
      for (const rel of waiFiles(owner)) visit(live, owner, rel);
    }
  }
  // A copied live file the rehearsal no longer holds is a delete.
  for (const [liveFile, base] of rehearsal.baseDigests) {
    if (seen.has(liveFile)) continue;
    const owner = ownerOf(rehearsal, liveFile);
    changes.push({ project: owner, path: slash(nodePath.relative(owner, liveFile)), action: 'delete', baseDigest: base });
  }
  return changes.sort(byOwnerThenPath);
}

/** One rehearsal file against its live base: a write, a create, or nothing when the bytes are equal. */
function changeOf(rehearsal: Rehearsal, live: string, rel: string, staged: string): FileChange | null {
  const base = rehearsal.baseDigests.get(nodePath.join(live, ...rel.split('/')));
  if (base === staged) return null;
  return base === undefined
    ? { project: live, path: rel, action: 'create', stagedDigest: staged }
    : { project: live, path: rel, action: 'write', baseDigest: base, stagedDigest: staged };
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const byOwnerThenPath = (a: FileChange, b: FileChange): number => order(a.project, b.project) || order(a.path, b.path);

/** The copied project whose .wai holds a live file: the deepest root that contains it. */
function ownerOf(rehearsal: Rehearsal, liveFile: string): string {
  const roots = [...rehearsal.roots.keys()].filter((r) => within(rehearsal.areas ? r : nodePath.join(r, WAI), liveFile));
  return roots.sort((a, b) => b.length - a.length)[0] ?? nodePath.dirname(nodePath.dirname(liveFile));
}

/** ifamily_file_adapter.read — a file's bytes, or null when it is absent. */
export function read(path: string): Buffer | null {
  try {
    return fs.readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`could not read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** ifamily_file_adapter.digest — `sha256:<hex>` of a file's bytes, or null when it is absent. */
export function digest(path: string): string | null {
  const bytes = read(path);
  return bytes === null ? null : sha256(bytes);
}

/** ifamily_file_adapter.replace — rename a staged file over a live path, with the bounded retries. */
export function replace(source: string, target: string): void {
  retrying('replace', target, () => fs.renameSync(source, target));
}

/** ifamily_file_adapter.place — bytes onto a live path the way a swap does: temporary sibling, fsync, rename. */
export function place(path: string, bytes: Uint8Array): void {
  fs.mkdirSync(nodePath.dirname(path), { recursive: true });
  const tmp = `${path}.wairon-restore`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    retrying('place', path, () => fs.renameSync(tmp, path));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** ifamily_file_adapter.remove — delete a live file with the same retries; absent is success. */
export function remove(path: string): void {
  retrying('remove', path, () => {
    try {
      fs.unlinkSync(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  });
}

/** ifamily_file_adapter.makeDirs — create a directory and its missing parents, answering the created ones shallowest first. */
export function makeDirs(dir: string): string[] {
  const missing: string[] = [];
  let at = nodePath.resolve(dir);
  while (!fs.existsSync(at)) {
    missing.unshift(at);
    const up = nodePath.dirname(at);
    if (up === at) break;
    at = up;
  }
  for (const d of missing) fs.mkdirSync(d);
  return missing;
}

/** ifamily_file_adapter.prune — remove an empty directory and each empty parent below stopAt, deepest first. */
export function prune(dir: string, stopAt: string): string[] {
  const removed: string[] = [];
  const stop = nodePath.resolve(stopAt);
  let at = nodePath.resolve(dir);
  while (at !== stop && within(stop, at)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(at);
    } catch {
      break;
    }
    if (entries.length > 0) break;
    fs.rmdirSync(at);
    removed.push(at);
    at = nodePath.dirname(at);
  }
  return removed;
}

/**
 * ifamily_file_adapter.resolve — a path relative to a project root under the
 * containment guard: the absolute directory when it lies strictly within the
 * root lexically and, through links, its nearest existing ancestor lands
 * within the root's real path too; null otherwise. Writes nothing.
 */
export function resolve(root: string, path: string): string | null {
  const dir = lexicalTarget(root, path);
  return dir !== null && landsWithin(root, dir) ? dir : null;
}

/** Whether a directory lies strictly below a root (not the root itself). */
function strictlyWithin(root: string, dir: string): boolean {
  const rel = nodePath.relative(root, dir);
  return rel !== '' && !rel.startsWith('..') && !nodePath.isAbsolute(rel);
}

/** The directory a relative path names below a root, read lexically; null for an empty, absolute or escaping path. */
function lexicalTarget(root: string, path: string): string | null {
  if (!path || nodePath.isAbsolute(path) || nodePath.win32.isAbsolute(path)) return null;
  const dir = nodePath.resolve(root, path);
  return strictlyWithin(root, dir) ? dir : null;
}

/** Through links: the directory's nearest existing ancestor lands at or below the root's real path. */
function landsWithin(root: string, dir: string): boolean {
  let at = dir;
  while (!fs.existsSync(at) && at !== nodePath.dirname(at)) at = nodePath.dirname(at);
  try {
    const real = fs.realpathSync(at);
    const realRoot = fs.realpathSync(root);
    return real === realRoot || strictlyWithin(realRoot, real);
  } catch {
    return false;
  }
}

/** ifamily_file_adapter.holdsProject — whether a directory already holds a wairon project (a .wai/project.yaml). Writes nothing. */
export function holdsProject(dir: string): boolean {
  return fs.existsSync(nodePath.join(dir, '.wai', 'project.yaml'));
}

/** ifamily_file_adapter.sameVolume — whether two existing paths share a device; a missing path answers false. */
export function sameVolume(a: string, b: string): boolean {
  try {
    return fs.statSync(a).dev === fs.statSync(b).dev;
  } catch {
    return false;
  }
}
