import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { authenticate, verifyViewToken } from './auth.js';
import { resolveProjectRoot, existingProjectRoot } from './projects.js';
import { createScopedServer, hostCore } from './adapters.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import type { AuditEvent, HostConfig, Principal, PrincipalSubject } from './types.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator (sdd_host)
//
// The per-request data-plane workflow: authenticate the bearer token, resolve
// and bind the authorized project's isolated root, then dispatch the sdd_* tool
// call into a fresh, reused MCP server within that scope. Because the whole
// dispatch runs inside runWithProjectRoot, every sdd_* handler resolves to the
// bound project's .wai/ tree with no other changes.
// ---------------------------------------------------------------------------

export function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(Array.isArray(h) ? h[0] : h);
  return m ? m[1].trim() : null;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function projectSelector(req: IncomingMessage): string | null {
  const h = req.headers['x-wairon-project'];
  if (h) return Array.isArray(h) ? h[0] : h;
  try {
    return new URL(req.url ?? '', 'http://localhost').searchParams.get('project');
  } catch {
    return null;
  }
}

// ── Data-plane audit (steps 12–17 of handleRequest) ─────────────────────────

/**
 * The redacted audit target of a handled JSON-RPC message: the tool name for a
 * `tools/call`, otherwise the bare JSON-RPC method. Returns undefined when the
 * body carries no dispatchable method (there is nothing to audit).
 */
export function mcpToolTarget(body: unknown): string | undefined {
  const msg = Array.isArray(body)
    ? body.find((m) => m && typeof m === 'object' && 'method' in m)
    : body;
  if (!msg || typeof msg !== 'object') return undefined;
  const method = (msg as { method?: unknown }).method;
  if (typeof method !== 'string') return undefined;
  if (method === 'tools/call') {
    const name = (msg as { params?: { name?: unknown } }).params?.name;
    return typeof name === 'string' && name.length > 0 ? name : method;
  }
  return method;
}

/**
 * Derive the audit outcome from the JSON-RPC response the scoped server emitted:
 * 'failed' for a protocol error or an `isError` tool result, else 'success'. A
 * missing/uncaptured response is treated as a (non-error) success.
 */
export function deriveMcpOutcome(response: unknown): 'success' | 'failed' {
  if (!response || typeof response !== 'object') return 'success';
  const r = response as { error?: unknown; result?: { isError?: unknown } };
  if (r.error !== undefined && r.error !== null) return 'failed';
  if (r.result && typeof r.result === 'object' && r.result.isError) return 'failed';
  return 'success';
}

/**
 * Steps 12–17: build the redacted `mcp.tool.call` audit event for a handled
 * data-plane request and append it under the default retention policy. An append
 * failure is recorded as a server diagnostic and never propagates — auditing must
 * never fail the request. A legacy principal with no resolved subject gets a
 * synthesized service actor so the (required) actor is always present.
 */
export function auditToolCall(
  dataDir: string,
  principal: Principal,
  projectId: string,
  body: unknown,
  outcome: string,
): void {
  const target = mcpToolTarget(body);
  if (!target) return; // no dispatchable tool/method → nothing to audit
  const actor: PrincipalSubject = principal.subject ?? {
    userId: `token:${principal.tokenId}`,
    kind: 'service',
    issuer: 'local',
  };
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level: 'info',
    category: 'mcp',
    action: 'mcp.tool.call',
    outcome,
    actor,
    tokenId: principal.tokenId,
    projectId,
    target,
  };
  try {
    appendAuditEvent(dataDir, event, DEFAULT_AUDIT_POLICY);
  } catch (e) {
    console.error(
      `[sdd_host] audit append failed for ${event.action} (target=${target}): ` +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}

/** Authenticate → resolve+bind project scope → dispatch the sdd_* call. */
export async function handleMcpRequest(
  cfg: HostConfig,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  let principal: Principal;
  if (cfg.authEnabled) {
    principal = authenticate(cfg.dataDir, bearerToken(req));
    if (!principal.authenticated) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
  } else {
    // Trusted-network mode: no credential required, but a project must still be named.
    principal = { tokenId: 'anonymous', role: 'admin', projects: ['*'], authenticated: true };
  }

  const root = resolveProjectRoot(cfg.dataDir, principal, projectSelector(req));
  if (!root) {
    sendJson(res, 403, { error: 'project not authorized, unknown, or not specified' });
    return;
  }

  await runWithProjectRoot(root, async () => {
    const server = createScopedServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    // Observe the JSON-RPC response the scoped server emits so the audit outcome
    // can be derived from it, without altering what the client receives.
    let response: unknown;
    const forward = transport.send.bind(transport);
    transport.send = (message, options) => {
      const m = message as { result?: unknown; error?: unknown };
      if (m.result !== undefined || m.error !== undefined) response = message;
      return forward(message, options);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);

    // Steps 12–17: audit the handled data-plane tool call (best-effort). The
    // project id is the basename of its isolated root (<dataDir>/projects/<id>).
    auditToolCall(cfg.dataDir, principal, path.basename(root), body, deriveMcpOutcome(response));
  });
}

/**
 * Serve a project's canvas HTML to a browser, authorized by a signed view token
 * in the URL (no bearer — the signature is the capability). Verifies signature +
 * expiry, binds the granted project's scope, and renders in scope.
 */
export function handleViewDiagram(cfg: HostConfig, req: IncomingMessage, res: ServerResponse): void {
  const token = new URL(req.url ?? '', 'http://localhost').searchParams.get('token');
  let grant;
  try {
    grant = verifyViewToken(token ?? '');
  } catch (e) {
    sendJson(res, 403, { error: e instanceof Error ? e.message : String(e) });
    return;
  }
  const root = existingProjectRoot(cfg.dataDir, grant.project);
  if (!root) {
    sendJson(res, 404, { error: 'project not found' });
    return;
  }
  const html = runWithProjectRoot(root, () => hostCore.renderDiagram(grant.format));
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}
