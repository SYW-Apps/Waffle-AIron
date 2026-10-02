import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Member declarations: a project declares its members in project.yaml
// `members`. The legacy L1 mount — a subsystem carrying projectPath — still
// loads for one release; each one is reported with the entry that replaces it
// and the fields `doctor --fix` will carry into the member.
//
// The rule does no I/O. The scan reads every legacy mount as the member
// declaration it is (never as a subsystem) and records it, as written, on the
// member's node (ctx.projectFamily.nodes[].legacyMount).
// ---------------------------------------------------------------------------

/** The mount fields that are the declaration itself, not content to carry. */
const DECLARATION_FIELDS = new Set(['id', 'name', 'description', 'parentSystem', 'projectPath', 'status', 'createdAt', 'updatedAt']);

/** Every field a mount carries beyond its declaration, that the migration moves into the member. */
function carriedFields(mount: Record<string, unknown>): string[] {
  return Object.entries(mount)
    .filter(([field, value]) => !DECLARATION_FIELDS.has(field) && value !== undefined
      && !(Array.isArray(value) && value.length === 0)
      && !(typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0))
    .map(([field]) => field);
}

export const memberDeclarationsRule: SddRule = {
  name: 'member-declarations',
  judges: 'design',
  description:
    "A project declares its members in project.yaml `members`, each by one source in one grammar. A deprecated declaration form loads for one release and is reported (DEPRECATED_MOUNT_FORM, notice): the L1 form — a subsystem carrying projectPath — naming the mount, its path, the `members` entry that replaces it, and every field it carries that `doctor --fix` will move into the member (or stop on); a mount whose alias `members` also declares is reported as ignored; and (stage 8) the long-form `path` key, naming the `source` (or shorthand) `doctor --fix` rewrites it to. Since stage 8 it also judges what each member of the bound project IS against what is declared or written about it, from the scan's problems at the bound root (a member's own members are that member's gate's): what a member is follows from its content — an id, an L0 or a lock make it a project, anything else a part — and every contradiction is ONE finding, MEMBER_KIND_MISMATCH (error), naming the alias and the contradiction: an asserted `as` the content contradicts; a part whose configuration declares project fields (members, externals, rules, extensions, composition, targets) without the id that would make it a project (add the id, or move them to the parent); a non-contained part with no PartOf, or one naming another project (opened alone it could not say what it belongs to); a contained member declaring PartOf; a `use` on a member whose content is a part (its names are already this project's own). A part whose files could not be read — its directory absent, or its git commit not cached and not fetchable (offline, refused, unknown) — is PART_UNAVAILABLE (error): the project's own subsystems are missing, so its verdict cannot be a pass. The member findings name no spec: members live in configuration. It reads the project graph's nodes, their legacy mounts, the bound root's declared members and its problems.",
  codes: [
    { code: 'DEPRECATED_MOUNT_FORM', defaultSeverity: 'notice', summary: "A member declared in a deprecated form — an L1 subsystem carrying projectPath, or (stage 8) the long-form `path` key — which doctor --fix rewrites to a `members` entry with one `source`." },
    { code: 'MEMBER_KIND_MISMATCH', defaultSeverity: 'error', summary: "What a member's content makes it (an id, L0 or lock: a project; else a part) contradicts what is declared or written about it: an asserted `as`, project fields in a part, a missing or wrong PartOf, a `use` on a part." },
    { code: 'PART_UNAVAILABLE', defaultSeverity: 'error', summary: "A part's files could not be read (absent directory, unpinned or unfetchable git commit): the project's own subsystems are missing." },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    // Steps 4-5: every member declared in the legacy form.
    for (const node of family.nodes) {
      const mount = node.legacyMount;
      if (!mount || node.namespace === '') continue;
      if (!ctx.isSpecInScope(node.namespace)) continue;
      const parent = node.parent === '' || node.parent === undefined ? 'this project' : `project "${node.parent}"`;
      const alias = node.mountAlias ?? mount.id;
      const entry = `\`members: { ${alias}: ${mount.projectPath} }\``;
      if (node.mountForm === 'members') {
        ctx.addIssue(
          'notice',
          'DEPRECATED_MOUNT_FORM',
          `${parent[0].toUpperCase()}${parent.slice(1)} declares the member "${alias}" twice: in .wai/project.yaml \`members\` and as the L1 subsystem "${mount.id}" carrying projectPath "${mount.projectPath}". The \`members\` entry is the declaration; the L1 mount is ignored — delete it once its fields are carried.`,
          node.namespace,
        );
        continue;
      }
      const carried = carriedFields(mount as unknown as Record<string, unknown>);
      ctx.addIssue(
        'notice',
        'DEPRECATED_MOUNT_FORM',
        `${parent[0].toUpperCase()}${parent.slice(1)} declares the member "${alias}" as the L1 subsystem "${mount.id}" carrying projectPath "${mount.projectPath}" — a member is not a subsystem and carries no content in its parent. Declare it in .wai/project.yaml as ${entry}${mount.description ? ' (its description moves to the long form)' : ''}; \`doctor --fix\` moves it${carried.length ? `, and carries ${carried.map((f) => `\`${f}\``).join(', ')} into the member or stops on a conflict` : ''}.`,
        node.namespace,
      );
    }
    // Steps 6-7 (stage 8): each member problem at the bound root — a member's
    // own members are that member's gate's. The findings name no spec: members
    // live in configuration.
    for (const member of ctx.declaredMembers ?? []) {
      if (!member.deprecatedPath || member.problem) continue;
      const written = member.path ?? member.source.path ?? '';
      const rest = member.description !== undefined || member.use.length > 0 || member.as !== undefined;
      ctx.addIssue(
        'notice',
        'DEPRECATED_MOUNT_FORM',
        `This project declares the member "${member.alias}" with the long-form \`path\` key, which stage 8 replaced by the one location key \`source\`. `
        + `\`doctor --fix\` rewrites it to ${rest ? `\`source: ${written}\` in its long form` : `the shorthand \`${member.alias}: ${written}\``} — its meaning unchanged.`,
      );
    }
    for (const problem of family.problems) {
      if (problem.projects[0] !== '') continue;
      if (problem.kind === 'kind-mismatch') {
        ctx.addIssue('error', 'MEMBER_KIND_MISMATCH', `Member "${problem.id}": ${problem.detail}.`);
      } else if (problem.kind === 'part-unavailable') {
        ctx.addIssue('error', 'PART_UNAVAILABLE', `Part "${problem.id}" could not be read — this project's own subsystems stored there are missing, so its verdict cannot be a pass: ${problem.detail}.`);
      }
    }
    // Step 8: judged.
  },
};
