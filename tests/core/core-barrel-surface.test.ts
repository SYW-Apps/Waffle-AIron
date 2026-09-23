/**
 * The core barrel publishes core_portal's contract — and states the rest.
 *
 * `src/core/index.ts` used to carry seventeen `export * from` lines. Sixteen of
 * them republished modules realizing 39 components, so the barrel offered 240
 * runtime names where the contract declares 97: every consumer could reach any
 * member and bypass the facade, which is why the same sdd_cli→sdd_core crossing
 * kept being found one symbol at a time.
 *
 * This suite is the thing that keeps it closed. It does NOT freeze a list of
 * names — it reads `icore_portal` and compares, so it keeps holding as the
 * contract changes. What it refuses is a name on the public surface that no
 * spec accounts for: not a contract method, not a method of a TYPE the barrel
 * publishes (a method travels with its type), not the shared rule vocabulary,
 * and not one of the seven diagram functions this wave REPORTED as unmodelled
 * rather than quietly forwarding.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import * as barrel from '../../src/core/index.js';
import * as library from '../../src/index.js';
import * as ruleBarrel from '../../src/core/rules/index.js';
import * as lockStore from '../../src/core/lockfile.js';
import { describeApprover, type ApproverIdentity } from '../../src/models/lock.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SPECS = path.join(REPO_ROOT, '.wai', 'specs');
const BARREL_FILE = path.join(REPO_ROOT, 'src', 'core', 'index.ts');

interface MethodSpec { name: string; symbol?: string }
interface SpecDoc { kind?: string; methods?: MethodSpec[] }

function readYaml<T>(file: string): T {
  return yaml.load(fs.readFileSync(file, 'utf8')) as T;
}

function walkYaml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkYaml(p));
    else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) out.push(p);
  }
  return out;
}

/**
 * The names `icore_portal` declares, spelled the way the CODE spells them: a
 * per-method `symbol` on the implementation wins over the contract's name.
 */
function contractNames(): Set<string> {
  const iface = readYaml<SpecDoc>(path.join(SPECS, 'interfaces', 'icore_portal.yaml'));
  const impl = readYaml<SpecDoc>(path.join(SPECS, 'implementations', 'core_portal_impl.yaml'));
  const symbolOf = new Map<string, string>();
  for (const m of impl.methods ?? []) if (m.symbol) symbolOf.set(m.name, m.symbol);
  return new Set((iface.methods ?? []).map((m) => symbolOf.get(m.name) ?? m.name));
}

/**
 * Every method a TYPE spec declares. A method travels with its type: a caller
 * handed an `ApprovalDiff` from here must be able to count one from here, which
 * is why `diffSize` is on the surface without being a Portal method. Read from
 * the tree rather than listed, so a new type method is accounted for by its
 * spec and not by editing this file.
 */
function typeMethodNames(): Set<string> {
  const names = new Set<string>();
  for (const file of walkYaml(SPECS)) {
    const doc = readYaml<SpecDoc>(file);
    if (!doc || typeof doc.kind !== 'string' || !Array.isArray(doc.methods)) continue;
    for (const m of doc.methods) names.add(m.symbol ?? m.name);
  }
  return names;
}

/**
 * The seven diagram functions `wairon diagram --all|--sequence|--subsystem` and
 * `wairon host demo` are built out of. No contract names them —
 * `icore_portal` names `renderDiagram`, `iarchitecture_diagrams` names `render`
 * and `buildGraphModel` — and cli_core_adapter dependsOn core_portal alone, so
 * this barrel is the only route that does not make sdd_cli import an sdd_core
 * module.
 *
 * A shrink-only ratchet, not an allowance: the list may lose entries (as each
 * one gets modelled) and never gain one. The assertion below fails the moment a
 * name here becomes a contract method, so a fix cannot leave a stale entry.
 */
const REPORTED_UNMODELLED = [
  'buildCanvasDataModel',
  'diagramSetIndex',
  'generateComponentDiagram',
  'generateDiagramSet',
  'generateSequenceDiagram',
  'loadSpecGraph',
  'toMarkdown',
] as const;

