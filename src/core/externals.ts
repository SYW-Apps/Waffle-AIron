import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { readYamlFile, serializeYaml } from '../utils/yaml.js';
import {
  ExternalsLockSchema,
  SurfaceSnapshotSchema,
  type ExternalsLock,
  type SurfaceSnapshot,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// The project's pinned externals (sdd_surfaces): the lock at
// .wai/externals.lock.yaml and the snapshots it names under
// .wai/externals/<alias>.yaml — one aggregate, as a lockfile and the contracts
// it digests are one, apart from the legacy .wai/surfaces snapshots the
// surface repository holds.
//
// Three components, one file (N:1), each an object over the one below it:
//   externals_file_adapter  — the only block that touches those files;
//   pinned_externals_store  — read-through state: every read is the file read,
//                             nothing is held in memory, nothing to hydrate;
//   externals_repository    — the facade consumers use, forwarding 1:1.
// ---------------------------------------------------------------------------

/** The externals lock's path at a project root. */
function lockPath(root: string): string {
  return path.join(root, '.wai', 'externals.lock.yaml');
}

/** An alias's snapshot path at a project root. */
function snapshotPath(root: string, alias: string): string {
  return path.join(root, '.wai', 'externals', `${alias}.yaml`);
}

/** Write a file atomically: to a sibling temp file, then renamed over the target. */
function writeAtomically(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** The lock with its aliases sorted, so a re-pin of the same set writes the same bytes. */
function sortedLock(lock: ExternalsLock): ExternalsLock {
  const externals: ExternalsLock['externals'] = {};
  for (const alias of Object.keys(lock.externals).sort()) externals[alias] = lock.externals[alias];
  return { externals };
}

// ── externals_file_adapter ──────────────────────────────────────────────────

/** iexternals_file_adapter. */
export interface ExternalsFileAdapter {
  readLock(): ExternalsLock | null;
  writeLock(lock: ExternalsLock): void;
  readSnapshot(alias: string): SurfaceSnapshot | null;
  writeSnapshot(alias: string, snapshot: SurfaceSnapshot): void;
  deleteSnapshot(alias: string): boolean;
}

export const externalsFileAdapter: ExternalsFileAdapter = {
  readLock() {
    // Null when absent; a lock that fails to parse or fails the schema is
    // refused naming the file — read as empty, it would silently unpin everything.
    const file = lockPath(getProjectRoot());
    if (!fs.existsSync(file)) return null;
    let raw: unknown;
    try {
      raw = readYamlFile(file);
    } catch (e) {
      throw new Error(`The externals lock ${file} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = ExternalsLockSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      throw new Error(`The externals lock ${file} does not match its schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    return parsed.data;
  },
  writeLock(lock) {
    writeAtomically(lockPath(getProjectRoot()), serializeYaml(sortedLock(lock)));
  },
  readSnapshot(alias) {
    // Null when absent or malformed: status then reports the alias as unpinned.
    const file = snapshotPath(getProjectRoot(), alias);
    if (!fs.existsSync(file)) return null;
    try {
      return SurfaceSnapshotSchema.parse(readYamlFile(file));
    } catch {
      return null;
    }
  },
  writeSnapshot(alias, snapshot) {
    writeAtomically(snapshotPath(getProjectRoot(), alias), serializeYaml(SurfaceSnapshotSchema.parse(snapshot)));
  },
  deleteSnapshot(alias) {
    const file = snapshotPath(getProjectRoot(), alias);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    // An emptied externals directory goes with its last snapshot.
    const dir = path.dirname(file);
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    return true;
  },
};

// ── pinned_externals_store ──────────────────────────────────────────────────

/** ipinned_externals_store — read-through: each method is one file operation. */
export interface PinnedExternalsStore {
  readLock(): ExternalsLock | null;
  writeLock(lock: ExternalsLock): void;
  readSnapshot(alias: string): SurfaceSnapshot | null;
  writeSnapshot(alias: string, snapshot: SurfaceSnapshot): void;
  removeSnapshot(alias: string): boolean;
}

export const pinnedExternalsStore: PinnedExternalsStore = {
  readLock() {
    return externalsFileAdapter.readLock();
  },
  writeLock(lock) {
    externalsFileAdapter.writeLock(lock);
  },
  readSnapshot(alias) {
    return externalsFileAdapter.readSnapshot(alias);
  },
  writeSnapshot(alias, snapshot) {
    externalsFileAdapter.writeSnapshot(alias, snapshot);
  },
  removeSnapshot(alias) {
    return externalsFileAdapter.deleteSnapshot(alias);
  },
};

// ── externals_repository ────────────────────────────────────────────────────

/** iexternals_repository — the facade: each method one call to the store. */
export interface ExternalsRepository {
  readLock(): ExternalsLock | null;
  saveLock(lock: ExternalsLock): void;
  readSnapshot(alias: string): SurfaceSnapshot | null;
  saveSnapshot(alias: string, snapshot: SurfaceSnapshot): void;
  removeSnapshot(alias: string): boolean;
}

export const externalsRepository: ExternalsRepository = {
  readLock() {
    return pinnedExternalsStore.readLock();
  },
  saveLock(lock) {
    pinnedExternalsStore.writeLock(lock);
  },
  readSnapshot(alias) {
    return pinnedExternalsStore.readSnapshot(alias);
  },
  saveSnapshot(alias, snapshot) {
    pinnedExternalsStore.writeSnapshot(alias, snapshot);
  },
  removeSnapshot(alias) {
    return pinnedExternalsStore.removeSnapshot(alias);
  },
};
