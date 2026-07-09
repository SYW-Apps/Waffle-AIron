import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendAuditEvent,
  queryAuditEvents,
  countAuditEvents,
  pruneAuditEvents,
  DEFAULT_AUDIT_POLICY,
} from '../../src/server/audit.js';
import type { AuditEvent, AuditRetentionPolicy, PrincipalSubject } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Audit Repository (sdd_host) — the durable, redacted audit log. Events are
// written to a real <dataDir>/audit-events.json through the exported facade so
// the store/registry/index composition (persistence, capture filter, redaction
// guard, retention pruning, and admin queries) is exercised end-to-end.
// ---------------------------------------------------------------------------

const ACTOR: PrincipalSubject = { userId: 'u-1', kind: 'human', issuer: 'local' };

function mkEvent(over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: '',
    timestamp: '2026-07-09T12:00:00.000Z',
    level: 'info',
    category: 'mcp',
    action: 'mcp.tool.call',
    outcome: 'success',
    actor: ACTOR,
    ...over,
  };
}

function policy(over: Partial<AuditRetentionPolicy> = {}): AuditRetentionPolicy {
  return { ...DEFAULT_AUDIT_POLICY, ...over };
}

describe('audit repository (sdd_host)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-audit-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── default policy ────────────────────────────────────────────────────────

  it('exposes the secure default audit policy', () => {
    expect(DEFAULT_AUDIT_POLICY).toEqual({
      enabled: true,
      minimumLevel: 'info',
      retentionDays: 90,
      securityRetentionDays: 365,
      includeReadEvents: false,
      metadataMode: 'redacted',
    });
  });

  // ── persistence ─────────────────────────────────────────────────────────

  it('persists an appended event that survives a reload from disk', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'token.mint', target: 'key-42' }), policy());

    // A fresh facade call re-reads the file, proving durability.
    const events = queryAuditEvents(dataDir, {});
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('token.mint');
    expect(events[0].target).toBe('key-42');
    // The file lives at <dataDir>/audit-events.json and is valid JSON.
    const raw = fs.readFileSync(path.join(dataDir, 'audit-events.json'), 'utf8');
    expect(JSON.parse(raw)).toHaveLength(1);
  });

  it('stamps a random id and a timestamp when they are absent', () => {
    appendAuditEvent(dataDir, mkEvent({ id: '', timestamp: '' }), policy());
    const [e] = queryAuditEvents(dataDir, {});
    expect(e.id).toMatch(/[0-9a-f-]{36}/);
    expect(Date.parse(e.timestamp)).not.toBeNaN();
  });

  // ── capture filter ────────────────────────────────────────────────────────

  it('is a silent no-op when the policy is disabled', () => {
    appendAuditEvent(dataDir, mkEvent(), policy({ enabled: false }));
    expect(queryAuditEvents(dataDir, {})).toHaveLength(0);
    expect(fs.existsSync(path.join(dataDir, 'audit-events.json'))).toBe(false);
  });

  it('drops events below the policy minimum level', () => {
    appendAuditEvent(dataDir, mkEvent({ level: 'debug' }), policy({ minimumLevel: 'info' }));
    expect(countAuditEvents(dataDir, {})).toBe(0);

    appendAuditEvent(dataDir, mkEvent({ level: 'warning' }), policy({ minimumLevel: 'info' }));
    expect(countAuditEvents(dataDir, {})).toBe(1);
  });

  it('excludes read events by default but includes them when the policy opts in', () => {
    const readEvent = mkEvent({ action: 'spec.read', outcome: 'success', target: 'sdd_get_status' });

    appendAuditEvent(dataDir, readEvent, policy({ includeReadEvents: false }));
    expect(countAuditEvents(dataDir, {})).toBe(0);

    appendAuditEvent(dataDir, readEvent, policy({ includeReadEvents: true }));
    expect(countAuditEvents(dataDir, {})).toBe(1);
  });

  it('captures a failed read-shaped action because only successful reads are excludable', () => {
    // outcome !== 'success' -> not a read -> captured even with includeReadEvents false.
    appendAuditEvent(dataDir, mkEvent({ action: 'spec.read', outcome: 'denied' }), policy({ includeReadEvents: false }));
    expect(countAuditEvents(dataDir, {})).toBe(1);
  });

  // ── redaction guard ───────────────────────────────────────────────────────

  it('rejects an event whose metadata looks like a bearer token', () => {
    expect(() =>
      appendAuditEvent(dataDir, mkEvent({ metadata: 'Authorization: Bearer sk-abcdef123456' }), policy()),
    ).toThrow(/rejected/i);
    // Nothing was persisted.
    expect(fs.existsSync(path.join(dataDir, 'audit-events.json'))).toBe(false);
  });

  it('rejects an event whose target carries a long hex secret', () => {
    const hex = 'a'.repeat(40);
    expect(() => appendAuditEvent(dataDir, mkEvent({ target: hex }), policy())).toThrow(/rejected/i);
  });

  // ── metadata mode ─────────────────────────────────────────────────────────

  it('drops metadata entirely under metadataMode "none"', () => {
    appendAuditEvent(dataDir, mkEvent({ metadata: 'diagnostic detail' }), policy({ metadataMode: 'none' }));
    const [e] = queryAuditEvents(dataDir, {});
    expect(e.metadata).toBeUndefined();
  });

  it('truncates oversize metadata under a redacted metadata mode', () => {
    const big = 'x'.repeat(5000);
    appendAuditEvent(dataDir, mkEvent({ metadata: big }), policy({ metadataMode: 'redacted' }));
    const [e] = queryAuditEvents(dataDir, {});
    expect(e.metadata).toBeDefined();
    expect(e.metadata!.length).toBe(2048);
  });

  // ── prune / retention ───────────────────────────────────────────────────

  it('removes only out-of-window events and honors the security retention override', () => {
    const now = '2026-07-09T00:00:00.000Z';
    const daysAgo = (n: number) => new Date(Date.parse(now) - n * 86_400_000).toISOString();

    // info event 100 days old -> beyond retentionDays (90) -> removed.
    appendAuditEvent(dataDir, mkEvent({ level: 'info', action: 'a.old', timestamp: daysAgo(100) }), policy());
    // info event 10 days old -> within 90 -> kept.
    appendAuditEvent(dataDir, mkEvent({ level: 'info', action: 'a.new', timestamp: daysAgo(10) }), policy());
    // security event 100 days old -> within securityRetentionDays (365) -> kept.
    appendAuditEvent(dataDir, mkEvent({ level: 'security', action: 'sec.old', timestamp: daysAgo(100) }), policy());

    const removed = pruneAuditEvents(dataDir, policy(), now);
    expect(removed).toBe(1);

    const remaining = queryAuditEvents(dataDir, {}).map((e) => e.action).sort();
    expect(remaining).toEqual(['a.new', 'sec.old']);
  });

  it('prunes nothing and returns zero when no window matches', () => {
    appendAuditEvent(dataDir, mkEvent({ timestamp: '2000-01-01T00:00:00.000Z' }), policy());
    // retentionDays 0 -> no positive window -> keep everything.
    const removed = pruneAuditEvents(dataDir, policy({ retentionDays: 0 }), '2026-07-09T00:00:00.000Z');
    expect(removed).toBe(0);
    expect(countAuditEvents(dataDir, {})).toBe(1);
  });

  // ── query / index ─────────────────────────────────────────────────────────

  it('filters by level ordering, time range, project, and outcome', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'e.info', level: 'info', projectId: 'p1', timestamp: '2026-07-01T00:00:00.000Z' }), policy());
    appendAuditEvent(dataDir, mkEvent({ action: 'e.error', level: 'error', projectId: 'p1', timestamp: '2026-07-05T00:00:00.000Z' }), policy());
    appendAuditEvent(dataDir, mkEvent({ action: 'e.warn', level: 'warning', projectId: 'p2', timestamp: '2026-07-08T00:00:00.000Z' }), policy());

    // minimumLevel 'warning' keeps warning + error, not info.
    const warnPlus = queryAuditEvents(dataDir, { minimumLevel: 'warning' }).map((e) => e.action).sort();
    expect(warnPlus).toEqual(['e.error', 'e.warn']);

    // project filter.
    expect(queryAuditEvents(dataDir, { projectId: 'p2' }).map((e) => e.action)).toEqual(['e.warn']);

    // inclusive time range.
    const inRange = queryAuditEvents(dataDir, {
      from: '2026-07-05T00:00:00.000Z',
      to: '2026-07-08T00:00:00.000Z',
    }).map((e) => e.action).sort();
    expect(inRange).toEqual(['e.error', 'e.warn']);
  });

  it('returns matches newest-first and applies the limit', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'oldest', timestamp: '2026-07-01T00:00:00.000Z' }), policy());
    appendAuditEvent(dataDir, mkEvent({ action: 'middle', timestamp: '2026-07-05T00:00:00.000Z' }), policy());
    appendAuditEvent(dataDir, mkEvent({ action: 'newest', timestamp: '2026-07-09T00:00:00.000Z' }), policy());

    const all = queryAuditEvents(dataDir, {}).map((e) => e.action);
    expect(all).toEqual(['newest', 'middle', 'oldest']);

    const limited = queryAuditEvents(dataDir, { limit: 2 }).map((e) => e.action);
    expect(limited).toEqual(['newest', 'middle']);
  });

  it('count applies the same filters but ignores the limit', () => {
    appendAuditEvent(dataDir, mkEvent({ action: 'c1', projectId: 'p1' }), policy());
    appendAuditEvent(dataDir, mkEvent({ action: 'c2', projectId: 'p1' }), policy());
    appendAuditEvent(dataDir, mkEvent({ action: 'c3', projectId: 'p2' }), policy());

    expect(countAuditEvents(dataDir, { projectId: 'p1', limit: 1 })).toBe(2);
    expect(countAuditEvents(dataDir, {})).toBe(3);
  });

  // ── store integrity ───────────────────────────────────────────────────────

  it('empty/missing store reads as no events', () => {
    expect(queryAuditEvents(dataDir, {})).toEqual([]);
    expect(countAuditEvents(dataDir, {})).toBe(0);
  });

  it('fails with a storage error naming the path when the file is malformed JSON', () => {
    const p = path.join(dataDir, 'audit-events.json');
    fs.writeFileSync(p, '{ not valid json');
    expect(() => queryAuditEvents(dataDir, {})).toThrow(p);
    expect(() => queryAuditEvents(dataDir, {})).toThrow(/malformed/i);
  });
});
