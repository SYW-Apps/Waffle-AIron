import { SddRule } from './types.js';

/**
 * Audits per-spec lint suppressions (lint.allow — wairon's #[allow(...)]).
 * The suppression itself happens centrally in ctx.addIssue; this rule runs
 * LAST in the registry so every other rule has already had the chance to
 * match (and mark) each allow. Two failure modes are flagged:
 *
 * - an allow naming a code no registered rule can emit (typo / removed rule),
 * - an allow that matched nothing this run — stale suppressions rot into
 *   invisible risk exactly like commented-out tests.
 *
 * By design, allows silence WARNING-severity findings only. Error findings
 * are architecture violations and always surface; a human can still re-tune
 * a code globally via rules.sddRuleSeverity in project.yaml.
 */
export const lintAllowsRule: SddRule = {
  name: 'lint-allows',
  description:
    'Per-spec lint suppressions (lint.allow) must name real issue codes and actually suppress a finding — unknown codes and stale allows are flagged. Allows silence warnings only; errors always surface.',
  codes: [
    { code: 'UNKNOWN_LINT_ALLOW_CODE', defaultSeverity: 'warning', summary: 'lint.allow names an issue code no registered rule emits' },
    { code: 'UNUSED_LINT_ALLOW', defaultSeverity: 'warning', summary: 'lint.allow entry matched no finding this run — remove the stale allow' },
  ],
  check(ctx) {
    for (const a of ctx.lintAllows) {
      if (!ctx.knownIssueCodes.has(a.code)) {
        ctx.addIssue(
          'warning',
          'UNKNOWN_LINT_ALLOW_CODE',
          `Spec "${a.specId}" allows unknown issue code "${a.code}" — no registered rule emits it (see \`wairon rules list\`).`,
          a.specId,
        );
        continue;
      }
      if (!a.used) {
        ctx.addIssue(
          'warning',
          'UNUSED_LINT_ALLOW',
          `Spec "${a.specId}" allows "${a.code}" (reason: ${a.reason}) but no such finding fired this run — remove the stale allow.`,
          a.specId,
        );
      }
    }
  },
};
