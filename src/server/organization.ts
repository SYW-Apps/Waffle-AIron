import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  OrganizationUnitRecord,
  ProjectPlacement,
  OrganizationState,
} from './types.js';

// ---------------------------------------------------------------------------
// Organization Repository (sdd_host) — Phase 4
//
// Durable hosted organization hierarchy — units and project placements —
// file-backed as two collections in ONE file at <dataDir>/organization.json
// (an OrganizationState object: { units, placements }). Composition mirrors the
// spec tree:
//   - OrganizationStore    : authoritative in-memory holder of BOTH collections,
//                            loaded from disk (missing file -> two empty
//                            collections; corrupt -> storage error naming the
//                            path). replaceAll swaps both in one assignment.
//   - OrganizationRegistry : the write path — upsert a unit (id/createdAt
//                            stamping, default status active, parentId
//                            referential validation, unit-tree cycle rejection)
//                            and place a project (id/createdAt stamping, unitId
//                            referential validation). Performs NO authorization
//                            (the orchestrator's job).
//   - OrganizationIndex    : the read path — hierarchy listing (direct children
//                            of a parent, or all), membership listing (filtered
//                            by project/unit), and by-id unit lookup; never
//                            mutates.
//   - facade               : the exported upsertOrganizationUnit / placeProject /
//                            listOrganizationUnits / listProjectPlacements /
//                            getOrganizationUnit functions; pure 1:1 forwarding
//                            (writes -> registry, reads -> index).
//
// A lost placement must never silently detach a project from its organization
// unit and a lost unit must never silently orphan its children, so the store
// never discards persisted records and every write goes through
// write-temp-then-rename: a crashed write leaves the prior state fully intact.
// ---------------------------------------------------------------------------

// ── file helpers ───────────────────────────────────────────────────────────

function storePath(dataDir: string): string {
  return path.join(dataDir, 'organization.json');
}

/**
 * Read both persisted collections. A missing file yields two empty collections
 * (first boot is not an error); an unreadable file, structurally invalid JSON,
 * or a shape that is not an object carrying `units` and `placements` arrays fails
 * with a storage error naming the path — persisted organization state is never
 * silently discarded.
 */
