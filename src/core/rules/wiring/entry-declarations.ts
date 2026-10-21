import { SddRule } from '../types.js';
import { transportKind, type ComponentSpec, type DeclaredInvocation } from '../../../models/index.js';

/**
 * Entry declarations: every invokedBy, on a contract method or on a
 * component, held to the shape the reachability model gives it. An entry is a
 * Portal verb's (callers outside the design reach it over the Portal's
 * transport); a scope says where NETWORK callers come from. A prose check of the declaration itself: it neither
 * walks the graph nor reads the family.
 */
export const entryDeclarationsRule: SddRule = {
  name: 'entry-declarations',
  judges: 'design',
  description:
    "Holds every invokedBy declaration, on a contract method or on a component, to the shape the reachability model gives it. An entry belongs to a Portal verb: a caller outside the design reaches it over the Portal's transport, so kind entry on anything but a Portal is reported. A scope describes where network callers come from, so a scope on a local or in-process verb, or on a runtime declaration, is reported. A declaration whose caller is planned (planned: true) still reaches the method, and a notice names it until the caller is built. A prose check of the declaration itself: it neither walks the graph nor reads the family.",
  codes: [
    { code: 'ENTRY_ON_NON_PORTAL', defaultSeverity: 'error', summary: 'An entry (invokedBy kind entry) declared on a method of a component that is not a Portal; a runtime hook declares kind runtime' },
    { code: 'ENTRY_CALLER_PLANNED', defaultSeverity: 'notice', summary: 'An invokedBy whose caller is planned (planned: true): it counts as reached until the caller is built' },
    { code: 'ENTRY_SCOPE_NOT_NETWORK', defaultSeverity: 'warning', summary: 'A scope on an entry whose Portal\'s transport crosses no network (local or in-process), or on a runtime declaration' },
  ],
  check(ctx) {
    /** Steps 2-7 for one declaration, written on `specId` (sited at `at` when it is a method's). */
    const judge = (comp: ComponentSpec, decl: DeclaredInvocation, specId: string, draft: boolean, at?: string): void => {
      const parts = at !== undefined ? { at } : undefined;
      // Steps 2-3: an entry belongs to a Portal verb.
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
      // Steps 4-5: a planned caller still reaches the method; the notice keeps it in view until it is built.
      if (decl.planned === true) {
        const what = at !== undefined ? `${comp.componentType === 'Portal' ? 'Verb' : 'Method'} "${at}" of "${comp.id}"` : `${comp.componentType} "${comp.id}" (every ${comp.componentType === 'Portal' ? 'verb' : 'method'})`;
        ctx.addIssue(
          'notice',
          'ENTRY_CALLER_PLANNED',
          `${what} declares ${decl.kind === 'entry' ? 'an entry' : 'a runtime invokedBy'} whose caller is planned, not built yet${decl.caller ? ` (${decl.caller})` : ''}. It counts as reached meanwhile; drop \`planned\` once the caller exists.`,
          specId,
          draft,
          undefined,
          parts,
        );
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

    // Step 1: each component's own declaration, then each contract method's.
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
