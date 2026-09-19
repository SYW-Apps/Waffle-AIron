import { implementationSourceFiles, pathKey, typeSourceFiles } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec Level 1, asked the other way round: is there code nobody designed?
//
// Every other conformance rule starts from a spec and asks what the code does
// about it. A file no spec ever names is invisible to all of them — it cannot
// be unrealized, undeclared or unwired, because nothing points at it. That is
// the one gap a spec-driven gate cannot close from the spec side, and it is
// where a codebase quietly drifts away from its design.
//
// Two decisions make the check shippable rather than a flood:
//
//  1. OPT-IN DOMAIN. The rule judges the files under `rules.conformance.
//     sourceRoots` and nothing else. A project that declares no root walks no
//     files, so upgrading wairon never turns a clean tree red, and the roots
//     are the project's own statement of where its code lives.
//
//  2. A ONE-WAY DEBT REGISTER, not a suppression. `rules.conformance.unclaimed`
//     lists the files that are unclaimed today. A lint.allow would hide one
//     finding behind one spec, forever, where only a reader of that spec sees
//     it; this list is the whole debt in one reviewable place. It can only
//     shrink: an entry that is now claimed, or proven a barrel, or that the
//     walk no longer finds, is STALE_UNCLAIMED_ENTRY and must be deleted. The
//     list is therefore EXACTLY the set of files that would otherwise fire —
//     which is what makes "the list cannot grow silently" a property and not
//     a hope, since a new unclaimed file fires on the day it appears.
//
// The one exemption is stated as a rule, not buried in a condition: a PURE
// RE-EXPORT BARREL — a file whose every top-level statement re-exports another
// module — declares nothing of its own, so there is nothing in it for a spec
// to claim. Only exact analysis can prove that (a weaker grade cannot tell a
// barrel from a file it failed to parse), and an unproven barrel is judged
// like any other file rather than let off on a guess.
// ---------------------------------------------------------------------------

export const unclaimedSourceRule: SddRule = {
  name: 'unclaimed-source',
  description:
    'Code↔spec Level 1, asked the other way round: every source file under the project\'s declared source roots must be named by some spec — an implementation\'s sourcePath, a method\'s, a simPath, or a type\'s — or be carried in the frozen `rules.conformance.unclaimed` list. A pure re-export barrel declares nothing of its own and only republishes other modules, so it has no code to claim and is exempt (exact grade only: a weaker grade cannot tell a barrel from a file it failed to parse). Declaring no source roots leaves the check silent, which is what makes it opt-in; the unclaimed list is a one-way debt register, so an entry the walk no longer finds unclaimed must be deleted and the list can only shrink.',
  codes: [
    { code: 'UNCLAIMED_SOURCE_FILE', defaultSeverity: 'warning', summary: 'A source file under a declared source root that no spec names and the frozen unclaimed list does not carry — code nobody designed' },
    { code: 'STALE_UNCLAIMED_ENTRY', defaultSeverity: 'warning', summary: 'An entry of the frozen unclaimed list names a file that is now claimed, or that the source-root walk no longer finds — delete it, the list only shrinks' },
  ],

  check(ctx: RuleContext): void {
    const walked = ctx.codeModel.rootFiles;
    const listed = (ctx.rules?.conformance?.unclaimed ?? []).map(pathKey);
    // No root declared: nothing was walked, so there is nothing to judge — and
    // a stale-entry audit against an empty walk would accuse every entry of
    // being stale for a reason the reader did not choose. Silent means silent.
    if (walked.length === 0) return;

    // Every file a spec names, whatever the spec: an implementation's own
    // sourcePath and its methods', the integration harness it commits, and a
    // type's own and per-method paths.
    const claimed = new Set<string>();
    for (const impl of ctx.implementations) {
      for (const file of implementationSourceFiles(impl)) claimed.add(pathKey(file));
      if (impl.simPath) claimed.add(pathKey(impl.simPath));
    }
    for (const type of ctx.types) {
      for (const file of typeSourceFiles(type)) claimed.add(pathKey(file));
    }

    const code = ctx.codeIndex();
    /** A file with nothing to claim: proven, at exact grade, to declare nothing of its own. */
    const isBarrel = (file: string): boolean => code.factsAt(file)?.reexportOnly === true;
    /** What the list is for: a walked file that would otherwise be reported. */
    const isLiveDebt = (file: string): boolean => !claimed.has(file) && !isBarrel(file);

    const listedSet = new Set(listed);
    for (const file of walked) {
      if (!isLiveDebt(file)) continue;
      if (listedSet.has(file)) continue;
      ctx.addIssue(
        'warning',
        'UNCLAIMED_SOURCE_FILE',
        `Source file "${file}" is under a declared source root but no spec names it — give it to a spec as a `
        + 'sourcePath (an implementation\'s, a method\'s, or a type\'s), or carry it in `rules.conformance.unclaimed` '
        + 'until it is designed.',
      );
    }

    const walkedSet = new Set(walked);
    for (const entry of listed) {
      if (walkedSet.has(entry) && isLiveDebt(entry)) continue;
      const why = !walkedSet.has(entry)
        ? 'the source-root walk no longer finds it (deleted, renamed, excluded, or outside the declared roots)'
        : isBarrel(entry)
          ? 'it is a pure re-export barrel, which has nothing to claim'
          : 'a spec now names it';
      ctx.addIssue(
        'warning',
        'STALE_UNCLAIMED_ENTRY',
        `"${entry}" is carried in \`rules.conformance.unclaimed\` but ${why} — delete the entry; the list only shrinks.`,
      );
    }
  },
};
