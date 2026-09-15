import { holdsState, isLogic, methodSourceFile, pathKey, type ComponentSpec, type ImplementationSpec } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// HIDDEN_STATE — the enforcement half of the fields-vs-Store criterion.
//
// The doctrine: a component's own fields hold only wiring/config/ephemeral
// state; anything written after construction AND read across separate
// entrypoint activations is domain state and belongs in a Store (or a Store
// with durability: cache, for memo state). This lint is the honest STATIC
// approximation: module-scope mutable bindings (`let`/`var`) in a file whose
// mapped components are exclusively STATELESS LOGIC — logic that holds no
// state of its own, which is an Orchestrator (or a Specialist until it is
// migrated). A component maps every file its implementations name: each
// implementation's sourcePath and each method's own sourcePath.
//
// Deliberately conservative:
//  - exact analysis grade only (lower grades never guess);
//  - files mapped to ANY component that is not stateless logic are exempt: a
//    shared file hosting a data or boundary component's state is that
//    component's business (N:1 collapse), and a Supervisor or Actor holds
//    runtime state by definition;
//  - a file dialed conformance: off is no mapping evidence: the
//    implementation's own sourcePath when the implementation is off, and a
//    method's file when that method's dial (its own, else the
//    implementation's) is off;
//  - mutation of const-bound containers (a `const map = new Map()` that is
//    written per-request) is invisible to this check — the finding text says
//    what was measured, never more.
// ---------------------------------------------------------------------------

/** Stateless logic: logic that holds no state of its own between calls. */
const isStatelessLogic = (component: ComponentSpec): boolean => isLogic(component) && !holdsState(component);

export const hiddenStateRule: SddRule = {
  name: 'hidden-state',
  description:
    'The fields-vs-Store criterion, statically approximated: module-scope mutable bindings (let/var) in a source file mapped EXCLUSIVELY to stateless logic (Orchestrators, and Specialists until they are migrated) — a component maps every file its implementations and their methods name — are flagged as hidden held state — state a logic component keeps for itself is invisible to the spec, the canvas, and every persistence rule. Promote it to a Store (durability: cache for loss-safe memo state), or lint.allow with the reason it is genuinely wiring/ephemeral. Exact analysis grade only; files also mapped to data or boundary components, or to a Supervisor or Actor (which hold runtime state by definition), are exempt (N:1 collapse); const-bound container mutation is beyond this check and the finding says so.',
  codes: [
    { code: 'HIDDEN_STATE', defaultSeverity: 'warning', summary: 'Module-scope mutable binding in a file mapped only to stateless logic (Orchestrators) — held state hiding outside a Store, Supervisor or Actor' },
  ],
  check(ctx: RuleContext) {
    // Source file → the implementations mapping it (with their components).
    const byPath = new Map<string, { impl: ImplementationSpec; component: ComponentSpec }[]>();
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const component = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!component) continue;
      if (ctx.isInChainedSubproject(component.subsystem)) continue;
      // The conformance dial decides which named files are trusted mapping
      // evidence (off marks generated or vendored code): the implementation's
      // own sourcePath unless it is off, and each method's file unless the
      // method's dial — its own, else the implementation's — is off.
      const trusted: string[] = [];
      if (impl.sourcePath && impl.conformance !== 'off') trusted.push(impl.sourcePath);
      for (const method of impl.methods) {
        if ((method.conformance ?? impl.conformance) === 'off') continue;
        const file = methodSourceFile(method, impl.sourcePath);
        if (file) trusted.push(file);
      }
      for (const file of trusted) {
        const key = pathKey(file);
        const list = byPath.get(key) ?? [];
        if (list.some(m => m.impl === impl)) continue;
        list.push({ impl, component });
        byPath.set(key, list);
      }
    }

    for (const facts of ctx.codeModel.files) {
      if (facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      const bindings = facts.topLevelMutableBindings ?? [];
      if (bindings.length === 0) continue;

      const mapped = byPath.get(pathKey(facts.path)) ?? [];
      if (mapped.length === 0) continue;
      if (!mapped.every(m => isStatelessLogic(m.component))) continue;

      const anchor = [...mapped].sort((a, b) => a.impl.id.localeCompare(b.impl.id))[0];
      const compList = [...new Set(mapped.map(m => `${m.component.id} (${m.component.componentType})`))].join(', ');
      ctx.addIssue(
        'warning',
        'HIDDEN_STATE',
        `"${facts.path}" holds module-scope mutable binding(s) ${bindings.map(b => `"${b}"`).join(', ')} while realizing only stateless logic components (${compList}). State written after construction and read across invocations belongs in a Store — visible to the spec — not inside a logic component (a loss-safe memo belongs in a Store with durability: cache). Promote the state, or lint.allow with the reason it is genuinely wiring/ephemeral. (Measured: let/var at module scope, exact grade; const-bound container mutation is beyond this check.)`,
        anchor.impl.id,
        mapped.some(m => ctx.isImplementationDraft(m.impl)),
      );
    }
  },
};
