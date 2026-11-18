import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import inquirer from 'inquirer';
import { addPack, bundlePack, installPack, usePack } from '../../src/commands/packs.js';
import { installPackFromDirectory, packInstallLockFile } from '../../src/core/index.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { logger } from '../../src/utils/logger.js';
import { inspectFileLock } from '../../src/utils/file-lock.js';

// Every copy into a packs folder reports whether the folder's install lock is
// held at that moment, so a test can see the write happen under it. A copy to
// `partialTo` writes a pack entry there and then fails, as a full disk would
// part way; a removal of `failRemove`, once it exists, fails.
const watched = vi.hoisted(() => ({
  lockFile: null as null | string,
  held: [] as boolean[],
  inspect: null as null | ((f: string) => unknown),
  partialTo: null as null | string,
  // When set, only a copy from this source to `partialTo` fails.
  partialFrom: null as null | string,
  failRemove: null as null | string,
  // The temporary folder the commands see: a worker thread cannot move it through TMPDIR.
  tmpdir: null as null | string,
}));

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  const tmpdir = () => watched.tmpdir ?? real.tmpdir();
  return { ...real, tmpdir, default: { ...real, tmpdir } };
});

vi.mock('../../src/io/files.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/io/files.js')>();
  const nodeFs = await import('fs');
  const nodePath = await import('path');
  return {
    ...real,
    copy: (from: string, to: string, options?: Parameters<typeof real.copy>[2]) => {
      if (watched.lockFile && watched.inspect) watched.held.push(watched.inspect(watched.lockFile) !== null);
      if (watched.partialTo && nodePath.resolve(to) === nodePath.resolve(watched.partialTo)
        && (!watched.partialFrom || nodePath.resolve(from) === nodePath.resolve(watched.partialFrom))) {
        nodeFs.mkdirSync(to, { recursive: true });
        nodeFs.writeFileSync(nodePath.join(to, 'pack.yaml'), 'name: partial\n');
        throw new Error('no space left on device (injected)');
      }
      real.copy(from, to, options);
    },
    remove: (target: string) => {
      if (watched.failRemove && nodePath.resolve(target) === nodePath.resolve(watched.failRemove) && nodeFs.existsSync(target)) {
        throw new Error('resource busy or locked (injected)');
      }
      real.remove(target);
    },
  };
});

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

