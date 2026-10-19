import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run as migrateRetiredValues } from '../../src/server/migration.js';
import { run as upgradeInstance, readVersion } from '../../src/server/upgrade.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { createCredential, listCredentials } from '../../src/server/credentials.js';
import { getExposurePolicyRecord } from '../../src/server/policy.js';
import { getUserById } from '../../src/server/users.js';
import { listApprovalRequests, getApprovalRequestById } from '../../src/server/approvals.js';
import { subjectOf } from './helpers.js';

// ---------------------------------------------------------------------------
// retired_value_migration.run - the data-directory rewrite of the values an
// older major stored that this major no longer reads, applied by the instance
// upgrade at server start. Read and rewritten raw: the loaders refuse them.
// ---------------------------------------------------------------------------

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-retired-values-'));
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
});

const file = (...parts: string[]): string => path.join(dataDir, ...parts);
const writeJson = (rel: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), JSON.stringify(value, null, 2) + '\n');
};
const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(file(rel), 'utf8')) as T;
const snapshot = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(`${path.relative(dataDir, full)}=${fs.readFileSync(full, 'utf8')}`);
    }
  };
  walk(dataDir);
  return out.sort();
};

const NOW = '2026-10-01T00:00:00.000Z';
const user = (id: string, status: string): Record<string, unknown> => ({
  id, subject: subjectOf(id), status, roleBindings: [], createdAt: NOW,
});
const lockRequest = (id: string, status: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, kind: 'project:lock', status, requestedBy: subjectOf('u-req'), projectId: 'platform', summary: 'Lock',
  payloadType: 'SubprojectScope', payload: JSON.stringify({ subproject: 'billing' }), createdAt: NOW, ...over,
});

/** A data directory holding every retired value an older major stored. */
function seedOld(): void {
  writeJson('exposure-policy.json', { adminApiMode: 'private_network', webUiEnabled: true });
  writeJson('users.json', [
    user('u-suspended', 'suspended'), user('u-deactivated', 'deactivated'), user('u-disabled', 'disabled'),
    user('u-deleted', 'deleted'), user('u-active', 'active'), user('u-inactive', 'inactive'),
  ]);
  writeJson('public-surfaces.json', [{
    projectId: 'platform', stateId: 's', systemName: 'Platform', exportedAt: NOW,
    interfaces: [{ id: 'a', audience: 'public' }, { id: 'b', audience: 'instance' }, { id: 'c', audience: 'external' }],
  }]);
  writeJson('share-snapshots/with-set.json', { id: 'with-set', projectId: 'platform', view: 'v', capturedAt: NOW, canvasModel: '{}', openapi: '{"one":1}', openapiSet: [{ portalId: 'p', name: 'P', document: '{"one":1}' }] });
  writeJson('share-snapshots/alone.json', { id: 'alone', projectId: 'platform', view: 'v', capturedAt: NOW, canvasModel: '{"keep":true}', openapi: '{"old":1}' });
  writeJson('share-snapshots/current.json', { id: 'current', projectId: 'platform', view: 'v', capturedAt: NOW, openapiSet: [] });
  writeJson('approvals.json', [
    lockRequest('r-pending', 'pending'),
    lockRequest('r-approved', 'approved', { decidedAt: NOW, decidedBy: subjectOf('u-decider') }),
    lockRequest('r-completed', 'completed'),
    lockRequest('r-denied', 'denied'),
    lockRequest('r-plain-pending', 'pending', { payloadType: undefined, payload: undefined }),
    { ...lockRequest('r-init', 'pending', { kind: 'project:init' }) },
  ]);
}

describe('the retired values are reported by a dry run, which writes nothing', () => {
  it('names each finding by area, in order, and leaves the data directory byte for byte as it was', () => {
    seedOld();
    const before = snapshot();
    const report = migrateRetiredValues(dataDir, false);
    expect(report.applied).toBe(false);
    expect(report.findings.map((f) => f.area)).toEqual([
      'exposure',
      'users', 'users', 'users', 'users',
      'surfaces',
      'shares', 'shares',
      'requests', 'requests',
    ]);
    expect(snapshot()).toEqual(before);
    expect(queryAuditEvents(dataDir, { action: 'approval.request.closed' })).toEqual([]);
  });
});

