import { SddRule } from '../types.js';
import { isDraftSubsystem, isOwnComponentEntry } from '../../../models/index.js';

/**
 * Public surface, question one: WHAT BACKS THE ENTRY. Every declared
 * publicInterface must name a component, that component must exist, and it
 * must be one this subsystem owns. Nothing else about the entry is judged
 * here — what the backing component may realize is public-surface-declared-
 * type's question, and the contract it binds is public-surface-bound-
 * contract's.
 *
 * The two `continue`s are the family's precedence: an entry whose binding is
 * broken says nothing reliable about a type or a contract, so the sibling
 * rules restate the same two preconditions rather than accuse on top of a
 * binding finding.
 */
export const publicSurfaceBindingRule: SddRule = {
  name: 'public-surface-binding',
  judges: 'design',
  description:
    'Every declared publicInterface names a backing component, that component exists, and the subsystem owns it — a subsystem may only publish its own components. A published component that is not a Portal is reported: nothing can use it, since a hop from another subsystem enters through a published Portal and another project consumes only a Portal\'s verbs.',
  codes: [
    { code: 'PUBLIC_INTERFACE_UNBOUND', defaultSeverity: 'error', summary: 'Public interface with no backing component' },
    { code: 'PUBLIC_INTERFACE_INVALID_COMPONENT', defaultSeverity: 'error', summary: 'Public interface references a non-existent component' },
    { code: 'PUBLIC_INTERFACE_FOREIGN_COMPONENT', defaultSeverity: 'error', summary: 'Subsystem publishing a component it does not own' },
    { code: 'PUBLIC_INTERFACE_NOT_PORTAL', defaultSeverity: 'warning', summary: 'Subsystem publishing a component that is not a Portal, which nothing can use' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const isDraftCtx = isDraftSubsystem(sub);
      // Own component entries only: a re-export or a type export is the
      // export-tables rule's to judge.
      for (const pi of sub.publicInterfaces.filter(isOwnComponentEntry)) {
        if (!pi.component) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_UNBOUND', `Subsystem "${sub.id}" declares a ${pi.type} public interface with no backing component. Bind it to the component that realizes it (publicInterfaces[].component).`, sub.id, isDraftCtx);
          continue;
        }
        const backing = ctx.componentMap.get(pi.component);
        if (!backing) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_INVALID_COMPONENT', `Subsystem "${sub.id}" public interface references component "${pi.component}" which does not exist.`, sub.id, isDraftCtx);
          continue;
        }
        const isSubsystemOwner = backing.subsystem === sub.id || backing.subsystem.startsWith(sub.id + '::');
        if (!isSubsystemOwner) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_FOREIGN_COMPONENT', `Subsystem "${sub.id}" publishes component "${pi.component}", but it belongs to subsystem "${backing.subsystem}". A subsystem may only publish its own components.`, sub.id, isDraftCtx);
          continue;
        }
        if (backing.componentType !== 'Portal') {
          ctx.addIssue('warning', 'PUBLIC_INTERFACE_NOT_PORTAL', `Subsystem "${sub.id}" publishes "${pi.component}", a ${backing.componentType}, not a Portal. Nothing can use it: a hop from another subsystem enters through a published Portal (CROSS_SUBSYSTEM_TARGET_NON_PORTAL where it is declared), and another project consumes only a Portal's verbs. Publish the Portal that dispatches to it, or drop the entry.`, sub.id, isDraftCtx);
        }
      }
    }
  },
};
