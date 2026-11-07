import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldPack, buildPack, inspectArchive, extractPack, readPack, PackArchiveError } from '../src/index';
import { createHash } from 'crypto';
import { assembleArchive } from '../src/archive';

// readPack + the PackArchiveError codes, through the real portal -> orchestrator -> codec stack.

const tmpRoots: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wpack-rp-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const envelope = (extra = ''): string =>
  `formatVersion: 1\nname: demo\nversion: 1.0.0\nkind: declarative\nentry: pack.yaml\n${extra}`;
const innerOk = enc('name: demo\nversion: 1.0.0\n');

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackArchiveError);
    return (err as PackArchiveError).code;
  }
  return undefined;
}

describe('readPack', () => {
  it('reads a declarative pack in memory', () => {
    const srcDir = path.join(mkTmp(), 'demo');
    scaffoldPack({ name: 'demo', version: '1.2.3', kind: 'declarative', targetDir: srcDir });
    const { archive } = buildPack(srcDir);
    const contents = readPack(archive);
    expect(contents.manifest.name).toBe('demo');
    expect(contents.packManifest.name).toBe('demo');
    expect(contents.packManifest.version).toBe('1.2.3');
    expect(contents.files.some((f) => f.path === 'pack.yaml')).toBe(true);
    expect(contents.files.some((f) => f.path === 'wairon-pack.yaml')).toBe(true);
  });

  it('reads a code pack: packManifest is package.json', () => {
    const srcDir = path.join(mkTmp(), 'coded');
    scaffoldPack({ name: 'coded', version: '0.3.0', kind: 'code', targetDir: srcDir });
    const { archive } = buildPack(srcDir);
    const contents = readPack(archive);
    expect(contents.manifest.kind).toBe('code');
    expect(contents.packManifest.name).toBe('coded');
    expect(contents.packManifest.version).toBe('0.3.0');
  });

  it('NOT_A_PACK without an envelope (readPack and inspectArchive)', () => {
    const zip = assembleArchive([{ path: 'foo.txt', contents: enc('hi') }]);
    expect(codeOf(() => readPack(zip))).toBe('NOT_A_PACK');
    expect(codeOf(() => inspectArchive(zip))).toBe('NOT_A_PACK');
  });

  it('NOT_A_PACK for bytes that are not a readable ZIP', () => {
    const junk = enc('this is not a zip archive at all');
    expect(codeOf(() => readPack(junk))).toBe('NOT_A_PACK');
    expect(codeOf(() => inspectArchive(junk))).toBe('NOT_A_PACK');
  });

  it('UNSAFE_PATH for a traversal entry', () => {
    const zip = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope()) },
      { path: 'a/../evil.txt', contents: enc('x') },
    ]);
    expect(codeOf(() => readPack(zip))).toBe('UNSAFE_PATH');
  });

  it('LIMIT_EXCEEDED for an archive over a cap', () => {
    const zip = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope()) },
      { path: 'pack.yaml', contents: innerOk },
    ]);
    expect(codeOf(() => readPack(zip, { maxEntries: 1 }))).toBe('LIMIT_EXCEEDED');
  });

  it('ENVELOPE_INVALID for a malformed, non-mapping or incomplete envelope', () => {
    const list = assembleArchive([{ path: 'wairon-pack.yaml', contents: enc('- just\n- a list\n') }]);
    expect(codeOf(() => readPack(list))).toBe('ENVELOPE_INVALID');
    const broken = assembleArchive([{ path: 'wairon-pack.yaml', contents: enc('a: [unclosed\n') }]);
    expect(codeOf(() => readPack(broken))).toBe('ENVELOPE_INVALID');
    const missing = assembleArchive([{ path: 'wairon-pack.yaml', contents: enc('formatVersion: 1\nname: x\n') }]);
    expect(codeOf(() => inspectArchive(missing))).toBe('ENVELOPE_INVALID');
  });

  it('FORMAT_VERSION_UNSUPPORTED for a newer format', () => {
    const zip = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope().replace('formatVersion: 1', 'formatVersion: 9')) },
    ]);
    expect(codeOf(() => readPack(zip))).toBe('FORMAT_VERSION_UNSUPPORTED');
  });

  it('PACK_MANIFEST_INVALID when the inner manifest is missing or not a mapping', () => {
    const missing = assembleArchive([{ path: 'wairon-pack.yaml', contents: enc(envelope()) }]);
    expect(codeOf(() => readPack(missing))).toBe('PACK_MANIFEST_INVALID');
    const scalar = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope()) },
      { path: 'pack.yaml', contents: enc('just a string') },
    ]);
    expect(codeOf(() => readPack(scalar))).toBe('PACK_MANIFEST_INVALID');
  });

  it('IDENTITY_MISMATCH on readPack and extractPack, before anything is written', () => {
    const zip = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope()) },
      { path: 'pack.yaml', contents: enc('name: other\nversion: 1.0.0\n') },
    ]);
    expect(codeOf(() => readPack(zip))).toBe('IDENTITY_MISMATCH');
    const dest = path.join(mkTmp(), 'never');
    expect(codeOf(() => extractPack(zip, dest))).toBe('IDENTITY_MISMATCH');
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('DIGEST_MISMATCH for tampered content', () => {
    const entryDigests = `entryDigests:\n  pack.yaml: ${'f'.repeat(64)}\n`;
    const zip = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope(entryDigests)) },
      { path: 'pack.yaml', contents: innerOk },
    ]);
    expect(codeOf(() => readPack(zip))).toBe('DIGEST_MISMATCH');
  });

  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

  it('DIGEST_MISMATCH when entryDigests lists a file the archive does not hold', () => {
    const entryDigests = `entryDigests:\n  pack.yaml: ${sha(innerOk)}\n  extra.yaml: ${'f'.repeat(64)}\n`;
    const zip = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope(entryDigests)) },
      { path: 'pack.yaml', contents: innerOk },
    ]);
    expect(codeOf(() => readPack(zip))).toBe('DIGEST_MISMATCH');
  });

  it('DIGEST_MISMATCH when the overall digest differs from the entry digests', () => {
    const entryDigests = `entryDigests:\n  pack.yaml: ${sha(innerOk)}\ndigest: ${'f'.repeat(64)}\n`;
    const zip = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope(entryDigests)) },
      { path: 'pack.yaml', contents: innerOk },
    ]);
    expect(codeOf(() => readPack(zip))).toBe('DIGEST_MISMATCH');
  });

  it('a built pack carries no build time and rebuilds byte for byte', () => {
    const srcDir = path.join(mkTmp(), 'demo');
    scaffoldPack({ name: 'demo', version: '1.2.3', kind: 'declarative', targetDir: srcDir });
    const first = buildPack(srcDir);
    const second = buildPack(srcDir);
    expect(readPack(first.archive).manifest.generatedAt).toBeUndefined();
    expect(Buffer.from(second.archive).equals(Buffer.from(first.archive))).toBe(true);
  });

  it('ENVELOPE_INVALID for an integrity field that is not a string', () => {
    const numericDigest = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope(`digest: ${'0'.repeat(64)}\n`)) },
      { path: 'pack.yaml', contents: innerOk },
    ]);
    expect(codeOf(() => readPack(numericDigest))).toBe('ENVELOPE_INVALID');
    const numericEntry = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope(`entryDigests:\n  pack.yaml: ${'0'.repeat(64)}\n`)) },
      { path: 'pack.yaml', contents: innerOk },
    ]);
    expect(codeOf(() => readPack(numericEntry))).toBe('ENVELOPE_INVALID');
    const listed = assembleArchive([
      { path: 'wairon-pack.yaml', contents: enc(envelope('entryDigests:\n  - pack.yaml\n')) },
      { path: 'pack.yaml', contents: innerOk },
    ]);
    expect(codeOf(() => readPack(listed))).toBe('ENVELOPE_INVALID');
  });

  it('inspectArchive refuses an oversized envelope before inflating it', () => {
    const big = envelope() + '# ' + 'x'.repeat(4000) + '\n';
    const zip = assembleArchive([{ path: 'wairon-pack.yaml', contents: enc(big) }]);
    expect(codeOf(() => inspectArchive(zip, { maxEntryBytes: 100 }))).toBe('LIMIT_EXCEEDED');
  });
});
