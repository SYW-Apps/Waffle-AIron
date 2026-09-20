import {
  callSitesOf,
  defaultConformanceTier,
  methodSourceFile,
  parseDeclaredCall,
  pathKey,
  type CallSiteFact,
  type MethodImplementation,
} from '../../../models/index.js';
import { CodeIndex, RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Call realization (code↔spec Level 3), both directions.
//
// Levels 1–2 prove the code matches the spec's SHAPE (files, symbols, import
// graph). This rule reads INTENT, over one relation — a call the method CLAIMS
// and the call that realizes it — asked both ways, exactly as Level 2 asks
// about imports both ways.
//
// A method claims a call two ways, and they are ONE subject here. A narrative
// `call` step names a target and where in the flow it is reached; an entry of
// the method's declared `calls` names the same target with no flow to place it
// in, because its narrative shows no steps. This check never reads order, so
// the step number is not part of the claim it judges — it is only how a
// finding POINTS at the claim. Two claims, one question, one verdict: a
// declaration that bought reachability in the graph is worth no more than a
// step that did, and until this rule read them both, one of them was free.
//
//   forward   every claim must be realized by a call that RESOLVES TO
//             the target's own source file. Matching the callee's NAME alone
//             was the old answer, and it let a `save` in an unrelated module
//             satisfy a claim that named the billing store's `save`. When the
//             call is there but a pure model cannot say where it lands, that
//             is CALL_ORIGIN_UNRESOLVED — a different answer from "the call is
//             missing", and keeping them apart is the point: only what
//             resolved may accuse. A `this.store.save()` receiver is followed
//             through the TYPE the class declares that field with, and a
//             `new Registry(store).save()` receiver through the module its
//             CLASS NAME came from — each says where the callee CAN have been
//             written and never where it was: so those readings accept a
//             claim, and a landing a finding names still comes from what was
//             proven.
//   converse  a call to a modelled method of ANOTHER component that lives in
//             the SAME FILE crosses a component boundary while looking local,
//             so the method must claim it (UNDECLARED_COLOCATED_CALL) — in a
//             narrative step, or in its declared `calls`. The file-level
//             checks structurally cannot see that hop: nothing is imported,
//             and Level 2 judges edges BETWEEN files.
//
// What the forward direction still does not prove: order, arguments and
// conditions stay deliberately unverified — this is reachability of a call
// site, not behavioral equivalence, and the finding text says so. `dispatch`
// steps are skipped: they route through runtime tables, so the bound method's
// name legitimately never appears at the call site. A declared reference that
// is not `<component>.<method>` names no target at all, which is
// MALFORMED_DECLARED_CALL's finding and never a silent acceptance here.
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

/** What a claim's target is in code: the names that realize it, and the files they are written in. */
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

/**
 * One call a method CLAIMS it makes: a narrative `call` step, or an entry of
 * its declared `calls`. They assert the same thing — this method calls that
 * component's method — and differ only in that a step also says where in the
 * flow it happens. This check never reads order, so that difference is not
 * part of the claim: it is how a finding POINTS at one, and nothing more.
 */
interface CallClaim {
  /** The narrative step's number; absent on a declared call, which has no step to point at. */
  step?: number;
  component: string;
  method: string;
}

/**
 * Everything a method claims it calls: its narrative `call` steps, then its
 * declared `calls`. A `dispatch` step routes through a runtime table and names
 * a capability rather than a method, so it asserts nothing about a call site
 * and is no claim. A declared reference that is not `<component>.<method>`
 * names no target to check — MALFORMED_DECLARED_CALL reports exactly that, and
 * a second accusation here would say the same thing twice.
 */
function claimsOf(implMethod: MethodImplementation): CallClaim[] {
  const claims: CallClaim[] = [];
  for (const step of implMethod.narrative) {
    if (step.type !== 'call' || !step.targetComponent || !step.targetMethod) continue;
    claims.push({ step: step.stepNumber, component: step.targetComponent, method: step.targetMethod });
  }
  for (const ref of implMethod.calls ?? []) {
    const parsed = parseDeclaredCall(ref);
    if (parsed) claims.push({ component: parsed.compId, method: parsed.methodName });
  }
  return claims;
}

/** Why a claim was not accepted. The three answers are deliberately distinct, and only two of them accuse. */
type Miss =
  | { kind: 'absent' }
  | { kind: 'elsewhere'; landed: string[] }
  /** `shapes`: how the matching sites were WRITTEN — an answer that cannot say where a call went owes the form it could not follow. */
  | { kind: 'unresolved'; shapes: string[] };

interface MissedClaim {
  /** The narrative step's number, absent on a declared call — the whole of what tells the two apart in a finding. */
  step?: number;
  target: string;
  accepted: string[];
  miss: Miss;
}

/**
 * How a finding names the claim it missed, and how the debt register and a
 * lint allow name that same unit: a step by its number and target, a
 * declaration by its target alone — which is the `calls` entry verbatim.
 */
const unitOf = (m: MissedClaim): string => (m.step === undefined ? m.target : `${m.step}:${m.target}`);

/** What a method's claims ARE, for a finding that counts them. A schema-valid method declares calls or narrates them, never both. */
const claimNoun = (implMethod: MethodImplementation): string =>
  (implMethod.narrative.length ? 'narrative call step(s)' : 'declared call(s)');

/**
 * How a call site was WRITTEN, read off its shape alone — the subject of the
 * unresolved answer. The shape is all this reports: naming the form it could
 * not follow is the honest content of "I cannot say", where advice to write
 * the call differently would be asking working code to suit the analysis.
 */
function describeSite(site: CallSiteFact): string {
  if (!site.member) return `${site.name}(…)`;
  if (site.via) return `${site.via}.${site.name}(…)`;
  if (site.field) return `this.${site.field}.${site.name}(…)`;
  if (site.constructed) return `new ${site.constructed}(…).${site.name}(…)`;
  return `<receiver>.${site.name}(…)`;
}

function describeMiss(m: MissedClaim): string {
  const where = m.step === undefined ? 'declared call' : `step ${m.step}`;
  const head = `${where} → ${m.target} (looked for ${m.accepted.map(a => `"${a}"`).join(' / ')}`;
  if (m.miss.kind === 'elsewhere') return `${head}, called but resolved to ${m.miss.landed.map(p => `"${p}"`).join(', ')})`;
  if (m.miss.kind === 'unresolved') return `${head}, written as ${m.miss.shapes.map(s => `\`${s}\``).join(' / ')})`;
  return `${head})`;
}

export const callConformanceRule: SddRule = {
  name: 'call-conformance',
  description:
    'Code↔spec Level 3: the CLAIMED call ↔ realized call relation, judged both ways against the method\'s own source file (its sourcePath, else the implementation\'s), at exact analysis grade only. A method claims a call two ways and they face one check: a narrative `call` step, and an entry of the declared `calls` a narrative-less method reaches its collaborators through. They assert the same thing, and the step number is no part of the claim — this check never reads order, so it is only how a finding points at one. Forward: every claim must be realized by a call whose callee RESOLVES TO one of the target method\'s own source files — the target\'s contract name or a per-method `symbol` override, closed transitively over the named helpers the realized function calls, and resolved against every file the call CAN have reached: a `this.<field>.<method>()` receiver followed through the field\'s DECLARED TYPE, a `new Class(...).<method>()` receiver through the module its CLASS NAME came from. A matching call whose origin a pure model cannot resolve is reported apart as CALL_ORIGIN_UNRESOLVED, which NAMES the shape it could not follow and asks for nothing — a coverage hole in the reader, reported for the reason CONFORMANCE_DEGRADED is: a silently degraded gate is worse than a degraded one. A finding names a landing only from the PROVEN tier so that widening what a call reached can accept a claim but never accuse one, and a target that names no file of its own falls back to name membership. Converse: a call that resolves to a modelled method of ANOTHER component in the SAME file crosses a component boundary while looking local, so the method must claim it — in a step or in `calls` (UNDECLARED_COLOCATED_CALL) — judged on the proven tier alone, and a same-file private helper is no modelled method and is never reported. A method that claims nothing at all is judged in neither direction: what it leaves unsaid is UNUSED_*\'s subject. Order, arguments and conditions stay unverified, dispatch steps (runtime-table routed) are no claim about a call site, a malformed declared reference is MALFORMED_DECLARED_CALL\'s finding and names no target here, the conformance dial (off) skips, and weaker analysis grades never guess.',
  codes: [
    { code: 'CALL_STEP_UNREALIZED', defaultSeverity: 'warning', summary: 'Narrative call step or declared call realized by no call that resolves to the target method\'s own source file — the call is absent, or it lands in another module', carryable: true },
    { code: 'CALL_ORIGIN_UNRESOLVED', defaultSeverity: 'warning', summary: 'Narrative call step or declared call whose target name IS called, but only from call sites written in a shape this analysis cannot resolve to a file — the claim was not checked, and is neither proven realized nor accused', carryable: true },
    { code: 'UNDECLARED_COLOCATED_CALL', defaultSeverity: 'warning', summary: 'The realized function calls a modelled method of another component living in the same source file, and neither a narrative step nor a declared call names it', carryable: true },
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
      // A method that claims no call is not this rule's subject in either
      // direction: nothing to prove forward, and nothing it could have failed
      // to declare. What it does NOT say is UNUSED_*'s subject, not this
      // rule's — a method silent about its calls is judged by what its
      // component's collaborators go unreached by, and accusing it here of
      // hiding a colocated call would be this rule judging the detail dial.
      if (!implMethod.narrative.length && !implMethod.calls?.length) continue;

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

      // ---- forward: every claimed call realized by a resolving call -------
      const missed: MissedClaim[] = [];
      for (const claim of claimsOf(implMethod)) {
        // A target this tree does not contain is cross-tree-references'
        // finding (and surface-reference-backing's once it resolves).
        if (!ctx.componentMap.has(claim.component)) continue;

        const target = resolveCallTarget(ctx, claim.component, claim.method);

        // N:1 identity forwarding: when the caller's own realized symbol IS
        // the target name, facade and target collapse onto one function
        // (pure 1:1 forwarding, barrel republication) — the claim is realized
        // by identity, exactly as Level 1's N:1 sharing blesses. A declaration
        // earns this exemption on the same terms a step does: the reason is
        // the shape of the CODE, which does not know which way the claim was
        // written.
        if (target.accepted.has(fnSymbol)) continue;

        const matching = sites.filter(s => target.accepted.has(s.name));
        const ref = `${claim.component}.${claim.method}`;

        // The target names no file of its own (MISSING_SOURCE_PATH reports
        // exactly that), so there is nothing to resolve AGAINST: the claim
        // falls back to the name membership this check has always had.
        if (target.files.size === 0) {
          if (matching.length === 0) {
            missed.push({ step: claim.step, target: ref, accepted: [...target.accepted], miss: { kind: 'absent' } });
          }
          continue;
        }

        // Two tiers, and the difference is the whole of the honesty here.
        // ACCEPTANCE reads everything a call can have reached: `this.store`
        // followed through the type the class declares the field with, and
        // `new Registry(...)` through the module its class name came from. A
        // LANDING a finding may name comes from the proven tier alone — a
        // declared type says what a collaborator is, not which class ships the
        // body, and a constructed class says where the class was written, not
        // where a method it inherits was — so widening what a call reached can
        // only ever accept a claim: it must never turn "I cannot say" into an
        // accusation.
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
            ? { kind: 'unresolved', shapes: [...new Set(matching.map(describeSite))].sort() }
            : { kind: 'elsewhere', landed: [...landed].sort() };
        missed.push({ step: claim.step, target: ref, accepted: [...target.accepted], miss });
      }

      const unrealized = missed.filter(m => m.miss.kind !== 'unresolved');
      const unresolved = missed.filter(m => m.miss.kind === 'unresolved');
      if (unrealized.length) {
        ctx.addIssue(
          'warning',
          'CALL_STEP_UNREALIZED',
          `Method "${implMethod.name}" in implementation "${impl.id}": ${unrealized.length} ${claimNoun(implMethod)} are realized by no call of the function "${fnSymbol}" in "${file}" that resolves to the target's own source file — ${unrealized.map(describeMiss).join('; ')}. Callees are closed over the named helpers the function calls, and each call site is resolved through this file's import bindings (order, arguments and conditions are not checked). Realize the calls, fix what the method claims, or map code names via per-method symbols on the targets.`,
          impl.id,
          entry.draftContext,
          undefined,
          // One claim, named the way the register names a unit: a step by its
          // number and target, a declaration by its target alone. What the
          // register carries is ONE unrealized claim, never "this method's
          // calls".
          { at: implMethod.name, covers: unrealized.map(unitOf) },
        );
      }
      if (unresolved.length) {
        ctx.addIssue(
          'warning',
          'CALL_ORIGIN_UNRESOLVED',
          `Method "${implMethod.name}" in implementation "${impl.id}": ${unresolved.length} ${claimNoun(implMethod)} ARE called by name inside the function "${fnSymbol}" in "${file}", but every site calling them is written in a shape this analysis cannot resolve to a file — ${unresolved.map(describeMiss).join('; ')}. What resolves is a name bound to a module of THIS project: a bare or namespaced call through such an import binding, a \`this.<field>\` receiver whose declared type names one, a \`new Class(…)\` receiver whose class does. What does not: an import from a PACKAGE specifier, a receiver holding a value the module assembled, a receiver this model records no name for. This reports what was not checked, not what is wrong — the claim is neither proven realized nor accused of being missing, and no working call is asked to be rewritten to suit the reader.`,
          impl.id,
          entry.draftContext,
          undefined,
          { at: implMethod.name, covers: unresolved.map(unitOf) },
        );
      }

      // ---- converse: colocated calls the method never claimed -------------
      // Every way the method names a target counts as claiming it: a call,
      // dispatch or register step, and an entry of its declared `calls`. A
      // dispatch or register step is no claim about a CALL SITE — nothing
      // forward asks of it — but it does name the target out loud, and the
      // converse direction's whole question is whether the boundary hop is
      // written down somewhere a reader will find it.
      const declared = new Set<string>();
      for (const step of implMethod.narrative) {
        if (step.targetComponent && step.targetMethod) declared.add(`${step.targetComponent}.${step.targetMethod}`);
      }
      for (const ref of implMethod.calls ?? []) {
        const parsed = parseDeclaredCall(ref);
        if (parsed) declared.add(`${parsed.compId}.${parsed.methodName}`);
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
          `Method "${implMethod.name}" in implementation "${impl.id}": the function "${fnSymbol}" in "${file}" calls ${crossings.size} modelled method(s) of OTHER components living in that same file, and neither a narrative step nor a declared call names it — ${detail}. Sharing a file does not make the hop internal: it crosses a component boundary nothing imports, so no file-level check can see it. Narrate the call, declare it in \`calls\`, or move the code so the boundary is real.`,
          impl.id,
          entry.draftContext,
          undefined,
          // The crossings themselves. Keyed by method alone, a 24th crossing
          // would ride into a register entry written for 23 - so each one is
          // named, and one nobody carried fires on the day it appears.
          { at: implMethod.name, covers: [...crossings.keys()] },
        );
      }
    }
  },
};
