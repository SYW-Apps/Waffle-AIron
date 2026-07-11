import * as crypto from 'crypto';
import {
  type ApiKeyRecord,
  type Principal,
  type ProjectGrant,
  type Role,
  type ViewGrant,
  UNAUTHENTICATED,
} from './types.js';
import { findByTokenHash, hashToken } from './credentials.js';
import { getWebSessionById, WEB_SESSION_PREFIX } from './websessions.js';
import { resolveSecret } from '../utils/secrets.js';

// ---------------------------------------------------------------------------
// Auth Specialist (sdd_host)
//
// The single authentication authority. Data-plane bearer tokens verify against
// the credential registry; the control-plane master credential verifies against
// WAIRON_ADMIN_TOKEN (an env-injected secret) so the admin API can be reached
// before any project or key exists (the bootstrap chicken-and-egg). Performs no
// routing — only produces a Principal, resolving its subject and precise grants.
// ---------------------------------------------------------------------------

/** True once a credential record is past its expiresAt or has a revokedAt set. */
function isExpiredOrRevoked(rec: ApiKeyRecord): boolean {
  if (rec.revokedAt) return true;
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) return true;
  return false;
}

/** Compatibility projection of legacy role/projects into precise grants:
 *  admin → a single instance-wide grant; editor → an mcp:read/mcp:write grant
 *  per authorized project. */
function projectGrantsFromRole(role: Role, projects: string[]): ProjectGrant[] {
  if (role === 'admin') {
    return [{ projectId: '*', permissions: ['*'], role: 'admin' }];
  }
  return projects.map((projectId) => ({
    projectId,
    permissions: ['mcp:read', 'mcp:write'],
    role: 'editor',
  }));
}

/** Assemble an authenticated Principal from a matched credential record:
 *  subject from ownerSubject when present, grants from the record when present,
 *  otherwise projected from the compatibility role/projects. */
function principalFromRecord(rec: ApiKeyRecord): Principal {
  const principal: Principal = {
    tokenId: rec.id,
    role: rec.role,
    projects: rec.projects,
    authenticated: true,
    grants: rec.grants ?? projectGrantsFromRole(rec.role, rec.projects),
  };
  if (rec.ownerSubject) principal.subject = rec.ownerSubject;
  return principal;
}

/** Salted-hash lookup of a bearer token → authenticated Principal, rejecting
 *  (UNAUTHENTICATED) when no record matches or the record is expired/revoked. */
function resolveTokenPrincipal(dataDir: string, token: string | null): Principal {
  if (!token) return UNAUTHENTICATED;
  const rec = findByTokenHash(dataDir, hashToken(token));
  if (!rec) return UNAUTHENTICATED;
  if (isExpiredOrRevoked(rec)) return UNAUTHENTICATED;
  return principalFromRecord(rec);
}

