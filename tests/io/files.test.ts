import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { files } from '../../src/io/index.js';

const temps: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-io-files-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

describe('io/files reading', () => {
  it('reads text, bytes and existence', () => {
    const dir = tmp();
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'héllo');
    expect(files.exists(p)).toBe(true);
    expect(files.exists(path.join(dir, 'nope'))).toBe(false);
    expect(files.readText(p)).toBe('héllo');
    expect(files.readBytes(p).equals(Buffer.from('héllo'))).toBe(true);
  });

  it('readText throws on an absent file; readTextOrNull answers null only for absence', () => {
    const dir = tmp();
    expect(() => files.readText(path.join(dir, 'nope'))).toThrow(/ENOENT/);
    expect(files.readTextOrNull(path.join(dir, 'nope'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    expect(files.readTextOrNull(path.join(dir, 'f', 'deeper'))).toBeNull();
    expect(files.readTextOrNull(path.join(dir, 'f'))).toBe('x');
    // a folder is not absent: the read error surfaces
    expect(() => files.readTextOrNull(dir)).toThrow();
  });

  it('lists names and typed entries', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'f.txt'), '');
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(files.list(dir).sort()).toEqual(['f.txt', 'sub']);
    const entries = files.listEntries(dir).sort((a, b) => a.name.localeCompare(b.name));
    expect(entries.map((e) => [e.name, e.isFile(), e.isDirectory()])).toEqual([
      ['f.txt', true, false],
      ['sub', false, true],
    ]);
  });

  it('stats, statOrNull and lstat', () => {
    const dir = tmp();
    const p = path.join(dir, 'f');
    fs.writeFileSync(p, 'abc');
    expect(files.stat(p).size).toBe(3);
    expect(files.stat(dir).isDirectory()).toBe(true);
    expect(files.statOrNull(p)?.isFile()).toBe(true);
    expect(files.statOrNull(path.join(dir, 'nope'))).toBeUndefined();
    expect(() => files.stat(path.join(dir, 'nope'))).toThrow(/ENOENT/);
    expect(files.lstat(p).isFile()).toBe(true);
  });

  it('resolves real paths and checks writability', () => {
    const dir = tmp();
    const p = path.join(dir, 'f');
    fs.writeFileSync(p, 'x');
    expect(files.realPath(p)).toBe(fs.realpathSync(p));
    expect(files.realPathNative(p)).toBe(fs.realpathSync.native(p));
    expect(() => files.checkWritable(p)).not.toThrow();
    expect(() => files.checkWritable(path.join(dir, 'nope'))).toThrow(/ENOENT/);
  });
});

describe('io/files writing', () => {
  it('writes text and bytes, replacing', () => {
    const dir = tmp();
    const p = path.join(dir, 'f');
    files.writeText(p, 'one');
    files.writeText(p, 'two');
    expect(fs.readFileSync(p, 'utf8')).toBe('two');
    files.writeBytes(p, new Uint8Array([1, 2, 3]));
    expect([...fs.readFileSync(p)]).toEqual([1, 2, 3]);
  });

  it('makes folders: recursive, single, and temporary', () => {
    const dir = tmp();
    files.ensureDir(path.join(dir, 'a', 'b'));
    files.ensureDir(path.join(dir, 'a', 'b'));
    expect(fs.statSync(path.join(dir, 'a', 'b')).isDirectory()).toBe(true);
    files.makeDir(path.join(dir, 'c'));
    expect(() => files.makeDir(path.join(dir, 'c'))).toThrow(/EEXIST/);
    expect(() => files.makeDir(path.join(dir, 'x', 'y'))).toThrow(/ENOENT/);
    const t = files.makeTempDir(path.join(dir, 'tmp-'));
    expect(path.basename(t).startsWith('tmp-')).toBe(true);
    expect(fs.statSync(t).isDirectory()).toBe(true);
  });

  it('renames, copies a file and copies a folder', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'a'), 'A');
    files.rename(path.join(dir, 'a'), path.join(dir, 'b'));
    expect(fs.existsSync(path.join(dir, 'a'))).toBe(false);
    files.copyFile(path.join(dir, 'b'), path.join(dir, 'c'));
    expect(fs.readFileSync(path.join(dir, 'c'), 'utf8')).toBe('A');
    fs.mkdirSync(path.join(dir, 'd', 'e'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'd', 'e', 'f'), 'F');
    files.copy(path.join(dir, 'd'), path.join(dir, 'd2'), { recursive: true });
    expect(fs.readFileSync(path.join(dir, 'd2', 'e', 'f'), 'utf8')).toBe('F');
    expect(() => files.copy(path.join(dir, 'd'), path.join(dir, 'd2'), { recursive: true, errorOnExist: true, force: false })).toThrow();
    files.copy(path.join(dir, 'd'), path.join(dir, 'd3'), { recursive: true, filter: (s) => !s.endsWith('f') });
    expect(fs.existsSync(path.join(dir, 'd3', 'e', 'f'))).toBe(false);
  });

  it('chmod sets mode bits and writeText honours mode', () => {
    if (process.platform === 'win32') return; // POSIX permission bits
    const dir = tmp();
    const p = path.join(dir, 'f');
    files.writeText(p, 'x', { mode: 0o600 });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    files.chmod(p, 0o755);
    expect(fs.statSync(p).mode & 0o777).toBe(0o755);
  });

  it('symlink and readLink round-trip', () => {
    const dir = tmp();
    const target = path.join(dir, 'target');
    fs.writeFileSync(target, 'x');
    const link = path.join(dir, 'link');
    try {
      files.symlink(target, link);
    } catch (e) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) return;
      throw e;
    }
    expect(files.readLink(link)).toBe(target);
    expect(files.lstat(link).isSymbolicLink()).toBe(true);
    expect(() => files.readLink(target)).toThrow();
  });
});

