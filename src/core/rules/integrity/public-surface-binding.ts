import { SddRule } from '../types.js';
import { isDraftSubsystem } from '../../../models/index.js';

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
  description:
    'Every declared publicInterface names a backing component, that component exists, and the subsystem owns it — a subsystem may only publish its own components.',
  codes: [
    { code: 'PUBLIC_INTERFACE_UNBOUND', defaultSeverity: 'error', summary: 'Public interface with no backing component' },
    { code: 'PUBLIC_INTERFACE_INVALID_COMPONENT', defaultSeverity: 'error', summary: 'Public interface references a non-existent component' },
    { code: 'PUBLIC_INTERFACE_FOREIGN_COMPONENT', defaultSeverity: 'error', summary: 'Subsystem publishing a component it does not own' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const isDraftCtx = isDraftSubsystem(sub);
      for (const pi of sub.publicInterfaces) {
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
        }
      }
    }
  },
};
