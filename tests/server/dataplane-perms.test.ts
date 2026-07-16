import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { handleMcpRequest } from '../../src/server/request.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { mintUserToken, allow } from './helpers.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator — granular data-plane permissions (sdd_host).
//
// Steps 25–27 of handleRequest: on the ordinary sdd_* dispatch path (NOT the
// already-gated project-lifecycle / landscape branch), the tool is classified as
// a read (sdd_get_ / sdd_validate_) or a write (sdd_add_ / sdd_update_ /
// sdd_delete_ / sdd_write_ / sdd_define_ / sdd_set_ / sdd_initialize_ /
// sdd_externalize_ / sdd_internalize_ / sdd_move_, and unknown → write, fail
// safe). The caller's RESOLVED permission for the BOUND project must be
// yes-valued project:read for a read or project:write for a write. A missing
// permission is an isError tool result (HTTP still 200) and the tool is NOT
// dispatched.
//
// Resolves through the permission resolver over the token OWNER's assignments —
// the token itself carries nothing — so a read-only owner is refused writes.
//
// Driven end-to-end over a real HTTP listener with auth enabled and real minted
// credentials, mirroring request-projectlifecycle.test.ts.
// ---------------------------------------------------------------------------

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

// A representative sample across every write and read prefix in the classifier.
const WRITE_TOOLS = [
  'sdd_add_subsystem',
  'sdd_update_spec',
  'sdd_delete_spec',
  'sdd_write_narrative',
  'sdd_define_interface',
  'sdd_set_endpoints',
  'sdd_initialize_system',
  'sdd_externalize_subsystem',
  'sdd_internalize_subsystem',
  'sdd_move_subsystem_project',
];
const READ_TOOLS = ['sdd_get_status', 'sdd_validate_tree', 'sdd_get_spec'];

