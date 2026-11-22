import type { MethodSignature } from '../../../models/index.js';
import { SddRule } from '../types.js';
import { entryTypeText, implementedEntry, type ExtensionPoint } from './implements-contracts.js';

/**
 * What a contract's several implements entries and its omissions ask of it
 * together: two entries asking one method name to be two things cannot both
 * be served, and `omits` stands only on a concrete Portal implementing a Portal
 * abstraction, directly or through a chain of abstractions.
 */
export const implementsConsistencyRule: SddRule = {
  name: 'implements-consistency',
  judges: 'design',
  description:
    "What a contract's several implements entries and its omissions ask of it together. Two entries asking one method name to differ in params, returns or effect cannot both be served (IMPLEMENTS_CONFLICT); the params and returns are compared semantically exactly as implements-contracts compares them, every type expression in canonical form and the producer's own name and the consumer's alias::name one type, never by a name's last segment. `omits` stands only on a concrete Portal implementing a Portal abstraction, directly or through a chain of abstractions (an abstract Portal never omits: its own contract is complete), and names only verbs of a Portal abstraction it implements transitively, read through ctx.abstractionsOf (OMISSION_NOT_ALLOWED).",
  codes: [
    { code: 'IMPLEMENTS_CONFLICT', defaultSeverity: 'error', summary: "Two abstractions or extension points one contract implements declare a method of the same name with different params, returns (compared semantically, never by a name's last segment) or effect: one method cannot serve both" },
    { code: 'OMISSION_NOT_ALLOWED', defaultSeverity: 'error', summary: 'omits on a contract that is not a concrete Portal implementing a Portal abstraction, or naming a method no Portal abstraction it implements, directly or through the chain, declares' },
  ],
  check(ctx) {
    // Step 1: each in-scope contract that implements something or states omissions.
    for (const intf of ctx.interfaces) {
      if ((intf.implements === undefined && intf.omits === undefined) || !ctx.isSpecInScope(intf.id)) continue;
      const implementer = ctx.componentMap.get(intf.component);
      const draft = intf.status === 'draft' || intf.status === 'design';
      const entries = (intf.implements ?? []).map((entry) => ({ entry, point: implementedEntry(ctx, intf.id, entry) }));
      // Steps 2-3: two entries asking one method name to be two things.
      type Asked = { entry: string; point: ExtensionPoint; method: Pick<MethodSignature, 'name' | 'params' | 'returns'> & { effect?: string } };
      const asked = new Map<string, Asked>();
      const conflicted = new Set<string>();
      for (const { entry, point } of entries) {
        if (!point) continue;
        for (const method of point.methods) {
          const earlier = asked.get(method.name);
          if (!earlier) {
            asked.set(method.name, { entry, point, method });
            continue;
          }
          const differs = differences(earlier, { point, method });
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
      // The Portal abstractions the implementer realizes, directly or through the chain.
      const portalAbstractions = (implementer ? ctx.abstractionsOf(implementer.id) : [])
        .filter((id) => ctx.componentMap.get(id)?.componentType === 'Portal' && ctx.componentMap.get(id)?.abstract === true);
      for (const omission of intf.omits) {
        let why: string | undefined;
        if (implementer?.componentType === 'Portal' && implementer.abstract === true) {
          why = 'an abstract Portal never omits a verb: its own contract is complete';
        } else if (implementer?.componentType !== 'Portal' || portalAbstractions.length === 0) {
          why = 'omits stands only on a concrete Portal that implements a Portal abstraction';
        } else if (!portalAbstractions.some((id) => ctx.interfaceMethodsOf(id).some((m) => m.name === omission.method))) {
          why = 'no Portal abstraction it implements declares that method';
        }
        if (why === undefined) continue;
        ctx.addIssue(
          'error',
          'OMISSION_NOT_ALLOWED',
          `Interface "${intf.id}" omits "${omission.method}" (${omission.reason}), but ${why}. omits states the verbs one concrete transport deliberately does not serve of a Portal abstraction it implements, directly or through the chain, each with its reason.`,
          intf.id,
          draft,
          undefined,
          { at: omission.method },
        );
      }
    }
  },
};

/** How two entries' declarations of one method name differ in params, returns or effect (effect only where both state one); undefined when they agree. Types compare as implements-contracts compares them. */
function differences(
  a: { point: ExtensionPoint; method: Pick<MethodSignature, 'params' | 'returns'> & { effect?: string } },
  b: { point: ExtensionPoint; method: Pick<MethodSignature, 'params' | 'returns'> & { effect?: string } },
): string | undefined {
  const typeOf = { a: entryTypeText(a.point), b: entryTypeText(b.point) };
  const shape = (m: Pick<MethodSignature, 'params'>, as: (t: string) => string): string => (m.params ?? []).map((p) => `${as(p.type)}${p.optional ? '?' : ''}`).join(', ');
  const parts: string[] = [];
  if (shape(a.method, typeOf.a) !== shape(b.method, typeOf.b)) parts.push('params');
  if (typeOf.a(a.method.returns) !== typeOf.b(b.method.returns)) parts.push('returns');
  if (a.method.effect !== undefined && b.method.effect !== undefined && a.method.effect !== b.method.effect) parts.push('effect');
  return parts.length > 0 ? parts.join(', ') : undefined;
}
