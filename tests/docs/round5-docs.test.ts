import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guideBody } from '../../src/utils/ai-guide.js';

// ---------------------------------------------------------------------------
// Round-5 trials (dev.109), docs half:
//  - `wairon method rename` (with --dry-run, --search, --no-pin-symbol) existed
//    only in `--help` (solo-app, platform, lib-and-app R5-9);
//  - `.wai/context/wairon-guide.md` — rendered from the GLOBAL guide body —
//    lacked the "Prose is design; linkage is not" rule `.claude/CLAUDE.md`
//    carries (platform);
//  - validate's code-reading line, lock's per-kind draft count and its kept
//    lockedAt, and the one identifier grammar are documented where a reader
//    looks for them.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

/** The options `.command('rename')` registers under `wairon method`, from the CLI source. */
function methodRenameOptions(): string[] {
  const src = read('src/cli/index.ts');
  const at = src.indexOf(".command('rename <component> <method> <new-name>')");
  expect(at, 'wairon method rename is registered').toBeGreaterThan(-1);
  const block = src.slice(at, src.indexOf('.action(', at));
  return [...block.matchAll(/\.option\('(--[a-z-]+)/g)].map((m) => m[1]);
}

describe('wairon method rename is documented with every option it takes', () => {
  it('cli.md has a section naming --dry-run, --search and --no-pin-symbol', () => {
    const cli = read('docs/cli.md');
    const start = cli.indexOf('### `wairon method rename <component> <method> <new-name>');
    expect(start).toBeGreaterThan(-1);
    const section = cli.slice(start, cli.indexOf('\n### ', start + 4));
    const options = methodRenameOptions();
    expect(options).toEqual(expect.arrayContaining(['--dry-run', '--search', '--no-pin-symbol']));
    for (const option of options) expect(section, option).toContain(option);
    expect(section).toMatch(/sdd_rename_method/);
  });

  it('the README command table names it with the same three options', () => {
    const row = read('README.md').split(/\r?\n/).find((line) => line.includes('`wairon method rename <component>'));
    expect(row).toBeDefined();
    for (const option of ['--dry-run', '--search', '--no-pin-symbol']) expect(row, option).toContain(option);
  });
});

describe('the generated context guide carries the approval doctrine', () => {
  it('the global body — what .wai/context/wairon-guide.md renders — states "Prose is design; linkage is not"', () => {
    const global = guideBody('global');
    expect(global).toContain('Prose is design; linkage is not');
    expect(global).toMatch(/re-opens the approval/);
    // The in-project guide says it too: the two never disagree on the rule.
    expect(guideBody('local')).toContain('Prose is design; linkage is not');
  });

  it('renderWaironGuide embeds the global body', () => {
    expect(read('src/core/context.ts')).toMatch(/lines\.push\(guideBody\('global'\)\)/);
  });
});

describe('validate, lock and the id grammar say what they do', () => {
  const cli = read('docs/cli.md');
  it('validate documents its code-reading line (grade and compiler), shared with sdd_validate_tree', () => {
    expect(cli).toMatch(/code-reading line/);
    expect(cli).toMatch(/Code read at grade exact with TypeScript/);
  });

  it('lock documents the per-kind draft count and that a re-run with nothing moved keeps lockedAt', () => {
    expect(cli).toMatch(/per kind \(subsystems, components, contracts, implementations, types\)/);
    expect(cli).toMatch(/keeps the record on file — its `lockedAt` included/);
  });

  it('the one identifier grammar is documented: length, leading dash, devices, reserved words', () => {
    const start = cli.indexOf('#### Ids and names');
    expect(start).toBeGreaterThan(-1);
    const section = cli.slice(start, cli.indexOf('\n### ', start));
    for (const claim of ['64 characters', 'never start with `-`', '`__proto__`', 'Windows reserves', '`super`', 'targetLanguage', 'RESERVED_IDENTIFIER']) {
      expect(section, claim).toContain(claim);
    }
  });
});
