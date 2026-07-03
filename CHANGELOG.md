# Changelog

## Unreleased (0.2.0)

A large correctness + capability release. **No CLI commands, MCP tools, spec
schema fields, or library APIs were removed or renamed** — everything below is
additive or a bug fix. The one compatibility surface to review before
upgrading a CI pipeline is the conformance gate (see *Compatibility &
migration*).

### Conformance gate (the architecture linter)

- The validator is now a **rule registry**: 16 documented rule modules under
  `src/core/rules/`, inspectable via the new **`wairon rules list`** (codes,
  default severities, per-project overrides), plus any extension-pack rules.
- **New rules:**
  - `MUTUAL_SUBSYSTEM_DEPENDENCY` *(warning)* — two subsystems depending on
    each other must be acknowledged with a `trustedLinks` declaration on
    either side (see below); otherwise the mutual coupling is flagged.
  - `INVALID_TRUSTED_LINK` *(error)* / `UNUSED_TRUSTED_LINK` *(warning)* —
    trusted links must name real peers and correspond to an actual
    cross-subsystem dependency.
  - `GOD_COMPONENT` *(warning)* — `dependsOn` fan-out above 8 suggests a
    split or a pattern facade.
  - `LANGUAGE_FOREIGN_BUILTIN` *(warning)* — with a declared
    `targetLanguage`, signatures using another language family's unambiguous
    builtins (e.g. `Vec`/`usize` in a TypeScript system) are flagged.
    Opt-in: only fires when `targetLanguage` is set.
- **Bug fixes with visible effect:** the unused-detection walk now covers ALL
  interfaces of a component and handles namespaced (subproject) component ids
  — previously invisible unused components/methods may now be reported
  (true positives).

### Spec schema (additive)

- `targetLanguage` on L0 (system default) and L1 (subsystem override).
- `trustedLinks: [{ subsystem, reason }]` on L1 — explicitly sanctioned tight
  couplings ("fast lanes"), turning architectural exceptions into reviewable
  spec.
- Structured method **`params: [{ name, type, description?, optional? }]`**
  on L3 methods — when present they are the AUTHORITATIVE source for
  type-reference validation and the free-form `signature` string is never
  heuristically parsed. Strongly recommended for new specs.

### Narrative control flow + the detail dial (L5)

- **Flow steps**: narratives stay a FLAT ordered list (order mimics the code
  lines) and gain 7 step types that jump by step number — `branch` (if/else),
  `switch`, `loop` (`loopKind: forEach | for | while | doWhile`), `try`
  (`catches` + `finallyStep`), `jump` (break/continue/rejoin), `return`,
  `throw`. Every existing narrative is already valid (linear = jump-free);
  older wairon binaries reject the new step types, so upgrade before adopting.
- **New rules**: `MALFORMED_FLOW_STEP` / `INVALID_STEP_JUMP` /
  `REGION_OVERLAP` *(error)* and `UNREACHABLE_STEP` / `JUMP_INTO_REGION` /
  `FALLTHROUGH_INTO_HANDLER` / `BACKWARD_JUMP` *(warning)* enforce
  structural soundness: regions must nest or be disjoint and are entered
  through their header, try bodies must not fall through into their own
  handlers, and backward jumps are only idiomatic as a continue to an
  enclosing loop header.
- **`LANGUAGE_FOREIGN_FLOW`** *(warning, requires `targetLanguage`)* —
  narrative flow constructs the target language lacks are flagged
  (try/throw in Rust, Go, C; do-while in Rust, Go, Python), with the
  idiomatic re-modeling suggested.
- **`sdd_update_spec` relocation**: narrative inserts/deletes renumber steps
  AND relocate every jump field automatically; deleting a jump target is
  rejected naming the referrers.
- **Narrative detail dial**: `detail: full | calls-only | intent` per method
  (or L4 spec-level default); omitted = stereotype default
  (Portal/Observer/Adapter → calls-only, Store/Index/Registry → intent,
  logic components → full). `intent` methods specify behavior as an `intent`
  paragraph instead of steps. `MISSING_NARRATIVE` / `INTENT_FLOOR` hold each
  method to its declared (or defaulted) level — explicit declarations as
  errors, stereotype-defaulted gaps as warnings. Unused-detection falls back
  to L2 edges for intent-level methods so collaborators don't false-positive
  as unused.
- **Renderers**: the canvas narrative modal draws real flowcharts (diamonds
  with labeled true/false/case edges, loop back-edges, dashed error edges,
  return/throw terminators, region indentation) with a **"Hide error paths"**
  toggle; Mermaid sequence diagrams render `loop`/`try` as native
  `loop`/`critical` fragments and other flow steps as annotated markers.

