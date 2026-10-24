import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { withFileLock } from '../../src/utils/file-lock.js';
import { load as loadCredentials, update as updateCredentials } from '../../src/server/credential-store.js';
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

  it('four processes replacing one file at once all get through', async () => {
    const dir = dataDir();
    const file = script(dir, 'replace-file.mts', [
      `const m = await import(${url('src/utils/fs.ts')});`,
      'const { replaceFile } = m.default ?? m;',
      'const [dataDir, who] = process.argv.slice(2);',
      'for (let i = 0; i < 60; i++) replaceFile(`${dataDir}/shared.json`, JSON.stringify({ who, i }));',
    ].join('\n'));
    const runs = await Promise.all(['a', 'b', 'c', 'd'].map((who) => worker(file, [dir, who])));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  }, 60_000);

  it('forty short-lived processes creating one credential each keep every record', async () => {
    // Writers that exit right after their write are what a lock judged by its
    // holder's pid must not mistake: the file it judged may be the next holder's.
    const dir = dataDir();
    const file = script(dir, 'create-one.mts', [
      `const m = await import(${url('src/server/credentials.ts')});`,
      'const { createCredential } = m.default ?? m;',
      'const [dataDir, who] = process.argv.slice(2);',
      'createCredential(dataDir, { id: who, label: who, keyHash: who, projects: ["*"], createdAt: new Date().toISOString() } as never);',
    ].join('\n'));
    const runs = await Promise.all(Array.from({ length: 40 }, (_, i) => worker(file, [dir, `k${i}`])));
    for (const r of runs) expect(r.code, r.out).toBe(0);
    expect(new Set(loadCredentials(dir).map((r) => r.id)).size).toBe(40);
  }, 120_000);

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
  const liveGenerations = (dir: string): string[] => fs.readdirSync(dir)
    .filter((n) => /\.lock\.\d+$/.test(n) && !fs.existsSync(path.join(dir, `${n}.end`)));

  it('a lock its holder left behind on this host, once gone, is taken over', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    // A pid no live process has, written the way a holder writes the lock.
    fs.writeFileSync(`${target}.lock.1`, `999999999\n${Date.now()}\n${os.hostname()}\n`);
    expect(withFileLock(target, () => 'ran')).toBe('ran');
    // The dead holder's generation was ended and cleaned below the one this writer took, which it then ended.
    expect(fs.existsSync(`${target}.lock.1`)).toBe(false);
    expect(fs.existsSync(`${target}.lock.2.end`)).toBe(true);
    expect(liveGenerations(dir)).toEqual([]);
  });

  it('a fresh lock whose pid the platform rejects (out of range) is not taken as gone: it holds until stale', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    // process.kill refuses this id with an error that is not ESRCH: the holder is unknown, so alive.
    fs.writeFileSync(`${target}.lock.1`, `99999999999\n${Date.now()}\n${os.hostname()}\n`);
    // Time is simulated (each wait advances the clock one second) so the test need not sit out the 15 s.
    let skew = 0;
    let waits = 0;
    const ran = withFileLock(target, () => 'ran', {
      now: () => Date.now() + skew,
      sleep: () => { waits++; skew += 1_000; },
    });
    expect(ran).toBe('ran');
    // Broken only by age (past 15 s), never at once as a dead holder.
    expect(waits).toBeGreaterThanOrEqual(14);
  });

  it('a fresh lock held on another host is waited for, not judged by a local pid, and taken over once stale', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    fs.writeFileSync(`${target}.lock.1`, `999999999\n${Date.now()}\nanother-host\n`);
    let skew = 0;
    // Its pid names no live process HERE, but it is another host's: it holds
    // until stale (15 s), within the wait (20 s), so the writer gets through.
    expect(withFileLock(target, () => 'ran', { now: () => Date.now() + skew, sleep: () => { skew += 1_000; } })).toBe('ran');
    expect(skew).toBeGreaterThanOrEqual(14_000);
  });

  it('a holder whose lock was reclaimed as stale leaves the new holder\'s lock in place', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    withFileLock(target, () => {
      // The reclaimer ends this generation and the next holder takes the next name.
      fs.writeFileSync(`${target}.lock.1.end`, '');
      fs.writeFileSync(`${target}.lock.2`, `1\n${Date.now()}\nanother-host\nnew-holder\n`);
    });
    expect(fs.readFileSync(`${target}.lock.2`, 'utf8')).toContain('new-holder');
    expect(fs.existsSync(`${target}.lock.2.end`)).toBe(false);
  });

  it('a store file that exists but does not parse is never written over as an empty set', () => {
    const dir = dataDir();
    const file = path.join(dir, 'auth', 'credentials.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '[{"id":"kept"');
    expect(() => updateCredentials(dir, (records) => [...records, { id: 'new' } as never])).toThrow(/not valid JSON/);
    expect(fs.readFileSync(file, 'utf8')).toBe('[{"id":"kept"');
    expect(liveGenerations(path.dirname(file))).toEqual([]);
  });

  it('a change that throws writes nothing and releases the lock', () => {
    const dir = dataDir();
    const target = path.join(dir, 'records.json');
    expect(() => withFileLock(target, () => { throw new Error('refused'); })).toThrow('refused');
    expect(liveGenerations(dir)).toEqual([]);
  });
});
