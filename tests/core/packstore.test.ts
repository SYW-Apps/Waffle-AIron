import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  packStoreDir,
  listInstalledPacks,
  resolveInstalledPack,
  installPackFromDirectory,
  uninstallPack,
  computePackDigest,
  UNVERSIONED,
} from '../../src/core/packstore.js';
import { discoverPacks } from '../../src/core/extensions.js';

// ---------------------------------------------------------------------------
// The pack STORE (A1) — installed is not applied.
//
// The store is the machine-wide pool: <store>/<name>/<version>/ with a per-pack
// install record. Nothing here governs a project until that project selects the
// pack by name. These tests cover the layout, digest identity, latest-version
// resolution, and — critically — that the pre-versioned FLAT layout still
// resolves, so an existing install keeps working.
// ---------------------------------------------------------------------------

const created: string[] = [];

function tempStore(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-store-'));
  created.push(dir);
  process.env.WAIRON_PACKS_DIR = dir;
  return dir;
}

/** A pack directory ready to install. */
function packDir(name: string, version?: string, extra = ''): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packsrc-'));
  created.push(dir);
  fs.writeFileSync(path.join(dir, 'pack.yaml'),
    `name: ${name}\n${version ? `version: ${version}\n` : ''}profiles:\n  ${name}-profile:\n    family: neutral\n${extra}`);
  return dir;
}

