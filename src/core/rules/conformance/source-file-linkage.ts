import {
  implementationSourceFiles,
  pathKey,
  methodSourceFile,
} from '../../../models/index.js';
import { RuleContext, SddRule, type Severity } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec Level 1, first question: does the spec name files that exist?
//
// An implementation names files (its own sourcePath and each method's). They
// are judged by whether its realization has BEGUN — code_index.holdsAny over
// the files it names: at least one exists. Before that the design is simply
// ahead of the code: a named file not on disk is PLANNED (a notice) and an
// implementation naming no file is unlinked design (a notice), so a
// design-only tree passes `validate --ci` and a planned sourcePath can be
// declared at design time — code linkage is not part of the approval, so
// declaring it costs no re-lock. Once realization has begun, a missing file is
// a broken link (an error) and a contract method naming no file while others
// do is unlinked (a warning). `rules.conformance.requireCode` reports the two
// notices at error, for teams whose CI must demand code for every design. It
// consumes the pure CodeModel the source analysis adapter builds once per run
// — the rule itself does no I/O.
//
// A file that escapes the root, is missing, or cannot be read is reported once
// per distinct file; method-realization and finding-realization then skip the
// methods realized in it, so a broken file costs one finding rather than one
// per method.
//
// CONFORMANCE_DEGRADED is the one run-wide finding of the family, reported
// here because this is where the file index is built: a silently degraded gate
// is worse than a degraded gate.
//
// Implementations owned by a chained subsystem (any projectPath along its
// namespace chain) are skipped: their sourcePaths are relative to the child
// project's root, and the child validates them standalone in its own run.
// ---------------------------------------------------------------------------

const quoteList = (names: string[]): string => names.map(n => `"${n}"`).join(', ');

/**
 * How planned code is reported: a notice, or an error naming the setting when
 * the project asks CI to demand code (rules.conformance.requireCode). Shared by
 * every rule that tells planned code from missing code.
 */
export function plannedCode(ctx: RuleContext): { severity: Severity; note: string } {
  return ctx.rules?.conformance?.requireCode === true
    ? { severity: 'error', note: ' — an error because rules.conformance.requireCode asks every designed implementation to have code' }
    : { severity: 'notice', note: '' };
}