describe('applying rewrites every retired value', () => {
  beforeEach(() => {
    seedOld();
    expect(migrateRetiredValues(dataDir, true).applied).toBe(true);
  });

  it('stores a retired adminApiMode as enabled, keeping the other flags, so the loader reads it', () => {
    expect(readJson<Record<string, unknown>>('exposure-policy.json')).toEqual({ adminApiMode: 'enabled', webUiEnabled: true });
    expect(getExposurePolicyRecord(dataDir)?.adminApiMode).toBe('enabled');
  });

  it('stores suspended, deactivated, disabled and deleted users as inactive and leaves the rest', () => {
    const status = (id: string): string | undefined => getUserById(dataDir, id)?.status;
    expect(['u-suspended', 'u-deactivated', 'u-disabled', 'u-deleted'].map(status)).toEqual(['inactive', 'inactive', 'inactive', 'inactive']);
    expect(status('u-active')).toBe('active');
    expect(status('u-inactive')).toBe('inactive');
  });

  it('stores a public-surface audience public as external, so the served reach is exactly what it was', () => {
    const [snapshotRow] = readJson<{ interfaces: { id: string; audience: string }[] }[]>('public-surfaces.json');
    expect(snapshotRow.interfaces.map((i) => [i.id, i.audience])).toEqual([['a', 'external'], ['b', 'instance'], ['c', 'external']]);
  });

  it('drops the single-document OpenAPI capture, keeping the per-portal set, the canvas and the rest', () => {
    const withSet = readJson<Record<string, unknown>>('share-snapshots/with-set.json');
    expect(withSet).not.toHaveProperty('openapi');
    expect(withSet.openapiSet).toEqual([{ portalId: 'p', name: 'P', document: '{"one":1}' }]);
    const alone = readJson<Record<string, unknown>>('share-snapshots/alone.json');
    expect(alone).not.toHaveProperty('openapi');
    expect(alone.canvasModel).toBe('{"keep":true}');
    expect(readJson<Record<string, unknown>>('share-snapshots/current.json')).toEqual({ id: 'current', projectId: 'platform', view: 'v', capturedAt: NOW, openapiSet: [] });
  });

  it('closes a pending member-scoped lock request as denied and an approved one as cancelled; others are left alone', () => {
    const byId = (id: string) => getApprovalRequestById(dataDir, id)!;
    expect(byId('r-pending')).toMatchObject({ status: 'denied', decidedBy: { userId: 'operator:host-upgrade' } });
    expect(byId('r-pending').decisionReason).toMatch(/member scope.*ask again/);
    expect(byId('r-approved')).toMatchObject({ status: 'cancelled' });
    expect(byId('r-approved').executionSummary).toMatch(/member scope.*ask again/);
    expect(byId('r-completed').status).toBe('completed');
    expect(byId('r-denied').status).toBe('denied');
    expect(byId('r-plain-pending').status).toBe('pending');
    expect(byId('r-init').status).toBe('pending');
    expect(listApprovalRequests(dataDir, 'approved')).toEqual([]);
  });

  it('audits approval.request.closed per closed request, naming the request, its project and the reason', () => {
    const events = queryAuditEvents(dataDir, { action: 'approval.request.closed' });
    expect(events.map((e) => e.target).sort()).toEqual(['r-approved', 'r-pending']);
    for (const e of events) {
      expect(e.projectId).toBe('platform');
      expect(JSON.parse(e.metadata!)).toMatchObject({ requestId: e.target, reason: expect.stringContaining('member scope') });
    }
    expect(events.map((e) => JSON.parse(e.metadata!).closedAs).sort()).toEqual(['cancelled', 'denied']);
  });

  it('is idempotent: the second run finds nothing, writes nothing and audits nothing more', () => {
    const before = snapshot();
    const again = migrateRetiredValues(dataDir, true);
    expect(again).toEqual({ findings: [], applied: true });
    expect(snapshot()).toEqual(before);
    expect(queryAuditEvents(dataDir, { action: 'approval.request.closed' })).toHaveLength(2);
  });
});

describe('a data directory with none of these values, or none of these files', () => {
  it('reports nothing for an empty data directory', () => {
    expect(migrateRetiredValues(dataDir, true)).toEqual({ findings: [], applied: true });
  });
});

describe('the start upgrade runs the step', () => {
  it('rewrites the retired values of an older data directory and stamps the running major; a revoked qualified key does not abort the start', () => {
    ensureInstanceIdentity(dataDir);
    fs.writeFileSync(file('version.json'), JSON.stringify({ major: 5 }));
    seedOld();
    createCredential(dataDir, {
      id: 'k-revoked', keyHash: 'h', projects: ['platform::billing'], createdAt: NOW, revokedAt: NOW, ownerSubject: subjectOf('u-q'),
    });
    createCredential(dataDir, { id: 'k-ghost', keyHash: 'h2', projects: ['platform::ghost'], createdAt: NOW, ownerSubject: subjectOf('u-q') });

    const report = upgradeInstance({ dataDir });

    expect(report.fromMajor).toBe(5);
    expect(readVersion(dataDir)).toBe(report.toMajor);
    expect(getExposurePolicyRecord(dataDir)?.adminApiMode).toBe('enabled');
    expect(getUserById(dataDir, 'u-suspended')?.status).toBe('inactive');
    expect(getApprovalRequestById(dataDir, 'r-pending')?.status).toBe('denied');
    // The revoked key is untouched; the key naming no member is revoked (removed).
    expect(listCredentials(dataDir, '*').map((k) => k.id)).toEqual(['k-revoked']);
    expect(queryAuditEvents(dataDir, { action: 'approval.request.closed' })).toHaveLength(2);
  });

  it('does not run on a current data directory: its retired values stay for the loaders to refuse', () => {
    ensureInstanceIdentity(dataDir);
    const current = upgradeInstance({ dataDir }); // first boot stamps the running major
    fs.writeFileSync(file('version.json'), JSON.stringify({ major: current.toMajor }));
    writeJson('users.json', [user('u-suspended', 'suspended')]);
    upgradeInstance({ dataDir });
    expect(readJson<{ status: string }[]>('users.json')[0].status).toBe('suspended');
  });
});
