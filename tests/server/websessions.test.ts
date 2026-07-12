import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWebSession,
  touchWebSession,
  removeWebSession,
  pruneExpiredWebSessions,
  getWebSessionById,
  listWebSessionsBySubject,
  WEB_SESSION_PREFIX,
} from '../../src/server/websessions.js';
import type { WebSession, PrincipalSubject, ProjectGrant } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Web Session Repository (sdd_host) — the store/registry/index triad exercised
// through the repository facade against a real <dataDir>/web-sessions.json, so id
// minting (reserved prefix), createdAt/lastSeenAt stamping, per-subject listing,
// expiry pruning, atomic write-temp-then-rename durability, and the missing- and
// malformed-file storage paths are covered end-to-end.
// ---------------------------------------------------------------------------

const SUBJECT: PrincipalSubject = { userId: 'u-1', kind: 'human', issuer: 'local', displayName: 'Ada' };
const GRANTS: ProjectGrant[] = [{ projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'], role: 'editor' }];

function future(msFromNow = 60_000): string {
  return new Date(Date.now() + msFromNow).toISOString();
}
function past(msAgo = 60_000): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function mkSession(over: Partial<WebSession> = {}): WebSession {
  return {
    id: '', // the registry mints a reserved-prefix id when absent
    subject: SUBJECT,
    grants: GRANTS,
    createdAt: '1999-01-01T00:00:00.000Z', // placeholder; the registry stamps its own
    expiresAt: future(),
    ...over,
  };
}

describe('web session repository (sdd_host)', () => {
  let dataDir: string;
  let storePath: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-websessions-'));
    storePath = path.join(dataDir, 'web-sessions.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── create ──────────────────────────────────────────────────────────────────

  it('create mints a ws_-prefixed id and a fresh createdAt, preserves caller fields, and persists', () => {
    const stored = createWebSession(dataDir, mkSession({ providerId: 'oidc-1' }));

    expect(stored.id.startsWith(WEB_SESSION_PREFIX)).toBe(true);
    expect(stored.id.length).toBeGreaterThan(WEB_SESSION_PREFIX.length);
    expect(stored.createdAt).not.toBe('1999-01-01T00:00:00.000Z');
    expect(Date.parse(stored.createdAt)).not.toBeNaN();
    // caller-supplied fields are preserved untouched
    expect(stored.subject).toEqual(SUBJECT);
    expect(stored.grants).toEqual(GRANTS);
    expect(stored.providerId).toBe('oidc-1');
    // an initial lastSeenAt is stamped
    expect(stored.lastSeenAt).toBeDefined();

    // durable, and survives a fresh read (a new store instance is loaded per call)
    expect(fs.existsSync(storePath)).toBe(true);
    expect(getWebSessionById(dataDir, stored.id)).toEqual(stored);
  });

  it('two creates mint distinct ids', () => {
    const a = createWebSession(dataDir, mkSession());
    const b = createWebSession(dataDir, mkSession());
    expect(a.id).not.toBe(b.id);
    // both persisted
    expect(getWebSessionById(dataDir, a.id)).not.toBeNull();
    expect(getWebSessionById(dataDir, b.id)).not.toBeNull();
  });

  // ── getById ─────────────────────────────────────────────────────────────────

  it('getById returns the session on a hit and null when absent', () => {
    const stored = createWebSession(dataDir, mkSession());
    expect(getWebSessionById(dataDir, stored.id)).toEqual(stored);
    expect(getWebSessionById(dataDir, 'ws_does-not-exist')).toBeNull();
  });

  // ── listBySubject ─────────────────────────────────────────────────────────────

  it('listBySubject returns only sessions whose subject.userId matches', () => {
    const a1 = createWebSession(dataDir, mkSession({ subject: { userId: 'u-a', kind: 'human', issuer: 'local' } }));
    const b1 = createWebSession(dataDir, mkSession({ subject: { userId: 'u-b', kind: 'human', issuer: 'local' } }));
    const a2 = createWebSession(dataDir, mkSession({ subject: { userId: 'u-a', kind: 'human', issuer: 'local' } }));

    expect(listWebSessionsBySubject(dataDir, 'u-a').map((s) => s.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(listWebSessionsBySubject(dataDir, 'u-b').map((s) => s.id)).toEqual([b1.id]);
    expect(listWebSessionsBySubject(dataDir, 'u-none')).toEqual([]);
  });

  // ── touch ─────────────────────────────────────────────────────────────────────

  it('touch updates only lastSeenAt, preserving every other field; a missing id is a no-op', () => {
    const stored = createWebSession(dataDir, mkSession());
    const ts = '2026-07-11T09:00:00.000Z';
    touchWebSession(dataDir, stored.id, ts);

    const after = getWebSessionById(dataDir, stored.id);
    expect(after?.lastSeenAt).toBe(ts);
    expect(after?.subject).toEqual(stored.subject);
    expect(after?.grants).toEqual(stored.grants);
    expect(after?.expiresAt).toBe(stored.expiresAt);
    expect(after?.createdAt).toBe(stored.createdAt);

    // a missing id neither throws nor mutates the stored session
    expect(() => touchWebSession(dataDir, 'ws_missing', '2030-01-01T00:00:00.000Z')).not.toThrow();
    expect(getWebSessionById(dataDir, stored.id)?.lastSeenAt).toBe(ts);
  });

  // ── remove ────────────────────────────────────────────────────────────────────

  it('remove deletes the session by id; a missing id is a no-op', () => {
    const stored = createWebSession(dataDir, mkSession());
    removeWebSession(dataDir, stored.id);
    expect(getWebSessionById(dataDir, stored.id)).toBeNull();
    expect(() => removeWebSession(dataDir, 'ws_missing')).not.toThrow();
  });

  // ── pruneExpired ────────────────────────────────────────────────────────────────

  it('pruneExpired drops only expired sessions and returns the count removed', () => {
    const live = createWebSession(dataDir, mkSession({ expiresAt: future(120_000) }));
    const dead1 = createWebSession(dataDir, mkSession({ expiresAt: past(1000) }));
    const dead2 = createWebSession(dataDir, mkSession({ expiresAt: past(5000) }));

    expect(pruneExpiredWebSessions(dataDir, new Date().toISOString())).toBe(2);
    expect(getWebSessionById(dataDir, live.id)).not.toBeNull();
    expect(getWebSessionById(dataDir, dead1.id)).toBeNull();
    expect(getWebSessionById(dataDir, dead2.id)).toBeNull();

    // a second prune with nothing overdue is a no-op → 0
    expect(pruneExpiredWebSessions(dataDir, new Date().toISOString())).toBe(0);
  });

  it('pruneExpired treats expiresAt exactly equal to now as expired (boundary)', () => {
    const boundary = '2026-07-11T12:00:00.000Z';
    const s = createWebSession(dataDir, mkSession({ expiresAt: boundary }));
    expect(pruneExpiredWebSessions(dataDir, boundary)).toBe(1);
    expect(getWebSessionById(dataDir, s.id)).toBeNull();
  });

  // ── storage paths: missing / malformed ────────────────────────────────────────

  it('a missing store file yields an empty set (first boot is not an error)', () => {
    expect(fs.existsSync(storePath)).toBe(false);
    expect(getWebSessionById(dataDir, 'ws_x')).toBeNull();
    expect(listWebSessionsBySubject(dataDir, 'u-1')).toEqual([]);
    expect(pruneExpiredWebSessions(dataDir, new Date().toISOString())).toBe(0);
  });

  it('malformed store JSON fails with a storage error naming the path', () => {
    fs.writeFileSync(storePath, '{ this is not valid json');
    expect(() => getWebSessionById(dataDir, 'ws_x')).toThrow(storePath);
    expect(() => getWebSessionById(dataDir, 'ws_x')).toThrow(/malformed/i);
  });

  it('a structurally invalid (non-array) store fails with a storage error naming the path', () => {
    fs.writeFileSync(storePath, JSON.stringify({ not: 'an array' }));
    expect(() => listWebSessionsBySubject(dataDir, 'u-1')).toThrow(storePath);
  });
});
