import { files } from '../io/index.js';
import * as path from 'path';
import type { ProjectPublicSurfaceSnapshot, PublicInterfaceSummary } from './types.js';
import { readJsonForUpdate, replaceFile } from '../utils/fs.js';
import { withFileLock } from '../utils/file-lock.js';

// ---------------------------------------------------------------------------
// Public Surface Repository (sdd_host)
//
// Durable, redacted per-project public-surface snapshots, file-backed at
// <dataDir>/public-surfaces.json. This is the only hosted read model other
// projects may use to understand a target project's public contract.
// Composition mirrors the spec tree:
//   - PublicSurfaceStore    : authoritative in-memory holder of the snapshot
//                             set (one per project), loaded from disk (missing
//                             file -> empty; corrupt -> storage error naming
//                             the path).
//   - PublicSurfaceRegistry : the write path — replace one project's snapshot
//                             (one snapshot per projectId), stamping exportedAt
//                             server-side while preserving the
//                             orchestrator-redacted interfaces, systemName,
//                             stateId, and exportedBy verbatim. Performs NO
//                             redaction or authorization (the orchestrator's
//                             job).
//   - PublicSurfaceIndex    : the read path — whole-snapshot lookup by project
//                             and single redacted-interface lookup by system
//                             interface id, over the store's set; never mutates.
//   - facade                : the exported replace/get/find functions; pure 1:1
//                             forwarding to the roles above (writes -> registry,
//                             reads -> index).
//
// A public-surface snapshot is the redacted contract a project exposes at one
// spec state: replacement is wholesale per project (never merged), and every
// write goes through write-temp-then-rename so a crashed write leaves the prior
// set fully intact.
// ---------------------------------------------------------------------------

// ── file helpers ───────────────────────────────────────────────────────────

function storePath(dataDir: string): string {
  return path.join(dataDir, 'public-surfaces.json');
}

/**
 * Read the persisted public-surface snapshot set, keyed by project id. A missing
 * file yields an empty set (first boot is not an error); an unreadable file or
 * structurally invalid JSON fails with a storage error naming the path —
 * persisted snapshots are never silently discarded.
 */
function readSnapshots(dataDir: string): ProjectPublicSurfaceSnapshot[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = files.readText(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read public surface store at ${p}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of public surface snapshots');
    return parsed as ProjectPublicSurfaceSnapshot[];
  } catch (e) {
    throw new Error(`Public surface store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/** Persist the complete snapshot set atomically (write temp, then rename). */
function readCurrent(p: string): ProjectPublicSurfaceSnapshot[] {
  const parsed = readJsonForUpdate<unknown>(p, []);
  if (!Array.isArray(parsed)) {
    throw new Error(`Public surface store at ${p} contains malformed JSON: expected a JSON array of public surface snapshots`);
  }
  return parsed as ProjectPublicSurfaceSnapshot[];
}

// ── store: authoritative in-memory holder ──────────────────────────────────

class PublicSurfaceStore {
  private snapshots: ProjectPublicSurfaceSnapshot[] = [];
  constructor(private readonly dataDir: string) {}

  /** Load the persisted set into the authoritative in-memory representation. */
  load(): ProjectPublicSurfaceSnapshot[] {
    this.snapshots = readSnapshots(this.dataDir);
    return this.snapshots;
  }

  /** Swap the in-memory set to a complete replacement in one assignment. Only
   *  called by the registry after durable persistence has succeeded, so index
   *  reads always observe a consistent set. */
  update(change: (snapshots: ProjectPublicSurfaceSnapshot[]) => ProjectPublicSurfaceSnapshot[]): ProjectPublicSurfaceSnapshot[] {
    const p = storePath(this.dataDir);
    files.ensureDir(path.dirname(p));
    this.snapshots = withFileLock(p, () => {
      const next = change(readCurrent(p));
      replaceFile(p, JSON.stringify(next, null, 2) + '\n');
      return next;
    });
    return this.snapshots;
  }

  /** The current authoritative set (shared by reference with the index). */
  all(): ProjectPublicSurfaceSnapshot[] {
    return this.snapshots;
  }
}

// ── registry: write path ────────────────────────────────────────────────────

class PublicSurfaceRegistry {
  constructor(private readonly store: PublicSurfaceStore) {}

  /**
   * Replace the snapshot for its projectId (one snapshot per project): stamp
   * exportedAt to the current server time while preserving the
   * orchestrator-supplied redacted interfaces, systemName, stateId, and
   * exportedBy verbatim. Persist the full set via write-temp-then-rename, refresh
   * the store, and return the stored snapshot. Persistence failures leave the
   * previous set intact. Redaction and authorization are enforced by the
   * orchestrator, not here.
   */
  replaceSnapshot(snapshot: ProjectPublicSurfaceSnapshot): ProjectPublicSurfaceSnapshot {
    const stored: ProjectPublicSurfaceSnapshot = {
      ...snapshot,
      exportedAt: new Date().toISOString(),
    };
    this.store.update((snapshots) => [
      ...snapshots.filter((s) => s.projectId !== stored.projectId),
      stored,
    ]);
    return stored;
  }
}

// ── index: read path ────────────────────────────────────────────────────────

class PublicSurfaceIndex {
  constructor(private readonly store: PublicSurfaceStore) {}

  /** Return the store's snapshot for the given project, or null when none exists. */
  getSnapshot(projectId: string): ProjectPublicSurfaceSnapshot | null {
    return this.store.all().find((s) => s.projectId === projectId) ?? null;
  }

  /**
   * Return the redacted public interface summary from the project's snapshot
   * whose id matches systemInterfaceId, or null when the project has no snapshot
   * or no such interface.
   */
  findInterface(projectId: string, systemInterfaceId: string): PublicInterfaceSummary | null {
    const snapshot = this.getSnapshot(projectId);
    if (snapshot === null) return null;
    return snapshot.interfaces.find((i) => i.id === systemInterfaceId) ?? null;
  }
}

// ── repository facade (1:1 forwarding) ──────────────────────────────────────
//
// Pure 1:1 forwarding. Each call materializes the authoritative set from disk
// (mirroring the rest of the server's read-fresh-per-call storage style), wires
// the store/registry/index over it, and forwards. Writes go to the registry,
// reads to the index.

/** Replace one project's public-surface snapshot wholesale (atomic). */
export function replacePublicSurfaceSnapshot(
  dataDir: string,
  snapshot: ProjectPublicSurfaceSnapshot,
): ProjectPublicSurfaceSnapshot {
  return new PublicSurfaceRegistry(new PublicSurfaceStore(dataDir)).replaceSnapshot(snapshot);
}

/** Return the latest public-surface snapshot for a project, or null when absent. */
export function getPublicSurfaceSnapshot(
  dataDir: string,
  projectId: string,
): ProjectPublicSurfaceSnapshot | null {
  const store = new PublicSurfaceStore(dataDir);
  store.load();
  return new PublicSurfaceIndex(store).getSnapshot(projectId);
}

/** Return one public interface summary from a project's snapshot, or null when absent. */
export function findPublicInterface(
  dataDir: string,
  projectId: string,
  systemInterfaceId: string,
): PublicInterfaceSummary | null {
  const store = new PublicSurfaceStore(dataDir);
  store.load();
  return new PublicSurfaceIndex(store).findInterface(projectId, systemInterfaceId);
}
