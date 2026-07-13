import * as crypto from 'crypto';
import { resolveSecret } from '../utils/secrets.js';
import type { IdentityProviderConfig, PrincipalSubject, ProviderEndpoints } from './types.js';

// ---------------------------------------------------------------------------
// Identity Provider Adapter (sdd_host) — OIDC/SSO.
//
// The only block that talks to an external OIDC provider. It resolves each
// provider's concrete endpoints (explicit config overrides -> OIDC discovery ->
// providerType template), assembles browser authorization URLs against the
// front-channel authorize endpoint, exchanges authorization codes over the
// back-channel token endpoint (which may be VPC-internal), and verifies the
// returned id_token against the provider JWKS before mapping the verified claims
// to a Wairon PrincipalSubject. It performs provider I/O only: it never persists,
// logs, or returns raw provider tokens (access/refresh/id) or the client secret.
//
// Async note: the L3 interface declares synchronous string returns, but endpoint
// resolution, code exchange, and JWKS verification are all network I/O, so
// `resolveEndpoints`, `exchangeCode`, and `resolveSubject` are implemented async
// (returning Promises). This mirrors the Notion Client Adapter, whose L3 declares
// `sync(...): void` yet is implemented as `async ...: Promise<void>`.
// `buildAuthorizationUrl` stays synchronous per its signature.
//
// Split-horizon: an explicit front-channel authorizationEndpoint (public) may
// coexist with an internal tokenEndpoint/jwksUri (back-channel). No HTTPS/public
// enforcement — an operator may point the back-channel at a VPC-internal host.
// ---------------------------------------------------------------------------

/** OIDC scopes requested for sign-in: identity + email + basic profile. */
const REQUESTED_SCOPE = 'openid email profile';

/** In-adapter, transient discovery-document cache keyed by issuer. NOT a store:
 *  it holds no authoritative state, is refetchable at any time, and exists only to
 *  keep endpoint resolution cheap on the hot path. */
const discoveryCache = new Map<string, OidcDiscoveryDocument>();

/** A JSON Web Key (Node's crypto JWK shape). Aliased so it works under Node lib
 *  types without pulling in the DOM lib's global JsonWebKey. */
type Jwk = crypto.JsonWebKey;

/** In-adapter, transient JWKS cache keyed by jwks URI. Refetched on an unknown key
 *  id (provider key rotation). Also NOT a store — pure I/O acceleration. */
const jwksCache = new Map<string, Jwk[]>();

/** Clear the in-adapter discovery/JWKS caches. Test hook only; production never
 *  needs it (caches are transient and refetch on rotation). */
export function __clearIdpCaches(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

/** The subset of an OIDC discovery document this adapter reads. */
interface OidcDiscoveryDocument {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  jwks_uri?: string;
  userinfo_endpoint?: string;
}

/** The redacted provider response summary carried between exchangeCode and
 *  resolveSubject. Serialized as JSON; carries the id_token needed for downstream
 *  signature verification plus its decoded claims — never a raw access_token,
 *  refresh_token, or the client secret. */
interface RedactedSummary {
  /** The raw id_token JWT — the identity assertion resolveSubject verifies. It is
   *  NOT an access/refresh token; it is the signed claim set the provider issued. */
  idToken: string;
  idTokenClaims: IdTokenClaims;
  tokenType: string;
}

/** Decoded ID-token payload claims (only the fields this adapter reads). */
interface IdTokenClaims {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  email?: string;
  name?: string;
  groups?: string[];
}

/** Raw provider token response (fields this adapter reads); never returned. */
interface ProviderTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
}

/** Trim a URL to a base without a trailing slash. */
function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The provider's canonical issuer (from config.issuerUrl), trailing slash removed.
 *  May be '' when a split-horizon config supplies explicit endpoints and no issuer. */
function normalizedIssuer(config: IdentityProviderConfig): string {
  return trimUrl(config.issuerUrl ?? '');
}

/** Resolve the configured client id, rejecting an unconfigured provider. */
function requireClientId(config: IdentityProviderConfig): string {
  const clientId = (config.clientId ?? '').trim();
  if (!clientId) {
    throw new Error(`Identity provider '${config.id}' has no clientId configured.`);
  }
  return clientId;
}

/** Resolve the client secret from config.clientSecretRef via the host secret
 *  mechanism. The ref is a key name (not a secret); the value never leaves here. */
