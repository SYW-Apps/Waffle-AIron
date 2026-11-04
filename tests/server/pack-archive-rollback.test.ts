import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPack } from '@wairon/sdk';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { discoverPacks, loadProjectConfig, packInstallLockFile as hostLockFile, upsertPackSelection } from '../../src/core/index.js';
import * as packs from '../../src/server/packs.js';
import type { HostConfig } from '../../src/server/types.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { inspectFileLock } from '../../src/utils/file-lock.js';
import { createPlacedProject } from './helpers.js';

// ---------------------------------------------------------------------------
// A hosted archive install that fails while it puts the new pack in place keeps
// the installed one: the copy of the staged pack into the installed folder is
// made to fail (a full disk, a permission error), and the earlier pack must be
// there afterwards with its own content, with nothing extra listed. A temporary
// folder that cannot be removed afterwards never fails an install that placed
// its pack.
// ---------------------------------------------------------------------------

const injected = vi.hoisted(() => ({
  failCopy: null as null | ((from: string, to: string) => boolean),
  // A copy to it writes a pack entry and then fails, as a full disk would part way.
  partialTo: null as null | string,
  failRemove: null as null | ((target: string) => boolean),
  // Each copy records whether this lock file is held at that moment.
  lockFile: null as null | string,
  inspect: null as null | ((file: string) => unknown),
  held: [] as boolean[],
  // The temporary folder the server sees: a worker thread cannot move it through TMPDIR.
  tmpdir: null as null | string,
}));

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  const tmpdir = () => injected.tmpdir ?? real.tmpdir();
  return { ...real, tmpdir, default: { ...real, tmpdir } };
});

vi.mock('../../src/io/files.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/io/files.js')>();
  const nodeFs = await import('node:fs');
  const nodePath = await import('node:path');
  return {
    ...real,
    copy: (from: string, to: string, options?: Parameters<typeof real.copy>[2]) => {
      if (injected.lockFile && injected.inspect) injected.held.push(injected.inspect(injected.lockFile) !== null);
      if (injected.failCopy?.(from, to)) throw new Error('no space left on device (injected)');
      if (injected.partialTo && nodePath.resolve(to) === nodePath.resolve(injected.partialTo)) {
        nodeFs.mkdirSync(to, { recursive: true });
        nodeFs.writeFileSync(nodePath.join(to, 'pack.yaml'), 'name: partial\n');
        throw new Error('no space left on device (injected)');
      }
      real.copy(from, to, options);
    },
    remove: (target: string) => {
      if (injected.failRemove?.(target)) throw new Error('resource busy or locked (injected)');
      real.remove(target);
    },
  };
});

const ADMIN = 'test-admin-secret';

/** Whether a path lies in an install's staging folder, or in its copy aside. */
const inTemp = (kind: 'staging' | 'aside') => (p: string): boolean => path.resolve(p).split(path.sep).some((seg) =>
  kind === 'aside' ? seg.startsWith('wairon-hosted-pack-backup-')
    : seg.startsWith('wairon-hosted-pack-') && !seg.startsWith('wairon-hosted-pack-backup-'));

