import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Lowered severities: a rule code the project sets below its default severity
// (rules.sddRuleSeverity) is never silent. Every run reports it with the
// project's reason from rules.severityReasons, so a lowering stays as visible
// as the debt register's total — quieting a rule is a decision the human
// approves, never a fix for its finding.
//
// The rule does no I/O: the project's rules come from the run's context, and
// each code's declared default from ctx.defaultSeverityOf. A code only the family
// run reports declares no default in this run's rule set, so it is judged
// neither as lowered nor as holding a stale reason. The findings name
// no spec: the lowering lives in .wai/project.yaml, which is configuration, not
// a spec.
// ---------------------------------------------------------------------------

/** error > warning > notice > off: a lowering ranks strictly below the default. */
const RANK: Record<string, number> = { error: 3, warning: 2, notice: 1, off: 0 };

export const loweredSeveritiesRule: SddRule = {
  name: 'lowered-severities',
  judges: 'design',
  description:
    "A rule code the project sets below its default severity (rules.sddRuleSeverity) is never silent: every run reports it with the project's reason from rules.severityReasons, so the lowering stays as visible as the debt register's total. A lowering without a reason is RULE_LOWERED_WITHOUT_REASON; a reason for a code the project does not lower is STALE_SEVERITY_REASON.",
  codes: [
    { code: 'RULE_LOWERED', defaultSeverity: 'notice', summary: "A rule code is set below its default severity; the finding names both severities and the project's reason" },
    { code: 'RULE_LOWERED_WITHOUT_REASON', defaultSeverity: 'warning', summary: 'A rule code is set below its default severity and rules.severityReasons gives no reason for it' },
    { code: 'STALE_SEVERITY_REASON', defaultSeverity: 'warning', summary: 'rules.severityReasons gives a reason for a code the project does not set below its default severity' },
  ],
  check(ctx) {
    // Step 1: the project's severities and reasons.
    const severities = ctx.rules?.sddRuleSeverity ?? {};
    const reasons = ctx.rules?.severityReasons ?? {};
    const declaredOf = (code: string): string | undefined => (ctx.knownIssueCodes.has(code) ? ctx.defaultSeverityOf(code) : undefined);
    const lowers = (code: string): boolean => {
      const set = Object.hasOwn(severities, code) ? severities[code] : undefined;
      const declared = declaredOf(code);
      return set !== undefined && declared !== undefined && RANK[set] < RANK[declared];
    };
    // Steps 2-8: each code the project sets.
    for (const [code, set] of Object.entries(severities)) {
      // Step 3: only a known code set below its declared default.
      if (!lowers(code)) continue;
      const declared = declaredOf(code);
      const reason = Object.hasOwn(reasons, code) ? reasons[code].trim() : '';
      if (reason !== '') {
        // Steps 4-6: lowered, with its reason.
        ctx.addIssue(
          'notice',
          'RULE_LOWERED',
          `Rule ${code} is set to ${set} in rules.sddRuleSeverity, below its default ${declared}. Reason: ${reason}. A lowered rule is reported on every run so the lowering stays visible — fix what ${code} names rather than quieting it.`,
        );
      } else {
        // Step 7: lowered, with no reason.
        ctx.addIssue(
          'warning',
          'RULE_LOWERED_WITHOUT_REASON',
          `Rule ${code} is set to ${set} in rules.sddRuleSeverity, below its default ${declared}, and rules.severityReasons gives no reason for it. State why (sdd_update_rules with \`why\`) or restore the default.`,
        );
      }
    }
    // Steps 9-12: each reason kept for a code the project does not lower.
    for (const code of Object.keys(reasons)) {
      if (lowers(code)) continue;
      // A code this run's rule set does not declare (a family-run code such as MEMBER_UNAPPROVED, or a typo) has no default here to be below, so a reason kept for it is not judged.
      if (!ctx.knownIssueCodes.has(code)) continue;
      const set = Object.hasOwn(severities, code) ? severities[code] : undefined;
      const declared = declaredOf(code);
      const state = set === undefined
        ? 'sets no severity for it'
        : declared === undefined
          ? `sets it to ${set}, but no registered rule declares it`
          : `sets it to ${set}, not below its default ${declared}`;
      ctx.addIssue(
        'warning',
        'STALE_SEVERITY_REASON',
        `rules.severityReasons keeps a reason for ${code}, but the project ${state}. Remove the reason (it is dropped when sdd_update_rules sets the severity back).`,
      );
    }
  },
};
