import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import inquirer from 'inquirer';

// The command tests mock inquirer.prompt, so a prompt type the installed inquirer no
// longer registers (inquirer 10 renamed `list` to `select`) passes every one of them and
// only fails in a real terminal. This reads each prompt question the commands declare and
// checks its type against the registry of the inquirer that ships.

const SRC = path.resolve(__dirname, '..', '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** Each `type: '<x>'` directly followed by `name:` — the shape of a prompt question. */
function declaredPromptTypes(): Array<{ file: string; type: string }> {
  const found: Array<{ file: string; type: string }> = [];
  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/from 'inquirer'/.test(text)) continue;
    for (const m of text.matchAll(/type:\s*'([a-z]+)',\s*name:/g)) {
      found.push({ file: path.relative(SRC, file), type: m[1] });
    }
  }
  return found;
}

describe('the prompt types the commands declare', () => {
  it('are all registered by the inquirer that ships', () => {
    const registered = Object.keys(inquirer.createPromptModule().prompts);
    const declared = declaredPromptTypes();
    expect(declared.length).toBeGreaterThan(10);
    const unknown = declared.filter((d) => !registered.includes(d.type));
    expect(unknown).toEqual([]);
  });
});
