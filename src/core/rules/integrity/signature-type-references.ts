import { SddRule } from '../types.js';
import {
  interfaceGenericParameters,
  methodGenericParameters,
  methodTypeRefs,
  signatureTypeRefs,
  typeGenericParameters,
} from '../../../models/index.js';

/**
 * The other half of "defined once, referenced everywhere": every type a
 * method signature names must resolve to a builtin, a generic parameter in
 * scope (declared on the interface or on the method itself), or a defined
 * TypeSpec — on contract methods, on type methods that carry params, and on a
 * signature type's params and returns. A sourced contract method is skipped:
 * its params are its source's, judged once where the source declares them.
 */
export const signatureTypeReferencesRule: SddRule = {
  name: 'signature-type-references',
  judges: 'design',
  description:
    'Every type identifier a method signature names must resolve to a builtin, a generic parameter in scope on the interface or the method, or a defined type: an interface method\'s params and returns, a type method\'s params when it has them, and a signature type\'s params and returns. A method that takes its signature from a source is skipped — its params are its source\'s, judged once where the source declares them.',
  codes: [
    { code: 'UNDEFINED_TYPE_REFERENCE', defaultSeverity: 'error', summary: 'Reference to a type that is not defined anywhere' },
  ],
  check(ctx) {
    for (const intf of ctx.interfaces) {
      const isDraftCtx = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
      const interfaceGenerics = new Set(
        Array.from(interfaceGenericParameters(intf)).map(g => g.toLowerCase()),
      );
      for (const m of intf.methods) {
        // Step 4: a sourced method's params are its source's, judged where the source declares them.
        if (m.signatureFrom !== undefined) continue;
        const methodGenerics = new Set(
          Array.from(methodGenericParameters(m)).map(g => g.toLowerCase()),
        );
        const allGenerics = new Set([...interfaceGenerics, ...methodGenerics]);
        const refs = methodTypeRefs(m);
        for (const ref of refs) {
          if (!ctx.isTypeResolved(ref, allGenerics)) {
            const hint = ctx.importHint(ref);
            ctx.addIssue(
              'error',
              'UNDEFINED_TYPE_REFERENCE',
              `Method "${m.name}" on interface "${intf.id}" references undefined type "${ref}" in signature.${hint ? ` A declared dependency exports it without this project importing it — add \`${hint}\`.` : ''}`,
              intf.id,
              isDraftCtx,
            );
          }
        }
      }
    }

    // Steps 9-13: the structured signatures types carry — a type method's
    // params and returns when it has params, and a signature type's params and
    // returns — resolved against the type's own generic parameters.
    for (const t of ctx.types) {
      const sub = t.subsystem ? ctx.subsystems.find((s) => s.id === t.subsystem) : undefined;
      const isDraftCtx = !!sub && (sub.status === 'draft' || sub.status === 'design');
      const typeGenerics = new Set(Array.from(typeGenericParameters(t)).map((g) => g.toLowerCase()));
      const named: { ref: string; by: string }[] = [
        ...t.methods.filter((m) => m.params !== undefined)
          .flatMap((m) => methodTypeRefs(m).map((ref) => ({ ref, by: `Method "${m.name}" on type "${t.id}"` }))),
        ...signatureTypeRefs(t).map((ref) => ({ ref, by: `Signature type "${t.id}"` })),
      ];
      for (const { ref, by } of named) {
        if (ctx.isTypeResolved(ref, typeGenerics)) continue;
        const hint = ctx.importHint(ref);
        ctx.addIssue(
          'error',
          'UNDEFINED_TYPE_REFERENCE',
          `${by} references undefined type "${ref}" in signature.${hint ? ` A declared dependency exports it without this project importing it — add \`${hint}\`.` : ''}`,
          t.id,
          isDraftCtx,
        );
      }
    }
  },
};
