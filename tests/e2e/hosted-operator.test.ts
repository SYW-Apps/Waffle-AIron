import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { assertDistBuilt, DIST_CLI, rmrfWithRetry } from './helpers.js';

// ---------------------------------------------------------------------------
// The hosted operator's journey against the BUILT server: an instance set up
// with the `wairon host` commands, served on loopback, and driven over HTTP MCP
// with owner-bound keys the way a team's AI tools reach it. Covers who may
// approve a design (approval:decide, per role), the approval a hosted lock
// leaves for everyone's status, the startup line about the web UI, and
// registering a hosted AI tool from an empty folder.
// ---------------------------------------------------------------------------

const MASTER = 'e2e-master-credential-0123456789abcdef';
const PROJECT = 'kbase';

describe('hosted operator journey (built server)', () => {
  let base: string;
  let dataDir: string;
  let env: NodeJS.ProcessEnv;
  let server: ChildProcess;
  let port: number;
  let log = '';
  const keys: Record<string, string> = {};

  const cli = (...args: string[]): string =>
    execFileSync(process.execPath, [DIST_CLI, ...args, ...(args[0] === 'host' ? ['--data-dir', dataDir] : [])], {
      env, cwd: base, encoding: 'utf8', timeout: 120_000,
    });

  async function rpc(key: string, method: string, params: unknown): Promise<any> {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'x-wairon-project': PROJECT,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await res.text();
    const sse = text.match(/^data: (.*)$/m);
    return JSON.parse(sse ? sse[1] : text);
  }

  async function tool(key: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const body = await rpc(key, 'tools/call', { name, arguments: args });
    const content = (body.result?.content ?? []) as { text?: string }[];
    return { text: content.map((c) => c.text ?? '').join('\n') || JSON.stringify(body), isError: !!body.result?.isError || !!body.error };
  }

  const lockFile = () => path.join(dataDir, 'projects', PROJECT, '.wai', 'lock.json');

  beforeAll(async () => {
    assertDistBuilt();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-e2e-hosted-'));
    dataDir = path.join(base, 'data');
    env = { ...process.env, WAIRON_ADMIN_TOKEN: MASTER, WAIRON_DATA_DIR: dataDir, HOME: base, USERPROFILE: base };
    delete env['WAIRON_ADMIN_USER'];
    delete env['WAIRON_ADMIN_PASSWORD'];
    delete env['WAIRON_OIDC_ISSUER'];

    cli('host', 'unit', 'create', '--slug', 'team');
    cli('host', 'project', 'create', '--id', PROJECT, '--unit', 'team');
    const grant = (user: string, capability: string, ...scope: string[]) =>
      cli('host', 'permission', 'set', '--user', user, '--capability', capability, '--project', PROJECT, ...scope);
    for (const user of ['alice', 'bob', 'carol', 'dana']) grant(user, 'project:read');
    grant('alice', 'project:write');                      // an author
    grant('bob', 'project:write', '--subsystem', 'workflow'); // one subsystem only
    grant('dana', 'approval:decide');                     // a reviewer
    for (const user of ['alice', 'bob', 'carol', 'dana']) {
      keys[user] = (cli('host', 'key', 'mint', '--project', PROJECT, '--owner', user).match(/wk_[0-9a-f]+/) ?? [''])[0];
      expect(keys[user]).toMatch(/^wk_/);
    }

    server = spawn(process.execPath, [
      DIST_CLI, 'serve', '--host', '127.0.0.1', '--port', '0',
      '--admin-host', '127.0.0.1', '--admin-port', '0', '--data-dir', dataDir,
    ], { env, cwd: base, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout!.on('data', (d) => { log += String(d); });
    server.stderr!.on('data', (d) => { log += String(d); });
    for (let i = 0; i < 200 && !log.includes('hosting server started'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(log).toContain('hosting server started');
    // Both planes listen on port 0 (no free-port probe to race other tests); the start banner names the bound data-plane port.
    port = Number(/data plane:\s+http:\/\/127\.0\.0\.1:(\d+)\/mcp/.exec(log)?.[1]);
    expect(port).toBeGreaterThan(0);
    // The server upgrades its data dir at start (there is no `host doctor` any more) and records the running major.
    const version = JSON.parse(fs.readFileSync(path.join(dataDir, 'version.json'), 'utf8')) as Record<string, unknown>;
    expect(JSON.stringify(version)).toContain(String(WAIRON_MAJOR));

    const init = await tool(keys.alice, 'sdd_initialize_system', {
      name: PROJECT, vision: 'A team knowledge base for notes and pages.', targetLanguage: 'typescript',
    });
    expect(init.isError).toBe(false);
  });

  afterAll(async () => {
    server?.kill();
    await new Promise((r) => setTimeout(r, 300));
    if (base) await rmrfWithRetry(base);
  });

  it('says at startup that the web UI is off and where to turn it on', () => {
    expect(log).toMatch(/\[wairon web UI\] off/);
    expect(log).toContain('exposure-policy.json');
    expect(log).toContain('Web UI and sign-in');
  });

  it('a read-only user may neither lock nor request one', async () => {
    const res = await tool(keys.carol, 'sdd_host_lock_project');
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Forbidden/);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('a user who may write only one subsystem may neither lock nor request one', async () => {
    const res = await tool(keys.bob, 'sdd_host_lock_project');
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Forbidden/);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('an author without approval:decide only requests the lock, even with it explicitly denied', async () => {
    const first = JSON.parse((await tool(keys.alice, 'sdd_host_lock_project')).text);
    expect(first.status).toBe('pending-approval');
    cli('host', 'permission', 'set', '--user', 'alice', '--capability', 'approval:decide', '--value', 'no', '--project', PROJECT);
    const second = JSON.parse((await tool(keys.alice, 'sdd_host_lock_project')).text);
    expect(second.status).toBe('pending-approval');
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('a reviewer holding approval:decide locks, and the approval reads clean for everyone', async () => {
    const outcome = JSON.parse((await tool(keys.dana, 'sdd_host_lock_project')).text);
    expect(outcome.status).toBe('completed');
    expect(fs.existsSync(lockFile())).toBe(true);

    for (const user of ['alice', 'carol']) {
      const status = (await tool(keys[user], 'sdd_get_status')).text;
      expect(status).toMatch(/this project is approved/);
      expect(status).not.toMatch(/gate parts are ignored/);
    }
  });

  it('registers a hosted AI tool from an empty folder, and the tool then reaches the hosted project', async () => {
    const empty = path.join(base, 'alice-tool');
    fs.mkdirSync(empty);
    execFileSync(process.execPath, [
      DIST_CLI, 'mcp', 'install', '--hosted', `http://127.0.0.1:${port}`, '--project', PROJECT,
      '--token', keys.alice, '--backend', 'claude',
    ], { env, cwd: empty, encoding: 'utf8', timeout: 120_000 });

    expect(fs.readdirSync(empty)).toEqual(['.mcp.json']);
    const entry = JSON.parse(fs.readFileSync(path.join(empty, '.mcp.json'), 'utf8')).mcpServers.wairon;
    expect(entry.url).toBe(`http://127.0.0.1:${port}/mcp`);

    // What the AI tool sends with that entry lists the hosted tools.
    const res = await fetch(entry.url, {
      method: 'POST',
      headers: { ...entry.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const text = await res.text();
    const sse = text.match(/^data: (.*)$/m);
    const names = (JSON.parse(sse ? sse[1] : text).result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain('sdd_get_status');
    expect(names).toContain('sdd_host_lock_project');
  });
});
