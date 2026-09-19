import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// The conformance debt register, audited.
//
// `rules.conformance.unclaimed` froze one answer: the files no spec names.
// This is the same shape for the findings about code a spec DOES name — and
// the reason it is a REGISTER and not a second `lint.allow` is the claim each
// one makes. An allow says "this finding is wrong here, by design"; it is
// meant to outlive everybody, and it is read only by whoever opens that spec.
// An entry here says "this finding is RIGHT, and it is not paid yet". Those
// are different sentences, and a mechanism that cannot tell them apart can
// never be asked how much the tree owes.
//
// Four properties keep them apart. This rule enforces three; the fourth —
// carrying itself — happens in addIssue, where the finding is born.
//
//  1. A CLOSED CODE SET. Only a code a rule declares `carryable` may appear.
//     Anything else is UNCARRYABLE_FINDING, an ERROR: no allow silences it and
//     no --ci waiver excuses it, so widening the set is a reviewed act on the
//     rule that emits the code, never a line somebody added to a config.
//
//  2. EXACTNESS, BOTH WAYS. The register may hold only what would otherwise
//     fire. An entry no finding matched, or one listing a unit the live
//     finding no longer reports, is STALE_CARRIED_FINDING: that much of the
//     debt is paid and the line must go. The register can only shrink, which
//     is what makes its length a number that means something.
//
//  3. NO GROWTH BEHIND AN ENTRY. An aggregating finding — one
//     UNDECLARED_COLOCATED_CALL reporting 23 crossings — is many facts wearing
//     one message. Keyed by code and spec alone, a 24th crossing would be
//     carried by an entry nobody wrote for it. So an entry lists the units it
//     carries and carries the finding only when it lists them ALL.
//
// And every entry states WHY, under one of three kinds, because a register
// that records only what it holds is a suppression list with extra steps: an
// author defect is debt somebody owes, a modelling question is a decision
// nobody has taken, and a shape the analysis cannot read is a limit to live
// with until the reader learns it. A maintainer must be able to tell those
// apart without opening the code.
//
// The audit stays silent where it cannot know. A run that built no code model
// could not have fired a conformance finding at all; a subsystem-scoped run
// never reaches the specs outside it; a code the project switched off emits
// nothing. Calling every entry stale in those runs would be exactly the "for a
// reason the reader did not choose" that the unclaimed list refuses.
// ---------------------------------------------------------------------------

export const carriedDebtRule: SddRule = {
  name: 'carried-debt',
  description:
    'The conformance debt register (`rules.conformance.carried`) holds the code↔spec findings this tree carries as declared, classified debt — `unclaimed`\'s one-way shape, for findings about code a spec does name. It is not a second lint.allow: an allow says a finding is wrong here by design, an entry here says the finding is right and unpaid, and each entry states which of the three kinds it is (drift: spec and code disagree; undecided: the fix waits on a modelling decision nobody has taken; unreadable: the analysis cannot follow the shape the code is written in) and why. Only a code a rule declares CARRYABLE may appear, and naming any other is an error, so the register can never widen into general-purpose suppression. An entry carries a finding only when it lists EVERY unit that finding reports, so an aggregating finding cannot grow behind it; an entry that matched nothing, that duplicates another, that names a spec the tree does not hold, or that lists a unit no longer reported is STALE_CARRIED_FINDING, so the register only shrinks. The audit is silent in a run that could not have fired the findings at all: one that built no code model, the specs outside a scoped run, and a code the project switched off.',
  codes: [
    { code: 'UNCARRYABLE_FINDING', defaultSeverity: 'error', summary: 'The conformance debt register names an issue code no rule emits, or one no rule declares carryable — the register holds measured code↔spec debt, never a design rule somebody wants quiet' },
    { code: 'STALE_CARRIED_FINDING', defaultSeverity: 'warning', summary: 'An entry of the conformance debt register carries a finding that no longer fires, or lists a unit that finding no longer reports — delete it, the register only shrinks' },
  ],

  check(ctx: RuleContext): void {
    const carried = ctx.carriedFindings;
    if (carried.length === 0) return;

    // Illegality first, and whatever the run saw: a code that may not be
    // carried is wrong even in a run that judged no code at all.
    for (const entry of carried) {
      if (ctx.carryableIssueCodes.has(entry.code)) continue;
      const why = ctx.knownIssueCodes.has(entry.code)
        ? 'that code is not CARRYABLE — the register holds measured code↔spec debt, and a doctrine, soundness or configuration finding says the design is illegal rather than unfinished'
        : 'no registered rule emits that code';
      ctx.addIssue(
        'error',
        'UNCARRYABLE_FINDING',
        `The conformance debt register carries "${entry.code}" on "${entry.spec}" (at "${entry.at}"), but ${why}. Remove the entry; if the code belongs in the register, declare it carryable on the rule that emits it.`,
      );
    }

    // A run that built no code model could not have fired one conformance
    // finding, so every entry would read as stale for a reason nobody chose.
    if (ctx.codeModel.files.length === 0) return;

    const known = new Set(ctx.specIds().map(s => s.id));
    const addressed = new Set<string>();

    for (const entry of carried) {
      if (!ctx.carryableIssueCodes.has(entry.code)) continue;
      // Silences the project itself chose, which are not debts anyone paid.
      if (ctx.rules?.sddRuleSeverity?.[entry.code] === 'off') continue;
      if (!ctx.isSpecInScope(entry.spec)) continue;

      const key = `${entry.spec}|${entry.code}|${entry.at}`;
      if (addressed.has(key)) {
        ctx.addIssue(
          'warning',
          'STALE_CARRIED_FINDING',
          `The conformance debt register carries "${entry.code}" on "${entry.spec}" (at "${entry.at}") more than once. Only the first entry can ever match, so the rest carry nothing — delete them and merge their units into the one entry.`,
        );
        continue;
      }
      addressed.add(key);

      if (!entry.fired) {
        const why = known.has(entry.spec)
          ? 'no such finding fired this run — the debt is paid, or the spec no longer reaches that site'
          : `the tree holds no spec "${entry.spec}"`;
        ctx.addIssue(
          'warning',
          'STALE_CARRIED_FINDING',
          `The conformance debt register carries "${entry.code}" on "${entry.spec}" (at "${entry.at}" — ${entry.kind}: ${entry.why}), but ${why}. Delete the entry; the register only shrinks.`,
        );
        continue;
      }

      const paid = entry.covers.filter(unit => !entry.seen.has(unit));
      if (paid.length === 0) continue;
      ctx.addIssue(
        'warning',
        'STALE_CARRIED_FINDING',
        `The conformance debt register carries "${entry.code}" on "${entry.spec}" (at "${entry.at}") together with ${paid.length} unit(s) the finding no longer reports — ${paid.map(u => `"${u}"`).join('; ')}. That much of the debt is paid: delete those lines from the entry's \`covers\`; the register only shrinks.`,
      );
    }
  },
};
