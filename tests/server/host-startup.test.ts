import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startHostServer, PLACEHOLDER_ADMIN_TOKEN, type HostServerHandle } from '../../src/server/http.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Host server startup credential guard (sdd_host).
//
// docker-compose only guards that WAIRON_ADMIN_TOKEN is non-empty, so an
// operator who copies .env.example without editing it would run the admin API
// with a publicly known credential. startHostServer must refuse to boot on the
// shipped placeholder or a trivially-short token.
// ---------------------------------------------------------------------------

describe('startHostServer admin-token guard', () => {
  let base: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const handles: HostServerHandle[] = [];

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-startup-'));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir: base, authEnabled: true };
  });

  afterEach(() => {
    while (handles.length) handles.pop()!.close();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it('refuses to start on the shipped .env.example placeholder token', () => {
    process.env.WAIRON_ADMIN_TOKEN = PLACEHOLDER_ADMIN_TOKEN;
    expect(() => startHostServer(cfg)).toThrow(/openssl rand -hex 32/);
  });

  it('refuses to start on a token shorter than 16 characters', () => {
    process.env.WAIRON_ADMIN_TOKEN = 'short-token'; // 11 chars
    expect(() => startHostServer(cfg)).toThrow(/openssl rand -hex 32/);
  });

  it('still refuses to start when the token is unset (auth enabled)', () => {
    delete process.env.WAIRON_ADMIN_TOKEN;
    expect(() => startHostServer(cfg)).toThrow(/WAIRON_ADMIN_TOKEN is not set/);
  });

  it('starts with a strong token', () => {
    process.env.WAIRON_ADMIN_TOKEN = 'a'.repeat(64); // strong, not the placeholder
    const handle = startHostServer(cfg);
    handles.push(handle);
    expect(handle).toBeDefined();
  });

  it('does not enforce the guard when auth is disabled (--no-auth)', () => {
    process.env.WAIRON_ADMIN_TOKEN = PLACEHOLDER_ADMIN_TOKEN;
    const handle = startHostServer({ ...cfg, authEnabled: false });
    handles.push(handle);
    expect(handle).toBeDefined();
  });
});
