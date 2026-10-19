import { describe, it, expect } from 'vitest';
import { buildAuthorizationUrl } from '../../src/server/idp.js';
import { providerSetupProblem } from '../../src/server/types.js';
import type { IdentityProviderConfig, ProviderEndpoints } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Tests for the server-side redirect_uri allowlist on the OIDC Identity Provider
// Adapter (sdd_host). Every sign-in start path builds its authorization URL
// through buildAuthorizationUrl, which enforces the provider's redirect allowlist.
// ---------------------------------------------------------------------------

function cfg(overrides: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig {
  return {
    id: 'authentik-corp',
    providerType: 'oidc',
    issuerUrl: 'https://idp.example',
    clientId: 'test-client',
    clientSecretRef: 'oidc-client-secret',
    enabled: true,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

const ENDPOINTS: ProviderEndpoints = {
  issuer: 'https://idp.example',
  authorizationEndpoint: 'https://idp.example/authorize',
  tokenEndpoint: 'https://idp.example/token',
};

/** Build an authorization URL for `redirectUri`, which applies the allowlist. */
function assertAllowedRedirectUri(provider: IdentityProviderConfig, redirectUri: string): void {
  buildAuthorizationUrl(provider, ENDPOINTS, 'signed-state', redirectUri);
}

describe('buildAuthorizationUrl enforces the redirect allowlist', () => {
  it('fails closed: refuses every redirectUri when allowedRedirectUris is unset', () => {
    expect(() => assertAllowedRedirectUri(cfg(), 'https://app.example/cb')).toThrow(/not set up yet/);
    expect(() => assertAllowedRedirectUri(cfg(), 'https://anything.example/whatever')).toThrow(/not set up yet/);
  });

  it('fails closed: refuses every redirectUri when allowedRedirectUris is empty or blank', () => {
    expect(() => assertAllowedRedirectUri(cfg({ allowedRedirectUris: [] }), 'https://app.example/cb')).toThrow(/not set up yet/);
    expect(() => assertAllowedRedirectUri(cfg({ allowedRedirectUris: ['  '] }), 'https://app.example/cb')).toThrow(/not set up yet/);
  });

  it('builds no authorization URL for a provider that is not set up, and never echoes the supplied address', () => {
    const attacker = 'https://evil.example/steal?token=SECRET';
    try {
      buildAuthorizationUrl(cfg(), ENDPOINTS, 'signed-state', attacker);
      throw new Error('expected buildAuthorizationUrl to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(attacker);
      expect((err as Error).message).toBe('Sign-in through authentik-corp is not set up yet. Ask an administrator to finish its setup.');
    }
  });

  it('providerSetupProblem: the admin sentence when no redirect address is named, nothing otherwise', () => {
    expect(providerSetupProblem(cfg({ displayName: 'Corp SSO' }))).toBe(
      'SSO through Corp SSO will not work until its allowed redirect addresses are set ' +
        '(allowedRedirectUris, or WAIRON_OIDC_ALLOWED_REDIRECT_URIS) — usually https://<this host>/web/sso/callback',
    );
    expect(providerSetupProblem(cfg())).toContain('SSO through authentik-corp will not work');
    expect(providerSetupProblem(cfg({ allowedRedirectUris: ['https://app.example/cb'] }))).toBeUndefined();
  });

  it('accepts an exact match when allowedRedirectUris is non-empty', () => {
    const provider = cfg({
      allowedRedirectUris: ['https://app.example/cb', 'https://app.example/other-cb'],
    });
    expect(() => assertAllowedRedirectUri(provider, 'https://app.example/cb')).not.toThrow();
    expect(() => assertAllowedRedirectUri(provider, 'https://app.example/other-cb')).not.toThrow();
  });

  it('rejects a non-matching redirectUri when allowedRedirectUris is non-empty', () => {
    const provider = cfg({ allowedRedirectUris: ['https://app.example/cb'] });
    expect(() => assertAllowedRedirectUri(provider, 'https://evil.example/cb')).toThrow(
      /redirect_uri not allowed/,
    );
  });

  it('rejects a prefix/substring of an allowed entry (no partial matching)', () => {
    const provider = cfg({ allowedRedirectUris: ['https://app.example/cb'] });
    // Prefix of the allowed entry.
    expect(() => assertAllowedRedirectUri(provider, 'https://app.example/c')).toThrow(
      /redirect_uri not allowed/,
    );
    // Allowed entry plus extra suffix (superset).
    expect(() => assertAllowedRedirectUri(provider, 'https://app.example/cb/extra')).toThrow(
      /redirect_uri not allowed/,
    );
    // Allowed entry embedded as a substring elsewhere.
    expect(() => assertAllowedRedirectUri(provider, 'https://evil.example/?u=https://app.example/cb')).toThrow(
      /redirect_uri not allowed/,
    );
  });

  it('does not echo the attacker-supplied redirectUri in the error message', () => {
    const provider = cfg({ allowedRedirectUris: ['https://app.example/cb'] });
    const attacker = 'https://evil.example/steal?token=SECRET';
    try {
      assertAllowedRedirectUri(provider, attacker);
      throw new Error('expected buildAuthorizationUrl to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(attacker);
      expect((err as Error).message).toMatch(/redirect_uri not allowed/);
    }
  });
});
