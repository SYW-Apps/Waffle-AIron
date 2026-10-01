import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleMcpRequest } from '../../src/server/request.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { createProjectRecord } from '../../src/server/projects.js';
import * as transaction from '../../src/migrations/transaction.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage 6 — hosted recovery. A hosted project has no person to run
// `wairon doctor --fix` in its directory, so the data plane rolls back a
// family migration a crash left unfinished when it next binds the project,
// before any tool touches the tree, and audits it (migration.recovered).
// Driven end to end over a real HTTP listener; the crash is a real staged and
// half-swapped transaction on disk.
// ---------------------------------------------------------------------------

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
});

function put(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function digests(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

describe('hosted: an unfinished family migration is rolled back on the next bind', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let url: string;
  let root: string;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-host-recover-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: false };
    root = createProjectRecord(dataDir, 'demo').rootPath;
    put(path.join(root, '.wai', 'project.yaml'), "schemaVersion: '1.0.0'\nid: demo\nname: Demo\ntargets: []\n");
    put(path.join(root, '.wai', 'specs', '.index.yaml'), "schemaVersion: '1.0.0'\nname: Demo\nvision: A hosted project.\n");
    put(path.join(root, 'member', '.wai', 'project.yaml'), "schemaVersion: '1.0.0'\nid: member\nname: Member\ntargets: []\n");

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        void handleMcpRequest(cfg, req, res, body).catch(() => {
          if (!res.headersSent) { res.writeHead(500); res.end(); }
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp?project=demo`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  const post = (bodyObj: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(bodyObj),
    });

  /** A migration that crashed mid-swap: staged in both owners, the top's files swapped, the member's not. */
  function crashMidSwap(): void {
    const member = path.join(root, 'member');
    const rehearsal = transaction.rehearse({ familyRoot: root, projects: [root, member] });
    put(path.join(rehearsal.directory, '.wai', 'project.yaml'), "schemaVersion: '1.0.0'\nid: renamed\nname: Demo\ntargets: []\n");
    put(path.join(rehearsal.directory, '.wai', 'specs', 'types', 'new.yaml'), 'id: new\n');
    put(path.join(rehearsal.directory, 'member', '.wai', 'project.yaml'), "schemaVersion: '1.0.0'\nid: member\nname: Member\ntargets: []\nexternals:\n  renamed: {}\n");
    const journals = transaction.stage(rehearsal, transaction.diff(rehearsal), 'rename');
    // The process dies after the coordinator's owner swapped and before the member's did.
    journals[0].phase = 'swapping';
    transaction.swap(journals.slice(0, 1));
    transaction.discard(rehearsal);
  }

  it('rolls the crash back before the tool runs, audits it, and the family is byte-identical to before', async () => {
    const before = digests(root);
    crashMidSwap();
    expect(digests(root)).not.toEqual(before);

    const res = await post(call('sdd_get_status'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { content?: { text?: string }[] } };
    // The tool read the rolled-back tree: no banner, nothing pending.
    expect(JSON.stringify(body.result?.content ?? [])).not.toContain('TRANSACTION PENDING');

    expect(digests(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, '.wai', 'transactions'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'member', '.wai', 'transactions'))).toBe(false);

    const recovered = queryAuditEvents(dataDir, { action: 'migration.recovered' });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ category: 'project', outcome: 'success', projectId: 'demo', level: 'info' });
    expect(JSON.parse(recovered[0].metadata ?? '{}')).toMatchObject({ verb: 'rename', phase: 'swapping', action: 'rolled-back' });

    // The next request finds nothing to recover and audits no second rollback.
    await (await post(call('sdd_get_status'))).json();
    expect(queryAuditEvents(dataDir, { action: 'migration.recovered' })).toHaveLength(1);
  });

  it('with nothing unfinished the bind writes nothing and audits nothing', async () => {
    const before = digests(root);
    await (await post(call('sdd_get_status'))).json();
    expect(queryAuditEvents(dataDir, { action: 'migration.recovered' })).toHaveLength(0);
    const after = digests(root);
    for (const [rel, digest] of Object.entries(before)) expect(after[rel]).toBe(digest);
  });
});
