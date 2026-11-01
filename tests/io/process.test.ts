import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { processes } from '../../src/io/index.js';

const NODE = process.execPath;

describe('io/process run', () => {
  it('answers standard output as text', () => {
    expect(processes.run(NODE, ['-e', "process.stdout.write('héllo')"])).toBe('héllo');
  });

  it('passes cwd and env', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-io-proc-')));
    try {
      expect(processes.run(NODE, ['-e', 'process.stdout.write(process.cwd())'], { cwd: dir })).toBe(dir);
      expect(processes.run(NODE, ['-e', 'process.stdout.write(process.env.IO_PROBE)'], { env: { ...process.env, IO_PROBE: 'yes' } })).toBe('yes');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a non-zero exit, carrying stderr as text', () => {
    let error: (Error & { stderr?: unknown; status?: number }) | undefined;
    try {
      processes.run(NODE, ['-e', "process.stderr.write('boom'); process.exit(3)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      error = e as typeof error;
    }
    expect(error?.status).toBe(3);
    expect(error?.stderr).toBe('boom');
  });

  it('throws on a missing program', () => {
    expect(() => processes.run('wairon-no-such-program-xyz', [])).toThrow(/ENOENT/);
  });

  it('stops a program that outlives its timeout', () => {
    expect(() => processes.run(NODE, ['-e', 'setTimeout(() => {}, 20000)'], { timeout: 200 })).toThrow();
  });
});

describe('io/process runShell', () => {
  it('runs a command line through the shell', () => {
    expect(processes.runShell(`"${NODE}" -e "process.stdout.write('ok')"`).trim()).toBe('ok');
  });

  it('throws on a non-zero exit', () => {
    expect(() => processes.runShell(`"${NODE}" -e "process.exit(2)"`, { stdio: ['ignore', 'pipe', 'pipe'] })).toThrow();
  });
});

describe('io/process start', () => {
  it('leaves a started program running without waiting', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-io-start-'));
    const marker = path.join(dir, 'ran');
    try {
      processes.start(NODE, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`]);
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(marker)) {
        if (Date.now() > deadline) throw new Error('the started program never ran');
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw for a program that is not there', async () => {
    expect(() => processes.start('wairon-no-such-program-xyz', [])).not.toThrow();
    await new Promise((r) => setTimeout(r, 100)); // the error event is swallowed, not unhandled
  });
});