### Spec engine

- **SpecWorkspace**: all spec-tree state (index cache, loader issues) lives on
  per-project-root workspace instances; nested subproject resolution no longer
  mutates a global project root (the historical source of namespacing bugs).
- **Schema-validated writes**: every spec save is Zod-validated first — a
  malformed `sdd_update_spec` delta now fails loudly instead of writing a
  corrupt file.
- **Freshness**: a long-running MCP server now notices external YAML edits
  (mtime-signature cache check, throttled to 2s).
- **Explicit status demotion**: `sdd_update_spec` with an explicit `status`
  can reopen a completed spec; re-adds still cannot silently demote.
- **Endpoint updates**: an explicitly changed endpoint via `sdd_update_spec`
  now wins (previously the stored endpoint silently overwrote it).

### Diagrams & visualization (new)

- **`wairon diagram`** — Mermaid component diagrams (subsystem subgraphs,
  boundary-hop edges, `owns` containment, public-surface marking) and L5
  narrative → sequence diagrams; `--all` writes the full living-doc set.
- **`wairon diagram --canvas`** — interactive single-page HTML canvas
  (Cytoscape.js embedded inline; fully offline): collapsible boundaries with
  aggregated "tube" edges, spec-derived detail panel, search,
  validation-issue overlay, locked blueprint layout with crossing
  minimization, "rearrange" toggle, PNG export.
- **`wairon diagram --drawio` / `--excalidraw`** — editable exports in open
  formats with the same computed layout.
- **Canvas 2.0**: SYW / light themes, redesigned toolbar, view levels
  (System / Components / Full), presentation mode, per-browser layout
  persistence with reset, search dims edges along with nodes, sidebar with
  collapsible sections, hover-highlighting from references, narrative
  flowchart modal (call drill-down with back navigation, PNG export), and an
  Export menu (PNG / draw.io / Excalidraw) that uses the CURRENT — possibly
  rearranged — positions. `--format <fmt>` flag added.
- **Scoped C4-style navigation**: every canvas view renders exactly one
  scope's direct children — System → top-level subsystems → a subsystem's
  children (nested subsystems + components) → a pattern's members,
  infinitely deep by ownership. Double-click (or "Open as view") drills in;
  the breadcrumb navigates back. "Internals" previews each child's own
  children inside its box; "Externals" shows out-of-scope dependencies as
  ghost references (double-click a ghost jumps to it). Layout
  rearrangements persist per view; exports capture the current view.
- **CLI behavior change**: bare `wairon diagram` now writes the interactive
  canvas (the primary format); Mermaid moved behind `--format mermaid` /
  `--subsystem` and writes a file instead of printing to stdout (use a
  `.mmd` `--out` for raw Mermaid).

### Technology boundaries (L4 `technologies`)

- An external technology is abstracted as a component: an Adapter behind an
  intent interface (inside a Repository/Gateway). The L4 of that component
  declares the binding — `technologies: [mysql]` — and the ownership tree
  becomes the technology's home. New warning-severity, `lint.allow`-able
  rules police the declaration (no hardcoded vendor lists — only declared
  tokens are checked):
  - **`TECH_LEAKAGE`** — the token referenced in any spec outside the owning
    boundary (prose, ids, `dependsOn` facade bypasses, vendor-shaped types
    in the shared type space).
  - **`VENDOR_NAME_IN_CONTRACT`** — the token in ANY L3 identifier surface
    (method names, signatures, params, endpoints), including the owning
    adapter's own contract: the L3 is the swap seam.
  - **`TECH_ON_LOGIC_COMPONENT`** — technology bound outside
    Adapter/Store/Registry/Index suggests a missing Adapter wrapper.
  This is also the spec-side hook for future code↔spec conformance checking
  (the same declaration later gates actual imports).

### Extension packs (`extensions.packs`)

- Wairon is now a **profile enforcer with a plugin surface**: platform-
  specific profiles and rules are injected from outside — a wrapper tool
  (e.g. an automation-platform SDD product) layers its doctrine on wairon
  without forking it, and wairon core never learns about the platform.
- `.wai/project.yaml` gains `extensions: { packs: [...] }` — each entry a
  relative **declarative YAML pack** (custom profiles: `family` +
  forbidden/discouraged stereotypes with reasons; language/platform tables:
  unsupported flow constructs with remodeling guidance, foreign builtin
  markers) or a requireable **programmatic JS pack** (the same data plus
  `rules: SddRule[]` written against the now-exported rule API). CLI and
  MCP load packs identically, so `sdd_validate_tree` enforces injected
  rules; pack rule codes work with `lint.allow` and `rules.sddRuleSeverity`
  unchanged; `wairon rules list` shows pack rules tagged with their pack.
  A broken pack is an **`EXTENSION_LOAD_ERROR`** (error), never a silent
  skip.
