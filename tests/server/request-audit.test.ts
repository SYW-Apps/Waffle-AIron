import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  auditToolCall,
  deriveMcpOutcome,
  mcpToolTarget,
  handleMcpRequest,
} from '../../src/server/request.js';
import { queryAuditEvents, countAuditEvents } from '../../src/server/audit.js';
import { createProjectRecord } from '../../src/server/projects.js';
import type { HostConfig, Principal, PrincipalSubject } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator — data-plane audit append (sdd_host).
//
// Steps 12–17 of handleRequest: after the scoped MCP dispatch, a redacted
// `mcp.tool.call` audit event is appended under the default retention policy.
// A read-only success is excluded by policy; a failing call is captured as
// 'failed'; an append failure is recorded as a diagnostic and NEVER fails the
// request; a legacy principal (no subject) gets a synthesized service actor.
//
// The pure derivation/append helpers are exercised directly, and the whole
// pipeline is driven end-to-end over a real HTTP listener (the way the shipped
// demo does) to prove the response is always returned unchanged.
// ---------------------------------------------------------------------------

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

const SUBJECT: PrincipalSubject = { userId: 'u-9', kind: 'human', issuer: 'local' };
const withSubject: Principal = {
  tokenId: 'tok-1',
  role: 'editor',
  projects: ['demo'],
  authenticated: true,
  subject: SUBJECT,
};
const legacy: Principal = {
  tokenId: 'tok-legacy',
  role: 'editor',
  projects: ['demo'],
  authenticated: true,
};

describe('data-plane audit helpers (steps 12–17)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-req-audit-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── target / outcome derivation ────────────────────────────────────────────

  it('derives the audit target: tools/call → tool name, otherwise the JSON-RPC method', () => {
    expect(mcpToolTarget(call('sdd_add_component'))).toBe('sdd_add_component');
    expect(mcpToolTarget({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).toBe('tools/list');
    // tools/call with no params.name falls back to the method itself.
    expect(mcpToolTarget({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })).toBe('tools/call');
    // Nothing dispatchable → nothing to audit.
    expect(mcpToolTarget(undefined)).toBeUndefined();
    expect(mcpToolTarget({})).toBeUndefined();
  });

  it('derives the outcome from the JSON-RPC response the server emitted', () => {
    expect(deriveMcpOutcome({ jsonrpc: '2.0', id: 1, result: { content: [] } })).toBe('success');
    expect(deriveMcpOutcome({ jsonrpc: '2.0', id: 1, result: { content: [], isError: true } })).toBe('failed');
    expect(deriveMcpOutcome({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } })).toBe('failed');
    // No captured response is treated as a (non-error) success.
    expect(deriveMcpOutcome(undefined)).toBe('success');
  });

  // ── append behavior ────────────────────────────────────────────────────────

  it('appends exactly one mcp.tool.call event for a successful non-read tool call', () => {
    auditToolCall(dataDir, withSubject, 'demo', call('sdd_add_component'), 'success');

    const events = queryAuditEvents(dataDir, {});
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.action).toBe('mcp.tool.call');
    expect(e.category).toBe('mcp');
    expect(e.level).toBe('info');
    expect(e.outcome).toBe('success');
    expect(e.target).toBe('sdd_add_component');
    expect(e.tokenId).toBe('tok-1');
    expect(e.projectId).toBe('demo');
    expect(e.actor).toEqual(SUBJECT);
    // requestId is not tracked in this phase.
    expect(e.requestId).toBeUndefined();
  });

  it('appends nothing for a successful read-only call under the default policy', () => {
    auditToolCall(dataDir, withSubject, 'demo', call('sdd_get_status'), 'success');
    expect(countAuditEvents(dataDir, {})).toBe(0);
    // The default (secure) policy never even touches disk for an excluded read.
    expect(fs.existsSync(path.join(dataDir, 'audit-events.json'))).toBe(false);
  });

  it("records outcome 'failed' for a failing tool call (a failed read is still captured)", () => {
    auditToolCall(dataDir, withSubject, 'demo', call('sdd_validate_tree'), 'failed');
    // Reads are only excludable when they SUCCEED, so a failed read is captured.
    auditToolCall(dataDir, withSubject, 'demo', call('sdd_get_status'), 'failed');

    const events = queryAuditEvents(dataDir, {});
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.outcome === 'failed')).toBe(true);
    expect(events.map((e) => e.target).sort()).toEqual(['sdd_get_status', 'sdd_validate_tree']);
  });

  it('synthesizes a service actor for a legacy principal without a subject', () => {
    auditToolCall(dataDir, legacy, 'demo', call('sdd_add_subsystem'), 'success');
    const [e] = queryAuditEvents(dataDir, {});
    expect(e.actor).toEqual({ userId: 'token:tok-legacy', kind: 'service', issuer: 'local' });
    expect(e.tokenId).toBe('tok-legacy');
  });

  it('never throws when the audit append fails — records a diagnostic instead', () => {
    // Plant a directory where the events file must be, so the repository read
    // fails with a storage error the moment append tries to load the store.
    fs.mkdirSync(path.join(dataDir, 'audit-events.json'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      auditToolCall(dataDir, withSubject, 'demo', call('sdd_add_component'), 'success'),
    ).not.toThrow();
    expect(spy).toHaveBeenCalledOnce();

    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// End-to-end: drive handleRequest over a real HTTP listener (no auth, project
// named via ?project=) exactly like examples/hosted-server/demo.mjs. Proves the
// dispatch → response-capture → audit wiring, and that the MCP response is
// always returned unchanged — even when the audit append fails.
// ---------------------------------------------------------------------------

describe('handleMcpRequest data-plane audit (end-to-end)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let url: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-req-audit-e2e-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: false };

    // A registered, active isolated project the request can be scoped to.
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
    const addr = server.address() as AddressInfo;
    url = `http://127.0.0.1:${addr.port}/mcp?project=demo`;
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

  const post = (bodyObj: unknown) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(bodyObj),
    });

  it('audits a real failing tool call as outcome "failed" and returns the MCP response', async () => {
    // sdd_get_spec on a missing id deterministically returns an isError result.
    const res = await post(call('sdd_get_spec', { kind: 'component', id: 'does-not-exist' }));
    const jsonBody = (await res.json()) as { result?: { isError?: boolean } };

    // The response is returned to the client unchanged.
    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBe(true);

    // Exactly one redacted mcp.tool.call event with the derived fields.
    const events = queryAuditEvents(dataDir, {});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'mcp.tool.call',
      category: 'mcp',
      level: 'info',
      outcome: 'failed',
      target: 'sdd_get_spec',
      projectId: 'demo',
      tokenId: 'anonymous',
    });
    // Trusted-network (no-auth) principal has no subject → synthesized actor.
    expect(events[0].actor).toEqual({ userId: 'token:anonymous', kind: 'service', issuer: 'local' });
  }, 20_000);

  it('still returns the MCP response when the audit append fails', async () => {
    // Force the append to fail by planting a directory at the events file path.
    fs.mkdirSync(path.join(dataDir, 'audit-events.json'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post(call('sdd_get_spec', { kind: 'component', id: 'does-not-exist' }));
    const jsonBody = (await res.json()) as { result?: { isError?: boolean } };

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBe(true); // response survived the audit failure
    expect(spy).toHaveBeenCalled(); // failure recorded as a server diagnostic

    spy.mockRestore();
  }, 20_000);
});
