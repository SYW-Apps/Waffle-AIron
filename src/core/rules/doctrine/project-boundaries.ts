import { SddRule, type RuleContext } from '../types.js';
import {
  familyNode,
  isDraftSubsystem,
  ownerOf,
  producerOf,
  PROJECT_ID_RE,
  EXTERNAL_ALIAS_RE,
  type ProjectNode,
} from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Project boundaries: every project is a crate of its own (decision 9).
// Another project reaches it only through its L0 exports, and only as a
// dependency it declared — a member it contains, or an external it names in
// project.yaml. This rule is the ONE judge of every cross-project reference
// the bound project writes (stage 4).
//
// The rule does no I/O and resolves nothing itself: the rule context's
// resolveCrossProject decides each reference's outcome from the project's own
// files (its scan, its members' live tables, its pins) before any severity,
// and each outcome but resolved becomes one finding carrying that resolution.
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

/** How a project reads in a finding. */
function label(node: ProjectNode | null, namespace: string): string {
  if (!node) return `"${namespace}"`;
  const id = node.id ?? node.name ?? '(no id)';
  return node.namespace === '' ? `"${id}"` : `"${id}" (keyed "${node.namespace}")`;
}

/** The `externals` entry that would declare the producer. */
function declaration(producer: ProjectNode | null): string {
  const id = producer?.id;
  if (!id || !PROJECT_ID_RE.test(id)) return 'an `externals` entry naming it (it has no usable id yet — declare one first)';
  return EXTERNAL_ALIAS_RE.test(id) ? `\`externals: { ${id}: {} }\`` : `\`externals: { ${id.replace(/\./g, '-')}: { project: ${id} } }\``;
}

