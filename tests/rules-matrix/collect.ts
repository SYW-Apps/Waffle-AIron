/**
 * Auto-collection of rule-matrix fixture families.
 *
 * Every file matching tests/rules-matrix/families/*.fixtures.ts is a family:
 * it default-exports a non-empty array of fixtures built with
 * defineRuleFixture(...). There is NO central manifest to edit — dropping a
 * new family file in is enough, so parallel contributors never conflict.
 * matrix.test.ts turns the collected fixtures into one it() each;
 * meta.test.ts diffs their codes against the full known-code universe.
 */
import * as path from 'node:path';
import { validateRuleFixture, type RuleFixture } from './harness.js';

// Vitest (via Vite) provides import.meta.glob at runtime. Declare the minimal
// surface used here so this file does not depend on vite/client typings.
declare global {
  interface ImportMeta {
    glob(pattern: string, options: { eager: true }): Record<string, unknown>;
  }
}

export interface CollectedFixture {
  fixture: RuleFixture;
  /** The family file's base name (e.g. "exemplars" for exemplars.fixtures.ts). */
  family: string;
}

export function collectRuleFixtures(): CollectedFixture[] {
  const modules = import.meta.glob('./families/*.fixtures.ts', { eager: true }) as Record<
    string,
    { default?: unknown }
  >;
  const files = Object.keys(modules).sort();
  const out: CollectedFixture[] = [];
  for (const file of files) {
    const family = path.basename(file).replace(/\.fixtures\.ts$/, '');
    const exported = modules[file]?.default;
    if (!Array.isArray(exported) || exported.length === 0) {
      throw new Error(
        `${file} must default-export a non-empty array of fixtures built with defineRuleFixture(...). ` +
        `See tests/rules-matrix/README.md for the contract.`,
      );
    }
    exported.forEach((fx, i) => {
      out.push({ fixture: validateRuleFixture(fx, `${file}[${i}]`), family });
    });
  }
  if (out.length === 0) {
    throw new Error('No rule fixtures collected from tests/rules-matrix/families/*.fixtures.ts — the matrix tier would silently vanish.');
  }
  return out;
}
