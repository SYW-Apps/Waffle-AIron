import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migratePermissionModel } from '../../src/server/migration.js';
import { getInstanceIdentity } from '../../src/server/instance.js';
import { authenticate, LEGACY_SUPERADMIN_USER_ID } from '../../src/server/auth.js';
import { authorize } from '../../src/server/authorization.js';
import { listAssignments } from '../../src/server/permissions.js';
import { createUnit, getOrganizationUnit, listProjectPlacements, placeProject } from '../../src/server/organization.js';
import { getUserById } from '../../src/server/users.js';
import { getWebSessionById } from '../../src/server/websessions.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { hashToken } from '../../src/server/credentials.js';

// ---------------------------------------------------------------------------
// Permission-model rollout migration (`wairon host doctor --fix`, sdd_host).
//
// A data dir written by a PRE-permission-model wairon is seeded RAW (grants on
// users/sessions/keys, ownerless master-minted keys, slug-less flat-id units,
// unplaced projects, 'builtin:*' literals) and migrated. The headline pins:
// a legacy editor key that would resolve to ZERO permissions afterwards
// actually WORKS again (owner synthesized + authority translated), and the
// migration is a no-op the second time (idempotent) and a pure report without
// --fix (dry run).
// ---------------------------------------------------------------------------

describe('permission-model migration (sdd_host)', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-migrate-'));
    process.env.WAIRON_DATA_DIR = dataDir;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  const write = (rel: string, value: unknown): void => {
    const p = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(value));
  };

  const LEGACY_TOKEN = 'wk_legacy_editor_token';

  /** A data dir exactly as a pre-permission-model wairon left it. */
  function seedLegacyWorld(): void {
    // Units: flat ids, no slugs; a child referencing the flat parent id; an
    // exposeTo pointing at a flat id.
    write('organization.json', {
      units: [
        { id: 'acme-root', name: 'Acme Corp', kind: 'business_entity', status: 'active', createdAt: '2025-01-01', createdBy: { userId: 'op', kind: 'human', issuer: 'local' } },
        { id: 'eng', name: 'Engineering', kind: 'team', parentId: 'acme-root', status: 'active', createdAt: '2025-01-01', createdBy: { userId: 'op', kind: 'human', issuer: 'local' } },
        { id: 'beta', name: 'Beta Inc', kind: 'business_entity', status: 'active', createdAt: '2025-01-01', createdBy: { userId: 'op', kind: 'human', issuer: 'local' }, exposeTo: ['eng'] },
      ],
      placements: [
        { id: 'pl-1', projectId: 'proj-a', unitId: 'eng', role: 'owner', createdAt: '2025-01-01', createdBy: { userId: 'op', kind: 'human', issuer: 'local' } },
      ],
    });
    // A user with stored grants (the legacy authority shape) homed in a flat unit id.
    write('users.json', [
      {
        id: 'u-ada',
        subject: { userId: 'ada', kind: 'human', issuer: 'sso' },
        status: 'active',
        createdAt: '2025-01-01',
        unitId: 'eng',
        grants: [{ projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'] }],
      },
    ]);
    // Keys: an OWNERLESS legacy master-minted editor key (grants stored), and a
    // key owned by the retired builtin literal.
    write('auth/credentials.json', [
      {
        id: 'k-legacy',
        keyHash: hashToken(LEGACY_TOKEN),
        role: 'editor',
        grants: [{ projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'] }],
        createdAt: '2025-01-01',
      },
      {
        id: 'k-builtin',
        keyHash: hashToken('wk_builtin_owned'),
        projects: ['*'],
        ownerSubject: { userId: LEGACY_SUPERADMIN_USER_ID, kind: 'human', issuer: 'local' },
        createdAt: '2025-01-01',
      },
    ]);
    // Sessions: one carrying grants, one belonging to the retired literal.
    write('web-sessions.json', [
      {
        id: 'ws_legacy',
        subject: { userId: 'ada', kind: 'human', issuer: 'sso' },
        grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }],
        createdAt: '2025-01-01',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      {
        id: 'ws_builtin',
        subject: { userId: LEGACY_SUPERADMIN_USER_ID, kind: 'human', issuer: 'local' },
        projects: ['*'],
        createdAt: '2025-01-01',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ]);
    // Projects: proj-a is placed (above); proj-orphan is placed NOWHERE.
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-orphan');
  }

  it('dry run: reports every finding and rewrites NOTHING', () => {
    seedLegacyWorld();
    const report = migratePermissionModel(dataDir, false);

    expect(report.applied).toBe(false);
    const areas = new Set(report.findings.map((f) => f.area));
    expect(areas).toEqual(new Set(['instance', 'units', 'users', 'keys', 'sessions', 'projects']));

    // Nothing changed on disk.
    expect(getInstanceIdentity(dataDir)).toBeNull();
    expect(getOrganizationUnit(dataDir, 'eng')).not.toBeNull();
    expect(listAssignments(dataDir)).toEqual([]);
    expect(getWebSessionById(dataDir, 'ws_builtin')).not.toBeNull();
    expect(listProjectPlacements(dataDir, 'proj-orphan')).toEqual([]);
  });

  it('apply: the headline defect closes — a legacy ownerless editor key WORKS again after migration', () => {
    seedLegacyWorld();

    // Before: the key authenticates but resolves ZERO permissions (no owner).
    const before = authenticate(dataDir, LEGACY_TOKEN);
    expect(before.authenticated).toBe(true);
    expect(authorize(dataDir, before, 'project:read', 'project', 'proj-a').value).toBe('no');

    migratePermissionModel(dataDir, true);

    // After: a synthesized service owner carries the key's legacy authority live.
    const after = authenticate(dataDir, LEGACY_TOKEN);
    expect(after.authenticated).toBe(true);
    expect(after.subject?.userId).toBe('svc-key-k-legacy');
    expect(authorize(dataDir, after, 'project:read', 'project', 'proj-a').value).toBe('yes');
    expect(authorize(dataDir, after, 'project:write', 'project', 'proj-a').value).toBe('yes');
    // The legacy grant never conferred admin — and still doesn't.
    expect(authorize(dataDir, after, 'project:admin', 'project', 'proj-a').value).toBe('no');
  });

  it('apply: units get slugs + qualified ids and EVERY reference follows (placements, exposeTo, assignments, user home units)', () => {
    seedLegacyWorld();
    migratePermissionModel(dataDir, true);

    // Qualified dot-path ids computed from the parent chain + slugified names.
    expect(getOrganizationUnit(dataDir, 'acme-root')?.slug).toBe('acme-root'); // flat id kept: it IS its slug already
    const eng = getOrganizationUnit(dataDir, 'acme-root.eng');
    expect(eng).not.toBeNull();
    expect(eng?.slug).toBe('eng');
    expect(getOrganizationUnit(dataDir, 'eng')).toBeNull(); // the flat id vacated

    // The placement and the exposeTo reference moved with the rename.
    expect(listProjectPlacements(dataDir, 'proj-a').map((p) => p.unitId)).toEqual(['acme-root.eng']);
    expect(getOrganizationUnit(dataDir, 'beta')?.exposeTo).toEqual(['acme-root.eng']);

    // The user's home unit followed, and the stored grants became assignments
    // for the user's SUBJECT id (grants field gone).
    const ada = getUserById(dataDir, 'u-ada')!;
    expect(ada.unitId).toBe('acme-root.eng');
    expect((ada as { grants?: unknown }).grants).toBeUndefined();
    const adaAssignments = listAssignments(dataDir, undefined, 'user', 'ada');
    expect(new Set(adaAssignments.map((a) => a.capability))).toEqual(new Set(['project:read', 'project:write']));
    expect(adaAssignments.every((a) => a.scopeKind === 'project' && a.scopeId === 'proj-a')).toBe(true);
  });

  it('apply: builtin-literal sessions/keys are dropped/revoked, the identity is seeded, and orphan projects land in `unassigned`', () => {
    seedLegacyWorld();
    migratePermissionModel(dataDir, true);

    // The boot-reserved UUIDs exist now.
    expect(getInstanceIdentity(dataDir)).not.toBeNull();

    // The retired literal's session is gone; the grants session survives with a
    // projects narrowing instead.
    expect(getWebSessionById(dataDir, 'ws_builtin')).toBeNull();
    const legacySession = getWebSessionById(dataDir, 'ws_legacy')!;
    expect(legacySession.projects).toEqual(['proj-a']);
    expect((legacySession as { grants?: unknown }).grants).toBeUndefined();

    // The builtin-owned key no longer authenticates (revoked, not deleted).
    expect(authenticate(dataDir, 'wk_builtin_owned').authenticated).toBe(false);

    // The unplaced project was placed into the synthesized root unit.
    expect(getOrganizationUnit(dataDir, 'unassigned')).not.toBeNull();
    expect(listProjectPlacements(dataDir, 'proj-orphan').map((p) => p.unitId)).toEqual(['unassigned']);
  });

  it('apply: duplicate owner placements collapse to the NEWEST one', () => {
    const system = { userId: 'seed', kind: 'service', issuer: 'local' };
    createUnit(dataDir, { id: '', name: 'Alpha', slug: 'alpha', kind: 'business_entity', status: 'active', createdAt: '', createdBy: system });
    createUnit(dataDir, { id: '', name: 'Beta', slug: 'beta', kind: 'business_entity', status: 'active', createdAt: '', createdBy: system });
    createProjectRecord(dataDir, 'proj-dup');
    // Two owner rows, the shape the pre-move-semantics web re-place produced.
    placeProject(dataDir, { id: '', projectId: 'proj-dup', unitId: 'alpha', role: 'owner', createdAt: '2026-01-01T00:00:00.000Z', createdBy: system });
    placeProject(dataDir, { id: 'dup-newer', projectId: 'proj-dup', unitId: 'beta', role: 'owner', createdAt: '', createdBy: system });

    const dry = migratePermissionModel(dataDir, false);
    expect(dry.findings.some((f) => f.area === 'placements' && f.detail.includes('proj-dup'))).toBe(true);
    // Dry run touches nothing.
    expect(listProjectPlacements(dataDir, 'proj-dup')).toHaveLength(2);

    migratePermissionModel(dataDir, true);
    const rows = listProjectPlacements(dataDir, 'proj-dup');
    expect(rows).toHaveLength(1);
    expect(rows[0].unitId).toBe('beta'); // the newest placement intent wins
  });

  it('idempotent: a second apply finds nothing left to do', () => {
    seedLegacyWorld();
    migratePermissionModel(dataDir, true);
    const second = migratePermissionModel(dataDir, true);
    expect(second.findings).toEqual([]);
  });

  it('an already-current data dir reports nothing (fresh instances are untouched)', () => {
    // A minimal CURRENT-shape world: seeded identity, slugged unit, placed project.
    migratePermissionModel(dataDir, true); // seeds identity on an empty dir
    const report = migratePermissionModel(dataDir, false);
    expect(report.findings).toEqual([]);
  });
});
