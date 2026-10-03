import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { importNames } from '../../src/core/index.js';

// ---------------------------------------------------------------------------
// project_config_registry.importNames (stage 4): add public names to the `use`
// of an external or member — append-only, idempotent, a shorthand member
// turned into its long form, and written with the comment-preserving save.
// ---------------------------------------------------------------------------

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-use-'));
  made.push(root);
  fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), [
    'schemaVersion: 1.0.0',
    'id: waffly',
    'name: Waffly',
    '# the vocabulary every project speaks',
    'externals:',
    '  shared:',
    '    # imported by hand',
    '    use: [host-var-values]',
    'members:',
    '  ui: packages/ui',
    'targets: []',
    "createdAt: '2026-09-28T00:00:00.000Z'",
    "updatedAt: '2026-09-28T00:00:00.000Z'",
    '',
  ].join('\n'));
  return root;
}

const read = (root: string): string => fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8');

describe('importNames', () => {
  it('appends only the new names after the ones a person wrote, keeping every comment', () => {
    const root = project();
    const repo = projectConfigRepositoryAt(root);
    expect(repo.importNames('shared', ['waffler-error', 'host-var-values'])).toBe(true);
    expect(repo.load()?.externals?.shared.use).toEqual(['host-var-values', 'waffler-error']);
    expect(read(root)).toContain('# the vocabulary every project speaks');
    expect(read(root)).toContain('# imported by hand');
  });

  it('is idempotent: the same names again write nothing', () => {
    const root = project();
    const repo = projectConfigRepositoryAt(root);
    repo.importNames('shared', ['waffler-error']);
    const bytes = read(root);
    expect(repo.importNames('shared', ['waffler-error', 'host-var-values'])).toBe(false);
    expect(read(root)).toBe(bytes);
  });

  it('turns a shorthand member into its long form to hold the imports; a `*` already imports everything', () => {
    const root = project();
    const repo = projectConfigRepositoryAt(root);
    expect(repo.importNames('ui', ['*'])).toBe(true);
    expect(repo.load()?.members?.ui).toEqual({ source: 'packages/ui', use: ['*'] });
    expect(repo.importNames('ui', ['banner'])).toBe(false);
  });

  it('refuses a malformed name and an alias neither externals nor members declares, writing nothing', () => {
    const root = project();
    const repo = projectConfigRepositoryAt(root);
    const bytes = read(root);
    expect(() => repo.importNames('shared', ['WafflerError'])).toThrow(/a `use` entry is `\*` or a public name/);
    expect(() => repo.importNames('ledger', ['entry'])).toThrow(/neither `externals` nor `members` declares "ledger"/);
    expect(read(root)).toBe(bytes);
  });

  it('is reachable through the core portal, bound to the ambient root', () => {
    const root = project();
    expect(runWithProjectRoot(root, () => importNames('shared', ['index-value']))).toBe(true);
    expect(projectConfigRepositoryAt(root).load()?.externals?.shared.use).toEqual(['host-var-values', 'index-value']);
  });
});
