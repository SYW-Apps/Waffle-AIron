import type { SourceFileFacts } from '../source-analysis.js';
import { normalizeSourcePath } from '../source-analysis.js';
import { RuleContext, SddRule } from './types.js';
import { isInChainedSubproject, stereotypeDefaultTier } from './conformance.js';

// ---------------------------------------------------------------------------
// Call-step realization (code↔spec Level 3, the opener).
//
// Levels 1–2 prove the code matches the spec's SHAPE (files, symbols, import
// graph). This rule takes the first honest step toward INTENT: every `call`
// step of a narrative must appear as a callee of the realized function.
//
// What it proves — and all it proves: the realized function (exact AST grade
// only) contains a call to the target method's name (or its per-method
// `symbol` override), where "contains" closes transitively over same-file
// named helpers the function calls (extract-helper refactors stay clean).
// Order, arguments, and conditions are deliberately unverified — this is set
// membership, not behavioral equivalence, and the finding text says so.
// `dispatch` steps are skipped: they route through runtime tables, so the
// bound method's name legitimately never appears at the call site.
// ---------------------------------------------------------------------------

/**
 * Own-property record lookup: callee/function names include things like
 * "toString" and "constructor", which a bare index would resolve to
 * Object.prototype members (functions — not iterable, not numbers).
 */
function ownEntry<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/** Callee set of `fn`, closed transitively over same-file named functions. */
export function closedCallees(facts: SourceFileFacts, fn: string): Set<string> | undefined {
  const direct = ownEntry(facts.functionCalls, fn);
  if (!direct) return undefined;
  const closed = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length) {
    const name = queue.pop()!;
    for (const next of ownEntry(facts.functionCalls, name) ?? []) {
      if (!closed.has(next)) {
        closed.add(next);
        queue.push(next);
      }
    }
  }
  return closed;
}

export const callConformanceRule: SddRule = {
  name: 'call-conformance',
  description:
    'Code↔spec Level 3 (opener): every narrative `call` step of an exactly-analyzed method must be realized as a call in the realized function — the target method\'s contract name or its per-method symbol override must appear among the function\'s callees, closed transitively over same-file named helpers. Set membership only: order, arguments, and conditions are deliberately unverified, and dispatch steps (runtime-table routed) are skipped. Respects the conformance dial (off skips) and fires only at exact analysis grade — weaker grades never guess.',
  codes: [
    { code: 'CALL_STEP_UNREALIZED', defaultSeverity: 'warning', summary: 'Narrative call step whose target method name (or symbol) never appears among the realized function\'s callees (exact grade, set membership)' },
  ],
  check(ctx: RuleContext) {
    const factsByPath = new Map<string, SourceFileFacts>();
    for (const f of ctx.codeModel.files) factsByPath.set(normalizeSourcePath(f.path), f);

    for (const impl of ctx.implementations) {
      if (!impl.sourcePath) continue;
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;
      const component = ctx.componentMap.get(contract.component);
      if (!component) continue;
      if (isInChainedSubproject(component.subsystem, ctx)) continue;

      const facts = factsByPath.get(normalizeSourcePath(impl.sourcePath));
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;

      const specTier = impl.conformance ?? stereotypeDefaultTier(component.componentType);
      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        const tier = implMethod.conformance ?? specTier;
        if (tier === 'off') continue;
        if (!implMethod.narrative.length) continue;

        const fnSymbol = implMethod.symbol ?? implMethod.name;
        const callees = closedCallees(facts, fnSymbol);
        // The realized function itself is missing — UNREALIZED_METHOD's find,
        // not ours; a duplicate finding here would just be noise.
        if (!callees) continue;

        // Aggregate per method: one finding listing every unrealized call
        // step, so a method with systematic naming drift reads as one review
        // item instead of a finding per step.
        const missing: { step: number; target: string; accepted: string[] }[] = [];
        for (const step of implMethod.narrative) {
          if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
          // Dangling targets are the contracts rule's findings.
          if (!ctx.componentMap.has(step.targetComponent)) continue;

          // Accept the contract name or any symbol override a target-side
          // implementation declares for that method.
          const accepted = new Set<string>([step.targetMethod]);
          for (const targetIntf of ctx.interfacesByComponent.get(step.targetComponent) ?? []) {
            for (const targetImpl of ctx.implementationsByContract.get(targetIntf.id) ?? []) {
              const targetMethod = targetImpl.methods.find(m => m.name === step.targetMethod);
              if (targetMethod?.symbol) accepted.add(targetMethod.symbol);
            }
          }

          // N:1 identity forwarding: when the caller's own realized symbol IS
          // the target name, facade and target collapse onto one function
          // (pure 1:1 forwarding, barrel republication) — the call step is
          // realized by identity, exactly as Level 1's N:1 sharing blesses.
          if (accepted.has(fnSymbol)) continue;
          if ([...accepted].some(name => callees.has(name))) continue;
          missing.push({
            step: step.stepNumber,
            target: `${step.targetComponent}.${step.targetMethod}`,
            accepted: [...accepted],
          });
        }
        if (missing.length === 0) continue;
        const detail = missing
          .map(m => `step ${m.step} → ${m.target} (looked for ${m.accepted.map(a => `"${a}"`).join(' / ')})`)
          .join('; ');
        ctx.addIssue(
          'warning',
          'CALL_STEP_UNREALIZED',
          `Method "${implMethod.name}" in implementation "${impl.id}": ${missing.length} narrative call step(s) are not realized as calls of the function "${fnSymbol}" in "${impl.sourcePath}" — ${detail}. Callees are matched by name, closed over same-file helpers (exact grade, set membership — order and arguments are not checked). Realize the calls, fix the narrative, or map code names via per-method symbols on the targets.`,
          impl.id,
          isDraftCtx,
        );
      }
    }
  },
};
