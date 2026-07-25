import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { loadProjectConfig } from '../../src/config/loader.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { AdminAuthError } from '../../src/server/errors.js';
import {
  installGlobalPack,
  installProjectPack,
  listProjectPacks,
  listProjectProfiles,
  listAdoptableProjectPacks,
  adoptProjectPack,
  storeListGlobalPacks,
  storeListAvailableProfiles,
  executeApprovedListProjectProfiles,
  executeApprovedEnsureProfileInstalled,
} from '../../src/server/packs.js';
import { allow, createPlacedProject, mintUserToken } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage B+C — pack/profile catalog + server-global pack adoption (sdd_host).
//
// Exercises the new pack_registry / pack_orchestrator surface: probe descriptor
// enrichment (profileIds / languageIds / ruleIds), the aggregated selectable-
// profile catalog (built-ins + pack-contributed, tagged by source), the
// adoptable server-global catalog, and adopting a server-global pack into a
// project by canonical name (rejecting a name the instance does not carry).
//
// Stage D adds the PROJECT-SCOPED half: the per-project profile catalog (which
// can see a project's own packs and marks each entry installed vs adoptable, the
// blind spot the instance-wide catalog has) and the ensure-profile-installed
// seam that makes one profile id actually able to GOVERN a project — adopting
// the contributing pack when needed, idempotently, and refusing an id no tier
// contributes rather than writing an unenforceable projectType.
// ---------------------------------------------------------------------------

const ADMIN = 'test-admin-secret';

// A declarative pack carrying one profile (with a family) and one language, so
// probe enrichment and the profile catalog have real ids to surface. Its file
// stem ('acme') differs from its canonical manifest name ('acme-doctrine').
const ACME_PACK = [
  'name: acme-doctrine',
  'profiles:',
  '  ddd:',
  '    family: backend-like',
  'languages:',
  '  rust:',
  '    unsupportedFlow: {}',
  '    foreignBuiltins: []',
  '',
].join('\n');

// A declarative pack uploaded STRAIGHT INTO a project — it exists in no
// server-global tier, so only the project-scoped catalog can ever see its
// profile ('hexagonal'). The instance-wide catalog's blind spot is the bug the
// project-scoped catalog fixes.
const TENANT_PACK = [
  'name: tenant-doctrine',
  'profiles:',
  '  hexagonal:',
  '    family: backend-like',
  '',
].join('\n');

