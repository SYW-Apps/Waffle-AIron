// ---------------------------------------------------------------------------
// cdn-publish.mjs — publish a release to the SYW CDN (cdn.sywapps.com).
//
// The CDN is a second home for a release, beside the GitHub release and npm:
// nothing reads from it yet but a product page, so a failure here never blocks
// either of them. The CDN sits behind Cloudflare (100 MB per request) and has
// no staged or chunked upload, so the five platform archives (~204 MB together)
// cannot go in one request. Following the CDN integration guide ("Multi-platform
// releases that exceed one request"), a version is published as:
//
//   1. one exact release per platform, `<version>-<target>`, holding that
//      platform's archive + its .sha256, with NO aliases;
//   2. a public GET of each archive, checked for SHA-256 and byte length;
//   3. the index release `<version>`: version.json, notes.md and the guides,
//      with the aliases, only after every platform release is verified.
//
//   apps/<app>/releases/<version>-<target>/wairon-<version>-<target>.zip|tar.gz (+ .sha256)
//   apps/<app>/releases/<version>/
//     version.json                      the manifest (docs/cdn-release.md); names each archive by its exact URL
//     notes.md                          release-notes/<version>.md, when it exists
//     docs/syw-docs.json + docs/*.md    the guides, for the CDN's docs reader
//
// Aliases move only on the index request: a stable version moves `latest` and
// `v<major>`; a beta or preview moves `beta` or `preview`. An alias is not moved
// when a NEWER exact version of its channel is already on the CDN (a recovery
// run of an old tag must not move a channel back). A dev build is not published
// here (one is cut per merge; npm's `dev` tag has them).
//
// Usage:
//   node scripts/cdn-publish.mjs --version 6.2.0 --artifacts <dir> [--commit <sha>] [--released <iso-time>] [--dry-run <out-dir>] [--app <slug>]
//   --released is the tagged commit's time, so a re-run publishes the same bytes (the CDN refuses different ones).
//   --dry-run writes one folder per release (its files + request.json) and sends nothing; --app names the
//   <app> in the manifest's URLs there (a real run reads it from the publisher session).
// Env: SYW_CDN_PUBLISHER_TOKEN (not needed for --dry-run), SYW_CDN_BASE (default https://cdn.sywapps.com).
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const REPO_URL = 'https://github.com/SYW-Apps/Waffle-AIron';
const BASE = (process.env.SYW_CDN_BASE || 'https://cdn.sywapps.com').replace(/\/+$/, '');

/**
 * The conservative client budget for ONE publish request's total encoded body
 * (files, fields and multipart boundaries). The CDN integration guide ("Upload
 * shape and size limits") says its manager accepts 512 MiB but the Cloudflare
 * route in front of it allows 100 MB per request on Free/Pro, and advises 90,000,000
 * bytes as the budget until the operator confirms more. Guidance, not a service limit.
 */
export const REQUEST_BUDGET_BYTES = 90_000_000;

/** How often a request is sent (same bytes each time) when the response is lost or a 5xx. */
const SEND_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5000;

/** The platforms release.yml builds, with the archive extension each one gets. */
export const TARGETS = [
  { target: 'windows-x64', ext: '.zip' },
  { target: 'linux-x64', ext: '.tar.gz' },
  { target: 'linux-arm64', ext: '.tar.gz' },
  { target: 'macos-x64', ext: '.tar.gz' },
  { target: 'macos-arm64', ext: '.tar.gz' },
];

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
  if (/^\d+\.\d+\.\d+-dev\.\d+$/.test(version)) return 'dev';
  if (/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) return 'beta';
  if (/^\d+\.\d+\.\d+-preview\.\d+$/.test(version)) return 'preview';
  if (/^\d+\.\d+\.\d+$/.test(version)) return 'stable';
  throw new Error(`version "${version}" is neither a release nor a dev, beta or preview build`);
}

/** The aliases a version moves on the CDN. */
export function aliasesOf(version) {
  const channel = channelOf(version);
  if (channel === 'stable') return ['latest', `v${version.split('.')[0]}`];
  return [channel];
}

/** Order two versions of this project's forms (a stable one sorts after its own pre-releases). */
export function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/.exec(v);
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Infinity : Number(m[4])];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * Which of a version's aliases to move, given the version each alias points at
 * now (`current`: alias -> version, or null/absent when the alias does not exist).
 * An alias is left alone when it already points at a NEWER version of the same
 * channel, so a recovery run of an old tag cannot move a channel back.
 */
