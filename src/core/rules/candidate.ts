import type { ComponentSpec, InterfaceSpec, SystemSpec } from '../../models/index.js';
import type { RulesConfig } from '../../models/project.js';
import type { ValidationIssue } from '../validation.js';
import type { LoadedExtensions } from '../extensions.js';
import { buildRuleContext } from './index.js';
import { registerBuiltinRules, registerPackRules, knownIssueCodes, specScopedRules } from './repository.js';
import { entrypointDepsRule } from './doctrine/entrypoint-dependencies.js';
import { dataBlockDepsRule } from './doctrine/data-block-dependencies.js';
import { portalsRule } from './doctrine/portal-endpoints.js';
import { subsystemBoundaryDepsRule } from './doctrine/subsystem-boundary-dependencies.js';
import { scanAllSpecs } from '../adapters/validator-core.js';

// ---------------------------------------------------------------------------
// Candidate validation — the write-boundary half of the rule set.
//
// `sdd_validate_tree` is the authority on whether a DESIGN is legal, and it runs
// over a loaded tree. But a whole family of verdicts needs no tree at all: does
// this component's own field set match its own stereotype? Those are pure
// functions of one spec (`scope: 'spec'`), and withholding them until validate
// time had a real cost — the write succeeded, the error was permanent, and an
// author with no way to unset the offending field was simply stuck.
//
// So the same rules, with the same codes and the same messages, run HERE against
// the candidate before it reaches disk. One rule set, two moments: the intrinsic
// subset gates the write, the full set gates the design.
//
// Deliberately NOT the whole rule set. Tree rules must not run here: a component
// is legitimately authored before its interface, its dependencies, or its
// narratives exist, so MISSING_ENDPOINT and friends would reject every correct
// first step of the sanctioned authoring order. `scope` defaults to 'tree'
// precisely so an undeclared rule can never leak into this path.
// ---------------------------------------------------------------------------

// The verdict is the data model's (src/models/candidate.ts), where its refusal
// text travels with it.
import type { CandidateVerdict } from '../../models/candidate.js';
export type { CandidateVerdict };

export interface CandidateOptions {
  /**
   * The project's rules config, for `sddRuleSeverity` overrides. Passing it is
   * what makes the write boundary honour the same escape hatch validate does:
   * a project that sets a code to 'off' is not blocked by it here either.
   */
  rules?: RulesConfig;
  projectType?: string;
  /** Loaded packs, so pack-registered `scope: 'spec'` rules gate writes too. */
  extensions?: LoadedExtensions;
}

/**
 * The minimal SystemSpec the context builder needs. Only `targetLanguage` is
 * read by any spec-scoped rule path, and a candidate carries no language
 * opinion of its own — so a stub is honest here rather than a shortcut, and it
 * keeps candidate validation free of a tree load.
 */