describe('Stage B+C — pack/profile catalog + adoption (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-adopt-it-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = ADMIN;
    process.env.WAIRON_PACKS_DIR = path.join(dataDir, 'packs');
    // Isolate the image tier: a populated /opt/wairon/packs on the host must
    // never leak into these instance-tier assertions.
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(dataDir, 'image-packs');
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** The pack refs registered in a hosted project's OWN .wai/project.yaml — what
   *  proves an adoption actually vendored + registered the contributing pack. */
  const registeredPacks = (projectId: string): string[] =>
    runWithProjectRoot(path.join(dataDir, 'projects', projectId), () => loadProjectConfig()).extensions?.packs ?? [];

  it('(a) enriches the probe descriptor with profileIds / languageIds / ruleIds', () => {
    const desc = installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK);
    expect(desc.name).toBe('acme-doctrine');
    expect(desc.profiles).toBe(1);
    expect(desc.profileIds).toEqual(['ddd']);
    expect(desc.languageIds).toEqual(['rust']);
    expect(desc.ruleIds).toEqual([]); // a declarative pack contributes no programmatic rules

    // The same enrichment rides on the two-tier listing.
    const listed = storeListGlobalPacks().find((d) => d.name === 'acme-doctrine');
    expect(listed?.profileIds).toEqual(['ddd']);
  });

  it('(b) storeListAvailableProfiles aggregates built-ins and pack profiles tagged by source', () => {
    installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK);
    const list = storeListAvailableProfiles();

    // A built-in id appears with source 'builtin'.
    expect(list.find((p) => p.id === 'backend')).toMatchObject({ id: 'backend', source: 'builtin' });

    // The seeded pack's profile appears with source = the pack's canonical name
    // and its ProfileDef family carried through.
    expect(list.find((p) => p.id === 'ddd')).toMatchObject({
      id: 'ddd',
      source: 'acme-doctrine',
      family: 'backend-like',
    });
  });

  it('(c) listAdoptableProjectPacks returns the server-global catalog', () => {
    installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK);
    createPlacedProject(cfg, ADMIN, 'demo');

    const adoptable = listAdoptableProjectPacks(cfg, ADMIN, 'demo');
    expect(adoptable.map((p) => p.name)).toContain('acme-doctrine');
  });

  it('(d) adoptProjectPack vendors a server-global pack by name and rejects an unknown name', () => {
    installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK); // canonical name 'acme-doctrine'
    createPlacedProject(cfg, ADMIN, 'demo');

    // Adopt by canonical name — vendored into the project under that name.
    const desc = adoptProjectPack(cfg, ADMIN, 'demo', 'acme-doctrine');
    expect(desc.scope).toBe('project');
    expect(desc.name).toBe('acme-doctrine');

    const root = path.join(dataDir, 'projects', 'demo');
    expect(fs.existsSync(path.join(root, '.wai', 'packs', 'acme-doctrine.yaml'))).toBe(true);

    // It now shows up in the project's registered packs.
    expect(listProjectPacks(cfg, ADMIN, 'demo').map((p) => p.name)).toContain('acme-doctrine');

    // A pack the instance does not carry is rejected — never a silent no-op.
    expect(() => adoptProjectPack(cfg, ADMIN, 'demo', 'ghost-pack')).toThrow(/no such server-global pack/i);
  });

  // ── Stage D — the PROJECT-SCOPED profile catalog + profile adoption ──────────

  it('(e) the project-scoped catalog marks the project tier installed and the server-global tier adoptable', () => {
    installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK); // server-global only → adoptable
    createPlacedProject(cfg, ADMIN, 'demo');
    installProjectPack(cfg, ADMIN, 'demo', 'tenant', TENANT_PACK); // the project's OWN pack → installed

    const catalog = executeApprovedListProjectProfiles(cfg, 'demo');

    // Built-ins always govern the project.
    expect(catalog.find((p) => p.id === 'backend')).toMatchObject({ source: 'builtin', installed: true });

    // The project's own pack contributes an INSTALLED profile, family carried through.
    expect(catalog.find((p) => p.id === 'hexagonal')).toMatchObject({
      id: 'hexagonal',
      source: 'tenant-doctrine',
      family: 'backend-like',
      installed: true,
    });

    // A server-global-only pack contributes an ADOPTABLE profile.
    expect(catalog.find((p) => p.id === 'ddd')).toMatchObject({
      id: 'ddd',
      source: 'acme-doctrine',
      installed: false,
    });
  });

  it('(f) a profile contributed ONLY by a project-installed pack is invisible instance-wide but present project-scoped', () => {
    createPlacedProject(cfg, ADMIN, 'demo');
    installProjectPack(cfg, ADMIN, 'demo', 'tenant', TENANT_PACK);

    // The instance-wide catalog cannot see a project's own packs — the bug.
    expect(storeListAvailableProfiles().find((p) => p.id === 'hexagonal')).toBeUndefined();

    // The project-scoped catalog can, and reports it as already governing.
    expect(executeApprovedListProjectProfiles(cfg, 'demo').find((p) => p.id === 'hexagonal')).toMatchObject({
      source: 'tenant-doctrine',
      installed: true,
    });
  });

  it('(g) ensureProfileInstalled adopts the contributing pack for a server-global-only profile', () => {
    installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK); // canonical name 'acme-doctrine', profile 'ddd'
    createPlacedProject(cfg, ADMIN, 'demo');
    expect(registeredPacks('demo')).not.toContain('.wai/packs/acme-doctrine.yaml');

    const applied = executeApprovedEnsureProfileInstalled(cfg, 'demo', 'ddd');
    expect(applied).toEqual({ profileId: 'ddd', source: 'acme-doctrine', adoptedPackName: 'acme-doctrine' });

    // The side effect is real: the pack is vendored AND registered by canonical name.
    expect(registeredPacks('demo')).toContain('.wai/packs/acme-doctrine.yaml');
    expect(fs.existsSync(path.join(dataDir, 'projects', 'demo', '.wai', 'packs', 'acme-doctrine.yaml'))).toBe(true);
    expect(listProjectPacks(cfg, ADMIN, 'demo').map((p) => p.name)).toContain('acme-doctrine');

    // And the profile now reads as installed rather than adoptable.
    expect(executeApprovedListProjectProfiles(cfg, 'demo').find((p) => p.id === 'ddd')).toMatchObject({
      source: 'acme-doctrine',
      installed: true,
    });
  });

  it('(h) ensureProfileInstalled is idempotent — a second call adopts nothing further', () => {
    installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK);
    createPlacedProject(cfg, ADMIN, 'demo');

    expect(executeApprovedEnsureProfileInstalled(cfg, 'demo', 'ddd').adoptedPackName).toBe('acme-doctrine');
    const before = registeredPacks('demo');

    const again = executeApprovedEnsureProfileInstalled(cfg, 'demo', 'ddd');
    expect(again).toEqual({ profileId: 'ddd', source: 'acme-doctrine' }); // no adoptedPackName
    expect(again.adoptedPackName).toBeUndefined();
    expect(registeredPacks('demo')).toEqual(before); // nothing new registered
  });

  it('(i) ensureProfileInstalled resolves a built-in profile and a project kind as-is, adopting nothing', () => {
    createPlacedProject(cfg, ADMIN, 'demo');

    expect(executeApprovedEnsureProfileInstalled(cfg, 'demo', 'backend')).toEqual({
      profileId: 'backend',
      source: 'builtin',
    });
    // A composite project kind is a legal projectType with no contributing pack.
    expect(executeApprovedEnsureProfileInstalled(cfg, 'demo', 'fullstack')).toEqual({
      profileId: 'fullstack',
      source: 'builtin',
    });
    expect(registeredPacks('demo')).toEqual([]);
  });

  it('(j) ensureProfileInstalled throws for a profile id no tier contributes', () => {
    createPlacedProject(cfg, ADMIN, 'demo');

    // Refused, never applied: an unresolvable projectType silently disables the
    // whole profile doctrine, so the error names the id and the tiers searched.
    expect(() => executeApprovedEnsureProfileInstalled(cfg, 'demo', 'ghost-profile')).toThrow(/ghost-profile/);
    expect(() => executeApprovedEnsureProfileInstalled(cfg, 'demo', 'ghost-profile')).toThrow(
      /built-in profile or project kind.*registered in project.*server-global pack/is,
    );
    expect(registeredPacks('demo')).toEqual([]);
  });

  it('(k) listProjectProfiles refuses a caller lacking project:read over the project', () => {
    installGlobalPack(cfg, ADMIN, 'acme', ACME_PACK);
    const unit = createPlacedProject(cfg, ADMIN, 'demo');

    const plain = mintUserToken(dataDir, { id: 'k-plain', userId: 'u-plain' });
    expect(() => listProjectProfiles(cfg, plain, 'demo')).toThrow(AdminAuthError);
    expect(() => listProjectProfiles(cfg, plain, 'demo')).toThrow(/requires project:read over the project/);

    // Granted project:read over the enclosing unit, the same caller may read it.
    allow(dataDir, 'u-plain', 'project:read', 'unit', unit.id);
    expect(listProjectProfiles(cfg, plain, 'demo').map((p) => p.id)).toContain('ddd');
  });
});
