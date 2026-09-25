import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  loadComponentSpec,
  invalidateSpecCache,
  workspaceFor,
} from '../../src/core/specs.js';
import { createChainedSubsystem } from '../../src/core/provision.js';
import { retireSpecialists, type SpecialistRetirement } from '../../src/core/stereotype-migration.js';
import * as corePortal from '../../src/core/index.js';
import { retireSpecialists as cliRetireSpecialists } from '../../src/commands/adapters/core.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// core_orchestrator.retireSpecialists — every Specialist becomes an
// Orchestrator whose dependencyClass its dependencies decide, classified in
// passes over the dependency graph and settled through cycles; every project
// variant based on Specialist is rebased onto Orchestrator. A plan writes
// nothing.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const BUILTIN_VARIANTS_DIR = path.resolve(__dirname, '..', '..', 'src', 'templates', 'variants');

const sub = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'calc-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const comp = (id: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: 'calc', componentType, owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const specialist = (id: string, dependsOn: string[], over: Record<string, unknown> = {}): ComponentSpec =>
  comp(id, 'Specialist', { dependsOn, ...over });

/** Every file under a directory, by relative path, with its content. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

const PROJECT_VARIANTS = [
  "# The project's logic shapes.",
  '- id: tariff',
  '  base: Specialist',
  '  guidance: Computes a tariff from supplied rates.',
  '- id: publisher',
  '  base: Adapter',
  '  guidance: Fans out events.',
  '',
].join('\n');
const GLOBAL_VARIANTS = 'id: shared-rule\nbase: Specialist\nguidance: the machine-wide rule\n';

/**
 * A `calc` subsystem of Specialists beside declared neighbours: pure and read
 * logic, a workflow, a Repository, an Index, an Adapter, a Store and a Gateway.
 * Each Specialist sits where one class decides: pure, read, unset, waiting on a
 * Specialist classified in a later pass, a cycle that settles on read, and a
 * cycle whose unset member turns the rest unset. A chained `ext` project holds
 * a Specialist of its own; the project and a global variant layer each define a
 * Specialist-based variant.
 */
