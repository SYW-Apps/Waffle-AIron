import { PATTERN_TYPES } from '../../../models/index.js';
import type { ComponentSpec, InterfaceSpec } from '../../../models/index.js';
import { isLocalEntry } from '../read-model.js';
import { SddRule, type RuleContext } from '../types.js';

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
    "Judges an abstraction against what implements it. A contract realizes an abstraction by declaring it in implements, and an abstraction's own contract may implement abstractions in turn (Animal, Dog, GoldenRetriever): it is exploded, declaring every method of what it implements (implements-contracts holds it at every level), so each abstraction is one complete contract and nothing inherits, and a concrete component is never implemented (IMPLEMENTS_NOT_ABSTRACT). The chain is read through ctx.abstractionsOf and ctx.implementersOf, the two cycle-safe queries every rule shares; an implements path that returns to its start, the component itself included, is a cycle (ABSTRACTION_CYCLE), and a member of one is judged by no other check here. An abstraction needs a concrete implementer, direct or through the abstractions below it, unless it, or an abstraction below it, is exported with role implement for other projects to implement (several L4 implementations of one component's contract serve one engine per deployment, and need no abstraction); each implementer, abstract or concrete, is the same stereotype as the abstraction it implements and is owned by the same owner (both unowned, or both owned by the same pattern), judged on each direct edge and so on every edge of the chain. An abstraction implemented from another subsystem must be published by its own subsystem with role implement, honouring the entry's consumers (ABSTRACTION_UNPUBLISHED), since a subsystem's components are reached by others only through what it publishes. A contract implementing more than one abstraction is legal and the exception, one vendor client serving two roles; an entry that is an ancestor of another entry of the same contract is no second role and is not counted. What an implementing contract must declare, its effects and its omissions are implements-contracts' own, and where the mark may stand is abstraction-shape's.",
  codes: [
    { code: 'ABSTRACTION_UNIMPLEMENTED', defaultSeverity: 'error', summary: 'An abstraction with no concrete implementer, direct or through the abstractions below it, when neither it nor an abstraction below it is exported with role implement' },
    { code: 'ABSTRACTION_SINGLE_IMPLEMENTER', defaultSeverity: 'notice', summary: "An abstraction with exactly one concrete implementer, direct or through the abstractions below it, unless it or an abstraction below it is exported with role implement: several L4 implementations of one component's contract suffice for one engine behind it" },
    { code: 'ABSTRACTION_STEREOTYPE_MISMATCH', defaultSeverity: 'error', summary: "An implementer whose stereotype differs from its abstraction's" },
    { code: 'ABSTRACTION_CONTAINMENT', defaultSeverity: 'error', summary: "An implementer not owned by the abstraction's owner: both unowned, or both owned by the same pattern" },
    { code: 'ABSTRACTION_MULTIPLE', defaultSeverity: 'notice', summary: 'A contract implementing more than one abstraction or extension point that is not an ancestor of another entry of the same contract: legal and the exception; keep it to one responsibility serving several roles, and document it with a lint.allow and a reason' },
    { code: 'ABSTRACTION_CYCLE', defaultSeverity: 'error', summary: 'An implements path returns to its start, a component implementing itself included: abstractions form a chain, never a loop' },
    { code: 'ABSTRACTION_UNPUBLISHED', defaultSeverity: 'error', summary: 'An abstraction implemented from another subsystem that its own subsystem does not publish with role implement, or publishes only to consumers that leave the implementing subsystem out' },
  ],
  check(ctx) {
    // Step 1: setup. Each abstraction's directly implementing contracts (the chain itself is
    // ctx.implementersOf / ctx.abstractionsOf's), the abstractions exposed for other projects to
    // implement, and the tree's ownership.
    const direct = new Map<string, InterfaceSpec[]>();
    for (const intf of ctx.interfaces) {
      for (const entry of intf.implements ?? []) {
        if (!isLocalEntry(ctx.componentMap, ctx.projectOf, intf.id, entry)) continue;
        direct.set(entry, [...(direct.get(entry) ?? []), intf]);
      }
    }
    const exposed = new Set<string>();
    for (const table of ctx.exportTables ?? []) {
      for (const e of table.entries) if (e.kind === 'component' && e.role === 'implement' && e.component) exposed.add(e.component);
    }
    const ownership = ctx.ownershipIndex();
    const isAbstract = (id: string): boolean => ctx.componentMap.get(id)?.abstract === true;

    // Steps 2-17: each abstraction (abstraction-shape reports where the mark cannot stand),
    // except those an implements path leads back to: a cycle is reported once, below.
    for (const comp of ctx.components) {
      if (comp.abstract !== true || !holdsMark(comp)) continue;
      if (ctx.abstractionsOf(comp.id).includes(comp.id)) continue;
      const draft = ctx.isComponentDraft(comp.id);
      // Step 3.
      const impls = direct.get(comp.id) ?? [];
      const below = ctx.implementersOf(comp.id);
      const concrete = below.filter((id) => !isAbstract(id) && ctx.componentMap.has(id));
      const exportedAsPoint = exposed.has(comp.id) || below.some((id) => isAbstract(id) && exposed.has(id));
      // Steps 4-6: no concrete implementer and no other project is waited for; the direct implementers are still judged.
      if (concrete.length === 0 && !exportedAsPoint) {
        ctx.addIssue(
          'error',
          'ABSTRACTION_UNIMPLEMENTED',
          `Abstraction "${comp.id}" has no concrete implementer: no concrete component implements it, directly or through an abstraction that implements it. Declare implements on the implementers' contracts, export it with role implement for other projects to implement, or drop the abstraction and depend on the component itself.`,
          comp.id,
          draft,
        );
      } else if (concrete.length === 1 && !exportedAsPoint) {
        // Steps 7-8: exactly one concrete implementer.
        ctx.addIssue(
          'notice',
          'ABSTRACTION_SINGLE_IMPLEMENTER',
          `Abstraction "${comp.id}" has exactly one concrete implementer, "${concrete[0]}". Several L4 implementations of one component's contract serve one engine per deployment; an abstraction earns its place by several live implementers used together.`,
          comp.id,
          draft,
        );
      }
      // Steps 9-16: each directly implementing contract, which is every edge of the chain.
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
        // Steps 14-15: another subsystem reaches only what a subsystem publishes.
        if (implComp.subsystem !== comp.subsystem) {
          const owning = ctx.subsystems.find((s) => s.id === comp.subsystem);
          const entries = (owning?.publicInterfaces ?? []).filter((pi) => pi.component === comp.id);
          const asImplement = entries.filter((pi) => pi.role === 'implement');
          const serves = asImplement.some((pi) => (pi.consumers ?? []).length === 0 || (pi.consumers ?? []).includes(implComp.subsystem));
          if (!serves) {
            const why = entries.length === 0
              ? 'its subsystem publishes no entry for it'
              : asImplement.length === 0
                ? 'its subsystem publishes it with another role than implement'
                : `the entry that publishes it with role implement names consumers that leave "${implComp.subsystem}" out`;
            ctx.addIssue(
              'error',
              'ABSTRACTION_UNPUBLISHED',
              `"${implComp.id}" (subsystem "${implComp.subsystem}") implements the abstraction "${comp.id}" of subsystem "${comp.subsystem}", but ${why}. Another subsystem reaches only what a subsystem publishes: publish the abstraction with role implement${asImplement.length > 0 ? ` to consumer "${implComp.subsystem}"` : ''}.`,
              implComp.id,
              implDraft,
            );
          }
        }
      }
    }
    // Steps 18-20: a contract implementing several abstractions or extension points, none an ancestor of another.
    for (const intf of ctx.interfaces) {
      const entries = intf.implements ?? [];
      if (entries.length <= 1) continue;
      const roles = entries.filter((entry) => !entries.some((other) => other !== entry && ctx.abstractionsOf(other).includes(entry)));
      if (roles.length <= 1) continue;
      ctx.addIssue(
        'notice',
        'ABSTRACTION_MULTIPLE',
        `Interface "${intf.id}" implements ${roles.length} abstractions or extension points (${roles.join(', ')}). That is legal and the exception, one vendor client serving two roles: keep the contract to one responsibility serving several roles, and document it with a lint.allow and its reason.`,
        intf.id,
        intf.status === 'draft' || intf.status === 'design',
      );
    }
    // Steps 21-23: each abstraction on an implements cycle, reported once on the first of its members in id order.
    const reported = new Set<string>();
    for (const comp of ctx.components) {
      if (comp.abstract !== true || reported.has(comp.id) || !ctx.abstractionsOf(comp.id).includes(comp.id)) continue;
      const members = new Set([comp.id, ...ctx.abstractionsOf(comp.id).filter((id) => isAbstract(id) && ctx.abstractionsOf(id).includes(comp.id))]);
      for (const id of members) reported.add(id);
      const first = [...members].sort()[0];
      ctx.addIssue(
        'error',
        'ABSTRACTION_CYCLE',
        `Abstractions "${[...members].sort().join('", "')}" implement one another in a cycle (${cyclePath(ctx, first)}). Abstractions form a chain from the broadest to the narrowest, never a loop: remove the implements entry that closes it.`,
        first,
        ctx.isComponentDraft(first),
      );
    }
  },
};

/** One implements path from a component back to itself, as text (a self-implementing component reads "a -> a"). */
function cyclePath(ctx: RuleContext, start: string): string {
  const path = [start];
  let at = start;
  const seen = new Set<string>();
  for (;;) {
    seen.add(at);
    const next = (ctx.interfacesByComponent.get(at) ?? [])
      .flatMap((i) => i.implements ?? [])
      .find((e) => e === start || (!seen.has(e) && ctx.componentMap.get(e)?.abstract === true && ctx.abstractionsOf(e).includes(start)));
    if (next === undefined) return path.join(' -> ');
    path.push(next);
    if (next === start) return path.join(' -> ');
    at = next;
  }
}

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
