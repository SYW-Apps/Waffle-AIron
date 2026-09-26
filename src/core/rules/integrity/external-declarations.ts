import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// External declarations: every external a project declares in project.yaml
// must be usable, so a misspelled declaration never passes as declared.
//
// The rule does no I/O. The project graph binds every node's declarations to
// their producers (ctx.projectFamily.nodes[].externals) and records why one
// could not be bound; each unresolved one becomes a finding. The findings name
// no spec: externals live in configuration.
// ---------------------------------------------------------------------------

export const externalDeclarationsRule: SddRule = {
  name: 'external-declarations',
  description:
    'Every external a project declares in project.yaml must be usable: its alias fits [a-z0-9-_]+ (a dotted producer id needs an explicit alias), its producer id fits the project-id grammar, and its producer is found — exactly one project of the family answers to the id, or source.path names a directory (whose project, when it is in the family, answers to the declared id). A declaration that fails is reported (EXTERNAL_UNRESOLVED) with its reason, so a misspelled declaration never passes as declared. The findings name no spec: externals live in configuration. It reads the project graph\'s bound externals.',
  codes: [
    { code: 'EXTERNAL_UNRESOLVED', defaultSeverity: 'notice', summary: 'A declared external whose alias or producer id is malformed, or whose producer the family and its source.path do not provide' },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Steps 4-7: every external every project of the family declares.
    for (const node of family.nodes) {
      const where = node.namespace === '' ? 'This project\'s' : `The member at "${node.namespace}"'s`;
      for (const external of node.externals) {
        if (external.sourceKind !== 'unresolved') continue;
        // Step 6.
        ctx.addIssue(
          'notice',
          'EXTERNAL_UNRESOLVED',
          `${where} .wai/project.yaml declares the external "${external.alias}" (producer "${external.project}"), which does not resolve: ${external.problem}. Fix the alias or the producer id, or add \`source: { path: <the producer's root> }\` to say where it lives.`,
        );
      }
    }
    // Step 8: judged.
  },
};
