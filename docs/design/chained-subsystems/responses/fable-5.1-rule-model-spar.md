# Fable 5.1 — sparring on the validator rule model (2026-09-13)

Context: the spec-coverage audit found that wairon's own tree designs the rule machinery (`rule_repository`, `sdd_rule`,
`rule_code`, `rule_context`) but none of the 43 rules. The maintainer decided the rules are designed in PR A with full
L5 narratives, and that any L3 method may declare `findings`. The shape was open: rule families (B), one component per
rule (A), or one contract with 43 implementations (C). The maintainer lacked the context to choose, so a read-only
Fable 5.1 agent sparred on it in two rounds. The lead verified the load-bearing claims in code (listed at the end).

## Round 1

**Recommendation**

Take Shape B, but tie the families to code folders: `src/core/rules/<family>/<rule>.ts`, one rule per file, each file's
body member named `check`, each L4 method carrying its own `sourcePath` (B3) and `symbol: check`. That is clippy's exact
layout (`methods/mod.rs` = one pass hosting many lints, `methods/<lint>.rs` = one `check` per lint), and it removes B's
real defect: as proposed (`symbol: reachabilityRule`) call-step conformance is silently disabled for all 43 rules (see
Corrections 1). The decisive reasons over A: everything the maintainer decided lives at method level (findings, full
narrative, source binding), so a per-rule component adds only a 44-edge registry needing a `lint.allow` and 43 identical
`check(ctx)` contracts; B keeps `rule_registry` at ≤10 edges with no allow, and gives pack authors a copyable pattern
("your pack's rules = one arbiter family"). C is out on mechanics: the reachability walker takes the first
implementation of a contract that has the method (graph.ts:159-169), and per-rule `findings` cannot sit on one shared L3
method. Keep the lead's `intrinsic_rules` family: it is the one family with an executable definition (candidate.ts:104,
repository.ts:50-52), so folder ⟺ `scope:'spec'` is machine-checkable.

**Corrections to the lead's analysis**

1. B2/B4 concern is misdiagnosed. Object-literal members are declared names at exact grade (source-analysis.ts:485-491;
   conformance.ts:15-18) and get a `functionCalls` entry (source-analysis.ts:406-411). The gap is the proposed
   `symbol: reachabilityRule`: a `const` bound to an object literal has no `functionCalls` entry, so `closedCallees`
   returns undefined and call-conformance `continue`s with no finding (call-conformance.ts:80-84) while
   `UNREALIZED_METHOD` stays quiet because the binding is declared. Second: same-named `check` members in one file are
   unioned (source-analysis.ts:461-464), so in the 4 multi-rule files a call step of one rule is "realized" by another's
   call. One rule per file + `symbol: check` fixes both today; B4 is not needed for this.
2. Registry edges would fire `UNREALIZED_DEPENDENCY` under A and B: repository.ts imports `./index.js`
   (repository.ts:2), which no spec maps, not the rule files; a declared edge with no import between mapped files is
   reported (dependency-conformance.ts:241-258). Move `SDD_RULES` into repository.ts (the registry names its built-ins)
   or map index.ts.
3. The existing narrative already describes the arbiter "gather" shape but the code does not: `roundtripRule` calls
   `dryRunSerializeSpecs` itself (namespace.ts:3,190) and `knownIssueCodes` is computed inside `buildRuleContext` from
   `SDD_RULES` (index.ts:474-479), not through the repository (step 18). The allow at spec_validator_impl.yaml:377-384
   hides two real call mismatches. Also, arbiter guidance forbids adapter dependencies
   (.wai/variants/specialist-shapes.yaml:13-16), so a family that calls `validator_core_adapter` cannot honestly carry
   `variant: arbiter`. Fix code-side: the validator runs the dry-run and injects the issues into the context; the rule
   reports them.
4. `specScopedRules` (repository.ts:50-52, used by candidate.ts:104) is on no interface (irule_index.yaml,
   irule_repository.yaml); the new `validateComponentCandidate` narrative has nothing to call. candidate.ts is mapped by
   no spec while `ispec_validator` now carries the method with `sourcePath: src/core/validation.ts`.
5. Counts: 40 files in `src/core/rules/`, 35 hold rules (5 infrastructure), not 39. 43 rules confirmed
   (index.ts:62-141); multi-rule files confirmed (semantic-edges 6, graph/portals/namespace 2 each).
6. Family table vs code: hidden-state sits in the code↔spec family (index.ts:122-123), lint-allows is the run-last
   audit (index.ts:138-140), and portal-fields/durability-declaration sit with their topics (index.ts:78-81, 105-106).
   Only the intrinsic split has a runtime definition; the rest should follow the code's own grouping (and the test files
   `tests/core/rules-*.test.ts` already group that way).
