import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { AuditEvent, AuditQuery, AuditRetentionPolicy } from './types.js';

// ---------------------------------------------------------------------------
// Audit Repository (sdd_host)
//
// Durable, redacted hosted audit log, file-backed at <dataDir>/audit-events.json.
// Composition mirrors the spec tree:
//   - AuditStore    : authoritative in-memory holder of the event set, loaded
//                     from disk (missing file -> empty; corrupt -> storage error).
//   - AuditRegistry : the write path — policy-filtered append and retention
//                     pruning; owns redaction enforcement so no event carrying a
//                     raw secret ever reaches disk.
//   - AuditIndex    : the admin-only read path — filtered, newest-first queries
//                     and counts over the store's set; never mutates.
//   - facade        : the exported append/query/count/prune functions the rest
//                     of the server calls; pure 1:1 forwarding to the roles above.
//
// The audit trail is the record of who did what: the store never silently drops
// persisted history, and every write goes through write-temp-then-rename so a
// crashed write leaves the prior set fully intact.
// ---------------------------------------------------------------------------

/** Ordered event severity: an event is captured only at or above the policy's
 *  minimumLevel, using this exact ordering. Unknown levels rank as 'info'. */
const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
  security: 4,
};

function levelRank(level: string): number {
  return LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
}

/** Milliseconds per day, for retention-window math. */
const DAY_MS = 86_400_000;

/** Upper bound on persisted metadata; anything larger is truncated by policy so
 *  a full spec body or oversize diagnostic can never bloat the audit file. */
const METADATA_CAP = 2048;

/** The design doc's secure default: capture info+ events, keep them 90 days
 *  (security events a year), skip high-volume reads, and persist redacted
 *  metadata only. */
export const DEFAULT_AUDIT_POLICY: AuditRetentionPolicy = {
  enabled: true,
  minimumLevel: 'info',
  retentionDays: 90,
  securityRetentionDays: 365,
  includeReadEvents: false,
  metadataMode: 'redacted',
};

// ── file helpers ───────────────────────────────────────────────────────────

function storePath(dataDir: string): string {
  return path.join(dataDir, 'audit-events.json');
}

/**
 * Read the persisted event set. A missing file yields an empty set; an
 * unreadable file or structurally invalid JSON fails with a storage error
 * naming the path — the audit trail is never silently dropped.
 */
function readEvents(dataDir: string): AuditEvent[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Failed to read audit store at ${p}: ${(e as Error).message}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array of audit events');
    return parsed as AuditEvent[];
  } catch (e) {
    throw new Error(`Audit store at ${p} contains malformed JSON: ${(e as Error).message}`);
  }
}

