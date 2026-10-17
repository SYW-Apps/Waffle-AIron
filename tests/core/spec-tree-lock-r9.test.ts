import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { lockTree, unlockTree } from '../../src/core/spec-files.js';

// ---------------------------------------------------------------------------
// Round-9 tinkerer (EDGE): two MCP servers writing one spec within ~40 ms lost
// one write while both answered "Updated" — a read-modify-write race with no
// lock and no version check. The tree's write lock (spec_file_store) is a lock
// file created exclusively, which is atomic on every platform, Windows
// included. These run REAL concurrent processes against it.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '..', '..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const STORE = path.join(REPO, 'src', 'core', 'spec-files.ts');

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function tree(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r9-lock-')));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  return dir;
}

/** A writer process: `rounds` read-modify-writes of one counter file, each under the tree's lock unless `unlocked`. */
function writerScript(dir: string, rounds: number, unlocked: boolean): string {
  const file = path.join(dir, `writer-${Math.random().toString(36).slice(2)}.cts`);
  fs.writeFileSync(file, `
const fs = require('fs');
const { lockTree, unlockTree } = require(${JSON.stringify(STORE)});
const root = ${JSON.stringify(dir)};
const counter = ${JSON.stringify(path.join(dir, '.wai', 'specs', 'counter.yaml'))};
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// Both writers start together: ready, then wait for the go.
fs.writeFileSync(${JSON.stringify(file)} + '.ready', '');
while (!fs.existsSync(${JSON.stringify(path.join(dir, 'go'))})) pause(2);
for (let i = 0; i < ${rounds}; i++) {
  if (!${unlocked}) lockTree(root);
  const n = Number(fs.readFileSync(counter, 'utf8'));
  pause(3);
  fs.writeFileSync(counter, String(n + 1));
  if (!${unlocked}) unlockTree(root);
}
`);
  return file;
}

/** Run writers side by side — released together once every one is ready — and wait for all of them. */
async function race(dir: string, scripts: string[]): Promise<number[]> {
  const done = Promise.all(scripts.map((script) => new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [TSX, script], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? 1));
  })));
  const deadline = Date.now() + 60_000;
  while (!scripts.every((s) => fs.existsSync(`${s}.ready`)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(path.join(dir, 'go'), '');
  return done;
}

describe('the spec tree write lock (item 4, EDGE)', () => {
  it('two concurrent writers serialize: every read-modify-write lands', async () => {
    const dir = tree();
    fs.writeFileSync(path.join(dir, '.wai', 'specs', 'counter.yaml'), '0');
    const codes = await race(dir, [writerScript(dir, 60, false), writerScript(dir, 60, false)]);
    expect(codes).toEqual([0, 0]);
    expect(Number(fs.readFileSync(path.join(dir, '.wai', 'specs', 'counter.yaml'), 'utf8'))).toBe(120);
    expect(fs.existsSync(path.join(dir, '.wai', '.spec-write.lock'))).toBe(false);
  }, 120_000);

  it('the same two writers WITHOUT the lock lose writes — the race the lock closes', async () => {
    const dir = tree();
    fs.writeFileSync(path.join(dir, '.wai', 'specs', 'counter.yaml'), '0');
    await race(dir, [writerScript(dir, 60, true), writerScript(dir, 60, true)]);
    expect(Number(fs.readFileSync(path.join(dir, '.wai', 'specs', 'counter.yaml'), 'utf8'))).toBeLessThan(120);
  }, 120_000);

  it('a lock whose holder process is gone is broken at once', () => {
    const dir = tree();
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const deadPid = Number(gone.stdout);
    fs.writeFileSync(path.join(dir, '.wai', '.spec-write.lock'), `${deadPid}\n${Date.now()}\n`);
    const started = Date.now();
    lockTree(dir);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fs.readFileSync(path.join(dir, '.wai', '.spec-write.lock'), 'utf8').split('\n')[0]).toBe(String(process.pid));
    unlockTree(dir);
    expect(fs.existsSync(path.join(dir, '.wai', '.spec-write.lock'))).toBe(false);
  });

  it('is reentrant within one process, and the last release removes the file', () => {
    const dir = tree();
    lockTree(dir);
    lockTree(dir);
    unlockTree(dir);
    expect(fs.existsSync(path.join(dir, '.wai', '.spec-write.lock'))).toBe(true);
    unlockTree(dir);
    expect(fs.existsSync(path.join(dir, '.wai', '.spec-write.lock'))).toBe(false);
  });
});