7. Confirmed as stated: register targets must be declared dependencies (`UNDECLARED_DEPENDENCY_CALL`,
   contracts.ts:245-258); register edges reach the callback (graph.ts:176-181); Registry→Specialist legal
   (stereotype-deps.ts:252-266); Specialist→Specialist legal (stereotype-deps.ts:217); `GOD_COMPONENT` is a warning at
   `> 10` (coupling.ts:108-118; project.yaml:39), so 10 edges pass.
8. Shared helpers cross rule files (call-conformance.ts:4, dependency-conformance.ts:5, hidden-state.ts:4,
   integration-conformance.ts:5, narrative-detail.ts:8-9, graph.ts:3, semantic-edges.ts:3, narrative-antipatterns.ts:3,
   contracts.ts:2, stereotype-deps.ts:2). Any shape that maps these files to different components gets
   `UNDECLARED_DEPENDENCY` unless the helpers move to non-rule modules (`rules/lib/`, unmapped until B8;
   `walkNarrativeGraph` is then a projector-Specialist candidate) or misleading `dependsOn` edges are declared between
   families.

**Impact sheets** — A = one component per rule; B = lead's proposal; B′ = recommended refinement; C = one contract, 43
implementations.

(a) Tree shape

| | A | B / B′ | C |
|---|---|---|---|
| new components / interfaces / implementations | 43 / 43 / 43 (sdd_validator 7→50; sdd_host has 119) | 8 / 8 / 8 | 1 / 1 / 43 |
| `rule_registry.dependsOn` | 44 → `GOD_COMPONENT`, needs lint.allow ("registration point of an open plugin set") | 9 (B′ with hidden-state moved, lint-allows kept in integrity: still ≤10) | 2 |
| cross-component helper imports | 10 | 4-5 (B′) | 0 |
| `spec_validator` | unchanged 4 edges; step 20 = loop + local | same | same |

(b) A12 (UNUSED_TYPE counts type-method signatures)

B′ changes two specs, then one file:
```yaml
# interfaces/iwiring_rules.yaml  (method unusedDetection → findings)
- { code: UNUSED_TYPE, severity: warning, summary: 'Type never referenced by fields, method signatures or type methods' }
# implementations/wiring_rules_impl.yaml
- name: unusedDetection
  sourcePath: src/core/rules/wiring/unused-detection.ts   # B3
  symbol: check
  narrative:
    - { stepNumber: 9, type: loop, loopKind: forEach, over: 'in-scope types', endStep: 10,
        description: 'Mark every type named by a type field, an interface signature or another type''s method signature; a type naming only itself stays unmarked' }
```
Then `unused-detection.ts` gains the `t.methods` scan next to graph.ts:356-364. A: same edit on
`iunused_detection_rule.check` + `unused_detection_rule_impl`. C: the summary sits among ~160 codes on
`ivalidation_rule.check` and the narrative on `unused_detection_impl` — the contract no longer says which rule owns the
code.

(c) New rule `UNCLAIMED_SOURCE_FILE`

- A: `sdd_add_component` + `sdd_define_interface` + `sdd_write_narrative` (3 files), `rule_registry.dependsOn` += 1,
  register step, allow reason unchanged; code: new file + registry entry.
- B′: one method on `iconformance_rules` (findings) + one on `conformance_rules_impl` (sourcePath, narrative) + register
  step; code: `rules/conformance/unclaimed-source.ts` + registry entry.
- C: new implementation spec; the shared method's findings grow; no register step changes — the tree cannot show it was
  registered.

(d) Drift

- Code emits a code the spec lacks: no validator rule can know a string literal is a code; the repo test (`SDD_RULES`
  codes vs spec findings, both ways) fails and names the rule (A, B′) or only the method (C).
- Rule deleted in code, spec kept: A: `MISSING_SOURCE_FILE` (error) on the impl, `UNREALIZED_DEPENDENCY` on the
  registry, repo test. B′: `MISSING_SOURCE_FILE` on the method's sourcePath (B3 must extend conformance.ts:96-156 to
  per-method paths) plus `UNREALIZED_FINDING` per code. B (lead): the `const` symbol vanishes → `UNREALIZED_METHOD`.
  C: `MISSING_SOURCE_FILE` on one impl; `UNREALIZED_FINDING` against "the method's source file" is undefined with 43
  files.
- Rule moved between families (B′ only): folder ≠ component → repo test.

(e) What checks verify per rule

