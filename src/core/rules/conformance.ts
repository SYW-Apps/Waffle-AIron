import type { SourceFileFacts } from '../source-analysis.js';
import { normalizeSourcePath } from '../source-analysis.js';
import { implementationSourceFiles, methodSourceFile } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Structural conformance (code↔spec Level 1)
//
// The spec tree names real files (an implementation's sourcePath and each
// method's own sourcePath) and real contract methods (L3); this family checks
// the code actually honors both. It consumes the pure CodeModel the source
// analysis adapter builds once per run (injected into the context beside
// surfaceSnapshots) — the rule itself does no I/O.
//
// Each contract method is checked against its OWN source file: the method's
// sourcePath, else the implementation's. A file that escapes the root, is
// missing, or cannot be read is reported once per distinct file and blocks
// only the methods realized in it — methods on a healthy file are still
// checked.
//
// Realization is tiered per implementation (the conformance dial, mirroring
// the narrative detail dial):
//   declared — the method name (or its per-method `symbol` override) must be
//              a declaration-tier anchor: a named declaration at any nesting
//              depth, destructuring binding, object-literal key, import
//              binding, or export specifier (barrels resolved).
//   anchored — declared, or an exact string-literal occurrence (tool/route
//              registrations). The stereotype default for Portals.
//   off      — method checks skipped (generated/vendored code); the
//              existence check of every named source file always applies.
//
// N:1 is native: many implementations may share one file, and one anchor
// satisfies every component that declares that method name — telling WHICH
// component a symbol serves is Level 3's job.
//
// Implementations owned by a chained subsystem (any projectPath along its
// namespace chain) are skipped: their sourcePaths are relative to the child
// project's root, and the child validates them standalone in its own run.
// ---------------------------------------------------------------------------

export type ConformanceTier = 'declared' | 'anchored' | 'off';

export function stereotypeDefaultTier(componentType: string): ConformanceTier {
  return componentType === 'Portal' ? 'anchored' : 'declared';
}

export function isInChainedSubproject(subsystemId: string, ctx: RuleContext): boolean {
  const segments = subsystemId.split('::');
  let prefix = '';
  for (const segment of segments) {
    prefix = prefix ? `${prefix}::${segment}` : segment;
    const sub = ctx.subsystems.find(s => s.id === prefix);
    if (sub?.projectPath) return true;
  }
  return false;
}

interface FactsLookup {
  declared: Set<string>;
  anchored: Set<string>;
  facts: SourceFileFacts;
}

const quoteList = (names: string[]): string => names.map(n => `"${n}"`).join(', ');

