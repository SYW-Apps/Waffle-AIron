# Code↔Spec Conformance

*Design record — 2026-07-11. Levels 1 and 2 shipped (commits `45ace22`, `491f764`); Level 3 is a research sketch, deliberately not implemented.*

## Why

The spec tree is only a contract if something enforces it against the code. Before this
pillar, "does the code match the specs?" was a manual sweep — the tree could name files
that no longer exist, contracts could claim methods the code never grew, and a component
could quietly import a sibling subsystem's internals with no declared edge. Conformance
turns each of those into an ordinary `ValidationIssue` through the existing rule registry,
so the CLI, the `--ci` gate, the canvas overlay, and the web UI's findings rendering all
pick them up with zero extra wiring.

The pillar is staged by how much the checker must understand the code:

| Level | Question | Machinery | Status |
|---|---|---|---|
| 1 — structural | Do the files exist, and are the contract methods realized in them? | name anchors | shipped |
| 2 — dependency | Does the import graph match `dependsOn`/`owns`? | import edges | shipped |
| 3 — behavioral | Do the L5 narrative steps match the actual call graph? | symbol resolution | sketch (below) |

## Architecture

One new component, `source_analysis_adapter` (Adapter, `sdd_validator`) — the subsystem's
only source-code I/O. `validateSddTree` calls `buildCodeModel(implementations, projectRoot)`
right next to `loadSurfaceSnapshots()` and injects the result into the rule context; the
conformance rules (`rules/conformance.ts`, `rules/dependency-conformance.ts`) consume it
purely. Rules never touch the filesystem — the same injection seam as surface snapshots.

The `CodeModel` is one `SourceFileFacts` per **distinct** sourcePath (N:1 sharing is native:
many implementations legitimately map to one file). Each facts entry carries a `status`
(`analyzed | missing | escaped | unreadable` — sourcePaths are containment-checked against
the project root, mirroring the projectPath chaining rule), the anchor sets described
below, exported names, runtime import specifiers, and re-export specifiers.

### Tiered analyzers — zero mandatory dependencies

wairon must analyze any language while staying lean, so analysis is tiered and the grade
is recorded per file and carried onto every finding message:

1. **exact** — full AST for TS/JS via the TypeScript compiler, resolved **dynamically**:
   the analyzed project's `node_modules` first, wairon's own installation second, never
   bundled. Chases `export *` barrels through relative specifiers so a pure re-export
   portal file realizes the names it publishes.
2. **pattern** — declarative per-language declaration/import/comment tables (12 built-in
   languages; extension packs can register more, or programmatic packs can provide exact
   analyzers).
3. **generic** — a word-boundary identifier scan, the universal floor. Weakest, but "the
   name still appears in the file" remains an honest drift check when nothing better exists.

A hosted checkout without `node_modules` degrades to pattern grade instead of losing
conformance; a single file's parse failure degrades that file, never the run.

## Level 1 — structural conformance

Codes (all completeness-classed — draft specs downgrade and are `--ci`-waived):

- `MISSING_SOURCE_FILE` (error), `SOURCE_PATH_ESCAPES_ROOT` (error)
- `UNREALIZED_METHOD`, `MISSING_SOURCE_PATH`, `CONFORMANCE_ANALYSIS_SKIPPED` (warnings)

**"Realized" is tiered** (the conformance dial, mirroring the narrative detail dial —
spec-level default plus per-method override on the L4):

- `declared` — the method name must be a declaration-tier anchor: a named declaration at
  any nesting depth, a destructuring binding, an object-literal key, an import binding,
  or an export specifier (barrels resolved). The default for every stereotype but Portal.
- `anchored` — additionally accepts exact string-literal occurrences (tool/route
  registrations) and property-access references (`specs.loadComponentSpecs()` — forwarding
  through a namespace). The Portal default.
- `off` — method checks skipped (generated/vendored code); the file-existence check
  always applies.

