import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildPack } from '@wairon/sdk';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { discoverPacks } from '../../src/core/index.js';
import * as packs from '../../src/server/packs.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// A hosted archive install that fails while it puts the new pack in place keeps
// the installed one: the copy of the staged pack into the installed folder is
// made to fail (a full disk, a permission error), and the earlier pack must be
// there afterwards with its own content, with nothing extra listed.
// ---------------------------------------------------------------------------

const injected = vi.hoisted(() => ({ failCopy: null as null | ((from: string, to: string) => boolean) }));

vi.mock('../../src/io/files.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/io/files.js')>();
  return {
    ...real,
    copy: (from: string, to: string, options?: Parameters<typeof real.copy>[2]) => {
      if (injected.failCopy?.(from, to)) throw new Error('no space left on device (injected)');
      real.copy(from, to, options);
    },
  };
});

const ADMIN = 'test-admin-secret';

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
    injected.failCopy = (from, to) => path.basename(from).startsWith('wairon-hosted-pack-')
      && !path.basename(from).startsWith('wairon-hosted-pack-backup-')
      && path.resolve(to) === path.resolve(installed);
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
});
