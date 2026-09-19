import {
  defaultConformanceTier,
  hasFunctionBody,
  importBindingOf,
  methodSourceFile,
  type ConformanceTier,
} from '../../../models/index.js';
import { CodeIndex, RuleContext, SddRule } from '../types.js';

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
//
// A name being PRESENT is not the same as an implementation being there, and
// the second question is METHOD_BODY_NOT_FOUND's: the symbol is a declaration
// of this file, and the file holds no function-like BODY under it — an
// overload signature, an ambient declaration, an interface or type member, a
// plain value binding, a name this file only imports or re-exports. Every
// deeper check reads a body (the callee set of Level 3, the measured
// complexity of the detail dial), so without one they all go quiet and the
// method reads as realized on the strength of its name alone. Only EXACT
// grade measures bodies, so only exact grade asks; and only a DECLARED symbol
// is asked about, because the anchored tier's string-literal registration
// deliberately claims no function at all.
// ---------------------------------------------------------------------------

/**
 * Whether a body can be REACHED under a symbol from the file that claims it —
 * here, or wherever this file's own imports and republications carry it.
 *
 * A thin adapter that forwards a name (`export const hostCore = { provision }`,
 * a re-export barrel) writes no body of its own, and demanding one would turn
 * the N:1 identity forwarding Level 1 already blesses into a finding. What is
 * NOT reachable is a name with no body at the end of that chain: a signature,
 * an ambient or interface declaration, a plain value binding.
 *
 * Every origin must be measured at exact grade before the answer can be "no":
 * a file the run did not read at exact grade holds no measured bodies at all,
 * which is not the same as holding none — and a symbol that resolves nowhere
 * (a package import) is unreadable rather than absent.
 */
function bodyReachable(code: CodeIndex, file: string, symbol: string): boolean {
  const facts = code.factsAt(file);
  if (!facts) return true;
  const names = new Set([symbol]);
  const binding = importBindingOf(facts, symbol);
  if (binding?.imported) names.add(binding.imported);
  const origins = code.originOf({ name: symbol, member: false }, file);
  if (origins.size === 0) return true;
  for (const origin of origins) {
    const at = code.factsAt(origin);
    if (!at || at.status !== 'analyzed' || at.analysisGrade !== 'exact') return true;
    for (const name of names) if (hasFunctionBody(at, name)) return true;
  }
  return false;
}

export const methodRealizationRule: SddRule = {
  name: 'method-realization',
  description:
    'Code↔spec Level 1: every L3 contract method must be realized in its own source file (the method\'s sourcePath, else the implementation\'s) at its conformance tier — declared | anchored | off; Portals default to anchored, everything else to declared, and a per-method `symbol` maps an intent-language name onto the code name. A method realized by a DECLARATION owes a function BODY as well: at exact grade one must be reachable under the symbol, here or through the imports and republications this file forwards it by, so a signature, an ambient or interface declaration or a plain value binding stops reading as an implementation (METHOD_BODY_NOT_FOUND). Findings carry the analysis grade (exact AST | pattern table | generic scan) so weaker analysis is visible. Methods whose file escapes the root, is missing or could not be analyzed are left to source-file-linkage, and implementations under chained subsystems (projectPath) validate standalone in their own project run.',
  codes: [
    { code: 'UNREALIZED_METHOD', defaultSeverity: 'warning', summary: 'An L3 contract method has no anchor in its own source file (the method\'s sourcePath, else the implementation\'s) at the required conformance tier' },
    { code: 'METHOD_BODY_NOT_FOUND', defaultSeverity: 'warning', summary: 'The method symbol IS declared in its own source file, but the file holds no function-like body under it — a signature, an ambient or interface declaration, a value binding, an imported or re-exported name' },
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
        if (realized) {
          // Realized by a DECLARATION, at the grade that measures bodies, and
          // no body under that name anywhere the model can follow: the spec
          // points at a symbol no deeper check can read.
          if (!inDeclared || facts.analysisGrade !== 'exact' || bodyReachable(code, file, symbol)) continue;
          const bodyLabel = methodImpl?.symbol ? `"${method.name}" (symbol "${symbol}")` : `"${method.name}"`;
          ctx.addIssue(
            'warning',
            'METHOD_BODY_NOT_FOUND',
            `Method ${bodyLabel} of contract "${impl.contract}" is declared in "${file}" but has no function body there — a signature, an ambient or interface declaration, a value binding, or a name this file only imports or re-exports. Every deeper check reads a body (the realized calls of Level 3, the measured complexity of the detail dial), so this method is judged on its name alone. Point the sourcePath at the file that implements it, map the code name via a per-method SYMBOL, or dial this method to "off".`,
            impl.id,
            draft,
          );
          continue;
        }

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
