import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { authenticate, authenticateSession, verifyViewToken } from './auth.js';
import { authorize } from './authorization.js';
import { WEB_SESSION_PREFIX } from './types.js';
import { resolveProjectRoot, existingProjectRoot } from './projects.js';
import { createScopedServer, hostCore } from './adapters.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import {
  initializeProject,
  lockProject,
  promoteProject,
  getApprovalStatus,
  awaitApproval,
} from './projectlifecycle.js';
import * as projectops from './projectops.js';
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

import { bearerToken, sendJson } from './httpio.js';
// Historical import site for these helpers — republish them.
export { bearerToken, sendJson } from './httpio.js';

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

// ── Data-plane project-lifecycle + surface-exchange dispatch (steps 10–28) ───

/** The five execute-primary project-lifecycle tools the data plane handles
 *  directly, bypassing the scoped sdd_* MCP server. Every other tool falls
 *  through to it. */
const PROJECT_LIFECYCLE_TOOLS = new Set<string>([
  'sdd_host_initialize_project',
  'sdd_host_lock_project',
  'sdd_host_promote_project',
  'sdd_host_get_approval_status',
  'sdd_host_await_approval',
]);

/** The four hosted landscape tools the data plane handles directly, routing
 *  them to the surface exchange orchestrator with currentProjectId = the BOUND
 *  project (never a project id taken from the tool arguments). */
const LANDSCAPE_DISCOVERY_TOOLS = new Set<string>([
  'sdd_landscape_list_reachable_projects',
  'sdd_landscape_list_reachable_project_interfaces',
  'sdd_landscape_list_visible_surfaces',
  'sdd_landscape_get_project_surface',
]);

/** The six hosted project-ops tools the data plane handles directly, routing
 *  them to the project ops orchestrator — ALWAYS bound to THE one authorized
 *  project (instance-level operations are deliberately absent from the data
 *  plane). Each is resolver-gated upstream by its owning orchestrator. */
