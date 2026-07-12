import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listIdentityProviderRecords,
  upsertIdentityProviderRecord,
  removeIdentityProviderRecord,
} from '../../src/server/policy.js';
import type { IdentityProviderConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Policy Repository (sdd_host) — identity-provider (SSO) configuration storage,
// file-backed at <dataDir>/identity-providers.json alongside the pack policy.
// Exercised through the exported storage facade over a real <dataDir>: missing →
// empty, malformed → storage error naming the path, server-side updatedAt
// stamping, secret-safe whitelist projection (clientSecretRef only), in-place
// upsert by id, not-found remove, and multi-provider coexistence.
// ---------------------------------------------------------------------------

function idp(over: Partial<IdentityProviderConfig> = {}): IdentityProviderConfig {
  return { id: 'idp-a', providerType: 'oidc', enabled: true, updatedAt: '', ...over };
}

describe('identity provider config storage (sdd_host policy repository)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-idp-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  const storePath = (): string => path.join(dataDir, 'identity-providers.json');

  // ── list: missing / empty ────────────────────────────────────────────────

  it('list returns an empty array when no providers file exists', () => {
    expect(listIdentityProviderRecords(dataDir)).toEqual([]);
  });

  it('a malformed store fails with a storage error naming the path', () => {
    fs.writeFileSync(storePath(), '{ not json');
    expect(() => listIdentityProviderRecords(dataDir)).toThrow(/identity-providers\.json/);
  });

  // ── upsert: insert + reload ──────────────────────────────────────────────

  it('upsert inserts a provider and reload returns exactly it', () => {
    const stored = upsertIdentityProviderRecord(
      dataDir,
      idp({ clientId: 'cid', clientSecretRef: 'secret://ref-a', issuerUrl: 'https://issuer.example' }),
    );
    expect(stored.id).toBe('idp-a');
    expect(stored.clientSecretRef).toBe('secret://ref-a');

    const reloaded = listIdentityProviderRecords(dataDir);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toEqual(stored);
  });

  // ── upsert: update in place ──────────────────────────────────────────────

  it('upsert updates an existing provider by id, replacing it in place', () => {
    upsertIdentityProviderRecord(dataDir, idp({ enabled: true, clientId: 'old' }));
    const updated = upsertIdentityProviderRecord(dataDir, idp({ enabled: false, clientId: 'new' }));

    const list = listIdentityProviderRecords(dataDir);
    expect(list).toHaveLength(1);
    expect(list[0].enabled).toBe(false);
    expect(list[0].clientId).toBe('new');
    expect(list[0]).toEqual(updated);
  });

  // ── updatedAt stamping ───────────────────────────────────────────────────

  it('stamps updatedAt server-side, overriding any caller-supplied value', () => {
    const before = Date.now();
    const stored = upsertIdentityProviderRecord(dataDir, idp({ updatedAt: 'not-a-real-time' }));
    expect(stored.updatedAt).not.toBe('not-a-real-time');
    expect(Date.parse(stored.updatedAt)).toBeGreaterThanOrEqual(before - 1000);
    // Persisted, not just returned.
    expect(Date.parse(listIdentityProviderRecords(dataDir)[0].updatedAt)).toBeGreaterThanOrEqual(before - 1000);
  });

  // ── secret safety: whitelist projection ──────────────────────────────────

  it('never persists a raw secret: drops fields outside the type, keeps clientSecretRef verbatim', () => {
    const dirty = {
      ...idp({ clientSecretRef: 'secret://safe-ref' }),
      clientSecret: 'RAW-CLIENT-SECRET',
      extraneous: 'should-be-dropped',
    } as unknown as IdentityProviderConfig;

    const stored = upsertIdentityProviderRecord(dataDir, dirty);
    expect((stored as Record<string, unknown>).clientSecret).toBeUndefined();
    expect((stored as Record<string, unknown>).extraneous).toBeUndefined();
    expect(stored.clientSecretRef).toBe('secret://safe-ref');

    // And nothing leaked onto disk.
    const raw = fs.readFileSync(storePath(), 'utf8');
    expect(raw).not.toContain('RAW-CLIENT-SECRET');
    expect(raw).not.toContain('should-be-dropped');
    expect(raw).toContain('secret://safe-ref');
  });

  // ── multiple providers coexist ───────────────────────────────────────────

  it('multiple providers coexist and preserve order across an in-place update', () => {
    upsertIdentityProviderRecord(dataDir, idp({ id: 'idp-1', providerType: 'keycloak' }));
    upsertIdentityProviderRecord(dataDir, idp({ id: 'idp-2', providerType: 'google' }));
    upsertIdentityProviderRecord(dataDir, idp({ id: 'idp-3', providerType: 'entra' }));
    upsertIdentityProviderRecord(dataDir, idp({ id: 'idp-2', providerType: 'google', enabled: false }));

    const list = listIdentityProviderRecords(dataDir);
    expect(list.map((c) => c.id)).toEqual(['idp-1', 'idp-2', 'idp-3']);
    expect(list.find((c) => c.id === 'idp-2')?.enabled).toBe(false);
  });

  // ── remove + not-found ───────────────────────────────────────────────────

  it('removes a provider by id and then reports it missing', () => {
    upsertIdentityProviderRecord(dataDir, idp({ id: 'idp-x' }));
    upsertIdentityProviderRecord(dataDir, idp({ id: 'idp-y' }));

    removeIdentityProviderRecord(dataDir, 'idp-x');
    expect(listIdentityProviderRecords(dataDir).map((c) => c.id)).toEqual(['idp-y']);

    expect(() => removeIdentityProviderRecord(dataDir, 'idp-x')).toThrow(/not found/i);
  });

  it('removing an id that never existed (no file at all) is a not-found error', () => {
    expect(() => removeIdentityProviderRecord(dataDir, 'ghost')).toThrow(/not found/i);
  });
});
