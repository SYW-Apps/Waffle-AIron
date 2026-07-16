import * as crypto from 'crypto';
import {
  type ApiKeyRecord,
  type HostConfig,
  type PermissionSubject,
  type Principal,
  type PrincipalSubject,
  type ViewGrant,
  UNAUTHENTICATED,
} from './types.js';
import { findByTokenHash, hashToken } from './credentials.js';
import { getWebSessionById, WEB_SESSION_PREFIX } from './websessions.js';
import { getUserById } from './users.js';
import { getInstanceIdentity } from './instance.js';
import { resolveSecret } from '../utils/secrets.js';

// ---------------------------------------------------------------------------
// Auth Specialist (sdd_host)
//
// The single authentication authority. Data-plane bearer tokens verify against
// the credential registry; the control-plane master credential verifies against
// WAIRON_ADMIN_TOKEN (an env-injected secret) so the admin API can be reached
// before any project or key exists (the bootstrap chicken-and-egg). Performs no
// routing — it only produces a Principal.
//
// A Principal carries NO permissions of its own. It carries a resolved
// permissionSubject (subjectId + roleBindings + instanceAdmin) that the
// permission resolver evaluates per request, so a token always acts as its
// owner's LIVE permission and can never outlive or exceed it.
// ---------------------------------------------------------------------------

/** LEGACY reserved literal — the built-in super-admin's former guessable
 *  userId. No longer a live subject id (the persisted boot-reserved UUID is),
 *  but it stays UNCLAIMABLE by user records for defense-in-depth. */
export const LEGACY_SUPERADMIN_USER_ID = 'builtin:superadmin';

/** LEGACY reserved literal — the synthetic local-developer subject's former
 *  guessable userId. No longer a live subject id; stays unclaimable. */
export const LEGACY_LOCALDEV_USER_ID = 'builtin:localdev';

/** The issuer the built-in subjects are minted under. */
const LOCAL_ISSUER = 'local';

/**
 * Legacy literal subject ids that are reserved forever: a hosted user record may
 * never claim one (isReservedSubject), or legacy data referencing them could
 * collide with a resurrected identity. The LIVE built-in ids are the persisted
 * boot-reserved UUIDs in <dataDir>/instance.json (UUID = unguessable, this
 * guard = unclaimable).
 */
export const RESERVED_SUBJECT_IDS: readonly string[] = [
  LEGACY_SUPERADMIN_USER_ID,
  LEGACY_LOCALDEV_USER_ID,
];

/**
 * True ONLY for the subjects that hold the resolver bypass:
 *   - the built-in super-admin, matched on the FULL tuple (issuer 'local' AND
 *     userId === the PERSISTED boot-reserved super-admin UUID) so an SSO
 *     provider issuing that userId under its own issuer can never collide into
 *     the bypass — and an unseeded instance recognizes NOBODY (fail closed);
 *   - the synthetic local-developer subject, likewise matched on the full tuple
 *     against the persisted local-developer UUID. It exists only when
 *     `wairon dev` minted it (startDevSession is devMode-only and is the sole
 *     minter), and the reserved-id guard stops a user record from impersonating
 *     it;
 *   - the bootstrap/master credential.
 *
 * instanceAdmin is determined by SUBJECT IDENTITY, never by a roleBinding or an
 * assignment. A regular user is never instanceAdmin — a delegated instance-wide
 * admin holds project:admin@instance, which resolves as a normal OVERRIDABLE
 * permission, not the bypass.
 */
function isInstanceAdminSubject(dataDir: string, subject: PrincipalSubject | undefined): boolean {
  if (!subject) return false;
  if (subject.kind === 'bootstrap' && subject.issuer === 'bootstrap') return true;
  if (subject.issuer !== LOCAL_ISSUER) return false;
  const identity = getInstanceIdentity(dataDir);
  if (!identity) return false; // unseeded instance: no recognizable built-ins
  return subject.userId === identity.superadminUserId || subject.userId === identity.localDevUserId;
}

/**
 * Reserved-subject guard: true when the candidate userId is an id user records
 * may NEVER claim — the persisted boot-reserved super-admin or local-developer
 * UUID, or a legacy reserved literal ('builtin:superadmin' / 'builtin:localdev').
 * Defense-in-depth companion to the UUID scheme (UUID = unguessable, guard =
 * unclaimable); identity.upsertUser enforces it on every user write so an
 * admin-created user can never inherit the built-in bypass.
 */
