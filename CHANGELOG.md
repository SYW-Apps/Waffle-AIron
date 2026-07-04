# Changelog

## Unreleased (0.2.0)

A large correctness + capability release. **No CLI commands, MCP tools, spec
schema fields, or library APIs were removed or renamed** — everything below is
additive or a bug fix. The one compatibility surface to review before
upgrading a CI pipeline is the conformance gate (see *Compatibility &
migration*).

### Hosting server (self-hosted)

- **`wairon serve`** — run wairon as an HTTP server that hosts many
  **fully-isolated** projects behind one endpoint (the new `sdd_host` subsystem):
  a public **data plane** (`POST /mcp` — the `sdd_*` tools over streamable HTTP,
  scoped per request to the authenticated project) and an admin **control
  plane**, plus `/healthz` + `/readyz`. Each request binds its project root via
  `AsyncLocalStorage`, reusing the core/validation/MCP layers unchanged. `sdd_mcp`
  is untouched.
- **Auth** (default-on; `--no-auth` for trusted networks): a master credential
  (`WAIRON_ADMIN_TOKEN`) gates the control plane; project API keys are minted per
  project/role and stored hashed. Scope is derived from the token, never from a
  client-supplied parameter.
- **`wairon host …`** (in-process, no running server needed — works over SSH /
  `docker exec`): `project create|list|destroy`, `key mint|list|revoke`, and the
  commit-scoped **`lock`** / **`promote`**.
- **State-scoped lock/promote:** `lock` validates the tree as-complete and writes
  `.wai/lock.json` scoped to a deterministic `StateId`; `promote` recomputes the
  `StateId` and refuses on any drift — never merges to production.
- **Docker:** `Dockerfile` + `docker-compose.yml` at the repo root; state on a
  `/data` volume. See
  [docs/design/hosted-mcp-server.md](docs/design/hosted-mcp-server.md).
- New library surfaces: `validateAsComplete` (full-strictness gate, reused by the
  local `wairon lock` story) and a request-scoped project root
  (`runWithProjectRoot`) so one process serves concurrent projects safely.
- **Diagrams over the admin API** — the diagram engine is now a first-class
  `diagram_specialist`; the hosting server generates/downloads a project's canvas,
  Mermaid, draw.io, or Excalidraw on demand, and serves the interactive canvas to
  a browser via a short-lived HMAC-**signed** `/view/diagram` link (no bearer —
  the capability is in the URL), with generate/download bearer-authed.
- **Producers** (`sdd_producers`) — project a spec tree into an external target as
  a one-way, idempotent subsection. Two producers ship, both raw REST with **no new
  dependency**, and both usable **hosted** (`wairon host producer …`,
  `/admin/projects/{id}/producers/*`) and **locally** (`wairon produce <target> --page <id>`,
  credential from flag/env/prompt):
  - **Notion** — a "wairon specs" page subtree whose pages carry each component's
    methods + a Mermaid diagram (target-agnostic `DocPage` model).
  - **Miro** — the architecture graph rendered onto a board as native shapes +
    connectors inside a `wairon architecture` frame (target-agnostic `GraphModel`;
    `--page` is the board id). Idempotent: the frame is cleared and rebuilt, the
    rest of the board untouched.
- **Runtime secret store** — integration tokens (git, Notion, Miro, signing)
  resolve data-dir store → env, and `wairon host secret set` / `PUT /admin/secrets/{key}`
  set them at runtime, so an integration can be added to a live container without a
  restart.
- **Git-backed projects** (`sdd_git`) — a hosted project can relocate its source
  of truth to a git repo (`wairon host git enable --remote …`, or
  `POST /admin/projects/{id}/git`): the container clones it, works on an isolated
  `wairon/work` branch, and `lock` becomes git-aware — sync → validate-as-complete
  → promote → **commit + push the working branch**, recording the commit SHA and a
  compare URL for a human to open the PR (push-only, one `WAIRON_GIT_TOKEN` bot
  identity, sync on-demand + auto-before-lock). `promote` still refuses a stale
  lock and never merges. The Docker image now ships with `git`.
