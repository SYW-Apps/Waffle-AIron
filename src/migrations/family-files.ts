import * as crypto from 'crypto';
import * as fs from 'fs';
import * as nodePath from 'path';
import type { FileChange, Rehearsal, TransactionScope } from './types.js';

// ---------------------------------------------------------------------------
// family_file_adapter — file I/O on the LIVE family's .wai trees for a staged
// transaction: mirror them into a rehearsal, compare a rehearsal with them,
// read and digest a live file, replace a live file with a staged one, remove
// one, and prune or recreate directories. A scope may also name owners WHOLE
// (a relocated project's old directory and its new root): every file under
// them is mirrored and compared, so a move — made in the rehearsal by move —
// reads as deletes at the old place and creates at the new.
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

/** Every file under an owner, whatever the file — .wai/transactions/ never, no link followed — relative to it, forward slashes. */
function everyFile(owner: string): string[] {
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
      // Following no link: a linked subtree is not the owner's own bytes.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), relPath);
      else if (entry.isFile()) out.push(relPath);
    }
  };
  walk(owner, '');
  return out.sort();
}

/** Whether a directory lies within (or is) any of the whole owners. */
function insideWhole(whole: string[], dir: string): boolean {
  return whole.some((w) => within(w, dir));
}

/** The files a scope copies from one owner: its .wai tree, or exactly its areas. */
function scopedFiles(owner: string, areas: string[] | undefined): string[] {
  return areas ? [...new Set(areas.flatMap((a) => areaFiles(owner, a)))].sort() : waiFiles(owner);
}

/**
 * ifamily_file_adapter.mirror — copy each scoped owner's areas (its .wai tree
 * by default) into the target at its path from the scope's base: the nearest
 * common ancestor of the coordinator and every owner (stage 8: a sibling
 * checkout beside the family root is an owner like any other), the
 * coordinator when the scope names none. An owner outside the base, or on
 * another volume than the coordinator, is refused.
 */
export function mirror(scope: TransactionScope, target: string): Map<string, string> {
  const digests = new Map<string, string>();
  const whole = scope.whole ?? [];
  const base = scope.base ?? scope.familyRoot;
  for (const owner of [...scope.projects, ...whole]) assertPlaceable(scope.familyRoot, base, owner);
  // An owner inside a whole owner is copied once, by the whole owner.
  for (const project of scope.projects.filter((p) => !insideWhole(whole, p))) {
    copyFiles(project, scopedFiles(project, scope.areas), nodePath.join(target, nodePath.relative(base, project)), digests);
  }
  for (const owner of whole) {
    copyFiles(owner, everyFile(owner), nodePath.join(target, nodePath.relative(base, owner)), digests);
  }
  return digests;
}

/** An owner the rehearsal can lay out: on the family root's volume, and under the base. */
function assertPlaceable(familyRoot: string, base: string, owner: string): void {
  if (!within(familyRoot, owner) && !sameVolume(familyRoot, nearestExisting(owner))) {
    throw new Error(`cross-volume: ${owner} lies on another volume than the family root ${familyRoot}, and a rename across volumes is not atomic`);
  }
  if (!within(base, owner)) {
    throw new Error(`${owner} does not lie within ${base}; a rehearsal copies only the family's own trees and the sibling checkouts beside it`);
  }
}

/** A path, or its nearest ancestor that exists. */
function nearestExisting(p: string): string {
  let at = nodePath.resolve(p);
  while (!fs.existsSync(at) && at !== nodePath.dirname(at)) at = nodePath.dirname(at);
  return at;
}

