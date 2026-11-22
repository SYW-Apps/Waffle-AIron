import type { MethodSignature } from '../../../models/index.js';
import { SddRule } from '../types.js';
import { implementedEntry } from './implements-contracts.js';

/**
 * What a contract's several implements entries and its omissions ask of it
 * together: two entries asking one method name to be two things cannot both
 * be served, and `omits` stands only on a Portal implementing a Portal
 * abstraction.
 */
export const implementsConsistencyRule: SddRule = {
  name: 'implements-consistency',
  judges: 'design',
  description:
    "What a contract's several implements entries and its omissions ask of it together. Two entries asking one method name to differ in params, returns or effect cannot both be served (IMPLEMENTS_CONFLICT). `omits` stands only on a Portal implementing a Portal abstraction, and names only methods that abstraction declares (OMISSION_NOT_ALLOWED).",
  codes: [
    { code: 'IMPLEMENTS_CONFLICT', defaultSeverity: 'error', summary: 'Two abstractions or extension points one contract implements declare a method of the same name with different params, returns or effect: one method cannot serve both' },
    { code: 'OMISSION_NOT_ALLOWED', defaultSeverity: 'error', summary: 'omits on a contract that is not a Portal implementing a Portal abstraction, or naming a method the abstraction does not declare' },
  ],
  check(ctx) {
    // Step 1: each in-scope contract that implements something or states omissions.
    for (const intf of ctx.interfaces) {
      if ((intf.implements === undefined && intf.omits === undefined) || !ctx.isSpecInScope(intf.id)) continue;
      const implementer = ctx.componentMap.get(intf.component);
      const draft = intf.status === 'draft' || intf.status === 'design';
      const entries = (intf.implements ?? []).map((entry) => ({ entry, point: implementedEntry(ctx, intf.id, entry) }));
      // Steps 2-3: two entries asking one method name to be two things.
      const asked = new Map<string, { entry: string; method: Pick<MethodSignature, 'name' | 'params' | 'returns'> & { effect?: string } }>();
      const conflicted = new Set<string>();
      for (const { entry, point } of entries) {
        if (!point) continue;
        for (const method of point.methods) {
          const earlier = asked.get(method.name);
          if (!earlier) {
            asked.set(method.name, { entry, method });
            continue;
          }
          const differs = differences(earlier.method, method);
          if (differs === undefined || conflicted.has(method.name)) continue;
          conflicted.add(method.name);
          ctx.addIssue(
            'error',
            'IMPLEMENTS_CONFLICT',
            `Interface "${intf.id}" implements both "${earlier.entry}" and "${entry}", which declare "${method.name}" differently (${differs}). One method cannot serve both: split the contract, or align the abstractions.`,
            intf.id,
            draft,
            undefined,
            { at: method.name },
          );
        }
      }
      // Steps 4-5: omissions stand only on a Portal implementing a Portal abstraction.
      if (intf.omits === undefined) continue;
      const portalAbstractions = entries
        .filter(({ point }) => point?.abstraction?.componentType === 'Portal')
        .map(({ point }) => point!);
      for (const omission of intf.omits) {
        let why: string | undefined;
        if (implementer?.componentType !== 'Portal' || portalAbstractions.length === 0) {
          why = 'omits stands only on a Portal that implements a Portal abstraction';
        } else if (!portalAbstractions.some((p) => p.methods.some((m) => m.name === omission.method))) {
          why = 'no Portal abstraction it implements declares that method';
        }
        if (why === undefined) continue;
        ctx.addIssue(
          'error',
          'OMISSION_NOT_ALLOWED',
          `Interface "${intf.id}" omits "${omission.method}" (${omission.reason}), but ${why}. omits states the verbs one transport deliberately does not serve of an abstract Portal it implements, each with its reason.`,
          intf.id,
          draft,
          undefined,
          { at: omission.method },
        );
      }
    }
  },
};

/** How two declarations of one method name differ in params, returns or effect (effect only where both state one); undefined when they agree. */
function differences(
  a: Pick<MethodSignature, 'params' | 'returns'> & { effect?: string },
  b: Pick<MethodSignature, 'params' | 'returns'> & { effect?: string },
): string | undefined {
  const shape = (m: Pick<MethodSignature, 'params'>): string => (m.params ?? []).map((p) => `${lastName(p.type)}${p.optional ? '?' : ''}`).join(', ');
  const parts: string[] = [];
  if (shape(a) !== shape(b)) parts.push('params');
  if (lastName(a.returns) !== lastName(b.returns)) parts.push('returns');
  if (a.effect !== undefined && b.effect !== undefined && a.effect !== b.effect) parts.push('effect');
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** A type text with its qualifiers dropped, so a local and a producer-side spelling of one type agree. */
function lastName(text: string): string {
  return text.replace(/[A-Za-z_][A-Za-z0-9_-]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_-]*)+/g, (n) => n.split('::').pop()!.split('.').pop()!);
}
