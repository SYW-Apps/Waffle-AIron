import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, saveComponentSpec, updateSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as portal from '../../src/core/index.js';
import { ReviewStore } from '../../src/core/review-store.js';
import { assertApprovable } from '../../src/commands/lock.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// A request records the branch it was made on; a checkout switched to another branch with another
// design neither locks nor supersedes it, a decision on it is refused, and a lock is told about it.

const now = '2026-11-10T10:00:00Z';
const SHA = 'c'.repeat(40);

function project(): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reviewbranch-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'rb-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'rb-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', { id: 'dom', name: 'dom', description: 'd', parentSystem: 'rb-sys', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now } as SubsystemSpec);
  saveComponentSpec({ id: 'worker', name: 'Worker', description: 'a worker', subsystem: 'dom', componentType: 'Orchestrator', dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now } as ComponentSpec);
  invalidateSpecCache();
  return root;
}

/** Check out `branch`; `branches` are the ones that exist (loose refs). */
function checkout(root: string, branch: string, branches: string[] = [branch]): void {
  fs.rmSync(path.join(root, '.git', 'refs'), { recursive: true, force: true });
  for (const b of branches) {
    const file = path.join(root, '.git', 'refs', 'heads', ...b.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SHA + '\n');
  }
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/' + branch + '\n');
}

function changeDesign(): void {
  updateSpec('component', 'worker', { description: 'a worker, changed on this branch' });
  invalidateSpecCache();
}

describe('review requests and branches', () => {
  let root: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it('records the branch and commit the request was made on', () => {
    root = project();
    checkout(root, 'feat/a');
    const { request } = portal.requestReview('lock', 'x');
    expect(request).toMatchObject({ branch: 'feat/a', commit: SHA });
  });

  it('keeps a request pending when the checkout is on another branch with another design', () => {
    root = project();
    checkout(root, 'feat/a', ['feat/a', 'main']);
    const { request } = portal.requestReview('lock', 'x');
    checkout(root, 'main', ['feat/a', 'main']);
    changeDesign();
    expect(portal.reviewStatus(request.id).status).toBe('pending');
    expect(portal.pendingReviews().map((r) => r.id)).toEqual([request.id]);
    // back on its branch the changed design supersedes it, as before
    checkout(root, 'feat/a', ['feat/a', 'main']);
    expect(portal.reviewStatus(request.id).status).toBe('superseded');
  });

  it('refuses a decision on it, naming both branches', () => {
    root = project();
    checkout(root, 'feat/a', ['feat/a', 'main']);
    const { request } = portal.requestReview('review', 'x');
    checkout(root, 'main', ['feat/a', 'main']);
    changeDesign();
    expect(() => portal.decideReview(request.id, 'approved')).toThrow(/feat\/a[\s\S]*main/);
  });

  it('judges a request normally when the checkout holds its design, whatever the branch', () => {
    root = project();
    checkout(root, 'feat/a', ['feat/a', 'main']);
    const { request } = portal.requestReview('review', 'x');
    checkout(root, 'main', ['feat/a', 'main']);
    expect(portal.decideReview(request.id, 'approved').status).toBe('approved');
  });

  it('supersedes a request with a changed design when it recorded no branch', () => {
    root = project();
    const { request } = portal.requestReview('lock', 'x');
    changeDesign();
    expect(portal.reviewStatus(request.id).status).toBe('superseded');
  });

  it('reports the conflict of a pending lock request on another existing branch, and ignores a deleted one', () => {
    root = project();
    expect(portal.reviewBranchConflict()).toBeUndefined();
    checkout(root, 'feat/a', ['feat/a', 'main']);
    const { request } = portal.requestReview('lock', 'x');
    expect(portal.reviewBranchConflict()).toBeUndefined();
    checkout(root, 'main', ['feat/a', 'main']);
    changeDesign();
    expect(portal.reviewBranchConflict()).toEqual({ requestId: request.id, requestedOn: 'feat/a', checkedOut: 'main' });
    // a newer review request asks for no approval
    new ReviewStore().save({ ...request, id: 'rev1', kind: 'review', requestedAt: '2099-01-01T00:00:00Z' });
    expect(portal.reviewBranchConflict()?.requestId).toBe(request.id);
    // the request's branch was deleted
    checkout(root, 'main', ['main']);
    expect(portal.reviewBranchConflict()).toBeUndefined();
  });

  it('the lock guard refuses on a conflict, names both branches, and --force passes', () => {
    root = project();
    checkout(root, 'feat/a', ['feat/a', 'main']);
    portal.requestReview('lock', 'x');
    checkout(root, 'main', ['feat/a', 'main']);
    changeDesign();
    expect(() => assertApprovable([])).toThrow(/the pending lock request was made on another branch[\s\S]*feat\/a[\s\S]*main/);
    expect(() => assertApprovable([], true)).not.toThrow();
  });
});
