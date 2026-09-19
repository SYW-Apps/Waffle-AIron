import { SddRule } from '../types.js';

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
 * The second one now includes the allow whose SITE no longer exists, and the
 * coarse allow written for a rule that names sites. An allow covers exactly
 * the occurrence it names (`at`, and `covers` where the finding aggregates),
 * so the stale finding must say what the run actually saw — otherwise "no such
 * finding fired" would read as a lie on a spec where three of them did. The
 * sites are in the message for the same reason: the author is being asked to
 * write one, and guessing its spelling from prose is how allows rot.
 *
 * By design, allows silence WARNING-severity findings only. Error findings
 * are architecture violations and always surface; a human can still re-tune
 * a code globally via rules.sddRuleSeverity in project.yaml.
 */
export const lintAllowsRule: SddRule = {
  name: 'lint-allows',
  description:
    'Per-spec lint suppressions (lint.allow) must name real issue codes and actually suppress a finding — unknown codes and stale allows are flagged. An allow covers exactly the occurrence it names: a finding that reports a site is silenced only by an allow whose `at` is that site, a finding that reports none only by an allow that names none, and an aggregating finding only by an allow whose `covers` lists every unit it reports — a unit nobody listed is named back as new instead of inheriting a decision taken about its neighbours. So a coarse allow left on a rule that names sites, and an allow whose site the run no longer reports, are both UNUSED_LINT_ALLOW, and the finding names the sites that did fire. Allows silence warnings only; errors always surface.',
  codes: [
    { code: 'UNKNOWN_LINT_ALLOW_CODE', defaultSeverity: 'warning', summary: 'lint.allow names an issue code no registered rule emits' },
    { code: 'UNUSED_LINT_ALLOW', defaultSeverity: 'warning', summary: 'lint.allow entry matched no finding this run — the code never fired, or it fired at sites this allow does not name' },
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
      if (a.used) continue;

      // What the run DID report for this code on this spec, so the finding can
      // tell "the debt is paid" from "you named the wrong occurrence".
      const reported = ctx.sitesReported(a.specId, a.code);
      const at = a.at ? ` at "${a.at}"` : '';
      let why: string;
      if (a.at && reported.unsited && reported.sites.length === 0) {
        why = `findings of "${a.code}" on this spec name no site at all, so this allow must not name one — drop the \`at\``;
      } else if (reported.sites.length > 0) {
        const sites = reported.sites.map(s => `"${s}"`).join('; ');
        why = a.at
          ? `that code fired at ${sites} instead — retarget the allow, or remove it`
          : `that code fired at ${sites}, and a sited finding is covered only by an allow naming its site — give this allow an \`at\` (one per site, each with its own reason), or remove it`;
      } else {
        why = 'no such finding fired this run — remove the stale allow';
      }
      ctx.addIssue(
        'warning',
        'UNUSED_LINT_ALLOW',
        `Spec "${a.specId}" allows "${a.code}"${at} (reason: ${a.reason}), but ${why}.`,
        a.specId,
      );
    }
  },
};