**Intent-language renames** get an explicit per-method `symbol:` mapping (`put` realized
by `saveSnapshot`). This is deliberate spec enrichment, not a workaround — the symbol map
is the code-level binding Level 3 will resolve against.

Implementations under chained subsystems (any `projectPath` along the namespace chain)
are skipped: their sourcePaths are relative to the child project's root, and the child
validates them standalone in its own run.

## Level 2 — dependency conformance

Codes: `UNDECLARED_DEPENDENCY`, `UNREALIZED_DEPENDENCY` (warnings, completeness-classed).

Import edges are built **purely**: specifiers resolve string-wise against the closed set
of component-mapped paths (`.js`→`.ts` swaps, index files) — no filesystem probing in
rules. Only exact-grade files participate; pattern-grade import lists are too coarse to
accuse anyone with. Two exclusions happen at collection time in the analyzer:

- **type-only imports** never form an edge (type coupling is allowed by default);
- **export-from specifiers** are collected separately as `reexports` — republication is
  not collaboration, so a barrel is never accused, but a re-export *does realize* a
  declared forwarding edge (a portal barrel republishing its orchestrator).

An import edge `F → G` is **justified** when any component pair across the two files has:

1. a direct `dependsOn`/`owns` edge,
2. a shared component (one component, several files),
3. a facade hop (the target is a member of a pattern the importer depends on),
4. the **reverse** declared edge within the same subsystem — mutual wiring collapsed to
   one file direction (a portal declares it mounts onto the server; the server file
   physically imports the portal's file to dispatch inward), or
5. across subsystems: a declared edge to the target subsystem's **published surface**.
   In-process imports may land on the subsystem's concrete modules — the published-portal
   declaration is the sanctioned hop, and its barrel is cosmetic at runtime. Importing a
   subsystem you declared *no* edge to is the real violation.

`UNREALIZED_DEPENDENCY` is the inverse: a declared edge between components realized in
different files with no import trace (forward, re-export, or same-subsystem reverse; for
a cross-subsystem portal edge, any import landing in the target subsystem counts).
Dependency-injection indirection can defeat this legitimately, which is why it stays a
warning.

## What dogfooding proved (131 + 51 findings → 0, honestly)

The acceptance test was wairon's own tree with the rules ON. Highlights of what the rules
*caught* — none of these were known beforehand:

- The core portal barrel didn't republish `provision/diagram/lockfile/statehash` — the
  portal's contract claimed methods its file never exported (fixed in code).
- Two sourcePaths pointed at the wrong realizing file (`admin_portal` routes in `http.ts`,
  `cli_core_adapter` realizes in `subsystem.ts`).
- Shared transport helpers (`sendJson`/`bearerToken`) lived inside the request
  orchestrator's file, physically coupling six route modules to it (extracted to
  `httpio.ts`); error classes were imported through re-export sites instead of
  `errors.ts`; the CLI imported commands through a barrel, hiding its adapter edges.
- Seven real collaborations existed in code but not in the spec — most notably
  `scope_specialist → organization_repository`: the code has `resolveScopeFor` gathering
  org data itself, while the Phase-6 orchestrator narratives still claim the orchestrators
  gather it. The edge is now declared and the discrepancy documented in `lint.allow`
  reasons — it is the ready-made first test case for Level 3.
- ~100 `symbol` mappings now record the intent-language → code-name bindings, and 9
  `lint.allow` entries document deliberate exceptions with reasons (e.g. the shared
  secrets utility being spec-homed under `sdd_host` — placement debt, not sanction).

## Hardening from the post-ship review (2026-07-12)

An adversarial review plus live e2e testing produced five fixes: (1) degraded
TS/JS analysis (compiler unresolvable — the normal state for npm installs of
wairon analyzing projects without their own `typescript`) is now surfaced as
one `CONFORMANCE_DEGRADED` warning per run instead of silently skipping
dependency conformance; (2) the C#/Java declaration patterns were rewritten
with same-line separators and pattern analysis is size-capped (1MB → generic
scan) after a verified quadratic blowup on generated files; (3) failed
compiler resolutions are retried after 30s in long-running processes;
(4) facade-hop justification is now symmetric (an owned Store may import what
its Repository declared; same-pattern siblings collaborate by construction);
(5) the same-subsystem reverse-edge justification is restricted to mounting
shapes (Portal/Observer declarers) so a Store importing its consumer stays a
violation. sourcePath keys are normalized (backslash-authored paths merge
into one facts entry).

