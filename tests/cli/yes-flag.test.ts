import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

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
});