/** Constant-time check of a presented credential against WAIRON_ADMIN_TOKEN. */
function masterMatches(credential: string | null): boolean {
  const master = process.env['WAIRON_ADMIN_TOKEN'];
  if (!master || !credential) return false;
  const a = Buffer.from(hashToken(credential), 'hex');
  const b = Buffer.from(hashToken(master), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The bootstrap/control-plane admin identity: admin over all projects, carrying
 *  a bootstrap subject and an instance-wide administrative grant. */
function bootstrapAdminPrincipal(): Principal {
  return {
    tokenId: 'admin:master',
    role: 'admin',
    projects: ['*'],
    authenticated: true,
    subject: {
      userId: 'bootstrap',
      kind: 'bootstrap',
      issuer: 'bootstrap',
      displayName: 'Bootstrap Administrator',
    },
    grants: [{ projectId: '*', permissions: ['*'], role: 'admin' }],
  };
}

/** Reverse of projectGrantsFromRole: derive the coarse role/projects
 *  compatibility projection from precise grants — any instance-wide ('*') grant →
 *  admin over ['*']; otherwise editor over the distinct granted project ids. Kept
 *  local (mirrors identity.ts's compatibilityProjection) because auth.ts must not
 *  import from identity.ts. */
function compatibilityProjectionFromGrants(grants: ProjectGrant[]): { role: Role; projects: string[] } {
  if (grants.some((g) => g.projectId === '*')) {
    return { role: 'admin', projects: ['*'] };
  }
  return { role: 'editor', projects: [...new Set(grants.map((g) => g.projectId))] };
}

/** The single, shared session-resolution path used by BOTH authenticateSession
 *  and the session branch of authenticateCredential, so the two can never diverge.
 *  Look up the browser session by id; reject an absent or expired (expiresAt at or
 *  before now) session as UNAUTHENTICATED. Otherwise assemble the same Principal
 *  shape a bearer token yields — subject and grants straight from the session, with
 *  the coarse role/projects compatibility projection derived from those grants and
 *  no credential-record lookup. The raw session id is a secret credential, so it is
 *  never used as the audit-facing tokenId (only a correlated tokenId, when present). */
function resolveSessionPrincipal(dataDir: string, sessionId: string): Principal {
  const session = getWebSessionById(dataDir, sessionId);
  if (!session) return UNAUTHENTICATED;
  if (Date.parse(session.expiresAt) <= Date.now()) return UNAUTHENTICATED;
  const { role, projects } = compatibilityProjectionFromGrants(session.grants);
  const principal: Principal = {
    tokenId: session.tokenId ?? '',
    role,
    projects,
    authenticated: true,
    subject: session.subject,
    grants: session.grants,
  };
  return principal;
}

/** Verify a data-plane bearer token to a Principal (or UNAUTHENTICATED). Resolves
 *  the Principal's subject and grants from the record (legacy records fall back to
 *  the role/projects projection); rejects expired or revoked records. */
export function authenticate(dataDir: string, token: string | null): Principal {
  return resolveTokenPrincipal(dataDir, token);
}

/** Verify the control-plane master credential to an admin Principal (or reject). */
export function authenticateMaster(token: string | null): Principal {
  if (!masterMatches(token)) return UNAUTHENTICATED;
  return { tokenId: 'admin:master', role: 'admin', projects: ['*'], authenticated: true };
}

/** The single control-plane entry point accepting three credential kinds: a browser
 *  web-session id (reserved prefix → resolved via the shared session helper, so a
 *  session authenticates every scoped endpoint exactly like a bearer token), the
 *  bootstrap/master credential (→ bootstrap admin Principal), or a stored bearer
 *  token (→ the same token path as authenticate, including expiry/revocation).
 *  The session branch is checked FIRST and shares resolveSessionPrincipal with
 *  authenticateSession so the two can never diverge. */
export function authenticateCredential(dataDir: string, credential: string | null): Principal {
  if (credential && credential.startsWith(WEB_SESSION_PREFIX)) {
    return resolveSessionPrincipal(dataDir, credential);
  }
  if (masterMatches(credential)) return bootstrapAdminPrincipal();
  return resolveTokenPrincipal(dataDir, credential);
}

/** Resolve a browser session id to a Principal — the auth bridge that lets the web
 *  UI reuse every scoped endpoint with a session cookie in place of a bearer token.
 *  An absent or expired session resolves to UNAUTHENTICATED (never throws), and a
 *  non-session credential (e.g. a bearer token) simply finds no session and is
 *  rejected — session ids only. Shares resolveSessionPrincipal with
 *  authenticateCredential's session branch (one code path, no divergence). */
export function authenticateSession(dataDir: string, sessionId: string): Principal {
  return resolveSessionPrincipal(dataDir, sessionId);
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

// ── Signed SSO state for the OIDC/SSO login round-trip ───────────────────────
//
// SSO state is a stateless capability: the authorize-redirect encodes an opaque
// login payload here and the callback verifies it, so no server-side session
// store is needed to detect tampering or replay. Signed with the same server
// signing authority as view tokens (WAIRON_SIGNING_SECRET, else
// WAIRON_ADMIN_TOKEN) and carries a short expiry (10 minutes — long enough for a
// human to complete an external login, short enough to bound replay).

const SSO_STATE_TTL_MS = 10 * 60 * 1000;

/** Mint a short-lived HMAC-signed SSO state binding an opaque login payload to an
 *  expiry, using the single server signing authority. */
export function signSsoState(payload: string): string {
  const body = Buffer.from(JSON.stringify({ payload, exp: Date.now() + SSO_STATE_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify an SSO state (signature + expiry, constant-time) and return the original
 *  payload, or throw on a tampered or expired state. */
export function verifySsoState(state: string): string {
  const [body, sig] = String(state).split('.');
  if (!body || !sig) throw new Error('invalid SSO state');
  const expected = crypto.createHmac('sha256', signingKey()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('invalid SSO state');
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { payload: string; exp: number };
  if (Date.now() > parsed.exp) throw new Error('expired SSO state');
  return parsed.payload;
}
