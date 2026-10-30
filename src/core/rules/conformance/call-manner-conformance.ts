import {
  bodySitesOf,
  callClaims,
  defaultConformanceTier,
  fieldTypesOf,
  importBindingOf,
  languageOfSourcePath,
  localTypesOf,
  pathKey,
  resolveImport,
  statesCalls,
  type CallClaim,
  type CallSiteFact,
  type SourceFileFacts,
} from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';
import {
  bodyKey,
  describeSite,
  invokedAs,
  isRemoteLink,
  isTarget,
  resolveCallTarget,
  targetForwards,
  type CallTarget,
} from './call-conformance.js';

// ---------------------------------------------------------------------------
// Code↔narrative for HOW a call runs (code↔spec Level 3, the manner of a call).
//
// call-conformance proves a claimed call is THERE; this rule reads the two
// things a narrative says about how it runs, where it says them:
//
//   detach    a step marked detach is fire-and-forget, so the code must not
//             wait for the call (DETACHED_CALL_AWAITED);
//   caught    a step inside the body of a try step that catches says its error
//             is caught, so the code must catch it (CALL_NOT_CAUGHT);
//   awaited   a step not marked detach finishes before the next step, so a
//             call that completes later must be waited for (CALL_NOT_AWAITED,
//             or the notice OPEN_CALL_NOT_AWAITED where the method does not
//             state its detail and the design leaves open whether it waits).
//
// It reads only the call sites WRITTEN in the method's own function and landing
// on the claim's target — a call reached through a helper is not judged, nor a
// site whose landing is not settled — and only what every writing of a shape
// agrees on, so a doubt is never an accusation. The reverse is never reported
// either: a try the code adds, and a call it waits for that the narrative does
// not mark, are routes the design leaves open.
// ---------------------------------------------------------------------------

/** Where a Python call site lands, through what the code DECLARES (import bindings, annotated fields and names). */
function declaredLandings(
  code: ReturnType<RuleContext['codeIndex']>,
  site: CallSiteFact,
  file: string,
  facts: SourceFileFacts,
): string[] {
  const resolve = (specifier: string | undefined): string[] => {
    if (specifier === undefined) return [];
    const target = resolveImport(file, specifier, code.paths, code.packages);
    return target ? [target] : [];
  };
  const throughType = (typeName: string): string[] => {
    const binding = importBindingOf(facts, typeName);
    if (binding) return resolve(binding.from);
    return code.declarationsAt(file).has(typeName) ? [file] : [];
  };
  if (!site.member) return resolve(importBindingOf(facts, site.name)?.from);
  if (site.enclosingClass) return [file];
  if (site.field) return fieldTypesOf(facts, site.field).flatMap(throughType);
  if (site.via) {
    const binding = importBindingOf(facts, site.via);
    if (binding?.namespace) return resolve(binding.from);
    return localTypesOf(facts, site.via).flatMap(throughType);
  }
  return [];
}

