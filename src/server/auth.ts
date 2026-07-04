import * as crypto from 'crypto';
import { type Principal, UNAUTHENTICATED } from './types.js';
import { findByTokenHash, hashToken } from './credentials.js';

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
