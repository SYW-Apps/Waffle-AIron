import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { handleMcpRequest } from '../../src/server/request.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { requestProjectLock, getRequestStatus } from '../../src/server/selfservice.js';
import { listApprovalRequests } from '../../src/server/approvals.js';
import type {
  ApiKeyRecord,
  HostConfig,
  PrincipalSubject,
  ProjectGrant,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator — data-plane self-service dispatch (sdd_host).
//
// Steps 10–20 of handleRequest: after the project root is resolved and bound, a
// `tools/call` for one of the four approval-backed self-service tools
// (sdd_host_request_project_initialization / _lock / _promotion /
// sdd_host_get_approval_status) is dispatched to the self-service orchestrator
// instead of the scoped sdd_* MCP server, then shaped into the standard MCP
// tool-result envelope and audited through the SAME best-effort path. Every other
// tool (including an unknown sdd_host_* name) falls through to the scoped server.
//
// Driven end-to-end over a real HTTP listener (like the shipped demo) with auth
// enabled and real minted credentials, so the whole authenticate → resolve+bind →
// self-service dispatch → response wiring is exercised as it runs in production.
// ---------------------------------------------------------------------------

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

describe('handleMcpRequest self-service dispatch (end-to-end)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-req-ss-e2e-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

    // A registered, active isolated project every request is scoped to.
    createProjectRecord(dataDir, 'demo');

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
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Mint a stored token with a known id, projects, grants, and owner subject;
   *  returns the plaintext bearer. */
  function mintToken(opts: { id: string; projects: string[]; grants: ProjectGrant[]; userId: string }): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: opts.id,
      keyHash: hashToken(token),
      role: 'editor',
      projects: opts.projects,
      grants: opts.grants,
      createdAt: new Date().toISOString(),
      ownerSubject: subject({ userId: opts.userId }),
    };
    createCredential(dataDir, record);
    return token;
  }

  /** An editor agent token scoped to `project` with mcp:read + mcp:write over it
   *  (may request actions and drive ordinary read/write sdd_* tools). */
  function agentToken(id: string, project: string, userId: string): string {
    return mintToken({
      id,
      projects: [project],
      grants: [{ projectId: project, permissions: ['mcp:read', 'mcp:write'] }],
      userId,
    });
  }

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

  it('requests project initialization via MCP → pending ApprovalRequest + persisted + audited', async () => {
    const token = agentToken('agent-init', 'demo', 'u-agent');

    const res = await post(call('sdd_host_request_project_initialization', { id: 'brand-new', displayName: 'Brand New' }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    // The self-service result is shaped into the standard MCP tool-result envelope.
    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    const approval = JSON.parse(toolText(jsonBody)) as { id: string; kind: string; status: string; projectId: string };
    expect(approval.status).toBe('pending');
    expect(approval.kind).toBe('project:init');
    expect(approval.projectId).toBe('brand-new'); // from the decoded init arguments
    expect(approval.id).toBeTruthy();

    // The pending request is persisted in approvals.json.
    const pending = listApprovalRequests(dataDir, 'pending');
    expect(pending.map((p) => p.id)).toContain(approval.id);

    // An mcp.tool.call audit event captures the self-service tool by name.
    const events = queryAuditEvents(dataDir, { action: 'mcp.tool.call' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      target: 'sdd_host_request_project_initialization',
      projectId: 'demo',
      outcome: 'success',
      tokenId: 'agent-init',
    });
  }, 20_000);

  it('scopes a lock request to the BOUND project — an argument-supplied project id is ignored', async () => {
    const token = agentToken('agent-lock', 'demo', 'u-lock');

    // The caller tries to name a different project in the arguments; it must be ignored.
    const res = await post(call('sdd_host_request_project_lock', { projectId: 'some-other-project' }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    const approval = JSON.parse(toolText(jsonBody)) as { kind: string; projectId: string; summary: string };
    expect(approval.kind).toBe('project:lock');
    expect(approval.projectId).toBe('demo'); // bound project, NOT 'some-other-project'
    expect(approval.summary).toBe('Lock project demo');
  }, 20_000);

  it('returns the requester’s own approval request via sdd_host_get_approval_status', async () => {
    const token = agentToken('agent-status', 'demo', 'u-status');
    // Seed a request owned by this token directly through the orchestrator.
    const seeded = requestProjectLock(cfg, token, 'demo');

    const res = await post(call('sdd_host_get_approval_status', { requestId: seeded.id }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    const got = JSON.parse(toolText(jsonBody)) as { id: string; status: string };
    expect(got.id).toBe(seeded.id);
    expect(got.status).toBe('pending');
  }, 20_000);

  it('denies reading another caller’s approval request → isError tool result, HTTP still 200', async () => {
    const owner = agentToken('owner-tok', 'demo', 'u-owner');
    // A different, unprivileged token (mcp:read only, no approval:decide, other subject).
    const stranger = mintToken({
      id: 'stranger-tok',
      projects: ['demo'],
      grants: [{ projectId: 'demo', permissions: ['mcp:read'] }],
      userId: 'u-stranger',
    });
    const owned = requestProjectLock(cfg, owner, 'demo');

    const res = await post(call('sdd_host_get_approval_status', { requestId: owned.id }), stranger);
    const jsonBody = (await res.json()) as RpcResponse;

    // A forbidden self-service call is an isError tool result, not an HTTP error.
    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBe(true);
    expect(toolText(jsonBody).toLowerCase()).toContain('forbidden');
    // The stranger must not learn anything about the request beyond the denial.
    expect(toolText(jsonBody)).not.toContain(owned.id);
  }, 20_000);

  it('does not intercept an unknown sdd_host_* tool — it falls through to the scoped server', async () => {
    const token = agentToken('agent-unknown', 'demo', 'u-unknown');

    const res = await post(call('sdd_host_not_a_real_tool', { foo: 'bar' }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    // The scoped MCP server rejects the unknown tool with its OWN "Tool ... not
    // found" message — proving the request fell through to it, and that the
    // self-service dispatch did NOT intercept a non-whitelisted sdd_host_* name.
    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBe(true);
    expect(toolText(jsonBody)).toContain('sdd_host_not_a_real_tool not found');
    // And nothing approval-shaped was created by the self-service path.
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  }, 20_000);

  it('leaves a normal sdd_* tool call unaffected (regression)', async () => {
    const token = agentToken('agent-normal', 'demo', 'u-normal');

    const res = await post(call('sdd_get_status'), token);
    const jsonBody = (await res.json()) as RpcResponse;

    // Handled by the scoped server: a standard tool result comes back, and the
    // self-service path created no approval request.
    expect(res.status).toBe(200);
    expect(jsonBody.result).toBeDefined();
    expect(jsonBody.result?.content?.[0]?.text).toBeTypeOf('string');
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  }, 20_000);
});
