import { AgentRecord } from '../models/agent.js';
import { ProjectConfig, RulesConfig } from '../models/project.js';
import { Registry } from '../models/registry.js';

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
} from './specs.js';
import { buildRuleContext, makeScopeFilter, SddRule } from './rules/index.js';
import { registerBuiltinRules, registerPackRules, ruleSequence } from './rules/repository.js';
import { LoadedExtensions, loadProjectExtensions } from './extensions.js';
import type { PackSelection } from '../models/project.js';
// Static, NOT a lazy require: a relative require does not resolve under the test
// runner, and the catch below would swallow it into "no selections" — silently
// disabling the reproducibility rule in every test.
import { loadProjectConfig } from '../config/loader.js';

/**
 * The project's BY-NAME pack selections, for the reproducibility rule. Legacy
 * path refs are excluded: they pin nothing to check. Never throws — an
 * uninitialized project simply selects nothing.
 */
function projectPackSelections(): PackSelection[] {
  try {
    return (loadProjectConfig().extensions?.packs ?? []).filter((e): e is PackSelection => typeof e !== 'string');
  } catch {
    return [];
  }
}
import { loadProjectVariants } from './variants.js';
import { loadSurfaceSnapshots } from './surfaces.js';
import { buildCodeModel } from './source-analysis.js';
import { findChainingParent } from './specs.js';
import { getProjectRoot } from '../utils/fs.js';
import * as path from 'path';
import { settledSpecPaths } from './baseline.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec } from '../models/index.js';

/**
 * Codes whose verdict is ROOT-DEPENDENT: they fail because a referenced spec, a
 * source file, or a dependency edge cannot be resolved in THIS tree, but resolve
 * fine from the parent. When the tree is a chained subproject validated
 * standalone, the target legitimately lives in the absent parent (or is reached
 * by a parent-root-relative sourcePath). Two families with DIFFERENT handling:
 *
 * REFERENCE RESOLUTION — each issue a snapshot does NOT cover is REPLACED by
 * one precise UNVERIFIED_EXTERNAL_REF warning (crossTreeContext, so --ci waives
 * it) naming the original finding and the remedy. References that DID resolve
 * against a vendored surface snapshot never enter this path: a snapshot IS the
 * verifiable contract, so contract mismatches and boundary violations keep
 * full strength (issues marked surfaceResolved are skipped).
 */
const SUBPROJECT_REFERENCE_CODES = new Set([
  'UNDEFINED_TYPE_REFERENCE',
  'INVALID_DEPENDENCY_REFERENCE',
  'INVALID_TARGET_COMPONENT_REFERENCE',
  'INVALID_SUBSYSTEM_REFERENCE',
  'UNDECLARED_DEPENDENCY_CALL',
  'INVALID_TRUSTED_LINK',
  'CROSS_SUBSYSTEM_NON_ADAPTER',
  'CROSS_TREE_REF_UNRESOLVED',
]);

/**
 * CODE↔SPEC CONFORMANCE (sourcePaths + realization + dependency graph) — these
 * KEEP the error→warning downgrade with crossTreeContext: sourcePaths are
 * stored relative to the authoring (parent) root and genuinely cannot resolve
 * standalone. The parent root remains the authoritative gate.
 */
const SUBPROJECT_CONFORMANCE_CODES = new Set([
  'MISSING_SOURCE_FILE',
  'SOURCE_PATH_ESCAPES_ROOT',
  'MISSING_SOURCE_PATH',
  'UNREALIZED_METHOD',
  'CONFORMANCE_ANALYSIS_SKIPPED',
  'CONFORMANCE_DEGRADED',
  'UNDECLARED_DEPENDENCY',
  'UNREALIZED_DEPENDENCY',
]);

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
  severity: 'error' | 'warning';
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
   * True when this issue reflects a reference that cannot be resolved because the
   * tree is being validated STANDALONE as a chained subproject — the referenced
   * spec lives in the (absent) parent tree. Downgraded from error to warning and
   * marked so the --ci gate can waive it: a subproject is fully verified from the
   * parent root, not standalone.
   */
  crossTreeContext?: boolean;
  /**
   * True when this finding was verified AGAINST a vendored surface snapshot —
   * the reference resolved to a declared cross-tree contract, so the finding is
   * a genuine contract/boundary verdict, not a resolution failure. Such issues
   * keep full strength in the chained-subproject pass (they are never replaced
   * by UNVERIFIED_EXTERNAL_REF).
   */
  surfaceResolved?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
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

