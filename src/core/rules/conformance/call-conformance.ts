import {
  callSitesOf,
  defaultConformanceTier,
  methodSourceFile,
  pathKey,
  type CallSiteFact,
} from '../../../models/index.js';
import { CodeIndex, RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Call-step realization (code↔spec Level 3), both directions.
//
// Levels 1–2 prove the code matches the spec's SHAPE (files, symbols, import
// graph). This rule reads INTENT, over one relation — a narrative `call` step
// and the call that realizes it — asked both ways, exactly as Level 2 asks
// about imports both ways:
//
//   forward   every `call` step must be realized by a call that RESOLVES TO
//             the target's own source file. Matching the callee's NAME alone
//             was the old answer, and it let a `save` in an unrelated module
//             satisfy a step that named the billing store's `save`. When the
//             call is there but a pure model cannot say where it lands, that
//             is CALL_ORIGIN_UNRESOLVED — a different answer from "the call is
//             missing", and keeping them apart is the point: only what
//             resolved may accuse. A `this.store.save()` receiver is followed
//             through the TYPE the class declares that field with, which says
//             where the callee CAN have been written and never where it was:
//             so that reading accepts a step, and a landing a finding names
//             still comes from what was proven.
//   converse  a call to a modelled method of ANOTHER component that lives in
//             the SAME FILE crosses a component boundary while looking local,
//             so the narrative must declare it (UNDECLARED_COLOCATED_CALL).
//             The file-level checks structurally cannot see that hop: nothing
//             is imported, and Level 2 judges edges BETWEEN files.
//
// What the forward direction still does not prove: order, arguments and
// conditions stay deliberately unverified — this is reachability of a call
// site, not behavioral equivalence, and the finding text says so. `dispatch`
// steps are skipped: they route through runtime tables, so the bound method's
// name legitimately never appears at the call site.
// ---------------------------------------------------------------------------

/**
 * Every call site the function makes, closed transitively over the named
 * helpers it calls (so extract-helper refactors stay clean), each carrying the
 * file its names resolve in. Undefined when the file holds no BODY under `fn`
 * — the answer METHOD_BODY_NOT_FOUND reports, and never confused with an empty
 * list, which is a body that calls nothing.
 *
 * `stopAt` names the callees the walk RECORDS but does not descend into: a
 * modelled method's own callees belong to its own narrative, so the converse
 * direction stops there instead of attributing them to the caller.
 */
export function closedCallSites(
  code: CodeIndex,
  file: string,
  fn: string,
  stopAt?: ReadonlySet<string>,
): CallSiteFact[] | undefined {
  const facts = code.factsAt(file);
  const direct = facts && callSitesOf(facts, fn);
  if (!direct) return undefined;
  const here = pathKey(file);
  const out: CallSiteFact[] = [];
  const descended = new Set<string>([`${here}|${fn}`]);
  const queue: CallSiteFact[] = direct.map(s => ({ ...s, from: s.from ?? here }));
  while (queue.length) {
    const site = queue.pop()!;
    out.push(site);
    if (stopAt?.has(site.name)) continue;
    const key = `${site.from}|${site.name}`;
    if (descended.has(key)) continue;
    descended.add(key);
    // Descend into whatever body the scope file holds under that name. This
    // is permissive on purpose — a wider callee set can only make the forward
    // direction ACCEPT more, never accuse — so a `this.helper()` hop into a
    // same-file method stays closed over, as it always was.
    const scope = code.factsAt(site.from!);
    const next = scope && callSitesOf(scope, site.name);
    if (!next) continue;
    queue.push(...next.map(s => ({ ...s, from: s.from ?? site.from })));
  }
  return out;
}

/** What a narrative step's target is in code: the names that realize it, and the files they are written in. */
interface CallTarget {
  /** The contract name, plus every per-method `symbol` override a target-side implementation declares. */
  accepted: Set<string>;
  /** The files realizing the target method: each implementation's method sourcePath, else the implementation's own. */
  files: Set<string>;
}

function resolveCallTarget(ctx: RuleContext, componentId: string, methodName: string): CallTarget {
  const accepted = new Set<string>([methodName]);
  const files = new Set<string>();
  for (const intf of ctx.interfacesByComponent.get(componentId) ?? []) {
    for (const impl of ctx.implementationsByContract.get(intf.id) ?? []) {
      const method = impl.methods.find(m => m.name === methodName);
      if (!method && !intf.methods.some(m => m.name === methodName)) continue;
      if (method?.symbol) accepted.add(method.symbol);
      const file = methodSourceFile(method ?? {}, impl.sourcePath);
      if (file) files.add(pathKey(file));
    }
  }
  return { accepted, files };
}

/** Why a call step was not accepted. The three answers are deliberately distinct, and only two of them accuse. */
type Miss =
  | { kind: 'absent' }
  | { kind: 'elsewhere'; landed: string[] }
  | { kind: 'unresolved' };

interface MissedStep {
  step: number;
  target: string;
  accepted: string[];
  miss: Miss;
}

function describeMiss(m: MissedStep): string {
  const head = `step ${m.step} → ${m.target} (looked for ${m.accepted.map(a => `"${a}"`).join(' / ')}`;
  return m.miss.kind === 'elsewhere'
    ? `${head}, called but resolved to ${m.miss.landed.map(p => `"${p}"`).join(', ')})`
    : `${head})`;
}

export const callConformanceRule: SddRule = {
  name: 'call-conformance',
  description:
    'Code↔spec Level 3: the narrative `call` step ↔ realized call relation, judged both ways against the method\'s own source file (its sourcePath, else the implementation\'s), at exact analysis grade only. Forward: every `call` step must be realized by a call whose callee RESOLVES TO one of the target method\'s own source files — the target\'s contract name or a per-method `symbol` override, closed transitively over the named helpers the realized function calls, and resolved against every file the call CAN have reached, a `this.<field>.<method>()` receiver followed through the field\'s DECLARED TYPE to the module declaring it; a matching call whose origin a pure model cannot resolve is reported apart as CALL_ORIGIN_UNRESOLVED rather than accused of being missing, a finding names a landing only from the PROVEN tier so that widening what a call reached can accept a step but never accuse one, and a target that names no file of its own falls back to name membership. Converse: a call that resolves to a modelled method of ANOTHER component in the SAME file crosses a component boundary while looking local, so the narrative must declare it (UNDECLARED_COLOCATED_CALL) — judged on the proven tier alone, and a same-file private helper is no modelled method and is never reported. Order, arguments and conditions stay unverified, dispatch steps (runtime-table routed) are skipped, the conformance dial (off) skips, and weaker analysis grades never guess.',
  codes: [
    { code: 'CALL_STEP_UNREALIZED', defaultSeverity: 'warning', summary: 'Narrative call step realized by no call that resolves to the target method\'s own source file — the call is absent, or it lands in another module' },
    { code: 'CALL_ORIGIN_UNRESOLVED', defaultSeverity: 'warning', summary: 'Narrative call step whose target name IS called, but only from call sites a pure model cannot resolve to any file — neither proven realized nor accused' },
    { code: 'UNDECLARED_COLOCATED_CALL', defaultSeverity: 'warning', summary: 'The realized function calls a modelled method of another component living in the same source file, and no narrative step declares that call' },
  ],
  check(ctx: RuleContext) {
    const code = ctx.codeIndex();

    // ctx.implementationMethods() is the descent — implementation, contract,
    // component, chained-subproject skip, method, source file — resolved once
    // for the whole run. What is done with the file it hands over stays here:
    // the conformance dial and the exact-grade gate are this rule's own
    // honesty stance, and belong where its accusation is read.
    const methods = ctx.implementationMethods();

    // Which modelled method each realizing symbol IS, per file — the converse
    // direction's whole subject, read off the same descent so a component and
    // its colocated neighbour come from one walk.
    const modelledAt = new Map<string, Map<string, { component: string; method: string }>>();
    for (const entry of methods) {
      if (!entry.sourceFile) continue;
      const file = pathKey(entry.sourceFile);
      const byName = modelledAt.get(file) ?? new Map<string, { component: string; method: string }>();
      byName.set(entry.method.symbol ?? entry.method.name, { component: entry.component.id, method: entry.method.name });
      modelledAt.set(file, byName);
    }

    for (const entry of methods) {
      const { implementation: impl, method: implMethod, component, sourceFile: file } = entry;
      const tier = implMethod.conformance ?? impl.conformance ?? defaultConformanceTier(component);
      if (tier === 'off') continue;
      if (!implMethod.narrative.length) continue;

      // The realized function lives in the method's own source file: its
      // sourcePath, else the implementation's. Exact grade only.
      if (!file) continue;
      const facts = code.factsAt(file);
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;

      const here = pathKey(file);
      const fnSymbol = implMethod.symbol ?? implMethod.name;
      const colocated = modelledAt.get(here) ?? new Map<string, { component: string; method: string }>();
      // The two directions close over different walks, and the difference is
      // doctrine rather than reuse. Forward closes over EVERYTHING the
      // function reaches: a wider callee set can only accept more, and a step
      // realized through a neighbour's method is still realized. The converse
      // stops AT a colocated modelled method, because what that method goes on
      // to call belongs to its own narrative, not to this caller's.
      const sites = closedCallSites(code, file, fnSymbol);
      // The realized function has no body here: UNREALIZED_METHOD's find when
      // the name is absent altogether, METHOD_BODY_NOT_FOUND's when it is a
      // bodyless declaration. Either way, not ours.
      if (!sites) continue;

      // ---- forward: every call step realized by a resolving call ----------
      const missed: MissedStep[] = [];
      for (const step of implMethod.narrative) {
        if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
        // A target this tree does not contain is cross-tree-references'
        // finding (and surface-reference-backing's once it resolves).
        if (!ctx.componentMap.has(step.targetComponent)) continue;

        const target = resolveCallTarget(ctx, step.targetComponent, step.targetMethod);

        // N:1 identity forwarding: when the caller's own realized symbol IS
        // the target name, facade and target collapse onto one function
        // (pure 1:1 forwarding, barrel republication) — the call step is
        // realized by identity, exactly as Level 1's N:1 sharing blesses.
        if (target.accepted.has(fnSymbol)) continue;

        const matching = sites.filter(s => target.accepted.has(s.name));
        const ref = `${step.targetComponent}.${step.targetMethod}`;

        // The target names no file of its own (MISSING_SOURCE_PATH reports
        // exactly that), so there is nothing to resolve AGAINST: the step
        // falls back to the name membership this check has always had.
        if (target.files.size === 0) {
          if (matching.length === 0) {
            missed.push({ step: step.stepNumber, target: ref, accepted: [...target.accepted], miss: { kind: 'absent' } });
          }
          continue;
        }

        // Two tiers, and the difference is the whole of the honesty here.
        // ACCEPTANCE reads everything a call can have reached, `this.store`
        // followed through the type the class declares the field with. A
        // LANDING a finding may name comes from the proven tier alone: a
        // declared type says what a collaborator is, not which class ships the
        // body, so widening what a call reached can only ever accept a step —
        // it must never turn "I cannot say" into an accusation.
        const landed = new Set<string>();
        let realized = false;
        for (const site of matching) {
          for (const origin of code.originOf(site, file)) landed.add(origin);
          for (const origin of code.possibleOriginsOf(site, file)) {
            if (target.files.has(origin)) realized = true;
          }
        }
        if (realized) continue;
        const miss: Miss = matching.length === 0
          ? { kind: 'absent' }
          : landed.size === 0
            ? { kind: 'unresolved' }
            : { kind: 'elsewhere', landed: [...landed].sort() };
        missed.push({ step: step.stepNumber, target: ref, accepted: [...target.accepted], miss });
      }

      const unrealized = missed.filter(m => m.miss.kind !== 'unresolved');
      const unresolved = missed.filter(m => m.miss.kind === 'unresolved');
      if (unrealized.length) {
        ctx.addIssue(
          'warning',
          'CALL_STEP_UNREALIZED',
          `Method "${implMethod.name}" in implementation "${impl.id}": ${unrealized.length} narrative call step(s) are realized by no call of the function "${fnSymbol}" in "${file}" that resolves to the target's own source file — ${unrealized.map(describeMiss).join('; ')}. Callees are closed over the named helpers the function calls, and each call site is resolved through this file's import bindings (order, arguments and conditions are not checked). Realize the calls, fix the narrative, or map code names via per-method symbols on the targets.`,
          impl.id,
          entry.draftContext,
        );
      }
      if (unresolved.length) {
        ctx.addIssue(
          'warning',
          'CALL_ORIGIN_UNRESOLVED',
          `Method "${implMethod.name}" in implementation "${impl.id}": ${unresolved.length} narrative call step(s) ARE called by name inside the function "${fnSymbol}" in "${file}", but only from call sites this analysis cannot resolve to any file — ${unresolved.map(describeMiss).join('; ')}. A member call through a value (\`this.store.save()\`, \`handle.save()\`) carries no origin a pure model can read, so the step is neither proven realized nor accused of being missing. Call the target through its module binding, or accept this as the grade's limit.`,
          impl.id,
          entry.draftContext,
        );
      }

      // ---- converse: colocated calls the narrative never declared ---------
      const declared = new Set<string>();
      for (const step of implMethod.narrative) {
        if (step.targetComponent && step.targetMethod) declared.add(`${step.targetComponent}.${step.targetMethod}`);
      }
      const crossings = new Map<string, string>();
      for (const site of closedCallSites(code, file, fnSymbol, new Set(colocated.keys())) ?? []) {
        const owner = colocated.get(site.name);
        if (!owner || owner.component === component.id) continue;
        const ref = `${owner.component}.${owner.method}`;
        if (declared.has(ref) || crossings.has(ref)) continue;
        // Only a call this analysis RESOLVES to this very file is a colocated
        // crossing. A same-named function reached through a value or through
        // an import is somebody else's, and a private helper is no modelled
        // method at all — so a rule's internal factoring is never a finding.
        if (!code.originOf(site, file).has(here)) continue;
        crossings.set(ref, site.name);
      }
      if (crossings.size) {
        const detail = [...crossings].map(([ref, name]) => `"${name}" (${ref})`).join('; ');
        ctx.addIssue(
          'warning',
          'UNDECLARED_COLOCATED_CALL',
          `Method "${implMethod.name}" in implementation "${impl.id}": the function "${fnSymbol}" in "${file}" calls ${crossings.size} modelled method(s) of OTHER components living in that same file, and no narrative step declares the call — ${detail}. Sharing a file does not make the hop internal: it crosses a component boundary nothing imports, so no file-level check can see it. Narrate the call, or move the code so the boundary is real.`,
          impl.id,
          entry.draftContext,
        );
      }
    }
  },
};
