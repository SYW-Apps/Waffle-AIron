/**
 * Rule-matrix fixture harness — the contract every family file under
 * tests/rules-matrix/families/*.fixtures.ts is written against.
 *
 * A fixture describes ONE realistic miniature system (the `tree`), names ONE
 * finding code, and states whether the composed rule sequence MUST emit that
 * code against the tree (`expectFire: true`) or MUST stay quiet for that code
 * (`expectFire: false` — other codes may fire; a control only guarantees its
 * OWN code's silence).
 *
 * Execution goes through the REAL loader: the tree is materialized as a
 * temporary `.wai/` project on disk and validated with `validateSddTree()`,
 * exactly the path the CLI, MCP server, and hosted gate take (YAML → zod
 * schemas → spec cache → composed rule sequence → severity/lint-allow/depth
 * gates). See tests/rules-matrix/README.md for the full contract, the
 * scenario-realism requirement, and the ratchet workflow.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { expect } from 'vitest';
import { validateSddTree } from '../../src/core/validation.js';
import type { ValidationIssue, ValidationResult } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import type { RulesConfig } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// The declarative test extension pack (tests/rules-matrix/fixture-pack/).
// Fixtures that need pack-contributed doctrine (namespaced assertion codes,
// pack-declared guarantee tokens) reference it via `tree.packs:
// [FIXTURE_PACK_DIR]`; meta.test.ts folds its namespaced codes into the
// enforced code universe.
// ---------------------------------------------------------------------------

export const FIXTURE_PACK_DIR = path.resolve(__dirname, 'fixture-pack');
export const FIXTURE_PACK_NAME = 'ledger-platform';

// ---------------------------------------------------------------------------
// Fixture contract
// ---------------------------------------------------------------------------

export type FixtureSeverity = 'error' | 'warning';

/**
 * One spec of a fixture tree. `id` is required; every other field is the raw
 * YAML the loader schema accepts for that spec kind (see src/models/specs.ts).
 * The harness fills mandatory boilerplate (schemaVersion, timestamps, derived
 * name/description, status complete) so a fixture states only what its
 * scenario is about — anything you set explicitly wins over the defaults.
 */
export interface FixtureSpecInput {
  id: string;
  [field: string]: unknown;
}

export interface FixtureTree {
  /**
   * L0 fields merged over the defaults ({ name: 'RuleMatrixSystem', vision }).
   * Set `name` when the scenario cares about it (e.g. subsystem parentSystem
   * mismatches).
   */
  system?: Record<string, unknown>;
  /** L1 subsystems. `parentSystem` defaults to the system's name. */
  subsystems?: FixtureSpecInput[];
  /**
   * L2 components. `componentType` defaults to 'Orchestrator'; `subsystem`
   * defaults to the tree's single subsystem (required when there are several).
   */
  components?: FixtureSpecInput[];
  /**
   * L3 interfaces. Ids must start with 'i' (loader schema). `component`
   * defaults to the tree's single component; each method gets description/
   * signature/returns boilerplate unless provided (name stays required).
   */
  interfaces?: FixtureSpecInput[];
  /** L4 implementations (with embedded L5 narratives). `contract` defaults to the tree's single interface. */
  implementations?: FixtureSpecInput[];
  /** Entity / value-object types. `kind` defaults to 'entity'. */
  types?: FixtureSpecInput[];
  /** RulesConfig fragment merged over the harness defaults and passed to validateSddTree. */
  rules?: Record<string, unknown>;
  /** validateSddTree projectType (default 'backend'). */
  projectType?: string;
  /**
   * Extension-pack refs written into the temp project's
   * `extensions.packs` (absolute paths — use FIXTURE_PACK_DIR). Loaded by the
   * real project-extension loader, exactly as a user project would load them.
   */
  packs?: string[];
  /**
   * Extra files materialized relative to the temp project root, forward-slash
   * relative paths ('src/billing/ledger.ts', '.wai/surfaces/crm.yaml', …).
   * This is how fixtures feed the code↔spec conformance family (sourcePath
   * targets), surface snapshots, variants, or nested subprojects.
   */
  files?: Record<string, string>;
  /** Scope the run to one subsystem (validateSddTree scopeSubsystem). */
  scopeSubsystem?: string;
  /** Validate at full strictness, as `wairon lock` does (treatAllAsComplete). */
  treatAllAsComplete?: boolean;
  /**
   * Bind the VALIDATED project root to this subdirectory of the temp root
   * instead of the temp root itself (relative, forward-slash, no '..' — same
   * hygiene as `files`). The tree still materializes at the temp root exactly
   * as always, so the top-level tree becomes an ANCESTOR project of the
   * validated one. This is the seam for chained-subproject resolution: the
   * loader's findChainingParent walks UP from the root looking for an ancestor
   * project whose subsystem `projectPath` resolves to that exact root, and a
   * child found that way is judged THROUGH that parent. Materialize the parent
   * (with the mount subsystem) at the top, the child project under `files`, and
   * point this at the child directory. Overriding the parent's own
   * `.wai/specs/.index.yaml` through `files` makes the parent unloadable — the
   * seam for the standalone fallback (CHAINED_SUBPROJECT_CONTEXT /
   * UNVERIFIED_EXTERNAL_REF).
   */
  validateFromSubdir?: string;
}