export function validateSddTree(
  rulesOrOptions?: RulesConfig | ValidationOptions,
  projectType: string = 'backend'
): ValidationResult {
  let rules = rulesOrOptions as RulesConfig | undefined;
  let scopeSubsystem: string | undefined;
  let recursive: boolean | number = true;
  let extensions: LoadedExtensions | undefined;
  let treatAllAsComplete = false;

  if (rulesOrOptions && ('scopeSubsystem' in rulesOrOptions || 'recursive' in rulesOrOptions || 'rules' in rulesOrOptions || 'projectType' in rulesOrOptions || 'extensions' in rulesOrOptions || 'treatAllAsComplete' in rulesOrOptions)) {
    const opts = rulesOrOptions as ValidationOptions;
    rules = opts.rules;
    projectType = opts.projectType ?? 'backend';
    scopeSubsystem = opts.scopeSubsystem;
    recursive = opts.recursive ?? true;
    extensions = opts.extensions;
    treatAllAsComplete = opts.treatAllAsComplete ?? false;
  }
  extensions ??= loadProjectExtensions();

  // Configure spec loader recursion
  scanAllSpecs({ recursive });

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
  const surfaceSnapshots = loadSurfaceSnapshots();
  // Source-code model (per-sourcePath declaration/export/import/anchor facts)
  // — what structural conformance checks realization against.
  const codeModel = buildCodeModel(implementations, getProjectRoot());

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
  // Deriving it from the baseline writes nothing and is bidirectional: a spec
  // that drifts after approval returns to draft context by itself. With no
  // baseline the authored status stands, which is how a tree behaves before
  // anyone has gated it.
  const statusBearing: { status?: 'draft' | 'design' | 'complete' }[] = treatAllAsComplete
    ? [...subsystems, ...components, ...interfaces, ...implementations]
    : settledStatusBearing({ subsystems, components, interfaces, implementations });
  const statusSnapshot = statusBearing.map((s) => s.status);
  for (const s of statusBearing) s.status = 'complete';

  try {
    // Retrieve any loader schema validation issues
    const isSpecInScope = makeScopeFilter({ components, interfaces, implementations, types, scopeSubsystem });
    const loaderErrors = getLoaderIssues();
    if (scopeSubsystem) {
      issues.push(...loaderErrors.filter(e => e.specId && isSpecInScope(e.specId)));
    } else {
      issues.push(...loaderErrors);
    }
    // Round-trip serializability runs as a registered rule (roundtripRule in
    // rules/namespace.ts) — visible in `rules list`, severity-tunable, scoped
    // like every other finding.

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
      return { valid: false, issues };
    }

    // A --subsystem scope that names no loaded subsystem is almost always a typo
    // or a wrong namespace prefix; validating "clean" would silently hide the real
    // tree. Fail with a clear error instead. A scope is valid when a subsystem's id
    // matches it exactly, or a namespaced (subproject) subsystem lives under it.
    if (scopeSubsystem) {
      const scopeMatches = subsystems.some(
        s => s.id === scopeSubsystem || s.id.startsWith(`${scopeSubsystem}::`),
      );
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
        return { valid: false, issues };
      }
    }

    // A pack that fails to load is an error, never a silent skip — otherwise
    // the gate would quietly run without the doctrine the project declared.
    for (const err of extensions.errors) {
      issues.push(issue('error', 'EXTENSION_LOAD_ERROR', err));
    }

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
      // By-name selections only: a legacy path ref pins nothing to check.
      packSelections: projectPackSelections(),
      surfaceSnapshots,
      codeModel,
      issues,
    });

    // Register the built-in rules and the loaded pack rules into the rule
    // repository, then run the composed sequence against the context.
    registerBuiltinRules();
    registerPackRules(extensions.rules);
    for (const rule of ruleSequence()) {
      rule.check(ctx);
    }

    // Chained-subproject reference honesty: when this tree is being validated
    // STANDALONE but is actually a chained subproject of a discoverable parent,
    // references INTO the parent (shared types, sibling subsystems, cross-tree
    // components) point at specs that physically live ABOVE this root. That is
    // the "different root, different verdict" surprise: from the parent these
    // resolve and the tree is clean; from the subproject's own dir they explode
    // into hundreds of hard errors.
    //
    // Two families, two treatments:
    //  - REFERENCE RESOLUTION: each cross-tree reference NO vendored surface
    //    snapshot covers is REPLACED by one precise UNVERIFIED_EXTERNAL_REF
    //    warning (crossTreeContext, so --ci waives it) naming the original
    //    finding and the remedy. References that DID resolve against a snapshot
    //    never enter this path (surfaceResolved) — a snapshot IS the verifiable
    //    contract, so contract mismatches and boundary violations stay errors.
    //  - CODE↔SPEC CONFORMANCE: downgraded error→warning + crossTreeContext as
    //    before — parent-root-relative sourcePaths genuinely cannot resolve here.
    //
    // Gated on actually HAVING such issues, so a clean tree (or a hosted per-
    // request validate) never pays the walk-up-the-filesystem cost.
    const hasCrossTreeSuspects = issues.some(
      i => SUBPROJECT_REFERENCE_CODES.has(i.code) || SUBPROJECT_CONFORMANCE_CODES.has(i.code),
    );
    const chainingParent = hasCrossTreeSuspects ? findChainingParent(getProjectRoot()) : null;
    if (chainingParent) {
      let unverified = 0;
      let downgraded = 0;
      for (let at = 0; at < issues.length; at++) {
        const iss = issues[at];
        if (SUBPROJECT_REFERENCE_CODES.has(iss.code) && !iss.surfaceResolved) {
          issues[at] = {
            severity: 'warning',
            code: 'UNVERIFIED_EXTERNAL_REF',
            crossTreeContext: true, // --ci waives it (parent root is authoritative)
            specId: iss.specId,
            ...(iss.agentId ? { agentId: iss.agentId } : {}),
            ...(iss.draftContext ? { draftContext: true } : {}),
            message:
              `Unverified external reference (${iss.code}): ${iss.message} No vendored surface snapshot ` +
              `covers this reference, so it cannot be verified from this chained subproject standalone — ` +
              `re-lock the parent so fresh family/sibling snapshots ship, or inspect what this project can ` +
              `consume via \`wairon surface externals\` / sdd_list_external_interfaces.`,
          };
          unverified++;
          continue;
        }
        if (SUBPROJECT_CONFORMANCE_CODES.has(iss.code)) {
          if (iss.severity === 'error') {
            iss.severity = 'warning';
            downgraded++;
          }
          iss.crossTreeContext = true; // mark so --ci waives it (parent root is authoritative)
        }
      }
      if (unverified > 0 || downgraded > 0) {
        const notes: string[] = [];
        if (unverified > 0) {
          notes.push(
            `${unverified} cross-tree reference(s) have no vendored surface snapshot covering them and were ` +
            `reported as UNVERIFIED_EXTERNAL_REF warnings — re-lock the parent so fresh family/sibling ` +
            `snapshots ship, or inspect via \`wairon surface externals\` / sdd_list_external_interfaces.`,
          );
        }
        if (downgraded > 0) {
          notes.push(
            `${downgraded} code↔spec conformance finding(s) (parent-root-relative source paths) were ` +
            `downgraded to warnings.`,
          );
        }
        issues.unshift({
          severity: 'warning',
          code: 'CHAINED_SUBPROJECT_CONTEXT',
          crossTreeContext: true,
          message:
            `This project is a chained subproject ("${chainingParent.subsystemId}") of the parent project at ` +
            `"${chainingParent.parentRoot}". ${notes.join(' ')} Full cross-tree verification runs from the ` +
            `parent root.`,
        });
      }
    }

    return {
      valid: issues.every((i) => i.severity !== 'error'),
      issues,
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
    return []; // a baseline problem must never break validation
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
 * The status flip lives inside validateSddTree (treatAllAsComplete) because
 * validation begins by invalidating the spec cache (clearLoaderIssues), which
 * would discard any objects mutated out here before the rules ever saw them —
 * exactly the silent degradation this wrapper previously suffered from.
 */
export function validateAsComplete(options?: ValidationOptions): ValidationResult {
  return validateSddTree({ ...(options ?? {}), treatAllAsComplete: true });
}
