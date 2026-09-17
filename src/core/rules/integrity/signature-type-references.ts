import { SddRule } from '../types.js';
import {
  interfaceGenericParameters,
  methodGenericParameters,
  methodTypeRefs,
} from '../../../models/index.js';

/**
 * The other half of "defined once, referenced everywhere": every type an
 * interface method signature names must resolve to a builtin, a generic
 * parameter in scope (declared on the interface or on the method itself), or
 * a defined TypeSpec.
 */
export const signatureTypeReferencesRule: SddRule = {
  name: 'signature-type-references',
  description:
    'Every type identifier an interface method signature names must resolve to a builtin, a generic parameter in scope on the interface or the method, or a defined entity/value-object type.',
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
        const methodGenerics = new Set(
          Array.from(methodGenericParameters(m)).map(g => g.toLowerCase()),
        );
        const allGenerics = new Set([...interfaceGenerics, ...methodGenerics]);
        const refs = methodTypeRefs(m);
        for (const ref of refs) {
          if (!ctx.isTypeResolved(ref, allGenerics)) {
            ctx.addIssue(
              'error',
              'UNDEFINED_TYPE_REFERENCE',
              `Method "${m.name}" on interface "${intf.id}" references undefined type "${ref}" in signature.`,
              intf.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