function readState(dataDir: string): OrganizationState {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { units: [], placements: [] };
    throw new Error(`Failed to read organization store at ${p}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrganizationState> | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.units) ||
      !Array.isArray(parsed.placements)
    ) {
      throw new Error('expected a JSON object with "units" and "placements" arrays');
    }
    return { units: parsed.units, placements: parsed.placements };
  } catch (e) {
    throw new Error(`Organization store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/** Persist both complete collections atomically (write temp, then rename). */
function persistState(dataDir: string, state: OrganizationState): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/**
 * True when unit `startId`, following parent links through `units`, is reachable
 * from itself — i.e. the parent chain revisits a unit already seen (a cycle in
 * the unit tree, including a unit set as its own parent).
 */
function chainHasCycle(units: OrganizationUnitRecord[], startId: string): boolean {
  const seen = new Set<string>();
  let cur: string | undefined = startId;
  while (cur !== undefined && cur !== '') {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const u = units.find((x) => x.id === cur);
    if (u === undefined) return false; // chain reached a non-existent (root-ward) node
    cur = u.parentId;
  }
  return false;
}

// ── store: authoritative in-memory holder of both collections ───────────────

class OrganizationStore {
  private units: OrganizationUnitRecord[] = [];
  private placements: ProjectPlacement[] = [];
  constructor(private readonly dataDir: string) {}

  /** Load both persisted collections into the authoritative in-memory
   *  representation and return them together. */
  load(): OrganizationState {
    const state = readState(this.dataDir);
    this.units = state.units;
    this.placements = state.placements;
    return { units: this.units, placements: this.placements };
  }

  /** Swap both in-memory collections to complete replacements in one assignment.
   *  Only called by the registry after durable persistence has succeeded, so
   *  index reads always observe a consistent pair of collections. */
  replaceAll(units: OrganizationUnitRecord[], placements: ProjectPlacement[]): void {
    this.units = units;
    this.placements = placements;
  }

  /** The current authoritative unit collection (shared by reference with the index). */
  allUnits(): OrganizationUnitRecord[] {
    return this.units;
  }

  /** The current authoritative placement collection (shared by reference with the index). */
  allPlacements(): ProjectPlacement[] {
    return this.placements;
  }
}

// ── registry: write path ─────────────────────────────────────────────────────

class OrganizationRegistry {
  constructor(private readonly dataDir: string, private readonly store: OrganizationStore) {}

  /**
   * Create or update one organization unit. On create, stamp a random id (when
   * none is supplied) and createdAt; on update (an existing id), preserve both.
   * Default status to active. Validate that parentId — when set — resolves to an
   * existing unit, and reject any change that would introduce a cycle in the unit
   * tree. Persist the full unit collection via write-temp-then-rename, refresh the
   * store, and return the stored unit. Persistence failures leave the previous
   * collections intact. Authorization is the orchestrator's job, not here.
   */
  upsertUnit(unit: OrganizationUnitRecord): OrganizationUnitRecord {
    const units = this.store.allUnits();
    const existingIdx = unit.id ? units.findIndex((u) => u.id === unit.id) : -1;
    const isUpdate = existingIdx >= 0;

    const stored: OrganizationUnitRecord = isUpdate
      ? {
          ...unit,
          id: units[existingIdx].id,
          createdAt: units[existingIdx].createdAt,
          status: unit.status || 'active',
        }
      : {
          ...unit,
          id: unit.id || crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          status: unit.status || 'active',
        };

    if (stored.parentId !== undefined && stored.parentId !== '') {
      if (!units.some((u) => u.id === stored.parentId)) {
        throw new Error(
          `Organization unit parentId "${stored.parentId}" does not resolve to an existing unit.`,
        );
      }
    }

    const next = isUpdate
      ? units.map((u, i) => (i === existingIdx ? stored : u))
      : [...units, stored];

    if (stored.parentId !== undefined && stored.parentId !== '' && chainHasCycle(next, stored.id)) {
      throw new Error(
        `Organization unit "${stored.id}" cannot be its own ancestor; the change would introduce a cycle in the unit tree.`,
      );
    }

    const placements = this.store.allPlacements();
    persistState(this.dataDir, { units: next, placements });
    this.store.replaceAll(next, placements);
    return stored;
  }

  /**
   * Create or update one project placement. On create, stamp a random id (when
   * none is supplied) and createdAt; on update (an existing id), preserve both.
   * Validate that the target unitId resolves to an existing organization unit —
   * failing with a validation error otherwise. Persist the full placement
   * collection via write-temp-then-rename, refresh the store, and return the
   * stored placement. Persistence failures leave the previous collections intact.
   * Authorization is the orchestrator's job, not here.
   */
  placeProject(placement: ProjectPlacement): ProjectPlacement {
    const units = this.store.allUnits();
    if (!units.some((u) => u.id === placement.unitId)) {
      throw new Error(
        `Project placement unitId "${placement.unitId}" does not resolve to an existing organization unit.`,
      );
    }

    const placements = this.store.allPlacements();
    const existingIdx = placement.id ? placements.findIndex((p) => p.id === placement.id) : -1;
    const isUpdate = existingIdx >= 0;

    const stored: ProjectPlacement = isUpdate
      ? {
          ...placement,
          id: placements[existingIdx].id,
          createdAt: placements[existingIdx].createdAt,
        }
      : {
          ...placement,
          id: placement.id || crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        };

    const next = isUpdate
      ? placements.map((p, i) => (i === existingIdx ? stored : p))
      : [...placements, stored];

    persistState(this.dataDir, { units, placements: next });
    this.store.replaceAll(units, next);
    return stored;
  }
}

// ── index: read path ─────────────────────────────────────────────────────────

class OrganizationIndex {
  constructor(private readonly store: OrganizationStore) {}

  /** Return the store's units, narrowed to the direct children of parentId when
   *  supplied, otherwise all units. An empty result is normal, never an error. */
  listUnits(parentId?: string): OrganizationUnitRecord[] {
    const units = this.store.allUnits();
    if (parentId === undefined) return units;
    return units.filter((u) => u.parentId === parentId);
  }

  /** Return the store's placements matching every populated filter — project id
   *  and organization unit id — otherwise all placements. An empty result is
   *  normal, never an error. */
  listPlacements(projectId?: string, unitId?: string): ProjectPlacement[] {
    let placements = this.store.allPlacements();
    if (projectId) placements = placements.filter((p) => p.projectId === projectId);
    if (unitId) placements = placements.filter((p) => p.unitId === unitId);
    return placements;
  }

  /** Return the store's unit whose id matches exactly, or null when absent. */
  getUnit(id: string): OrganizationUnitRecord | null {
    return this.store.allUnits().find((u) => u.id === id) ?? null;
  }
}

// ── repository facade (1:1 forwarding) ──────────────────────────────────────
//
// Pure 1:1 forwarding. Each call materializes the authoritative state from disk
// (mirroring the rest of the server's read-fresh-per-call storage style), wires
// the store/registry/index over it, and forwards. Writes go to the registry,
// reads to the index.

/** Create or update one organization unit through the repository facade (atomic). */
export function upsertOrganizationUnit(
  dataDir: string,
  unit: OrganizationUnitRecord,
): OrganizationUnitRecord {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationRegistry(dataDir, store).upsertUnit(unit);
}

/** Create or update a project placement inside an organization unit (atomic). */
export function placeProject(dataDir: string, placement: ProjectPlacement): ProjectPlacement {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationRegistry(dataDir, store).placeProject(placement);
}

/** List organization units, optionally narrowed to the direct children of a parent. */
export function listOrganizationUnits(
  dataDir: string,
  parentId?: string,
): OrganizationUnitRecord[] {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationIndex(store).listUnits(parentId);
}

/** List project placements, optionally filtered by project id and/or unit id. */
export function listProjectPlacements(
  dataDir: string,
  projectId?: string,
  unitId?: string,
): ProjectPlacement[] {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationIndex(store).listPlacements(projectId, unitId);
}

/** Return one organization unit by id, or null when absent. */
export function getOrganizationUnit(dataDir: string, id: string): OrganizationUnitRecord | null {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationIndex(store).getUnit(id);
}
