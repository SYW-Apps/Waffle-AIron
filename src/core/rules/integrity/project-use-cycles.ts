import { SddRule } from '../types.js';
import type { CrossProjectReference } from '../../../models/project-family.js';

// ---------------------------------------------------------------------------
// Project use cycles: projects of one family use each other through
// `alias::name` references. Containment (members) and parts are no use, so a
// member using its parent is the ordinary one-way shape; a loop of uses is
// refused, as a crate, module or package cycle is in the languages the code is
// written in. The rule does no I/O; it reads the project graph.
// ---------------------------------------------------------------------------

/** The display name of a project key: '' is the bound project. */
function projectName(key: string, ids: ReadonlyMap<string, string>): string {
  return ids.get(key) ?? (key === '' ? 'this project' : key);
}

export const projectUseCyclesRule: SddRule = {
  name: 'project-use-cycles',
  judges: 'design',
  description:
    "Projects of one family use each other through `alias::name` references: a dependsOn, a call, register or dispatch step, an implements entry, a type position or a re-export naming another project's public name (project_family.references, consumer to producer). Membership is containment and a part is its parent's own subsystems, so neither is a use: a member that uses its parent (a plugin implementing its host's abstraction) is the ordinary one-way shape. When the uses loop — the bound project uses a project that, directly or through others, uses it back — neither side can be built, versioned or approved before the other, as a crate, module or package cycle is refused in the languages the code is written in: PROJECT_USE_CYCLE (error), once, naming the projects around the loop in order and one reference that makes each edge, with the fix: move what both sides use (an abstraction and its types, say) into a project of its own that each uses, or make the member a part again (member demote), whose names are its parent's own. It reads the project graph's nodes and references; a candidate run with no graph reports nothing. A family migration's dry run validates the planned family, so it foretells the finding.",
  codes: [
    { code: 'PROJECT_USE_CYCLE', defaultSeverity: 'error', summary: 'The bound project uses a project that, directly or through others, uses it back: no side can be built, versioned or approved before the other. Move what both use into a project of its own, or make the member a part again.' },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Step 4: the use graph, consumer to producer, the first reference of each edge its witness.
    const edges = new Map<string, Map<string, CrossProjectReference>>();
    for (const ref of family.references) {
      if (ref.consumer === ref.producer) continue;
      const out = edges.get(ref.consumer) ?? new Map<string, CrossProjectReference>();
      if (!out.has(ref.producer)) out.set(ref.producer, ref);
      edges.set(ref.consumer, out);
    }
    // Step 5: the shortest loop through the bound project, breadth first from it.
    const previous = new Map<string, string>();
    const queue: string[] = [''];
    let closing: string | undefined;
    while (queue.length > 0 && closing === undefined) {
      const at = queue.shift()!;
      for (const next of edges.get(at)?.keys() ?? []) {
        if (next === '') { closing = at; break; }
        if (previous.has(next)) continue;
        previous.set(next, at);
        queue.push(next);
      }
    }
    if (closing === undefined) return;
    // Step 6: the loop in order, each edge with its witness, and the fix.
    const path: string[] = [closing];
    while (path[0] !== '') path.unshift(previous.get(path[0])!);
    path.push('');
    const ids = new Map(family.nodes.map((n) => [n.namespace, n.id ?? n.mountAlias ?? n.namespace] as [string, string]));
    const hops = path.slice(0, -1).map((from, i) => {
      const witness = edges.get(from)!.get(path[i + 1])!;
      return `${projectName(from, ids)} uses ${projectName(path[i + 1], ids)} (${witness.specId}: "${witness.authored}")`;
    });
    ctx.addIssue('error', 'PROJECT_USE_CYCLE',
      `The projects use each other in a loop: ${hops.join('; ')}. No side can be built, versioned or approved before the other. Move what both sides use (an abstraction and its types, say) into a project of its own that each uses, or make the member a part again (member demote), whose names are its parent's own.`);
    // Step 7: judged.
  },
};
