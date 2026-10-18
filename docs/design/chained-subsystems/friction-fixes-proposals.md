# Wairon friction fixes — proposals

_2026-09-13. Source: [`wairon-friction-2a0.md`](wairon-friction-2a0.md) (F1–F27), met while building stage 2a-0. The
maintainer's direction: most of it is resolved, because the tool must be clear and truthful — no unneeded silence or
confusion. Code facts come from read-only mapping passes; line numbers are at `feat/stage2a0-config-repository`
(899666f). Each proposal names the defect with an example from this session, the fix, and any decision it needs._

## A. Authoring tools that tell the truth

### A1. A write reports what it changed, or that nothing changed (F1, F2, F8)
**Now.** `sdd_update_spec` answers "Successfully updated …" whenever the update does not throw (`src/mcp/server.ts:1645`).
There is no before/after comparison: a delta that changes nothing still re-stamps `updatedAt`, writes the file and
notifies listeners (`src/core/specs.ts:2831–2869`). Keys the schema does not know are refused only at the delta's top
level (2315–2339); deeper ones are dropped when the spec is parsed at save (`parseOrThrow`, 707–713), so a misspelled
step field or an unsupported `unset` disappears without a word.

**Example.** `{"methods":[{"name":"createChainedSubsystem","narrative":[{"stepNumber":7,"unset":["condition","onTrueStep","onFalseStep"]}]}]}`
→ "Successfully updated implementation spec" — and the file was unchanged.

**Fix.**
- Compare the parsed spec before and after the merge, ignoring `updatedAt`.
- No difference: nothing is written, and the result reads `No change to implementation "core_orchestrator_impl" —
  nothing written.`, naming every delta entry that had no effect.
- A difference: the result lists the changed paths, e.g. `Updated implementation "core_orchestrator_impl":
  methods.createChainedSubsystem.narrative[7] — type branch → local; dropped condition, onTrueStep, onFalseStep.`
- A key that has no effect at its depth (anything but a schema field or the delta's own markers: `action`, `remove`,
  `captureJumps`, `unset`, `*Label`) is handled per the decision below.

**Decisions.** Ineffective keys: refuse the write naming the path, or apply the rest and report them. A no-op: a plain
"No change" result, or an error result.

### A2. `[]` and `unset` work at every level (F1, F2)
**Now.** `[]` does nothing for an implementation method's `narrative` (`specs.ts:2550`), nor for the top-level
`methods`, `fields`, `publicInterfaces`, `dispatch` and `lifecycle` (2714–2727). `unset` works only at the spec's top
level (2826–2832); inside a method, a field or a step it is dropped.

**Fix.** `[]` clears the array it names, wherever it is. `unset` removes the listed fields from the element it sits in.
Both appear in the change report: `methods.createChainedSubsystem.narrative cleared (14 steps removed)`. A delete that
removes the last element of an optional array removes the property as well: an empty array only confuses a reader or
triggers warnings (F30, decided 2026-09-14).

### A3. Changing a step's type rebuilds the step (F3)
**Now.** A step merge is a shallow spread (`specs.ts:2501–2508`): a branch rewritten as a local kept `condition`,
`onTrueStep` and `onFalseStep`; a call rewritten as a branch kept `outcome`. Undoing it took five calls — insert a
clean step with `captureJumps`, label the downstream target, retarget by label, delete the stale step.