| check | A (1 rule/file) | B (as proposed) | B′ | C |
|---|---|---|---|---|
| reachability via `register` | per rule | per rule | per rule | one node; 42 narratives never walked (graph.ts:162-168) |
| `UNUSED_METHOD` | per rule | per rule | per rule | never per rule |
| `UNREALIZED_METHOD` | per rule | per rule (const binding) | per rule (`check` unique per file) | N:1 across 43 files |
| `CALL_STEP_UNREALIZED` | per rule | **silently off** (Correction 1) | per rule | first impl only |
| dependency conformance | per rule file | per family | per family, per-method files | one component |
| `findings` / `UNREALIZED_FINDING` | per rule | per rule | per rule | ambiguous |
| draft status, approval sha | per rule | per family | per family | per impl |

(f) Delegation: fences are subsystem-level today (project.yaml:44; agent_resolver.ts:318-350), so every shape is owned
by the sdd_validator owner. Live briefs are per component: A = one rule, one file, ideal for parallel "change rule X"
subagents; B′ = one family folder (agent_resolver.ts:331-334 reads only `impl.sourcePath` — a B3 consumer to include);
C = one brief with 43 source paths.

(g) Packs and the write gate: pack rules stay data through `registerPackRules` under every shape; B′ tells a pack's own
tree to model them as one family. Write gate: `validateComponentCandidate` narrative = `loop over
rule_repository.specScopedRules()` + local `check`; add `specScopedRules` to `irule_index` and `irule_repository`. B′:
`rules/intrinsic/` folder ⟺ `scope:'spec'`, asserted by the repo test. A: same loop; scope has no structural home (the
two rules would be plain components; a `guarantees` token like `spec-intrinsic` is the fallback).

(h) Risks and PR-B pull-forward

- A: nothing pulled forward; needs the registry allow, the 4-file split, helper extraction, and a 50-component
  subsystem. Strongest per-rule identity; weakest canvas.
- B (lead): B3; plus the silent call-conformance gap and `UNREALIZED_METHOD` N:1 in multi-rule files unless files are
  split; family membership lives only in the spec.
- B′: B3 (schema field + consumers: conformance, call-conformance, dependency-conformance, hidden-state, narrative-detail,
  integration-conformance, `buildCodeModel`, agent_resolver, the MCP carry-forward seam); folder restructure (35→43
  files) and helper extraction; roundtrip/knownIssueCodes gather fix (Correction 3). Fallback if PR A must stay small:
  one file per family with named `check<Rule>` functions and `symbol` per method — works with today's model, no B3, but
  is churn B3 later reverses.
- C: nothing pulled forward; structurally untruthful (L4 alternatives are swap seams; graph.ts:159-169).

## Round 2 (the lead challenged helper homes, family table, symbol naming, the gather fix, the write gate, PR size)

**1. Helper homes**

