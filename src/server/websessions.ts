import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { WebSession } from './types.js';

// ---------------------------------------------------------------------------
// Web Session Repository (sdd_host)
//
// Durable browser sessions for the hosted web UI, file-backed at
// <dataDir>/web-sessions.json. Composition mirrors the spec tree:
//   - WebSessionStore    : authoritative in-memory holder of the session set,
//                          loaded from disk (missing file -> empty; corrupt ->
//                          storage error naming the path).
//   - WebSessionRegistry : the write path — create (mint a reserved-prefix id,
//                          stamp createdAt/lastSeenAt), touch (activity), remove
//                          (sign-out / correlated revocation), pruneExpired.
//                          Persists the complete set durably then refreshes the
//                          owned store; never touches the index.
//   - WebSessionIndex    : the read path — by-id lookup and per-subject listing
//                          over the store's set; never mutates and enforces no
//                          expiry (the auth specialist rejects expired sessions
//                          on resolution).
//   - facade             : the exported dataDir-first functions; pure 1:1
//                          forwarding (writes -> registry, reads -> index).
//
// The session id carries a RESERVED PREFIX (WEB_SESSION_PREFIX) and is itself a
// first-class credential: the auth specialist recognizes it by that prefix and
// resolves it to a Principal exactly like a bearer token. Every write goes
// through write-temp-then-rename so a crashed write leaves the prior set intact —
// a lost session would silently sign a user out.
// ---------------------------------------------------------------------------

/** Reserved prefix marking a session id as a first-class web-session credential.
 *  Exported so the auth specialist can distinguish a session id from a bearer
 *  token before resolving it. */
export const WEB_SESSION_PREFIX = 'ws_';

// ── file helpers ─────────────────────────────────────────────────────────────

function storePath(dataDir: string): string {
  return path.join(dataDir, 'web-sessions.json');
}

/**
 * Read the persisted browser-session set. A missing file yields an empty set
 * (first boot is not an error); an unreadable file or structurally invalid JSON
 * fails with a storage error naming the path — persisted sessions are never
 * silently discarded.
 */
