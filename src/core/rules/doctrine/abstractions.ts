import { PATTERN_TYPES } from '../../../models/index.js';
import type { ComponentSpec, InterfaceSpec } from '../../../models/index.js';
import { SddRule } from '../types.js';

/**
 * Judges an abstraction against what implements it. A contract realizes an
 * abstraction by declaring it in `implements`. What an implementing contract
 * must declare, its effects and its omissions are implements-contracts' own,
 * and where the mark may stand is abstraction-shape's.
 */
export const abstractionsRule: SddRule = {
  name: 'abstractions',
  judges: 'design',
  description:
    "Judges an abstraction against what implements it. A contract realizes an abstraction by declaring it in implements. An abstraction needs implementers, unless it is exported with role implement for other projects to implement (several L4 implementations of one component's contract serve one engine per deployment, and need no abstraction); each implementer is the same stereotype as the abstraction and is owned by the same owner (both unowned, or both owned by the same pattern). A contract implementing more than one abstraction is legal and the exception, one vendor client serving two roles. What an implementing contract must declare, its effects and its omissions are implements-contracts' own, and where the mark may stand is abstraction-shape's.",
  codes: [
    { code: 'ABSTRACTION_UNIMPLEMENTED', defaultSeverity: 'error', summary: 'An abstraction no contract implements and that is not exported with role implement' },
    { code: 'ABSTRACTION_SINGLE_IMPLEMENTER', defaultSeverity: 'notice', summary: "An abstraction with exactly one implementer, unless exported with role implement: several L4 implementations of one component's contract suffice for one engine behind it" },
    { code: 'ABSTRACTION_STEREOTYPE_MISMATCH', defaultSeverity: 'error', summary: "An implementer whose stereotype differs from its abstraction's" },
    { code: 'ABSTRACTION_CONTAINMENT', defaultSeverity: 'error', summary: "An implementer not owned by the abstraction's owner: both unowned, or both owned by the same pattern" },
    { code: 'ABSTRACTION_MULTIPLE', defaultSeverity: 'notice', summary: 'A contract implementing more than one abstraction: legal and the exception; keep it to one responsibility serving several roles, and document it with a lint.allow and a reason' },
  ],
  check(ctx) {
    // Step 1: setup. Each abstraction's implementing contracts, the abstractions
    // exposed for other projects to implement, and the tree's ownership.
    const implementing = new Map<string, InterfaceSpec[]>();
    for (const intf of ctx.interfaces) {
      for (const entry of intf.implements ?? []) {
        if (entry.includes('::')) continue;
        implementing.set(entry, [...(implementing.get(entry) ?? []), intf]);
      }
    }
    const exposed = new Set<string>();
    for (const table of ctx.exportTables ?? []) {
      for (const e of table.entries) if (e.kind === 'component' && e.role === 'implement' && e.component) exposed.add(e.component);
    }
    const ownership = ctx.ownershipIndex();

    // Steps 2-15: each abstraction (abstraction-shape reports where the mark cannot stand).
    for (const comp of ctx.components) {
      if (comp.abstract !== true || !holdsMark(comp)) continue;
      const draft = ctx.isComponentDraft(comp.id);
      // Step 3.
      const impls = implementing.get(comp.id) ?? [];
      const exportedAsPoint = exposed.has(comp.id);
      // Steps 4-6: nothing implements it and no other project is waited for.
      if (impls.length === 0 && !exportedAsPoint) {
        ctx.addIssue(
          'error',
          'ABSTRACTION_UNIMPLEMENTED',
          `Abstraction "${comp.id}" has no implementer: no contract declares it in implements. Declare implements on the implementers' contracts, export it with role implement for other projects to implement, or drop the abstraction and depend on the component itself.`,
          comp.id,
          draft,
        );
        continue;
      }
      // Steps 7-8: exactly one implementer.
      if (impls.length === 1 && !exportedAsPoint) {
        ctx.addIssue(
          'notice',
          'ABSTRACTION_SINGLE_IMPLEMENTER',
          `Abstraction "${comp.id}" has exactly one implementer, "${impls[0].component}". Several L4 implementations of one component's contract serve one engine per deployment; an abstraction earns its place by several live implementers used together.`,
          comp.id,
          draft,
        );
      }
      // Steps 9-14: each implementing contract.
      for (const intf of impls) {
        const implComp = ctx.componentMap.get(intf.component);
        if (!implComp) continue;
        const implDraft = ctx.isComponentDraft(implComp.id);
        if (implComp.componentType !== comp.componentType) {
          ctx.addIssue(
            'error',
            'ABSTRACTION_STEREOTYPE_MISMATCH',
            `"${implComp.id}" implements the abstraction "${comp.id}" but is ${aOrAn(implComp.componentType)} ${implComp.componentType}, not ${aOrAn(comp.componentType)} ${comp.componentType}. Callers substitute implementers for the abstraction, so each is the same kind of block.`,
            implComp.id,
            implDraft,
          );
        }
        const implOwner = ownership.ownerOf(implComp.id);
        const absOwner = ownership.ownerOf(comp.id);
        if (implOwner !== absOwner) {
          ctx.addIssue(
            'error',
            'ABSTRACTION_CONTAINMENT',
            `"${implComp.id}" implements the abstraction "${comp.id}" but ${owner(implOwner)} while the abstraction ${owner(absOwner)}. An abstraction and its implementers live under one owner (both unowned, or both owned by the same pattern), so a pattern's members stay private to it.`,
            implComp.id,
            implDraft,
          );
        }
      }
    }
    // Steps 16-18: a contract implementing several abstractions or extension points.
    for (const intf of ctx.interfaces) {
      if ((intf.implements ?? []).length <= 1) continue;
      ctx.addIssue(
        'notice',
        'ABSTRACTION_MULTIPLE',
        `Interface "${intf.id}" implements ${intf.implements!.length} abstractions or extension points (${intf.implements!.join(', ')}). That is legal and the exception, one vendor client serving two roles: keep the contract to one responsibility serving several roles, and document it with a lint.allow and its reason.`,
        intf.id,
        intf.status === 'draft' || intf.status === 'design',
      );
    }
  },
};

/** Whether the mark is somewhere it may stand: abstraction-shape reports an Observer, a pattern or a UI block. */
function holdsMark(comp: ComponentSpec): boolean {
  return comp.componentType !== 'Observer' && comp.componentType !== 'View' && !PATTERN_TYPES.has(comp.componentType);
}

function owner(id: string | undefined): string {
  return id === undefined ? 'is unowned' : `is owned by "${id}"`;
}

function aOrAn(word: string): string {
  return /^[AEIOU]/.test(word) ? 'an' : 'a';
}
