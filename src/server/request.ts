import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { authenticate, verifyViewToken } from './auth.js';
import { resolveProjectRoot, existingProjectRoot } from './projects.js';
import { createScopedServer, hostCore } from './adapters.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import {
  requestProjectInitialization,
  requestProjectLock,
  requestProjectPromotion,
  getRequestStatus,
} from './selfservice.js';
import {
  listReachableProjectsForMcp,
  listReachableProjectInterfacesForMcp,
  listVisibleSurfaces,
  getProjectSurfaceForMcp,
} from './landscape.js';
import type {
  AuditEvent,
  HostConfig,
  Principal,
  PrincipalSubject,
  ProjectInitRequest,
} from './types.js';

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

// ── Data-plane self-service + landscape discovery dispatch (steps 10–24) ─────

/** The four approval-backed self-service tools the data plane handles directly,
 *  bypassing the scoped sdd_* MCP server. Every other tool falls through to it. */
const SELF_SERVICE_TOOLS = new Set<string>([
  'sdd_host_request_project_initialization',
  'sdd_host_request_project_lock',
  'sdd_host_request_project_promotion',
  'sdd_host_get_approval_status',
]);

/** The two hosted landscape discovery tools the data plane handles directly,
 *  routing them to the landscape orchestrator with currentProjectId = the BOUND
 *  project (never a project id taken from the tool arguments). */
const LANDSCAPE_DISCOVERY_TOOLS = new Set<string>([
  'sdd_landscape_list_reachable_projects',
  'sdd_landscape_list_reachable_project_interfaces',
  'sdd_landscape_list_visible_surfaces',
  'sdd_landscape_get_project_surface',
]);

/** The MCP tool-result envelope — the exact shape the scoped sdd_* server returns:
 *  text content, optionally flagged as an error. */
