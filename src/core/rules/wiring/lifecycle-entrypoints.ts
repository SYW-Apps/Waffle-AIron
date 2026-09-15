import { isDraftSubsystem } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Lifecycle entrypoints — declared init/shutdown flow roots. Existence is
// checked here; the reachability and durability rules consume them as roots.
// ---------------------------------------------------------------------------

export const lifecycleRule: SddRule = {
  name: 'lifecycle-entrypoints',
  description:
    'Declared subsystem lifecycle entrypoints (init/shutdown flows) must name an existing component and a method on one of its interfaces — they are reachability roots, so a dangling entrypoint would silently detach every flow rooted in it.',
  codes: [
    { code: 'INVALID_LIFECYCLE_ENTRYPOINT', defaultSeverity: 'error', summary: 'Lifecycle entrypoint names a missing component or method' },
    { code: 'LIFECYCLE_CROSS_SUBSYSTEM', defaultSeverity: 'error', summary: 'Lifecycle entrypoint roots a flow in another subsystem\'s component' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const isDraftCtx = isDraftSubsystem(sub);
      for (const le of sub.lifecycle ?? []) {
        const comp = ctx.componentMap.get(le.component);
        if (!comp) {
          ctx.addIssue(
            'error',
            'INVALID_LIFECYCLE_ENTRYPOINT',
            `Subsystem "${sub.id}" declares ${le.phase} lifecycle entrypoint "${le.component}.${le.method}", but component "${le.component}" does not exist.`,
            sub.id,
            isDraftCtx,
          );
          continue;
        }
        // A lifecycle flow is the subsystem's own boot/shutdown wiring —
        // rooting it in a sibling's internals crosses the boundary (and would
        // silently dangle when that sibling is externalized/renamed).
        if (comp.subsystem !== sub.id) {
          ctx.addIssue(
            'error',
            'LIFECYCLE_CROSS_SUBSYSTEM',
            `Subsystem "${sub.id}" declares ${le.phase} lifecycle entrypoint "${le.component}.${le.method}", but "${comp.id}" belongs to subsystem "${comp.subsystem}" — declare the entrypoint on the owning subsystem instead.`,
            sub.id,
            isDraftCtx || ctx.isComponentDraft(comp.id),
          );
        }
        if (!ctx.interfaceMethodsOf(comp.id).some(method => method.name === le.method)) {
          ctx.addIssue(
            'error',
            'INVALID_LIFECYCLE_ENTRYPOINT',
            `Subsystem "${sub.id}" declares ${le.phase} lifecycle entrypoint "${le.component}.${le.method}", but "${comp.id}" declares no method "${le.method}" on any of its interfaces.`,
            sub.id,
            isDraftCtx || ctx.isComponentDraft(comp.id),
          );
        }
      }
    }
  },
};