/** Copy an owner's files (relative paths) to the same paths under `at`, recording each live file's digest. */
function copyFiles(owner: string, rels: string[], at: string, digests: Map<string, string>): void {
  fs.mkdirSync(at, { recursive: true });
  for (const rel of rels) {
    const live = nodePath.join(owner, ...rel.split('/'));
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

/** ifamily_file_adapter.compare — the rehearsal's byte difference from the live owners, per owner then path. */
export function compare(rehearsal: Rehearsal): FileChange[] {
  const changes: FileChange[] = [];
  const seen = new Set<string>();
  // Each compared file: live owner, its rehearsal image, the file relative to both.
  for (const [live, copyRoot, rel] of comparedFiles(rehearsal)) {
    seen.add(nodePath.join(live, ...rel.split('/')));
    const change = changeOf(rehearsal, live, rel, sha256(fs.readFileSync(nodePath.join(copyRoot, ...rel.split('/')))));
    if (change) changes.push(change);
  }
  // A copied live file the rehearsal no longer holds is a delete.
  for (const [liveFile, base] of rehearsal.baseDigests) {
    if (seen.has(liveFile)) continue;
    const owner = ownerOf(rehearsal, liveFile);
    changes.push({ project: owner, path: slash(nodePath.relative(owner, liveFile)), action: 'delete', baseDigest: base });
  }
  return changes.sort(byOwnerThenPath);
}

/**
 * The files a comparison reads, as [live owner, rehearsal image, relative path]:
 * every copied owner's areas (a scope that names them), else every .wai tree in
 * the rehearsal — an owner inside a whole owner left to it — and then every
 * whole owner file by file, whatever the file.
 */
function comparedFiles(rehearsal: Rehearsal): [string, string, string][] {
  const whole = rehearsal.whole ?? [];
  const owners: [string, string, string[]][] = rehearsal.areas
    ? [...rehearsal.roots].map(([live, copy]) => [live, copy, scopedFiles(copy, rehearsal.areas)])
    : waiOwners(rehearsal.directory).map((copy) => [nodePath.join(rehearsal.base ?? rehearsal.familyRoot, nodePath.relative(rehearsal.directory, copy)), copy, waiFiles(copy)]);
  const imageOf = (live: string): string => nodePath.join(rehearsal.directory, nodePath.relative(rehearsal.base ?? rehearsal.familyRoot, live));
  const all: [string, string, string[]][] = [
    ...owners.filter(([live]) => !insideWhole(whole, live)),
    ...whole.map((live): [string, string, string[]] => [live, imageOf(live), everyFile(imageOf(live))]),
  ];
  return all.flatMap(([live, copy, rels]) => rels.map((rel): [string, string, string] => [live, copy, rel]));
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

/** The copied project whose .wai holds a live file: the whole owner holding it, else the deepest root that contains it. */
function ownerOf(rehearsal: Rehearsal, liveFile: string): string {
  const whole = (rehearsal.whole ?? []).find((w) => within(w, liveFile));
  if (whole !== undefined) return whole;
  const roots = [...rehearsal.roots.keys()].filter((r) => within(rehearsal.areas ? r : nodePath.join(r, WAI), liveFile));
  return roots.sort((a, b) => b.length - a.length)[0] ?? nodePath.dirname(nodePath.dirname(liveFile));
}

/**
 * ifamily_file_adapter.move — every file under `from` renamed to the same
 * relative path under `to` (inside a rehearsal), the emptied directories below
 * `from` pruned, `from` included. Refuses a target that already holds a file.
 */
export function move(from: string, to: string): void {
  const rels = everyFile(from);
  const taken = rels.find((rel) => fs.existsSync(nodePath.join(to, ...rel.split('/'))));
  if (taken !== undefined) throw new Error(`cannot move ${from} to ${to}: ${nodePath.join(to, ...taken.split('/'))} already exists`);
  for (const rel of rels) {
    const target = nodePath.join(to, ...rel.split('/'));
    makeDirs(nodePath.dirname(target));
    replace(nodePath.join(from, ...rel.split('/')), target);
  }
  for (const rel of rels) prune(nodePath.dirname(nodePath.join(from, ...rel.split('/'))), nodePath.dirname(from));
  prune(from, nodePath.dirname(from));
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
