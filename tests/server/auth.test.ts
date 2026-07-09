import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { authenticate, authenticateCredential, authenticateMaster } from '../../src/server/auth.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import type { ApiKeyRecord, PrincipalSubject, ProjectGrant } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Auth Specialist (sdd_host) — subject/grant resolution, expiry/revocation, and
// the dual-credential authenticateCredential entry point. Records are written to
// a real credentials.json via createCredential so the salted-hash lookup and the
// legacy-compatibility projection are exercised end-to-end.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret';

function mkRecord(over: Partial<ApiKeyRecord> & Pick<ApiKeyRecord, 'id' | 'keyHash'>): ApiKeyRecord {
  return {
    role: 'editor',
    projects: ['proj-a'],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

describe('auth specialist (sdd_host)', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-auth-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── authenticate: grant resolution ───────────────────────────────────────

  it('resolves subject and grants from the record when present', () => {
    const token = 'tok-explicit';
    const ownerSubject: PrincipalSubject = { userId: 'u-1', kind: 'human', issuer: 'local', email: 'a@b.co' };
    const grants: ProjectGrant[] = [
      { projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write', 'key:manage'], role: 'maintainer' },
    ];
    createCredential(dataDir, mkRecord({ id: 'c-1', keyHash: hashToken(token), ownerSubject, grants }));

    const p = authenticate(dataDir, token);
    expect(p.authenticated).toBe(true);
    expect(p.tokenId).toBe('c-1');
    expect(p.grants).toEqual(grants);
    expect(p.subject).toEqual(ownerSubject);
  });

  it('falls back to the editor role projection for legacy records', () => {
    const token = 'tok-editor';
    createCredential(dataDir, mkRecord({ id: 'c-ed', keyHash: hashToken(token), role: 'editor', projects: ['proj-a', 'proj-b'] }));

    const p = authenticate(dataDir, token);
    expect(p.authenticated).toBe(true);
    expect(p.subject).toBeUndefined();
    expect(p.grants).toEqual([
      { projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'], role: 'editor' },
      { projectId: 'proj-b', permissions: ['mcp:read', 'mcp:write'], role: 'editor' },
    ]);
  });

  it('falls back to an instance-wide grant for a legacy admin record', () => {
    const token = 'tok-admin';
    createCredential(dataDir, mkRecord({ id: 'c-ad', keyHash: hashToken(token), role: 'admin', projects: ['*'] }));

    const p = authenticate(dataDir, token);
    expect(p.grants).toEqual([{ projectId: '*', permissions: ['*'], role: 'admin' }]);
  });

  // ── authenticate: expiry / revocation ────────────────────────────────────

  it('rejects an expired record', () => {
    const token = 'tok-exp';
    const expiresAt = new Date(Date.now() - 60_000).toISOString();
    createCredential(dataDir, mkRecord({ id: 'c-exp', keyHash: hashToken(token), expiresAt }));

    expect(authenticate(dataDir, token).authenticated).toBe(false);
  });

  it('accepts a record whose expiresAt is still in the future', () => {
    const token = 'tok-future';
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    createCredential(dataDir, mkRecord({ id: 'c-fut', keyHash: hashToken(token), expiresAt }));

    expect(authenticate(dataDir, token).authenticated).toBe(true);
  });

  it('rejects a revoked record', () => {
    const token = 'tok-rev';
    createCredential(dataDir, mkRecord({ id: 'c-rev', keyHash: hashToken(token), revokedAt: '2026-07-05T00:00:00.000Z' }));

    expect(authenticate(dataDir, token).authenticated).toBe(false);
  });

  it('rejects an unknown token and a null token', () => {
    expect(authenticate(dataDir, 'no-such-token').authenticated).toBe(false);
    expect(authenticate(dataDir, null).authenticated).toBe(false);
  });

  // ── legacy parity: no new fields → identical core Principal ───────────────

  it('authenticates a legacy record without new fields identically to before', () => {
    const token = 'tok-legacy';
    createCredential(dataDir, mkRecord({ id: 'c-leg', keyHash: hashToken(token), role: 'editor', projects: ['proj-a'] }));

    const p = authenticate(dataDir, token);
    // The four original fields are unchanged; grants is additive, subject absent.
    expect({ tokenId: p.tokenId, role: p.role, projects: p.projects, authenticated: p.authenticated }).toEqual({
      tokenId: 'c-leg',
      role: 'editor',
      projects: ['proj-a'],
      authenticated: true,
    });
    expect(p.subject).toBeUndefined();
  });

  // ── authenticateCredential: dual-credential entry point ───────────────────

  it('accepts the master credential and returns the bootstrap admin principal', () => {
    const p = authenticateCredential(dataDir, MASTER);
    expect(p.authenticated).toBe(true);
    expect(p.role).toBe('admin');
    expect(p.projects).toEqual(['*']);
    expect(p.subject?.kind).toBe('bootstrap');
    expect(p.subject?.userId).toBe('bootstrap');
    expect(p.grants).toEqual([{ projectId: '*', permissions: ['*'], role: 'admin' }]);
  });

  it('accepts a valid bearer token via authenticateCredential (same as authenticate)', () => {
    const token = 'tok-dual';
    const ownerSubject: PrincipalSubject = { userId: 'u-2', kind: 'service', issuer: 'local' };
    createCredential(dataDir, mkRecord({ id: 'c-dual', keyHash: hashToken(token), ownerSubject }));

    expect(authenticateCredential(dataDir, token)).toEqual(authenticate(dataDir, token));
  });

  it('rejects an unknown credential and an expired token via authenticateCredential', () => {
    const token = 'tok-dual-exp';
    createCredential(
      dataDir,
      mkRecord({ id: 'c-dual-exp', keyHash: hashToken(token), expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );

    expect(authenticateCredential(dataDir, 'garbage').authenticated).toBe(false);
    expect(authenticateCredential(dataDir, token).authenticated).toBe(false);
  });

  it('does not treat the master credential as an admin token via authenticate', () => {
    // authenticate is the data-plane path: the master credential is not a stored
    // bearer token, so it must not authenticate there.
    expect(authenticate(dataDir, MASTER).authenticated).toBe(false);
  });

  // ── authenticateMaster: unchanged behavior ───────────────────────────────

  it('authenticateMaster still returns a plain admin principal with no subject/grants', () => {
    const p = authenticateMaster(MASTER);
    expect(p).toEqual({ tokenId: 'admin:master', role: 'admin', projects: ['*'], authenticated: true });
    expect(authenticateMaster('wrong').authenticated).toBe(false);
  });
});
