import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// The split guard: src/config/loader.ts is the topology store, src/config/paths.ts
// is the path convention.
//
// `aiPathsAt`/`AI_PATHS` are resolved by nineteen modules, so a file that holds
// them belongs to no component — the same standing src/utils/fs.ts has. While
// both halves shared loader.ts, the topology_store spec's claim on that file
// made every one of those nineteen importers owe a declared dependency edge, and
// the validator said so thirty-one times. This test keeps the halves apart: it
// fails if a path helper drifts back into loader.ts, and it fails if an import
// site starts pulling one out of loader.ts again.
//
// Literal `includes` throughout, never a regular expression — escaping the
// dotted paths has gone wrong here before.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOADER = path.join(REPO_ROOT, 'src', 'config', 'loader.ts');
const PATHS = path.join(REPO_ROOT, 'src', 'config', 'paths.ts');

/** The exported declarations that belong to the unclaimed path convention. */
const PATH_EXPORTS = [
  'export interface WaiPaths {',
  'export function aiPathsAt(',
  'export const AI_PATHS',
  'export function isProjectInitialized(',
  'export function assertProjectInitialized(',
] as const;

/** The exported declarations that are the topology store's own job. */
const STORE_EXPORTS = [
  'export function loadRegistry(',
  'export function loadTopologyConfig(',
  'export function saveTopologyConfig(',
] as const;

/** The binding names an import line must not take from the store's module. */
const PATH_SYMBOLS = ['WaiPaths', 'aiPathsAt', 'AI_PATHS', 'isProjectInitialized', 'assertProjectInitialized'] as const;

const LOADER_MODULE_SPECIFIER = 'config/loader.js';

function collectTsFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collectTsFiles(full, found);
    } else if (entry.name.endsWith('.ts')) {
      found.push(full);
    }
  }
  return found;
}

describe('config/loader.ts and config/paths.ts hold different jobs', () => {
  it('paths.ts exports the path convention', () => {
    const source = fs.readFileSync(PATHS, 'utf8');
    for (const declaration of PATH_EXPORTS) {
      expect(source).toContain(declaration);
    }
  });

  it('loader.ts no longer exports the path convention', () => {
    const source = fs.readFileSync(LOADER, 'utf8');
    for (const declaration of PATH_EXPORTS) {
      expect(source).not.toContain(declaration);
    }
  });

  it('loader.ts still exports the topology store, and resolves paths through paths.ts', () => {
    const source = fs.readFileSync(LOADER, 'utf8');
    for (const declaration of STORE_EXPORTS) {
      expect(source).toContain(declaration);
    }
    expect(source).toContain("from './paths.js'");
  });

  it('paths.ts does not export the topology store', () => {
    const source = fs.readFileSync(PATHS, 'utf8');
    for (const declaration of STORE_EXPORTS) {
      expect(source).not.toContain(declaration);
    }
  });

  it('no module imports a path helper from the topology store module', () => {
    const files = [
      ...collectTsFiles(path.join(REPO_ROOT, 'src')),
      ...collectTsFiles(path.join(REPO_ROOT, 'tests')),
    ].filter((file) => file !== __filename);

    const offenders: string[] = [];
    for (const file of files) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.includes(LOADER_MODULE_SPECIFIER)) continue;
        for (const symbol of PATH_SYMBOLS) {
          if (line.includes(symbol)) {
            offenders.push(`${path.relative(REPO_ROOT, file)}: ${line.trim()}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the public config surface still re-exports both halves', () => {
    const barrel = fs.readFileSync(path.join(REPO_ROOT, 'src', 'config', 'index.ts'), 'utf8');
    expect(barrel).toContain("export * from './loader.js';");
    expect(barrel).toContain("export * from './paths.js';");
  });
});