afterEach(() => {
  delete process.env.WAIRON_PACKS_DIR;
  for (const dir of created.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('pack store layout', () => {
  it('installs into <store>/<name>/<version>/ with an install record', () => {
    const store = tempStore();
    const installed = installPackFromDirectory(packDir('appenser', '1.2.0'), 'https://example.test/appenser-1.2.0.wpack');

    expect(installed.name).toBe('appenser');
    expect(installed.version).toBe('1.2.0');
    expect(installed.path).toBe(path.join(store, 'appenser', '1.2.0'));
    expect(fs.existsSync(path.join(store, 'appenser', '1.2.0', 'pack.yaml'))).toBe(true);

    // The origin is recorded so a project selection can carry a `source`.
    const record = fs.readFileSync(path.join(store, 'appenser', '1.2.0', '.install.yaml'), 'utf-8');
    expect(record).toContain('https://example.test/appenser-1.2.0.wpack');
    expect(installed.digest).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('an empty or missing store lists nothing rather than failing', () => {
    tempStore();
    expect(listInstalledPacks()).toEqual([]);
    process.env.WAIRON_PACKS_DIR = path.join(os.tmpdir(), 'wairon-store-does-not-exist-xyz');
    expect(listInstalledPacks()).toEqual([]);
    expect(resolveInstalledPack('anything')).toBeNull();
  });

  it('holds several versions of one pack side by side', () => {
    tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    installPackFromDirectory(packDir('appenser', '1.3.0'));

    const versions = listInstalledPacks().filter((p) => p.name === 'appenser').map((p) => p.version);
    expect(versions).toEqual(['1.3.0', '1.2.0']); // newest first
  });

  it('reinstalling the same name@version is idempotent, not additive', () => {
    tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    expect(listInstalledPacks().filter((p) => p.name === 'appenser')).toHaveLength(1);
  });

  it('refuses a source directory that is not a pack, writing nothing', () => {
    const store = tempStore();
    const notAPack = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-notpack-'));
    created.push(notAPack);
    fs.writeFileSync(path.join(notAPack, 'readme.txt'), 'not a pack');

    expect(() => installPackFromDirectory(notAPack)).toThrow(/not a pack directory/i);
    expect(fs.readdirSync(store)).toEqual([]);
  });

  it('records a pack declaring no version as unversioned', () => {
    tempStore();
    const installed = installPackFromDirectory(packDir('nover'));
    expect(installed.version).toBe(UNVERSIONED);
  });
});

describe('resolution: latest by default, exact when pinned', () => {
  it('resolves the highest installed version when none is pinned', () => {
    tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    installPackFromDirectory(packDir('appenser', '1.10.0')); // not lexicographic
    installPackFromDirectory(packDir('appenser', '1.3.0'));

    expect(resolveInstalledPack('appenser')?.version).toBe('1.10.0');
  });

  it('prefers a stable release over a pre-release at the same base version', () => {
    tempStore();
    installPackFromDirectory(packDir('appenser', '2.0.0-beta.3'));
    installPackFromDirectory(packDir('appenser', '2.0.0'));
    expect(resolveInstalledPack('appenser')?.version).toBe('2.0.0');
  });

  it('resolves an exact pin, and nothing when that pin is absent', () => {
    tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    expect(resolveInstalledPack('appenser', '1.2.0')?.version).toBe('1.2.0');
    // "declared but not installed" — the caller turns this into PACK_NOT_INSTALLED.
    expect(resolveInstalledPack('appenser', '9.9.9')).toBeNull();
    expect(resolveInstalledPack('never-installed')).toBeNull();
  });
});

describe('content digest identity', () => {
  it('is stable across installs of identical content and differs on a change', () => {
    tempStore();
    const a = installPackFromDirectory(packDir('samepack', '1.0.0'));
    uninstallPack('samepack');
    const b = installPackFromDirectory(packDir('samepack', '1.0.0'));
    expect(b.digest).toBe(a.digest);

    uninstallPack('samepack');
    const c = installPackFromDirectory(packDir('samepack', '1.0.0', 'guarantees: [extra-token]\n'));
    expect(c.digest).not.toBe(a.digest);
  });

  it('excludes the install record, so digesting is not self-referential', () => {
    tempStore();
    const installed = installPackFromDirectory(packDir('appenser', '1.2.0'), 'https://example.test/a.wpack');
    // Recomputing over the INSTALLED copy (which now contains .install.yaml)
    // must equal the digest computed before the record was written.
    expect(computePackDigest(installed.path)).toBe(installed.digest);
  });

  it('is independent of where the pack sits on disk', () => {
    tempStore();
    const src = packDir('appenser', '1.2.0');
    const beforeInstall = computePackDigest(src);
    const installed = installPackFromDirectory(src);
    expect(installed.digest).toBe(beforeInstall);
  });
});

describe('uninstall', () => {
  it('removes one version and prunes the empty name level', () => {
    const store = tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    expect(uninstallPack('appenser', '1.2.0')).toBe(true);
    expect(fs.existsSync(path.join(store, 'appenser'))).toBe(false);
  });

  it('removes every version when none is named', () => {
    tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    installPackFromDirectory(packDir('appenser', '1.3.0'));
    expect(uninstallPack('appenser')).toBe(true);
    expect(listInstalledPacks()).toEqual([]);
  });

  it('keeps other versions when one is named', () => {
    tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    installPackFromDirectory(packDir('appenser', '1.3.0'));
    uninstallPack('appenser', '1.2.0');
    expect(listInstalledPacks().map((p) => p.version)).toEqual(['1.3.0']);
  });

  it('removing nothing is not an error', () => {
    tempStore();
    expect(uninstallPack('never-installed')).toBe(false);
  });
});

describe('backwards compatibility with the pre-versioned flat store', () => {
  it('reports a bare pack FILE as unversioned, under its declared name', () => {
    const store = tempStore();
    fs.writeFileSync(path.join(store, 'org.yaml'), 'name: org-doctrine\nprofiles:\n  org-profile:\n    family: neutral\n');

    const installed = listInstalledPacks();
    expect(installed).toHaveLength(1);
    expect(installed[0].name).toBe('org-doctrine'); // declared name, not the file name
    expect(installed[0].version).toBe(UNVERSIONED);
    expect(resolveInstalledPack('org-doctrine')).not.toBeNull();
  });

  it('reports an unversioned pack DIRECTORY as unversioned', () => {
    const store = tempStore();
    const dir = path.join(store, 'legacy-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pack.yaml'), 'name: legacy-pack\nprofiles: {}\n');

    const installed = listInstalledPacks();
    expect(installed).toHaveLength(1);
    expect(installed[0].name).toBe('legacy-pack');
    expect(installed[0].version).toBe(UNVERSIONED);
  });

  it('uninstalls a legacy flat entry', () => {
    const store = tempStore();
    fs.writeFileSync(path.join(store, 'org.yaml'), 'name: org-doctrine\nprofiles: {}\n');
    expect(uninstallPack('org-doctrine')).toBe(true);
    expect(fs.existsSync(path.join(store, 'org.yaml'))).toBe(false);
  });
});

describe('the legacy auto-load path still sees store-installed packs', () => {
  it('discoverPacks resolves a versioned entry to its newest version', () => {
    const store = tempStore();
    installPackFromDirectory(packDir('appenser', '1.2.0'));
    installPackFromDirectory(packDir('appenser', '1.10.0'));

    // Without versioned-layout awareness, <store>/appenser/ has no pack entry
    // file and discovery would return NOTHING — the doctrine would silently stop
    // applying for projects that still rely on global auto-load.
    const refs = discoverPacks(store);
    expect(refs).toEqual([path.join(store, 'appenser', '1.10.0')]);
  });

  it('still discovers legacy flat files and unversioned directories', () => {
    const store = tempStore();
    fs.writeFileSync(path.join(store, 'flat.yaml'), 'name: flat\nprofiles: {}\n');
    const dir = path.join(store, 'legacy-dir');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'pack.yaml'), 'name: legacy\nprofiles: {}\n');

    const refs = discoverPacks(store);
    expect(refs).toContain(path.join(store, 'flat.yaml'));
    expect(refs).toContain(dir);
  });
});