function readSessions(dataDir: string): WebSession[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read web session store at ${p}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of web sessions');
    return parsed as WebSession[];
  } catch (e) {
    throw new Error(`Web session store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/** Persist the complete session set atomically (write temp, then rename). */
function persistSessions(dataDir: string, sessions: WebSession[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(sessions, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/** Mint a fresh, unguessable session id carrying the reserved prefix. */
function mintSessionId(): string {
  return `${WEB_SESSION_PREFIX}${crypto.randomBytes(24).toString('hex')}`;
}

// ── store: authoritative in-memory holder ────────────────────────────────────

class WebSessionStore {
  private sessions: WebSession[] = [];
  constructor(private readonly dataDir: string) {}

  /** Load the persisted set into the authoritative in-memory representation. */
  load(): WebSession[] {
    this.sessions = readSessions(this.dataDir);
    return this.sessions;
  }

  /** Swap the in-memory set to a complete replacement in one assignment. Only
   *  called by the registry after durable persistence has succeeded, so index
   *  reads always observe a consistent set. */
  replaceAll(sessions: WebSession[]): void {
    this.sessions = sessions;
  }

  /** The current authoritative set (shared by reference with the index). */
  all(): WebSession[] {
    return this.sessions;
  }
}

// ── registry: write path ─────────────────────────────────────────────────────

class WebSessionRegistry {
  constructor(private readonly dataDir: string, private readonly store: WebSessionStore) {}

  /**
   * Mint the session id when absent (reserved prefix), stamp createdAt and the
   * initial lastSeenAt, and keep the caller-supplied expiresAt/subject/grants/
   * providerId. Insert it into the current set, persist the complete set durably
   * via write-temp-then-rename, then push the new set into the store and return
   * the stored session. On persistence failure no in-memory state changes.
   */
  create(session: WebSession): WebSession {
    const now = new Date().toISOString();
    const stored: WebSession = {
      ...session,
      id: session.id && session.id.length > 0 ? session.id : mintSessionId(),
      createdAt: now,
      lastSeenAt: session.lastSeenAt ?? now,
    };
    const next = [...this.store.all(), stored];
    persistSessions(this.dataDir, next);
    this.store.replaceAll(next);
    return stored;
  }

  /**
   * Locate the session by id — a missing id is a silent no-op — update only its
   * lastSeenAt while preserving every other field, then persist and swap.
   */
  touch(id: string, lastSeenAt: string): void {
    const sessions = this.store.all();
    const idx = sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const updated: WebSession = { ...sessions[idx], lastSeenAt };
    const next = [...sessions];
    next[idx] = updated;
    persistSessions(this.dataDir, next);
    this.store.replaceAll(next);
  }

  /**
   * Drop the session with the given id — a missing id is a silent no-op that
   * rewrites nothing — then persist the reduced set durably and swap it in.
   */
  remove(id: string): void {
    const sessions = this.store.all();
    if (!sessions.some((s) => s.id === id)) return;
    const next = sessions.filter((s) => s.id !== id);
    persistSessions(this.dataDir, next);
    this.store.replaceAll(next);
  }

  /**
   * Remove every session belonging to the given subject user id (correlated
   * revocation when a user is deactivated — a separate credential type from
   * tokens, so it must be swept too), persist and swap the reduced set, and
   * return the number removed. A user with no sessions is a no-op returning zero.
   */
  removeAllForSubject(userId: string): number {
    const sessions = this.store.all();
    const next = sessions.filter((s) => s.subject.userId !== userId);
    const removed = sessions.length - next.length;
    if (removed > 0) {
      persistSessions(this.dataDir, next);
      this.store.replaceAll(next);
    }
    return removed;
  }

  /**
   * Remove every session whose expiresAt is at or before the supplied instant,
   * persist and swap the reduced set, and return the number removed. A no-op
   * returns zero without rewriting unchanged state.
   */
  pruneExpired(now: string): number {
    const nowMs = Date.parse(now);
    const sessions = this.store.all();
    const next = sessions.filter((s) => Date.parse(s.expiresAt) > nowMs);
    const removed = sessions.length - next.length;
    if (removed > 0) {
      persistSessions(this.dataDir, next);
      this.store.replaceAll(next);
    }
    return removed;
  }
}

// ── index: read path ─────────────────────────────────────────────────────────

class WebSessionIndex {
  constructor(private readonly store: WebSessionStore) {}

  /** Return the store's session whose id matches exactly, or null when absent.
   *  A pure read; performs no expiry enforcement. */
  getById(id: string): WebSession | null {
    return this.store.all().find((s) => s.id === id) ?? null;
  }

  /** Return every session whose subject.userId equals the supplied user id, for
   *  account views and correlated revocation; empty when the user has none. */
  listBySubject(userId: string): WebSession[] {
    return this.store.all().filter((s) => s.subject.userId === userId);
  }
}

// ── repository facade (1:1 forwarding) ────────────────────────────────────────
//
// Pure 1:1 forwarding. Each call materializes the authoritative set from disk
// (mirroring the rest of the server's read-fresh-per-call storage style), wires
// the store/registry/index over it, and forwards. Writes go to the registry,
// reads to the index.

/** Persist a new browser session (minting a reserved-prefix id) through the facade (atomic). */
export function createWebSession(dataDir: string, session: WebSession): WebSession {
  const store = new WebSessionStore(dataDir);
  store.load();
  return new WebSessionRegistry(dataDir, store).create(session);
}

/** Update one session's lastSeenAt activity timestamp through the facade (atomic). */
export function touchWebSession(dataDir: string, id: string, lastSeenAt: string): void {
  const store = new WebSessionStore(dataDir);
  store.load();
  new WebSessionRegistry(dataDir, store).touch(id, lastSeenAt);
}

/** Remove one session by id (sign-out / correlated revocation) through the facade (atomic). */
export function removeWebSession(dataDir: string, id: string): void {
  const store = new WebSessionStore(dataDir);
  store.load();
  new WebSessionRegistry(dataDir, store).remove(id);
}

/** Delete sessions at or past their expiresAt; returns the count removed (atomic). */
export function pruneExpiredWebSessions(dataDir: string, now: string): number {
  const store = new WebSessionStore(dataDir);
  store.load();
  return new WebSessionRegistry(dataDir, store).pruneExpired(now);
}

/** Remove every browser session belonging to the given user id (correlated
 *  revocation on deactivation); returns the count removed (atomic). */
export function removeAllWebSessionsForSubject(dataDir: string, userId: string): number {
  const store = new WebSessionStore(dataDir);
  store.load();
  return new WebSessionRegistry(dataDir, store).removeAllForSubject(userId);
}

/** Return one browser session by id, or null when absent. */
export function getWebSessionById(dataDir: string, id: string): WebSession | null {
  const store = new WebSessionStore(dataDir);
  store.load();
  return new WebSessionIndex(store).getById(id);
}

/** Return every browser session belonging to the given Wairon user id. */
export function listWebSessionsBySubject(dataDir: string, userId: string): WebSession[] {
  const store = new WebSessionStore(dataDir);
  store.load();
  return new WebSessionIndex(store).listBySubject(userId);
}