export interface RuleFixture {
  /** The finding code under test (builtin or pack-namespaced <PACK>_<CODE>). */
  code: string;
  /** Asserted against the emitted finding's severity when given (fire fixtures only). */
  severity?: FixtureSeverity;
  /**
   * Asserted against the emitted finding's specId when given (fire fixtures
   * only). `null` asserts the OPPOSITE: the finding carries NO specId anchor
   * (a tree-level finding, e.g. the prepended CHAINED_SUBPROJECT_CONTEXT
   * notice). Omit to not assert on the anchor at all.
   */
  anchoredTo?: string | null;
  /**
   * REQUIRED: one human sentence describing the realistic architecture
   * situation the tree models ("a billing Portal reads directly from the
   * invoice Store, skipping the read facade"). Becomes the test name.
   */
  scenario: string;
  tree: FixtureTree;
  /** true → the code MUST be among the findings; false → the code MUST be absent. */
  expectFire: boolean;
  /** For controls: why this near-identical tree must stay quiet. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Definition-time validation. Fails fast (at module import) so a family file
// with a malformed fixture is rejected before any test runs, with a message
// that names the offending fixture.
// ---------------------------------------------------------------------------

/**
 * Fixtures must read like miniature REAL systems (maintainer requirement):
 * meaningful domain names, never comp1/sub-a/foo. This catches the obvious
 * placeholder shapes; reviewers catch the rest.
 */
const GENERIC_ID_PATTERN =
  /^(?:comp(?:onent)?|sub(?:sys(?:tem)?)?|sys(?:tem)?|intf|iface|interface|impl(?:ementation)?|meth(?:od)?|type|foo|bar|baz|qux|quux|test|dummy|fake|mock|stub|sample|example|placeholder|generic|thing|stuff|item|obj(?:ect)?|widget|abc|xyz|asdf)(?:[-_]?(?:[a-z]|\d{1,3}))?$/i;

function assertRealisticId(id: unknown, where: string): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`${where}: every spec needs an "id" (string). Got: ${JSON.stringify(id)}`);
  }
  // Interface ids carry a mandated leading "i" — strip it so "icomp-a" is
  // caught just like "comp-a".
  if (id.length < 3 || GENERIC_ID_PATTERN.test(id) || GENERIC_ID_PATTERN.test(id.replace(/^i[-_]?/, ''))) {
    throw new Error(
      `${where}: spec id "${id}" reads like a placeholder. Fixtures must model miniature REAL systems with ` +
      `meaningful domain names (invoice-store, checkout-portal, shipment-scheduler) — never comp1/sub-a/foo. ` +
      `See tests/rules-matrix/README.md.`,
    );
  }
}

