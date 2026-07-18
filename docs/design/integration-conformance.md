# Design: integration sim as Definition of Done → the integration-conformance gate

Status: **process shipped, gate shipped** (July 2026). The sdd-implement
skill's Definition of Done requires an integration sim (§3); the static
integration-conformance gate (§4) is implemented as the
`integration-conformance` rule family, with one refinement over the original
design: MISSING_INTEGRATION_SIM activates **per subsystem** once its first
`simPath` is declared (§4.4) — the adoption story made mechanical, so a tree
that has not adopted sims is not flooded with expectations it never made.

## 1. Motivation (the retro that started this)

A real failure in this project: a component shipped with 25 passing pure/
mocked resolver tests, was declared "done", and only a later ad-hoc "demo
green" run proved the wired system actually worked — and that demo was never
a GATE, just luck. Today's conformance stack proves progressively more about
SHAPE and nothing about EXECUTION:

- `sdd_validate_tree` proves the **design** is coherent (hierarchy, contracts,
  narratives, boundaries, semantic edges).
- Structural + dependency conformance (Levels 1–2) prove the **code matches
  the spec's shape** (files exist, methods realized, import graph matches the
  declared edges).
- Unit tests with mocked dependencies prove the component honors its
  **contract shape** against its OWN understanding of its collaborators.

None of these prove "the wired components RUN together". Mocks encode the
implementer's assumptions — which is exactly where cross-component bugs live.

## 2. Principle: honesty about what each check proves

This design deliberately splits into a **process gate now** (§3 — cheap,
already enforceable through the sdd-implement skill) and a **static
conformance gate later** (§4 — checkable by the validator without running
anything). The validator is static and I/O-free outside the source-analysis
adapter; it must never CLAIM to have executed anything. Running the sim is
the test runner's / CI's job; the validator's job is to prove the sim
EXISTS, is WIRED to real modules, and COVERS the narrative paths — the same
honesty stance as the detail-sufficiency and invariant lints (declarations
checked, not correctness).

## 3. SHIPPED — Definition of Done in sdd-implement (process gate)

The sdd-implement skill's Workflow Rule 6 now defines Done as all three,
reported explicitly:

1. `sdd_validate_tree` reports zero errors (design coherent),
2. the unit test suite is green (contract shape honored),
3. an **integration sim** runs green: the component constructed with its
   REAL direct dependencies (the implementations behind their L3 contracts,
   from their L4 `sourcePath`s) and driven through its narrative paths — the
   happy path plus each declared error path (`branch`/`throw` steps, stated
   `intent` failure behavior).

Rules that make the sim honest:

- A missing dependency implementation is a **sequencing problem** (implement
  leaves before dependents — the planned `wairon implement plan` waves), not
  a license to mock.
- Only **technology boundaries** may stay faked: the outermost `Adapter`
  over a vendor/system declared in L4 `technologies`, with a
  contract-faithful fake. Sibling L2 components with implementations are
  never mocked.
- The sim must be a **committed, re-runnable harness** — a one-off manual
  run that leaves no artifact does not satisfy the gate.

## 4. DESIGNED — the static integration-conformance gate (not yet implemented)

Goal: "a component cannot claim `complete` until a harness wires it to its
real dependencies and exercises its narrative paths" — enforced by the
validator, statically, with the machinery Levels 1–2 already built.

### 4.1 Spec surface

One optional L4 field:

```yaml
# implementation spec
simPath: tests/integration/routing.sim.ts   # the committed harness file
```

`simPath` names the committed integration-sim harness for this
implementation (N:1 sharing allowed, like `sourcePath` — one subsystem sim
may cover several components).

### 4.2 Rule family (conformance.ts sibling, warning-severity, completeness-classed)

- `MISSING_INTEGRATION_SIM` — a `complete` implementation of a component
  with ≥1 real L2 dependency declares no `simPath`, IN A SUBSYSTEM THAT HAS
  ADOPTED SIMS (≥1 implementation there declares one — see §4.4). (Leaf
  components with no dependencies are exempt — their unit suite IS their
  sim.)
- `SIM_FILE_MISSING` — the declared `simPath` resolves to no file
  (containment-checked inside the project root, like `sourcePath`).
- `UNWIRED_INTEGRATION_SIM` — the sim file exists but its import graph
  (source-analysis adapter, exact grade) does not reach BOTH the component's
  own `sourcePath` module and at least one `sourcePath` module of each
  direct `dependsOn`/`owns` component — i.e. the harness does not actually
  wire the real implementations. Technology-boundary adapters (L4
  `technologies` declared) are exempt from the reach requirement.
- `SIM_PATH_UNCOVERED` (stretch, later) — narrative `branch`/`throw` paths
  with no corresponding sim anchor. Needs a convention for path markers in
  the harness (e.g. string anchors naming narrative step outcomes) before it
  can be honest; do not ship a guess.

What this proves — and all it proves: a committed harness exists, imports
the real modules on both sides, and is therefore RUNNABLE against the real
wiring. Whether it PASSES is CI's job (it is a test file; the ordinary test
run executes it). The finding messages must say exactly that.

### 4.3 Why not "the validator runs the sim"

Rejected: the validator is deterministic, I/O-light, and runs inside
editors/MCP hosts; executing arbitrary project code from validation would
break determinism, security posture (hosted multi-tenant validation runs),
and the zero-dependency stance. The split "validator proves wiring, CI
proves execution" keeps every promise honest.

### 4.4 Migration

New codes arrive as warnings (the standard new-check policy) and are
`lint.allow`-suppressible per spec. Projects opt into strictness via
`rules.sddRuleSeverity` once their sims exist. Adoption is mechanical and
subsystem-scoped: declaring the FIRST `simPath` in a subsystem activates
MISSING_INTEGRATION_SIM for that subsystem's other complete non-leaf
implementations — declaring a sim is the declaration of intent, and the rule
holds the subsystem to it. wairon's own tree adopts sims
subsystem-by-subsystem, starting with sdd_validator (whose real-registry
validation suite already IS an integration sim — it becomes the first
declared `simPath`).
