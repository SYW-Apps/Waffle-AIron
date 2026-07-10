import { resolveSecret } from '../utils/secrets.js';
import type { IdentityProviderConfig, PrincipalSubject } from './types.js';

// ---------------------------------------------------------------------------
// Identity Provider Adapter (sdd_host) — Phase 5a OIDC/SSO.
//
// The only block that talks to an external OIDC provider. It assembles browser
// authorization URLs, exchanges authorization codes for provider tokens over
// HTTPS, and verifies provider identity metadata into a Wairon PrincipalSubject.
// It performs provider I/O only: it never persists, logs, or returns raw
// provider tokens (access/refresh/id) or the client secret.
//
// Async note: the L3 interface declares string returns, but token exchange is
// network I/O, so `exchangeCode` is async (returns Promise<string>). This
// mirrors the Notion Client Adapter, whose L3 declares `sync(...): void` yet is
// implemented as `async ...: Promise<void>`. `buildAuthorizationUrl` and
// `resolveSubject` stay synchronous per their signatures.
//
// Discovery note: OIDC discovery over `<issuerUrl>/.well-known/openid-configuration`
// would resolve the exact endpoints, but that is network I/O and the URL-assembly
// path must be synchronous. This phase therefore derives the conventional
// endpoints relative to the configured issuer (`<issuerUrl>/authorize`,
// `<issuerUrl>/token`); per-providerType path overrides / live discovery are a
// later-phase concern.
//
// Verification note: full ID-token signature verification against the provider
// JWKS is deferred to a later phase. In this phase trust is established by the
// TLS channel used for the code->token exchange plus a strict issuer match in
// resolveSubject; the id_token payload is decoded (base64url JSON) for its claims.
// ---------------------------------------------------------------------------

/** OIDC scopes requested for sign-in: identity + email + basic profile. */
const REQUESTED_SCOPE = 'openid email profile';

/** The redacted provider response summary carried between exchangeCode and
 *  resolveSubject. Serialized as JSON; carries verified claims only — never a
 *  raw access_token, refresh_token, id_token, or the client secret. */
interface RedactedSummary {
  idTokenClaims: {
    iss?: string;
    sub?: string;
    email?: string;
    name?: string;
    groups?: string[];
  };
  tokenType: string;
}

/** Decoded ID-token payload claims (only the fields this adapter reads). */
interface IdTokenClaims {
  iss?: string;
  sub?: string;
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

/** Normalize the configured issuer to a base URL without a trailing slash. */
function issuerBase(config: IdentityProviderConfig): string {
  const issuer = (config.issuerUrl ?? '').trim();
  if (!issuer) {
    throw new Error(`Identity provider '${config.id}' has no issuerUrl configured.`);
  }
  return issuer.replace(/\/+$/, '');
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

/** Decode a JWT id_token's payload segment into claims (base64url JSON). No
 *  signature verification in this phase — see the verification note above. */
function decodeIdTokenClaims(idToken: string): IdTokenClaims {
  const parts = idToken.split('.');
  if (parts.length < 2 || !parts[1]) {
    throw new Error('Malformed id_token: expected a JWT with a payload segment.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('Malformed id_token: payload is not valid base64url JSON.');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('Malformed id_token: payload is not a JSON object.');
  }
  return payload as IdTokenClaims;
}

/**
 * Build a provider authorization URL for a browser sign-in flow.
 *
 * Assembles response_type=code, client_id, the supplied redirectUri, the
 * requested scopes, and the opaque state against the conventional authorization
 * endpoint derived from the configured issuer.
 */
export function buildAuthorizationUrl(
  config: IdentityProviderConfig,
  state: string,
  redirectUri: string,
): string {
  const base = issuerBase(config);
  const clientId = requireClientId(config);
  const url = new URL(`${base}/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', REQUESTED_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * Exchange an authorization code for provider tokens and return a redacted,
 * serialized summary (verified claims + token type) that carries NO raw
 * provider tokens or client secret.
 *
 * POSTs a form-encoded grant (grant_type=authorization_code, code, redirect_uri,
 * client_id, resolved client secret) to the token endpoint over the provider's
 * TLS channel, decodes the returned id_token's claims, and serializes only the
 * redacted summary. The raw code, secret, and tokens are never logged or returned.
 */
export async function exchangeCode(
  config: IdentityProviderConfig,
  code: string,
  redirectUri: string,
): Promise<string> {
  const base = issuerBase(config);
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
    res = await fetch(`${base}/token`, {
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
    idTokenClaims: {
      iss: claims.iss,
      sub: claims.sub,
      email: claims.email,
      name: claims.name,
      groups: claims.groups,
    },
    tokenType: token.token_type ?? 'Bearer',
  };
  // Only the redacted summary crosses this boundary — raw tokens are discarded.
  return JSON.stringify(summary);
}

/**
 * Verify the redacted provider identity metadata and map it to a Wairon
 * PrincipalSubject without leaking raw provider tokens.
 *
 * Validates the issuer against the configured provider, requires a subject,
 * enforces allowedDomains against the verified email domain when configured,
 * and maps the verified claims to a stable PrincipalSubject.
 */
export function resolveSubject(
  config: IdentityProviderConfig,
  providerMetadata: string,
): PrincipalSubject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(providerMetadata);
  } catch {
    throw new Error(`Invalid provider identity metadata for '${config.id}': not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid provider identity metadata for '${config.id}': not an object.`);
  }
  const claims = (parsed as RedactedSummary).idTokenClaims;
  if (!claims || typeof claims !== 'object') {
    throw new Error(`Invalid provider identity metadata for '${config.id}': missing id token claims.`);
  }

  // Issuer must match the configured provider issuer (trailing slash tolerant).
  const expectedIssuer = issuerBase(config);
  const actualIssuer = (claims.iss ?? '').trim().replace(/\/+$/, '');
  if (!actualIssuer || actualIssuer !== expectedIssuer) {
    throw new Error(`Invalid provider identity metadata for '${config.id}': issuer mismatch.`);
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

  return {
    userId: `sso:${config.id}:${subject}`,
    kind: 'human',
    issuer: config.id,
    externalSubject: subject,
    displayName: claims.name?.trim() || undefined,
    email,
  };
}
