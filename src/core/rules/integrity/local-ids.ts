import { SddRule, type RuleContext } from '../types.js';
import { isDraftSubsystem } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Local ids: inside one project an id names one spec, and an id without `::`
// is always local.
//
// The rule does no I/O. The scan keeps the first of two declarations of one
// key in one project and records the second as a duplicate-spec problem
// naming both files; the project graph carries the owners and every project's
// alias table. Each fact becomes one finding.
// ---------------------------------------------------------------------------

/** The draft context a finding on this spec takes. */
function draftOf(ctx: RuleContext, specId: string): boolean {
  const sub = ctx.subsystems.find((s) => s.id === specId);
  if (sub) return isDraftSubsystem(sub);
  if (ctx.componentMap.has(specId)) return ctx.isComponentDraft(specId);
  const intf = ctx.interfaceMap.get(specId);
  if (intf) return ctx.isComponentDraft(intf.component);
  const impl = ctx.implementations.find((i) => i.id === specId);
  return impl ? ctx.isImplementationDraft(impl) : false;
}

/** A key's local id: the part after its project's key. */
function localIdOf(key: string, project: string): string {
  return project && key.startsWith(`${project}::`) ? key.slice(project.length + 2) : key;
}

export const localIdsRule: SddRule = {
  name: 'local-ids',
  judges: 'design',
  description:
    "Inside one project an id names one spec, and an id without `::` is always local. Two spec files of one project declaring one key are DUPLICATE_SPEC_ID: whichever the loader kept, every reference to that key — local, or `alias::name` from another project — could mean either, so the tree has no single reading. A local id equal to one of the project's aliases (a `members` or `externals` key) is LOCAL_ID_SHADOWS_PROJECT: the grammar keeps them apart (a bare id is local, `alias::name` crosses), but a reader seeing `billing` beside `billing::invoice_portal` cannot tell a local subsystem from a member, so the shadow is made visible. It reads the project graph's owners, alias tables and duplicate-spec problems.",
  codes: [
    { code: 'DUPLICATE_SPEC_ID', defaultSeverity: 'error', summary: "Two spec files of one project declare the same id" },
    { code: 'LOCAL_ID_SHADOWS_PROJECT', defaultSeverity: 'warning', summary: "A local spec id equals one of the project's aliases (a member or external), so a bare id and the alias read alike" },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Steps 4-5: every key two files of one project declare.
    for (const problem of family.problems) {
      if (problem.kind !== 'duplicate-spec' || problem.id === undefined) continue;
      if (!ctx.isSpecInScope(problem.id)) continue;
      const project = problem.projects[0] === '' ? 'this project' : `project "${problem.projects[0]}"`;
      ctx.addIssue(
        'error',
        'DUPLICATE_SPEC_ID',
        `In ${project}, ${problem.detail}. The loader kept the first; every reference to "${problem.id}" — local, or \`alias::name\` from another project — could mean either, so the tree has no single reading. Rename one of them.`,
        problem.id,
      );
    }
    // Steps 6-9: every local id that reads like one of its project's aliases.
    for (const node of family.nodes) {
      const aliases = new Map<string, string>();
      for (const [alias, producer] of node.aliases) aliases.set(alias, producer === '' ? 'the bound root' : `project "${producer}"`);
      for (const external of node.externals) if (!aliases.has(external.alias)) aliases.set(external.alias, `the external "${external.project}"`);
      if (aliases.size === 0) continue;
      for (const [key, owner] of family.owners) {
        if (owner !== node.namespace) continue;
        const local = localIdOf(key, owner);
        const named = aliases.get(local);
        if (named === undefined || !ctx.isSpecInScope(key)) continue;
        // Step 8.
        ctx.addIssue(
          'warning',
          'LOCAL_ID_SHADOWS_PROJECT',
          `"${key}" has the local id "${local}", which is also this project's alias for ${named}: a bare \`${local}\` is the local spec, while \`${local}::name\` reaches the other project — a reader cannot tell them apart. Rename the spec or the alias.`,
          key,
          draftOf(ctx, key),
        );
      }
    }
    // Step 10: judged.
  },
};