**Fix.** When a delta changes `type`, the step keeps only the fields valid for the new type, and the result lists what
was dropped. A delta that sets a field the step's type cannot have (`condition` on a local) is refused at the write,
naming the field and the type. The per-type field table is shared with A4, as `narrative_step.foreignFields(): string[]`
(removed from the schema PR's `narrative_step` and re-added with PR A). Every type may carry `stepNumber`, `label`,
`description` and `type`. On top of those:

| type | may also carry |
|---|---|
| local | assertsInvariants |
| call | targetComponent, targetMethod, auth, detach, assertsGuarantees, assertsInvariants |
| dispatch | targetComponent, capability, auth, detach, assertsGuarantees, assertsInvariants |
| register | targetComponent, targetMethod |
| branch | condition, onTrueStep, onFalseStep |
| switch | on, cases, defaultStep |
| loop | loopKind, over, condition, endStep |
| try | endStep, catches, finallyStep |
| parallel | branches, endStep |
| jump | toStep |
| return | outcome |
| throw | error |

**Decision.** Carry `description` and `label` unless the delta restates them, or require the delta to restate the
whole step.

### A4. A field that belongs to another step type is a finding (F4), and wairon's 7 are fixed
**Now.** `MALFORMED_FLOW_STEP` checks flow fields only on local, call, register and dispatch steps
(`src/core/rules/narrative-flow.ts:189–197`). `outcome` on a branch, `targetComponent` on a local or throw, and
`condition` on a return or throw all pass. Wairon's own tree holds 7 such steps.

**Fix.** The per-type field table drives a new finding, `FOREIGN_STEP_FIELD`, naming the step, its type and the
field. The 7 steps in wairon's tree are fixed in the same pull request; rules-matrix fixtures pin fire and control.

**Decision.** Severity, and whether `wairon doctor --fix` removes the fields (they carry no meaning).

### A5. Delta order is documented, and a label can retarget an existing jump (F7, F14)
**Now.** Methods apply in array order; steps apply sorted by `stepNumber`, each against the numbering that earlier
entries of the same delta left (`specs.ts:2449`, 2467–2498). Labels resolve once after the merge against the final
numbering, so they do not drift — but a label cannot retarget an existing jump: the merged step still holds the old
number and the write fails "sets both … they disagree" (`src/core/narrative-labels.ts:56–58`). Neither the tool
description nor the server instructions mention labels or order.

**Fix.** The tool description states the order and recommends labels. A `*Label` in a delta replaces its numeric twin
on that step, so `{"stepNumber":13,"onFalseLabel":"export_skills"}` retargets step 13.

### A6. A step delete cannot silently hit the wrong step (F9)
**Now.** The only guard is the jump-target check (`specs.ts:2455–2465`). Deleting a step number that does not exist does
nothing (2454); a mistyped step marker merges instead of acting; deleting a loop, try or parallel header leaves its body
behind.

**Fix.**
- Deleting a missing step refuses the write, as deleting a missing method already does.
- A delete may carry `label` or `description`; the write is refused when the step at that number does not match.
- Step markers are validated like method markers.
- Deleting a header whose body would be orphaned is refused, naming the region.

### A7. Arrays inside elements merge by identity (F12)
**Now.** `mergeDelta` walks top-level keys and nested objects, never arrays inside array elements (`specs.ts:2740`), so
an interface method's `params` are replaced wholesale, and `{name, action: "delete"}` became a literal parameter
(`params.0.type: Required`).

**Fix.** `params` merge by `name`, switch `cases` by `value`, try `catches` by `error`, all with the insert and delete
markers. String lists such as `guarantees` keep replacing wholesale, as the description already says.

### A8. Nullable parameter types: say what already works (F13)
**Finding.** `ProjectConfig | null` is already accepted as a param type: `null` is a built-in, and param types are
tokenised exactly like `returns` (`src/core/rules/type-analysis.ts:16`, 55–81). Nothing says so, so the host agent used
`optional: true`, which means "may be omitted", not "may be null".

**Fix.** The tool description says param types accept unions such as `T | null` and how `optional` differs. The
externalize/internalize migration, which rewrites a param type as a single id (`src/core/provision.ts:617–627`), is
checked against unions.

### A9. Create tools accept a status, and re-running one never demotes (F15)
**Now.** The create handlers hardcode `status: 'draft'` (`server.ts:915`, 1117, 1215, 1421) and refuse a `status`
argument, so moving approved content into a new component took three extra update calls. Re-running `sdd_add_subsystem`
on an existing subsystem silently writes `draft`: `saveSubsystemSpec` has no demotion guard (`specs.ts:1670–1673`),
unlike the component, interface and implementation saves.

**Fix.** An optional `status` (`draft | design | complete`) on the create tools, echoed in the result. `saveSubsystemSpec`
keeps an existing status unless one is given.

### A10. `sdd_get_spec` can return a slice (F26)
**Now.** It returns the whole spec (`server.ts:1566–1601`); `project_policy_orchestrator_impl` is 55 KB.

**Fix.** An optional `methods` filter for interfaces and implementations; the result says how many methods it left out.

### A11. Nested tool input is strict too
**Now.** Create tools refuse unknown top-level arguments (`server.ts:316–318`), but unknown keys inside nested objects —
params, narrative steps — are dropped silently.

**Fix.** Nested input shapes are strict as well, so a misspelled step field is refused with its path.

### A12. A type used only in another type's method is not unused (F28)
**Now.** UNUSED_TYPE counts references from type fields and interface method signatures
(`src/core/rules/graph.ts:340-364`), never from methods declared on types. PR A's own model hits it:
`spec_delta.applyTo(spec): SpecDeltaApplication` leaves `spec_delta_application` flagged.

**Fix.** A third pass reads each type method's `signature` and `returns`. A type naming only itself in its own methods
still counts as unused, as ESLint `no-unused-vars` treats a function that only calls itself. The finding's message and
the registry summary name type methods too.

```yaml
# types/spec_delta.yaml
methods:
  - name: applyTo
    signature: 'applyTo(spec: SystemSpec | ...): SpecDeltaApplication'
    returns: SpecDeltaApplication
```
Before: `UNUSED_TYPE spec_delta_application`. After: no finding. A `project_config` whose only reference is its own
`merge(other: ProjectConfig): ProjectConfig`: still `UNUSED_TYPE`.

**Why A, not B.** It is a spec-graph rule, not code conformance, and PR A's tree needs it to validate without a false
warning or a suppression. The two existing UNUSED_TYPE allows (`openapi_spec_index`, `rule_context`) are unrelated —
neither type appears in any type method — so they stay.

### Decided for A (maintainer, 2026-09-13)
- **A1:** a key that has no effect at its depth refuses the whole write and names the path. A write that changes nothing
  answers plainly `No change to … — nothing written.` (not an error) and names any ineffective entries.
- **A3:** a type change keeps `description` and `label` unless the delta restates them; every other field the new type
  cannot have is dropped and listed.
- **A4:** `FOREIGN_STEP_FIELD` is a warning; `wairon doctor --fix` removes those fields.

### PR A — the model (spec-first), approved 2026-09-13 (`sdd_authoring` placement, structured JSON results)
**Why the model comes first.** Nothing A changes has a home in wairon's own tree: no spec has `updateSpec`, `getSpec`
or `deleteSpec`; `sdd_update_spec` and `sdd_get_spec` are unmodelled tools; the component write gate
(`validateComponentCandidate`, `src/core/rules/candidate.ts`) is on no contract; `wairon doctor` exists only in prose;
and the MCP server reaches `src/core/authoring.ts`, a file no spec claims.

**The code's own layering** (`src/core/authoring.ts` header): access paths (CLI, stdio MCP, hosted web, hosted MCP/API) →
authoring → specs + rules. The store stays dumb because the rule engine reads it — a store importing the rules would close
an import cycle — and mechanical writes (status promotion, layout normalization, migrations) bypass the gate by
construction.

**Proposed: a bounded context `sdd_authoring`.**
- `authoring_portal` (Portal) — the published write surface for spec authoring: `writeSpec(kind, spec, status?)` and
  `updateSpec(kind, id, delta)`, each returning a `SpecChangeReport`.
- `authoring_orchestrator` (Orchestrator) — the gated write:
  1. refuse keys that have no effect at their depth (A1, A11);
  2. for an update, load the stored spec and apply the delta (`spec_delta.applyTo`);
  3. refuse a step field its type cannot have (A3);
  4. keep an existing status unless one is given (A9);
  5. gate a component candidate through the validator;
  6. compare with the stored spec — unchanged means nothing is written and the report says "No change" (A1);
  7. save through the core adapter and return the report.
- `authoring_core_adapter` (Adapter → `core_portal` loads and saves) and `authoring_validator_adapter` (Adapter →
  `validator_portal.validateComponentCandidate`).
- Types, pure behaviour on the type (no Specialist): `spec_delta` with `applyTo(spec): SpecDeltaApplication` — the merge
  semantics of A2, A3, A5, A6 and A7, like a JSON Patch document applying itself; `narrative_step` with
  `foreignFields(): string[]` — the per-type field table shared by A3 and A4; plus `spec_delta_application`,
  `spec_change`, `spec_change_report` and `candidate_verdict`.

**Existing subsystems.**
- `sdd_validator`: `validator_portal` and `spec_validator` publish `validateComponentCandidate(candidate, options):
  CandidateVerdict` (existing code, now on a contract); `FOREIGN_STEP_FIELD` joins the narrative-flow rules.
- `sdd_mcp`: `mcp_portal` gains `sdd_update_spec` and `sdd_get_spec` (with the `methods` filter, A10); the create tools
  gain `status`; every write routes through a new `mcp_authoring_adapter`; `getSpec` reads through `mcp_core_adapter`.
- `sdd_core`: `spec_registry.saveSubsystemSpec` keeps an existing status (A9). Mechanical writes stay direct.
- `sdd_cli`: `cli_runner.runDoctor` is modelled; `--fix` removes foreign step fields through the core saves, a mechanical
  repair like the migrations.

**Dependencies.** `sdd_mcp` → `sdd_authoring` → {`sdd_core`, `sdd_validator`}; `sdd_validator` → `sdd_core` as today. No
cycle.

**Alternative.** Authoring inside `sdd_core` (`core_orchestrator.writeSpec`/`updateSpec` with a `core_validator_adapter`).
Smaller, but `sdd_core` and `sdd_validator` would depend on each other — `MUTUAL_SUBSYSTEM_DEPENDENCY`, silenced only by
a trusted link — the very cycle the code's layering exists to avoid.

**Result format.** A write returns structured JSON, as `sdd_validate_tree` does: `{ written, changes: [{ path, change,
dropped? }], notices }`, with a one-line human summary.

### A13. The validator's rules are designed in the spec tree (spec-coverage audit, 2026-09-13)
**Now.** The tree models the rule machinery — `rule_repository` (Store, Registry, Index) and the `sdd_rule`, `rule_code`
and `rule_context` types — but not the rules. Their behaviour is one prose `local` step (`spec_validator_impl.validateSddTree`
step 20) that names 32 of the 43; in code each is an `SddRule` object (`name`, `description`, `scope`, `codes`,
`check(ctx)`) under `src/core/rules/`. A rule change such as A12 has no spec to change first, and PR A and PR B change
several rules.

**Why a Specialist, and which kind.** Block by block, as the last-resort doctrine asks:
- not a type method — the rule set is open (packs register rules at runtime), and most verdicts read many specs;
- not a Store, Registry or Index — a rule holds nothing; the rule set is held state, already the rule Repository;
- not an Adapter (no I/O), and not an Orchestrator (no workflow — one verdict).

The standard names this shape: the `arbiter` variant ("subject + supplied world → deterministic verdict + reasons",
companion "Orchestrator → arbiter rules") and the Scanner role (`scan(scope) → findings`). Rules keep reporting through
`ctx.addIssue`, as ESLint rules report through `context.report` and clippy lints through `span_lint`.

**Chosen: shape B′ — rule families tied to code folders, one method per rule** (after a Fable 5.1 spar,
[`responses/fable-5.1-rule-model-spar.md`](responses/fable-5.1-rule-model-spar.md)). Eight `arbiter` Specialists in
`sdd_validator`. A method is one rule, named after it; its `findings` list holds the rule's codes. Each rule's code is one
file in its family's folder, and the method points at it with a per-method `sourcePath` and `symbol: check`. The families
follow the grouping already written in the code's rule registry (`src/core/rules/index.ts:62-141`).

| Component | Judges | Rules (run order) |
|---|---|---|
| `integrity_rules` | ids, references and serialization hold together | hierarchy-integrity, namespace-hygiene, roundtrip-serialization, type-references, public-surface, lint-allows (runs last) |
| `narrative_rules` | contracts and narratives agree and are sound | contract-symmetry-and-narratives, guarantee-tokens, narrative-flow (gains `FOREIGN_STEP_FIELD`, A4), narrative-antipatterns, narrative-detail |
| `intrinsic_rules` | one spec's own fields — the subset the write gate runs | portal-fields, durability-declaration |
| `doctrine_rules` | the standard's stereotype and pattern doctrine | portal-endpoints, portal-call-auth, stereotype-dependencies, pattern-ownership, facade-forwarding |
| `extension_rules` | what packs contribute resolves, applies and is pinned | architectural-profiles, pattern-references, component-variants, declarative-assertions, pack-resolution, pack-reproducibility |
| `wiring_rules` | the execution graph is connected and complete | dependency-cycles, dispatch-tables, lifecycle-entrypoints, unused-detection, durability-round-trip, untyped-seams, prose-claims, invariant-backing, event-topology |
| `conformance_rules` | code matches the spec | structural-conformance, call-conformance, hidden-state, dependency-conformance, integration-conformance |
| `heuristic_rules` | advisory size, naming and technology fit | coupling-health, target-language, technology-boundaries, naming-conventions, complexity-and-metadata |

```yaml
# L2 — wiring_rules
componentType: Specialist
variant: arbiter
dependsOn: [narrative_graph_projector]

# L3 — iwiring_rules
methods:
  - name: unusedDetection
    signature: 'unusedDetection(ctx: RuleContext): void'
    params: [{ name: ctx, type: RuleContext }]
    returns: void
    description: Walks the narrative graph from every entrypoint and reports what no chain reaches or nothing references.
    findings:                       # new field: the codes this method reports
      - { code: UNUSED_COMPONENT, severity: warning, summary: Component never reached by any narrative call chain }
      - { code: UNUSED_METHOD, severity: warning, summary: Method never called by any narrative step }
      - { code: UNUSED_TYPE, severity: warning, summary: 'Type never referenced by fields, signatures or type methods' }
      - { code: INVOKED_BY_UNDESCRIBED, severity: warning, summary: invokedBy caller prose missing or placeholder-thin }
      - { code: INVOKED_BY_REDUNDANT, severity: warning, summary: invokedBy on a method the internal walk already reaches }

# L4/L5 — wiring_rules_impl
methods:
  - name: unusedDetection
    sourcePath: src/core/rules/wiring/unused-detection.ts   # per method
    symbol: check
    narrative:
      # … seed the entrypoints, walk the graph (narrative_graph_projector.walk), report UNUSED_COMPONENT and UNUSED_METHOD …
      - stepNumber: 9
        type: local
        description: >-
          Mark every type named by a type field, an interface method signature or another type's method signature;
          a type naming only itself stays unmarked (A12)
      - stepNumber: 10
        type: local
        description: Report UNUSED_TYPE for each in-scope type left unmarked

# How rules become reachable — rule_registry_impl.registerBuiltinRules
narrative:
  - { stepNumber: 1, type: register, targetComponent: integrity_rules, targetMethod: hierarchyIntegrity,
      description: Add hierarchy-integrity to the rule set }
  # … one register step per built-in rule, in run order
```

**What B′ settles beyond the shape.**
- **One rule per file, `symbol: check`.** The analyzer indexes a rule object's `check` as a named body; a `const` holding
  the object has none, so pointing a method at the object's name would silently skip call conformance, and two rules in
  one file would merge their `check` bodies.
- **Rule files never import each other.** Queries on the tree become `rule_context` methods, the way ESLint shares
  analysis through its context; behaviour of one spec value becomes a type method (`method_implementation.stepGraph()`,
  `component_spec.defaultConformanceTier()`); the reachability walk becomes `narrative_graph_projector` (`variant:
  projector`), the one shared algorithm with enough doctrine to need its own narrative; the type-reference grammar, which
  canvas and surfaces use too, becomes type methods realized in `src/models/`.
- **Every family is a pure arbiter.** The validator gathers the round-trip dry-run issues and the known-code set into the
  rule context before any rule runs, so no rule calls core, and the `CALL_STEP_UNREALIZED` allow on `spec_validator_impl`
  goes: both calls become real callees of `validateSddTree`.
- **The registry names its built-ins.** `SDD_RULES` moves into the rule repository's file, so the registration edges are
  real imports; `rule_registry` depends on `rule_store` and the eight families (nine, under the cap of ten), and
  `rule_index.ruleSequence` appends `integrity_rules.lintAllows` last.
- **The write gate stays on `spec_validator`:** `validateComponentCandidate`, with its own `sourcePath`
  (`src/core/rules/candidate.ts`), loops over `rule_repository.specScopedRules()`, now on `irule_index` and
  `irule_repository`.
- **Type-method calls stay local steps until B6** lets a call step target them; PR B converts them.

**How the catalog stays true.**
- A declared finding code must appear as a string literal in its method's source file, as the anchored tier already
  checks method names; otherwise `UNREALIZED_FINDING` (warning). Any method may declare findings — a compiler pass, an
  API validator and a policy engine report codes too.
- Wairon's own tests compare the code registry (`SDD_RULES`: names, codes, severities, summaries, scope) with the spec
  catalog in both directions, as ESLint's repository checks every rule's `meta` and docs. It is a test, not a rule,
  because only wairon knows its registry's format.

**Alternatives considered.**
- **Shape B as first proposed** (each method pointing at the rule object's name, `symbol: reachabilityRule`). A `const`
  holding an object has no body the analyzer indexes, so call conformance would silently skip all 43 rules, and two rules
  sharing a file would merge their `check` bodies.
- **Shape A — one arbiter per rule** (`unused_detection_rule.check(ctx)`, 43 components). One-to-one with the code
  objects, like `notion_adapter` and `miro_adapter`, but 129 spec files at code granularity, and `rule_registry` would
  depend on 43 components: `GOD_COMPONENT` against the cap of ten. Everything a rule needs already lives at method level.
- **Shape C — one contract, 43 implementations** (`validation_rule.check`). Fewest files, but register and call steps
  target a component's method, not an implementation, so every rule is one node, and the reachability walker follows only
  the first implementation of a contract (`graph.ts:159-169`). A second implementation of a contract is meant as a swap
  seam for the same behaviour.
- **Rejected — methods on `rule_context`.** Packs add rules at runtime, so the set cannot be one type's fixed methods; it
  would also be a 43-method type, and types carry no narratives.

**Decided (maintainer, 2026-09-13).**
- **Narrative depth:** full L5 for all 43 rules.
- **`findings` on any L3 method**, checked against the method's source file.
- **Shape B′**, after the spar.
- **Order:** a schema PR (a per-method `sourcePath`, B3 moved up from PR B, and `findings`), then the rule model PR, then
  PR A. The schema PR's rule-code changes are the one step taken before the rules have specs.
- **Schema PR refinements:** `UNREALIZED_FINDING` ships with `findings`, so the field is checked from the day it exists;
  wairon's own methods whose code lives in another file are linked to it in the same PR.

## B. Conformance that never goes quiet

### B1. A call step is realized only by a call to the target's code (F6, F21)
**Now.** Source analysis records callee names only — `f()` and `x.f()` both as `f`, the object dropped
(`src/core/source-analysis.ts:443-446`) — and keeps imported names without the module they come from (492-502); an
aliased import is recorded under its local name (501). A step passes when any accepted name is among the callees
(`src/core/rules/call-conformance.ts:110`), or at once when the calling function itself has the target's name (the
identity shortcut, 109), without looking inside it.

**Example.** `validator_core_adapter_impl`'s step `core_portal.loadProjectConfig` passes because `validation.ts` declares a
function of that name (yaml 66-72); any leftover function with that name, from anywhere, would pass it too. Aliases hide
the opposite way: `setExecutionTier as writeExecutionTier` would never satisfy `cli_core_adapter.setExecutionTier`.

**Fix.** Record, for each imported name, its module and original name. A call step is realized only by a call that
resolves — through an import, a re-exporting barrel (the star-export chase already exists, 595-600), or a same-file
declaration — to the target implementation's `sourcePath`. The identity shortcut counts only when that function's body
makes such a call. The validator's own spec (`spec_validator_impl`, which describes the name matching) changes with it.

**Decision.** A callee whose origin cannot be resolved (a package import, dynamic dispatch, an unanalysed module).

### B2. A method whose code is not found is reported (F22)
**Now.** When no named function with the method's name (or `symbol`) has a body in the file, the call check skips the
method (`call-conformance.ts:84`), assuming `UNREALIZED_METHOD` covers it — but that rule accepts any declared name,
including a bare import (`source-analysis.ts:498-501`). About 20 `cli_runner_impl` methods (`runInit`, `runGenerate`,
`runSubsystem*`, `runSurface`, `runRemote`, …) are imported into `src/cli/index.ts`, called from anonymous command
callbacks, and never checked.

**Fix.** A new warning, `METHOD_BODY_NOT_FOUND`, when a method has call steps to check but its function body is not in
the file — naming where the name is only imported from ("`runInit` is imported here from `../commands/init.js`; give the
method that file (B3) or a `symbol`").

### B3. A method can name its own source file (F11)
**Now.** An implementation has one `sourcePath` (`src/models/specs.ts:715`); a dispatch-hub Orchestrator like `cli_runner`
cannot point each command at the file that implements it.

**Fix.** An optional per-method `sourcePath` overriding the implementation's. Structural, call and dependency conformance
and agent write fences read it; the MCP tools express it. Wairon's own `cli_runner_impl` gets its real files — which will
surface the findings B2 describes, fixed in the same pull request.

### B4. A call between co-located components needs a declared path (F19)
**Now.** Several implementations can share one file (five share `src/config/project-config.ts`). Callee data is keyed by
name and merged across same-named functions, the call check absorbs every same-file helper into the caller
(`call-conformance.ts:33-48`), and the dependency check ignores same-file edges (`dependency-conformance.ts:121, 127`).
Nothing notices one component calling another's function in the same file.

**Fix (clear case).** In a shared file, a function that is a contract method of one component belongs to that component; a
call from it to another component's contract function, with no call step and no declared dependency, is
`UNDECLARED_COLOCATED_CALL` (warning). Private helpers that no contract names stay shared and neutral — so the exact
wave-1 case (the index calling the store's private `rawValueAt`) is *not* caught; saying that limit plainly is part of the
proposal.

**Decision.** Build the clear case now, or leave B4 for later.

### B5. A prose-only method does not fake reachability (F10)
**Now.** A method with no narrative and a detail level below `full` marks every `dependsOn`/`owns` component reachable,
with all its methods (`src/core/rules/graph.ts:193-208`), which can hide `UNUSED_METHOD` on a collaborator's whole
surface. Its calls are also invisible to the call check, call cycles, `PORTAL_WRITE_SHORTCUT`, portal auth and invariants.

**Fix.** Intent methods may declare `calls: [component.method, …]`, validated like call steps and used by every rule that
reads call steps.

**Decision.** Whether the reach-everything fallback goes.

### B6. A call step can target a type's method (F23)
**Now.** `targetComponent` must be a component (`src/core/rules/contracts.ts:180` → `INVALID_TARGET_COMPONENT_REFERENCE`);
type methods are indexed nowhere (`src/core/rules/index.ts:315-332`). The hosted migration had to forward
`declaredPackNames` through `hostCore`, whose contract cannot name it.

**Fix.** A call step may target `targetType` + `targetMethod` (pure type behaviour needs no dependency edge). Checking that
the code calls it (B1) needs to know where the type's behaviour lives.

**Decision.** Add an optional `sourcePath`/`symbol` on type specs now (earlier deferred as "type conformance later"), or
validate type calls for existence only until then.

### B7. A lint allow covers exactly the finding it names (F18) — revised after review
**Now.** An allow is `{ code, reason }`, keyed by spec and code (`specs.ts:158-163`, `rules/index.ts:458-508`); findings
carry no structured site. `UNDECLARED_DEPENDENCY` lands on the first implementation mapped to the importing file
(`dependency-conformance.ts:97`), so one allow silences every import edge out of that file; a second allow with the same
code on one spec overwrites the first, which is then reported stale.

**Example.** `diagram_specialist_impl`'s allow, written for `validateSddTree`, also silenced the new
`project_config_repository` edge.

**Rejected first proposal.** "Allows without a target keep working, and validate lists what they silence." The maintainer:
keeping an over-broad suppression because migrating allows costs work is not a reason; the tool is still being developed,
and it must follow how real code and linters behave.

**How real linters scope a suppression.**
- One site: `// eslint-disable-next-line rule`, TypeScript's `// @ts-expect-error` — which itself fails when it
  suppresses nothing.
- A wider scope is an explicit, syntactic choice: `/* eslint-disable rule */` at a file's top, Rust's `#[allow(lint)]` on
  a module or function, `#[expect(lint)]` warning when unfulfilled.
- Project-wide switches live in configuration: ESLint `rules`, `Cargo.toml [lints]` — wairon's `rules.sddRuleSeverity`.

Wairon's allow had only the spec granularity, with findings anchored arbitrarily, so a spec-level allow acted as an
implicit file-wide disable nobody had chosen.

**Fix.** Every finding carries its site within the spec: the spec itself, a method, a step, a field, or a dependency
target, written with the change-report path syntax of A1. An allow names the site it covers and matches only that site:
`{ code: UNDECLARED_DEPENDENCY, at: imports.project_config_repository, reason }`,
`{ code: CALL_STEP_UNREALIZED, at: methods.renderDiagram.narrative[3], reason }`. An allow that matches nothing is
`UNUSED_LINT_ALLOW`, as `@ts-expect-error` fails. Allows in wairon's tree are rewritten in the same pull request.

**Decision.** Whether a deliberate wider scope exists at all.

### B8. A source file no spec claims is reported (F17)
**Now.** The code model reads only files named by `sourcePath`/`simPath` (`source-analysis.ts:629-633`). There are no
source roots and no notion of an unclaimed file; agent write fences come from `sourcePath`s (`src/core/agent_resolver.ts:330-336`).
`provision.ts`, `loader.ts`, `src/index.ts`, `doctor.ts` and a dozen more belong to no owner, and an import that passes
through such a file is invisible to the dependency graph — a false `UNREALIZED_DEPENDENCY`, or a missed
`UNDECLARED_DEPENDENCY`.

**Fix.** Declared source roots; a file under them that no implementation or method claims is `UNCLAIMED_SOURCE_FILE`; an
implementation may claim extra files (helpers, command files); the dependency graph walks through unclaimed files; agent
fences include claimed files. Wairon's own tree claims every file in the same pull request.

**Decision.** Opt-in or default, and severity.

## C. Delegation

### C1. Validate a worktree (F20)
**Now.** `sdd_validate_tree` takes `subsystem` and `recursive` only (`src/mcp/server.ts:1536-1539`) and validates the
server's bound root; the CLI has no `--cwd` or `--json`, and agents are told not to run it. The machinery already
validates another root: `runWithProjectRoot` plus the per-root spec cache, as `resolveThroughParent` does
(`src/core/validation.ts:585-604`).

**Fix.** An optional `root` on `sdd_validate_tree`, local only: accepted when it is the bound root, inside it, or a git
worktree of the same repository; configuration and validation both run bound to it, and the result names the root it
validated. The hosted data plane refuses `root` with a clear error (tenant filesystems). `wairon validate --json` for
scripts.

**Decision.** Which roots are allowed.

### C2. A spec change lists the tests it may break (F25)
**Now.** The only spec→test link is `simPath`; removal and rename notices already exist at the write boundary
(`removedByName`, `rewriteNotices`, `server.ts:419-463`).

**Fix.** When a write removes or renames a contract method or changes its signature, the result lists test files that
reference that symbol through the implementation's module — "tests to revisit: tests/server/pack-tiers.test.ts
(readProjectReferences)". Hosted roots, which carry no tests, say so.

### C3. Tests are typechecked (F24)
**Now.** `tsconfig.json` excludes `tests`; CI never typechecks them, so a deleted export fails only at test runtime.

**Fix.** A tests tsconfig and `npm run typecheck:tests`, run in CI after the build. The type errors it surfaces in
existing tests are fixed in the same pull request.

### C4. Delegation briefs carry the conventions agents kept tripping on (F27)
**Fix.** `sdd-delegate` and `sdd-implement` gain short sections: commit with explicit paths; on Windows PowerShell 5.1 a
`-m` message must not contain double quotes (use `-F`); in a worktree, prove the base commit first and remove a
`node_modules` junction only as a link; stop at the write fence and ask.

### C5. Move methods between components (F16)
**Now.** No tool moves a method. Externalize's `rewriteRefFields` rewrites single ids, not (component, method) pairs, and is
not exported (`src/core/provision.ts:571-651`). Splitting exposure policy out of `operations_orchestrator` meant re-sending
two contracts and narratives by hand and deep-comparing against HEAD.

**Fix.** `sdd_move_methods { from, to, methods }` moves contract methods and their implementations with status, re-points
every caller's call, dispatch and lifecycle steps, adds the new target to each caller's `dependsOn` (dropping the old one
when no call to it remains), and reports every rewrite; it refuses a missing target or a name collision.

**Decision.** Now or later.

### C6. Wairon's own tree models the tools it changes
**Found.** Twelve always-registered MCP tools have no `mcp_portal`/`mcp_orchestrator` method — `sdd_update_spec`,
`sdd_get_spec`, `sdd_delete_spec`, `sdd_add_type`, `sdd_set_endpoints`, `sdd_set_public_interfaces`,
`sdd_set_subsystem_project_path`, `listAgents`, `getAgent`, `listDomains`, `validateTopology`, `getProjectConfig` — plus
sixteen hosted discovery stubs and the prompts. `sdd_validate_tree` and `sdd_get_status` omit their params, and
`sdd_move_subsystem_project` declares `subsystemId` where the tool takes `subsystem`. The validator portal's
`validateSddTree`/`validateAsComplete` contracts (and four interfaces forwarding them) declare no options, although nine
production callers pass rules, project type and scope. Execution-budget derivation (`deriveExecutionProfile`,
`resolveBudget`) has no spec.

**Fix.** Group A changes `sdd_update_spec`, `sdd_get_spec` and the create tools, so those are modelled first (spec-first);
the rest follow.

**Decision.** Model every unmodelled tool and contract in this programme, or only the ones a fix touches.

## D. Spec coverage (decided 2026-09-13; after PR C, does not block stage 2a)
**Found.** 148 of 234 source files are named by no spec — every `sourcePath` and `simPath` compared with `src/` and
`web/src`, tests excluded — and no exclusion has a recorded reason:
- 39 files under `src/core/rules` — the 35 files holding the 43 rules, designed in PR A (A13), and 4 shared modules
  (context building, rule types, type analysis, the write gate);
- 42 React app files — one unrecorded note ("presentation, outside the SDD model"); the standard never mentions UI;
- 17 files whose behaviour is on a contract but whose file no spec names — CLI command bodies, `provision.ts`,
  `approval.ts`, `authoring.ts`, `config/loader.ts`, `diagram-export.ts`, `src/index.ts` (B3, B8);
- 13 files named only in prose, mostly data shapes (`src/models`, `server/types.ts`) (B6);
- 32 files with no component or contract — agent-file exporters, realtime and its WebSocket transport, the
  permission-model migration, domain detection and the aliases command, AI guide files, project context, execution
  budgets, the version stamp, the demo seed, and plumbing;
- 5 empty barrel files.

**What counts as a reason.** Generated or vendored code stays claimed by its owner under `conformance: off` (the canvas
engine in `web/src/canvas` is generated by `gen-canvas-engine.mjs`); tests and build scripts have their own tiers; a
private helper belongs to the component whose step it performs — claimed and fenced, with no contract of its own.
Product behaviour has no such reason.

**Plan.** `UNCLAIMED_SOURCE_FILE` (B8) lists what is left and keeps the list from growing; B3 and B6 link what is already
designed; each remaining area is designed spec-first, one at a time, as track D in `.wai/phased_design.md` lists. If UI is
declared outside SDD instead of modelled, that decision and its reason go into the architecture standard.

## E. Specialists that may deserve a block (proposals for the maintainer's review, 2026-09-14)
**Question (maintainer).** Can a Specialist be split into better-fitting blocks, and does a recurring shape that fits no
block deserve a new one — in the default set, or offered later by a pack?

**Data.** Wairon's tree has 28 Specialists: 12 `arbiter`, 6 `projector`, 3 `composer`, 3 `codec`, and 4 with no variant —
`auth_specialist`, `authorization_specialist` and `share_snapshot_specialist` in `sdd_host`, and `spec_validator`. The
standard's promotion criterion (`docs/standards/architecture.md` §8): a variant becomes a stereotype when independent
projects keep re-registering it, or when its edge rules exceed what guidance can express.

**E1. An existing block fits: `spec_validator` is an Orchestrator.** It writes the rule set (`registerBuiltinRules`,
`registerPackRules`), gathers the tree, the code model and the round-trip results through three Adapters, runs the rules
and returns the verdict: a workflow. Orchestrator and Specialist share the detail default (`full`) and the conformance
default (`declared`), and Portal → Orchestrator is the standard path, so the retype changes no dial. Proposed for the rule
model PR.

**E2. Query — a read-side block (candidate for the default set).** Gathers from several read facades, may ask arbiters
and projectors, returns a result, never writes.
- Evidence: the other three unvariant Specialists — `authorization_specialist` (four `list*` calls, then the resolver),
  `auth_specialist` (`get`/`find*` across five Repositories), `share_snapshot_specialist` (renders through two
  Adapters). The arbiter guidance already names this companion "gather-Specialist".
- Precedent: CQRS query handlers, GraphQL resolvers, XACML's policy information and decision points.
- Edge rules guidance cannot enforce: no call to a write-effect method (the check `PORTAL_WRITE_SHORTCUT` already makes
  for Portals); depends on Repositories, Indexes, Adapters and pure Specialists only; a Portal may call it directly.
- Blocker: effect tags. None of those three Specialists' 26 call steps reaches a tagged method, and 29 of 32
  Orchestrators call no tagged method at all, so the rule would judge nothing until facade methods are tagged (the open
  effect-tag extension).

**E3. Guard — a variant of Query.** A precondition check that workflows call first: authenticate, authorize, quota.
- Evidence: `auth_specialist` (17 consumers), `authorization_specialist` (15); `quota_specialist` is the arbiter half of a
  quota guard; the standard's Gateway already names interceptor Specialists.
- Precedent: NestJS guards, Spring Security filters, ASP.NET Core authorization handlers.
- Variant, not block: what makes it a guard is where callers place the call — a property of their narratives, not of its
  own edges.

**E4. Rule — a refinement of arbiter.** A verdict unit a rule engine runs over a shared context, reporting findings rather
than returning a value.
- Evidence: the 43 validator rules and programmatic pack rules.
- Precedent: ESLint rules, Semgrep rules, OPA policies, clippy lints.
- Checkable: every method declares findings; every method is reached through a register step, never a call; it depends
  on projectors at most. The arbiter guidance asks for a returned verdict and `idempotent`, which a reporting rule does not
  fit; the refinement would say so.
- Variant; valuable to tools that host plugins, so a pack candidate rather than foundational.

**E5. Codec and projector stay variants, with checked edges.** All three codecs depend on nothing; a projector reads at
most one facade and writes nothing (`share_snapshot_specialist` fails that with three facades — it is a Query). Both are
checkable as variant-scoped assertions, the mechanism the variant file already anticipates, without new blocks.

**Not proposed.**
- An Engine block that runs registered units over a context: that is E1's Orchestrator reading a Repository, with no edge
  of its own.
- A plugin-set pattern (registry, engine, units): a Repository plus an Orchestrator plus arbiters; a pattern owning a
  workflow block breaks "Repositories never contain a workflow Orchestrator".

**E6. Follow-up to the maintainer's questions (2026-09-14): sort by what a component depends on, not by what it
returns.** Sorting all 28 Specialists by their dependencies gives three groups, not four:
- 18 depend on nothing, or only on components that themselves depend on nothing: the 12 arbiters, the 3 codecs, the 2
  projectors that take their input as parameters (`landscape_diagram_specialist`, `narrative_graph_projector`) and the
  composer `pack_scaffold_specialist`.
- 9 read through Repositories or Adapters and, judging by the method names they call (none is effect-tagged), never
  write: the 4 projectors that load their own source (`diagram_specialist`, `state_hash_specialist`,
  `surface_projector`, `spec_projection_specialist`), the 2 composers that read the skills adapter
  (`instructions_specialist`, `skills_resource_specialist`) and E2's three.
- 1 writes and sequences: `spec_validator` (E1).

The four variants cut across the first two groups, which is why the projector guidance caps its reads in prose ("at
most one read facade") and why the multi-facade readers fit no variant.

Proposal: components by dependency class, variants for the kind of result, Specialist without variants.
- A pure computation block (working name Evaluator; alternatives Calculator, Transformer): depends only on other pure
  blocks, and any block may depend on it, Stores included (a file Store using a codec). Checkable today. Variants:
  arbiter, codec, projector, composer, and E4's rule through a pack.
- Query (E2; alternative name Reader): depends on Repository and Index facades, Adapters and pure blocks; a Portal may
  call it for reads; never writes, checked once facade methods carry effect tags.
- Orchestrator and Adapter unchanged. An OAuth or OIDC provider (token endpoint, signing keys, introspection) and an
  external linter run as a tool (ESLint, Semgrep) are Adapters. Wairon's own rules are not: they bind no external
  system, and Adapters default to calls-only narrative detail (`src/core/rules/narrative-detail.ts:32`).
- Specialist keeps the universal rules and takes no variant: a recognized shape belongs to the block whose dependencies
  it has, so a Specialist states why none fits. Wairon's own tree would have none.

Not four blocks: arbiter, codec, projector and composer would carry identical dependency rules, so the split adds names
without adding a check, and the standard's promotion criterion asks for rules guidance cannot express.

Consequences: projectors and composers that load their own source become Queries, or pure blocks whose caller loads for
them (the second preferred: loading in the workflow, deriving in pure code); the Gateway's containment rule, which names
interceptor Specialists, names the new blocks; effect tags on facade methods become a prerequisite for Query's write
check; rule-matrix fixtures, canvas styling, briefs and the standard's text gain the two blocks. Patterns (Repository,
Gateway, pack patterns) compose blocks and are unaffected.

**E7. The maintainer's model (2026-09-14): logic is an Orchestrator; E6's two new blocks withdrawn.** The maintainer
defines an Orchestrator as any flowchart of logic — ordered steps, conditions, branches, parallel dispatch, nested
calls to other Orchestrators down to leaf Orchestrators of native logic — while the other blocks are boundaries (Portal,
Adapter, Observer), facades (patterns), narrow deterministic data jobs grouped as classes (Store, Registry, Index) and
process owners (Supervisor, Actor). Checked against the code and the tree:
- A Specialist's narrative uses the same steps as an Orchestrator's (`auth_specialist` has 16 branches, `pack_codec`
  10), and both share the detail default (full) and the conformance default (declared). The one enforced difference is
  a dependency rule: a Specialist may not depend on Orchestrator, Supervisor, Actor, Store, Registry, Portal or Observer
  (`src/core/rules/stereotype-deps.ts:217`).
- Nesting already exists: 10 of 32 Orchestrators depend on another Orchestrator (23 edges); no rule forbids it.
- What the model replaces is §3's discriminator, "coordination, not complexity".

Proposal: one logic block. A variant declares a dependency class that the stereotype-dependencies rule enforces per hop,
so by induction nothing down a pure chain reaches data or I/O: `pure` (depends only on pure components — arbiter,
codec, a projector or composer handed its input), `read` (adds read methods of Repositories, Indexes and Adapters,
checked once facade methods carry effect tags — a loading projector or composer, a guard), and no variant for a
workflow. Specialist retires; the 28 map to 18 pure, 9 read and 1 workflow (E6's grouping). Semgrep is an Adapter plus
an Orchestrator (§4's standalone outbound). The validator keeps B′'s shape as nested Orchestrators: `spec_validator`
(workflow) → the families (pure) → `narrative_graph_projector` (pure) → type methods and `rule_context` queries as the
native leaf logic; L3 is unchanged.

Supervisor and Actor (maintainer's question). §3 defines them: an Actor owns one live process, loop, session or
instance with its runtime state and delegates each iteration's work to Orchestrators; a Supervisor owns the set of Actors
and their lifecycle; an Orchestrator holds injected collaborators and no domain state. Gaps: the stereotype-dependencies
rule has no case for Orchestrator, Supervisor or Actor as the depending side; wairon's tree has two Supervisors and no
Actor — `host_server` runs the periodic git-backup timer itself and `mcp_server` supervises sessions itself, both of
which §3 models as Actors.

Query (maintainer's question). §7 files a custom query as an Adapter-backed Index method, but an Index shares the
Store's references and is never stale, which a query the database computes per call is not. Proposal: a Query member
beside the Index inside a Repository, for computed reads over its own Store, depending on its Store or backend Adapter.
Joins across Repositories: not a Query depending on another Repository's facade (the Repository stops being a
self-contained unit, and two such queries form a cycle); by default a read Orchestrator that joins facade results; when
the join must run in the database, a read-model Repository whose Query runs it, with a declared relation naming the
Repositories whose data it reads — today an Adapter-backed query reads any table its connection sees without the graph
showing it (design needed).

Sequencing proposal: finish the rule model PR under today's rules (families as Specialist + arbiter; `spec_validator`
as Orchestrator, E1), because retyping the families now raises eight `ARCHITECTURE_VIOLATION_REGISTRY_DEP` warnings (a
Registry may depend on a Specialist but not an Orchestrator); then a doctrine PR before PR A.

**E8. Stress test (maintainer, 2026-09-14): Actors, singleton wiring, joins and Entity Framework.**
- *Actors.* Read literally, §3's "an Actor stays thin and delegates per-iteration work to Orchestrators" makes every
  Actor method a shim. Refinement: every logic component's methods are flowcharts; the component type says what it owns
  between calls — an Orchestrator nothing but injected collaborators, an Actor the runtime state of one live thing (a
  session, a connection, a timer) whose events it handles one at a time, a Supervisor the set of Actors. §5's test
  places the logic: logic over the Actor's own state (a protocol state machine, buffering, backoff) is the Actor's own
  method narrative; a workflow that stands on its own (it coordinates other components, or something else also triggers
  it) is an Orchestrator the Actor calls with values from its state before applying the result. An Actor never passes
  itself to an Orchestrator (§3: arguments carry only workflow input). Sketch of the process-layer rules the doctrine PR
  would add: Supervisor → its Actors, Orchestrators, Adapters; Actor → Orchestrators, Adapters, never a Store or
  Registry directly, never its Supervisor; Orchestrator → Supervisor to start, stop or reach a live instance by id,
  never an Actor directly.
- *Singleton Repositories.* A read Orchestrator holds its Repositories as constructor-injected collaborators wired once
  at the composition root; callers pass only input. §3 already says this ("stateless means no domain state — not no
  fields"); wairon's own Orchestrators depend on Repositories 70 times.
- *What a Store covers.* The standard implies one aggregate (§3: a Registry is the write path for one aggregate; §7: a
  Repository owns one Store and one Registry) but never says so; proposed wording: a Store covers one aggregate — the
  entity and everything that must stay consistent with it, across as many tables as that takes. Joins then fall into
  three cases: within an aggregate, a Store (or Query) method whose SQL join is its implementation; across aggregates
  with small data or different databases, a read Orchestrator over both Repositories; across aggregates in one
  database needing one SQL statement, a read-model Repository whose Query runs the join through the shared standalone
  database Adapter and declares which aggregates it reads. The patterns rule already allows a Repository without a
  Registry (it restricts member types only, `src/core/rules/patterns.ts:56-65`), though §7's text says "exactly one
  Registry"; Query would join the allowed member types.
- *Entity Framework.* Not excluded: the DbContext is the database Adapter (connection, change tracking, the
  transaction context §10 has the Adapter issue); entity mappings and navigation properties implement a Store; `Include`
  joins are Store methods; cross-aggregate LINQ projections or view-mapped keyless entities are read-model Queries. The
  one habit wairon pushes against is querying the DbContext from a workflow (§7: "never a consumer→Adapter shortcut"),
  which is doctrine text only today — any component may depend on an Adapter.

**E9. Second stress test (maintainer, 2026-09-14): Actor size, entity actors, timers, Orchestrator grouping, writes.**
- *Size.* No default limits a method's size for any component: `EXCESSIVE_NARRATIVE_STEPS` and `EXCESSIVE_METHODS`
  fire only when `rules.complexity` sets a cap (`src/core/rules/complexity.ts:135,176`); only dependency fan-out has a
  default (8, `GOD_COMPONENT`; wairon sets 10). Wairon's 991 methods with narratives: median 1 step, p95 13, max 59
  (`host_request_orchestrator.handleRequest`); Orchestrator p95 18; 13 methods exceed 20 steps, 3 exceed 30, and only
  Orchestrators and Specialists exceed 17. Proposal: a default step-cap warning for every method (threshold to settle,
  e.g. 20).
- *Actor methods (corrects E8).* An Actor method is a full flowchart and may call Repository facades, Indexes, Adapters
  and Orchestrators itself; a part moves into an Orchestrator only when something else also triggers it or it is too
  big to read — E8's "a workflow that coordinates other components is an Orchestrator" made every Actor method a shim.
  No Actor-owned Orchestrator (blocks own nothing; it would be a second kind of Orchestrator). Large decision logic
  follows the Decider pattern: decide (a pure Orchestrator given state and message) → apply to the Actor's own state →
  act through collaborators. Process-layer sketch amended: Actor → Repository facades, Indexes, Adapters,
  Orchestrators; never a Store or Registry directly, never its Supervisor.
- *Entity actors.* An Actor may be the live instance of an entity (Akka Cluster Sharding entities, Orleans grains keyed
  by id): the entity type stays data with pure methods, the Actor holds one instance's working state and handles its
  messages, and the Store stays authoritative (loaded on activation, written through the Repository). Not every Actor
  is an entity. Use one when live in-memory interaction is the point (auction, match, device twin); use persisted
  status plus event-driven workflows when steps are minutes to days apart. §3's Actor row names both cases.
- *Timers.* Per-instance, loss-safe timers are Actor state (Orleans timers, Akka `withTimers`); durable timers are due
  rows in a Store fired by a scheduler Actor (Orleans reminders); a process-wide schedule is its own Actor; restart
  backoff and passivation belong to the Supervisor; an external scheduler is an Adapter.
- *Orchestrator grouping.* §3 says one cohesive workflow and one workflow method; wairon's 32 Orchestrators hold 332
  methods. Proposal: a component is the unit holding its injected collaborators, with one or more methods, each one
  flowchart; methods belong together when they serve one purpose and share collaborators; groups of methods that call
  no common component are two Orchestrators in one, checkable over L5 targets — 8 of 32 today (`cli_runner` 8 groups,
  `project_ops_orchestrator` 6 groups each calling one other Orchestrator, `web_project_orchestrator` 3 groups in 4
  methods). Language realization is already in `docs/standards/language-bindings.md`; functional languages close
  functions over the collaborators.
- *Writes.* Decide the aggregate first. An owner's value objects (a profile's address) are saved with it in one Store
  call (EF owned types; `SaveChanges` orders inserts by foreign key). A separate aggregate (credentials) is written by
  the workflow in one transaction (§10): ids generated in the workflow, the dependent referencing the owner. Behaviour:
  own fields → type methods; with collaborators → an Orchestrator taking the entity (§5); live per instance → an
  entity Actor. Never cache-then-persist in a Supervisor.
- *Worked example, placing an order* (place, email a confirmation, cancel if unpaid after 30 minutes): one Portal;
  Orchestrators `place_order`, `send_confirmation`, `cancel_unpaid_order`; pure Orchestrators `pricing`,
  `confirmation_email`; Repositories for order (lines, address and price copies, status, outbox), basket, customer,
  product and scheduled jobs; Adapters for the database (transactions), bus and email; one Observer; Actors
  `outbox_relay` and `job_scheduler`; Supervisor `order_runtime`. Copies taken at placement remove most joins. 18
  components, 33 counting Repository members — the Repository expansion is where the spec has more parts than the code.
  Proposal: the doctrine PR adds this example to the standard.

**E10. Complexity levels, entities as schemas, a Supervisor example, naming (maintainer, 2026-09-15; two Fable 5.1
spars, repository claims verified).**
- *Complexity.* Verified: every narrative cap is an opt-in warning (`src/core/rules/complexity.ts:81,107,135,157,176`);
  the only default is `maxUnnarratedComplexity` 8, for methods without a narrative; project severity overrides beat
  pack profiles (`src/core/rules/index.ts:437-448`), but the complexity config merge lets the pack win
  (`complexity.ts:25`); `lint.allow` silences warnings only (`index.ts:504-510`). Measured over 991 narratives: McCabe
  with each switch case counted flags 3 above 10, two of them dispatch switches (`host_request_orchestrator.handleRequest`
  23, `cli_runner.runPack` 13); a cognitive score (branch, switch, loop, try with catches and parallel +1 each, plus
  +1 per enclosing loop/try/parallel region) flags 1 (`web_admin_orchestrator.removeUnit`, 12); steps: 13 above 20, 6
  above 25, 3 above 30. Against the realized code of 780 name-matched methods (211 unmatched; some matches are thin
  wrappers): a step is a median 1.0 statement (p75 1.8) and 2.6 lines; steps correlate weakly with statements (0.29).
  Proposal: two measures, each with a warning and an optional max on separate codes (severity overrides are per code);
  precedence built-in < pack profile < project (fix the merge). Level from the cognitive score — linear 0, simple 1–4,
  moderate 5–10, complex 11–20, severe 21+ — warning above moderate (McCabe and NIST SP 500-235: 10; SonarQube
  cognitive: 15; narratives are coarser than code, so lower). Steps warning above 25 (Checkstyle
  ExecutableStatementCount: 30; ESLint max-statements: 10); the existing `maxNarrativeSteps` becomes this warning. No
  default max. A loop or switch counts once, so table-driven designs stay low and their length meets the step warning.
  Exceptions: `lint.allow` with a reason on the warning; a max is a project decision, raised in `project.yaml` with a
  reason as `maxComponentDependencies: 10` is. A narrative-understates-code check (code McCabe > max(8, 2 × narrative +
  2) at detail full) fires on 45 of 362 matched methods (`openapi_codec.fromOpenApi`: code 51, narrative 2) — calibrate
  in PR B before any default.
- *Entities as schemas.* Verified: fields carry `key` (26 uses in 24 of wairon's type files) and `references`; types
  carry `database`, `table`, `linkedEntity` (the schema text describes separate table-schema types linked to an entity,
  the demo seed puts the table on the entity); the canvas has a Databases view; no rule in `src/core/rules` reads any
  of them; nothing exports a schema. Proposal: one type per entity with persistence as metadata (`persistence:
  {database, table}`, per-field `column`, `transient`); relations stated once on the field with foreign keys derived —
  other aggregates by id, owned value objects embedded (EF owned types), owned collections as child tables, many-to-many
  join tables derived; retire `linkedEntity`, `references` and `key: foreign`; each table-backed entity belongs to
  exactly one Store, bound to its database. No `extends`: it silently copies every future base field (a `passwordHash`
  added to User reaches every view extending it); read models are derived explicitly (`derivedFrom` with a source per
  field, checked for drift); polymorphic entities use a discriminator plus one owned value object per variant (TPH or
  TPT). Generation is a producer (`wairon produce schema --database <id> --target postgres|prisma|efcore`); migrations
  stay with the ORM. Checks: unknown database or table, table without a primary key, unresolved relation, cross-aggregate
  navigation, a table owned by zero or two Stores, read-model drift, and spec-to-ORM-schema drift.
- *Supervisor example: a live auction.* Weighed against a multiplayer match, ride dispatch, device twins and an order
  book. Components: `bidding_portal` (Portal, HTTP and WebSocket); `bidding` (Orchestrator: load the bidder, hand the
  bid to the live lot); `lot_lifecycle` (Orchestrator: open, close, cancel, markPaid — shared by the clock, admins and
  the payment feed); `bid_rules` (pure: `decide(lot, bid, bidder, policy, now)`, including the last-second extension);
  `seller_dashboard` (read Orchestrator over lots and bidders); `live_lot` (Actor: one open lot's state, watchers,
  heartbeat); `live_lots` (Supervisor: find-or-start by id, stop, unload idle); `deadline_scheduler` and `outbox_relay`
  (Actors); `auction_runtime` (root Supervisor); Repositories for lots (tables lots and bids), bidders and outbox;
  Adapters for the database, event bus and WebSocket; `payment_feed` (Observer). `live_lot.placeBid`: decide through
  `bid_rules`, write bid and outbox row in one transaction, apply to its own state only after commit, push to watchers.
  The deadline is the field `lot.endsAt`, read by the lot Index; a last-second bid moves it in the same transaction.
  After a restart nothing is preloaded: a lot restarts on its next bid, watch or close; due lots close within one tick;
  the relay republishes and consumers drop duplicates by event id.
  Rules it exposes: (1) an Orchestrator or Portal messages a live Actor by id through its Supervisor, never holding it —
  `dependsOn` lists the Actor with its Supervisor, since a call must target a declared dependency
  (`docs/standards/architecture.md:129-130`); (2) a live entity Actor is the only writer of its aggregate
  (`lot_lifecycle.close` goes through `live_lots`), per process — a cluster needs a lease or sharded routing; (3) the
  method that owns the workflow, Orchestrator or Actor, owns the transaction, and in-memory state changes only after
  commit (§10 names only the Orchestrator); (4) Supervisor → Supervisor; (5) Portal → Supervisor for by-id messages, as
  Observer → Supervisor already is (`architecture.md:104-105`); (6) deadlines are usually aggregate fields read by an
  Index, a schedule aggregate only for timers spanning aggregates (corrects E9 and the order example); (7)
  `src/core/rules/hidden-state.ts:29` treats Supervisor and Actor as components where held state must not live,
  contradicting §3 (`architecture.md:92`); (8) §7 says a Repository owns exactly one Store (`architecture.md:258`) while
  §10 puts an outbox Store inside it (`:435`) — with one Store per aggregate the outbox is a sibling Repository.
- *Naming.* The order example's names failed: `place_order.placeOrder` and `pricing.price` stutter, task-named
  components hid that three workflows form one Orchestrator, and `pricing` hid that the total is `order.total()` when
  prices are copied onto the lines. Guidance: a component is named for what it is responsible for — a process
  (`ordering`, `bidding`), a live thing (`live_lot`), a set of them (`live_lots`), an aggregate's data
  (`lot_repository`), an external system, an audience or feed; a method is a verb phrase that does not repeat the
  component's words; arithmetic over one value's own fields is a type method; logic without collaborators is named for
  the rules or output it holds (`bid_rules`, `order_mail`). Role words appear only to tell apart components sharing a
  noun and must match the type — 7 do not (Stores `pack_registry`, `lock_registry`, `producer_config_registry`,
  `git_config_registry`; Repositories `credential_registry`, `secret_registry`, `project_registry`). Checkable:
  stutter, a generic-word blocklist (the Manager/Helper/Utils ban is prompt text only: `src/utils/ai-guide.ts:71`,
  `src/templates/architect.yaml:21`, `src/templates/skills/sdd-architect.md:64`), role word versus type, a one-method
  component named after its method. Human review: one purpose, and whether logic belongs on the type. Renamed order
  example: `ordering.place`, `ordering.cancelIfUnpaid`, `order_notifications.sendConfirmation`,
  `order_mail.confirmation`, `order.total()`, and `order.paymentDueAt` with an unpaid-order sweep Actor instead of a
  scheduled-job Repository.
- *Corrections to E9.* `docs/standards/language-bindings.md` maps a component only to classes and structs (`:13-21`);
  the module-of-functions form still has to be written. The process-layer sketch gains Supervisor → Supervisor and
  rule (1).
- *Scope proposal.* After the rule model PR: a doctrine PR (logic and process blocks, dependency classes, Query,
  cohesion, naming and complexity checks), then a data-model PR (persistence mapping, relations, derived read models,
  schema producer), then A–C.

## F. What narrating the 43 rules found (rule model L4/L5, 2026-09-15)
Eight authoring agents narrated every rule and the projector faithfully from today's code. The lead checked the specs
mechanically — method paths and `symbol: check`, every declared code named in its narrative, call steps only to
declared dependencies: 0 failures — and the tree validates with 0 errors. The findings are the agents' reports with
file:line; none is reproduced yet, and each fix starts with a failing test.

**Complexity.** 27 of 44 methods score above 10 (branch, switch, loop, try with catches and parallel +1 each, plus
enclosing loop/try/parallel regions) and 13 exceed 25 steps. Largest: `contractSymmetryAndNarratives` 62 steps / 80,
`stereotypeDependencies` 47 / 65, `narrativeFlow` 47 / 54, `declarativeAssertions` 48 / 52, `patternOwnership` 43 / 43,
`targetLanguage` 28 / 38. Proposal: keep them faithful in this PR, which changes no behaviour, and decompose them in the
doctrine PR, where a family is a pure Orchestrator that can nest pure sub-flows. Natural splits, as the agents named
them: stereotypeDependencies (reference resolution, boundary rules, matrix, PORTAL_WRITE_SHORTCUT); contractSymmetry
(symmetry, dispatch targets, call/register targets, shared cross-tree handling); narrativeFlow (labels, config and jumps,
reachability, regions); declarativeAssertions (one per assertion kind); structuralConformance (file status, method
realization, declared findings); dispatchTables (table side, step side); unusedDetection (invokedBy audit, unused
components and methods, unused types); targetLanguage (builtins, flow constructs).

**Behaviour that looks wrong.**
- Narrative: `narrative-antipatterns.ts:149,162` and `isTerminal` (`:27-42`) use `nextOf` with no parallel case while
  `stepGraph` uses `fallNext` (`narrative-flow.ts:57-58,82,85`), so MEANINGLESS_BRANCH compares a non-final arm's end
  against the next arm instead of the join — the two must never disagree, per `stepGraph`'s own comment;
  `isUnavoidable` (`:49-67`) treats parallel arms as alternatives, so UNCONDITIONAL_CALL_CYCLE misses cycles through
  them; the lint-allow anchor uses `localeCompare` (`:252`).
- Doctrine: `patterns.ts:53` records a block as owner after BLOCK_OWNS_MEMBERS, so its Store escapes UNOWNED_STORE, its
  Registry escapes REGISTRY_WITHOUT_STORE and dependants get VISIBILITY_VIOLATION naming it a pattern; RouterComponent's
  "exactly one Portal" is checked as at least one (`:22,107`); a third owner is named wrongly (`:49-53`);
  PORTAL_WRITE_SHORTCUT ignores dispatch-table routes to write methods (`stereotype-deps.ts:317-340`).
- Wiring: dependency-cycles stops at the first cycle anywhere, so a scoped run can miss an in-scope cycle
  (`graph.ts:54-59`, unconfirmed); unused-detection ignores a draft subsystem (`graph.ts:266,298,311`); untyped-seams
  checks structured params only (`semantic-edges.ts:413`); prose-claims misses "persisting"/"persistence" and ignores
  register steps (`:444,473`) while firing on quoted text (F33); invariant-backing's draft context is inconsistent
  (`invariants.ts:108-125`); a topic declared twice reports twice (`event-topology.ts:69-78`).
- Conformance: integration-conformance counts missing files as the component's modules, so UNWIRED_INTEGRATION_SIM rides
  along with MISSING_SOURCE_FILE (`integration-conformance.ts:65-80`, live today) and does not skip chained subprojects;
  a dependency listed in both dependsOn and owns reports twice (`dependency-conformance.ts:233`); hidden-state ignores a
  method-level `conformance: off` (`hidden-state.ts:43`).
- Heuristic: GOD_COMPONENT reads `maxComponentDependencies` from project config with a default of 8 while
  EXCESSIVE_DEPENDENCIES reads the pack-merged value with no default — the comment says they agree
  (`coupling.ts:7-8,108`, `complexity.ts:20-28,107`); draft context differs across naming, complexity, language and
  technology.
- Minor: `hierarchy.ts:76` scans instead of using `interfaceMap`; `type-references.ts:53-84` resolves field references by
  hand while `:100` uses `isTypeResolved`; `sdd-narrative.md:36` documents `on` as required on a switch.

**L3 gaps closed in this PR.** code_model `pathKey`/`factsFor`; source_file_facts `functionComplexity`, `functionCalls`,
`topLevelMutableBindings`, `resolveImport`; implementation_spec `simPath`, `technologies`; rule_ext `packSelections`,
`selectionFailures`; subsystem_spec `isDraft`; component_spec `basePath`, `auth`, `emits`, `subscribesTo`,
`externalLinks`, `isPattern`, the four durability modes; type_spec `invariants`; profile_def `allowedEdges` as
`AllowedEdge[]`; rule_context `namingConfigFor` (and `targetLanguageFor` documented as normalized); rule_store `clear`;
new types event_binding, external_link, invariant, allowed_edge. Model vocabulary (`SEMANTIC_GUARANTEES`,
`PATTERN_TYPES`) stays imported from `src/models`.

**Friction.** F30 again; F31 (validate cannot narrow to one spec), F32 (continue forms undocumented), F33 (prose-claims on
quoted text), F34 (a labeled method added through `sdd_update_spec` reported its own labels unknown).
