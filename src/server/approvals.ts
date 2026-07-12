import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ApprovalRequest, ApprovalDecision } from './types.js';

// ---------------------------------------------------------------------------
// Approval Repository (sdd_host)
//
// Durable, redacted hosted approval requests, file-backed at
// <dataDir>/approvals.json. Composition mirrors the spec tree:
//   - ApprovalStore    : authoritative in-memory holder of the request set,
//                        loaded from disk (missing file -> empty; corrupt ->
//                        storage error naming the path).
//   - ApprovalRegistry : the write path — create pending, record decisions,
//                        mark completed, expire overdue. Owns the
//                        pending-and-unexpired state invariants and the
//                        decidedBy/decidedAt/decisionReason stamping; performs
//                        NO authorization (the self-approval check is the
//                        orchestrator's job).
//   - ApprovalIndex    : the read path — by-id lookup and filtered,
//                        newest-first queries over the store's set; never mutates.
//   - facade           : the exported create/decide/getById/list/markCompleted/
//                        expirePending functions; pure 1:1 forwarding to the
//                        roles above (writes -> registry, reads -> index).
//
// An approval request is the record of a privileged action awaiting an
// authorized decision: the store never silently drops persisted requests
// (a lost pending request would silently deny a legitimate action or strand an
// approved one), and every write goes through write-temp-then-rename so a
// crashed write leaves the prior set fully intact.
// ---------------------------------------------------------------------------

// ── file helpers ───────────────────────────────────────────────────────────

function storePath(dataDir: string): string {
  return path.join(dataDir, 'approvals.json');
}

/**
 * Read the persisted approval-request set. A missing file yields an empty set
 * (first boot is not an error); an unreadable file or structurally invalid JSON
 * fails with a storage error naming the path — persisted approvals are never
 * silently discarded.
 */