function resolveClientSecret(config: IdentityProviderConfig): string {
  const ref = (config.clientSecretRef ?? '').trim();
  if (!ref) {
    throw new Error(`Identity provider '${config.id}' has no clientSecretRef configured.`);
  }
  const secret = resolveSecret(ref);
  if (!secret) {
    throw new Error(
      `No client secret is configured for identity provider '${config.id}' (secret ref is unset).`,
    );
  }
  return secret;
}

/** Decode a base64url JSON segment of a JWT (header or payload). */
function decodeJwtSegment<T>(segment: string, what: string): T {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as T;
  } catch {
    throw new Error(`Malformed id_token: ${what} is not valid base64url JSON.`);
  }
}

/** Decode a JWT id_token's payload segment into claims (base64url JSON). */
function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Malformed id_token: expected a JWT with a payload segment.');
  }
  const payload = decodeJwtSegment<unknown>(parts[1], 'payload');
  if (!payload || typeof payload !== 'object') {
    throw new Error('Malformed id_token: payload is not a JSON object.');
  }
  return payload as IdTokenClaims;
}

// ── endpoint resolution ──────────────────────────────────────────────────────

/** Fetch and cache the OIDC discovery document for an issuer. Best-effort: a
 *  network error or non-2xx response yields null so resolution falls through to
 *  the providerType template. */
async function fetchDiscovery(issuer: string): Promise<OidcDiscoveryDocument | null> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`${issuer}/.well-known/openid-configuration`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let doc: OidcDiscoveryDocument;
  try {
    doc = (await res.json()) as OidcDiscoveryDocument;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  discoveryCache.set(issuer, doc);
  return doc;
}

/** The providerType-template endpoints (last resort). An empty issuer yields no
 *  template (the provider is then rejected for having no usable endpoints). */
function templateEndpoints(config: IdentityProviderConfig, issuer: string): Partial<ProviderEndpoints> {
  if (!issuer) return {};
  switch (config.providerType) {
    case 'keycloak':
      return {
        authorizationEndpoint: `${issuer}/protocol/openid-connect/auth`,
        tokenEndpoint: `${issuer}/protocol/openid-connect/token`,
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
      };
    case 'authentik':
      return {
        authorizationEndpoint: `${issuer}/application/o/authorize/`,
        tokenEndpoint: `${issuer}/application/o/token/`,
        jwksUri: `${issuer}/application/o/jwks/`,
      };
    default:
      // Generic OIDC: the conventional /authorize + /token relative to the issuer.
      return {
        authorizationEndpoint: `${issuer}/authorize`,
        tokenEndpoint: `${issuer}/token`,
      };
  }
}

/**
 * Resolve the provider's concrete OIDC endpoints for one config, with precedence:
 * (1) explicit per-endpoint overrides on the config win field-by-field (the
 * split-horizon path); (2) OIDC discovery over
 * <issuerUrl>/.well-known/openid-configuration fills any still-missing endpoint;
 * (3) a providerType template is the last resort. Discovery documents are cached
 * in-adapter (transient, refetchable). Rejects a config that resolves to no usable
 * authorization or token endpoint.
 */
export async function resolveEndpoints(config: IdentityProviderConfig): Promise<ProviderEndpoints> {
  const issuer = normalizedIssuer(config);

  // (1) explicit per-endpoint overrides — taken field-by-field.
  let authorizationEndpoint = config.authorizationEndpoint?.trim() || undefined;
  let tokenEndpoint = config.tokenEndpoint?.trim() || undefined;
  let jwksUri = config.jwksUri?.trim() || undefined;
  let userinfoEndpoint = config.userinfoEndpoint?.trim() || undefined;

  // (2) OIDC discovery for any endpoint still unresolved (needs the issuer URL).
  const anyMissing = !authorizationEndpoint || !tokenEndpoint || !jwksUri || !userinfoEndpoint;
  if (anyMissing && issuer) {
    const doc = await fetchDiscovery(issuer);
    if (doc) {
      authorizationEndpoint = authorizationEndpoint || doc.authorization_endpoint?.trim() || undefined;
      tokenEndpoint = tokenEndpoint || doc.token_endpoint?.trim() || undefined;
      jwksUri = jwksUri || doc.jwks_uri?.trim() || undefined;
      userinfoEndpoint = userinfoEndpoint || doc.userinfo_endpoint?.trim() || undefined;
    }
  }

  // (3) providerType template as a last resort for any endpoint still unresolved.
  if (!authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    const tmpl = templateEndpoints(config, issuer);
    authorizationEndpoint = authorizationEndpoint || tmpl.authorizationEndpoint;
    tokenEndpoint = tokenEndpoint || tmpl.tokenEndpoint;
    jwksUri = jwksUri || tmpl.jwksUri;
  }

  // Reject a provider whose endpoints cannot be resolved to a usable authorize/token pair.
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error(
      `Identity provider '${config.id}' resolved no usable authorization or token endpoint.`,
    );
  }

  const endpoints: ProviderEndpoints = { issuer, authorizationEndpoint, tokenEndpoint };
  if (jwksUri) endpoints.jwksUri = jwksUri;
  if (userinfoEndpoint) endpoints.userinfoEndpoint = userinfoEndpoint;
  return endpoints;
}

