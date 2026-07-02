import {
  ComponentSpec,
  ImplementationSpec,
  MethodImplementation,
  NarrativeDetail,
} from '../../models/index.js';
import { SddRule } from './types.js';

// ---------------------------------------------------------------------------
// The narrative detail dial. Levels are FLOORS, not ceilings — extra detail is
// never penalized. Resolution: method.detail → spec.detail → stereotype
// default. Stereotype defaults exist so the common case needs zero extra
// fields: Portals/Adapters are boundary pass-throughs (real logic belongs in
// the Orchestrator they forward to), and a Store's semantics are a contract
// paragraph, not choreography.
// ---------------------------------------------------------------------------

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
    'The narrative detail dial: each method resolves to full | calls-only | intent (method override → spec default → stereotype default). full requires a narrative; intent-level methods without a narrative must specify behavior as non-trivial prose (L4 intent or L3 description) — dialing detail down never means leaving behavior unspecified. Explicit declarations are held to their promise as errors; stereotype-defaulted gaps surface as warnings.',
  codes: [
    { code: 'MISSING_NARRATIVE', defaultSeverity: 'warning', summary: 'Method resolved to detail: full but has no narrative (error when the level was declared explicitly)' },
    { code: 'INTENT_FLOOR', defaultSeverity: 'warning', summary: 'Intent-level method whose intent/description prose is missing or placeholder-thin (error when declared explicitly)' },
  ],
  check(ctx) {
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