function writeProject(root: string, packs?: unknown[]): void {
  const waiDir = path.join(root, '.wai');
  fs.mkdirSync(path.join(waiDir, 'specs', 'subsystems'), { recursive: true });
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'pack-lock-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    ...(packs ? { extensions: { packs } } : {}),
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
  watched.lockFile = null;
  watched.held = [];
  watched.partialTo = null;
  watched.partialFrom = null;
  watched.failRemove = null;
  watched.tmpdir = null;
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

  it('refuses an archive whose envelope and pack name disagree, leaving the existing pack', async () => {
    fs.mkdirSync(packsDir, { recursive: true });
    fs.writeFileSync(path.join(packsDir, 'alpha.yaml'), packYaml('alpha'));
    await addPack(wpack(sources, 'beta', 'alpha'), true, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/identity mismatch/);
    expect(packEntries(packsDir)).toEqual(['alpha.yaml']);
  });

  it('copies the pack in while it holds the install lock every installer of the folder takes', async () => {
    const first = path.join(sources, 'a.yaml');
    fs.writeFileSync(first, packYaml('a'));
    const lock = packInstallLockFile(packsDir, 'global');
    expect(path.dirname(lock)).toBe(packsDir);
    watched.inspect = inspectFileLock;
    watched.lockFile = lock;
    await addPack(first, true, true);
    watched.lockFile = null;
    expect(process.exitCode ?? 0).toBe(0);
    expect(watched.held).toEqual([true]);
    // Released afterwards.
    expect(inspectFileLock(lock)).toBeNull();
  });

  it('counts the packs folder when the source folder holds it', async () => {
    const source = path.join(sources, 'outer');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'pack.yaml'), packYaml('shared'));
    packsDir = path.join(source, 'packs');
    process.env.WAIRON_PACKS_DIR = packsDir;
    fs.mkdirSync(packsDir, { recursive: true });
    fs.writeFileSync(path.join(packsDir, 'a.yaml'), packYaml('shared'));
    await addPack(source, true, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/declaring the name "shared" is already installed as "a\.yaml"/);
    expect(packEntries(packsDir)).toEqual(['a.yaml']);
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

  it('refuses a pack under a name the project selects from the pack store, from a folder or an archive', async () => {
    const proj = mkTmp();
    writeProject(proj, [{ name: 'shared', version: '1.0.0', bundle: true }]);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    invalidateSpecCache();
    const bundled = path.join(proj, '.wai', 'packs', 'shared', '1.0.0');
    fs.mkdirSync(bundled, { recursive: true });
    fs.writeFileSync(path.join(bundled, 'pack.yaml'), packYaml('shared'));

    // A folder named for the selection, declaring another name: it would replace the bundle.
    const folder = path.join(sources, 'shared');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'pack.yaml'), packYaml('other'));
    await addPack(folder, false, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/selects the pack "shared" from the pack store/);
    expect(errors.join('\n')).toMatch(/wairon pack unuse shared/);

    // Another folder name declaring the selected name: the selection is named, not the bundle.
    process.exitCode = 0;
    errors.length = 0;
    const elsewhere = path.join(sources, 'elsewhere');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'pack.yaml'), packYaml('shared'));
    await addPack(elsewhere, false, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/selects the pack "shared" from the pack store/);
    expect(errors.join('\n')).not.toMatch(/already installed as/);

    process.exitCode = 0;
    errors.length = 0;
    await addPack(wpack(sources, 'shared', 'shared'), false, true);
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/selects the pack "shared" from the pack store/);

    // The bundle is untouched and nothing was registered by path.
    expect(fs.readdirSync(path.join(proj, '.wai', 'packs', 'shared'))).toEqual(['1.0.0']);
    expect(fs.readFileSync(path.join(proj, '.wai', 'project.yaml'), 'utf8')).not.toContain('.wai/packs/shared');
  });
});

