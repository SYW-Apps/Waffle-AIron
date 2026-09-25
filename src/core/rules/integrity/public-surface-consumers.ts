import { SddRule } from '../types.js';
import { isDraftSubsystem } from '../../../models/index.js';

/**
 * Public surface, question four: WHO IT IS PUBLISHED TO. A publicInterfaces
 * entry's consumers restricts who may depend on the surface, so every id it
 * names must be a subsystem of this tree. An id that names nothing locks the
 * surface against a caller nobody can be — and a typo there silently locks out
 * the caller that was meant, which subsystem-boundary-dependencies would then
 * report against the wrong party.
 */
export const publicSurfaceConsumersRule: SddRule = {
  name: 'public-surface-consumers',
  description:
    'Every subsystem a published surface names as its consumer must exist in the tree. A consumers list restricts who may depend on the surface, so an id that names nothing locks the surface against a caller nobody can be — and a typo there silently locks out the caller that was meant, which the boundary rule would then report against the wrong party.',
  codes: [
    { code: 'PUBLIC_INTERFACE_UNKNOWN_CONSUMER', defaultSeverity: 'error', summary: 'A published surface names as its consumer a subsystem the tree does not have' },
  ],
  check(ctx) {
    const known = new Set(ctx.subsystems.map((s) => s.id));
    // Step 1: every consumers id of every entry of every loaded subsystem.
    for (const sub of ctx.subsystems) {
      for (const pi of sub.publicInterfaces) {
        for (const consumer of pi.consumers ?? []) {
          // Step 2: an id that names a subsystem of this tree passes.
          if (known.has(consumer)) continue;
          // Step 3: one that names none is reported on the declaring subsystem.
          ctx.addIssue(
            'error',
            'PUBLIC_INTERFACE_UNKNOWN_CONSUMER',
            `Subsystem "${sub.id}" publishes "${pi.component ?? `${pi.type} ${pi.details}`}" to consumer "${consumer}", which names no subsystem of this tree. Name an existing subsystem, or drop the id — a consumers list admits only the subsystems it names.`,
            sub.id,
            isDraftSubsystem(sub),
          );
        }
      }
    }
    // Step 4: every consumers id resolved or reported.
  },
};
