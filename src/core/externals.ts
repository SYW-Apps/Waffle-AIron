import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot, withLineEndings } from '../utils/fs.js';
import { readYamlFile, serializeYaml } from '../utils/yaml.js';
import { canonicalize } from '../utils/canonical-json.js';
import {
  ExternalsLockSchema,
  ParentExcerptSchema,
  SurfaceSnapshotSchema,
  type ExternalsLock,
  type ParentExcerpt,
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
  fs.writeFileSync(tmp, withLineEndings(file, text));
  fs.renameSync(tmp, file);
}

/** The lock with its aliases sorted, so a re-pin of the same set writes the same bytes; a part's parent entry kept. */
function sortedLock(lock: ExternalsLock): ExternalsLock {
  const externals: ExternalsLock['externals'] = {};
  for (const alias of Object.keys(lock.externals).sort()) externals[alias] = lock.externals[alias];
  return { externals, ...(lock.parent !== undefined ? { parent: lock.parent } : {}) };
}

// ── externals_file_adapter ──────────────────────────────────────────────────

/** iexternals_file_adapter. */
export interface ExternalsFileAdapter {
  readLock(): ExternalsLock | null;
  writeLock(lock: ExternalsLock): void;
  readSnapshot(alias: string): SurfaceSnapshot | null;
  writeSnapshot(alias: string, snapshot: SurfaceSnapshot): void;
  deleteSnapshot(alias: string): boolean;
  readExcerpt(project: string): ParentExcerpt | null;
  writeExcerpt(excerpt: ParentExcerpt): void;
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
  readExcerpt(project) {
    // Null when absent, not valid YAML or failing the schema: the gate then
    // reports the part's parent as unpinned rather than throwing (stage 8).
    const file = snapshotPath(getProjectRoot(), project);
    if (!fs.existsSync(file)) return null;
    try {
      return ParentExcerptSchema.parse(readYamlFile(file));
    } catch {
      return null;
    }
  },
  writeExcerpt(excerpt) {
    // Canonical key order, written atomically; the directory is created when missing.
    writeAtomically(snapshotPath(getProjectRoot(), excerpt.project), serializeYaml(JSON.parse(canonicalize(ParentExcerptSchema.parse(excerpt)))));
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
  readExcerpt(project: string): ParentExcerpt | null;
  writeExcerpt(excerpt: ParentExcerpt): void;
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
  readExcerpt(project) {
    // Read-through: no RAM copy.
    return externalsFileAdapter.readExcerpt(project);
  },
  writeExcerpt(excerpt) {
    externalsFileAdapter.writeExcerpt(excerpt);
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
  readExcerpt(project: string): ParentExcerpt | null;
  saveExcerpt(excerpt: ParentExcerpt): void;
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
  readExcerpt(project) {
    return pinnedExternalsStore.readExcerpt(project);
  },
  saveExcerpt(excerpt) {
    pinnedExternalsStore.writeExcerpt(excerpt);
  },
};

// ── surface_orchestrator: carrying and removing a pin ───────────────────────
//
// The two pin writes the family migrations make (stage 6): a rename carries a
// pin to its new alias or producer id WITHOUT re-pinning — a rename is not a
// producer change, and re-pinning would hide one — and an adopt or an
// internalize removes the pin of an alias that stops being an external. Both
// act at the bound project's root. The caller must gate on reach itself.

/** isurface_orchestrator.renamePin — carry the bound project's pin of one external to a new alias or producer id, digest unchanged. */
export function renamePin(alias: string, newAlias: string, project: string): boolean {
  // Step 1: the current lock (none yet reads as empty).
  const lock: ExternalsLock = externalsRepository.readLock() ?? { externals: {} };
  const entry = lock.externals[alias];
  // Steps 2-3: nothing to carry.
  if (entry === undefined || (alias === newAlias && entry.project === project)) return false;
  // Step 4: the pinned snapshot.
  const snapshot = externalsRepository.readSnapshot(alias);
  // Steps 5-6: its producer id set to the new one — its content, and so its digest, untouched.
  if (snapshot) externalsRepository.saveSnapshot(newAlias, { ...snapshot, projectId: project });
  // Step 7: the entry under the new alias with the new producer id, digest and `used` as pinned.
  const externals = Object.fromEntries(Object.entries(lock.externals)
    .filter(([key]) => key !== alias)
    .concat([[newAlias, { ...entry, project, snapshot: `.wai/externals/${newAlias}.yaml` }]]));
  externalsRepository.saveLock({ ...lock, externals });
  // Steps 8-9: the snapshot under the old alias goes.
  if (newAlias !== alias) externalsRepository.removeSnapshot(alias);
  // Step 10.
  return true;
}

/** isurface_orchestrator.unpin — remove the bound project's pin of one alias: its lock entry and its snapshot. */
export function unpin(alias: string): boolean {
  // Step 1.
  const lock = externalsRepository.readLock();
  // Steps 2-3: nothing pinned.
  if (!lock || lock.externals[alias] === undefined) return false;
  // Step 4: the entry dropped and the lock saved.
  const externals = Object.fromEntries(Object.entries(lock.externals).filter(([key]) => key !== alias));
  externalsRepository.saveLock({ ...lock, externals });
  // Step 5.
  externalsRepository.removeSnapshot(alias);
  // Step 6.
  return true;
}