export const callMannerConformanceRule: SddRule = {
  name: 'call-manner-conformance',
  judges: 'code',
  description:
    "Code-to-narrative for HOW a call runs, where the narrative says it: a narrative call step and the call realizing it agree on whether the method waits for the call and whether an error the call raises is caught. A step marked detach is fire-and-forget, so the code must not wait for the call; a step the narrative does not mark detach finishes before the next step, so where the call is proven to complete later the code must wait for it; and a step inside the body of a try step that catches says its error is caught, so the code must catch it. Read for the call sites call-conformance matched to the claim, at exact grade (or where a Python file's reading records manner), and only for sites written directly in the method's own function: a call reached through a helper the method calls is not judged, nor is a site whose landing is not settled, a target that plans no code or lives in another project, a dispatch step (which names no call site), or a method whose conformance dial is off (its own, else its implementation's). Where a claim has several realizing sites, or one shape is written several times, only what every writing agrees on is reported. A detach step whose call every writing waits for is DETACHED_CALL_AWAITED; a step inside a catching try whose call no writing catches is CALL_NOT_CAUGHT. A step not marked detach whose target's realizing function completes later (source_file_facts.asyncFunctions) and whose call no writing waits for is CALL_NOT_AWAITED when the method states its detail (full or calls-only, its own or its implementation's: the narrative is then the whole flow), and the notice OPEN_CALL_NOT_AWAITED when it does not — the design then leaves open whether the method waits, and the notice says so without failing the gate. A try the code adds around a call the narrative does not place in one, and a call the code waits for that the narrative does not mark, are open routes and never reported.",
  codes: [
    {
      code: 'DETACHED_CALL_AWAITED',
      defaultSeverity: 'warning',
      summary: 'A call step marked detach (fire-and-forget) is realized by a call the code waits for, so the method does not go on until the call finishes, as its narrative says it does',
      carryable: true,
    },
    {
      code: 'CALL_NOT_CAUGHT',
      defaultSeverity: 'warning',
      summary: 'A call step inside the body of a try step that catches is realized by a call no try/catch (or try/except) encloses in the code, so an error the design says is caught escapes the method',
      carryable: true,
    },
    {
      code: 'CALL_NOT_AWAITED',
      defaultSeverity: 'warning',
      summary: 'A call step not marked detach, in a method that states its detail, is realized by a call that completes later and that the code never waits for, so the next step can run before the call finishes',
      carryable: true,
    },
    {
      code: 'OPEN_CALL_NOT_AWAITED',
      defaultSeverity: 'notice',
      summary: 'A call step not marked detach, in a method that leaves its detail open, is realized by a call that completes later and that the code never waits for: the design leaves open whether the method waits, and this says the code does not',
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    /** Whether the target's realizing function completes later: every judged anchor is async, and at least one was judged. */
    const completesLater = (target: CallTarget): boolean => {
      let judged = 0;
      for (const anchor of target.anchors) {
        const there = code.factsAt(anchor.file);
        if (!there || there.status !== 'analyzed') return false;
        const readable = there.analysisGrade === 'exact' || there.reads?.includes('calls');
        if (!readable) return false;
        if (!(there.asyncFunctions ?? []).includes(anchor.symbol)) return false;
        judged++;
      }
      return judged > 0;
    };

    // ---- 1. gather: each method's step claims, with how the narrative says they run ----
    for (const entry of ctx.implementationMethods()) {
      const { implementation: impl, method, component, sourceFile: file, draftContext } = entry;
      if ((method.conformance ?? impl.conformance ?? defaultConformanceTier(component)) === 'off') continue;
      const claims = callClaims(method).filter(c => c.step !== undefined);
      if (claims.length === 0 || !file) continue;
      const facts = code.factsAt(file);
      if (!facts || facts.status !== 'analyzed') continue;
      const exact = facts.analysisGrade === 'exact';
      if (!exact && !facts.reads?.includes('manner')) continue;
      const here = pathKey(file);
      const fnSymbol = method.symbol ?? method.name;
      // The sites written in the method's own function, in its own file.
      const own = bodySitesOf(facts, fnSymbol, method.exportedVia);
      if (!own) continue;
      const sites = own.sites.filter(s => pathKey(s.from ?? here) === here);
      const stated = statesCalls(method, impl, component);

      // ---- 2. for each claim ----
      for (const claim of claims as (CallClaim & { step: number })[]) {
        const callee = ctx.componentMap.get(claim.component);
        // ---- 4. a claim that can be judged: a target of this project that plans code ----
        if (!callee || claim.component.includes('::') || isRemoteLink(component, callee)) continue;
        const target = resolveCallTarget(ctx, claim.component, claim.method);
        if (target.files.size === 0) continue;
        if (![...target.files].every(f => languageOfSourcePath(f) === languageOfSourcePath(file))) continue;
        if (!code.holdsAny([...target.files])) continue;
        // N:1 identity: the caller IS the target, so there is no call to read.
        if (target.bodies.has(bodyKey(here, fnSymbol, method.exportedVia))) continue;
        const sharedBody = targetForwards(code, target);
        if (code.forwardsOf(file, fnSymbol, method.exportedVia)
          .some(p => p.file !== here && sharedBody.has(`${p.file}#${p.name}`))) continue;
        if (isTarget(code.forwardsOf(file, fnSymbol, method.exportedVia), target)) continue;

        // ---- 3. the sites call-conformance matched to the claim ----
        const matched = sites.filter((s) => {
          if (isTarget(invokedAs(code, s, file), target)) return true;
          if (!target.accepted.has(s.name)) return false;
          if (exact) {
            return [...code.originOf(s, file)].some(o => target.files.has(o))
              || [...code.possibleOriginsOf(s, file)].some(o => target.files.has(o));
          }
          return declaredLandings(code, s, here, facts).some(o => target.files.has(o));
        });
        if (matched.length === 0) continue;

        const ref = `${claim.component}.${claim.method}`;
        const unit = `${claim.step}:${ref}`;
        const line = matched.find(s => s.line !== undefined)?.line;
        const where = `step ${claim.step} → ${ref}, written as ${[...new Set(matched.map(s => `\`${describeSite(s, file)}\``))].sort().join(' / ')} in the function "${fnSymbol}" in "${file}"${line !== undefined ? ` (line ${line})` : ''}`;
        const report = (severity: 'warning' | 'notice', codeName: string, message: string): void => {
          ctx.addIssue(severity, codeName, `Method "${method.name}" in implementation "${impl.id}": ${where} — ${message}`, impl.id, draftContext, undefined, { at: method.name, covers: [unit] });
        };

        // ---- 5. detach: the code must not wait ----
        if (claim.detach && matched.every(s => s.awaited === 'all')) {
          report('warning', 'DETACHED_CALL_AWAITED', 'the step is marked detach (fire-and-forget), but the code waits for the call, so the method does not go on until it finishes. Remove the await or drop detach from the step.');
        }
        // ---- 6. caught: the code must catch ----
        if (claim.caught && matched.every(s => s.guarded === undefined)) {
          report('warning', 'CALL_NOT_CAUGHT', 'the step lies in the body of a try step that catches, but no try/catch (or try/except) in the code encloses the call and no rejection handler is chained on it, so an error the design says is caught escapes the method. Catch it around the call or move the step out of the try body.');
        }
        // ---- 7. awaited: the code must wait where the call completes later ----
        if (!claim.detach && matched.every(s => s.awaited === undefined) && completesLater(target)) {
          if (stated) {
            report('warning', 'CALL_NOT_AWAITED', 'the step is not marked detach, so the next step follows it, but the target completes later (async) and the code never waits for the call. Await it, or mark the step detach if the method goes on without it.');
          } else {
            report('notice', 'OPEN_CALL_NOT_AWAITED', 'the target completes later (async) and the code never waits for the call, while the method leaves its detail open, so the design does not say whether it waits. State the method\'s detail and mark the step detach, or await the call.');
          }
        }
      }
    }
  },
};
