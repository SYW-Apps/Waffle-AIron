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
//                          expiry (authentication rejects expired sessions
//                          on resolution).
//   - facade             : the exported dataDir-first functions; pure 1:1
//                          forwarding (writes -> registry, reads -> index).
//
// The session id carries a RESERVED PREFIX (WEB_SESSION_PREFIX) and is itself a
// first-class credential: authentication recognizes it by that prefix and
// resolves it to a Principal exactly like a bearer token. Every write goes
// through write-temp-then-rename so a crashed write leaves the prior set intact —
// a lost session would silently sign a user out.
// ---------------------------------------------------------------------------

// The reserved session-id prefix lives with the WebSession types so transport
// code can brand-check a credential without importing this component's file.
import { WEB_SESSION_PREFIX } from './types.js';
import { readJsonForUpdate, replaceFile } from '../utils/fs.js';
import { withFileLock } from '../utils/file-lock.js';

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
/** The set as read under the write lock: absent is empty; unreadable or malformed throws and nothing is written. */
function readCurrent(p: string): WebSession[] {
  const parsed = readJsonForUpdate<unknown>(p, []);
  if (!Array.isArray(parsed)) {
    throw new Error(`Web session store at ${p} contains malformed JSON: expected a JSON array of web sessions`);
  }
  return parsed as WebSession[];
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
  /**
   * iweb_session_store.update — under web-sessions.json's write lock, read the
   * set fresh, apply the change and replace the file atomically; a change that
   * throws, or one that answers the array it was given, writes nothing.
   * Answers the set written.
   */
  update(change: (sessions: WebSession[]) => WebSession[]): WebSession[] {
    const p = storePath(this.dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    this.sessions = withFileLock(p, () => {
      const current = readCurrent(p);
      const before = JSON.stringify(current);
      const next = change(current);
      if (JSON.stringify(next) !== before) replaceFile(p, JSON.stringify(next, null, 2) + '\n');
      return next;
    });
    return this.sessions;
  }

  /** The current authoritative set (shared by reference with the index). */
  all(): WebSession[] {
    return this.sessions;
  }
}

// ── registry: write path ─────────────────────────────────────────────────────

class WebSessionRegistry {
  constructor(private readonly store: WebSessionStore) {}

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
    this.store.update((sessions) => [...sessions, stored]);
    return stored;
  }

  /**
   * Locate the session by id — a missing id is a silent no-op — update only its
   * lastSeenAt while preserving every other field, then persist and swap.
   */
  touch(id: string, lastSeenAt: string): void {
    this.store.update((sessions) => {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) return sessions;
      const next = [...sessions];
      next[idx] = { ...sessions[idx], lastSeenAt };
      return next;
    });
  }

  /**
   * Drop the session with the given id — a missing id is a silent no-op that
   * rewrites nothing — then persist the reduced set durably and swap it in.
   */
  remove(id: string): void {
    this.store.update((sessions) => (sessions.some((s) => s.id === id) ? sessions.filter((s) => s.id !== id) : sessions));
  }

  /**
   * Remove every session belonging to the given subject user id (correlated
   * revocation when a user is deactivated — a separate credential type from
   * tokens, so it must be swept too), persist and swap the reduced set, and
   * return the number removed. A user with no sessions is a no-op returning zero.
   */
  removeAllForSubject(userId: string): number {
    let removed = 0;
    this.store.update((sessions) => {
      const next = sessions.filter((s) => s.subject.userId !== userId);
      removed = sessions.length - next.length;
      return removed > 0 ? next : sessions;
    });
    return removed;
  }

  /**
   * Remove every session whose expiresAt is at or before the supplied instant,
   * persist and swap the reduced set, and return the number removed. A no-op
   * returns zero without rewriting unchanged state.
   */
  pruneExpired(now: string): number {
    const nowMs = Date.parse(now);
    let removed = 0;
    this.store.update((sessions) => {
      const next = sessions.filter((s) => Date.parse(s.expiresAt) > nowMs);
      removed = sessions.length - next.length;
      return removed > 0 ? next : sessions;
    });
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
  return new WebSessionRegistry(new WebSessionStore(dataDir)).create(session);
}

/** Update one session's lastSeenAt activity timestamp through the facade (atomic). */
export function touchWebSession(dataDir: string, id: string, lastSeenAt: string): void {
  new WebSessionRegistry(new WebSessionStore(dataDir)).touch(id, lastSeenAt);
}

/** Remove one session by id (sign-out / correlated revocation) through the facade (atomic). */
export function removeWebSession(dataDir: string, id: string): void {
  new WebSessionRegistry(new WebSessionStore(dataDir)).remove(id);
}

/** Delete sessions at or past their expiresAt; returns the count removed (atomic). */
export function pruneExpiredWebSessions(dataDir: string, now: string): number {
  return new WebSessionRegistry(new WebSessionStore(dataDir)).pruneExpired(now);
}

/** Remove every browser session belonging to the given user id (correlated
 *  revocation on deactivation); returns the count removed (atomic). */
export function removeAllWebSessionsForSubject(dataDir: string, userId: string): number {
  return new WebSessionRegistry(new WebSessionStore(dataDir)).removeAllForSubject(userId);
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
