// ---------------------------------------------------------------------------
// cdn-publish.mjs — publish a release to the SYW CDN (cdn.sywapps.com).
//
// The CDN is a second home for a release, beside the GitHub release and npm:
// nothing reads from it yet but a product page, so a failure here never blocks
// either of them. One immutable release per version, under the namespace the
// publisher credential is assigned (the request names no namespace):
//
//   apps/<app>/releases/<version>/
//     version.json                      the release manifest (docs/cdn-release.md)
//     wairon-<version>-<target>.zip|tar.gz (+ .sha256)   the GitHub release's archives
//     notes.md                          release-notes/<version>.md, when it exists
//     docs/syw-docs.json + docs/*.md    the guides, for the CDN's docs reader
//
// Aliases move only after the exact release is valid: a stable version moves
// `latest` and `v<major>`; a beta or preview moves `beta` or `preview`. A dev
// build is not published here (one is cut per merge; npm's `dev` tag has them).
//
// Usage:
//   node scripts/cdn-publish.mjs --version 6.2.0 --artifacts <dir> [--commit <sha>] [--released <iso-time>] [--dry-run <out-dir>]
//   --released is the tagged commit's time, so a re-run publishes the same bytes (the CDN refuses different ones).
// Env: SYW_CDN_PUBLISHER_TOKEN (not needed for --dry-run), SYW_CDN_BASE (default https://cdn.sywapps.com).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO_URL = 'https://github.com/SYW-Apps/Waffle-AIron';
const BASE = (process.env.SYW_CDN_BASE || 'https://cdn.sywapps.com').replace(/\/+$/, '');

/** The guides published with a release: source file, published page id, title. */
const GUIDES = [
  { src: 'README.md', id: 'start', title: 'Start here' },
  { src: 'docs/vision.md', id: 'vision', title: 'Vision' },
  { src: 'docs/architecture.md', id: 'architecture', title: 'Architecture' },
  { src: 'docs/cli.md', id: 'cli', title: 'CLI reference', section: 'Reference' },
  { src: 'docs/network.md', id: 'network', title: 'Derived networking', section: 'Reference' },
  { src: 'docs/design-export.md', id: 'design-export', title: 'The design export', section: 'Reference' },
  { src: 'docs/extending-wairon.md', id: 'extending-wairon', title: 'Extending wairon', section: 'Extending' },
  { src: 'docs/templates.md', id: 'templates', title: 'Templates', section: 'Extending' },
];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    out[key.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

/** The release channel of a version, as publish-npm.yml names its dist-tags. */
export function channelOf(version) {
  if (/-dev\.\d+$/.test(version)) return 'dev';
  if (/-beta\.\d+$/.test(version)) return 'beta';
  if (/-preview\.\d+$/.test(version)) return 'preview';
  if (/^\d+\.\d+\.\d+$/.test(version)) return 'stable';
  throw new Error(`version "${version}" is neither a release nor a dev, beta or preview build`);
}

/** The aliases a version moves on the CDN. */
export function aliasesOf(version) {
  const channel = channelOf(version);
  if (channel === 'stable') return ['latest', `v${version.split('.')[0]}`];
  return [channel];
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/** The GitHub release's archives for this version, each checked against its .sha256. */
function archives(dir, version) {
  const name = new RegExp(`^wairon-${version.replace(/\./g, '\\.')}-([a-z0-9]+-[a-z0-9]+)\\.(zip|tar\\.gz)$`);
  const found = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const m = name.exec(file);
    if (!m) continue;
    const bytes = fs.readFileSync(path.join(dir, file));
    const digest = sha256(bytes);
    const sumFile = path.join(dir, `${file}.sha256`);
    if (!fs.existsSync(sumFile)) throw new Error(`${file} has no ${file}.sha256 beside it`);
    const recorded = fs.readFileSync(sumFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
    if (recorded !== digest) throw new Error(`${file}: sha256 ${digest} does not match its .sha256 (${recorded})`);
    found.push({ platform: m[1], name: file, sha256: digest, bytes: bytes.length, checksum: `${file}.sha256` });
  }
  if (found.length === 0) throw new Error(`no wairon-${version}-<target> archives in ${dir}`);
  return found;
}

/**
 * A guide's Markdown with its relative links resolved: a link to another
 * published guide stays in the reader, every other one points at the file on
 * GitHub at this version's tag.
 */
export function rewriteLinks(markdown, src, published, version) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (whole, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) return whole;
    const [file, fragment] = target.split('#');
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(src), file));
    const page = published.get(resolved);
    const hash = fragment ? `#${fragment}` : '';
    if (page) return `](${page}${hash})`;
    return `](${REPO_URL}/blob/v${version}/${resolved}${hash})`;
  });
}

