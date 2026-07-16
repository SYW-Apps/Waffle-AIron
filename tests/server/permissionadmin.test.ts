import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRole,
  updateRole,
  deleteRole,
  listRoles,
  setAssignment,
  removeAssignment,
  listAssignments,
  bindRole,
  unbindRole,
} from '../../src/server/permissionadmin.js';
import { ForbiddenError, UnauthenticatedError } from '../../src/server/errors.js';
import { SSO_ADMIN_ROLE_ID } from '../../src/server/roles.js';
import { authenticate } from '../../src/server/auth.js';
import { authorize } from '../../src/server/authorization.js';
import { upsertUser, getUserById } from '../../src/server/users.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { placeProject } from '../../src/server/organization.js';
import { allow, mintUserToken, seedUnit, subjectOf } from './helpers.js';
import type { HostConfig, Role } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Permission Admin Orchestrator (sdd_host): roles, the assignment grid, and
// user role bindings.
//
// Every method authenticates and authorizes through the resolver — role
// management needs INSTANCE-level project:admin (a delegated instance-wide
// admin qualifies; roles are instance-level templates), assignment/binding
// management needs project:admin over the TARGET scope. Two hard reservations
// are pinned: built-in role ids are intrinsic (CRUD refuses them BEFORE
// anything else), and the '*'@instance marker can never enter the grid — the
// instance-admin bypass stays env-anchored, never assignment-conferred.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

