import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// ---------------------------------------------------------------------------
// `-y` is accepted wherever `--yes` is: a user who learned `wairon lock -y`
// typed `wairon member promote x -y` and was refused. Every command that takes
// --yes declares the short flag too.
// ---------------------------------------------------------------------------

describe('the --yes flag', () => {
  it('every command declaring --yes also accepts -y', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'cli', 'index.ts'), 'utf8');
    const declarations = [...source.matchAll(/\.option\((['"])([^'"]*--yes\b[^'"]*)\1/g)].map((m) => m[2]);
    expect(declarations.length).toBeGreaterThan(0);
    expect(declarations.filter((flags) => !flags.startsWith('-y, --yes'))).toEqual([]);
  });

  // `pack init` never prompts, but a script passing -y to every pack command
  // was refused with "unknown option" (trial rounds 2 and 3). It takes both
  // spellings and still scaffolds.
  it('pack init accepts -y and --yes and scaffolds as without them', () => {
    const repo = path.join(__dirname, '..', '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pack-init-yes-'));
    try {
      for (const flag of ['-y', '--yes']) {
        const dir = path.join(tmp, `pack${flag.replace(/-/g, '')}`);
        execFileSync(process.execPath, [
          path.join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(repo, 'src', 'cli', 'index.ts'),
          'pack', 'init', 'yes-pack', '--dir', dir, flag,
        ], { cwd: tmp, stdio: 'pipe', timeout: 120_000 });
        expect(fs.readdirSync(dir).length, flag).toBeGreaterThan(0);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
