import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { WAIRON_MANAGED_BANNER } from '../../src/exporters/base.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon generate` (cli_runner.runGenerate), two gates:
//
// F84 — the derived context documents are owed whenever the project keeps a
// context directory. Generate used to gate them on the human-written
// project.md, so a project that never wrote one kept a stale wairon-guide.md
// that doctor --fix (which syncs unconditionally) would have refreshed.
//
// F85 — generate writes nothing outside the project root unless asked: a
// target whose output directory resolves outside it is named and skipped,
// write and prune, until --global; then each file it replaces there is backed
// up beside itself.
//
// Real CLI, homes redirected into the temp directory as a precaution.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const now = new Date().toISOString();

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'reach-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
});

function buildProject(rootDir: string, targets: unknown[], rules: Record<string, unknown> = {}): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'reach-system', projectType: 'backend', targets, rules,
    extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'reach-system', vision: 'a generate reach fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', subsystem('dom-a'));
  invalidateSpecCache();
  setProjectRoot(null);
}

describe('cli_runner.runGenerate: context and reach (real CLI)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    for (const dir of dirs.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
    }
  });

  const tmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-gen-reach-'));
    dirs.push(dir);
    return dir;
  };

  const runGenerate = (cwd: string, home: string, ...args: string[]) =>
    execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'generate', ...args], {
      cwd,
      timeout: 180_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), WAIRON_PACKS_DIR: path.join(home, 'packs') },
    });

  it('refreshes a stale derived guide although no project.md exists (F84)', async () => {
    const base = tmp();
    const project = path.join(base, 'project');
    buildProject(project, [{ type: 'claude', outputDir: '.claude/agents', enabled: true }]);
    const guide = path.join(project, '.wai', 'context', 'wairon-guide.md');
    fs.mkdirSync(path.dirname(guide), { recursive: true });
    fs.writeFileSync(guide, '# a guide an older wairon wrote\n', 'utf8');
    expect(fs.existsSync(path.join(project, '.wai', 'context', 'project.md'))).toBe(false);

    await runGenerate(project, path.join(base, 'home'));

    const after = fs.readFileSync(guide, 'utf8');
    expect(after).not.toContain('a guide an older wairon wrote');
    expect(fs.existsSync(path.join(project, '.wai', 'context', 'domains.md'))).toBe(true);
  }, 240_000);

  it('skips a target outside the project root without --global, and writes it with a backup under --global (F85)', async () => {
    const base = tmp();
    const project = path.join(base, 'project');
    const outsideDir = path.join(base, 'shared-agents');
    buildProject(project, [{ type: 'claude', outputDir: '../shared-agents', enabled: true }], { materializeAgentFiles: true });
    const home = path.join(base, 'home');

    // Without --global: named, skipped, nothing written there.
    const skipped = await runGenerate(project, home);
    expect(`${skipped.stdout}${skipped.stderr}`).toContain('Skipped target "claude"');
    expect(fs.existsSync(outsideDir)).toBe(false);

    // A file already there, managed and stale: --global replaces it and keeps the old one.
    const owner = path.join(outsideDir, 'dom-a-owner.md');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(owner, `${WAIRON_MANAGED_BANNER}\nan old brief\n`, 'utf8');

    const written = await runGenerate(project, home, '--global');
    expect(fs.readFileSync(owner, 'utf8')).not.toContain('an old brief');
    const backups = fs.readdirSync(outsideDir).filter((f) => f.startsWith('dom-a-owner.md.wairon-backup-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(outsideDir, backups[0]), 'utf8')).toContain('an old brief');
    expect(written.stdout.replace(/\s+/g, ' ')).toContain(backups[0]);

    // A second --global run replaces nothing, so it leaves no new backup.
    await runGenerate(project, home, '--global');
    expect(fs.readdirSync(outsideDir).filter((f) => f.includes('.wairon-backup-'))).toHaveLength(1);
  }, 240_000);
});
