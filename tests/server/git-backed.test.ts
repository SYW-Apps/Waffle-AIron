import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as admin from '../../src/server/admin.js';
import { AdminAuthError } from '../../src/server/admin.js';
import { resolveSecret } from '../../src/utils/secrets.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Integration test for git-backed projects (sdd_git). Exercises the real git
// flow against a LOCAL bare repo acting as the remote: enable (clone onto the
// working branch), the git-aware lock (commit + push + record the commit/URL),
// collaborator sync, disable, and admin-credential rejection.
// ---------------------------------------------------------------------------

const ADMIN = 'test-admin-secret';

const PROJECT_YAML = [
  'schemaVersion: "1.0.0"',
  'name: demo',
  'projectType: backend',
  'targets:',
  '  - type: claude',
  '    outputDir: .claude/agents',
  '    enabled: true',
  'rules:',
  '  noOverlappingOwnership: true',
  '  requireOwnedPaths: true',
  '  metaAgentTags: [meta]',
  '  enforceReproducibility: true',
  '  generateComponentImplementers: true',
  '  sddRuleSeverity: {}',
  'paths:',
  '  specsDir: .wai/specs',
  'createdAt: "2026-07-04T00:00:00.000Z"',
  'updatedAt: "2026-07-04T00:00:00.000Z"',
  '',
].join('\n');

const INDEX_YAML = [
  'schemaVersion: "1.0.0"',
  'name: demo',
  'vision: Seed project for the git-backed test',
  'boundaries: []',
  'globalRequirements: []',
  'createdAt: "2026-07-04T00:00:00.000Z"',
  'updatedAt: "2026-07-04T00:00:00.000Z"',
  '',
].join('\n');

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A bare "remote" seeded with a minimal wairon project on main, plus a working
 *  clone the test can use to simulate a collaborator. */