- **Extension packs in a hosted container** (`sdd_host` → `pack_orchestrator` +
  `pack_registry`) — install architectural profiles and language/platform tables
  into a running container without shell access, at **server-global** scope
  (`GET/PUT/DELETE /admin/packs/{name}`, or `wairon host packs …`) or into one
  **project** (`GET/PUT/DELETE /admin/projects/{id}/packs/{name}`, committed with
  the project so every clone and CI enforce it). Installs over the admin surface
  are **declarative-only** (pure data — profiles + language tables); programmatic
  **rule/code** packs are refused there and install via the trusted filesystem (a
  mounted `WAIRON_PACKS_DIR` volume or `wairon packs add`), which the API still
  *lists*. Server-global packs now live on the data volume (`WAIRON_PACKS_DIR`
  defaults to `$WAIRON_DATA_DIR/packs`) so they **persist across container
  recreation** — previously a machine-wide install landed in an ephemeral home dir.

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
- **Canvas readability fixes**: (a) with nothing selected, the sidebar now
  describes the **current view scope** (the subsystem/component you drilled
  into) instead of always the root system — the breadcrumb still walks up to
  the parent; (b) **focus mode** — selecting any box lifts its own edges above
  everything and recolours them **by direction** (outgoing "depends on →" vs
  incoming "← used by") while unrelated elements recede, so one block's relations
  and their direction read clearly in a busy graph; (c) the **Types ERD degrades
  gracefully on huge systems** — above ~400 in-scope types it renders a
  subsystem-cluster overview (double-click a cluster to open it), above ~120 it
  falls back to header-only boxes, with a banner and a "render full detail
  anyway" override — so a 1000+-type system stays interactive yet fully
  navigable; (d) **breadcrumbs preserve the active mode** — walking up from a
  subsystem's ERD now lands on the *parent's types* (not its components), so you
  can climb from a subsystem's types all the way to the system-wide ERD; the
  Components/Types toggle stays the explicit way to switch mode.
- **Layout picker** — a **Layout ▾** menu lets you switch the auto-layout instead
  of being stuck with the dependency-column heuristic (which stacked leaves under
  unrelated components and turned the ERD into one giant vertical ladder):
  **Layered** (the original columns), **Force** (physics relaxation seeded from
  the layered positions — untangles crossings, places nodes near their
  connections), **Concentric** (most-referenced in the centre, rings outward),
  and **Grid** (compact wrapped rows). Force uses cytoscape's built-in `cose`
  tuned for the large box sizes (accounts for node dimensions, high repulsion /
  long ideal edges) so nodes spread instead of overlapping; Concentric and Grid
  are size-aware presets computed for both the component view and the ERD —
  Concentric derives each ring's radius from the nodes it holds (compact, not
  sprawling) and only centres a *lone* most-referenced node, spreading a tied top
  tier into a ring rather than a central pile. The choice persists, is remembered
  per view, and a manual **Rearrange** still wins on top for fine-tuning.
  External (ghost) nodes are placed just outside the *actual* node bounds rather
  than at fixed offsets, so a centred layout never drops one in the middle of the
  graph; and **Internals** now lay each box's children out with the same chosen
  layout (Grid/Concentric) instead of always the layered columns.

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
- **`wairon packs add | list | remove`** — first-class pack installation.
  `add <source>` vendors a pack (file or directory with a `pack.yaml` /
  `pack.cjs` entry) into `.wai/packs/` and registers it in project.yaml
  (committed → CI and every clone enforce it); `add --global` installs
  machine-wide into `WAIRON_PACKS_DIR` / `~/.wairon/packs`, auto-loaded for
  every project (project packs win on collision; opt out via
  `extensions.useGlobalPacks: false`). `remove <name>` is the uninstall.
  **`wairon init --pack <source>`** applies doctrine at project birth.
- **Distribution needs no npm**: wrapper products ship a release ZIP (pack
  files + an install script that runs `wairon packs add`) on top of the
  standalone wairon binaries — see the ZIP recipe in
  `docs/extending-wairon.md`.
- The narrative **flow algebra stays closed** (packs can gate and re-label
  constructs, never inject step kinds — reachability analysis and jump
  relocation depend on a closed successor semantics). The
  `LANGUAGE_FOREIGN_FLOW` gate now covers the full construct keyspace
  (branch/switch/forEach/for/while/doWhile/try/throw/jump), so a pack can
  mark e.g. `forEach` unsupported on its platform with guidance.
- **Wrapper-product template**: `examples/wrapper/` — packs (custom profile
  + language table + injected rule), the installer such a product ships
  (`install.js` → `wairon packs add`), an advanced library-embedding demo,
  and a CI-clean **spec-only** demo project (implementation lives on the
  platform; `requireOwnedPaths: false`) — guarded by a golden test so the
  example cannot rot. Full reference: `docs/extending-wairon.md`.
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
