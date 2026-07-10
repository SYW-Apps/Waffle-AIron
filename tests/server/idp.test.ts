import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setSecret } from '../../src/utils/secrets.js';
import { buildAuthorizationUrl, exchangeCode, resolveSubject } from '../../src/server/idp.js';
import type { IdentityProviderConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Tests for the OIDC Identity Provider Adapter (sdd_host, Phase 5a). A stub OIDC
// provider runs on an ephemeral loopback http server: its /token endpoint records
// the received form and returns a crafted token response whose id_token carries a
// base64url JSON payload. Client secrets resolve from a seeded WAIRON_DATA_DIR
// secret store, exactly like production.
// ---------------------------------------------------------------------------

const SECRET_REF = 'oidc-client-secret';
const SECRET_VALUE = 'super-secret-value';

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
      if (req.method === 'POST' && req.url === '/token') {
        received.path = req.url;
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
    clientId: 'test-client',
    clientSecretRef: SECRET_REF,
    enabled: true,
    updatedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
}

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function makeIdToken(claims: unknown): string {
  return [b64url({ alg: 'RS256', typ: 'JWT' }), b64url(claims), 'sig'].join('.');
}

describe('buildAuthorizationUrl', () => {
  it('assembles response_type, client_id, redirect_uri, scope, and state', () => {
    const url = new URL(buildAuthorizationUrl(cfg(), 'opaque-state-123', 'https://app.example/callback'));
    expect(url.pathname).toBe('/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('test-client');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example/callback');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('opaque-state-123');
  });
});

describe('exchangeCode', () => {
  it('POSTs the code+secret form and returns a redacted summary without raw tokens', async () => {
    const claims = { iss: issuerUrl, sub: 'user-123', email: 'alice@corp.example', name: 'Alice', groups: ['admins'] };
    const idToken = makeIdToken(claims);
    tokenResponse = () => ({
      status: 200,
      json: { access_token: 'ACCESS-XYZ', refresh_token: 'REFRESH-XYZ', id_token: idToken, token_type: 'Bearer' },
    });

    const summaryStr = await exchangeCode(cfg(), 'auth-code-1', 'https://app.example/callback');

    // The provider received the correct form-encoded grant.
    expect(received.path).toBe('/token');
    expect(received.contentType).toMatch(/application\/x-www-form-urlencoded/);
    expect(received.body.grant_type).toBe('authorization_code');
    expect(received.body.code).toBe('auth-code-1');
    expect(received.body.redirect_uri).toBe('https://app.example/callback');
    expect(received.body.client_id).toBe('test-client');
    // The client secret was resolved from the seeded secret ref, not passed in config.
    expect(received.body.client_secret).toBe(SECRET_VALUE);

    // The returned summary is redacted: no raw tokens leak into it.
    expect(summaryStr).not.toContain('ACCESS-XYZ');
    expect(summaryStr).not.toContain('REFRESH-XYZ');
    expect(summaryStr).not.toContain(idToken);
    expect(summaryStr).not.toContain(SECRET_VALUE);

    const summary = JSON.parse(summaryStr);
    expect(summary.idTokenClaims.iss).toBe(issuerUrl);
    expect(summary.idTokenClaims.sub).toBe('user-123');
    expect(summary.idTokenClaims.email).toBe('alice@corp.example');
    expect(summary.idTokenClaims.name).toBe('Alice');
    expect(summary.tokenType).toBe('Bearer');
    expect(summary.idTokenClaims.access_token).toBeUndefined();
    expect(summary.access_token).toBeUndefined();
  });

  it('surfaces a clear error on a provider 400 without leaking the response body', async () => {
    tokenResponse = () => ({ status: 400, json: { error: 'invalid_grant', hint: 'do-not-leak' } });
    let message = '';
    try {
      await exchangeCode(cfg(), 'bad-code', 'https://app.example/callback');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/400/);
    expect(message).not.toContain('invalid_grant');
    expect(message).not.toContain('do-not-leak');
  });

  it('output feeds resolveSubject end-to-end', async () => {
    const claims = { iss: issuerUrl, sub: 'user-777', email: 'carol@corp.example', name: 'Carol' };
    tokenResponse = () => ({
      status: 200,
      json: { access_token: 'A', refresh_token: 'R', id_token: makeIdToken(claims), token_type: 'Bearer' },
    });
    const summary = await exchangeCode(cfg({ allowedDomains: ['corp.example'] }), 'code', 'https://app.example/callback');
    const subject = resolveSubject(cfg({ allowedDomains: ['corp.example'] }), summary);
    expect(subject.externalSubject).toBe('user-777');
    expect(subject.email).toBe('carol@corp.example');
  });
});

describe('resolveSubject', () => {
  function summaryFor(claims: Record<string, unknown>): string {
    return JSON.stringify({ idTokenClaims: claims, tokenType: 'Bearer' });
  }

  it('maps verified claims to a PrincipalSubject', () => {
    const subject = resolveSubject(
      cfg(),
      summaryFor({ iss: issuerUrl, sub: 'user-123', email: 'alice@corp.example', name: 'Alice', groups: ['admins'] }),
    );
    expect(subject.userId).toBe('sso:authentik-corp:user-123');
    expect(subject.kind).toBe('human');
    expect(subject.issuer).toBe('authentik-corp');
    expect(subject.externalSubject).toBe('user-123');
    expect(subject.displayName).toBe('Alice');
    expect(subject.email).toBe('alice@corp.example');
  });

  it('rejects an issuer mismatch', () => {
    expect(() => resolveSubject(cfg(), summaryFor({ iss: 'https://evil.example', sub: 'user-123' }))).toThrow(
      /issuer mismatch/i,
    );
  });

  it('rejects metadata with no subject', () => {
    expect(() => resolveSubject(cfg(), summaryFor({ iss: issuerUrl, email: 'x@corp.example' }))).toThrow(/no subject/i);
  });

  it('enforces allowedDomains (foreign rejected, listed allowed, unset allows all)', () => {
    const foreign = { iss: issuerUrl, sub: 'user-9', name: 'Bob', email: 'bob@other.example' };
    const listed = { iss: issuerUrl, sub: 'user-9', name: 'Bob', email: 'bob@corp.example' };

    // Wrong domain is rejected when allowedDomains is set.
    expect(() => resolveSubject(cfg({ allowedDomains: ['corp.example'] }), summaryFor(foreign))).toThrow(/domain/i);
    // Matching domain passes.
    expect(resolveSubject(cfg({ allowedDomains: ['corp.example'] }), summaryFor(listed)).email).toBe('bob@corp.example');
    // Unset allowedDomains permits any domain.
    expect(resolveSubject(cfg(), summaryFor(foreign)).email).toBe('bob@other.example');
  });
});
