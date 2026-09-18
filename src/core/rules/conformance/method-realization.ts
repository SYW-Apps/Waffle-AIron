import {
  defaultConformanceTier,
  methodSourceFile,
  type ConformanceTier,
} from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec Level 1, second question: does the file contain the method?
//
// Each L3 contract method is checked against its OWN source file — the
// method's sourcePath, else the implementation's — in the pure CodeModel the
// source analysis adapter builds once per run.
//
// Realization is tiered per implementation (the conformance dial, mirroring
// the narrative detail dial):
//   declared — the method name (or its per-method `symbol` override) must be
//              a declaration-tier anchor: a named declaration at any nesting
//              depth, destructuring binding, object-literal key, import
//              binding, or export specifier (barrels resolved).
//   anchored — declared, or an exact string-literal occurrence (tool/route
//              registrations). The stereotype default for Portals.
//   off      — method checks skipped (generated/vendored code); the existence
//              check of every named source file (source-file-linkage) always
//              applies.
//
// N:1 is native: many implementations may share one file, and one anchor
// satisfies every component that declares that method name — telling WHICH
// component a symbol serves is Level 3's job.
//
// A file that escapes the root, is missing or is unreadable blocks only the
// methods realized in it: source-file-linkage reports it once, and the method
// is skipped here rather than reported twice.
// ---------------------------------------------------------------------------

export const methodRealizationRule: SddRule = {
  name: 'method-realization',
  description:
    'Code↔spec Level 1: every L3 contract method must be realized in its own source file (the method\'s sourcePath, else the implementation\'s) at its conformance tier — declared | anchored | off; Portals default to anchored, everything else to declared, and a per-method `symbol` maps an intent-language name onto the code name. Findings carry the analysis grade (exact AST | pattern table | generic scan) so weaker analysis is visible. Methods whose file escapes the root, is missing or could not be analyzed are left to source-file-linkage, and implementations under chained subsystems (projectPath) validate standalone in their own project run.',
  codes: [
    { code: 'UNREALIZED_METHOD', defaultSeverity: 'warning', summary: 'An L3 contract method has no anchor in its own source file (the method\'s sourcePath, else the implementation\'s) at the required conformance tier' },
  ],

  check(ctx: RuleContext): void {
    // declarationsAt is the declaration tier (declared + exported names);
    // anchorsAt adds the weak anchors the `anchored` tier also accepts.
    const code = ctx.codeIndex();

    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const component = ctx.componentMap.get(contract.component);
      if (!component) continue;
      if (ctx.isInChainedSubproject(component.subsystem)) continue;

      const draft = ctx.isImplementationDraft(impl);
      const specTier = (impl.conformance as ConformanceTier | undefined)
        ?? defaultConformanceTier(component);

      for (const method of contract.methods) {
        const methodImpl = impl.methods.find(m => m.name === method.name);
        // Tier off, no file at all (MISSING_SOURCE_PATH covers it), no code
        // model for the path (context built without one), or a file that
        // escaped, is missing or is unreadable (source-file-linkage covers it).
        const tier = (methodImpl?.conformance as ConformanceTier | undefined) ?? specTier;
        if (tier === 'off') continue;
        const file = methodSourceFile(methodImpl ?? {}, impl.sourcePath);
        if (!file) continue;
        const facts = code.factsAt(file);
        if (!facts || facts.status !== 'analyzed') continue;

        const symbol = methodImpl?.symbol ?? method.name;
        const inDeclared = code.declarationsAt(file).has(symbol);
        const inAnchored = inDeclared || code.anchorsAt(file).has(symbol);
        const realized = tier === 'declared' ? inDeclared : inAnchored;
        if (realized) continue;

        const label = methodImpl?.symbol ? `"${method.name}" (symbol "${symbol}")` : `"${method.name}"`;
        const weakHint = tier === 'declared' && inAnchored
          ? ' Only a weak string/word anchor exists — declare the symbol, map it via a per-method `symbol`, or dial this method to `anchored`.'
          : '';
        ctx.addIssue(
          'warning',
          'UNREALIZED_METHOD',
          `Method ${label} of contract "${impl.contract}" is not realized in "${file}" at the "${tier}" tier (analysis grade: ${facts.analysisGrade}).${weakHint}`,
          impl.id,
          draft,
        );
      }
    }
  },
};
