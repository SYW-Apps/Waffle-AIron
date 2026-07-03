# Design: control flow in L5 narratives + the narrative detail dial

Status: **implemented** (schema + rules, MCP authoring with jump relocation,
flow-aware renderers, detail dial — July 2026). Kept as the design record;
§10 lists the decisions as resolved.

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

## 3. Schema (additive) — the complete vocabulary

`NarrativeStepTypeSchema` grows from `['local', 'call']` to:

```
['local', 'call', 'branch', 'switch', 'loop', 'try', 'jump', 'return', 'throw']
```

Nine types cover every classical control structure. Deliberately, syntax
variants are **config on one type**, not separate types (all four loop forms
are `loop` + `loopKind`) — renderers and validators then handle one shape per
concept. New **optional** fields on `NarrativeStepSchema` (unused by old
types):

```yaml
# branch — if/else: "if <condition> continue at onTrueStep (default: next
#           step), otherwise jump to onFalseStep"
- stepNumber: 3
  type: branch
  description: cache entry exists and is fresh
  condition: cache hit && age < ttl        # prose or pseudo-expression
  onTrueStep: 4                            # optional, default = next step
  onFalseStep: 6                           # required
# else-if chains = the onFalseStep target is itself a branch step.

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

# loop — header step; body = steps (stepNumber+1 .. endStep). All four
#        classical forms via loopKind:
#          forEach — iterate `over` a collection
#          for     — indexed/counted; put the range in `over` ("i in 0..n")
#          while   — `condition` checked BEFORE each iteration
#          doWhile — `condition` checked AFTER the body (body runs >= once)
#        When the loop ends, control continues at endStep+1.
- stepNumber: 6
  type: loop
  loopKind: forEach                        # forEach | for | while | doWhile
  description: for each pending job
  over: pending jobs from the queue        # forEach/for iteration source
  condition: null                          # while/doWhile condition
  endStep: 9                               # required, > stepNumber

# try — guarded region: body = steps (stepNumber+1 .. endStep); a matching
#       error during the body jumps to that catch's step; finallyStep (if
#       set) names the first step of a region that runs on every path out.
- stepNumber: 4
  type: try
  description: guard the external dispatch
  endStep: 7                               # required
  catches:
    - error: TimeoutError                  # free text — the error/condition caught
      step: 8
    - error: any
      step: 11
  finallyStep: 13                          # optional

# jump — unconditional goto. THE glue primitive: `break` = jump past
#        endStep+1, `continue` = jump to the loop header, and how a catch
#        block rejoins the main flow. Use sparingly; UNREACHABLE_STEP and
#        review keep it honest.
- stepNumber: 12
  type: jump
  description: recovered — rejoin the normal flow
  toStep: 14                               # required

# return — terminator (happy or handled-failure exit)
- stepNumber: 13
  type: return
  description: job already completed — nothing to do
  outcome: success                         # free text; 'success' / 'not found' / …

# throw — error terminator: this path ends by raising/propagating an error
- stepNumber: 9
  type: throw
  description: retries exhausted
  error: DispatchFailedError               # free text
```

`call` and `local` steps are unchanged and remain valid jump targets.
`assertsGuarantees` keeps working on every type.