Rule: no rule file imports another rule file. Three homes, all already sanctioned: (i) a query on the supplied world =
method on the `rule_context` type (its existing methods at types.ts:103-114 are unmodelled today — rule_context.yaml has
`methods: []`; PR A's type-method work should add them all); (ii) behaviour intrinsic to one spec value = method on that
value type; (iii) an algorithm with its own doctrine = a `projector` Specialist.

| helper | home | why |
|---|---|---|
| `isInChainedSubproject`, `enclosingMounts` (conformance.ts:39, namespace.ts:140) | (i) `rule_context.isChained(subsystemId)` | reads `ctx.subsystems`; same shape as `getComponentProfile` |
| `stereotypeDefaultTier` (conformance.ts:35), `stereotypeDetailDefault` (narrative-detail.ts:30) | (ii) `component_spec.defaultConformanceTier()` / `.defaultNarrativeDetail()` | a pure function of the stereotype |
| `effectiveNarrativeDetail` (narrative-detail.ts:46) | (ii) `method_implementation.effectiveDetail(impl, component)` | resolves the method's dial against its spec and stereotype defaults, no world |
| `passesIntentFloor` (narrative-detail.ts:66) | (i) `rule_context.meetsIntentFloor(text, methodName)` | pure text policy used on two value types (L4 `intent`, L3 `invokedBy.caller`, graph.ts:267); a doctrine predicate, not a value's behaviour |
| `getEffectiveComplexityConfig` (complexity.ts:20) | (i) `rule_context.complexityConfigFor(subsystemId)` | merges `ctx.rules` with the governing profile, like `getComponentProfile` |
| `isExternalNamespaceRef`, `isCollapsedCrossTreeRef`, `resolveSurfaceRef` (namespace.ts:18,164,74) | (i) `rule_context.resolveSurfaceRef(ref, fromSubsystem)` (+ the two predicates) | read `surfaceSnapshots`/`mountSurfaceSnapshots` — world facts |
| `reportAmbiguousSurfaceRef` (namespace.ts:118) | dissolve: each rule emits its own `SURFACE_REF_AMBIGUOUS`; the message comes from a `surface_ref_resolution.describe()` type method | the emission site must sit in the file that declares the finding, or `findings` is realized by the `codes` literal alone |
| `stepGraph` (narrative-flow.ts:33) | (ii) `method_implementation.stepGraph()` | pure of the narrative list |
| `walkNarrativeGraph`, `methodKey`, `WalkSeed`/`WalkOptions` (graph.ts:66-105) | (iii) `narrative_graph_projector.walk(ctx, seeds, options): ReachSet` (Specialist, `variant: projector`, parameters-only); seeds/options/result become types | 100 lines carrying reachability doctrine (register edges, dispatch flooding, detail fallback) deserve a narrative and conformance; only `wiring_rules` depends on it |
| type-analysis.ts: `extractTypeIdentifiers`, `extractTypeGenerics`, `extractGenericTypeVariables`, `extractTypesFromSignature`, `methodTypeRefs`, `matchTypeRef`, `BUILTIN_TYPES` | (ii) a `type_reference` value type (`identifiers()`, `generics()`), `type_spec.matches(ref)`, `method_spec.typeRefs()` — realized in `src/models/` | a models-level grammar: canvas.ts and surfaces.ts use it too, so it is not validator-owned |
| `normalizeLanguage`, `LANGUAGE_MARKERS` | `rule_context.targetLanguageFor` already normalizes; the marker table stays inside `heuristic/target-language.ts` | single consumer |

Dependency conformance afterwards: rule files import `./types.js` type-only (exempt, source-analysis.ts:494-497), model
files (unmapped, and types are not components, so no `dependsOn` semantics even after B6), and the projector's file
(justified by `wiring_rules.dependsOn`). Zero undeclared edges and no fake family-to-family edges. B6 need not move:
type-method uses stay `local` steps that name the method ("compute the step graph (method_implementation.stepGraph)");
local steps are not checked (call-conformance.ts:91), so nothing fires falsely, and PR B converts them to `call` steps.
Cost: those narratives are touched again in PR B.

**2. Family table** — `rule_registry.dependsOn = rule_store + 8 families = 9`, no allow. Numbers are index.ts run
positions; registration order is the registry's narrative (one `register` step each, in index.ts order), not family
order.

| component | judges | rules (run order) |
|---|---|---|
| `integrity_rules` | ids, references and serialization hold together | hierarchy-integrity 1, namespace-hygiene 2, roundtrip-serialization 3, type-references 4, public-surface 20, lint-allows 43 |
| `narrative_rules` | contracts and narratives agree and are sound | contract-symmetry-and-narratives 5, guarantee-tokens 6, narrative-flow 7, narrative-antipatterns 8, narrative-detail 9 |
| `intrinsic_rules` | one spec's own fields — the write-gate subset (candidate.ts:104) | portal-fields 10, durability-declaration 25 |
| `doctrine_rules` | the standard's stereotype and pattern doctrine | portal-endpoints 11, portal-call-auth 12, stereotype-dependencies 13, pattern-ownership 14, facade-forwarding 15 |
| `extension_rules` | what packs contribute resolves, applies and is pinned | architectural-profiles 16, pattern-references 17, component-variants 18, declarative-assertions 19, pack-resolution 41, pack-reproducibility 42 |
| `wiring_rules` | the execution graph is connected and complete | dependency-cycles 21, dispatch-tables 22, lifecycle-entrypoints 23, unused-detection 24, durability-round-trip 26, untyped-seams 27, prose-claims 28, invariant-backing 29, event-topology 30 |
| `conformance_rules` | code matches spec | structural-conformance 31, call-conformance 32, hidden-state 33, dependency-conformance 34, integration-conformance 35 |
| `heuristic_rules` | advisory size, naming and technology fit | coupling-health 36, target-language 37, technology-boundaries 38, naming-conventions 39, complexity-and-metadata 40 |

Deviations from the lead's table, all from code grouping: the portal family merges into doctrine (the 10-family version
would put the registry at 11); configuration rules join the pack-reference family (one subject: packs); hidden-state
goes to conformance (index.ts:122-123); lint-allows is spec hygiene, so integrity. "Runs last" is the index's doing
(repository.ts:37-40), modelled in `rule_index_impl.ruleSequence`: call `rule_store.listRules`; local "registration order
without the lint-allow audit"; branch "audit registered?"; local "append `integrity_rules.lintAllows` last so it sees
every allow the pack rules consumed"; return. Data-driving it (`phase: audit`) is not worth a field for one rule.

