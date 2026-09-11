import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createApprovalRequest,
  decideApprovalRequest,
  getApprovalRequestById,
  listApprovalRequests,
  markApprovalCompleted,
  expirePendingApprovals,
} from '../../src/server/approvals.js';
import type { ApprovalRequest, ApprovalDecision, PrincipalSubject } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Approval Repository (sdd_host) — the store/registry/index triad exercised
// through the repository facade against a real <dataDir>/approvals.json, so
// persistence, the pending-and-unexpired state invariants, decision stamping,
// atomic write-temp-then-rename, and the malformed-file storage error are
// covered end-to-end.
// ---------------------------------------------------------------------------

const REQUESTER: PrincipalSubject = { userId: 'u-req', kind: 'human', issuer: 'local' };
const DECIDER: PrincipalSubject = { userId: 'u-adm', kind: 'human', issuer: 'local' };

function mkReq(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'placeholder', // server stamps its own random id on create
    kind: 'project:lock',
    status: 'placeholder', // server forces 'pending' on create
    requestedBy: REQUESTER,
    summary: 'Lock project acme',
    createdAt: '1999-01-01T00:00:00.000Z', // placeholder; the registry stamps its own
    ...over,
  };
}

function mkDecision(over: Partial<ApprovalDecision> = {}): ApprovalDecision {
  return {
    requestId: 'r-1',
    approved: true,
    decidedBy: DECIDER,
    decidedAt: '2026-07-09T12:00:00.000Z',
    ...over,
  };
}

