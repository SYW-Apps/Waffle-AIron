import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type {
  OrganizationUnitRecord,
  ProjectPlacement,
  OrganizationState,
  UnitIdRemap,
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
//   - OrganizationRegistry : the write path — unit lifecycle (createUnit
//                            computes the QUALIFIED DOT-PATH id from the parent
//                            path plus slug and rejects collisions; updateUnit
//                            applies metadata only; reparentUnit moves a whole
//                            subtree and returns the old->new id remap;
//                            deleteUnit removes one emptied unit) and placements
//                            (placeProject stamping + unitId referential
//                            validation, deletePlacement). Performs NO
//                            authorization (the orchestrator's job).
//   - OrganizationIndex    : the read path — hierarchy listing (direct children
//                            of a parent, or all), membership listing (filtered
//                            by project/unit), and by-id unit lookup; never
//                            mutates.
//   - facade               : the exported createUnit / updateUnit / reparentUnit /
//                            deleteUnit / placeProject / deletePlacement /
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

/** A unit's local segment: lowercase [a-z0-9-], dot-free ('.' separates the
 *  qualified path), unique among siblings. */
const SLUG_PATTERN = /^[a-z0-9-]+$/;

/** The canonical organization-unit kinds, top → down. Portfolio was intentionally
 *  dropped — a `group` is the same "named container", so portfolio-style grouping
 *  is a future unit tag, not a distinct kind. */
export const UNIT_KINDS = ['business_entity', 'department', 'team', 'group'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

/** The kinds each kind may be nested DIRECTLY under. A root unit (no parent) must
 *  be a business_entity. Cross-unit projects are not modeled as multi-parent units
 *  — a project keeps a single owner unit and is shared via exposeTo. */
export const ALLOWED_PARENT_KINDS: Record<UnitKind, UnitKind[]> = {
  business_entity: ['business_entity'], // a subsidiary/division under another entity
  department: ['business_entity', 'department'], // a division, or a sub-department (stackable)
  team: ['business_entity', 'department'], // under a department, or an entity (small orgs)
  group: ['team', 'group'], // a subdomain within a team (nestable)
};

/**
 * Enforce the org-unit kind hierarchy for a NEW or moved unit: a root unit
 * (`parentKind` null) must be a business_entity; otherwise `kind` must be allowed
 * directly under the parent's kind, and both must be canonical kinds. Enforced at
 * the ORCHESTRATION layer (like authorization — see createUnit's "not here" note),
 * on new/moved units only, so legacy or test-seeded units are never retroactively
 * invalidated. Throws a plain Error (mapped to a 400-class message upstream).
 */
export function validateUnitHierarchy(kind: string, parentKind: string | null): void {
  if (!(UNIT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Organization unit kind "${kind}" is not one of: ${UNIT_KINDS.join(', ')}.`);
  }
  if (parentKind === null) {
    if (kind !== 'business_entity') {
      throw new Error(`A top-level organization unit must be a business_entity (a "${kind}" needs a parent unit).`);
    }
    return;
  }
  const allowed = ALLOWED_PARENT_KINDS[kind as UnitKind];
  if (!allowed.includes(parentKind as UnitKind)) {
    throw new Error(`A "${kind}" cannot be nested under a "${parentKind}" (allowed parents: ${allowed.join(', ')}).`);
  }
}

/** The qualified dot-path id: the parent's qualified id + '.' + slug; a root
 *  unit's id IS its slug. */
function qualifiedId(parentId: string | undefined, slug: string): string {
  return parentId ? `${parentId}.${slug}` : slug;
}

/** All unit ids in the subtree rooted at `rootId` (root included), resolved by
 *  parentId links — never by id-prefix, so legacy opaque ids stay correct. */
function subtreeIds(units: OrganizationUnitRecord[], rootId: string): Set<string> {
  const subtree = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parentId !== undefined && subtree.has(u.parentId) && !subtree.has(u.id)) {
        subtree.add(u.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/**
 * Fill in a `slug` for a unit persisted before slugs existed.
 *
 * `OrganizationUnitRecord.slug` is REQUIRED by the contract, but records written
 * by a pre-slug wairon have none, and an instance that upgraded without running
 * `wairon host doctor --fix` still holds them. Serving those records verbatim
 * broke the organizations page with an unreadable minified TypeError
 * (`undefined.localeCompare`) — a data-shape problem surfacing as a UI crash,
 * which tells an operator nothing about the actual remedy.
 *
 * Derived, not invented: a unit's id is its dot-qualified path and the slug is the
 * last segment, so a root unit's id IS its slug. That is the same rule the
 * migration applies, which keeps a normalized read and a migrated record in
 * agreement rather than drifting apart.
 *
 * This is a READ-path shim, not a substitute for the migration: grants, tokens,
 * and qualified ids still need `host doctor --fix` (legacy subjects otherwise
 * resolve to zero permissions). It only guarantees that a required field is never
 * absent, so a missing migration presents as missing permissions — a symptom that
 * names its cause — instead of a crashed page.
 */
function normalizeUnit(unit: OrganizationUnitRecord): OrganizationUnitRecord {
  if (unit.slug) return unit;
  const id = unit.id ?? '';
  return { ...unit, slug: id.slice(id.lastIndexOf('.') + 1) };
}

// ── store: authoritative in-memory holder of both collections ───────────────

class OrganizationStore {
  private units: OrganizationUnitRecord[] = [];
  private placements: ProjectPlacement[] = [];
  constructor(private readonly dataDir: string) {}

  /** Load both persisted collections into the authoritative in-memory
   *  representation and return them together. Units are normalized on the way in
   *  (see normalizeUnit) so no reader ever sees a record missing a field the
   *  contract declares as required. */
  load(): OrganizationState {
    const state = readState(this.dataDir);
    this.units = state.units.map(normalizeUnit);
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
   * Create one organization unit: compute its QUALIFIED id from the parentId
   * path plus slug (a root unit's id IS its slug — any incoming id is ignored),
   * validate the slug shape and that parentId — when set — resolves to an
   * existing unit, and reject a collision (an existing unit already holding the
   * qualified id, or a sibling already using the slug). Stamp createdAt, default
   * status to active, persist via write-temp-then-rename, refresh the store, and
   * return the stored unit. Authorization is the orchestrator's job, not here.
   */
  createUnit(unit: OrganizationUnitRecord): OrganizationUnitRecord {
    const units = this.store.allUnits();
    if (!unit.slug || !SLUG_PATTERN.test(unit.slug)) {
      throw new Error(
        `Organization unit slug "${unit.slug}" is invalid — lowercase [a-z0-9-] only (dot-free; '.' separates the qualified path).`,
      );
    }
    const parentId = unit.parentId || undefined;
    if (parentId !== undefined && !units.some((u) => u.id === parentId)) {
      throw new Error(
        `Organization unit parentId "${parentId}" does not resolve to an existing unit.`,
      );
    }
    const id = qualifiedId(parentId, unit.slug);
    if (units.some((u) => u.id === id)) {
      throw new Error(`Organization unit "${id}" already exists — never a silent overwrite.`);
    }
    // Belt-and-braces sibling check: legacy units may hold ids that don't follow
    // the qualified convention, so the id collision alone wouldn't catch them.
    if (units.some((u) => (u.parentId || undefined) === parentId && u.slug === unit.slug)) {
      throw new Error(
        `A sibling unit already uses the slug "${unit.slug}" under ${parentId ?? 'the root'}.`,
      );
    }

    const stored: OrganizationUnitRecord = {
      ...unit,
      id,
      ...(parentId !== undefined ? { parentId } : {}),
      createdAt: new Date().toISOString(),
      status: unit.status || 'active',
    };
    if (parentId === undefined) delete stored.parentId;

    const next = [...units, stored];
    const placements = this.store.allPlacements();
    persistState(this.dataDir, { units: next, placements });
    this.store.replaceAll(next, placements);
    return stored;
  }

  /**
   * Update one existing unit's METADATA (name, kind, status, visibility,
   * exposeTo) by id, preserving id, slug, parentId, createdAt, and createdBy.
   * Any attempt to change slug or parentId is rejected — those are moves,
   * performed via reparentUnit. Persist durably and refresh the store.
   */
  updateUnit(unit: OrganizationUnitRecord): OrganizationUnitRecord {
    const units = this.store.allUnits();
    const idx = units.findIndex((u) => u.id === unit.id);
    if (idx < 0) {
      throw new Error(`Organization unit "${unit.id}" not found.`);
    }
    const existing = units[idx];
    if (unit.slug && unit.slug !== existing.slug) {
      throw new Error(
        `Organization unit slug cannot be changed here — a rename/move goes through reparentUnit (unit "${unit.id}").`,
      );
    }
    if (unit.parentId !== undefined && (unit.parentId || undefined) !== (existing.parentId || undefined)) {
      throw new Error(
        `Organization unit parentId cannot be changed here — a move goes through reparentUnit (unit "${unit.id}").`,
      );
    }

    const stored: OrganizationUnitRecord = {
      ...existing,
      name: unit.name || existing.name,
      kind: unit.kind || existing.kind,
      status: unit.status || existing.status,
      ...(unit.visibility !== undefined ? { visibility: unit.visibility } : {}),
      ...(unit.exposeTo !== undefined ? { exposeTo: unit.exposeTo } : {}),
    };

    const next = units.map((u, i) => (i === idx ? stored : u));
    const placements = this.store.allPlacements();
    persistState(this.dataDir, { units: next, placements });
    this.store.replaceAll(next, placements);
    return stored;
  }

  /**
   * Move a unit and its WHOLE subtree under a new parent (an empty newParentId
   * promotes it to a root): recompute every moved unit's qualified id from the
   * new parent path, reject a cycle (moving under itself or a descendant) or an
   * unresolved parent or an id collision outside the moving subtree, rewrite
   * every exposeTo[] reference to a moved id across ALL units AND every
   * placement's unitId (both collections persist together, so referential
   * integrity holds atomically), and return the old->new UnitIdRemap for every
   * moved unit so the caller rewrites EXTERNAL references (assignment scopes,
   * user home units, role-binding scopes).
   */
  reparentUnit(unitId: string, newParentId?: string): UnitIdRemap[] {
    const units = this.store.allUnits();
    const unit = units.find((u) => u.id === unitId);
    if (!unit) {
      throw new Error(`Organization unit "${unitId}" not found.`);
    }
    const parentId = newParentId || undefined;
    if (parentId !== undefined && !units.some((u) => u.id === parentId)) {
      throw new Error(`New parent "${parentId}" does not resolve to an existing unit.`);
    }

    const moving = subtreeIds(units, unitId);
    if (parentId !== undefined && moving.has(parentId)) {
      throw new Error(
        `Organization unit "${unitId}" cannot move under itself or one of its own descendants.`,
      );
    }

    // Recompute qualified ids parent-first across the moving subtree.
    const newIds = new Map<string, string>();
    newIds.set(unitId, qualifiedId(parentId, unit.slug));
    let grew = true;
    while (grew) {
      grew = false;
      for (const u of units) {
        if (
          moving.has(u.id) &&
          !newIds.has(u.id) &&
          u.parentId !== undefined &&
          newIds.has(u.parentId)
        ) {
          newIds.set(u.id, `${newIds.get(u.parentId)}.${u.slug}`);
          grew = true;
        }
      }
    }

    // Collision check: a recomputed id must not collide outside the moving
    // subtree (inside it, old ids vacate in the same atomic write).
    for (const [oldId, newId] of newIds) {
      if (newId !== oldId && units.some((v) => !moving.has(v.id) && v.id === newId)) {
        throw new Error(
          `Moving "${oldId}" would collide with the existing unit "${newId}" — resolve the slug clash first.`,
        );
      }
    }

    const nextUnits = units.map((u) => {
      let r = u;
      if (moving.has(u.id)) {
        r = { ...u, id: newIds.get(u.id)! };
        if (u.id === unitId) {
          if (parentId !== undefined) r.parentId = parentId;
          else delete r.parentId;
        } else {
          r.parentId = newIds.get(u.parentId!)!;
        }
      }
      // exposeTo references to a moved id follow the move — on every unit.
      if (r.exposeTo && r.exposeTo.some((e) => newIds.has(e))) {
        r = { ...r, exposeTo: r.exposeTo.map((e) => newIds.get(e) ?? e) };
      }
      return r;
    });

    const nextPlacements = this.store
      .allPlacements()
      .map((p) => (newIds.has(p.unitId) ? { ...p, unitId: newIds.get(p.unitId)! } : p));

    persistState(this.dataDir, { units: nextUnits, placements: nextPlacements });
    this.store.replaceAll(nextUnits, nextPlacements);

    return [...newIds.entries()]
      .filter(([oldId, newId]) => oldId !== newId)
      .map(([oldId, newId]) => ({ oldId, newId }));
  }

  /**
   * Delete one organization unit that has NO child units and NO project
   * placements (the orchestrator empties it first), stripping the deleted id
   * from every other unit's exposeTo[]. Deleting an absent unit is a no-op.
   */
  deleteUnit(unitId: string): void {
    const units = this.store.allUnits();
    if (!units.some((u) => u.id === unitId)) return; // no-op
    if (units.some((u) => u.parentId === unitId)) {
      throw new Error(`Organization unit "${unitId}" still has child units — empty it first.`);
    }
    const placements = this.store.allPlacements();
    if (placements.some((p) => p.unitId === unitId)) {
      throw new Error(`Organization unit "${unitId}" still has project placements — empty it first.`);
    }
    const next = units
      .filter((u) => u.id !== unitId)
      .map((u) =>
        u.exposeTo && u.exposeTo.includes(unitId)
          ? { ...u, exposeTo: u.exposeTo.filter((e) => e !== unitId) }
          : u,
      );
    persistState(this.dataDir, { units: next, placements });
    this.store.replaceAll(next, placements);
  }

  /**
   * Remove one project placement by id — the placed project itself is untouched.
   * Removing an absent placement is a no-op.
   */
  deletePlacement(placementId: string): void {
    const placements = this.store.allPlacements();
    const next = placements.filter((p) => p.id !== placementId);
    if (next.length === placements.length) return; // no-op
    const units = this.store.allUnits();
    persistState(this.dataDir, { units, placements: next });
    this.store.replaceAll(units, next);
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

/** Create one organization unit through the repository facade (atomic) — the
 *  registry computes the qualified dot-path id and rejects collisions. */
export function createUnit(dataDir: string, unit: OrganizationUnitRecord): OrganizationUnitRecord {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationRegistry(dataDir, store).createUnit(unit);
}

/** Update one organization unit's METADATA through the repository facade
 *  (atomic) — slug/parent changes are rejected there; use reparentUnit. */
export function updateUnit(dataDir: string, unit: OrganizationUnitRecord): OrganizationUnitRecord {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationRegistry(dataDir, store).updateUnit(unit);
}

/** Move a unit's subtree under a new parent through the repository facade
 *  (atomic), returning the old->new qualified-id remap for every moved unit. */
export function reparentUnit(
  dataDir: string,
  unitId: string,
  newParentId?: string,
): UnitIdRemap[] {
  const store = new OrganizationStore(dataDir);
  store.load();
  return new OrganizationRegistry(dataDir, store).reparentUnit(unitId, newParentId);
}

/** Delete one EMPTY organization unit through the repository facade. */
export function deleteUnit(dataDir: string, unitId: string): void {
  const store = new OrganizationStore(dataDir);
  store.load();
  new OrganizationRegistry(dataDir, store).deleteUnit(unitId);
}

/** Remove one project placement through the repository facade. */
export function deletePlacement(dataDir: string, placementId: string): void {
  const store = new OrganizationStore(dataDir);
  store.load();
  new OrganizationRegistry(dataDir, store).deletePlacement(placementId);
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