export function isReservedSubject(dataDir: string, userId: string): boolean {
  if (RESERVED_SUBJECT_IDS.includes(userId)) return true;
  const identity = getInstanceIdentity(dataDir);
  if (!identity) return false;
  return userId === identity.superadminUserId || userId === identity.localDevUserId;
}

/**
 * Resolve a credential's subject to its LIVE permission subject.
 *
 * roleBindings are read fresh from the user record on every authentication, so
 * revoking a role takes effect immediately for existing tokens. Returns null when
 * the owner user exists but is not active — defense in depth behind
 * revokeAllForOwner, so a deactivated user cannot act even if a credential
 * somehow survived the revocation sweep.
 */
function resolvePermissionSubject(
  dataDir: string,
  subject: PrincipalSubject | undefined,
): PermissionSubject | null {
  const subjectId = subject?.userId ?? '';
  if (isInstanceAdminSubject(dataDir, subject)) {
    // The env-anchored subjects have no user record — bindings are irrelevant
    // because the resolver bypasses the walk for them entirely.
    return { subjectId, roleBindings: [], instanceAdmin: true };
  }
  if (!subjectId) {
    return { subjectId: '', roleBindings: [], instanceAdmin: false };
  }
  const user = getUserById(dataDir, subjectId);
  if (user && user.status !== 'active') return null;
  return { subjectId, roleBindings: user?.roleBindings ?? [], instanceAdmin: false };
}

/** True once a credential record is past its expiresAt or has a revokedAt set. */
function isExpiredOrRevoked(rec: ApiKeyRecord): boolean {
  if (rec.revokedAt) return true;
  if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) return true;
  return false;
}

/**
 * Assemble an authenticated Principal from a matched credential record: the
 * subject from ownerSubject, the token's project narrowing from the record, and
 * the permissionSubject resolved LIVE from the owner's user record. The record's
 * role/projects remain a coarse DISPLAY projection only. A record whose owner is
 * no longer active resolves to UNAUTHENTICATED.
 */
