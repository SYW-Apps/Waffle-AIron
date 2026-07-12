import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  upsertProjectRelation,
  removeProjectRelation,
  listProjectRelations,
} from '../../src/server/relations.js';
import type { ProjectRelationRecord, PrincipalSubject } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Project Relation Repository (sdd_host) — the store/registry/index triad
// exercised through the repository facade against a real <dataDir>/relations.json,
// so id stamping, status defaulting, createdAt/createdBy preservation, atomic
// write-temp-then-rename persistence, the filter surface, and the malformed-file
// storage error are covered end-to-end.
// ---------------------------------------------------------------------------

const CREATOR: PrincipalSubject = { userId: 'u-arch', kind: 'human', issuer: 'local' };

function mkRel(over: Partial<ProjectRelationRecord> = {}): ProjectRelationRecord {
  return {
    id: '', // absent on create -> the registry stamps a random id
    sourceProjectId: 'proj-a',
    targetProjectId: 'proj-b',
    kind: 'consumes',
    sourceAdapter: 'billing_client_adapter',
    targetPublicInterface: {
      projectId: 'proj-b',
      systemInterfaceId: 'iinvoice_api',
      version: '1.0.0',
      reason: 'billing needs invoice totals',
    },
    reason: 'cross-project billing dependency',
    status: '', // absent on create -> defaults to 'active'
    createdAt: '2026-07-09T10:00:00.000Z', // orchestrator-supplied; preserved verbatim
    createdBy: CREATOR,
    ...over,
  };
}

