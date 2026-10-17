import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Every relative link in a shipped doc resolves inside the published package.
//
// The npm package ships README.md and docs/*.md (package.json "files"), not
// docs/design/ or CHANGELOG.md — so a relative link to one of those is dead in
// every installed copy and on npmjs.com, while it works in the checkout. Four
// shipped docs carried such links through two trial rounds. A file outside the
// package is linked by its absolute GitHub URL instead.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The package "files" entries as matchers over repo-relative, '/'-separated paths. */
function packageFileMatchers(): ((rel: string) => boolean)[] {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { files: string[] };
  return pkg.files.map((entry) => {
    const pattern = entry.replace(/\/$/, '');
    if (!/[*]/.test(pattern)) return (rel: string) => rel === pattern || rel.startsWith(`${pattern}/`);
    const re = new RegExp(`^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')}$`);
    return (rel: string) => re.test(rel);
  });
}

/** The shipped markdown files: README.md, docs/*.md and docs/standards/**. */
function shippedDocs(inPackage: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.md') && inPackage(rel)) out.push(rel);
    }
  };
  walk('docs');
  if (inPackage('README.md')) out.push('README.md');
  return out.sort();
}

/** The link targets of a markdown text, code fences and inline code excluded. */
function linkTargets(markdown: string): string[] {
  const prose = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '')
    .replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)].map((m) => m[1]);
}

describe('links in the shipped docs', () => {
  it('every relative link resolves to a file the package ships', () => {
    const matchers = packageFileMatchers();
    const inPackage = (rel: string): boolean => matchers.some((m) => m(rel));
    const docs = shippedDocs(inPackage);
    expect(docs).toContain('docs/cli.md');

    const dead: string[] = [];
    for (const doc of docs) {
      for (const target of linkTargets(fs.readFileSync(path.join(REPO_ROOT, doc), 'utf8'))) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue; // URL, mailto, in-page anchor
        const file = decodeURIComponent(target.split('#')[0]);
        const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc), file));
        const exists = fs.existsSync(path.join(REPO_ROOT, rel));
        if (rel.startsWith('..') || !exists || !inPackage(rel)) {
          dead.push(`${doc}: ${target}${exists ? ' (not in the published package)' : ' (no such file)'}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });
});
