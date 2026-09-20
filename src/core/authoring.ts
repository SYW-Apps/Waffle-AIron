import type { ComponentSpec, MethodImplementation } from '../models/specs.js';
import type { RulesConfig } from '../models/project.js';
import {
  saveComponentSpec, updateSpec, moveMethods as coreMoveMethods,
  type MethodMoveReport, type SpecChangeReport, type SpecWriteHooks, type WritableSpecKind,
} from './specs.js';
import { validateComponentCandidate, findTestsReferencing } from './validation.js';
import { formatCandidateRefusal, type CandidateVerdict } from './rules/candidate.js';
import { loadProjectConfig } from './index.js';
import { getProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// The AUTHORING seam — gated spec writes, shared by every access path.
//
// wairon is one backend behind four doors: the local CLI, the local stdio MCP
// server, the hosted web interface, and the hosted MCP/API. Which door you came
// through decides authentication and transport, never behaviour. So a rule about
// what may be written belongs HERE, above the store and above the rule engine,
// where every door reuses it — not in a transport handler, where the next door
// would have to reimplement it and would eventually reimplement it differently.
//
// Layering, and why it is this way round:
//
//   access paths (cli / mcp / hosted http)  ->  authoring  ->  specs + rules
//
// `core/specs.ts` stays a dumb store: core/validation.ts (the rule engine's
// entry point) already reads it, so a store that imported the rule engine
// back would close an import cycle. This module sits above both and owns the
// composition, injecting the gate through SpecWriteHooks. That also keeps
// MECHANICAL writes ungated by construction — status promotion, layout
// normalization, and migrations call the store directly and are unaffected,
// which is what lets a spec authored before a rule existed still load and
// still be repaired.
// ---------------------------------------------------------------------------

/**
 * The project's configuration, as the settings a write is judged and reported
 * with: the severity overrides (so `sddRuleSeverity` disarms a gate exactly as
 * it disarms validate), the project type, and — through `rules.conformance` —
 * the test roots a change report searches.
 */
function candidateOptions(): { rules?: RulesConfig; projectType?: string } {
  try {
    const config = loadProjectConfig();
    return config ? { rules: config.rules, projectType: config.projectType } : {};
  } catch {
    // An uninitialized or unreadable project gets default severities. A config
    // read must never be the thing that fails a write closed.
    return {};
  }
}

/** Intrinsic warnings, as the notice strings the authoring surfaces already return. */
function noticesFrom(verdict: CandidateVerdict): string[] {
  return verdict.warnings.map(w => `${w.code}: ${w.message}`);
}

/**
 * The write-boundary gate for components, as an injectable hook.
 *
 * Judges the MERGED spec, because that is the only form in which the spec the
 * caller will actually get exists — a delta on its own cannot tell you the
 * resulting componentType, and it is the resulting componentType that decides
 * whether a field belongs.
 */
export function componentCandidateGate(
  options: { rules?: RulesConfig; projectType?: string } = candidateOptions(),
): SpecWriteHooks {
  return {
    gate: (kind, merged) => {
      if (kind !== 'component') return;
      const verdict = validateComponentCandidate(merged as ComponentSpec, options);
      if (verdict.errors.length) throw new Error(formatCandidateRefusal(verdict));
      return noticesFrom(verdict);
    },
  };
}

/**
 * Author a NEW L2 component: gate the candidate, then persist it.
 *
 * Throws on an intrinsic violation, before anything touches disk — so the remedy
 * really is "fix the arguments and call again", not "repair a saved spec".
 * Returns the store's notices plus any intrinsic warnings.
 */
export function addComponent(candidate: ComponentSpec): string[] {
  const verdict = validateComponentCandidate(candidate, candidateOptions());
  if (verdict.errors.length) throw new Error(formatCandidateRefusal(verdict));
  return [...noticesFrom(verdict), ...saveComponentSpec(candidate)];
}

/**
 * Patch an existing spec through the same gate. An update can introduce a
 * misplaced field just as easily as a create can — and unlike a create, it can
 * also change the componentType out from under fields that were legal before.
 *
 * Answers with a SpecChangeReport: exactly what changed, which of the delta's
 * paths changed nothing, or that nothing did and nothing was written. A caller
 * that cannot tell those apart eventually ships an edit it never made.
 *
 * `dryRun` runs the whole write, this gate included, and answers with the report
 * it would have produced without touching disk — so "what will this delta do to
 * a 200-step narrative" is a question that can be asked before it is answered
 * by the file.
 *
 * A write that changed or deleted a METHOD also names the tests that encode it,
 * when the project declares test roots. The change that creates the collision
 * is the one that reports it: a spec pass that rewrites a contract and says
 * nothing is how a brief comes to promise green tests it has already broken.
 */
export function updateSpecGated(
  kind: WritableSpecKind,
  id: string,
  delta: Record<string, any>,
  dryRun?: boolean,
): SpecChangeReport {
  // Step 1: the bound project's configuration — the severities and project
  // type the judgement uses, and the test roots the report searches. A project
  // that has none is judged on the defaults and searches nothing.
  const bound = candidateOptions();
  // Step 2: the judgement as a write hook over those same settings.
  const gate = componentCandidateGate(bound);
  // Step 3: apply the delta with the hook injected, so the judgement runs on
  // the merged spec at the last point before anything reaches disk.
  const report = updateSpec(kind, id, delta, gate, dryRun);

  // Step 4: did this write invalidate any test?
  const testRoots = bound.rules?.conformance?.testRoots ?? [];
  const changed = changedMethods(report, delta);
  if (changed.length > 0 && testRoots.length > 0) {
    // Step 5.
    report.testsToRevisit = findTestsReferencing(changed, getProjectRoot(), testRoots);
  }

  // Step 6.
  return report;
}

/**
 * The methods this write changed or deleted — the search's subject.
 *
 * The change report addresses them by PATH (`methods.<name>`, and everything
 * under it), which is the one place both a rewritten method and a deleted one
 * appear. The delta is where a code-level `symbol` for one of them is written,
 * so it supplies that; a symbol the delta does not restate is not knowable
 * from the report alone, and the search falls back to the contract name —
 * exactly what it does for a method that declares no symbol at all.
 */
function changedMethods(
  report: SpecChangeReport,
  delta: Record<string, any>,
): Pick<MethodImplementation, 'name' | 'symbol'>[] {
  const named = new Set<string>();
  for (const change of report.changes) {
    const [field, name] = change.path.split('.');
    if (field === 'methods' && name) named.add(name);
  }
  const written: Record<string, any>[] = Array.isArray(delta?.methods) ? delta.methods : [];
  return [...named].map(name => ({
    name,
    symbol: written.find(m => m?.name === name)?.symbol,
  }));
}

/**
 * The write-boundary judgement for a METHOD MOVE, with both halves.
 *
 * `gate` refuses the resulting components at the write boundary exactly as the
 * candidate gate does. `assess` answers the same question about a candidate
 * home WITHOUT throwing, so the store — which holds the tree and can enumerate
 * the candidates — can rank them instead of driving a search on caught
 * exceptions.
 *
 * Beyond the intrinsic rules it reads the project's dependency ceiling, because
 * that is the rule a move actually trips: a method moves with the collaborators
 * its narrative calls, and the natural home is regularly the component that
 * cannot afford them. The SOURCE is exempt from the ceiling — a component that
 * already exceeds it must still be able to give methods away, and refusing that
 * would lock exactly the component this feature exists to relieve.
 */
export function methodMoveGate(source: string): SpecWriteHooks {
  // The config read sits HERE, in the builder's own body, so the orchestrator's
  // step 1 (authoring_core_adapter.loadProjectConfig) is a call this file's
  // reader can actually see. Hiding it inside the returned closures — the shape
  // componentCandidateGate uses, which claims no config read — would leave that
  // step claiming a call nothing realizes.
  const bound = candidateOptions();
  return {
    gate: (kind, merged) => {
      if (kind !== 'component') return;
      const { codes, verdict, ceiling } = judgeMoveHome(merged as ComponentSpec, source, bound);
      if (codes.length === 0) return noticesFrom(verdict);
      throw new Error(
        `${codes.join(', ')} refuses "${(merged as ComponentSpec).id}" as the home for these methods. `
        + (verdict.errors.length
          ? formatCandidateRefusal(verdict)
          : `It would reach ${(merged as ComponentSpec).dependsOn?.length ?? 0} dependencies against a ceiling of ${ceiling}.`),
      );
    },
    assess: (kind, merged) => (kind === 'component' ? judgeMoveHome(merged as ComponentSpec, source, bound).codes : []),
  };
}

/**
 * The rule codes that refuse one component as a home for the moved methods,
 * with the verdict they came from — the one judgement both halves of the hook
 * answer with, so `gate` and `assess` can never disagree about the same spec.
 */
function judgeMoveHome(
  component: ComponentSpec,
  source: string,
  options: { rules?: RulesConfig; projectType?: string },
): { codes: string[]; verdict: CandidateVerdict; ceiling?: number } {
  const ceiling = options.rules?.complexity?.maxComponentDependencies;
  const verdict = validateComponentCandidate(component, options);
  const codes = verdict.errors.map((e) => e.code);
  if (component.id !== source && ceiling !== undefined && (component.dependsOn?.length ?? 0) > ceiling) {
    codes.push('EXCESSIVE_DEPENDENCIES');
  }
  return { codes: [...new Set(codes)], verdict, ceiling };
}

/**
 * Move methods from one component to another as ONE gated write.
 *
 * The judgement is the point. A rename changes identity and can stay
 * mechanical; a move changes which component owns behaviour, which is exactly
 * what the stereotype and dependency rules judge. On a refusal nothing is
 * written and the report names the rule plus where the methods could live
 * instead — because a refusal that only names the rule leaves the caller to
 * search for a legal home by hand, which is the hand labour this replaces.
 */
export function moveMethods(
  from: string,
  to: string,
  methods: string[],
  dryRun?: boolean,
): MethodMoveReport {
  return coreMoveMethods(from, to, methods, methodMoveGate(from), dryRun);
}
