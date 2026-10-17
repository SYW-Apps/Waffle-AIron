/**
 * The validator's rule registry and its spec catalog are one list.
 *
 * Every built-in rule (SDD_RULES) is exactly one method of one rule family's L3
 * interface, named after the rule, declaring exactly the rule's codes with the
 * same default severity and summary. The spec-scoped rules are exactly the
 * intrinsic family; rule_registry_impl registers the built-ins in SDD_RULES'
 * order; and each rule's implementation method names the rule's own file, which
 * exports that rule. A test rather than a validator rule, because only wairon
 * knows its registry's format.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { SDD_RULES } from '../../src/core/rules/repository.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SPECS = path.join(REPO_ROOT, '.wai', 'specs');

const FAMILY_FOLDERS: Record<string, string> = {
  integrity_rules: 'integrity',
  narrative_rules: 'narrative',
  intrinsic_rules: 'intrinsic',
  doctrine_rules: 'doctrine',
  extension_rules: 'extension',
  wiring_rules: 'wiring',
  conformance_rules: 'conformance',
  heuristic_rules: 'heuristic',
};

interface Finding { code: string; severity: string; summary: string }
interface CatalogEntry { family: string; folder: string; method: string; description: string; findings: Finding[]; sourcePath?: string; symbol?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SpecDocument = any;

const methodName = (ruleName: string): string => ruleName.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const readSpec = (...segments: string[]): SpecDocument => yaml.load(fs.readFileSync(path.join(SPECS, ...segments), 'utf8'));
const byCode = (a: Finding, b: Finding) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

const catalog: CatalogEntry[] = Object.entries(FAMILY_FOLDERS).flatMap(([family, folder]) => {
  const contract = readSpec('interfaces', `i${family}.yaml`);
  const implementation = readSpec('implementations', `${family}_impl.yaml`);
  return contract.methods.map((m: { name: string; description: string; findings?: Finding[] }) => {
    const realized = implementation.methods.find((im: { name: string }) => im.name === m.name);
    return {
      family,
      folder,
      method: m.name,
      description: m.description,
      findings: (m.findings ?? []).map(({ code, severity, summary }) => ({ code, severity, summary })),
      sourcePath: realized?.sourcePath,
      symbol: realized?.symbol,
    };
  });
});

const entryFor = (ruleName: string): CatalogEntry | undefined => catalog.find((e) => e.method === methodName(ruleName));

describe('rule catalog', () => {
  it('has one spec method per built-in rule and one built-in rule per spec method', () => {
    expect(catalog.map((e) => e.method).sort()).toEqual(SDD_RULES.map((r) => methodName(r.name)).sort());
  });

  it.each(SDD_RULES.map((r) => [r.name, r] as const))('%s declares the same codes as its spec method', (_name, rule) => {
    const fromCode = rule.codes.map((c) => ({ code: c.code, severity: c.defaultSeverity, summary: c.summary })).sort(byCode);
    expect(entryFor(rule.name)?.findings.slice().sort(byCode)).toEqual(fromCode);
  });

  it.each(SDD_RULES.map((r) => [r.name, r] as const))('%s\'s description matches its spec method\'s description', (_name, rule) => {
    expect(entryFor(rule.name)?.description).toBe(`Rule ${rule.name}. ${rule.description}`);
  });

  it('makes the spec-scoped built-ins exactly the intrinsic family', () => {
    const specScoped = SDD_RULES.filter((r) => r.scope === 'spec').map((r) => methodName(r.name)).sort();
    const intrinsic = catalog.filter((e) => e.family === 'intrinsic_rules').map((e) => e.method).sort();
    expect(specScoped).toEqual(intrinsic);
  });

  it('registers the built-ins in SDD_RULES order', () => {
    const registry = readSpec('implementations', 'rule_registry_impl.yaml');
    const seed = registry.methods.find((m: { name: string }) => m.name === 'registerBuiltinRules');
    const registered = seed.narrative
      .filter((s: { type: string }) => s.type === 'register')
      .map((s: { targetMethod: string }) => s.targetMethod);
    expect(registered).toEqual(SDD_RULES.map((r) => methodName(r.name)));
  });

  it.each(SDD_RULES.map((r) => [r.name, r] as const))('%s lives in its own file, bound by symbol check', async (_name, rule) => {
    const entry = entryFor(rule.name)!;
    expect(entry.sourcePath).toBe(`src/core/rules/${entry.folder}/${rule.name}.ts`);
    expect(entry.symbol).toBe('check');
    const module = await import(path.join(REPO_ROOT, entry.sourcePath!));
    expect(Object.values(module)).toContain(rule);
  });
});
