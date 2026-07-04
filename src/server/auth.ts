import * as crypto from 'crypto';
import { type Principal, type ViewGrant, UNAUTHENTICATED } from './types.js';
import { findByTokenHash, hashToken } from './credentials.js';
import { resolveSecret } from '../utils/secrets.js';

// ---------------------------------------------------------------------------
// Auth Specialist (sdd_host)
//
// The single authentication authority. Data-plane bearer tokens verify against
// the credential registry; the control-plane master credential verifies against
// WAIRON_ADMIN_TOKEN (an env-injected secret) so the admin API can be reached
// before any project or key exists (the bootstrap chicken-and-egg). Performs no
// routing — only produces a Principal.
// ---------------------------------------------------------------------------

/** Verify a data-plane bearer token to a Principal (or UNAUTHENTICATED). */
export function authenticate(dataDir: string, token: string | null): Principal {
  if (!token) return UNAUTHENTICATED;
  const rec = findByTokenHash(dataDir, hashToken(token));
  if (!rec) return UNAUTHENTICATED;
  return { tokenId: rec.id, role: rec.role, projects: rec.projects, authenticated: true };
}

/** Verify the control-plane master credential to an admin Principal (or reject). */
export function authenticateMaster(token: string | null): Principal {
  const master = process.env['WAIRON_ADMIN_TOKEN'];
  if (!master || !token) return UNAUTHENTICATED;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hashToken(master), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return UNAUTHENTICATED;
  return { tokenId: 'admin:master', role: 'admin', projects: ['*'], authenticated: true };
}

// ── Signed capability tokens for browser diagram viewing ─────────────────────
//
// A view token is a capability: possessing a valid, unexpired signature grants
// read of exactly one project's diagram, so the /view route needs no bearer
// (browsers can't attach one to a navigation). Signed with WAIRON_SIGNING_SECRET
// (else WAIRON_ADMIN_TOKEN) so it can't be forged.

const VIEW_TTL_MS = 5 * 60 * 1000;

function signingKey(): string {
  return resolveSecret('signing-secret') || '';
}

/** Mint a short-lived HMAC-signed view token for one project's diagram. */
export function signViewToken(project: string, format: string): string {
  const body = Buffer.from(JSON.stringify({ project, format, exp: Date.now() + VIEW_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify a view token (signature + expiry, constant-time) to a ViewGrant, or throw. */
export function verifyViewToken(token: string): ViewGrant {
  const [body, sig] = String(token).split('.');
  if (!body || !sig) throw new Error('invalid view token');
  const expected = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('invalid view token');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { project: string; format: string; exp: number };
  if (Date.now() > payload.exp) throw new Error('expired view token');
  return { project: payload.project, format: payload.format, expiresAt: new Date(payload.exp).toISOString() };
}
