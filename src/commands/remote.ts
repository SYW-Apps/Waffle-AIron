import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { assertProjectInitialized } from '../config/loader.js';
import { getProjectRoot } from '../utils/fs.js';
import { exportSpecTree, importSpecTree } from './subsystem.js';
import { detectHostedMcpSource } from './mcp.js';
import {
  readBinding,
  writeBinding,
  clearBinding,
  readCredential,
  writeCredential,
  clearCredential,
  listCredentialUrls,
} from './remotebinding.js';
import type { RemoteBinding } from './remotebinding.js';
import type { TreeExportResult, TreeImportResult } from '../core/treetransfer.js';

// ---------------------------------------------------------------------------
// CLI Remote Client Adapter + Remote Migration Orchestrator + `wairon remote`
// (sdd_cli → a REMOTE sdd_host instance)
//
// push — export the local spec tree and import it into a hosted project
// pull — export a hosted project's spec tree and import it into this checkout
//
// The transport is the hosted data plane exactly as an agent's MCP client uses
// it: one authenticated JSON-RPC `tools/call` per operation, the bearer in the
// Authorization header and the project in the selector. That is deliberate —
// the CLI is then authenticated, permission-gated and audited by the machinery
// that already exists, with no second auth surface to build or secure.
// ---------------------------------------------------------------------------

/** Everything needed to act on ONE project of ONE hosted instance. */
export interface RemoteTarget {
  url: string;
  projectId: string;
  token: string;
}

/** The choices one migration makes; nothing here defaults permissively. */
export interface RemoteTransferOptions {
  createUnitId?: string;
  replaceExisting?: boolean;
  includeDerived?: boolean;
  archivePath?: string;
  destDir?: string;
}