describe('pack bundle', () => {
  function storePack(name: string, version: string): void {
    const dir = path.join(sources, `${name}-${version}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), packYaml(name, version));
    installPackFromDirectory(dir);
  }

  it('refuses a bundle another pack in .wai/packs already declares, and bundles a new version over an old one', async () => {
    storePack('shared', '1.0.0');
    storePack('shared', '2.0.0');
    const proj = mkTmp();
    writeProject(proj, [{ name: 'shared', version: '1.0.0' }]);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    invalidateSpecCache();
    const projectPacks = path.join(proj, '.wai', 'packs');
    fs.mkdirSync(projectPacks, { recursive: true });
    fs.writeFileSync(path.join(projectPacks, 'legacy.yaml'), packYaml('shared'));

    bundlePack('shared');
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/declaring the name "shared" is already installed as "legacy\.yaml"/);
    expect(fs.existsSync(path.join(projectPacks, 'shared'))).toBe(false);

    process.exitCode = 0;
    fs.rmSync(path.join(projectPacks, 'legacy.yaml'));
    bundlePack('shared');
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.existsSync(path.join(projectPacks, 'shared', '1.0.0', 'pack.yaml'))).toBe(true);

    // Another version of the same pack is its own name folder: a refresh, never a clash.
    writeProject(proj, [{ name: 'shared', version: '2.0.0' }]);
    invalidateSpecCache();
    bundlePack('shared');
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.existsSync(path.join(projectPacks, 'shared', '2.0.0', 'pack.yaml'))).toBe(true);
  });

  it('refuses to bundle into a folder that holds a pack added by path', () => {
    storePack('shared', '1.0.0');
    const proj = mkTmp();
    writeProject(proj, [{ name: 'shared', version: '1.0.0' }]);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    invalidateSpecCache();
    const added = path.join(proj, '.wai', 'packs', 'shared');
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, 'pack.yaml'), packYaml('shared'));

    bundlePack('shared');
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/\.wai\/packs\/shared holds a pack added by path/);
    expect(errors.join('\n')).toMatch(/wairon pack remove shared/);
    expect(fs.readdirSync(added)).toEqual(['pack.yaml']);
    expect(fs.readFileSync(path.join(proj, '.wai', 'project.yaml'), 'utf8')).not.toMatch(/"bundle"\s*:\s*true|bundle: true/);
  });

  it('pack use refuses a pack the project already has added by path, by its name or its folder name', async () => {
    storePack('shared', '1.0.0');
    const proj = mkTmp();
    const added = path.join(proj, '.wai', 'packs', 'mine');
    fs.mkdirSync(added, { recursive: true });
    fs.writeFileSync(path.join(added, 'pack.yaml'), packYaml('shared'));
    writeProject(proj, ['.wai/packs/mine']);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    invalidateSpecCache();

    await usePack('shared', { yes: true });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/already has the pack "shared" added by path \(\.wai\/packs\/mine\)/);
    expect(errors.join('\n')).toMatch(/wairon pack remove shared/);
    expect(fs.readFileSync(path.join(proj, '.wai', 'project.yaml'), 'utf8')).not.toMatch(/name: shared|"name":\s*"shared"/);

    // A path reference whose file name is the pack's name counts as well.
    process.exitCode = 0;
    errors.length = 0;
    fs.writeFileSync(path.join(proj, '.wai', 'packs', 'shared.yaml'), 'not: a pack\n');
    writeProject(proj, ['.wai/packs/shared.yaml']);
    invalidateSpecCache();
    await usePack('shared', { yes: true });
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/added by path \(\.wai\/packs\/shared\.yaml\)/);

    // With no such pack the selection is recorded.
    process.exitCode = 0;
    writeProject(proj);
    invalidateSpecCache();
    await usePack('shared', { yes: true });
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.readFileSync(path.join(proj, '.wai', 'project.yaml'), 'utf8')).toMatch(/shared/);
  });

  it('pack use checks again under the install lock for a pack added by path while it asked', async () => {
    storePack('shared', '1.0.0');
    const proj = mkTmp();
    writeProject(proj);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    invalidateSpecCache();
    const added = path.join(proj, '.wai', 'packs', 'mine');
    const lock = packInstallLockFile(path.join(proj, '.wai', 'packs'), 'project');
    let heldWhileAsking: unknown = 'unset';
    // While the question is open, another command adds the pack by path.
    vi.spyOn(inquirer, 'prompt').mockImplementation((async () => {
      heldWhileAsking = inspectFileLock(lock);
      fs.mkdirSync(added, { recursive: true });
      fs.writeFileSync(path.join(added, 'pack.yaml'), packYaml('shared'));
      writeProject(proj, ['.wai/packs/mine']);
      invalidateSpecCache();
      return { confirmed: true };
    }) as unknown as typeof inquirer.prompt);
    const stdinTty = process.stdin.isTTY;
    const stdoutTty = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await usePack('shared');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: stdinTty, configurable: true });
      Object.defineProperty(process.stdout, 'isTTY', { value: stdoutTty, configurable: true });
    }
    // The question is asked without the lock; the write is refused under it.
    expect(heldWhileAsking).toBeNull();
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/already has the pack "shared" added by path \(\.wai\/packs\/mine\)/);
    const config = fs.readFileSync(path.join(proj, '.wai', 'project.yaml'), 'utf8');
    expect(config).toContain('.wai/packs/mine');
    expect(config).not.toMatch(/name: shared|"name":\s*"shared"/);
    expect(inspectFileLock(lock)).toBeNull();
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

  it('refuses a source that is itself an entry of the store, since it would list beside the copy', () => {
    const inside = path.join(packsDir, 'shared-src');
    fs.mkdirSync(inside, { recursive: true });
    fs.writeFileSync(path.join(inside, 'pack.yaml'), packYaml('shared'));
    expect(() => installPackFromDirectory(inside)).toThrow(/declaring the name "shared" is already installed as "shared-src"/);
    expect(packEntries(packsDir)).toEqual(['shared-src']);
  });

  it('copies, digests and records while it holds the store install lock', () => {
    const dir = path.join(sources, 'shared');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), packYaml('shared'));
    fs.mkdirSync(packsDir, { recursive: true });
    const lock = packInstallLockFile(packsDir, 'global');
    watched.inspect = inspectFileLock;
    watched.lockFile = lock;
    installPackFromDirectory(dir);
    watched.lockFile = null;
    expect(watched.held).toEqual([true]);
    expect(inspectFileLock(lock)).toBeNull();
  });

  it('removes a version it could not finish copying, and says so when it cannot', () => {
    const dir = path.join(sources, 'shared');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), packYaml('shared'));
    const dest = path.join(packsDir, 'shared', '1.0.0');

    watched.partialTo = dest;
    expect(() => installPackFromDirectory(dir)).toThrow(/^no space left on device \(injected\)$/);
    expect(fs.existsSync(dest)).toBe(false);

    watched.failRemove = dest;
    expect(() => installPackFromDirectory(dir)).toThrow(/no space left on device \(injected\) The partial copy at .* could not be removed \(resource busy or locked \(injected\)\)/);
    watched.failRemove = null;
    watched.partialTo = null;

    installPackFromDirectory(dir);
    expect(fs.readFileSync(path.join(dest, 'pack.yaml'), 'utf8')).toBe(packYaml('shared'));
  });

  it('keeps the installed version when its reinstall fails, and names the copy it could not put back', () => {
    const temp = mkTmp('wairon-pack-tmp-');
    watched.tmpdir = temp;
    const dir = path.join(sources, 'shared');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), packYaml('shared'));
    installPackFromDirectory(dir);
    const dest = path.join(packsDir, 'shared', '1.0.0');
    const earlier = fs.readFileSync(path.join(dest, 'pack.yaml'), 'utf8');

    // The replacement's copy fails part way: the earlier version comes back.
    fs.writeFileSync(path.join(dir, 'pack.yaml'), `${packYaml('shared')}# changed\n`);
    watched.partialTo = dest;
    watched.partialFrom = dir;
    expect(() => installPackFromDirectory(dir)).toThrow(/^no space left on device \(injected\)$/);
    expect(fs.readFileSync(path.join(dest, 'pack.yaml'), 'utf8')).toBe(earlier);
    expect(fs.readdirSync(temp)).toEqual([]);

    // Putting it back fails too: its copy is kept in the temporary folder and named.
    watched.partialFrom = null;
    let message = '';
    try { installPackFromDirectory(dir); } catch (e) { message = (e as Error).message; }
    const kept = fs.readdirSync(temp);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^wairon-packstore-backup-/);
    expect(message).toContain(`Putting the earlier version back failed too (no space left on device (injected)); its copy is kept in the system temporary folder as ${kept[0]}.`);
    expect(fs.readFileSync(path.join(temp, kept[0], 'held', 'pack', 'pack.yaml'), 'utf8')).toBe(earlier);
    // The partial copy the failed restore wrote is not left to be listed.
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('installs an archive whose temporary extraction lies in the store itself', async () => {
    const outside = mkTmp();
    vi.spyOn(process, 'cwd').mockReturnValue(outside);
    const archive = wpack(sources, 'shared', 'shared');
    fs.mkdirSync(packsDir, { recursive: true });
    watched.tmpdir = packsDir;
    await installPack(archive, true);
    watched.tmpdir = null;
    expect(errors).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(fs.existsSync(path.join(packsDir, 'shared', '1.0.0', 'pack.yaml'))).toBe(true);
    expect(packEntries(packsDir)).toEqual(['shared']);
  });
});