export const projectBoundariesRule: SddRule = {
  name: 'project-boundaries',
  description:
    "The one judge of every cross-project reference the bound project writes (decision 9 — every project is a crate of its own, reached only through its L0 exports and only as a dependency it declared). It reads each of the project's own references from the project graph — `::` forms and bare names bound through `use` imports alike — takes its resolution from resolveCrossProject, decided before any severity from the project's own files alone, and reports every outcome but resolved once, carrying the resolution: forbidden is EXTERNAL_UNDECLARED (the reference reaches a project the referrer declares neither as a member nor as an external, or names a first segment that is none of its subsystems, aliases or foreign providers); missing is EXTERNAL_NOT_EXPORTED (the producer's table — a contained member's live one, or the external's pin — has no public name covering the referrer, or not the used method, or exports the type only inside a signature's closure); an ambiguous import is IMPORT_AMBIGUOUS (two imports supply one bare name: two explicit `use` names, or two `*` with no explicit one — name it `alias::name` or narrow a `use`); unavailable is EXTERNAL_CHECK_UNAVAILABLE (no pin, an unreadable pin, a member absent on disk, or a deprecated form naming no alias — never a pass). A bare name no import supplies is not this rule's: it is the unresolved-reference finding it always was, with rule_context.importHint appended. A trustedLinks entry naming a subsystem of another project (`alias::sub`) is TRUSTED_LINK_CROSSES_PROJECT: a sanctioned fast lane stays inside one project. Stage 4 makes the three stage-2 notices errors now that the owner's gate judges them exactly; a reference is never left to a parent's verdict.",
  codes: [
    { code: 'EXTERNAL_UNDECLARED', defaultSeverity: 'error', summary: "A reference reaches another project the referring project declares neither as a member nor as an external, or names a first segment that is none of its subsystems, aliases or foreign providers" },
    { code: 'EXTERNAL_NOT_EXPORTED', defaultSeverity: 'error', summary: "A reference reaches another project at anything but a public name, or a member of one, whose audience covers the referrer" },
    { code: 'TRUSTED_LINK_CROSSES_PROJECT', defaultSeverity: 'error', summary: "A trustedLinks entry names a subsystem of another project" },
    { code: 'EXTERNAL_CHECK_UNAVAILABLE', defaultSeverity: 'warning', summary: "A reference into another project has nothing to be judged against: no pin, an unreadable pin, a member absent on disk, or a deprecated form naming no alias" },
    { code: 'IMPORT_AMBIGUOUS', defaultSeverity: 'error', summary: "Two `use` imports supply one bare name: two explicit names, or two `*` imports with no explicit one" },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Steps 4-14: every reference the bound project's own specs write with
    // `::`, and every bare name it binds through a `use` import — a contained
    // member's references are its own gate's.
    const judged = new Set<string>();
    for (const ref of family.authoredReferences) {
      if ((family.owners.get(ref.specId) ?? '') !== '') continue;
      const key = `${ref.specId}|${ref.position}|${ref.authored}`;
      if (judged.has(key)) continue;
      judged.add(key);
      // Step 5: the resolution, decided before any severity.
      const resolution = ctx.resolveCrossProject(ref.specId, ref.position, ref.authored);
      if (!resolution) continue;
      const draft = draftOf(ctx, ref.specId);
      const where = `"${ref.specId}" writes "${ref.authored}" (${ref.position})`;
      // Step 6: what did it resolve to?
      switch (resolution.outcome) {
        case 'forbidden': {
          // Step 7.
          const producer = ref.producer !== undefined ? familyNode(family, ref.producer) : null;
          const remedy = producer
            ? `, which reaches project ${label(producer, producer.namespace)} — a project this one declares neither as a member nor as an external. Declare it in this project's .wai/project.yaml with ${declaration(producer)}, after which the reference is written \`alias::name\`.`
            : `: ${resolution.reason}. Declare the project it means as a member or an external and write \`alias::name\`, or fix the reference.`;
          ctx.addIssue('error', 'EXTERNAL_UNDECLARED', `${where}${remedy}`, ref.specId, draft, resolution);
          break;
        }
        case 'missing':
          // Step 9.
          ctx.addIssue(
            'error',
            'EXTERNAL_NOT_EXPORTED',
            `${where}, which reaches "${resolution.canonicalTarget}" at no public name the referrer may see: ${resolution.reason}. Another project may reach it only through a public name of its L0 table whose audience covers the referrer — export it from that project's L0 (a project-level type takes one own \`{ typeDef }\` entry) and re-pin, or reach it by a name the producer exports.`,
            ref.specId,
            draft,
            resolution,
          );
          break;
        case 'ambiguous':
          // Step 11: only an import's ambiguity is this rule's; foreign
          // snapshots that disagree are SURFACE_REF_AMBIGUOUS where the edge is judged.
          if (ref.form !== 'import' && !resolution.importedVia) break;
          ctx.addIssue(
            'error',
            'IMPORT_AMBIGUOUS',
            `${where}: ${resolution.reason}. Write it \`alias::name\`, or narrow a \`use\` so one import supplies it.`,
            ref.specId,
            draft,
            resolution,
          );
          break;
        case 'unavailable':
          // Step 13: never a pass.
          ctx.addIssue(
            'warning',
            'EXTERNAL_CHECK_UNAVAILABLE',
            `${where}: ${resolution.reason}. The reference cannot be judged, which is never a pass.`,
            ref.specId,
            draft,
            resolution,
          );
          break;
        default:
          break;
      }
    }
    // Steps 15-19: a trusted link stays inside its project.
    for (const sub of ctx.subsystems) {
      const home = ownerOf(family, sub.id);
      if (!home || home.namespace !== '') continue;
      for (const link of sub.trustedLinks ?? []) {
        // Step 16: the loader leaves trustedLinks raw, so read it the way the scan binds
        // a reference: a bare subsystem id is local, `alias::sub` lands where the alias names.
        const producer = producerOf(family, link.subsystem, home.namespace);
        // Step 17: unknown, or its own project.
        if (!producer || producer.namespace === home.namespace) continue;
        // Step 18.
        ctx.addIssue(
          'error',
          'TRUSTED_LINK_CROSSES_PROJECT',
          `Subsystem "${sub.id}" declares a trusted link to "${link.subsystem}", a subsystem of project ${label(producer, producer.namespace)} — a trusted link waives the client-Adapter shim inside one project and cannot pierce a project boundary. Reach the other project through its exports.`,
          sub.id,
          isDraftSubsystem(sub),
          {
            outcome: 'forbidden', owner: familyNode(family, '')?.id ?? '', callSite: `${sub.id} (trustedLinks)`,
            canonicalTarget: `${producer.id ?? producer.namespace}::${link.subsystem.split('::').pop()}`,
            reason: 'a trusted link cannot cross into another project',
          },
        );
      }
    }
    // Step 20: judged.
  },
};