- **Profiles are open**: L1 `profile` and `projectType` accept
  pack-registered names; unregistered names get **`UNKNOWN_PROFILE`**
  *(warning)*. Pack profiles enforce **`PROFILE_FORBIDDEN_STEREOTYPE`**
  *(error)* / **`PROFILE_DISCOURAGED_STEREOTYPE`** *(warning)*.
- The narrative **flow algebra stays closed** (packs can gate and re-label
  constructs, never inject step kinds — reachability analysis and jump
  relocation depend on a closed successor semantics). The
  `LANGUAGE_FOREIGN_FLOW` gate now covers the full construct keyspace
  (branch/switch/forEach/for/while/doWhile/try/throw/jump), so a pack can
  mark e.g. `forEach` unsupported on its platform with guidance.
- Design record: `docs/design/technology-boundaries-and-extensibility.md`.

### Per-spec lint suppression — `lint.allow`

- Any L1–L4 or type spec may declare
  `lint: { allow: [{ code, reason }] }` — wairon's `#[allow(...)]`: the
  named WARNING code is silenced **on that spec only**, with the reason in
  reviewable spec (same philosophy as `trustedLinks`). Error-severity
  findings are never locally suppressible (a human can still re-tune codes
  globally via `rules.sddRuleSeverity`). `UNKNOWN_LINT_ALLOW_CODE` /
  `UNUSED_LINT_ALLOW` *(warning)* keep suppressions honest: typo'd codes
  and allows that no longer match anything are flagged.

### Types & ERD

- **`HOLLOW_TYPE`** *(warning)* — a type with no fields and no methods is a
  placeholder that informs neither implementers nor the ERD; fill it or
  delete it.
- **Canvas Types view is a real logical ERD now**: boxes render as
  UML-style tables (header, divider, `field?: type` rows sized to content,
  intrinsic methods), reference edges carry **multiplicity** derived from
  the field shape (`LineItem[]` → `*`, optional → `0..1`, plain → `1`) as a
  target-end label, and types group into per-subsystem containers (shared
  system-level types in their own box) — ready for large trees.

### Testing & tooling

- End-to-end MCP stdio integration tests (spawn the real server, drive the
  full `sdd_*` authoring pipeline).
- Skills/standards/README/init text updated to the canonical dot-prefixed
  spec layout (`.index.yaml` / `.interface.yaml` / `.implementation.yaml`);
  legacy names still load and `wairon doctor --fix` migrates them.
- Dead `lint` npm script removed (eslint was never configured); vitest 4.

### Compatibility & migration

**Who is affected:** only projects running **`wairon validate --ci`**
(warnings-as-errors) in a pipeline. Plain `wairon validate` is unaffected —
all new rules default to *warning* severity (except `INVALID_TRUSTED_LINK`,
which requires the new field to exist at all).

After upgrading, run `wairon validate` locally and review new warnings:

1. **`MUTUAL_SUBSYSTEM_DEPENDENCY`** — if the mutual coupling is intentional
   (e.g. a latency fast lane bypassing the bus), declare it on either
   subsystem and it becomes sanctioned:

   ```yaml
   trustedLinks:
     - subsystem: runtime-runners
       reason: runtime dispatch latency — bus round-trip too slow
   ```

   Otherwise break one direction (usually via events over the bus).
2. **`GOD_COMPONENT`** — split the workflow or group cohesive collaborators
   behind a Repository/Gateway facade.
3. **New `UNUSED_COMPONENT`/`UNUSED_METHOD` findings** — these were always
   true; the walk previously missed multi-interface components and
   namespaced ids. Wire the narratives or remove the dead surface.
3b. **`MISSING_NARRATIVE` / `INTENT_FLOOR`** — methods are now held to their
   narrative detail level (stereotype-defaulted gaps are warnings). Either
   write the missing narrative, add substantive `intent`/description prose,
   or declare a lower `detail` level where the stereotype default is wrong.
4. Any rule can be tuned per project in `.wai/project.yaml`:

   ```yaml
   rules:
     sddRuleSeverity:
       GOD_COMPONENT: 'off'        # or 'warning' / 'error'
   ```

   Prefer fixing over silencing — the overrides exist for deliberate,
   documented exceptions.

Also note: spec files are canonicalized on their next save (schema defaults
like `trustedLinks: []` are materialized), which produces one-time YAML diff
churn per file. No action needed.

## 0.1.x

Initial development series: SDD spec tree (L0–L5), conformance validation,
spec-derived agent topology, SDD skills, MCP server, subsystem chaining,
self-update with release channels.