/**
 * Build a provider authorization URL for a browser sign-in flow.
 *
 * Assembles response_type=code, client_id, the supplied redirectUri, the
 * requested scopes, and the opaque state against the resolved front-channel
 * authorization endpoint (endpoints.authorizationEndpoint).
 */
export function buildAuthorizationUrl(
  config: IdentityProviderConfig,
  endpoints: ProviderEndpoints,
  state: string,
  redirectUri: string,
): string {
  const clientId = requireClientId(config);
  const url = new URL(endpoints.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', REQUESTED_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange an authorization code for provider tokens and return a redacted,
 * serialized summary (the id_token needed for signature verification + its
 * decoded claims + token type) that carries NO raw access/refresh token or client
 * secret.
 *
 * POSTs a form-encoded grant (grant_type=authorization_code, code, redirect_uri,
 * client_id, resolved client secret) to the resolved back-channel token endpoint
 * (endpoints.tokenEndpoint, possibly VPC-internal) over the provider's TLS
 * channel. The raw code, secret, access/refresh tokens are never logged or returned.
 */
export async function exchangeCode(
  config: IdentityProviderConfig,
  endpoints: ProviderEndpoints,
  code: string,
  redirectUri: string,
): Promise<string> {
  const clientId = requireClientId(config);
  const clientSecret = resolveClientSecret(config);

  const form = new URLSearchParams();
  form.set('grant_type', 'authorization_code');
  form.set('code', code);
  form.set('redirect_uri', redirectUri);
  form.set('client_id', clientId);
  form.set('client_secret', clientSecret);

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });
  } catch {
    // Never surface the request body (carries the code and client secret).
    throw new Error(`Token exchange with identity provider '${config.id}' failed: network error.`);
  }

  if (!res.ok) {
    // Status only — the response body may echo request parameters or secrets.
    throw new Error(
      `Token exchange with identity provider '${config.id}' failed: provider returned HTTP ${res.status}.`,
    );
  }

  let token: ProviderTokenResponse;
  try {
    token = (await res.json()) as ProviderTokenResponse;
  } catch {
    throw new Error(`Token exchange with identity provider '${config.id}' returned an unreadable response.`);
  }

  if (!token.id_token) {
    throw new Error(`Identity provider '${config.id}' returned no id_token.`);
  }

  const claims = decodeIdTokenClaims(token.id_token);
  const summary: RedactedSummary = {
    idToken: token.id_token,
    idTokenClaims: {
      iss: claims.iss,
      sub: claims.sub,
      aud: claims.aud,
      exp: claims.exp,
      email: claims.email,
      name: claims.name,
      groups: claims.groups,
    },
    tokenType: token.token_type ?? 'Bearer',
  };
  // Only the redacted summary crosses this boundary — raw access/refresh tokens
  // are discarded (the id_token is the signed identity assertion, not a bearer).
  return JSON.stringify(summary);
}

// ── id_token signature verification ──────────────────────────────────────────

/** Fetch the JWKS at a URI (uncached), returning its keys array. */
async function fetchJwksFresh(jwksUri: string): Promise<Jwk[]> {
  const res = await fetch(jwksUri, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`JWKS fetch failed: provider returned HTTP ${res.status}.`);
  const doc = (await res.json()) as { keys?: Jwk[] };
  return Array.isArray(doc?.keys) ? doc.keys : [];
}