describe('approval repository (sdd_host)', () => {
  let dataDir: string;
  let approvalsPath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-approvals-'));
    approvalsPath = path.join(dataDir, 'approvals.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Seed the store file directly with a controlled record set (compact JSON, no
   *  trailing newline) so tests can pin createdAt/status. A subsequent facade
   *  call re-reads it; and because the registry always persists pretty-printed +
   *  newline, a byte-identical file afterwards proves no rewrite occurred. */
  function seed(records: ApprovalRequest[]): string {
    const compact = JSON.stringify(records);
    fs.writeFileSync(approvalsPath, compact);
    return compact;
  }

  // ── create ────────────────────────────────────────────────────────────────

  it('create stamps a random id, a fresh createdAt, and pending status, and persists', () => {
    const stored = createApprovalRequest(dataDir, mkReq({ status: 'approved', summary: 'do thing' }));

    expect(stored.id).toMatch(/[0-9a-f-]{36}/);
    expect(stored.id).not.toBe('placeholder');
    expect(stored.status).toBe('pending'); // caller-supplied 'approved' is overridden
    expect(stored.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(stored.createdAt)).not.toBeNaN();
    expect(stored.summary).toBe('do thing'); // redacted summary preserved

    // Re-read from disk proves durability.
    const reloaded = getApprovalRequestById(dataDir, stored.id);
    expect(reloaded).toEqual(stored);
    const raw = fs.readFileSync(approvalsPath, 'utf8');
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it('create rejects a payload that looks like a raw bearer token and persists nothing', () => {
    expect(() =>
      createApprovalRequest(dataDir, mkReq({ payload: 'Authorization: Bearer sk-abc123' })),
    ).toThrow(/rejected/i);
    expect(fs.existsSync(approvalsPath)).toBe(false);
  });

  // ── decide ────────────────────────────────────────────────────────────────

  it('decide approves a pending request, stamping decidedBy/decidedAt and status approved', () => {
    const created = createApprovalRequest(dataDir, mkReq());
    const decided = decideApprovalRequest(
      dataDir,
      mkDecision({ requestId: created.id, approved: true, reason: 'looks good', decidedAt: '2026-07-09T12:34:56.000Z' }),
    );

    expect(decided.status).toBe('approved');
    expect(decided.decidedBy).toEqual(DECIDER);
    expect(decided.decidedAt).toBe('2026-07-09T12:34:56.000Z');
    expect(decided.decisionReason).toBe('looks good');
    expect(getApprovalRequestById(dataDir, created.id)?.status).toBe('approved');
  });

  it('decide denies a pending request, stamping the denial and reason', () => {
    const created = createApprovalRequest(dataDir, mkReq());
    const decided = decideApprovalRequest(
      dataDir,
      mkDecision({ requestId: created.id, approved: false, reason: 'not allowed' }),
    );

    expect(decided.status).toBe('denied');
    expect(decided.decidedBy).toEqual(DECIDER);
    expect(decided.decisionReason).toBe('not allowed');
  });

  it('decide on an unknown requestId fails with a not-found error', () => {
    expect(() => decideApprovalRequest(dataDir, mkDecision({ requestId: 'nope' }))).toThrow(/not found/i);
  });

  it('decide on a non-pending request is rejected', () => {
    const created = createApprovalRequest(dataDir, mkReq());
    decideApprovalRequest(dataDir, mkDecision({ requestId: created.id, approved: true }));
    // A second decision on the now-approved request must be rejected.
    expect(() =>
      decideApprovalRequest(dataDir, mkDecision({ requestId: created.id, approved: false })),
    ).toThrow(/not pending/i);
  });

  it('decide on a past-expiry request flips it to expired and rejects the decision', () => {
    // Pending but already past its expiresAt at decision time.
    const created = createApprovalRequest(dataDir, mkReq({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    expect(created.status).toBe('pending');

    expect(() =>
      decideApprovalRequest(
        dataDir,
        mkDecision({ requestId: created.id, decidedAt: '2026-07-09T12:00:00.000Z' }),
      ),
    ).toThrow(/expired/i);

    // The rejection persisted the expired status.
    const after = getApprovalRequestById(dataDir, created.id);
    expect(after?.status).toBe('expired');
    expect(after?.decidedBy).toBeUndefined();
  });

  // ── markCompleted ───────────────────────────────────────────────────────

  it('markCompleted transitions an approved request to completed', () => {
    const created = createApprovalRequest(dataDir, mkReq());
    decideApprovalRequest(dataDir, mkDecision({ requestId: created.id, approved: true }));

    const completed = markApprovalCompleted(dataDir, created.id);
    expect(completed.status).toBe('completed');
    expect(getApprovalRequestById(dataDir, created.id)?.status).toBe('completed');
  });

  it('markCompleted is rejected from a pending status', () => {
    const created = createApprovalRequest(dataDir, mkReq());
    expect(() => markApprovalCompleted(dataDir, created.id)).toThrow(/not approved/i);
  });

  it('markCompleted is rejected from a denied status', () => {
    const created = createApprovalRequest(dataDir, mkReq());
    decideApprovalRequest(dataDir, mkDecision({ requestId: created.id, approved: false }));
    expect(() => markApprovalCompleted(dataDir, created.id)).toThrow(/not approved/i);
  });

  it('markCompleted on an unknown id fails with a not-found error', () => {
    expect(() => markApprovalCompleted(dataDir, 'nope')).toThrow(/not found/i);
  });

  // ── expirePending ───────────────────────────────────────────────────────

  it('expirePending flips only overdue pending requests and returns the count', () => {
    const now = '2026-07-09T00:00:00.000Z';
    seed([
      mkReq({ id: 'r-overdue', status: 'pending', expiresAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' }),
      mkReq({ id: 'r-future', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }),
      mkReq({ id: 'r-nostamp', status: 'pending', createdAt: '2026-01-01T00:00:00.000Z' }), // no expiresAt -> never expires
      mkReq({ id: 'r-approved', status: 'approved', expiresAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z' }), // not pending
    ]);

    const count = expirePendingApprovals(dataDir, now);
    expect(count).toBe(1);

    expect(getApprovalRequestById(dataDir, 'r-overdue')?.status).toBe('expired');
    expect(getApprovalRequestById(dataDir, 'r-future')?.status).toBe('pending');
    expect(getApprovalRequestById(dataDir, 'r-nostamp')?.status).toBe('pending');
    expect(getApprovalRequestById(dataDir, 'r-approved')?.status).toBe('approved');
  });

  it('expirePending is a no-op returning 0 that does not rewrite the file when nothing is overdue', () => {
    const compact = seed([
      mkReq({ id: 'r-future', status: 'pending', expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);

    const count = expirePendingApprovals(dataDir, '2026-07-09T00:00:00.000Z');
    expect(count).toBe(0);

    // A rewrite would pretty-print + append a newline; byte-identical proves no write.
    expect(fs.readFileSync(approvalsPath, 'utf8')).toBe(compact);
  });

  // ── getById ────────────────────────────────────────────────────────────────

  it('getById returns null for a miss and the record for a hit', () => {
    expect(getApprovalRequestById(dataDir, 'r-1')).toBeNull();
    const created = createApprovalRequest(dataDir, mkReq());
    expect(getApprovalRequestById(dataDir, created.id)?.id).toBe(created.id);
  });

  // ── list filters ────────────────────────────────────────────────────────

  function seedForList(): void {
    // Distinct createdAt values, seeded out of order, to assert newest-first.
    seed([
      mkReq({ id: 'r-a', status: 'pending', projectId: 'p1', kind: 'project:lock', requestedBy: { userId: 'u-1', kind: 'human', issuer: 'local' }, createdAt: '2026-07-01T00:00:00.000Z' }),
      mkReq({ id: 'r-b', status: 'approved', projectId: 'p1', kind: 'project:init', requestedBy: { userId: 'u-2', kind: 'human', issuer: 'local' }, createdAt: '2026-07-03T00:00:00.000Z' }),
      mkReq({ id: 'r-c', status: 'pending', projectId: 'p2', kind: 'project:lock', requestedBy: { userId: 'u-1', kind: 'human', issuer: 'local' }, createdAt: '2026-07-05T00:00:00.000Z' }),
      mkReq({ id: 'r-d', status: 'denied', projectId: 'p2', kind: 'project:init', requestedBy: { userId: 'u-3', kind: 'human', issuer: 'local' }, createdAt: '2026-07-02T00:00:00.000Z' }),
    ]);
  }

  it('lists all requests newest-first by createdAt when unfiltered', () => {
    seedForList();
    expect(listApprovalRequests(dataDir).map((r) => r.id)).toEqual(['r-c', 'r-b', 'r-d', 'r-a']);
  });

  it('filters by status (newest-first)', () => {
    seedForList();
    expect(listApprovalRequests(dataDir, 'pending').map((r) => r.id)).toEqual(['r-c', 'r-a']);
  });

  it('filters by projectId', () => {
    seedForList();
    expect(listApprovalRequests(dataDir, undefined, 'p1').map((r) => r.id)).toEqual(['r-b', 'r-a']);
  });

  it('filters by requestedByUserId (matched against requestedBy.userId)', () => {
    seedForList();
    expect(listApprovalRequests(dataDir, undefined, undefined, 'u-1').map((r) => r.id)).toEqual(['r-c', 'r-a']);
  });

  it('filters by action kind', () => {
    seedForList();
    expect(listApprovalRequests(dataDir, undefined, undefined, undefined, 'project:lock').map((r) => r.id)).toEqual(['r-c', 'r-a']);
  });

  it('combines filters (status + project + requester + kind)', () => {
    seedForList();
    // pending AND p2 AND u-1 AND project:lock -> only r-c.
    expect(listApprovalRequests(dataDir, 'pending', 'p2', 'u-1', 'project:lock').map((r) => r.id)).toEqual(['r-c']);
    // pending AND p1 -> only r-a (r-b is approved).
    expect(listApprovalRequests(dataDir, 'pending', 'p1').map((r) => r.id)).toEqual(['r-a']);
  });

  // ── store integrity ───────────────────────────────────────────────────────

  it('missing store file reads as an empty set', () => {
    expect(listApprovalRequests(dataDir)).toEqual([]);
    expect(getApprovalRequestById(dataDir, 'anything')).toBeNull();
    expect(expirePendingApprovals(dataDir, '2026-07-09T00:00:00.000Z')).toBe(0);
  });

  it('malformed store JSON fails with a storage error naming the path', () => {
    fs.writeFileSync(approvalsPath, '{ this is not valid json');
    expect(() => listApprovalRequests(dataDir)).toThrow(approvalsPath);
    expect(() => listApprovalRequests(dataDir)).toThrow(/malformed/i);
  });

  it('a structurally invalid (non-array) store fails with a storage error naming the path', () => {
    fs.writeFileSync(approvalsPath, JSON.stringify({ not: 'an array' }));
    expect(() => getApprovalRequestById(dataDir, 'r-1')).toThrow(approvalsPath);
  });
});
