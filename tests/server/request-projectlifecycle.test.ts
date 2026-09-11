import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { handleMcpRequest } from '../../src/server/request.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { createProjectRecord, existingProjectRoot } from '../../src/server/projects.js';
import { hostCore } from '../../src/server/adapters.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { lockProject } from '../../src/server/projectlifecycle.js';
import { listApprovalRequests } from '../../src/server/approvals.js';
import { setAssignment } from '../../src/server/permissions.js';
import { createUnit } from '../../src/server/organization.js';
import * as packs from '../../src/server/packs.js';
import { setPackPolicyRecord } from '../../src/server/policy.js';
import { mintUserToken, allow as grant, seedChainedMount } from './helpers.js';
import type {
  ApiKeyRecord,
  Capability,
  HostConfig,
  InstancePackPolicy,
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

// ---------------------------------------------------------------------------
// Host Request Orchestrator — SUBPROJECT CONFINEMENT (steps 10–11 + 16/18).
//
// A hosted token may be narrowed to a chained subproject ('projectId::subsystemId')
// and the data plane then binds the CHILD root for every ordinary sdd_* tool. Two
// families of hosted tools bypass that binding by construction:
//
//   RECORD-level (refused, steps 10–11): initialize / approval status / await
//   approval + the six project-ops tools (pack list/install, policy
//   evaluate/reconcile, produce, commit). They act on the hosted project RECORD
//   with the TOP project id, so serving one to a qualified credential would let a
//   token scoped to one child act on the WHOLE parent — the qualifier would narrow
//   nothing. They are refused as an isError tool result BEFORE any dispatch, and
//   the refusal still flows through the same best-effort audit path.
//
//   TREE-scoped (confined by FORWARDING, steps 16/18): lock + promote. The bound
//   qualifier is passed through, so the freeze / StateId re-check lands on exactly
//   the child tree the credential is scoped to.
//
// Both tokens below are owned by the SAME subject with the SAME grants, so the only
// difference between a refusal and a success is the narrowing — never a permission.
// ---------------------------------------------------------------------------

const CONFINE_PACK = ['name: sneaky-doctrine', 'profiles: {}', 'languages: {}', ''].join('\n');
const SEEDED_PACK = ['name: seeded-doctrine', 'profiles: {}', 'languages: {}', ''].join('\n');
const POLICY_PACK = ['name: policy-doctrine', 'profiles: {}', 'languages: {}', ''].join('\n');

/** A full InstancePackPolicy whose single default pack a reconcile must vendor. */
function policyVendoring(name: string): InstancePackPolicy {
  return {
    id: 'inst-policy',
    requiredGlobalPacks: [],
    defaultProjectPacks: [name],
    allowedProfileIds: [],
    requiredProfileIds: [],
    blockedPackNames: [],
    requireProfileSelection: false,
    enforcementMode: 'warn',
    updatedAt: '',
  };
}

describe('handleMcpRequest subproject confinement (end-to-end)', () => {
  const MASTER = 'confine-master-credential-value';
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  let demoRoot: string;
  let childRoot: string;
  let unitId: string;
  /** Narrowed to demo::billing (the confined credential). */
  let qualTok: string;
  /** Narrowed to plain demo — SAME owner, SAME grants (the control). */
  let plainTok: string;
  /** A pending project:lock request on demo, and the requester's own two narrowings. */
  let seededRequestId: string;
  let requesterQualTok: string;
  let requesterPlainTok: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-confine-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    // Isolate BOTH global pack tiers so a populated host never leaks in.
    const packsDir = path.join(base, 'global-packs');
    fs.mkdirSync(packsDir, { recursive: true });
    fs.writeFileSync(path.join(packsDir, 'policy-doctrine.yaml'), POLICY_PACK);
    process.env.WAIRON_PACKS_DIR = packsDir;
    process.env.WAIRON_IMAGE_PACKS_DIR = path.join(base, 'image-packs');
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

    // demo (provisioned, lockable) ── billing (chained subproject, also lockable)
    demoRoot = createProjectRecord(dataDir, 'demo').rootPath;
    runWithProjectRoot(demoRoot, () => hostCore.provisionProject('demo'));
    childRoot = seedChainedMount(demoRoot, 'billing', 'packages/billing');
    runWithProjectRoot(childRoot, () => hostCore.provisionProject('billing'));
    invalidateSpecCache();

    unitId = createUnit(dataDir, {
      id: '', name: 'Confine', slug: 'confine', kind: 'team', status: 'active', createdAt: '', createdBy: subject(),
    }).id;

    // ONE owner holding everything the nine record-level tools could ever need,
    // so a refusal can only come from the confinement guard.
    for (const cap of ['project:read', 'project:write', 'project:admin'] as Capability[]) {
      grant(dataDir, 'u-full', cap, 'project', 'demo');
    }
    grant(dataDir, 'u-full', 'project:create', 'unit', unitId);
    grant(dataDir, 'u-full', 'approval:decide', 'instance', undefined);
    qualTok = mintUserToken(dataDir, { id: 'tok-qual', userId: 'u-full', projects: ['demo::billing'] });
    plainTok = mintUserToken(dataDir, { id: 'tok-plain', userId: 'u-full', projects: ['demo'] });

    // A real pending project:lock request, plus the REQUESTER's own two narrowings
    // (only the original requester may await, so the control needs its token).
    grant(dataDir, 'u-req', 'project:write', 'project', 'demo', 'approval');
    requesterQualTok = mintUserToken(dataDir, { id: 'tok-req-qual', userId: 'u-req', projects: ['demo::billing'] });
    requesterPlainTok = mintUserToken(dataDir, { id: 'tok-req-plain', userId: 'u-req', projects: ['demo'] });
    seededRequestId = lockProject(cfg, requesterPlainTok, 'demo').approval!.id;

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
    invalidateSpecCache();
    process.env = { ...savedEnv };
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  interface RpcResponse {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { code?: number; message?: string };
  }
  const text = (r: RpcResponse): string => r.result?.content?.[0]?.text ?? '';

  /** One tools/call as `token`; single-entry narrowings need no selector, so the
   *  qualified token binds demo::billing and the plain token binds demo. */
  const send = async (token: string, tool: string, args: Record<string, unknown> = {}): Promise<RpcResponse> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(call(tool, args)),
    });
    // A confinement refusal is a TOOL RESULT, never an HTTP error.
    expect(res.status).toBe(200);
    return (await res.json()) as RpcResponse;
  };

  /** True only for THE confinement refusal: isError, naming the tool, the bound
   *  qualifier, and the "acts on the whole project" reason. Deliberately strict so
   *  an unrelated failure (a permission denial, an Unknown-project error, a
   *  producer misconfiguration) can never be mistaken for the guard firing. */
  const refused = (r: RpcResponse, tool: string): boolean =>
    r.result?.isError === true &&
    text(r).includes(tool) &&
    text(r).includes('demo::billing') &&
    /acts on the whole project/.test(text(r)) &&
    /unqualified credential/.test(text(r));

  /** The nine RECORD-level tools with arguments that WOULD take effect. */
  const recordLevelCalls = (): { tool: string; args: Record<string, unknown> }[] => [
    { tool: 'sdd_host_initialize_project', args: { id: 'sneaky', displayName: 'Sneaky', ownerUnitId: unitId } },
    { tool: 'sdd_host_get_approval_status', args: { requestId: seededRequestId } },
    { tool: 'sdd_host_await_approval', args: { requestId: seededRequestId, timeoutSeconds: 0 } },
    { tool: 'sdd_host_pack_list', args: {} },
    { tool: 'sdd_host_pack_install', args: { name: 'sneaky', content: CONFINE_PACK } },
    { tool: 'sdd_host_policy_evaluate', args: {} },
    { tool: 'sdd_host_policy_reconcile', args: {} },
    { tool: 'sdd_host_produce', args: { target: 'notion' } },
    { tool: 'sdd_host_commit_project', args: { message: 'sneaky commit' } },
  ];

  // ── the refused set ────────────────────────────────────────────────────────

  it('refuses EVERY record-level hosted tool on a subproject-qualified binding (isError, HTTP 200)', async () => {
    for (const { tool, args } of recordLevelCalls()) {
      const body = await send(qualTok, tool, args);
      expect(refused(body, tool), `${tool} was not refused: ${text(body)}`).toBe(true);
    }
    // The await_approval refusal is immediate — it never enters the long poll.
  }, 30_000);

  it('the same nine tools on an UNQUALIFIED binding are never refused (no regression)', async () => {
    for (const { tool, args } of recordLevelCalls()) {
      const body = await send(plainTok, tool, args);
      expect(refused(body, tool), `${tool} was wrongly refused on a plain binding`).toBe(false);
    }
  }, 30_000);

  it('a refusal still flows through the SAME best-effort audit path (TOP project id + bound qualifier)', async () => {
    await send(qualTok, 'sdd_host_commit_project', { message: 'sneaky commit' });

    const events = queryAuditEvents(dataDir, { action: 'mcp.tool.call' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      target: 'sdd_host_commit_project',
      projectId: 'demo', // TOP project id — provenance anchors at the top
      outcome: 'failed', // an isError result derives a failed outcome
      tokenId: 'tok-qual',
    });
    expect(JSON.parse(events[0].metadata ?? '{}')).toEqual({ subproject: 'billing' });
  }, 20_000);

  // ── what each refusal PREVENTED ────────────────────────────────────────────

  it('refused initialize: NO new project was created and NO approval request was queued', async () => {
    const before = listApprovalRequests(dataDir).length;
    const body = await send(qualTok, 'sdd_host_initialize_project', {
      id: 'sneaky', displayName: 'Sneaky', ownerUnitId: unitId,
    });
    expect(refused(body, 'sdd_host_initialize_project')).toBe(true);

    // DID NOT HAPPEN: no project record/tree for "sneaky", and no new approval.
    expect(existingProjectRoot(dataDir, 'sneaky')).toBeNull();
    expect(fs.existsSync(path.join(dataDir, 'projects', 'sneaky'))).toBe(false);
    expect(listApprovalRequests(dataDir)).toHaveLength(before);

    // The control DOES create it, proving the fixture could have succeeded.
    const ok = await send(plainTok, 'sdd_host_initialize_project', {
      id: 'sneaky', displayName: 'Sneaky', ownerUnitId: unitId,
    });
    expect(ok.result?.isError).toBeFalsy();
    expect(existingProjectRoot(dataDir, 'sneaky')).toBeTruthy();
  }, 20_000);

  it('refused pack install: the pack was NOT vendored into the parent project', async () => {
    const body = await send(qualTok, 'sdd_host_pack_install', { name: 'sneaky', content: CONFINE_PACK });
    expect(refused(body, 'sdd_host_pack_install')).toBe(true);

    // DID NOT HAPPEN: nothing landed in the parent's pack set or on its disk.
    expect(packs.listProjectPacks(cfg, MASTER, 'demo').map((p) => p.name)).not.toContain('sneaky-doctrine');
    expect(fs.existsSync(path.join(demoRoot, '.wai', 'packs', 'sneaky.yaml'))).toBe(false);
    // …nor in the CHILD tree (the guard refuses; it never redirects the write).
    expect(fs.existsSync(path.join(childRoot, '.wai', 'packs', 'sneaky.yaml'))).toBe(false);

    // The control installs it into the parent, proving the call was viable.
    const ok = await send(plainTok, 'sdd_host_pack_install', { name: 'sneaky', content: CONFINE_PACK });
    expect(ok.result?.isError).toBeFalsy();
    expect(packs.listProjectPacks(cfg, MASTER, 'demo').map((p) => p.name)).toContain('sneaky-doctrine');
  }, 20_000);

  it("refused policy reconcile: the instance policy's default pack was NOT vendored into the parent", async () => {
    setPackPolicyRecord(dataDir, policyVendoring('policy-doctrine'));

    const body = await send(qualTok, 'sdd_host_policy_reconcile', {});
    expect(refused(body, 'sdd_host_policy_reconcile')).toBe(true);

    // DID NOT HAPPEN: the reconciliation never ran, so the default pack is absent.
    expect(packs.listProjectPacks(cfg, MASTER, 'demo').map((p) => p.name)).not.toContain('policy-doctrine');

    // The control reconciles, vendoring it — the policy really was actionable.
    const ok = await send(plainTok, 'sdd_host_policy_reconcile', {});
    expect(ok.result?.isError, text(ok)).toBeFalsy();
    expect(packs.listProjectPacks(cfg, MASTER, 'demo').map((p) => p.name)).toContain('policy-doctrine');
  }, 20_000);

  it('refused pack list / policy evaluate: the parent project’s state was NOT disclosed', async () => {
    packs.installProjectPack(cfg, MASTER, 'demo', 'seeded', SEEDED_PACK);

    const list = await send(qualTok, 'sdd_host_pack_list', {});
    expect(refused(list, 'sdd_host_pack_list')).toBe(true);
    // DID NOT HAPPEN: the parent's installed pack is not named in the refusal.
    expect(text(list)).not.toContain('seeded-doctrine');

    const evaluated = await send(qualTok, 'sdd_host_policy_evaluate', {});
    expect(refused(evaluated, 'sdd_host_policy_evaluate')).toBe(true);
    // DID NOT HAPPEN: no evaluation payload came back.
    expect(text(evaluated)).not.toContain('compliant');

    // The control sees the parent's pack, proving the listing was available.
    const ok = await send(plainTok, 'sdd_host_pack_list', {});
    expect(text(ok)).toContain('seeded-doctrine');
  }, 20_000);

  it('refused approval status / await: the parent project’s pending request was NOT disclosed', async () => {
    for (const tool of ['sdd_host_get_approval_status', 'sdd_host_await_approval']) {
      const tok = tool === 'sdd_host_await_approval' ? requesterQualTok : qualTok;
      const body = await send(tok, tool, { requestId: seededRequestId, timeoutSeconds: 0 });
      expect(refused(body, tool), text(body)).toBe(true);
      // DID NOT HAPPEN: the request id and its status never reach the caller.
      expect(text(body)).not.toContain(seededRequestId);
      expect(text(body)).not.toContain('pending');
    }

    // The controls DO see it (u-full via approval:decide, u-req as requester).
    expect(text(await send(plainTok, 'sdd_host_get_approval_status', { requestId: seededRequestId })))
      .toContain(seededRequestId);
    expect(text(await send(requesterPlainTok, 'sdd_host_await_approval', { requestId: seededRequestId, timeoutSeconds: 0 })))
      .toContain(seededRequestId);
  }, 20_000);

  // ── the TREE-scoped pair: confined by forwarding, not refused ──────────────

  it('lock on a qualified binding freezes the CHILD tree and leaves the PARENT unlocked', async () => {
    const body = await send(qualTok, 'sdd_host_lock_project', {});
    expect(body.result?.isError, text(body)).toBeFalsy();
    const outcome = JSON.parse(text(body)) as ProjectActionOutcome;
    expect(outcome.status).toBe('completed');
    expect(outcome.action).toBe('project:lock');
    expect(outcome.summary).toContain('subproject "billing"');

    // The lock record landed in the CHILD's .wai/ …
    const childLockPath = path.join(childRoot, '.wai', 'lock.json');
    expect(fs.existsSync(childLockPath)).toBe(true);
    const childLock = JSON.parse(fs.readFileSync(childLockPath, 'utf8')) as { stateId: { digest: string }; status: string };
    expect(childLock.status).toBe('ready');
    expect(outcome.lock?.stateId.digest).toBe(childLock.stateId.digest);

    // DID NOT HAPPEN: the PARENT tree was never locked — no record at all.
    expect(fs.existsSync(path.join(demoRoot, '.wai', 'lock.json'))).toBe(false);
    // …and the child's StateId is genuinely the child's, not the parent's.
    const parentStateId = runWithProjectRoot(demoRoot, () => hostCore.computeStateId());
    expect(childLock.stateId.digest).not.toBe(parentStateId.digest);
  }, 20_000);

  it('lock WITHOUT a qualifier still locks the project itself (no regression)', async () => {
    const body = await send(plainTok, 'sdd_host_lock_project', {});
    const outcome = JSON.parse(text(body)) as ProjectActionOutcome;
    expect(outcome.status).toBe('completed');
    expect(outcome.summary).toContain('Locked project "demo"');
    expect(outcome.summary).not.toContain('subproject');

    expect(fs.existsSync(path.join(demoRoot, '.wai', 'lock.json'))).toBe(true);
    // The child was NOT dragged along by a project-level lock.
    expect(fs.existsSync(path.join(childRoot, '.wai', 'lock.json'))).toBe(false);
  }, 20_000);

});
