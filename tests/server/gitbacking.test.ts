import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  listBackingBindings,
  bindScope,
  unbindScope,
  syncBackingScope,
  runPeriodicBackingSync,
  getBinding,
  backingCredentialKey,
} from '../../src/server/gitbacking.js';
import { resolveSecret, resolveGitToken, setSecret } from '../../src/utils/secrets.js';
import { ForbiddenError } from '../../src/server/errors.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { placeProject } from '../../src/server/organization.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { allow, mintUserToken, seedUnit, subjectOf } from './helpers.js';
import type { GitBackingBinding, HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Git Backing (sdd_host): CONTAINER-level backup repositories, distinct from
// the per-project real-repo binding — a unit binding mirrors the subtree
// projects' .wai/ trees into a container repo; the instance binding mirrors
// the instance-structure JSON. Exercised against LOCAL bare repos. The headline
// security pin: the SECRET STORE (auth/secrets.json) and live web sessions are
// NEVER mirrored, while hashed credentials are.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A bare "remote" with an initial empty commit on main. */
function seedBareRemote(base: string, name: string): string {
  const remote = path.join(base, `${name}.git`);
  fs.mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '-q', '.'], remote);
  const seed = path.join(base, `${name}-seed`);
  git(['clone', '-q', remote, seed], base);
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${name} backup\n`);
  git(['-c', 'user.email=s@x', '-c', 'user.name=seed', 'add', '-A'], seed);
  git(['-c', 'user.email=s@x', '-c', 'user.name=seed', 'commit', '-qm', 'init'], seed);
  git(['branch', '-M', 'main'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  return remote;
}

/** Clone the remote fresh and return the checkout path, to inspect what was pushed. */
function inspect(base: string, remote: string): string {
  const dir = fs.mkdtempSync(path.join(base, 'inspect-'));
  git(['clone', '-q', remote, '.'], dir);
  return dir;
}

describe('container-level git backing (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-backing-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    process.env.WAIRON_DATA_DIR = dataDir;
    process.env.WAIRON_GIT_NAME = 'wairon-bot';
    process.env.WAIRON_GIT_EMAIL = 'bot@localhost';
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  const bindingFor = (over: Partial<GitBackingBinding>): GitBackingBinding => ({
    id: '',
    scopeKind: 'instance',
    remote: '',
    branch: 'main',
    createdAt: '',
    createdBy: subjectOf('seeder'),
    ...over,
  });

  /** A unit with one placed project carrying a .wai tree. */
  function seedWorld(): { unitId: string } {
    const unit = seedUnit(dataDir, 'acme');
    const rec = createProjectRecord(dataDir, 'proj-a');
    fs.mkdirSync(path.join(rec.rootPath, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(rec.rootPath, '.wai', 'specs', '.index.yaml'), 'name: proj-a\n');
    placeProject(dataDir, {
      id: '',
      projectId: 'proj-a',
      unitId: unit.id,
      role: 'owner',
      createdAt: '',
      createdBy: subjectOf('seeder'),
    });
    return { unitId: unit.id };
  }

  it("a unit binding mirrors the subtree projects' .wai/ trees into the container repo and pushes", () => {
    const { unitId } = seedWorld();
    const remote = seedBareRemote(base, 'acme-container');

    const stored = bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: unitId, remote }));
    expect(stored.id).toBeTruthy();

    const published = syncBackingScope(cfg, MASTER, stored.id);
    expect(published).toBe(true);
    expect(getBinding(dataDir, stored.id)?.lastSyncAt).toBeTruthy();

    // The pushed content mirrors the placed project's .wai tree.
    const checkout = inspect(base, remote);
    expect(fs.existsSync(path.join(checkout, 'projects', 'proj-a', '.wai', 'specs', '.index.yaml'))).toBe(true);

    // A second sync with nothing changed publishes nothing (skip-if-clean).
    expect(syncBackingScope(cfg, MASTER, stored.id)).toBe(false);

    // Audited: a security-level bind + an info-level sync.
    expect(queryAuditEvents(dataDir, { action: 'git.backing.bind' })).toHaveLength(1);
    expect(queryAuditEvents(dataDir, { action: 'git.backing.sync' }).length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('the instance binding mirrors the structure JSON — NEVER the secret store or live sessions; hashed credentials yes', () => {
    seedWorld();
    // Structure collections + the files that must never leave the box.
    fs.mkdirSync(path.join(dataDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'auth', 'credentials.json'), '[]');
    fs.writeFileSync(path.join(dataDir, 'auth', 'secrets.json'), '{"git-token":"SUPER-SECRET"}');
    fs.writeFileSync(path.join(dataDir, 'web-sessions.json'), '[]');
    const remote = seedBareRemote(base, 'instance-backup');

    const stored = bindScope(cfg, MASTER, bindingFor({ remote }));
    expect(syncBackingScope(cfg, MASTER, stored.id)).toBe(true);

    const checkout = inspect(base, remote);
    // The structure is there…
    expect(fs.existsSync(path.join(checkout, 'instance', 'organization.json'))).toBe(true);
    expect(fs.existsSync(path.join(checkout, 'instance', 'projects.json'))).toBe(true);
    expect(fs.existsSync(path.join(checkout, 'instance', 'auth', 'credentials.json'))).toBe(true);
    // …and the secrets and live sessions are NOT.
    expect(fs.existsSync(path.join(checkout, 'instance', 'auth', 'secrets.json'))).toBe(false);
    expect(fs.existsSync(path.join(checkout, 'instance', 'web-sessions.json'))).toBe(false);
    // Belt and braces: the pushed tree contains the secret value nowhere —
    // `git grep` exits non-zero exactly when there is NO match.
    expect(() => git(['grep', '-l', 'SUPER-SECRET', 'HEAD', '--'], checkout)).toThrow();
  }, 30_000);

  it('one binding per scope: a re-bind replaces; unbind removes by id (repo untouched)', () => {
    const { unitId } = seedWorld();
    const remote = seedBareRemote(base, 'acme-container');

    const first = bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: unitId, remote }));
    const second = bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: unitId, remote, branch: 'main' }));
    const bindings = listBackingBindings(cfg, MASTER);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].id).toBe(second.id);
    expect(bindings[0].id).not.toBe(first.id);

    unbindScope(cfg, MASTER, second.id);
    expect(listBackingBindings(cfg, MASTER)).toEqual([]);
    expect(() => unbindScope(cfg, MASTER, second.id)).toThrow(/not found/);
  }, 30_000);

  it('scope validation: a unit binding needs an existing unit; an instance binding names no scopeId', () => {
    const remote = seedBareRemote(base, 'x');
    expect(() => bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: 'ghost', remote }))).toThrow(/Unknown organization unit/);
    expect(() => bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', remote }))).toThrow(/must name its scopeId/);
    expect(() => bindScope(cfg, MASTER, bindingFor({ scopeId: 'acme', remote }))).toThrow(/names no scopeId/);
  });

  it('resolver gates: a unit admin binds THEIR unit only; the instance binding needs instance-level admin; the listing filters', () => {
    const { unitId } = seedWorld();
    const other = seedUnit(dataDir, 'globex');
    const remote = seedBareRemote(base, 'acme-container');

    allow(dataDir, 'u-adm', 'project:admin', 'unit', unitId);
    const admToken = mintUserToken(dataDir, { id: 'k-adm', userId: 'u-adm' });

    // Their unit: allowed. (bindScope only writes the binding — no clone here.)
    const mine = bindScope(cfg, admToken, bindingFor({ scopeKind: 'unit', scopeId: unitId, remote }));
    // A foreign unit and the instance scope: refused.
    expect(() => bindScope(cfg, admToken, bindingFor({ scopeKind: 'unit', scopeId: other.id, remote }))).toThrow(ForbiddenError);
    expect(() => bindScope(cfg, admToken, bindingFor({ remote }))).toThrow(ForbiddenError);

    // The master binds the instance backup; the unit admin's listing shows ONLY their binding.
    bindScope(cfg, MASTER, bindingFor({ remote: seedBareRemote(base, 'instance-backup') }));
    expect(listBackingBindings(cfg, admToken).map((b) => b.id)).toEqual([mine.id]);
    expect(listBackingBindings(cfg, MASTER)).toHaveLength(2);

    // Unbinding a binding whose scope they do not administer is refused.
    const instanceBinding = listBackingBindings(cfg, MASTER).find((b) => b.scopeKind === 'instance')!;
    expect(() => unbindScope(cfg, admToken, instanceBinding.id)).toThrow(ForbiddenError);
    expect(() => syncBackingScope(cfg, admToken, instanceBinding.id)).toThrow(ForbiddenError);
  });

  it('an inline PAT becomes the connection credential: stored write-only, recorded as credentialRef, never in the binding record', () => {
    const { unitId } = seedWorld();
    const remote = seedBareRemote(base, 'acme-container');

    const stored = bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: unitId, remote }), 'ghp_UNIT_TOKEN');

    const key = backingCredentialKey({ scopeKind: 'unit', scopeId: unitId });
    expect(stored.credentialRef).toBe(key);
    // Resolvable via the connection key AND via the fallback resolver.
    expect(resolveSecret(key)).toBe('ghp_UNIT_TOKEN');
    expect(resolveGitToken(stored.credentialRef)).toBe('ghp_UNIT_TOKEN');

    // The raw PAT is NEVER persisted into the binding record — only the key name.
    const raw = fs.readFileSync(path.join(dataDir, 'git-backing.json'), 'utf8');
    expect(raw).not.toContain('ghp_UNIT_TOKEN');
    expect(raw).toContain(key);
  }, 30_000);

  it('distinct connections carry distinct PATs; a binding without one falls back to the shared git-token', () => {
    const a = seedUnit(dataDir, 'acme');
    const b = seedUnit(dataDir, 'globex');
    const ra = seedBareRemote(base, 'acme-container');
    const rb = seedBareRemote(base, 'globex-container');
    setSecret('git-token', 'shared-fallback');

    const bound = bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: a.id, remote: ra }), 'ghp_ACME');
    const shared = bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: b.id, remote: rb }));

    // acme uses its own PAT; globex (no PAT) resolves to the shared fallback.
    expect(resolveGitToken(bound.credentialRef)).toBe('ghp_ACME');
    expect(shared.credentialRef).toBeUndefined();
    expect(resolveGitToken(shared.credentialRef)).toBe('shared-fallback');
  }, 30_000);

  it('runPeriodicBackingSync syncs due bindings and skips not-due ones', () => {
    const { unitId } = seedWorld();
    const remote = seedBareRemote(base, 'acme-container');
    const due = bindScope(cfg, MASTER, bindingFor({ scopeKind: 'unit', scopeId: unitId, remote, periodicSyncMinutes: 1 }));
    // A manual-only binding (no interval) is never swept.
    bindScope(cfg, MASTER, bindingFor({ remote: seedBareRemote(base, 'instance-backup') }));

    runPeriodicBackingSync(cfg);
    expect(getBinding(dataDir, due.id)?.lastSyncAt).toBeTruthy();
    const instanceBinding = listBackingBindings(cfg, MASTER).find((b) => b.scopeKind === 'instance')!;
    expect(instanceBinding.lastSyncAt).toBeUndefined();
  }, 30_000);
});
