import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { declaredMembers, isPart, parseMemberSource, ProjectConfigSchema } from '../../src/models/project.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { fetch, resolve, head, cacheEntryOf, SourceUnavailable } from '../../src/core/adapters/git-source.js';

// ---------------------------------------------------------------------------
// Stage 8, wave A — the one location grammar, the part's configuration and
// the git source adapter. A local bare repository serves every git source, so
// nothing here needs a network; WAIRON_CACHE_DIR points the fetch cache at a
// temp directory.
// ---------------------------------------------------------------------------

const TS = '2026-10-02T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const cleanups: (() => void)[] = [];
let savedCache: string | undefined;

beforeEach(() => {
  savedCache = process.env.WAIRON_CACHE_DIR;
  process.env.WAIRON_CACHE_DIR = tempDir('wairon-cache-');
});

afterEach(() => {
  if (savedCache === undefined) delete process.env.WAIRON_CACHE_DIR;
  else process.env.WAIRON_CACHE_DIR = savedCache;
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

const config = (extra: Record<string, unknown>) => ProjectConfigSchema.parse({ name: 'Clinic', createdAt: TS, updatedAt: TS, ...extra });

describe('the one location grammar (member_declaration.source)', () => {
  it('reads every shorthand form: contained, sibling, git at a commit, hosted', () => {
    expect(parseMemberSource('services/scheduling')).toEqual({ source: { path: 'services/scheduling' }, storage: 'contained' });
    expect(parseMemberSource('../admin')).toEqual({ source: { path: '../admin' }, storage: 'path' });
    expect(parseMemberSource('../../platform/admin')).toEqual({ source: { path: '../../platform/admin' }, storage: 'path' });
    expect(parseMemberSource(`git@host.example:acme/payments.git#${COMMIT}`)).toEqual({ source: { git: 'git@host.example:acme/payments.git', commit: COMMIT }, storage: 'git' });
    expect(parseMemberSource(`https://host.example/acme/payments.git#${COMMIT}`)).toEqual({ source: { git: 'https://host.example/acme/payments.git', commit: COMMIT }, storage: 'git' });
    expect(parseMemberSource(`file:///srv/repos/payments.git#${COMMIT}`).storage).toBe('git');
    expect(parseMemberSource('hosted:marketplace')).toEqual({ source: { hosted: 'marketplace' }, storage: 'hosted' });
  });

  it('rejects an absolute path, an inner `..`, an empty source and a git source without its full commit — as the problem, never thrown', () => {
    expect(parseMemberSource('/srv/scheduling').problem).toMatch(/absolute path/);
    expect(parseMemberSource('C:\\srv\\scheduling').problem).toMatch(/absolute path/);
    expect(parseMemberSource('services/../../elsewhere').problem).toMatch(/inner `\.\.`/);
    expect(parseMemberSource('../admin/../other').problem).toMatch(/inner `\.\.`/);
    expect(parseMemberSource('..').problem).toMatch(/names a directory above the project but no member/);
    expect(parseMemberSource('').problem).toMatch(/empty/);
    expect(parseMemberSource('git@host.example:acme/payments.git').problem).toMatch(/names no commit — write it as "git@host.example:acme\/payments.git#<full commit>"/);
    expect(parseMemberSource('https://host.example/acme/payments.git#main').problem).toMatch(/not a full commit/);
    expect(parseMemberSource('hosted:').problem).toMatch(/names no hosted record/);
  });

  it('reads the long form — source, as, ref, dir — and the deprecated `path` for one release, flagged', () => {
    const members = declaredMembers(config({
      members: {
        scheduling: 'services/scheduling',
        admin: { source: '../admin', as: 'part', description: 'The admin console' },
        payments: { source: `git@host.example:acme/payments.git#${COMMIT}`, ref: 'main', dir: 'services/payments', as: 'project', use: ['payment-portal'] },
        ledger: { path: 'services/ledger' },
      },
    }));
    expect(members).toEqual([
      { alias: 'scheduling', path: 'services/scheduling', use: [], source: { path: 'services/scheduling' }, storage: 'contained', deprecatedPath: false },
      { alias: 'admin', description: 'The admin console', use: [], as: 'part', source: { path: '../admin' }, storage: 'path', deprecatedPath: false },
      {
        alias: 'payments', use: ['payment-portal'], as: 'project', storage: 'git', deprecatedPath: false,
        source: { git: 'git@host.example:acme/payments.git', commit: COMMIT, ref: 'main', dir: 'services/payments' },
      },
      { alias: 'ledger', path: 'services/ledger', use: [], source: { path: 'services/ledger' }, storage: 'contained', deprecatedPath: true },
    ]);
  });

  it('records each declaration problem rather than dropping the entry', () => {
    const problems = declaredMembers(config({
      members: {
        both: { source: 'a', path: 'a' },
        none: { description: 'nowhere' },
        marketplace: { source: 'hosted:marketplace', as: 'part' },
        bad: { source: 'services/bad', as: 'module' },
        branch: { source: 'services/branch', ref: 'main' },
        nocommit: 'git@host.example:acme/payments.git',
      },
    })).map((m) => [m.alias, m.problem]);
    expect(problems).toEqual([
      ['both', expect.stringContaining('names both `source` and the deprecated `path`')],
      ['none', expect.stringContaining('declares no source')],
      ['marketplace', expect.stringContaining('a hosted source is a project')],
      ['bad', expect.stringContaining('asserts `as: module`')],
      ['branch', expect.stringContaining('only a git source carries')],
      ['nocommit', expect.stringContaining('names no commit')],
    ]);
  });
});

describe('a part\'s configuration: partOf, isPart, setPartOf, updateMember', () => {
  function project(extra: Record<string, unknown> = {}): string {
    const root = tempDir('wairon-cfg-');
    fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', id: 'clinic', name: 'Clinic', targets: [], createdAt: TS, updatedAt: TS, ...extra }));
    return root;
  }

  it('creates a fresh part\'s configuration holding only its schema version and partOf, and reads it as a part with no id', () => {
    const dir = tempDir('wairon-part-');
    const repo = projectConfigRepositoryAt(dir);
    expect(repo.setPartOf({ project: 'clinic', path: '../clinic' })).toBe(true);
    expect(yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8'))).toEqual({ schemaVersion: '1.0.0', partOf: { project: 'clinic', path: '../clinic' } });
    const read = repo.load();
    expect(isPart(read)).toBe(true);
    expect(read?.id).toBeUndefined();
    expect(repo.setPartOf({ project: 'clinic', path: '../clinic' })).toBe(false);
    expect(isPart(projectConfigRepositoryAt(project()).load())).toBe(false);
  });

  it('refuses to turn a project into a part: a configuration declaring project fields keeps them, nothing written', () => {
    const root = project({ members: { scheduling: 'services/scheduling' } });
    const before = fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8');
    expect(() => projectConfigRepositoryAt(root).setPartOf({ project: 'hospital' })).toThrow(/declares `id`, `members`, `targets`.*member demote/);
    expect(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8')).toBe(before);
  });

  it('updateMember rewrites the deprecated `path` to `source` — the shorthand when nothing else remains — and writes nothing twice', () => {
    const root = project({ members: { ledger: { path: 'services/ledger' }, billing: { path: 'services/billing', description: 'Invoices' } } });
    const repo = projectConfigRepositoryAt(root);
    expect(repo.updateMember('ledger', {})).toBe(true);
    expect(repo.updateMember('billing', {})).toBe(true);
    expect(repo.load()?.members).toEqual({ ledger: 'services/ledger', billing: { source: 'services/billing', description: 'Invoices' } });
    expect(repo.updateMember('ledger', {})).toBe(false);
    // A git member's commit moves; `as` and `use` drop with an empty value.
    repo.updateMember('billing', { as: 'part' });
    expect(repo.load()?.members?.billing).toEqual({ source: 'services/billing', as: 'part', description: 'Invoices' });
    repo.updateMember('billing', { as: '' });
    expect(repo.load()?.members?.billing).toEqual({ source: 'services/billing', description: 'Invoices' });
    expect(() => repo.updateMember('crm', {})).toThrow(/declares no "crm"/);
    expect(() => repo.updateMember('ledger', { source: 'git@host.example:acme/ledger.git' })).toThrow(/names no commit/);
    expect(() => repo.updateMember('ledger', { as: 'module' })).toThrow(/a member is a part or a project/);
  });
});

describe('git_source_adapter over a local bare repository', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-c', 'user.name=Stage Eight', '-c', 'user.email=stage8@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  function repository(): { url: string; work: string; bare: string; first: string; second: string } {
    const work = tempDir('wairon-git-work-');
    fs.mkdirSync(path.join(work, 'services', 'payments'), { recursive: true });
    fs.writeFileSync(path.join(work, 'services', 'payments', 'README.md'), 'first\n');
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'first');
    const first = git(work, 'rev-parse', 'HEAD');
    git(work, 'tag', 'v1');
    fs.writeFileSync(path.join(work, 'services', 'payments', 'README.md'), 'second\n');
    git(work, 'commit', '-q', '-am', 'second');
    const second = git(work, 'rev-parse', 'HEAD');
    const bare = path.join(tempDir('wairon-git-bare-'), 'payments.git');
    git(path.dirname(bare), 'clone', '-q', '--bare', work, bare);
    return { url: `file:///${bare.replace(/\\/g, '/').replace(/^\//, '')}`, work, bare, first, second };
  }

  it('resolves HEAD, a branch and a tag to the full commit they name now', () => {
    const r = repository();
    expect(resolve(r.url)).toBe(r.second);
    expect(resolve(r.url, 'main')).toBe(r.second);
    expect(resolve(r.url, 'v1')).toBe(r.first);
    expect(() => resolve(r.url, 'no-such-branch')).toThrow(SourceUnavailable);
  });

  it('materializes exactly one commit into the content-addressed cache, outside every project tree', () => {
    const r = repository();
    const dir = fetch(r.url, r.first);
    expect(dir).toBe(cacheEntryOf(r.url, r.first));
    expect(dir.startsWith(process.env.WAIRON_CACHE_DIR!)).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'services', 'payments', 'README.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('first\n');
    expect(fs.existsSync(path.join(dir, '.git'))).toBe(false);
    expect(fetch(r.url, r.first, 'services/payments')).toBe(path.join(dir, 'services/payments'));
    expect(() => fetch(r.url, r.first, 'services/ledger')).toThrow(/holds no "services\/ledger"/);
  });

  it('keeps an entry immutable: a cached commit is served offline, unchanged, and never fetched again', () => {
    const r = repository();
    const dir = fetch(r.url, r.first);
    const stamp = fs.statSync(path.join(dir, 'services', 'payments', 'README.md')).mtimeMs;
    fs.rmSync(r.bare, { recursive: true, force: true });
    expect(fetch(r.url, r.first)).toBe(dir);
    expect(fs.statSync(path.join(dir, 'services', 'payments', 'README.md')).mtimeMs).toBe(stamp);
  });

  it('leaves the cache exactly as it was when a fetch fails — offline or an unknown commit — and says why', () => {
    const r = repository();
    const repoDir = path.dirname(cacheEntryOf(r.url, r.first));
    expect(() => fetch(r.url, 'b'.repeat(40))).toThrow(SourceUnavailable);
    expect(fs.existsSync(repoDir)).toBe(false);
    const gone = `${r.url}-gone`;
    expect(() => fetch(gone, r.first)).toThrow(/cannot fetch/);
    expect(() => resolve(gone)).toThrow(/cannot reach/);
  });

  it('reads the commit of the work tree holding a directory, and null outside one', () => {
    const r = repository();
    expect(head(path.join(r.work, 'services', 'payments'))).toBe(r.second);
    expect(head(tempDir('wairon-no-git-'))).toBeNull();
  });
});
