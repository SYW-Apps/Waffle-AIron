import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createUnit,
  updateUnit,
  reparentUnit,
  deleteUnit,
  placeProject,
  deletePlacement,
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
// through the repository facade against a real <dataDir>/organization.json.
//
// The unit lifecycle is qualified-id based: createUnit computes the id from the
// parent path plus slug (a root's id IS its slug) and rejects collisions;
// updateUnit is metadata-only (slug/parent changes are MOVES via reparentUnit);
// reparentUnit renames a whole subtree, follows exposeTo references and
// placements, and returns the old->new id remap for external references;
// deleteUnit removes one EMPTIED unit. Storage semantics (atomic
// write-temp-then-rename, missing/malformed-file behavior) are pinned too.
// ---------------------------------------------------------------------------

const CREATOR: PrincipalSubject = { userId: 'u-admin', kind: 'human', issuer: 'local' };

function mkUnit(over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord {
  return {
    id: '', // the registry computes the qualified id from parent + slug
    name: 'Engineering',
    slug: 'eng',
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

  // ── createUnit: qualified-id computation ─────────────────────────────────────

  it('createUnit computes the qualified id (a root id IS its slug), stamps createdAt, defaults status, persists', () => {
    const root = createUnit(dataDir, mkUnit({ name: 'Platform', slug: 'platform' }));
    expect(root.id).toBe('platform'); // any incoming id is ignored
    expect(root.status).toBe('active'); // empty status defaulted
    expect(root.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(root.createdAt)).not.toBeNaN();

    const child = createUnit(dataDir, mkUnit({ name: 'Team A', slug: 'team-a', parentId: 'platform' }));
    expect(child.id).toBe('platform.team-a');
    const grandchild = createUnit(dataDir, mkUnit({ name: 'Web', slug: 'web', parentId: child.id }));
    expect(grandchild.id).toBe('platform.team-a.web');

    // Re-read from disk proves durability.
    expect(getOrganizationUnit(dataDir, 'platform.team-a')).toEqual(child);
    const raw = JSON.parse(fs.readFileSync(orgPath, 'utf8')) as OrganizationState;
    expect(raw.units).toHaveLength(3);
    expect(raw.placements).toEqual([]);
  });

  it('createUnit rejects an invalid slug (uppercase, dots, empty) — the slug is the id segment', () => {
    for (const slug of ['', 'Has.Dot', 'UPPER', 'spa ce']) {
      expect(() => createUnit(dataDir, mkUnit({ slug }))).toThrow(/slug/i);
    }
    expect(fs.existsSync(orgPath)).toBe(false); // nothing persisted
  });

  it('createUnit rejects a unit whose parentId does not resolve, persisting nothing', () => {
    expect(() => createUnit(dataDir, mkUnit({ parentId: 'ghost-parent' }))).toThrow(
      /does not resolve|existing unit/i,
    );
    expect(fs.existsSync(orgPath)).toBe(false);
  });

  it('createUnit rejects a qualified-id/sibling-slug collision — never a silent overwrite; the slug reuses freely across parents', () => {
    createUnit(dataDir, mkUnit({ slug: 'acme' }));
    createUnit(dataDir, mkUnit({ slug: 'it', parentId: 'acme' }));

    // The same slug under the same parent collides…
    expect(() => createUnit(dataDir, mkUnit({ slug: 'it', parentId: 'acme' }))).toThrow(/already exists/i);
    expect(() => createUnit(dataDir, mkUnit({ slug: 'acme' }))).toThrow(/already exists/i);

    // …but reuses freely under a DIFFERENT parent: company_a.it and company_b.it coexist.
    createUnit(dataDir, mkUnit({ slug: 'beta' }));
    expect(createUnit(dataDir, mkUnit({ slug: 'it', parentId: 'beta' })).id).toBe('beta.it');
  });

  // ── updateUnit: metadata only ────────────────────────────────────────────────

  it('updateUnit changes metadata (name/kind/status/visibility/exposeTo) preserving id, slug, parentId, createdAt, createdBy', () => {
    const created = createUnit(dataDir, mkUnit({ name: 'Eng', slug: 'eng' }));

    const updated = updateUnit(dataDir, {
      ...created,
      name: 'Engineering & Platform',
      kind: 'division',
      status: 'archived',
      visibility: 'closed',
      exposeTo: ['somewhere'],
    });

    expect(updated.id).toBe(created.id);
    expect(updated.slug).toBe('eng');
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.createdBy).toEqual(created.createdBy);
    expect(updated.name).toBe('Engineering & Platform');
    expect(updated.kind).toBe('division');
    expect(updated.status).toBe('archived');
    expect(updated.visibility).toBe('closed');
    expect(updated.exposeTo).toEqual(['somewhere']);

    // Still a single unit after the update.
    expect(listOrganizationUnits(dataDir)).toHaveLength(1);
    expect(getOrganizationUnit(dataDir, created.id)).toEqual(updated);
  });

  it('updateUnit rejects an unknown id, and any slug or parentId change (those are MOVES via reparentUnit)', () => {
    createUnit(dataDir, mkUnit({ slug: 'a' }));
    createUnit(dataDir, mkUnit({ slug: 'b' }));

    expect(() => updateUnit(dataDir, mkUnit({ id: 'ghost', slug: 'ghost' }))).toThrow(/not found/i);
    expect(() => updateUnit(dataDir, { ...getOrganizationUnit(dataDir, 'a')!, slug: 'renamed' })).toThrow(
      /reparentUnit/,
    );
    expect(() => updateUnit(dataDir, { ...getOrganizationUnit(dataDir, 'a')!, parentId: 'b' })).toThrow(
      /reparentUnit/,
    );
  });

  // ── reparentUnit: subtree move + remap ───────────────────────────────────────

  /** acme(root) → it → dev ; beta(root). A placement sits in acme.it.dev, and
   *  beta exposes its subtree to acme.it. */
  function seedMoveWorld(): void {
    createUnit(dataDir, mkUnit({ slug: 'acme' }));
    createUnit(dataDir, mkUnit({ slug: 'it', parentId: 'acme' }));
    createUnit(dataDir, mkUnit({ slug: 'dev', parentId: 'acme.it' }));
    createUnit(dataDir, mkUnit({ slug: 'beta', exposeTo: ['acme.it'] }));
    placeProject(dataDir, mkPlacement({ id: 'pl-dev', projectId: 'p-dev', unitId: 'acme.it.dev' }));
  }

  it('reparentUnit moves the whole subtree, recomputes qualified ids, follows exposeTo + placements, and returns the remap', () => {
    seedMoveWorld();

    const remap = reparentUnit(dataDir, 'acme.it', 'beta');

    // Old->new for the moved unit AND every descendant.
    expect(remap).toEqual(
      expect.arrayContaining([
        { oldId: 'acme.it', newId: 'beta.it' },
        { oldId: 'acme.it.dev', newId: 'beta.it.dev' },
      ]),
    );
    expect(remap).toHaveLength(2);

    // The tree reflects the move; the old ids are gone.
    expect(getOrganizationUnit(dataDir, 'acme.it')).toBeNull();
    expect(getOrganizationUnit(dataDir, 'beta.it')?.parentId).toBe('beta');
    expect(getOrganizationUnit(dataDir, 'beta.it.dev')?.parentId).toBe('beta.it');

    // The exposeTo reference followed the move…
    expect(getOrganizationUnit(dataDir, 'beta')?.exposeTo).toEqual(['beta.it']);
    // …and so did the placement (both collections persist together).
    expect(listProjectPlacements(dataDir, 'p-dev').map((p) => p.unitId)).toEqual(['beta.it.dev']);
  });

  it('reparentUnit with an empty newParentId promotes the subtree to a root', () => {
    seedMoveWorld();
    const remap = reparentUnit(dataDir, 'acme.it');
    expect(remap).toEqual(
      expect.arrayContaining([
        { oldId: 'acme.it', newId: 'it' },
        { oldId: 'acme.it.dev', newId: 'it.dev' },
      ]),
    );
    const promoted = getOrganizationUnit(dataDir, 'it')!;
    expect(promoted.parentId).toBeUndefined();
  });

  it('reparentUnit rejects an unknown unit, an unresolved parent, a cycle, and an outside-id collision', () => {
    seedMoveWorld();

    expect(() => reparentUnit(dataDir, 'ghost', 'beta')).toThrow(/not found/i);
    expect(() => reparentUnit(dataDir, 'acme.it', 'ghost')).toThrow(/does not resolve/i);
    // Moving under itself or its own descendant is a cycle.
    expect(() => reparentUnit(dataDir, 'acme.it', 'acme.it')).toThrow(/itself|descendant/i);
    expect(() => reparentUnit(dataDir, 'acme.it', 'acme.it.dev')).toThrow(/itself|descendant/i);

    // A collision outside the moving subtree rejects the whole move.
    createUnit(dataDir, mkUnit({ slug: 'it', parentId: 'beta' })); // beta.it already exists
    expect(() => reparentUnit(dataDir, 'acme.it', 'beta')).toThrow(/collide/i);
    // Nothing moved.
    expect(getOrganizationUnit(dataDir, 'acme.it')).not.toBeNull();
  });

  // ── deleteUnit / deletePlacement ─────────────────────────────────────────────

  it('deleteUnit removes one EMPTY unit and strips it from other units\' exposeTo; occupied units are refused', () => {
    seedMoveWorld();

    // Occupied: child units / placements refuse the delete.
    expect(() => deleteUnit(dataDir, 'acme.it')).toThrow(/child units/i);
    expect(() => deleteUnit(dataDir, 'acme.it.dev')).toThrow(/placements/i);

    // Empty it first, then delete bottom-up.
    deletePlacement(dataDir, 'pl-dev');
    deleteUnit(dataDir, 'acme.it.dev');
    deleteUnit(dataDir, 'acme.it');
    expect(getOrganizationUnit(dataDir, 'acme.it')).toBeNull();
    // beta's exposeTo entry for the deleted unit was stripped.
    expect(getOrganizationUnit(dataDir, 'beta')?.exposeTo).toEqual([]);

    // Deleting an absent unit is a no-op, never an error.
    expect(() => deleteUnit(dataDir, 'acme.it')).not.toThrow();
  });

  it('deletePlacement removes one placement (the project record untouched); absent id is a no-op', () => {
    createUnit(dataDir, mkUnit({ slug: 'u1' }));
    const placed = placeProject(dataDir, mkPlacement({ unitId: 'u1' }));
    deletePlacement(dataDir, placed.id);
    expect(listProjectPlacements(dataDir)).toEqual([]);
    expect(() => deletePlacement(dataDir, 'ghost')).not.toThrow();
  });

  // ── placeProject ─────────────────────────────────────────────────────────────

  it('placeProject stamps a random id and fresh createdAt inside an existing unit, and persists', () => {
    const unit = createUnit(dataDir, mkUnit({ name: 'Org', slug: 'org' }));

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
        mkUnit({ id: 'root', slug: 'root', name: 'Org', kind: 'organization' }),
        mkUnit({ id: 'c1', slug: 'c1', name: 'Dept 1', parentId: 'root' }),
        mkUnit({ id: 'c2', slug: 'c2', name: 'Dept 2', parentId: 'root' }),
        mkUnit({ id: 'gc1', slug: 'gc1', name: 'Team', parentId: 'c1' }), // grandchild
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
    seed({ units: [mkUnit({ id: 'u-x', slug: 'u-x', name: 'X' })], placements: [] });

    expect(getOrganizationUnit(dataDir, 'u-x')?.id).toBe('u-x');
    expect(getOrganizationUnit(dataDir, 'nope')).toBeNull();
  });

  // ── listPlacements: filters ──────────────────────────────────────────────────

  function seedForPlacements(): void {
    seed({
      units: [mkUnit({ id: 'u1', slug: 'u1' }), mkUnit({ id: 'u2', slug: 'u2' })],
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
