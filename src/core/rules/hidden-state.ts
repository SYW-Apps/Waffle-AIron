import type { ImplementationSpec } from '../../models/index.js';
import { normalizeSourcePath } from '../source-analysis.js';
import { RuleContext, SddRule } from './types.js';
import { isInChainedSubproject } from './conformance.js';

// ---------------------------------------------------------------------------
// HIDDEN_STATE — the enforcement half of the fields-vs-Store criterion.
//
// The doctrine: a component's own fields hold only wiring/config/ephemeral
// state; anything written after construction AND read across separate
// entrypoint activations is domain state and belongs in a Store (or a Store
// with durability: cache, for memo state). This lint is the honest STATIC
// approximation: module-scope mutable bindings (`let`/`var`) in a file whose
// mapped components are exclusively LOGIC stereotypes.
//
// Deliberately conservative:
//  - exact analysis grade only (lower grades never guess);
//  - files mapped to ANY data/boundary component are exempt (a shared file
//    hosting a Store's state is the Store's business — N:1 collapse);
//  - conformance: off implementations don't count as mapping evidence;
//  - mutation of const-bound containers (a `const map = new Map()` that is
//    written per-request) is invisible to this check — the finding text says
//    what was measured, never more.
// ---------------------------------------------------------------------------

/** The stereotypes where behavior lives and held state must not. */
const LOGIC_STEREOTYPES = new Set(['Orchestrator', 'Supervisor', 'Actor', 'Specialist']);

export const hiddenStateRule: SddRule = {
  name: 'hidden-state',
  description:
    'The fields-vs-Store criterion, statically approximated: module-scope mutable bindings (let/var) in a source file mapped EXCLUSIVELY to logic-stereotype components (Orchestrator/Supervisor/Actor/Specialist) are flagged as hidden held state — state a logic component keeps for itself is invisible to the spec, the canvas, and every persistence rule. Promote it to a Store (durability: cache for loss-safe memo state), or lint.allow with the reason it is genuinely wiring/ephemeral. Exact analysis grade only; files also mapped to data or boundary components are exempt (N:1 collapse); const-bound container mutation is beyond this check and the finding says so.',
  codes: [
    { code: 'HIDDEN_STATE', defaultSeverity: 'warning', summary: 'Module-scope mutable binding in a file mapped only to logic-stereotype components — held state hiding outside a Store' },
  ],
  check(ctx: RuleContext) {
    // sourcePath → the implementations mapping it (with their components).
    const byPath = new Map<string, { impl: ImplementationSpec; componentType: string; compId: string }[]>();
    for (const impl of ctx.implementations) {
      if (!impl.sourcePath) continue;
      if (impl.conformance === 'off') continue; // untrusted mapping
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!component) continue;
      if (isInChainedSubproject(component.subsystem, ctx)) continue;
      const key = normalizeSourcePath(impl.sourcePath);
      const list = byPath.get(key) ?? [];
      list.push({ impl, componentType: component.componentType, compId: component.id });
      byPath.set(key, list);
    }

    for (const facts of ctx.codeModel.files) {
      if (facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      const bindings = facts.topLevelMutableBindings ?? [];
      if (bindings.length === 0) continue;

      const mapped = byPath.get(normalizeSourcePath(facts.path)) ?? [];
      if (mapped.length === 0) continue;
      if (!mapped.every(m => LOGIC_STEREOTYPES.has(m.componentType))) continue;

      const anchor = [...mapped].sort((a, b) => a.impl.id.localeCompare(b.impl.id))[0];
      const compList = [...new Set(mapped.map(m => `${m.compId} (${m.componentType})`))].join(', ');
      ctx.addIssue(
        'warning',
        'HIDDEN_STATE',
        `"${facts.path}" holds module-scope mutable binding(s) ${bindings.map(b => `"${b}"`).join(', ')} while realizing only logic components (${compList}). State written after construction and read across invocations belongs in a Store — visible to the spec — not inside a logic component (a loss-safe memo belongs in a Store with durability: cache). Promote the state, or lint.allow with the reason it is genuinely wiring/ephemeral. (Measured: let/var at module scope, exact grade; const-bound container mutation is beyond this check.)`,
        anchor.impl.id,
        mapped.some(m => ctx.isImplementationDraft(m.impl)),
      );
    }
  },
};