/** Persist the complete event set atomically (write temp, then rename). */
function persistEvents(dataDir: string, events: AuditEvent[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(events, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── redaction / capture predicates ─────────────────────────────────────────

/** Bearer-token prefix or a 32+ character hex run: the shapes a raw credential
 *  or secret leaks in as. Used to reject un-redacted events before they persist. */
const SECRET_RE = /Bearer\s+\S/i;
const LONG_HEX_RE = /[0-9a-fA-F]{32,}/;

function looksLikeSecret(value: string): boolean {
  return SECRET_RE.test(value) || LONG_HEX_RE.test(value);
}

/**
 * Conservative read-event derivation for the capture filter. An event counts as
 * a (high-volume, excludable) read only when it clearly succeeded AND names a
 * read-only operation, i.e. ALL of:
 *   - outcome === 'success', AND
 *   - target starts with 'sdd_get' or 'sdd_validate', OR
 *     action ends with '.read', '.list', or '.query'.
 * Anything else (writes, denials, failures, ambiguous actions) is treated as a
 * non-read and captured, so the filter never hides a mutation or a denial.
 */
function isReadEvent(event: AuditEvent): boolean {
  if (event.outcome !== 'success') return false;
  const target = event.target ?? '';
  const action = event.action ?? '';
  return (
    target.startsWith('sdd_get') ||
    target.startsWith('sdd_validate') ||
    action.endsWith('.read') ||
    action.endsWith('.list') ||
    action.endsWith('.query')
  );
}

// ── store: authoritative in-memory holder ──────────────────────────────────

class AuditStore {
  private events: AuditEvent[] = [];
  constructor(private readonly dataDir: string) {}

  /** Load the persisted set into the authoritative in-memory representation. */
  load(): AuditEvent[] {
    this.events = readEvents(this.dataDir);
    return this.events;
  }

  /** Swap the in-memory set to a complete replacement in one assignment. Only
   *  called by the registry after durable persistence has succeeded, so index
   *  reads always observe a consistent set. */
  replaceAll(events: AuditEvent[]): void {
    this.events = events;
  }

  /** The current authoritative set (shared by reference with the index). */
  all(): AuditEvent[] {
    return this.events;
  }
}

// ── registry: policy-filtered write path ───────────────────────────────────

class AuditRegistry {
  constructor(private readonly dataDir: string, private readonly store: AuditStore) {}

  append(event: AuditEvent, policy: AuditRetentionPolicy): void {
    // (1) Capture filter — drop without touching disk (silent, successful no-op).
    if (!policy.enabled) return;
    if (levelRank(event.level) < levelRank(policy.minimumLevel)) return;
    if (!policy.includeReadEvents && isReadEvent(event)) return;

    // (2) Redaction guard — reject anything that still smells like a raw secret,
    //     checking the original target and metadata before any transformation.
    for (const field of [event.target, event.metadata]) {
      if (field && looksLikeSecret(field)) {
        throw new Error(
          `Audit event "${event.action}" rejected: target or metadata contains what looks ` +
            `like a raw credential; redact secrets before auditing.`,
        );
      }
    }

    // Apply the metadata mode: 'none' drops metadata entirely; any other mode
    // persists it but truncated to the size cap.
    let metadata = event.metadata;
    if (policy.metadataMode === 'none') {
      metadata = undefined;
    } else if (metadata !== undefined && metadata.length > METADATA_CAP) {
      metadata = metadata.slice(0, METADATA_CAP);
    }

    // (3) Stamp id + timestamp if absent, persist, then refresh the store.
    const stamped: AuditEvent = {
      ...event,
      id: event.id && event.id.length > 0 ? event.id : crypto.randomUUID(),
      timestamp: event.timestamp && event.timestamp.length > 0 ? event.timestamp : new Date().toISOString(),
      metadata,
    };

    const next = [...this.store.all(), stamped];
    persistEvents(this.dataDir, next);
    this.store.replaceAll(next);
  }

  prune(policy: AuditRetentionPolicy, now: string): number {
    const nowMs = Date.parse(now);
    const kept: AuditEvent[] = [];
    let removed = 0;

    for (const event of this.store.all()) {
      const windowDays = retentionWindowDays(event, policy);
      // No positive window means "keep forever" for this event.
      if (windowDays === undefined || !(windowDays > 0)) {
        kept.push(event);
        continue;
      }
      const ageMs = nowMs - Date.parse(event.timestamp);
      if (ageMs > windowDays * DAY_MS) {
        removed++;
      } else {
        kept.push(event);
      }
    }

    if (removed > 0) {
      persistEvents(this.dataDir, kept);
      this.store.replaceAll(kept);
    }
    return removed;
  }
}

/** The retention window (in days) an event maps to: security events use
 *  securityRetentionDays when it is set, otherwise every event uses
 *  retentionDays. */
function retentionWindowDays(event: AuditEvent, policy: AuditRetentionPolicy): number | undefined {
  if (event.level === 'security' && policy.securityRetentionDays !== undefined) {
    return policy.securityRetentionDays;
  }
  return policy.retentionDays;
}

// ── index: admin-only read path ────────────────────────────────────────────

class AuditIndex {
  constructor(private readonly store: AuditStore) {}

  query(query: AuditQuery): AuditEvent[] {
    const matched = this.store.all().filter((e) => matchesQuery(e, query));
    matched.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    if (query.limit !== undefined && query.limit >= 0) {
      return matched.slice(0, query.limit);
    }
    return matched;
  }

  count(query: AuditQuery): number {
    return this.store.all().filter((e) => matchesQuery(e, query)).length;
  }
}

/** True when the event satisfies every populated filter of the query. Unset
 *  fields match everything. */
function matchesQuery(event: AuditEvent, q: AuditQuery): boolean {
  if (q.projectId !== undefined && event.projectId !== q.projectId) return false;
  if (q.actorUserId !== undefined && event.actor?.userId !== q.actorUserId) return false;
  if (q.tokenId !== undefined && event.tokenId !== q.tokenId) return false;
  if (q.category !== undefined && event.category !== q.category) return false;
  if (q.action !== undefined && event.action !== q.action) return false;
  if (q.outcome !== undefined && event.outcome !== q.outcome) return false;
  if (q.minimumLevel !== undefined && levelRank(event.level) < levelRank(q.minimumLevel)) return false;
  if (q.from !== undefined && Date.parse(event.timestamp) < Date.parse(q.from)) return false;
  if (q.to !== undefined && Date.parse(event.timestamp) > Date.parse(q.to)) return false;
  return true;
}

// ── repository facade ──────────────────────────────────────────────────────
//
// Pure 1:1 forwarding. Each call materializes the authoritative set from disk
// (mirroring the rest of the server's read-fresh-per-call storage style), wires
// the store/registry/index over it, and forwards. Appends and prunes go to the
// registry; queries and counts to the index.

/**
 * Append one redacted audit event if the policy says it should be persisted.
 * Rejects raw-token/secret/full-spec metadata. Persistence failures surface as
 * storage errors — hot-path callers must treat append failure as non-blocking.
 */
export function appendAuditEvent(dataDir: string, event: AuditEvent, policy: AuditRetentionPolicy): void {
  const store = new AuditStore(dataDir);
  store.load();
  new AuditRegistry(dataDir, store).append(event, policy);
}

/** Return redacted audit events matching an admin query filter, newest-first. */
export function queryAuditEvents(dataDir: string, query: AuditQuery): AuditEvent[] {
  const store = new AuditStore(dataDir);
  store.load();
  return new AuditIndex(store).query(query);
}

/** Count redacted audit events matching an admin query filter (ignores limit). */
export function countAuditEvents(dataDir: string, query: AuditQuery): number {
  const store = new AuditStore(dataDir);
  store.load();
  return new AuditIndex(store).count(query);
}

/** Apply the retention policy and delete expired events; returns removed count. */
export function pruneAuditEvents(dataDir: string, policy: AuditRetentionPolicy, now: string): number {
  const store = new AuditStore(dataDir);
  store.load();
  return new AuditRegistry(dataDir, store).prune(policy, now);
}
