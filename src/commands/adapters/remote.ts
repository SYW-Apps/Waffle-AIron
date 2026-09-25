import { WaironError } from '../../utils/errors.js';
import type { TreeExportResult, TreeImportResult } from '../../core/treetransfer.js';

// ---------------------------------------------------------------------------
// cli_remote_adapter — sdd_cli's client hop onto a REMOTE sdd_host instance.
//
// The transport is the hosted data plane exactly as an agent's MCP client uses
// it: one authenticated JSON-RPC `tools/call` per operation, the bearer in the
// Authorization header and the project in the selector — plus the one call the
// data plane cannot answer (creating the project it would bind), which goes to
// the web plane's project route with the same credential. The migration
// workflows and `wairon remote` itself stay in ../remote.ts.
// ---------------------------------------------------------------------------

/** Everything needed to act on ONE project of ONE hosted instance. */
export interface RemoteTarget {
  url: string;
  projectId: string;
  token: string;
}

// ── cli_remote_adapter: the HTTP edge onto a remote data plane ──────────────

/** The MCP tool-result envelope the hosted data plane answers with. */
interface RpcEnvelope {
  error?: { message?: string } | string;
  result?: { content?: { type: string; text?: string }[]; isError?: boolean };
}

/**
 * One authenticated `tools/call` against the hosted data plane. Returns the
 * tool's payload — parsed as JSON when it is JSON, else the raw text.
 *
 * A hosted REFUSAL arrives as HTTP 200 carrying `isError`, so unwrapping the
 * envelope is not a nicety: without it a Forbidden would read as a successful
 * migration that moved nothing.
 */
