import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { runWithProjectRoot, runWithProjectBinding, type HostedRecordLookup } from '../utils/fs.js';
import { authenticate, authenticateSession, verifyViewToken } from './auth.js';
import { authorize, resolveFamilyReach } from './authorization.js';
import { WEB_SESSION_PREFIX } from './types.js';
import {
  resolveProjectBinding,
  existingProjectRoot,
  listFamilyRecords,
  SUBPROJECT_SEPARATOR,
} from './projects.js';
import type { ProjectBinding } from './projects.js';
import { recoverUnfinishedMigrations } from './members.js';
import * as memberRegistration from './members.js';
import type { MemberAdoption, MemberDetachment, MembershipScreen, ReachComparison } from './types.js';
import { createScopedServer } from './adapters/mcp.js';
import * as hostCore from './adapters/core.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import {
  initializeProject,
  lockProject,
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
// and bind the authorized hosted RECORD's root, then dispatch the sdd_* tool
// call into a fresh, reused MCP server within that scope. Because the whole
// dispatch runs inside runWithProjectRoot, every sdd_* handler resolves to the
// bound project's .wai/ tree with no other changes. Since stage 7 a member is a
// record of its own: it is bound by its own id, its permissions resolve over
// its own chain (its scope, its parents', its family root's units), and audit
// names it. A deprecated member-qualified selector ('projectId::alias') still
// resolves, for one release, to the member's record; the family root it named
// is recorded as the event's composition.
// ---------------------------------------------------------------------------

import { bearerToken, sendJson } from './httpio.js';
// Historical import site for these helpers — republish them.
export { bearerToken, sendJson } from './httpio.js';
import { publishChange } from './realtime.js';

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
 *
 * The event names the bound record as `projectId` — the member's own id when
 * a member was bound. When a deprecated member qualifier resolved the binding
 * (via), the family root it named is recorded as `composition`.
 */
