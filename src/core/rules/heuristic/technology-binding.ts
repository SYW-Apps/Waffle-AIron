import { SddRule } from '../types.js';
import { technologyName } from '../../../models/index.js';

/**
 * Who may bind a technology at all. An L4 that declares `technologies` (e.g.
 * ["mysql"]) pins its component to that vendor, and only the stereotypes that
 * sit at a seam exist to be pinned: an Adapter, Store, Registry or Index IS the
 * seam a data technology lives behind, an Observer the one a messaging
 * technology is subscribed through — and a Portal is the TRANSPORT seam, so
 * the framework that serves its endpoints (fastapi, express) is bound there
 * and nowhere else. Telling it to extract its web framework behind a data
 * seam was wrong. What a Portal may not bind is a data layer's technology:
 * one an Adapter, Store, Registry, Index or Observer of the tree binds too is
 * a reach past its own seam into theirs — said without any vendor list, from
 * the tree's own declarations. Logic that binds one directly has no seam to
 * swap at. WHERE the technology's name may then appear is
 * technology-boundaries' question.
 */

/** Stereotypes that may legitimately bind a technology directly. */
const DATA_LAYER = new Set(['Adapter', 'Store', 'Registry', 'Index', 'Observer']);

export const technologyBindingRule: SddRule = {
  name: 'technology-binding',
  judges: 'design',
  description:
    "Only the stereotypes that sit at a technology seam (Adapter/Store/Registry/Index, Observer — the edge block that subscribes to a messaging technology — and a Portal, the transport seam, which binds the framework that serves its endpoints) should bind a technology directly: an L4 that declares `technologies` on logic has no swap seam. A Portal binding a technology an Adapter, Store, Registry, Index or Observer of the tree also binds is reaching past its own seam into theirs, and is reported. No hardcoded vendor lists — only declared tokens are policed, so the rule never fires on a tree that doesn't opt in.",
  codes: [
    { code: 'TECH_ON_LOGIC_COMPONENT', defaultSeverity: 'warning', summary: "Technology bound by a stereotype that sits at no technology seam, or a Portal binding a technology a data-layer stereotype binds" },
  ],
  check(ctx) {
    const componentOf = (contract: string) => {
      const intf = ctx.interfaceMap.get(contract);
      return intf ? ctx.componentMap.get(intf.component) : undefined;
    };
    // The technologies the data-layer seams bind: what a Portal may not.
    const dataLayer = new Set(ctx.implementations
      .filter(impl => DATA_LAYER.has(componentOf(impl.contract)?.componentType ?? ''))
      .flatMap(impl => (impl.technologies ?? []).map(t => technologyName(t).toLowerCase())));
    for (const impl of ctx.implementations) {
      const comp = componentOf(impl.contract);
      // A dangling contract is the hierarchy rule's finding, not this one's.
      if (!impl.technologies?.length || !comp || DATA_LAYER.has(comp.componentType)) continue;
      if (comp.componentType === 'Portal') {
        const reached = impl.technologies.map(technologyName).filter(name => dataLayer.has(name.toLowerCase()));
        if (reached.length === 0) continue;
        ctx.addIssue(
          'warning',
          'TECH_ON_LOGIC_COMPONENT',
          `Implementation "${impl.id}" binds ${reached.join(', ')} on Portal "${comp.id}", a technology a data-layer component of this tree binds too. A Portal is the transport seam: it binds the framework that serves its endpoints, and reaches the data layer only through the components that bind it — drop ${reached.length === 1 ? 'it' : 'them'} from this implementation's technologies.`,
          impl.id,
          ctx.isImplementationDraft(impl),
        );
        continue;
      }
      ctx.addIssue(
        'warning',
        'TECH_ON_LOGIC_COMPONENT',
        `Implementation "${impl.id}" binds technology (${impl.technologies.map(technologyName).join(', ')}) on component "${comp.id}" (${comp.componentType}). Technology belongs behind a data-layer seam — extract an Adapter (or Store/Registry/Index) behind an intent interface and let this component depend on that.`,
        impl.id,
        ctx.isImplementationDraft(impl),
      );
    }
  },
};
