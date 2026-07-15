import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getLoginOptions, serveApp } from '../../src/server/web.js';
import { upsertIdentityProviderRecord, listIdentityProviderRecords } from '../../src/server/policy.js';
import { routeData } from '../../src/server/http.js';
import type { HostConfig, IdentityProviderConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Dynamic login screen (sdd_host): the pre-auth GET /web/login-options read.
//
// web_orchestrator.getLoginOptions projects WHICH sign-in methods exist —
// passwordLogin (the env-anchored built-in admin configured on the host config)
// plus one { id, displayName } entry per ENABLED identity provider — and NOTHING
// else: no secrets, clientIds, issuer URLs, or endpoints ever cross the pre-auth
// boundary. The portal route is unauthenticated (no session, no CSRF — a GET)
// and 404-gated with every /web route on exposure.webUiEnabled. displayName is a
// new IdentityProviderConfig field and must survive the policy repository's
// whitelist projection (sanitizeIdentityProvider drops any field not listed).
// ---------------------------------------------------------------------------

const SECRET_REF = 'oidc-client-secret-ref';

function provider(over: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig {
  return {
    id: 'corp-keycloak',
    providerType: 'keycloak',
    issuerUrl: 'https://sso.corp.example/realms/main',
    clientId: 'wairon-client-id',
    clientSecretRef: SECRET_REF,
    tokenEndpoint: 'http://sso.internal:9000/token',
    enabled: true,
    updatedAt: '2026-07-14T00:00:00.000Z',
    ...over,
  };
}

// ── Web orchestrator: getLoginOptions ────────────────────────────────────────

describe('web orchestrator getLoginOptions (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-login-options-'));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('passwordLogin reflects the env-anchored built-in admin config: true only when BOTH values are set', () => {
    // The serve command copies WAIRON_ADMIN_USER/_PASSWORD onto the resolved
    // host config; getLoginOptions reads that config, so unset env = disabled.
    expect(getLoginOptions(cfg).passwordLogin).toBe(false);
    expect(getLoginOptions({ ...cfg, builtinAdminUser: 'admin' }).passwordLogin).toBe(false);
    expect(getLoginOptions({ ...cfg, builtinAdminPassword: 'pw' }).passwordLogin).toBe(false);
    expect(
      getLoginOptions({ ...cfg, builtinAdminUser: 'admin', builtinAdminPassword: 'pw' }).passwordLogin,
    ).toBe(true);
  });

  it('lists only ENABLED providers; displayName falls back to the provider id', () => {
    upsertIdentityProviderRecord(dataDir, provider({ id: 'corp-sso', displayName: 'Corporate SSO' }));
    upsertIdentityProviderRecord(dataDir, provider({ id: 'bare' })); // no displayName set
    upsertIdentityProviderRecord(dataDir, provider({ id: 'retired', enabled: false }));

    const options = getLoginOptions(cfg);
    expect(options.providers).toEqual([
      { id: 'corp-sso', displayName: 'Corporate SSO' },
      { id: 'bare', displayName: 'bare' },
    ]);
  });

  it('no providers configured → an empty provider list (no SSO section to render)', () => {
    expect(getLoginOptions(cfg).providers).toEqual([]);
  });

  it('SECURITY: the pre-auth payload carries ONLY { id, displayName } — never secrets, clientIds, issuers, or endpoints', () => {
    upsertIdentityProviderRecord(
      dataDir,
      provider({ id: 'corp-sso', displayName: 'Corporate SSO', adminGroupClaims: ['wairon-admins'] }),
    );

    const options = getLoginOptions(cfg);
    expect(options.providers).toHaveLength(1);
    // Exactly the two fields a login page needs — nothing else.
    expect(Object.keys(options.providers[0]).sort()).toEqual(['displayName', 'id']);

    const raw = JSON.stringify(options);
    expect(raw).not.toContain(SECRET_REF);
    expect(raw).not.toContain('wairon-client-id');
    expect(raw).not.toContain('sso.corp.example');
    expect(raw).not.toContain('sso.internal');
    expect(raw).not.toContain('clientId');
    expect(raw).not.toContain('clientSecretRef');
    expect(raw).not.toContain('issuerUrl');
    expect(raw).not.toContain('tokenEndpoint');
    expect(raw).not.toContain('adminGroupClaims');
  });
});

