import {
  ComponentSpec,
  ImplementationSpec,
  MethodImplementation,
  NarrativeDetail,
} from '../../models/index.js';
import { normalizeSourcePath, type SourceFileFacts } from '../source-analysis.js';
import { isInChainedSubproject, stereotypeDefaultTier } from './conformance.js';
import { getEffectiveComplexityConfig } from './complexity.js';
import { SddRule } from './types.js';

// ---------------------------------------------------------------------------
// The narrative detail dial. Levels are FLOORS, not ceilings — extra detail is
// never penalized. Resolution: method.detail → spec.detail → stereotype
// default. Stereotype defaults exist so the common case needs zero extra
// fields: Portals/Adapters are boundary pass-throughs (real logic belongs in
// the Orchestrator they forward to), and a Store's semantics are a contract
// paragraph, not choreography.
// ---------------------------------------------------------------------------

/**
 * The unambiguous LOGIC blocks — where behavior genuinely lives. Deliberately
 * narrower than "everything defaulting to detail: full": pattern facades
 * (Repository, Gateway) and presenter/pattern components inherit the full
 * floor but forward to members, so an explicit dial-down there is a normal
 * choice, not a smell worth DETAIL_BELOW_STEREOTYPE.
 */
const LOGIC_STEREOTYPES = new Set(['Orchestrator', 'Supervisor', 'Actor', 'Specialist']);

export function stereotypeDetailDefault(componentType: string | undefined): NarrativeDetail {
  if (componentType === 'Portal' || componentType === 'Observer' || componentType === 'Adapter') {
    return 'calls-only';
  }
  if (componentType === 'Store' || componentType === 'Index' || componentType === 'Registry') {
    return 'intent';
  }
  return 'full';
}

export interface ResolvedDetail {
  level: NarrativeDetail;
  /** True when declared on the method or spec (as opposed to a stereotype default). */
  explicit: boolean;
}

export function effectiveNarrativeDetail(
  method: MethodImplementation,
  impl: ImplementationSpec,
  component: ComponentSpec | undefined,
): ResolvedDetail {
  if (method.detail) return { level: method.detail, explicit: true };
  if (impl.detail) return { level: impl.detail, explicit: true };
  return { level: stereotypeDetailDefault(component?.componentType), explicit: false };
}

// The detail-sufficiency floor: above this cyclomatic complexity a realized
// function has enough real branching that leaving its method below detail:
// full (with no narrative) hides logic from every deeper conformance check.
// Overridable via rules.complexity.maxUnnarratedComplexity.
export const DEFAULT_MAX_UNNARRATED_COMPLEXITY = 8;

// The intent floor: prose short enough to be a placeholder cannot specify
// behavior an implementer could be held to.
const INTENT_FLOOR_MIN_CHARS = 40;

export function passesIntentFloor(text: string | undefined, methodName: string): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length < INTENT_FLOOR_MIN_CHARS) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (norm(t) === norm(methodName)) return false;
  return true;
}

/**
 * Enforces that every method carries the detail its declared (or defaulted)
 * level promises: `full` requires a narrative; `intent` (and `calls-only`
 * without any calls to choreograph) requires prose passing the intent floor —
 * the method's L4 `intent`, or failing that its L3 contract description.
 */
