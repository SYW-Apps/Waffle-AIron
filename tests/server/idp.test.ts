import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { setSecret } from '../../src/utils/secrets.js';
import {
  resolveEndpoints,
  buildAuthorizationUrl,
  exchangeCode,
  resolveSubject,
  __clearIdpCaches,
} from '../../src/server/idp.js';
import type { IdentityProviderConfig, ProviderEndpoints } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Tests for the OIDC Identity Provider Adapter (sdd_host). A stub OIDC provider
// runs on an ephemeral loopback http server: it serves OIDC discovery, a JWKS with
// a real RSA public key, and a /token endpoint that returns a crafted, RS256-SIGNED
// id_token. Endpoint resolution (overrides -> discovery -> template), code
// exchange, and id_token JWKS verification are exercised end-to-end. Client secrets
// resolve from a seeded WAIRON_DATA_DIR secret store exactly like production.
// ---------------------------------------------------------------------------

const SECRET_REF = 'oidc-client-secret';
const SECRET_VALUE = 'super-secret-value';
const CLIENT_ID = 'test-client';

// A real RSA signing key; its public half is published in the stub JWKS.
const { publicKey: SIGN_PUB, privateKey: SIGN_PRIV } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
const JWK = { ...(SIGN_PUB.export({ format: 'jwk' }) as crypto.JsonWebKey), kid: KID, use: 'sig', alg: 'RS256' };

// A loopback port nothing listens on: discovery to it fails fast (ECONNREFUSED),
// so template resolution kicks in deterministically without any real DNS.
const CLOSED_ISSUER = 'http://127.0.0.1:1';

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

