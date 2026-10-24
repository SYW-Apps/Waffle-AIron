import { SddRule } from '../types.js';
import { misplacedGroupFiles } from '../../../models/specs.js';

// ---------------------------------------------------------------------------
// type-groups — type groups are a tree of folders (group_spec.parent) over a
// project's types, layout and presentation only: type ids stay bare and global
// and no reference resolves through a group. Four questions with errors for
// what cannot be followed (a type naming a group no spec declares, a group
// naming a parent that does not exist, a parent in another home, a parent
// chain that leads back to its group) and one softer question about the disk
// (a group or type file outside the folder its chain names), which `wairon
// doctor --fix` repairs by moving the file.
// ---------------------------------------------------------------------------

export const typeGroupsRule: SddRule = {
  name: 'type-groups',
  judges: 'design',
  description:
    'Type groups are a tree of folders (group_spec.parent) over a project\'s types. A type naming a group that no group spec declares is reported (TYPE_GROUP_UNKNOWN); so is a group naming a parent that does not exist (GROUP_PARENT_UNKNOWN) and a parent chain that leads back to its own group (GROUP_CYCLE, once per cycle, naming the groups in it). A group and its parent share one home (the shared types folder or one subsystem\'s): a parent that exists but lives in another home is its own error, GROUP_PARENT_CROSS_HOME, separate from GROUP_PARENT_UNKNOWN because the fix differs (move one of the two, not create a group) and the message can name both homes. Layout is judged last and softer: a group whose file does not sit inside its parent\'s folder, and a type whose file does not sit in its group\'s folder, are TYPE_GROUP_MISPLACED (a warning that `wairon doctor --fix` repairs by moving the file; nothing resolves through the folder, so the design is unaffected). Type ids stay global and bare, so no rule here concerns a type\'s id.',
  codes: [
    { code: 'TYPE_GROUP_UNKNOWN', defaultSeverity: 'error', summary: 'A type names a group that no group spec declares' },
    { code: 'GROUP_PARENT_UNKNOWN', defaultSeverity: 'error', summary: 'A group names a parent group that does not exist' },
    { code: 'GROUP_CYCLE', defaultSeverity: 'error', summary: 'A group\'s parent chain leads back to the group itself' },
    { code: 'TYPE_GROUP_MISPLACED', defaultSeverity: 'warning', summary: 'A group or type file does not sit in the folder its parent chain or group names; doctor --fix moves it' },
    { code: 'GROUP_PARENT_CROSS_HOME', defaultSeverity: 'error', summary: 'A group\'s parent exists but lives in another home (shared folder vs a subsystem\'s, or two subsystems\'); a group and its parent share one home' },
  ],
  check(ctx) {
    // Step 1: the groups by id (an absent list is no groups).
    const groups = ctx.groups ?? [];
    const byId = new Map(groups.map((g) => [g.id, g] as const));
    // Steps 2-3: each grouped type in scope whose group no spec declares.
    for (const t of ctx.types) {
      if (t.group === undefined || t.group === '' || !ctx.isSpecInScope(t.id)) continue;
      if (byId.has(t.group)) continue;
      ctx.addIssue(
        'error',
        'TYPE_GROUP_UNKNOWN',
        `Type "${t.id}" names the group "${t.group}", which no group spec declares. Define it (sdd_add_group) or correct the group on the type — a typo reads as exactly this.`,
        t.id,
      );
    }
    // Steps 4-6: each group's parent, then its loop.
    const home = (id: string | undefined): string => (id === undefined ? '' : byId.get(id)?.subsystem ?? '');
    const homeText = (h: string): string => (h === '' ? 'the shared types folder' : `subsystem "${h}"`);
    const reported = new Set<string>();
    for (const g of groups) {
      if (g.parent === undefined) continue;
      // Step 5: an unknown parent, and one in another home.
      const parent = byId.get(g.parent);
      if (!parent) {
        ctx.addIssue(
          'error',
          'GROUP_PARENT_UNKNOWN',
          `Group "${g.id}" names the parent "${g.parent}", which no group spec declares. Define the parent (sdd_add_group) or omit parent to make "${g.id}" a top-level group.`,
          g.id,
        );
        continue;
      }
      if (home(g.id) !== home(parent.id)) {
        ctx.addIssue(
          'error',
          'GROUP_PARENT_CROSS_HOME',
          `Group "${g.id}" lives in ${homeText(home(g.id))} but its parent "${parent.id}" lives in ${homeText(home(parent.id))}. A group and its parent share one home: move one of the two (sdd_move_spec kind group).`,
          g.id,
        );
      }
      // Step 6: a parent chain that leads back, once per cycle on the smallest id in it.
      const walk: string[] = [g.id];
      let at: string | undefined = g.parent;
      while (at !== undefined && !walk.includes(at)) {
        walk.push(at);
        at = byId.get(at)?.parent;
      }
      if (at === g.id) {
        const key = [...walk].sort().join('\u0000');
        const first = [...walk].sort()[0];
        if (!reported.has(key) && g.id === first) {
          reported.add(key);
          ctx.addIssue(
            'error',
            'GROUP_CYCLE',
            `The parent chain of group "${g.id}" leads back to it: ${[...walk, g.id].join(' > ')}. Re-parent one of the groups (sdd_move_spec kind group) so the chain ends at a top-level group.`,
            g.id,
          );
        }
      }
    }
    // Step 7: layout, judged last. A broken or cyclic chain is not compared (its errors are reported above).
    const misplaced = misplacedGroupFiles(groups, ctx.groupFiles ?? {}, ctx.typeFiles ?? {}, ctx.types);
    for (const m of misplaced) {
      if (m.kind === 'type' && !ctx.isSpecInScope(m.id)) continue;
      ctx.addIssue(
        'warning',
        'TYPE_GROUP_MISPLACED',
        `${m.reason}. \`wairon doctor --fix\` moves the file; nothing resolves through the folder, so the design is unaffected.`,
        m.id,
      );
    }
  },
};