function readRequests(dataDir: string): ApprovalRequest[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read approval store at ${p}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of approval requests');
    return parsed as ApprovalRequest[];
  } catch (e) {
    throw new Error(`Approval store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/** Persist the complete request set atomically (write temp, then rename). */
function persistRequests(dataDir: string, requests: ApprovalRequest[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(requests, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── redaction predicate ─────────────────────────────────────────────────────

/** Bearer-token prefix or a 32+ character hex run: the shapes a raw credential
 *  or secret leaks in as. Used to reject an un-redacted payload before it persists. */
const SECRET_RE = /Bearer\s+\S/i;
const LONG_HEX_RE = /[0-9a-fA-F]{32,}/;

function looksLikeSecret(value: string): boolean {
  return SECRET_RE.test(value) || LONG_HEX_RE.test(value);
}

// ── store: authoritative in-memory holder ──────────────────────────────────

class ApprovalStore {
  private requests: ApprovalRequest[] = [];
  constructor(private readonly dataDir: string) {}

  /** Load the persisted set into the authoritative in-memory representation. */
  load(): ApprovalRequest[] {
    this.requests = readRequests(this.dataDir);
    return this.requests;
  }

  /** Swap the in-memory set to a complete replacement in one assignment. Only
   *  called by the registry after durable persistence has succeeded, so index
   *  reads always observe a consistent set. */
  replaceAll(requests: ApprovalRequest[]): void {
    this.requests = requests;
  }

  /** The current authoritative set (shared by reference with the index). */
  all(): ApprovalRequest[] {
    return this.requests;
  }
}

// ── registry: write path ────────────────────────────────────────────────────

class ApprovalRegistry {
  constructor(private readonly dataDir: string, private readonly store: ApprovalStore) {}

  /**
   * Stamp the new request's id (random), createdAt, and status pending —
   * preserving the caller-supplied redacted summary and payload, and rejecting a
   * payload that smells like a raw secret or bearer token — then append it via
   * write-temp-then-rename and refresh the store. Persistence failures leave the
   * previous set intact and surface as storage errors.
   */
  create(request: ApprovalRequest): ApprovalRequest {
    if (request.payload !== undefined && looksLikeSecret(request.payload)) {
      throw new Error(
        `Approval request "${request.kind}" rejected: payload contains what looks like a raw ` +
          `credential or bearer token; redact secrets before requesting approval.`,
      );
    }
    const stored: ApprovalRequest = {
      ...request,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    const next = [...this.store.all(), stored];
    persistRequests(this.dataDir, next);
    this.store.replaceAll(next);
    return stored;
  }

  /**
   * Locate the request by the decision's requestId (not-found error when absent)
   * and reject any request that is not currently pending or whose expiresAt has
   * already passed — a past-expiry pending request is flipped to expired and
   * rejected rather than decided. Otherwise stamp decidedBy, decidedAt, and
   * decisionReason and set status approved or denied, persist, then refresh the
   * store. Authorization — including the self-approval check — is the
   * orchestrator's job, not here.
   */
  decide(decision: ApprovalDecision): ApprovalRequest {
    const requests = this.store.all();
    const idx = requests.findIndex((r) => r.id === decision.requestId);
    if (idx === -1) {
      throw new Error(`Approval request "${decision.requestId}" not found.`);
    }
    const current = requests[idx];
    if (current.status !== 'pending') {
      throw new Error(
        `Approval request "${current.id}" is ${current.status}, not pending; it cannot be decided.`,
      );
    }
    // Past-expiry: flip to expired and reject rather than deciding.
    if (
      current.expiresAt !== undefined &&
      Date.parse(current.expiresAt) <= Date.parse(decision.decidedAt)
    ) {
      const expired: ApprovalRequest = { ...current, status: 'expired' };
      const next = [...requests];
      next[idx] = expired;
      persistRequests(this.dataDir, next);
      this.store.replaceAll(next);
      throw new Error(
        `Approval request "${current.id}" expired at ${current.expiresAt} and can no longer be decided.`,
      );
    }
    const decided: ApprovalRequest = {
      ...current,
      status: decision.approved ? 'approved' : 'denied',
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      decisionReason: decision.reason,
    };
    const next = [...requests];
    next[idx] = decided;
    persistRequests(this.dataDir, next);
    this.store.replaceAll(next);
    return decided;
  }

  /**
   * Locate the request by id (not-found error when absent) and transition it to
   * completed only from an approved status (any other status is a validation
   * error), then persist and refresh the store.
   */
  markCompleted(id: string): ApprovalRequest {
    const requests = this.store.all();
    const idx = requests.findIndex((r) => r.id === id);
    if (idx === -1) {
      throw new Error(`Approval request "${id}" not found.`);
    }
    const current = requests[idx];
    if (current.status !== 'approved') {
      throw new Error(
        `Approval request "${id}" is ${current.status}, not approved; ` +
          `only an approved request can be completed.`,
      );
    }
    const completed: ApprovalRequest = { ...current, status: 'completed' };
    const next = [...requests];
    next[idx] = completed;
    persistRequests(this.dataDir, next);
    this.store.replaceAll(next);
    return completed;
  }

  /**
   * Flip every pending request whose expiresAt is at or before the supplied
   * now-timestamp to expired and return the count flipped. A set with no overdue
   * pending requests changes nothing, rewrites nothing, and returns zero.
   */
  expirePending(now: string): number {
    const nowMs = Date.parse(now);
    let changed = 0;
    const next = this.store.all().map((r) => {
      if (r.status === 'pending' && r.expiresAt !== undefined && Date.parse(r.expiresAt) <= nowMs) {
        changed++;
        return { ...r, status: 'expired' };
      }
      return r;
    });
    if (changed > 0) {
      persistRequests(this.dataDir, next);
      this.store.replaceAll(next);
    }
    return changed;
  }
}

// ── index: read path ────────────────────────────────────────────────────────

class ApprovalIndex {
  constructor(private readonly store: ApprovalStore) {}

  /** Return the store's request whose id matches exactly, or null when absent. */
  getById(id: string): ApprovalRequest | null {
    return this.store.all().find((r) => r.id === id) ?? null;
  }

  /**
   * Return the requests matching every populated filter — status, project id,
   * requester user id (matched against requestedBy.userId), and action kind —
   * sorted newest-first by createdAt. Unpopulated filters match everything.
   */
  list(
    status?: string,
    projectId?: string,
    requestedByUserId?: string,
    kind?: string,
  ): ApprovalRequest[] {
    let requests = this.store.all();
    if (status) requests = requests.filter((r) => r.status === status);
    if (projectId) requests = requests.filter((r) => r.projectId === projectId);
    if (requestedByUserId) {
      requests = requests.filter((r) => r.requestedBy?.userId === requestedByUserId);
    }
    if (kind) requests = requests.filter((r) => r.kind === kind);
    return [...requests].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}

// ── repository facade (1:1 forwarding) ──────────────────────────────────────
//
// Pure 1:1 forwarding. Each call materializes the authoritative set from disk
// (mirroring the rest of the server's read-fresh-per-call storage style), wires
// the store/registry/index over it, and forwards. Writes go to the registry,
// reads to the index.

/** Create a new pending approval request through the repository facade (atomic). */
export function createApprovalRequest(dataDir: string, request: ApprovalRequest): ApprovalRequest {
  const store = new ApprovalStore(dataDir);
  store.load();
  return new ApprovalRegistry(dataDir, store).create(request);
}

/** Record an approval or denial decision on a pending request (atomic). */
export function decideApprovalRequest(dataDir: string, decision: ApprovalDecision): ApprovalRequest {
  const store = new ApprovalStore(dataDir);
  store.load();
  return new ApprovalRegistry(dataDir, store).decide(decision);
}

/** Return one approval request by id, or null when absent. */
export function getApprovalRequestById(dataDir: string, id: string): ApprovalRequest | null {
  const store = new ApprovalStore(dataDir);
  store.load();
  return new ApprovalIndex(store).getById(id);
}

/** List approval requests filtered by status, project, requester, or action kind. */
export function listApprovalRequests(
  dataDir: string,
  status?: string,
  projectId?: string,
  requestedByUserId?: string,
  kind?: string,
): ApprovalRequest[] {
  const store = new ApprovalStore(dataDir);
  store.load();
  return new ApprovalIndex(store).list(status, projectId, requestedByUserId, kind);
}

/** Mark an approved request completed after its privileged workflow ran (atomic). */
export function markApprovalCompleted(dataDir: string, id: string): ApprovalRequest {
  const store = new ApprovalStore(dataDir);
  store.load();
  return new ApprovalRegistry(dataDir, store).markCompleted(id);
}

/** Expire pending requests at or past their expiresAt; returns the count expired (atomic). */
export function expirePendingApprovals(dataDir: string, now: string): number {
  const store = new ApprovalStore(dataDir);
  store.load();
  return new ApprovalRegistry(dataDir, store).expirePending(now);
}
