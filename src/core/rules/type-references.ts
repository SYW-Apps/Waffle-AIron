import { SddRule } from './types.js';
import {
  BUILTIN_TYPES,
  extractTypeIdentifiers,
  extractGenericTypeVariables,
  extractTypeGenerics,
  methodTypeRefs,
  matchTypeRef,
} from './type-analysis.js';

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

      if (t.fields) {
        const typeGenerics = new Set(
          Array.from(extractTypeGenerics(t.name)).map(g => g.toLowerCase()),
        );
        for (const field of t.fields) {
          const refs = extractTypeIdentifiers(field.type);
          for (const ref of refs) {
            const refLower = ref.toLowerCase();
            if (BUILTIN_TYPES.has(refLower)) {
              continue;
            }
            if (typeGenerics.has(refLower)) {
              continue;
            }
            const resolved = ctx.types.find(spec => {
              const typeQualifiedId = spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
                ? `${spec.subsystem}::${spec.id}`
                : spec.id;
              return matchTypeRef(ref, typeQualifiedId);
            });
            if (!resolved) {
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
        Array.from(extractTypeGenerics(intf.name)).map(g => g.toLowerCase()),
      );
      for (const m of intf.methods) {
        const methodGenerics = new Set(
          Array.from(extractGenericTypeVariables(m.signature)).map(g => g.toLowerCase()),
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
