import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  createProject,
  destroyProject,
  lockProject,
  promoteProject,
  AdminAuthError,
} from '../../src/server/admin.js';
import {
  upsertOrganizationUnit,
  placeProject,
  listProjectPlacements,
} from '../../src/server/organization.js';
import { listProjectRecords } from '../../src/server/projects.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import type {
  ApiKeyRecord,
  HostConfig,
  OrganizationUnitRecord,
  PrincipalSubject,
  ProjectGrant,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Admin Orchestrator — Phase 6a scoped project lifecycle (sdd_host).
//
// createProject / destroyProject / lockProject / promoteProject switch from
// master-credential-only to credential + organization scope: the bootstrap
// master resolves to an instance-wide super-admin (grants '*'/'*' → scope.all),
// so existing master-token behavior is preserved, while a unit-scoped admin may
// only act within their organization-unit subtree. A unit-scoped creator must
// target an in-scope unit and the new project is auto-placed there.
//
// Exercised at the orchestrator boundary (like git-backed.test.ts) with a real
// data dir, a real org tree, and real minted credentials.
// ---------------------------------------------------------------------------

const MASTER = 'master-admin-secret-value';
const sub: PrincipalSubject = { userId: 'tester', kind: 'human', issuer: 'local' };

function orgUnit(id: string, parentId?: string): OrganizationUnitRecord {
  const u: OrganizationUnitRecord = {
    id,
    name: id,
    kind: 'team',
    status: 'active',
    createdAt: '',
    createdBy: sub,
  };
  if (parentId) u.parentId = parentId;
  return u;
}

describe('admin scoped project lifecycle (Phase 6a)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let unitTok: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-admin-scope-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

    // A small org: acme(root) → eng → web ; and sales (out of eng's subtree).
    upsertOrganizationUnit(dataDir, orgUnit('acme'));
    upsertOrganizationUnit(dataDir, orgUnit('eng', 'acme'));
    upsertOrganizationUnit(dataDir, orgUnit('web', 'eng'));
    upsertOrganizationUnit(dataDir, orgUnit('sales', 'acme'));

    // A unit-scoped admin: project lifecycle authority over the eng subtree only
    // (covers eng + web, never sales). Note projectId '' + orgUnitId, so it is NOT
    // an instance-wide '*' super-admin.
    unitTok = mintUnitToken([
      {
        projectId: '',
        orgUnitId: 'eng',
        permissions: ['project:create', 'project:destroy', 'lock:create', 'promote:mark-ready'],
      },
    ]);
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Mint a stored user-bound token carrying the given grants (no data-plane
   *  project scope needed — admin lifecycle authorizes by grants). */
  function mintUnitToken(grants: ProjectGrant[]): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: 'unit-admin-' + crypto.randomBytes(3).toString('hex'),
      keyHash: hashToken(token),
      role: 'editor',
      projects: [],
      grants,
      createdAt: new Date().toISOString(),
      ownerSubject: { userId: 'unit-admin', kind: 'human', issuer: 'local' },
    };
    createCredential(dataDir, record);
    return token;
  }

  /** Place an existing project into a unit directly (out-of-scope fixtures). */
  function place(projectId: string, unitId: string): void {
    placeProject(dataDir, { id: '', projectId, unitId, role: 'owner', createdAt: '', createdBy: sub });
  }

  it('a unit-scoped creator creates AND auto-places a project in an in-scope unit', () => {
    const rec = createProject(cfg, unitTok, 'web-proj', 'web');
    expect(rec.id).toBe('web-proj');

    // The new project is placed in the target unit so the creator retains scope.
    const placements = listProjectPlacements(dataDir, 'web-proj');
    expect(placements).toHaveLength(1);
    expect(placements[0].unitId).toBe('web');
    expect(placements[0].role).toBe('owner');
  });

  it('a unit-scoped creator with NO target unit is denied (403)', () => {
    expect(() => createProject(cfg, unitTok, 'no-unit-proj')).toThrow(AdminAuthError);
    // Nothing was allocated.
    expect(listProjectRecords(dataDir).some((r) => r.id === 'no-unit-proj')).toBe(false);
  });

  it('a unit-scoped creator targeting an OUT-OF-SCOPE unit is denied (403)', () => {
    expect(() => createProject(cfg, unitTok, 'sales-proj', 'sales')).toThrow(AdminAuthError);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'sales-proj')).toBe(false);
  });

  it('an unauthenticated credential is rejected (403)', () => {
    expect(() => createProject(cfg, 'not-a-credential', 'nope', 'web')).toThrow(AdminAuthError);
  });

  it('destroyProject: in-scope succeeds, out-of-scope is denied (403)', () => {
    // In scope: created + placed in web by the unit admin itself.
    createProject(cfg, unitTok, 'del-me', 'web');
    destroyProject(cfg, unitTok, 'del-me');
    expect(listProjectRecords(dataDir).some((r) => r.id === 'del-me')).toBe(false);

    // Out of scope: a project placed in sales (created by the super-admin).
    createProject(cfg, MASTER, 'sales-del');
    place('sales-del', 'sales');
    expect(() => destroyProject(cfg, unitTok, 'sales-del')).toThrow(AdminAuthError);
    expect(listProjectRecords(dataDir).some((r) => r.id === 'sales-del')).toBe(true);
  });

  it('lockProject: out-of-scope is denied (403); in-scope passes the scope gate', () => {
    // Out of scope → denied at the scope gate (never touches the tree).
    createProject(cfg, MASTER, 'sales-lock');
    place('sales-lock', 'sales');
    expect(() => lockProject(cfg, unitTok, 'sales-lock')).toThrow(AdminAuthError);

    // In scope → the scope gate permits; the subsequent lock may fail validation,
    // but it must NOT be an authorization denial.
    createProject(cfg, unitTok, 'web-lock', 'web');
    let err: unknown;
    try {
      lockProject(cfg, unitTok, 'web-lock');
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(AdminAuthError);
  });

  it('promoteProject: in-scope reaches the workflow (not-locked), out-of-scope is denied (403)', () => {
    // In scope: the scope gate permits, so it reaches the promote workflow and
    // reports the deterministic not-locked outcome.
    createProject(cfg, unitTok, 'web-promo', 'web');
    expect(promoteProject(cfg, unitTok, 'web-promo').status).toBe('not-locked');

    // Out of scope → denied at the scope gate.
    createProject(cfg, MASTER, 'sales-promo');
    place('sales-promo', 'sales');
    expect(() => promoteProject(cfg, unitTok, 'sales-promo')).toThrow(AdminAuthError);
  });

  it('the master (super-admin) credential retains full, unplaced access', () => {
    // Super-admin may create anywhere with no target unit → no placement.
    const rec = createProject(cfg, MASTER, 'master-proj');
    expect(rec.id).toBe('master-proj');
    expect(listProjectPlacements(dataDir, 'master-proj')).toHaveLength(0);

    // And lock/promote/destroy over any project regardless of unit scope.
    expect(promoteProject(cfg, MASTER, 'master-proj').status).toBe('not-locked');
    destroyProject(cfg, MASTER, 'master-proj');
    expect(listProjectRecords(dataDir).some((r) => r.id === 'master-proj')).toBe(false);
  });
});
