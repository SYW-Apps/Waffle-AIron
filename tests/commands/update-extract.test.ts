import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractArchive, findExtractedBinary } from '../../src/commands/update.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-extract-test-'));
  dirs.push(d);
  return d;
}

describe('findExtractedBinary', () => {
  it('finds the binary at the root', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'wairon.exe'), 'x');
    expect(findExtractedBinary(d, 'wairon.exe')).toBe(path.join(d, 'wairon.exe'));
  });

  it('finds it one folder down', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'wairon-1.0'));
    fs.writeFileSync(path.join(d, 'wairon-1.0', 'wairon.exe'), 'x');
    expect(findExtractedBinary(d, 'wairon.exe')).toBe(path.join(d, 'wairon-1.0', 'wairon.exe'));
  });

  it('answers undefined when it is not there', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a', 'b', 'wairon.exe'), 'x');
    expect(findExtractedBinary(d, 'wairon.exe')).toBeUndefined();
  });
});

describe('extractArchive', () => {
  it('uses tar first and stops when it yields the binary', () => {
    const d = tmp();
    const calls: string[] = [];
    const found = extractArchive('a.zip', d, 'wairon.exe', true, (cmd, args) => {
      calls.push(`${cmd} ${args[0]}`);
      fs.writeFileSync(path.join(d, 'wairon.exe'), 'x');
    });
    expect(found).toBe(path.join(d, 'wairon.exe'));
    expect(calls).toEqual(['tar -xf']);
  });

  it('falls back to PowerShell for a zip, and names both extractors when neither works', () => {
    const d = tmp();
    const calls: string[] = [];
    let message = '';
    try {
      extractArchive('C:\\tmp\\wairon.zip', d, 'wairon.exe', true, (cmd) => {
        calls.push(cmd);
        throw Object.assign(new Error('boom'), { stderr: Buffer.from(`${cmd} failed \n`), status: 1 });
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(calls).toEqual(['tar', 'powershell']);
    expect(message).toContain('C:\\tmp\\wairon.zip');
    expect(message).toContain('tar: exit 1: tar failed');
    expect(message).toContain('powershell Expand-Archive: exit 1: powershell failed');
  });

  it('does not fall back for a tarball', () => {
    const d = tmp();
    const calls: string[] = [];
    expect(() => extractArchive('a.tar.gz', d, 'wairon', false, (cmd, args) => { calls.push(`${cmd} ${args[0]}`); })).toThrow(/a\.tar\.gz/);
    expect(calls).toEqual(['tar -xzf']);
  });
});