**3. Symbol.** `symbol: check` on every method: the rule object is ESLint's `meta + create` in one export, one rule per
file makes `check` unique (source-analysis.ts:410-411, 461-464), and a separate exported function would be a second name
to keep in sync — the thing `symbol` exists to avoid.

**4. Correction 3, minimal code.** validation.ts: register built-ins and pack rules before `buildRuleContext` (today
after, :468 vs :490-494); call `dryRunSerializeSpecs(isSpecInScope)` there and pass the issues plus `knownIssueCodes()`
from the repository (unioned with the declarative-assertion `fullCode`s, index.ts:477-478) into the context as two
supplied-world fields; `roundtripRule.check` reports `ctx.roundtripIssues`, and namespace.ts drops its `../specs.js`
import (:3); buildRuleContext drops its own `SDD_RULES` read (:474-479); candidate.ts reorders the same way with an empty
dry-run. Narrative: step 12 becomes "gather the round-trip dry-run issues for the context" (same call), step 18 stays a
call to `rule_repository.knownIssueCodes`, a new local step "build the rule context from the gathered world" precedes the
loop, step 20 = `loop` over the sequence with a local "run the rule's check". Every family then depends on nothing but
(for wiring) the projector — arbiter guidance forbids stores, registries, repositories, indexes and adapters
(specialist-shapes.yaml:13-16), not Specialists — so all eight carry `variant: arbiter` honestly, and the allow at
spec_validator_impl.yaml:377-384 goes: both calls are then real callees of `validateSddTree`.

**5. Correction 4.** Yes: `specScopedRules` on `irule_index` (it is the index's projection, repository.ts:50-52) and
forwarded on `irule_repository`. `validateComponentCandidate` belongs on `spec_validator` — it is the same
gather-then-run workflow at write time — with per-method `sourcePath: src/core/rules/candidate.ts` under B3; its
narrative is a `loop` over `rule_repository.specScopedRules()` (call) plus the local check. `formatCandidateRefusal` is
authoring-side text and belongs with `mcp_authoring_adapter`.

**6. PR A code, in order.**

1. Schema: `sourcePath` on `MethodImplementation` (B3) and `findings` on L3 methods, declared in the MCP carry-forward
   seam (`schema-field-coverage.test.ts`).
2. B3 consumers: `buildCodeModel` path collection, conformance.ts, call-conformance.ts, dependency-conformance.ts,
   hidden-state.ts, narrative-detail.ts, integration-conformance.ts, agent_resolver.ts:331-334.
3. Folder restructure `src/core/rules/<family>/<rule>.ts` (35 → 43 files, `check` member); `SDD_RULES` moves into
   repository.ts; `buildRuleContext` moves to `rules/context.ts` (the `rule_context` sourcePath).
4. Helper homes per §1, including the `narrative_graph_projector` component and the dissolved reporting helper.
5. Gather fixes per §4; `specScopedRules` on the facade.
6. `UNREALIZED_FINDING` rule (conformance family) and the repo test: `SDD_RULES` names/codes/severities/summaries
   against the spec catalog both ways, folder ⟺ family, `scope:'spec'` ⟺ `intrinsic/`.
7. A4 and A12 rule changes.

Own PRs: items 1-2 (B3) — spec-first needs the field before the family specs can validate, and it touches eight
consumers; items 3-4 — a behaviour-free refactor, cleanest reviewed alone (existing rule tests must pass unchanged). The
rest is PR A proper.

## Lead's verification (in code, 2026-09-13)

- Correction 1 holds: `closedCallees` keys named functions only (source-analysis.ts:406-421); a `const` bound to an
  object literal has no entry, so call-conformance continues silently (call-conformance.ts:80-84); same-named members
  merge (source-analysis.ts:461-464).
- Correction 2 holds: repository.ts:2 imports `SDD_RULES` from `./index.js`.
- Correction 3 holds: namespace.ts:3 imports `dryRunSerializeSpecs` and calls it at :189; index.ts:474 builds the
  known-code set itself; the arbiter guidance forbids adapter dependencies (specialist-shapes.yaml:13-16).
- Round 2 §1 holds where checked: canvas.ts:12 and surfaces.ts:29 import type-analysis; `SURFACE_REF_AMBIGUOUS` is
  declared by two rules (contracts.ts:21, stereotype-deps.ts:31) but emitted from a namespace.ts helper (:129).
- Round 2 §4 holds: validation.ts builds the context at :468 and registers rules at :490-492.
