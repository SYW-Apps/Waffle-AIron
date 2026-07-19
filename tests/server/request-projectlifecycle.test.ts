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
import { hostCore } from '../../src/server/adapters.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { lockProject } from '../../src/server/projectlifecycle.js';
import { listApprovalRequests } from '../../src/server/approvals.js';
import { setAssignment } from '../../src/server/permissions.js';
import { createUnit } from '../../src/server/organization.js';
import type {
  ApiKeyRecord,
  Capability,
  HostConfig,
  PermissionValue,
  PrincipalSubject,
  ProjectActionOutcome,
  ScopeKind,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator — data-plane project-lifecycle dispatch (sdd_host).
//
// Steps 10–24 of handleRequest: after the project root is resolved and bound, a
// `tools/call` for one of the five execute-primary project-lifecycle tools
// (sdd_host_initialize_project / _lock_project / _promote_project /
// _get_approval_status / _await_approval) is dispatched to the project lifecycle
// orchestrator instead of the scoped sdd_* MCP server, then shaped into the
// standard MCP tool-result envelope and audited through the SAME best-effort
// path. Every other tool (including an unknown sdd_host_* name) falls through to
// the scoped server.
//
// Driven end-to-end over a real HTTP listener (like the shipped demo) with auth
// enabled and real minted credentials, so the whole authenticate → resolve+bind →
// lifecycle dispatch → response wiring is exercised as it runs in production.
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

describe('handleMcpRequest project-lifecycle dispatch (end-to-end)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-req-plc-e2e-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

    // A registered, PROVISIONED isolated project every request is scoped to —
    // execute-primary means a yes-valued lock really validates the tree.
    const demo = createProjectRecord(dataDir, 'demo');
    runWithProjectRoot(demo.rootPath, () => hostCore.provisionProject('demo'));

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

  /** Mint a stored grants-free token owned by `userId`; returns the plaintext
   *  bearer. Permissions come exclusively from the assignment grid. */
  function mintToken(opts: { id: string; projects: string[]; userId: string }): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: opts.id,
      keyHash: hashToken(token),
      projects: opts.projects,
      createdAt: new Date().toISOString(),
      ownerSubject: subject({ userId: opts.userId }),
    };
    createCredential(dataDir, record);
    return token;
  }

  /** Seed one assignment in the permission grid. */
  function allow(
    userId: string,
    capability: Capability,
    scopeKind: ScopeKind,
    scopeId: string | undefined,
    value: PermissionValue,
  ): void {
    setAssignment(dataDir, {
      id: '',
      subjectKind: 'user',
      subjectId: userId,
      scopeKind,
      ...(scopeId !== undefined ? { scopeId } : {}),
      capability,
      value,
      createdAt: '',
    });
  }

  /** An editor agent token scoped to `project`: read+write resolve yes there
   *  (may drive ordinary sdd_* tools) and project:write resolves 'approval'
   *  when overridden per test. */
  function agentToken(id: string, project: string, userId: string): string {
    allow(userId, 'project:read', 'project', project, 'yes');
    allow(userId, 'project:write', 'project', project, 'yes');
    return mintToken({ id, projects: [project], userId });
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

  it('initialize with an approval-valued permission → pending-approval outcome + persisted + audited', async () => {
    const unit = createUnit(dataDir, {
      id: '', name: 'Makers', slug: 'makers', kind: 'team', status: 'active', createdAt: '', createdBy: subject(),
    });
    const token = agentToken('agent-init', 'demo', 'u-agent');
    allow('u-agent', 'project:create', 'unit', unit.id, 'approval');

    const res = await post(
      call('sdd_host_initialize_project', { id: 'brand-new', displayName: 'Brand New', ownerUnitId: unit.id }),
      token,
    );
    const jsonBody = (await res.json()) as RpcResponse;

    // The lifecycle result is shaped into the standard MCP tool-result envelope.
    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    const outcome = JSON.parse(toolText(jsonBody)) as ProjectActionOutcome;
    expect(outcome.status).toBe('pending-approval');
    expect(outcome.action).toBe('project:init');
    expect(outcome.approval?.kind).toBe('project:init');
    expect(outcome.approval?.projectId).toBe('brand-new'); // from the decoded init arguments
    expect(outcome.approval?.id).toBeTruthy();

    // The pending request is persisted in approvals.json.
    const pending = listApprovalRequests(dataDir, 'pending');
    expect(pending.map((p) => p.id)).toContain(outcome.approval!.id);

    // An mcp.tool.call audit event captures the lifecycle tool by name.
    const events = queryAuditEvents(dataDir, { action: 'mcp.tool.call' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      target: 'sdd_host_initialize_project',
      projectId: 'demo',
      outcome: 'success',
      tokenId: 'agent-init',
    });
  }, 20_000);

  it('initialize with NO project:create reach → isError Forbidden (execute-primary denies, it does not queue)', async () => {
    const unit = createUnit(dataDir, {
      id: '', name: 'Closed', slug: 'closed', kind: 'team', status: 'active', createdAt: '', createdBy: subject(),
    });
    const token = agentToken('agent-denied', 'demo', 'u-denied');

    const res = await post(call('sdd_host_initialize_project', { id: 'nope', ownerUnitId: unit.id }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBe(true);
    expect(toolText(jsonBody).toLowerCase()).toContain('forbidden');
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  }, 20_000);

  it('lock with a yes-valued permission EXECUTES on the BOUND project — an argument-supplied project id is ignored', async () => {
    const token = agentToken('agent-lock', 'demo', 'u-lock');

    // The caller tries to name a different project in the arguments; it must be ignored.
    const res = await post(call('sdd_host_lock_project', { projectId: 'some-other-project' }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    const outcome = JSON.parse(toolText(jsonBody)) as ProjectActionOutcome;
    expect(outcome.status).toBe('completed'); // executed directly, no approval
    expect(outcome.action).toBe('project:lock');
    expect(outcome.summary).toContain('Locked project "demo"'); // bound project, NOT 'some-other-project'
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  }, 20_000);

  it('lock with an approval-valued permission creates the pending request instead', async () => {
    const token = mintToken({ id: 'agent-appr', projects: ['demo'], userId: 'u-appr' });
    allow('u-appr', 'project:write', 'project', 'demo', 'approval');

    const res = await post(call('sdd_host_lock_project'), token);
    const jsonBody = (await res.json()) as RpcResponse;

    expect(jsonBody.result?.isError).toBeFalsy();
    const outcome = JSON.parse(toolText(jsonBody)) as ProjectActionOutcome;
    expect(outcome.status).toBe('pending-approval');
    expect(outcome.approval?.kind).toBe('project:lock');
    expect(outcome.approval?.projectId).toBe('demo');
    expect(outcome.approval?.summary).toBe('Lock project demo');
  }, 20_000);

  it('returns the requester’s own approval request via sdd_host_get_approval_status', async () => {
    const token = mintToken({ id: 'agent-status', projects: ['demo'], userId: 'u-status' });
    allow('u-status', 'project:write', 'project', 'demo', 'approval');
    // Seed a pending request owned by this token directly through the orchestrator.
    const seeded = lockProject(cfg, token, 'demo').approval!;

    const res = await post(call('sdd_host_get_approval_status', { requestId: seeded.id }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    const got = JSON.parse(toolText(jsonBody)) as { id: string; status: string };
    expect(got.id).toBe(seeded.id);
    expect(got.status).toBe('pending');
  }, 20_000);

  it('awaits an approval with a zero timeout: returns the still-pending request immediately', async () => {
    const token = mintToken({ id: 'agent-await', projects: ['demo'], userId: 'u-await' });
    allow('u-await', 'project:write', 'project', 'demo', 'approval');
    const seeded = lockProject(cfg, token, 'demo').approval!;

    const res = await post(call('sdd_host_await_approval', { requestId: seeded.id, timeoutSeconds: 0 }), token);
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    const got = JSON.parse(toolText(jsonBody)) as { id: string; status: string };
    expect(got.id).toBe(seeded.id);
    expect(got.status).toBe('pending');
  }, 20_000);

  it('denies reading another caller’s approval request → isError tool result, HTTP still 200', async () => {
    const ownerTok = mintToken({ id: 'owner-tok', projects: ['demo'], userId: 'u-owner' });
    allow('u-owner', 'project:write', 'project', 'demo', 'approval');
    // A different, unprivileged token (read-only reach, no approval:decide, other subject).
    const stranger = mintToken({ id: 'stranger-tok', projects: ['demo'], userId: 'u-stranger' });
    allow('u-stranger', 'project:read', 'project', 'demo', 'yes');
    const owned = lockProject(cfg, ownerTok, 'demo').approval!;

    const res = await post(call('sdd_host_get_approval_status', { requestId: owned.id }), stranger);
    const jsonBody = (await res.json()) as RpcResponse;

    // A forbidden lifecycle call is an isError tool result, not an HTTP error.
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
    // lifecycle dispatch did NOT intercept a non-whitelisted sdd_host_* name.
    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBe(true);
    expect(toolText(jsonBody)).toContain('sdd_host_not_a_real_tool not found');
    // And nothing approval-shaped was created by the lifecycle path.
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  }, 20_000);

  it('leaves a normal sdd_* tool call unaffected (regression)', async () => {
    const token = agentToken('agent-normal', 'demo', 'u-normal');

    const res = await post(call('sdd_get_status'), token);
    const jsonBody = (await res.json()) as RpcResponse;

    // Handled by the scoped server: a standard tool result comes back, and the
    // lifecycle path created no approval request.
    expect(res.status).toBe(200);
    expect(jsonBody.result).toBeDefined();
    expect(jsonBody.result?.content?.[0]?.text).toBeTypeOf('string');
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  }, 20_000);
});
