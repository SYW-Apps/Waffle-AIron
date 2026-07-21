import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldPack, buildPack, inspectArchive, extractPack } from '../src/index';
import { assembleArchive } from '../src/archive';

// Integration sim: wires the REAL portal -> orchestrator -> codec/scaffold/archive
// stack end to end (only the temp filesystem is real I/O, no mocks).

const tmpRoots: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpack-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('scaffold -> build -> inspect -> extract (declarative)', () => {
  it('round-trips a small declarative pack', () => {
    const srcDir = path.join(mkTmp(), 'demo');
    const created = scaffoldPack({ name: 'demo', version: '1.2.3', kind: 'declarative', targetDir: srcDir });
    expect(created.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(srcDir, 'wairon-pack.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(srcDir, 'pack.yaml'))).toBe(true);

    const build = buildPack(srcDir);
    expect(build.suggestedFileName).toBe('demo-1.2.3.wpack');
    expect(build.info.name).toBe('demo');
    expect(build.info.version).toBe('1.2.3');
    expect(build.info.kind).toBe('declarative');
    expect(build.info.compatible).toBe(true);
    expect(build.archive.byteLength).toBeGreaterThan(0);

    const info = inspectArchive(build.archive);
    expect(info.name).toBe('demo');
    expect(info.version).toBe('1.2.3');
    expect(info.entry).toBe('pack.yaml');
    expect(info.formatVersion).toBe(1);
    expect(info.compatible).toBe(true);
    expect(info.entryCount).toBeGreaterThan(0);

    const dest = path.join(mkTmp(), 'installed');
    const result = extractPack(build.archive, dest);
    expect(result.name).toBe('demo');
    expect(result.kind).toBe('declarative');
    expect(result.entryPath).toBe('pack.yaml');
    expect(result.directory).toBe(path.resolve(dest));
    expect(fs.existsSync(path.join(dest, 'pack.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'wairon-pack.yaml'))).toBe(true);

    // The extracted pack.yaml is byte-identical to the source pack.yaml.
    expect(fs.readFileSync(path.join(dest, 'pack.yaml'), 'utf8'))
      .toBe(fs.readFileSync(path.join(srcDir, 'pack.yaml'), 'utf8'));
  });

  it('withSkill packs carry the skill file through the round trip', () => {
    const srcDir = path.join(mkTmp(), 'skilled');
    scaffoldPack({ name: 'skilled', version: '0.1.0', kind: 'declarative', targetDir: srcDir, withSkill: true });
    const build = buildPack(srcDir);
    const dest = path.join(mkTmp(), 'out');
    const result = extractPack(build.archive, dest);
    expect(result.entryCount).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(path.join(dest, 'skills', 'skilled', 'SKILL.md'))).toBe(true);
  });
});

describe('build failure + inspect guards', () => {
  it('buildPack rejects a directory with no envelope', () => {
    const dir = path.join(mkTmp(), 'no-envelope');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pack.yaml'), 'name: x\nversion: 1.0.0\n');
    expect(() => buildPack(dir)).toThrow(/envelope/);
  });

  it('inspectArchive rejects a plain zip with no envelope', () => {
    const zip = assembleArchive([{ path: 'foo.txt', contents: new TextEncoder().encode('hi') }]);
    expect(() => inspectArchive(zip)).toThrow(/wpack/);
  });
});