/** Fetch the JWKS at a URI, caching it. */
async function fetchJwks(jwksUri: string): Promise<Jwk[]> {
  const cached = jwksCache.get(jwksUri);
  if (cached) return cached;
  const keys = await fetchJwksFresh(jwksUri);
  jwksCache.set(jwksUri, keys);
  return keys;
}

/** Pick a signing key from a JWKS: by kid when the token names one, else the first. */
function pickKey(keys: Jwk[], kid: string | undefined): Jwk | undefined {
  if (kid) return keys.find((k) => (k as { kid?: string }).kid === kid);
  return keys[0];
}

/** Resolve the signing key for a token's kid, refetching the JWKS once on an
 *  unknown kid (provider key rotation). */
async function resolveSigningKey(jwksUri: string, kid: string | undefined): Promise<Jwk | undefined> {
  let key = pickKey(await fetchJwks(jwksUri), kid);
  if (!key) {
    // Unknown kid → the cached JWKS may be stale (key rotation); refetch once.
    const fresh = await fetchJwksFresh(jwksUri);
    jwksCache.set(jwksUri, fresh);
    key = pickKey(fresh, kid);
  }
  return key;
}

/** Verify a JWT signature (RS, PS, or ES family) over `signingInput` using a JWK. */
function verifyJwtSignature(alg: string, signingInput: string, jwk: Jwk, sigB64url: string): boolean {
  const digest = { '256': 'sha256', '384': 'sha384', '512': 'sha512' }[alg.slice(2)];
  if (!digest) return false; // unsupported / 'none'
  let keyObject: crypto.KeyObject;
  try {
    keyObject = crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput['key'], format: 'jwk' });
  } catch {
    return false;
  }
  const data = Buffer.from(signingInput);
  const sig = Buffer.from(sigB64url, 'base64url');
  try {
    if (alg.startsWith('RS')) {
      return crypto.verify(digest, data, keyObject, sig);
    }
    if (alg.startsWith('PS')) {
      return crypto.verify(
        digest,
        data,
        { key: keyObject, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
        sig,
      );
    }
    if (alg.startsWith('ES')) {
      // JOSE ECDSA signatures are raw r||s (IEEE P1363), not DER.
      return crypto.verify(digest, data, { key: keyObject, dsaEncoding: 'ieee-p1363' }, sig);
    }
  } catch {
    return false;
  }
  return false;
}

/** Verify the standard claims (iss/aud/exp) against the provider config/endpoints. */
function assertStandardClaims(config: IdentityProviderConfig, endpoints: ProviderEndpoints, claims: IdTokenClaims): void {
  // issuer: the id_token iss must match the resolved canonical issuer (slash tolerant).
  if (endpoints.issuer) {
    const actual = trimUrl(claims.iss ?? '');
    if (!actual || actual !== trimUrl(endpoints.issuer)) {
      throw new Error(`Invalid provider identity metadata for '${config.id}': issuer mismatch.`);
    }
  }
  // audience: the id_token aud must include the configured clientId (when set).
  const clientId = (config.clientId ?? '').trim();
  if (clientId) {
    const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!aud.includes(clientId)) {
      throw new Error(`Invalid provider identity metadata for '${config.id}': audience mismatch.`);
    }
  }
  // expiry: the id_token must not be expired.
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new Error(`Invalid provider identity metadata for '${config.id}': id_token is expired or has no expiry.`);
  }
}

/** Full JWKS signature verification path: verify the id_token signature against the
 *  provider signing key, then its iss/aud/exp claims. Returns the verified claims. */
async function verifyIdTokenWithJwks(
  config: IdentityProviderConfig,
  endpoints: ProviderEndpoints,
  idToken: string,
): Promise<IdTokenClaims> {
  const parts = idToken.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(`Invalid provider identity metadata for '${config.id}': malformed id_token.`);
  }
  const header = decodeJwtSegment<{ alg?: string; kid?: string }>(parts[0], 'header');
  const alg = header.alg ?? '';
  if (!alg || alg.toLowerCase() === 'none') {
    throw new Error(`Invalid provider identity metadata for '${config.id}': unsigned id_token rejected.`);
  }

  const key = await resolveSigningKey(endpoints.jwksUri as string, header.kid);
  if (!key) {
    throw new Error(`Invalid provider identity metadata for '${config.id}': no signing key for the id_token.`);
  }

  const ok = verifyJwtSignature(alg, `${parts[0]}.${parts[1]}`, key, parts[2]);
  if (!ok) {
    throw new Error(`Invalid provider identity metadata for '${config.id}': id_token signature verification failed.`);
  }

  const claims = decodeIdTokenClaims(idToken);
  assertStandardClaims(config, endpoints, claims);
  return claims;
}

