import {
  defaultConformanceTier,
  methodSourceFile,
  pathKey,
  type ConformanceTier,
  type SourceFileFacts,
} from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec Level 1, third question: does the file report the codes the method
// declares?
//
// Every finding code an L3 contract method declares must be among the anchors
// of the method's own source file — the method's sourcePath, else the
// implementation's. At exact grade those anchors are string literals and
// property-access names (a code reported through a constants object, `Codes.X`,
// counts); the pattern grade also counts any identifier outside comments and
// the generic grade any word, so below exact grade a code that is named but
// never reported can pass. The grade rides on the finding.
//
// The conformance dial applies here as it does to method realization: `off`
// skips the method, and a file that escaped, is missing or is unreadable is
// source-file-linkage's single finding rather than one per declared code.
//
// Implementations owned by a chained subsystem (any projectPath along its
// namespace chain) are skipped: their sourcePaths are relative to the child
// project's root, and the child validates them standalone in its own run.
// ---------------------------------------------------------------------------

export const findingRealizationRule: SddRule = {
  name: 'finding-realization',
  description:
    'Code↔spec Level 1: every finding code an L3 contract method declares must be anchored in the method\'s own source file (the method\'s sourcePath, else the implementation\'s) — as a string literal or, at exact grade, a property-access name, so a code reported through a constants object counts. Below exact grade any identifier or word counts, and the grade rides on the finding. Respects the conformance dial (off skips), leaves unresolvable files to source-file-linkage, and skips implementations under chained subsystems (projectPath), which validate standalone in their own project run.',
  codes: [
    { code: 'UNREALIZED_FINDING', defaultSeverity: 'warning', summary: 'A finding code a contract method declares appears in the method\'s source file neither as a string literal nor as a property-access name (below exact grade, any identifier counts)' },
  ],

  check(ctx: RuleContext): void {
    /** Each file's anchoredNames alone — string literals and property-access names at exact grade (weaker grades add identifiers or words). */
    const lookups = new Map<string, { findingAnchors: Set<string>; facts: SourceFileFacts }>();
    for (const facts of ctx.codeModel.files) {
      lookups.set(pathKey(facts.path), { findingAnchors: new Set(facts.anchoredNames), facts });
    }

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
        if (!method.findings?.length) continue;
        const methodImpl = impl.methods.find(m => m.name === method.name);
        const tier = (methodImpl?.conformance as ConformanceTier | undefined) ?? specTier;
        if (tier === 'off') continue;
        const file = methodSourceFile(methodImpl ?? {}, impl.sourcePath);
        if (!file) continue;
        const lookup = lookups.get(pathKey(file));
        if (!lookup || lookup.facts.status !== 'analyzed') continue;

        for (const finding of method.findings) {
          if (lookup.findingAnchors.has(finding.code)) continue;
          ctx.addIssue(
            'warning',
            'UNREALIZED_FINDING',
            `Method "${method.name}" of contract "${impl.contract}" declares finding "${finding.code}", but "${file}" has no string literal or property-access name "${finding.code}" (analysis grade: ${lookup.facts.analysisGrade}) — report the finding under its declared code, or remove the declaration.`,
            impl.id,
            draft,
          );
        }
      }
    }
  },
};
