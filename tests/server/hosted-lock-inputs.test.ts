import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as hostedLock from '../../src/server/hosted-lock.js';
import * as hostedProducers from '../../src/server/hosted-producers.js';
import { getApprovalRequestById } from '../../src/server/approvals.js';
import { LockValidationError } from '../../src/server/errors.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSystemSpec } from '../../src/core/specs.js';
import { provisionProject } from '../../src/server/adapters/core.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// hosted_lock + hosted_producers (sdd_host): the refresh of the owed build
// inputs a hosted lock takes first, the read-only checks a lock request is made
// with, the producer workflows' own credential gate, and a persisted request
// recorded under the field's former name.
// ---------------------------------------------------------------------------

const APPROVER = { id: 'u-approver', name: 'Approver', source: 'hosted' as const };
const now = '2026-11-20T10:00:00Z';

let dataDir: string;
let cfg: HostConfig;
let root: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hosted-lock-inputs-'));
  cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  root = createProjectRecord(dataDir, 'solo').rootPath;
  runWithProjectRoot(root, () => provisionProject('solo'));
  invalidateSpecCache();
});

afterEach(() => {
  invalidateSpecCache();
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

describe('hosted_lock.refreshInputs', () => {
  it('pins nothing when nothing is owed, and answers no outcome', () => {
    const outcomes = runWithProjectRoot(root, () => hostedLock.refreshInputs([]));
    expect(outcomes).toEqual([]);
  });
});

describe('hosted_lock.identity and assertApprovable', () => {
  it('identity renders the approval algorithm and digest, and reads without writing', () => {
    const id = hostedLock.identity(cfg, 'solo');
    expect(id).toMatch(/^sha256\+design\+policy:[0-9a-f]{64}$/);
    expect(fs.existsSync(path.join(root, '.wai', 'lock.json'))).toBe(false);
  });

  it('an unknown project fails loudly', () => {
    expect(() => hostedLock.identity(cfg, 'ghost')).toThrow(/unknown project/i);
    expect(() => hostedLock.assertApprovable(cfg, 'ghost')).toThrow(/unknown project/i);
    expect(() => hostedLock.execute(cfg, 'ghost', APPROVER)).toThrow(/unknown project/i);
  });

  it('assertApprovable refuses a tree with design errors and writes nothing', () => {
    runWithProjectRoot(root, () => {
      saveSystemSpec({
        schemaVersion: '1.0.0', name: 'solo', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
        publicInterfaces: [{ from: 'nowhere' }],
      } as never);
    });
    invalidateSpecCache();
    expect(() => hostedLock.assertApprovable(cfg, 'solo')).toThrow(LockValidationError);
    expect(fs.existsSync(path.join(root, '.wai', 'lock.json'))).toBe(false);
  });
});

describe('hosted_producers', () => {
  it('every workflow refuses a caller that authenticates to nothing', async () => {
    expect(() => hostedProducers.list(cfg, null, 'solo')).toThrow();
    expect(() => hostedProducers.configure(cfg, null, 'solo', 'notion', 'page')).toThrow();
    expect(() => hostedProducers.remove(cfg, null, 'solo', 'notion')).toThrow();
    await expect(hostedProducers.produce(cfg, null, 'solo', 'notion')).rejects.toThrow();
  });
});

describe('a persisted approval request recorded before the field was renamed', () => {
  it('reads its identity as the approvalId it became', () => {
    const stored = {
      id: 'req-1', kind: 'project:lock', status: 'pending', projectId: 'solo', requestedBy: 'u-requester',
      summary: 'Lock project solo', createdAt: now, expiresAt: '2099-01-01T00:00:00Z', gateStateId: 'sha256+design-2+doctrine+inputs+members:' + 'a'.repeat(64),
    };
    fs.writeFileSync(path.join(dataDir, 'approvals.json'), JSON.stringify([stored]));
    const read = getApprovalRequestById(dataDir, 'req-1')!;
    expect(read.approvalId).toBe(stored.gateStateId);
    expect((read as unknown as { gateStateId?: string }).gateStateId).toBeUndefined();
  });
});
