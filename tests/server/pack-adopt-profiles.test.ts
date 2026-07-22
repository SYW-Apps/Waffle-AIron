import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import {
  installGlobalPack,
  listProjectPacks,
  listAdoptableProjectPacks,
  adoptProjectPack,
  storeListGlobalPacks,
  storeListAvailableProfiles,
} from '../../src/server/packs.js';
import { createPlacedProject } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage B+C — pack/profile catalog + server-global pack adoption (sdd_host).
//
// Exercises the new pack_registry / pack_orchestrator surface: probe descriptor
// enrichment (profileIds / languageIds / ruleIds), the aggregated selectable-
// profile catalog (built-ins + pack-contributed, tagged by source), the
// adoptable server-global catalog, and adopting a server-global pack into a
// project by canonical name (rejecting a name the instance does not carry).
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
});
