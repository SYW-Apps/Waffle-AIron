import { SddRule } from '../types.js';
import { fieldTypeRefs, methodTypeRefs, typeMatchesRef } from '../../../models/index.js';

/**
 * A type nothing names: no field of any type, no contract signature and no
 * other type's method signature references it. Its own scan, not the
 * reachability walk — a type is reached by being NAMED, never by an execution
 * chain, so nothing here rides the narrative graph.
 */
export const unusedTypesRule: SddRule = {
  name: 'unused-types',
  description:
    'Flags types no field of any type, no interface method signature and no other type\'s method signature references. References are matched through the type-reference grammar (generic arguments, collections, qualified ids), and the declaring type\'s own generic parameters are left out — a type parameter is not a reference to a type. A type named only by its OWN methods stays unused, the way a function that only calls itself is.',
  codes: [
    { code: 'UNUSED_TYPE', defaultSeverity: 'warning', summary: 'Type never referenced by fields, signatures or type methods' },
  ],
  check(ctx) {
    const referencedTypes = new Set<string>();
    /** Record every type the ref names, except `exceptId` — the type doing the naming, when it names itself. */
    const markTypeReferenced = (ref: string, exceptId?: string) => {
      if (ctx.isBuiltinType(ref)) return;
      for (const spec of ctx.types) {
        if (spec.id === exceptId) continue;
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

    // 3. Scan the methods declared ON types. A type returned only by another
    // type's method — `rule_context.codeIndex(): CodeIndex` — is named, and
    // reading only fields and contracts made it look like nobody's. The
    // declaring type is excluded from its OWN methods' refs: a type named
    // nowhere but its own signatures is used by nothing, the way a function
    // that only calls itself is.
    for (const t of ctx.types) {
      for (const m of t.methods) {
        const refs = methodTypeRefs(m);
        for (const ref of refs) {
          markTypeReferenced(ref, t.id);
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
          `Type "${t.id}" is defined but never referenced by any type field, interface method or other type's method.`,
          t.id,
          isDraftCtx,
        );
      }
    }
  },
};
