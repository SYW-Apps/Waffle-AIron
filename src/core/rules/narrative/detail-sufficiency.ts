import {
  defaultConformanceTier,
  effectiveDetail,
  isLogic,
  methodSourceFile,
  type ComponentSpec,
  type ImplementationSpec,
  type MethodImplementation,
  type ResolvedDetail,
} from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Detail SUFFICIENCY — the other half of the dial. narrative-detail asks
// whether a method keeps the promise its level makes; this asks whether the
// level is low enough to hide behavior that should have been choreographed.
// Two readings of one question, and the CODE one wins: a measured function's
// branching is evidence, where the stereotype is only an expectation, so a
// method already accused of hiding real branching is not accused twice.
// ---------------------------------------------------------------------------

// The detail-sufficiency floor: above this cyclomatic complexity a realized
// function has enough real branching that leaving its method below detail:
// full (with no narrative) hides logic from every deeper conformance check.
// Overridable via rules.complexity.maxUnnarratedComplexity.
export const DEFAULT_MAX_UNNARRATED_COMPLEXITY = 8;

/**
 * One method the dial holds BELOW full with no narrative — the only methods
 * this rule judges. Gathered in one pass so the two readings are a flat walk
 * over the methods at issue rather than a descent repeated inside each.
 */
interface DialedDownMethod {
  implementation: ImplementationSpec;
  method: MethodImplementation;
  /** The component the implementation realizes; absent when the contract names one that does not resolve (a hierarchy finding). */
  component?: ComponentSpec;
  /** The level the dial resolved to, and whether the method or its implementation declared it. */
  detail: ResolvedDetail;
  draftContext: boolean;
}

/**
 * Enforces that the detail a method is dialed DOWN to still covers its
 * behavior: a realized function measuring real branching, and a logic
 * stereotype dialed below its full floor, both owe a narrative.
 */
export const detailSufficiencyRule: SddRule = {
  name: 'detail-sufficiency',
  description:
    'A method dialed below detail: full with no narrative may not be hiding behavior it owes a reader. A method whose realized function — in the method\'s own source file, else the implementation\'s — measures real branching (cyclomatic complexity above rules.complexity.maxUnnarratedComplexity, exact AST grade only) is reported (UNNARRATED_COMPLEXITY), and an explicit dial below a full-floor logic stereotype without a narrative is a visible, lint.allow-justifiable choice (DETAIL_BELOW_STEREOTYPE) — reported only where the measured finding did not already fire, since evidence outranks expectation. Both are honest lints over declarations: they never claim a narrative would be correct, only that the dial hides something.',
  codes: [
    { code: 'UNNARRATED_COMPLEXITY', defaultSeverity: 'warning', summary: 'Method below detail: full with no narrative whose realized function, in the method\'s source file, has real branching (cyclomatic complexity over the configured threshold, exact-grade analysis only)' },
    { code: 'DETAIL_BELOW_STEREOTYPE', defaultSeverity: 'warning', summary: 'Method explicitly dialed below the full narrative floor of its logic stereotype, with no narrative' },
  ],
  check(ctx) {
    const code = ctx.codeIndex();

    // 1. The methods the dial holds below full with nothing written: the
    //    contract must define the method (UNEXPECTED_IMPLEMENTATION_METHOD
    //    covers one it does not), levels are floors so a narrated method
    //    passes, and a full-level method owes a narrative rather than
    //    sufficiency (MISSING_NARRATIVE is narrative-detail's finding).
    const dialedDown: DialedDownMethod[] = [];
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const component = ctx.componentMap.get(contract.component);
      const draftContext = ctx.isImplementationDraft(impl);
      for (const method of impl.methods) {
        const detail = effectiveDetail(method, impl, component);
        if (contract.methods.some(m => m.name === method.name)
          && method.narrative.length === 0
          && detail.level !== 'full') {
          dialedDown.push({ implementation: impl, method, component, detail, draftContext });
        }
      }
    }

    for (const entry of dialedDown) {
      const { implementation: impl, method, component, detail } = entry;

      // 2. The code side: the realized function's measured branching may not
      //    hide below the dial. Exact-grade analysis only — a weaker grade
      //    measures nothing rather than guessing, and `off` conformance means
      //    the name↔symbol mapping is untrusted. A chained subproject's files
      //    are relative to its own root, so it is measured in its own run. The
      //    function is measured in the method's own source file: its
      //    sourcePath, else the implementation's.
      const tier = method.conformance ?? impl.conformance ?? defaultConformanceTier(component);
      const file = methodSourceFile(method, impl.sourcePath);
      const symbol = method.symbol ?? method.name;
      const limit = ctx.complexityConfigFor(component?.subsystem)?.maxUnnarratedComplexity
        ?? DEFAULT_MAX_UNNARRATED_COMPLEXITY;
      let complexity: number | undefined;
      if (file && tier !== 'off'
        && !(component && ctx.isInChainedSubproject(component.subsystem))) {
        const facts = code.factsAt(file);
        // Own-property lookup: a method named e.g. "constructor" must not
        // resolve to Object.prototype members.
        complexity = facts?.status === 'analyzed' && facts.analysisGrade === 'exact'
          && facts.functionComplexity
          && Object.prototype.hasOwnProperty.call(facts.functionComplexity, symbol)
          ? facts.functionComplexity[symbol]
          : undefined;
      }
      if (complexity !== undefined && complexity > limit) {
        ctx.addIssue(
          'warning',
          'UNNARRATED_COMPLEXITY',
          `Method "${method.name}" in implementation "${impl.id}" sits at detail: ${detail.level} with no narrative, but its realized function "${symbol}" in "${file}" measures cyclomatic complexity ${complexity} (limit ${limit}) — real branching is hiding behind ${detail.level}. Write the narrative, or keep the dial with a lint.allow stating why the branching needs no choreography.`,
          impl.id,
          entry.draftContext,
        );
        continue;
      }

      // 3. The spec side: explicitly dialing a logic stereotype's method below
      //    its full floor is a visible design choice. Logic is where behavior
      //    genuinely lives — an Orchestrator, Supervisor or Actor (or a
      //    Specialist until it is migrated). Deliberately narrower than
      //    "everything defaulting to detail: full": pattern facades and
      //    presenter components inherit the full floor but forward to members,
      //    so an explicit dial-down there is a normal choice.
      if (detail.explicit && component && isLogic(component)) {
        ctx.addIssue(
          'warning',
          'DETAIL_BELOW_STEREOTYPE',
          `Method "${method.name}" in implementation "${impl.id}" is explicitly dialed to detail: ${detail.level}, below the full narrative floor of its ${component.componentType} stereotype, and has no narrative. Logic behavior belongs in a narrative — write one, or keep the dial with a lint.allow stating why.`,
          impl.id,
          entry.draftContext,
        );
      }
    }
  },
};