**Considered and deferred:** a `parallel` fan-out step (concurrent calls,
`Promise.all`-style). Real in orchestrators, but it complicates every renderer
and validator for a case that a `local` step ("in parallel: dispatch to all
runners") plus individual `call` steps describes acceptably today. Revisit
when a concrete Waffler narrative actually needs joined-branch semantics.
Recursion needs nothing special (`call` may target the method itself), and
async/await is intentionally NOT flow structure here — awaiting is an
implementation concern, not narrative-level control flow.

**On try/catch belonging in flowcharts:** classical flowcharts predate
structured exception handling and typically show only the happy path — but
SDD narratives are not decorative flowcharts; they are the review surface,
and error paths (compensation, rollback, retries, propagation across
subsystem boundaries) are precisely where review-before-code pays the most.
So `try`/`throw` are in. The happy path stays readable through rendering,
not through omission (§6).

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
| `MALFORMED_FLOW_STEP`| error    | branch without `condition`/`onFalseStep`; loop without `endStep` or `endStep <= stepNumber`; `while`/`doWhile` without `condition`, `forEach`/`for` without `over`; switch without `cases`; try without `endStep` or with neither `catches` nor `finallyStep`; jump without `toStep`; flow config on a `local`/`call` step |
| `INVALID_STEP_JUMP`  | error    | any jump field (`onTrueStep`, `onFalseStep`, `cases[].step`, `defaultStep`, `endStep`, `catches[].step`, `finallyStep`, `toStep`) targeting a step number that does not exist in the narrative |
| `UNREACHABLE_STEP`   | warning  | step not reachable from step 1 following fall-through + jumps (catch/finally regions count as reachable from their try) |

Registered in the rule registry like the other 12 modules (severity
overridable per project, listed by `wairon rules list`). The existing
unused-component/method reachability walk needs **no change**: it already
iterates all steps of a narrative linearly, so `call` steps inside branches
and loop bodies keep counting as usage.

## 6. Rendering

- **Steps mode** (sidebar / modal): one line per step —
  `3. ◇ if cache entry is fresh … else → 6`, `6. ⟳ for each pending job (6–9)`,
  `4. ⛨ try (5–7) — on TimeoutError → 8`, `13. ⏎ return — success`,
  `9. ⚡ throw DispatchFailedError`.
- **Flowchart mode** (canvas modal): `branch`/`switch` render as diamonds with
  labeled outgoing edges (true/false, case values); `loop` as a diamond with a
  back-edge from `endStep` (for `doWhile` the diamond sits at the END of the
  body); `try` as a subtle guarded region with dashed error edges to its
  catch steps; `return` as a rounded terminator and `throw` as an error-tinted
  one. Main spine stays vertical; jump/error edges route beside it. Call
  drill-down and PNG/draw.io/Excalidraw export work unchanged (they consume
  the same step graph).
- **One flowchart, not separate happy/unhappy charts.** Splitting paths into
  parallel diagrams invites drift and hides exactly the junction points a
  reviewer needs to see (where the flow *leaves* the happy path). Instead the
  happy path reads as the main spine, error edges/terminators are visually
  distinct (dashed, error color), and the flow modal gets a **"hide error
  paths" toggle** that filters catch regions, `throw` terminators, and error
  edges from the one source of truth when a pure happy-path view is wanted.
- **Mermaid sequence diagrams**: `branch` → `alt`/`else`, `loop` → `loop`,
  `switch` → `alt` with one branch per case, `try`/`catches` → `critical`/
  `option` (or `alt` fallback), `return`/`throw` end the fragment — Mermaid
  supports all of these natively.

## 7. Compatibility & migration

- **Old specs → new wairon**: every existing narrative parses and validates
  unchanged (linear = jump-free). **No migration, no file rewrites.**
- **New specs → old wairon**: an old binary rejects unknown step types with a
  Zod parse error. Changelog note: upgrade wairon before adopting flow steps.
- All schema fields optional/additive; `sdd_write_narrative` calls written for
  today's shape keep working verbatim.

## 8. The detail dial — declared per method, IN the L5 spec (answers "is full L5 overkill?")

Full flow-level narratives for every method WOULD be overkill (a CRUD
passthrough doesn't need a flowchart, and writing one is just programming in
YAML). The fix is not to weaken L5 — it's to make the fidelity level an
**explicit, per-method declaration in the implementation spec itself**. No
subsystem-level dial, no cascading overrides across layers — the decision
lives exactly where the detail lives:

```yaml
# L4 implementation spec
detail: calls-only            # optional spec-level default for all methods
methods:
  - name: forwardRequest      # inherits calls-only: narrative = call steps
    narrative:
      - { stepNumber: 1, type: call, description: pass through to the orchestrator, targetComponent: job-orchestrator, targetMethod: runNext }
  - name: healthCheck
    detail: intent            # per-method override — no narrative needed
    intent: >
      Returns 200 with build metadata; 503 when the orchestrator's readiness
      probe fails. No side effects, no auth.
  - name: negotiateProtocol
    detail: full              # this one IS worth a flowchart
    narrative: [ ... flow steps ... ]
```

- **`full`** — narrative required; flow steps encouraged where logic branches.
- **`calls-only`** — narrative required but only the cross-component `call`
  choreography is expected; local/flow detail optional. Keeps the
  unused/reachability analysis fully sound (it only consumes call steps).
- **`intent`** — narrative optional; behavior is specified as prose instead.
  The **intent floor** applies: the method's `intent` field (or, if absent,
  its L3 `description`) must be non-trivial — not missing, not a few words
  restating the name — and failure behavior must be stated there or in
  `guarantees`. `INTENT_FLOOR` fires as an error otherwise.

