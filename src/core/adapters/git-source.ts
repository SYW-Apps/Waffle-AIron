import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WaironError } from '../../utils/errors.js';

// ---------------------------------------------------------------------------
// git_source_adapter (sdd_core) — the only block that talks to git for stage
// 8's sources. It materializes a repository at one commit into wairon's
// content-addressed fetch cache, resolves a ref to the commit it names now,
// and reads the commit of a work tree on disk.
//
// The cache lives outside every project tree — WAIRON_CACHE_DIR, else the OS
// user cache directory — under git/<sha256 of the URL>/<commit>, so nothing
// fetched is ever committed with a project. An entry is written to a temporary
// directory and renamed into place, so a cut-short fetch never leaves half a
// commit; and an entry is immutable, because a commit's content never changes.
// Offline, a cached commit serves exactly as online; an uncached one is
// unavailable, never a pass. A verdict never resolves a ref: only pinning and
// updating do.
// ---------------------------------------------------------------------------

/** Thrown when a git source cannot be read: offline, refused, an unknown commit or ref, a missing dir. */
export class SourceUnavailable extends WaironError {
  constructor(message: string) {
    super(message);
    this.name = 'SourceUnavailable';
  }
}

/** The OS user cache directory wairon's cache lives under when WAIRON_CACHE_DIR is not set. */
function osUserCache(): string {
  if (process.platform === 'win32') return process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
}

/** The cache root, resolved once per setting of WAIRON_CACHE_DIR. */
const cacheRoots = new Map<string, string>();
function cacheRoot(): string {
  const setting = process.env.WAIRON_CACHE_DIR ?? '';
  let root = cacheRoots.get(setting);
  if (root === undefined) {
    root = setting !== '' ? path.resolve(setting) : path.join(osUserCache(), 'wairon');
    cacheRoots.set(setting, root);
  }
  return root;
}

/** git, never prompting for credentials: an unattended run fails rather than hangs. */
function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
}

/** Why a git call failed, in one line: its stderr when it gave one. */
function reasonOf(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : e instanceof Error ? e.message : String(e);
  return text.trim().split(/\r?\n/).filter((l) => l.trim() !== '').slice(-1)[0] ?? 'git failed';
}

/** The cache directory of one commit of one repository. */
export function cacheEntryOf(url: string, commit: string): string {
  const repo = crypto.createHash('sha256').update(url).digest('hex');
  return path.join(cacheRoot(), 'git', repo, commit);
}

/** `dir` inside an entry, refused when the commit does not hold it. */
function within(entry: string, url: string, commit: string, dir: string | undefined): string {
  const at = dir ? path.join(entry, dir) : entry;
  if (!fs.existsSync(at)) {
    throw new SourceUnavailable(`the commit ${commit} of ${url} holds no "${dir}"`);
  }
  return at;
}

/** Fetch exactly the commit into a fresh repository at `tmp`, falling back to a full fetch when the remote refuses a commit by id. */
function fetchInto(tmp: string, url: string, commit: string): void {
  git(['init', '-q'], tmp);
  try {
    git(['fetch', '-q', '--depth', '1', url, commit], tmp);
  } catch {
    // A remote that does not serve a commit by id still serves its refs.
    git(['fetch', '-q', url, '+refs/heads/*:refs/remotes/source/*', '+refs/tags/*:refs/tags/*'], tmp);
  }
  git(['-c', 'advice.detachedHead=false', 'checkout', '-q', commit], tmp);
  // The entry is content only: the commit's tree, never a repository a later read could move.
  fs.rmSync(path.join(tmp, '.git'), { recursive: true, force: true });
}

/**
 * igit_source_adapter.fetch — the cache directory holding `dir` of the
 * repository at exactly that commit, fetching it (that commit only, shallow)
 * when the cache does not hold it yet. Throws SourceUnavailable naming why when
 * it cannot. A cached commit is answered without touching the network, and a
 * failed fetch leaves the cache exactly as it was.
 */
export function fetch(url: string, commit: string, dir?: string): string {
  const entry = cacheEntryOf(url, commit);
  if (fs.existsSync(entry)) return within(entry, url, commit, dir);
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const tmp = `${entry}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(tmp, { recursive: true });
  try {
    fetchInto(tmp, url, commit);
    try {
      fs.renameSync(tmp, entry);
    } catch (e) {
      // A concurrent fetch that won the rename holds the same content.
      if (!fs.existsSync(entry)) throw e;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    // A repository folder this fetch created and nothing filled goes with it.
    if (fs.readdirSync(path.dirname(entry)).length === 0) fs.rmdirSync(path.dirname(entry));
    throw e instanceof SourceUnavailable ? e : new SourceUnavailable(`cannot fetch ${commit} of ${url}: ${reasonOf(e)}`);
  }
  return within(entry, url, commit, dir);
}

/**
 * igit_source_adapter.resolve — the full commit a ref names on the remote now
 * (the remote's default branch when no ref is given). Network; throws
 * SourceUnavailable when the remote cannot be reached or lists no such ref.
 * Called only by pinning and updating, never by a validate.
 */
export function resolve(url: string, ref?: string): string {
  let listed: string;
  try {
    listed = git(['ls-remote', url, ref ?? 'HEAD']);
  } catch (e) {
    throw new SourceUnavailable(`cannot reach ${url}: ${reasonOf(e)}`);
  }
  const wanted = commitListed(listed, ref ?? 'HEAD');
  if (!wanted) throw new SourceUnavailable(`${url} lists no ref "${ref ?? 'HEAD'}"`);
  return wanted;
}

/** The commit ls-remote listed for a ref: HEAD, a branch, or a tag (its peeled commit first). */
function commitListed(listed: string, ref: string): string | undefined {
  const lines = listed.split(/\r?\n/).filter((l) => l.trim() !== '').map((l) => l.split(/\s+/));
  const names = [ref, `refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`];
  for (const name of names) {
    const line = lines.find(([, listedName]) => listedName === name);
    if (line) return line[0];
  }
  return undefined;
}

/**
 * igit_source_adapter.trackedFiles — the files under the pathspecs (relative to
 * the directory) that the index of the work tree holding the directory tracks,
 * committed or staged, answered relative to the directory. Ignored and
 * untracked files are never listed. Null when the directory is in no work tree
 * or git is not installed: "git tracks none" is an empty list, "no git to ask"
 * is null. No network.
 */
export function trackedFiles(directory: string, pathspecs: string[]): string[] | null {
  if (pathspecs.length === 0) return [];
  try {
    return git(['ls-files', '-z', '--', ...pathspecs], directory).split('\0').filter((p) => p !== '');
  } catch {
    return null;
  }
}

/**
 * igit_source_adapter.head — the commit checked out in the work tree that
 * holds a directory, or null when the directory is in no git work tree (or git
 * is not installed). No network; provenance only.
 */
export function head(directory: string): string | null {
  try {
    return git(['rev-parse', 'HEAD'], directory).trim() || null;
  } catch {
    return null;
  }
}

/**
 * igit_source_adapter.repositoryRoot — the root of the git work tree holding a
 * directory: the nearest ancestor (the directory itself included) holding a
 * `.git` entry, a directory or a worktree's file; null when none does. A
 * filesystem walk, no git process: what tells a producer in another
 * repository (whose commit a pin records) from a same-repository one.
 */
export function repositoryRoot(directory: string): string | null {
  let at = path.resolve(directory);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

