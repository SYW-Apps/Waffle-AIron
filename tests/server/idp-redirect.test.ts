import { describe, it, expect } from 'vitest';
import { assertAllowedRedirectUri } from '../../src/server/idp.js';
import type { IdentityProviderConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Tests for the server-side redirect_uri allowlist on the OIDC Identity Provider
// Adapter (sdd_host). Closes the MEDIUM finding where POST /web/sso/start trusted
// a client-supplied redirectUri verbatim with no server-side check.
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

describe('assertAllowedRedirectUri', () => {
  it('accepts any redirectUri when allowedRedirectUris is unset', () => {
    expect(() => assertAllowedRedirectUri(cfg(), 'https://app.example/cb')).not.toThrow();
    expect(() => assertAllowedRedirectUri(cfg(), 'https://anything.example/whatever')).not.toThrow();
  });

  it('accepts any redirectUri when allowedRedirectUris is an empty array', () => {
    expect(() => assertAllowedRedirectUri(cfg({ allowedRedirectUris: [] }), 'https://app.example/cb')).not.toThrow();
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
      throw new Error('expected assertAllowedRedirectUri to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(attacker);
      expect((err as Error).message).toMatch(/redirect_uri not allowed/);
    }
  });
});