function declarativeWpack(root: string, name: string, version: string): Uint8Array {
  const pack = path.join(root, `${name}-${version}`);
  fs.mkdirSync(pack, { recursive: true });
  fs.writeFileSync(
    path.join(pack, 'wairon-pack.yaml'),
    ['formatVersion: 1', `name: ${name}`, `version: ${version}`, 'kind: declarative', 'entry: pack.yaml', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(pack, 'pack.yaml'),
    [`name: ${name}`, `version: ${version}`, 'profiles:', '  ddd:', '    family: backend-like', ''].join('\n'),
  );
  return buildPack(pack).archive;
}

describe('a hosted archive install that fails while placing the pack', () => {
  let base: string;
  let packsDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-packroll-'));
    const dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    packsDir = path.join(dataDir, 'packs');
    process.env.WAIRON_ADMIN_TOKEN = ADMIN;
    process.env.WAIRON_PACKS_DIR = packsDir;
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(dataDir, 'image-packs');
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    injected.failCopy = null;
    injected.partialTo = null;
    injected.lockFile = null;
    injected.held = [];
    injected.failRemove = null;
    injected.tmpdir = null;
    invalidateSpecCache();
    process.env = { ...savedEnv };
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps the installed pack with its own content', () => {
    const sources = path.join(base, 'src');
    packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '1.0.0'));
    const installed = path.join(packsDir, 'alpha');
    const before = fs.readFileSync(path.join(installed, 'pack.yaml'), 'utf8');
    expect(before).toMatch(/version: 1\.0\.0/);

    const asideBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wairon-hosted-pack-backup-')));
    // Only the staged pack's copy into the installed folder fails; copying the
    // installed pack aside and back still works.
    injected.failCopy = (from, to) => inTemp('staging')(from) && path.resolve(to) === path.resolve(installed);
    expect(() => packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '2.0.0'))).toThrow(
      /no space left on device/,
    );
    injected.failCopy = null;

    expect(fs.readFileSync(path.join(installed, 'pack.yaml'), 'utf8')).toBe(before);
    expect(discoverPacks(packsDir).map((ref) => path.relative(packsDir, ref))).toEqual(['alpha']);
    expect(packs.listGlobalPacks(cfg, ADMIN).map((p) => p.name)).toEqual(['alpha']);
    // The copy aside is gone once the pack is back.
    expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('wairon-hosted-pack-backup-') && !asideBefore.has(n)))
      .toEqual([]);
  });

  it('never takes its own staging folder for another pack when the packs folder is the temporary folder', () => {
    const sources = path.join(base, 'src');
    const first = declarativeWpack(sources, 'alpha', '1.0.0');
    const second = declarativeWpack(sources, 'alpha', '2.0.0');
    fs.mkdirSync(packsDir, { recursive: true });
    injected.tmpdir = packsDir;
    packs.installGlobalPackArchive(cfg, ADMIN, first);
    packs.installGlobalPackArchive(cfg, ADMIN, second);
    injected.tmpdir = null;
    expect(fs.readFileSync(path.join(packsDir, 'alpha', 'pack.yaml'), 'utf8')).toMatch(/version: 2\.0\.0/);
    // Neither the staging folder nor the copy aside is left behind to list.
    expect(packs.listGlobalPacks(cfg, ADMIN).map((p) => p.name)).toEqual(['alpha']);
    expect(fs.readdirSync(packsDir).filter((n) => !n.startsWith('.install'))).toEqual(['alpha']);
  });

  it('stops before removing anything when the installed pack cannot be copied aside', () => {
    const sources = path.join(base, 'src');
    packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '1.0.0'));
    const installed = path.join(packsDir, 'alpha');
    const before = fs.readFileSync(path.join(installed, 'pack.yaml'), 'utf8');

    injected.failCopy = (from) => path.resolve(from) === path.resolve(installed);
    expect(() => packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '2.0.0'))).toThrow(
      /no space left on device/,
    );
    injected.failCopy = null;

    expect(fs.readFileSync(path.join(installed, 'pack.yaml'), 'utf8')).toBe(before);
  });

  it('keeps the installed pack of a project, and its registration', () => {
    const sources = path.join(base, 'src');
    createPlacedProject(cfg, ADMIN, 'demo');
    const root = path.join(cfg.dataDir, 'projects', 'demo');
    packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack(sources, 'alpha', '1.0.0'));
    const installed = path.join(root, '.wai', 'packs', 'alpha');
    const before = fs.readFileSync(path.join(installed, 'pack.yaml'), 'utf8');

    injected.failCopy = (from, to) => inTemp('staging')(from) && path.resolve(to) === path.resolve(installed);
    expect(() => packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack(sources, 'alpha', '2.0.0'))).toThrow(
      /no space left on device/,
    );
    injected.failCopy = null;

    expect(fs.readFileSync(path.join(installed, 'pack.yaml'), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(root, '.wai', 'packs'))).toEqual(['alpha']);
    expect(runWithProjectRoot(root, () => loadProjectConfig())?.extensions?.packs ?? []).toContain('.wai/packs/alpha');
  });

  it('keeps a copy aside it could not put back where no packs folder lists it', () => {
    const sources = path.join(base, 'src');
    const first = declarativeWpack(sources, 'alpha', '1.0.0');
    const second = declarativeWpack(sources, 'alpha', '2.0.0');
    fs.mkdirSync(packsDir, { recursive: true });
    injected.tmpdir = packsDir;
    packs.installGlobalPackArchive(cfg, ADMIN, first);
    const installed = path.join(packsDir, 'alpha');

    // Both the replacement and the restore fail: the install fails with its own
    // error, and says that the earlier pack is not back and where its copy is.
    injected.failCopy = (_from, to) => path.resolve(to) === path.resolve(installed);
    expect(() => packs.installGlobalPackArchive(cfg, ADMIN, second)).toThrow(
      /^no space left on device \(injected\) Putting the earlier pack "alpha" back failed too \(no space left on device \(injected\)\); its copy is kept in the server's temporary folder as wairon-hosted-pack-backup-\w+\.$/,
    );
    injected.failCopy = null;
    injected.tmpdir = null;

    const kept = fs.readdirSync(packsDir).filter((n) => n.startsWith('wairon-hosted-pack-backup-'));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(packsDir, kept[0], 'held', 'pack', 'pack.yaml'), 'utf8')).toMatch(/version: 1.0.0/);
    // The packs folder is the temporary folder, and still lists no pack from the copy aside.
    expect(discoverPacks(packsDir)).toEqual([]);
    expect(packs.listGlobalPacks(cfg, ADMIN)).toEqual([]);
  });

  it('does not fail an install that placed its pack when a temporary folder cannot be removed', () => {
    const sources = path.join(base, 'src');
    createPlacedProject(cfg, ADMIN, 'demo');
    const root = path.join(cfg.dataDir, 'projects', 'demo');
    packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack(sources, 'alpha', '1.0.0'));

    injected.failRemove = (target) => inTemp('staging')(target) || inTemp('aside')(target);
    const desc = packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack(sources, 'alpha', '2.0.0'));
    packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack(sources, 'beta', '1.0.0'));
    injected.failRemove = null;

    expect(desc.error).toBeUndefined();
    expect(fs.readFileSync(path.join(root, '.wai', 'packs', 'alpha', 'pack.yaml'), 'utf8')).toMatch(/version: 2.0.0/);
    const registered = runWithProjectRoot(root, () => loadProjectConfig())?.extensions?.packs ?? [];
    expect(registered).toEqual(expect.arrayContaining(['.wai/packs/alpha', '.wai/packs/beta']));
  });

  it('removes what a first install wrote before its copy failed, and says so when it cannot', () => {
    const sources = path.join(base, 'src');
    const installed = path.join(packsDir, 'alpha');
    injected.partialTo = installed;
    expect(() => packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '1.0.0'))).toThrow(
      /^no space left on device \(injected\)$/,
    );
    expect(discoverPacks(packsDir)).toEqual([]);

    injected.failRemove = (target) => path.resolve(target) === path.resolve(installed);
    expect(() => packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '1.0.0'))).toThrow(
      /^no space left on device \(injected\) The partial copy "alpha" in the packs folder could not be removed \(resource busy or locked \(injected\)\); remove it before installing again\.$/,
    );
  });

  it('places the pack while it holds the install lock of its packs folder', () => {
    const sources = path.join(base, 'src');
    packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '1.0.0'));
    injected.inspect = inspectFileLock;
    injected.lockFile = hostLockFile(packsDir, 'global');
    packs.installGlobalPackArchive(cfg, ADMIN, declarativeWpack(sources, 'alpha', '2.0.0'));
    // Copy aside, then the staged pack into place.
    expect(injected.held).toEqual([true, true]);

    createPlacedProject(cfg, ADMIN, 'demo');
    const projectPacks = path.join(cfg.dataDir, 'projects', 'demo', '.wai', 'packs');
    injected.lockFile = hostLockFile(projectPacks, 'project');
    injected.held = [];
    packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack(sources, 'beta', '1.0.0'));
    expect(injected.held).toEqual([true]);
    injected.lockFile = null;
  });

  it('refuses an upload into a project under a name the project selects from the pack store', () => {
    const sources = path.join(base, 'src');
    createPlacedProject(cfg, ADMIN, 'demo');
    const root = path.join(cfg.dataDir, 'projects', 'demo');
    runWithProjectRoot(root, () => upsertPackSelection({ name: 'alpha', version: '1.0.0', bundle: true }));
    const bundled = path.join(root, '.wai', 'packs', 'alpha', '1.0.0');
    fs.mkdirSync(bundled, { recursive: true });
    fs.writeFileSync(path.join(bundled, 'pack.yaml'), 'name: alpha\nversion: 1.0.0\n');

    expect(() => packs.installProjectPackArchive(cfg, ADMIN, 'demo', declarativeWpack(sources, 'alpha', '2.0.0'))).toThrow(
      /selects the pack "alpha" from the pack store, so a pack installed under that name would register it twice/,
    );
    expect(fs.readdirSync(path.join(root, '.wai', 'packs', 'alpha'))).toEqual(['1.0.0']);
    expect(runWithProjectRoot(root, () => loadProjectConfig())?.extensions?.packs ?? []).not.toContain('.wai/packs/alpha');

    // A plain YAML install (the route adoption and policy installs share) is refused the same way.
    const yaml = 'name: alpha\nversion: 2.0.0\nprofiles:\n  ddd:\n    family: backend-like\n';
    expect(() => packs.installProjectPack(cfg, ADMIN, 'demo', 'alpha', yaml)).toThrow(/selects the pack "alpha" from the pack store/);
    // Named for the selection while declaring another name: only the selection rule refuses it.
    const zeta = 'name: zeta\nversion: 1.0.0\nprofiles:\n  ddd:\n    family: backend-like\n';
    expect(() => packs.installProjectPack(cfg, ADMIN, 'demo', 'alpha', zeta)).toThrow(/selects the pack "alpha" from the pack store/);
    expect(fs.readdirSync(path.join(root, '.wai', 'packs'))).toEqual(['alpha']);
    const registered = runWithProjectRoot(root, () => loadProjectConfig())?.extensions?.packs ?? [];
    expect(registered.filter((e) => typeof e === 'string')).toEqual([]);
  });
});
