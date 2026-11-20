import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import type { ImplementationSpec } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// The pattern reader's comment scan reads a file left to right, as the
// compiler does: a `/*` or `*/` inside a `//` comment or a string literal is
// text, so it never opens or closes a block comment that hides declarations.
// (Reported from a Rust module whose doc comment held `.data/**` and whose
// later code held `packages/*/**`: every method between them read as absent.)
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

/** The names the pattern reader finds declared in one file. */
function declared(file: string, text: string): string[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-scan-'));
  temps.push(root);
  fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  const impls = [{ id: 'impl-a', contract: 'ia', sourcePath: file, methods: [] }] as unknown as ImplementationSpec[];
  const facts = buildCodeModel(impls, [], root).files.find((f) => f.path === file);
  return facts?.declaredNames ?? [];
}

describe('the comment scan reads literals and line comments first', () => {
  it('Rust: a glob in a doc comment and another in a line comment and a string hide nothing', () => {
    const names = declared('src/policy.rs', [
      '//! Rules for <install>/.data/** and its children.',
      'pub trait PolicyEvaluator {',
      '    fn authorize(&self) -> bool;',
      '}',
      'pub fn build_bootstrap_rules() {',
      '    // every packages/*/** path is covered',
      '    let g = "<root>/packages/*/**";',
      '    let raw = r#"a */ b"#;',
      "    let c = '*';",
      '}',
      "fn with_lifetime<'a>(x: &'a str) -> &'a str { x }",
      '/* a real block comment */ fn after_block() {}',
      '',
    ].join('\n'));
    expect(names).toEqual(expect.arrayContaining(['PolicyEvaluator', 'authorize', 'build_bootstrap_rules', 'with_lifetime', 'after_block']));
  });

  it('a real block comment still hides what it holds', () => {
    const names = declared('src/hidden.rs', '/*\nfn hidden_one() {}\n*/\nfn shown_one() {}\n');
    expect(names).toContain('shown_one');
    expect(names).not.toContain('hidden_one');
  });

  it('TypeScript: a comment opener inside a string or a template is text', () => {
    const names = declared('src/a.ts', [
      "const glob = 'src/*/x'; // see dist/**",
      'const tpl = `a /* b`;',
      'export function visible(): void {}',
      'const end = "*/";',
      'export function alsoVisible(): void {}',
      '',
    ].join('\n'));
    expect(names).toEqual(expect.arrayContaining(['visible', 'alsoVisible']));
  });

  it('C#: a verbatim string holding a comment opener is text', () => {
    const names = declared('src/A.cs', [
      'public class Paths {',
      '  public string Glob = @"c:\\data\\/*";',
      '  public void Visible() {}',
      '  public string Close = "*/";',
      '}',
      '',
    ].join('\n'));
    expect(names).toEqual(expect.arrayContaining(['Paths', 'Visible']));
  });
});
