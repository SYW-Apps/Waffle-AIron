import { setSecret } from '../utils/secrets.js';
import { upsertIdentityProviderRecord } from './policy.js';
import type { HostConfig, IdentityProviderConfig } from './types.js';

// ---------------------------------------------------------------------------
// Identity Provider Bootstrap (sdd_host)
//
// Boot-time declarative seeding of the `default` OIDC identity provider from
// the server process's own WAIRON_OIDC_* environment, run by `wairon serve`
// before the listeners bind and before any credential exists. Everything it
// writes is read from the environment; its caller hands it only the host
// configuration.
// ---------------------------------------------------------------------------

/** The provider id the sign-in screen offers by default. */
const DEFAULT_PROVIDER_ID = 'default';
/** The fixed secret reference a raw env-shipped client secret is stored under. */
const DEFAULT_PROVIDER_SECRET_REF = 'oidc-default';

/** A trimmed env value, or undefined when unset/blank. */
function envTrim(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** Split a comma-separated env value into trimmed, non-empty entries. */
function envCsv(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Boot-time declarative seeding of the `default` OIDC identity provider from
 * the server process's own WAIRON_OIDC_* environment, so a whole SSO setup
 * ships in the compose file. Runs before any credential exists: the caller
 * passes nothing, and everything written is read from the environment. A no-op
 * (answering null) unless WAIRON_OIDC_ISSUER is set. A RAW
 * WAIRON_OIDC_CLIENT_SECRET is stored under the fixed ref `oidc-default` and the
 * provider carries only that ref (an existing stored ref may be named with
 * WAIRON_OIDC_CLIENT_SECRET_REF instead). The upsert is idempotent, so every
 * boot re-seeds: env is the source of truth for `default`, and the web UI
 * manages other providers on top.
 */
export function seedDefaultProvider(cfg: HostConfig): IdentityProviderConfig | null {
  // Step 1–3: seeding activates only when the issuer is set
  const issuer = envTrim('WAIRON_OIDC_ISSUER');
  if (!issuer) return null;
  // Step 4–6: a raw secret is stored under the fixed ref; else a named ref, if any
  let clientSecretRef = envTrim('WAIRON_OIDC_CLIENT_SECRET_REF');
  const rawSecret = process.env['WAIRON_OIDC_CLIENT_SECRET'];
  if (rawSecret) {
    setSecret(DEFAULT_PROVIDER_SECRET_REF, rawSecret);
    clientSecretRef = DEFAULT_PROVIDER_SECRET_REF;
  }
  // Step 7: build the provider record from the environment
  const config = defaultProviderFromEnv(issuer, clientSecretRef);
  // Step 8–9: upsert it through the policy repository and return it
  return upsertIdentityProviderRecord(cfg.dataDir, config);
}

/** The `default` provider record the WAIRON_OIDC_* environment describes. */
function defaultProviderFromEnv(issuer: string, clientSecretRef: string | undefined): IdentityProviderConfig {
  const config: IdentityProviderConfig = {
    id: DEFAULT_PROVIDER_ID,
    providerType: envTrim('WAIRON_OIDC_PROVIDER_TYPE') ?? 'oidc',
    issuerUrl: issuer,
    enabled: true,
    updatedAt: '', // stamped server-side by the policy registry
  };
  // Login-button label: "Sign in with <displayName>", defaulting to the provider id.
  const displayName = envTrim('WAIRON_OIDC_DISPLAY_NAME');
  if (displayName) config.displayName = displayName;
  const clientId = envTrim('WAIRON_OIDC_CLIENT_ID');
  if (clientId) config.clientId = clientId;
  if (clientSecretRef) config.clientSecretRef = clientSecretRef;
  const adminGroups = envCsv('WAIRON_OIDC_ADMIN_GROUPS');
  if (adminGroups.length) config.adminGroupClaims = adminGroups;
  const redirectUris = envCsv('WAIRON_OIDC_ALLOWED_REDIRECT_URIS');
  if (redirectUris.length) config.allowedRedirectUris = redirectUris;
  const domains = envCsv('WAIRON_OIDC_ALLOWED_DOMAINS');
  if (domains.length) config.allowedDomains = domains;
  applyEndpointOverrides(config);
  return config;
}

/** Split-horizon endpoint overrides (public authorize vs VPC-internal back-channel). */
function applyEndpointOverrides(config: IdentityProviderConfig): void {
  const authorizationEndpoint = envTrim('WAIRON_OIDC_AUTHORIZATION_ENDPOINT');
  if (authorizationEndpoint) config.authorizationEndpoint = authorizationEndpoint;
  const tokenEndpoint = envTrim('WAIRON_OIDC_TOKEN_ENDPOINT');
  if (tokenEndpoint) config.tokenEndpoint = tokenEndpoint;
  const jwksUri = envTrim('WAIRON_OIDC_JWKS_URI');
  if (jwksUri) config.jwksUri = jwksUri;
  const userinfoEndpoint = envTrim('WAIRON_OIDC_USERINFO_ENDPOINT');
  if (userinfoEndpoint) config.userinfoEndpoint = userinfoEndpoint;
}