/** RS256-sign an id_token (header.payload.signature) with the stub signing key. */
function signIdToken(claims: Record<string, unknown>, kid: string = KID): string {
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const input = `${b64url(header)}.${b64url(claims)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), SIGN_PRIV).toString('base64url');
  return `${input}.${sig}`;
}

/** Standard verified claims for the stub provider (valid iss/aud/exp). */
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: issuerUrl,
    sub: 'user-123',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'alice@corp.example',
    name: 'Alice',
    groups: ['admins'],
    ...over,
  };
}

// Records the last form POSTed to /token so tests can assert the exchange body.
const received: { path?: string; contentType?: string; body: Record<string, string> } = { body: {} };
// The response the stub /token endpoint returns; each test may override it.
let tokenResponse: () => { status: number; json: unknown } = () => ({ status: 200, json: {} });

let server: Server;
let issuerUrl: string;
let dataDir: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', issuerUrl);
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            issuer: issuerUrl,
            authorization_endpoint: `${issuerUrl}/authorize`,
            token_endpoint: `${issuerUrl}/token`,
            jwks_uri: `${issuerUrl}/jwks`,
            userinfo_endpoint: `${issuerUrl}/userinfo`,
          }),
        );
        return;
      }
      if (req.method === 'GET' && url.pathname === '/jwks') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [JWK] }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        received.path = url.pathname;
        received.contentType = req.headers['content-type'];
        received.body = Object.fromEntries(new URLSearchParams(raw));
        const r = tokenResponse();
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r.json));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  issuerUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-idp-'));
  process.env.WAIRON_DATA_DIR = dataDir;
  setSecret(SECRET_REF, SECRET_VALUE);
  __clearIdpCaches();
  tokenResponse = () => ({
    status: 200,
    json: { access_token: 'ACCESS-XYZ', refresh_token: 'REFRESH-XYZ', id_token: signIdToken(claims()), token_type: 'Bearer' },
  });
});

afterEach(() => {
  delete process.env.WAIRON_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
  received.body = {};
  received.path = undefined;
  received.contentType = undefined;
});

function cfg(overrides: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig {
  return {
    id: 'authentik-corp',
    providerType: 'oidc',
    issuerUrl,
    clientId: CLIENT_ID,
    clientSecretRef: SECRET_REF,
    enabled: true,
    updatedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  };
}

// ── resolveEndpoints: override vs discovery vs template ──────────────────────

describe('resolveEndpoints', () => {
  it('explicit per-endpoint overrides win field-by-field (split-horizon)', async () => {
    // A PUBLIC front-channel authorize + a VPC-INTERNAL back-channel token/jwks.
    const endpoints = await resolveEndpoints(
      cfg({
        authorizationEndpoint: 'https://public.example/authorize',
        tokenEndpoint: 'https://authentik.internal/token',
        jwksUri: 'https://authentik.internal/jwks',
        userinfoEndpoint: 'https://authentik.internal/userinfo',
      }),
    );
    expect(endpoints.authorizationEndpoint).toBe('https://public.example/authorize');
    expect(endpoints.tokenEndpoint).toBe('https://authentik.internal/token');
    expect(endpoints.jwksUri).toBe('https://authentik.internal/jwks');
    expect(endpoints.userinfoEndpoint).toBe('https://authentik.internal/userinfo');
    // The issuer is the canonical issuer, matched later against the id_token iss.
    expect(endpoints.issuer).toBe(issuerUrl);
  });

  it('OIDC discovery resolves the advertised endpoints when no overrides are set', async () => {
    const endpoints = await resolveEndpoints(cfg());
    expect(endpoints.authorizationEndpoint).toBe(`${issuerUrl}/authorize`);
    expect(endpoints.tokenEndpoint).toBe(`${issuerUrl}/token`);
    expect(endpoints.jwksUri).toBe(`${issuerUrl}/jwks`);
    expect(endpoints.userinfoEndpoint).toBe(`${issuerUrl}/userinfo`);
  });

  it('a partial override coexists with discovery for the rest (split-horizon)', async () => {
    const endpoints = await resolveEndpoints(
      cfg({ authorizationEndpoint: 'https://public.example/authorize' }),
    );
    // The explicit authorize wins; token/jwks fall through to discovery.
    expect(endpoints.authorizationEndpoint).toBe('https://public.example/authorize');
    expect(endpoints.tokenEndpoint).toBe(`${issuerUrl}/token`);
    expect(endpoints.jwksUri).toBe(`${issuerUrl}/jwks`);
  });

  it('keycloak template is the last resort when discovery is unreachable', async () => {
    const endpoints = await resolveEndpoints(
      cfg({ providerType: 'keycloak', issuerUrl: `${CLOSED_ISSUER}/realms/corp` }),
    );
    expect(endpoints.authorizationEndpoint).toBe(`${CLOSED_ISSUER}/realms/corp/protocol/openid-connect/auth`);
    expect(endpoints.tokenEndpoint).toBe(`${CLOSED_ISSUER}/realms/corp/protocol/openid-connect/token`);
    expect(endpoints.jwksUri).toBe(`${CLOSED_ISSUER}/realms/corp/protocol/openid-connect/certs`);
  });

  it('authentik template is the last resort when discovery is unreachable', async () => {
    const endpoints = await resolveEndpoints(
      cfg({ providerType: 'authentik', issuerUrl: `${CLOSED_ISSUER}/application/o/corp` }),
    );
    expect(endpoints.authorizationEndpoint).toBe(`${CLOSED_ISSUER}/application/o/corp/application/o/authorize/`);
    expect(endpoints.tokenEndpoint).toBe(`${CLOSED_ISSUER}/application/o/corp/application/o/token/`);
    expect(endpoints.jwksUri).toBe(`${CLOSED_ISSUER}/application/o/corp/application/o/jwks/`);
  });

  it('generic oidc template derives /authorize + /token when discovery is unreachable', async () => {
    const endpoints = await resolveEndpoints(cfg({ providerType: 'oidc', issuerUrl: CLOSED_ISSUER }));
    expect(endpoints.authorizationEndpoint).toBe(`${CLOSED_ISSUER}/authorize`);
    expect(endpoints.tokenEndpoint).toBe(`${CLOSED_ISSUER}/token`);
  });

  it('rejects a config that resolves to no usable authorize/token endpoint', async () => {
    await expect(resolveEndpoints(cfg({ providerType: 'oidc', issuerUrl: '' }))).rejects.toThrow(
      /no usable authorization or token endpoint/i,
    );
  });
});

// ── buildAuthorizationUrl ─────────────────────────────────────────────────────

describe('buildAuthorizationUrl', () => {
  it('assembles the URL against the resolved front-channel authorization endpoint', async () => {
    const endpoints = await resolveEndpoints(cfg());
    const url = new URL(buildAuthorizationUrl(cfg(), endpoints, 'opaque-state-123', 'https://app.example/callback'));
    expect(url.origin).toBe(issuerUrl);
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/callback');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('opaque-state-123');
  });

  it('honors an explicit public authorization endpoint override', async () => {
    const endpoints: ProviderEndpoints = {
      issuer: issuerUrl,
      authorizationEndpoint: 'https://public.example/authorize',
      tokenEndpoint: 'https://internal.example/token',
    };
    const url = new URL(buildAuthorizationUrl(cfg(), endpoints, 's', 'https://app.example/cb'));
    expect(url.origin).toBe('https://public.example');
    expect(url.pathname).toBe('/authorize');
  });
});

// ── exchangeCode ──────────────────────────────────────────────────────────────

describe('exchangeCode', () => {
  it('POSTs the code+secret form to the back-channel token endpoint and returns a redacted summary', async () => {
    const endpoints = await resolveEndpoints(cfg());
    const summaryStr = await exchangeCode(cfg(), endpoints, 'auth-code-1', 'https://app.example/callback');

    // The provider received the correct form-encoded grant on /token.
    expect(received.path).toBe('/token');
    expect(received.contentType).toMatch(/application\/x-www-form-urlencoded/);
    expect(received.body.grant_type).toBe('authorization_code');
    expect(received.body.code).toBe('auth-code-1');
    expect(received.body.redirect_uri).toBe('https://app.example/callback');
    expect(received.body.client_id).toBe(CLIENT_ID);
    expect(received.body.client_secret).toBe(SECRET_VALUE);

    // The summary is redacted: no raw access/refresh token nor client secret leaks.
    expect(summaryStr).not.toContain('ACCESS-XYZ');
    expect(summaryStr).not.toContain('REFRESH-XYZ');
    expect(summaryStr).not.toContain(SECRET_VALUE);

    const summary = JSON.parse(summaryStr);
    // It DOES carry the id_token (the signed identity assertion) for verification.
    expect(typeof summary.idToken).toBe('string');
    expect(summary.idTokenClaims.sub).toBe('user-123');
    expect(summary.tokenType).toBe('Bearer');
    expect(summary.access_token).toBeUndefined();
    expect(summary.refresh_token).toBeUndefined();
  });

  it('surfaces a clear error on a provider 400 without leaking the response body', async () => {
    const endpoints = await resolveEndpoints(cfg());
    tokenResponse = () => ({ status: 400, json: { error: 'invalid_grant', hint: 'do-not-leak' } });
    let message = '';
    try {
      await exchangeCode(cfg(), endpoints, 'bad-code', 'https://app.example/callback');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/400/);
    expect(message).not.toContain('invalid_grant');
    expect(message).not.toContain('do-not-leak');
  });

  it('output feeds resolveSubject end-to-end (JWKS-verified)', async () => {
    const endpoints = await resolveEndpoints(cfg({ allowedDomains: ['corp.example'] }));
    tokenResponse = () => ({
      status: 200,
      json: { id_token: signIdToken(claims({ sub: 'user-777', email: 'carol@corp.example', name: 'Carol' })), token_type: 'Bearer' },
    });
    const summary = await exchangeCode(cfg({ allowedDomains: ['corp.example'] }), endpoints, 'code', 'https://app.example/callback');
    const subject = await resolveSubject(cfg({ allowedDomains: ['corp.example'] }), endpoints, summary);
    expect(subject.externalSubject).toBe('user-777');
    expect(subject.email).toBe('carol@corp.example');
  });
});

// ── resolveSubject: JWKS signature verification ──────────────────────────────

describe('resolveSubject (JWKS verification)', () => {
  /** A redacted summary carrying a token signed for the given claims. */
  function summaryFor(over: Record<string, unknown> = {}, kid?: string): string {
    const c = claims(over);
    return JSON.stringify({ idToken: signIdToken(c, kid), idTokenClaims: c, tokenType: 'Bearer' });
  }

  it('verifies the id_token signature and maps the claims to a PrincipalSubject', async () => {
    const endpoints = await resolveEndpoints(cfg());
    const subject = await resolveSubject(cfg(), endpoints, summaryFor());
    expect(subject.userId).toBe('sso:authentik-corp:user-123');
    expect(subject.kind).toBe('human');
    expect(subject.issuer).toBe('authentik-corp');
    expect(subject.externalSubject).toBe('user-123');
    expect(subject.displayName).toBe('Alice');
    expect(subject.email).toBe('alice@corp.example');
  });

  it('falls back to preferred_username / given+family when the name claim is absent', async () => {
    const endpoints = await resolveEndpoints(cfg());
    // No `name` (many IdPs — Keycloak/Authentik dev — send only
    // preferred_username): the display name falls back to it rather than
    // leaving the UI to show the opaque subject id.
    const pref = await resolveSubject(cfg(), endpoints, summaryFor({ name: undefined, preferred_username: 'alice.dev' }));
    expect(pref.displayName).toBe('alice.dev');
    // given_name + family_name compose when preferred_username is also absent.
    const composed = await resolveSubject(cfg(), endpoints, summaryFor({ name: undefined, given_name: 'Ada', family_name: 'Lovelace' }));
    expect(composed.displayName).toBe('Ada Lovelace');
    // Full `name` still wins when present.
    expect((await resolveSubject(cfg(), endpoints, summaryFor({ preferred_username: 'ignored' }))).displayName).toBe('Alice');
  });

  it('rejects a TAMPERED id_token (payload altered after signing)', async () => {
    const endpoints = await resolveEndpoints(cfg());
    const valid = JSON.parse(summaryFor());
    // Swap in a forged payload while keeping the original signature → verify fails.
    const [h, , s] = valid.idToken.split('.');
    const forgedPayload = b64url(claims({ sub: 'attacker', email: 'attacker@corp.example' }));
    valid.idToken = `${h}.${forgedPayload}.${s}`;
    await expect(resolveSubject(cfg(), endpoints, JSON.stringify(valid))).rejects.toThrow(/signature/i);
  });

  it('rejects a token signed by an UNKNOWN key (kid not in the JWKS)', async () => {
    const endpoints = await resolveEndpoints(cfg());
    // Sign with a foreign key but claim a kid the JWKS does not carry.
    const foreign = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const header = { alg: 'RS256', typ: 'JWT', kid: 'unknown-kid' };
    const input = `${b64url(header)}.${b64url(claims())}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(input), foreign).toString('base64url');
    const summary = JSON.stringify({ idToken: `${input}.${sig}`, idTokenClaims: claims(), tokenType: 'Bearer' });
    await expect(resolveSubject(cfg(), endpoints, summary)).rejects.toThrow(/no signing key|signature/i);
  });

  it('rejects an issuer mismatch even with a valid signature', async () => {
    const endpoints = await resolveEndpoints(cfg());
    await expect(resolveSubject(cfg(), endpoints, summaryFor({ iss: 'https://evil.example' }))).rejects.toThrow(
      /issuer mismatch/i,
    );
  });

  it('rejects an audience mismatch even with a valid signature', async () => {
    const endpoints = await resolveEndpoints(cfg());
    await expect(resolveSubject(cfg(), endpoints, summaryFor({ aud: 'some-other-client' }))).rejects.toThrow(
      /audience mismatch/i,
    );
  });

  it('rejects an expired id_token even with a valid signature', async () => {
    const endpoints = await resolveEndpoints(cfg());
    await expect(
      resolveSubject(cfg(), endpoints, summaryFor({ exp: Math.floor(Date.now() / 1000) - 60 })),
    ).rejects.toThrow(/expired/i);
  });

  it('rejects metadata with no subject', async () => {
    const endpoints = await resolveEndpoints(cfg());
    await expect(resolveSubject(cfg(), endpoints, summaryFor({ sub: '' }))).rejects.toThrow(/no subject/i);
  });

  it('enforces allowedDomains (foreign rejected, listed allowed, unset allows all)', async () => {
    const endpoints = await resolveEndpoints(cfg());
    const foreign = summaryFor({ sub: 'user-9', name: 'Bob', email: 'bob@other.example' });
    const listed = summaryFor({ sub: 'user-9', name: 'Bob', email: 'bob@corp.example' });

    await expect(resolveSubject(cfg({ allowedDomains: ['corp.example'] }), endpoints, foreign)).rejects.toThrow(/domain/i);
    expect((await resolveSubject(cfg({ allowedDomains: ['corp.example'] }), endpoints, listed)).email).toBe('bob@corp.example');
    expect((await resolveSubject(cfg(), endpoints, foreign)).email).toBe('bob@other.example');
  });
});