Detail levels are **floors, not ceilings** — extra detail is never penalized.
Precedence: method `detail` → spec-level `detail` → **stereotype default**:

| Stereotype | Default | Rationale |
|------------|---------|-----------|
| Portal, Observer, Adapter | `calls-only` | boundary pass-throughs — real logic belongs in the Orchestrator they forward to; a flowchart of "receive → forward" is noise |
| Store, Index, Registry | `intent` | persistence semantics are a contract paragraph, not choreography |
| Orchestrator, Supervisor, Actor, Specialist, Repository, Gateway, patterns | `full` | this is where flows branch and cross boundaries — the review surface |

Stereotype defaults mean the common case needs **zero extra fields** (an
Adapter spec with call-step narratives is already conformant), while any
method can be dialed up or down explicitly — including a Portal endpoint that
genuinely branches (which is itself a smell the docs should note: heavy Portal
logic usually belongs in a dedicated Orchestrator).

Can an agent implement accurately from signature + intent + guarantees +
types alone? For the code `intent` is appropriate for — CRUD passthroughs,
mappers, thin adapters — yes, reliably; that is precisely what makes them
skippable. If a method can't be specified adequately in a paragraph, that is
the signal it needs `calls-only` or `full`. The dial self-selects.

Why keep detailed L5 at all, for AI-driven development (unchanged): the
narrative is the review surface a human can approve BEFORE code exists, the
cross-boundary choreography record mocked unit tests never verify, the
durable regeneratable asset, and the granularity code↔spec conformance
checking needs.

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
| `src/models/specs.ts` | step-type enum + optional flow fields; `detail` on L4 spec + methods, `intent` on methods |
| `src/core/rules/narrative-detail.ts` (new) | `MISSING_NARRATIVE` + `INTENT_FLOOR`, driven by method → spec → stereotype detail resolution |
| `src/mcp/server.ts` | `sdd_write_narrative` input schema + description; `sdd_update_spec` docs |
| `src/core/specs.ts` | renumber-and-relocate on narrative insert/delete; reject deleting a jump target |
| `src/core/rules/narrative-flow.ts` (new) + `index.ts` | 3 new codes (§5) |
| `src/core/rules/graph.ts` | `intent`-level callers fall back to L2 `dependsOn` edges in the unused-walk |
| `src/core/diagram.ts` | Mermaid sequence `alt`/`loop` blocks |
| `src/core/canvas.ts` | flow modal: diamonds, labeled/back edges, terminators; steps-mode text |
| skills + standards docs | authoring guidance & examples |
| tests | schema, rules, renumbering, sequence generator, canvas runtime flow |

Phasing: (1) schema + validation + update semantics, (2) MCP authoring, (3)
renderers, (4) detail dial. Each phase lands green and is independently
useful; nothing before (3) changes any visual output.

## 10. Decisions

Resolved (user-approved 2026-07-03):

- **Complete flow vocabulary** (§3): branch/if-else, switch, all four loop
  forms, try/catch/finally, throw, return, jump. `parallel` deferred.
- **Error paths live in the SAME flowchart**, visually distinct, with a
  "hide error paths" renderer toggle — no separate happy/unhappy charts.
- **Jump-by-step-number with tool-side relocation** — a flat list whose order
  mimics the code lines; blocks are just skipped regions.
- **Detail dial approved and reshaped** (user, 2026-07-03): declared per
  method in the L4/L5 spec (`detail: full | calls-only | intent` +
  `intent` prose), spec-level default, **stereotype defaults** (Portals and
  Adapters are pass-throughs; their flowcharts are redundant), no
  subsystem-level dial. Intent floor (§8) so `intent` never means "no
  behavioral specification".
- Flow steps and the detail dial ship in the same release.
