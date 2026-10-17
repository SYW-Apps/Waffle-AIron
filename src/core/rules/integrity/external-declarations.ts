import { SddRule, type RuleContext } from '../types.js';
import { nameKey, type PinnedExternal } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// External declarations: every external a project declares in project.yaml
// must be usable, so a misspelled declaration never passes as declared.
//
// The rule does no I/O. The project graph binds the bound root's declarations
// to their producers and records why one could not be bound, the validator
// hands over the project's pins (ctx.pinnedExternals), and the scan the
// members' export tables; each unusable declaration or `use` import becomes a
// finding. The findings name no spec: externals and members live in
// configuration.
// ---------------------------------------------------------------------------

export const externalDeclarationsRule: SddRule = {
  name: 'external-declarations',
  judges: 'design',
  description:
    "Every external a project declares in project.yaml must be usable: its alias fits [a-z0-9-_]+ (a dotted producer id needs an explicit alias) and is not also a `members` key (one alias names one project), its producer id fits the project-id grammar, and it has something to be judged against — a project of the scan answers to the id, source.path names a directory (whose project, when it is in the scan, answers to the declared id), or the project holds a pin for the alias. A declaration that fails is reported (EXTERNAL_UNRESOLVED) with its reason, so a misspelled declaration never passes as declared. A member validated from its own root that declares its parent or a sibling is not reported when it has pinned it: the pin is what its gate judges against, and nothing is climbed to find the producer. Every name an external's or a member's `use` lists by name must be a public name the producer exports to this project — a contained member's live L0 table, an external's pin — compared by nameKey (IMPORT_UNRESOLVED, naming the closest public names; a `use` on an unpinned external is left to the pin's own EXTERNAL_CHECK_UNAVAILABLE), and must not share its nameKey with a spec of the project itself (IMPORT_SHADOWED_BY_LOCAL: the local spec wins every bare reference, so the named import can never take effect and says something false — rename one or drop the import). A `*` import shadowed by locals is silent, as a glob import is in Rust. One code, one meaning: IMPORT_UNRESOLVED is only a name the producer does not export, IMPORT_SHADOWED_BY_LOCAL only a named import a local spec hides. A malformed `use` entry is the declaration's problem (EXTERNAL_UNRESOLVED for an external, the member's for a member). The findings name no spec: externals and members live in configuration. It reads the bound root's node of the project graph, its alias-conflict problems, the members' export tables, the project's own spec ids and ctx.pinnedExternals.",
  codes: [
    { code: 'EXTERNAL_UNRESOLVED', defaultSeverity: 'notice', summary: "A declared external whose alias is malformed or taken by a member, whose producer id is malformed, or whose producer the family and its source.path do not provide" },
    { code: 'IMPORT_UNRESOLVED', defaultSeverity: 'error', summary: "A `use` entry names a public name its producer does not export to this project" },
    { code: 'IMPORT_SHADOWED_BY_LOCAL', defaultSeverity: 'error', summary: "A named `use` import shares its name with a spec of the importing project, so the local spec always wins and the import never takes effect" },
  ],
  check(ctx) {
    // Step 1: the graph.
    const family = ctx.projectFamily;
    // Steps 2-3: a candidate run carries none.
    if (!family) return;
    const node = family.nodes.find((n) => n.namespace === '');
    if (!node) return;
    const pinned = new Map(ctx.pinnedExternals.map((p) => [p.alias, p] as const));
    const reported = new Set<string>();
    // Steps 4-7: each external the bound project declares — a contained
    // member's declarations are its own gate's.
    for (const external of node.externals) {
      // Step 5: unresolved, and no pin to judge against — nothing is climbed.
      if (external.sourceKind !== 'unresolved') continue;
      if (pinned.get(external.alias)?.snapshot && !external.problem?.startsWith('the `use`') && !isMalformed(external.problem)) continue;
      reported.add(external.alias);
      // Step 6: an unpinned producer outside this root is its pin's to judge —
      // say so instead of blaming the declaration.
      const unpinnedOutside = external.problem?.startsWith('no project of the family answers') && !pinned.get(external.alias)?.snapshot;
      ctx.addIssue(
        'notice',
        'EXTERNAL_UNRESOLVED',
        unpinnedOutside
          ? `This project's .wai/project.yaml declares the external "${external.alias}" (producer "${external.project}"), which this project's own gate cannot resolve: no project this root contains answers to "${external.project}", and nothing is pinned for it. A parent or sibling is never climbed to from a project's own gate — its pin is the one thing the gate judges it against. Pin it here (\`wairon externals pin ${external.alias}\`), or give it \`source: { path: <the producer's root> }\`.`
          : `This project's .wai/project.yaml declares the external "${external.alias}" (producer "${external.project}"), which does not resolve: ${external.problem}. Fix the alias or the producer id, add \`source: { path: <the producer's root> }\` to say where it lives, or pin it (\`wairon externals pin\`) so this project's gate has something to judge it against.`,
      );
    }
    // An alias a legacy L1 mount also takes: one alias names one project.
    for (const problem of family.problems) {
      if (problem.kind !== 'alias-conflict' || problem.projects[0] !== '' || !problem.id || reported.has(problem.id)) continue;
      ctx.addIssue(
        'notice',
        'EXTERNAL_UNRESOLVED',
        `This project's .wai/project.yaml declares the external "${problem.id}", and "${problem.id}" also names a member: ${problem.detail}. Rename the external's alias.`,
      );
    }
    // Steps 8-13: each name the bound project imports by name.
    const ownKeys = new Map<string, string>();
    for (const spec of [...ctx.components, ...ctx.interfaces, ...ctx.types]) {
      if ((family.owners.get(spec.id) ?? '') !== '') continue;
      const k = nameKey(spec.id.split('::').pop()!);
      if (!ownKeys.has(k)) ownKeys.set(k, spec.id);
    }
    for (const imported of node.imports) {
      const named = imported.use.filter((u) => u !== '*');
      if (named.length === 0) continue;
      const exported = exportedNames(ctx, node.aliases.get(imported.alias), pinned.get(imported.alias));
      for (const name of named) {
        // Step 9: is it exported? An external with nothing to judge against is skipped:
        // its references already report EXTERNAL_CHECK_UNAVAILABLE.
        if (exported && !exported.some((e) => nameKey(e) === nameKey(name))) {
          // Step 10.
          const closest = closestNames(name, exported);
          ctx.addIssue(
            'error',
            'IMPORT_UNRESOLVED',
            `This project's .wai/project.yaml imports "${name}" from ${imported.section === 'members' ? 'the member' : 'the external'} "${imported.alias}" (\`${imported.section}.${imported.alias}.use\`), which exports no public name "${name}" to this project${closest.length ? ` — did you mean ${closest.map((c) => `"${c}"`).join(' or ')}?` : '.'} Import a name it exports, or export this one from its L0 (and re-pin).`,
          );
        }
        // Steps 11-12: a named import a local spec hides.
        const local = ownKeys.get(nameKey(name));
        if (local !== undefined) {
          ctx.addIssue(
            'error',
            'IMPORT_SHADOWED_BY_LOCAL',
            `This project's .wai/project.yaml imports "${name}" by name from "${imported.alias}" (\`${imported.section}.${imported.alias}.use\`), but its own spec "${local}" shares that name, so every bare reference binds the local spec and the import never takes effect. Rename one, or drop the import and write \`${imported.alias}::${name}\` where the other project's name is meant.`,
          );
        }
      }
    }
    // Step 14: judged.
  },
};

