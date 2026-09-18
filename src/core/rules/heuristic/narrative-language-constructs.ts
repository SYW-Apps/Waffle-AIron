import { SddRule } from '../types.js';
import type { ImplementationSpec, MethodImplementation, NarrativeStep } from '../../../models/index.js';

/**
 * Flow constructs that do not exist in a given target language. Conservative
 * by design (same philosophy as the signature marker tables): only unambiguous
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

/** One narrative step of one implementation, with the construct gaps judging it. */
interface StepScan {
  implementation: ImplementationSpec;
  method: MethodImplementation;
  step: NarrativeStep;
  lang: string;
  gaps: Record<string, string>;
  draft: boolean;
}

/**
 * The full construct keyspace of a step: branch | switch | forEach | for |
 * while | doWhile | try | throw | jump | parallel | detach (local/call/return
 * are universal and never gated; detach is a call-step flag gated as its own
 * construct).
 */
function constructsOf(step: NarrativeStep): string[] {
  const constructs: string[] = [
    step.type === 'loop'
      ? (step.loopKind ?? (step.over ? 'forEach' : 'while'))
      : step.type,
  ];
  if (step.detach) constructs.push('detach');
  return constructs;
}

/** How a construct reads in the finding message. */
function constructLabel(construct: string): string {
  if (construct === 'doWhile') return 'a do-while loop';
  if (construct === 'forEach' || construct === 'for' || construct === 'while') return `a ${construct} loop`;
  if (construct === 'detach') return 'a detached (fire-and-forget) call';
  return `a ${construct} step`;
}

/**
 * Language-aware narrative hygiene: when a system/subsystem declares a
 * targetLanguage, narrative flow steps using constructs the language lacks
 * (try/throw in Rust or Go, do-while in Python) are flagged, so the narrative
 * describes flows an implementer can write idiomatically. What a CONTRACT may
 * name in that language is signature-language-builtins' question.
 */
export const narrativeLanguageConstructsRule: SddRule = {
  name: 'narrative-language-constructs',
  description:
    'Narratives must describe flows the declared target language can express: steps using constructs the language lacks (e.g. exceptions in Rust/Go, do-while in Python) are flagged with the idiomatic alternative. Set targetLanguage on the system (L0) or override per subsystem (L1).',
  codes: [
    { code: 'LANGUAGE_FOREIGN_FLOW', defaultSeverity: 'warning', summary: 'Narrative flow step uses a construct the target language does not have' },
  ],
  check(ctx) {
    // Effective per-language gaps: built-ins merged with extension-pack
    // languages (packs may add whole platforms, or extend a built-in
    // language's table).
    const gapsFor = (lang: string): Record<string, string> => ({
      ...(UNSUPPORTED_FLOW[lang] ?? {}),
      ...(ctx.ext.languages[lang]?.unsupportedFlow ?? {}),
    });

    // Every narrative step a declared target language can actually judge — an
    // implementation with a dangling contract, no target language, or a
    // language that documents no flow gap has nothing to check against.
    const scans: StepScan[] = [];
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const comp = ctx.componentMap.get(contract.component);
      const lang = ctx.targetLanguageFor(comp?.subsystem);
      if (!lang) continue;
      const gaps = gapsFor(lang);
      if (Object.keys(gaps).length === 0) continue;
      const draft = ctx.isImplementationDraft(impl);
      for (const method of impl.methods) {
        for (const step of method.narrative) scans.push({ implementation: impl, method, step, lang, gaps, draft });
      }
    }

    for (const scan of scans) {
      for (const construct of constructsOf(scan.step)) {
        const guidance = scan.gaps[construct];
        if (!guidance) continue;
        ctx.addIssue(
          'warning',
          'LANGUAGE_FOREIGN_FLOW',
          `Step ${scan.step.stepNumber} of "${scan.method.name}" in implementation "${scan.implementation.id}" uses ${constructLabel(construct)}, but the target language is ${scan.lang}: ${guidance}.`,
          scan.implementation.id,
          scan.draft,
        );
      }
    }
  },
};
