import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { mintKey } from '../../src/server/admin.js';
import {
  authenticate,
  authenticateCredential,
  authenticateMaster,
  authenticateSession,
} from '../../src/server/auth.js';
import { isInstanceAdmin } from '../../src/server/identity.js';
import { signInWithPassword, __resetLoginThrottle } from '../../src/server/web.js';
import { createProjectRecord } from '../../src/server/projects.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// mintKey super-admin cap (sdd_host): "built-in is the only super-admin".
//
// The legacy admin role projects to {projectId '*', permissions ['*']} and the
// '*' project wildcard is instance-wide, so `wairon host key mint --role admin
// --project '*'` used to yield a distributable *:* bearer — a second
// super-admin route beside the env-anchored built-in account. mintKey now
// refuses both shapes; only project-scoped, non-super-admin keys are mintable.
// The WAIRON_ADMIN_TOKEN master principal and the built-in password login are
// NOT minted keys and must remain full *:* super-admins.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const ADMIN_USER = 'root-operator';
const ADMIN_PASSWORD = 'a-very-strong-builtin-password';

describe('mintKey refuses instance-wide super-admin (*:*) keys (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-mint-cap-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    __resetLoginThrottle();
    cfg = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
      builtinAdminUser: ADMIN_USER,
      builtinAdminPassword: ADMIN_PASSWORD,
    };
  });

  afterEach(() => {
    __resetLoginThrottle();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  it("rejects role admin (any project): the legacy role projects to *:*", () => {
    expect(() => mintKey(cfg, MASTER, 'proj-a', 'admin')).toThrow(
      /instance-wide super-admin \(\*:\*\) keys cannot be minted/,
    );
    expect(() => mintKey(cfg, MASTER, 'proj-a', 'admin')).toThrow(/WAIRON_ADMIN_USER/);
  });

  it("rejects the '*' project wildcard (any role): instance-wide keys are not mintable", () => {
    expect(() => mintKey(cfg, MASTER, '*', 'editor')).toThrow(
      /instance-wide super-admin \(\*:\*\) keys cannot be minted/,
    );
    expect(() => mintKey(cfg, MASTER, '*', 'admin')).toThrow(
      /instance-wide super-admin \(\*:\*\) keys cannot be minted/,
    );
  });

  it('a project-scoped editor key still mints, authenticates, and is NOT instance-admin', () => {
    createProjectRecord(dataDir, 'proj-a');
    const token = mintKey(cfg, MASTER, 'proj-a', 'editor');
    expect(token).toMatch(/^wk_[0-9a-f]+$/);

    const principal = authenticate(dataDir, token);
    expect(principal.authenticated).toBe(true);
    expect(principal.role).toBe('editor');
    expect(principal.projects).toEqual(['proj-a']);
    expect(principal.grants).toEqual([
      { projectId: 'proj-a', permissions: ['mcp:read', 'mcp:write'], role: 'editor' },
    ]);
    expect(isInstanceAdmin(principal)).toBe(false);
  });

  it('the WAIRON_ADMIN_TOKEN master principal REMAINS a full *:* super-admin (not a minted key)', () => {
    const viaMaster = authenticateMaster(MASTER);
    expect(viaMaster.authenticated).toBe(true);
    expect(viaMaster.role).toBe('admin');
    expect(viaMaster.projects).toEqual(['*']);

    const viaCredential = authenticateCredential(dataDir, MASTER);
    expect(viaCredential.authenticated).toBe(true);
    expect(isInstanceAdmin(viaCredential)).toBe(true);
  });

  it('a built-in password-login session REMAINS a full *:* super-admin (not a minted key)', () => {
    const sessionId = signInWithPassword(cfg, ADMIN_USER, ADMIN_PASSWORD);
    const principal = authenticateSession(dataDir, sessionId);
    expect(principal.authenticated).toBe(true);
    expect(isInstanceAdmin(principal)).toBe(true);
  });

  it('nothing was persisted for a refused mint: the rejected key cannot exist', () => {
    expect(() => mintKey(cfg, MASTER, '*', 'admin')).toThrow();
    // No credential store file was created by the refused mint.
    const authDir = path.join(dataDir, 'auth');
    const files = fs.existsSync(authDir) ? fs.readdirSync(authDir) : [];
    expect(files.filter((f) => /key|credential/i.test(f))).toEqual([]);
  });
});
