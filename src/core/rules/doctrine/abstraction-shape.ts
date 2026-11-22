import { PATTERN_TYPES, technologyName } from '../../../models/index.js';
import type { ComponentSpec } from '../../../models/index.js';
import { SddRule } from '../types.js';

/**
 * Where the abstract mark may stand and what an abstraction holds. A component
 * marked abstract holds a contract several other components implement, and
 * callers depend on it, never on an implementer. The mark stands on a Portal,
 * Orchestrator, Supervisor, Actor, Store, Index, Query, Registry or Adapter,
 * never on an Observer (reached by its topic), a pattern or a UI block.
 */
export const abstractionShapeRule: SddRule = {
  name: 'abstraction-shape',
  judges: 'design',
  description:
    "An abstraction is a component marked abstract: it holds a contract several other components implement, and callers depend on it, never on an implementer. The mark stands on a Portal, Orchestrator, Supervisor, Actor, Store, Index, Query, Registry or Adapter, and never on an Observer (reached by its topic), a pattern or a UI block. An abstract Portal states only its verbs: transport, endpoints, auth, basePath, dispatch and invokedBy belong to each implementer Portal, which binds its own. An abstraction's own L4 carries code linkage only, the file and symbol declaring the interface, trait or Protocol: no narrative, intent, calls or technologies, because its methods are realized by declaration and its behaviour lives in the implementers.",
  codes: [
    { code: 'ABSTRACT_NOT_ALLOWED', defaultSeverity: 'error', summary: 'abstract on an Observer, a pattern or a UI block' },
    { code: 'ABSTRACT_PORTAL_BINDS', defaultSeverity: 'error', summary: 'An abstract Portal declaring a transport, endpoints, auth, basePath, dispatch or invokedBy' },
    { code: 'ABSTRACTION_HAS_BEHAVIOUR', defaultSeverity: 'error', summary: "An abstraction's L4 carries a narrative, an intent, calls or technologies: it carries code linkage only" },
  ],
  check(ctx) {
    // Step 1: each component.
    for (const comp of ctx.components) {
      // Step 2: only an abstraction concerns this rule.
      if (comp.abstract !== true) continue;
      const draft = ctx.isComponentDraft(comp.id);
      // Steps 3-5: the mark where it cannot stand; nothing else is judged on it.
      if (isRefused(comp)) {
        ctx.addIssue(
          'error',
          'ABSTRACT_NOT_ALLOWED',
          `Component "${comp.id}" is marked abstract but is ${aOrAn(comp.componentType)} ${comp.componentType}: an Observer is reached by its topic, a pattern owns its members and a UI block presents, so none is substituted by callers. An abstraction is a Portal, Orchestrator, Supervisor, Actor, Store, Index, Query, Registry or Adapter.`,
          comp.id,
          draft,
        );
        continue;
      }
      const interfaces = ctx.interfacesByComponent.get(comp.id) ?? [];
      // Steps 6-7: an abstract Portal states only the verbs.
      if (comp.componentType === 'Portal') {
        const binds: string[] = [];
        if (comp.transport !== undefined) binds.push('transport');
        if (comp.basePath !== undefined) binds.push('basePath');
        if (comp.auth !== undefined) binds.push('auth');
        if (comp.dispatch !== undefined) binds.push('dispatch');
        if (comp.invokedBy !== undefined) binds.push('invokedBy');
        for (const intf of interfaces) {
          for (const m of intf.methods) {
            if (m.endpoint !== undefined) binds.push(`the endpoint of method "${m.name}"`);
            if (m.invokedBy !== undefined) binds.push(`the invokedBy of method "${m.name}"`);
          }
        }
        if (binds.length > 0) {
          ctx.addIssue(
            'error',
            'ABSTRACT_PORTAL_BINDS',
            `Abstract Portal "${comp.id}" binds what only an implementer Portal binds: ${binds.join(', ')}. An abstract Portal states only the verbs, and each implementer Portal binds its own transport, endpoints, auth, basePath, dispatch and entry.`,
            comp.id,
            draft,
          );
        }
      }
      // Steps 8-11: each L4 of the abstraction carries code linkage only.
      for (const intf of interfaces) {
        for (const impl of ctx.implementationsByContract.get(intf.id) ?? []) {
          const behaviours: string[] = [];
          for (const m of impl.methods) {
            if ((m.narrative ?? []).length > 0) behaviours.push(`a narrative on method "${m.name}"`);
            if (m.intent !== undefined && m.intent.trim() !== '') behaviours.push(`an intent on method "${m.name}"`);
            if ((m.calls ?? []).length > 0) behaviours.push(`calls on method "${m.name}"`);
          }
          for (const t of impl.technologies ?? []) behaviours.push(`the technology "${technologyName(t)}"`);
          if (behaviours.length === 0) continue;
          ctx.addIssue(
            'error',
            'ABSTRACTION_HAS_BEHAVIOUR',
            `Implementation "${impl.id}" of the abstraction "${comp.id}" carries behaviour: ${behaviours.join(', ')}. An abstraction's implementation names only the file and symbol declaring the interface, trait or Protocol, and its methods are realized by declaration; the behaviour lives in the implementers.`,
            impl.id,
            ctx.isImplementationDraft(impl),
          );
        }
      }
    }
  },
};

/** Whether the abstract mark cannot stand on this component: an Observer, a pattern or a UI block (a View). */
function isRefused(comp: ComponentSpec): boolean {
  return comp.componentType === 'Observer' || comp.componentType === 'View' || PATTERN_TYPES.has(comp.componentType);
}

function aOrAn(word: string): string {
  return /^[AEIOU]/.test(word) ? 'an' : 'a';
}