function principalFromRecord(dataDir: string, rec: ApiKeyRecord): Principal {
  const permissionSubject = resolvePermissionSubject(dataDir, rec.ownerSubject);
  if (!permissionSubject) return UNAUTHENTICATED;
  const principal: Principal = {
    tokenId: rec.id,
    role: rec.role ?? 'editor',
    projects: rec.projects,
    authenticated: true,
    permissionSubject,
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
  return principalFromRecord(dataDir, rec);
}

/** Constant-time check of a presented credential against WAIRON_ADMIN_TOKEN. */
function masterMatches(credential: string | null): boolean {
  const master = process.env['WAIRON_ADMIN_TOKEN'];
  if (!master || !credential) return false;
  const a = Buffer.from(hashToken(credential), 'hex');
  const b = Buffer.from(hashToken(master), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The bootstrap/control-plane admin identity: the env-anchored master credential,
 *  which holds the instance-admin bypass by subject identity. */
function bootstrapAdminPrincipal(): Principal {
  const subject: PrincipalSubject = {
    userId: 'bootstrap',
    kind: 'bootstrap',
    issuer: 'bootstrap',
    displayName: 'Bootstrap Administrator',
  };
  return {
    tokenId: 'admin:master',
    role: 'admin',
    projects: ['*'],
    authenticated: true,
    subject,
    permissionSubject: { subjectId: subject.userId, roleBindings: [], instanceAdmin: true },
  };
}

/** The coarse role/projects DISPLAY projection for a session. Not an authority
 *  source — every decision resolves from permissionSubject. */
function displayProjection(permissionSubject: PermissionSubject, projects: string[]): {
  role: Principal['role'];
  projects: string[];
} {
  if (permissionSubject.instanceAdmin) return { role: 'admin', projects: ['*'] };
  return { role: 'editor', projects };
}

/** The single, shared session-resolution path used by BOTH authenticateSession
 *  and the session branch of authenticateCredential, so the two can never diverge.
 *  Look up the browser session by id; reject an absent or expired (expiresAt at or
 *  before now) session as UNAUTHENTICATED. Otherwise assemble the same Principal
 *  shape a bearer token yields — the subject and project narrowing straight from
 *  the session, with the permissionSubject resolved LIVE (the session stores no
 *  permissions of its own). The raw session id is a secret credential, so it is
 *  never used as the audit-facing tokenId (only a correlated tokenId, when present). */
function resolveSessionPrincipal(dataDir: string, sessionId: string): Principal {
  const session = getWebSessionById(dataDir, sessionId);
  if (!session) return UNAUTHENTICATED;
  if (Date.parse(session.expiresAt) <= Date.now()) return UNAUTHENTICATED;
  const permissionSubject = resolvePermissionSubject(dataDir, session.subject);
  if (!permissionSubject) return UNAUTHENTICATED;
  const { role, projects } = displayProjection(permissionSubject, session.projects);
  return {
    tokenId: session.tokenId ?? '',
    role,
    projects,
    authenticated: true,
    subject: session.subject,
    permissionSubject,
  };
}

/** Verify a data-plane bearer token to a Principal (or UNAUTHENTICATED). Resolves
 *  the Principal's subject from the record and its permissionSubject LIVE from the
 *  owner's user record; rejects expired or revoked records, and a record whose
 *  owner is no longer active. */
export function authenticate(dataDir: string, token: string | null): Principal {
  return resolveTokenPrincipal(dataDir, token);
}

/** Verify the control-plane master credential to the bootstrap admin Principal
 *  (or reject). The master holds the env-anchored instance-admin bypass. */
export function authenticateMaster(token: string | null): Principal {
  if (!masterMatches(token)) return UNAUTHENTICATED;
  return bootstrapAdminPrincipal();
}

// ── Built-in super-admin web login (WAIRON_ADMIN_USER / WAIRON_ADMIN_PASSWORD) ─

/** Constant-time equality of two strings via fixed-length salted digests: hashing
 *  first normalizes both sides to equal-length buffers, so timingSafeEqual applies
 *  and the comparison leaks neither content nor length. */
function hashedEquals(a: string, b: string): boolean {
  const ha = Buffer.from(hashToken(a), 'hex');
  const hb = Buffer.from(hashToken(b), 'hex');
  return ha.length === hb.length && crypto.timingSafeEqual(ha, hb);
}

/**
 * Verify the built-in super-admin web-login credentials against the env-injected
 * WAIRON_ADMIN_USER / WAIRON_ADMIN_PASSWORD pair carried on the host configuration.
 * CONSTANT-TIME: both the username and the password are hashed to fixed-length
 * digests and compared with a timing-safe equality, and BOTH comparisons are always
 * evaluated before branching, so no user-enumeration or early-exit timing signal
 * exists. When either configured value is unset, password login is DISABLED and
 * every attempt resolves to null (the server still starts — SSO-only posture). On a
 * full match, returns the stable built-in super-admin subject (userId = the
 * PERSISTED boot-reserved super-admin UUID — never an account-name-derived id);
 * on any mismatch, or when the instance identity has never been seeded, returns
 * null. Never throws and performs no session, throttle, or audit work — the web
 * orchestrator owns the session mint and the failed-attempt throttle.
 */
export function verifyBuiltinAdmin(cfg: HostConfig, user: string, password: string): PrincipalSubject | null {
  const configuredUser = cfg.builtinAdminUser ?? '';
  const configuredPassword = cfg.builtinAdminPassword ?? '';
  if (!configuredUser || !configuredPassword) {
    return null; // password login disabled (SSO-only) — steps 1–2
  }
  // steps 3–4: ALWAYS evaluate both comparisons before branching (no early exit).
  const userMatches = hashedEquals(String(user ?? ''), configuredUser);
  const passwordMatches = hashedEquals(String(password ?? ''), configuredPassword);
  if (!(userMatches && passwordMatches)) {
    return null; // steps 5–6: same path/timing for a wrong user and a wrong password
  }
  // step 7: the persisted boot-reserved built-in subject UUIDs (fail closed when
  // the instance has never been seeded — the lifecycle init entrypoint seeds them).
  const identity = getInstanceIdentity(cfg.dataDir);
  if (!identity) return null;
  // steps 8–9: the stable built-in super-admin subject.
  return { userId: identity.superadminUserId, kind: 'human', issuer: 'local' };
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
  // Fail CLOSED: an empty HMAC key would make view tokens and SSO state forgeable
  // by anyone. The hosted server refuses to start without WAIRON_ADMIN_TOKEN, so
  // this only guards the --no-auth path and any direct caller — never silently
  // sign/verify with a blank key.
  const key = resolveSecret('signing-secret');
  if (!key) {
    throw new Error('No signing secret available — set WAIRON_SIGNING_SECRET or WAIRON_ADMIN_TOKEN.');
  }
  return key;
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
