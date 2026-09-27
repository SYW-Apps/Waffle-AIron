import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';

// ---------------------------------------------------------------------------
// Stage 3: the registry's member intents (declareMember, setMemberPath,
// removeMember), through the comment-preserving save — a project.yaml write
// is an edit of the file, and `members` lands at its schema position.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

const lines = (...l: string[]): string => `${l.join('\r\n')}\r\n`;

function tempRoot(text?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-members-'));
  roots.push(dir);
  if (text !== undefined) {
    fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), text);
  }
  return dir;
}

const textOf = (root: string): string => fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8');
const membersOf = (root: string): unknown => (yaml.load(textOf(root)) as { members?: unknown }).members;

const BASE = lines(
  'schemaVersion: 1.0.0',
  'id: waffly',
  '# the display name',
  'name: Waffly',
  'externals:',
  '  crm: {}',
  'targets: []',
  "createdAt: '2026-01-01T00:00:00.000Z'",
  "updatedAt: '2026-01-01T00:00:00.000Z'",
);

describe('project_config_registry.declareMember', () => {
  it('writes the shorthand for a bare path, the long form for a description, after externals, keeping comments and CRLF', () => {
    const root = tempRoot(BASE);
    const repo = projectConfigRepositoryAt(root);
    expect(repo.declareMember('billing', { path: 'services/billing' })).toBe(true);
    expect(repo.declareMember('ledger', { path: 'services/ledger', description: 'The ledger of record' })).toBe(true);
    const text = textOf(root);
    expect(text).toContain('# the display name');
    expect(text.match(/(?<!\r)\n/g)).toBeNull();
    const keys = text.split('\r\n').filter((l) => /^[a-zA-Z]/.test(l)).map((l) => l.split(':')[0]);
    expect(keys.indexOf('members')).toBe(keys.indexOf('externals') + 1);
    expect(membersOf(root)).toEqual({
      billing: 'services/billing',
      ledger: { path: 'services/ledger', description: 'The ledger of record' },
    });
    expect(repo.load()?.members).toEqual(membersOf(root));
  });

  it('writes nothing for the same declaration again, in either form', () => {
    const root = tempRoot(BASE);
    const repo = projectConfigRepositoryAt(root);
    repo.declareMember('billing', { path: 'services/billing' });
    const once = textOf(root);
    expect(repo.declareMember('billing', { path: 'services/billing' })).toBe(false);
    expect(textOf(root)).toBe(once);
  });

  it('refuses a malformed alias, an empty or absolute path, an alias externals holds, and a different declaration', () => {
    const root = tempRoot(BASE);
    const repo = projectConfigRepositoryAt(root);
    expect(() => repo.declareMember('Billing.Svc', { path: 'services/billing' })).toThrow(/\[a-z0-9-_\]\+/);
    expect(() => repo.declareMember('billing', { path: '' })).toThrow(/empty/);
    expect(() => repo.declareMember('billing', { path: '/srv/billing' })).toThrow(/absolute/);
    expect(() => repo.declareMember('crm', { path: 'services/crm' })).toThrow(/`externals` already declares "crm"/);
    repo.declareMember('billing', { path: 'services/billing' });
    expect(() => repo.declareMember('billing', { path: 'services/billing-v2' })).toThrow(/never overwritten/);
    expect(membersOf(root)).toEqual({ billing: 'services/billing' });
  });

  it('refuses a project with no configuration', () => {
    expect(() => projectConfigRepositoryAt(tempRoot()).declareMember('billing', { path: 'b' })).toThrow();
  });
});

describe('project_config_registry.setMemberPath / removeMember', () => {
  it('moves a member in the form it was written, keeping a long form\'s description', () => {
    const root = tempRoot(BASE);
    const repo = projectConfigRepositoryAt(root);
    repo.declareMember('billing', { path: 'services/billing' });
    repo.declareMember('ledger', { path: 'services/ledger', description: 'The ledger of record' });
    expect(repo.setMemberPath('billing', 'apps/billing')).toBe(true);
    expect(repo.setMemberPath('ledger', 'apps/ledger')).toBe(true);
    expect(repo.setMemberPath('ledger', 'apps/ledger')).toBe(false);
    expect(membersOf(root)).toEqual({
      billing: 'apps/billing',
      ledger: { path: 'apps/ledger', description: 'The ledger of record' },
    });
    expect(() => repo.setMemberPath('crm', 'apps/crm')).toThrow(/declares no "crm"/);
    expect(() => repo.setMemberPath('billing', '')).toThrow(/empty/);
  });

  it('removes one member, and `members` itself with the last one', () => {
    const root = tempRoot(BASE);
    const repo = projectConfigRepositoryAt(root);
    repo.declareMember('billing', { path: 'services/billing' });
    repo.declareMember('ledger', { path: 'services/ledger' });
    expect(repo.removeMember('ledger')).toBe(true);
    expect(membersOf(root)).toEqual({ billing: 'services/billing' });
    expect(repo.removeMember('ledger')).toBe(false);
    expect(repo.removeMember('billing')).toBe(true);
    expect(membersOf(root)).toBeUndefined();
    expect(textOf(root)).toContain('# the display name');
  });
});
