import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ProjectRelationRecord } from './types.js';

// ---------------------------------------------------------------------------
// Project Relation Repository (sdd_host)
//
// Durable, hosted-instance metadata describing directed cross-project
// relations (a source project consuming a target project's exported system
// public interface), file-backed at <dataDir>/relations.json. Composition
// mirrors the spec tree:
//   - ProjectRelationStore    : authoritative in-memory holder of the relation
//                               set, loaded from disk (missing file -> empty;
//                               corrupt -> storage error naming the path).
//   - ProjectRelationRegistry : the write path — upsert (id stamping + status
//                               defaulting) and remove. Preserves the
//                               orchestrator-supplied createdAt/createdBy and
//                               the orchestrator-validated targetPublicInterface;
//                               performs NO authorization or public-surface
//                               validation (that is the orchestrator's gate).
//   - ProjectRelationIndex    : the read path — filtered queries over the
//                               store's set; never mutates.
//   - facade                  : the exported upsert/remove/list functions; pure
//                               1:1 forwarding to the roles above (writes ->
//                               registry, reads -> index).
//
// A relation is the record of a declared cross-project dependency: the store
// never silently drops a persisted relation (a lost relation would silently
// sever a declared dependency), and every write goes through
// write-temp-then-rename so a crashed write leaves the prior set fully intact.
// ---------------------------------------------------------------------------

// ── file helpers ───────────────────────────────────────────────────────────

function storePath(dataDir: string): string {
  return path.join(dataDir, 'relations.json');
}

/**
 * Read the persisted cross-project relation set. A missing file yields an empty
 * set (first boot is not an error); an unreadable file or structurally invalid
 * JSON fails with a storage error naming the path — persisted relations are
 * never silently discarded, so a lost relation never drops a declared
 * cross-project dependency.
 */
function readRelations(dataDir: string): ProjectRelationRecord[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read relation store at ${p}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of project relations');
    return parsed as ProjectRelationRecord[];
  } catch (e) {
    throw new Error(`Relation store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/** Persist the complete relation set atomically (write temp, then rename). */
function persistRelations(dataDir: string, relations: ProjectRelationRecord[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(relations, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── store: authoritative in-memory holder ──────────────────────────────────

class ProjectRelationStore {
  private relations: ProjectRelationRecord[] = [];
  constructor(private readonly dataDir: string) {}

  /** Load the persisted set into the authoritative in-memory representation. */
  load(): ProjectRelationRecord[] {
    this.relations = readRelations(this.dataDir);
    return this.relations;
  }

  /** Swap the in-memory set to a complete replacement in one assignment. Only
   *  called by the registry after durable persistence has succeeded, so index
   *  reads always observe a consistent set. */
  replaceAll(relations: ProjectRelationRecord[]): void {
    this.relations = relations;
  }

  /** The current authoritative set (shared by reference with the index). */
  all(): ProjectRelationRecord[] {
    return this.relations;
  }
}

// ── registry: write path ────────────────────────────────────────────────────

class ProjectRelationRegistry {
  constructor(private readonly dataDir: string, private readonly store: ProjectRelationStore) {}

  /**
   * Create or update one cross-project relation. On create, stamp a random id;
   * default status to active when unset. The orchestrator-supplied createdAt and
   * createdBy and the orchestrator-validated targetPublicInterface are preserved
   * untouched. Replace the record in place when its id already exists, otherwise
   * append it, then persist the full set via write-temp-then-rename and refresh
   * the store, returning the stored relation. Persistence failures leave the
   * previous set intact. Public-surface validation and authorization are the
   * orchestrator's job, not here.
   */
  upsert(record: ProjectRelationRecord): ProjectRelationRecord {
    const hasId = typeof record.id === 'string' && record.id.trim().length > 0;
    const hasStatus = typeof record.status === 'string' && record.status.trim().length > 0;
    const stored: ProjectRelationRecord = {
      ...record,
      id: hasId ? record.id : crypto.randomUUID(),
      status: hasStatus ? record.status : 'active',
    };
    const relations = this.store.all();
    const idx = relations.findIndex((r) => r.id === stored.id);
    const next = [...relations];
    if (idx === -1) {
      next.push(stored);
    } else {
      next[idx] = stored;
    }
    persistRelations(this.dataDir, next);
    this.store.replaceAll(next);
    return stored;
  }

  /**
   * Locate the relation by id (not-found error when absent) and remove it from
   * the persisted set, then persist via write-temp-then-rename and refresh the
   * store. A missing id is a safe not-found that mutates and persists nothing;
   * persistence failures leave the previous set intact.
   */
  remove(id: string): void {
    const relations = this.store.all();
    const idx = relations.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new Error(`Project relation "${id}" not found.`);
    }
    const next = relations.filter((_, i) => i !== idx);
    persistRelations(this.dataDir, next);
    this.store.replaceAll(next);
  }
}

// ── index: read path ────────────────────────────────────────────────────────

class ProjectRelationIndex {
  constructor(private readonly store: ProjectRelationStore) {}

  /**
   * Return the store's relations matching every populated filter — source
   * project id, target project id, and status — otherwise all relations.
   * Read-only over the store's current references in insertion order (a stable
   * projection); an empty result is normal, never an error.
   */
  list(sourceProjectId?: string, targetProjectId?: string, status?: string): ProjectRelationRecord[] {
    let relations = this.store.all();
    if (sourceProjectId) relations = relations.filter((r) => r.sourceProjectId === sourceProjectId);
    if (targetProjectId) relations = relations.filter((r) => r.targetProjectId === targetProjectId);
    if (status) relations = relations.filter((r) => r.status === status);
    return [...relations];
  }
}

// ── repository facade (1:1 forwarding) ──────────────────────────────────────
//
// Pure 1:1 forwarding. Each call materializes the authoritative set from disk
// (mirroring the rest of the server's read-fresh-per-call storage style), wires
// the store/registry/index over it, and forwards. Writes go to the registry,
// reads to the index.

/** Create or update one cross-project relation through the repository facade (atomic). */
export function upsertProjectRelation(
  dataDir: string,
  record: ProjectRelationRecord,
): ProjectRelationRecord {
  const store = new ProjectRelationStore(dataDir);
  store.load();
  return new ProjectRelationRegistry(dataDir, store).upsert(record);
}

/** Remove one cross-project relation by id (not-found error when absent; atomic). */
export function removeProjectRelation(dataDir: string, id: string): void {
  const store = new ProjectRelationStore(dataDir);
  store.load();
  new ProjectRelationRegistry(dataDir, store).remove(id);
}

/** List cross-project relations filtered by source project, target project, or status. */
export function listProjectRelations(
  dataDir: string,
  sourceProjectId?: string,
  targetProjectId?: string,
  status?: string,
): ProjectRelationRecord[] {
  const store = new ProjectRelationStore(dataDir);
  store.load();
  return new ProjectRelationIndex(store).list(sourceProjectId, targetProjectId, status);
}
