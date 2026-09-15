import { SddRule } from '../types.js';
import { extractTypeIdentifiers, methodTypeRefs } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Untyped seams — bare Json/any/unknown/object crossing a subsystem's public
// surface. The seam is exactly where role-envelope mismatches hide; inside a
// component a loose bag is a style choice, across a boundary it is an
// unchecked contract.
// ---------------------------------------------------------------------------

const BARE_SEAM_TYPES = new Set(['json', 'any', 'unknown', 'object']);

/** Whether any of these type references is a bare seam type, ignoring case. */
function namesBareType(refs: string[]): boolean {
  return refs.some(ref => BARE_SEAM_TYPES.has(ref.toLowerCase()));
}

export const untypedSeamRule: SddRule = {
  name: 'untyped-seams',
  description:
    'Methods on a subsystem\'s published components (its public surface) should not take or return bare Json/any/unknown/object, judged through each method\'s type references so a prose signature is judged like structured params: cross-subsystem contracts are the swap seam and must be typed. Generic-dispatch portals carry per-capability types via their dispatch table instead.',
  codes: [
    { code: 'UNTYPED_SEAM', defaultSeverity: 'warning', summary: 'Bare Json/any/unknown/object parameter or return crossing a subsystem public surface' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const published = ctx.publicSet.get(sub.id);
      if (!published || published.size === 0) continue;

      for (const compId of published) {
        const comp = ctx.componentMap.get(compId);
        if (!comp) continue;
        // A generic-dispatch portal's untyped envelope is the sanctioned
        // pattern ONCE it carries a dispatch table — the table is where the
        // per-capability typing lives.
        if (comp.componentType === 'Portal' && comp.dispatch && comp.dispatch.length > 0) continue;

        for (const intf of ctx.interfacesByComponent.get(compId) ?? []) {
          const isDraftCtx = ctx.isComponentDraft(compId) || intf.status === 'draft' || intf.status === 'design';
          for (const m of intf.methods) {
            // Every type is read through the grammar m.typeRefs() uses, so a
            // prose signature gets the verdict the same structured params would.
            // Structured params, authoritative when authored, name their
            // offenders one by one; a prose signature is the offender whole.
            const offenders: string[] = [];
            if (m.params && m.params.length > 0) {
              for (const p of m.params) {
                if (namesBareType(extractTypeIdentifiers(p.type))) {
                  offenders.push(`param "${p.name}: ${p.type}"`);
                }
              }
              if (namesBareType(extractTypeIdentifiers(m.returns ?? ''))) {
                offenders.push(`return "${m.returns}"`);
              }
            } else if (namesBareType(methodTypeRefs(m))) {
              offenders.push(`signature "${m.signature}"`);
            }
            if (offenders.length) {
              ctx.addIssue(
                'warning',
                'UNTYPED_SEAM',
                `Method "${m.name}" on published component "${compId}" (public surface of subsystem "${sub.id}") crosses the boundary untyped: ${offenders.join(', ')}. Type the seam — or, for a generic-dispatch portal, carry per-capability types in the dispatch table.`,
                intf.id,
                isDraftCtx,
              );
            }
          }
        }
      }
    }
  },
};
