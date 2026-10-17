import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildTreeArchive, inspectTreeArchive, extractTreeArchive } from '../src/index';
import { assembleArchive } from '../src/archive';
import {
  assertPortableTreePaths,
  planTreeExtraction,
  defaultTreeLimits,
  parseTreeManifest,
  serializeTreeManifest,
  TREE_ENVELOPE_FILENAME,
} from '../src/treecodec';
import type { TreeRootSource } from '../src/types';

// Integration sim: wires the REAL portal -> orchestrator -> tree codec/archive
// stack end to end (only the temp filesystem is real I/O, no mocks).

const tmpRoots: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waitree-'));
  tmpRoots.push(dir);
  return dir;
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

/** A minimal but realistic spec tree at `<root>/.wai`. */
function seedTree(root: string, name: string): string {
  const wai = path.join(root, '.wai');
  write(path.join(wai, 'project.yaml'), `schemaVersion: 1.0.0\nname: ${name}\n`);
  write(path.join(wai, 'specs', '.index.yaml'), `id: ${name}\nname: ${name}\n`);
  write(path.join(wai, 'specs', 'subsystems', 'core.yaml'), `id: core\nparentSystem: ${name}\n`);
  write(path.join(wai, 'lock.json'), '{"stateId":"x"}\n');
  // Regenerable artifacts — must NOT travel by default.
  write(path.join(wai, 'docs', 'diagrams', 'system.mmd'), 'graph TD;\n');
  write(path.join(wai, 'generated', 'topology.json'), '{}\n');
  return wai;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('build -> inspect -> extract (spec tree)', () => {
  it('round-trips a single-root tree, dropping regenerable artifacts', () => {
    const src = mkTmp();
    const wai = seedTree(src, 'demo-system');

    const build = buildTreeArchive([{ relativePath: '.', waiDir: wai }], 'Demo System');
    expect(build.suggestedFileName).toBe('demo-system.waitree');
    expect(build.manifest.projectName).toBe('Demo System');
    expect(build.manifest.roots).toEqual(['.']);
    expect(build.manifest.formatVersion).toBe(1);
    expect(build.manifest.includesDerived).toBe(false);
    expect(build.archive.byteLength).toBeGreaterThan(0);

    const info = inspectTreeArchive(build.archive);
    expect(info.compatible).toBe(true);
    expect(info.manifest.projectName).toBe('Demo System');
    expect(info.entryCount).toBe(build.fileCount + 1); // + the envelope

    const dest = mkTmp();
    const extraction = extractTreeArchive(build.archive, dest);
    expect(extraction.roots).toEqual(['.']);
    expect(fs.readFileSync(path.join(dest, '.wai', 'project.yaml'), 'utf8')).toContain('demo-system');
    expect(fs.existsSync(path.join(dest, '.wai', 'specs', 'subsystems', 'core.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.wai', 'lock.json'))).toBe(true);
    // Derived artifacts stayed behind.
    expect(fs.existsSync(path.join(dest, '.wai', 'docs'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.wai', 'generated'))).toBe(false);
  });

  it('carries regenerable artifacts when the caller asks for them', () => {
    const src = mkTmp();
    const wai = seedTree(src, 'derived-system');

    const build = buildTreeArchive([{ relativePath: '.', waiDir: wai }], 'Derived System', undefined, true);
    expect(build.manifest.includesDerived).toBe(true);

    const dest = mkTmp();
    extractTreeArchive(build.archive, dest);
    expect(fs.existsSync(path.join(dest, '.wai', 'docs', 'diagrams', 'system.mmd'))).toBe(true);
    expect(fs.existsSync(path.join(dest, '.wai', 'generated', 'topology.json'))).toBe(true);
  });

  it('preserves a chained subproject layout across the move', () => {
    const src = mkTmp();
    const parentWai = seedTree(src, 'parent-system');
    const childWai = seedTree(path.join(src, 'packages', 'billing'), 'billing');

    const roots: TreeRootSource[] = [
      { relativePath: '.', waiDir: parentWai },
      { relativePath: 'packages/billing', waiDir: childWai },
    ];
    const build = buildTreeArchive(roots, 'Parent System', 'sha256-abc');
    expect(build.manifest.roots).toEqual(['.', 'packages/billing']);
    expect(build.manifest.stateId).toBe('sha256-abc');

    const dest = mkTmp();
    const extraction = extractTreeArchive(build.archive, dest);
    expect(extraction.roots).toEqual(['.', 'packages/billing']);
    expect(fs.existsSync(path.join(dest, '.wai', 'project.yaml'))).toBe(true);
    expect(fs.readFileSync(path.join(dest, 'packages', 'billing', '.wai', 'project.yaml'), 'utf8'))
      .toContain('billing');
  });

  it('stamps + verifies per-entry integrity, and refuses a tampered archive', () => {
    const src = mkTmp();
    const wai = seedTree(src, 'sealed-system');
    const build = buildTreeArchive([{ relativePath: '.', waiDir: wai }], 'Sealed System');

    expect(build.manifest.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(build.manifest.entryDigests ?? {}).length).toBe(build.fileCount);
    expect(build.manifest.entryDigests?.[TREE_ENVELOPE_FILENAME]).toBeUndefined();

    // Re-assemble with the SAME (sealed) envelope but a mutated payload file.
    const envelope = serializeTreeManifest(build.manifest);
    const tampered = assembleArchive([
      { path: TREE_ENVELOPE_FILENAME, contents: new TextEncoder().encode(envelope) },
      { path: '.wai/project.yaml', contents: new TextEncoder().encode('schemaVersion: 1.0.0\nname: not-what-was-sealed\n') },
    ]);
    expect(() => extractTreeArchive(tampered, mkTmp())).toThrow(/integrity digest mismatch/);
  });

  it('refuses an archive with no spec-tree files rather than exporting nothing', () => {
    const src = mkTmp();
    const wai = path.join(src, '.wai');
    // Only regenerable artifacts — everything portable filters out.
    write(path.join(wai, 'docs', 'topology.md'), '# generated\n');
    expect(() => buildTreeArchive([{ relativePath: '.', waiDir: wai }], 'Empty System')).toThrow(
      /found no spec-tree files/,
    );
  });

  it('refuses an archive that is not a .waitree', () => {
    const notATree = assembleArchive([{ path: 'readme.md', contents: new TextEncoder().encode('hi') }]);
    expect(() => inspectTreeArchive(notATree)).toThrow(/missing wairon-tree.yaml/);
  });
});

describe('tree safety guards', () => {
  it('rejects zip-slip, symlink, oversized, and zip-bomb entries before inflating', () => {
    const limits = defaultTreeLimits();
    const slip = [{ path: '../escape/.wai/x.yaml', uncompressedSize: 10, compressedSize: 10, kind: 'file' }];
    expect(() => planTreeExtraction(slip, limits)).toThrow(/unsafe or oversized/);

    const link = [{ path: '.wai/link', uncompressedSize: 10, compressedSize: 10, kind: 'symlink' }];
    expect(() => planTreeExtraction(link, limits)).toThrow(/unsafe or oversized/);

    const huge = [{ path: '.wai/big.yaml', uncompressedSize: 9 * 1024 * 1024, compressedSize: 9 * 1024 * 1024, kind: 'file' }];
    expect(() => planTreeExtraction(huge, limits)).toThrow(/unsafe or oversized/);

    const bomb = [{ path: '.wai/bomb.yaml', uncompressedSize: 1024 * 1024, compressedSize: 100, kind: 'file' }];
    expect(() => planTreeExtraction(bomb, limits)).toThrow(/unsafe or oversized/);
  });

  it('accepts a realistic multi-root plan under the tree caps', () => {
    const entries = [
      { path: TREE_ENVELOPE_FILENAME, uncompressedSize: 400, compressedSize: 200, kind: 'file' },
      { path: '.wai/specs/subsystems/a.yaml', uncompressedSize: 900, compressedSize: 300, kind: 'file' },
      { path: 'packages/b/.wai/specs/subsystems/b.yaml', uncompressedSize: 900, compressedSize: 300, kind: 'file' },
      { path: '.wai/specs/', uncompressedSize: 0, compressedSize: 0, kind: 'dir' },
    ];
    const plan = planTreeExtraction(entries, defaultTreeLimits());
    expect(plan.paths).toHaveLength(3); // the dir marker is structural, never inflated
    expect(plan.totalUncompressedBytes).toBe(2200);
  });

  it('refuses executable content over the wire, but only when the guard is asked for', () => {
    const withCodePack = [TREE_ENVELOPE_FILENAME, '.wai/specs/x.yaml', '.wai/packs/evil/rules.cjs'];
    expect(() => assertPortableTreePaths(withCodePack)).toThrow(/executable content/);
    // The same paths pass the pure plan — the guard is a separate, opt-in decision.
    const entries = withCodePack.map((p) => ({ path: p, uncompressedSize: 10, compressedSize: 10, kind: 'file' }));
    expect(planTreeExtraction(entries, defaultTreeLimits()).paths).toHaveLength(3);
  });

  it('refuses entries outside any spec-tree root', () => {
    expect(() => assertPortableTreePaths([TREE_ENVELOPE_FILENAME, 'src/index.ts'])).toThrow(
      /outside any spec-tree root/,
    );
    expect(() => assertPortableTreePaths([TREE_ENVELOPE_FILENAME, '.wai/specs/x.yaml'])).not.toThrow();
  });

  it('refuses an executable riding inside a hosted-style extraction', () => {
    const archive = assembleArchive([
      {
        path: TREE_ENVELOPE_FILENAME,
        contents: new TextEncoder().encode(
          serializeTreeManifest({ formatVersion: 1, projectName: 'x', roots: ['.'] }),
        ),
      },
      { path: '.wai/project.yaml', contents: new TextEncoder().encode('name: x\n') },
      { path: '.wai/packs/evil/rules.cjs', contents: new TextEncoder().encode('module.exports={}') },
    ]);
    const dest = mkTmp();
    expect(() => extractTreeArchive(archive, dest, undefined, true)).toThrow(/executable content/);
    // Nothing was written — the guard runs before a single entry is inflated.
    expect(fs.existsSync(path.join(dest, '.wai'))).toBe(false);
  });
});

describe('tree envelope', () => {
  it('round-trips through serialize/parse and rejects a newer major', () => {
    const manifest = {
      formatVersion: 1,
      projectName: 'Round Trip',
      roots: ['.', 'packages/x'],
      stateId: 'sha256-1',
      waironVersion: '5.1.1',
    };
    expect(parseTreeManifest(serializeTreeManifest(manifest))).toEqual(manifest);
    expect(() => parseTreeManifest('formatVersion: 2\nprojectName: x\nroots: ["."]\n')).toThrow(
      /unsupported tree-archive formatVersion/,
    );
    expect(() => parseTreeManifest('formatVersion: 1\nprojectName: x\n')).toThrow(/roots must be/);
  });
});