/** The 14 shared value shapes the barrel publishes as types, by name. */
const DECLARED_TYPES = [
  'ComponentRename',
  'ForeignFieldRepair',
  'GenerateOptions',
  'GenerateSummary',
  'InstalledPack',
  'LockRecord',
  'LockStatus',
  'MethodRename',
  'SpecialistRetirement',
  'StateId',
  'SyncResult',
  'TreeExportResult',
  'TreeImportOptions',
  'TreeImportResult',
] as const;

/** The five files outside src/core that take symbols off the barrel. */
const CONSUMER_FILES = [
  'src/commands/subsystem.ts',
  'src/commands/lock.ts',
  'src/commands/packs.ts',
  'src/mcp/server.ts',
  'src/server/adapters.ts',
] as const;

/** Names a file imports from the core barrel, split into values and types. */
function barrelImports(relPath: string): { values: string[]; types: string[] } {
  const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
  const values: string[] = [];
  const types: string[] = [];
  const rx = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(source))) {
    if (!/(^|\/)core\/index\.js$/.test(match[3])) continue;
    // Strip line comments from the WHOLE clause before splitting: these import
    // lists carry prose, and prose carries commas.
    for (const raw of match[2].replace(/\/\/[^\n]*/g, '').split(',')) {
      const cleaned = raw.trim();
      if (!cleaned) continue;
      const isType = Boolean(match[1]) || cleaned.startsWith('type ');
      const name = cleaned.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (!name) continue;
      (isType ? types : values).push(name);
    }
  }
  return { values, types };
}

const CONTRACT = contractNames();
const TYPE_METHODS = typeMethodNames();
const RULE_VOCABULARY = new Set(Object.keys(ruleBarrel));
const PUBLISHED = Object.keys(barrel);

describe('core barrel surface (src/core/index.ts)', () => {
  it('publishes no name icore_portal does not account for', () => {
    const unaccounted = PUBLISHED.filter(
      (name) =>
        !CONTRACT.has(name)
        && !TYPE_METHODS.has(name)
        && !RULE_VOCABULARY.has(name)
        && !(REPORTED_UNMODELLED as readonly string[]).includes(name),
    );
    expect(
      unaccounted,
      'The core Portal publishes its contract. A name here is on the public surface with no '
      + 'spec behind it — model it (on icore_portal, or on the type it belongs to) rather than '
      + 'widening this test.',
    ).toEqual([]);
  });

  it('publishes every method icore_portal declares', () => {
    const missing = [...CONTRACT].filter((name) => !PUBLISHED.includes(name)).sort();
    expect(
      missing,
      'A contract method with no forward: the Portal promises it and the barrel does not carry it.',
    ).toEqual([]);
  });

  it('keeps ONE star export — the rule vocabulary, which realizes no component', () => {
    const source = fs.readFileSync(BARREL_FILE, 'utf8');
    const stars = [...source.matchAll(/^export \* from '([^']*)';/gm)].map((m) => m[1]);
    expect(
      stars,
      'A star export republishes a whole module, so it says nothing about which of its functions '
      + 'the Portal means — which is exactly how the surface grew to 315 names.',
    ).toEqual(['./rules/index.js']);
  });

  it('carries the unmodelled diagram functions as a shrink-only ratchet', () => {
    for (const name of REPORTED_UNMODELLED) {
      expect(PUBLISHED, `${name} is listed as reported-unmodelled but is not exported`).toContain(name);
      expect(
        CONTRACT.has(name),
        `${name} is now a contract method — delete it from REPORTED_UNMODELLED; the list only shrinks.`,
      ).toBe(false);
    }
  });

  it('publishes the shared value shapes its consumers need, as types', () => {
    const source = fs.readFileSync(BARREL_FILE, 'utf8');
    const exportedTypes = new Set<string>();
    for (const match of source.matchAll(/export type \{([^}]*)\} from/g)) {
      for (const raw of match[1].split(',')) {
        const name = raw.replace(/\/\/[^\n]*/g, '').trim();
        if (name) exportedTypes.add(name);
      }
    }
    const missing = DECLARED_TYPES.filter((name) => !exportedTypes.has(name));
    expect(missing, 'A declared type the barrel stopped publishing').toEqual([]);
  });
});

