import { SddRule } from '../types.js';
import { fieldTypeRefs, methodTypeRefs, signatureTypeRefs, typeMatchesRef } from '../../../models/index.js';

/**
 * A type nothing names: no field of any type, no contract signature, no
 * contract method's signatureFrom and no other type's method signature
 * references it. Its own scan, not the
 * reachability walk — a type is reached by being NAMED, never by an execution
 * chain, so nothing here rides the narrative graph.
 */
export const unusedTypesRule: SddRule = {
  name: 'unused-types',
  // Stage 8: its verdict needs the whole system's specs, so a part judged alone skips it.
  needsWholeTree: true,
  judges: 'design',
  description:
    "Flags types no field of any type, no interface method signature, no contract method's signatureFrom, no other type's method signature and no export table references. References are matched through the type-reference grammar (generic arguments, collections, qualified ids), and the declaring type's own generic parameters are left out: a type parameter is not a reference to a type. A signature type is used when a method names it as its signatureFrom or a param is typed by it. A type exported by an L1 or L0 export entry (typeDef) is used by definition: its consumers are outside this tree. A type named only by its OWN methods stays unused, the way a function that only calls itself is.",
  codes: [
    { code: 'UNUSED_TYPE', defaultSeverity: 'warning', summary: 'Type never referenced by fields, signatures, type methods or an export table' },
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

    // 1. Scan type fields (the type's own generic parameters are left out),
    // and a signature type's params and returns, its references in place of
    // fields (a signature naming itself is not a use of it).
    for (const t of ctx.types) {
      for (const field of t.fields) {
        const refs = fieldTypeRefs(t, field.type);
        for (const ref of refs) {
          markTypeReferenced(ref);
        }
      }
      for (const ref of signatureTypeRefs(t)) markTypeReferenced(ref, t.id);
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

    // 3. The signature types methods take their signature from, as the loader
    // resolved them (ctx.signatureFacts; none on a candidate run): a fact whose
    // type reading named a signature type — its target, or an ambiguous
    // fact's signature candidate — is a use of that type.
    for (const fact of ctx.signatureFacts?.sources ?? []) {
      const named = fact.form === 'signature' && fact.target ? fact.target
        : fact.outcome === 'ambiguous' ? fact.candidates?.[1] : undefined;
      if (!named) continue;
      for (const spec of ctx.types) {
        if (spec.id === named || typeMatchesRef(spec, named)) referencedTypes.add(spec.id);
      }
    }

    // 4. Scan the methods declared ON types. A type returned only by another
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

    // 5. The exported types: every L1 and L0 export entry's typeDef, and every
    // type the resolved tables bind. Its consumers are outside this tree, so
    // an exported type is used by definition.
    for (const sub of ctx.subsystems) {
      for (const pi of sub.publicInterfaces) if (pi.typeDef) markTypeReferenced(pi.typeDef);
    }
    for (const e of ctx.system.publicInterfaces ?? []) if (e.typeDef) markTypeReferenced(e.typeDef);
    for (const table of ctx.exportTables ?? []) {
      for (const e of table.entries) if (e.kind === 'type' && e.typeDef) referencedTypes.add(e.typeDef);
    }

    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      if (!referencedTypes.has(t.id)) {
        const sub = ctx.subsystems.find(s => s.id === t.subsystem);
        const isDraftCtx = sub ? (sub.status === 'draft' || sub.status === 'design') : false;
        ctx.addIssue(
          'warning',
          'UNUSED_TYPE',
          `Type "${t.id}" is defined but never referenced by any type field, interface method, other type's method or export table.`,
          t.id,
          isDraftCtx,
        );
      }
    }
  },
};