export function auditToolCall(
  dataDir: string,
  principal: Principal,
  binding: Pick<ProjectBinding, 'projectId' | 'via'>,
  body: unknown,
  outcome: string,
): void {
  const projectId = binding.projectId;
  const composition = binding.via?.split(SUBPROJECT_SEPARATOR)[0];
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
    ...(composition ? { composition } : {}),
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

/** The seven hosted project-ops tools the data plane handles directly, routing
 *  them to the project ops orchestrator — ALWAYS bound to THE one authorized
 *  project (instance-level operations are deliberately absent from the data
 *  plane). Each is permission-rules-gated upstream by its owning orchestrator:
 *  sdd_host_pack_impact is a READ there (project:read — it measures and writes
 *  nothing), so it is absent from MUTATING_HOST_TOOLS and wakes no channel. */
const PROJECT_OPS_TOOLS = new Set<string>([
  'sdd_host_pack_list',
  'sdd_host_pack_install',
  'sdd_host_pack_impact',
  'sdd_host_policy_evaluate',
  'sdd_host_policy_reconcile',
  'sdd_host_produce',
  'sdd_host_commit_project',
]);

/** The two spec-tree transfer tools, dispatched like the project-ops tools on
 *  the BOUND record's tree (a member's own tree when a member is bound). */
const TREE_TRANSFER_TOOLS = new Set<string>([
  'sdd_host_export_tree',
  'sdd_host_import_tree',
]);

/** The RECORD-level hosted tools: they act on the hosted project RECORD (or its
 *  repository), or answer for that project's relations to other projects. Since
 *  stage 7 a credential bound to a member reaches the member's OWN record-level
 *  tools — within the member only, never its parent's. */
const PROJECT_RECORD_TOOLS = new Set<string>([
  'sdd_host_initialize_project',
  'sdd_host_get_approval_status',
  'sdd_host_await_approval',
  ...PROJECT_OPS_TOOLS,
  ...LANDSCAPE_DISCOVERY_TOOLS,
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

/** Write tools mutate the spec tree; their names carry one of these prefixes.
 *  A rename tool added later is a write by this prefix, not by a hand-kept
 *  name list — see step 48 of handleRequest. */
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
  'sdd_rename_',
  // sdd_pin_externals writes the externals lock and snapshots of the bound tree.
  'sdd_pin_',
  // The stage-6 family migrations (sdd_attach_member, sdd_detach_member,
  // sdd_adopt_member; the sdd_rename_ and sdd_internalize_/sdd_externalize_
  // prefixes cover the rest). A dryRun call is still a write: a tool's class
  // is its name's, never its arguments'.
  'sdd_attach_',
  'sdd_detach_',
  'sdd_adopt_',
];

/** Read tools only inspect the tree; their names carry one of these prefixes
 *  (sdd_get_status is a read). */
const READ_TOOL_PREFIXES = ['sdd_get_', 'sdd_validate_'];

/** Read tools whose names carry no read prefix, listed one by one so the
 *  fail-closed default stays in force for every other name. */
const READ_TOOL_NAMES = new Set<string>([
  'listAgents',
  'getAgent',
  'listDomains',
  'validateTopology',
  'getProjectConfig',
]);

/**
 * The data-plane capability a tool requires: `project:read` for a read tool (a
 * name starting with sdd_get_ / sdd_validate_, or one of READ_TOOL_NAMES),
 * otherwise `project:write`.
 *
 * FAIL CLOSED: a read is ONLY an explicit read prefix or name. Every write —
 * whether it carries one of the known write prefixes or is unrecognized or
 * newly added — is treated as a write, so a novel tool (including a future
 * rename tool, covered by the sdd_rename_ prefix) can never slip past on
 * read-level permission by name alone.
 */
export function requiredDataPlaneCapability(toolName: string): 'project:read' | 'project:write' {
  if (READ_TOOL_NAMES.has(toolName) || READ_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) return 'project:read';
  return 'project:write';
}

/** Where a hosted tool acts: on the bound spec TREE, or on the hosted project
 *  RECORD, its repository, or its relations to other projects. */
export type ToolScope = 'tree' | 'record';

/** The TREE-scoped hosted tools the data plane dispatches itself. */
const TREE_SCOPED_HOST_TOOLS = new Set<string>([
  'sdd_host_lock_project',
  ...TREE_TRANSFER_TOOLS,
]);

/**
 * The scope a tool declares, or undefined when it declares none. Every ordinary
 * sdd_* tool the scoped server serves — each explicit read (by prefix or by
 * name) and each explicit write (by prefix — the sdd_rename_ tools among
 * them) — acts on the bound tree; the hosted tools are declared one by one.
 */
export function toolScope(toolName: string): ToolScope | undefined {
  if (PROJECT_RECORD_TOOLS.has(toolName)) return 'record';
  if (TREE_SCOPED_HOST_TOOLS.has(toolName)) return 'tree';
  if (
    READ_TOOL_NAMES.has(toolName) ||
    READ_TOOL_PREFIXES.some((p) => toolName.startsWith(p)) ||
    WRITE_TOOL_PREFIXES.some((p) => toolName.startsWith(p))
  ) {
    return 'tree';
  }
  return undefined;
}

/**
 * Whether a tool is classified on purpose — it declares its scope, which also
 * makes it an explicit read, an explicit write, or a hosted tool the data plane
 * dispatches itself — rather than leaning on a fail-closed default. The
 * defaults are safety nets, not classifications: a tool the server advertises
 * must never depend on them.
 */
export function isExplicitlyClassifiedTool(toolName: string): boolean {
  return toolScope(toolName) !== undefined;
}

/** Lifecycle/ops tools whose SUCCESS changes state other live views are
 *  showing (project status, placements, packs) — not the read-shaped ones
 *  (get_approval_status, landscape discovery) and not the external-side-effect
 *  ones (produce, commit — the spec tree itself is unchanged). */
const MUTATING_HOST_TOOLS = new Set([
  'sdd_host_initialize_project',
  'sdd_host_lock_project',
  'sdd_host_await_approval', // a decided approval may have executed the action
  'sdd_host_policy_reconcile',
  'sdd_host_import_tree', // replaces the whole spec tree — every open view is stale
]);

/**
 * The realtime channels a SUCCESSFUL data-plane tool call invalidates: a spec-
 * mutating sdd_* write wakes the bound project's channel (open canvases refetch
 * through their own scoped REST reads — the event carries no data, so
 * authorization stays at the read); a mutating lifecycle tool also wakes the
 * projects list. Publishing is an OPTIMIZATION, so unlike the permission gate
 * (which fails closed to write) an unknown tool publishes nothing.
 */
export function mcpChangeChannels(body: unknown, projectId: string, response: unknown): string[] {
  if (deriveMcpOutcome(response) !== 'success') return [];
  const msg = jsonRpcRequest(body);
  if (!msg || msg.method !== 'tools/call') return [];
  const name = msg.params?.name;
  if (typeof name !== 'string') return [];
  if (WRITE_TOOL_PREFIXES.some((p) => name.startsWith(p))) return [`project:${projectId}`];
  if (MUTATING_HOST_TOOLS.has(name)) return [`project:${projectId}`, 'projects'];
  return [];
}

/**
 * Enforce the granular data-plane permission for an ordinary sdd_* `tools/call`.
 * Returns an `isError` tool-result response to send (and NOT dispatch) when the
 * caller lacks the needed capability over the BOUND project, or undefined to let
 * the call proceed. A non-`tools/call` message (initialize, tools/list) or a call
 * with no tool name is never gated — those do not mutate project state.
 *
 * This resolves through permission rules over the bound project, so a
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
 *
 * Every one of them acts on the bound RECORD — a member's own record when a
 * member is bound (the documented widening within the member only).
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
    !(
      PROJECT_LIFECYCLE_TOOLS.has(name) ||
      LANDSCAPE_DISCOVERY_TOOLS.has(name) ||
      PROJECT_OPS_TOOLS.has(name) ||
      TREE_TRANSFER_TOOLS.has(name)
    )
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
        // The BOUND record (args ignored): a member's own lock request,
        // approval page and status when a member is bound.
        value = lockProject(cfg, credential, projectId);
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
      // exists on the data plane); permission-rules-gated by the owning orchestrators.
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
      case 'sdd_host_pack_impact':
        // The per-project pack impact preview: name, and the declarative content
        // when installing, from arguments; writes nothing (project:read upstream).
        // sdd_host_pack_install itself stays an unattended write that says it applied.
        value = projectops.previewProjectPack(
          cfg,
          credential,
          projectId,
          String(args.name ?? ''),
          typeof args.content === 'string' ? args.content : undefined,
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
      case 'sdd_host_export_tree': {
        // The BOUND record's tree. The archive rides the
        // JSON-RPC result as base64 and is therefore bounded by the same body
        // cap as every other data-plane response — a tree too large for that is
        // an honest failure pointing at the raw-upload route, never a truncation.
        const exported = projectops.exportProjectTree(
          cfg,
          credential,
          projectId,
          undefined,
          args.allowPartial === true,
        );
        value = {
          projectName: exported.projectName,
          roots: exported.roots,
          fileCount: exported.fileCount,
          stateId: exported.stateId,
          suggestedFileName: exported.suggestedFileName,
          archiveBase64: Buffer.from(exported.archive).toString('base64'),
          skipped: exported.skipped,
        };
        break;
      }
      case 'sdd_host_import_tree': {
        // TREE-scoped like export. The base64 argument is decoded here (a
        // transport concern); the orchestrator takes bytes and always refuses
        // executable entries.
        const decoded = Buffer.from(String(args.archiveBase64 ?? ''), 'base64');
        value = projectops.importProjectTree(
          cfg,
          credential,
          projectId,
          decoded,
          args.replaceExisting === true,
        );
        break;
      }
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
    // holds the permission-rules bypass — satisfying the data-plane gate below exactly as
    // the master credential does.
    principal = {
      tokenId: 'anonymous',
      role: 'admin',
      projects: ['*'],
      authenticated: true,
      permissionSubject: { subjectId: 'anonymous', roleBindings: [], instanceAdmin: true },
    };
  }

  // Step 6: resolve the authorized binding to a hosted RECORD — a member is a
  // record of its own; a deprecated member qualifier maps to its member record
  // (via), never wider; a narrowing entry naming a project covers its members.
  const binding = resolveProjectBinding(cfg.dataDir, principal, projectSelector(req));
  if (!binding) {
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

  // Steps 9-11: bind the root together with the request's reach into its family.
  const reach = familyReachOf(cfg, principal, binding);

  await runWithProjectBinding(binding.rootPath, reach, async () => {
    // The bound record — permissions, audit and record-level tools anchor here.
    const projectId = binding.projectId;

    // Step 12: family upkeep before the tool — a family migration a crash left
    // unfinished is rolled back and audited (never fails the request).
    recoverBoundFamily(cfg, principal, binding);

    // Steps 13–14: the execute-primary project-lifecycle tools, the hosted
    // landscape discovery tools and the project-ops tools are handled here,
    // bypassing the scoped sdd_* MCP server, on the BOUND record. The response
    // still flows through the SAME best-effort audit path (auditToolCall).
    const dispatchedResponse = await dispatchProjectLifecycleTool(cfg, cred, projectId, body);
    if (dispatchedResponse !== undefined) {
      sendJson(res, 200, dispatchedResponse);
      auditToolCall(cfg.dataDir, principal, binding, body, deriveMcpOutcome(dispatchedResponse));
      // Realtime: nudge the channels a successful lifecycle mutation touched.
      for (const ch of mcpChangeChannels(body, projectId, dispatchedResponse)) publishChange(ch);
      return;
    }

    // Steps 15–18: enforce the granular data-plane permission BEFORE dispatching
    // an ordinary sdd_* tool. A read tool needs project:read, every other tool
    // project:write (fail closed), resolved LIVE through hierarchical
    // permission rules over the BOUND record's own chain. Capabilities match
    // EXACTLY — there is no wildcard capability, and the '*'@instance
    // instance-admin marker is reserved (setAssignment rejects it); only the
    // env-anchored instance-admin subjects bypass the walk. A refusal is an
    // isError tool result (HTTP still 200) and the tool is never dispatched; it
    // still flows through the SAME best-effort audit path.
    const permissionError = dataPlanePermissionError(cfg, principal, projectId, body);
    if (permissionError !== undefined) {
      sendJson(res, 200, permissionError);
      auditToolCall(cfg.dataDir, principal, binding, body, deriveMcpOutcome(permissionError));
      return;
    }

    // Steps 19–29: a membership-changing tool is handled first — on hosted,
    // membership decides reach, and a detach or an adopt moves storage between
    // isolated roots: member registration serves those whole; attach and a
    // project rename are screened.
    const membership = serveMembershipTool(cfg, principal, binding, body);
    if (membership.response !== undefined) {
      sendJson(res, 200, membership.response);
      auditToolCall(cfg.dataDir, principal, binding, body, deriveMcpOutcome(membership.response));
      for (const ch of mcpChangeChannels(body, projectId, membership.response)) publishChange(ch);
      if (deriveMcpOutcome(membership.response) === 'success') publishChange('projects');
      return;
    }

    // Steps 30–31: every other tool dispatches into a fresh scoped MCP server.
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
      if (m.result !== undefined || m.error !== undefined) {
        // Step 31: a screened dry run carries who gains access beside the plan.
        withReachListing(m.result, membership.screen, body);
        response = message;
      }
      return forward(message, options);
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, body);

    // Steps 32–33: an applied family-shape tool that succeeded — the family's
    // member records follow the family on disk.
    reconcileAfter(cfg, principal, binding, body, response);

    // Step 34: audit the handled data-plane tool call (best-effort).
    auditToolCall(cfg.dataDir, principal, binding, body, deriveMcpOutcome(response));
    // Realtime: a successful sdd_* WRITE changed the spec tree — nudge the
    // project channel so open canvases/views refetch (spec-tree change → live).
    for (const ch of mcpChangeChannels(body, projectId, response)) publishChange(ch);
  });
}

// ── Membership changes on hosted (steps 19–33 of handleRequest) ─────────────

/** The membership-changing tools: on hosted, membership decides reach. */
const MEMBERSHIP_TOOLS = new Set(['sdd_attach_member', 'sdd_adopt_member', 'sdd_detach_member', 'sdd_rename_project']);

/** The family-shape tools the scoped server runs whose applied success the hosted records must follow. */
const FAMILY_SHAPE_TOOLS = new Set([
  'sdd_add_member',
  'sdd_move_member',
  'sdd_attach_member',
  'sdd_rename_project',
  'sdd_rename_member_alias',
  'sdd_internalize_member',
  'sdd_externalize_subsystem',
]);

/** A tools/call's name and arguments, or null for any other message. */
function toolCall(body: unknown): { id: unknown; name: string; args: Record<string, unknown> } | null {
  const msg = jsonRpcRequest(body);
  if (!msg || msg.method !== 'tools/call' || typeof msg.params?.name !== 'string') return null;
  return { id: msg.id ?? null, name: msg.params.name, args: (msg.params.arguments ?? {}) as Record<string, unknown> };
}

/** Who gains or loses what, one line per principal, capability and project. */
function reachLines(rows: ReachComparison[]): string[] {
  return rows.map((r) => `${r.memberId}: ${r.subjectId} ${r.capability} ${r.before.value} -> ${r.after.value}`);
}

/**
 * Steps 19–29: serve a hosted detach or adopt whole through member
 * registration (each relocates the project between its family's tree and an
 * isolated root of its own), or screen an attach or a project rename. Answers
 * the response to send for a tool served or refused here, else the screen the
 * scoped server's dry run carries (or nothing at all).
 */
function serveMembershipTool(
  cfg: HostConfig,
  principal: Principal,
  binding: ProjectBinding,
  body: unknown,
): { response?: { jsonrpc: '2.0'; id: unknown; result: McpToolResult }; screen?: MembershipScreen } {
  const call = toolCall(body);
  // Step 19.
  if (!call || !MEMBERSHIP_TOOLS.has(call.name)) return {};
  const apply = call.args.dryRun !== true;
  const answer = (result: McpToolResult): { response: { jsonrpc: '2.0'; id: unknown; result: McpToolResult } } => ({ response: { jsonrpc: '2.0', id: call.id, result } });
  try {
    switch (call.name) {
      case 'sdd_detach_member':
        // Steps 20–22.
        return answer(relocationResult('detach', memberRegistration.detach(cfg.dataDir, principal, binding, String(call.args.alias ?? ''), apply), apply));
      case 'sdd_adopt_member':
        // Steps 23–25.
        return answer(relocationResult('adopt', memberRegistration.adopt(cfg.dataDir, principal, binding, String(call.args.alias ?? ''), String(call.args.path ?? ''), apply), apply));
      default: {
        // Steps 26–29: attach and a project rename are screened.
        const named = call.name === 'sdd_rename_project' ? String(call.args.project ?? '') : String(call.args.alias ?? '');
        const screened = memberRegistration.screen(cfg.dataDir, binding, call.name, named, typeof call.args.path === 'string' ? call.args.path : undefined);
        if (screened.refusal !== undefined) return answer({ content: [{ type: 'text', text: screened.refusal }], isError: true });
        return { screen: screened };
      }
    }
  } catch (err) {
    return answer(toolErrorResult(err));
  }
}

/** A hosted detach or adopt as its tool answers it: refused or failed is an error, with the whole report. */
function relocationResult(verb: 'detach' | 'adopt', report: MemberDetachment | MemberAdoption, apply: boolean): McpToolResult {
  const plan = report.plan;
  const reach = 'reachLost' in report ? report.reachLost : report.reachChanges;
  const view = {
    dryRun: !apply,
    applied: report.applied,
    memberId: report.memberId,
    ...('newRoot' in report ? { newRoot: report.newRoot } : { memberPath: report.memberPath }),
    reach: reachLines(reach),
    relock: plan.relock,
    ...(report.outcome ? { outcome: { committed: report.outcome.committed, restored: report.outcome.restored, unrestored: report.outcome.unrestored, ...(report.outcome.failure ? { failure: report.outcome.failure } : {}) } } : {}),
    ...(report.commit ? { commit: report.commit } : {}),
    plan: {
      verb: plan.request.verb,
      edits: plan.edits.map((e) => ({ project: e.project, kind: e.kind, detail: e.detail })),
      refusals: plan.refusals,
      changes: plan.changes.map((c) => ({ project: c.project, path: c.path, action: c.action })),
      notes: plan.notes,
    },
  };
  const text = JSON.stringify(view, null, 2);
  if (plan.refusals.length > 0) return { content: [{ type: 'text', text: `the hosted ${verb} is refused; nothing was written.\n${text}` }], isError: true };
  if (apply && !report.applied) return { content: [{ type: 'text', text: `the hosted ${verb} failed and ${report.outcome?.restored ? 'everything was restored exactly as before' : 'some files could not be restored: an operator must run `wairon host doctor --fix`'}.\n${text}` }], isError: true };
  return { content: [{ type: 'text', text }] };
}

/**
 * Step 31: a screened DRY RUN of attach carries who gains access through the
 * new parent beside the plan, so a person approves the membership change with
 * its access consequences in view.
 */
function withReachListing(result: unknown, screened: MembershipScreen | undefined, body: unknown): void {
  const call = toolCall(body);
  if (!screened || !call || call.args.dryRun !== true || !result || typeof result !== 'object') return;
  const r = result as { content?: { type: string; text: string }[]; isError?: boolean };
  if (r.isError || !Array.isArray(r.content)) return;
  const lines = reachLines(screened.reachChanges);
  r.content.push({ type: 'text', text: lines.length > 0 ? `Reach changes — who gains access through the new parent:\n${lines.join('\n')}` : 'Reach changes: none — nobody gains or loses access.' });
}

/**
 * Steps 32–33: after an APPLIED family-shape tool succeeded, reconcile the
 * family's member records (touched = the owners the tool's report names as
 * written, the bound record when it names none). A failure is logged and
 * audited, never turns the tool's success into a failure.
 */
function reconcileAfter(cfg: HostConfig, principal: Principal, binding: ProjectBinding, body: unknown, response: unknown): void {
  const call = toolCall(body);
  if (!call || !FAMILY_SHAPE_TOOLS.has(call.name) || call.args.dryRun === true || deriveMcpOutcome(response) !== 'success') return;
  try {
    memberRegistration.reconcile(cfg.dataDir, principal, binding.projectId, writtenOwners(cfg, binding, response));
    publishChange('projects');
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error(`[sdd_host] member reconciliation failed after ${call.name} at ${binding.projectId}: ${detail}`);
    try {
      appendAuditEvent(cfg.dataDir, {
        id: '', timestamp: '', level: 'warning', category: 'project', action: 'member.reconcile', outcome: 'failed',
        actor: principal.subject ?? { userId: `token:${principal.tokenId}`, kind: 'service', issuer: 'local' },
        tokenId: principal.tokenId, projectId: binding.projectId, target: call.name, metadata: JSON.stringify({ failure: detail }),
      }, DEFAULT_AUDIT_POLICY);
    } catch { /* best-effort */ }
  }
}

/** The family record ids whose roots the tool's report names as written; the bound record when it names none. */
function writtenOwners(cfg: HostConfig, binding: ProjectBinding, response: unknown): string[] {
  const changes = (response as { result?: { structuredContent?: { plan?: { changes?: { project?: string }[] } } } } | undefined)
    ?.result?.structuredContent?.plan?.changes ?? [];
  const key = (p: string): string => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const roots = new Set(changes.map((c) => c.project ?? '').filter(Boolean).map(key));
  const ids = listFamilyRecords(cfg.dataDir, binding.projectId).filter((r) => r.rootPath && roots.has(key(r.rootPath))).map((r) => r.id);
  return ids.length > 0 ? ids : [binding.projectId];
}

/**
 * Steps 9–11: the request's reach into the bound record's hosted family, each
 * record judged through its own chain AND the credential's narrowing: the
 * family root's root as the ceiling, whether the family root is readable (a
 * family run may compose the whole family only then), and the roots of family
 * records the request may not write (a family migration that must write one
 * refuses family-partial). The caller must gate on reach itself.
 */
function familyReachOf(
  cfg: HostConfig,
  principal: Principal,
  binding: ProjectBinding,
): { topRoot: string; parentReach: boolean; unwritableRoots: string[]; hostedLookup: HostedRecordLookup } {
  // Step 9: the bound project's hosted family, family root first.
  const family = listFamilyRecords(cfg.dataDir, binding.projectId);
  // Step 10: which family records the principal may read and write.
  const reach = resolveFamilyReach(cfg.dataDir, principal, family.map((r) => r.id));
  // The credential's narrowing covers a record iff it binds it (a token for a project reaches its members).
  const covered = (id: string): boolean => resolveProjectBinding(cfg.dataDir, principal, id) !== null;
  // Step 11.
  const topRoot = existingProjectRoot(cfg.dataDir, binding.familyRootId) ?? binding.rootPath;
  const parentReach = reach.readable.includes(binding.familyRootId) && covered(binding.familyRootId);
  const unwritableRoots = family
    .filter((r) => r.rootPath && !(reach.writable.includes(r.id) && covered(r.id)))
    .map((r) => r.rootPath);
  return { topRoot, parentReach, unwritableRoots, hostedLookup: hostedRecordLookup(cfg, principal) };
}

/**
 * The record lookup an external's source.hosted resolves through (stage 7):
 * the root of a hosted record the credential's narrowing covers AND whose own
 * chain grants project:read; null for anything else, unknown and unreadable
 * alike, so it never says whether a record exists. The caller must gate on
 * reach itself, and this is where a hosted producer is gated.
 */
function hostedRecordLookup(cfg: HostConfig, principal: Principal): HostedRecordLookup {
  return (recordId: string): string | null => {
    const bound = resolveProjectBinding(cfg.dataDir, principal, recordId);
    if (!bound || recordId.includes(SUBPROJECT_SEPARATOR)) return null;
    return authorize(cfg.dataDir, principal, 'project:read', 'project', bound.projectId).value === 'yes' ? bound.rootPath : null;
  };
}

/** Step 12: roll back a crashed family migration under the bound family before the tool runs; never fails the request. */
function recoverBoundFamily(cfg: HostConfig, principal: Principal, binding: ProjectBinding): void {
  try {
    recoverUnfinishedMigrations(cfg.dataDir, principal, binding);
  } catch (e) {
    console.error(`[sdd_host] family upkeep failed for project ${binding.projectId}: ${e instanceof Error ? e.message : String(e)}`);
  }
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
