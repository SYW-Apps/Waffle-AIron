import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as memberRegistration from '../../src/server/members.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { mintUserToken } from './helpers.js';
import { buildHostedFamily } from './hosted-family.js';

// ---------------------------------------------------------------------------
// The family transaction's commit holds each affected host-store file's write
// lock for the stage and the swap: a store update in ANOTHER process that holds
// a store's lock makes the swap wait for it, instead of the swap replacing the
// file under that writer. The holder here is a separate process that takes
// projects.json's lock, tells the test, and keeps it for a while.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '../..');
const TSX = path.join(REPO, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const HOLD_MS = 1500;
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA'] as const;

describe('family_transaction.commit holds the host stores\' locks', () => {
  let base: string;
  let dataDir: string;
  let savedEnv: (readonly [string, string | undefined])[];

  beforeEach(() => {
    savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-swap-locks-'));
    for (const k of ENV_KEYS) process.env[k] = path.join(base, 'home');
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    buildHostedFamily(dataDir);
    mintUserToken(dataDir, { id: 'k-q', userId: 'u-q', projects: ['platform::billing'] });
    invalidateSpecCache();
  });
  afterEach(() => {
    invalidateSpecCache();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  it('a member upgrade waits for another process that holds projects.json\'s lock, then applies', async () => {
    const planned = memberRegistration.plan(dataDir);
    expect(planned.refusals).toEqual([]);

    const target = path.join(dataDir, 'projects.json');
    const script = path.join(base, 'hold.mts');
    const lockUrl = new URL(`file:///${path.join(REPO, 'src/utils/file-lock.ts').replace(/\\/g, '/')}`).href;
    fs.writeFileSync(script, [
      `const m0 = await import(${JSON.stringify(lockUrl)});`,
      'const m = m0.default ?? m0;',
      `const handle = m.acquireFileLock(${JSON.stringify(target)});`,
      'console.log("held");',
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});`,
      'm.releaseFileLock(handle);',
    ].join('\n'));
    const child = spawn(process.execPath, [TSX, script], { cwd: REPO });
    await new Promise<void>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; if (out.includes('held')) resolve(); });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', () => reject(new Error(`the holder exited without holding the lock: ${out}`)));
    });
    const startedAt = Date.now();
    const report = memberRegistration.apply({ dataDir }, planned);
    const waited = Date.now() - startedAt;

    expect(report.applied).toBe(true);
    // The swap could only start once the holder let go.
    expect(waited).toBeGreaterThan(HOLD_MS - 600);
    child.kill();
  }, 60_000);
});