export const structuralConformanceRule: SddRule = {
  name: 'structural-conformance',
  description:
    'Code↔spec Level 1: every source file an implementation names — its own sourcePath and each method\'s — must resolve to a real file inside the project root, and every L3 contract method must be realized in its own source file (the method\'s sourcePath, else the implementation\'s) at its conformance tier (declared | anchored | off; Portals default to anchored, everything else to declared; per-method `symbol` maps intent-language names to code names). A file that escapes the root, is missing or cannot be read is reported once and blocks only the methods realized in it. Findings carry the analysis grade (exact AST | pattern table | generic scan) so weaker analysis is visible. Implementations under chained subsystems (projectPath) validate standalone in their own project run and are skipped here.',
  codes: [
    { code: 'MISSING_SOURCE_PATH', defaultSeverity: 'warning', summary: 'A contract method has no source file — its implementation declares no sourcePath and the method names none — so structural conformance cannot link it to code' },
    { code: 'MISSING_SOURCE_FILE', defaultSeverity: 'error', summary: 'A source file an implementation or one of its methods names does not resolve to a file on disk' },
    { code: 'SOURCE_PATH_ESCAPES_ROOT', defaultSeverity: 'error', summary: 'A source file an implementation or one of its methods names is absolute or escapes the project root (containment refusal)' },
    { code: 'UNREALIZED_METHOD', defaultSeverity: 'warning', summary: 'An L3 contract method has no anchor in its own source file (the method\'s sourcePath, else the implementation\'s) at the required conformance tier' },
    { code: 'CONFORMANCE_ANALYSIS_SKIPPED', defaultSeverity: 'warning', summary: 'A source file an implementation or one of its methods names could not be analyzed (binary/unreadable) — realization of the methods in it was not checked' },
    { code: 'CONFORMANCE_DEGRADED', defaultSeverity: 'warning', summary: 'TypeScript/JavaScript files were analyzed below exact grade (compiler not resolvable) — dependency conformance skips them' },
  ],

  check(ctx: RuleContext): void {
    const lookups = new Map<string, FactsLookup>();
    for (const facts of ctx.codeModel.files) {
      lookups.set(normalizeSourcePath(facts.path), {
        declared: new Set([...facts.declaredNames, ...facts.exportedNames]),
        anchored: new Set([...facts.declaredNames, ...facts.exportedNames, ...facts.anchoredNames]),
        facts,
      });
    }

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
      if (isInChainedSubproject(component.subsystem, ctx)) continue;

      const draft = ctx.isImplementationDraft(impl);
      const methodImplOf = (name: string) => impl.methods.find(m => m.name === name);

      // A contract method with no source file at all: the implementation names
      // no path and the method names none of its own.
      const unlinked = contract.methods
        .filter(method => !methodSourceFile(methodImplOf(method.name) ?? {}, impl.sourcePath))
        .map(method => method.name);
      if (unlinked.length > 0) {
        // An `implementation`-type external link on the component IS the external
        // source-of-record (a cloud console / Make.com scenario / GitHub file). wairon
        // cannot analyze it, so there is no local file to structurally check — and
        // MISSING_SOURCE_PATH would just be noise. Suppress it when such a link exists.
        const hasExternalSource = (component.externalLinks ?? []).some((l) => l.type === 'implementation');
        if (!hasExternalSource) {
          const one = unlinked.length === 1;
          ctx.addIssue(
            'warning',
            'MISSING_SOURCE_PATH',
            `Implementation "${impl.id}" declares no sourcePath, and contract method${one ? '' : 's'} ${quoteList(unlinked)} of "${impl.contract}" name${one ? 's' : ''} no source file of ${one ? 'its' : 'their'} own — structural conformance cannot link ${one ? 'it' : 'them'} to code.`,
            impl.id,
            draft,
          );
        }
      }

      // File status, once per distinct file the implementation names (its own
      // path, then each method's). The existence check applies at every tier.
      const reported = new Set<string>();
      for (const file of implementationSourceFiles(impl)) {
        const key = normalizeSourcePath(file);
        if (reported.has(key)) continue;
        reported.add(key);
        const facts = lookups.get(key)?.facts;
        if (!facts || facts.status === 'analyzed') continue;

        const isImplementationFile = !!impl.sourcePath && normalizeSourcePath(impl.sourcePath) === key;
        const users = isImplementationFile
          ? []
          : impl.methods.filter(m => m.sourcePath && normalizeSourcePath(m.sourcePath) === key).map(m => m.name);
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

      const specTier = (impl.conformance as ConformanceTier | undefined)
        ?? stereotypeDefaultTier(component.componentType);

      for (const method of contract.methods) {
        const methodImpl = methodImplOf(method.name);
        const tier = (methodImpl?.conformance as ConformanceTier | undefined) ?? specTier;
        if (tier === 'off') continue;

        const file = methodSourceFile(methodImpl ?? {}, impl.sourcePath);
        if (!file) continue; // MISSING_SOURCE_PATH covers it
        const lookup = lookups.get(normalizeSourcePath(file));
        // No code model for this path (context built without one), or the file
        // escaped, is missing or unreadable — that file's own finding covers it,
        // and only the methods realized in it are blocked.
        if (!lookup || lookup.facts.status !== 'analyzed') continue;

        const symbol = methodImpl?.symbol ?? method.name;
        const inDeclared = lookup.declared.has(symbol);
        const inAnchored = inDeclared || lookup.anchored.has(symbol);
        const realized = tier === 'declared' ? inDeclared : inAnchored;
        if (realized) continue;

        const label = methodImpl?.symbol ? `"${method.name}" (symbol "${symbol}")` : `"${method.name}"`;
        const weakHint = tier === 'declared' && inAnchored
          ? ' Only a weak string/word anchor exists — declare the symbol, map it via a per-method `symbol`, or dial this method to `anchored`.'
          : '';
        ctx.addIssue(
          'warning',
          'UNREALIZED_METHOD',
          `Method ${label} of contract "${impl.contract}" is not realized in "${file}" at the "${tier}" tier (analysis grade: ${lookup.facts.analysisGrade}).${weakHint}`,
          impl.id,
          draft,
        );
      }
    }
  },
};
