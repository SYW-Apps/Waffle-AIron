import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// What the shipped docs promise a reader, checked against the repository.
//
// Round-4 trials (dev.108) found three kinds of drift the link test cannot see:
//  - the CI recipe pinned a dev version (`5.1.1-dev.107` one build after it
//    shipped) and examples pinned `@v6.0.0` / `@wairon/cli@6.0.0` — a tag and a
//    package version that do not exist on a dev build;
//  - README linked six design docs and CONTRIBUTING.md at `blob/main/`, which
//    404 until main has them — a file the package ships is linked relatively;
//  - `surface diff`, `externals consumers --search` and the dev server's MCP
//    endpoint existed only in `--help`.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The package "files" entries as matchers over repo-relative, '/'-separated paths (as shipped-doc-links does). */
function inPackage(): (rel: string) => boolean {
  const pkg = JSON.parse(read('package.json')) as { files: string[] };
  const matchers = pkg.files.map((entry) => {
    const pattern = entry.replace(/\/$/, '');
    if (!/[*]/.test(pattern)) return (rel: string) => rel === pattern || rel.startsWith(`${pattern}/`);
    const re = new RegExp(`^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')}$`);
    return (rel: string) => re.test(rel);
  });
  return (rel) => matchers.some((m) => m(rel));
}

/** Every markdown file the package ships, plus the reusable workflow a reader copies from. */
function shippedTexts(): string[] {
  const shipped = inPackage();
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.md') && shipped(rel)) out.push(rel);
    }
  };
  walk('docs');
  for (const top of ['README.md', 'CONTRIBUTING.md']) if (shipped(top)) out.push(top);
  out.push('.github/workflows/lock-check.yml');
  return out.sort();
}

describe('the shipped docs pin no version a reader cannot install', () => {
  it('name no dev build, and pin no fixed release in a copyable CI example', () => {
    const found: string[] = [];
    for (const rel of shippedTexts()) {
      read(rel).split(/\r?\n/).forEach((line, i) => {
        if (/\b\d+\.\d+\.\d+-dev\.\d+\b/.test(line)) found.push(`${rel}:${i + 1}: a dev version — ${line.trim()}`);
        if (/@wairon\/cli@\d/.test(line)) found.push(`${rel}:${i + 1}: @wairon/cli pinned to a fixed version — ${line.trim()}`);
        if (/(lock-check\.yml|setup-wairon)@v\d/.test(line)) found.push(`${rel}:${i + 1}: the workflow pinned to a fixed tag — ${line.trim()}`);
        if (/wairon-version:\s*'\d/.test(line)) found.push(`${rel}:${i + 1}: wairon-version pinned to a fixed version — ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it('cli.md explains the pin generically: the version you lock with, release and dev forms', () => {
    const md = read('docs/cli.md');
    expect(md).toMatch(/the version you lock with/);
    expect(md).toMatch(/`@vX\.Y\.Z-dev\.N`/);
    expect(md).toMatch(/npm view @wairon\/cli@<version> version/);
  });
});

describe('links to this repository resolve for every reader', () => {
  it('a file the package ships is linked relatively, never through a GitHub branch that may not have it yet', () => {
    const shipped = inPackage();
    const bad: string[] = [];
    for (const rel of shippedTexts().filter((r) => r.endsWith('.md'))) {
      for (const m of read(rel).matchAll(/https:\/\/github\.com\/SYW-Apps\/Waffle-AIron\/blob\/[^/\s)]+\/([^)#\s]+)/g)) {
        const target = m[1].replace(/\/$/, '');
        if (shipped(target)) bad.push(`${rel}: ${m[0]} — ships in the package, link it relatively`);
        if (!fs.existsSync(path.join(REPO_ROOT, target))) bad.push(`${rel}: ${m[0]} — no such file in this checkout`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('README links the design docs and CONTRIBUTING.md it advertises relatively, and the package ships them', () => {
    const readme = read('README.md');
    const shipped = inPackage();
    for (const rel of [
      'docs/design/supervisor-doctrine.md', 'docs/design/pack-scoping.md', 'docs/design/connecting-agent-entrypoint.md',
      'docs/design/execution-budgets.md', 'docs/design/approval-baseline.md', 'CONTRIBUTING.md',
    ]) {
      expect(readme, rel).toContain(`](${rel})`);
      expect(shipped(rel), `${rel} is in package.json "files"`).toBe(true);
    }
  });
});

describe('the CLI reference documents what the CLI offers', () => {
  const index = read('src/cli/index.ts');
  const cli = read('docs/cli.md');
  const readme = read('README.md');

  it('every `wairon surface` action the CLI registers has a cli.md row (and README names it)', () => {
    const description = /\.command\('surface <action>'\)\s*\.description\('([^']+)'\)/.exec(index);
    expect(description, 'src/cli/index.ts: the surface command').not.toBeNull();
    const actions = description![1].replace(/^[^:]*:\s*/, '').replace(/\(.*$/, '').split('|').map((a) => a.trim()).filter(Boolean);
    expect(actions).toContain('diff');
    for (const action of actions) {
      expect(cli, `docs/cli.md: wairon surface ${action}`).toMatch(new RegExp(`wairon surface [^\\n]*\\b${action}\\b`));
      expect(readme, `README: wairon surface ${action}`).toMatch(new RegExp(`wairon surface [^\\n]*\\b${action}\\b`));
    }
  });

  it('`externals consumers --search` and the rename commands are documented', () => {
    expect(index).toContain("'--search <dirs...>'");
    expect(cli).toMatch(/`wairon externals consumers \[--search <dirs\.\.\.>\]/);
    expect(readme).toMatch(/consumers \[--search/);
    for (const command of ['method rename-param', 'type rename-field']) {
      expect(index, command).toContain(`.command('${command.split(' ')[1]}`);
      expect(cli, command).toContain(`wairon ${command}`);
      expect(readme, command).toContain(`wairon ${command}`);
    }
  });

  it('the dev server\'s MCP endpoint and the refusal contract are documented', () => {
    expect(cli).toMatch(/POST http:\/\/127\.0\.0\.1:<port>\/mcp\?project=local/);
    expect(cli).toMatch(/#### When a command refuses/);
    expect(cli).toMatch(/WAIRON_DEBUG=1/);
  });
});