export function planAliases(version, current) {
  const channel = channelOf(version);
  const move = [];
  const skipped = [];
  for (const alias of aliasesOf(version)) {
    const at = current[alias];
    let newer = false;
    if (at) {
      try { newer = channelOf(at) === channel && compareVersions(at, version) > 0; } catch { newer = false; }
    }
    if (newer) skipped.push({ alias, newer: at });
    else move.push(alias);
  }
  return { move, skipped };
}

/** Refuse a request whose encoded body exceeds the budget; called before any request is sent. */
export function checkRequestBudget(label, bytes, budget = REQUEST_BUDGET_BYTES) {
  if (bytes > budget) {
    throw new Error(`${label}: request body is ${bytes} bytes, over the ${budget}-byte request budget (docs/cdn-release.md); nothing was sent`);
  }
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * The GitHub release's archives for this version: exactly one per platform in
 * TARGETS, with the right extension, each checked against its .sha256.
 */
export function archives(dir, version) {
  // Every regex metacharacter and the backslash itself, not only the dots a version holds.
  const esc = version.replace(/[\\^$.*+?()[\]{}|]/g, (c) => `\\${c}`);
  const name = new RegExp(`^wairon-${esc}-([a-z0-9]+-[a-z0-9]+)(\\.zip|\\.tar\\.gz)$`);
  const present = new Map();
  const unexpected = [];
  for (const file of fs.readdirSync(dir).sort()) {
    const m = name.exec(file);
    if (!m) continue;
    const want = TARGETS.find((t) => t.target === m[1]);
    if (!want || want.ext !== m[2]) unexpected.push(file);
    else present.set(m[1], file);
  }
  const missing = TARGETS.filter((t) => !present.has(t.target)).map((t) => `wairon-${version}-${t.target}${t.ext}`);
  if (missing.length || unexpected.length) {
    throw new Error(`the archive set in ${dir} is not the five platforms: ${[
      missing.length ? `missing ${missing.join(', ')}` : '',
      unexpected.length ? `unexpected ${unexpected.join(', ')}` : '',
    ].filter(Boolean).join('; ')}`);
  }
  return TARGETS.map(({ target }) => {
    const file = present.get(target);
    const bytes = fs.readFileSync(path.join(dir, file));
    const digest = sha256(bytes);
    const sumFile = path.join(dir, `${file}.sha256`);
    if (!fs.existsSync(sumFile)) throw new Error(`${file} has no ${file}.sha256 beside it`);
    const sumBytes = fs.readFileSync(sumFile);
    const recorded = sumBytes.toString('utf8').trim().split(/\s+/)[0].toLowerCase();
    if (recorded !== digest) throw new Error(`${file}: sha256 ${digest} does not match its .sha256 (${recorded})`);
    return { platform: target, name: file, sha256: digest, bytes: bytes.length, checksum: `${file}.sha256`, data: bytes, sumData: sumBytes };
  });
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

/** A platform's own release name: `<version>-<target>`. */
export const platformRelease = (version, target) => `${version}-${target}`;

/** The root-relative public path of a file in an exact release. */
export const releasePath = (prefix, release, file) => `/${prefix}/releases/${release}/${file}`;

/** The index release's manifest, naming each archive by its exact platform-release URL. */
export function buildManifest({ version, channel, released, commit, notes, prefix, files }) {
  return {
    schemaVersion: 2,
    name: 'wairon',
    version,
    tag: `v${version}`,
    channel,
    ...(released ? { released } : {}),
    ...(commit ? { commit } : {}),
    npm: { package: '@wairon/cli', version },
    source: `${REPO_URL}/tree/v${version}`,
    ...(notes ? { notes: 'notes.md' } : {}),
    docs: 'docs/syw-docs.json',
    files: files.map((f) => {
      const release = platformRelease(version, f.platform);
      return {
        platform: f.platform,
        name: f.name,
        sha256: f.sha256,
        bytes: f.bytes,
        release,
        url: releasePath(prefix, release, f.name),
        checksumUrl: releasePath(prefix, release, f.checksum),
      };
    }),
  };
}

/** The publish requests of a version: one per platform (no aliases), then the index. */
export function buildRequests({ version, channel, files, indexFiles, aliases }) {
  const tags = ['release', channel].join(',');
  const platforms = files.map((f) => ({
    label: platformRelease(version, f.platform),
    version: platformRelease(version, f.platform),
    aliases: [],
    description: `wairon ${version} (${f.platform})`,
    tags,
    files: [{ path: f.name, bytes: f.data }, { path: f.checksum, bytes: f.sumData }],
  }));
  const index = { label: version, version, aliases, description: `wairon ${version}`, tags, files: indexFiles };
  return { platforms, index };
}

/** A request as the multipart body the CDN takes (and the Content-Type naming its boundary). */
async function encode(req) {
  const form = new FormData();
  form.append('version', req.version);
  for (const alias of req.aliases) form.append('alias', alias);
  form.append('description', req.description);
  form.append('tags', req.tags);
  for (const f of req.files) form.append(`file:${f.path}`, new Blob([f.bytes]), path.posix.basename(f.path));
  const response = new Response(form);
  return { contentType: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) };
}

/** What a failed response tells the operator to hand over (never the token). */
function describeFailure(label, url, size, res, text) {
  const ids = ['cf-ray', 'x-request-id', 'cf-request-id'].map((h) => (res.headers.get(h) ? `${h}=${res.headers.get(h)}` : '')).filter(Boolean);
  return `${label}: HTTP ${res.status} from ${url} (${new Date().toISOString()}, body ${size} bytes${ids.length ? `, ${ids.join(', ')}` : ''}): ${text.slice(0, 300).replace(/\s+/g, ' ')}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST one release request. A 409 is different bytes (or a different file set) under an
 * exact version: a retry cannot fix it, so it fails at once. A thrown fetch (lost
 * response) or a 5xx is retried a bounded number of times with the SAME bytes, which
 * the CDN accepts as idempotent.
 */
async function send(req, token, delayMs = RETRY_DELAY_MS) {
  const { contentType, body } = await encode(req);
  const url = `${BASE}/api/v1/publish/releases`;
  let last;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType }, body });
      const text = await res.text();
      if (res.ok) return text;
      last = describeFailure(`publish ${req.label}`, url, body.length, res, text);
      if (res.status < 500) throw Object.assign(new Error(last), { final: true });
    } catch (err) {
      if (err.final) throw err;
      last = `publish ${req.label}: no response from ${url} (${err.message}; body ${body.length} bytes)`;
    }
    if (attempt < SEND_ATTEMPTS) {
      console.log(`${last}\nretrying the same bytes in ${delayMs / 1000}s (attempt ${attempt + 1} of ${SEND_ATTEMPTS})`);
      await sleep(delayMs);
    }
  }
  throw new Error(last);
}

/** Fetch a published archive back from its public URL and compare its SHA-256 and length. */
async function verify(prefix, release, f) {
  const url = `${BASE}${releasePath(prefix, release, f.name)}`;
  let last;
  for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const got = Buffer.from(await res.arrayBuffer());
        if (got.length === f.bytes && sha256(got) === f.sha256) return;
        throw Object.assign(new Error(`verify ${url}: got ${got.length} bytes sha256 ${sha256(got)}, expected ${f.bytes} bytes sha256 ${f.sha256}`), { final: true });
      }
      last = describeFailure(`verify ${release}`, url, 0, res, await res.text());
    } catch (err) {
      if (err.final) throw err;
      last = `verify ${release}: ${url}: ${err.message}`;
    }
    if (attempt < SEND_ATTEMPTS) await sleep(RETRY_DELAY_MS);
  }
  throw new Error(last);
}

/**
 * The version each alias points at now, read from its public version.json: 404 means
 * the alias is free (null); anything else that is not a readable manifest fails
 * closed, so no alias is moved on a guess.
 */
async function currentAliases(prefix, aliases) {
  const out = {};
  for (const alias of aliases) {
    const url = `${BASE}/${prefix}/releases/${alias}/version.json`;
    const res = await fetch(url);
    if (res.status === 404) { out[alias] = null; continue; }
    const text = await res.text();
    if (!res.ok) throw new Error(describeFailure(`read alias ${alias}`, url, 0, res, text));
    let version;
    try { version = JSON.parse(text).version; } catch { /* reported below */ }
    if (typeof version !== 'string') throw new Error(describeFailure(`read alias ${alias} (no version in its version.json)`, url, 0, res, text));
    out[alias] = version;
  }
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  const version = a.version;
  if (!version || !a.artifacts) throw new Error('usage: --version <x.y.z> --artifacts <dir> [--commit <sha>] [--released <iso>] [--dry-run <out-dir>] [--app <slug>]');
  const channel = channelOf(version);
  if (channel === 'dev') {
    console.log(`${version} is a dev build: not published to the CDN.`);
    return;
  }
  const root = process.cwd();
  const token = process.env.SYW_CDN_PUBLISHER_TOKEN;
  const dryRun = a['dry-run'];
  if (!dryRun && !token) throw new Error('SYW_CDN_PUBLISHER_TOKEN is not set');

  const files = archives(a.artifacts, version);
  const notesSrc = path.join(root, 'release-notes', `${version}.md`);
  const notes = fs.existsSync(notesSrc) ? fs.readFileSync(notesSrc, 'utf8').replace(/\r\n/g, '\n') : undefined;

  // Platform requests do not depend on the publisher session: size them first,
  // so an over-budget request is refused before any network call.
  const first = buildRequests({ version, channel, files, indexFiles: [], aliases: [] });
  for (const req of first.platforms) checkRequestBudget(req.label, (await encode(req)).body.length);

  let prefix;
  if (dryRun) {
    prefix = `apps/${a.app || 'wairon'}`;
  } else {
    const res = await fetch(`${BASE}/api/v1/publish/session`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(describeFailure('publisher session', `${BASE}/api/v1/publish/session`, 0, res, await res.text()));
    prefix = prefixIn(await res.json());
    if (!prefix) throw new Error('the publisher session names no apps/<app> prefix: cannot build the manifest\'s exact URLs');
    console.log(`Publishing as ${prefix}`);
  }

  const manifest = buildManifest({ version, channel, released: a.released, commit: a.commit, notes, prefix, files });
  const indexFiles = [
    { path: 'version.json', bytes: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') },
    ...(notes ? [{ path: 'notes.md', bytes: Buffer.from(notes, 'utf8') }] : []),
    ...guides(root, version, `/${prefix}/releases/${version}/docs/syw-docs.json`),
  ];
  const { platforms, index } = buildRequests({ version, channel, files, indexFiles, aliases: aliasesOf(version) });
  const indexSize = (await encode(index)).body.length;
  checkRequestBudget(index.label, indexSize);

  if (dryRun) {
    for (const req of [...platforms, index]) {
      const dir = path.join(dryRun, req.label);
      for (const f of req.files) {
        fs.mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
        fs.writeFileSync(path.join(dir, f.path), f.bytes);
      }
      const size = (await encode(req)).body.length;
      fs.writeFileSync(path.join(dir, 'request.json'), `${JSON.stringify({
        version: req.version, aliases: req.aliases, description: req.description, tags: req.tags,
        files: req.files.map((f) => f.path), bodyBytes: size, budgetBytes: REQUEST_BUDGET_BYTES,
      }, null, 2)}\n`);
    }
    console.log(`Dry run: ${platforms.length} platform releases (${platforms.map((p) => p.label).join(', ')}) and the index release ${version} written to ${dryRun}.`);
    console.log(`Would: send each platform release without aliases, verify each archive by public GET, read each alias's current version.json, then send the index with ${index.aliases.join(', ')} (an alias is skipped when the alias already points at a newer ${channel} version).`);
    return;
  }

  for (const req of platforms) {
    const f = files.find((x) => platformRelease(version, x.platform) === req.label);
    await send(req, token);
    console.log(`Published ${req.label} (${f.bytes} bytes)`);
    await verify(prefix, req.label, f);
    console.log(`Verified ${req.label}: sha256 and length match the public copy`);
  }

  const { move, skipped } = planAliases(version, await currentAliases(prefix, aliasesOf(version)));
  for (const s of skipped) console.log(`::notice::Alias ${s.alias} not moved: a newer ${channel} version ${s.newer} is already on the CDN.`);
  const text = await send({ ...index, aliases: move }, token);
  console.log(`Published ${version} (aliases ${move.length ? move.join(', ') : 'none moved'}): ${text.slice(0, 500)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
