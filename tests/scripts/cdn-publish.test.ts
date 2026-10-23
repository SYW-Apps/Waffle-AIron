import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
// @ts-expect-error — a plain .mjs script with no declarations
import { channelOf, aliasesOf, rewriteLinks, planAliases, checkRequestBudget, REQUEST_BUDGET_BYTES } from '../../scripts/cdn-publish.mjs';

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

describe('alias safety', () => {
  it('moves every alias that is free or points at an older version', () => {
    expect(planAliases('6.1.4', { latest: null, v6: null })).toEqual({ move: ['latest', 'v6'], skipped: [] });
    expect(planAliases('6.1.4', { latest: '6.1.3', v6: '6.0.9' })).toEqual({ move: ['latest', 'v6'], skipped: [] });
    expect(planAliases('6.1.4', {})).toEqual({ move: ['latest', 'v6'], skipped: [] });
  });

  it('moving to the version an alias already holds is allowed (an identical republish)', () => {
    expect(planAliases('6.1.4', { latest: '6.1.4', v6: '6.1.4' }).move).toEqual(['latest', 'v6']);
  });

  it('does not move an alias back over a newer version', () => {
    expect(planAliases('6.1.3', { latest: '6.1.4', v6: '6.1.4' })).toEqual({ move: [], skipped: [{ alias: 'latest', newer: '6.1.4' }, { alias: 'v6', newer: '6.1.4' }] });
  });

  it('a newer release of another major only holds latest back', () => {
    expect(planAliases('6.1.4', { latest: '7.0.0', v6: '6.1.3' })).toEqual({ move: ['v6'], skipped: [{ alias: 'latest', newer: '7.0.0' }] });
  });

  it('compares a pre-release only within its own channel', () => {
    expect(planAliases('6.2.0-beta.1', { beta: '6.3.0' })).toEqual({ move: ['beta'], skipped: [] });
    expect(planAliases('6.2.0-beta.1', { beta: '6.2.0-beta.2' })).toEqual({ move: [], skipped: [{ alias: 'beta', newer: '6.2.0-beta.2' }] });
  });
});

