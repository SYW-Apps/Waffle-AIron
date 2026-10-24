import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { setProjectRoot, writeFile } from '../../src/utils/fs.js';
import { inspectLock, writeSpecFile, readSpecFile } from '../../src/core/spec-files.js';
import { ownPidNamespace } from '../../src/utils/lock-holder.js';
import { saveSystemSpec, saveSpec, loadSpec, invalidateSpecCache } from '../../src/core/specs.js';
import type { SubsystemSpec } from '../../src/models/index.js';

/** The namespace line this process writes into a lock record (Linux), so a hand-written record reads as local. */
const NS = ownPidNamespace();
const nsTail = NS !== undefined ? `\nnonce\npidns=${NS}\n` : '';

// ---------------------------------------------------------------------------
// Round 10 (the spec write lock). Decided behaviour:
//  1. every write into a .wai tree takes the tree's lock — the store's writes
//     and every other writer that goes through the shared file helper — so a
//     CLI write waits for a session that holds it;
//  2. a spec document another session changed on disk since this process read
//     it is never silently replaced: the write is refused (spec-write-conflict)
//     and the other session's bytes stay;
//  3. a lock file wairon cannot read is broken once it is older than a short
//     grace (10 s), instead of blocking every write for 30 s and never going;
//  4. inspectLock names a present lock, its holder and whether it breaks.
// ---------------------------------------------------------------------------

const now = '2026-10-09T10:00:00.000Z';
let root = '';

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10-lock-'));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id: 'locky', name: 'locky', targets: [], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(dir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'locky', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'locky',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  invalidateSpecCache();
  return dir;
}

// The next lock generation of the tree: one past the highest generation that has ended (the setup's own writes took and released the first ones).
// Written without an .end marker beside it, it is the live lock.
const lockFile = (dir: string): string => {
  const lockDir = path.join(dir, '.wai', '.spec-write.lock');
  fs.mkdirSync(lockDir, { recursive: true });
  const ended = fs.readdirSync(lockDir).map((n) => /^tree\.lock\.(\d+)\.end$/.exec(n)).filter((m) => m !== null).map((m) => Number(m![1]));
  return path.join(lockDir, `tree.lock.${Math.max(0, ...ended) + 1}`);
};

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows locks */ }
  root = '';
});

describe('2 — a write never replaces what another session wrote after this one read it', () => {
  it('a stale save is refused with spec-write-conflict and the other session\'s bytes stay', () => {
    root = project();
    const read = loadSpec('subsystem', 'dom') as SubsystemSpec;
    expect(read.description).toBe('the domain');
    // Another session writes the file after this one read it (bytes outside this process).
    const file = path.join(root, '.wai', 'specs', 'dom', '.index.yaml');
    const theirs = fs.readFileSync(file, 'utf8').replace('description: the domain', 'description: written by the other session');
    fs.writeFileSync(file, theirs);
    // This session saves what it read: refused, never "Updated".
    expect(() => saveSpec('subsystem', { ...read, name: 'dom renamed here' } as SubsystemSpec)).toThrow(/spec-write-conflict/);
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs);
    // Once it reads afresh, the write goes through and keeps both changes.
    invalidateSpecCache();
    const fresh = loadSpec('subsystem', 'dom') as SubsystemSpec;
    saveSpec('subsystem', { ...fresh, name: 'dom renamed here' } as SubsystemSpec);
    const after = readSpecFile(file) as SubsystemSpec;
    expect(after.description).toBe('written by the other session');
    expect(after.name).toBe('dom renamed here');
  });

  it('a raw rewrite through the shared helper is held to the same check', () => {
    root = project();
    const file = path.join(root, '.wai', 'specs', 'dom', '.index.yaml');
    readSpecFile(file);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('the domain', 'theirs'));
    expect(() => writeFile(file, 'id: dom\n')).toThrow(/spec-write-conflict/);
    expect(fs.readFileSync(file, 'utf8')).toContain('theirs');
  });
});

describe('1 — every .wai write takes the tree lock', () => {
  it('a write waits while another process holds the lock, then lands', async () => {
    root = project();
    const lock = lockFile(root);
    // Another process takes the lock for ~600 ms.
    const holder = spawn(process.execPath, ['-e', [
      'const fs=require("fs");',
      `const f=${JSON.stringify(lock)};`,
      'fs.writeFileSync(f, process.pid+"\\n"+Date.now()+"\\n", {flag:"wx"});',
      'console.log("held");',
      'setTimeout(()=>{fs.writeFileSync(f+".end", "", {flag:"wx"});process.exit(0)},600);',
    ].join('')], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout!.once('data', () => resolve()));
    const started = Date.now();
    writeSpecFile(path.join(root, '.wai', 'specs', 'dom', 'note.yaml'), { id: 'note' });
    const waited = Date.now() - started;
    await new Promise((resolve) => holder.once('exit', resolve));
    expect(waited).toBeGreaterThanOrEqual(300);
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'dom', 'note.yaml'))).toBe(true);
    // Released after the write: no live generation is left behind.
    expect(inspectLock(root)).toBeNull();
  }, 20_000);

  it('a file outside any .wai tree is written without a lock', () => {
    root = project();
    fs.writeFileSync(lockFile(root), 'garbage');
    const outside = path.join(root, 'notes.txt');
    writeFile(outside, 'free');
    expect(fs.readFileSync(outside, 'utf8')).toBe('free');
  });
});

describe('3 — a lock wairon cannot read is broken after a short grace (round 10, tinkerer)', () => {
  for (const content of ['', '12345', '{"pid": 99999, "at": "2026-10-01T00:00:00Z"}']) {
    it(`an unreadable lock (${JSON.stringify(content)}) older than 10 s is broken at once`, () => {
      root = project();
      const lock = lockFile(root);
      fs.writeFileSync(lock, content);
      const old = new Date(Date.now() - 15_000);
      fs.utimesSync(lock, old, old);
      expect(inspectLock(root)).toMatchObject({ holder: 'unreadable', breaks: true });
      const started = Date.now();
      writeSpecFile(path.join(root, '.wai', 'specs', 'dom', 'note.yaml'), { id: 'note' });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(inspectLock(root)).toBeNull();
    }, 20_000);
  }

  it('a fresh unreadable lock is a holder mid-write: named, not yet breakable', () => {
    root = project();
    fs.writeFileSync(lockFile(root), '');
    expect(inspectLock(root)).toMatchObject({ holder: 'unreadable', breaks: false });
  });
});

describe('4 — inspectLock names a present lock and its holder', () => {
  it('none, gone and live', () => {
    root = project();
    expect(inspectLock(root)).toBeNull();
    fs.writeFileSync(lockFile(root), `999999\n${Date.now()}\n${nsTail}`);
    expect(inspectLock(root)).toMatchObject({ pid: 999999, holder: 'gone', breaks: true });
    fs.writeFileSync(lockFile(root), `${process.ppid}\n${Date.now()}\n${nsTail}`);
    expect(inspectLock(root)).toMatchObject({ pid: process.ppid, holder: 'live', breaks: false });
  });

  it('an out-of-range pid is unknown, not gone: the lock is held until it is stale', () => {
    root = project();
    // process.kill rejects this id with an error that is not ESRCH.
    fs.writeFileSync(lockFile(root), `99999999999\n${Date.now()}\n${nsTail}`);
    expect(inspectLock(root)).toMatchObject({ pid: 99999999999, holder: 'live', breaks: false });
  });
});