/** Validate an unknown value as a RuleFixture. Used by defineRuleFixture and by the collector (so raw exported objects are held to the same contract). */
export function validateRuleFixture(fx: unknown, where: string): RuleFixture {
  if (fx === null || typeof fx !== 'object') {
    throw new Error(`${where}: a fixture must be an object built with defineRuleFixture(...).`);
  }
  const f = fx as Record<string, unknown>;
  if (typeof f.code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(f.code)) {
    throw new Error(`${where}: "code" must be an UPPER_SNAKE finding code. Got: ${JSON.stringify(f.code)}`);
  }
  if (typeof f.expectFire !== 'boolean') {
    throw new Error(`${where} [${f.code}]: "expectFire" must be true (triggering fixture) or false (control fixture).`);
  }
  if (typeof f.scenario !== 'string' || f.scenario.trim().length < 20 || f.scenario.trim().split(/\s+/).length < 4) {
    throw new Error(
      `${where} [${f.code}]: "scenario" is required — one full human sentence describing the realistic ` +
      `architecture situation the tree models (min 4 words). Got: ${JSON.stringify(f.scenario)}`,
    );
  }
  if (f.severity !== undefined && f.severity !== 'error' && f.severity !== 'warning') {
    throw new Error(`${where} [${f.code}]: "severity" must be 'error' or 'warning' when given.`);
  }
  if (f.anchoredTo !== undefined && f.anchoredTo !== null && (typeof f.anchoredTo !== 'string' || f.anchoredTo.length === 0)) {
    throw new Error(`${where} [${f.code}]: "anchoredTo" must be a non-empty spec id (or null to assert the finding carries NO anchor) when given.`);
  }
  if (f.tree === null || typeof f.tree !== 'object') {
    throw new Error(`${where} [${f.code}]: "tree" must be a FixtureTree object.`);
  }
  const tree = f.tree as FixtureTree;
  if (tree.validateFromSubdir !== undefined) {
    const sub = tree.validateFromSubdir;
    if (
      typeof sub !== 'string' || sub.trim() === '' ||
      path.isAbsolute(sub) || sub.replace(/\\/g, '/').split('/').includes('..')
    ) {
      throw new Error(
        `${where} [${f.code}]: "tree.validateFromSubdir" must be a relative path inside the temp project ` +
        `(no '..', not absolute). Got: ${JSON.stringify(sub)}`,
      );
    }
  }
  for (const kind of ['subsystems', 'components', 'interfaces', 'implementations', 'types'] as const) {
    for (const spec of tree[kind] ?? []) {
      assertRealisticId((spec as FixtureSpecInput).id, `${where} [${f.code}] tree.${kind}`);
    }
  }
  return fx as RuleFixture;
}

/** Declare one rule-matrix fixture. Validates the contract at definition time and returns the fixture unchanged. */
export function defineRuleFixture(fixture: RuleFixture): RuleFixture {
  return validateRuleFixture(fixture, 'defineRuleFixture');
}

// ---------------------------------------------------------------------------
// Materialization — FixtureTree → a real temp .wai project on disk.
// ---------------------------------------------------------------------------

const TS_STAMP = '2026-01-01T00:00:00.000Z';

/** The RulesConfig every fixture runs under unless overridden via tree.rules. Mirrors the defaults tests/core/validation.test.ts uses. */
export const BASE_FIXTURE_RULES: RulesConfig = {
  noOverlappingOwnership: true,
  requireOwnedPaths: true,
  metaAgentTags: ['meta', 'guardian', 'architect'],
  enforceReproducibility: true,
};

function titleFromId(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ');
}

function writeYamlFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(data, { noRefs: true, lineWidth: 200 }));
}

function safeFileName(id: string, taken: Set<string>): string {
  let base = id.replace(/[^a-zA-Z0-9._-]+/g, '_');
  if (taken.has(base)) {
    let n = 2;
    while (taken.has(`${base}_${n}`)) n++;
    base = `${base}_${n}`;
  }
  taken.add(base);
  return `${base}.yaml`;
}