/** The guides as release files: docs/<id>.md plus the docs reader's manifest. */
function guides(root, version, canonical) {
  const published = new Map(GUIDES.map((g) => [g.src, `${g.id}.md`]));
  const files = [];
  for (const g of GUIDES) {
    const text = fs.readFileSync(path.join(root, g.src), 'utf8').replace(/\r\n/g, '\n');
    files.push({ path: `docs/${g.id}.md`, bytes: Buffer.from(rewriteLinks(text, g.src, published, version), 'utf8') });
  }
  const manifest = {
    schemaVersion: 1,
    id: 'wairon',
    title: 'wairon',
    version,
    description: 'Spec-driven development: design a system as a checked spec tree, then build against it.',
    ...(canonical ? { canonical } : {}),
    home: 'start',
    pages: GUIDES.map((g) => ({ id: g.id, title: g.title, path: `${g.id}.md`, ...(g.section ? { section: g.section } : {}) })),
  };
  files.push({ path: 'docs/syw-docs.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') });
  return files;
}

/** The namespace prefix (apps/<app>) the credential is assigned, when the session names one. */
function prefixIn(session) {
  const seen = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = /^\/?(apps\/[a-z0-9][a-z0-9-]*)(\/|$)/i.exec(v);
      if (m) seen.push(m[1]);
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v)) walk(x);
    }
  };
  walk(session);
  return seen[0];
}

async function main() {
  const a = args(process.argv.slice(2));
  const version = a.version;
  if (!version || !a.artifacts) throw new Error('usage: --version <x.y.z> --artifacts <dir> [--commit <sha>] [--dry-run <out-dir>]');
  const channel = channelOf(version);
  if (channel === 'dev') {
    console.log(`${version} is a dev build: not published to the CDN.`);
    return;
  }
  const root = process.cwd();
  const token = process.env.SYW_CDN_PUBLISHER_TOKEN;
  const dryRun = a['dry-run'];
  if (!dryRun && !token) throw new Error('SYW_CDN_PUBLISHER_TOKEN is not set');

  let prefix;
  if (!dryRun) {
    const res = await fetch(`${BASE}/api/v1/publish/session`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`publisher session: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    prefix = prefixIn(await res.json());
    console.log(prefix ? `Publishing as ${prefix}` : 'The publisher session names no apps/<app> prefix: publishing without a canonical docs path.');
  }

  const files = archives(a.artifacts, version);
  const notesSrc = path.join(root, 'release-notes', `${version}.md`);
  const notes = fs.existsSync(notesSrc) ? fs.readFileSync(notesSrc, 'utf8').replace(/\r\n/g, '\n') : undefined;
  const canonical = prefix ? `/${prefix}/releases/${version}/docs/syw-docs.json` : undefined;
  const docs = guides(root, version, canonical);
  const manifest = {
    schemaVersion: 1,
    name: 'wairon',
    version,
    tag: `v${version}`,
    channel,
    ...(a.released ? { released: a.released } : {}),
    ...(a.commit ? { commit: a.commit } : {}),
    npm: { package: '@wairon/cli', version },
    source: `${REPO_URL}/tree/v${version}`,
    ...(notes ? { notes: 'notes.md' } : {}),
    docs: 'docs/syw-docs.json',
    files: files.map(({ platform, name, sha256: digest, bytes, checksum }) => ({ platform, name, sha256: digest, bytes, checksum })),
  };

  const parts = [
    { path: 'version.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    ...(notes ? [{ path: 'notes.md', bytes: Buffer.from(notes, 'utf8') }] : []),
    ...docs,
  ];
  const aliases = aliasesOf(version);

  if (dryRun) {
    for (const p of parts) {
      fs.mkdirSync(path.dirname(path.join(dryRun, p.path)), { recursive: true });
      fs.writeFileSync(path.join(dryRun, p.path), p.bytes);
    }
    console.log(`Dry run: ${parts.length} generated files written to ${dryRun}; ${files.length} archives; aliases ${aliases.join(', ')}.`);
    return;
  }

  const form = new FormData();
  form.append('version', version);
  for (const alias of aliases) form.append('alias', alias);
  form.append('description', `wairon ${version}`);
  form.append('tags', ['release', channel].join(','));
  for (const f of files) {
    form.append(`file:${f.name}`, await fs.openAsBlob(path.join(a.artifacts, f.name)), f.name);
    form.append(`file:${f.checksum}`, await fs.openAsBlob(path.join(a.artifacts, f.checksum)), f.checksum);
  }
  for (const p of parts) form.append(`file:${p.path}`, new Blob([p.bytes]), path.posix.basename(p.path));

  const res = await fetch(`${BASE}/api/v1/publish/releases`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  const body = await res.text();
  if (!res.ok) throw new Error(`publish ${version}: HTTP ${res.status} ${body.slice(0, 500)}`);
  console.log(`Published ${version} (aliases ${aliases.join(', ')}): ${body.slice(0, 500)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
