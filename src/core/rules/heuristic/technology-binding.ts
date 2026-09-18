import { SddRule } from '../types.js';

/**
 * Who may bind a technology at all. An L4 that declares `technologies` (e.g.
 * ["mysql"]) pins its component to that vendor, and only the data-layer
 * stereotypes exist to be pinned: an Adapter, Store, Registry or Index IS the
 * seam a technology lives behind. Logic that binds one directly has no seam to
 * swap at. WHERE the technology's name may then appear is
 * technology-boundaries' question.
 */

/** Stereotypes that may legitimately bind a technology directly. */
const DATA_LAYER = new Set(['Adapter', 'Store', 'Registry', 'Index']);

export const technologyBindingRule: SddRule = {
  name: 'technology-binding',
  description:
    'Only data-layer stereotypes (Adapter/Store/Registry/Index) should bind a technology directly: an L4 that declares `technologies` on logic has no swap seam. No hardcoded vendor lists — only declared tokens are policed, so the rule never fires on a tree that doesn\'t opt in.',
  codes: [
    { code: 'TECH_ON_LOGIC_COMPONENT', defaultSeverity: 'warning', summary: 'Technology bound by a non-data-layer stereotype' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const intf = ctx.interfaceMap.get(impl.contract);
      const comp = intf ? ctx.componentMap.get(intf.component) : undefined;
      // A dangling contract is the hierarchy rule's finding, not this one's.
      if (!impl.technologies?.length || !comp || DATA_LAYER.has(comp.componentType)) continue;
      ctx.addIssue(
        'warning',
        'TECH_ON_LOGIC_COMPONENT',
        `Implementation "${impl.id}" binds technology (${impl.technologies.join(', ')}) on component "${comp.id}" (${comp.componentType}). Technology belongs behind a data-layer seam — extract an Adapter (or Store/Registry/Index) behind an intent interface and let this component depend on that.`,
        impl.id,
        ctx.isImplementationDraft(impl),
      );
    }
  },
};
