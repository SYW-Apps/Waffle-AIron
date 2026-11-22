import { SddRule } from '../types.js';
import { implementedEntry } from './implements-contracts.js';

/**
 * What an implementing contract promises beyond its shape. A local entry names
 * an abstract component; each implemented method's effect, and the
 * implementer's dependencyClass, are no wider than the abstraction's or
 * extension point's, since callers rely on the narrower promise.
 */
export const implementsCompatibilityRule: SddRule = {
  name: 'implements-compatibility',
  judges: 'design',
  description:
    "What an implementing contract promises beyond its shape. A local implements entry names an abstract component (IMPLEMENTS_NOT_ABSTRACT otherwise). Each implemented method's effect, and the implementer's dependencyClass, are no wider than the abstraction's or extension point's (IMPLEMENTS_EFFECT_WIDER), since callers rely on the narrower promise: none, read, lifecycle, write in that order, io matching only io or none, and pure, read, workflow for the class; an effect is judged only where both sides state one, for a cross-project extension point as for a local abstraction.",
  codes: [
    { code: 'IMPLEMENTS_NOT_ABSTRACT', defaultSeverity: 'error', summary: 'A local implements entry names a component that is not abstract, or none at all' },
    { code: 'IMPLEMENTS_EFFECT_WIDER', defaultSeverity: 'error', summary: "An implemented method's effect, or the implementer's dependencyClass, is wider than the abstraction's or extension point's" },
  ],
  check(ctx) {
    // Step 1: each in-scope contract that implements something.
    for (const intf of ctx.interfaces) {
      if (intf.implements === undefined || !ctx.isSpecInScope(intf.id)) continue;
      const implementer = ctx.componentMap.get(intf.component);
      const draft = intf.status === 'draft' || intf.status === 'design';
      // Step 2: each entry the contract implements.
      for (const entry of intf.implements) {
        // Steps 3-5: a local entry that is no abstraction.
        if (!entry.includes('::') && ctx.componentMap.get(entry)?.abstract !== true) {
          const named = ctx.componentMap.has(entry) ? `names "${entry}", a component that is not abstract` : `names "${entry}", which is no component of this tree`;
          ctx.addIssue(
            'error',
            'IMPLEMENTS_NOT_ABSTRACT',
            `Interface "${intf.id}" implements ${named}. An implements entry names an abstraction: mark that component abstract, or implement one that is.`,
            intf.id,
            draft,
          );
          continue;
        }
        // Step 6: an `alias::name` entry that does not resolve with role implement is project-boundaries' finding.
        const point = implementedEntry(ctx, intf.id, entry);
        if (!point) continue;
        // Steps 7-10: each method the contract declares of the entry.
        for (const expected of point.methods) {
          const own = intf.methods.find((m) => m.name === expected.name);
          if (!own || own.effect === undefined || expected.effect === undefined) continue;
          if (!effectWider(own.effect, expected.effect)) continue;
          ctx.addIssue(
            'error',
            'IMPLEMENTS_EFFECT_WIDER',
            `Method "${own.name}" of interface "${intf.id}" has effect "${own.effect}", wider than the effect "${expected.effect}" that "${entry}" promises. A caller may rely on the abstraction's effect, so an implementer does no more than it states.`,
            intf.id,
            draft,
            undefined,
            { at: own.name },
          );
        }
        // Steps 11-12: the implementer's dependency class, judged where the abstraction states one.
        const promised = point.abstraction?.dependencyClass;
        if (implementer && promised !== undefined && classRank(implementer.dependencyClass) > classRank(promised)) {
          ctx.addIssue(
            'error',
            'IMPLEMENTS_EFFECT_WIDER',
            `Component "${implementer.id}" depends on more than "${entry}" promises: its dependencyClass is ${implementer.dependencyClass ?? 'unset (a workflow)'}, wider than ${promised}. Logic that callers rely on as ${promised} stays so in every implementer.`,
            implementer.id,
            ctx.isComponentDraft(implementer.id),
          );
        }
      }
    }
  },
};

/** The order of effects, narrowest first; io stands apart. */
const EFFECT_RANK: Record<string, number> = { none: 0, read: 1, lifecycle: 2, write: 3 };

/** Whether an implementer's effect is wider than the abstraction's: none ⊂ read ⊂ lifecycle ⊂ write, io matching only io or none. */
function effectWider(implemented: string, promised: string): boolean {
  if (implemented === 'none' || implemented === promised) return false;
  if (implemented === 'io' || promised === 'io') return true;
  return (EFFECT_RANK[implemented] ?? 0) > (EFFECT_RANK[promised] ?? 0);
}

/** The order of dependency classes, narrowest first: pure, read, then unset (a workflow). */
function classRank(dependencyClass: string | undefined): number {
  return dependencyClass === 'pure' ? 0 : dependencyClass === 'read' ? 1 : 2;
}
