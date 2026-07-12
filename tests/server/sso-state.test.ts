import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import { signSsoState, verifySsoState } from '../../src/server/auth.js';

// ---------------------------------------------------------------------------
// Auth Specialist (sdd_host) — stateless signed SSO state. Mirrors the view-token
// discipline: an opaque login payload is HMAC-signed with the server signing
// authority and bound to a short expiry, so the callback can detect tampering and
// replay without any server-side session store. The signing secret is fixed via
// WAIRON_SIGNING_SECRET so the HMAC is deterministic across a sign/verify pair.
// ---------------------------------------------------------------------------

describe('sso state (sdd_host auth specialist)', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // Pin the signing key and ensure no data-dir secret store shadows the env layer.
    delete process.env.WAIRON_DATA_DIR;
    process.env.WAIRON_SIGNING_SECRET = 'sso-state-signing-secret';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
  });

  it('round-trips: a freshly signed state verifies back to its payload', () => {
    expect(verifySsoState(signSsoState('login-payload'))).toBe('login-payload');
  });

  it('returns the exact original payload string (integrity across special characters)', () => {
    const payload = JSON.stringify({ redirect: '/app?a=1&b=2', nonce: 'x.y-z_0', s: 'ünîcödé', n: 42 });
    const back = verifySsoState(signSsoState(payload));
    expect(back).toBe(payload);
    // Same string identity, byte-for-byte.
    expect(Buffer.from(back).equals(Buffer.from(payload))).toBe(true);
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const state = signSsoState('original');
    const [body, sig] = state.split('.');
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { payload: string; exp: number };
    decoded.payload = 'tampered';
    const forgedBody = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    expect(() => verifySsoState(`${forgedBody}.${sig}`)).toThrow(/invalid SSO state/i);
  });

  it('rejects a tampered signature (same length, wrong key)', () => {
    const state = signSsoState('payload');
    const [body] = state.split('.');
    const forgedSig = crypto.createHmac('sha256', 'a-different-key').update(body).digest('base64url');
    expect(() => verifySsoState(`${body}.${forgedSig}`)).toThrow(/invalid SSO state/i);
  });

  it('rejects a structurally malformed state (no signature separator)', () => {
    expect(() => verifySsoState('not-a-signed-state')).toThrow(/invalid SSO state/i);
  });

  it('rejects an expired state once the short TTL has elapsed', () => {
    const base = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(base);
    const state = signSsoState('will-expire');
    // Still valid a minute in.
    clock.mockReturnValue(base + 60_000);
    expect(verifySsoState(state)).toBe('will-expire');
    // Past the documented 10-minute TTL → rejected as expired.
    clock.mockReturnValue(base + 11 * 60_000);
    expect(() => verifySsoState(state)).toThrow(/expired SSO state/i);
  });
});
