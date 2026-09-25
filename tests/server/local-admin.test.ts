import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as localAdmin from '../../src/server/local-admin.js';
import * as cliHostAdapter from '../../src/commands/adapters/host.js';
import * as admin from '../../src/server/admin.js';
import * as packs from '../../src/server/packs.js';
import * as permissionadmin from '../../src/server/permissionadmin.js';
import * as projects from '../../src/server/projects.js';
import * as errors from '../../src/server/errors.js';
import * as identity from '../../src/server/identity.js';
import * as identityProviderBootstrap from '../../src/server/identity-provider-bootstrap.js';
import * as landscape from '../../src/server/landscape.js';
import * as migration from '../../src/server/migration.js';
import * as http from '../../src/server/http.js';
import { listIdentityProviderRecords } from '../../src/server/policy.js';
import type { HostConfig } from '../../src/server/types.js';
import { listSecretKeys, resolveSecret } from '../../src/utils/secrets.js';

// ---------------------------------------------------------------------------
// local_admin_portal (sdd_host) and cli_host_adapter (sdd_cli).
//
// The in-process administration portal is the owning workflows republished by
// identity — it adds no gate and no logic, so the workflows' own authorization
// is the only one there is — and the CLI adapter is the portal republished by
// identity. Both pinned here, plus the one boot-time write that runs before any
// credential exists: the caller hands it nothing but the host configuration.
// ---------------------------------------------------------------------------

const OWNERS: Record<string, Record<string, unknown>> = {
  admin,
  packs,
  permissionadmin,
  projects,
  errors,
  identity,
  identityProviderBootstrap,
  landscape,
  migration,
  http,
};

const PORTAL_SOURCES: Record<string, string> = {
  createProject: 'admin',
  destroyProject: 'admin',
  listProjects: 'admin',
  lockProject: 'admin',
  mintKey: 'admin',
  revokeKey: 'admin',
  listKeys: 'admin',
  configureProducer: 'admin',
  produceProducer: 'admin',
  removeProducer: 'admin',
  listProducers: 'admin',
  setSecret: 'admin',
  listSecrets: 'admin',
  enableGit: 'admin',
  disableGit: 'admin',
  syncGit: 'admin',
  commitProject: 'admin',
  getGitBinding: 'admin',
  configureGitSync: 'admin',
  registerLocalDevProject: 'admin',
  LockValidationError: 'admin',
  listGlobalPacks: 'packs',
  installGlobalPack: 'packs',
  removeGlobalPack: 'packs',
  listProjectPacks: 'packs',
  installProjectPack: 'packs',
  removeProjectPack: 'packs',
  setAssignment: 'permissionadmin',
  removeAssignment: 'permissionadmin',
  listAssignments: 'permissionadmin',
  existingProjectRoot: 'projects',
  AdminAuthError: 'errors',
  mintToken: 'identity',
  seedDefaultProvider: 'identityProviderBootstrap',
  upsertUnit: 'landscape',
  migratePermissionModel: 'migration',
  startHostServer: 'http',
};

describe('local_admin_portal (sdd_host)', () => {
  it('publishes exactly the owning workflows, each by identity', () => {
    expect(Object.keys(localAdmin).sort()).toEqual(Object.keys(PORTAL_SOURCES).sort());
    for (const [name, owner] of Object.entries(PORTAL_SOURCES)) {
      expect((localAdmin as Record<string, unknown>)[name], name).toBe(OWNERS[owner][name]);
    }
  });

  it('never publishes the unguarded secret or project-record writes', () => {
    const surface = localAdmin as Record<string, unknown>;
    expect(surface['registerProjectRecord']).toBeUndefined();
    expect(surface['createProjectRecord']).toBeUndefined();
    // setSecret on the portal is the admin workflow (credential-checked), not the store write.
    expect(surface['setSecret']).toBe(admin.setSecret);
  });
});

describe('cli_host_adapter (sdd_cli)', () => {
  it('is the local admin portal republished by identity', () => {
    expect(Object.keys(cliHostAdapter).sort()).toEqual(Object.keys(localAdmin).sort());
    for (const name of Object.keys(localAdmin)) {
      expect((cliHostAdapter as Record<string, unknown>)[name], name).toBe(
        (localAdmin as Record<string, unknown>)[name],
      );
    }
  });
});

describe('seedDefaultProvider (sdd_host boot write)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-local-admin-'));
    process.env.WAIRON_DATA_DIR = dataDir;
    for (const key of Object.keys(process.env)) if (key.startsWith('WAIRON_OIDC_')) delete process.env[key];
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

  it('writes nothing and answers null when the environment names no issuer', () => {
    process.env.WAIRON_OIDC_CLIENT_SECRET = 'raw-client-secret';
    expect(localAdmin.seedDefaultProvider(cfg)).toBeNull();
    expect(listSecretKeys()).toEqual([]);
    expect(listIdentityProviderRecords(dataDir)).toEqual([]);
  });

  it('stores the environment secret under the fixed reference only, and the provider names the reference', () => {
    process.env.WAIRON_OIDC_ISSUER = 'https://sso.example.com/';
    process.env.WAIRON_OIDC_CLIENT_SECRET = 'raw-client-secret';
    const seeded = localAdmin.seedDefaultProvider(cfg);
    expect(seeded?.id).toBe('default');
    expect(seeded?.clientSecretRef).toBe('oidc-default');
    expect(listSecretKeys()).toEqual(['oidc-default']);
    expect(resolveSecret('oidc-default')).toBe('raw-client-secret');
  });

  it('takes nothing from its caller but the host configuration', () => {
    expect(localAdmin.seedDefaultProvider.length).toBe(1);
  });
});
