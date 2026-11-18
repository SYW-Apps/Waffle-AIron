import { describe, it, expect, vi, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import * as viewCache from '../../src/server/view-cache.js';
import { findingsWithin, outdateViews, GATE_WAIT_MS } from '../../src/server/web.js';
import { publishChange, publishNudge } from '../../src/server/realtime.js';
import { sendJsonTagged } from '../../src/server/httpio.js';
import type { ValidationIssue, ValidationResult } from '../../src/core/validation.js';
import type { WebGraphModel } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// web_view_cache (sdd_host): the built views the server keeps between reads,
// the findings a rebuild draws while the gate runs on, and the realtime
// publication that outdates them.
// ---------------------------------------------------------------------------

const issue = (specId: string): ValidationIssue => ({ severity: 'error', code: 'X', message: 'x', specId }) as ValidationIssue;
const graph = (scope: string): WebGraphModel => ({ tier: 'project', nodes: [], edges: [], level: 0, generatedAt: '2026-11-13T00:00:00.000Z', scope });

describe('web view cache (sdd_host)', () => {
  it('keeps a view under its key, answers it current or not, and outdating keeps view and findings', () => {
    const key = 'test\u0000keep';
    expect(viewCache.read(key)).toBeUndefined();
    const view = { model: graph('a'), issues: [issue('a')], current: true };
    viewCache.write(key, view);
    expect(viewCache.read(key)).toBe(view);

    const before = viewCache.version();
    viewCache.outdate();
    expect(viewCache.version()).toBe(before + 1);
    const kept = viewCache.read(key)!;
    expect(kept.current).toBe(false);
    expect(kept.model).toBe(view.model);
    expect(kept.issues).toEqual([issue('a')]);

    const replaced = { model: graph('b'), issues: [], current: true };
    viewCache.write(key, replaced);
    expect(viewCache.read(key)).toBe(replaced);
  });

  it('a published change outdates every kept view; a nudge leaves them current', () => {
    const key = 'test\u0000publish';
    viewCache.write(key, { model: graph('a'), issues: [], current: true });
    publishNudge('project:test');
    expect(viewCache.read(key)!.current).toBe(true);
    const before = viewCache.version();
    publishChange('project:test');
    expect(viewCache.read(key)!.current).toBe(false);
    expect(viewCache.version()).toBe(before + 1);

    viewCache.write(key, { model: graph('a'), issues: [], current: true });
    outdateViews();
    expect(viewCache.read(key)!.current).toBe(false);
  });
});

describe('findings drawn while the gate runs (sdd_host)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const answer = (issues: ValidationIssue[]): Promise<ValidationResult> => Promise.resolve({ valid: issues.length === 0, issues } as ValidationResult);

  it('draws the gate\'s findings as current when it answers within the wait', async () => {
    const drawn = await findingsWithin(answer([issue('a')]), undefined, 'none');
    expect(drawn).toEqual({ issues: [issue('a')], state: 'current' });
  });

  it('draws the kept view\'s findings as stale, or none as pending, when the gate is late', async () => {
    vi.useFakeTimers();
    const late = new Promise<ValidationResult>(() => {});
    const kept = { model: graph('a'), issues: [issue('k')], current: false };
    const stale = findingsWithin(late, kept, 'none');
    await vi.advanceTimersByTimeAsync(GATE_WAIT_MS + 1);
    expect(await stale).toEqual({ issues: [issue('k')], state: 'stale' });

    const pending = findingsWithin(late, undefined, 'none');
    await vi.advanceTimersByTimeAsync(GATE_WAIT_MS + 1);
    expect(await pending).toEqual({ issues: [], state: 'pending' });
  });

  it('a gate that fails draws no findings, or fails the read when asked to', async () => {
    const failing = (): Promise<ValidationResult> => Promise.reject(new Error('gate down'));
    expect(await findingsWithin(failing(), undefined, 'none')).toEqual({ issues: [], state: 'current' });
    await expect(findingsWithin(failing(), undefined, 'throw')).rejects.toThrow('gate down');
  });

  it('a gate that fails after the wait raises no unhandled rejection', async () => {
    vi.useFakeTimers();
    let fail: (err: Error) => void = () => {};
    const late = new Promise<ValidationResult>((_, reject) => { fail = reject; });
    const drawn = findingsWithin(late, undefined, 'throw');
    await vi.advanceTimersByTimeAsync(GATE_WAIT_MS + 1);
    expect((await drawn).state).toBe('pending');
    // The read's own nudge path holds the late promise; the drawn answer's copy is handled.
    late.catch(() => undefined);
    fail(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(1);
  });
});

describe('tagged JSON answer (sdd_host)', () => {
  function capture(ifNoneMatch?: string): { req: IncomingMessage; res: ServerResponse; out: { status?: number; headers?: Record<string, string>; body?: string } } {
    const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
    const req = { headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {} } as unknown as IncomingMessage;
    const res = {
      writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; },
      end(body?: string) { out.body = body ?? ''; },
    } as unknown as ServerResponse;
    return { req, res, out };
  }

  it('answers the whole body, stamp included, tagged without the stamp', () => {
    const a = capture();
    const body = { tier: 'project', generatedAt: '2026-11-13T01:00:00.000Z', nodes: [1, 2] };
    sendJsonTagged(a.req, a.res, body);
    expect(a.out.status).toBe(200);
    expect(JSON.parse(a.out.body!)).toEqual(body);

    // The same content stamped later carries the same tag, and a read holding it is answered 304.
    const b = capture(a.out.headers!.etag);
    sendJsonTagged(b.req, b.res, { ...body, generatedAt: '2026-11-13T02:00:00.000Z' });
    expect(b.out.status).toBe(304);
    expect(b.out.body).toBe('');

    const c = capture();
    sendJsonTagged(c.req, c.res, { ...body, nodes: [3] });
    expect(c.out.headers!.etag).not.toBe(a.out.headers!.etag);
  });

  it('answers a body with only a stamp, and one with none', () => {
    const a = capture();
    sendJsonTagged(a.req, a.res, { generatedAt: 'now' });
    expect(JSON.parse(a.out.body!)).toEqual({ generatedAt: 'now' });
    const b = capture();
    sendJsonTagged(b.req, b.res, [1, 2]);
    expect(JSON.parse(b.out.body!)).toEqual([1, 2]);
  });
});
