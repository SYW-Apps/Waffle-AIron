import type { SourceFileFacts } from '../source-analysis.js';
import { normalizeSourcePath } from '../source-analysis.js';
import { RuleContext, SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Structural conformance (code↔spec Level 1)
//
// The spec tree names real files (L4 sourcePath) and real contract methods
// (L3); this family checks the code actually honors both. It consumes the
// pure CodeModel the source analysis adapter builds once per run (injected
// into the context beside surfaceSnapshots) — the rule itself does no I/O.
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
//              sourcePath existence check always applies.
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

export const structuralConformanceRule: SddRule = {
  name: 'structural-conformance',
  description:
    'Code↔spec Level 1: every L4 sourcePath must resolve to a real file inside the project root, and every L3 contract method must be realized in that file at the implementation\'s conformance tier (declared | anchored | off; Portals default to anchored, everything else to declared; per-method `symbol` maps intent-language names to code names). Findings carry the analysis grade (exact AST | pattern table | generic scan) so weaker analysis is visible. Implementations under chained subsystems (projectPath) validate standalone in their own project run and are skipped here.',
  codes: [
    { code: 'MISSING_SOURCE_PATH', defaultSeverity: 'warning', summary: 'An implementation spec declares no sourcePath — structural conformance cannot link it to code' },
    { code: 'MISSING_SOURCE_FILE', defaultSeverity: 'error', summary: 'An L4 sourcePath does not resolve to a file on disk' },
    { code: 'SOURCE_PATH_ESCAPES_ROOT', defaultSeverity: 'error', summary: 'An L4 sourcePath is absolute or escapes the project root (containment refusal)' },
    { code: 'UNREALIZED_METHOD', defaultSeverity: 'warning', summary: 'An L3 contract method has no anchor in its implementation\'s source file at the required conformance tier' },
    { code: 'CONFORMANCE_ANALYSIS_SKIPPED', defaultSeverity: 'warning', summary: 'A source file could not be analyzed (binary/unreadable) — method realization was not checked' },
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

      if (!impl.sourcePath) {
        ctx.addIssue(
          'warning',
          'MISSING_SOURCE_PATH',
          `Implementation "${impl.id}" declares no sourcePath — its contract "${impl.contract}" cannot be structurally checked against code.`,
          impl.id,
          draft,
        );
        continue;
      }

      const lookup = lookups.get(normalizeSourcePath(impl.sourcePath));
      if (!lookup) continue; // no code model for this path (context built without one)

      const { facts } = lookup;
      if (facts.status === 'escaped') {
        ctx.addIssue(
          'error',
          'SOURCE_PATH_ESCAPES_ROOT',
          `Implementation "${impl.id}" sourcePath "${impl.sourcePath}" is absolute or escapes the project root — sourcePaths must stay inside the project.`,
          impl.id,
          draft,
        );
        continue;
      }
      if (facts.status === 'missing') {
        ctx.addIssue(
          'error',
          'MISSING_SOURCE_FILE',
          `Implementation "${impl.id}" sourcePath "${impl.sourcePath}" does not resolve to a file — the spec names code that does not exist.`,
          impl.id,
          draft,
        );
        continue;
      }
      if (facts.status === 'unreadable') {
        ctx.addIssue(
          'warning',
          'CONFORMANCE_ANALYSIS_SKIPPED',
          `Implementation "${impl.id}" sourcePath "${impl.sourcePath}" could not be analyzed (binary or unreadable) — method realization was not checked.`,
          impl.id,
          draft,
        );
        continue;
      }

      const specTier = (impl.conformance as ConformanceTier | undefined)
        ?? stereotypeDefaultTier(component.componentType);

      for (const method of contract.methods) {
        const methodImpl = impl.methods.find(m => m.name === method.name);
        const tier = (methodImpl?.conformance as ConformanceTier | undefined) ?? specTier;
        if (tier === 'off') continue;

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
          `Method ${label} of contract "${impl.contract}" is not realized in "${impl.sourcePath}" at the "${tier}" tier (analysis grade: ${facts.analysisGrade}).${weakHint}`,
          impl.id,
          draft,
        );
      }
    }
  },
};
