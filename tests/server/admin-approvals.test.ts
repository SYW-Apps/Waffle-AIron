import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { routeAdmin } from '../../src/server/http.js';
import { initializeProject } from '../../src/server/projectlifecycle.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { existingProjectRoot } from '../../src/server/projects.js';
import { setAssignment } from '../../src/server/permissions.js';
import { upsertOrganizationUnit } from '../../src/server/organization.js';
import type {
  ApiKeyRecord,
  ApprovalRequest,
  Capability,
  HostConfig,
  OrganizationUnitRecord,
  PermissionValue,
  PrincipalSubject,
  ScopeKind,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Admin approval endpoints (sdd_host) — exercised through the REAL admin-plane
// routing (http.ts routeAdmin) over a real HTTP listener bound to an ephemeral
// port, so the routes, the path/body → ApprovalDecision assembly, and the
// 401/403/404/400 error mapping are all covered end-to-end. The three routes
// forward to the project lifecycle orchestrator per admin_portal_impl:
//   GET  /admin/approvals               → listPendingRequests
//   POST /admin/approvals/{id}/decision → decideRequest (approve AUTO-EXECUTES)
//   POST /admin/approvals/{id}/execute  → executeApprovedRequest (manual retry)
// The admin-plane credential is the bootstrap master (WAIRON_ADMIN_TOKEN), which
// is an instance-admin and thus carries approval:decide implicitly. Pending
// requests are seeded from approval-valued requesters — execute-primary means a
// yes-valued caller (like the admin) executes directly and never queues one.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

describe('admin approval endpoints (sdd_host http)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let baseUrl: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-admin-approvals-'));
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

    // Drive the real admin-plane router over a real socket (the production admin
    // listener wires routeAdmin the same way in startHostServer).
    server = http.createServer((req, res) => {
      void routeAdmin(cfg, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  async function api(
    method: string,
    pathname: string,
    opts: { cred?: string; body?: unknown } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.cred) headers['Authorization'] = `Bearer ${opts.cred}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(baseUrl + pathname, init);
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  /** Mint a stored grants-free non-admin token owned by `userId`. */
  function mintToken(id: string, userId: string): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id,
      keyHash: hashToken(token),
      projects: ['*'],
      createdAt: new Date().toISOString(),
      ownerSubject: subject({ userId }),
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

  function seedUnit(name: string): OrganizationUnitRecord {
    return upsertOrganizationUnit(dataDir, {
      id: '', name, kind: 'team', status: 'active', createdAt: '', createdBy: subject(),
    });
  }

  /** Seed a pending project:init request FROM an approval-valued requester
   *  (userId), so the admin (MASTER) deciding it is never the original
   *  requester. Returns the request id. */
  function seedInitRequestFrom(userId: string, projectId: string): string {
    const unit = seedUnit(`unit-${projectId}`);
    const requester = mintToken(`tok-${userId}`, userId);
    allow(userId, 'project:create', 'unit', unit.id, 'approval');
    const outcome = initializeProject(cfg, requester, { id: projectId, ownerUnitId: unit.id });
    expect(outcome.status).toBe('pending-approval');
    return outcome.approval!.id;
  }

  // ── listApprovals: GET /admin/approvals ──────────────────────────────────────

  it('list requires an admin-plane credential: 401 for a bare request', async () => {
    const res = await api('GET', '/admin/approvals');
    expect(res.status).toBe(401);
  });

  it('list rejects a non-privileged token with 403', async () => {
    const plain = mintToken('plain', 'u-plain');
    const res = await api('GET', '/admin/approvals', { cred: plain });
    expect(res.status).toBe(403);
  });

  it('lists pending approvals for the admin after a request is seeded', async () => {
    seedInitRequestFrom('u-list', 'list-proj');

    const res = await api('GET', '/admin/approvals', { cred: MASTER });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect(res.json).toHaveLength(1);
    expect(res.json[0].status).toBe('pending');
    expect(res.json[0].kind).toBe('project:init');
    expect(res.json[0].projectId).toBe('list-proj');
  });

  it('rejects an unsupported status filter with 400 (only pending is listable this phase)', async () => {
    const res = await api('GET', '/admin/approvals?status=approved', { cred: MASTER });
    expect(res.status).toBe(400);
    expect(String(res.json.error)).toMatch(/only pending/i);
  });

  it('accepts an explicit status=pending and passes the project filter through', async () => {
    seedInitRequestFrom('u-a', 'proj-one');
    seedInitRequestFrom('u-b', 'proj-two');

    const all = await api('GET', '/admin/approvals?status=pending', { cred: MASTER });
    expect(all.status).toBe(200);
    expect(all.json).toHaveLength(2);

    const filtered = await api('GET', '/admin/approvals?project=proj-one', { cred: MASTER });
    expect(filtered.status).toBe(200);
    expect(filtered.json.map((r: { projectId: string }) => r.projectId)).toEqual(['proj-one']);
  });

  // ── decideApproval: POST /admin/approvals/{id}/decision ──────────────────────

  it('approving AUTO-EXECUTES: the response is the completed request with the caller-derived decidedBy, and the project exists on disk', async () => {
    const id = seedInitRequestFrom('u-dec', 'dec-proj');

    const res = await api('POST', `/admin/approvals/${id}/decision`, { cred: MASTER, body: { approved: true } });
    expect(res.status).toBe(200);
    // Approved = done: the decision auto-executed and marked the request completed.
    expect(res.json.status).toBe('completed');
    // The admin plane credential is the bootstrap admin, so decidedBy is derived
    // from the authenticated caller — never the (absent) client-supplied value.
    expect(res.json.decidedBy.userId).toBe('bootstrap');
    expect(res.json.decidedAt).toBeTruthy();

    // Really provisioned on disk by the auto-execution.
    const root = existingProjectRoot(dataDir, 'dec-proj');
    expect(root).toBeTruthy();
    expect(fs.existsSync(path.join(root!, '.wai', 'project.yaml'))).toBe(true);
  });

  it('denies a pending request with a reason (nothing executes)', async () => {
    const id = seedInitRequestFrom('u-deny', 'deny-proj');

    const res = await api('POST', `/admin/approvals/${id}/decision`, {
      cred: MASTER,
      body: { approved: false, reason: 'not now' },
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('denied');
    expect(res.json.decisionReason).toBe('not now');
    expect(existingProjectRoot(dataDir, 'deny-proj')).toBeNull();
  });

  it('rejects self-approval with 403 (the decider is the original requester)', async () => {
    const unit = seedUnit('self-unit');
    const selfTok = mintToken('self-tok', 'u-self');
    allow('u-self', 'project:create', 'unit', unit.id, 'approval');
    allow('u-self', 'approval:decide', 'instance', undefined, 'yes');
    const outcome = initializeProject(cfg, selfTok, { id: 'self-proj', ownerUnitId: unit.id });

    const res = await api('POST', `/admin/approvals/${outcome.approval!.id}/decision`, {
      cred: selfTok,
      body: { approved: true },
    });
    expect(res.status).toBe(403);
  });

  it('rejects a decision with a non-boolean approved as 400', async () => {
    const id = seedInitRequestFrom('u-bad', 'bad-proj');
    const res = await api('POST', `/admin/approvals/${id}/decision`, { cred: MASTER, body: { reason: 'no approved field' } });
    expect(res.status).toBe(400);
  });

  // ── executeApproval: POST /admin/approvals/{id}/execute (manual retry) ───────

  it('executes an APPROVED-but-not-completed request (the retry path behind auto-execution)', async () => {
    // Seed an approved-but-unexecuted request directly — the state a failed
    // auto-execution leaves behind.
    const unit = seedUnit('manual-unit');
    const approved: ApprovalRequest = {
      id: 'man-1',
      kind: 'project:init',
      status: 'approved',
      requestedBy: subject({ userId: 'u-man' }),
      projectId: 'exec-proj',
      summary: 'Initialize project exec-proj',
      payloadType: 'ProjectInitRequest',
      payload: JSON.stringify({ id: 'exec-proj', ownerUnitId: unit.id }),
      createdAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      decidedBy: subject({ userId: 'bootstrap' }),
    };
    fs.writeFileSync(path.join(dataDir, 'approvals.json'), JSON.stringify([approved]));

    const res = await api('POST', '/admin/approvals/man-1/execute', { cred: MASTER });
    expect(res.status).toBe(200);
    expect(String(res.json.outcome)).toContain('Initialized project "exec-proj"');

    // Really provisioned on disk.
    const root = existingProjectRoot(dataDir, 'exec-proj');
    expect(root).toBeTruthy();
    expect(fs.existsSync(path.join(root!, '.wai', 'project.yaml'))).toBe(true);
  });

  it('returns 404 when executing an unknown approval id', async () => {
    const res = await api('POST', '/admin/approvals/does-not-exist/execute', { cred: MASTER });
    expect(res.status).toBe(404);
  });
});