function requireRef(
  value: unknown,
  field: string,
  candidates: FixtureSpecInput[] | undefined,
  specId: string,
  kind: string,
): string {
  if (typeof value === 'string' && value.length > 0) return value;
  if (candidates && candidates.length === 1) return candidates[0].id;
  throw new Error(
    `rule-matrix harness: ${kind} "${specId}" needs an explicit "${field}" (the tree defines ` +
    `${candidates?.length ?? 0} candidates, so it cannot be defaulted).`,
  );
}

type MethodLike = Record<string, unknown>;

function normalizeInterfaceMethods(intfId: string, methods: unknown): MethodLike[] {
  if (methods === undefined) return [];
  if (!Array.isArray(methods)) throw new Error(`rule-matrix harness: interface "${intfId}" methods must be an array.`);
  return methods.map((m) => {
    const method = m as MethodLike;
    if (typeof method.name !== 'string' || method.name.length === 0) {
      throw new Error(`rule-matrix harness: a method on interface "${intfId}" is missing "name".`);
    }
    return {
      description: `Contract method ${method.name} on ${intfId}.`,
      signature: `${method.name}(): void`,
      returns: 'void',
      ...method,
    };
  });
}

/**
 * Write the fixture tree as a real .wai project under `root`. Exported for
 * debugging (inspecting what a fixture materializes); tests normally go
 * through runRuleFixture.
 */
