import { AgentRecord } from '../models/agent.js';
import { ProjectConfig, RulesConfig } from '../models/project.js';
import { Registry } from '../models/registry.js';

// validator_core_adapter and validator_surfaces_adapter: every name this
// validator takes from another subsystem lands on the adapter's own module,
// which re-exports it by identity from the provider's portal.
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  clearLoaderIssues,
  getLoaderIssues,
  scanAllSpecs,
  dryRunSerializeSpecs,
  loadProjectExtensions,
  loadProjectConfig,
  computeOwnStateId,
  consumedContractInputs,
  settledSpecPaths,
  readLockRecord,
  approvalRecord,
  loadProjectVariants,
  resolveSubsystemExports,
  resolveProjectExports,
  projectFamily,
  exportUsage,
} from './adapters/validator-core.js';
import { listSnapshots, listPinnedExternals } from './adapters/validator-surfaces.js';
// family_validator: the family run the portal forwards validateFamily to.
import * as familyValidator from './family-validation.js';
import { buildRuleContext, makeScopeFilter, SddRule } from './rules/index.js';
import { registerBuiltinRules, registerPackRules, ruleSequence, knownIssueCodes } from './rules/repository.js';

// validator_portal: the write-boundary half of the rule set — judge one
// component before it is written. The spec validator realizes it in
// rules/candidate.ts; it is published here, on the validator's entry point, so
// callers reach it through the portal.
export { validateComponentCandidate } from './rules/candidate.js';
import type { LoadedExtensions } from './extensions.js';
import { projectIdentity, requiredPolicies, type PackRequirement, type PackSelection, type ProjectIdentity } from '../models/project.js';
// pack_impact: the pre-write pack measurement the portal forwards to.
import * as packImpact from './pack-impact.js';
import type { PackCandidate, PackDoctrine, PackImpact } from '../models/pack-impact.js';
import type { ExtensionPack } from './extensions.js';
import { analyzerDigest, computeGateIdentity, type GateConfig } from './rules/gate-identity.js';
import { BUILTIN_PROFILES, PROJECT_KINDS, judgesCode, type IssueSeverity } from './rules/types.js';
import type { StateId } from './statehash.js';
import type { AnalysisGradeLabel, CodeAnalysis, ProjectApproval } from '../models/lock.js';
import type { CodeModel } from '../models/code-model.js';
import { WAIRON_VERSION } from '../config/defaults.js';

/**
 * The project's BY-NAME pack selections, for the reproducibility rule. Legacy
 * path refs are excluded: they pin nothing to check. Never throws — an
 * uninitialized project, or one whose configuration cannot be read, simply
 * selects nothing.
 */
function projectPackSelections(): PackSelection[] {
  try {
    return (loadProjectConfig()?.extensions?.packs ?? []).filter((e): e is PackSelection => typeof e !== 'string');
  } catch {
    return [];
  }
}

/**
 * The bound project's OWN composition.requirePolicies, for the
 * pack-requirements rule to check their syntax. Never a parent's: a parent's
 * requirements reach a member only in the family run. Never throws.
 */
function boundPackRequirements(): PackRequirement[] {
  try {
    const config = loadProjectConfig();
    return config ? requiredPolicies(config) : [];
  } catch {
    return [];
  }
}

/**
 * The bound project's identity, resolved against the id its lock recorded, for
 * the project-identity rule. Undefined when the project has no readable
 * configuration — a configuration that fails its schema is reported by the
 * paths that load it, and an identity guessed from half of it would be a second,
 * less truthful report. An unreadable lock records no id: a lock that cannot be
 * read approved nothing this run can compare against.
 */
function boundProjectIdentity(): ProjectIdentity | undefined {
  let config;
  try {
    config = loadProjectConfig();
  } catch {
    return undefined;
  }
  if (!config) return undefined;
  const lockedProjectId = readLockRecord()?.projectId;
  return projectIdentity(config, lockedProjectId);
}
import {
  buildCodeModel,
  findTestsReferencing as findTestsUnderRoots,
  type TestsToRevisit,
} from './source-analysis.js';
import { getProjectRoot } from '../utils/fs.js';
import * as path from 'path';
import type {
  SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec, MethodImplementation, ReferenceResolution,
} from '../models/index.js';

export type { TestsToRevisit };