// ── resolveSubject: userinfo fallback + unverifiable rejection ───────────────

describe('resolveSubject (fallback + rejection)', () => {
  function summaryFor(over: Record<string, unknown> = {}): string {
    const c = claims(over);
    return JSON.stringify({ idToken: signIdToken(c), idTokenClaims: c, tokenType: 'Bearer' });
  }

  it('falls back to the userinfo endpoint (claim validation) when no JWKS is available', async () => {
    const endpoints: ProviderEndpoints = {
      issuer: issuerUrl,
      authorizationEndpoint: `${issuerUrl}/authorize`,
      tokenEndpoint: `${issuerUrl}/token`,
      userinfoEndpoint: `${issuerUrl}/userinfo`,
    };
    const subject = await resolveSubject(cfg(), endpoints, summaryFor());
    expect(subject.externalSubject).toBe('user-123');
    // The fallback still enforces iss/aud/exp.
    await expect(resolveSubject(cfg(), endpoints, summaryFor({ iss: 'https://evil.example' }))).rejects.toThrow(/issuer/i);
  });

  it('rejects metadata when neither a JWKS nor a userinfo endpoint is available', async () => {
    const endpoints: ProviderEndpoints = {
      issuer: issuerUrl,
      authorizationEndpoint: `${issuerUrl}/authorize`,
      tokenEndpoint: `${issuerUrl}/token`,
    };
    await expect(resolveSubject(cfg(), endpoints, summaryFor())).rejects.toThrow(/no JWKS or userinfo/i);
  });
});
