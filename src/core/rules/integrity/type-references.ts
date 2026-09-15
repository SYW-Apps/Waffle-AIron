import { SddRule } from '../types.js';
import {
  fieldTypeRefs,
  interfaceGenericParameters,
  methodGenericParameters,
  methodTypeRefs,
} from '../../../models/index.js';

/**
 * Types are defined once and referenced everywhere: every type mentioned in a
 * type field or an interface method signature must resolve to a builtin, a
 * generic parameter in scope, or a defined TypeSpec.
 */
export const typeReferencesRule: SddRule = {
  name: 'type-references',
  description:
    'Type fields and interface method signatures may only reference builtins, in-scope generic parameters, or defined entity/value-object types. Types owned by a subsystem must reference an existing subsystem.',
  codes: [
    { code: 'INVALID_SUBSYSTEM_REFERENCE', defaultSeverity: 'error', summary: 'Type references a non-existent owning subsystem' },
    { code: 'UNDEFINED_TYPE_REFERENCE', defaultSeverity: 'error', summary: 'Reference to a type that is not defined anywhere' },
    { code: 'HOLLOW_TYPE', defaultSeverity: 'warning', summary: 'Type declares no fields and no methods — a placeholder that informs neither implementers nor the ERD' },
  ],
  check(ctx) {
    // Check types reference existing subsystem and resolve fields
    for (const t of ctx.types) {
      const sub = ctx.subsystems.find(s => s.id === t.subsystem);
      const isDraftCtx = sub ? (sub.status === 'draft' || sub.status === 'design') : false;
      if (t.subsystem && !ctx.subsystemIds.has(t.subsystem)) {
        ctx.addIssue(
          'error',
          'INVALID_SUBSYSTEM_REFERENCE',
          `Type "${t.id}" references non-existent subsystem "${t.subsystem}".`,
          t.id,
          isDraftCtx,
        );
      }

      // A type with neither fields nor methods carries a name and nothing
      // else — it can't inform implementers, can't participate in the ERD,
      // and usually marks a post-hoc "make validation pass" placeholder.
      if ((!t.fields || t.fields.length === 0) && (!t.methods || t.methods.length === 0)) {
        ctx.addIssue(
          'warning',
          'HOLLOW_TYPE',
          `Type "${t.id}" (${t.kind}) declares no fields and no methods. Fill in the shape it actually models, or delete it.`,
          t.id,
          isDraftCtx,
        );
      }

      if (t.fields) {
        for (const field of t.fields) {
          // The field type's identifiers, the type's own generic parameters
          // already left out — so none remain in scope to resolve against.
          const refs = fieldTypeRefs(t, field.type);
          for (const ref of refs) {
            if (!ctx.isTypeResolved(ref, new Set())) {
              ctx.addIssue(
                'error',
                'UNDEFINED_TYPE_REFERENCE',
                `Type "${t.id}" field "${field.name}" references undefined type "${ref}" in "${field.type}".`,
                t.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }

    // Interface method signature type references
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
