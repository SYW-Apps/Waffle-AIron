import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, updateSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import { captureApprovedSpecs } from '../../src/core/approval.js';
import { writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/validation.js';
import * as portal from '../../src/core/index.js';
import { ReviewStore } from '../../src/core/review-store.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The review handshake: requests live under .wai/.local/ (git-ignored), carry
// the design identity they were made against, and are brought up to date on
// every read — a lock that covers the design answers a lock request, a design
// that changed supersedes it.
// ---------------------------------------------------------------------------

const now = '2026-09-11T10:00:00Z';

function project(): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reviews-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'rev-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'rev-sys', vision: 'a review fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'rev-sys',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component', subsystem: 'dom',
    componentType: 'Orchestrator', dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  invalidateSpecCache();
  return root;
}

function lock(): void {
  const record: LockRecord = {
    stateId: computeGateStateId(),
    lockedAt: '2026-09-12T08:00:00Z',
    lockedBy: { id: 'locker <l@example.com>', source: 'git' },
    validatorVersion: 'test',
    validationResult: { valid: true, errors: 0, warnings: 0 },
    status: 'ready',
    specs: captureApprovedSpecs(),
    specsReading: 'design',
    format: 3,
    children: {},
  };
  writeLockRecord(record);
}

function changeDesign(): void {
  updateSpec('component', 'worker', { description: 'a worker component, changed' });
  invalidateSpecCache();
}

describe('reviews', () => {
  let root: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows keeps handles a moment */ }
  });

  it('records a pending request under .wai/.local/reviews and keeps .local/ out of git', () => {
    root = project();
    const receipt = portal.requestReview('review', 'please look');
    expect(receipt.shownAt).toBeUndefined();
    expect(receipt.request.status).toBe('pending');
    expect(receipt.request.designId).toMatch(/^sha256-design/);
    expect(fs.existsSync(path.join(root, '.wai', '.local', 'reviews', `${receipt.request.id}.yaml`))).toBe(true);
    const ignore = fs.readFileSync(path.join(root, '.wai', '.gitignore'), 'utf8');
    expect(ignore.split(/\r?\n/)).toContain('.local/');
  });

  it('keeps the other lines of an existing .wai/.gitignore and adds the line once', () => {
    root = project();
    fs.writeFileSync(path.join(root, '.wai', '.gitignore'), '.spec-write.lock*');
    portal.requestReview('review', 'a');
    portal.requestReview('review', 'b');
    const lines = fs.readFileSync(path.join(root, '.wai', '.gitignore'), 'utf8').split(/\r?\n/).filter(Boolean);
    expect(lines).toEqual(['.spec-write.lock*', '.local/']);
  });

  it('refuses an unknown kind, and a subsystem on a review request', () => {
    root = project();
    expect(() => portal.requestReview('approve', 'x')).toThrow(/invalid review request/);
    expect(() => portal.requestReview('review', 'x', 'dom')).toThrow(/invalid review request/);
    expect(portal.requestReview('lock', 'x', 'dom').request.subsystem).toBe('dom');
  });

  it('lists pending requests newest first, and an unknown id throws', () => {
    root = project();
    const a = portal.requestReview('review', 'first').request;
    const b = portal.requestReview('lock', 'second').request;
    const ids = portal.pendingReviews().map((r) => r.id);
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
    expect(() => portal.reviewStatus('nope')).toThrow(/unknown review request/);
  });

  it('decides a review request approved, with the comment and per-spec notes', () => {
    root = project();
    const { request } = portal.requestReview('review', 'look');
    const decided = portal.decideReview(request.id, 'changes_requested', 'rework it', [{ specId: 'worker', note: 'too wide' }]);
    expect(decided.status).toBe('changes_requested');
    expect(decided.decision?.comment).toBe('rework it');
    expect(decided.decision?.notes).toEqual([{ specId: 'worker', note: 'too wide' }]);
    expect(decided.decision?.decidedBy).toBeTruthy();
    expect(portal.pendingReviews()).toHaveLength(0);
    // Decided once: a second decision is refused, naming the status.
    expect(() => portal.decideReview(request.id, 'approved')).toThrow(/changes_requested/);

    const second = portal.requestReview('review', 'again').request;
    expect(portal.decideReview(second.id, 'approved').status).toBe('approved');
  });

  it('refuses an outcome the kind does not take', () => {
    root = project();
    const review = portal.requestReview('review', 'r').request;
    const lockReq = portal.requestReview('lock', 'l').request;
    expect(() => portal.decideReview(review.id, 'locked')).toThrow(/takes approved or changes_requested/);
    expect(() => portal.decideReview(lockReq.id, 'approved')).toThrow(/takes locked or changes_requested/);
    expect(portal.decideReview(lockReq.id, 'locked').status).toBe('locked');
  });

  it('supersedes a pending request when the design changed since', () => {
    root = project();
    const { request } = portal.requestReview('review', 'look');
    changeDesign();
    expect(portal.reviewStatus(request.id).status).toBe('superseded');
    expect(portal.pendingReviews()).toHaveLength(0);
    expect(() => portal.decideReview(request.id, 'approved')).toThrow(/superseded/);
  });

  it('answers a lock request as locked when a lock covers the requested design', () => {
    root = project();
    const { request } = portal.requestReview('lock', 'approve');
    expect(portal.reviewStatus(request.id).status).toBe('pending');
    lock();
    const after = portal.reviewStatus(request.id);
    expect(after.status).toBe('locked');
    expect(after.decision?.decidedBy).toContain('locker');
    expect(after.decision?.decidedAt).toBe('2026-09-12T08:00:00Z');
  });

  it('does not answer a lock request for a design the lock does not cover', () => {
    root = project();
    lock();
    changeDesign();
    const { request } = portal.requestReview('lock', 'approve');
    // The design moved after the lock: not approved, so the request stays pending.
    expect(portal.reviewStatus(request.id).status).toBe('pending');
    // A review request is never answered by a lock.
    lock();
    const review = portal.requestReview('review', 'r').request;
    expect(portal.reviewStatus(review.id).status).toBe('pending');
  });

  it('withdraws a pending request, and only a pending one', () => {
    root = project();
    const { request } = portal.requestReview('review', 'x');
    expect(portal.withdrawReview(request.id).status).toBe('withdrawn');
    expect(() => portal.withdrawReview(request.id)).toThrow(/no longer pending/);
  });

  describe('the dev server announcement', () => {
    it('is reported only while its process is alive, and shown on a receipt', () => {
      root = project();
      portal.announceDevServer('http://127.0.0.1:4100', process.pid);
      expect(new ReviewStore().devServer()).toBe('http://127.0.0.1:4100');
      expect(portal.requestReview('review', 'x').shownAt).toBe('http://127.0.0.1:4100');
    });

    it('ignores the announcement of a process that is gone', async () => {
      root = project();
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      await new Promise((resolve) => child.on('exit', resolve));
      portal.announceDevServer('http://127.0.0.1:4101', child.pid as number);
      expect(new ReviewStore().devServer()).toBeNull();
      expect(portal.requestReview('review', 'x').shownAt).toBeUndefined();
    });

    it('is withdrawn only by the process that announced it', () => {
      root = project();
      const file = path.join(root, '.wai', '.local', 'dev-server.json');
      portal.announceDevServer('http://127.0.0.1:4102', process.pid);
      portal.withdrawDevServer(process.pid + 100000);
      expect(fs.existsSync(file)).toBe(true);
      portal.withdrawDevServer(process.pid);
      expect(fs.existsSync(file)).toBe(false);
    });
  });
});