function seedRemote(base: string): { remote: string; seed: string } {
  const remote = path.join(base, 'remote.git');
  fs.mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '-q', '.'], remote);
  const seed = path.join(base, 'seed');
  git(['clone', '-q', remote, seed], base);
  fs.mkdirSync(path.join(seed, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.wai', 'project.yaml'), PROJECT_YAML);
  fs.writeFileSync(path.join(seed, '.wai', 'specs', '.index.yaml'), INDEX_YAML);
  git(['-c', 'user.email=s@x', '-c', 'user.name=seed', 'add', '-A'], seed);
  git(['-c', 'user.email=s@x', '-c', 'user.name=seed', 'commit', '-qm', 'init'], seed);
  git(['branch', '-M', 'main'], seed);
  git(['push', '-q', 'origin', 'main'], seed);
  return { remote, seed };
}

describe('git-backed projects (sdd_git)', () => {
  let base: string;
  let dataDir: string;
  let remote: string;
  let seed: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    invalidateSpecCache();
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-git-it-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    ({ remote, seed } = seedRemote(base));
    process.env.WAIRON_ADMIN_TOKEN = ADMIN;
    process.env.WAIRON_GIT_NAME = 'wairon-bot';
    process.env.WAIRON_GIT_EMAIL = 'bot@localhost';
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  const projectRoot = () => path.join(dataDir, 'projects', 'demo');

  it('enable clones the repo onto the isolated working branch and writes git.json', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const root = projectRoot();
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).toBe('wairon/work');
    expect(fs.existsSync(path.join(root, '.wai', 'git.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.wai', 'specs', '.index.yaml'))).toBe(true);
  });

  it('lock commits + pushes the working branch and records the commit + compare URL', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const root = projectRoot();

    // Simulate an in-container edit to the spec tree.
    const idx = path.join(root, '.wai', 'specs', '.index.yaml');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/vision:.*/, 'vision: edited in the container'));
    invalidateSpecCache();

    const rec = admin.lockProject(cfg, ADMIN, 'demo');
    expect(rec.status).toBe('ready');
    expect(rec.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(rec.compareUrl).toContain('/compare/main...wairon');

    // A real lock commit landed on the working branch...
    expect(git(['log', '-1', '--pretty=%s', 'wairon/work'], root)).toContain('wairon lock');
    // ...and the remote received the working branch.
    expect(git(['branch'], remote)).toContain('wairon/work');

    // Container-local files never enter the repo.
    const tracked = git(['ls-files'], root);
    expect(tracked).not.toContain('lock.json');
    expect(tracked).not.toContain('git.json');
  });

  it('sync integrates a collaborator commit from the default branch', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    // A collaborator (the seed clone) commits to main and pushes.
    fs.writeFileSync(path.join(seed, 'COLLAB.md'), 'from a collaborator');
    git(['-c', 'user.email=c@x', '-c', 'user.name=collab', 'add', '-A'], seed);
    git(['-c', 'user.email=c@x', '-c', 'user.name=collab', 'commit', '-qm', 'collab change'], seed);
    git(['push', '-q', 'origin', 'main'], seed);

    admin.syncGit(cfg, ADMIN, 'demo');
    expect(fs.existsSync(path.join(projectRoot(), 'COLLAB.md'))).toBe(true);
  });

  it('a per-project PAT is stored write-only under git-project:<id>, recorded as credentialRef, never in git.json', () => {
    process.env.WAIRON_DATA_DIR = dataDir; // the secret store lives under the data dir
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main', 'ghp_PROJECT_TOKEN');
    const key = admin.projectGitCredentialKey('demo');

    // Status + config record only the key NAME, never the raw PAT.
    expect(admin.getGitBinding(cfg, ADMIN, 'demo').credentialRef).toBe(key);
    const gitJson = fs.readFileSync(path.join(projectRoot(), '.wai', 'git.json'), 'utf8');
    expect(gitJson).toContain(key);
    expect(gitJson).not.toContain('ghp_PROJECT_TOKEN');

    // The PAT resolves via the connection key (write-only secret store).
    expect(resolveSecret(key)).toBe('ghp_PROJECT_TOKEN');
  });

  it('disable removes the git-backing config', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    admin.disableGit(cfg, ADMIN, 'demo');
    expect(fs.existsSync(path.join(projectRoot(), '.wai', 'git.json'))).toBe(false);
  });

  it('rejects git operations with a bad admin credential', () => {
    expect(() => admin.enableGit(cfg, 'wrong', 'demo', remote, 'main')).toThrow(AdminAuthError);
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    expect(() => admin.lockProject(cfg, 'wrong', 'demo')).toThrow(AdminAuthError);
    expect(() => admin.syncGit(cfg, 'wrong', 'demo')).toThrow(AdminAuthError);
    expect(() => admin.disableGit(cfg, 'wrong', 'demo')).toThrow(AdminAuthError);
    expect(() => admin.commitProject(cfg, 'wrong', 'demo')).toThrow(AdminAuthError);
    expect(() => admin.getGitBinding(cfg, 'wrong', 'demo')).toThrow(AdminAuthError);
    expect(() => admin.configureGitSync(cfg, 'wrong', 'demo', 5)).toThrow(AdminAuthError);
  });

  // ── the .wai/-scoped commit primitive (the `git add -A` fix) ────────────────

  it("commitProject stages ONLY .wai/ — a shared repo's own code is NEVER committed by wairon", () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const root = projectRoot();

    // The team's own code lands in the shared repo alongside a spec edit.
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const team = "owns this";');
    const idx = path.join(root, '.wai', 'specs', '.index.yaml');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/vision:.*/, 'vision: scoped commit test'));

    const publish = admin.commitProject(cfg, ADMIN, 'demo', undefined, 'save specs');
    expect(publish.published).toBe(true);
    expect(publish.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // The commit carries the spec edit and NOTHING outside .wai/.
    const committed = git(['show', '--name-only', '--pretty=format:', publish.commitSha!], root);
    expect(committed).toContain('.wai/specs/.index.yaml');
    expect(committed).not.toContain('src/app.ts');
    // The team's file is still uncommitted in the working tree (untouched —
    // porcelain reports the untracked src/ directory).
    expect(git(['status', '--porcelain', '--', 'src/'], root)).toContain('?? src/');
    // And the push happened (commit = local save, push = the actual backup).
    expect(git(['log', '-1', '--pretty=%s', 'wairon/work'], remote)).toBe('save specs');
  });

  it('commitProject on a clean scope publishes nothing (a quiet project never commits noise)', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const publish = admin.commitProject(cfg, ADMIN, 'demo');
    expect(publish.published).toBe(false);
    expect(publish.commitSha).toBeUndefined();
  });

  it('a subsystem-scoped commit stages only .wai/specs/<subsystem>/ (staging convenience)', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const root = projectRoot();
    fs.mkdirSync(path.join(root, '.wai', 'specs', 'billing'), { recursive: true });
    fs.mkdirSync(path.join(root, '.wai', 'specs', 'auth'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'billing', '.index.yaml'), 'name: billing\n');
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'auth', '.index.yaml'), 'name: auth\n');

    const publish = admin.commitProject(cfg, ADMIN, 'demo', 'billing');
    expect(publish.published).toBe(true);
    const committed = git(['show', '--name-only', '--pretty=format:', publish.commitSha!], root);
    expect(committed).toContain('.wai/specs/billing/.index.yaml');
    expect(committed).not.toContain('.wai/specs/auth/.index.yaml');
  });

  it("the lock's auto-publish message references the validated StateId", () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const root = projectRoot();
    const idx = path.join(root, '.wai', 'specs', '.index.yaml');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/vision:.*/, 'vision: stateid message test'));
    invalidateSpecCache();

    const rec = admin.lockProject(cfg, ADMIN, 'demo');
    const subject = git(['log', '-1', '--pretty=%s', 'wairon/work'], root);
    expect(subject).toContain('wairon lock: demo @');
    expect(subject).toContain(rec.stateId);
  });

  it('getGitBinding reports scoped dirtiness and the sync setting; configureGitSync persists it', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const root = projectRoot();

    // Clean at first; a foreign (non-.wai) change does NOT make the scope dirty.
    expect(admin.getGitBinding(cfg, ADMIN, 'demo')).toMatchObject({ enabled: true, dirty: false });
    fs.writeFileSync(path.join(root, 'TEAM.md'), 'not wairon business');
    expect(admin.getGitBinding(cfg, ADMIN, 'demo').dirty).toBe(false);

    // A .wai/ change flips the SCOPED dirtiness.
    const idx = path.join(root, '.wai', 'specs', '.index.yaml');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/vision:.*/, 'vision: dirty now'));
    expect(admin.getGitBinding(cfg, ADMIN, 'demo').dirty).toBe(true);

    // The periodic-sync setting round-trips (and skipIfClean defaults true).
    admin.configureGitSync(cfg, ADMIN, 'demo', 15);
    expect(admin.getGitBinding(cfg, ADMIN, 'demo')).toMatchObject({ periodicSyncMinutes: 15, skipIfClean: true });

    // A project that is NOT git-backed reports enabled:false, and configuring
    // sync there is rejected.
    expect(() => admin.configureGitSync(cfg, ADMIN, 'demo2', 5)).toThrow(/Unknown project/);
  });

  it('runPeriodicGitSync publishes a due dirty project and skips a clean one (skip-if-clean)', () => {
    admin.enableGit(cfg, ADMIN, 'demo', remote, 'main');
    const root = projectRoot();
    admin.configureGitSync(cfg, ADMIN, 'demo', 1); // due immediately (no lastSyncAt)

    // Clean → the sweep publishes nothing.
    admin.runPeriodicGitSync(cfg);
    expect(admin.getGitBinding(cfg, ADMIN, 'demo').lastSyncAt).toBeUndefined();

    // Dirty → the sweep publishes a .wai/-scoped commit and stamps lastSyncAt.
    const idx = path.join(root, '.wai', 'specs', '.index.yaml');
    fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/vision:.*/, 'vision: periodic sweep'));
    admin.runPeriodicGitSync(cfg);
    expect(admin.getGitBinding(cfg, ADMIN, 'demo').lastSyncAt).toBeTruthy();
    expect(git(['log', '-1', '--pretty=%s', 'wairon/work'], root)).toContain('wairon periodic sync: demo');
  });
});
