# Design: control flow in L5 narratives + the narrative detail dial

Status: **proposal — not implemented**. Companion to the flowchart renderer in
the canvas.

## 1. Motivation

L5 narratives are today a strictly linear list of steps (`local` | `call`).
Real methods branch, loop, and return early — so every generated flowchart is
a straight line, and the narrative cannot faithfully describe the flows where
fidelity matters most (error paths, retries, dispatch loops). This proposal
adds flow structure while keeping the flat, ordered, delta-friendly step list.

At the same time, full flowchart-level detail is NOT the right default for
every method (see §8): detail should be a declared, per-scope dial, not an
implicit global obligation.

## 2. Shape: flat steps + explicit jumps (no nesting)

Steps stay a flat, ordered array with `stepNumber`. Flow structures are
special step types whose config points at other steps **by step number** —
"when false, jump to step 7". Reading order = numbering = default fall-through.

Why jumps instead of nested `children` blocks:

- **Backwards compatible by construction** — every existing narrative is
  already valid (a jump-free program).
- The granular `sdd_update_spec` delta model (insert/delete/replace a step)
  keeps working on a flat list; nested blocks would need a whole new delta
  vocabulary.
- Renders naturally in BOTH modes: numbered steps (a jump is one line of
  text) and flowchart (a jump is an edge).
- The known GOTO fragility (renumbering breaks targets) is contained because
  all writes go through the MCP tools, which renumber jump targets
  atomically (§4).

Nesting was rejected: more expressive on paper, but it breaks the flat
authoring model, complicates every consumer, and offers no rendering benefit.

## 3. Schema (additive)

`NarrativeStepTypeSchema` grows from `['local', 'call']` to:

```
['local', 'call', 'branch', 'loop', 'switch', 'return']
```

New **optional** fields on `NarrativeStepSchema` (unused by old types):

```yaml
# branch — "if <condition> continue at onTrueStep (default: next step),
#           otherwise jump to onFalseStep"
- stepNumber: 3
  type: branch
  description: cache entry exists and is fresh
  condition: cache hit && age < ttl        # prose or pseudo-expression
  onTrueStep: 4                            # optional, default = next step
  onFalseStep: 6                           # required

# loop — header step; body = steps (stepNumber+1 .. endStep); after the body
#        control returns to the header; when the condition no longer holds
#        (or the iteration source is exhausted) control continues at endStep+1
- stepNumber: 6
  type: loop
  description: for each pending job
  over: pending jobs from the queue        # for-each source (or use condition)
  condition: null                          # while-style alternative to over
  endStep: 9                               # required, > stepNumber

# switch — multiway dispatch on a value
- stepNumber: 10
  type: switch
  description: dispatch on job kind
  on: job.kind
  cases:
    - value: build
      step: 11
    - value: test
      step: 14
  defaultStep: 17                          # optional; default = next step

# return — early terminator (success or failure path)
- stepNumber: 13
  type: return
  description: job already completed — nothing to do
  outcome: success                         # free text; 'success' / 'not found' / …
```

`call` and `local` steps are unchanged and remain valid jump targets.
`assertsGuarantees` keeps working on every type.

## 4. Authoring via MCP

**`sdd_write_narrative`** — the agent submits the steps array in order;
`stepNumber` is assigned from array position (1-based), exactly as today. Jump
fields therefore reference *positions in the submitted array*, which the agent
can count while writing:

```json
{ "component": "job-orchestrator", "method": "runNext", "steps": [
  { "type": "call",   "description": "fetch next pending job", "targetComponent": "job-repository", "targetMethod": "nextPending" },
  { "type": "branch", "description": "a job was found", "condition": "job != null", "onFalseStep": 5 },
  { "type": "call",   "description": "execute it", "targetComponent": "job-runner", "targetMethod": "execute" },
  { "type": "local",  "description": "record the result" },
  { "type": "return", "description": "done", "outcome": "success" }
] }
```

**`sdd_update_spec`** narrative deltas stay granular, with one new invariant:
inserting or deleting a step **renumbers all subsequent steps AND rewrites
every jump field in the same narrative** (`onTrueStep`, `onFalseStep`,
`endStep`, `cases[].step`, `defaultStep`) that points at or beyond the
mutation point — the same way an assembler relocates addresses. Deleting a
step that is itself a jump target is rejected with a clear error naming the
referring steps (the agent must retarget or delete those first).

Manual YAML edits remain possible but unprotected — `INVALID_STEP_JUMP` (§5)
catches breakage at validate time.

## 5. Validation (new rule module `rules/narrative-flow.ts`)

| Code                 | Severity | Meaning                                                        |
|----------------------|----------|----------------------------------------------------------------|
| `MALFORMED_FLOW_STEP`| error    | branch without `condition`/`onFalseStep`; loop without `endStep` or `endStep <= stepNumber`; switch without `cases`; flow config on a `local`/`call` step |
| `INVALID_STEP_JUMP`  | error    | any jump field targeting a step number that does not exist in the narrative |
| `UNREACHABLE_STEP`   | warning  | step not reachable from step 1 following fall-through + jumps  |