/**
 * ispec_validator/ivalidator_portal.findTestsReferencing — the tests that
 * encode a given set of methods, so a write that changes or deletes one can
 * say which tests it just invalidated.
 *
 * The walk itself belongs to the source analyzer, which already owns this
 * subsystem's only source-code I/O and the containment rules a root is held
 * to. A project that declares no test roots answers empty rather than
 * throwing: naming the tests must never be the thing that fails a write.
 */
export function findTestsReferencing(
  methods: ReadonlyArray<Pick<MethodImplementation, 'name' | 'symbol'>>,
  projectRoot: string,
  testRoots: readonly string[] = [],
): TestsToRevisit[] {
  return findTestsUnderRoots(methods, projectRoot, testRoots);
}

// ---------------------------------------------------------------------------
// Validation
//
// The SDD conformance checks themselves live in ./rules/ as a registry of
// documented SddRule modules (the "custom linter"). This module is the public
// entry point: it loads the spec tree, surfaces loader issues, builds the rule
// context, and runs the registry. Registry/topology and project-config
// validation (non-SDD) also live here.
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /**
   * After project and profile overrides. A `notice` is reported like any other
   * finding but never makes a result invalid (`valid` counts errors only) and
   * never fails `--ci`.
   */
  severity: IssueSeverity;
  code: string;
  message: string;
  /** Optional: agent id related to the issue */
  agentId?: string;
  specId?: string;
  /**
   * True when this issue was raised in a draft/design context — i.e. the spec
   * it concerns (or an ancestor) is not yet complete. Rules that already know
   * this (e.g. DRAFT_COMPONENT_WARNING, UNUSED_COMPONENT on a draft component)
   * surface it so downstream policy — like the --ci gate — can waive warnings
   * that merely reflect declared, unfinished work without silencing the rule.
   */
  draftContext?: boolean;
  /**
   * On a finding about a cross-project reference: how the owner's gate
   * resolved it (outcome, owner, call site, canonical target, input digest,
   * reason), decided before the severity.
   */
  resolution?: ReferenceResolution;
  /**
   * In a family run: the key of the project whose gate (or whose external,
   * for a composition finding) the finding belongs to — '' for the family
   * root. Absent on the owner's own run.
   */
  project?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /**
   * One line, never a finding. The owner's gate: present when the project
   * declares externals, saying that `validate --family` composes them against
   * their live producers. A family run: present when externals were left out
   * because their producers lie outside the run's reach.
   */
  hint?: string;
  /**
   * A family run only: one line per selected project (the root first, then its
   * members in scan order) with its own gate's totals. Absent on the owner's
   * gate.
   */
  projects?: ProjectVerdict[];
  /**
   * The as-complete run only (validateAsComplete): the code-conformance half
   * summarized with the analyzer that produced it. Absent on the owner's gate
   * and on a family run.
   */
  analysis?: CodeAnalysis;
}

/**
 * project_verdict — one project's line in a family run: which project it is,
 * where it lives, and the totals of its own gate's verdict, which the family
 * run carries verbatim under the project's key.
 */
export interface ProjectVerdict {
  /** The project's key in the family root's scan ('' for the root itself). */
  key: string;
  /** The project's effective id. */
  id?: string;
  /** The project's root directory. */
  directory: string;
  /** Whether its own gate found no error. */
  valid: boolean;
  errors: number;
  warnings: number;
  notices: number;
}

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  agentId?: string,
  specId?: string,
): ValidationIssue {
  return { severity, code, message, agentId, specId };
}

// ---------------------------------------------------------------------------
// Registry validation
// ---------------------------------------------------------------------------

