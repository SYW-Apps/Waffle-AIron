import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { seedIdentityProviderFromEnv } from '../../src/commands/host.js';
import { listIdentityProviderRecords } from '../../src/server/policy.js';
import { listIdentityProviders } from '../../src/server/identity.js';
import { resolveSecret, setSecret } from '../../src/utils/secrets.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Declarative env-based identity-provider seeding (sdd_host boot wiring).
//
// `wairon serve` startup seeds the `default` OIDC provider from WAIRON_OIDC_*
// env vars so a whole SSO setup ships in the compose file: activates only when
// WAIRON_OIDC_ISSUER is set, stores a RAW client secret under the fixed ref
// `oidc-default` (the provider carries only the ref), parses the comma-list
// vars, persists split-horizon endpoint overrides, and idempotently re-seeds
// on every boot (env is the source of truth for `default`).
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const ISSUER = 'https://sso.example.com/application/o/wairon/';
const RAW_SECRET = 'raw-oidc-client-secret-value';

const OIDC_ENV_KEYS = [
  'WAIRON_OIDC_PROVIDER_TYPE',
  'WAIRON_OIDC_ISSUER',
  'WAIRON_OIDC_DISPLAY_NAME',
  'WAIRON_OIDC_CLIENT_ID',
  'WAIRON_OIDC_CLIENT_SECRET',
  'WAIRON_OIDC_CLIENT_SECRET_REF',
  'WAIRON_OIDC_ADMIN_GROUPS',
  'WAIRON_OIDC_ALLOWED_REDIRECT_URIS',
  'WAIRON_OIDC_ALLOWED_DOMAINS',
  'WAIRON_OIDC_AUTHORIZATION_ENDPOINT',
  'WAIRON_OIDC_TOKEN_ENDPOINT',
  'WAIRON_OIDC_JWKS_URI',
  'WAIRON_OIDC_USERINFO_ENDPOINT',
] as const;

