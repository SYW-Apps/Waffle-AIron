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
    "A project declares its members in project.yaml `members`; a member is not a subsystem and carries no content in its parent. The L1 form — a subsystem carrying projectPath — still loads for one release and is reported (DEPRECATED_MOUNT_FORM), naming the mount, its path, the `members` entry that replaces it, and every field it carries that `doctor --fix` will move into the member (or stop on); a mount whose alias `members` also declares is reported as ignored. It reads the project graph's nodes and their legacy mounts.",
  codes: [
    { code: 'DEPRECATED_MOUNT_FORM', defaultSeverity: 'notice', summary: "A member declared as an L1 subsystem carrying projectPath instead of a project.yaml `members` entry" },
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
    // Step 6: judged.
  },
};