Registered in the rule registry like the other 12 modules (severity
overridable per project, listed by `wairon rules list`). The existing
unused-component/method reachability walk needs **no change**: it already
iterates all steps of a narrative linearly, so `call` steps inside branches
and loop bodies keep counting as usage.

## 6. Rendering

- **Steps mode** (sidebar / modal): one line per step —
  `3. ◇ if cache entry is fresh … else → 6`, `6. ⟳ for each pending job (6–9)`,
  `13. ⏎ return — success`.
- **Flowchart mode** (canvas modal): `branch`/`switch` render as diamonds with
  labeled outgoing edges (true/false, case values), `loop` as a diamond with a
  back-edge from `endStep`, `return` as a rounded terminator. Main spine stays
  vertical; jump edges route beside it. Call drill-down and PNG/draw.io/
  Excalidraw export work unchanged (they consume the same step graph).
- **Mermaid sequence diagrams**: `branch` → `alt`/`else`, `loop` → `loop`,
  `switch` → `alt` with one branch per case, `return` ends the fragment —
  Mermaid supports all of these natively.

## 7. Compatibility & migration

- **Old specs → new wairon**: every existing narrative parses and validates
  unchanged (linear = jump-free). **No migration, no file rewrites.**
- **New specs → old wairon**: an old binary rejects unknown step types with a
  Zod parse error. Changelog note: upgrade wairon before adopting flow steps.
- All schema fields optional/additive; `sdd_write_narrative` calls written for
  today's shape keep working verbatim.

## 8. The detail dial — `narrativeDetail` (answers "is full L5 overkill?")

Full flow-level narratives for every method WOULD be overkill (a CRUD
passthrough doesn't need a flowchart, and writing one is just programming in
YAML). The fix is not to weaken L5 — it's to make the fidelity level a
**declared, validated property of a scope** instead of an implicit global
obligation:

```yaml
# L1 subsystem (or L2 component override)
narrativeDetail: full | calls-only | skip
skipReason: pure CRUD passthroughs — structure-level design is sufficient  # required for skip
```

- **`full`** (default): narratives expected on the public surface; flow steps
  encouraged where the logic branches.
- **`calls-only`**: narratives only need the cross-component `call`
  choreography; local detail and flow structure optional. Cheap to author and
  keeps the unused/reachability analysis fully sound (it only consumes call
  steps anyway).
- **`skip`**: narratives optional in this scope. Requires `skipReason` (same
  philosophy as `trustedLinks`: exceptions become reviewable spec, never
  silence). Validator consequences: narrative-completeness warnings are
  suppressed for the scope, and the unused-walk falls back to L2 `dependsOn`
  edges (component granularity) for callers inside the scope so their callees
  don't false-positive as unused. Status/canvas surface the declared level, so
  a reviewer always sees "this area was deliberately designed to structural
  level only".

Why keep detailed L5 at all, for AI-driven development: the narrative is the
**review surface** (a human can approve a flowchart before code exists, but
cannot meaningfully review 10k lines of generated diff), the **cross-boundary
choreography record** (exactly what per-subsystem mock tests never verify),
the **durable regeneratable asset** (code is disposable; re-target languages
or re-generate from the same narratives), and the required granularity for
the planned **code↔spec conformance checking**. The dial concentrates that
effort on the flows where review-before-code actually pays.

## 9. Impact inventory

| Area | Change |
|------|--------|
| `src/models/specs.ts` | step-type enum + optional flow fields; `narrativeDetail`/`skipReason` on L1/L2 |
| `src/mcp/server.ts` | `sdd_write_narrative` input schema + description; `sdd_update_spec` docs |
| `src/core/specs.ts` | renumber-and-relocate on narrative insert/delete; reject deleting a jump target |
| `src/core/rules/narrative-flow.ts` (new) + `index.ts` | 3 new codes (§5) |
| `src/core/rules/graph.ts` | `skip`-scope fallback to L2 edges in the unused-walk |
| `src/core/diagram.ts` | Mermaid sequence `alt`/`loop` blocks |
| `src/core/canvas.ts` | flow modal: diamonds, labeled/back edges, terminators; steps-mode text |
| skills + standards docs | authoring guidance & examples |
| tests | schema, rules, renumbering, sequence generator, canvas runtime flow |

Phasing: (1) schema + validation + update semantics, (2) MCP authoring, (3)
renderers, (4) detail dial. Each phase lands green and is independently
useful; nothing before (3) changes any visual output.

## 10. Open decisions

1. Jump-by-step-number with tool-side relocation (recommended, §2) vs stable
   step labels — labels are insert-proof but add authoring friction.
2. Should `narrativeDetail` default depend on stereotype (e.g. `full` for
   Portal/Orchestrator, `calls-only` for Store/Adapter)?
3. Ship the detail dial in the same release as flow steps (recommended — they
   answer the same criticism from both sides) or as a follow-up.