export const sourceFileLinkageRule: SddRule = {
  name: 'source-file-linkage',
  judges: 'code',
  description:
    'Code↔spec Level 1: every source file an implementation names — its own sourcePath and each method\'s — is checked against the code on disk, judged by whether the implementation\'s realization has BEGUN (code_index.holdsAny over the files it names: at least one exists). Before that, the design is ahead of the code and nothing is wrong: a named file that is not on disk is PLANNED (SOURCE_FILE_PLANNED, a notice — planned, not written yet) and an implementation that names no file is unlinked design (MISSING_SOURCE_PATH, a notice), so a design-only tree passes `validate --ci` and a planned sourcePath can be declared at design time — which code linkage, outside the approval since format 3, costs nothing to do. Once it has begun, conformance judges it: a named file that is missing is a broken link (MISSING_SOURCE_FILE, an error) and a contract method that names no file while others do is unlinked (METHOD_SOURCE_PATH_MISSING, a warning). A team that wants CI to demand code for every designed implementation sets rules.conformance.requireCode, which reports the two notices at error, naming the setting. A file that escapes the root or cannot be analyzed is reported once and blocks only the methods realized in it. A run in which TypeScript/JavaScript files were analyzed below exact grade reports that once (CONFORMANCE_DEGRADED). Implementations under chained subsystems (projectPath) validate standalone in their own project run and are skipped here.',
  codes: [
    { code: 'MISSING_SOURCE_PATH', defaultSeverity: 'notice', summary: 'An implementation whose realization has not begun names no source file (for itself or for some contract methods) — designed, not linked to code yet; an error under rules.conformance.requireCode' },
    { code: 'MISSING_SOURCE_FILE', defaultSeverity: 'error', summary: 'A source file an implementation or one of its methods names does not resolve to a file on disk although the implementation\'s realization has begun (another file it names exists) — a broken link' },
    { code: 'SOURCE_PATH_ESCAPES_ROOT', defaultSeverity: 'error', summary: 'A source file an implementation or one of its methods names is absolute or escapes the project root (containment refusal)' },
    { code: 'CONFORMANCE_ANALYSIS_SKIPPED', defaultSeverity: 'warning', summary: 'A source file an implementation or one of its methods names could not be analyzed (binary/unreadable) — realization of the methods in it was not checked' },
    { code: 'CONFORMANCE_DEGRADED', defaultSeverity: 'warning', summary: 'TypeScript/JavaScript files were analyzed below exact grade (compiler not resolvable) — dependency conformance skips them' },
    { code: 'SOURCE_FILE_PLANNED', defaultSeverity: 'notice', summary: 'A source file an implementation names is not on disk and none of its named files is — planned, not written yet; conformance judges it once a file exists. An error under rules.conformance.requireCode' },
    { code: 'METHOD_SOURCE_PATH_MISSING', defaultSeverity: 'warning', summary: 'An implementation whose realization has begun leaves contract methods without a source file — structural conformance cannot link them to code' },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    // A silently degraded gate is worse than a degraded gate: when ts/js files
    // could not be analyzed at exact grade the compiler was not resolvable —
    // structural anchors stay honest (grade is on each finding), but dependency
    // conformance SKIPS those files entirely. Surface that once per run.
    const degradedTsFiles = ctx.codeModel.files.filter(
      f => f.status === 'analyzed'
        && (f.language === 'typescript' || f.language === 'javascript')
        && f.analysisGrade !== 'exact',
    );
    if (degradedTsFiles.length > 0) {
      ctx.addIssue(
        'warning',
        'CONFORMANCE_DEGRADED',
        `${degradedTsFiles.length} TypeScript/JavaScript source file(s) were analyzed below exact grade — the TypeScript compiler could not be resolved from the analyzed project or the wairon installation. Structural findings carry their grade, but dependency conformance skips these files. Install "typescript" in the analyzed project to restore exact analysis.`,
      );
    }

    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const component = ctx.componentMap.get(contract.component);
      if (!component) continue;
      if (ctx.isInChainedSubproject(component.subsystem)) continue;

      const draft = ctx.isImplementationDraft(impl);

      // A contract method with no source file at all: the implementation names
      // no path and the method names none of its own.
      const unlinked = contract.methods
        .filter(method => !methodSourceFile(impl.methods.find(m => m.name === method.name) ?? {}, impl.sourcePath))
        .map(method => method.name);
      // The implementation names no source file anywhere — no sourcePath of its
      // own, and no method names one either — regardless of how many contract
      // methods exist (including zero). `unlinked` alone goes quiet when the
      // contract has no methods to enumerate, which would leave an
      // implementation with literally nothing linking it to code unreported.
      const noFileAtAll = implementationSourceFiles(impl).length === 0;
      // Realization has begun once any file the implementation names exists.
      const begun = code.holdsAny(implementationSourceFiles(impl));
      const planned = plannedCode(ctx);
      if (unlinked.length > 0 || noFileAtAll) {
        // An `implementation`-type external link on the component IS the external
        // source-of-record (a cloud console / Make.com scenario / GitHub file). wairon
        // cannot analyze it, so there is no local file to structurally check — and
        // MISSING_SOURCE_PATH would just be noise. Suppress it when such a link exists.
        const hasExternalSource = (component.externalLinks ?? []).some((l) => l.type === 'implementation');
        if (!hasExternalSource) {
          const one = unlinked.length === 1;
          const methods = `contract method${one ? '' : 's'} ${quoteList(unlinked)} of "${impl.contract}" name${one ? 's' : ''} no source file of ${one ? 'its' : 'their'} own`;
          if (begun) {
            // Realization has begun: an unlinked method is a gap in code that exists.
            ctx.addIssue(
              'warning',
              'METHOD_SOURCE_PATH_MISSING',
              `Implementation "${impl.id}" declares no sourcePath, and ${methods} — structural conformance cannot link ${one ? 'it' : 'them'} to code.`,
              impl.id,
              draft,
            );
          } else {
            // Not begun: designed, not linked to code yet — nothing is wrong.
            const what = unlinked.length > 0
              ? `declares no sourcePath, and ${methods}`
              : `of contract "${impl.contract}" names no source file at all`;
            ctx.addIssue(
              planned.severity,
              'MISSING_SOURCE_PATH',
              `Implementation "${impl.id}" ${what} — designed, not linked to code yet. Declare the planned sourcePath now: code linkage is not part of the approval, so it costs no re-lock${planned.note}.`,
              impl.id,
              draft,
            );
          }
        }
      }

      // File status, once per distinct file the implementation names (its own
      // path, then each method's). The existence check applies at every tier.
      const reported = new Set<string>();
      for (const file of implementationSourceFiles(impl)) {
        const key = pathKey(file);
        if (reported.has(key)) continue;
        reported.add(key);
        const facts = code.factsAt(key);
        if (!facts || facts.status === 'analyzed') continue;

        const isImplementationFile = !!impl.sourcePath && pathKey(impl.sourcePath) === key;
        const users = isImplementationFile
          ? []
          : impl.methods.filter(m => m.sourcePath && pathKey(m.sourcePath) === key).map(m => m.name);
        const owner = users.length === 0
          ? `Implementation "${impl.id}"`
          : `Implementation "${impl.id}" method${users.length === 1 ? '' : 's'} ${quoteList(users)}`;

        if (facts.status === 'escaped') {
          ctx.addIssue(
            'error',
            'SOURCE_PATH_ESCAPES_ROOT',
            `${owner} sourcePath "${file}" is absolute or escapes the project root — sourcePaths must stay inside the project.`,
            impl.id,
            draft,
          );
        } else if (facts.status === 'missing' && begun) {
          ctx.addIssue(
            'error',
            'MISSING_SOURCE_FILE',
            `${owner} sourcePath "${file}" does not resolve to a file although the implementation's realization has begun — a broken link: the spec names code that does not exist.`,
            impl.id,
            draft,
          );
        } else if (facts.status === 'missing') {
          ctx.addIssue(
            planned.severity,
            'SOURCE_FILE_PLANNED',
            `${owner} sourcePath "${file}" is planned, not written yet — conformance judges it once a file the implementation names exists${planned.note}.`,
            impl.id,
            draft,
          );
        } else {
          ctx.addIssue(
            'warning',
            'CONFORMANCE_ANALYSIS_SKIPPED',
            `${owner} sourcePath "${file}" could not be analyzed (binary or unreadable) — realization of the methods in it was not checked.`,
            impl.id,
            draft,
          );
        }
      }
    }
  },
};
