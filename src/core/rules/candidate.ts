import type { ComponentSpec, SystemSpec } from '../../models/index.js';
import type { RulesConfig } from '../../models/project.js';
import type { ValidationIssue } from '../validation.js';
import type { LoadedExtensions } from '../extensions.js';
import { buildRuleContext } from './index.js';
import { registerBuiltinRules, registerPackRules, specScopedRules } from './repository.js';

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

/** A candidate's verdict, split by severity — errors refuse the write, warnings ride along as notices. */
export interface CandidateVerdict {
  /** Intrinsic violations. The write must be refused; each names its rule code. */
  errors: ValidationIssue[];
  /** Intrinsic advisories (e.g. MISSING_DURABILITY). Surface, but never block. */
  warnings: ValidationIssue[];
}

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
    issues,
  });

  registerBuiltinRules();
  if (opts.extensions?.rules?.length) registerPackRules(opts.extensions.rules);
  for (const rule of specScopedRules()) {
    rule.check(ctx);
  }

  // Belt and braces: a rule that misdeclares its scope and reaches for another
  // spec cannot smuggle a finding about one into this verdict.
  const own = issues.filter(i => !i.specId || i.specId === candidate.id);
  return {
    errors: own.filter(i => i.severity === 'error'),
    warnings: own.filter(i => i.severity === 'warning'),
  };
}

/**
 * Format a refused candidate for an agent: the codes, the messages, and the
 * remedy. Written as one message because the caller's channel is a tool error
 * string — and it names `unset` explicitly, since "remove the field" is the fix
 * an agent most often cannot guess.
 */
export function formatCandidateRefusal(verdict: CandidateVerdict): string {
  const lines = verdict.errors.map(e => `- ${e.code}: ${e.message}`);
  return `Refused: this component's fields do not match its componentType.\n${lines.join('\n')}\n\n`
    + 'Nothing was written. Fix the fields and retry — on an EXISTING spec, remove a field with '
    + 'sdd_update_spec\'s "unset" (e.g. {"unset": ["basePath"]}); passing null leaves it in place.';
}
