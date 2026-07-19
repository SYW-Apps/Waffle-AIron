import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ensureInstanceIdentity, getInstanceIdentity } from '../../src/server/instance.js';
import {
  verifyBuiltinAdmin,
  isReservedSubject,
  authenticateSession,
  authenticateMaster,
} from '../../src/server/auth.js';
import { createWebSession, getWebSessionById } from '../../src/server/websessions.js';
import { initHostInstance, DEV_UNIT_ID } from '../../src/server/http.js';
import { getOrganizationUnit } from '../../src/server/organization.js';
import { startDevSession } from '../../src/server/web.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Instance Identity Repository + boot-reserved built-in subjects (sdd_host).
//
// The built-in subjects are identified by PERSISTED random UUIDs seeded once at
// first boot (<dataDir>/instance.json) by the lifecycle init entrypoint — an
// account NAME is never a subject id, so the name stops being an attack
// surface. The legacy 'builtin:*' literals are no longer live subject ids but
// remain reserved (unclaimable). An unseeded instance recognizes NO built-in
// subjects (fail closed).
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('instance identity (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-instance-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
      builtinAdminUser: 'root-operator',
      builtinAdminPassword: 'a-very-strong-builtin-password',
    };
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── create-once seeding ─────────────────────────────────────────────────────

  it('seeds two distinct random UUIDs once and returns the same record on every later boot', () => {
    expect(getInstanceIdentity(dataDir)).toBeNull(); // never seeded

    const first = ensureInstanceIdentity(dataDir, '2026-01-01T00:00:00.000Z');
    expect(first.superadminUserId).toMatch(UUID_RE);
    expect(first.localDevUserId).toMatch(UUID_RE);
    expect(first.superadminUserId).not.toBe(first.localDevUserId);
    expect(first.createdAt).toBe('2026-01-01T00:00:00.000Z');

    // Persisted at <dataDir>/instance.json.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'instance.json'), 'utf8'));
    expect(onDisk.superadminUserId).toBe(first.superadminUserId);

    // Idempotent: re-seeding NEVER rotates the ids.
    const again = ensureInstanceIdentity(dataDir, '2030-12-31T00:00:00.000Z');
    expect(again).toEqual(first);
    expect(getInstanceIdentity(dataDir)).toEqual(first);
  });

  it('fails loudly on a malformed instance.json instead of silently reseeding', () => {
    fs.writeFileSync(path.join(dataDir, 'instance.json'), '{"nope": true}');
    expect(() => getInstanceIdentity(dataDir)).toThrow(/malformed instance identity/i);
    expect(() => ensureInstanceIdentity(dataDir)).toThrow(/malformed instance identity/i);
  });

  // ── verifyBuiltinAdmin: the login NAME never becomes the subject id ─────────

  it('verifyBuiltinAdmin resolves the PERSISTED super-admin UUID, and fails closed when unseeded', () => {
    // Unseeded instance: correct credentials still resolve to null.
    expect(verifyBuiltinAdmin(cfg, 'root-operator', 'a-very-strong-builtin-password')).toBeNull();

    const identity = ensureInstanceIdentity(dataDir);
    const subject = verifyBuiltinAdmin(cfg, 'root-operator', 'a-very-strong-builtin-password');
    expect(subject).toEqual({ userId: identity.superadminUserId, kind: 'human', issuer: 'local', displayName: 'root-operator' });
    // The subject id is the boot-reserved UUID — never the login name and never
    // the legacy literal.
    expect(subject!.userId).not.toBe('root-operator');
    expect(subject!.userId).not.toBe('builtin:superadmin');

    // Wrong credentials still resolve to null.
    expect(verifyBuiltinAdmin(cfg, 'root-operator', 'wrong')).toBeNull();
    expect(verifyBuiltinAdmin(cfg, 'wrong', 'a-very-strong-builtin-password')).toBeNull();
  });

  // ── instance-admin recognition compares the persisted UUIDs ─────────────────

  it('a session bound to the persisted super-admin UUID is instanceAdmin; the legacy literal no longer is', () => {
    const identity = ensureInstanceIdentity(dataDir);

    const uuidSession = createWebSession(dataDir, {
      id: '',
      subject: { userId: identity.superadminUserId, kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(authenticateSession(dataDir, uuidSession.id).permissionSubject?.instanceAdmin).toBe(true);

    // The legacy guessable literal is DEAD as a live subject id.
    const legacySession = createWebSession(dataDir, {
      id: '',
      subject: { userId: 'builtin:superadmin', kind: 'human', issuer: 'local' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(authenticateSession(dataDir, legacySession.id).permissionSubject?.instanceAdmin).toBe(false);

    // A foreign issuer presenting the UUID can never collide into the bypass.
    const foreignSession = createWebSession(dataDir, {
      id: '',
      subject: { userId: identity.superadminUserId, kind: 'human', issuer: 'https://idp.example' },
      projects: ['*'],
      createdAt: '',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(authenticateSession(dataDir, foreignSession.id).permissionSubject?.instanceAdmin).toBe(false);

    // The bootstrap master is instance-admin regardless of the instance identity.
    expect(authenticateMaster(MASTER).permissionSubject?.instanceAdmin).toBe(true);
  });

  // ── reserved-subject guard: unclaimable ids ──────────────────────────────────

  it('isReservedSubject reserves the persisted UUIDs AND the legacy literals', () => {
    // The legacy literals are reserved even before seeding.
    expect(isReservedSubject(dataDir, 'builtin:superadmin')).toBe(true);
    expect(isReservedSubject(dataDir, 'builtin:localdev')).toBe(true);
    expect(isReservedSubject(dataDir, 'u-ordinary')).toBe(false);

    const identity = ensureInstanceIdentity(dataDir);
    expect(isReservedSubject(dataDir, identity.superadminUserId)).toBe(true);
    expect(isReservedSubject(dataDir, identity.localDevUserId)).toBe(true);
    expect(isReservedSubject(dataDir, 'u-ordinary')).toBe(false);
  });

  // ── lifecycle init entrypoint ────────────────────────────────────────────────

  it('initHostInstance seeds the identity; under devMode it also ensures the synthetic local unit (idempotently)', () => {
    // Hosted posture: identity seeded, NO synthetic unit.
    initHostInstance(cfg);
    expect(getInstanceIdentity(dataDir)).not.toBeNull();
    expect(getOrganizationUnit(dataDir, DEV_UNIT_ID)).toBeNull();

    // Dev posture: the synthetic local unit exists so dev projects can be placed.
    const devCfg: HostConfig = { ...cfg, authEnabled: false, devMode: true };
    initHostInstance(devCfg);
    const unit = getOrganizationUnit(dataDir, DEV_UNIT_ID);
    expect(unit?.id).toBe(DEV_UNIT_ID);

    // Idempotent: a re-run neither duplicates the unit nor rotates the identity.
    const before = getInstanceIdentity(dataDir);
    initHostInstance(devCfg);
    expect(getInstanceIdentity(dataDir)).toEqual(before);
    expect(getOrganizationUnit(dataDir, DEV_UNIT_ID)?.createdAt).toBe(unit?.createdAt);
  });

  it('startDevSession binds the persisted local-developer UUID (and refuses before init seeded it)', () => {
    const devCfg: HostConfig = { ...cfg, authEnabled: false, devMode: true };

    // Before init: fail closed rather than minting a nameless session.
    expect(() => startDevSession(devCfg)).toThrow(/instance identity is not seeded/i);

    initHostInstance(devCfg);
    const identity = getInstanceIdentity(dataDir)!;
    const sessionId = startDevSession(devCfg);
    const principal = authenticateSession(dataDir, sessionId);
    expect(principal.subject?.userId).toBe(identity.localDevUserId);
    expect(principal.permissionSubject?.instanceAdmin).toBe(true); // full local access
    // The stored session narrows to the one local project (the instance-admin
    // DISPLAY projection widens to '*', but the record itself stays narrowed).
    expect(getWebSessionById(dataDir, sessionId)?.projects).toEqual(['local']);
  });
});
