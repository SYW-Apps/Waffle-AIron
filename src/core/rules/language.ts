import { SddRule } from './types.js';
import { LANGUAGE_MARKERS, normalizeLanguage, methodTypeRefs } from './type-analysis.js';

/**
 * Flow constructs that do not exist in a given target language. Conservative
 * by design (same philosophy as LANGUAGE_MARKERS): only unambiguous
 * per-language gaps are listed — the narrative stays semantic, so a construct
 * is flagged only when the language genuinely has no direct equivalent and
 * the implementer would be forced to emulate or re-model it.
 */
const UNSUPPORTED_FLOW: Record<string, Record<string, string>> = {
  rust: {
    try: 'Rust models errors as values (Result + ?) — specify the guarded logic as explicit error branches, or note the Result mapping in the step description',
    throw: 'Rust has no exceptions — model the failure as a return step whose outcome names the Err variant',
    doWhile: 'Rust has no do-while — prefer loopKind: while, or state the emulation (loop + break) in the description',
  },
  go: {
    try: 'Go models errors as return values — specify explicit error-check branches instead of a try region (panic is not control flow)',
    throw: 'Go has no exceptions — model the failure as a return step with an error outcome',
    doWhile: 'Go has no do-while — prefer loopKind: while (the `for cond` form), or state the emulation',
  },
  c: {
    try: 'C has no exceptions — specify explicit error-code checks instead of a try region',
    throw: 'C has no exceptions — model the failure as a return step with an error-code outcome',
  },
  python: {
    doWhile: 'Python has no do-while — prefer loopKind: while, or state the emulation (while True + break)',
  },
};

/**
 * Language-aware contract hygiene: when a system/subsystem declares a
 * targetLanguage, builtins that unambiguously belong to a DIFFERENT language
 * family are flagged in interface signatures — e.g. `usize`/`Vec` in a
 * TypeScript system, or `Promise`/`any` in a Rust one. Conservative by design:
 * only unambiguous per-language markers trigger, shared vocabulary never does.
 * The same opt-in gates narrative flow steps: constructs the language lacks
 * (try/throw in Rust or Go, do-while in Python) are flagged so the narrative
 * describes flows an implementer can write idiomatically.
 */
export const languageRule: SddRule = {
  name: 'target-language',
  description:
    'Contracts must speak the declared target language: builtin types that unambiguously belong to another language family are flagged in method signatures, and narrative flow steps using constructs the language lacks (e.g. exceptions in Rust/Go, do-while in Python) are flagged too. Set targetLanguage on the system (L0) or override per subsystem (L1).',
  codes: [
    { code: 'LANGUAGE_FOREIGN_BUILTIN', defaultSeverity: 'warning', summary: 'Signature uses a builtin from a different language family' },
    { code: 'LANGUAGE_FOREIGN_FLOW', defaultSeverity: 'warning', summary: 'Narrative flow step uses a construct the target language does not have' },
  ],
  check(ctx) {
    for (const intf of ctx.interfaces) {
      const comp = ctx.componentMap.get(intf.component);
      const lang = ctx.targetLanguageFor(comp?.subsystem);
      if (!lang) continue;
      const normalized = normalizeLanguage(lang);
      const ownMarkers = LANGUAGE_MARKERS[normalized];
      // Unknown language: nothing reliable to check against.
      if (!ownMarkers && !(normalized in LANGUAGE_MARKERS)) {
        // Still check foreign markers only if we at least know the language? No —
        // an unknown language could legitimately share any vocabulary. Skip.
        continue;
      }

      const isDraftCtx = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
      for (const m of intf.methods) {
        const refs = methodTypeRefs(m);
        for (const ref of refs) {
          const refLower = ref.toLowerCase();
          if (ownMarkers?.has(refLower)) continue;
          for (const [family, markers] of Object.entries(LANGUAGE_MARKERS)) {
            if (family === normalized) continue;
            if (markers.has(refLower)) {
              ctx.addIssue(
                'warning',
                'LANGUAGE_FOREIGN_BUILTIN',
                `Method "${m.name}" on interface "${intf.id}" uses "${ref}", a ${family} builtin, but the target language here is ${normalized}. Use the ${normalized} equivalent so implementers generate idiomatic code.`,
                intf.id,
                isDraftCtx,
              );
              break;
            }
          }
        }
      }
    }

    // Narrative flow steps against the language's actual control constructs.
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const comp = ctx.componentMap.get(contract.component);
      const lang = ctx.targetLanguageFor(comp?.subsystem);
      if (!lang) continue;
      const gaps = UNSUPPORTED_FLOW[normalizeLanguage(lang)];
      if (!gaps) continue;

      const isDraftCtx = impl.status === 'draft' || impl.status === 'design'
        || contract.status === 'draft' || contract.status === 'design'
        || ctx.isComponentDraft(contract.component);

      for (const implMethod of impl.methods) {
        for (const step of implMethod.narrative) {
          const construct = step.type === 'loop'
            ? ((step.loopKind ?? (step.over ? 'forEach' : 'while')) === 'doWhile' ? 'doWhile' : null)
            : (step.type === 'try' || step.type === 'throw') ? step.type : null;
          if (!construct || !gaps[construct]) continue;
          ctx.addIssue(
            'warning',
            'LANGUAGE_FOREIGN_FLOW',
            `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" uses ${construct === 'doWhile' ? 'a do-while loop' : `a ${construct} step`}, but the target language is ${normalizeLanguage(lang)}: ${gaps[construct]}.`,
            impl.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
