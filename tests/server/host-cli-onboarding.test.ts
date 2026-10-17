import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runHostKey, runHostPermission, runHostUnit } from '../../src/commands/host.js';
import { mintKey } from '../../src/server/admin.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { getOrganizationUnit, placeProject } from '../../src/server/organization.js';
import { upsertUser } from '../../src/server/users.js';
import { listCredentials } from '../../src/server/credentials.js';
import { subjectOf } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// The hosted first-run commands an operator types from the quick start: a root
// unit without --kind, a key for a project, and the read/write split of the
// permission grid — each says what it did, or refuses before writing.
// ---------------------------------------------------------------------------

const MASTER = 'host-cli-onboarding-master-credential';
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'WAIRON_CACHE_DIR', 'WAIRON_ADMIN_TOKEN', 'WAIRON_DATA_DIR', 'WAIRON_PACKS_DIR'];

let base: string;
let dataDir: string;
let cfg: HostConfig;
let saved: (readonly [string, string | undefined])[];
let warnings: string[];

beforeEach(() => {
  saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-host-onboard-'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
  process.env.LOCALAPPDATA = path.join(home, 'AppData', 'Local');
  process.env.WAIRON_CACHE_DIR = path.join(base, 'cache');
  process.env.WAIRON_ADMIN_TOKEN = MASTER;
  dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.WAIRON_DATA_DIR = dataDir;
  cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  warnings = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

/** A project on the instance, placed in a root unit. */
function placedProject(id: string): void {
  createProjectRecord(dataDir, id);
  placeProject(dataDir, { id: '', projectId: id, unitId: 'acme', role: 'owner', createdAt: '', createdBy: { userId: 'system', kind: 'service', issuer: 'local' } });
}

function user(id: string): void {
  upsertUser(dataDir, { id, subject: subjectOf(id), status: 'active', createdAt: new Date().toISOString(), roleBindings: [] });
}

describe('host unit create', () => {
  it('defaults a top-level unit to business_entity, the only kind the hierarchy admits at the root', async () => {
    await runHostUnit('create', { dataDir, slug: 'acme' });
    expect(getOrganizationUnit(dataDir, 'acme')?.kind).toBe('business_entity');
  });

  it('defaults a unit under a parent to team, and keeps an explicit --kind', async () => {
    await runHostUnit('create', { dataDir, slug: 'acme' });
    await runHostUnit('create', { dataDir, slug: 'web', parent: 'acme' });
    expect(getOrganizationUnit(dataDir, 'acme.web')?.kind).toBe('team');
    await runHostUnit('create', { dataDir, slug: 'ops', kind: 'business_entity' });
    expect(getOrganizationUnit(dataDir, 'ops')?.kind).toBe('business_entity');
  });
});

describe('host key mint', () => {
  it('refuses a project no hosted record holds, minting nothing', async () => {
    await expect(runHostKey('mint', { dataDir, project: 'acme' })).rejects.toThrow(/unknown project "acme"/);
    expect(() => mintKey(cfg, MASTER, 'acme', 'editor')).toThrow(/unknown project "acme"/);
    expect(listCredentials(dataDir, '*')).toEqual([]);
  });

  it('warns when the owner cannot read the project the token is narrowed to', async () => {
    await runHostUnit('create', { dataDir, slug: 'acme' });
    placedProject('shop');
    user('alice');
    await runHostKey('mint', { dataDir, project: 'shop', owner: 'alice' });
    expect(warnings.join('\n')).toMatch(/project:read for "alice" at project shop resolves to no/);
    expect(warnings.join('\n')).toContain('wairon host permission set --user alice --capability project:read --project shop');

    warnings.length = 0;
    await runHostPermission('set', { dataDir, user: 'alice', capability: 'project:read', project: 'shop' });
    await runHostKey('mint', { dataDir, project: 'shop', owner: 'alice' });
    expect(warnings.join('\n')).not.toMatch(/project:read for "alice"/);
  });
});

describe('host permission set — read and write are separate capabilities', () => {
  beforeEach(async () => {
    await runHostUnit('create', { dataDir, slug: 'acme' });
    placedProject('shop');
    user('alice');
  });

  it('warns when it grants project:write to a user who cannot read that scope', async () => {
    await runHostPermission('set', { dataDir, user: 'alice', capability: 'project:write', project: 'shop' });
    expect(warnings.join('\n')).toMatch(/project:read for "alice" at project shop resolves to no — alice can write here but cannot read it/);
  });

  it('says nothing when the user can already read it', async () => {
    await runHostPermission('set', { dataDir, user: 'alice', capability: 'project:read', unit: 'acme' });
    await runHostPermission('set', { dataDir, user: 'alice', capability: 'project:write', project: 'shop' });
    expect(warnings.join('\n')).not.toMatch(/project:read for "alice"/);
  });

  it('says nothing for a denial, and nothing for a user with no record', async () => {
    await runHostPermission('set', { dataDir, user: 'alice', capability: 'project:write', value: 'no', project: 'shop' });
    await runHostPermission('set', { dataDir, user: 'svc-bot', capability: 'project:write', project: 'shop' });
    expect(warnings.join('\n')).not.toMatch(/project:read for/);
  });
});
