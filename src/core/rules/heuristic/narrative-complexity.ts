import { cognitiveScore, complexityLevel } from '../../../models/index.js';
import type { ComponentSpec, ImplementationSpec, MethodImplementation } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// A narrative is judged on TWO independent axes, because they measure
// different costs. The cognitive band comes from shape — branching, nesting,
// jumps — and says how hard the flow is to hold in your head. The step count
// comes from length and says how much the method does. A flat list of forty
// registrations is long but linear; a three-level guard is short but severe.
// Neither subsumes the other, so each warns on its own dial and errors only
// where a maximum is deliberately configured.
// ---------------------------------------------------------------------------

/** The cognitive bands, weakest first — a band is "above" another when it sits later in this list. */
const BANDS = ['linear', 'simple', 'moderate', 'complex', 'severe'] as const;

/** Position of a band in BANDS; an unknown (mis-configured) band sorts before every real one. */
function bandIndex(band: string | undefined): number {
  return BANDS.indexOf((band ?? '') as (typeof BANDS)[number]);
}

/** The default band a narrative may reach before it warns: complex and severe warn, moderate does not. */
const DEFAULT_WARN_ABOVE = 'moderate';

/**
 * The default step ceiling. Unlike the other complexity caps this one has a
 * default on purpose: a narrative past 25 steps is a method doing too much
 * whether or not the project has configured a dial.
 */
const DEFAULT_MAX_STEPS = 25;

interface NarrativeEntry {
  implementation: ImplementationSpec;
  method: MethodImplementation;
  component: ComponentSpec;
  subsystem: string;
}

export const narrativeComplexityRule: SddRule = {
  name: 'narrative-complexity',
  description:
    'Judges a narrative on two independent axes: the cognitive band its shape earns, from branching and nesting, and the number of steps it lists. A flat list of registrations is long but linear; a deeply nested guard is short but severe. Each axis warns above its configured level, and reports an error only where a maximum is configured.',
  codes: [
    { code: 'NARRATIVE_COMPLEXITY', defaultSeverity: 'warning', summary: 'Narrative\'s cognitive band is above the configured level (default: above moderate)' },
    { code: 'NARRATIVE_COMPLEXITY_OVER_MAX', defaultSeverity: 'error', summary: 'Narrative\'s cognitive band is above the configured maximum band' },
    { code: 'EXCESSIVE_NARRATIVE_STEPS', defaultSeverity: 'warning', summary: 'Method implementation contains more narrative steps than the configured limit (default 25)' },
    { code: 'NARRATIVE_STEPS_OVER_MAX', defaultSeverity: 'error', summary: 'Narrative step count is above the configured hard maximum' },
  ],
  check(ctx) {
    // 1. Every authored narrative, carried together with the component it
    //    realizes — the component decides both the config in force and the
    //    draft context. An implementation whose contract or component does not
    //    resolve is another rule's finding, never judged here.
    const entries: NarrativeEntry[] = [];
    for (const impl of ctx.implementations) {
      const intf = ctx.interfaceMap.get(impl.contract);
      const comp = intf ? ctx.componentMap.get(intf.component) : undefined;
      if (!comp) continue;
      for (const method of impl.methods) {
        if ((method.narrative ?? []).length === 0) continue;
        entries.push({ implementation: impl, method, component: comp, subsystem: comp.subsystem });
      }
    }

    // 2. Judge each narrative on both axes.
    for (const entry of entries) {
      const cfg = ctx.complexityConfigFor(entry.subsystem);
      const isDraft = ctx.isComponentDraft(entry.component.id);
      const steps = entry.method.narrative.length;
      const score = cognitiveScore(entry.method);
      const band = complexityLevel(entry.method);

      // 2a. The cognitive axis: shape, not length.
      const warnAbove = cfg?.cognitiveWarnAbove ?? DEFAULT_WARN_ABOVE;
      if (bandIndex(band) > bandIndex(warnAbove)) {
        ctx.addIssue(
          'warning',
          'NARRATIVE_COMPLEXITY',
          `Method "${entry.method.name}" in implementation "${entry.implementation.id}" has a ${band} narrative (cognitive score ${score}), above the configured "${warnAbove}" band. Split it into steps that call smaller methods.`,
          entry.implementation.id,
          isDraft,
        );
      }

      // 2b. …and an error only where a maximum band is configured.
      if (cfg?.maxCognitiveLevel !== undefined && bandIndex(band) > bandIndex(cfg.maxCognitiveLevel)) {
        ctx.addIssue(
          'error',
          'NARRATIVE_COMPLEXITY_OVER_MAX',
          `Method "${entry.method.name}" in implementation "${entry.implementation.id}" has a ${band} narrative (cognitive score ${score}), above the configured maximum band "${cfg.maxCognitiveLevel}". Split it into steps that call smaller methods.`,
          entry.implementation.id,
          isDraft,
        );
      }

      // 2c. The step axis: length, not shape. This one carries a default.
      const maxSteps = cfg?.maxNarrativeSteps ?? DEFAULT_MAX_STEPS;
      if (steps > maxSteps) {
        ctx.addIssue(
          'warning',
          'EXCESSIVE_NARRATIVE_STEPS',
          `Method "${entry.method.name}" in implementation "${entry.implementation.id}" contains ${steps} narrative steps, exceeding the configured limit of ${maxSteps}.`,
          entry.implementation.id,
          isDraft,
        );
      }

      // 2d. …and an error only where a hard maximum is configured.
      if (cfg?.narrativeStepsHardMax !== undefined && steps > cfg.narrativeStepsHardMax) {
        ctx.addIssue(
          'error',
          'NARRATIVE_STEPS_OVER_MAX',
          `Method "${entry.method.name}" in implementation "${entry.implementation.id}" lists ${steps} narrative steps, above the configured hard maximum of ${cfg.narrativeStepsHardMax}. Extract part of the flow into a method of its own.`,
          entry.implementation.id,
          isDraft,
        );
      }
    }
  },
};