describe('request budget', () => {
  it('refuses a body over the 90,000,000-byte budget and passes one at it', () => {
    expect(REQUEST_BUDGET_BYTES).toBe(90_000_000);
    expect(() => checkRequestBudget('6.1.4-linux-x64', 90_000_001)).toThrow(/over the 90000000-byte request budget/);
    expect(() => checkRequestBudget('6.1.4-linux-x64', 90_000_000)).not.toThrow();
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
  const TARGETS: Array<[string, string]> = [
    ['windows-x64', '.zip'], ['linux-x64', '.tar.gz'], ['linux-arm64', '.tar.gz'], ['macos-x64', '.tar.gz'], ['macos-arm64', '.tar.gz'],
  ];
  /** A folder holding the five archives and their .sha256 (a wrong one on the first when corrupt). */
  function stage(version: string, opts: { corrupt?: boolean; skip?: string; extra?: string } = {}): { art: string; out: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-publish-'));
    temps.push(dir);
    const art = path.join(dir, 'art');
    fs.mkdirSync(art);
    const put = (file: string, wrong = false): void => {
      fs.writeFileSync(path.join(art, file), BYTES);
      fs.writeFileSync(path.join(art, `${file}.sha256`), `${wrong ? '0'.repeat(64) : DIGEST}  ${file}\n`);
    };
    TARGETS.forEach(([target, ext], i) => {
      if (target !== opts.skip) put(`wairon-${version}-${target}${ext}`, opts.corrupt && i === 0);
    });
    if (opts.extra) put(opts.extra);
    return { art, out: path.join(dir, 'out') };
  }
  const run = (args: string[]): string => execFileSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' });
  const dryRun = (art: string, out: string): string =>
    run(['--version', '6.2.0', '--artifacts', art, '--released', '2026-10-22T12:00:00Z', '--app', 'wairon', '--dry-run', out]);
  const read = (out: string, ...p: string[]): string => fs.readFileSync(path.join(out, ...p), 'utf8');

  it('stages one release per platform, with no aliases, and the index release', () => {
    const { art, out } = stage('6.2.0');
    dryRun(art, out);
    expect(fs.readdirSync(out).sort()).toEqual(
      ['6.2.0', ...TARGETS.map(([t]) => `6.2.0-${t}`)].sort());
    for (const [target, ext] of TARGETS) {
      const dir = path.join(out, `6.2.0-${target}`);
      const file = `wairon-6.2.0-${target}${ext}`;
      expect(fs.readdirSync(dir).sort()).toEqual([file, `${file}.sha256`, 'request.json'].sort());
      const request = JSON.parse(read(out, `6.2.0-${target}`, 'request.json'));
      expect(request).toMatchObject({ version: `6.2.0-${target}`, aliases: [], files: [file, `${file}.sha256`] });
      expect(request.bodyBytes).toBeLessThan(request.budgetBytes);
    }
    const index = JSON.parse(read(out, '6.2.0', 'request.json'));
    expect(index.aliases).toEqual(['latest', 'v6']);
    expect(index.files).toContain('version.json');
    expect(index.files).toContain('docs/syw-docs.json');
    expect(index.files.some((f: string) => f.endsWith('.zip') || f.endsWith('.tar.gz'))).toBe(false);
  });

  it('version.json names each archive by its exact platform-release URL', () => {
    const { art, out } = stage('6.2.0');
    dryRun(art, out);
    const manifest = JSON.parse(read(out, '6.2.0', 'version.json'));
    expect(manifest).toMatchObject({ schemaVersion: 2, version: '6.2.0', channel: 'stable', released: '2026-10-22T12:00:00Z', docs: 'docs/syw-docs.json' });
    expect(manifest.files).toHaveLength(5);
    const linux = manifest.files.find((f: { platform: string }) => f.platform === 'linux-x64');
    expect(linux).toEqual({
      platform: 'linux-x64',
      name: 'wairon-6.2.0-linux-x64.tar.gz',
      sha256: DIGEST,
      bytes: BYTES.length,
      release: '6.2.0-linux-x64',
      url: '/apps/wairon/releases/6.2.0-linux-x64/wairon-6.2.0-linux-x64.tar.gz',
      checksumUrl: '/apps/wairon/releases/6.2.0-linux-x64/wairon-6.2.0-linux-x64.tar.gz.sha256',
    });
    expect(manifest.files.find((f: { platform: string }) => f.platform === 'windows-x64').url)
      .toBe('/apps/wairon/releases/6.2.0-windows-x64/wairon-6.2.0-windows-x64.zip');
    const docs = JSON.parse(read(out, '6.2.0', 'docs', 'syw-docs.json'));
    expect(docs.home).toBe('start');
    for (const page of docs.pages) expect(fs.existsSync(path.join(out, '6.2.0', 'docs', page.path))).toBe(true);
  });

  it('two runs stage the same bytes, so a re-run republishes identically', () => {
    const staged = [0, 1].map(() => {
      const { art, out } = stage('6.2.0');
      dryRun(art, out);
      return read(out, '6.2.0', 'version.json');
    });
    expect(staged[0]).toBe(staged[1]);
  });

  it('a missing platform is refused, naming it', () => {
    const { art, out } = stage('6.2.0', { skip: 'macos-arm64' });
    expect(() => dryRun(art, out)).toThrow(/missing wairon-6\.2\.0-macos-arm64\.tar\.gz/);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('a wrong extension or an unknown platform is refused, naming it', () => {
    const wrongExt = stage('6.2.0', { skip: 'linux-x64', extra: 'wairon-6.2.0-linux-x64.zip' });
    expect(() => dryRun(wrongExt.art, wrongExt.out)).toThrow(/missing wairon-6\.2\.0-linux-x64\.tar\.gz; unexpected wairon-6\.2\.0-linux-x64\.zip/);
    const unknown = stage('6.2.0', { extra: 'wairon-6.2.0-freebsd-x64.tar.gz' });
    expect(() => dryRun(unknown.art, unknown.out)).toThrow(/unexpected wairon-6\.2\.0-freebsd-x64\.tar\.gz/);
  });

  it('an archive that does not match its .sha256 is refused', () => {
    const { art, out } = stage('6.2.0', { corrupt: true });
    expect(() => dryRun(art, out)).toThrow(/does not match its \.sha256/);
  });

  it('a dev build is not published', () => {
    const { art } = stage('6.2.1-dev.1');
    expect(run(['--version', '6.2.1-dev.1', '--artifacts', art])).toMatch(/dev build: not published/);
  });
});