## Known limitations (accepted, documented)

- **Chained subprojects** are skipped in the parent run (they validate standalone).
- **DI indirection** produces false `UNREALIZED_DEPENDENCY` positives — warning severity
  and `lint.allow` are the pressure valves until Level 3 resolves real call paths.
- **tsconfig path aliases** are not resolved (relative specifiers only). Alias-heavy
  projects under-report edges; support is a straightforward extension when needed.
- **Unmapped intermediary files** (a barrel that is no component's sourcePath) hide the
  edges flowing through them. Guidance: import concrete modules directly, as the CLI now
  does; transitive resolution through unmapped files is a possible later extension.
- **N:1 union semantics**: in a shared file, an anchor satisfies every component that
  declares that method name, and an edge is justified if *any* component pair covers it.
  Coarse by design — under-reports rather than false-accuses. Level 3 disambiguates.
- **Symlink containment**: sourcePath containment is textual; a symlinked directory
  inside the project pointing outside the root would bypass it (deliberate setup,
  not a drive-by risk).
- **Hosted render-path cost**: the canvas issue overlay invokes the full validate
  (including the source scan) on every hosted canvas render — bounded by the 1MB
  pattern cap, but a `sourceAnalysis` opt-out on ValidationOptions is the natural
  knob if hosted profiling ever demands it.

## Level 3 — call-graph ↔ L5 narrative steps (sketch only)

**Goal.** For a contract method realized at a known symbol, extract the function's actual
call graph and compare it against the narrative's `call`/`dispatch` steps: every narrative
call should appear in the body (unrealized choreography), and calls into other components'
methods that the narrative never mentions are undeclared choreography. This is where the
`calls-only` narrative floor becomes *checkable* rather than aspirational.

**Machinery required (why this is a separate effort).**

- A `ts.Program` with module resolution and a type checker — no longer parse-only. Cost,
  caching, and the zero-dependency posture all need revisiting (likely: exact-grade-only,
  explicitly opt-in, possibly a separate slower verb or `--deep` flag feeding the same
  issue channel).
- **Symbol→component resolution**: a call expression's callee must resolve through
  imports, re-exports, destructured `require` wrappers, and the per-method `symbol` maps
  (already recorded by Level 1) back to a (component, method) pair via the sourcePath map.
- **Indirection**: DI containers, callbacks, higher-order registration (`server.tool(name,
  handler)`) break static callee resolution. `dispatch` steps help — the capability string
  in the narrative can be matched against string arguments at call sites (the dispatch
  tables and tool-name symbol maps are already machine-readable).
- **Matching semantics**: start order-insensitive (set comparison of called component
  methods vs narrative call steps), per-method opt-in via a third dial tier (e.g.
  `conformance: choreography`). Order/flow matching against branch/loop structure is a
  research problem on its own — decompilation-shaped, same reason Mermaid block
  reconstruction was deliberately not attempted.

**Fuel already in place**: per-method `symbol` bindings, Portal dispatch tables with
capability strings, `SourceFileFacts` imports/exports/reexports, and one known
ground-truth discrepancy (the scope_specialist org-gathering case) to validate the
checker against before trusting it anywhere else.

**Staged research plan**: (1) spike `ts.Program` cost on wairon itself and define the
caching story; (2) callee resolution for the three realization styles observed in this
codebase (flat exported functions, closure registrations, destructured forwarding);
(3) set-comparison checker behind an opt-in dial, dogfooded on `sdd_validator` only;
(4) decide severity/rollout after measuring false-positive rate; order-sensitivity
deferred until the set checker earns trust.
