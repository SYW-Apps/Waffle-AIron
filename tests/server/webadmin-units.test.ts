import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as webadmin from '../../src/server/webadmin.js';
import { ForbiddenError } from '../../src/server/identity.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { createWebSession } from '../../src/server/websessions.js';
import {
  createUnit,
  getOrganizationUnit,
  listOrganizationUnits,
  listProjectPlacements,
  placeProject,
} from '../../src/server/organization.js';
import { listAssignments } from '../../src/server/permissions.js';
import { upsertUser, getUserById } from '../../src/server/users.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { allow, subjectOf } from './helpers.js';
import type { HostConfig, OrganizationUnitRecord, ProjectPlacement, UnitDisposition } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// web_admin_orchestrator.removeUnit (sdd_host): unit disposal is never a silent
// cascade — the caller picks a UnitDisposition, and every non-cascade choice is
// an explicit MOVE that rewrites the moved subtree's qualified ids and every
// reference to them (placements, exposeTo, assignment scopes, user home units,
// role-binding scopes) before the emptied unit is deleted. Cascade deletes the
// subtree AND removes assignments scoped into it (no resurrection at a reused
// path) and clears user references into it.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

describe('web admin removeUnit dispositions (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const FUTURE = (): string => new Date(Date.now() + 3_600_000).toISOString();

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rmunit-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  function adminSession(): string {
    const inst = ensureInstanceIdentity(dataDir);
    return createWebSession(dataDir, {
      id: '',
      subject: { userId: inst.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;
  }

  const unitRec = (slug: string, parentId?: string, over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord => ({
    id: '',
    name: slug,
    slug,
    kind: 'team',
    status: 'active',
    createdAt: '',
    createdBy: subjectOf('seeder'),
    ...(parentId !== undefined ? { parentId } : {}),
    ...over,
  });
  const placementRec = (projectId: string, unitId: string): ProjectPlacement => ({
    id: `${projectId}@${unitId}`,
    projectId,
    unitId,
    role: 'owner',
    createdAt: '',
    createdBy: subjectOf('seeder'),
  });

  /** acme(root) → it → dev ; beta(root, exposes to acme.it). Placements p-it@acme.it,
   *  p-dev@acme.it.dev. Assignment: u-1 project:read @unit acme.it.dev. User u-h
   *  homed in acme.it.dev with a role binding scoped to acme.it. */
  function seedWorld(): void {
    createUnit(dataDir, unitRec('acme'));
    createUnit(dataDir, unitRec('it', 'acme'));
    createUnit(dataDir, unitRec('dev', 'acme.it'));
    createUnit(dataDir, unitRec('beta', undefined, { exposeTo: ['acme.it'] }));
    placeProject(dataDir, placementRec('p-it', 'acme.it'));
    placeProject(dataDir, placementRec('p-dev', 'acme.it.dev'));
    allow(dataDir, 'u-1', 'project:read', 'unit', 'acme.it.dev');
    upsertUser(dataDir, {
      id: 'u-h',
      subject: subjectOf('u-h'),
      status: 'active',
      createdAt: '',
      unitId: 'acme.it.dev',
      roleBindings: [{ roleId: 'reader', scopeKind: 'unit', scopeId: 'acme.it' }],
    });
  }

  it("migrate: children reparent under the target, placements/assignments/users follow the remap, the emptied unit dies", () => {
    seedWorld();
    webadmin.removeUnit(cfg, adminSession(), 'acme.it', { kind: 'migrate', targetUnitId: 'beta' });

    // The removed unit is gone; its child subtree lives under the target now.
    expect(getOrganizationUnit(dataDir, 'acme.it')).toBeNull();
    expect(getOrganizationUnit(dataDir, 'beta.dev')?.parentId).toBe('beta');

    // Placements: the removed unit's own placement re-pointed to the DESTINATION;
    // the child's placement followed its moved unit.
    expect(listProjectPlacements(dataDir, 'p-it').map((p) => p.unitId)).toEqual(['beta']);
    expect(listProjectPlacements(dataDir, 'p-dev').map((p) => p.unitId)).toEqual(['beta.dev']);

    // The assignment scoped at the moved descendant followed the remap — a `no`
    // that vanished here would be an escalation.
    expect(listAssignments(dataDir, undefined, 'user', 'u-1').map((a) => a.scopeId)).toEqual(['beta.dev']);

    // The user's home unit followed the move; the binding at the REMOVED unit
    // re-anchored on the destination.
    const user = getUserById(dataDir, 'u-h')!;
    expect(user.unitId).toBe('beta.dev');
    expect(user.roleBindings).toEqual([{ roleId: 'reader', scopeKind: 'unit', scopeId: 'beta' }]);

    // Audited at security level.
    const ev = queryAuditEvents(dataDir, { action: 'org.unit.remove' });
    expect(ev).toHaveLength(1);
    expect(ev[0].level).toBe('security');
  });

  it('absorb: content moves to the parent; absorbing a ROOT is refused (no parent destination)', () => {
    seedWorld();
    webadmin.removeUnit(cfg, adminSession(), 'acme.it', { kind: 'absorb' });

    expect(getOrganizationUnit(dataDir, 'acme.it')).toBeNull();
    expect(getOrganizationUnit(dataDir, 'acme.dev')?.parentId).toBe('acme');
    expect(listProjectPlacements(dataDir, 'p-it').map((p) => p.unitId)).toEqual(['acme']);
    expect(listProjectPlacements(dataDir, 'p-dev').map((p) => p.unitId)).toEqual(['acme.dev']);

    expect(() => webadmin.removeUnit(cfg, adminSession(), 'beta', { kind: 'absorb' })).toThrow(/root unit/i);
  });

  it("alternative: a replacement sibling is created (posture copied) and content moves in — how a rename is expressed", () => {
    seedWorld();
    // Give the removed unit a posture so the copy is observable.
    webadmin.removeUnit(cfg, adminSession(), 'acme.it', { kind: 'alternative', newSlug: 'tech', newName: 'Tech' });

    expect(getOrganizationUnit(dataDir, 'acme.it')).toBeNull();
    const replacement = getOrganizationUnit(dataDir, 'acme.tech')!;
    expect(replacement.name).toBe('Tech');
    expect(replacement.parentId).toBe('acme');
    expect(getOrganizationUnit(dataDir, 'acme.tech.dev')?.parentId).toBe('acme.tech');
    expect(listProjectPlacements(dataDir, 'p-it').map((p) => p.unitId)).toEqual(['acme.tech']);
    expect(listProjectPlacements(dataDir, 'p-dev').map((p) => p.unitId)).toEqual(['acme.tech.dev']);

    // The missing newSlug is rejected before anything moves.
    expect(() => webadmin.removeUnit(cfg, adminSession(), 'beta', { kind: 'alternative' })).toThrow(/newSlug/);
  });

  it('cascade: the whole subtree, its placements, its scoped assignments, and user references are removed', () => {
    seedWorld();
    webadmin.removeUnit(cfg, adminSession(), 'acme.it', { kind: 'cascade' });

    // Subtree gone; the untouched siblings remain.
    expect(getOrganizationUnit(dataDir, 'acme.it')).toBeNull();
    expect(getOrganizationUnit(dataDir, 'acme.it.dev')).toBeNull();
    expect(listOrganizationUnits(dataDir).map((u) => u.id).sort()).toEqual(['acme', 'beta']);

    // Placements in the subtree were deleted (the project records are untouched).
    expect(listProjectPlacements(dataDir, 'p-it')).toEqual([]);
    expect(listProjectPlacements(dataDir, 'p-dev')).toEqual([]);

    // Assignments scoped into the subtree are REMOVED — never left to resurrect
    // if a unit is later recreated at the same qualified path.
    expect(listAssignments(dataDir, undefined, 'user', 'u-1')).toEqual([]);

    // The user's home unit and the binding scoped into the subtree are cleared.
    const user = getUserById(dataDir, 'u-h')!;
    expect(user.unitId).toBeUndefined();
    expect(user.roleBindings).toEqual([]);

    // beta's exposeTo entry for the deleted unit was stripped by deleteUnit.
    expect(getOrganizationUnit(dataDir, 'beta')?.exposeTo).toEqual([]);
  });

  it('rejects an unknown unit, an invalid migrate target, and a non-instance-admin session', () => {
    seedWorld();
    expect(() => webadmin.removeUnit(cfg, adminSession(), 'ghost', { kind: 'cascade' })).toThrow(/unknown/i);

    // Migrate target validation: absent, the unit itself, inside the removed
    // subtree, or nonexistent — all refused before anything moves.
    for (const targetUnitId of [undefined, 'acme.it', 'acme.it.dev', 'ghost']) {
      const disposition = { kind: 'migrate', ...(targetUnitId ? { targetUnitId } : {}) } as UnitDisposition;
      expect(() => webadmin.removeUnit(cfg, adminSession(), 'acme.it', disposition)).toThrow(/migrate target/i);
    }
    expect(getOrganizationUnit(dataDir, 'acme.it')).not.toBeNull();

    // A signed-in NON-admin (delegated unit admin included) is refused: unit
    // disposal rewrites instance-wide references.
    allow(dataDir, 'unit-admin', 'project:admin', 'unit', 'acme.it');
    const nonAdmin = createWebSession(dataDir, {
      id: '',
      subject: { userId: 'unit-admin', kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: FUTURE(),
    }).id;
    expect(() => webadmin.removeUnit(cfg, nonAdmin, 'acme.it', { kind: 'cascade' })).toThrow(ForbiddenError);
  });
});