describe('the five consumer files outside src/core', () => {
  for (const relPath of CONSUMER_FILES) {
    it(`${relPath} resolves everything it takes off the barrel`, () => {
      const { values, types } = barrelImports(relPath);
      expect(values.length + types.length, `${relPath} imports nothing from the barrel`).toBeGreaterThan(0);

      const unresolved = values.filter((name) => (barrel as Record<string, unknown>)[name] === undefined);
      expect(unresolved, `${relPath} imports names the barrel no longer exports`).toEqual([]);

      const source = fs.readFileSync(BARREL_FILE, 'utf8');
      const missingTypes = types.filter((name) => !new RegExp(`\\b${name}\\b`).test(source));
      expect(missingTypes, `${relPath} imports types the barrel no longer names`).toEqual([]);
    });
  }
});

/**
 * The embedding API a wrapper product compiles its doctrine into.
 *
 * `docs/extending-wairon.md` documents these by name and
 * `examples/wrapper/wrapper.js` runs on them; `iextension_orchestrator.load`
 * records the contract in the spec tree (`invokedBy: external` — "no internal
 * call chain exists by design"). None of them is on `icore_portal`, so they
 * used to reach the package only because the core barrel starred the module
 * that held them. They are named on the LIBRARY entry now — and this is what
 * says so, because losing a documented API as a side effect of narrowing a
 * Portal is exactly the accident the narrowing nearly caused.
 */
const EMBEDDING_API = [
  'validateSddTree',
  'loadExtensions',
  'loadExtensionPacks',
  'loadProjectExtensions',
  'globalPacksDir',
  'discoverPacks',
  'setProjectRoot',
  'emptyExtensions',
  'SDD_RULES',
  'composeRuleSequence',
] as const;

describe('the documented embedding API stays on the library entry', () => {
  it('exports every name docs/extending-wairon.md lists', () => {
    const missing = EMBEDDING_API.filter((name) => (library as Record<string, unknown>)[name] === undefined);
    expect(missing, 'docs/extending-wairon.md names these as the public embedding API').toEqual([]);
  });

  it('resolves every call the shipped wrapper example makes', () => {
    const example = fs.readFileSync(path.join(REPO_ROOT, 'examples', 'wrapper', 'wrapper.js'), 'utf8');
    const called = [...example.matchAll(/\bwairon\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
    expect(called.length, 'the example stopped calling through the library entry').toBeGreaterThan(0);
    const unresolved = [...new Set(called)].filter((name) => (library as Record<string, unknown>)[name] === undefined);
    expect(unresolved, 'examples/wrapper/wrapper.js calls names the package no longer exports').toEqual([]);
  });
});

describe('approver_identity.label lives with its type', () => {
  const GIT: ApproverIdentity = { id: 'robbe <robbe@example.com>', source: 'git' };
  const NAMED: ApproverIdentity = { id: 'u-17', name: 'Robbe', source: 'hosted' };

  it('renders exactly what the lock store used to render', () => {
    expect(describeApprover(GIT)).toBe('robbe <robbe@example.com>');
    expect(describeApprover(NAMED)).toBe('Robbe (u-17) [authenticated]');
    expect(describeApprover({ id: 'local:someone', source: 'legacy' })).toBe('local:someone');
    expect(describeApprover({ id: 'u-9', name: 'Ops', source: 'os' })).toBe('Ops (u-9)');
  });

  it('marks only an authenticated identity as authenticated', () => {
    for (const source of ['git', 'os', 'legacy'] as const) {
      expect(describeApprover({ id: 'x', source })).not.toContain('authenticated');
    }
    expect(describeApprover({ id: 'x', source: 'hosted' })).toContain('authenticated');
  });

  it('is gone from the lock store, which is the point of moving it', () => {
    expect(
      (lockStore as Record<string, unknown>).describeApprover,
      'While this lived beside the lock file I/O there was no legal route to it: a Portal may not '
      + 'depend on a Store, so no CLI command could render an approver.',
    ).toBeUndefined();
    expect((barrel as Record<string, unknown>).describeApprover).toBeUndefined();
  });

  it('still normalizes a legacy record into the moved type', () => {
    expect(lockStore.normalizeApprover('local:ShutYourWaffle')).toEqual({
      id: 'local:ShutYourWaffle',
      source: 'legacy',
    });
    expect(describeApprover(lockStore.normalizeApprover(NAMED))).toBe('Robbe (u-17) [authenticated]');
  });
});