const PROJECT_OPS_TOOLS = new Set<string>([
  'sdd_host_pack_list',
  'sdd_host_pack_install',
  'sdd_host_policy_evaluate',
  'sdd_host_policy_reconcile',
  'sdd_host_produce',
  'sdd_host_commit_project',
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

/** Every dispatchable JSON-RPC request (an object carrying a `method`) in a body,
 *  unwrapping a batch array. */
function jsonRpcRequests(body: unknown): JsonRpcRequest[] {
  const arr = Array.isArray(body) ? body : [body];
  return arr.filter((m): m is JsonRpcRequest => !!m && typeof m === 'object' && 'method' in m);
}

/** The single dispatchable JSON-RPC request in a body (unwrapping a batch array),
 *  or undefined when the body carries none. Callers that gate/audit on this MUST
 *  first reject multi-request batches (see handleMcpRequest) — the transport
 *  dispatches EVERY message, so a second request would ride past a gate that
 *  inspected only this one. */
function jsonRpcRequest(body: unknown): JsonRpcRequest | undefined {
  return jsonRpcRequests(body)[0];
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
// On the ordinary sdd_* dispatch path (the project-lifecycle / landscape branch is
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
 * The data-plane capability a tool requires: `project:read` for a read tool (a
 * name starting with sdd_get_ / sdd_validate_), otherwise `project:write`.
 *
 * FAIL CLOSED: a read is ONLY the explicit read prefixes. The known write
 * prefixes and any unrecognized or newly added tool name are all treated as
 * writes, so a novel tool can never slip past on read-level permission.
 */
function requiredDataPlaneCapability(toolName: string): 'project:read' | 'project:write' {
  if (READ_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'project:read';
  if (WRITE_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'project:write';
  return 'project:write';
}

/**
 * Enforce the granular data-plane permission for an ordinary sdd_* `tools/call`.
 * Returns an `isError` tool-result response to send (and NOT dispatch) when the
 * caller lacks the needed capability over the BOUND project, or undefined to let
 * the call proceed. A non-`tools/call` message (initialize, tools/list) or a call
 * with no tool name is never gated — those do not mutate project state.
 *
 * This resolves through the permission resolver over the bound project, so a
 * token always acts as its owner's LIVE permission: the token's `projects`
 * narrowing (enforced separately at resolveProjectRoot) bounds WHICH projects it
 * may name, and this gate decides what it may DO there.
 */
function dataPlanePermissionError(
  cfg: HostConfig,
  principal: Principal,
  projectId: string,
  body: unknown,
): { jsonrpc: '2.0'; id: unknown; result: McpToolResult } | undefined {
  const msg = jsonRpcRequest(body);
  if (!msg || msg.method !== 'tools/call') return undefined;
  const name = msg.params?.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;

  const needed = requiredDataPlaneCapability(name);
  if (authorize(cfg.dataDir, principal, needed, 'project', projectId).value === 'yes') return undefined;

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
 * Steps 10–24: when the message is a `tools/call` for one of the five execute-primary
 * project-lifecycle tools or one of the hosted landscape discovery tools, dispatch it to
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
export async function dispatchProjectLifecycleTool(
  cfg: HostConfig,
  credential: string | null,
  projectId: string,
  body: unknown,
): Promise<{ jsonrpc: '2.0'; id: unknown; result: McpToolResult } | undefined> {
  const msg = jsonRpcRequest(body);
  if (!msg || msg.method !== 'tools/call') return undefined;
  const name = msg.params?.name;
  if (
    typeof name !== 'string' ||
    !(PROJECT_LIFECYCLE_TOOLS.has(name) || LANDSCAPE_DISCOVERY_TOOLS.has(name) || PROJECT_OPS_TOOLS.has(name))
  ) {
    return undefined;
  }

  const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
  const id = msg.id ?? null;
  let result: McpToolResult;
  try {
    let value: unknown;
    switch (name) {
      case 'sdd_host_initialize_project':
        value = initializeProject(cfg, credential, args as unknown as ProjectInitRequest);
        break;
      case 'sdd_host_lock_project':
        value = lockProject(cfg, credential, projectId); // bound project; args ignored
        break;
      case 'sdd_host_promote_project':
        value = promoteProject(cfg, credential, projectId); // bound project; args ignored
        break;
      case 'sdd_host_await_approval':
        // Long-poll for a decision on the caller's own approval request.
        value = await awaitApproval(
          cfg,
          credential,
          String(args.requestId ?? ''),
          Number(args.timeoutSeconds ?? 0),
        );
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
      // ── Hosted project ops — always the BOUND project (no project argument
      // exists on the data plane); resolver-gated by the owning orchestrators.
      case 'sdd_host_pack_list':
        value = projectops.listProjectPacks(cfg, credential, projectId);
        break;
      case 'sdd_host_pack_install':
        value = projectops.installProjectPack(
          cfg,
          credential,
          projectId,
          String(args.name ?? ''),
          String(args.content ?? ''),
        );
        break;
      case 'sdd_host_policy_evaluate':
        value = projectops.evaluateProjectPolicy(cfg, credential, projectId);
        break;
      case 'sdd_host_policy_reconcile':
        value = projectops.reconcileProjectPolicy(cfg, credential, projectId);
        break;
      case 'sdd_host_produce':
        await projectops.produceProducer(cfg, credential, projectId, String(args.target ?? ''));
        value = { ok: true };
        break;
      case 'sdd_host_commit_project':
        value = projectops.commitProject(
          cfg,
          credential,
          projectId,
          typeof args.subsystem === 'string' && args.subsystem ? args.subsystem : undefined,
          typeof args.message === 'string' && args.message ? args.message : undefined,
        );
        break;
      default: // 'sdd_host_get_approval_status'
        value = getApprovalStatus(cfg, credential, String(args.requestId ?? ''));
        break;
    }
    result = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  } catch (err) {
    result = toolErrorResult(err);
  }
  return { jsonrpc: '2.0', id, result };
}

/** Authenticate → resolve+bind project scope → dispatch the sdd_* call.
 *
 * The `credential` argument is the auth bridge: http.ts passes
 * `bearerToken(req) ?? sessionCookieValue(req)` so a browser web session drives
 * /mcp (spec authoring) with no bearer. When omitted, the credential is the bearer
 * token exactly as before (unchanged for every existing caller). A ws_-prefixed
 * session id resolves through the session bridge; anything else resolves as a
 * stored bearer token (the master credential is deliberately NOT accepted here). */
export async function handleMcpRequest(
  cfg: HostConfig,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  credential?: string | null,
): Promise<void> {
  const cred = credential !== undefined ? credential : bearerToken(req);
  let principal: Principal;
  if (cfg.authEnabled) {
    principal =
      cred && cred.startsWith(WEB_SESSION_PREFIX)
        ? authenticateSession(cfg.dataDir, cred)
        : authenticate(cfg.dataDir, cred);
    if (!principal.authenticated) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
  } else {
    // Trusted-network mode (auth disabled): no credential required, but a project
    // must still be named. The anonymous principal is an instance-admin, so it
    // holds the resolver bypass — satisfying the data-plane gate below exactly as
    // the master credential does.
    principal = {
      tokenId: 'anonymous',
      role: 'admin',
      projects: ['*'],
      authenticated: true,
      permissionSubject: { subjectId: 'anonymous', roleBindings: [], instanceAdmin: true },
    };
  }

  const root = resolveProjectRoot(cfg.dataDir, principal, projectSelector(req));
  if (!root) {
    sendJson(res, 403, { error: 'project not authorized, unknown, or not specified' });
    return;
  }

  // A JSON-RPC BATCH would let a second, unchecked request ride past the gates
  // below: the permission gate, project-lifecycle dispatch, and audit each inspect a
  // SINGLE message, but the transport dispatches every message in a batch array.
  // A read-only (mcp:read) token could smuggle a write tool as the second element
  // — unauthorized AND unaudited. The hosted data plane authorizes and audits
  // exactly one tool call per request, so refuse multi-request bodies outright.
  if (jsonRpcRequests(body).length > 1) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Batched JSON-RPC requests are not supported on the data plane; send one tool call per request.',
      },
    });
    return;
  }

  await runWithProjectRoot(root, async () => {
    // The project id is the basename of its isolated root (<dataDir>/projects/<id>).
    const projectId = path.basename(root);

    // Steps 10–24: the five execute-primary project-lifecycle tools and the hosted
    // landscape discovery tools are handled here, bypassing the scoped sdd_* MCP
    // server. The response still flows through the SAME best-effort audit path
    // (auditToolCall) the scoped dispatch uses.
    const dispatchedResponse = await dispatchProjectLifecycleTool(cfg, cred, projectId, body);
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
    const permissionError = dataPlanePermissionError(cfg, principal, projectId, body);
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
