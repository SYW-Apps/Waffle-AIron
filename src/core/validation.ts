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
  invalidateSpecCache,
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
import { loadSurfaceSnapshots, loadMountSurfaceSnapshots } from './surfaces.js';
import { buildCodeModel } from './source-analysis.js';
import { findChainingParent } from './specs.js';
import { getProjectRoot, runWithProjectRoot, getRequestParentReach } from '../utils/fs.js';
import * as path from 'path';
import { settledSpecPaths } from './approval.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec } from '../models/index.js';

/**
 * Codes whose verdict is ROOT-DEPENDENT: they fail because a referenced spec, a
 * source file, or a dependency edge cannot be resolved in THIS tree, but may
 * resolve from the parent. Two families with DIFFERENT handling:
 *
 * REFERENCE RESOLUTION — a chained child whose parent is on disk is judged
 * through it (resolveThroughParent), and these are the findings the parent's
 * verdict replaces. With no usable parent they keep their raw verdict: a
 * cross-tree form stays a CROSS_TREE_REF_UNRESOLVED warning and a typo stays an
 * error — never softened. References that DID resolve against a vendored surface
 * snapshot are verdicts in their own right (surfaceResolved).
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
   * True when a code↔spec conformance finding was downgraded to a warning
   * because the tree is a chained subproject whose source paths may be authored
   * relative to the parent root — marked so the --ci gate waives it. References
   * are never marked: a chained child is judged through its parent, or keeps its
   * raw verdict.
   */
  crossTreeContext?: boolean;
  /**
   * True when this finding was verified AGAINST a vendored surface snapshot —
   * the reference resolved to a declared cross-tree contract, so the finding is
   * a genuine contract/boundary verdict, not a resolution failure. Such issues
   * keep full strength in a chained subproject; the parent's re-judgement of the
   * same edge stands in for one only when it is at least as severe.
   */
  surfaceResolved?: boolean;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /**
   * Present when a chained subproject's verdict was resolved through its
   * parent: the top root that was validated and the mount chain it was scoped
   * to. Absent when the tree was validated on its own.
   */
  resolvedThrough?: { root: string; scope: string };
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
   * Internal: 'off' skips resolving a chained subproject through its parent. Set
   * on the run that IS the parent's verdict, so that run can never walk again.
   */
  crossTree?: 'off';
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
  let crossTree: 'off' | undefined;

  if (rulesOrOptions && ('scopeSubsystem' in rulesOrOptions || 'recursive' in rulesOrOptions || 'rules' in rulesOrOptions || 'projectType' in rulesOrOptions || 'extensions' in rulesOrOptions || 'treatAllAsComplete' in rulesOrOptions || 'crossTree' in rulesOrOptions)) {
    const opts = rulesOrOptions as ValidationOptions;
    rules = opts.rules;
    projectType = opts.projectType ?? 'backend';
    scopeSubsystem = opts.scopeSubsystem;
    recursive = opts.recursive ?? true;
    extensions = opts.extensions;
    treatAllAsComplete = opts.treatAllAsComplete ?? false;
    crossTree = opts.crossTree;
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

    // The snapshots each chained mount holds, kept per mount so a contract a
    // child imported decides only that child's references (see
    // RuleContext.mountSurfaceSnapshots). Loaded after the loader issues were
    // collected: resolving a mount that escapes the root raises its issue again.
    const mountSurfaceSnapshots = loadMountSurfaceSnapshots(
      subsystems.filter((s) => s.projectPath).map((s) => s.id),
    );

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
      mountSurfaceSnapshots,
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

    // Chained subprojects: when this tree is validated from its own root but is a
    // chained subproject of a discoverable parent, references INTO the parent
    // (shared types, sibling subsystems, cross-tree components) point at specs
    // that physically live ABOVE this root.
    //
    // Two families, two treatments:
    //  - REFERENCE RESOLUTION: judged through the parent when it is usable;
    //    otherwise every such finding keeps its raw verdict. References that DID
    //    resolve against a snapshot are verdicts in their own right.
    //  - CODE↔SPEC CONFORMANCE: downgraded error→warning + crossTreeContext —
    //    source paths may be authored relative to the parent root.
    //
    // Gated on actually HAVING such issues, so a clean tree (or a hosted per-
    // request validate) never pays the walk-up-the-filesystem cost.
    const hasCrossTreeSuspects = issues.some(
      i => SUBPROJECT_REFERENCE_CODES.has(i.code) || SUBPROJECT_CONFORMANCE_CODES.has(i.code),
    );
    const chainingParent = hasCrossTreeSuspects && crossTree !== 'off' ? findChainingParent(getProjectRoot()) : null;

    // RESOLVE THROUGH THE PARENT. When the parent is on disk, a reference this
    // root cannot resolve is not "unverifiable" — it is judged by validating the
    // parent scoped to this mount. The child keeps every finding of its own and
    // gains the parent's verdict for what it could not see: a union, with no
    // severity changed, so it is never judged more leniently than its parent.
    // (It used to rewrite each such reference into a waived warning instead,
    // including references the parent judged as hard boundary violations.)
    const uncovered = (i: ValidationIssue): boolean => SUBPROJECT_REFERENCE_CODES.has(i.code) && !i.surfaceResolved;
    const resolution = chainingParent && issues.some(uncovered)
      ? resolveThroughParent(getProjectRoot(), treatAllAsComplete)
      : null;
    if (resolution) {
      // A child finding verified against a snapshot is a verdict on a cross-tree
      // edge the parent's run judges again, against the real component or the
      // same snapshot the mount holds. Where the parent reached the same code on
      // the same spec at least as severely, its verdict stands in for the
      // child's: one finding worded from two roots is not two findings. Where it
      // did not, the child's finding stays, so the union is never quieter.
      const parentSeverity = new Map<string, ValidationIssue['severity']>();
      for (const i of resolution.issues) {
        const key = `${i.code}|${i.specId ?? ''}`;
        if (i.severity === 'error' || !parentSeverity.has(key)) parentSeverity.set(key, i.severity);
      }
      const rejudged = (i: ValidationIssue): boolean => {
        const judged = parentSeverity.get(`${i.code}|${i.specId ?? ''}`);
        return judged === 'error' || (judged === 'warning' && i.severity === 'warning');
      };
      const kept = issues.filter((i) => !uncovered(i) && !(i.surfaceResolved && rejudged(i)));
      for (const iss of kept) {
        if (SUBPROJECT_CONFORMANCE_CODES.has(iss.code)) {
          if (iss.severity === 'error') iss.severity = 'warning';
          iss.crossTreeContext = true; // conformance findings keep their downgrade
        }
      }
      const merged = dedupeIssues([...kept, ...resolution.issues]);
      return {
        valid: merged.every((i) => i.severity !== 'error'),
        issues: merged,
        resolvedThrough: { root: resolution.root, scope: resolution.scope },
      };
    }

    // No usable parent (its L0 missing, the mount unknown, or reach denied):
    // every reference keeps its raw verdict. A chained child that cannot be
    // judged through its parent pins its family surfaces or fails its gate — it
    // is never quietly passed. (It used to rewrite each such reference into a
    // warning --ci waived, and prepend a notice explaining why.)
    if (chainingParent) {
      for (const iss of issues) {
        if (SUBPROJECT_CONFORMANCE_CODES.has(iss.code)) {
          if (iss.severity === 'error') iss.severity = 'warning';
          iss.crossTreeContext = true; // conformance findings keep their downgrade
        }
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
 * Validate a chained subproject's specs FROM ITS PARENT: walk up to the top root
 * collecting the mount chain, validate there scoped to that chain, and rename
 * the findings into the child's own ids. Null when no usable parent is reachable
 * — the caller then keeps the standalone verdict.
 *
 * Reach: resolving reads the parent tree. A hosted request whose credential is
 * narrowed to the child never gets here, and the walk never climbs above the
 * request's own top project root.
 */
function resolveThroughParent(
  boundRoot: string,
  treatAllAsComplete: boolean,
): { root: string; scope: string; issues: ValidationIssue[] } | null {
  const reach = getRequestParentReach();
  if (reach && !reach.parentReach) return null;
  const ceiling = reach?.topRoot ? path.resolve(reach.topRoot) : undefined;

  const chain: string[] = [];
  let top = path.resolve(boundRoot);
  while (top !== ceiling) {
    const hop = findChainingParent(top);
    if (!hop) break;
    const next = path.resolve(hop.parentRoot);
    if (ceiling && !isWithinOrEqual(ceiling, next)) break;
    chain.unshift(hop.subsystemId);
    top = next;
  }
  if (chain.length === 0) return null;
  const scope = chain.join('::');

  const inner = runWithProjectRoot(top, () => {
    // Read the parent as it is NOW — the child was probably just edited, and a
    // cached parent tree would judge it against the past.
    invalidateSpecCache();
    // The parent's own governing configuration: its rules and profile decide
    // its verdict, not the child's.
    let governing: { rules?: RulesConfig; projectType?: string } = {};
    try {
      const config = loadProjectConfig();
      governing = { rules: config.rules, projectType: config.projectType };
    } catch { /* an unconfigured parent validates with the defaults */ }
    return validateSddTree({
      ...governing,
      scopeSubsystem: scope,
      recursive: true,
      crossTree: 'off',
      treatAllAsComplete,
    });
  });
  // No L0 to walk, or the mount is not in the parent's tree: nothing to resolve through.
  if (inner.issues.some((i) => i.code === 'MISSING_SYSTEM_SPEC' || i.code === 'SUBSYSTEM_NOT_FOUND')) return null;

  const local = scope.split('::').pop()!;
  const issues = inner.issues.map((i) => ({
    ...i,
    message: stripNamespace(i.message, scope),
    ...(i.specId !== undefined ? { specId: i.specId === scope ? local : stripNamespace(i.specId, scope) } : {}),
  }));
  return { root: top, scope, issues };
}

/**
 * Remove a mount-chain prefix (`scope::`) wherever it begins an id in `text` —
 * only at an id boundary, so `kid::` never bites into `bigkid::x` or into a
 * deeper `par::kid::x` that names a different namespace.
 */
function stripNamespace(text: string, scope: string): string {
  const prefix = `${scope}::`;
  let out = '';
  let from = 0;
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, from)) {
    const atBoundary = at === 0 || !isIdChar(text[at - 1]);
    out += text.slice(from, at) + (atBoundary ? '' : prefix);
    from = at + prefix.length;
  }
  return out + text.slice(from);
}

function isIdChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
    || ch === '_' || ch === '-' || ch === '.' || ch === ':';
}

function isWithinOrEqual(dir: string, target: string): boolean {
  const rel = path.relative(dir, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** One finding per (code, spec, message): a union must never print the same verdict twice. */
function dedupeIssues(list: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const key = `${i.code}|${i.specId ?? ''}|${i.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
 * The status flip lives inside validateSddTree (treatAllAsComplete) because
 * validation begins by invalidating the spec cache (clearLoaderIssues), which
 * would discard any objects mutated out here before the rules ever saw them —
 * exactly the silent degradation this wrapper previously suffered from.
 */
export function validateAsComplete(options?: ValidationOptions): ValidationResult {
  return validateSddTree({ ...(options ?? {}), treatAllAsComplete: true });
}
