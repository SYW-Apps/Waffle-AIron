import { SddRule } from './types.js';
import { LANGUAGE_MARKERS, normalizeLanguage, extractTypesFromSignature } from './type-analysis.js';

/**
 * Language-aware contract hygiene: when a system/subsystem declares a
 * targetLanguage, builtins that unambiguously belong to a DIFFERENT language
 * family are flagged in interface signatures — e.g. `usize`/`Vec` in a
 * TypeScript system, or `Promise`/`any` in a Rust one. Conservative by design:
 * only unambiguous per-language markers trigger, shared vocabulary never does.
 */
export const languageRule: SddRule = {
  name: 'target-language',
  description:
    'Contracts must speak the declared target language: builtin types that unambiguously belong to another language family are flagged in method signatures. Set targetLanguage on the system (L0) or override per subsystem (L1).',
  codes: [
    { code: 'LANGUAGE_FOREIGN_BUILTIN', defaultSeverity: 'warning', summary: 'Signature uses a builtin from a different language family' },
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
        const refs = extractTypesFromSignature(m.signature, m.returns);
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
  },
};
