import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as portal from '../../src/core/index.js';
import { runReviewWithdraw } from '../../src/cli/runner.js';
import { assertApprovable } from '../../src/commands/lock.js';
import { logger } from '../../src/utils/logger.js';
import { WaironError } from '../../src/utils/errors.js';

// `wairon review withdraw <id>` takes a pending request back and says what it withdrew.

const now = '2026-11-10T10:00:00Z';
const SHA = 'd'.repeat(40);

function project(): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reviewwithdraw-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'rw-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'rw-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  invalidateSpecCache();
  fs.mkdirSync(path.join(root, '.git', 'refs', 'heads', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'refs', 'heads', 'feat', 'a'), SHA + '\n');
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/feat/a\n');
  return root;
}

describe('wairon review withdraw', () => {
  let root: string;
  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it('withdraws a pending request and prints its kind and branch', async () => {
    root = project();
    const { request } = portal.requestReview('lock', 'x');
    const out = vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    await runReviewWithdraw(request.id);
    expect(portal.reviewStatus(request.id).status).toBe('withdrawn');
    expect(out.mock.calls[0][0]).toMatch(/lock request[\s\S]*feat\/a/);
    expect(() => assertApprovable([])).not.toThrow();
  });

  it('refuses a request no longer pending, naming its status', async () => {
    root = project();
    const { request } = portal.requestReview('review', 'x');
    vi.spyOn(logger, 'success').mockImplementation(() => undefined);
    await runReviewWithdraw(request.id);
    await expect(runReviewWithdraw(request.id)).rejects.toThrow(/withdrawn/);
    await expect(runReviewWithdraw(request.id)).rejects.toBeInstanceOf(WaironError);
  });

  it('refuses an unknown id', async () => {
    root = project();
    await expect(runReviewWithdraw('nope')).rejects.toThrow(/unknown review request: nope/);
  });
});
