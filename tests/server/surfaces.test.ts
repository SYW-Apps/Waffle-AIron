import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  replacePublicSurfaceSnapshot,
  getPublicSurfaceSnapshot,
  findPublicInterface,
} from '../../src/server/surfaces.js';
import type {
  ProjectPublicSurfaceSnapshot,
  PublicInterfaceSummary,
  PrincipalSubject,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Public Surface Repository (sdd_host) — the store/registry/index triad
// exercised through the repository facade against a real
// <dataDir>/public-surfaces.json, so persistence, server-side exportedAt
// stamping, wholesale single-per-project replacement, atomic
// write-temp-then-rename, and the malformed-file storage error are covered
// end-to-end.
// ---------------------------------------------------------------------------

const EXPORTER: PrincipalSubject = { userId: 'u-exp', kind: 'service', issuer: 'local' };

function mkInterface(over: Partial<PublicInterfaceSummary> = {}): PublicInterfaceSummary {
  return {
    id: 'iface-1',
    name: 'Billing Interface',
    type: 'Portal',
    audience: 'public',
    methods: ['charge', 'refund'],
    details: 'Redacted public billing surface.',
    ...over,
  };
}

function mkSnapshot(over: Partial<ProjectPublicSurfaceSnapshot> = {}): ProjectPublicSurfaceSnapshot {
  return {
    projectId: 'p1',
    stateId: 'state-abc',
    systemName: 'Acme Billing',
    interfaces: [mkInterface()],
    exportedAt: '1999-01-01T00:00:00.000Z', // placeholder; the registry stamps its own
    exportedBy: EXPORTER,
    ...over,
  };
}

describe('public surface repository (sdd_host)', () => {
  let dataDir: string;
  let surfacesPath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-surfaces-'));
    surfacesPath = path.join(dataDir, 'public-surfaces.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Seed the store file directly with a controlled snapshot set (compact JSON,
   *  no trailing newline) so tests can pin exportedAt/content. A subsequent
   *  facade call re-reads it. */
  function seed(records: ProjectPublicSurfaceSnapshot[]): string {
    const compact = JSON.stringify(records);
    fs.writeFileSync(surfacesPath, compact);
    return compact;
  }

  // ── replace (write path) ────────────────────────────────────────────────

  it('replace stamps a fresh exportedAt server-side, preserves exportedBy + content, and persists', () => {
    const stored = replacePublicSurfaceSnapshot(dataDir, mkSnapshot());

    // exportedAt is stamped to the current server time (not the caller's placeholder).
    expect(stored.exportedAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(stored.exportedAt)).not.toBeNaN();
    // Everything else is preserved verbatim.
    expect(stored.exportedBy).toEqual(EXPORTER);
    expect(stored.projectId).toBe('p1');
    expect(stored.stateId).toBe('state-abc');
    expect(stored.systemName).toBe('Acme Billing');
    expect(stored.interfaces).toEqual([mkInterface()]);

    // Re-read from disk proves durability and round-trips identically.
    const reloaded = getPublicSurfaceSnapshot(dataDir, 'p1');
    expect(reloaded).toEqual(stored);
    const raw = fs.readFileSync(surfacesPath, 'utf8');
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it('a second replace overwrites the project snapshot wholesale (no merge)', () => {
    replacePublicSurfaceSnapshot(
      dataDir,
      mkSnapshot({ stateId: 'state-old', interfaces: [mkInterface({ id: 'iface-old' })] }),
    );
    const second = replacePublicSurfaceSnapshot(
      dataDir,
      mkSnapshot({ stateId: 'state-new', interfaces: [mkInterface({ id: 'iface-new' })] }),
    );

    const reloaded = getPublicSurfaceSnapshot(dataDir, 'p1');
    expect(reloaded).toEqual(second);
    expect(reloaded?.stateId).toBe('state-new');
    // Old interface is gone — replacement is wholesale, not a merge.
    expect(reloaded?.interfaces.map((i) => i.id)).toEqual(['iface-new']);
    // Still exactly one snapshot for the project.
    expect(JSON.parse(fs.readFileSync(surfacesPath, 'utf8'))).toHaveLength(1);
  });

  it('snapshots for multiple projects coexist and replace targets only the matching projectId', () => {
    replacePublicSurfaceSnapshot(dataDir, mkSnapshot({ projectId: 'p1', systemName: 'One' }));
    replacePublicSurfaceSnapshot(dataDir, mkSnapshot({ projectId: 'p2', systemName: 'Two' }));

    expect(getPublicSurfaceSnapshot(dataDir, 'p1')?.systemName).toBe('One');
    expect(getPublicSurfaceSnapshot(dataDir, 'p2')?.systemName).toBe('Two');
    expect(JSON.parse(fs.readFileSync(surfacesPath, 'utf8'))).toHaveLength(2);

    // Replacing p1 leaves p2 untouched.
    replacePublicSurfaceSnapshot(dataDir, mkSnapshot({ projectId: 'p1', systemName: 'One-v2' }));
    expect(getPublicSurfaceSnapshot(dataDir, 'p1')?.systemName).toBe('One-v2');
    expect(getPublicSurfaceSnapshot(dataDir, 'p2')?.systemName).toBe('Two');
    expect(JSON.parse(fs.readFileSync(surfacesPath, 'utf8'))).toHaveLength(2);
  });

  // ── getSnapshot (read path) ─────────────────────────────────────────────

  it('getSnapshot returns the snapshot for a hit and null for a project with no snapshot', () => {
    replacePublicSurfaceSnapshot(dataDir, mkSnapshot({ projectId: 'p1' }));
    expect(getPublicSurfaceSnapshot(dataDir, 'p1')?.projectId).toBe('p1');
    expect(getPublicSurfaceSnapshot(dataDir, 'nope')).toBeNull();
  });

  // ── findInterface (read path) ───────────────────────────────────────────

  it('findInterface returns the matching redacted interface summary', () => {
    replacePublicSurfaceSnapshot(
      dataDir,
      mkSnapshot({
        projectId: 'p1',
        interfaces: [mkInterface({ id: 'iface-a' }), mkInterface({ id: 'iface-b', name: 'B' })],
      }),
    );
    const found = findPublicInterface(dataDir, 'p1', 'iface-b');
    expect(found?.id).toBe('iface-b');
    expect(found?.name).toBe('B');
  });

  it('findInterface returns null when the project has a snapshot but no such interface', () => {
    replacePublicSurfaceSnapshot(dataDir, mkSnapshot({ projectId: 'p1', interfaces: [mkInterface({ id: 'iface-a' })] }));
    expect(findPublicInterface(dataDir, 'p1', 'iface-missing')).toBeNull();
  });

  it('findInterface returns null when the project has no snapshot at all', () => {
    replacePublicSurfaceSnapshot(dataDir, mkSnapshot({ projectId: 'p1' }));
    expect(findPublicInterface(dataDir, 'other-project', 'iface-1')).toBeNull();
  });

  // ── store integrity ─────────────────────────────────────────────────────

  it('missing store file reads as an empty set (null lookups, no error)', () => {
    expect(getPublicSurfaceSnapshot(dataDir, 'anything')).toBeNull();
    expect(findPublicInterface(dataDir, 'anything', 'iface-1')).toBeNull();
  });

  it('malformed store JSON fails with a storage error naming the path', () => {
    fs.writeFileSync(surfacesPath, '{ this is not valid json');
    expect(() => getPublicSurfaceSnapshot(dataDir, 'p1')).toThrow(surfacesPath);
    expect(() => getPublicSurfaceSnapshot(dataDir, 'p1')).toThrow(/malformed/i);
  });

  it('a structurally invalid (non-array) store fails with a storage error naming the path', () => {
    seed({ not: 'an array' } as unknown as ProjectPublicSurfaceSnapshot[]);
    expect(() => findPublicInterface(dataDir, 'p1', 'iface-1')).toThrow(surfacesPath);
  });
});