async function callTool(target: RemoteTarget, name: string, args: Record<string, unknown>): Promise<unknown> {
  const endpoint = `${target.url.replace(/\/+$/, '')}/mcp?project=${encodeURIComponent(target.projectId)}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.token}`,
        'content-type': 'application/json',
        // The streamable transport requires BOTH advertised; the host answers JSON.
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch (e) {
    throw new WaironError(
      `Could not reach the hosted instance at ${target.url} — ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const text = await res.text();
  let payload: RpcEnvelope;
  try {
    payload = text ? (JSON.parse(text) as RpcEnvelope) : {};
  } catch {
    throw new WaironError(`${name}: unexpected non-JSON response from ${target.url} (HTTP ${res.status})`);
  }

  if (!res.ok) {
    const e = payload.error;
    const msg = typeof e === 'string' ? e : e?.message;
    if (res.status === 401) {
      throw new WaironError(
        `Unauthorized at ${target.url} — the token was rejected. Mint one in the hosted UI (Tokens) and pass it with --token or WAIRON_REMOTE_TOKEN.`,
      );
    }
    if (res.status === 403) {
      throw new WaironError(
        `Forbidden at ${target.url} — the token is not authorized for project "${target.projectId}"${msg ? ` (${msg})` : ''}.`,
      );
    }
    throw new WaironError(msg ?? `${name} failed against ${target.url} (HTTP ${res.status})`);
  }
  if (payload.error !== undefined && payload.error !== null) {
    const e = payload.error;
    throw new WaironError(typeof e === 'string' ? e : e.message ?? `${name} failed`);
  }

  const first = payload.result?.content?.[0];
  const raw = first && first.type === 'text' ? first.text ?? '' : '';
  if (payload.result?.isError) {
    throw new WaironError(raw || `${name} was refused by ${target.url}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** cli_remote_adapter.exportRemoteTree — sdd_host_export_tree, decoded. */
export async function exportRemoteTree(target: RemoteTarget, allowPartial?: boolean): Promise<TreeExportResult> {
  // Step 1: call the hosted export tool and decode the base64 archive.
  const payload = (await callTool(target, 'sdd_host_export_tree', { allowPartial: allowPartial === true })) as {
    projectName?: string;
    roots?: string[];
    fileCount?: number;
    stateId?: string;
    suggestedFileName?: string;
    archiveBase64?: string;
    skipped?: { mount: string; projectPath: string; reason: string }[];
  };
  if (!payload || typeof payload.archiveBase64 !== 'string' || !payload.archiveBase64) {
    throw new WaironError(`The hosted export returned no archive for project "${target.projectId}".`);
  }
  const result: TreeExportResult = {
    archive: Buffer.from(payload.archiveBase64, 'base64'),
    suggestedFileName: payload.suggestedFileName ?? `${target.projectId}.waitree`,
    projectName: payload.projectName ?? target.projectId,
    roots: payload.roots ?? ['.'],
    fileCount: payload.fileCount ?? 0,
    skipped: (payload.skipped ?? []) as TreeExportResult['skipped'],
  };
  if (payload.stateId) result.stateId = payload.stateId;
  return result;
}

/** cli_remote_adapter.importRemoteTree — sdd_host_import_tree. */
export async function importRemoteTree(
  target: RemoteTarget,
  archive: Uint8Array,
  replaceExisting: boolean,
): Promise<TreeImportResult> {
  // Step 1: call the hosted import tool with the base64-encoded archive.
  return (await callTool(target, 'sdd_host_import_tree', {
    archiveBase64: Buffer.from(archive).toString('base64'),
    replaceExisting,
  })) as TreeImportResult;
}

/** cli_remote_adapter.validateRemoteTree — sdd_validate_tree on the bound project. */
export async function validateRemoteTree(target: RemoteTarget, subsystem?: string): Promise<unknown> {
  // Step 1: call the hosted validator over the bound tree.
  return callTool(target, 'sdd_validate_tree', subsystem ? { subsystem } : {});
}

/** cli_remote_adapter.getRemoteStatus — sdd_get_status on the bound project. */
export async function getRemoteStatus(target: RemoteTarget, subsystem?: string): Promise<string> {
  // Step 1: call the hosted status tool; it answers rendered text, not JSON.
  const result = await callTool(target, 'sdd_get_status', subsystem ? { subsystem } : {});
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}

/** cli_remote_adapter.lockRemoteProject — sdd_host_lock_project on the bound tree. */
export async function lockRemoteProject(target: RemoteTarget): Promise<string> {
  // Step 1: call the hosted lock. An approval-gated instance answers that a
  // REQUEST was created — returned verbatim, never reshaped into a success.
  const outcome = (await callTool(target, 'sdd_host_lock_project', {})) as
    | { status?: string; summary?: string }
    | string;
  if (typeof outcome === 'string') return outcome;
  return `${outcome.status ?? 'completed'}: ${outcome.summary ?? 'locked'}`.trim();
}

/**
 * cli_remote_adapter.initializeRemoteProject — create the destination project.
 *
 * Deliberately NOT the data plane: /mcp binds ONE project and resolves that
 * binding BEFORE dispatching any tool, so a project that does not exist yet can
 * never be addressed there — sdd_host_initialize_project is reachable only from
 * a session already bound to some OTHER project. The web plane's project route
 * is instance-scoped, accepts the same bearer credential (its auth bridge takes
 * a bearer in place of a session cookie), and resolves project:create over the
 * owner unit through the same permission rules. Same credential, same gate,
 * the one endpoint that can answer before the project exists.
 */
export async function initializeRemoteProject(target: RemoteTarget, ownerUnitId: string): Promise<string> {
  // Step 1: POST the create to the hosted web plane with the bearer credential.
  const endpoint = `${target.url.replace(/\/+$/, '')}/web/projects`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${target.token}`,
        'content-type': 'application/json',
        'X-Wairon-Web': '1',
      },
      body: JSON.stringify({ id: topProjectId(target.projectId), unitId: ownerUnitId }),
    });
  } catch (e) {
    throw new WaironError(
      `Could not reach the hosted instance at ${target.url} — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const text = await res.text();
  if (res.status === 404) {
    throw new WaironError(
      `${target.url} does not expose the project route (its web plane is disabled), so --unit cannot create ` +
        `"${topProjectId(target.projectId)}" from here. Create the project on the instance first, then push without --unit.`,
    );
  }
  if (!res.ok) {
    let message = `Creating project "${topProjectId(target.projectId)}" failed (HTTP ${res.status})`;
    try {
      const parsed = text ? (JSON.parse(text) as { error?: string }) : null;
      if (parsed?.error) message = parsed.error;
    } catch {
      /* keep the default */
    }
    throw new WaironError(message);
  }
  // Step 2: report what the instance did — an approval-gated instance answers
  // that a request was created, which is NOT a completed project.
  const record = text ? (JSON.parse(text) as { id?: string; status?: string; summary?: string }) : {};
  return record.summary ?? `created project "${record.id ?? topProjectId(target.projectId)}"`;
}

/** The TOP project id of a possibly subproject-qualified selector. */
function topProjectId(selector: string): string {
  return selector.split('::')[0];
}
