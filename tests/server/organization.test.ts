import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  upsertOrganizationUnit,
  placeProject,
  listOrganizationUnits,
  listProjectPlacements,
  getOrganizationUnit,
} from '../../src/server/organization.js';
import type {
  OrganizationUnitRecord,
  ProjectPlacement,
  OrganizationState,
  PrincipalSubject,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Organization Repository (sdd_host) — the store/registry/index triad exercised
// through the repository facade against a real <dataDir>/organization.json, so
// id/createdAt stamping, parent/unit referential validation, unit-tree cycle
// rejection, hierarchy/membership listing, atomic write-temp-then-rename, and
// the missing/malformed-file storage semantics are covered end-to-end.
// ---------------------------------------------------------------------------

const CREATOR: PrincipalSubject = { userId: 'u-admin', kind: 'human', issuer: 'local' };

function mkUnit(over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord {
  return {
    id: '', // registry stamps a random id when absent
    name: 'Engineering',
    kind: 'department',
    status: '', // registry defaults to 'active' when empty
    createdAt: '1999-01-01T00:00:00.000Z', // placeholder; the registry stamps its own
    createdBy: CREATOR,
    ...over,
  };
}

function mkPlacement(over: Partial<ProjectPlacement> = {}): ProjectPlacement {
  return {
    id: '', // registry stamps a random id when absent
    projectId: 'p1',
    unitId: 'u1',
    role: 'owner',
    createdAt: '1999-01-01T00:00:00.000Z', // placeholder; the registry stamps its own
    createdBy: CREATOR,
    ...over,
  };
}

describe('organization repository (sdd_host)', () => {
  let dataDir: string;
  let orgPath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-org-'));
    orgPath = path.join(dataDir, 'organization.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Seed the store file directly with a controlled OrganizationState so tests
   *  can pin ids/createdAt. A subsequent facade call re-reads it. */
  function seed(state: OrganizationState): void {
    fs.writeFileSync(orgPath, JSON.stringify(state));
  }

  // ── upsertUnit: insert ──────────────────────────────────────────────────────

  it('upsertUnit inserts, stamping a random id and fresh createdAt, defaulting status to active, and persists', () => {
    const stored = upsertOrganizationUnit(dataDir, mkUnit({ name: 'Platform' }));

    expect(stored.id).toMatch(/[0-9a-f-]{36}/);
    expect(stored.id).not.toBe('');
    expect(stored.status).toBe('active'); // empty status defaulted
    expect(stored.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(stored.createdAt)).not.toBeNaN();
    expect(stored.name).toBe('Platform');

    // Re-read from disk proves durability.
    expect(getOrganizationUnit(dataDir, stored.id)).toEqual(stored);
    const raw = JSON.parse(fs.readFileSync(orgPath, 'utf8')) as OrganizationState;
    expect(raw.units).toHaveLength(1);
    expect(raw.placements).toEqual([]);
  });

  // ── upsertUnit: update round-trip ────────────────────────────────────────────

  it('upsertUnit updates an existing unit, preserving id and createdAt while changing other fields', () => {
    const created = upsertOrganizationUnit(dataDir, mkUnit({ name: 'Eng' }));

    const updated = upsertOrganizationUnit(
      dataDir,
      mkUnit({ id: created.id, name: 'Engineering & Platform', kind: 'division', status: 'archived' }),
    );

    expect(updated.id).toBe(created.id); // preserved
    expect(updated.createdAt).toBe(created.createdAt); // preserved
    expect(updated.name).toBe('Engineering & Platform');
    expect(updated.kind).toBe('division');
    expect(updated.status).toBe('archived'); // caller-supplied status honored

    // Still a single unit after the update.
    expect(listOrganizationUnits(dataDir)).toHaveLength(1);
    expect(getOrganizationUnit(dataDir, created.id)).toEqual(updated);
  });

  // ── upsertUnit: referential validation ───────────────────────────────────────

  it('upsertUnit rejects a unit whose parentId does not resolve to an existing unit, persisting nothing', () => {
    expect(() =>
      upsertOrganizationUnit(dataDir, mkUnit({ parentId: 'ghost-parent' })),
    ).toThrow(/does not resolve|existing unit/i);

    expect(fs.existsSync(orgPath)).toBe(false); // nothing persisted
  });

  it('upsertUnit accepts a unit whose parentId resolves to an existing unit', () => {
    const parent = upsertOrganizationUnit(dataDir, mkUnit({ name: 'Org', kind: 'organization' }));
    const child = upsertOrganizationUnit(
      dataDir,
      mkUnit({ name: 'Team A', kind: 'team', parentId: parent.id }),
    );

    expect(child.parentId).toBe(parent.id);
    expect(listOrganizationUnits(dataDir, parent.id).map((u) => u.id)).toEqual([child.id]);
  });

  // ── upsertUnit: cycle rejection ──────────────────────────────────────────────

  it('upsertUnit rejects a reparent that would make a unit its own ancestor (A -> B -> A)', () => {
    const a = upsertOrganizationUnit(dataDir, mkUnit({ name: 'A' }));
    const b = upsertOrganizationUnit(dataDir, mkUnit({ name: 'B', parentId: a.id }));

    // Reparent A under B: A -> B -> A is a cycle.
    expect(() =>
      upsertOrganizationUnit(dataDir, mkUnit({ id: a.id, name: 'A', parentId: b.id })),
    ).toThrow(/cycle|ancestor/i);

    // The rejected reparent left A a root (parentId unchanged).
    expect(getOrganizationUnit(dataDir, a.id)?.parentId).toBeUndefined();
  });

  // ── placeProject ─────────────────────────────────────────────────────────────

  it('placeProject stamps a random id and fresh createdAt inside an existing unit, and persists', () => {
    const unit = upsertOrganizationUnit(dataDir, mkUnit({ name: 'Org' }));

    const placed = placeProject(dataDir, mkPlacement({ projectId: 'proj-42', unitId: unit.id, role: 'shared' }));

    expect(placed.id).toMatch(/[0-9a-f-]{36}/);
    expect(placed.id).not.toBe('');
    expect(placed.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(placed.createdAt)).not.toBeNaN();
    expect(placed.projectId).toBe('proj-42');
    expect(placed.unitId).toBe(unit.id);
    expect(placed.role).toBe('shared');

    // Re-read from disk proves durability.
    expect(listProjectPlacements(dataDir).map((p) => p.id)).toEqual([placed.id]);
  });

  it('placeProject rejects a placement whose unitId does not resolve to an existing unit, persisting nothing', () => {
    expect(() =>
      placeProject(dataDir, mkPlacement({ unitId: 'ghost-unit' })),
    ).toThrow(/does not resolve|existing organization unit/i);

    expect(fs.existsSync(orgPath)).toBe(false); // nothing persisted
  });

  // ── listUnits: root / by-parent ──────────────────────────────────────────────

  it('listUnits returns all units unfiltered and only direct children when a parent is given', () => {
    seed({
      units: [
        mkUnit({ id: 'root', name: 'Org', kind: 'organization' }),
        mkUnit({ id: 'c1', name: 'Dept 1', parentId: 'root' }),
        mkUnit({ id: 'c2', name: 'Dept 2', parentId: 'root' }),
        mkUnit({ id: 'gc1', name: 'Team', parentId: 'c1' }), // grandchild
      ],
      placements: [],
    });

    // Unfiltered -> all units (roots included).
    expect(listOrganizationUnits(dataDir).map((u) => u.id).sort()).toEqual(['c1', 'c2', 'gc1', 'root']);
    // By parent -> direct children only (grandchild excluded).
    expect(listOrganizationUnits(dataDir, 'root').map((u) => u.id).sort()).toEqual(['c1', 'c2']);
    expect(listOrganizationUnits(dataDir, 'c1').map((u) => u.id)).toEqual(['gc1']);
    // A parent with no children yields an empty list, not an error.
    expect(listOrganizationUnits(dataDir, 'gc1')).toEqual([]);
  });

  // ── getUnit: hit / null ──────────────────────────────────────────────────────

  it('getUnit returns the record for a hit and null for a miss', () => {
    seed({ units: [mkUnit({ id: 'u-x', name: 'X' })], placements: [] });

    expect(getOrganizationUnit(dataDir, 'u-x')?.id).toBe('u-x');
    expect(getOrganizationUnit(dataDir, 'nope')).toBeNull();
  });

  // ── listPlacements: filters ──────────────────────────────────────────────────

  function seedForPlacements(): void {
    seed({
      units: [mkUnit({ id: 'u1' }), mkUnit({ id: 'u2' })],
      placements: [
        mkPlacement({ id: 'pl1', projectId: 'p1', unitId: 'u1' }),
        mkPlacement({ id: 'pl2', projectId: 'p1', unitId: 'u2' }),
        mkPlacement({ id: 'pl3', projectId: 'p2', unitId: 'u1' }),
      ],
    });
  }

  it('listPlacements returns all placements when unfiltered', () => {
    seedForPlacements();
    expect(listProjectPlacements(dataDir).map((p) => p.id).sort()).toEqual(['pl1', 'pl2', 'pl3']);
  });

  it('listPlacements filters by projectId', () => {
    seedForPlacements();
    expect(listProjectPlacements(dataDir, 'p1').map((p) => p.id).sort()).toEqual(['pl1', 'pl2']);
  });

  it('listPlacements filters by unitId', () => {
    seedForPlacements();
    expect(listProjectPlacements(dataDir, undefined, 'u1').map((p) => p.id).sort()).toEqual(['pl1', 'pl3']);
  });

  it('listPlacements combines projectId and unitId filters', () => {
    seedForPlacements();
    expect(listProjectPlacements(dataDir, 'p1', 'u1').map((p) => p.id)).toEqual(['pl1']);
  });

  // ── store integrity ──────────────────────────────────────────────────────────

  it('a missing store file reads as empty collections', () => {
    expect(listOrganizationUnits(dataDir)).toEqual([]);
    expect(listProjectPlacements(dataDir)).toEqual([]);
    expect(getOrganizationUnit(dataDir, 'anything')).toBeNull();
  });

  it('malformed store JSON fails with a storage error naming the path', () => {
    fs.writeFileSync(orgPath, '{ this is not valid json');
    expect(() => listOrganizationUnits(dataDir)).toThrow(orgPath);
    expect(() => listOrganizationUnits(dataDir)).toThrow(/malformed/i);
  });

  it('a structurally invalid store (not an object with unit/placement arrays) fails naming the path', () => {
    fs.writeFileSync(orgPath, JSON.stringify({ units: 'not-an-array' }));
    expect(() => getOrganizationUnit(dataDir, 'x')).toThrow(orgPath);
    expect(() => listProjectPlacements(dataDir)).toThrow(/malformed/i);
  });
});
