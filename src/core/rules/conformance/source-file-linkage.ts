import {
  implementationSourceFiles,
  pathKey,
  methodSourceFile,
} from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec Level 1, first question: does the spec name files that exist?
//
// An implementation names real files (its own sourcePath and each method's);
// this rule checks that every one of them resolves to a readable file inside
// the project root, and that nothing the contract lists is left unlinked. It
// consumes the pure CodeModel the source analysis adapter builds once per run
// (injected into the context beside surfaceSnapshots) — the rule itself does
// no I/O.
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

export const sourceFileLinkageRule: SddRule = {
  name: 'source-file-linkage',
  description:
    'Code↔spec Level 1: every source file an implementation names — its own sourcePath and each method\'s — must resolve to a real, readable file inside the project root, and an implementation that names no file at all, or leaves a contract method without one, is linked to no code. A file that escapes the root, is missing or cannot be analyzed is reported once and blocks only the methods realized in it. A run in which TypeScript/JavaScript files were analyzed below exact grade reports that once (CONFORMANCE_DEGRADED), since dependency conformance then skips them. Implementations under chained subsystems (projectPath) validate standalone in their own project run and are skipped here.',
  codes: [
    { code: 'MISSING_SOURCE_PATH', defaultSeverity: 'warning', summary: 'An implementation names no source file at all, or a contract method is left without one — structural conformance cannot link it to code' },
    { code: 'MISSING_SOURCE_FILE', defaultSeverity: 'error', summary: 'A source file an implementation or one of its methods names does not resolve to a file on disk' },
    { code: 'SOURCE_PATH_ESCAPES_ROOT', defaultSeverity: 'error', summary: 'A source file an implementation or one of its methods names is absolute or escapes the project root (containment refusal)' },
    { code: 'CONFORMANCE_ANALYSIS_SKIPPED', defaultSeverity: 'warning', summary: 'A source file an implementation or one of its methods names could not be analyzed (binary/unreadable) — realization of the methods in it was not checked' },
    { code: 'CONFORMANCE_DEGRADED', defaultSeverity: 'warning', summary: 'TypeScript/JavaScript files were analyzed below exact grade (compiler not resolvable) — dependency conformance skips them' },
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
      if (unlinked.length > 0 || noFileAtAll) {
        // An `implementation`-type external link on the component IS the external
        // source-of-record (a cloud console / Make.com scenario / GitHub file). wairon
        // cannot analyze it, so there is no local file to structurally check — and
        // MISSING_SOURCE_PATH would just be noise. Suppress it when such a link exists.
        const hasExternalSource = (component.externalLinks ?? []).some((l) => l.type === 'implementation');
        if (!hasExternalSource) {
          if (unlinked.length > 0) {
            const one = unlinked.length === 1;
            ctx.addIssue(
              'warning',
              'MISSING_SOURCE_PATH',
              `Implementation "${impl.id}" declares no sourcePath, and contract method${one ? '' : 's'} ${quoteList(unlinked)} of "${impl.contract}" name${one ? 's' : ''} no source file of ${one ? 'its' : 'their'} own — structural conformance cannot link ${one ? 'it' : 'them'} to code.`,
              impl.id,
              draft,
            );
          } else {
            ctx.addIssue(
              'warning',
              'MISSING_SOURCE_PATH',
              `Implementation "${impl.id}" of contract "${impl.contract}" names no source file at all — structural conformance cannot link it to code.`,
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
        } else if (facts.status === 'missing') {
          ctx.addIssue(
            'error',
            'MISSING_SOURCE_FILE',
            `${owner} sourcePath "${file}" does not resolve to a file — the spec names code that does not exist.`,
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
