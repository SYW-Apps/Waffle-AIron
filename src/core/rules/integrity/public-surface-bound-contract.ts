import { SddRule } from '../types.js';
import { isDraftSubsystem, isOwnComponentEntry } from '../../../models/index.js';

/**
 * Public surface, question three: DOES THE BOUND CONTRACT BELONG TO THE
 * COMPONENT THE ENTRY PUBLISHES. An entry may name the L3 interface it
 * publishes; that interface must exist, and it must be the backing
 * component's own.
 *
 * The comparison is between two ids, so this rule never reads the backing
 * component's spec — but it does restate public-surface-binding's two
 * preconditions, because `intf.component !== pi.component` is trivially true
 * for EVERY interface when pi.component names nothing. Judged without them,
 * a single mistyped component id would accuse a perfectly good contract of
 * belonging elsewhere.
 */
export const publicSurfaceBoundContractRule: SddRule = {
  name: 'public-surface-bound-contract',
  description:
    'A publicInterface entry that binds an L3 interface must bind one that exists and that belongs to the component the entry publishes.',
  codes: [
    { code: 'PUBLIC_INTERFACE_INVALID_INTERFACE', defaultSeverity: 'error', summary: 'Bound L3 interface missing or belonging to another component' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const isDraftCtx = isDraftSubsystem(sub);
      // Own component entries only: a re-export or a type export is the
      // export-tables rule's to judge.
      for (const pi of sub.publicInterfaces.filter(isOwnComponentEntry)) {
        if (!pi.interface) continue;
        // public-surface-binding's preconditions, restated: against an entry
        // that names no component, or one that resolves to nothing, an
        // ownership comparison can only misfire.
        if (!pi.component || !ctx.componentMap.has(pi.component)) continue;

        const intf = ctx.interfaceMap.get(pi.interface);
        if (!intf) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_INVALID_INTERFACE', `Subsystem "${sub.id}" public interface references interface "${pi.interface}" which does not exist.`, sub.id, isDraftCtx);
        } else if (intf.component !== pi.component) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_INVALID_INTERFACE', `Subsystem "${sub.id}" binds interface "${pi.interface}" to component "${pi.component}", but that interface belongs to component "${intf.component}".`, sub.id, isDraftCtx);
        }
      }
    }
  },
};
