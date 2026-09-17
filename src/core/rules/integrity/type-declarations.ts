import { SddRule } from '../types.js';

/**
 * What a type DECLARES about itself: the subsystem that owns it has to exist,
 * and a type that models nothing — no fields, no methods — is a name and
 * nothing else. The identifiers a type's fields and an interface's signatures
 * REFERENCE are the field-type-references and signature-type-references rules.
 */
export const typeDeclarationsRule: SddRule = {
  name: 'type-declarations',
  description:
    'A type owned by a subsystem must reference an existing one, and a type declaring neither fields nor methods is a placeholder that can inform neither implementers nor the ERD.',
  codes: [
    { code: 'INVALID_SUBSYSTEM_REFERENCE', defaultSeverity: 'error', summary: 'Type references a non-existent owning subsystem' },
    { code: 'HOLLOW_TYPE', defaultSeverity: 'warning', summary: 'Type declares no fields and no methods — a placeholder that informs neither implementers nor the ERD' },
  ],
  check(ctx) {
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
    }
  },
};