export function materializeFixtureProject(root: string, tree: FixtureTree): void {
  const specsDir = path.join(root, '.wai', 'specs');
  fs.mkdirSync(specsDir, { recursive: true });

  const mergedRules = { ...BASE_FIXTURE_RULES, ...(tree.rules ?? {}) };
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0',
    name: 'rule-matrix-fixture',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: mergedRules,
    extensions: { packs: tree.packs ?? [], useGlobalPacks: false },
    createdAt: TS_STAMP,
    updatedAt: TS_STAMP,
  });

  const system = {
    schemaVersion: '1.0.0',
    name: 'RuleMatrixSystem',
    vision: 'A miniature but realistic system modeling one architecture scenario for the rule-matrix test tier.',
    ...(tree.system ?? {}),
    createdAt: (tree.system?.createdAt as string) ?? TS_STAMP,
    updatedAt: (tree.system?.updatedAt as string) ?? TS_STAMP,
  };
  writeYamlFile(path.join(specsDir, '.index.yaml'), system);

  const dirs: Record<string, string> = {
    subsystems: path.join(specsDir, 'subsystems'),
    components: path.join(specsDir, 'components'),
    interfaces: path.join(specsDir, 'interfaces'),
    implementations: path.join(specsDir, 'implementations'),
    types: path.join(specsDir, 'types'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const taken: Record<string, Set<string>> = {
    subsystems: new Set(), components: new Set(), interfaces: new Set(), implementations: new Set(), types: new Set(),
  };

  for (const sub of tree.subsystems ?? []) {
    writeYamlFile(path.join(dirs.subsystems, safeFileName(sub.id, taken.subsystems)), {
      schemaVersion: '1.0.0',
      name: titleFromId(sub.id),
      description: `The ${titleFromId(sub.id)} subsystem of this scenario's miniature system.`,
      parentSystem: system.name,
      ...sub,
      createdAt: (sub.createdAt as string) ?? TS_STAMP,
      updatedAt: (sub.updatedAt as string) ?? TS_STAMP,
    });
  }

  for (const comp of tree.components ?? []) {
    writeYamlFile(path.join(dirs.components, safeFileName(comp.id, taken.components)), {
      schemaVersion: '1.0.0',
      name: titleFromId(comp.id),
      description: `The ${titleFromId(comp.id)} component of this scenario's miniature system.`,
      componentType: 'Orchestrator',
      dependsOn: [],
      owns: [],
      ...comp,
      subsystem: requireRef(comp.subsystem, 'subsystem', tree.subsystems, comp.id, 'component'),
      createdAt: (comp.createdAt as string) ?? TS_STAMP,
      updatedAt: (comp.updatedAt as string) ?? TS_STAMP,
    });
  }

  for (const intf of tree.interfaces ?? []) {
    writeYamlFile(path.join(dirs.interfaces, safeFileName(intf.id, taken.interfaces)), {
      schemaVersion: '1.0.0',
      name: titleFromId(intf.id.replace(/^i/, '')),
      description: `The contract of ${titleFromId(intf.id.replace(/^i/, ''))} in this scenario's miniature system.`,
      ...intf,
      component: requireRef(intf.component, 'component', tree.components, intf.id, 'interface'),
      methods: normalizeInterfaceMethods(intf.id, intf.methods),
      createdAt: (intf.createdAt as string) ?? TS_STAMP,
      updatedAt: (intf.updatedAt as string) ?? TS_STAMP,
    });
  }

  for (const impl of tree.implementations ?? []) {
    writeYamlFile(path.join(dirs.implementations, safeFileName(impl.id, taken.implementations)), {
      schemaVersion: '1.0.0',
      name: titleFromId(impl.id),
      description: `The ${titleFromId(impl.id)} realization in this scenario's miniature system.`,
      methods: [],
      ...impl,
      contract: requireRef(impl.contract, 'contract', tree.interfaces, impl.id, 'implementation'),
      createdAt: (impl.createdAt as string) ?? TS_STAMP,
      updatedAt: (impl.updatedAt as string) ?? TS_STAMP,
    });
  }

  for (const t of tree.types ?? []) {
    writeYamlFile(path.join(dirs.types, safeFileName(t.id, taken.types)), {
      schemaVersion: '1.0.0',
      kind: 'entity',
      name: titleFromId(t.id),
      description: `The ${titleFromId(t.id)} domain type of this scenario's miniature system.`,
      ...t,
      createdAt: (t.createdAt as string) ?? TS_STAMP,
      updatedAt: (t.updatedAt as string) ?? TS_STAMP,
    });
  }

  for (const [rawRel, content] of Object.entries(tree.files ?? {})) {
    const rel = rawRel.replace(/\\/g, '/');
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) {
      throw new Error(`rule-matrix harness: tree.files path "${rawRel}" must be a relative path inside the temp project (no '..').`);
    }
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

// ---------------------------------------------------------------------------
// Execution + assertion
// ---------------------------------------------------------------------------

export interface FixtureRun {
  result: ValidationResult;
  /** Every finding of the run (loader issues + full composed rule sequence). */
  issues: ValidationIssue[];
  /** The findings whose code equals the fixture's code. */
  matching: ValidationIssue[];
}

/**
 * Materialize the fixture tree as a temp .wai project and validate it through
 * the real entry point (validateSddTree → composed rule sequence, with the
 * project's declared extension packs loaded). The temp project is always
 * removed; the project-root override and spec cache are always restored.
 */
export function runRuleFixture(fixture: RuleFixture): FixtureRun {
  // realpath: os.tmpdir() may be a short (8.3) or symlinked path; rules that
  // compare paths against the project root need one canonical form.
  const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rule-matrix-')));
  try {
    materializeFixtureProject(tempDir, fixture.tree);
    // Optional root re-binding (the chained-child seam): the tree stays
    // materialized at the temp root, but validation runs FROM a nested
    // directory — so the top-level tree is an ANCESTOR the loader's
    // walk-up (findChainingParent) can discover.
    let boundRoot = tempDir;
    if (fixture.tree.validateFromSubdir !== undefined) {
      const rel = fixture.tree.validateFromSubdir.replace(/\\/g, '/');
      if (path.isAbsolute(rel) || rel.split('/').includes('..') || rel.trim() === '') {
        throw new Error(`rule-matrix harness: tree.validateFromSubdir "${fixture.tree.validateFromSubdir}" must be a relative path inside the temp project (no '..').`);
      }
      boundRoot = path.join(tempDir, ...rel.split('/').filter(Boolean));
      if (!fs.existsSync(boundRoot)) {
        throw new Error(
          `rule-matrix harness: tree.validateFromSubdir "${rel}" does not exist after materialization — ` +
          `the child project must be laid down via tree.files (e.g. "${rel}/.wai/specs/.index.yaml").`,
        );
      }
    }
    invalidateSpecCache();
    setProjectRoot(boundRoot);
    try {
      const result = validateSddTree({
        rules: { ...BASE_FIXTURE_RULES, ...(fixture.tree.rules ?? {}) } as RulesConfig,
        projectType: fixture.tree.projectType ?? 'backend',
        ...(fixture.tree.scopeSubsystem !== undefined ? { scopeSubsystem: fixture.tree.scopeSubsystem } : {}),
        ...(fixture.tree.treatAllAsComplete ? { treatAllAsComplete: true } : {}),
      });
      return { result, issues: result.issues, matching: result.issues.filter((i) => i.code === fixture.code) };
    } finally {
      setProjectRoot(null);
      invalidateSpecCache();
    }
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows can hold transient locks on just-written files; the OS temp
      // cleaner picks up the rare straggler.
    }
  }
}

function describeIssues(issues: ValidationIssue[]): string {
  if (issues.length === 0) return '  (no findings at all)';
  return issues.map((i) => `  ${i.severity.toUpperCase()} ${i.code}${i.specId ? ` @${i.specId}` : ''}: ${i.message}`).join('\n');
}

/**
 * Assert a fixture's expectation against a run:
 *  - expectFire=true  → the code IS among the findings; at the declared
 *    severity and anchored to `anchoredTo` when those are given.
 *  - expectFire=false → the code is ABSENT. Other codes are deliberately NOT
 *    asserted on: a control guarantees only its own code's silence, never a
 *    clean tree.
 */
export function assertRuleFixture(fixture: RuleFixture, run: FixtureRun): void {
  if (fixture.expectFire) {
    expect(
      run.matching.length,
      `[${fixture.code}] expected to FIRE but did not.\nScenario: ${fixture.scenario}\nFindings of the run:\n${describeIssues(run.issues)}`,
    ).toBeGreaterThan(0);

    let candidates = run.matching;
    if (fixture.anchoredTo !== undefined) {
      // anchoredTo: null asserts the finding carries NO specId (tree-level).
      candidates = fixture.anchoredTo === null
        ? run.matching.filter((i) => i.specId === undefined)
        : run.matching.filter((i) => i.specId === fixture.anchoredTo);
      const wanted = fixture.anchoredTo === null ? 'no anchor (a tree-level finding without specId)' : `"${fixture.anchoredTo}"`;
      expect(
        candidates.length,
        `[${fixture.code}] fired, but never anchored to ${wanted}.\nScenario: ${fixture.scenario}\nAnchors seen: ${run.matching.map((i) => i.specId ?? '(none)').join(', ')}`,
      ).toBeGreaterThan(0);
    }
    if (fixture.severity !== undefined) {
      expect(
        candidates.some((i) => i.severity === fixture.severity),
        `[${fixture.code}] fired at severity [${candidates.map((i) => i.severity).join(', ')}], expected "${fixture.severity}".\nScenario: ${fixture.scenario}\nMatching findings:\n${describeIssues(candidates)}`,
      ).toBe(true);
    }
  } else {
    expect(
      run.matching.map((i) => `${i.severity} ${i.code}${i.specId ? ` @${i.specId}` : ''}: ${i.message}`),
      `[${fixture.code}] control fixture must stay QUIET for its code (other codes may fire).\nScenario: ${fixture.scenario}${fixture.reason ? `\nWhy it must not fire: ${fixture.reason}` : ''}`,
    ).toEqual([]);
  }
}

/** Convenience: run + assert in one call (what matrix.test.ts uses per fixture). */
export function checkRuleFixture(fixture: RuleFixture): FixtureRun {
  const run = runRuleFixture(fixture);
  assertRuleFixture(fixture, run);
  return run;
}
