import { describe, it, expect, vi, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { initPack, buildPack, addPack } from '../../src/commands/packs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// `wairon pack` command family (cli_packs_adapter) — the authoring + ZIP install
// deltas. Mirrors the wrapper-example round-trip: init scaffolds a declarative
// pack, build emits a .wpack, add <that .wpack> extracts + registers it, and the
// deprecated `wairon packs` alias still works (delegating to the same handlers).
// ---------------------------------------------------------------------------

// vitest runs with cwd = repo root (the wrapper-example test relies on this too).
const REPO_ROOT = process.cwd();

const tmpRoots: string[] = [];
function mkTmp(prefix = 'wairon-pack-cmd-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

function writeProject(root: string): void {
  const waiDir = path.join(root, '.wai');
  fs.mkdirSync(path.join(waiDir, 'specs', 'subsystems'), { recursive: true });
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'pack-cmd-project',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: '2026-07-03T12:00:00Z',
    updatedAt: '2026-07-03T12:00:00Z',
  }));
}

afterEach(() => {
  invalidateSpecCache();
  vi.restoreAllMocks();
  // A negative addPack path sets process.exitCode; never let it leak into the run.
  process.exitCode = 0;
});

afterAll(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('pack init', () => {
  it('scaffolds a declarative pack directory', async () => {
    const target = path.join(mkTmp(), 'demo');
    await initPack('demo', { dir: target });

    expect(fs.existsSync(path.join(target, 'wairon-pack.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'pack.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(target, 'wairon-pack.yaml'), 'utf8')).toContain('kind: declarative');
  });
});

describe('pack build', () => {
  it('emits a non-empty .wpack archive from a scaffolded pack directory', async () => {
    const dir = path.join(mkTmp(), 'demo');
    await initPack('demo', { dir });

    const out = path.join(mkTmp(), 'demo.wpack');
    await buildPack(dir, { out });

    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });
});

describe('pack add <file.wpack>', () => {
  it('extracts + registers a built archive (init -> build -> add round-trip)', async () => {
    // Author a pack and build an installable archive.
    const srcDir = path.join(mkTmp(), 'roundtrip');
    await initPack('roundtrip', { dir: srcDir });
    const wpack = path.join(mkTmp(), 'roundtrip.wpack');
    await buildPack(srcDir, { out: wpack });

    // A fresh project WITHOUT the pack — install the archive into it.
    const proj = mkTmp();
    writeProject(proj);
    vi.spyOn(process, 'cwd').mockReturnValue(proj);
    invalidateSpecCache();

    await addPack(wpack);
    expect(process.exitCode ?? 0).toBe(0);

    // The archive was extracted into .wai/packs/<manifest.name>/ ...
    const installed = path.join(proj, '.wai', 'packs', 'roundtrip');
    expect(fs.existsSync(path.join(installed, 'pack.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(installed, 'wairon-pack.yaml'))).toBe(true);
    // ... and the DIRECTORY ref registered in project.yaml.
    expect(fs.readFileSync(path.join(proj, '.wai', 'project.yaml'), 'utf8')).toContain('.wai/packs/roundtrip');
    // No staging directory is left behind.
    expect(fs.readdirSync(path.join(proj, '.wai', 'packs')).some(n => n.startsWith('.wpack-staging-'))).toBe(false);
  });
});

describe('packs (deprecated alias)', () => {
  it('still works: `wairon packs list` warns + delegates to the same list handler', () => {
    const tsxCli = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const cwd = mkTmp('wairon-alias-cwd-');
    const packsDir = mkTmp('wairon-alias-packs-');

    const res = spawnSync(
      process.execPath,
      [tsxCli, path.join(REPO_ROOT, 'src', 'cli', 'index.ts'), 'packs', 'list'],
      { cwd, encoding: 'utf8', env: { ...process.env, WAIRON_PACKS_DIR: packsDir }, timeout: 55000 },
    );

    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    expect(res.status).toBe(0);
    // Delegated to listPacks (its header) ...
    expect(combined).toContain('Extension packs');
    // ... and surfaced the one-line deprecation notice pointing at `wairon pack`.
    expect(combined.toLowerCase()).toContain('deprecated');
    expect(combined).toContain('wairon pack list');
  }, 60000);
});