describe('handleMcpRequest granular data-plane permissions (end-to-end)', () => {
  let dataDir: string;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dp-perms-'));
    fs.mkdirSync(dataDir, { recursive: true });

    // A registered, active isolated project every request is scoped to.
    createProjectRecord(dataDir, 'demo');

    const cfg: HostConfig = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
    };

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = undefined;
        }
        void handleMcpRequest(cfg, req, res, body).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** A token whose OWNER holds only project:read over the bound project. */
  const readOnly = () => {
    allow(dataDir, 'u-read-only', 'project:read', 'project', 'demo');
    return mintUserToken(dataDir, { id: 'read-only', userId: 'u-read-only', projects: ['demo'] });
  };
  /** A token whose OWNER holds project:read + project:write over the project. */
  const readWrite = () => {
    allow(dataDir, 'u-read-write', 'project:read', 'project', 'demo');
    allow(dataDir, 'u-read-write', 'project:write', 'project', 'demo');
    return mintUserToken(dataDir, { id: 'read-write', userId: 'u-read-write', projects: ['demo'] });
  };
  /** A token whose OWNER holds instance-level read+write (covers every project). */
  const instanceWide = () => {
    allow(dataDir, 'u-instance', 'project:read', 'instance', undefined);
    allow(dataDir, 'u-instance', 'project:write', 'instance', undefined);
    return mintUserToken(dataDir, { id: 'instance-wide', userId: 'u-instance', projects: ['*'] });
  };

  const post = (bodyObj: unknown, token: string) =>
    fetch(`http://127.0.0.1:${port}/mcp?project=demo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(bodyObj),
    });

  interface RpcResponse {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { code?: number; message?: string };
  }
  const toolText = (r: RpcResponse): string => r.result?.content?.[0]?.text ?? '';
  /** True when the response is the granular-permission refusal (never a scoped-server error). */
  const isPermRefusal = (r: RpcResponse): boolean =>
    r.result?.isError === true && /required for /.test(toolText(r));

  it('read-only token: reads sdd_get_status but is refused writes (isError, HTTP 200)', async () => {
    const tok = readOnly();

    // Read is allowed → the gate lets it through to the scoped server (whose own
    // outcome on this bare project is irrelevant to the permission gate).
    const readRes = await post(call('sdd_get_status'), tok);
    const readBody = (await readRes.json()) as RpcResponse;
    expect(readRes.status).toBe(200);
    expect(isPermRefusal(readBody)).toBe(false);
    expect(readBody.result?.content?.[0]?.text).toBeTypeOf('string');

    // Writes are refused with a clear permission message — never dispatched.
    for (const tool of ['sdd_initialize_system', 'sdd_add_subsystem']) {
      const res = await post(call(tool), tok);
      const body = (await res.json()) as RpcResponse;
      expect(res.status).toBe(200); // an authorization denial is a tool result, not an HTTP error
      expect(body.result?.isError).toBe(true);
      expect(toolText(body)).toContain(`project:write required for ${tool}`);
    }
  }, 20_000);

  it('SECURITY: a read-only token cannot smuggle a write in a JSON-RPC batch (bypass refused)', async () => {
    const tok = readOnly();

    // The permission gate historically inspected only the FIRST batch message,
    // while the transport dispatches EVERY message — a read tool up front and a
    // write tool behind it would have run the write on a read-only grant. The
    // data plane now refuses multi-request batches outright (HTTP 400, no
    // dispatch), so the write never executes.
    const batch = [call('sdd_get_status'), { ...call('sdd_initialize_system'), id: 2 }];
    const res = await post(batch, tok);
    expect(res.status).toBe(400);
    const body = (await res.json()) as RpcResponse;
    expect(body.error?.code).toBe(-32600);
    expect(body.error?.message ?? '').toMatch(/one tool call per request/i);
  }, 20_000);

  it('even an instance-wide grant may not batch (single tool call per request)', async () => {
    const tok = instanceWide();
    const res = await post([call('sdd_get_status'), { ...call('sdd_get_spec'), id: 2 }], tok);
    expect(res.status).toBe(400);
  }, 20_000);

  it('read/write token: allowed both a read and a write (write passes the gate)', async () => {
    const tok = readWrite();

    const readRes = await post(call('sdd_get_status'), tok);
    const readBody = (await readRes.json()) as RpcResponse;
    expect(isPermRefusal(readBody)).toBe(false);

    // The write is NOT refused by the gate — it reaches the scoped server (whose
    // own outcome is irrelevant to the permission gate under test).
    const writeRes = await post(call('sdd_add_subsystem'), tok);
    const writeBody = (await writeRes.json()) as RpcResponse;
    expect(writeRes.status).toBe(200);
    expect(isPermRefusal(writeBody)).toBe(false);
  }, 20_000);

  it('an instance-level read+write owner covers both on every project', async () => {
    const tok = instanceWide();

    const readBody = (await (await post(call('sdd_get_status'), tok)).json()) as RpcResponse;
    expect(isPermRefusal(readBody)).toBe(false);

    const writeBody = (await (await post(call('sdd_add_subsystem'), tok)).json()) as RpcResponse;
    expect(isPermRefusal(writeBody)).toBe(false);
  }, 20_000);

  it('an approval-valued project:write does NOT pass the data-plane gate (only yes acts)', async () => {
    allow(dataDir, 'u-approval', 'project:read', 'project', 'demo');
    allow(dataDir, 'u-approval', 'project:write', 'project', 'demo', 'approval');
    const tok = mintUserToken(dataDir, { id: 'approval-tok', userId: 'u-approval', projects: ['demo'] });

    const writeBody = (await (await post(call('sdd_add_subsystem'), tok)).json()) as RpcResponse;
    expect(writeBody.result?.isError).toBe(true);
    expect(toolText(writeBody)).toContain('project:write required for sdd_add_subsystem');
  }, 20_000);

  it('classifies every write prefix as a write (read-only token → refused)', async () => {
    const tok = readOnly();
    for (const tool of WRITE_TOOLS) {
      const body = (await (await post(call(tool), tok)).json()) as RpcResponse;
      expect(body.result?.isError).toBe(true);
      expect(toolText(body)).toContain(`project:write required for ${tool}`);
    }
  }, 30_000);

  it('classifies every read prefix as a read (read-only token → not refused by the gate)', async () => {
    const tok = readOnly();
    for (const tool of READ_TOOLS) {
      const body = (await (await post(call(tool, { kind: 'component', id: 'x' }), tok)).json()) as RpcResponse;
      // The gate lets reads through; a scoped-server error (e.g. not found) is not
      // a permission refusal.
      expect(isPermRefusal(body)).toBe(false);
    }
  }, 20_000);

  it('an unknown tool is treated as a write (fail safe): read-only token refused', async () => {
    const tok = readOnly();
    const body = (await (await post(call('sdd_frobnicate_everything'), tok)).json()) as RpcResponse;
    expect(body.result?.isError).toBe(true);
    expect(toolText(body)).toContain('project:write required for sdd_frobnicate_everything');
  }, 20_000);
});
