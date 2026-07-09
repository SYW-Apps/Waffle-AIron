import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  requestProjectInitialization,
  requestProjectLock,
  requestProjectPromotion,
  getRequestStatus,
  listPendingRequests,
  decideRequest,
  executeApprovedRequest,
} from '../../src/server/selfservice.js';
import { createProject } from '../../src/server/admin.js';
import { UnauthenticatedError, ForbiddenError } from '../../src/server/identity.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { createProjectRecord, existingProjectRoot } from '../../src/server/projects.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import type {
  ApiKeyRecord,
  ApprovalRequest,
  HostConfig,
  PrincipalSubject,
  ProjectGrant,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Self-Service Orchestrator (sdd_host) — exercised through the exported
// orchestrator functions against a real <dataDir> with real minted credentials,
// mirroring identity.test.ts. Covers authentication (401), grant-based
// authorization (403), the request/inspect/decide/execute approval workflows,
// self-approval rejection with server-derived decidedBy, lazy expiry, best-effort
// audit appends, and end-to-end execution that actually provisions on disk. Also
// smoke-guards the admin.ts gated-variant refactor.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

describe('self-service orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let approvalsPath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-selfservice-'));
    fs.mkdirSync(dataDir, { recursive: true });
    approvalsPath = path.join(dataDir, 'approvals.json');
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Mint a stored token with a KNOWN id, given grants, and optional owner subject;
   *  returns the plaintext. A known id + subject make requestedBy/requestedTokenId
   *  and caller-derived decidedBy assertions deterministic. */
  function mintToken(opts: { id: string; grants: ProjectGrant[]; subject?: PrincipalSubject }): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id: opts.id,
      keyHash: hashToken(token),
      role: 'editor',
      projects: opts.grants.map((g) => g.projectId),
      grants: opts.grants,
      createdAt: new Date().toISOString(),
      ...(opts.subject ? { ownerSubject: opts.subject } : {}),
    };
    createCredential(dataDir, record);
    return token;
  }

  /** A token that may request project actions on `project` (mcp:write). */
  function requesterToken(id: string, project: string, userId: string): string {
    return mintToken({ id, grants: [{ projectId: project, permissions: ['mcp:write'] }], subject: subject({ userId }) });
  }

  /** A token that may decide approvals instance-wide (approval:decide). */
  function deciderToken(id: string, userId: string): string {
    return mintToken({ id, grants: [{ projectId: '*', permissions: ['approval:decide'] }], subject: subject({ userId }) });
  }

  function seedApprovals(records: ApprovalRequest[]): void {
    fs.writeFileSync(approvalsPath, JSON.stringify(records));
  }

  // ── requestProjectInitialization ────────────────────────────────────────────

  it('init request: creates a pending project:init with a redacted summary, default 7-day expiry, and an info audit event', () => {
    const requester = mintToken({ id: 'hp', grants: [], subject: subject({ userId: 'u-hp' }) });
    const before = Date.now();

    const req = requestProjectInitialization(cfg, requester, { id: 'alpha', displayName: 'Alpha Project' });

    expect(req.status).toBe('pending');
    expect(req.kind).toBe('project:init');
    expect(req.summary).toBe('Initialize project alpha (Alpha Project)');
    expect(req.payloadType).toBe('ProjectInitRequest');
    expect(JSON.parse(req.payload!).id).toBe('alpha');
    expect(req.projectId).toBe('alpha');
    expect(req.requestedBy.userId).toBe('u-hp');
    expect(req.requestedTokenId).toBe('hp');

    const ttl = Date.parse(req.expiresAt!) - before;
    expect(ttl).toBeGreaterThan(SEVEN_DAYS_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(SEVEN_DAYS_MS + 60_000);

    const ev = queryAuditEvents(dataDir, { action: 'approval.request.created' });
    expect(ev).toHaveLength(1);
    expect(ev[0].level).toBe('info');
    expect(ev[0].target).toBe(req.id);

    // The project itself is NOT created by a request.
    expect(existingProjectRoot(dataDir, 'alpha')).toBeNull();
  });

  it('init request: rejects an id that already exists as a project', () => {
    createProjectRecord(dataDir, 'dup');
    const requester = mintToken({ id: 'd', grants: [], subject: subject() });
    expect(() => requestProjectInitialization(cfg, requester, { id: 'dup' })).toThrow(/already exists/i);
  });

  it('init request: rejects a structurally invalid project id', () => {
    const requester = mintToken({ id: 'iv', grants: [], subject: subject() });
    expect(() => requestProjectInitialization(cfg, requester, { id: 'Bad Id!' })).toThrow(/invalid project id/i);
  });

  // ── requestProjectLock / requestProjectPromotion authorization ──────────────

  it('lock/promote request: requires a grant covering the project (403 without mcp:write)', () => {
    createProjectRecord(dataDir, 'proj-a');
    const reader = mintToken({ id: 'ro', grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }], subject: subject() });

    expect(() => requestProjectLock(cfg, reader, 'proj-a')).toThrow(ForbiddenError);
    expect(() => requestProjectPromotion(cfg, reader, 'proj-a')).toThrow(ForbiddenError);
  });

  it('lock/promote request: rejects an unknown project (after authorization passes)', () => {
    // MASTER is instance-admin, so authorization passes and the failure is existence.
    expect(() => requestProjectLock(cfg, MASTER, 'ghost')).toThrow(/unknown project/i);
    expect(() => requestProjectPromotion(cfg, MASTER, 'ghost')).toThrow(/unknown project/i);
  });

  it('lock request: happy path creates a pending project:lock carrying the project scope', () => {
    createProjectRecord(dataDir, 'proj-a');
    const requester = requesterToken('lr', 'proj-a', 'u-lr');

    const req = requestProjectLock(cfg, requester, 'proj-a');
    expect(req.status).toBe('pending');
    expect(req.kind).toBe('project:lock');
    expect(req.projectId).toBe('proj-a');
    expect(req.summary).toBe('Lock project proj-a');
    expect(queryAuditEvents(dataDir, { action: 'approval.request.created' })).toHaveLength(1);
  });

  // ── getRequestStatus visibility ─────────────────────────────────────────────

  it('getRequestStatus: visible to the original requester and to an admin, denied to an unrelated non-admin', () => {
    createProjectRecord(dataDir, 'proj-a');
    const requester = requesterToken('vr', 'proj-a', 'u-vr');
    const req = requestProjectLock(cfg, requester, 'proj-a');

    expect(getRequestStatus(cfg, requester, req.id).id).toBe(req.id); // own
    expect(getRequestStatus(cfg, MASTER, req.id).id).toBe(req.id); // admin sees all

    const stranger = mintToken({ id: 'vs', grants: [{ projectId: 'proj-b', permissions: ['mcp:write'] }], subject: subject({ userId: 'u-vs' }) });
    expect(() => getRequestStatus(cfg, stranger, req.id)).toThrow(ForbiddenError);
  });

  it('getRequestStatus: lazily expires an overdue pending request before returning it', () => {
    seedApprovals([
      {
        id: 'od-1',
        kind: 'project:lock',
        status: 'pending',
        requestedBy: subject({ userId: 'u-od' }),
        projectId: 'proj-a',
        summary: 'Lock project proj-a',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      },
    ]);
    const got = getRequestStatus(cfg, MASTER, 'od-1');
    expect(got.status).toBe('expired');
  });

  it('getRequestStatus: not-found for an unknown id', () => {
    expect(() => getRequestStatus(cfg, MASTER, 'nope')).toThrow(/not found/i);
  });

  // ── listPendingRequests ─────────────────────────────────────────────────────

  it('listPendingRequests: gated to approval:decide or admin, and filterable by project', () => {
    createProjectRecord(dataDir, 'p1');
    createProjectRecord(dataDir, 'p2');
    const requester = mintToken({ id: 'lpr', grants: [{ projectId: '*', permissions: ['mcp:write'] }], subject: subject({ userId: 'u-lpr' }) });
    requestProjectLock(cfg, requester, 'p1');
    requestProjectLock(cfg, requester, 'p2');

    // The requester holds mcp:write but not approval:decide → denied.
    expect(() => listPendingRequests(cfg, requester)).toThrow(ForbiddenError);

    // Admin lists all pending.
    expect(listPendingRequests(cfg, MASTER)).toHaveLength(2);
    // Project filter narrows.
    expect(listPendingRequests(cfg, MASTER, 'p1').map((r) => r.projectId)).toEqual(['p1']);

    // A decider grant is authorized.
    const decider = deciderToken('lpd', 'u-lpd');
    expect(listPendingRequests(cfg, decider)).toHaveLength(2);
  });

  // ── decideRequest ────────────────────────────────────────────────────────────

  it('decideRequest: derives decidedBy from the authenticated caller and ignores the client-supplied value', () => {
    createProjectRecord(dataDir, 'proj-a');
    const requester = requesterToken('req-tok', 'proj-a', 'u-req');
    const decider = deciderToken('dec-tok', 'u-dec');
    const req = requestProjectLock(cfg, requester, 'proj-a');

    const decided = decideRequest(cfg, decider, {
      requestId: req.id,
      approved: true,
      decidedBy: subject({ userId: 'IMPERSONATED' }), // must be ignored
      decidedAt: '2000-01-01T00:00:00.000Z', // must be re-stamped server-side
    });

    expect(decided.status).toBe('approved');
    expect(decided.decidedBy?.userId).toBe('u-dec'); // caller-derived, not 'IMPERSONATED'
    expect(Date.parse(decided.decidedAt!)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00.000Z'));
    expect(queryAuditEvents(dataDir, { action: 'approval.decided' })[0].level).toBe('security');
  });

  it('decideRequest: rejects self-approval even when the requester holds approval:decide', () => {
    createProjectRecord(dataDir, 'proj-a');
    const selfTok = mintToken({
      id: 'self-tok',
      grants: [
        { projectId: 'proj-a', permissions: ['mcp:write'] },
        { projectId: '*', permissions: ['approval:decide'] },
      ],
      subject: subject({ userId: 'u-self' }),
    });
    const req = requestProjectLock(cfg, selfTok, 'proj-a');

    expect(() =>
      decideRequest(cfg, selfTok, {
        requestId: req.id,
        approved: true,
        decidedBy: subject({ userId: 'u-self' }),
        decidedAt: new Date().toISOString(),
      }),
    ).toThrow(ForbiddenError);
  });

  it('decideRequest: denies a pending request (denied path), gated by approval:decide', () => {
    createProjectRecord(dataDir, 'proj-a');
    const requester = requesterToken('dr', 'proj-a', 'u-dr');
    const decider = deciderToken('dd', 'u-dd');
    const req = requestProjectLock(cfg, requester, 'proj-a');

    const denied = decideRequest(cfg, decider, {
      requestId: req.id,
      approved: false,
      reason: 'not now',
      decidedBy: subject(),
      decidedAt: new Date().toISOString(),
    });
    expect(denied.status).toBe('denied');
    expect(denied.decisionReason).toBe('not now');

    // A non-decider cannot decide at all.
    const plain = mintToken({ id: 'pl', grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }], subject: subject() });
    const req2 = requestProjectLock(cfg, requester, 'proj-a');
    expect(() =>
      decideRequest(cfg, plain, { requestId: req2.id, approved: true, decidedBy: subject(), decidedAt: new Date().toISOString() }),
    ).toThrow(ForbiddenError);
  });

  // ── executeApprovedRequest ───────────────────────────────────────────────────

  it('executeApprovedRequest: project:init runs end-to-end — the project exists on disk and the request completes; re-execution is rejected', () => {
    const requester = mintToken({ id: 'ir', grants: [], subject: subject({ userId: 'u-ir' }) });
    const decider = deciderToken('idc', 'u-idc');

    const pending = requestProjectInitialization(cfg, requester, { id: 'brand-new', displayName: 'Brand New' });
    decideRequest(cfg, decider, { requestId: pending.id, approved: true, decidedBy: subject(), decidedAt: new Date().toISOString() });

    const outcome = executeApprovedRequest(cfg, requester, pending.id);
    expect(outcome).toContain('Initialized project "brand-new"');

    // The project is really provisioned on disk.
    const root = existingProjectRoot(dataDir, 'brand-new');
    expect(root).toBeTruthy();
    expect(fs.existsSync(path.join(root!, '.wai', 'project.yaml'))).toBe(true);

    // Completed and audited.
    expect(getRequestStatus(cfg, MASTER, pending.id).status).toBe('completed');
    expect(queryAuditEvents(dataDir, { action: 'approval.executed' }).length).toBeGreaterThanOrEqual(1);

    // A completed request cannot be re-executed.
    expect(() => executeApprovedRequest(cfg, requester, pending.id)).toThrow(/not approved/i);
  });

  it('executeApprovedRequest: project:lock dispatches to the admin lock and locks the provisioned project', () => {
    createProject(cfg, MASTER, 'lock-proj'); // gated admin variant provisions the tree
    const requester = requesterToken('llr', 'lock-proj', 'u-llr');
    const decider = deciderToken('lld', 'u-lld');

    const req = requestProjectLock(cfg, requester, 'lock-proj');
    decideRequest(cfg, decider, { requestId: req.id, approved: true, decidedBy: subject(), decidedAt: new Date().toISOString() });

    const outcome = executeApprovedRequest(cfg, requester, req.id);
    expect(outcome).toContain('Locked project "lock-proj"');
    expect(outcome).toContain('ready');
    expect(getRequestStatus(cfg, MASTER, req.id).status).toBe('completed');
  });

  it('executeApprovedRequest: project:promote dispatches to the admin promote (not-locked on an unlocked project)', () => {
    createProject(cfg, MASTER, 'promo-proj');
    const requester = requesterToken('ppr', 'promo-proj', 'u-ppr');
    const decider = deciderToken('ppd', 'u-ppd');

    const req = requestProjectPromotion(cfg, requester, 'promo-proj');
    decideRequest(cfg, decider, { requestId: req.id, approved: true, decidedBy: subject(), decidedAt: new Date().toISOString() });

    const outcome = executeApprovedRequest(cfg, requester, req.id);
    expect(outcome).toContain('not-locked'); // reached executeApprovedPromote
  });

  it('executeApprovedRequest: rejects a request that is not approved', () => {
    createProjectRecord(dataDir, 'proj-a');
    const requester = requesterToken('nar', 'proj-a', 'u-nar');
    const req = requestProjectLock(cfg, requester, 'proj-a'); // still pending
    expect(() => executeApprovedRequest(cfg, MASTER, req.id)).toThrow(/not approved/i);
  });

  it('executeApprovedRequest: rejects an approved-but-expired request', () => {
    seedApprovals([
      {
        id: 'exp-1',
        kind: 'project:lock',
        status: 'approved',
        requestedBy: subject({ userId: 'u-e' }),
        projectId: 'proj-a',
        summary: 'Lock project proj-a',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      },
    ]);
    // Admin passes the requester/admin gate; the failure is expiry.
    expect(() => executeApprovedRequest(cfg, MASTER, 'exp-1')).toThrow(/expired/i);
  });

  it('executeApprovedRequest: denies a caller who is neither the original requester nor an admin', () => {
    createProjectRecord(dataDir, 'proj-a');
    const requester = requesterToken('or', 'proj-a', 'u-or');
    const decider = deciderToken('od', 'u-od2');
    const req = requestProjectLock(cfg, requester, 'proj-a');
    decideRequest(cfg, decider, { requestId: req.id, approved: true, decidedBy: subject(), decidedAt: new Date().toISOString() });

    const stranger = mintToken({ id: 'str', grants: [{ projectId: 'proj-a', permissions: ['mcp:read'] }], subject: subject({ userId: 'u-str' }) });
    expect(() => executeApprovedRequest(cfg, stranger, req.id)).toThrow(ForbiddenError);
  });

  // ── best-effort audit + authentication ───────────────────────────────────────

  it('does not fail the request when the audit append fails', () => {
    const requester = mintToken({ id: 'af', grants: [], subject: subject() });
    // Make the audit store unwritable/unreadable: a directory where the file goes.
    fs.mkdirSync(path.join(dataDir, 'audit-events.json'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const req = requestProjectInitialization(cfg, requester, { id: 'af-proj' });
    expect(req.status).toBe('pending'); // the approval was still created
    expect(errSpy).toHaveBeenCalled(); // failure recorded as a diagnostic
  });

  it('throws an unauthenticated error for a bogus token and for no credential', () => {
    expect(() => requestProjectInitialization(cfg, null, { id: 'x' })).toThrow(UnauthenticatedError);
    expect(() => listPendingRequests(cfg, 'not-a-real-token')).toThrow(UnauthenticatedError);
    expect(() => getRequestStatus(cfg, null, 'r')).toThrow(UnauthenticatedError);
  });

  // ── admin.ts refactor guard ───────────────────────────────────────────────────

  it('gated admin createProject still works after the refactor (and rejects a bad credential)', () => {
    const rec = createProject(cfg, MASTER, 'smoke-proj');
    expect(rec.id).toBe('smoke-proj');
    expect(existingProjectRoot(dataDir, 'smoke-proj')).toBeTruthy();
    expect(fs.existsSync(path.join(rec.rootPath, '.wai', 'project.yaml'))).toBe(true);

    expect(() => createProject(cfg, 'bad-credential', 'nope')).toThrow();
  });
});
