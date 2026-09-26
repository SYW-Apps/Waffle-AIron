import { SddRule, type RuleContext } from '../types.js';
import {
  declares,
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
// dependency it declared — a member it mounts, or an external it names in
// project.yaml.
//
// The rule does no I/O and resolves nothing. The validator hands over the
// project graph (ctx.projectFamily: owners, cross-project references) and the
// export usages (ctx.exportUsages: which of those references land on a public
// name); each fact becomes one finding. All three codes are notices in stage 2:
// references keep their old forms until stage 3 rewrites them to alias::name.
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
  return node.namespace === '' ? `"${id}"` : `"${id}" (mounted at "${node.namespace}")`;
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
    'Every project is a crate of its own (decision 9): another project reaches it only through its L0 exports, and only as a dependency it declared. A reference that reaches another project the referring project neither mounts as a member nor declares as an external is EXTERNAL_UNDECLARED; a reference that reaches another project at anything but a public name whose audience covers the referrer — an L1-published or internal component, a method outside the entry\'s narrowing, a type neither exported by name nor in an exported signature\'s closure — is EXTERNAL_NOT_EXPORTED; and a trustedLinks entry that names a subsystem of another project is TRUSTED_LINK_CROSSES_PROJECT, since a sanctioned fast lane stays inside one project. A reference is one of the positions CrossProjectReference lists, judged from the project graph (owner of the referring spec versus producer of the target) and the export usages; a reference whose producer the scan cannot place is left to the resolve-through-parent verdict.',
  codes: [
    { code: 'EXTERNAL_UNDECLARED', defaultSeverity: 'notice', summary: 'A reference reaches another project that the referring project neither mounts nor declares as an external' },
    { code: 'EXTERNAL_NOT_EXPORTED', defaultSeverity: 'notice', summary: 'A reference reaches another project at anything but a public name whose audience covers the referrer' },
    { code: 'TRUSTED_LINK_CROSSES_PROJECT', defaultSeverity: 'notice', summary: 'A trustedLinks entry names a subsystem of another project' },
  ],
  check(ctx) {
    // Step 1: the graph and the export usages.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries no graph.
    if (!family) return;
    // Steps 4-7: every cross-project reference must be a declared dependency.
    const reported = new Set<string>();
    for (const ref of family.references) {
      if (declares(family, ref.consumer, ref.producer)) continue;
      const key = `${ref.specId}|${ref.producer}|${ref.target}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const consumer = familyNode(family, ref.consumer);
      const producer = familyNode(family, ref.producer);
      ctx.addIssue(
        'notice',
        'EXTERNAL_UNDECLARED',
        `"${ref.specId}" reaches "${ref.target}" (${ref.position}) in project ${label(producer, ref.producer)}, which project ${label(consumer, ref.consumer)} neither mounts nor declares as an external — a project reaches another only as a dependency it declared. Declare it in ${ref.consumer === '' ? 'this project\'s' : `the member at "${ref.consumer}"'s`} .wai/project.yaml with ${declaration(producer)}.`,
        ref.specId,
        draftOf(ctx, ref.specId),
      );
    }
    // Steps 8-9: every reference that lands on no public name the referrer may see.
    for (const usage of ctx.exportUsages ?? []) {
      const producer = familyNode(family, usage.producer);
      for (const ref of usage.unexported) {
        ctx.addIssue(
          'notice',
          'EXTERNAL_NOT_EXPORTED',
          `"${ref.specId}" reaches "${ref.target}"${ref.member ? ` (${ref.member})` : ''} (${ref.position}) in project ${label(producer, usage.producer)}, which exports no public name covering it — another project may reach it only through an L0 export whose audience covers the referrer. Export it from that project's L0 (audience project reaches the family) and reach it there.`,
          ref.specId,
          draftOf(ctx, ref.specId),
        );
      }
    }
    // Steps 10-14: a trusted link stays inside its project.
    for (const sub of ctx.subsystems) {
      const home = ownerOf(family, sub.id);
      if (!home) continue;
      for (const link of sub.trustedLinks ?? []) {
        // Step 11: the loader leaves trustedLinks raw, so qualify from the declaring subsystem's project.
        const producer = producerOf(family, link.subsystem, home.namespace);
        // Step 12: unknown, or its own project.
        if (!producer || producer.namespace === home.namespace) continue;
        // Step 13.
        ctx.addIssue(
          'notice',
          'TRUSTED_LINK_CROSSES_PROJECT',
          `Subsystem "${sub.id}" declares a trusted link to "${link.subsystem}", a subsystem of project ${label(producer, producer.namespace)} — a trusted link waives the client-Adapter shim inside one project and cannot pierce a project boundary. Reach the other project through its exports.`,
          sub.id,
          isDraftSubsystem(sub),
        );
      }
    }
    // Step 15: judged.
  },
};
