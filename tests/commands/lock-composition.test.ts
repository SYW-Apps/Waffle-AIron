import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, invalidateSpecCache } from '../../src/core/specs.js';
import * as portal from '../../src/core/index.js';
import { assertApprovable, runLock } from '../../src/commands/lock.js';
import { computeApprovalId } from '../../src/core/validation.js';
import { logger } from '../../src/utils/logger.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// A lock refuses a family that could not be composed (a declared member whose folder is gone),
// with or without --force, before it prints any summary, and writes nothing.

vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

const now = '2026-11-10T10:00:00Z';
let root: string;

function project(): void {
  invalidateSpecCache();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lockcomp-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id: 'host', name: 'host', targets: [], rules: {}, createdAt: now, updatedAt: now,
    members: { gone: 'parts/gone' },
  }));
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'host', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', { id: 'dom', name: 'dom', description: 'd', parentSystem: 'host', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now } as SubsystemSpec);
  invalidateSpecCache();
  setProjectRoot(root);
}

afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows */ }
});

describe('lock refuses a family that could not be composed', () => {
  it('refuses with and without --force, prints no summary, writes nothing', async () => {
    project();
    const lines: string[] = [];
    for (const level of ['info', 'warn', 'success', 'blank'] as const) {
      vi.spyOn(logger, level).mockImplementation((m?: string) => { lines.push(String(m ?? '')); });
    }
    const lockFile = path.join(root, '.wai', 'lock.json');
    for (const force of [false, true]) {
      invalidateSpecCache();
      await expect(runLock({ yes: true, force }, { valid: true, issues: [] }, computeApprovalId()))
        .rejects.toThrow(/^the family could not be composed — [\s\S]*gone[\s\S]*--force does not override this\. Nothing was written\./);
    }
    expect(fs.existsSync(lockFile)).toBe(false);
    expect(lines.join('\n')).not.toMatch(/would pass/);
    expect(lines).toEqual([]);
    expect(() => assertApprovable([], true)).toThrow(/family could not be composed/);
  });
});

describe('branch conflict and a request on the checkout\'s own branch', () => {
  const SHA = 'c'.repeat(40);
  function checkout(branch: string, branches: string[]): void {
    fs.rmSync(path.join(root, '.git', 'refs'), { recursive: true, force: true });
    for (const b of branches) {
      const file = path.join(root, '.git', 'refs', 'heads', ...b.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, SHA + '\n');
    }
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/' + branch + '\n');
  }
  function plain(): void {
    project();
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', id: 'host', name: 'host', targets: [], rules: {}, createdAt: now, updatedAt: now,
    }));
    invalidateSpecCache();
  }

  it('no conflict when a pending lock request is also on the current branch; conflict when only the other branch has one', () => {
    plain();
    checkout('feat/a', ['feat/a', 'main']);
    portal.requestReview('lock', 'a');
    checkout('main', ['feat/a', 'main']);
    // only A pending, design changed on main
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'extra.txt'), 'x');
    saveSpec('subsystem', { id: 'dom', name: 'dom', description: 'changed', parentSystem: 'host', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now } as SubsystemSpec);
    invalidateSpecCache();
    expect(portal.reviewBranchConflict()?.requestedOn).toBe('feat/a');
    // a pending lock request on main too
    portal.requestReview('lock', 'b');
    expect(portal.reviewBranchConflict()).toBeUndefined();
  });
});
