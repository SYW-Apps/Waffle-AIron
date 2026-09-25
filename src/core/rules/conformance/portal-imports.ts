import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Portal imports (code↔spec Level 2, where a crossing lands)
//
// dependency-conformance asks whether a cross-subsystem import is DECLARED;
// this asks where it LANDS. A runtime import that crosses a subsystem boundary
// must land on a file realizing one of the target subsystem's published
// components — its portal file. An import that reaches past the portal into a
// concrete module can use anything that module exports, published or not, so
// the portal stops being the boundary and names no contract ever promised
// leak across it. In-process that is cosmetic at runtime; it is not cosmetic
// for the contract.
//
// It reads the same closed file set dependency-conformance judges (the
// component-mapped exact-grade files), so the two rules read one graph. Type-
// only imports never reach the model; re-exports are surface republication and
// not judged here (an adapter module re-exporting a portal is the sanctioned
// shape). Chained subprojects validate standalone.
// ---------------------------------------------------------------------------

export const portalImportsRule: SddRule = {
  name: 'portal-imports',
  description:
    'A runtime import that crosses a subsystem boundary must land on a file that realizes one of the target subsystem\'s PUBLISHED components — its portal file. dependency-conformance asks whether the hop is declared; this asks where it lands. An import that reaches past the portal into a concrete module can use anything that module exports, published or not, so the portal stops being the boundary and names no contract ever promised leak across it — which is how a surface grows that nobody designed. In-process it is cosmetic at runtime; it is not cosmetic for the contract. Only exact-grade component-mapped files participate; type-only imports are exempt; chained subprojects validate standalone.',
  codes: [
    {
      code: 'IMPORT_BYPASSES_PORTAL',
      defaultSeverity: 'warning',
      summary: 'A runtime import crosses into another subsystem through a file that realizes none of its published components',
      carryable: true,
    },
  ],

  check(ctx: RuleContext): void {
    // 1. the mapped files, and the import graph closed over exactly them
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();
    const mappedPaths = new Set(realization.paths.filter(p => code.exactPaths.has(p)));
    const graph = ctx.importGraph(mappedPaths);

    // 2. each subsystem's portal files
    const portalFiles = new Map<string, Set<string>>();
    const portalFilesOf = (subsystemId: string): Set<string> => {
      let files = portalFiles.get(subsystemId);
      if (!files) {
        files = new Set<string>();
        for (const compId of ctx.publicSet.get(subsystemId) ?? []) {
          for (const f of realization.filesOf(compId)) if (mappedPaths.has(f)) files.add(f);
        }
        portalFiles.set(subsystemId, files);
      }
      return files;
    };
    const draftAt = (path: string): boolean =>
      realization.implementationsAt(path).some(impl => ctx.isImplementationDraft(impl));

    // 3. every runtime import edge between mapped files
    for (const fromPath of mappedPaths) {
      const fromSubsystems = new Set(realization.componentsAt(fromPath).map(c => c.subsystem));
      for (const toPath of graph.importsOf(fromPath)) {
        // 4. the subsystems the import crosses into
        const crossed = [...new Set(realization.componentsAt(toPath).map(c => c.subsystem))]
          .filter(s => !fromSubsystems.has(s));
        // 5. crossing somewhere other than the portal file?
        const bypassed = crossed.filter(s => !portalFilesOf(s).has(toPath));
        if (bypassed.length === 0) continue;
        // 6. report
        for (const subsystemId of bypassed) {
          const portals = [...portalFilesOf(subsystemId)];
          ctx.addIssue(
            'warning',
            'IMPORT_BYPASSES_PORTAL',
            `"${fromPath}" imports "${toPath}", crossing into subsystem "${subsystemId}" somewhere other than its portal file (${portals.length > 0 ? portals.join(', ') : 'none realized at exact grade'}). Import the name from the portal file instead; when no portal of "${subsystemId}" publishes it, it is a surface the provider never promised — publish it on the contract of the portal whose capability it is, or stop depending on it.`,
            realization.implementationsAt(fromPath)[0]?.id,
            draftAt(fromPath) || draftAt(toPath),
            undefined,
            // One import edge, one indivisible fact: the EDGE is the site.
            { at: `${fromPath} -> ${toPath}` },
          );
        }
      }
    }
    // 7. done: every crossing import judged
  },
};
