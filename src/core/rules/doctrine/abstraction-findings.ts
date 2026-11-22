import { SddRule } from '../types.js';

/**
 * The finding codes an abstraction's method declares are what a caller may
 * meet, and only some implementers need raise each: a code stands when at
 * least one concrete implementer declares it on its own method of that name.
 */
export const abstractionFindingsRule: SddRule = {
  name: 'abstraction-findings',
  judges: 'design',
  description:
    "The finding codes an abstraction's method declares are what a caller of the abstraction may meet, and only some implementers need raise each (one carrier takes several parcels in a shipment, another refuses them): a code stands when at least one concrete implementer, direct or through the chain (ctx.implementersOf), declares it on its own method of that name, whose code finding-realization then holds to it, and one that none declares is ABSTRACTION_FINDING_UNRAISED. An abstract implementer declaring it raises nothing. An abstraction nothing concrete implements yet (abstractions reports it), or one other projects implement (it, or an abstraction below it, exported with role implement), is not judged. A code only an implementer declares is that implementer's own, a special state of one carrier, and is never reported: the abstraction need not grow with each implementer.",
  codes: [
    { code: 'ABSTRACTION_FINDING_UNRAISED', defaultSeverity: 'warning', summary: 'A finding code an abstraction\'s method declares that no concrete implementer, direct or through the chain, declares on that method: callers would handle a code nobody raises; a code only an implementer declares is its own and is never reported' },
  ],
  check(ctx) {
    // Step 1: the abstractions other projects implement.
    const exposed = new Set<string>();
    for (const table of ctx.exportTables ?? []) {
      for (const e of table.entries) if (e.kind === 'component' && e.role === 'implement' && e.component) exposed.add(e.component);
    }
    const isAbstract = (id: string): boolean => ctx.componentMap.get(id)?.abstract === true;

    // Steps 2-4: each code each abstraction's method declares.
    for (const comp of ctx.components) {
      if (comp.abstract !== true) continue;
      const below = ctx.implementersOf(comp.id);
      const concrete = below.filter((id) => ctx.componentMap.has(id) && !isAbstract(id));
      if (concrete.length === 0) continue;
      if (exposed.has(comp.id) || below.some((id) => isAbstract(id) && exposed.has(id))) continue;
      for (const method of ctx.interfaceMethodsOf(comp.id)) {
        const seen = new Set<string>();
        for (const finding of method.findings ?? []) {
          if (seen.has(finding.code)) continue;
          seen.add(finding.code);
          // Step 3: one concrete implementer declaring it on its own method of that name is enough.
          const raised = concrete.some((id) =>
            ctx.interfaceMethodsOf(id).some((m) => m.name === method.name && (m.findings ?? []).some((f) => f.code === finding.code)));
          if (raised) continue;
          // Step 4.
          ctx.addIssue(
            'warning',
            'ABSTRACTION_FINDING_UNRAISED',
            `Abstraction "${comp.id}" declares the finding code ${finding.code} on "${method.name}", but no concrete implementer declares it on its own "${method.name}". Callers of the abstraction would handle a code nobody raises: declare it on the contract of each implementer that raises it, or remove it from the abstraction. A code only an implementer declares is that implementer's own and is never judged here.`,
            comp.id,
            ctx.isComponentDraft(comp.id),
            undefined,
            // The code is the site; the method is a unit, which follows a rename of either.
            { at: finding.code, covers: [`${comp.id}.${method.name}`] },
          );
        }
      }
    }
  },
};
