import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getInstanceIdentity } from '../../src/server/instance.js';
import { getOrganizationUnit, listProjectPlacements } from '../../src/server/organization.js';
import { registerProjectRecord } from '../../src/server/projects.js';
import { migratePermissionModel } from '../../src/server/migration.js';
import { bootstrapInstance, DEV_UNIT_ID } from '../../src/server/instance-bootstrap.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Instance Bootstrap (sdd_host) — the lifecycle init entrypoint.
//
// One-time boot initialization, run BEFORE the listeners bind: seeds or loads
// the persisted instance identity and, under devMode, creates the synthetic
// local development unit when it is missing. A later boot changes nothing.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

describe('instance bootstrap (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-bootstrap-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
      builtinAdminUser: 'root-operator',
      builtinAdminPassword: 'a-very-strong-builtin-password',
    };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('bootstrapInstance seeds the identity; under devMode it also ensures the synthetic local unit (idempotently)', () => {
    // Hosted posture: identity seeded, NO synthetic unit.
    bootstrapInstance(cfg);
    expect(getInstanceIdentity(dataDir)).not.toBeNull();
    expect(getOrganizationUnit(dataDir, DEV_UNIT_ID)).toBeNull();

    // Dev posture: the synthetic local unit exists so dev projects can be placed.
    const devCfg: HostConfig = { ...cfg, authEnabled: false, devMode: true };
    bootstrapInstance(devCfg);
    const unit = getOrganizationUnit(dataDir, DEV_UNIT_ID);
    expect(unit?.id).toBe(DEV_UNIT_ID);

    // Idempotent: a re-run neither duplicates the unit nor rotates the identity.
    const before = getInstanceIdentity(dataDir);
    bootstrapInstance(devCfg);
    expect(getInstanceIdentity(dataDir)).toEqual(before);
    expect(getOrganizationUnit(dataDir, DEV_UNIT_ID)?.createdAt).toBe(unit?.createdAt);
  });
  it('under devMode it places the dev project in the local unit, so its own data dir never reads as unmigrated', () => {
    const devCfg: HostConfig = { ...cfg, authEnabled: false, devMode: true };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-bootstrap-root-'));
    try {
      registerProjectRecord(dataDir, 'local', root);
      expect(migratePermissionModel(dataDir, false).findings.map((f) => f.area)).toContain('projects');

      bootstrapInstance(devCfg);
      expect(listProjectPlacements(dataDir, 'local')).toEqual([expect.objectContaining({ projectId: 'local', unitId: DEV_UNIT_ID, role: 'owner' })]);
      expect(migratePermissionModel(dataDir, false).findings).toEqual([]);

      // A later boot places nothing twice.
      bootstrapInstance(devCfg);
      expect(listProjectPlacements(dataDir, 'local')).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a hosted boot places nothing: placement is the operator's", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-bootstrap-root-'));
    try {
      registerProjectRecord(dataDir, 'shop', root);
      bootstrapInstance(cfg);
      expect(listProjectPlacements(dataDir)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