function stubSystem(): SystemSpec {
  const now = new Date().toISOString();
  return {
    schemaVersion: '1.0.0',
    name: 'candidate',
    vision: '',
    boundaries: [],
    globalRequirements: [],
    databases: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Run the spec-scoped rules against ONE not-yet-written component.
 *
 * The candidate is the only component in the context, so every finding is
 * necessarily about it — no cross-spec state can leak in, and no unrelated
 * pre-existing violation elsewhere in the tree can block this write.
 *
 * Draft status matters and is respected: the candidate arrives as `draft`, so
 * COMPLETENESS codes relax to warnings exactly as they do in a tree run. That
 * is what keeps the authoring order legal — `sdd_add_component` for a Portal
 * followed by `sdd_update_spec` to set its portalType is two calls, and the
 * first must not be refused for being incomplete. A MISPLACED field is a
 * different thing: it is wrong now, it is an error now, and it is refused now.
 */
export function validateComponentCandidate(
  candidate: ComponentSpec,
  opts: CandidateOptions = {},
): CandidateVerdict {
  const issues: ValidationIssue[] = [];

  registerBuiltinRules();
  if (opts.extensions?.rules?.length) registerPackRules(opts.extensions.rules);
  // Every code the registered rules and the loaded declarative assertions can
  // report, gathered as validateProject gathers them, so any rule reading the
  // context's known codes sees the same set.
  const knownCodes = new Set([
    ...knownIssueCodes().map((rc) => rc.code),
    ...(opts.extensions?.assertions ?? []).map((a) => a.fullCode),
  ]);

  const ctx = buildRuleContext({
    system: stubSystem(),
    subsystems: [],
    components: [candidate],
    interfaces: [],
    implementations: [],
    types: [],
    rules: opts.rules,
    projectType: opts.projectType ?? 'backend',
    extensions: opts.extensions,
    // Only a tree-scoped rule reads these (roundtrip-serialization); no
    // spec-scoped rule does, so a candidate carries none.
    roundTripIssues: [],
    knownIssueCodes: knownCodes,
    issues,
  });

  for (const rule of specScopedRules()) {
    rule.check(ctx);
  }

  // Belt and braces: a rule that misdeclares its scope and reaches for another
  // spec cannot smuggle a finding about one into this verdict.
  const own = issues.filter(i => !i.specId || i.specId === candidate.id);
  return {
    errors: own.filter(i => i.severity === 'error'),
    warnings: own.filter(i => i.severity === 'warning'),
    notices: own.filter(i => i.severity === 'notice'),
  };
}

// ---------------------------------------------------------------------------
// The in-tree half: what a write INTRODUCES.
//
// A spec-scoped rule needs no tree; a doctrine edge and a route collision do
// — a Portal depending on a Store is legal or not by the Store's stereotype,
// two methods collide only beside each other. Those used to wait for the next
// validate while the write tool answered "1 change" (a Portal -> Store
// dependsOn, a duplicate route bound by sdd_set_endpoints). They run here over
// the bound tree twice — as stored, and with the candidate in place — and
// only what the candidate adds is kept, restricted to the findings no later
// write in the sanctioned authoring order can cure without undoing this one:
// an edge between two existing blocks whose stereotypes forbid it, and a route
// two bound methods share. Completeness findings never run here, so a
// component authored before its collaborators is never refused for it.
// ---------------------------------------------------------------------------

/** The codes a write is judged on in its tree: each fixed by the two ends of an edge, or by two bound routes. */
const INTRODUCED_CODES: ReadonlySet<string> = new Set([
  'ARCHITECTURE_VIOLATION_PORTAL_DEP',
  'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP',
  'ARCHITECTURE_VIOLATION_VIEW_DEP',
  'ARCHITECTURE_VIOLATION_SUPERVISOR_DEP',
  'ARCHITECTURE_VIOLATION_STORE_DEP',
  'ARCHITECTURE_VIOLATION_REGISTRY_DEP',
  'ARCHITECTURE_VIOLATION_ADAPTER_DEP',
  'ARCHITECTURE_VIOLATION_QUERY_DEP',
  'ENDPOINT_ROUTE_DUPLICATE',
]);

/**
 * The boundary codes judged on an edge that leaves its subsystem. Fixed when
 * the edge's target is not a Portal — no trustedLink and no export makes a
 * Store or an Orchestrator another subsystem's front door — and curable when it
 * is one (a client Adapter, a trustedLink on the source, the target's export).
 */
const BOUNDARY_CODES: ReadonlySet<string> = new Set([
  'CROSS_SUBSYSTEM_NON_ADAPTER',
  'CROSS_SUBSYSTEM_PRIVATE_ACCESS',
  'CROSS_SUBSYSTEM_TARGET_NON_PORTAL',
]);

/**
 * spec_validator.introducedFindings — the doctrine edges, the cross-subsystem
 * edges into a non-Portal and the route collisions writing `candidate` (a
 * component or a contract), together with the `others` the same write changes,
 * would introduce into the bound tree, split by severity: an error refuses the
 * write, a code the project tuned down — and a curable boundary finding on an
 * edge into a Portal — rides along as a warning. Any other kind answers an
 * empty verdict.
 */
export function introducedFindings(
  kind: string,
  candidate: ComponentSpec | InterfaceSpec,
  opts: CandidateOptions = {},
  others: ComponentSpec[] = [],
): CandidateVerdict {
  if (kind !== 'component' && kind !== 'interface') return { errors: [], warnings: [], notices: [] };
  // Step 1: the bound tree, its stored version of the candidate included.
  const index = scanAllSpecs({ memberDepth: 0 });
  // Steps 2-3: the built-ins under validate's codes and severities.
  registerBuiltinRules();
  const knownCodes = new Set(knownIssueCodes().map((rc) => rc.code));
  const swapped = <T extends { id: string }>(list: T[], spec: T): T[] => {
    const at = list.findIndex((s) => s.id === spec.id);
    return at < 0 ? [...list, spec] : list.map((s, i) => (i === at ? spec : s));
  };
  // Steps 4-9: both contexts, the edge, boundary and route rules over each.
  const run = (components: ComponentSpec[], interfaces: InterfaceSpec[]): ValidationIssue[] => {
    const issues: ValidationIssue[] = [];
    const ctx = buildRuleContext({
      system: stubSystem(),
      subsystems: index.subsystems,
      components,
      interfaces,
      implementations: index.implementations,
      types: index.types,
      rules: opts.rules,
      projectType: opts.projectType ?? 'backend',
      extensions: opts.extensions,
      roundTripIssues: [],
      knownIssueCodes: knownCodes,
      issues,
    });
    entrypointDepsRule.check(ctx);
    dataBlockDepsRule.check(ctx);
    subsystemBoundaryDepsRule.check(ctx);
    portalsRule.check(ctx);
    return issues.filter((i) => INTRODUCED_CODES.has(i.code) || BOUNDARY_CODES.has(i.code));
  };
  const changed = kind === 'component' ? [candidate as ComponentSpec, ...others] : others;
  const afterComponents = changed.reduce((list, spec) => swapped(list, spec), index.components);
  const before = run(index.components, index.interfaces);
  const after = kind === 'component'
    ? run(afterComponents, index.interfaces)
    : run(afterComponents, swapped(index.interfaces, candidate as InterfaceSpec));
  // Step 10: only what the write adds — a boundary finding refuses only on an
  // edge into a non-Portal of another subsystem, which no later write cures.
  const key = (i: ValidationIssue): string => `${i.code}|${i.specId ?? ''}|${i.message}`;
  const held = new Set(before.map(key));
  const added = after.filter((i) => !held.has(key(i)));
  const fixedEdges = afterComponents.flatMap((comp) => (comp.dependsOn ?? []).flatMap((ref) => {
    const target = afterComponents.find((c) => c.id === ref);
    return target && target.subsystem !== comp.subsystem && target.componentType !== 'Portal' ? [{ from: comp.id, to: target.id }] : [];
  }));
  const fixed = (i: ValidationIssue): boolean => !BOUNDARY_CODES.has(i.code)
    || fixedEdges.some((e) => e.from === i.specId && i.message.includes(`"${e.to}"`));
  const curable = added.filter((i) => !fixed(i));
  const decided = added.filter(fixed);
  // Step 11.
  return {
    errors: decided.filter((i) => i.severity === 'error'),
    warnings: [...decided.filter((i) => i.severity === 'warning'), ...curable.filter((i) => i.severity !== 'notice')],
    notices: [...decided, ...curable].filter((i) => i.severity === 'notice'),
  };
}
