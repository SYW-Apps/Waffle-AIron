import { SddRule } from '../types.js';
import { fieldTypeRefs, methodTypeRefs, typeMatchesRef } from '../../../models/index.js';

/**
 * A type nothing names: no field of any type and no contract signature
 * references it. Its own scan, not the reachability walk — a type is reached
 * by being NAMED, never by an execution chain, so nothing here rides the
 * narrative graph.
 */
export const unusedTypesRule: SddRule = {
  name: 'unused-types',
  description:
    'Flags types no field of any type and no interface method signature references. References are matched through the type-reference grammar (generic arguments, collections, qualified ids), and the declaring type\'s own generic parameters are left out — a type parameter is not a reference to a type.',
  codes: [
    { code: 'UNUSED_TYPE', defaultSeverity: 'warning', summary: 'Type never referenced by fields or signatures' },
  ],
  check(ctx) {
    const referencedTypes = new Set<string>();
    const markTypeReferenced = (ref: string) => {
      if (ctx.isBuiltinType(ref)) return;
      for (const spec of ctx.types) {
        if (typeMatchesRef(spec, ref)) {
          referencedTypes.add(spec.id);
        }
      }
    };

    // 1. Scan type fields (the type's own generic parameters are left out)
    for (const t of ctx.types) {
      for (const field of t.fields) {
        const refs = fieldTypeRefs(t, field.type);
        for (const ref of refs) {
          markTypeReferenced(ref);
        }
      }
    }

    // 2. Scan interface method signatures & returns (structured params preferred)
    for (const intf of ctx.interfaces) {
      for (const m of intf.methods) {
        const refs = methodTypeRefs(m);
        for (const ref of refs) {
          markTypeReferenced(ref);
        }
      }
    }

    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      if (!referencedTypes.has(t.id)) {
        const sub = ctx.subsystems.find(s => s.id === t.subsystem);
        const isDraftCtx = sub ? (sub.status === 'draft' || sub.status === 'design') : false;
        ctx.addIssue(
          'warning',
          'UNUSED_TYPE',
          `Type "${t.id}" is defined but never referenced by any type fields or interface methods.`,
          t.id,
          isDraftCtx,
        );
      }
    }
  },
};
