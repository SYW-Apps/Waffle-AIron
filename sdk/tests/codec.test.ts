import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  serializeManifest,
  defaultLimits,
  planExtraction,
  verifyIdentity,
  verifyIntegrity,
  sealIntegrity,
  checkCompatibility,
} from '../src/codec';
import type { ArchiveEntryMeta, PackArchiveManifest, PackFile } from '../src/types';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function fileEntry(path: string, uncompressed = 10, compressed = 10): ArchiveEntryMeta {
  return { path, uncompressedSize: uncompressed, compressedSize: compressed, kind: 'file' };
}

function manifest(overrides: Partial<PackArchiveManifest> = {}): PackArchiveManifest {
  return { formatVersion: 1, name: 'p', version: '1.0.0', kind: 'declarative', entry: 'pack.yaml', ...overrides };
}

describe('planExtraction — the single safety chokepoint', () => {
  const limits = defaultLimits();

  it('accepts a clean archive and sums inflated sizes', () => {
    const plan = planExtraction([fileEntry('wairon-pack.yaml'), fileEntry('pack.yaml')], limits);
    expect(plan.paths).toEqual(['wairon-pack.yaml', 'pack.yaml']);
    expect(plan.totalUncompressedBytes).toBe(20);
  });

  it('rejects zip-slip (..)', () => {
    expect(() => planExtraction([fileEntry('../evil.sh')], limits)).toThrow();
    expect(() => planExtraction([fileEntry('a/../../evil')], limits)).toThrow();
  });

  it('rejects absolute paths', () => {
    expect(() => planExtraction([fileEntry('/etc/passwd')], limits)).toThrow();
  });

  it('rejects backslash and drive-letter paths', () => {
    expect(() => planExtraction([fileEntry('sub\\evil')], limits)).toThrow();
    expect(() => planExtraction([fileEntry('C:\\windows\\evil')], limits)).toThrow();
  });

  it('rejects symlink / non-regular entries', () => {
    expect(() => planExtraction([{ path: 'link', uncompressedSize: 1, compressedSize: 1, kind: 'symlink' }], limits)).toThrow();
  });

  it('rejects oversized entries', () => {
    expect(() => planExtraction([fileEntry('big', 9 * 1024 * 1024, 9 * 1024 * 1024)], limits)).toThrow();
  });

  it('rejects zip bombs (compression ratio)', () => {
    expect(() => planExtraction([fileEntry('bomb', 1024 * 1024, 100)], limits)).toThrow();
  });

  it('rejects too-deep paths', () => {
    const deep = Array.from({ length: 20 }, (_, i) => `d${i}`).join('/') + '/f';
    expect(() => planExtraction([fileEntry(deep)], limits)).toThrow();
  });

  it('rejects archives exceeding the entry-count cap', () => {
    const many = Array.from({ length: 5000 }, (_, i) => fileEntry(`f${i}`, 1, 1));
    expect(() => planExtraction(many, limits)).toThrow();
  });

  it('rejects archives exceeding the total-size cap', () => {
    // Each entry within per-entry cap, but the sum blows the 32 MiB total.
    const chunk = 4 * 1024 * 1024;
    const entries = Array.from({ length: 10 }, (_, i) => fileEntry(`f${i}`, chunk, chunk));
    expect(() => planExtraction(entries, limits)).toThrow();
  });

  it('skips directory entries without approving them', () => {
    const plan = planExtraction(
      [{ path: 'sub/', uncompressedSize: 0, compressedSize: 0, kind: 'dir' }, fileEntry('sub/x')],
      limits,
    );
    expect(plan.paths).toEqual(['sub/x']);
  });

  it('honors caller-tightened caps over the defaults', () => {
    expect(() => planExtraction([fileEntry('a'), fileEntry('b')], { maxEntries: 1 })).toThrow();
  });
});

describe('parseManifest / serializeManifest', () => {
  it('parses a valid envelope', () => {
    const m = parseManifest('formatVersion: 1\nname: p\nversion: 1.0.0\nkind: declarative\nentry: pack.yaml\n');
    expect(m.name).toBe('p');
    expect(m.kind).toBe('declarative');
    expect(m.entry).toBe('pack.yaml');
  });

  it('rejects a newer-major formatVersion', () => {
    expect(() => parseManifest('formatVersion: 2\nname: p\nversion: 1.0.0\nkind: declarative\nentry: pack.yaml\n')).toThrow();
  });

  it('rejects missing / invalid required fields', () => {
    expect(() => parseManifest('name: p\n')).toThrow();
    expect(() => parseManifest('formatVersion: 1\nname: p\nversion: 1.0.0\nkind: bogus\nentry: pack.yaml\n')).toThrow();
  });

  it('round-trips through serialize + parse and drops undefined optionals', () => {
    const text = serializeManifest(manifest({ kind: 'code', entry: 'pack.cjs' }));
    expect(text).not.toContain('minWaironVersion');
    const m = parseManifest(text);
    expect(m.entry).toBe('pack.cjs');
    expect(m.kind).toBe('code');
  });
});

describe('identity + integrity', () => {
  it('verifyIdentity throws on mismatch and passes on match', () => {
    expect(() => verifyIdentity(manifest(), 'other', '1.0.0')).toThrow();
    expect(() => verifyIdentity(manifest(), 'p', '1.0.0')).not.toThrow();
  });

  it('seal then verify integrity round-trips (envelope excluded from digests)', () => {
    const files: PackFile[] = [
      { path: 'pack.yaml', contents: enc('name: p') },
      { path: 'wairon-pack.yaml', contents: enc('formatVersion: 1') },
    ];
    const sealed = sealIntegrity(manifest(), files, '@wairon/sdk@0.0.0', 'now');
    expect(sealed.entryDigests).toBeDefined();
    expect(sealed.entryDigests?.['pack.yaml']).toBeDefined();
    expect(sealed.entryDigests?.['wairon-pack.yaml']).toBeUndefined();
    expect(sealed.digest).toBeDefined();
    expect(verifyIntegrity(sealed, files)).toBe(true);
  });

  it('verifyIntegrity returns false when no integrity data was carried', () => {
    expect(verifyIntegrity(manifest(), [])).toBe(false);
  });

  it('verifyIntegrity throws on a tampered file', () => {
    const files: PackFile[] = [{ path: 'pack.yaml', contents: enc('name: p') }];
    const sealed = sealIntegrity(manifest(), files, 'x', 'y');
    const tampered: PackFile[] = [{ path: 'pack.yaml', contents: enc('name: EVIL') }];
    expect(() => verifyIntegrity(sealed, tampered)).toThrow();
  });
});

describe('checkCompatibility', () => {
  it('true for a supported format with no minimum', () => {
    expect(checkCompatibility(manifest({ kind: 'code', entry: 'e' }), '1.0.0')).toBe(true);
  });

  it('false when the running version is below minWaironVersion', () => {
    expect(checkCompatibility(manifest({ minWaironVersion: '2.0.0' }), '1.0.0')).toBe(false);
  });

  it('true when the running version meets minWaironVersion (range operators tolerated)', () => {
    expect(checkCompatibility(manifest({ minWaironVersion: '^1.0.0' }), '1.4.2')).toBe(true);
  });

  it('false for an unsupported (newer) format', () => {
    expect(checkCompatibility(manifest({ formatVersion: 2 }), '1.0.0')).toBe(false);
  });
});