describe('io/files removing', () => {
  it('remove deletes a tree and tolerates absence', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 't', 'u'), { recursive: true });
    files.remove(path.join(dir, 't'));
    expect(fs.existsSync(path.join(dir, 't'))).toBe(false);
    expect(() => files.remove(path.join(dir, 't'))).not.toThrow();
  });

  it('removeFileIfPresent tolerates absence', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'f'), '');
    files.removeFileIfPresent(path.join(dir, 'f'));
    expect(fs.existsSync(path.join(dir, 'f'))).toBe(false);
    expect(() => files.removeFileIfPresent(path.join(dir, 'f'))).not.toThrow();
  });

  it('removeExisting and removeFile throw on absence', () => {
    const dir = tmp();
    expect(() => files.removeExisting(path.join(dir, 'nope'))).toThrow(/ENOENT/);
    expect(() => files.removeExisting(path.join(dir, 'nope'), { recursive: true })).toThrow(/ENOENT/);
    expect(() => files.removeFile(path.join(dir, 'nope'))).toThrow(/ENOENT/);
    fs.writeFileSync(path.join(dir, 'f'), '');
    files.removeExisting(path.join(dir, 'f'));
    expect(fs.existsSync(path.join(dir, 'f'))).toBe(false);
    fs.mkdirSync(path.join(dir, 'd', 'e'), { recursive: true });
    expect(() => files.removeExisting(path.join(dir, 'd'))).toThrow();
    files.removeExisting(path.join(dir, 'd'), { recursive: true });
    expect(fs.existsSync(path.join(dir, 'd'))).toBe(false);
  });

  it('removeEmptyDir refuses a folder that holds something', () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'e'));
    files.removeEmptyDir(path.join(dir, 'e'));
    expect(fs.existsSync(path.join(dir, 'e'))).toBe(false);
    fs.mkdirSync(path.join(dir, 'f'));
    fs.writeFileSync(path.join(dir, 'f', 'x'), '');
    expect(() => files.removeEmptyDir(path.join(dir, 'f'))).toThrow();
  });

  it('removeFileLater removes in the background and never throws', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'f'), '');
    files.removeFileLater(path.join(dir, 'f'));
    files.removeFileLater(path.join(dir, 'nope'));
    for (let i = 0; i < 50 && fs.existsSync(path.join(dir, 'f')); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(path.join(dir, 'f'))).toBe(false);
  });
});

describe('io/files descriptors and streams', () => {
  it('openNew is exclusive', () => {
    const dir = tmp();
    const p = path.join(dir, 'lock');
    const fd = files.openNew(p);
    files.writeDescriptor(fd, 'holder');
    files.closeDescriptor(fd);
    expect(fs.readFileSync(p, 'utf8')).toBe('holder');
    expect(() => files.openNew(p)).toThrow(/EEXIST/);
  });

  it('openForWrite writes text and bytes, syncs, closes', () => {
    const dir = tmp();
    const p = path.join(dir, 'f');
    const fd = files.openForWrite(p);
    try {
      files.writeDescriptor(fd, 'ab');
      files.writeDescriptor(fd, new Uint8Array([99]));
      files.syncDescriptor(fd);
    } finally {
      files.closeDescriptor(fd);
    }
    expect(fs.readFileSync(p, 'utf8')).toBe('abc');
  });

  it('readDescriptorHead reads the first bytes only', () => {
    const dir = tmp();
    const p = path.join(dir, 'f');
    fs.writeFileSync(p, 'abcdefgh');
    const fd = files.openForRead(p);
    try {
      const buffer = Buffer.alloc(4);
      expect(files.readDescriptorHead(fd, buffer, 4)).toBe(4);
      expect(buffer.toString()).toBe('abcd');
    } finally {
      files.closeDescriptor(fd);
    }
  });

  it('openWriteStream writes a file', async () => {
    const dir = tmp();
    const p = path.join(dir, 'f');
    const stream = files.openWriteStream(p);
    await new Promise<void>((resolve) => stream.end('streamed', resolve));
    expect(fs.readFileSync(p, 'utf8')).toBe('streamed');
  });
});