/**
 * Verify provider identity metadata and map it to a Wairon PrincipalSubject
 * without leaking raw provider tokens.
 *
 * Fetches the provider's public keys from the resolved jwksUri (cached; refetched
 * on an unknown key id / rotation), verifies the id_token signature and its
 * issuer/audience/expiry claims, and only then maps the verified claims to a
 * subject. When no JWKS is available it falls back to the userinfo endpoint path
 * (issuer/audience/expiry validation only). Metadata that can be verified by
 * neither path is rejected. Enforces allowedDomains against the verified email.
 */
export async function resolveSubject(
  config: IdentityProviderConfig,
  endpoints: ProviderEndpoints,
  providerMetadata: string,
): Promise<PrincipalSubject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(providerMetadata);
  } catch {
    throw new Error(`Invalid provider identity metadata for '${config.id}': not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid provider identity metadata for '${config.id}': not an object.`);
  }
  const summary = parsed as Partial<RedactedSummary>;
  if (!summary.idToken || typeof summary.idToken !== 'string') {
    throw new Error(`Invalid provider identity metadata for '${config.id}': missing id_token.`);
  }

  let claims: IdTokenClaims;
  if (endpoints.jwksUri) {
    // Primary path: verify the id_token signature against the provider JWKS.
    claims = await verifyIdTokenWithJwks(config, endpoints, summary.idToken);
  } else if (endpoints.userinfoEndpoint) {
    // Fallback path (no JWKS): the id_token signature cannot be cryptographically
    // verified, so trust rests on the back-channel exchange TLS plus a strict
    // issuer/audience/expiry claim check (the userinfo endpoint is the configured
    // fallback identity path). Verified metadata still requires these claims.
    claims = decodeIdTokenClaims(summary.idToken);
    assertStandardClaims(config, endpoints, claims);
  } else {
    // Neither a JWKS nor a userinfo endpoint: the metadata is unverifiable.
    throw new Error(
      `Cannot verify identity from provider '${config.id}': no JWKS or userinfo endpoint is available.`,
    );
  }

  const subject = (claims.sub ?? '').trim();
  if (!subject) {
    throw new Error(`Invalid provider identity metadata for '${config.id}': no subject.`);
  }

  const email = claims.email?.trim() || undefined;

  // Enforce allowedDomains against the email domain, when configured. An unset
  // (or empty) allowedDomains permits any domain.
  if (config.allowedDomains && config.allowedDomains.length > 0) {
    const domain = email ? email.split('@').pop()?.toLowerCase() : undefined;
    const allowed = config.allowedDomains.map((d) => d.toLowerCase().replace(/^@/, ''));
    if (!domain || !allowed.includes(domain)) {
      throw new Error(`Email domain is not permitted to sign in via identity provider '${config.id}'.`);
    }
  }

  // The PrincipalSubject issuer is the provider CONFIG id (the instance's stable
  // handle for this provider) — the identifier user records are keyed by. The OIDC
  // issuer URL (endpoints.issuer) is used above to VERIFY the id_token's iss claim.
  return {
    userId: `sso:${config.id}:${subject}`,
    kind: 'human',
    issuer: config.id,
    externalSubject: subject,
    displayName: claims.name?.trim() || undefined,
    email,
  };
}

/**
 * Enforce the provider's server-side redirect_uri allowlist.
 *
 * When `config.allowedRedirectUris` is set and non-empty, `redirectUri` must be
 * an EXACT string match of one of its entries (no prefix/substring matching);
 * otherwise this throws. When unset or empty, every redirectUri is accepted
 * (backward compatible). The thrown message never echoes the supplied
 * redirectUri, so a malicious value cannot be reflected back.
 */
export function assertAllowedRedirectUri(provider: IdentityProviderConfig, redirectUri: string): void {
  const allowed = provider.allowedRedirectUris;
  if (!allowed || allowed.length === 0) {
    return;
  }
  if (!allowed.includes(redirectUri)) {
    throw new Error(`redirect_uri not allowed for identity provider '${provider.id}'.`);
  }
}