export function validateRegistry(registry: Registry, rules: RulesConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Duplicate agent ids
  const idCounts = new Map<string, number>();
  for (const agent of registry.agents) {
    idCounts.set(agent.id, (idCounts.get(agent.id) ?? 0) + 1);
  }
  for (const [id, count] of idCounts) {
    if (count > 1) {
      issues.push(issue('error', 'DUPLICATE_AGENT_ID', `Duplicate agent id: "${id}"`, id));
    }
  }

  // Per-agent checks
  for (const agent of registry.agents) {
    validateAgent(agent, rules, issues);
  }

  // Overlapping ownership
  if (rules.noOverlappingOwnership) {
    checkOverlappingOwnership(registry.agents, issues);
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}

function validateAgent(
  agent: AgentRecord,
  rules: RulesConfig,
  issues: ValidationIssue[],
): void {
  const isMeta = agent.tags.some((t) => rules.metaAgentTags.includes(t));

  if (rules.requireOwnedPaths && !isMeta && agent.ownedPaths.length === 0) {
    issues.push(
      issue(
        'warning',
        'NO_OWNED_PATHS',
        `Agent "${agent.id}" has no ownedPaths. Add paths or tag as meta/guardian.`,
        agent.id,
      ),
    );
  }

  if (agent.targets.length === 0) {
    issues.push(
      issue('warning', 'NO_TARGETS', `Agent "${agent.id}" has no output targets configured.`, agent.id),
    );
  }
}

function checkOverlappingOwnership(agents: AgentRecord[], issues: ValidationIssue[]): void {
  // Simple exact-match check — a full glob overlap check is a future improvement
  const pathToAgents = new Map<string, string[]>();

  for (const agent of agents) {
    for (const p of agent.ownedPaths) {
      const owners = pathToAgents.get(p) ?? [];
      owners.push(agent.id);
      pathToAgents.set(p, owners);
    }
  }

  for (const [p, owners] of pathToAgents) {
    if (owners.length > 1) {
      issues.push(
        issue(
          'error',
          'OVERLAPPING_OWNERSHIP',
          `Path "${p}" is claimed by multiple agents: ${owners.join(', ')}`,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Project config validation
// ---------------------------------------------------------------------------

export function validateProjectConfig(config: ProjectConfig): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (config.targets.length === 0) {
    issues.push(issue('error', 'NO_TARGETS', 'No output targets configured in project.yaml'));
  }

  const enabled = config.targets.filter((t) => {
    if (typeof t === 'string') return true;
    return t.enabled !== false;
  });

  if (enabled.length === 0) {
    issues.push(issue('error', 'NO_ENABLED_TARGETS', 'All configured targets are disabled'));
  }

  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
  };
}

// ---------------------------------------------------------------------------
// SDD Spec Tree Validation (rule registry entry point)
// ---------------------------------------------------------------------------

export interface ValidationOptions {
  rules?: RulesConfig;
  projectType?: string;
  scopeSubsystem?: string;
  recursive?: boolean | number;
  /**
   * Pre-loaded extension packs (the programmatic-wrapper path). When omitted,
   * the packs declared in the project's own config are loaded — so CLI and
   * MCP callers get pack rules/profiles/languages without passing anything.
   */
  extensions?: LoadedExtensions;
  /**
   * Validate at FULL strictness: treat every spec as `complete`, so the
   * completeness rules that relax to warnings while draft/design apply as
   * errors. This is the as-complete gate behind `wairon lock`. The flip must
   * happen INSIDE the validation run — clearLoaderIssues() invalidates the
   * spec cache, so any status mutation done before calling in is lost to the
   * rescan (statuses are restored before returning, so the flip is never
   * observable to later callers).
   */
  treatAllAsComplete?: boolean;
  /**
   * Ask for the family run explicitly (`validate --family`, MCP `family:
   * true`). Omitted, a project that declares members runs its family and any
   * other project runs its owner's gate (validation_options.selectsFamily).
   */
  family?: boolean;
  /**
   * The by-name pack selections the pack rules judge. Omitted, the project's
   * own stored selections are read. Given only by a dry run that judges a
   * candidate configuration it has not written (pack_impact.measure), together
   * with that candidate's rules, projectType and loaded extensions.
   */
  packSelections?: PackSelection[];
}

/**
 * The active conformance rule set — the built-in rules plus the loaded
 * programmatic pack rules, in run order — for `wairon rules list`. Loads and
 * registers the governing packs, then reads the composed sequence.
 */
export function listRules(): SddRule[] {
  const extensions = loadProjectExtensions();
  registerBuiltinRules();
  registerPackRules(extensions.rules);
  return ruleSequence();
}

/**
 * The key of the contained member that owns a spec key, or undefined for one
 * of the bound project's own: its owner in the graph, else the longest member
 * key prefixing it (a loader issue on a file whose spec did not load).
 */
function memberOwning(owners: Map<string, string>, memberKeys: string[], key: string): string | undefined {
  const owner = owners.get(key);
  if (owner !== undefined) return owner === '' ? undefined : owner;
  let best: string | undefined;
  for (const k of memberKeys) {
    if (key.startsWith(`${k}::`) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

/**
 * ispec_validator/ivalidator_portal.validateProject — the owner's gate (stage
 * 4): judge the bound project from its own files alone — its specs, its
 * configuration and doctrine, its code, its lock, its externals lock and
 * pinned snapshots, and the export tables of the members it contains — and
 * nothing else. It never walks up to a parent, never reads a sibling's live
 * tree and discovers nothing, so a project's verdict is the same from every
 * root and with or without its family on disk. A contained member's own specs
 * are never judged here: its gate judges them under its own configuration.
 */
export function validateProject(
  rulesOrOptions?: RulesConfig | ValidationOptions,
  projectType: string = 'backend'
): ValidationResult {
  return runOwnersGate(rulesOrOptions, projectType).result;
}

/** One run of the owner's gate: the verdict, and the code model it judged the code with. */
interface OwnersGateRun {
  result: ValidationResult;
  codeModel: CodeModel;
}

/**
 * The owner's gate itself, shared by validateProject and validateAsComplete:
 * the as-complete run also needs the code model the rules read, to say how
 * exactly the code half was analyzed.
 */
function runOwnersGate(
  rulesOrOptions?: RulesConfig | ValidationOptions,
  projectType: string = 'backend'
): OwnersGateRun {
  let rules = rulesOrOptions as RulesConfig | undefined;
  let scopeSubsystem: string | undefined;
  let extensions: LoadedExtensions | undefined;
  let treatAllAsComplete = false;
  let packSelections: PackSelection[] | undefined;

  if (rulesOrOptions && ('scopeSubsystem' in rulesOrOptions || 'recursive' in rulesOrOptions || 'rules' in rulesOrOptions || 'projectType' in rulesOrOptions || 'extensions' in rulesOrOptions || 'treatAllAsComplete' in rulesOrOptions || 'family' in rulesOrOptions || 'packSelections' in rulesOrOptions)) {
    const opts = rulesOrOptions as ValidationOptions;
    rules = opts.rules;
    projectType = opts.projectType ?? 'backend';
    scopeSubsystem = opts.scopeSubsystem;
    extensions = opts.extensions;
    treatAllAsComplete = opts.treatAllAsComplete ?? false;
    packSelections = opts.packSelections;
  }
  extensions ??= loadProjectExtensions();

  // Step 1: the scan reads the bound project and the members it contains —
  // its own references into a contained member are judged against that
  // member's L0 table, whatever `recursive` selects for a family run. Nothing
  // above the bound root is read.
  scanAllSpecs({ recursive: true });

  const issues: ValidationIssue[] = [];

  // Load specs
  clearLoaderIssues();
  const system = loadSystemSpec();
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();
  const types = loadTypeSpecs();
  // Stored surface snapshots (.wai/surfaces/): declared contracts that
  // unresolved cross-tree/remote references validate against.
  const surfaceSnapshots = listSnapshots();
  // Step 10: the bound project's pinned externals — its own lock and
  // snapshots, never the producer — what a reference into a project outside
  // the scan is judged against.
  const pinnedExternals = listPinnedExternals();
  // Source-code model (per-sourcePath declaration/export/import/anchor facts)
  // — what structural conformance checks realization against. The declared
  // source roots widen the walked set with the files no spec names yet, which
  // is the unclaimed-source rule's whole subject; a project that declares none
  // walks nothing and that rule stays silent.
  const conformance = rules?.conformance;
  const codeModel = buildCodeModel(
    implementations, types, getProjectRoot(), conformance?.sourceRoots ?? [], conformance?.exclude ?? [],
  );

  // As-complete mode: flip statuses on the freshly loaded instances — these
  // are the workspace cache's own objects, loaded after the cache clear above,
  // so the rules genuinely see them as complete. Restore in `finally` so the
  // flip never leaks to later callers sharing this process (e.g. the MCP
  // server or hosted request scope).
  // Approved-and-unchanged specs are presented to the rules as complete. That
  // is what the on-disk `status: draft → complete` ratchet used to buy — after
  // approval, ordinary validate stops relaxing completeness findings — except
  // the ratchet bought it by rewriting every spec file in the tree, and it was
  // ONE-WAY: an edited spec stayed marked complete, so in-flux work kept being
  // judged at full strictness with no way back short of a manual demotion.
  //
  // Deriving it from the lock record writes nothing and is bidirectional: a spec
  // that drifts after approval returns to draft context by itself. With no
  // approval the authored status stands, which is how a tree behaves before
  // anyone has gated it.
  const statusBearing: { status?: 'draft' | 'design' | 'complete' }[] = treatAllAsComplete
    ? [...subsystems, ...components, ...interfaces, ...implementations]
    : settledStatusBearing({ subsystems, components, interfaces, implementations });
  const statusSnapshot = statusBearing.map((s) => s.status);
  for (const s of statusBearing) s.status = 'complete';

  try {
    // Retrieve any loader schema validation issues
    const isSpecInScope = makeScopeFilter({ components, interfaces, implementations, types, scopeSubsystem });
    // Step 14: only the loader's diagnostics on the bound project's own files —
    // one on a contained member's file is that member's gate's.
    const scanned = projectFamily();
    const memberKeys = scanned.nodes.filter((n) => n.namespace !== '').map((n) => n.namespace);
    const loaderErrors = getLoaderIssues().filter((e) => !e.specId || memberOwning(scanned.owners, memberKeys, e.specId) === undefined);
    if (scopeSubsystem) {
      issues.push(...loaderErrors.filter(e => e.specId && isSpecInScope(e.specId)));
    } else {
      issues.push(...loaderErrors);
    }
    // Round-trip serializability runs as a registered rule (roundtripRule in
    // rules/integrity/roundtrip-serialization.ts) — visible in `rules list`, severity-tunable, scoped
    // like every other finding. Its dry-run findings are gathered below, before
    // the rules run.

    if (!system) {
      // Everything below needs an L0 to walk, so this returns early — which means
      // project CONFIGURATION checks (pack resolution, reproducibility) have not
      // run yet. Say so rather than leaving their silence to be discovered: the
      // result is already `valid: false`, so nothing is being passed off as clean,
      // but a reader should not assume the pack set was verified.
      const pending = (extensions.errors.length > 0 || extensions.selectionFailures.length > 0)
        ? ' Extension packs were not checked yet either, and at least one problem is already known there — re-run once the L0 exists.'
        : ' Extension-pack configuration is not checked until the L0 exists.';
      issues.push(issue('error', 'MISSING_SYSTEM_SPEC', `L0 System specification (.system.yaml) is missing.${pending}`));
      return { result: { valid: false, issues }, codeModel };
    }

    // A --subsystem scope that names no loaded subsystem is almost always a typo
    // or a wrong namespace prefix; validating "clean" would silently hide the real
    // tree. Fail with a clear error instead. A scope is valid when a subsystem's id
    // matches it exactly, or a namespaced (subproject) subsystem lives under it.
    if (scopeSubsystem) {
      // A member's key is a scope too, even for a member with no subsystem of
      // its own (a vocabulary project of project-level types).
      const scopeMatches = subsystems.some(
        s => s.id === scopeSubsystem || s.id.startsWith(`${scopeSubsystem}::`),
      ) || projectFamily().nodes.some((n) => n.namespace !== '' && n.namespace === scopeSubsystem);
      if (!scopeMatches) {
        const known = subsystems.map(s => s.id).sort();
        const hint = known.length
          ? ` Known subsystems: ${known.join(', ')}.`
          : ' This project declares no subsystems.';
        issues.push(
          issue(
            'error',
            'SUBSYSTEM_NOT_FOUND',
            `--subsystem "${scopeSubsystem}" matches no subsystem in this project.${hint}`,
            undefined,
            scopeSubsystem,
          ),
        );
        return { result: { valid: false, issues }, codeModel };
      }
    }

    // A pack that fails to load is an error, never a silent skip — otherwise
    // the gate would quietly run without the doctrine the project declared.
    for (const err of extensions.errors) {
      issues.push(issue('error', 'EXTENSION_LOAD_ERROR', err));
    }

    // The writer's round-trip dry run over every in-scope spec (same
    // relativization, same schema, no I/O), gathered here so the
    // roundtrip-serialization rule reports it from the context. It runs after
    // the loader issues were collected.
    const roundTripIssues = dryRunSerializeSpecs(isSpecInScope);

    // Register the built-in rules and the loaded pack rules into the rule
    // repository, and read the composed run sequence.
    registerBuiltinRules();
    registerPackRules(extensions.rules);
    const sequence = ruleSequence();
    // Every code the registered rules and the loaded declarative assertions can
    // report: what the lint-allows audit checks lint.allow references against.
    const knownCodes = new Set([
      ...knownIssueCodes().map((rc) => rc.code),
      ...extensions.assertions.map((a) => a.fullCode),
    ]);
    // The codes a rule declares CARRYABLE: the closed set the conformance
    // debt register's entries are checked against, so the register can name
    // measured code-vs-spec debt and nothing else.
    const carryableCodes = new Set(
      knownIssueCodes().filter((rc) => rc.carryable).map((rc) => rc.code),
    );

    // Steps 29-33: the project graph of this scan — the bound project's own
    // from every root, nothing above it — every contained member's L0 table,
    // and for each producer the bound project's references connect it to,
    // those references mapped onto the producer's public names.
    const family = projectFamily();
    const memberTables = family.nodes
      .filter((n) => n.namespace !== '')
      .map((n) => resolveProjectExports(n.namespace));
    const producers = new Set(family.references.filter((r) => r.consumer === '').map((r) => r.producer));
    const exportUsages = [...producers].map((producer) => exportUsage('', producer));

    const ctx = buildRuleContext({
      system,
      subsystems,
      components,
      interfaces,
      implementations,
      types,
      rules,
      projectType,
      scopeSubsystem,
      extensions,
      variants: loadProjectVariants(),
      // Every subsystem's resolved export table, then the project's: the
      // export-tables rule judges the problems the resolver met.
      exportTables: [
        ...subsystems.map((s) => resolveSubsystemExports(s.id)),
        resolveProjectExports(),
        ...memberTables,
      ],
      projectFamily: family,
      exportUsages,
      pinnedExternals,
      // By-name selections only: a legacy path ref pins nothing to check. A dry
      // run supplies its candidate's; otherwise the stored ones.
      packSelections: packSelections ?? projectPackSelections(),
      // The bound project's own requirements, for their syntax only.
      packRequirements: boundPackRequirements(),
      projectIdentity: boundProjectIdentity(),
      surfaceSnapshots,
      codeModel,
      roundTripIssues,
      knownIssueCodes: knownCodes,
      carryableIssueCodes: carryableCodes,
      issues,
    });

    // Run the composed sequence against the context.
    for (const rule of sequence) {
      rule.check(ctx);
    }

    // Steps 37-38: a project that declares externals judged them against its
    // pins alone; the hint says the family run composes them. A hint, not a
    // finding: it never changes the verdict.
    const count = pinnedExternals.length;
    const hint = count > 0
      ? `${count} external${count === 1 ? ' was' : 's were'} judged against ${count === 1 ? 'its pin' : 'their pins'} alone; \`wairon validate --family\` composes ${count === 1 ? 'it' : 'them'} against the live producer${count === 1 ? '' : 's'}.`
      : undefined;

    // Step 39: the project's verdict — the same from every root.
    return {
      result: {
        valid: issues.every((i) => i.severity !== 'error'),
        issues,
        ...(hint ? { hint } : {}),
      },
      codeModel,
    };
  } finally {
    statusBearing.forEach((s, i) => { s.status = statusSnapshot[i]; });
  }
}

/**
 * The loaded spec objects that a human has approved and that have not moved
 * since — the set presented to the rules as `complete`.
 *
 * Empty when the tree was never approved (authored status stands) and, by
 * construction, excludes anything edited since: those return to draft context
 * on their own, which the one-way on-disk ratchet could never do.
 */
function settledStatusBearing(loaded: {
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
}): { status?: 'draft' | 'design' | 'complete' }[] {
  let settled: Set<string> | null;
  try {
    settled = settledSpecPaths();
  } catch {
    return []; // an unreadable approval must never break validation
  }
  if (!settled || settled.size === 0) return [];

  const root = getProjectRoot();
  const index = scanAllSpecs();
  const rel = (abs: string): string => path.relative(root, abs).split(path.sep).join('/');

  const out: { status?: 'draft' | 'design' | 'complete' }[] = [];
  const take = (
    specs: { id: string }[],
    paths: Record<string, string>,
  ): void => {
    for (const spec of specs) {
      const p = paths[spec.id];
      if (p && settled!.has(rel(p))) out.push(spec as { status?: 'draft' | 'design' | 'complete' });
    }
  };
  take(loaded.subsystems, index.paths.subsystem);
  take(loaded.components, index.paths.component);
  take(loaded.interfaces, index.paths.interface);
  take(loaded.implementations, index.paths.implementation);
  return out;
}

/**
 * Validate the tree at FULL strictness — treating every spec as `complete`, so
 * the completeness rules that relax to warnings while draft/design apply as
 * errors — WITHOUT mutating anything on disk. This is the as-complete gate that
 * `wairon lock` and the hosting lock require: a draft tree can "pass" a normal
 * validate yet break the moment it is frozen, so lock must gate on this.
 *
 * The status flip lives inside validateProject (treatAllAsComplete) because
 * validation begins by invalidating the spec cache (clearLoaderIssues), which
 * would discard any objects mutated out here before the rules ever saw them —
 * exactly the silent degradation this wrapper previously suffered from.
 */
export function validateAsComplete(options?: ValidationOptions): ValidationResult {
  const { result, codeModel } = runOwnersGate({ ...(options ?? {}), treatAllAsComplete: true });
  // Steps 15-16: the code half summarized apart, with the analyzer that took
  // it — never removed from the issues; the lock partitions with designOnly.
  const sequence = ruleSequence();
  const doctrineDigest = analyzerDigest(sequence, { rules: options?.rules ?? projectRules() });
  return { ...result, analysis: codeAnalysisOf(result, sequence, codeModel, doctrineDigest) };
}

/** The bound project's rule tuning, when its configuration reads. */
function projectRules(): RulesConfig | undefined {
  try {
    return loadProjectConfig()?.rules;
  } catch {
    return undefined;
  }
}

/** The weakest grade first: a clean result is only as strong as the least exact file it read. */
const GRADE_ORDER: AnalysisGradeLabel[] = ['generic', 'pattern', 'exact'];

/** The weakest analysis grade the code model applied to any analyzed file; `none` when it analyzed none. */
function weakestGrade(codeModel: CodeModel): AnalysisGradeLabel {
  const grades = codeModel.files
    .filter((f) => f.status === 'analyzed' && f.analysisGrade)
    .map((f) => GRADE_ORDER.indexOf(f.analysisGrade as AnalysisGradeLabel));
  return grades.length ? GRADE_ORDER[Math.min(...grades)] : 'none';
}

/** The code half of a run: the codes code-judging rules declare, and how many of each severity it reported. */
function codeAnalysisOf(
  result: ValidationResult,
  sequence: SddRule[],
  codeModel: CodeModel,
  doctrineDigest: string,
): CodeAnalysis {
  const codes = [...new Set(sequence.filter(judgesCode).flatMap((r) => r.codes.map((c) => c.code)))].sort();
  const codeSet = new Set(codes);
  const count = (severity: IssueSeverity): number =>
    result.issues.filter((i) => codeSet.has(i.code) && i.severity === severity).length;
  return {
    analyzer: { validatorVersion: WAIRON_VERSION, doctrineDigest, grade: weakestGrade(codeModel) },
    codes,
    errors: count('error'),
    warnings: count('warning'),
    notices: count('notice'),
  };
}

/**
 * ivalidator_portal.validateFamily — the family run: every selected project's
 * own gate verbatim under its project key, the composition of each project's
 * externals against their live producers, and the family checks. `wairon
 * validate` at a project that declares members, and `--family` anywhere, call
 * this; the owner's gate is validateProject. It forwards to the family
 * validator, which keeps the owner's gate a pure function of one project.
 */
export function validateFamily(options: ValidationOptions): ValidationResult {
  return familyValidator.run(options);
}

/**
 * ivalidator_portal.measurePackImpact — what one pack write would change on
 * the bound project, measured before it happens: the pack's doctrine against
 * wairon's defaults, the profiles of it that would govern, and the owner's-gate
 * findings that differ between the current and the candidate configuration.
 * Writes nothing. Forwarded to the pack impact workflow.
 */
export function measurePackImpact(candidate: PackCandidate): PackImpact {
  return packImpact.measure(candidate);
}

/**
 * ivalidator_portal.measurePackDoctrine — what one pack changes against
 * wairon's defaults, with no project to validate. Writes nothing. Forwarded to
 * the pack impact workflow.
 */
export function measurePackDoctrine(manifest: ExtensionPack): PackDoctrine {
  return packImpact.doctrine(manifest);
}

/**
 * ispec_validator/ivalidator_portal.builtinProfileIds — the ids of wairon's
 * built-in architectural profiles: the built-in half of the profiles a
 * projectType may name. A copy of the rule set's own constant, so a caller can
 * never mutate it.
 */
export function builtinProfileIds(): string[] {
  return [...BUILTIN_PROFILES];
}

/**
 * ispec_validator/ivalidator_portal.builtinProjectKinds — the built-in
 * composite project kinds: legal projectType values that are not
 * architectural profiles and carry no doctrine of their own.
 */
export function builtinProjectKinds(): string[] {
  return [...PROJECT_KINDS];
}

/**
 * The gate identity a lock records and every staleness check compares
 * (ispec_validator/ivalidator_portal.computeGateStateId): the project's OWN
 * content identity, the design doctrine, its own consumed contract inputs, its
 * `composition`, and each direct member's composition subject — read from the
 * member's own lock record, never recomputed and never its specs. So a
 * parent's identity costs its own tree plus one lock file per direct member,
 * and a lock taken at a member's own root and one taken inside its family
 * record the same identity. The validator computes it because the doctrine it
 * covers is the validator's own rule set; core only compares a lock against
 * the identity its caller passes (readLockState).
 */
export function computeGateStateId(): StateId {
  // The whole scan, so the graph names every direct member whatever an earlier
  // caller narrowed it to.
  scanAllSpecs({ recursive: true });
  const content = computeOwnStateId();
  const extensions = loadProjectExtensions();
  // The project's governing configuration decides verdicts too: which profile
  // applies, how it tuned the rules, and what it requires of its members. A
  // configuration that fails its schema contributes nothing, and the tree
  // identity still stands on its own.
  let gate: GateConfig = {};
  try {
    const config = loadProjectConfig();
    if (config) gate = { projectType: config.projectType, rules: config.rules, composition: config.composition ?? null };
  } catch { /* a configuration that fails its schema: an empty gate config */ }
  const inputs = consumedContractInputs();
  const members = directMemberSubjects();
  // The built-in rules only: pack rules enter the identity through the extensions.
  registerBuiltinRules();
  return computeGateIdentity(content, extensions, ruleSequence(), inputs, gate, members);
}

/** The subject recorded for a member with no lock (or no project on disk). */
const NEVER_SUBJECT = 'never';

/**
 * Steps 6-9 of computeGateStateId: each member the bound root declares
 * DIRECTLY → the stateId its own lock record carries (`<algorithm>:<digest>`),
 * or `never`. Recorded, not recomputed: the member's live edits are the
 * member's to re-approve. Deeper members reach the identity through their
 * parent's subject.
 */
function directMemberSubjects(): Record<string, string> {
  const family = projectFamily();
  const subjects: Record<string, string> = {};
  for (const node of family.nodes) {
    if (node.parent !== '' || node.mountAlias === undefined) continue;
    const record = approvalRecord(node.directory);
    subjects[node.mountAlias] = record ? `${record.stateId.algorithm}:${record.stateId.digest}` : NEVER_SUBJECT;
  }
  // A declared member with no project on disk carries no decision at all.
  for (const problem of family.problems) {
    if (problem.kind === 'member-absent' && problem.projects[0] === '' && problem.id) subjects[problem.id] = NEVER_SUBJECT;
  }
  return subjects;
}

/**
 * ivalidator_portal.familyApprovals — the bound project's pin tree: its own
 * approval state and each member's within `depth` levels, each computed at the
 * member's own root, with each member's subject and how its parent pinned it.
 * The one source the lock workflow, `wairon status` and sdd_get_status read,
 * so they cannot disagree. Writes nothing; a hosted caller gates on reach
 * itself before asking about a family.
 */
export function familyApprovals(depth?: number): ProjectApproval[] {
  return familyValidator.projectApprovals(depth);
}
