import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { noteWebUiPosture } from '../../src/server/http.js';
import { upsertIdentityProviderRecord } from '../../src/server/policy.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// The startup line about the web UI: an operator learns whether it is served
// and how a person signs in, instead of meeting a bare 404.
// ---------------------------------------------------------------------------

describe('host_server.start: the web UI startup line', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let lines: string[];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-webui-note-'));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.join(' ')); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* windows file locks */ }
  });

  const enableWebUi = () => fs.writeFileSync(path.join(dataDir, 'exposure-policy.json'), JSON.stringify({ webUiEnabled: true }));

  it('off by default: names the exposure policy file and the guide', () => {
    noteWebUiPosture(cfg);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('off');
    expect(lines[0]).toContain(path.join(dataDir, 'exposure-policy.json'));
    expect(lines[0]).toContain('"webUiEnabled": true');
    expect(lines[0]).toContain('Web UI and sign-in');
  });

  it('on with no sign-in method: says nobody can sign in yet and what to set', () => {
    enableWebUi();
    noteWebUiPosture(cfg);
    expect(lines[0]).toMatch(/nobody can sign in yet/);
    expect(lines[0]).toContain('WAIRON_ADMIN_USER');
  });

  it('on: names the built-in admin account and each enabled identity provider', () => {
    enableWebUi();
    upsertIdentityProviderRecord(dataDir, { id: 'corp', providerType: 'oidc', issuerUrl: 'https://idp.example', enabled: true, updatedAt: '' });
    noteWebUiPosture({ ...cfg, builtinAdminUser: 'admin', builtinAdminPassword: 'a-long-password' });
    expect(lines[0]).toContain('the built-in admin account');
    expect(lines[0]).toContain('single sign-on (corp)');
    expect(lines[0]).not.toContain('a-long-password');
  });

  it('warns once per enabled provider that names no allowed redirect address, with its sentence', () => {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args.join(' ')); });
    enableWebUi();
    upsertIdentityProviderRecord(dataDir, { id: 'corp', providerType: 'oidc', issuerUrl: 'https://idp.example', enabled: true, updatedAt: '' });
    upsertIdentityProviderRecord(dataDir, { id: 'ready', providerType: 'oidc', issuerUrl: 'https://idp.example', enabled: true, allowedRedirectUris: ['https://app.example/web/sso/callback'], updatedAt: '' });
    upsertIdentityProviderRecord(dataDir, { id: 'off', providerType: 'oidc', issuerUrl: 'https://idp.example', enabled: false, updatedAt: '' });
    noteWebUiPosture(cfg);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('SSO through corp will not work until its allowed redirect addresses are set');
  });

  it('the dev server says nothing: it is always on and signs in by itself', () => {
    noteWebUiPosture({ ...cfg, devMode: true });
    expect(lines).toHaveLength(0);
  });
});