describe('project relation repository (sdd_host)', () => {
  let dataDir: string;
  let relationsPath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-relations-'));
    relationsPath = path.join(dataDir, 'relations.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Seed the store file directly with a controlled record set (compact JSON) so
   *  tests can pin id/status/createdAt and insertion order. A subsequent facade
   *  call re-reads it. */
  function seed(records: ProjectRelationRecord[]): void {
    fs.writeFileSync(relationsPath, JSON.stringify(records));
  }

  // ── upsert: insert ──────────────────────────────────────────────────────────

  it('upsert insert stamps a random id and defaults status to active, preserving provenance', () => {
    const stored = upsertProjectRelation(dataDir, mkRel({ reason: 'declared dep' }));

    expect(stored.id).toMatch(/[0-9a-f-]{36}/);
    expect(stored.id).not.toBe('');
    expect(stored.status).toBe('active'); // absent status defaulted
    expect(stored.createdAt).toBe('2026-07-09T10:00:00.000Z'); // preserved, not re-stamped
    expect(stored.createdBy).toEqual(CREATOR); // orchestrator-supplied provenance preserved
    expect(stored.targetPublicInterface).toEqual(mkRel().targetPublicInterface); // untouched
    expect(stored.reason).toBe('declared dep');

    // Re-read from disk proves durability.
    const reloaded = listProjectRelations(dataDir);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toEqual(stored);
    const raw = fs.readFileSync(relationsPath, 'utf8');
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it('upsert insert preserves a caller-supplied status and id rather than overriding them', () => {
    const stored = upsertProjectRelation(
      dataDir,
      mkRel({ id: 'rel-fixed', status: 'suspended' }),
    );
    expect(stored.id).toBe('rel-fixed'); // present id kept, not re-stamped
    expect(stored.status).toBe('suspended'); // present status kept, not defaulted
  });

  // ── upsert: update round-trip ────────────────────────────────────────────────

  it('upsert update replaces the record with the matching id in place and reloads', () => {
    const created = upsertProjectRelation(dataDir, mkRel());
    expect(created.status).toBe('active');

    const updated = upsertProjectRelation(
      dataDir,
      mkRel({ id: created.id, status: 'retired', reason: 'dependency removed' }),
    );

    expect(updated.id).toBe(created.id); // same id
    expect(updated.status).toBe('retired');
    expect(updated.reason).toBe('dependency removed');

    // Replaced in place, not appended.
    const all = listProjectRelations(dataDir);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(updated);

    // Durable on disk.
    const raw = JSON.parse(fs.readFileSync(relationsPath, 'utf8')) as ProjectRelationRecord[];
    expect(raw).toHaveLength(1);
    expect(raw[0].status).toBe('retired');
  });

  // ── remove ────────────────────────────────────────────────────────────────

  it('remove deletes the relation by id and persists', () => {
    const created = upsertProjectRelation(dataDir, mkRel());
    removeProjectRelation(dataDir, created.id);

    expect(listProjectRelations(dataDir)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(relationsPath, 'utf8'))).toHaveLength(0);
  });

  it('remove of an unknown id fails with a not-found error', () => {
    upsertProjectRelation(dataDir, mkRel());
    expect(() => removeProjectRelation(dataDir, 'nope')).toThrow(/not found/i);
    // The existing set is untouched.
    expect(listProjectRelations(dataDir)).toHaveLength(1);
  });

  // ── list filters ────────────────────────────────────────────────────────

  function seedForList(): void {
    // Seeded in a fixed order to assert stable insertion-order projection.
    seed([
      mkRel({ id: 'r-a', sourceProjectId: 's1', targetProjectId: 't1', status: 'active' }),
      mkRel({ id: 'r-b', sourceProjectId: 's1', targetProjectId: 't2', status: 'suspended' }),
      mkRel({ id: 'r-c', sourceProjectId: 's2', targetProjectId: 't1', status: 'active' }),
      mkRel({ id: 'r-d', sourceProjectId: 's2', targetProjectId: 't2', status: 'retired' }),
    ]);
  }

  it('lists all relations in insertion order when unfiltered', () => {
    seedForList();
    expect(listProjectRelations(dataDir).map((r) => r.id)).toEqual(['r-a', 'r-b', 'r-c', 'r-d']);
  });

  it('filters by sourceProjectId', () => {
    seedForList();
    expect(listProjectRelations(dataDir, 's1').map((r) => r.id)).toEqual(['r-a', 'r-b']);
  });

  it('filters by targetProjectId', () => {
    seedForList();
    expect(listProjectRelations(dataDir, undefined, 't1').map((r) => r.id)).toEqual(['r-a', 'r-c']);
  });

  it('filters by status', () => {
    seedForList();
    expect(listProjectRelations(dataDir, undefined, undefined, 'active').map((r) => r.id)).toEqual([
      'r-a',
      'r-c',
    ]);
  });

  it('combines filters (source + target + status)', () => {
    seedForList();
    // s2 AND t1 AND active -> only r-c.
    expect(listProjectRelations(dataDir, 's2', 't1', 'active').map((r) => r.id)).toEqual(['r-c']);
    // s1 AND active -> only r-a (r-b is suspended).
    expect(listProjectRelations(dataDir, 's1', undefined, 'active').map((r) => r.id)).toEqual([
      'r-a',
    ]);
    // A filter combination with no matches is an empty set, not an error.
    expect(listProjectRelations(dataDir, 's1', 't1', 'retired')).toEqual([]);
  });

  // ── store integrity ───────────────────────────────────────────────────────

  it('missing store file reads as an empty set', () => {
    expect(listProjectRelations(dataDir)).toEqual([]);
  });

  it('malformed store JSON fails with a storage error naming the path', () => {
    fs.writeFileSync(relationsPath, '{ this is not valid json');
    expect(() => listProjectRelations(dataDir)).toThrow(relationsPath);
    expect(() => listProjectRelations(dataDir)).toThrow(/malformed/i);
  });

  it('a structurally invalid (non-array) store fails with a storage error naming the path', () => {
    fs.writeFileSync(relationsPath, JSON.stringify({ not: 'an array' }));
    expect(() => listProjectRelations(dataDir)).toThrow(relationsPath);
  });
});
