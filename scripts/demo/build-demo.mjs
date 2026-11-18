// Build the static demo: a read-only snapshot of this project's own design that runs without a
// server (docs: scripts/demo/README.md). It
//   1. builds the demo bundle of the web app (web/dist-demo, one HTML file),
//   2. starts `wairon dev` on this checkout, records what the canvas and specs views read,
//   3. keeps only the selected subsystems, strips code linkage, scrubs people and branches,
//   4. verifies nothing private is left (the build FAILS otherwise), and
//   5. writes the page beside its data files, and prints their sizes.
//
// usage: node scripts/demo/build-demo.mjs [--config scripts/demo/wairon.demo.json]
//                                         [--out site/demos/wairon] [--skip-web]
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { getKey, mcpKey } from '../../web/src/demo/canon.mjs';
import {
  collectNeedles,
  parseToolText,
  redactPathsDeep,
  scrubDeep,
  selectCanvasModel,
  selectFindings,
  selectGraph,
  specFileName,
  stripLinkage,
  verifyClean,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT = 'local';
const INITIAL_BUDGET_GZ = 1.5 * 1024 * 1024;
const TOTAL_BUDGET_GZ = 6 * 1024 * 1024;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(name);

const log = (m) => console.log('[demo] ' + m);
const fail = (m) => {
  console.error('[demo] ERROR: ' + m);
  process.exit(1);
};

const configPath = path.resolve(ROOT, arg('--config', 'scripts/demo/wairon.demo.json'));
const outDir = path.resolve(ROOT, arg('--out', 'site/demos/wairon'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const roots = config.redactRoots ?? [];

// ---------------------------------------------------------------------------------------------
// The dev server

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function startServer() {
  const cli = path.join(ROOT, 'dist', 'cli', 'index.js');
  if (!fs.existsSync(cli)) fail('dist/cli/index.js is missing: run `npm run build:web && npm run build` first.');
  const port = await freePort();
  const child = spawn(process.execPath, [cli, 'dev', '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) fail('the dev server exited early:\n' + output);
    try {
      const res = await fetch(base + '/web/dev-login', { redirect: 'manual' });
      if (res.status === 302 || res.status === 200) {
        const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
        return { child, base, cookie };
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      child.kill();
      fail('the dev server did not start within 90 s:\n' + output);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

function client(server) {
  const headers = { cookie: server.cookie, 'X-Wairon-Web': '1' };
  const get = async (p) => {
    const res = await fetch(server.base + p, { headers });
    if (!res.ok) throw new Error(`GET ${p} answered ${res.status}`);
    return res.json();
  };
  const mcp = async (name, args) => {
    const res = await fetch(server.base + '/mcp', {
      method: 'POST',
      headers: {
        ...headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'X-Wairon-Project': PROJECT,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    let text = await res.text();
    const data = /^data: (.*)$/m.exec(text);
    if (data && !text.trimStart().startsWith('{')) text = data[1];
    const payload = JSON.parse(text);
    if (!res.ok || payload.error) throw new Error(`${name} failed: ${JSON.stringify(payload.error ?? payload)}`);
    const first = payload.result?.content?.[0];
    if (payload.result?.isError) throw new Error(`${name} failed: ${first?.text}`);
    // The reply text must be pure JSON; a note trailing it is dropped.
    return parseToolText(first?.text ?? '');
  };
  return { get, mcp };
}

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// ---------------------------------------------------------------------------------------------
// What to scrub: the maintainer and the branches of this checkout

function git(...args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function needlesFor(approval) {
  const names = [git('config', 'user.name')];
  const emails = [git('config', 'user.email')];
  // The lock's approver reads "Name <email>".
  const approver = typeof approval?.approvedBy === 'string' ? approval.approvedBy : '';
  const m = /^(.*?)\s*<([^>]+)>\s*$/.exec(approver);
  if (m) {
    names.push(m[1]);
    emails.push(m[2]);
  } else if (approver) names.push(approver);
  const branches = [
    git('rev-parse', '--abbrev-ref', 'HEAD'),
    approval?.branch ?? '',
    ...git('branch', '-a', '--format=%(refname:short)').split(/\r?\n/),
  ];
  return collectNeedles({ names: names.filter(Boolean), emails: emails.filter(Boolean), branches: branches.filter(Boolean) });
}

// ---------------------------------------------------------------------------------------------

const sizeOf = (text) => ({ raw: Buffer.byteLength(text), gz: zlib.gzipSync(text, { level: 9 }).length });
const kb = (n) => (n / 1024).toFixed(0).padStart(6) + ' KB';

async function main() {
  if (!flag('--skip-web')) {
    log('building the demo bundle of the web app');
    const r = spawnSync('npm --prefix web run build:demo', { cwd: ROOT, stdio: 'inherit', shell: true });
    if (r.status !== 0) fail('the demo bundle did not build.');
  }
  const page = path.join(ROOT, 'web', 'dist-demo', 'index.html');
  if (!fs.existsSync(page)) fail('web/dist-demo/index.html is missing: run without --skip-web.');

  log('recording the design from a local dev server');
  const server = await startServer();
  let recorded;
  let chosen;
  let specs;
  try {
    const c = client(server);
    recorded = await record(c);
    chosen = choose(recorded);
    log(`fetching ${chosen.specNodes.length} specs`);
    specs = await pool(chosen.specNodes, 8, async (n) => {
      const kind = SPEC_KIND[n.kind];
      return { kind, id: n.id, spec: await c.mcp('sdd_get_spec', { kind, id: n.id }) };
    });
  } finally {
    // Stop the server this script started, by its own handle: no other process is touched.
    server.child.kill();
  }
  const { profiles, approval, version } = recorded;
  const { picked, graph, implOfStart, picks } = chosen;

  // -- make the files: strip, redact, scrub ---------------------------------------------------
  const needles = needlesFor(approval);
  // --explain lists each changed string, to see what a rule touches.
  const explain = (what) => (before, after) => {
    if (!flag('--explain')) return;
    const i = [...before].findIndex((ch, k) => ch !== after[k]);
    console.log(`[demo] ${what}: …${before.slice(Math.max(0, i - 25), i + 45).replace(/\s+/g, ' ')}…`);
  };
  let redacted = 0;
  let scrubbed = 0;
  const clean = (value) => {
    const r = redactPathsDeep(stripLinkage(value), roots, explain('redacted'));
    const s = scrubDeep(r.value, needles, explain('scrubbed'));
    redacted += r.changed;
    scrubbed += s.changed;
    return s.value;
  };

  const files = new Map(); // name (under data/) -> object
  const index = {
    v: 1,
    demo: { id: config.id, title: config.title, waironVersion: version },
    start: {
      canvas: config.start.canvasSubsystem,
      specs: { kind: implOfStart.kind, id: implOfStart.id },
    },
    gets: {},
    mcp: {},
  };
  const addGet = (p, name, value) => {
    index.gets[getKey(p)] = name;
    files.set(name, clean(value));
  };
  const addMcp = (name, args, file, value) => {
    index.mcp[mcpKey(name, args)] = file;
    files.set(file, clean(value));
  };
  // The page runs as a local, single-project visitor: no person is recorded.
  addGet('/web/context', 'get/context.json', { subject: { userId: 'demo', kind: 'human', issuer: 'demo', displayName: 'Visitor' }, isAdmin: true, local: true });
  addGet(`/web/canvas-model?projectId=${PROJECT}`, 'get/canvas-model.json', picked.model);
  addGet(`/web/graph?tier=project&projectId=${PROJECT}&level=4`, 'get/graph.json', graph);
  addGet(`/web/projects/profiles?projectId=${PROJECT}`, 'get/profiles.json', profiles);
  addMcp('sdd_validate_tree', {}, 'get/validation.json', picks.result);
  for (const s of specs) addMcp('sdd_get_spec', { kind: s.kind, id: s.id }, specFileName(s.kind, s.id), s.spec);
  files.set('index.json', index);

  // -- write, then verify what was written ----------------------------------------------------
  const texts = [...files].map(([name, value]) => ({ name, text: JSON.stringify(value) }));
  const pageText = fs.readFileSync(page, 'utf8');
  const hits = verifyClean(
    texts.map((t) => ({ name: 'data/' + t.name, text: t.text })),
    { needles, roots },
  );
  if (hits.length > 0) {
    console.error('[demo] ERROR: the demo holds what must not be published:');
    for (const h of hits.slice(0, 40)) console.error(`  ${h.file}: ${h.kind} "${h.match}"`);
    if (hits.length > 40) console.error(`  ... and ${hits.length - 40} more`);
    process.exit(1);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  for (const t of texts) {
    const target = path.join(outDir, 'data', t.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, t.text);
  }
  fs.copyFileSync(page, path.join(outDir, 'index.html'));
  writeSiteRoot();

  // -- sizes ----------------------------------------------------------------------------------
  report(texts, pageText, { redacted, scrubbed, dropped: picked.droppedFindings + picks.dropped, specs: specs.length, comps: picked.components.length });
}

const SPEC_KIND = { project: 'system', subsystem: 'subsystem', component: 'component', interface: 'interface', implementation: 'implementation', type: 'type' };

/** What the selection keeps of the recording, and where the visitor starts. */
function choose({ model, graph, validation }) {
  const implNodes = graph.nodes.filter((n) => n.kind === 'implementation').map((n) => n.id);
  const picked = selectCanvasModel(model, config.subsystems, roots, implNodes);
  for (const s of config.subsystems) {
    if (!picked.model.subsystems.some((x) => x.id === s)) fail(`subsystem "${s}" is not in the design.`);
  }
  if (!config.subsystems.includes(config.start.canvasSubsystem)) {
    fail(`the canvas start subsystem "${config.start.canvasSubsystem}" is not among the selected subsystems.`);
  }
  const kept = selectGraph(graph, config.subsystems, new Set(picked.types));
  const implOfStart = kept.nodes.find((n) => n.kind === 'implementation' && n.parentId === config.start.specsComponent);
  if (!implOfStart) fail(`the specs start component "${config.start.specsComponent}" has no implementation among the selected specs.`);
  return {
    picked,
    graph: kept,
    implOfStart,
    picks: selectFindings(validation, picked.specIds, roots),
    specNodes: kept.nodes.filter((n) => SPEC_KIND[n.kind]),
  };
}

function writeSiteRoot() {
  // A page at the site root (beside demos/) pointing to the demo, when the output sits in demos/<id>.
  const siteRoot = path.resolve(outDir, '..', '..');
  if (path.basename(path.dirname(outDir)) !== 'demos') return;
  fs.writeFileSync(path.join(siteRoot, '.nojekyll'), '');
  fs.writeFileSync(
    path.join(siteRoot, 'index.html'),
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta http-equiv="refresh" content="0; url=demos/${config.id}/">\n<title>wairon demos</title>\n</head>\n<body>\n<p><a href="demos/${config.id}/">The wairon demo</a>: a read-only snapshot of wairon's own design.</p>\n</body>\n</html>\n`,
  );
}

function report(texts, pageText, counts) {
  const byName = new Map(texts.map((t) => [t.name, sizeOf(t.text)]));
  const page = sizeOf(pageText);
  const initialNames = ['index.json', 'get/context.json', 'get/canvas-model.json'];
  const initial = initialNames.reduce((acc, n) => ({ raw: acc.raw + byName.get(n).raw, gz: acc.gz + byName.get(n).gz }), page);
  const specs = [...byName].filter(([n]) => n.startsWith('spec/')).reduce((a, [, s]) => ({ raw: a.raw + s.raw, gz: a.gz + s.gz }), { raw: 0, gz: 0 });
  const total = [...byName.values()].reduce((a, s) => ({ raw: a.raw + s.raw, gz: a.gz + s.gz }), page);
  const line = (label, s) => `  ${label.padEnd(34)} ${kb(s.raw)} raw  ${kb(s.gz)} gzip`;
  console.log('');
  console.log(`[demo] wrote ${path.relative(ROOT, outDir) || '.'}  (${counts.comps} components, ${counts.specs} specs)`);
  console.log(line('index.html (the app)', page));
  for (const n of initialNames) console.log(line('data/' + n, byName.get(n)));
  console.log(line('initial load (canvas start)', initial));
  console.log(line(`${counts.specs} spec files (on demand)`, specs));
  for (const n of ['get/graph.json', 'get/validation.json', 'get/profiles.json']) console.log(line('data/' + n, byName.get(n)));
  console.log(line('whole site', total));
  console.log(`[demo] stripped linkage, redacted ${counts.redacted} path strings, scrubbed ${counts.scrubbed} strings, dropped ${counts.dropped} findings; verification passed.`);
  if (initial.gz > INITIAL_BUDGET_GZ) fail(`the initial load is ${kb(initial.gz)} gzipped, over the ${kb(INITIAL_BUDGET_GZ)} budget.`);
  if (total.gz > TOTAL_BUDGET_GZ) fail(`the whole site is ${kb(total.gz)} gzipped, over the ${kb(TOTAL_BUDGET_GZ)} budget.`);
}

async function record(c) {
  const version = execFileSync(process.execPath, [path.join(ROOT, 'dist', 'cli', 'index.js'), '--version'], { encoding: 'utf8' }).trim();
  // The server answers at once with the last known findings while its gate runs; the recording
  // waits until both reads carry the gate's own answer, or fails.
  const current = async (p) => {
    for (let i = 0; i < 240; i++) {
      const r = await c.get(p);
      if (r.findingsState === 'current') return r;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`${p} never reported its findings as current within 120 s`);
  };
  const model = await current(`/web/canvas-model?projectId=${PROJECT}`);
  const graph = await current(`/web/graph?tier=project&projectId=${PROJECT}&level=4`);
  const profiles = await c.get(`/web/projects/profiles?projectId=${PROJECT}`);
  const approval = await c.get('/web/dev/approval').catch(() => null);
  const validation = await c.mcp('sdd_validate_tree', {});
  return { model, graph, profiles, approval, validation, version };
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
