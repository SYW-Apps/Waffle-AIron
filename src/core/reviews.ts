import * as crypto from 'crypto';
import { computeOwnDesignStateId } from './statehash.js';
import { approvalRecord, approvalVerdict } from './approval.js';
import { localApprover } from './approver.js';
import { ReviewStore } from './review-store.js';

// ---------------------------------------------------------------------------
// Reviews (sdd_core): the review handshake between an agent and the human.
//
// An agent requests a review or a lock against the design as it stands; the
// human decides it (in the dev page) or simply locks (anywhere); every read
// brings a pending request up to date, so a lock made in the terminal answers it
// and a design changed since supersedes it. The agent only ever asks: nothing
// here locks.
// ---------------------------------------------------------------------------

/** Where an agent's review request stands. */
export type ReviewStatus = 'pending' | 'locked' | 'approved' | 'changes_requested' | 'superseded' | 'withdrawn';

/** A reviewer's note pinned to one spec. */
export interface ReviewNote {
  specId: string;
  note: string;
}

/** How the human answered a review request. */
export interface ReviewDecision {
  comment?: string;
  notes: ReviewNote[];
  decidedAt: string;
  decidedBy: string;
}

/** An agent's request that the human review the design, or approve it with a lock. */
export interface ReviewRequest {
  id: string;
  kind: string;
  subsystem?: string;
  note: string;
  designId: string;
  requestedAt: string;
  status: ReviewStatus;
  decision?: ReviewDecision;
}

/** What an agent gets back when it asks for a review: the request, and where the human will see it. */
export interface ReviewReceipt {
  request: ReviewRequest;
  shownAt?: string;
}

function designIdOf(): string {
  const id = computeOwnDesignStateId();
  return `${id.algorithm}:${id.digest}`;
}

export class ReviewOrchestrator {
  constructor(private readonly store: ReviewStore = new ReviewStore()) {}

  /** Record a review request against the design as it stands. */
  request(kind: string, note: string, subsystem?: string): ReviewReceipt {
    if ((kind !== 'review' && kind !== 'lock') || (kind === 'review' && subsystem)) {
      throw new Error('invalid review request: the kind is `review` or `lock`, and only a lock request names a subsystem');
    }
    const request: ReviewRequest = {
      id: crypto.randomUUID().slice(0, 8),
      kind,
      ...(subsystem ? { subsystem } : {}),
      note,
      designId: designIdOf(),
      requestedAt: new Date().toISOString(),
      status: 'pending',
    };
    this.store.save(request);
    const shownAt = this.store.devServer();
    return shownAt ? { request, shownAt } : { request };
  }

  /** One request, brought up to date. */
  status(id: string): ReviewRequest {
    const request = this.store.load(id);
    if (!request) throw new Error(`unknown review request: ${id}`);
    if (request.status !== 'pending') return request;
    const same = designIdOf() === request.designId;
    const record = approvalRecord();
    if (request.kind === 'lock' && same && record !== null && !approvalVerdict().drifted) {
      request.status = 'locked';
      request.decision = {
        notes: [],
        decidedAt: record.lockedAt ?? new Date().toISOString(),
        decidedBy: record.lockedBy?.id ?? 'unknown',
      };
      this.store.save(request);
      return request;
    }
    if (!same) {
      request.status = 'superseded';
      this.store.save(request);
    }
    return request;
  }

  /** The requests still pending after being brought up to date, newest first. */
  pending(): ReviewRequest[] {
    return this.store.list()
      .map((r) => (r.status === 'pending' ? this.status(r.id) : r))
      .filter((r) => r.status === 'pending');
  }

  /** The human's answer to a pending request. */
  decide(id: string, outcome: ReviewStatus, comment?: string, notes?: ReviewNote[]): ReviewRequest {
    const request = this.status(id);
    // A lock request the lock already answered takes `locked` once more, so the
    // page's lock adds the human's comment and notes to it.
    const lockAnswered = request.kind === 'lock' && request.status === 'locked' && outcome === 'locked';
    if (request.status !== 'pending' && !lockAnswered) {
      throw new Error(`the request cannot take this decision: it is ${request.status}`);
    }
    const takes = request.kind === 'lock' ? ['locked', 'changes_requested'] : ['approved', 'changes_requested'];
    if (!takes.includes(outcome)) {
      throw new Error(`the request cannot take this decision: a ${request.kind} request takes ${takes.join(' or ')}`);
    }
    const who = localApprover();
    request.status = outcome;
    request.decision = {
      ...(comment ? { comment } : {}),
      notes: notes ?? [],
      // A request the lock already answered keeps the lock's approver and time.
      decidedAt: lockAnswered && request.decision ? request.decision.decidedAt : new Date().toISOString(),
      decidedBy: lockAnswered && request.decision ? request.decision.decidedBy : who.id,
    };
    this.store.save(request);
    return request;
  }

  /** The requester takes a pending request back. */
  withdraw(id: string): ReviewRequest {
    const request = this.status(id);
    if (request.status !== 'pending') throw new Error(`the request is no longer pending: it is ${request.status}`);
    request.status = 'withdrawn';
    this.store.save(request);
    return request;
  }

  /** Record where a starting dev server serves this project. */
  announceDevServer(url: string, pid: number): void {
    this.store.announceDevServer(url, pid);
  }

  /** Remove a stopping dev server's announcement. */
  withdrawDevServer(pid: number): void {
    this.store.withdrawDevServer(pid);
  }
}


// approval_portal: the review handshake, forwarded to the review orchestrator.
export const requestReview = (kind: string, note: string, subsystem?: string): ReviewReceipt => new ReviewOrchestrator().request(kind, note, subsystem);
export const reviewStatus = (id: string): ReviewRequest => new ReviewOrchestrator().status(id);
export const pendingReviews = (): ReviewRequest[] => new ReviewOrchestrator().pending();
export const decideReview = (id: string, outcome: ReviewStatus, comment?: string, notes?: ReviewNote[]): ReviewRequest => new ReviewOrchestrator().decide(id, outcome, comment, notes);
export const withdrawReview = (id: string): ReviewRequest => new ReviewOrchestrator().withdraw(id);
export const announceDevServer = (url: string, pid: number): void => new ReviewOrchestrator().announceDevServer(url, pid);
export const withdrawDevServer = (pid: number): void => new ReviewOrchestrator().withdrawDevServer(pid);