function calc(): { root: string; globalDir: string; projectVariants: string; globalVariants: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'calc', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-global-'));
  process.env.WAIRON_VARIANTS_DIR = globalDir;
  setProjectRoot(root);

  saveSystemSpec({ schemaVersion: '1.0.0', name: 'calc-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSubsystemSpec(sub('calc'));
  saveComponentSpec(comp('rates', 'Orchestrator', { dependencyClass: 'pure' }));
  saveComponentSpec(comp('lookup', 'Orchestrator', { dependencyClass: 'read' }));
  saveComponentSpec(comp('flow', 'Orchestrator'));
  saveComponentSpec(comp('prices', 'Repository'));
  saveComponentSpec(comp('catalog', 'Index'));
  saveComponentSpec(comp('feed', 'Adapter'));
  saveComponentSpec(comp('ledger', 'Store', { durability: 'durable' }));
  saveComponentSpec(comp('edge', 'Gateway'));

  // pure
  saveComponentSpec(specialist('tax', ['rates'], { variant: 'tariff' }));
  saveComponentSpec(specialist('leaf', []));
  // read
  saveComponentSpec(specialist('quote', ['rates', 'lookup', 'prices', 'catalog', 'feed']));
  // unset
  saveComponentSpec(specialist('stamp', ['rates', 'ledger']));
  saveComponentSpec(specialist('dispatcher', ['flow']));
  // waiting: each sorts before the Specialist it depends on, so its first try finds it unclassified
  saveComponentSpec(specialist('a_total', ['tax']));
  saveComponentSpec(specialist('a_summary', ['quote']));
  saveComponentSpec(specialist('a_audit', ['stamp']));
  // a cycle that settles on read
  saveComponentSpec(specialist('cyc_a', ['cyc_b', 'prices']));
  saveComponentSpec(specialist('cyc_b', ['cyc_a']));
  // a cycle with one member left unset, and a Specialist waiting on the cycle
  saveComponentSpec(specialist('loop_a', ['loop_b']));
  saveComponentSpec(specialist('loop_b', ['loop_a', 'ledger']));
  saveComponentSpec(specialist('loop_c', ['loop_a']));

  createChainedSubsystem(sub('ext', { projectPath: 'packages/ext' }), 'ext');
  const ext = workspaceFor(path.join(root, 'packages', 'ext'));
  ext.saveSubsystemSpec(sub('ext', { parentSystem: 'ext' }));
  ext.saveComponentSpec(comp('rule', 'Specialist', { subsystem: 'ext' }));

  const projectVariants = path.join(root, '.wai', 'variants', 'shapes.yaml');
  fs.mkdirSync(path.dirname(projectVariants), { recursive: true });
  fs.writeFileSync(projectVariants, PROJECT_VARIANTS);
  const globalVariants = path.join(globalDir, 'shared.yaml');
  fs.writeFileSync(globalVariants, GLOBAL_VARIANTS);
  invalidateSpecCache();
  return { root, globalDir, projectVariants, globalVariants };
}

const classes = (plan: SpecialistRetirement): Record<string, string | undefined> =>
  Object.fromEntries(plan.retyped.map((r) => [r.component, r.dependencyClass]));
const reasonOf = (plan: SpecialistRetirement, component: string): string =>
  plan.retyped.find((r) => r.component === component)!.reason;

describe('retireSpecialists', () => {
  let dirs: string[] = [];

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    delete process.env.WAIRON_VARIANTS_DIR;
    for (const dir of dirs) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win locks */ }
    }
    dirs = [];
  });

  const fixture = (): ReturnType<typeof calc> => {
    const made = calc();
    dirs.push(made.root, made.globalDir);
    return made;
  };

  it("plans every Specialist of the bound project, in id order, and neither a Gateway nor a chained project's Specialist", () => {
    fixture();
    const plan = retireSpecialists(false);
    expect(plan.retyped.map((r) => r.component)).toEqual([
      'a_audit', 'a_summary', 'a_total', 'cyc_a', 'cyc_b', 'dispatcher', 'leaf',
      'loop_a', 'loop_b', 'loop_c', 'quote', 'stamp', 'tax',
    ]);
  });

  it('classifies pure a Specialist whose every dependency is pure logic, or that has none', () => {
    fixture();
    const plan = retireSpecialists(false);
    expect(classes(plan)).toMatchObject({ tax: 'pure', leaf: 'pure' });
    expect(reasonOf(plan, 'tax')).toContain('rates');
    expect(reasonOf(plan, 'leaf')).toMatch(/no dependencies/);
  });

  it('classifies read a Specialist that also depends on read logic, a Repository, an Index or an Adapter', () => {
    fixture();
    const plan = retireSpecialists(false);
    expect(classes(plan).quote).toBe('read');
    for (const dependency of ['lookup', 'prices', 'catalog', 'feed']) expect(reasonOf(plan, 'quote')).toContain(dependency);
  });

  it('leaves unset a Specialist with a dependency that fits neither class, naming that dependency', () => {
    fixture();
    const plan = retireSpecialists(false);
    const unset = plan.retyped.filter((r) => r.component === 'stamp' || r.component === 'dispatcher');
    for (const retype of unset) expect('dependencyClass' in retype).toBe(false);
    expect(reasonOf(plan, 'stamp')).toContain('ledger');
    expect(reasonOf(plan, 'stamp')).not.toContain('rates');
    expect(reasonOf(plan, 'dispatcher')).toContain('flow');
  });

  it('classifies a Specialist after the Specialists it depends on, whatever order they are tried in', () => {
    fixture();
    const plan = retireSpecialists(false);
    expect(classes(plan)).toMatchObject({ a_total: 'pure', a_summary: 'read', a_audit: undefined });
    expect(reasonOf(plan, 'a_total')).toContain('tax');
    expect(reasonOf(plan, 'a_audit')).toContain('stamp');
  });

  it('settles a dependency cycle on read when every other dependency allows it', () => {
    fixture();
    const plan = retireSpecialists(false);
    expect(classes(plan)).toMatchObject({ cyc_a: 'read', cyc_b: 'read' });
    expect(reasonOf(plan, 'cyc_a')).toMatch(/cycle/);
    expect(reasonOf(plan, 'cyc_a')).toContain('cyc_b');
    expect(reasonOf(plan, 'cyc_a')).toContain('prices');
  });

  it('turns unset every leftover depending on one left unset, through the cycle and beyond it', () => {
    fixture();
    const plan = retireSpecialists(false);
    expect(classes(plan)).toMatchObject({ loop_a: undefined, loop_b: undefined, loop_c: undefined });
    expect(reasonOf(plan, 'loop_b')).toContain('ledger');
    expect(reasonOf(plan, 'loop_a')).toContain('loop_b');
    expect(reasonOf(plan, 'loop_c')).toContain('loop_a');
  });

  it('plans the rebase of the project variants based on Specialist, and a plan changes no file', () => {
    const { root, globalDir } = fixture();
    const before = [snapshot(root), snapshot(globalDir)];

    const plan = retireSpecialists(false);

    expect(plan.applied).toBe(false);
    expect(plan.rebasedVariants).toEqual(['tariff']);
    expect([snapshot(root), snapshot(globalDir)]).toEqual(before);
  });

  it('applies: retypes each Specialist, rebases the project variant file, and leaves the built-in and global variants alone', () => {
    const { projectVariants, globalVariants } = fixture();
    const builtin = snapshot(BUILTIN_VARIANTS_DIR);
    const planned = retireSpecialists(false);

    const applied = retireSpecialists(true);

    expect(applied.applied).toBe(true);
    expect(applied.retyped).toEqual(planned.retyped);
    expect(applied.rebasedVariants).toEqual(['tariff']);

    invalidateSpecCache();
    for (const retype of planned.retyped) {
      const saved = loadComponentSpec(retype.component)!;
      expect(saved.componentType, retype.component).toBe('Orchestrator');
      expect(saved.dependencyClass, retype.component).toBe(retype.dependencyClass);
    }
    expect(loadComponentSpec('tax')?.variant).toBe('tariff');
    expect(loadComponentSpec('edge')?.componentType).toBe('Gateway');
    expect(loadComponentSpec('ext::rule')?.componentType).toBe('Specialist');

    const variants = fs.readFileSync(projectVariants, 'utf8');
    expect(variants).toContain("# The project's logic shapes.");
    expect(yaml.load(variants)).toEqual([
      { id: 'tariff', base: 'Orchestrator', guidance: 'Computes a tariff from supplied rates.' },
      { id: 'publisher', base: 'Adapter', guidance: 'Fans out events.' },
    ]);
    expect(fs.readFileSync(globalVariants, 'utf8')).toBe(GLOBAL_VARIANTS);
    expect(snapshot(BUILTIN_VARIANTS_DIR)).toEqual(builtin);

    // Nothing is left to retire.
    expect(retireSpecialists(false)).toEqual({ retyped: [], rebasedVariants: [], applied: false });
  });

  it('is published on the core portal and forwarded by the CLI core adapter', () => {
    fixture();
    const plan = retireSpecialists(false);
    expect(corePortal.retireSpecialists(false)).toEqual(plan);
    expect(cliRetireSpecialists(false)).toEqual(plan);
    expect(typeof corePortal.renameComponent).toBe('function');
  });
});