/** What one migration actually moved. */
export interface RemoteTransferOutcome {
  direction: 'push' | 'pull';
  url: string;
  projectId: string;
  projectName: string;
  roots: string[];
  fileCount: number;
  backupPath?: string;
  createdProject?: boolean;
  archivePath?: string;
  /** Pull only: where the tree landed — a pull may target another directory. */
  destDir?: string;
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
export async function exportRemoteTree(target: RemoteTarget): Promise<TreeExportResult> {
  // Step 1: call the hosted export tool and decode the base64 archive.
  const payload = (await callTool(target, 'sdd_host_export_tree', {})) as {
    projectName?: string;
    roots?: string[];
    fileCount?: number;
    stateId?: string;
    suggestedFileName?: string;
    archiveBase64?: string;
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
 * owner unit through the same permission resolver. Same credential, same gate,
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

// ── remote_orchestrator: the two migration workflows ────────────────────────

/** Migrate the LOCAL spec tree into a hosted project. */
export async function pushTree(
  target: RemoteTarget,
  options: RemoteTransferOptions = {},
): Promise<RemoteTransferOutcome> {
  // Step 1: export the local tree FIRST — nothing is created or changed on the
  // instance until there is something complete to send.
  const exported = exportSpecTree(options.includeDerived);
  // Steps 2–3: optionally write the archive to a file as well.
  const archivePath = writeArchiveIfAsked(exported.archive, options.archivePath, exported.suggestedFileName);
  // Steps 4–5: optionally initialize the destination project first.
  let createdProject = false;
  if (options.createUnitId) {
    const outcome = await initializeRemoteProject(target, options.createUnitId);
    logger.info(`Hosted project initialization: ${outcome}`);
    createdProject = true;
  }
  // Step 6 (send): import the archive into the hosted project.
  const imported = await importRemoteTree(target, exported.archive, options.replaceExisting === true);
  // Steps 7–8: assemble and return what moved.
  const result: RemoteTransferOutcome = {
    direction: 'push',
    url: target.url,
    projectId: target.projectId,
    projectName: imported.projectName ?? exported.projectName,
    roots: imported.roots ?? exported.roots,
    fileCount: imported.fileCount ?? exported.fileCount,
    createdProject,
  };
  if (imported.backupPath) result.backupPath = imported.backupPath;
  if (archivePath) result.archivePath = archivePath;
  return result;
}

/** Migrate a hosted project's spec tree into the local root. */
export async function pullTree(
  target: RemoteTarget,
  options: RemoteTransferOptions = {},
): Promise<RemoteTransferOutcome> {
  // Step 1: export the hosted tree FIRST — the local root is not touched until
  // a complete archive is in hand.
  const exported = await exportRemoteTree(target);
  // Steps 2–3: optionally write the archive to a file as well.
  const archivePath = writeArchiveIfAsked(exported.archive, options.archivePath, exported.suggestedFileName);
  // Step 4 (land): import it locally. The executable-entry guard is deliberately
  // NOT set — this is the trusted-filesystem tier, the same one `wairon packs
  // add` installs code packs through.
  const imported = importSpecTree(exported.archive, {
    replaceExisting: options.replaceExisting === true,
    ...(options.destDir ? { destDir: options.destDir } : {}),
  });
  // Steps 5–6: assemble and return what moved.
  const result: RemoteTransferOutcome = {
    direction: 'pull',
    url: target.url,
    projectId: target.projectId,
    projectName: imported.projectName,
    roots: imported.roots,
    fileCount: imported.fileCount,
    destDir: imported.destDir,
  };
  if (imported.backupPath) result.backupPath = imported.backupPath;
  if (archivePath) result.archivePath = archivePath;
  return result;
}

// ── remote_orchestrator: attachment ─────────────────────────────────────────

/**
 * Which hosted project THIS command addresses, and with which credential.
 *
 * Precedence: explicit flags, then the recorded binding, then the agent's own
 * MCP configuration. That last fallback is the point of the whole feature — a
 * developer whose agent already works against a hosted project never types the
 * connection twice, and the agent and CLI cannot drift onto different projects.
 * Returns null when nothing resolves: an unattached checkout is a normal state,
 * and the caller decides whether that is an error.
 */
export function resolveTarget(root: string, overrides: RemoteCommandOptions = {}): RemoteTarget | null {
  const flagUrl = (overrides.url ?? process.env['WAIRON_REMOTE_URL'] ?? '').trim();
  const flagProject = (overrides.project ?? process.env['WAIRON_REMOTE_PROJECT'] ?? '').trim();
  const flagToken = (overrides.token ?? process.env['WAIRON_REMOTE_TOKEN'] ?? '').trim();

  let url = '';
  let projectId = '';
  let token = flagToken;

  // Step 1–2: an explicit flag always wins over any recorded or derived binding.
  if (flagUrl && flagProject) {
    url = flagUrl;
    projectId = flagProject;
  } else {
    // Step 3–4: the recorded binding for this checkout.
    const binding = readBinding(root);
    if (binding) {
      url = flagUrl || binding.url;
      projectId = flagProject || binding.projectId;
    } else {
      // Step 5–6: the agent's own MCP configuration.
      const detected = detectHostedMcpSource(root);
      if (!detected || detected.kind !== 'hosted' || !detected.url) return null;
      url = flagUrl || detected.url;
      projectId = flagProject || detected.projectId || '';
      if (!token && detected.token) token = detected.token;
    }
  }
  if (!url || !projectId) return null;
  // Step 7–8: fall back to the machine's stored credential for that instance.
  if (!token) token = readCredential(url) ?? '';
  // Step 9: an instance with no usable credential is not a resolved target.
  if (!token) return null;
  return { url, projectId, token };
}

/** Record this checkout's standing binding — after proving it actually works. */
export async function attach(root: string, target: RemoteTarget): Promise<RemoteBinding> {
  // Step 1: verify BEFORE recording. An attach that cannot reach or is refused
  // by the instance must fail here, not leave every later command mysterious.
  await getRemoteStatus(target);
  // Step 2: the credential belongs to the machine...
  writeCredential(target.url, target.token);
  // Step 3: ...the binding belongs to the project.
  const binding: RemoteBinding = {
    url: target.url,
    projectId: target.projectId,
    source: 'binding-file',
    attachedAt: new Date().toISOString(),
  };
  writeBinding(root, binding);
  // Step 4: return the recorded binding.
  return binding;
}

/** Remove this checkout's binding; the stored credential is left alone. */
export function detach(root: string): void {
  // Step 1: the credential belongs to the machine, and other checkouts may use it.
  clearBinding(root);
}

/** What this checkout is attached to and how it resolved — never the credential. */
export function describeAttachment(root: string): RemoteBinding | null {
  // Step 1–2: an explicit binding wins.
  const binding = readBinding(root);
  if (binding) return binding;
  // Step 3–4: otherwise report what the agent's MCP configuration points at, so
  // an unattached checkout still explains where its agent is working.
  const detected = detectHostedMcpSource(root);
  if (!detected || detected.kind !== 'hosted' || !detected.url) return null;
  return { url: detected.url, projectId: detected.projectId ?? '(unset)', source: 'mcp-config' };
}

/** Store a credential for an instance on this machine, after verifying it. */
export async function storeCredential(url: string, token: string, probeProjectId?: string): Promise<void> {
  // Step 1–2: verify before storing — a stored credential that does not work
  // turns every later failure into a permission mystery.
  if (probeProjectId) {
    await getRemoteStatus({ url, projectId: probeProjectId, token });
  }
  // Step 3: store it for this instance.
  writeCredential(url, token);
}

/** Forget a credential LOCALLY (nothing is revoked on the instance). */
export function forgetCredential(url: string): void {
  // Step 1: local only.
  clearCredential(url);
}

/** The instances this machine holds a credential for — URLs only. */
export function listStoredInstances(): string[] {
  // Step 1: URLs only, never tokens.
  return listCredentialUrls();
}

/**
 * The stored credential for an instance, for the one caller that must WRITE it
 * somewhere else: registering a hosted MCP entry the agent will present. The
 * config adapter is deliberately not allowed to read the credential store
 * itself, so the resolution happens here and the token is handed over.
 */
export function storedCredentialFor(url: string): string | null {
  return readCredential(url);
}

// ── remote_orchestrator: the attached counterparts of local commands ────────

/** Validate the ATTACHED project's tree on the instance. */
export async function validateAttached(target: RemoteTarget, subsystem?: string): Promise<unknown> {
  // Step 1: forward to the remote adapter.
  return validateRemoteTree(target, subsystem);
}

/** Read the ATTACHED project's completeness dashboard. */
export async function statusAttached(target: RemoteTarget, subsystem?: string): Promise<string> {
  // Step 1: forward to the remote adapter.
  return getRemoteStatus(target, subsystem);
}

/** Freeze the ATTACHED project's tree, carrying an approval outcome back as such. */
export async function lockAttached(target: RemoteTarget): Promise<string> {
  // Step 1: forward to the remote adapter.
  return lockRemoteProject(target);
}

// ── `wairon remote <action>` ────────────────────────────────────────────────

export interface RemoteCommandOptions {
  url?: string;
  project?: string;
  token?: string;
  unit?: string;
  force?: boolean;
  includeDerived?: boolean;
  archive?: string;
  dir?: string;
}

export async function runRemote(action: string, options: RemoteCommandOptions = {}): Promise<void> {
  const root = getProjectRoot();

  // `status` and `detach` must work on an unresolvable checkout — that IS the
  // question they answer — so they run before the target is demanded.
  if (action === 'status') {
    // Step 11–12: describe what this checkout addresses and where that came from.
    reportAttachment(root);
    return;
  }
  if (action === 'detach') {
    // Step 9–10: return the checkout to purely local operation.
    detach(root);
    logger.success('Detached — wairon commands now run against this checkout\'s own .wai tree.');
    return;
  }

  // Step 1: resolve the instance, project and credential: explicit flags, then
  // the environment, then the recorded binding, then the agent's MCP config.
  const target = requireTarget(root, options);

  // Step 2: route on the action.
  switch (action) {
    case 'attach': {
      // Step 7–8: record the binding after proving it resolves.
      const binding = await attach(root, target);
      logger.success(`Attached to ${binding.projectId} on ${binding.url}.`);
      logger.info('validate, status and lock now run against the hosted tree; `wairon remote pull` brings it local.');
      return;
    }
    case 'push': {
      // A push sends THIS checkout's tree, so it must be a wairon project.
      assertProjectInitialized();
      const transfer: RemoteTransferOptions = {
        replaceExisting: options.force === true,
        includeDerived: options.includeDerived === true,
      };
      if (options.unit) transfer.createUnitId = options.unit;
      if (options.archive) transfer.archivePath = options.archive;
      // Step 3: migrate the local tree up.
      report(await pushTree(target, transfer));
      return;
    }
    case 'pull': {
      const transfer: RemoteTransferOptions = { replaceExisting: options.force === true };
      if (options.archive) transfer.archivePath = options.archive;
      if (options.dir) transfer.destDir = path.resolve(options.dir);
      // Step 5: migrate the hosted tree down.
      report(await pullTree(target, transfer));
      return;
    }
    default:
      // Step 13: reject an unknown action, naming the supported ones.
      throw new WaironError(
        `Unknown remote action "${action}" (supported: push, pull, attach, detach, status).`,
      );
  }
}

/** `wairon login <url>` — store a credential for an instance on this machine. */
export async function runLogin(url: string, options: RemoteCommandOptions = {}): Promise<void> {
  // Step 1: take the token from --token or the environment, and normalize the URL.
  const instance = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(instance)) {
    throw new WaironError(`The instance must be an http(s) URL (got "${url}").`);
  }
  const token = (options.token ?? process.env['WAIRON_REMOTE_TOKEN'] ?? '').trim();
  if (!token) {
    throw new WaironError(
      'Pass the token with --token (or WAIRON_REMOTE_TOKEN). Mint one in the hosted web UI under Tokens.',
    );
  }
  // Step 2: verify it against the instance before storing, when a project was
  // named to probe with — a stored credential that does not work turns every
  // later failure into a permission mystery.
  const probe = (options.project ?? process.env['WAIRON_REMOTE_PROJECT'] ?? '').trim();
  await storeCredential(instance, token, probe || undefined);
  // Step 3: confirm, without echoing the credential.
  logger.success(`Stored a credential for ${instance}${probe ? ` (verified against "${probe}")` : ''}.`);
  if (!probe) {
    logger.info('Not verified — pass --project <id> to check the credential works before you rely on it.');
  }
  logger.info(`Next: \`wairon remote attach --url ${instance} --project <id>\` to bind this checkout.`);
}

/** `wairon logout [url]` — forget a stored credential, or list what is stored. */
export async function runLogout(url: string | undefined, _options: RemoteCommandOptions = {}): Promise<void> {
  // Step 1: was an instance named?
  if (url && url.trim()) {
    const instance = url.trim().replace(/\/+$/, '');
    // Step 2: forget it locally.
    forgetCredential(instance);
    // Step 3: say plainly what this did NOT do.
    logger.success(`Forgot the stored credential for ${instance}.`);
    logger.warn('This is local only — the token is NOT revoked. Revoke it in the hosted web UI under Tokens.');
    return;
  }
  // Step 4: list the instances this machine holds a credential for.
  const stored = listStoredInstances();
  if (!stored.length) {
    logger.info('No stored credentials.');
    return;
  }
  logger.info('Stored credentials for:');
  for (const instance of stored) logger.info(`  ${chalk.cyan(instance)}`);
}

// --- helpers ---------------------------------------------------------------

/** Resolve the target, or refuse with guidance naming exactly what is missing. */
function requireTarget(root: string, options: RemoteCommandOptions): RemoteTarget {
  const target = resolveTarget(root, options);
  if (target) {
    if (!/^https?:\/\//i.test(target.url)) {
      throw new WaironError(`The instance must be an http(s) URL (got "${target.url}").`);
    }
    return target;
  }
  // Name what is actually absent rather than a generic failure: the three
  // inputs come from four possible places, and "which one" is the whole
  // question a developer has at this moment.
  const url = (options.url ?? process.env['WAIRON_REMOTE_URL'] ?? '').trim();
  const projectId = (options.project ?? process.env['WAIRON_REMOTE_PROJECT'] ?? '').trim();
  const token = (options.token ?? process.env['WAIRON_REMOTE_TOKEN'] ?? '').trim();
  const missing: string[] = [];
  if (!url) missing.push('--url (or WAIRON_REMOTE_URL)');
  if (!projectId) missing.push('--project (or WAIRON_REMOTE_PROJECT)');
  if (!token) missing.push('--token (or WAIRON_REMOTE_TOKEN, or `wairon login <url>`)');
  throw new WaironError(
    `Missing ${missing.join(', ')}. This checkout is not attached and nothing was resolvable from ` +
      'the agent\'s MCP configuration — pass the flags, or run `wairon remote attach` once.',
  );
}

/** Print what this checkout addresses and where that answer came from. */
function reportAttachment(root: string): void {
  const binding = describeAttachment(root);
  if (!binding) {
    logger.info('Not attached — wairon commands run against this checkout\'s own .wai tree.');
    const stored = listStoredInstances();
    if (stored.length) logger.info(`Credentials stored for: ${stored.map((u) => chalk.cyan(u)).join(', ')}`);
    return;
  }
  const via = binding.source === 'mcp-config'
    ? "derived from the agent's MCP configuration (not an explicit attach)"
    : 'explicitly attached';
  logger.success(`Attached to ${chalk.cyan(binding.projectId)} on ${chalk.cyan(binding.url)} — ${via}.`);
  if (binding.attachedAt) logger.info(`Attached at ${binding.attachedAt}`);
  logger.info(
    readCredential(binding.url)
      ? 'A credential is stored for this instance.'
      : `No stored credential for this instance — run \`wairon login ${binding.url}\`.`,
  );
}

/** The TOP project id of a possibly subproject-qualified selector. */
function topProjectId(selector: string): string {
  return selector.split('::')[0];
}

/** Write the archive when the caller asked for a file copy; returns where. */
function writeArchiveIfAsked(
  archive: Uint8Array,
  archivePath: string | undefined,
  suggestedFileName: string,
): string | undefined {
  if (!archivePath) return undefined;
  const resolved = path.resolve(archivePath);
  // A directory target keeps the archive's own suggested name.
  const target = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()
    ? path.join(resolved, suggestedFileName)
    : resolved;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(archive));
  return target;
}

/** Step 8 (report): print what moved — a replaced tree must always name the
 *  backup it can be undone from. */
function report(outcome: RemoteTransferOutcome): void {
  const where =
    outcome.direction === 'push'
      ? `${outcome.url} → ${outcome.projectId}`
      : `${outcome.projectId} → ${outcome.destDir ?? getProjectRoot()}`;
  logger.success(
    `${outcome.direction === 'push' ? 'Pushed' : 'Pulled'} "${outcome.projectName}": ` +
      `${outcome.fileCount} file(s) across ${outcome.roots.length} root(s) — ${where}`,
  );
  if (outcome.roots.length > 1) {
    logger.info(`Roots: ${outcome.roots.map((r) => chalk.cyan(r)).join(', ')}`);
  }
  if (outcome.createdProject) {
    logger.info(`Created the hosted project "${topProjectId(outcome.projectId)}".`);
  }
  if (outcome.archivePath) {
    logger.info(`Archive written to ${chalk.cyan(outcome.archivePath)}`);
  }
  if (outcome.backupPath) {
    logger.info(`The replaced tree was backed up to ${chalk.cyan(outcome.backupPath)} — restore it by moving it back.`);
  }
}