export const narrativeDetailRule: SddRule = {
  name: 'narrative-detail',
  description:
    'The narrative detail dial: each method resolves to full | calls-only | intent (method override → spec default → stereotype default). full requires a narrative; intent-level methods without a narrative must specify behavior as non-trivial prose (L4 intent or L3 description) — dialing detail down never means leaving behavior unspecified. Explicit declarations are held to their promise as errors; stereotype-defaulted gaps surface as warnings. Detail sufficiency rides along: a method whose realized function measures real branching (cyclomatic complexity above rules.complexity.maxUnnarratedComplexity, exact AST grade only) may not hide below detail: full without a narrative (UNNARRATED_COMPLEXITY), and an explicit dial below a full-floor logic stereotype without a narrative is a visible, lint.allow-justifiable choice (DETAIL_BELOW_STEREOTYPE). Both are honest lints over declarations — they never claim the narrative or prose is CORRECT.',
  codes: [
    { code: 'MISSING_NARRATIVE', defaultSeverity: 'warning', summary: 'Method resolved to detail: full but has no narrative (error when the level was declared explicitly)' },
    { code: 'INTENT_FLOOR', defaultSeverity: 'warning', summary: 'Intent-level method whose intent/description prose is missing or placeholder-thin (error when declared explicitly)' },
    { code: 'UNNARRATED_COMPLEXITY', defaultSeverity: 'warning', summary: 'Method below detail: full with no narrative whose realized function has real branching (cyclomatic complexity over the configured threshold, exact-grade analysis only)' },
    { code: 'DETAIL_BELOW_STEREOTYPE', defaultSeverity: 'warning', summary: 'Method explicitly dialed below the full narrative floor of its logic stereotype, with no narrative' },
  ],
  check(ctx) {
    const factsByPath = new Map<string, SourceFileFacts>();
    for (const f of ctx.codeModel.files) factsByPath.set(normalizeSourcePath(f.path), f);

    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const component = ctx.componentMap.get(contract.component);

      const isDraftCtx =
        impl.status === 'draft' || impl.status === 'design'
        || contract.status === 'draft' || contract.status === 'design'
        || ctx.isComponentDraft(contract.component);

      for (const implMethod of impl.methods) {
        const contractMethod = contract.methods.find(m => m.name === implMethod.name);
        if (!contractMethod) continue; // UNEXPECTED_IMPLEMENTATION_METHOD covers this

        const eff = effectiveNarrativeDetail(implMethod, impl, component);
        const hasNarrative = implMethod.narrative.length > 0;
        if (hasNarrative) continue; // floors, not ceilings

        if (eff.level === 'full') {
          ctx.addIssue(
            eff.explicit ? 'error' : 'warning',
            'MISSING_NARRATIVE',
            `Method "${implMethod.name}" in implementation "${impl.id}" resolves to detail: full`
            + (eff.explicit ? ' (declared explicitly)' : ` (stereotype default for ${component?.componentType ?? 'component'})`)
            + ' but has no narrative. Write the narrative, or dial the method down (detail: calls-only / intent).',
            impl.id,
            isDraftCtx,
          );
          continue;
        }

        // Detail sufficiency (code side): the realized function's measured
        // branching may not hide below detail: full. Exact-grade analysis
        // only — a weaker grade skips rather than guesses. `off` conformance
        // means the name↔symbol mapping is untrusted, so skip that too.
        let complexityFired = false;
        const tier = implMethod.conformance ?? impl.conformance
          ?? stereotypeDefaultTier(component?.componentType ?? '');
        if (impl.sourcePath && tier !== 'off'
          && !(component && isInChainedSubproject(component.subsystem, ctx))) {
          const facts = factsByPath.get(normalizeSourcePath(impl.sourcePath));
          const symbol = implMethod.symbol ?? implMethod.name;
          const complexity = facts?.status === 'analyzed' && facts.analysisGrade === 'exact'
            ? facts.functionComplexity?.[symbol]
            : undefined;
          const limit = getEffectiveComplexityConfig(ctx, component?.subsystem)?.maxUnnarratedComplexity
            ?? DEFAULT_MAX_UNNARRATED_COMPLEXITY;
          if (complexity !== undefined && complexity > limit) {
            complexityFired = true;
            ctx.addIssue(
              'warning',
              'UNNARRATED_COMPLEXITY',
              `Method "${implMethod.name}" in implementation "${impl.id}" sits at detail: ${eff.level} with no narrative, but its realized function "${symbol}" in "${impl.sourcePath}" measures cyclomatic complexity ${complexity} (limit ${limit}) — real branching is hiding behind ${eff.level}. Write the narrative, or keep the dial with a lint.allow stating why the branching needs no choreography.`,
              impl.id,
              isDraftCtx,
            );
          }
        }

        // Detail sufficiency (spec side): explicitly dialing a logic
        // stereotype's method below its full floor is a visible design choice.
        // Skipped when the code-backed finding already fired for this method.
        if (!complexityFired && eff.explicit
          && component && LOGIC_STEREOTYPES.has(component.componentType)) {
          ctx.addIssue(
            'warning',
            'DETAIL_BELOW_STEREOTYPE',
            `Method "${implMethod.name}" in implementation "${impl.id}" is explicitly dialed to detail: ${eff.level}, below the full narrative floor of its ${component?.componentType ?? 'logic'} stereotype, and has no narrative. Logic behavior belongs in a narrative — write one, or keep the dial with a lint.allow stating why.`,
            impl.id,
            isDraftCtx,
          );
        }

        // intent — and calls-only with nothing to choreograph — must clear the
        // intent floor: behavior specified as prose an implementer can follow.
        const prose = implMethod.intent ?? contractMethod.description;
        if (!passesIntentFloor(prose, implMethod.name)) {
          ctx.addIssue(
            eff.explicit ? 'error' : 'warning',
            'INTENT_FLOOR',
            `Method "${implMethod.name}" in implementation "${impl.id}" has no narrative (detail: ${eff.level}`
            + (eff.explicit ? ', declared explicitly)' : `, stereotype default for ${component?.componentType ?? 'component'})`)
            + ' and its behavioral prose is missing or placeholder-thin. Provide an "intent" on the L4 method (or a substantive L3 description) stating what it does and how it fails — or write a narrative.',
            impl.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