// ── Web portal HTTP mount: GET /web/login-options ────────────────────────────

describe('GET /web/login-options HTTP mount (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;

  function enableWebUi(): void {
    fs.writeFileSync(
      path.join(dataDir, 'exposure-policy.json'),
      JSON.stringify({ webUiEnabled: true, requireTls: false }),
    );
  }

  interface RawResponse {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }
  function raw(opts: { method: string; path: string; headers?: Record<string, string> }): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: opts.method, path: opts.path, headers: opts.headers },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-login-options-http-'));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    server = http.createServer((req, res) => routeData(cfg, req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('webUiEnabled=false (default): answers 404 like every /web route', async () => {
    upsertIdentityProviderRecord(dataDir, provider({ id: 'corp-sso' }));
    expect((await raw({ method: 'GET', path: '/web/login-options' })).status).toBe(404);
  });

  it('webUiEnabled=true: serves the options UNAUTHENTICATED — no session cookie, no CSRF header', async () => {
    enableWebUi();
    upsertIdentityProviderRecord(dataDir, provider({ id: 'corp-sso', displayName: 'Corporate SSO' }));
    upsertIdentityProviderRecord(dataDir, provider({ id: 'retired', enabled: false }));

    // Deliberately NO cookie and NO X-Wairon-Web header: this is a pre-auth GET.
    const res = await raw({ method: 'GET', path: '/web/login-options' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    const body = JSON.parse(res.body);
    expect(body.passwordLogin).toBe(false); // no built-in admin on this config
    expect(body.providers).toEqual([{ id: 'corp-sso', displayName: 'Corporate SSO' }]);
    // No secret material leaks over the wire.
    expect(res.body).not.toContain(SECRET_REF);
    expect(res.body).not.toContain('wairon-client-id');

    // With the built-in admin configured (env → host config), the flag flips.
    cfg.builtinAdminUser = 'admin';
    cfg.builtinAdminPassword = 'strong-password';
    const withPw = await raw({ method: 'GET', path: '/web/login-options' });
    expect(JSON.parse(withPw.body).passwordLogin).toBe(true);
  });
});

// ── displayName round-trip through the policy repository ─────────────────────

describe('IdentityProviderConfig.displayName round-trip (sdd_host policy repository)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-idp-displayname-'));
  });
  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('displayName survives the sanitizeIdentityProvider whitelist (persist + read back)', () => {
    // Attach an off-whitelist field alongside displayName: the projection must
    // keep displayName and still drop the unknown field (the raw-secret guard).
    const config = { ...provider({ id: 'corp-sso', displayName: 'Corporate SSO' }), clientSecret: 'raw-secret' };
    const stored = upsertIdentityProviderRecord(dataDir, config as IdentityProviderConfig);
    expect(stored.displayName).toBe('Corporate SSO');
    expect((stored as Record<string, unknown>)['clientSecret']).toBeUndefined();

    const read = listIdentityProviderRecords(dataDir);
    expect(read).toHaveLength(1);
    expect(read[0].displayName).toBe('Corporate SSO');
    expect(JSON.stringify(read)).not.toContain('raw-secret');
  });

  it('a config without displayName stays without it (no empty-string pollution)', () => {
    upsertIdentityProviderRecord(dataDir, provider({ id: 'bare' }));
    expect(listIdentityProviderRecords(dataDir)[0].displayName).toBeUndefined();
  });
});

// ── Served client shell: the dynamic login screen wiring ─────────────────────

describe('web portal client shell dynamic login screen (sdd_host)', () => {
  const html = serveApp('/');

  it('fetches /web/login-options and renders per-provider sign-in buttons', () => {
    expect(html).toContain('/web/login-options');
    expect(html).toContain('Sign in with '); // dynamic per-provider label
    expect(html).toContain('btn-sso');
    // The existing SSO start flow is reused per button.
    expect(html).toContain('/web/sso/start');
  });

  it('has NO free-text provider input and shows the no-method message when nothing is configured', () => {
    expect(html).not.toContain('id="pid"');
    expect(html).not.toContain('Sign in with SSO'); // the old generic button
    expect(html).toContain('No sign-in method is configured');
  });

  it('the IdP admin form carries the new Display name field', () => {
    expect(html).toContain('pDisplay');
    expect(html).toContain('displayName');
  });
});
