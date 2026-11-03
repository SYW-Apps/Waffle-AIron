import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import { addPack } from '../../src/commands/packs.js';
import { installPackFromDirectory, packInstallLockFile } from '../../src/core/index.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { logger } from '../../src/utils/logger.js';

// ---------------------------------------------------------------------------
// `wairon pack add` and the pack store's install write into the same packs
// folders the hosted server installs into: each takes the folder's install lock
// (the file core names for every installer) and refuses a pack whose declared
// name another pack there already declares, while a reinstall of the same file,
// folder or version refreshes it.
// ---------------------------------------------------------------------------

const tmpRoots: string[] = [];
function mkTmp(prefix = 'wairon-pack-lock-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

const packYaml = (name: string, version = '1.0.0'): string =>
  [`name: ${name}`, `version: ${version}`, 'profiles:', '  ddd:', '    family: backend-like', ''].join('\n');

/** A declarative archive whose envelope names `envelope` while its pack.yaml declares `inner`. */
function wpack(dir: string, envelope: string, inner: string): string {
  const file = path.join(dir, `${envelope}.wpack`);
  const enc = (s: string) => new TextEncoder().encode(s);
  fs.writeFileSync(file, zipSync({
    'wairon-pack.yaml': enc(['formatVersion: 1', `name: ${envelope}`, 'version: 1.0.0', 'kind: declarative', 'entry: pack.yaml', ''].join('\n')),
    'pack.yaml': enc(packYaml(inner)),
  }));
  return file;
}

function writeProject(root: string): void {
  const waiDir = path.join(root, '.wai');
  fs.mkdirSync(path.join(waiDir, 'specs', 'subsystems'), { recursive: true });
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'pack-lock-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: '2026-11-03T12:00:00Z',
    updatedAt: '2026-11-03T12:00:00Z',
  }));
}

/** The entries of a packs folder that are packs, not the install lock's files. */
const packEntries = (dir: string): string[] => fs.readdirSync(dir).filter((n) => !n.startsWith('.')).sort();

let packsDir: string;
let sources: string;
let errors: string[];
const savedPacksDir = process.env.WAIRON_PACKS_DIR;

beforeEach(() => {
  packsDir = path.join(mkTmp(), 'packs');
  sources = mkTmp('wairon-pack-src-');
  process.env.WAIRON_PACKS_DIR = packsDir;
  errors = [];
  vi.spyOn(logger, 'error').mockImplementation((m: unknown) => { errors.push(String(m)); });
  vi.spyOn(logger, 'success').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  invalidateSpecCache();
  vi.restoreAllMocks();
  process.exitCode = 0;
  if (savedPacksDir === undefined) delete process.env.WAIRON_PACKS_DIR;
  else process.env.WAIRON_PACKS_DIR = savedPacksDir;
});

afterAll(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('pack add --global', () => {
  it('refuses a second pack declaring an installed name, and a reinstall refreshes', async () => {
    const first = path.join(sources, 'a.yaml');
    fs.writeFileSync(first, packYaml('shared'));
    await addPack(first, true, true);
    expect(process.exitCode ?? 0).toBe(0);

    const second = path.join(sources, 'b.yaml');
    fs.writeFileSync(second, packYaml('shared'));
    await addPack(second, true, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/declaring the name "shared" is already installed as "a\.yaml"/);
    expect(errors.join('\n')).toMatch(/wairon pack remove a\.yaml --global/);
    expect(packEntries(packsDir)).toEqual(['a.yaml']);

    process.exitCode = 0;
    fs.writeFileSync(first, packYaml('shared', '2.0.0'));
    await addPack(first, true, true);
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(path.join(packsDir, 'a.yaml'), 'utf8')).toMatch(/version: 2\.0\.0/);
  });

  it('judges an archive by the name its pack declares', async () => {
    fs.mkdirSync(packsDir, { recursive: true });
    fs.writeFileSync(path.join(packsDir, 'alpha.yaml'), packYaml('alpha'));
    await addPack(wpack(sources, 'beta', 'alpha'), true, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/declaring the name "alpha" is already installed as "alpha\.yaml"/);
    expect(packEntries(packsDir)).toEqual(['alpha.yaml']);
  });

  it('holds the install lock every installer of the folder takes', async () => {
    const first = path.join(sources, 'a.yaml');
    fs.writeFileSync(first, packYaml('a'));
    await addPack(first, true, true);
    const lock = packInstallLockFile(packsDir, 'global');
    expect(path.dirname(lock)).toBe(packsDir);
    expect(fs.readdirSync(packsDir).some((n) => n.startsWith(`${path.basename(lock)}.lock.`))).toBe(true);
  });
});

describe('pack add into a project', () => {
  it('refuses a second pack declaring a name already in .wai/packs, with the lock kept out of it', async () => {
    const proj = mkTmp();
    writeProject(proj);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    invalidateSpecCache();

    const first = path.join(sources, 'a.yaml');
    fs.writeFileSync(first, packYaml('shared'));
    await addPack(first, false, true);
    expect(process.exitCode ?? 0).toBe(0);

    const second = path.join(sources, 'b.yaml');
    fs.writeFileSync(second, packYaml('shared'));
    await addPack(second, false, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/declaring the name "shared" is already installed as "a\.yaml"/);
    // Only the first pack is vendored or registered; the lock lives in the ignored lock folder.
    expect(fs.readdirSync(path.join(proj, '.wai', 'packs'))).toEqual(['a.yaml']);
    expect(fs.readFileSync(path.join(proj, '.wai', 'project.yaml'), 'utf8')).not.toContain('b.yaml');
    expect(fs.existsSync(path.join(proj, '.wai', '.spec-write.lock'))).toBe(true);
  });
});

describe('the pack store install', () => {
  it('refuses a pack another entry of the folder already declares, and reinstalls a version', () => {
    fs.mkdirSync(packsDir, { recursive: true });
    fs.writeFileSync(path.join(packsDir, 'legacy.yaml'), packYaml('shared'));
    const dir = path.join(sources, 'shared');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), packYaml('shared'));
    expect(() => installPackFromDirectory(dir)).toThrow(/declaring the name "shared" is already installed as "legacy\.yaml"/);
    expect(packEntries(packsDir)).toEqual(['legacy.yaml']);

    fs.rmSync(path.join(packsDir, 'legacy.yaml'));
    installPackFromDirectory(dir);
    installPackFromDirectory(dir);
    expect(fs.existsSync(path.join(packsDir, 'shared', '1.0.0', 'pack.yaml'))).toBe(true);
    expect(packEntries(packsDir)).toEqual(['shared']);
  });
});