interface McpToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** The fields the data plane reads off a JSON-RPC request to route a `tools/call`. */
interface JsonRpcRequest {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

/** The single dispatchable JSON-RPC request in a body (unwrapping a batch array),
 *  or undefined when the body carries none. */
function jsonRpcRequest(body: unknown): JsonRpcRequest | undefined {
  const msg = Array.isArray(body)
    ? body.find((m) => m && typeof m === 'object' && 'method' in m)
    : body;
  return msg && typeof msg === 'object' ? (msg as JsonRpcRequest) : undefined;
}

/** Shape a caught error into an `isError` MCP tool result carrying a clear message
 *  (UnauthenticatedError / ForbiddenError / not-found all read clearly) — never a
 *  stack trace. */
function toolErrorResult(err: unknown): McpToolResult {
  return {
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

// ── Granular data-plane permission gate (step 25–27 of handleRequest) ────────
//
// On the ordinary sdd_* dispatch path (the self-service / landscape branch is
// already gated by its orchestrator), classify the tool and require the
// principal's grant FOR THE BOUND PROJECT to carry the matching data-plane
// permission before it reaches the scoped MCP server.

/** Write tools mutate the spec tree; their names carry one of these prefixes. */
const WRITE_TOOL_PREFIXES = [
  'sdd_add_',
  'sdd_update_',
  'sdd_delete_',
  'sdd_write_',
  'sdd_define_',
  'sdd_set_',
  'sdd_initialize_',
  'sdd_externalize_',
  'sdd_internalize_',
  'sdd_move_',
];

/** Read tools only inspect the tree; their names carry one of these prefixes
 *  (sdd_get_status is a read). */
const READ_TOOL_PREFIXES = ['sdd_get_', 'sdd_validate_'];

/**
 * The data-plane permission a tool requires: `mcp:read` for a read tool (a name
 * starting with sdd_get_ / sdd_validate_), otherwise `mcp:write`. Unknown / other
 * names are treated as writes (fail safe) so a novel tool can never slip past on a
 * read-only grant.
 */
function requiredDataPlanePermission(toolName: string): 'mcp:read' | 'mcp:write' {
  if (READ_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'mcp:read';
  if (WRITE_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'mcp:write';
  return 'mcp:write';
}

/**
 * True when the principal's grant FOR THE BOUND PROJECT carries the required
 * data-plane permission: a grant whose projectId is the bound project (or the
 * instance-wide '*') carrying that permission — or the '*' permission wildcard,
 * which covers both read and write. Consults principal.grants, NOT the coarse
 * role/projects projection, so a read-only token (mcp:read only) is correctly
 * refused writes.
 */
function grantPermitsDataPlane(principal: Principal, projectId: string, permission: string): boolean {
  return (principal.grants ?? []).some(
    (g) =>
      (g.projectId === projectId || g.projectId === '*') &&
      (g.permissions.includes('*') || g.permissions.includes(permission)),
  );
}

/**
 * Enforce the granular data-plane permission for an ordinary sdd_* `tools/call`.
 * Returns an `isError` tool-result response to send (and NOT dispatch) when the
 * bound project is not covered for the needed permission, or undefined to let the
 * call proceed. A non-`tools/call` message (initialize, tools/list) or a call with
 * no tool name is never gated — those do not mutate project state.
 */
function dataPlanePermissionError(
  principal: Principal,
  projectId: string,
  body: unknown,
): { jsonrpc: '2.0'; id: unknown; result: McpToolResult } | undefined {
  const msg = jsonRpcRequest(body);
  if (!msg || msg.method !== 'tools/call') return undefined;
  const name = msg.params?.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;

  const needed = requiredDataPlanePermission(name);
  if (grantPermitsDataPlane(principal, projectId, needed)) return undefined;

  return {
    jsonrpc: '2.0',
    id: msg.id ?? null,
    result: {
      content: [{ type: 'text', text: `Forbidden — permission ${needed} required for ${name}` }],
      isError: true,
    },
  };
}

/**
 * Steps 10–24: when the message is a `tools/call` for one of the four approval-backed
 * self-service tools or one of the two hosted landscape discovery tools, dispatch it to
 * the matching orchestrator — re-authenticating the RAW bearer credential (the
 * orchestrators are the single auth authority) — and shape the outcome into the standard
 * JSON-RPC tool-result envelope. Returns the full JSON-RPC response to send, or undefined
 * when the call is neither (the caller then falls through to the scoped sdd_* MCP server —
 * step 25).
 *
 * Project lock and promotion, and BOTH landscape discovery workflows, are ALWAYS scoped to
 * the already-bound project id as their current project; a project id supplied in the tool
 * arguments is deliberately IGNORED for those, so a caller can never act as, or read the
 * neighbourhood of, a project it is not scoped to. Initialization carries the (new) project
 * as its decoded ProjectInitRequest arguments, and interface discovery reads its TARGET
 * project (the neighbour to inspect, still gated by reachability) from arguments.projectId.
 */
export function dispatchSelfServiceTool(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  body: unknown,
): { jsonrpc: '2.0'; id: unknown; result: McpToolResult } | undefined {
  const msg = jsonRpcRequest(body);
  if (!msg || msg.method !== 'tools/call') return undefined;
  const name = msg.params?.name;
  if (typeof name !== 'string' || !(SELF_SERVICE_TOOLS.has(name) || LANDSCAPE_DISCOVERY_TOOLS.has(name))) {
    return undefined;
  }

  const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
  const id = msg.id ?? null;
  let result: McpToolResult;
  try {
    let value: unknown;
    switch (name) {
      case 'sdd_host_request_project_initialization':
        value = requestProjectInitialization(cfg, credential, args as unknown as ProjectInitRequest);
        break;
      case 'sdd_host_request_project_lock':
        value = requestProjectLock(cfg, credential, projectId); // bound project; args ignored
        break;
      case 'sdd_host_request_project_promotion':
        value = requestProjectPromotion(cfg, credential, projectId); // bound project; args ignored
        break;
      case 'sdd_landscape_list_reachable_projects':
        // currentProjectId = the BOUND project; never taken from arguments.
        value = listReachableProjectsForMcp(cfg, credential, projectId);
        break;
      case 'sdd_landscape_list_reachable_project_interfaces':
        // currentProjectId = the BOUND project; targetProjectId from arguments.projectId.
        value = listReachableProjectInterfacesForMcp(
          cfg,
          credential,
          projectId,
          String(args.projectId ?? ''),
        );
        break;
      case 'sdd_landscape_list_visible_surfaces':
        // The visibility-resolved discovery catalog for the BOUND project.
        value = listVisibleSurfaces(cfg, credential, projectId);
        break;
      case 'sdd_landscape_get_project_surface':
        // Contract-grade surface fetch: currentProjectId = the BOUND project;
        // targetProjectId from arguments.projectId. Visibility-gated.
        value = getProjectSurfaceForMcp(cfg, credential, projectId, String(args.projectId ?? ''));
        break;
      default: // 'sdd_host_get_approval_status'
        value = getRequestStatus(cfg, credential, String(args.requestId ?? ''));
        break;
    }
    result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch (err) {
    result = toolErrorResult(err);
  }
  return { jsonrpc: '2.0', id, result };
}

/** Authenticate → resolve+bind project scope → dispatch the sdd_* call. */
export async function handleMcpRequest(
  cfg: HostConfig,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const credential = bearerToken(req);
  let principal: Principal;
  if (cfg.authEnabled) {
    principal = authenticate(cfg.dataDir, credential);
    if (!principal.authenticated) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
  } else {
    // Trusted-network mode: no credential required, but a project must still be
    // named. The anonymous principal is a super-admin, so it carries an
    // instance-wide '*'/'*' grant — this satisfies the granular data-plane
    // permission gate below exactly as the master credential does.
    principal = {
      tokenId: 'anonymous',
      role: 'admin',
      projects: ['*'],
      authenticated: true,
      grants: [{ projectId: '*', permissions: ['*'] }],
    };
  }

  const root = resolveProjectRoot(cfg.dataDir, principal, projectSelector(req));
  if (!root) {
    sendJson(res, 403, { error: 'project not authorized, unknown, or not specified' });
    return;
  }

  await runWithProjectRoot(root, async () => {
    // The project id is the basename of its isolated root (<dataDir>/projects/<id>).
    const projectId = path.basename(root);

    // Steps 10–24: the four approval-backed self-service tools and the two hosted
    // landscape discovery tools are handled here, bypassing the scoped sdd_* MCP
    // server. The response still flows through the SAME best-effort audit path
    // (auditToolCall) the scoped dispatch uses.
    const dispatchedResponse = dispatchSelfServiceTool(cfg, credential, projectId, body);
    if (dispatchedResponse !== undefined) {
      sendJson(res, 200, dispatchedResponse);
      auditToolCall(cfg.dataDir, principal, projectId, body, deriveMcpOutcome(dispatchedResponse));
      return;
    }

    // Steps 25–27: enforce the granular data-plane permission BEFORE dispatching
    // an ordinary sdd_* tool. A read tool needs mcp:read, a write tool needs
    // mcp:write (a '*' permission or the instance-wide '*'/'*' grant covers both),
    // consulted from the principal's grant for the BOUND project. A refusal is an
    // isError tool result (HTTP still 200) and the tool is never dispatched; it
    // still flows through the SAME best-effort audit path.
    const permissionError = dataPlanePermissionError(principal, projectId, body);
    if (permissionError !== undefined) {
      sendJson(res, 200, permissionError);
      auditToolCall(cfg.dataDir, principal, projectId, body, deriveMcpOutcome(permissionError));
      return;
    }

    // Step 28: every other tool dispatches into a fresh scoped MCP server.
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

    // Steps 23–27: audit the handled data-plane tool call (best-effort).
    auditToolCall(cfg.dataDir, principal, projectId, body, deriveMcpOutcome(response));
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
