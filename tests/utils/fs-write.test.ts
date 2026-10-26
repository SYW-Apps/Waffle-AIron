import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFile, writeFileIfChanged, restoreFile } from '../../src/utils/fs.js';

// A spec file is replaced whole, never truncated and refilled: a reader in
// another process sees the old content or the new, never an emptied file.
describe('writing a file replaces it whole', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-write-')));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A rename puts a new file in place; a write in place keeps the old one.
  const replaced = (file: string, write: () => void): boolean => {
    const before = fs.statSync(file, { bigint: true });
    write();
    const after = fs.statSync(file, { bigint: true });
    return before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs;
  };

  it('writeFile, writeFileIfChanged and restoreFile each put a new file in place', () => {
    const file = path.join(tmp(), 'spec.yaml');
    fs.writeFileSync(file, 'id: a\n');
    expect(replaced(file, () => writeFile(file, 'id: b\n'))).toBe(true);
    expect(replaced(file, () => writeFileIfChanged(file, 'id: c\n'))).toBe(true);
    expect(replaced(file, () => restoreFile(file, Buffer.from('id: d\n')))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('id: d\n');
  });

  it('leaves no temporary file beside the one it wrote', () => {
    const dir = tmp();
    writeFile(path.join(dir, 'spec.yaml'), 'id: a\n');
    writeFile(path.join(dir, 'spec.yaml'), 'id: b\n');
    expect(fs.readdirSync(dir)).toEqual(['spec.yaml']);
  });

  it('keeps the line endings of the file it replaces', () => {
    const file = path.join(tmp(), 'spec.yaml');
    fs.writeFileSync(file, 'id: a\r\nname: A\r\n');
    writeFile(file, 'id: b\nname: B\n');
    expect(fs.readFileSync(file, 'utf8')).toBe('id: b\r\nname: B\r\n');
  });

  it.skipIf(process.platform === 'win32')('keeps an existing file\'s permission bits', () => {
    const file = path.join(tmp(), 'spec.yaml');
    fs.writeFileSync(file, 'id: a\n');
    fs.chmodSync(file, 0o640);
    writeFile(file, 'id: b\n');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });

  it.skipIf(process.platform === 'win32')('writes through a symbolic link to the file it names', () => {
    const dir = tmp();
    const real = path.join(dir, 'real.yaml');
    const link = path.join(dir, 'link.yaml');
    fs.writeFileSync(real, 'id: a\n');
    fs.symlinkSync(real, link);
    writeFile(link, 'id: b\n');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf8')).toBe('id: b\n');
  });
});
