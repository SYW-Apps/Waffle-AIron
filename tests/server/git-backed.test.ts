import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as admin from '../../src/server/admin.js';
import { AdminAuthError } from '../../src/server/admin.js';
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
  });
});
