import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { writeClinic } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Round 8 (platform): a refused member command printed "✖ … Nothing was
// written." and the shell read success. Every member and family-migration
// command that writes nothing because it was refused — or because nothing
// could confirm it — exits non-zero; a report, an empty plan and an applied
// one exit zero.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
});

/** The CLI in a folder, stdin not a terminal; answers its exit status and everything it printed. */
function run(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function clinic(): string {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r8-exit-')));
  dirs.push(top);
  return writeClinic(path.join(top, 'clinic')).root;
}

describe('round 8 — a refused member command exits non-zero', () => {
  it('member add refused (an alias the grammar refuses): exit 1, nothing written', () => {
    const root = clinic();
    const before = fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8');
    const r = run(root, 'member', 'add', 'Bad Alias', 'services/x');
    expect(r.out).toMatch(/Refusing to create the member/);
    expect(r.status).toBe(1);
    expect(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8')).toBe(before);
  }, 120_000);

  it('member update of a member that is no git member: exit 1', () => {
    const r = run(clinic(), 'member', 'update', 'scheduling');
    expect(r.status).toBe(1);
  }, 120_000);

  it('a refused family migration exits 1, with --report too', () => {
    const root = clinic();
    expect(run(root, 'member', 'demote', 'nosuch', '--report').status).toBe(1);
    expect(run(root, 'member', 'promote', 'nosuch', '--yes').status).toBe(1);
    expect(run(root, 'subsystem', 'externalize', 'nosuch', '--path', 'x', '--report').status).toBe(1);
  }, 240_000);

  it('a migration nothing could confirm (no terminal, no --yes) exits 1 and writes nothing; its --report exits 0', () => {
    const root = clinic();
    const before = fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8');
    const unconfirmed = run(root, 'member', 'promote', 'scheduling');
    expect(unconfirmed.out).toMatch(/re-run with --yes/);
    expect(unconfirmed.status).toBe(1);
    expect(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8')).toBe(before);
    expect(run(root, 'member', 'promote', 'scheduling', '--report').status).toBe(0);
  }, 240_000);
});
