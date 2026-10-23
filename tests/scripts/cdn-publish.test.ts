import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
// @ts-expect-error — a plain .mjs script with no declarations
import { channelOf, aliasesOf, rewriteLinks } from '../../scripts/cdn-publish.mjs';

// ---------------------------------------------------------------------------
// The CDN publish script (docs/cdn-release.md): which aliases a version moves,
// how the guides' links resolve, and the release a dry run stages.
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'cdn-publish.mjs');
const BYTES = 'archive bytes';
const DIGEST = crypto.createHash('sha256').update(BYTES).digest('hex');

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

describe('channels and aliases', () => {
  it('a stable version moves latest and its major; a beta or preview moves its channel', () => {
    expect(aliasesOf('6.2.0')).toEqual(['latest', 'v6']);
    expect(aliasesOf('6.3.0-beta.1')).toEqual(['beta']);
    expect(aliasesOf('6.3.0-preview.2')).toEqual(['preview']);
    expect(channelOf('6.2.1-dev.5')).toBe('dev');
  });

  it('an unknown pre-release suffix is refused, not published as stable', () => {
    expect(() => channelOf('6.2.0-rc.1')).toThrow(/neither a release/);
    expect(() => channelOf('not-a-version-beta.1')).toThrow(/neither a release/);
  });
});

describe('guide links', () => {
  const published = new Map([['README.md', 'start.md'], ['docs/cli.md', 'cli.md']]);

  it('a link to a published guide stays in the reader, keeping its fragment', () => {
    expect(rewriteLinks('see [CLI](docs/cli.md#members)', 'README.md', published, '6.2.0')).toBe('see [CLI](cli.md#members)');
  });

  it('any other relative link points at the file on GitHub at the tag', () => {
    expect(rewriteLinks('[s](standards/INDEX.md)', 'docs/cli.md', published, '6.2.0'))
      .toBe('[s](https://github.com/SYW-Apps/Waffle-AIron/blob/v6.2.0/docs/standards/INDEX.md)');
  });

  it('absolute URLs and in-page anchors are left alone', () => {
    const text = '[a](https://example.com/x.md) [b](#usage) [c](mailto:x@y.z)';
    expect(rewriteLinks(text, 'README.md', published, '6.2.0')).toBe(text);
  });
});

describe('a dry run', () => {
  /** A folder holding one linux archive and its .sha256 (a wrong one when corrupt). */
  function stage(version: string, corrupt = false): { art: string; out: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-publish-'));
    temps.push(dir);
    const art = path.join(dir, 'art');
    fs.mkdirSync(art);
    const file = `wairon-${version}-linux-x64.tar.gz`;
    fs.writeFileSync(path.join(art, file), BYTES);
    fs.writeFileSync(path.join(art, `${file}.sha256`), `${corrupt ? '0'.repeat(64) : DIGEST}  ${file}\n`);
    return { art, out: path.join(dir, 'out') };
  }
  const run = (args: string[]): string => execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  const dryRun = (art: string, out: string): string =>
    run(['--version', '6.2.0', '--artifacts', art, '--released', '2026-10-22T12:00:00Z', '--dry-run', out]);

  it('stages version.json, the guides and their manifest, with each archive\'s digest', () => {
    const { art, out } = stage('6.2.0');
    dryRun(art, out);
    const manifest = JSON.parse(fs.readFileSync(path.join(out, 'version.json'), 'utf8'));
    expect(manifest).toMatchObject({ version: '6.2.0', channel: 'stable', released: '2026-10-22T12:00:00Z', docs: 'docs/syw-docs.json' });
    expect(manifest.files).toEqual([{ platform: 'linux-x64', name: 'wairon-6.2.0-linux-x64.tar.gz', sha256: DIGEST, bytes: BYTES.length, checksum: 'wairon-6.2.0-linux-x64.tar.gz.sha256' }]);
    const docs = JSON.parse(fs.readFileSync(path.join(out, 'docs', 'syw-docs.json'), 'utf8'));
    expect(docs.home).toBe('start');
    for (const page of docs.pages) expect(fs.existsSync(path.join(out, 'docs', page.path))).toBe(true);
  });

  it('two runs stage the same bytes, so a re-run republishes identically', () => {
    const staged = [0, 1].map(() => {
      const { art, out } = stage('6.2.0');
      dryRun(art, out);
      return fs.readFileSync(path.join(out, 'version.json'), 'utf8');
    });
    expect(staged[0]).toBe(staged[1]);
  });

  it('an archive that does not match its .sha256 is refused', () => {
    const { art, out } = stage('6.2.0', true);
    expect(() => dryRun(art, out)).toThrow(/does not match its \.sha256/);
  });

  it('a dev build is not published', () => {
    const { art } = stage('6.2.1-dev.1');
    expect(run(['--version', '6.2.1-dev.1', '--artifacts', art])).toMatch(/dev build: not published/);
  });
});
