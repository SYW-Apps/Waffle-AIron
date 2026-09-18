import { isDraftSubsystem } from '../../../models/index.js';
import { SddRule } from '../types.js';

/**
 * An entity's invariant ids are the names its write paths assert by
 * (`<type-id>.<invariant-id>`), so a repeated id makes one assertion stand for
 * two different properties — and satisfying either would silence both. Read
 * from the entity's own invariant list and nothing else.
 */
export const uniqueInvariantIdsRule: SddRule = {
  name: 'unique-invariant-ids',
  description:
    'An entity\'s declared invariant ids must be unique within the entity: a narrative step asserts an invariant by "<type-id>.<invariant-id>", so a repeated id makes one assertion stand for two properties and satisfying either silences both.',
  codes: [
    { code: 'DUPLICATE_INVARIANT_ID', defaultSeverity: 'error', summary: 'An entity declares two invariants with the same id' },
  ],
  check(ctx) {
    for (const t of ctx.types) {
      const invariants = t.invariants ?? [];
      if (invariants.length === 0) continue;
      // A type carries no status of its own, so its subsystem decides the
      // draft context, as it does for UNUSED_TYPE.
      const sub = t.subsystem ? ctx.subsystems.find(s => s.id === t.subsystem) : undefined;
      const entityDraft = sub !== undefined && isDraftSubsystem(sub);

      const seen = new Set<string>();
      for (const inv of invariants) {
        if (seen.has(inv.id)) {
          ctx.addIssue(
            'error',
            'DUPLICATE_INVARIANT_ID',
            `Entity "${t.id}" declares invariant id "${inv.id}" more than once — invariant ids must be unique within the entity.`,
            t.id,
            entityDraft,
          );
        }
        seen.add(inv.id);
      }
    }
  },
};
