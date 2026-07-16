#!/usr/bin/env node
// ---------------------------------------------------------------------------
// examples/hosted-server/demo.mjs
//
// End-to-end demo of the wairon hosting server (`wairon serve`). Against a
// throwaway data dir it: provisions an isolated project, mints a scoped API key,
// starts the server, drives the DATA PLANE over HTTP (auth rejection + MCP
// initialize + a project-scoped `sdd_get_status` tool call), then exercises the
// CONTROL PLANE (state-scoped lock → promote → edit → stale promote). No Docker
// required. Self-verifying: exits non-zero if any assertion fails.
//
//   npm run build            # once — the demo runs the built CLI
//   node examples/hosted-server/demo.mjs
// ---------------------------------------------------------------------------

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const CLI = join(repoRoot, 'dist', 'cli', 'index.js');
const PORT = Number(process.env.DEMO_PORT ?? 8987);
const ADMIN_PORT = Number(process.env.DEMO_ADMIN_PORT ?? 8988);
const DATA = mkdtempSync(join(tmpdir(), 'wairon-demo-'));
const env = { ...process.env, WAIRON_DATA_DIR: DATA, WAIRON_ADMIN_TOKEN: 'demo-admin-' + randomBytes(8).toString('hex') };
const specPath = join(DATA, 'projects', 'demo', '.wai', 'specs', '.index.yaml');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ✅' : '  ❌'} ${msg}`); if (!cond) failures++; };
const step = (msg) => console.log(`\n▶ ${msg}`);

function cli(args, { allowFail = false } = {}) {
  const r = spawnSync('node', [CLI, ...args], { env, encoding: 'utf8' });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0 && !allowFail) { console.error(out); throw new Error(`wairon ${args.join(' ')} exited ${r.status}`); }
  return out;
}

async function post(token, body) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server never became healthy on :${PORT}`);
}

async function main() {
  if (!existsSync(CLI)) { console.error(`Build first: \`npm run build\` (missing ${CLI})`); process.exit(2); }
  console.log(`data dir: ${DATA}`);

  step('Control plane (in-process): provision an isolated project + mint an owner-bound agent key');
  // Every project is placed in an organization unit at creation, so seed one first.
  console.log('  ' + cli(['host', 'unit', 'create', '--slug', 'demo-team']).replace(/\s+/g, ' '));
  console.log('  ' + cli(['host', 'project', 'create', '--id', 'demo', '--unit', 'demo-team']).replace(/\s+/g, ' '));
  // A token carries NO permissions of its own — it acts as its OWNER's live
  // permission. Seed the owner's read+write assignment, then mint their token.
  console.log('  ' + cli(['host', 'permission', 'set', '--user', 'ci-agent', '--capability', 'project:read', '--project', 'demo']).replace(/\s+/g, ' '));
  console.log('  ' + cli(['host', 'permission', 'set', '--user', 'ci-agent', '--capability', 'project:write', '--project', 'demo']).replace(/\s+/g, ' '));
  const key = (cli(['host', 'key', 'mint', '--project', 'demo', '--owner', 'ci-agent']).match(/wk_[a-f0-9]+/) || [])[0];
  ok(!!key, `minted key ${key ? key.slice(0, 12) + '…' : '(none!)'}`);
  ok(existsSync(specPath), 'isolated .wai/ tree provisioned');

  step('Start `wairon serve`');
  const server = spawn('node', [CLI, 'serve', '--port', String(PORT), '--admin-port', String(ADMIN_PORT), '--data-dir', DATA], { env, stdio: 'ignore' });
  try {
    await waitHealthy();
    ok(true, `server healthy on :${PORT}`);

    step('Data plane: auth is enforced');
    ok((await post(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status === 401, 'no token → 401');
    ok((await post('wk_bogus', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).status === 401, 'bad token → 401');

    step('Data plane: MCP initialize + a project-scoped tool call');
    const init = await post(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo', version: '0' } } });
    ok(init.json?.result?.serverInfo?.name === 'wairon', 'initialize → serverInfo wairon');
    const res = await post(key, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'sdd_get_status', arguments: {} } });
    const text = (res.json?.result?.content?.[0]?.text ?? '').trim();
    console.log('  ↳ sdd_get_status →', text);
    ok(text.includes('demo'), 'tool call scoped to the "demo" project (AsyncLocalStorage isolation)');
  } finally {
    server.kill();
  }

  step('Control plane: state-scoped lock → promote (matches)');
  console.log('  ' + cli(['host', 'lock', '--project', 'demo']));
  ok(/marked ready/i.test(cli(['host', 'promote', '--project', 'demo'])), 'promote after lock → ready');

  step('TOCTOU guard: edit a spec after locking → promote must refuse as stale');
  writeFileSync(specPath, readFileSync(specPath, 'utf8').replace(/vision:.*/, 'vision: edited after lock'));
  ok(/re-lock required/i.test(cli(['host', 'promote', '--project', 'demo'], { allowFail: true })), 'edit after lock → promote refuses (stale)');

  console.log(`\n${failures === 0 ? '✅ all checks passed' : `❌ ${failures} check(s) failed`}`);
}

main()
  .catch((err) => { console.error('\n' + err.stack); failures++; })
  .finally(() => { rmSync(DATA, { recursive: true, force: true }); process.exit(failures === 0 ? 0 : 1); });
