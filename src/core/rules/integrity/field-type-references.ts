import { SddRule } from '../types.js';
import { fieldTypeRefs } from '../../../models/index.js';

/**
 * Types are defined once and referenced everywhere. A field's declared type
 * names identifiers; each one must resolve to a builtin or a defined TypeSpec.
 * The type's own generic parameters are left out by fieldTypeRefs, so none
 * remain in scope to resolve against here.
 */
export const fieldTypeReferencesRule: SddRule = {
  name: 'field-type-references',
  description:
    'Every type identifier a type field\'s declared type names must resolve to a builtin or a defined entity/value-object type — the type\'s own generic parameters are not field references.',
  codes: [
    { code: 'UNDEFINED_TYPE_REFERENCE', defaultSeverity: 'error', summary: 'Reference to a type that is not defined anywhere' },
  ],
  check(ctx) {
    for (const t of ctx.types) {
      const sub = ctx.subsystems.find(s => s.id === t.subsystem);
      const isDraftCtx = sub ? (sub.status === 'draft' || sub.status === 'design') : false;
      if (!t.fields) continue;

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
  },
};