describe('permission admin orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-permadmin-'));
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

  const role = (id: string, over: Partial<Role> = {}): Role => ({
    id,
    name: id,
    permissions: [{ capability: 'project:read', value: 'yes' }],
    createdAt: '',
    ...over,
  });

  // ── roles ───────────────────────────────────────────────────────────────────

  describe('role management (instance-level templates)', () => {
    it('the master credential creates, lists, updates, and deletes a role', () => {
      const stored = createRole(cfg, MASTER, role('intern'));
      expect(stored.id).toBe('intern');
      expect(stored.createdAt).toBeTruthy();
      expect(stored.createdBy?.userId).toBe('bootstrap'); // the master credential's subject
      expect(listRoles(cfg, MASTER).map((r) => r.id)).toEqual(['intern']);

      const updated = updateRole(cfg, MASTER, role('intern', { name: 'Intern (read-only)' }));
      expect(updated.name).toBe('Intern (read-only)');
      expect(updated.createdAt).toBe(stored.createdAt); // preserved by the repository

      deleteRole(cfg, MASTER, 'intern');
      expect(listRoles(cfg, MASTER)).toEqual([]);
    });

    it('refuses the built-in reserved role ids BEFORE authentication (intrinsic constants, not rows)', () => {
      // Even a bogus credential gets the Forbidden reservation, never Unauthenticated —
      // the guard runs before anything else.
      expect(() => createRole(cfg, 'not-a-credential', role(SSO_ADMIN_ROLE_ID))).toThrow(ForbiddenError);
      expect(() => updateRole(cfg, 'not-a-credential', role(SSO_ADMIN_ROLE_ID))).toThrow(/intrinsic/);
      expect(() => deleteRole(cfg, 'not-a-credential', SSO_ADMIN_ROLE_ID)).toThrow(/cannot be deleted/);
    });

    it('a delegated instance-wide project:admin manages roles; a scoped admin does not', () => {
      allow(dataDir, 'u-instadm', 'project:admin', 'instance', undefined);
      const instAdmin = mintUserToken(dataDir, { id: 'k-instadm', userId: 'u-instadm' });
      expect(createRole(cfg, instAdmin, role('ops')).id).toBe('ops');
      expect(listRoles(cfg, instAdmin).map((r) => r.id)).toEqual(['ops']);

      // project:admin over ONE unit is not instance-level authority over role templates.
      const unit = seedUnit(dataDir, 'team-a');
      allow(dataDir, 'u-unitadm', 'project:admin', 'unit', unit.id);
      const unitAdmin = mintUserToken(dataDir, { id: 'k-unitadm', userId: 'u-unitadm' });
      expect(() => createRole(cfg, unitAdmin, role('rogue'))).toThrow(ForbiddenError);
      expect(() => listRoles(cfg, unitAdmin)).toThrow(/instance-level project:admin/);
    });

    it('rejects an unauthenticated caller (401 shape, not a silent no-op)', () => {
      expect(() => createRole(cfg, null, role('ghost'))).toThrow(UnauthenticatedError);
      expect(() => listRoles(cfg, 'wk_bogus')).toThrow(UnauthenticatedError);
    });
  });

  // ── the assignment grid ─────────────────────────────────────────────────────

  describe('assignment grid (set / remove / list)', () => {
    it("rejects the reserved '*'@instance instance-admin marker unconditionally — even for the master", () => {
      expect(() =>
        setAssignment(cfg, MASTER, {
          id: '',
          subjectKind: 'user',
          subjectId: 'u-evil',
          scopeKind: 'instance',
          capability: '*' as never,
          value: 'yes',
          createdAt: '',
        }),
      ).toThrow(/reserved to the built-in admin account/);
      expect(listAssignments(cfg, MASTER)).toEqual([]);
    });

    it('the master sets an assignment (id + createdBy stamped) and lists it by scope and subject', () => {
      const unit = seedUnit(dataDir, 'team-a');
      const stored = setAssignment(cfg, MASTER, {
        id: '',
        subjectKind: 'user',
        subjectId: 'u-1',
        scopeKind: 'unit',
        scopeId: unit.id,
        capability: 'project:read',
        value: 'yes',
        createdAt: '',
      });
      expect(stored.id).toBeTruthy();
      expect(stored.createdBy?.userId).toBe('bootstrap'); // the master credential's subject

      // Scope-filtered, subject-filtered, and unfiltered listings all find it.
      expect(listAssignments(cfg, MASTER, 'unit', unit.id).map((a) => a.id)).toEqual([stored.id]);
      expect(listAssignments(cfg, MASTER, undefined, undefined, 'user', 'u-1').map((a) => a.id)).toEqual([stored.id]);
      expect(listAssignments(cfg, MASTER).map((a) => a.id)).toContain(stored.id);
      // A different scope anchor does not cross-match.
      expect(listAssignments(cfg, MASTER, 'project', unit.id)).toEqual([]);
    });

    it("a unit admin manages assignments within their unit but never at instance scope (or a foreign unit)", () => {
      const mine = seedUnit(dataDir, 'mine');
      const theirs = seedUnit(dataDir, 'theirs');
      allow(dataDir, 'u-adm', 'project:admin', 'unit', mine.id);
      const admToken = mintUserToken(dataDir, { id: 'k-adm', userId: 'u-adm' });

      const ok = setAssignment(cfg, admToken, {
        id: '',
        subjectKind: 'user',
        subjectId: 'u-member',
        scopeKind: 'unit',
        scopeId: mine.id,
        capability: 'project:write',
        value: 'yes',
        createdAt: '',
      });
      expect(ok.id).toBeTruthy();
      // The unit-scoped listing contains BOTH the admin's own seeded project:admin
      // assignment and the new one — filter to the subject being managed.
      expect(listAssignments(cfg, admToken, 'unit', mine.id, 'user', 'u-member').map((a) => a.id)).toEqual([ok.id]);

      for (const scope of [
        { scopeKind: 'instance' as const },
        { scopeKind: 'unit' as const, scopeId: theirs.id },
      ]) {
        expect(() =>
          setAssignment(cfg, admToken, {
            id: '',
            subjectKind: 'user',
            subjectId: 'u-member',
            ...scope,
            capability: 'project:read',
            value: 'yes',
            createdAt: '',
          }),
        ).toThrow(ForbiddenError);
      }
      expect(() => listAssignments(cfg, admToken, 'unit', theirs.id)).toThrow(ForbiddenError);
      expect(() => listAssignments(cfg, admToken)).toThrow(/project:admin over the scope/);
    });

    it("removeAssignment authorizes over the assignment's OWN scope, never a caller-supplied one", () => {
      const mine = seedUnit(dataDir, 'mine');
      const theirs = seedUnit(dataDir, 'theirs');
      const foreign = setAssignment(cfg, MASTER, {
        id: '',
        subjectKind: 'user',
        subjectId: 'u-x',
        scopeKind: 'unit',
        scopeId: theirs.id,
        capability: 'project:read',
        value: 'yes',
        createdAt: '',
      });

      allow(dataDir, 'u-adm', 'project:admin', 'unit', mine.id);
      const admToken = mintUserToken(dataDir, { id: 'k-adm', userId: 'u-adm' });
      expect(() => removeAssignment(cfg, admToken, foreign.id)).toThrow(ForbiddenError);
      expect(listAssignments(cfg, MASTER, 'unit', theirs.id)).toHaveLength(1);

      removeAssignment(cfg, MASTER, foreign.id);
      expect(listAssignments(cfg, MASTER, 'unit', theirs.id)).toEqual([]);
    });

    it('removeAssignment rejects an unknown id as not found', () => {
      expect(() => removeAssignment(cfg, MASTER, 'nope')).toThrow(/not found/);
    });
  });

  // ── role bindings ───────────────────────────────────────────────────────────

  describe('user role bindings (bind / unbind)', () => {
    const seedUser = (id: string): void => {
      upsertUser(dataDir, { id, subject: subjectOf(id), status: 'active', createdAt: '' });
    };

    it('binds a role to a user at a scope (idempotent) and unbinding leaves other bindings intact', () => {
      const unit = seedUnit(dataDir, 'team-a');
      createRole(cfg, MASTER, role('reader'));
      seedUser('u-b');

      const bound = bindRole(cfg, MASTER, 'u-b', 'reader', 'unit', unit.id);
      expect(bound.roleBindings).toEqual([{ roleId: 'reader', scopeKind: 'unit', scopeId: unit.id }]);

      // Idempotent: the same {roleId, scope} anchor never duplicates.
      expect(bindRole(cfg, MASTER, 'u-b', 'reader', 'unit', unit.id).roleBindings).toHaveLength(1);

      // A second, instance-wide binding of another role coexists…
      createRole(cfg, MASTER, role('ops'));
      expect(bindRole(cfg, MASTER, 'u-b', 'ops').roleBindings).toHaveLength(2);

      // …and unbinding the unit-scoped one leaves it untouched.
      const after = unbindRole(cfg, MASTER, 'u-b', 'reader', 'unit', unit.id);
      expect(after.roleBindings).toEqual([{ roleId: 'ops' }]);
      expect(getUserById(dataDir, 'u-b')?.roleBindings).toEqual([{ roleId: 'ops' }]);
    });

    it('rejects binding to an unknown user as not found', () => {
      createRole(cfg, MASTER, role('reader'));
      expect(() => bindRole(cfg, MASTER, 'u-ghost', 'reader')).toThrow(/not found/);
    });

    it('a unit admin binds at their unit scope but never instance-wide', () => {
      const unit = seedUnit(dataDir, 'team-a');
      createRole(cfg, MASTER, role('reader'));
      seedUser('u-b');
      allow(dataDir, 'u-adm', 'project:admin', 'unit', unit.id);
      const admToken = mintUserToken(dataDir, { id: 'k-adm', userId: 'u-adm' });

      expect(bindRole(cfg, admToken, 'u-b', 'reader', 'unit', unit.id).roleBindings).toHaveLength(1);
      expect(() => bindRole(cfg, admToken, 'u-b', 'reader')).toThrow(ForbiddenError);
      expect(() => unbindRole(cfg, admToken, 'u-b', 'reader')).toThrow(ForbiddenError);
    });

    it('a bound role confers its permissions through the resolver, anchored at the binding scope', () => {
      // World: unit team-a contains the placed project proj-a.
      const unit = seedUnit(dataDir, 'team-a');
      createProjectRecord(dataDir, 'proj-a');
      placeProject(dataDir, { id: '', projectId: 'proj-a', unitId: unit.id, role: 'owner', createdAt: '', createdBy: subjectOf('seeder') });

      createRole(cfg, MASTER, role('reader')); // project:read = yes
      seedUser('u-b');
      const token = mintUserToken(dataDir, { id: 'k-b', userId: 'u-b' });

      // Before the binding: no authority anywhere.
      expect(authorize(dataDir, authenticate(dataDir, token), 'project:read', 'project', 'proj-a').value).toBe('no');

      // Bind reader at the unit → the role's value applies to the unit's subtree.
      bindRole(cfg, MASTER, 'u-b', 'reader', 'unit', unit.id);
      expect(authorize(dataDir, authenticate(dataDir, token), 'project:read', 'project', 'proj-a').value).toBe('yes');
      // …but not to anything outside the anchor.
      createProjectRecord(dataDir, 'elsewhere');
      expect(authorize(dataDir, authenticate(dataDir, token), 'project:read', 'project', 'elsewhere').value).toBe('no');

      // Unbind → the authority is gone again (live resolution, no caching).
      unbindRole(cfg, MASTER, 'u-b', 'reader', 'unit', unit.id);
      expect(authorize(dataDir, authenticate(dataDir, token), 'project:read', 'project', 'proj-a').value).toBe('no');
    });
  });
});
