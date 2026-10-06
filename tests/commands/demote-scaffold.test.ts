import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { writeClinic } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// `member demote` takes away the session scaffold `member promote` gave the
// member's folder (round-2 tinkerer trial: orphaned "you are operating inside
// wairon" files in a folder that is no project root any more). A file holding
// someone else's content is kept, and said so.
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

function run(cwd: string, ...args: string[]): string {
  return execFileSync(process.execPath, [TSX_CLI, WAIRON_CLI, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('wairon member demote', () => {
  it('removes the guide, skills, root pointer and .mcp.json a promote wrote, keeping what someone else wrote', () => {
    const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-demote-scaffold-')));
    dirs.push(top);
    execFileSync('git', ['init', '-q'], { cwd: top });
    const { root, part } = writeClinic(path.join(top, 'clinic'));
    run(root, 'member', 'promote', 'scheduling', '--yes');
    expect(fs.existsSync(path.join(part, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(part, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(fs.existsSync(path.join(part, 'CLAUDE.md'))).toBe(true);
    // Someone else's server beside wairon's: the file stays, its wairon entry goes.
    const mcp = JSON.parse(fs.readFileSync(path.join(part, '.mcp.json'), 'utf-8'));
    mcp.mcpServers.other = { command: 'other-server' };
    fs.writeFileSync(path.join(part, '.mcp.json'), JSON.stringify(mcp, null, 2));

    const out = run(root, 'member', 'demote', 'scheduling', '--yes');
    expect(out).toMatch(/is a part now, not a project root/);
    expect(fs.existsSync(path.join(part, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(part, '.claude', 'skills', 'sdd-architect'))).toBe(false);
    expect(fs.existsSync(path.join(part, 'CLAUDE.md'))).toBe(false);
    const kept = JSON.parse(fs.readFileSync(path.join(part, '.mcp.json'), 'utf-8'));
    expect(kept.mcpServers).toEqual({ other: { command: 'other-server' } });
  }, 240_000);
});
