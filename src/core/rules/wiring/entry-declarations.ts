import { SddRule } from '../types.js';
import { transportKind, type ComponentSpec, type DeclaredInvocation } from '../../../models/index.js';

/**
 * Entry declarations: every invokedBy, on a contract method or on a Portal
 * component, held to the shape the reachability model gives it. An entry is a
 * Portal verb's (callers outside the design reach it over the Portal's
 * transport); a scope says where NETWORK callers come from; the kinds the
 * model retired are read compatibly for one release and reported with the
 * kind they are read as. A prose check of the declaration itself: it neither
 * walks the graph nor reads the family.
 */
export const entryDeclarationsRule: SddRule = {
  name: 'entry-declarations',
  judges: 'design',
  description:
    "Holds every invokedBy declaration, on a contract method or on a Portal component, to the shape the reachability model gives it. An entry belongs to a Portal verb: a caller outside the design reaches it over the Portal's transport, so kind entry on anything but a Portal is reported. A scope describes where network callers come from, so a scope on a local or in-process verb, or on a runtime declaration, is reported. The kinds retired with the reachability model (external, sibling-subsystem) are read compatibly for one release and reported with the kind they are read as, which doctor --fix writes. A prose check of the declaration itself: it neither walks the graph nor reads the family.",
  codes: [
    { code: 'ENTRY_ON_NON_PORTAL', defaultSeverity: 'error', summary: 'An entry (invokedBy kind entry) declared on a method of a component that is not a Portal; a runtime hook declares kind runtime' },
    { code: 'ENTRY_SCOPE_NOT_NETWORK', defaultSeverity: 'warning', summary: 'A scope on an entry whose Portal\'s transport crosses no network (local or in-process), or on a runtime declaration' },
    { code: 'INVOKED_BY_RETIRED_KIND', defaultSeverity: 'warning', summary: 'An invokedBy declaration of a retired kind (external, sibling-subsystem), read as entry or runtime for one release' },
  ],
  check(ctx) {
    // The retired kinds the scan met, by interface and method: the loaded
    // spec already reads them as entry or runtime.
    const retired = new Map<string, string>();
    for (const fact of ctx.retiredReachFacts ?? []) {
      if (fact.form === 'invoked-by-kind' && fact.at !== undefined && typeof fact.stored === 'string') {
        retired.set(`${fact.specId}#${fact.at}`, fact.stored);
      }
    }

    /** Steps 2-8 for one declaration, written on `specId` (sited at `at` when it is a method's). */
    const judge = (comp: ComponentSpec, decl: DeclaredInvocation, specId: string, draft: boolean, at?: string): void => {
      const parts = at !== undefined ? { at } : undefined;
      // Steps 2-3: a retired kind, read as entry on a Portal and runtime elsewhere.
      const stored = at !== undefined ? retired.get(`${specId}#${at}`) : undefined;
      if (stored !== undefined) {
        ctx.addIssue(
          'warning',
          'INVOKED_BY_RETIRED_KIND',
          `Method "${at}" on "${comp.id}" declares invokedBy kind "${stored}", which the reachability model retired; it is read as "${decl.kind}" for one release. Run \`wairon doctor --fix\` to write it${stored === 'sibling-subsystem' ? ' — and model the sibling\'s call instead: its caller is in this tree' : ''}.`,
          specId,
          draft,
          undefined,
          parts,
        );
      }
      // Steps 4-5: an entry belongs to a Portal verb.
      if (decl.kind === 'entry' && comp.componentType !== 'Portal') {
        ctx.addIssue(
          'error',
          'ENTRY_ON_NON_PORTAL',
          `${at !== undefined ? `Method "${at}" on ${comp.componentType}` : comp.componentType} "${comp.id}" declares an entry (invokedBy kind entry), but only a Portal verb is entered by callers outside the design. A hook the process's own runtime calls (a composition root, timer, signal or framework callback) declares kind runtime; an outside caller of this component needs a Portal in front of it.`,
          specId,
          draft,
          undefined,
          parts,
        );
        return;
      }
      // Steps 6-7: a scope describes network callers only.
      if (decl.scope === undefined) return;
      const kind = comp.transport ? transportKind(comp.transport) : undefined;
      if (decl.kind === 'runtime' || (kind !== undefined && kind !== 'network')) {
        ctx.addIssue(
          'warning',
          'ENTRY_SCOPE_NOT_NETWORK',
          decl.kind === 'runtime'
            ? `${at !== undefined ? `Method "${at}" on ` : ''}"${comp.id}" declares a runtime invokedBy with scope "${decl.scope}", but a scope says where network callers of an entry come from; a runtime hook has none. Drop the scope.`
            : `${at !== undefined ? `Verb "${at}" of ` : ''}Portal "${comp.id}" declares an entry with scope "${decl.scope}", but its transport ${comp.transport} is ${kind}: no network is crossed, so the scope means nothing. Drop the scope.`,
          specId,
          draft,
          undefined,
          parts,
        );
      }
    };

    // Step 1: each Portal component's own declaration, then each contract method's.
    for (const comp of ctx.components) {
      if (comp.invokedBy === undefined || !ctx.isSpecInScope(comp.id)) continue;
      judge(comp, comp.invokedBy, comp.id, ctx.isComponentDraft(comp.id));
    }
    for (const intf of ctx.interfaces) {
      const comp = ctx.componentMap.get(intf.component);
      if (!comp || !ctx.isSpecInScope(intf.id)) continue;
      const draft = ctx.isComponentDraft(comp.id) || intf.status === 'draft' || intf.status === 'design';
      for (const m of intf.methods) {
        if (m.invokedBy !== undefined) judge(comp, m.invokedBy, intf.id, draft, m.name);
      }
    }
  },
};
