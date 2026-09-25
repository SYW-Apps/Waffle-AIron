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
import { listSecretKeys, resolveSecret } from '../../src/utils/secrets.js';

// ---------------------------------------------------------------------------
// local_admin_portal (sdd_host) and cli_host_adapter (sdd_cli).
//
// The in-process administration portal is the owning workflows republished by
// identity — it adds no gate and no logic, so the workflows' own authorization
// is the only one there is — and the CLI adapter is the portal republished by
// identity. Both pinned here, plus the one boot-time write that runs before any
// credential exists: it takes neither key nor value from its caller.
// ---------------------------------------------------------------------------

const OWNERS: Record<string, Record<string, unknown>> = {
  admin,
  packs,
  permissionadmin,
  projects,
  errors,
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
  seedIdentityProviderSecret: 'admin',
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

describe('seedIdentityProviderSecret (sdd_host boot write)', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-local-admin-'));
    process.env.WAIRON_DATA_DIR = dataDir;
    delete process.env.WAIRON_OIDC_CLIENT_SECRET;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('writes nothing and answers null when the environment ships no secret', () => {
    expect(localAdmin.seedIdentityProviderSecret()).toBeNull();
    expect(listSecretKeys()).toEqual([]);
  });

  it('stores the environment value under the fixed reference only', () => {
    process.env.WAIRON_OIDC_CLIENT_SECRET = 'raw-client-secret';
    expect(localAdmin.seedIdentityProviderSecret()).toBe('oidc-default');
    expect(listSecretKeys()).toEqual(['oidc-default']);
    expect(resolveSecret('oidc-default')).toBe('raw-client-secret');
  });

  it('takes no key or value from its caller', () => {
    expect(localAdmin.seedIdentityProviderSecret.length).toBe(0);
  });
});
