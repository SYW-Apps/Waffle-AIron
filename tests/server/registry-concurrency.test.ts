import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { withFileLock } from '../../src/utils/fs.js';
import { load as loadCredentials } from '../../src/server/credential-store.js';
import { listProjectRecords } from '../../src/server/projects.js';

// ---------------------------------------------------------------------------
// The hosted registries under concurrent writers in SEPARATE processes: each
// read-change-write holds the file's write lock, so no writer's record is lost
// (an external review reproduced the lost update on the unlocked stores). Real
// processes, real files; nothing mocked.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '../..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-concurrency-'));
  temps.push(dir);
  return dir;
}

/** Run one worker script in its own node process; resolves with its exit code and output. */
function worker(script: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, script, ...args], { cwd: REPO });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * A worker script in the scratch folder, importing the module under test by
 * absolute URL (outside the repo it loads as CommonJS, so its exports may sit on default).
 */
function script(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

const url = (rel: string): string => JSON.stringify(new URL(`file:///${path.join(REPO, rel).replace(/\\/g, '/')}`).href);

describe('concurrent writers in separate processes', () => {
  it('four processes creating credentials at once keep every record', async () => {
    const dir = dataDir();
    const file = script(dir, 'create-credentials.mts', [
      `const m = await import(${url('src/server/credentials.ts')});`,
      'const { createCredential } = m.default ?? m;',
      'const [dataDir, who] = process.argv.slice(2);',
      'for (let i = 0; i < 15; i++) {',
      '  createCredential(dataDir, { id: `${who}-${i}`, label: who, keyHash: `${who}${i}`, projects: ["*"], createdAt: new Date().toISOString() } as never);',
      '}',
    ].join('\n'));
    const runs = await Promise.all(['a', 'b', 'c', 'd'].map((who) => worker(file, [dir, who])));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    const ids = loadCredentials(dir).map((r) => r.id);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
  }, 60_000);

  it('four processes registering project records at once keep every record', async () => {
    const dir = dataDir();
    const file = script(dir, 'register-projects.mts', [
      `const m = await import(${url('src/server/projects.ts')});`,
      'const { registerProjectRecord } = m.default ?? m;',
      'const [dataDir, who] = process.argv.slice(2);',
      'for (let i = 0; i < 15; i++) registerProjectRecord(dataDir, `${who}-${i}`, `/roots/${who}-${i}`);',
    ].join('\n'));
    const runs = await Promise.all(['a', 'b', 'c', 'd'].map((who) => worker(file, [dir, who])));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    expect(listProjectRecords(dir)).toHaveLength(60);
  }, 60_000);
});

describe('the data file write lock', () => {
  it('a lock its holder left behind on this host, once gone, is taken over', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    // A pid no live process has, written the way a holder writes the lock.
    fs.writeFileSync(`${target}.lock`, `999999999\n${Date.now()}\n${os.hostname()}\n`);
    expect(withFileLock(target, () => 'ran')).toBe('ran');
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
  });

  it('a fresh lock held on another host is waited for, not judged by a local pid', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    fs.writeFileSync(`${target}.lock`, `999999999\n${Date.now()}\nanother-host\n`);
    const started = Date.now();
    expect(() => withFileLock(target, () => 'ran')).toThrow(/being written by another process/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
  }, 20_000);

  it('a change that throws writes nothing and releases the lock', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    expect(() => withFileLock(target, () => { throw new Error('refused'); })).toThrow('refused');
    expect(fs.existsSync(`${target}.lock`)).toBe(false);
  });
});