/** Whether an external's problem is its declaration's own (a malformed alias, id or `use`): a pin never excuses it. */
function isMalformed(problem: string | undefined): boolean {
  return problem !== undefined && (problem.startsWith('the alias') || problem.startsWith('the producer id') || problem.startsWith('the `use`'));
}

/** The public names a producer exports to the bound project: a contained member's live table, else the pin; undefined when there is nothing to judge against. */
function exportedNames(ctx: RuleContext, key: string | undefined, pin: PinnedExternal | undefined): string[] | undefined {
  if (key !== undefined) {
    const table = (ctx.exportTables ?? []).find((t) => t.level === 'project' && t.owner === key);
    return table ? table.entries.map((e) => e.publicName) : undefined;
  }
  if (!pin?.snapshot) return undefined;
  return [...pin.snapshot.interfaces.map((e) => e.id), ...(pin.snapshot.exportedTypes ?? []).map((t) => t.id)];
}

/** Up to three exported names closest to the one written, by shared name-key prefix. */
function closestNames(name: string, exported: string[]): string[] {
  const key = nameKey(name);
  const score = (e: string): number => {
    const k = nameKey(e);
    let i = 0;
    while (i < k.length && i < key.length && k[i] === key[i]) i++;
    return i + (k.includes(key) || key.includes(k) ? key.length : 0);
  };
  return exported
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.e < b.e ? -1 : 1))
    .slice(0, 3)
    .map((x) => x.e);
}