describe('WAIRON_OIDC_* startup seeding of the default identity provider (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-idp-seed-'));
    for (const key of OIDC_ENV_KEYS) delete process.env[key];
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('seeds a fully-configured default provider: raw secret → oidc-default ref, comma-lists parsed, endpoints persisted', () => {
    process.env.WAIRON_OIDC_PROVIDER_TYPE = 'authentik';
    process.env.WAIRON_OIDC_ISSUER = ISSUER;
    process.env.WAIRON_OIDC_DISPLAY_NAME = 'Corporate SSO';
    process.env.WAIRON_OIDC_CLIENT_ID = 'wairon-client';
    process.env.WAIRON_OIDC_CLIENT_SECRET = RAW_SECRET;
    process.env.WAIRON_OIDC_ADMIN_GROUPS = 'wairon-admins, platform-team';
    process.env.WAIRON_OIDC_ALLOWED_REDIRECT_URIS =
      'https://wairon.example.com/web/sso/callback, https://wairon.example.com/alt/cb';
    process.env.WAIRON_OIDC_ALLOWED_DOMAINS = 'example.com,corp.example';
    process.env.WAIRON_OIDC_AUTHORIZATION_ENDPOINT = 'https://sso.example.com/authorize';
    process.env.WAIRON_OIDC_TOKEN_ENDPOINT = 'http://sso.internal:9000/token';
    process.env.WAIRON_OIDC_JWKS_URI = 'http://sso.internal:9000/jwks';
    process.env.WAIRON_OIDC_USERINFO_ENDPOINT = 'http://sso.internal:9000/userinfo';

    seedIdentityProviderFromEnv(cfg);

    const records = listIdentityProviderRecords(dataDir);
    expect(records).toHaveLength(1);
    const provider = records[0];
    expect(provider.id).toBe('default'); // the sign-in screen's default provider id
    expect(provider.enabled).toBe(true);
    expect(provider.providerType).toBe('authentik');
    expect(provider.issuerUrl).toBe(ISSUER);
    // The login-button label survives the whitelist projection (sign-in screen
    // renders "Sign in with Corporate SSO" for the seeded default provider).
    expect(provider.displayName).toBe('Corporate SSO');
    expect(provider.clientId).toBe('wairon-client');
    expect(provider.adminGroupClaims).toEqual(['wairon-admins', 'platform-team']);
    expect(provider.allowedRedirectUris).toEqual([
      'https://wairon.example.com/web/sso/callback',
      'https://wairon.example.com/alt/cb',
    ]);
    expect(provider.allowedDomains).toEqual(['example.com', 'corp.example']);
    // Split-horizon endpoint overrides survive the whitelist projection.
    expect(provider.authorizationEndpoint).toBe('https://sso.example.com/authorize');
    expect(provider.tokenEndpoint).toBe('http://sso.internal:9000/token');
    expect(provider.jwksUri).toBe('http://sso.internal:9000/jwks');
    expect(provider.userinfoEndpoint).toBe('http://sso.internal:9000/userinfo');
    expect(Date.parse(provider.updatedAt)).not.toBeNaN(); // stamped server-side

    // The raw secret landed in the secret store; the provider carries only the ref.
    expect(provider.clientSecretRef).toBe('oidc-default');
    expect(resolveSecret(provider.clientSecretRef!)).toBe(RAW_SECRET);
    expect(JSON.stringify(records)).not.toContain(RAW_SECRET);

    // Visible through the identity plane (instance-admin master credential).
    const listed = listIdentityProviders(cfg, MASTER);
    expect(listed.map((p) => p.id)).toEqual(['default']);
  });

  it('minimal env: only the issuer set → providerType defaults to oidc, no secret is stored', () => {
    process.env.WAIRON_OIDC_ISSUER = ISSUER;

    seedIdentityProviderFromEnv(cfg);

    const records = listIdentityProviderRecords(dataDir);
    expect(records).toHaveLength(1);
    expect(records[0].providerType).toBe('oidc');
    expect(records[0].issuerUrl).toBe(ISSUER);
    expect(records[0].displayName).toBeUndefined(); // label defaults to the id downstream
    expect(records[0].clientSecretRef).toBeUndefined();
    expect(resolveSecret('oidc-default')).toBeNull();
  });

  it('does NOT seed when WAIRON_OIDC_ISSUER is unset — even with every other var present', () => {
    process.env.WAIRON_OIDC_CLIENT_ID = 'wairon-client';
    process.env.WAIRON_OIDC_CLIENT_SECRET = RAW_SECRET;
    process.env.WAIRON_OIDC_ADMIN_GROUPS = 'wairon-admins';

    seedIdentityProviderFromEnv(cfg);

    expect(listIdentityProviderRecords(dataDir)).toEqual([]);
    expect(resolveSecret('oidc-default')).toBeNull(); // no secret write either
  });

  it('re-seeding is idempotent and declarative: same env → one record; changed env → the record follows', () => {
    process.env.WAIRON_OIDC_ISSUER = ISSUER;
    process.env.WAIRON_OIDC_CLIENT_ID = 'first-client';

    seedIdentityProviderFromEnv(cfg);
    seedIdentityProviderFromEnv(cfg);
    let records = listIdentityProviderRecords(dataDir);
    expect(records).toHaveLength(1);
    expect(records[0].clientId).toBe('first-client');

    // Declarative: env is the source of truth for `default` on every boot.
    process.env.WAIRON_OIDC_CLIENT_ID = 'second-client';
    seedIdentityProviderFromEnv(cfg);
    records = listIdentityProviderRecords(dataDir);
    expect(records).toHaveLength(1);
    expect(records[0].clientId).toBe('second-client');
  });

  it('WAIRON_OIDC_CLIENT_SECRET_REF points at an existing stored ref instead of storing a raw secret', () => {
    setSecret('corp-oidc-secret', 'pre-provisioned-value');
    process.env.WAIRON_OIDC_ISSUER = ISSUER;
    process.env.WAIRON_OIDC_CLIENT_SECRET_REF = 'corp-oidc-secret';

    seedIdentityProviderFromEnv(cfg);

    const [provider] = listIdentityProviderRecords(dataDir);
    expect(provider.clientSecretRef).toBe('corp-oidc-secret');
    expect(resolveSecret(provider.clientSecretRef!)).toBe('pre-provisioned-value');
    expect(resolveSecret('oidc-default')).toBeNull(); // nothing stored under the fixed ref
  });

  it('a RAW secret wins over a simultaneous ref: stored under oidc-default and referenced from there', () => {
    process.env.WAIRON_OIDC_ISSUER = ISSUER;
    process.env.WAIRON_OIDC_CLIENT_SECRET = RAW_SECRET;
    process.env.WAIRON_OIDC_CLIENT_SECRET_REF = 'some-other-ref';

    seedIdentityProviderFromEnv(cfg);

    const [provider] = listIdentityProviderRecords(dataDir);
    expect(provider.clientSecretRef).toBe('oidc-default');
    expect(resolveSecret('oidc-default')).toBe(RAW_SECRET);
  });
});
