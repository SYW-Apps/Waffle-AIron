# Changelog

## Unreleased (from v5.1.0)

**Breaking.** Merge dev → main with `[major]` in the merge commit message →
**v6.0.0**. Three changes are visible on upgrade without any action by the user,
and each needs one (see *Upgrading* below): machine-wide packs no longer apply to
a project that has not declared them, existing lock records read as stale, and a
project referencing a global pack's profile can newly fail `validate --ci`. Nothing
here is purely additive, so `[minor]` would understate it.

### Rule-matrix test tier: every finding code pinned by fire+control fixtures

The validator can emit ~160 distinct finding codes; the rule tests covered some
of them, and nothing noticed when a rule shipped without any. The new
`tests/rules-matrix/` tier makes that coverage self-enforcing.

- **Fixture contract** — `defineRuleFixture({ code, severity?, anchoredTo?,
  scenario, tree, expectFire })`: each code gets a TRIGGERING fixture and a
  near-identical CONTROL that must stay quiet for that code (a control only
  guarantees its own code's silence — other codes may fire). Trees are
  declarative miniature systems with realistic domain names, materialized as
  real temp `.wai` projects and validated through `validateSddTree()` — the
  same loader → schema → composed-rule-sequence path the CLI, MCP server, and
  hosted gate run, so a rule starved by the loader fails here too. Family
  files under `tests/rules-matrix/families/` are auto-collected; there is no
  central manifest to conflict on.
- **The ratchet** — `meta.test.ts` diffs the real `knownIssueCodes` universe
  (test pack included, so namespaced `<PACK>_<CODE>` assertion codes are
  enforced on the same terms) against the collected fixtures; `ratchet.json`
  lists the not-yet-covered debt explicitly and only shrinks. A new code with
  no fixture and no entry, a stale entry for a now-covered code, or an
  unsorted/unknown entry each turn CI red — so every new rule needs fixtures
  immediately, and deleting coverage means growing a file a reviewer reads.
- **Pack composition proven** — a small declarative test pack
  (`ledger-platform`) contributes a forbid-edge assertion and a guarantee
  token; fixtures pin that its namespaced code fires and can be satisfied, and
  that a pack-declared guarantee token is accepted while an undeclared one
  still flags `UNKNOWN_GUARANTEE`.
- **Coverage floors** — `vitest.config.ts` now carries `coverage.thresholds`:
  a global floor just under the measured baseline plus a higher floor for
  `src/core/rules/**` (measured separately — vitest excludes glob-matched
  files from the global pool). The floors move deliberately, by humans; no
  `autoUpdate`. Thresholds apply to `npm run test:coverage` only — plain
  `npm test` stays coverage-free.

### Black-box e2e tier: agent journeys against the built artifact

Two incidents this week shared a blind spot: a long-lived MCP server running an
older `dist/` silently stripped newly-added schema fields on write, and an older
CLI binary rejected spec trees using new vocabulary. Both were invisible to the
unit suite, which imports `src/` directly and never runs what actually ships.
The new `tests/e2e/` tier closes that gap by testing the BUILT artifact as a
subprocess.

- **Agent journeys over real MCP stdio** — each suite spawns
  `node dist/cli/index.js mcp serve` against a scratch project and drives it
  with the official SDK client: the full authoring flow (system → subsystem →
  components → interfaces → narratives → validate → status → live agent brief),
  the declared-entrypoint regression (`invokedBy` kind + caller and `register`
  steps asserted VERBATIM in the YAML on disk — the stale-server class), and
  agent-mistake journeys proving refusals are clean and leave the tree
  byte-identical.
- **CLI smoke on the journey-built tree** — `validate --ci`, `lock` (asserting
  the `.wai/lock.json` stateId digest), and `agent brief` run through the built
  binary, exactly as a human would.
- **Wiring** — `npm run test:e2e` (own `vitest.e2e.config.ts`, generous
  timeouts, no coverage); the default `npm test` stays unit-scope and excludes
  `tests/e2e/**`. CI runs the e2e tier after Build. The release workflow gained
  a post-publish verify job: in a clean node container it installs the
  just-published `@wairon/cli@<version>` from the registry, asserts
  `wairon --version` prints that version, and completes a JSON-RPC initialize
  handshake against `wairon mcp serve`.

### Pack scoping: installing a pack no longer governs every project on the machine

A pack installed machine-wide used to apply to every project on that machine,
including projects that never mentioned it. The gate, `skills list`, and the MCP
instructions therefore differed per developer, and CI — which has no pack store —
enforced a different rule set than the author's laptop. Installing a pack now makes
it *available*; a project *selects* what it applies.

- **The pack store** — `wairon pack install <source>` puts a pack in this wairon
  install's store (`WAIRON_PACKS_DIR`, else `~/.wairon/packs`), laid out
  `<name>/<version>/` so several versions coexist. `pack uninstall`, and
  `pack which <name>` to see exactly which version, path, content digest, and
  recorded origin a name resolves to. Installing applies to nothing.
- **Per-project selection** — `wairon pack use <name>[@version]` records the pack
  by name in `.wai/project.yaml`. `--pin` freezes the resolved version and its
  digest, `--source <url>` records an explicit fetch URL, `--bundle` marks it for
  committing. `pack unuse` drops the selection and leaves the pack installed.
  Unpinned means "latest installed".
- **A selection carries its own source** — copied from the store's install record
  at selection time, so the project self-describes how a fresh machine or CI runner
  obtains the same doctrine. `wairon pack sync` installs every declared-but-missing
  pack from it; `pack install` accepts a URL. A local-path origin is not fetchable
  and `pack use` says so rather than leaving CI to discover it.
- **Bundling for self-sufficiency** — `wairon pack bundle [name] [--all]` commits a
  copy under `.wai/packs/<name>/<version>/`, which resolves **before** the store, so
  a clone and CI need no store and no network. The answer for private packs and
  air-gapped CI.
- **A declared pack that cannot be resolved is an error**, never a silent skip:
  `validate`, `status`, `lock`, `generate`, and every `sdd_*` MCP call refuse. The
  code names the remedy — `PACK_NOT_INSTALLED` (absent), `PACK_VERSION_UNSATISFIED`
  (installed, but not at the pin — the message lists what *is* installed),
  `PACK_INTEGRITY_MISMATCH` (content off the pinned digest). All error severity, all
  in `wairon rules list` and tunable via `rules.sddRuleSeverity`.
- **A pinned `integrity` is verified on whichever path wins, recomputed from the
  files.** A committed bundle is not exempt — it overrides the store, which makes it
  the most important place to honour a pin, not a place to skip it. The store's
  recorded digest is not trusted as the answer either, since a pack edited in place
  would otherwise satisfy a pin it no longer matches.
- **`PACK_STORE_DRIFT`** (warning) when a bundle and the store hold different
  content for the same `name@version`. The bundle still applies, so this exists to
  explain why an edit to the installed copy had no effect.
- **`applyByDefault: true`** in a pack manifest seeds that pack into new projects at
  `wairon init` — what a machine-wide install *should* mean: a default for projects
  you create from now on, recorded where it is visible, not retroactive authority
  over everything on disk.
- **`rules.enforceReproducibility` now does something.** It has existed since `init`
  started writing it and was read nowhere. It backs `UNPINNED_PACK_SELECTION` and
  `PACK_SOURCE_UNFETCHABLE` — warnings while you work, errors under `--ci` and at
  `lock`. You may develop against a floating pack set; CI will not accept one. A
  bundled selection is exempt: its committed bytes are the pin.
- **`wairon doctor`** reports unresolvable selections, installed-but-unapplied packs,
  and packs applying via an explicit `useGlobalPacks: true`. `doctor --fix` records
  the unapplied set as explicit selections. It never invents selections for a
  project that deliberately applies nothing, distinguishing "never decided" (the
  field absent from the file) from "chose deliberately".
- **`.github/actions/setup-wairon`** — a composite action with `packs: sync | none |
  <explicit list>`, so a cloned repo's CI needs no pack configuration.

### The lock now covers the doctrine that validated the tree

`wairon lock` recorded a hash of the spec tree alone. The pack set — which *is* the
gate — was invisible to it, so you could lock a tree validated under one rule set,
change the packs, and still promote on the strength of the earlier lock because the
spec digest never moved. That is the stale-approval hole the commit-scoped lock
exists to close, entering through the doctrine door.

Implemented as a **second** identity rather than a change to the existing one,
because the same StateId also stamps surface snapshots and drives their freshness
comparison, where doctrine is irrelevant:

- `computeStateId()` — spec tree only. Surface/landscape snapshots, freshness.
- `computeGateStateId()` — tree **+** doctrine projection. `lock`, hosted lock, and
  the promote-time re-check.

The projection covers only what can change a verdict: pack identities, merged
profile and language tables, patterns, guarantee tokens, assertions, and rule
names/codes. Pack `skills` and `instructions` are excluded — prose cannot alter a
verdict, and including it would invalidate every lock on a documentation tweak.

It also covers the **builtin rule registry** (names, codes, default severities) and
the project's own governing configuration (`projectType` and `rules`). So "valid
stays valid unless the rules truly change": a release touching no rule keeps every
lock, one that adds, removes, or re-grades a code invalidates exactly the locks it
should, and a severity override or profile switch counts as the gate change it is.
Keyed on the registry rather than the wairon version deliberately — the version
would churn every lock on every patch. Residual gap, accepted knowingly: a rule
whose *implementation* grows stricter without its name, codes, or default severity
changing is not caught.

### Teaching the connecting agent over MCP

An agent connecting to a wairon MCP server received nothing: `initialize` carried no
`instructions`, there was no prompts capability, and skills were pull-only
resources. Spec-authoring quality depended on whether a human remembered to brief
the agent.

- **`instructions` on `initialize`** — the protocol's own "how to use this server"
  field, which clients inject into the system prompt. Carries the L0→L5 shape, the
  authoring order by tool name, the fact that the `sdd_*` schemas are
  self-describing, the bound project's governing profile, the loaded packs, and the
  directive to read `wairon-skill://sdd-architect` *before* authoring. Short and
  pointer-heavy by design; composed per server construction, so a hosted
  per-request server reports its own project.
- **Packs contribute, wairon owns the default** — `instructions:` in a pack manifest
  is appended under `## From pack "<name>"` in pack load order, optionally scoped to
  the governing profile. A pack states its platform delta; it never restates
  wairon's model, which would drift on every release.
- **Skills as MCP prompts** as well as resources, so clients that surface prompts can
  offer them directly.
- **Pack skills can EXTEND a builtin** — `extends: sdd-implement` appends the pack's
  section to the builtin under `## Platform: <pack>` instead of standing beside it as
  a parallel skill the agent has to notice and reconcile. The builtin stays wairon's,
  so an upgrade still updates it.
- **Variant guidance reaches hosted agents** — `sdd_get_spec` on a variant-tagged
  component returns the resolved guidance and its same-variant siblings as a derived,
  read-only field. Previously it only reached generated agent files.

### Spec authoring: array deltas upsert, and an optional field can be removed

`sdd_update_spec` documented that arrays are "matched by name (or id) and
merged/upserted", with `action: 'delete'` to remove an element. That held for
`methods`, `fields`, `publicInterfaces`, `dispatch`, `lifecycle`, `emits`, and
`subscribesTo` — and was **silently false for every other array**, which fell
through to wholesale replacement. A delta naming ONE element deleted every element
it did not mention:

```
trustedLinks  [x, y] + delta [x]     ->  [x]     (y silently gone)
invariants    [i1,i2] + delta [i1]   ->  [i1]    (i2 silently gone)
lint.allow    [A, B]  + delta [A]    ->  [A]     (B silently gone)
```

The same data loss already fixed once for dispatch tables, still live for six other
fields — destroying authored specs through the sanctioned authoring path.

- **One identity table replaces the per-field special cases**, so the contract is
  true by construction and a future array field inherits upsert semantics instead
  of regressing to destructive replace. Keys: `dispatch` by capability, `lifecycle`
  by phase+component+method, `emits`/`subscribesTo` by topic+event, `trustedLinks`
  by subsystem, `invariants` and `patterns` by id, `lint.allow` by code,
  `boundaries` by name, `globalRequirements` by description, else name or id.
- **`action: 'delete'` now works on all of them** — including a stale `lint.allow`,
  which wairon reports and fails `--ci` on but which the tools previously could not
  remove, dead-ending an agent restricted to the `sdd_*` surface.
- **An explicitly empty array still clears a list.** Under pure upsert semantics it
  would mean "change nothing", leaving no way to empty a keyed list.
- **`unset` removes an optional field**: `{ unset: ['basePath', 'variant'] }`. It
  could previously be set but never cleared — `null`/`undefined` mean "no change",
  and writing `""` leaves the field present and empty, which is a different and
  usually wrong spec. Explicit rather than overloading `null`: a destructive
  meaning must be asked for, not inferred from an absent value.

### Re-authoring a spec no longer erases what the tool cannot express

Every `sdd_add_*` / `sdd_define_*` / `sdd_write_*` tool is an upsert: called with an
id that already exists, it rewrites that spec. Each tool's input schema is a
hand-maintained **subset** of the canonical schema, and the handler rebuilt the spec
from its arguments — so every field the input could not express was erased by a
restatement that never mentioned it, under a `Successfully added` banner:

```
sdd_add_component      lint.allow, ext, auth, variant, patterns, externalLinks
sdd_add_subsystem      lint.allow, ext
sdd_add_type           lint.allow, ext
sdd_initialize_system  databases (hard-reset to []), publicInterfaces, diagram
```

A suppressed warning silently coming back days later was the only tell. The same
loss was fixed once for `sdd_define_interface` and `sdd_write_narrative`; the other
four surfaces were never covered.

- **All six write surfaces now carry forward what they cannot express**, driven by
  each tool's *own* input-schema keys — so a field added to a tool starts being
  replaced, and a field added only to the canonical schema starts being carried,
  with no parallel list to drift. It lives at the tool boundary because only there
  is "the caller cleared this" distinguishable from "the caller never mentioned it";
  the store receives a whole spec and cannot tell those apart.
- **`ext` is carried even though the tools accept it.** It is opaque pack data the
  authoring agent does not own and cannot know to restate, and the schema promises
  it is preserved verbatim. Everything else expressed keeps replace semantics.
- **Removals are stated rather than left to be discovered.** Replace is still the
  contract for what the input *can* say — but a restatement that drops a method or
  empties an array now says so, naming what went:

```
NOTICE:
- Component "graphics" already existed — re-authored in place; this input REPLACES what it expresses.
- Carried forward (not expressible through this tool): createdAt, externalLinks, lint, ext.
- REMOVED by this restatement: method "beta" (endpoint bindings included) — absent from the input…
- CLEARED by omission: dependsOn (had 1) — the argument was not repeated…
```

- **Two automated checks hold the line** (`tests/mcp/schema-field-coverage.test.ts`).
  Against the schemas the server actually publishes over `listTools` — not a copy of
  them — every canonical field must be expressed by its tool, store-managed, derived,
  or explicitly declared `sdd_update_spec`-only *with a reason*; stale declarations
  are flagged too. Then each declared field is populated, the create tool re-run with
  minimal arguments, and required to survive. The narrative **step** schema — the
  largest hand-copied surface, where a missing field is stripped by the MCP SDK
  before the handler runs — is covered the same way.

### A misplaced field is refused at the write, not discovered at validate time

`sdd_add_component` accepted any field on any `componentType` — the write path only
checked the schema, where `portalType`, `basePath`, and `durability` are all
optional. The stereotype rules that reject them live in `sdd_validate_tree`, and two
of their codes (`UNEXPECTED_PORTAL_FIELD`, `DURABILITY_ON_NON_STORE`) are errors that
never relax while draft — correctly, since a misplaced field is wrong *now* rather
than merely incomplete.

The result was a trap rather than a warning. Setting `basePath` on an Orchestrator
succeeded, then failed validation permanently, and before `unset` existed there was
no way to remove the field again: the component was wedged, and recreating it was the
only escape. Agents reported this as *"non-Portal components require Portal-only
arguments"* — the schema never required them; the spec just could not be repaired.

- **Rules now declare their scope.** `scope: 'spec'` marks a rule whose verdict reads
  one spec's own fields and no cross-spec relationship; `'tree'` (the default, so an
  undeclared rule can never leak into the write path) marks one that needs the loaded
  tree. The intrinsic subset runs against a **candidate** spec before it is written.
- **Two rules split along that line**, since each mixed intrinsic and tree checks:
  `portal-fields` (field shape) out of `portal-endpoints` (endpoint bindings), and
  `durability-declaration` (does the declaration belong here) out of
  `durability-round-trip` (hydration reachability). Same codes, same messages, same
  severities — relocated, not rewritten.
- **`sdd_add_component` and `sdd_update_spec` gate on the merged spec**, so an update
  cannot introduce a misplacement either. A refusal names the code and the remedy,
  and nothing reaches disk — the fix is to retry the call, not repair a saved spec.
- **Deliberately not the whole rule set.** A component is legitimately authored
  before its interface, dependencies, and narratives exist, so tree rules would
  reject every correct first step of the authoring order. A draft Portal without its
  `portalType` yet still writes (a warning, as in a tree run); a Portal-only field on
  a Store does not.
- **Mechanical re-saves stay ungated** — status promotion, layout normalization, and
  migrations pass no gate, so a spec that predates a rule remains loadable and
  repairable via `unset`. `rules.sddRuleSeverity` disarms the gate exactly as it
  disarms the same code in `validate`.

### Hosted web UI: custom theme builder (new, `feat/webapp-custom-theme-builder`)

The theme picker's three built-in palettes are now a starting point, not the
menu. A **theme builder** (`/themes`, reached from the header menu's new
"Custom themes" section) lets a user author, duplicate, and delete their own
themes, stored per browser alongside the existing UI settings.

- **Sparse overrides over the derived engine.** wairon derives its whole
  `--wairon-*` palette from one primary color, so a custom theme stores only
  the edits: resolution is derive(primary, mode) → base overrides → per-mode
  overrides. Every field in the builder shows the resolved value, marks whether
  it is `derived` or `custom`, and resets per field — untouched tokens keep
  adapting to light/dark/high-contrast. (The reference SYW builder this ports
  layers derivation *over* a full snapshot, which silently discards base edits;
  the inversion is deliberate.)
- **The editor.** Grouped token editors (brand, surfaces, text, borders &
  effects, status) with color pickers + alpha, shadow presets, and free-form
  CSS for gradients; a seed control that re-derives the full palette from one
  color; per-mode override pinning; live surface/typography previews with
  WCAG contrast ratios; and a "generate accessible text set" pass that pins
  AA-compliant (4.5:1) text tokens for the previewed mode. Edits stage in a
  local draft with a floating save bar — nothing applies or persists until
  saved.
- **Custom themes are first-class everywhere**: they appear in the header-menu
  and login-cog pickers, re-theme the canvas chrome through the bridge, and
  `-rgb` companions + the accessible primary-contrast recompute from the final
  colors automatically. A vanished custom id degrades to the default theme.
- **The picker is the shared SYW `ThemeMenu` component** (matching waffler_ui):
  one compact "Appearance" section — a dropdown trigger showing the active
  theme's swatch pill + name, a flyout listing every theme with "Create custom
  theme" at its foot, and the mode toggle directly beneath. Extracted as a
  props-only, app-agnostic component (`components/ThemeMenu.tsx`, styled purely
  through `.tmenu-*` classes) so the same menu can be lifted into any SYW app.

### Declared entrypoints: `register` steps + `invokedBy` (new)

Unused-detection could only see callers the narrative graph modeled, so a callback
handed to the runtime (timer, event listener, shutdown hook) or a method invoked by
an external system read as `UNUSED_COMPONENT`/`UNUSED_METHOD` — and the lint.allow
that silenced the finding also stopped reachability from propagating through the
method's narrative. Two mechanisms close that honestly:

- **`register` narrative step** — a runtime-callback HANDOFF with the same target
  shape as a `call` step (`targetComponent` + `targetMethod`). Reachability treats
  it as an edge (the callback is reached wherever its registering narrative is),
  but it is NOT an invocation: exempt from call-graph conformance
  (`CALL_STEP_UNREALIZED`), never a call-cycle edge (`UNCONDITIONAL_CALL_CYCLE`),
  and not followed by the durability boot walk — registering a hydrating read at
  init is not executing it at boot, matching the non-flooded boot-graph doctrine.
  Targets get the identical existence/dependency/contract validation call steps get.
- **`invokedBy` on L3 methods** — `{ kind: runtime | external | sibling-subsystem,
  caller }` declares a real caller OUTSIDE the modeled graph. Unused-detection seeds
  the method as an entrypoint, so reachability PROPAGATES through its narrative —
  unlike a lint.allow, which only hides the finding. The declaration is audited:
  missing or placeholder-thin `caller` prose warns `INVOKED_BY_UNDESCRIBED`, and a
  declaration on a method the internal walk already reaches warns
  `INVOKED_BY_REDUNDANT` (stale — remove it).

### Fixes

- **A stale lock reported itself as locked.** The hosted project config view judged
  "locked" from the mere EXISTENCE of a lock record while the promote gate compared
  state identities — so a project whose specs changed after locking still claimed a
  freeze that did not hold, the same time-of-check gap the lock exists to close,
  reintroduced in the reporting surface. `readLockState()` is now the single
  authority (`unlocked | locked | stale`), shared by the promote gate, the config
  view, `wairon status`, and `wairon doctor`, so they cannot disagree. `locked` now
  means the lock is IN FORCE; `lockStale` distinguishes voided from never-locked so
  a UI can prompt for the re-lock.
- **Lock staleness was invisible until promote.** It was compared in exactly one
  place, so a voided lock surfaced only when someone tried to promote — fail-closed,
  but late. `status` and `doctor` now report it with the reason and the remedy.
  Deliberately NOT auto-relocking on upgrade: the record carries `lockedBy` and
  asserts that a human approved promoting this state, so regenerating it would make
  that assertion untrue.
- **Organizations page crashed on a hosted instance upgraded to v5** with
  `Cannot read properties of undefined (reading 'localeCompare')`. Units persisted
  before slugs existed have no `slug`, `host doctor --fix` is operator-invoked, and
  the units view sorted on `slug` straight off the wire — a data-shape problem
  surfacing as an unreadable minified UI crash. The read path now derives a missing
  slug from the id (a unit's id is its dot-qualified path and the slug is its last
  segment, so a root unit's id *is* its slug — the same rule the migration applies).
  Identity is never rewritten and a present slug never overwritten.
- **An unmigrated data dir now announces itself at startup.** `wairon serve` reports
  pending legacy shapes and names the remedy, reusing the migration's own dry run as
  the detector so the two cannot disagree. It writes nothing and never blocks
  startup. Previously the first symptom was zero permissions or a crashed page.
- **CI typechecks the web app.** `web/` is a separate package, not an npm workspace,
  so the root `typecheck` never covered it and `build:web` does not run in CI — a
  type error in `web/src` could reach main unnoticed.
- **A test no longer rebuilds the project mid-suite.** The hosted-server example test
  ran `npm run build`, whose `prebuild` cleans `sdk/dist`, while ~126 other test
  files loaded in parallel workers — so any file importing `@wairon/sdk` in that
  window died with `Cannot find module '/sdk/dist/index.js'`. Intermittent, invisible
  when run alone, and more likely the more tests the suite gained.

### Upgrading

1. **Hosted instances: run `wairon host doctor` (dry run), then `--fix`.** Required
   if you upgraded from a pre-permission-model version — legacy users and API tokens
   otherwise resolve to zero permissions, and units without slugs break the
   organizations page. `wairon serve` now warns when this is pending.
2. **Re-lock any locked project.** The lock now covers doctrine, so records written
   before this release read as *stale* and `promote` refuses until you re-lock. This
   fails closed by design: those locks were taken without doctrine coverage and
   cannot be retro-verified.
3. **Declare the packs your projects apply.** Machine-wide packs no longer apply
   unless a project selects them. Run `wairon doctor` to see what is installed but
   unapplied and `wairon doctor --fix` to record it as explicit selections — or set
   `extensions.useGlobalPacks: true` in `.wai/project.yaml` to keep the old
   behaviour. **A project whose subsystem references a global pack's `profile` will
   otherwise report `UNKNOWN_PROFILE`, which fails `validate --ci`.**
4. **Embedding wairon as a library:** `LoadedExtensions` gained required
   `instructions` and `selectionFailures` fields. Use the exported
   `emptyExtensions()` rather than hand-constructing one.

## v5.1.0 (from v5.0.1)

### Hosted profile application: a selected profile now actually governs (new, `feat/profile-apply-into-spec`)

Picking an architectural profile for a hosted project used to record a name.
If the profile came from an extension pack that was not installed **in that
project**, it resolved to nothing: `UNKNOWN_PROFILE`, doctrine family silently
`neutral`, and the profile's whole `rules` block (designDepth, rule severities,
naming, complexity) never applied. A project's own pack profiles were also
invisible to the picker, and any later pack write erased the recorded selection.

- **Project-scoped profile catalog** — `GET /web/projects/profiles` lists
  built-ins ∪ the profiles contributed by that project's **own** registered
  packs (`installed`) ∪ those from the server-global tiers (adoptable), each
  source-tagged. The instance-wide `/web/admin/profiles` catalog is unchanged
  but cannot see a project's own packs, which is why the picker switched.
- **Writing a profile makes it resolve** — `setProjectType` ensures the profile
  is resolvable *before* writing: a built-in or project kind passes through, a
  profile contributed only by a server-global pack has that pack **vendored
  into the project** (reported as `adoptedPackName`), and an id no tier carries
  is **refused** rather than written as a name nothing enforces. The applied id
  is folded to the front of the recorded `profileSelection`.
- **Initialization applies the selection** — a project created under a policy
  that requires a profile comes up governed by it (first resolvable id;
  remaining ids are reported as an unapplied remainder, since a project has
  exactly one governing profile). An unresolvable selection leaves the default
  and is audited, never failing project creation.
- **Honest reporting** — `getProjectConfig` returns `profileSource`,
  `profileResolvable`, the unapplied remainder, and the subsystems whose own
  `profile` overrides the project-level one; `evaluateProjectPolicy` reports
  `governingProfileId` + `unappliedProfileIds`. The web UI surfaces an
  unresolvable recorded project type instead of leaving it silent.
- **Reconciliation repairs, and converges** — `reconcileProjectPolicy` repairs
  the governing profile only when it is broken or policy-noncompliant (a
  deliberate, resolvable, compliant choice survives), and folds the repair into
  the recorded selection so compliance is satisfied in **one** pass. Without
  that fold it reported the required profile as "not selected" forever.
- **Fixes silent data loss** — `profileSelection` is now modeled in
  `ProjectConfigSchema`; previously any `saveProjectConfig` round trip (a pack
  install, adopt, or removal) stripped the unmodeled key.
- New `ihost_core_adapter.builtinProjectKinds`, with `PROJECT_KINDS` exported
  once from the core rules registry so the profiles rule and the hosted apply
  path cannot disagree about which composite kinds are legal `projectType`s.

**Validation rail (web UI)**: scoped to the focused spec by default — a
component scopes to its whole unit (component + interface + implementation) —
with an honest `N on this component · M elsewhere` count and a show-all toggle.
Each finding carries a clickable chip naming the affected spec, and issues whose
code maps to a concrete field (description, componentType, durability, profile,
publicInterfaces) scroll to and highlight it.

*Known gap*: a **subsystem**-level `profile` chosen from a not-yet-installed
pack still resolves to nothing (no adopt step on that path) — the project-level
write is the one that adopts. Tracked as the next step, together with the
subproject-vs-internal-subsystem inheritance model (a subproject is its own
project and may carry its own `projectType`; internal subsystems inherit).

### Subproject-scoped credentials are actually scoped (new, `feat/subproject-confinement`)

A hosted token can be narrowed to a chained subproject (`projectId::subsystemId`),
and the data plane binds the CHILD root for ordinary `sdd_*` tools. Eleven tools
bypassed that: they act on the hosted project RECORD with the TOP project id, so a
credential scoped to one subproject could act across the WHOLE parent. Not
privilege escalation (a narrowing never widens grants) but a confinement failure,
with no workaround but avoiding narrowed tokens.

- **Record-level tools are refused** on a subproject-qualified binding —
  `sdd_host_initialize_project`, `sdd_host_get_approval_status`,
  `sdd_host_await_approval`, and the six project-ops tools (pack list/install,
  policy evaluate/reconcile, produce, commit). The refusal is an `isError` tool
  result naming the tool and the bound qualifier (HTTP stays 200), raised BEFORE
  the lifecycle dispatch and BEFORE the permission gate, and audited through the
  same path as any other outcome.
- **`lock` / `promote` are confined rather than refused**: the qualifier is
  forwarded and binds the child's tree through the containment-guarded mount
  resolution, so a narrowed agent can freeze exactly its own subtree. An
  unresolvable qualifier fails loudly — it never falls back to the parent, which
  was the defect.
- **The approval path is confined too.** Approval is the one path where the
  requester does not perform the action, so the qualifier is recorded on the
  `ApprovalRequest` via the existing `payload`/`payloadType` fields (the mechanism
  `project:init` already uses), named in the summary so an approver sees the real
  scope, and forwarded by both the auto-execute and the retry path. A malformed
  scope payload refuses rather than widening to the whole project.
- A subproject-scoped lock performs **no git sync and no publish**: the git binding
  is read from the bound root, so a child tree carries none. Note the frozen child
  tree is not staged by the project's own `.wai/`-scoped commit either — a chained
  child lives outside that pathspec — so reaching a remote takes a commit whose
  scope covers the child's path.

### Sibling surfaces include Gateway- and Observer-published subsystems (fix)

A chained child receives each sibling subsystem's published surface, but the
projection only accepted a `Portal`. A subsystem published through a `Gateway` was
legitimately published in-project yet absent from every child, leaving the child's
cross-tree references permanently unverifiable with no user workaround. The
projection now accepts what the boundary rules already sanction as a cross-boundary
target — `Portal`, `Gateway`, or an `Observer` for an event surface. A published
entry whose backing component can never serve a cross-boundary caller (a `Custom`
entry over a Specialist, say) is omitted and reported as a diagnostic when the
surfaces are generated; unbound entries and ones naming a missing component stay
silent, because the validator already raises those as errors.

## v5.0.1 (from v5.0.0)

Undocumented at the time; recorded here from the release range.

### ZIP (`.wpack`) extension packs + `@wairon/sdk` (new)

A portable, versioned `.wpack` archive became the pack unit across the CLI, the
webapp, and the hosted API, with a companion `@wairon/sdk` authoring library
(`wairon pack init|build|add|list|remove`; `packs` kept as a deprecated alias). A
`.wpack` is a directory pack plus a root `wairon-pack.yaml` envelope, extracted at
INSTALL time into `.wai/packs/<name>/` — a directory pack the loader already reads,
so the runtime load path is unchanged. The extractor enforces zip-slip
normalization and caps on entries, uncompressed size, per-entry size, compression
ratio and depth (stricter on hosted, which also keeps a max-body cap). Hosted
install stays declarative-only; code packs remain a filesystem/image concern.

### Distribution: scoped packages, tag-sourced releases, provenance

`@wairon/cli` (renamed from the unscoped package) and `@wairon/sdk` publish in
lockstep from a version tag with npm provenance; every `dev` push auto-tags
`-dev.N` and publishes to the `dev` dist-tag. Windows binaries are
Authenticode-signed behind a gate. The root build became self-sufficient (it builds
the `sdk/` workspace first), and the workspace package is bundled rather than left
as a runtime dependency — an unpublished workspace sibling must be bundled or the
shipped image cannot resolve it.

## v5.0.0 (from v4.3.0)

Accumulated capabilities since v4.0.0 around extension packs, the hosted server,
chained subprojects, agent-topology scale, the RBAC permission model, and the
Level-3 semantic-conformance program. Interim tags v4.1.0–v4.3.0 were cut from
earlier dev merges, so some bullets shipped in those. The RBAC permission model
changed hosted authorization behavior and the stereotype matrix gained newly
enforced edges, which is what made this a major.

### Level-3 semantic conformance + model-review program (new, `feat/level3-conformance`)

The validator moves from structural/topological checking toward semantic and
behavioral checking, plus the configurability and doctrine fixes from an
independent model review. All new checks default to **warnings** (lint.allow-
suppressible) unless noted; existing clean trees stay clean unless listed under
*migration* below.

**New rule codes** (see `wairon rules list` for the full descriptions):

- Detail sufficiency: `UNNARRATED_COMPLEXITY` (realized cyclomatic complexity —
  exact AST grade only — over `rules.complexity.maxUnnarratedComplexity`,
  default 8, while the method sits below `detail: full` with no narrative),
  `DETAIL_BELOW_STEREOTYPE` (explicit dial below a logic stereotype's full floor).
- Invariant registry: entities declare `invariants:` (anchored via
  `componentClass`); narrative steps assert them via `assertsInvariants` —
  `UNASSERTED_INVARIANT`, `INVARIANT_UNANCHORED` (warnings),
  `UNKNOWN_INVARIANT_REF`, `DUPLICATE_INVARIANT_ID` (errors). Declarations
  checked; enforcement never proven.
- L5 antipatterns (provable-only): `INESCAPABLE_CYCLE` (step cycle with no exit
  and no terminator), `MEANINGLESS_BRANCH`, `UNCONDITIONAL_CALL_CYCLE`
  (cross-component call cycle unavoidable on every path).
- Code↔spec Level 3 opener: `CALL_STEP_UNREALIZED` — every narrative `call`
  step must appear among the realized function's callees (set membership,
  same-file helper closure, symbol overrides + N:1 identity forwarding
  honored; exact grade only; aggregated one finding per method).
- Store/Registry doctrine: `UNOWNED_STORE` (two sanctioned shapes: Repository
  recommended, deliberate standalone Store via lint.allow),
  `REGISTRY_WITHOUT_STORE` (a storeless standalone Registry is mistyped or
  orphaned), `ARCHITECTURE_VIOLATION_REGISTRY_DEP` (Registry outbound: its
  Store or a backend Adapter only), `HIDDEN_STATE` (module-scope mutable
  bindings in files realizing only logic stereotypes), `MISSING_DURABILITY`
  (every Store declares its durability), `PORTAL_WRITE_SHORTCUT` (error — a
  Portal narrative calling a write-effect facade method).
- Event topology: components declare `emits:` / `subscribesTo:`; paired with
  MessageBus endpoint directions — `UNCONSUMED_TOPIC`, `UNSOURCED_SUBSCRIPTION`
  (silent on trees with no event edges).
- Guarantee vocabulary: `UNKNOWN_GUARANTEE` — a guarantee token on an L3 method
  or a narrative `assertsGuarantees` that is neither builtin
  (`idempotent | atomic | transactional | exactly-once`) nor declared by a
  loaded pack. The token consistency checks match literally, so an undeclared
  token silently escapes them.
- Facade rule now enforced: `FACADE_FORWARDING` — a Repository/Gateway facade
  method with an authored narrative that is not exactly one `call` step to an
  owned member (the standard §7 claim, previously "mechanically enforceable"
  but unimplemented; dogfooded at zero cost — wairon's own 63 narrated facade
  methods all conform).
- **Static integration gate** (docs/design/integration-conformance.md §4,
  implemented): L4 `simPath` names the committed integration harness (N:1
  sharing like `sourcePath`). `SIM_FILE_MISSING` (no such file / escapes
  root), `UNWIRED_INTEGRATION_SIM` (the harness's exact-grade import graph,
  closed over the analyzed modules, does not reach the component's own
  module + each direct dependency's — any module of the target subsystem for
  cross-subsystem edges; technology-boundary fakes sanctioned), and
  `MISSING_INTEGRATION_SIM` — which activates **per subsystem** once its
  first `simPath` is declared (adoption made mechanical; un-adopted trees
  see nothing). Wiring is proven statically; execution stays CI's job.
  wairon's own sdd_validator subsystem adopts first: all 7 non-leaf
  implementations declare `tests/core/validation.test.ts`, which wires the
  real registry/store/adapters.
- **Sim path coverage** (`SIM_PATH_UNCOVERED`, §4.5): a harness may claim
  coverage with string anchors — `"sim:<component>.<method>"` (happy path)
  and `"sim:<component>.<method>:<label>"` (the error path of the `throw`
  step carrying that narrative label). Opt-in per component (its first
  `sim:` anchor activates the expectation); unlabeled throw steps are never
  expected — the step label IS the path's renumber-proof identity. Anchors
  prove paths are NAMED; execution and assertion quality stay CI's job.

**New config & schema surface:**

- `rules.designDepth: components | interfaces | implementations | narratives`
  (default `narratives`) + per-subsystem `designDepth` override + pack-profile
  default — expectation checks below the declared depth are gated; soundness
  of authored content always applies.
- Pack profiles (`ProfileDef.rules`) can now carry `sddRuleSeverity` (applies
  to their subsystems; explicit project config wins) alongside the existing
  documentation/complexity/naming and the new designDepth.
- **Profile edge-deltas**: `ProfileDef.allowedEdges` — `{from[], to[],
  reason}` entries LICENSE intra-subsystem `dependsOn` edges the builtin
  stereotype matrix refuses, for components governed by the profile (the
  review's "game-ecs would error on its own idiom" fixed: an ECS pack
  licenses `Specialist → Store`). Cross-subsystem boundary rules and pattern
  containment are never relaxable; the DENY half is a `forbid-edge`
  declarative assertion. Together these complete the profile-scoped matrix
  mechanism (severity deltas + allow deltas + deny assertions).
- `durability` grows to `durable | read-through | ram-projection | cache`
  (only `durable` requires the hydration round-trip).
- Lifecycle entrypoint `phase` grows to `init | shutdown | cyclic | interrupt |
  scheduled` — all root the reachability walker; only `init` feeds hydration.
- `ext:` — an opaque, verbatim-preserved extension-data map on every spec kind
  and on L3/L4 methods, for pack rules to read.
- **Declarative rule assertions** (docs/design/declarative-rule-dsl.md): a
  declarative pack may carry `assertions:` — instances of three closed kinds
  (`forbid-edge` selector-matched dependency/ownership bans, `require-field`
  over top-level and `ext.*` fields with optional closed value sets,
  `endpoint-shape` transport allowlists + address patterns) with pack-local
  codes surfaced namespaced (`<PACK>_<CODE>`), declared severities, and the
  doctrine reason quoted in every finding. Packs add rule INSTANCES, never
  rule logic — the hosted (declarative-only) pack path finally carries real
  doctrine; an unknown kind fails the pack load loudly. Assertion codes join
  `knownIssueCodes`, so lint.allow and `sddRuleSeverity` treat them exactly
  like builtins.
- **Pack-declarable guarantee tokens**: the guarantee schema is now open
  (`z.string()`); a pack manifest may declare `guarantees: [compensating, …]`
  to extend the vocabulary. The narrative↔contract consistency check
  (`NARRATIVE_SEMANTIC_UNBACKED`) applies to pack tokens exactly as to
  builtins; the MCP `guarantees`/`assertsGuarantees` inputs accept any
  declared token.
- **Symbolic step labels**: a narrative step may declare a `label` anchor, and
  every jump-by-number flow field has a `*Label` twin (`toLabel`,
  `onTrueLabel`, `onFalseLabel`, `defaultLabel`, `endLabel`, `finallyLabel`,
  plus `label` in `cases`/`catches`/`branches` entries) resolved to step
  numbers at write time — the stored spec keeps plain numbers. Guards LLM
  step-counting off-by-ones: an unknown/duplicate label REJECTS the write,
  and an `sdd_update_spec` delta can reference labels anchored on
  pre-existing steps (resolution runs post-merge, against the final
  numbering).
- **`parallel` fan-out/join step + `detach` call flag** (flow algebra
  extension sanctioned by the technology-boundaries design record §4; the
  model review's GPU/robotics/backend convergence). A `parallel` header owns
  body `next..endStep`, covered by ≥2 contiguous ordered arms
  (`branches: [{step}]`); the join is implicit after `endStep` once ALL arms
  complete — `stepGraph()` routes an arm's last step to the join, never into
  its neighbor (nesting handled). `detach: true` on a call/dispatch step is
  fire-and-forget. Soundness lives in the narrative-flow rule (arm coverage,
  ordering, region overlap, dangling entries); `updateSpec` relocates
  `branches[].step` on insert/delete and refuses to delete an arm entry
  target; language/platform packs gate both via `unsupportedFlow`
  (`parallel:`, `detach:`).
  `UNCONDITIONAL_CALL_CYCLE` treats arms as alternatives for now
  (under-reports across parallel regions — conservative direction).
- **Parallel/detach rendering across the diagram surfaces.** The canvas flow
  modal renders a `parallel` header as a fan-out BAR spanning one lane per
  arm, with the implicit join bar after `endStep` (all arms complete before
  flow continues) — an arm's last step wires into the join, never into its
  neighbor arm. A detached call hangs its callee OFF the flow as a ghost
  node reached by a dashed open arrow annotated "detached", while the firing
  step's own lane continues normally — failure visibly does not propagate.
  Both survive the "Hide error paths" toggle (they are not error paths), and
  the flow modal's draw.io/Excalidraw exports keep the bars and ghosts. The
  Mermaid sequence exporter maps endStep-bounded parallel regions onto
  `par`/`and` fragments (mirroring loop/critical) and renders detached
  calls/dispatches as async open arrows (`-)`, annotated, no activation, no
  return). The Steps list spells both out (`∥ parallel — arms …`,
  `⇢ detached — fire & forget`).
- Cross-subsystem: a `trustedLink` on the SOURCE subsystem licenses a direct
  in-process edge to the peer's published Portal (no Adapter shim); Portals may
  depend on Repository/Index for reads.
- FeatureComponent arity relaxed: exactly one Orchestrator + **one or more**
  Views (was exactly one of each) — a feature slice with list/detail/form
  faces no longer needs artificial per-view slices. Foreign member types
  inside the slice are still rejected.
- Honest profile labeling: `lowlevel-os` / `game-ecs` / `realtime-embedded`
  are now labeled as *blueprints* everywhere they're described (init menu,
  roadmap) — today they enforce only backend-family fencing; the described
  platform validations are explicitly marked unimplemented, and doctrine is
  expected from extension packs. `plc-cyclic`'s unimplemented narrative
  checks are likewise marked.
- Placement notices: `sdd_add_type` (and siblings) explain flat-layout
  placement and never-relocate semantics instead of silently "ignoring" the
  subsystem parameter. `doctor --fix` still performs no flat→nested migration
  (known gap).
- sdd-implement's Definition of Done now includes an integration sim against
  real dependencies (docs/design/integration-conformance.md holds the designed
  static gate); the standard gains a transactions & unit-of-work + outbox
  doctrine and the two-path store doctrine.

**Migration for existing trees:** `MISSING_DURABILITY` fires once per
undeclared Store (declare one of the four modes); storeless standalone
Registries get `REGISTRY_WITHOUT_STORE` (retype to a `read-through` Store, or
lint.allow); narrative-bearing trees may see `CALL_STEP_UNREALIZED` where
per-method `symbol` maps are missing. `Store → Registry` edges are now errors
(the standard always said so; none existed in wairon's own tree).

**Dogfood: spec_loader promoted to a real Repository.** The
REGISTRY_WITHOUT_STORE debt marker on wairon's own spec loader is retired the
honest way: `spec_loader` is now a Repository owning `spec_file_store`
(read-through Store over the YAML tree, `readYamlFile`/`writeYamlFile`/
`listFilesRecursive` symbols), `spec_registry` (validated write face + the
round-trip dry run), and `spec_index` (read/lookup face). The facade's 16
methods are pure 1:1 forwards — verified by the new `FACADE_FORWARDING` rule
on a real remodel. Spec-tree-only change; the code already had this shape.

### Extension packs: pack-provided AI skills + versioned pattern references (new)

Two generic extension-pack capabilities so profiles and wrapper products can
carry more reusable, versioned knowledge — while wairon's core model stays
portable. Both are opt-in and change nothing for projects that don't use them.

- **Pack-provided AI-agent skills.** A directory pack can ship declarative
  `skills:` (SKILL.md files); `wairon skills install` / `generate` install them
  into the supported client targets, and the hosted MCP server publishes them
  through the same `wairon-skill://` resource mirror as the built-ins. Skills
  install **namespaced `<pack-id>-<skill-id>`** (the built-in `sdd-*` names are
  reserved), so skills from different packs never collide and provenance +
  version are legible in `wairon skills list`. These are AI-client skills, not
  MCP tools.
- **Versioned reusable pattern references.** Packs declare named, versioned
  `patterns:`; a component references one via `patterns: [{ id, version }]`.
  Wairon resolves the reference (`UNKNOWN_PATTERN_REF`, plus
  `PATTERN_VERSION_MISMATCH` for a pinned version no pack provides), lists them
  with `wairon patterns list`, and exposes them to pack rules via
  `ctx.ext.patterns` — the pattern's actual constraints are enforced by its
  declaring pack's own rules. Publishes a reusable architecture convention
  across projects without copy-pasting a spec shape.

Internally, the previously-unmodeled core extension machinery is now first-class
in wairon's own spec tree — the pack loader, the conformance rule set as a
proper in-memory **Repository**, and the `packs`/`rules`/`patterns` CLI — held to
the same conformance gate as everything else. See `docs/extending-wairon.md`.

### Component variants (new)

A **variant** is a named, base-anchored specialization of a core stereotype — a
"kind of `Adapter`/`Specialist`/…" (e.g. a `publisher`) — carrying implementation
guidance. It gives components domain vocabulary and, crucially, tells the
**implementer** "this is the same kind as those other components — reuse one
shared approach instead of reinventing it per instance." The base stereotype
stays authoritative for all generic semantics; the variant only adds vocabulary,
a rule target, and the guidance. (A cross-cutting capability like `retriable` is
*not* a variant — that stays a method `guarantee`.)

- **A dynamic registry on top of packs.** Variants live outside packs — define
  one on demand (no pack edit/release) and share it anywhere (a tiny portable
  YAML). Loaded from `WAIRON_VARIANTS_DIR` (machine/org-wide) then `.wai/variants/`
  (project wins), so a good variant is reusable across projects, orgs, tenants.
- **One per component, strictly base-anchored.** A component declares a single
  `variant`; `base` is required, so a variant is always "a kind of `<stereotype>`".
  Resolution: `UNKNOWN_VARIANT` (undeclared) and `VARIANT_BASE_MISMATCH` (the
  component's stereotype ≠ the variant's base, error).
- **Deep implementer integration.** A component's variant guidance and its
  same-variant siblings are injected into the generated owner/implementer agent
  context, so same-variant components get implemented consistently. Listed by
  `wairon variants list`; exposed to pack rules via `ctx.variants`.

### Hosted server: real SSO + web admin UI + agent tokens (new)

The hosted server (`sdd_host`, `wairon host`) gains the pieces that make its
web UI a real, self-serviceable control plane. Opt-in as before
(`exposurePolicy.webUiEnabled`, default off).

- **SSO for self-hosted providers.** The OIDC adapter now resolves each
  provider's endpoints by **explicit overrides → `.well-known` discovery →
  providerType template** (Keycloak `/protocol/openid-connect/*`, Authentik
  `/application/o/*`, generic), so **self-hosted Keycloak/Authentik actually
  connect** — previously it derived `/authorize`+`/token`, which matches neither.
  The returned **id_token signature is verified against the provider JWKS**
  (plus `iss`/`aud`/`exp`), no longer trusting the TLS channel alone.
- **Split-horizon endpoints.** New `IdentityProviderConfig` overrides
  (`authorizationEndpoint`/`tokenEndpoint`/`jwksUri`/`userinfoEndpoint`) let a
  **public** front-channel authorize URL pair with a **VPC-internal** back-channel
  token/JWKS URL — the common self-hosted-in-a-private-network topology.
- **Web admin UI.** The identity/admin control-plane portals are bound to the
  loopback admin listener and unreachable from a remote browser, so admins had
  no real control plane in the UI. New data-plane `/web/admin/*` routes + client
  forms bring **Users** (create/status/grants), **Identity Providers/SSO**
  (incl. the discovery + split-horizon fields), and **Organization units** into
  the browser app, forwarding the session as the credential so existing scope
  authorization is unchanged.
- **Agent tokens, separate from web login.** A signed-in user can mint a
  **single-project MCP token** for an AI agent — self-scoped (no `key:manage`
  needed for a token no broader than your own access) and **owned by the minting
  user**, so deactivating that user revokes their agent tokens. List + revoke
  round out the lifecycle.
- **Project lifecycle in the UI.** Humans **create / lock / promote / destroy**
  their projects from the browser (the admin project methods already authorize by
  grant scope), with a scoped project list — no longer CLI/loopback-only.

### Layered agent topology (new)

`wairon generate` now produces a **layered, per-project** agent topology instead
of one flat pile at the top:

- Generation emits agents for **only the current project's own layer** — the
  architect and one owner per local subsystem. A **chained subproject collapses
  to a single delegating owner** that routes work into the subproject; it never
  enumerates the subproject's internals (which belong to the subproject's own
  layer). On the real Waffler project this took the root from 507 flat agents to
  **10**, and `waffler_core` from 2000+ to **29** — each `.claude/agents` (and the
  context every session loads) now proportional to one layer.
- **Cascade by default**: one `wairon generate` walks every chained subproject
  and generates each layer into its **own** `.wai/.claude`, ensuring each child is
  initialized first (non-destructive). `--no-recurse` limits to the current layer.
- **`generateComponentImplementers` now defaults to `false`** — one owner per
  subsystem, not one implementer per component (the source of the explosions).
  Opt in with `true` on small trees. Projects with the field explicitly set are
  unaffected.
- The domain-owner agent template now instructs **hierarchical self-division**:
  break the domain into components/tasks, spawn focused subagents (which split
  further as needed), and — for a chained-subproject domain — delegate into the
  subproject rather than implementing its internals.
- `wairon generate` (and the exporters) now write relative to the bound project
  root, so running it from a subdirectory targets the project, not the cwd.
- **`generate` now reconciles its output dirs** — it prunes agent files that are
  no longer in the topology (a removed component's orphaned agent, or the old
  flat pile after the switch to layered) so the on-disk set actually shrinks
  instead of accumulating. Every generated file carries a `wairon:managed`
  marker; pruning only ever removes wairon-owned files (that marker, or the
  generated `-owner`/`-implementer`/`-architect` naming), **never a
  hand-authored agent**. Scoped runs (`--domain`/`--root`) never prune (they
  wrote only part of the set); `--no-prune` disables it entirely. The cascade
  reconciles each layer's own dir.

### Chained subprojects: self-initialize + doctor backfill (new)

- Creating a chained subsystem (`sdd_add_subsystem` with a `projectPath`) now
  **fully initializes** the child in the same action (project.yaml + system
  spec), **non-destructively** — never overwriting an existing spec tree (this
  also fixed a latent clobber in the old scaffold path).
- `wairon doctor` **detects** chained subprojects that have specs but no
  project.yaml (un-runnable standalone), and `--fix` **backfills** them.

### Validation-scope fixes

- **`validate --subsystem <name>` now errors on an unknown subsystem**
  (`SUBSYSTEM_NOT_FOUND`) instead of silently validating clean. The error lists
  the known subsystems, so a typo or wrong namespace prefix fails loudly.
- **Chained subprojects no longer explode when validated from their own
  directory.** A subproject validated standalone physically does not contain its
  parent tree, so references into it (shared types, sibling subsystems,
  cross-tree components) and code↔spec sourcePaths stored relative to the parent
  root cannot resolve — previously this produced hundreds of hard errors from
  the subproject dir while the same specs were clean from the top project
  ("different root, different verdict"). Now `wairon` detects that the current
  project is a chained subproject of a discoverable parent and **downgrades
  those root-dependent resolution failures to warnings**, with one clear notice
  (`CHAINED_SUBPROJECT_CONTEXT`) pointing at the parent root for full
  verification. So an agent running `wairon validate` / `mcp serve` inside a
  subproject dir gets an honest, non-exploding result instead of a wall of false
  errors. Additionally, cross-subproject references are now stored in the
  root-invariant relative form (`super::`) rather than a root-absolute `::`
  anchor, so newly-authored refs resolve identically from either root.

## v4.0.0 (from v3.2.5)

A large correctness + capability release, versioned **major** to signal two
breaking *deployment/CI* changes to downstream consumers (the CLI, MCP tools,
spec schema, and library APIs themselves are fully backward compatible — nothing
was removed or renamed):

1. **Stricter validation.** The new conformance gate makes `wairon validate`
   stricter — a stale L4 `sourcePath` is now a hard error, and `validate --ci`
   surfaces new warnings. A pipeline that was green may go red until the specs
   are reconciled (see *Compatibility & migration*).
2. **Container image rebased debian→alpine, npm removed.** Extension images
   built `FROM` the wairon image must use `apk` (not `apt`) and cannot rely on a
   bundled npm at runtime.

### Security hardening (multi-tenant + web UI + image)

Findings from an adversarial re-review of the authz core, the browser/SSO
session surface, and a container CVE scan — all fixed:

- **Data-plane batch bypass (HIGH):** a JSON-RPC *batch* body let a second,
  unchecked tool call ride past the `mcp:read`/`mcp:write` permission gate
  (which inspected only the first message) — a read-only token could smuggle a
  write. The data plane now refuses multi-request batch bodies (`400`); one
  tool call per request. Cross-tenant isolation was never affected.
- **SSO login CSRF (HIGH):** the OIDC `state` nonce was signed but never bound
  to the browser. Sign-in now sets a short-lived HttpOnly nonce cookie and the
  callback requires it to match the signed state, so a forged/replayed callback
  delivered to a victim fails closed.
- **SSO redirect_uri allowlist (MEDIUM):** an identity provider may now declare
  `allowedRedirectUris`; when set, `POST /web/sso/start` refuses any redirect
  URI not on the exact-match list (server-side redirect pinning).
- **Grant-shape normalization:** a `projectId:'*'` grant that also carries an
  `orgUnitId` is now treated as unit-scoped (never instance-wide super-admin)
  everywhere, matching the scope engine.
- **Signing key fails closed:** an absent signing secret now throws instead of
  signing/verifying with an empty HMAC key (only reachable under `--no-auth`).
- **Container image:** rebased to `node:24-alpine`, `apk upgrade`, and npm
  removed from the runtime layer (the server runs `node` directly). The image
  ships no perl/npm and scans **0 critical / 0 high**, down from 1 critical /
  20 high on the previous debian base; size 488 MB → 318 MB.

### Post-RBAC web UI: permission grid, canvas engine, hierarchical environment

The three deliberately-deferred UI epics, landed after the RBAC merge:

- **Permissions admin view** (`/admin/permissions`) — the whole assignment
  grid (subject × scope × capability → value) with scope/subject filters, a
  scope-defaults (everyone) section, and a set-assignment form over the
  existing hardened endpoints. Canonical-subject semantics throughout: the UI
  displays record ids and submits them (the API canonicalizes); grid rows
  resolve back to users by BOTH subject userId and record id, with a
  "legacy key" badge on diverged-key rows.
- **Canvas engine epic** — floating header (the classic renderer's solid top
  bar becomes a floating toolbar over a full-bleed canvas, yielding to the
  details panel), and **data-plane realtime**: successful MCP `sdd_*` writes
  now nudge the project's realtime channel, so open canvases live-update on
  agent spec edits (previously only `/web` mutations pushed). The event
  carries no data — authorization stays at the scoped REST refetch.
- **Hierarchical environment canvas** — the landscape is filtered by the
  permission RESOLVER (`resolveVisibleScopes`), never a display projection:
  ancestor units of a deeper actionable scope now appear as read-only
  BREADCRUMBS (`actionable: false`, other children omitted) so the hierarchy
  stays navigable in the no@org + yes@one-project case; every node carries
  `actionable`, carried through `/web/graph` to the environment canvas.
  Cross-tenant invisibility is pinned by a dedicated two-tenant test suite.
- **Header overflow → dropdown** — canvas header controls that no longer fit
  collapse into a trailing "⋯" menu (horizontal scroll remains the
  last-resort fallback).

### Unified web UI (opt-in)

One role-based browser app for the hosted server — developers author specs
visually, admins additionally get control-plane pages, all gated by the
Phase-6 grant/role model. A browser session resolves to a Principal like a
bearer token, so the UI reuses the existing scoped API with no new
authorization surface. Enable with `webUiEnabled: true` in the instance
exposure policy (default **off**).

- **View** — an embedded live architecture canvas per authorized project
  (the same engine as `wairon diagram --format canvas`).
- **Specs (authoring)** — a component index + structured inspector that reads
  and edits specs over the existing `/mcp` data plane (`sdd_get_spec` /
  `sdd_update_spec`) and runs `sdd_validate_tree`, with write affordances
  disabled for read-only sessions (Phase-6b `mcp:read`/`mcp:write` enforced
  server-side).
- **Admin (control pages)** — session-scoped `/web/admin/*` routes over the
  existing Phase-6 scoped control-plane functions: pending approvals (with
  approve/reject), the scoped user directory, the landscape (units / projects
  / relations), and the instance health report. Every view filters to the
  caller's grants; a viewer session is refused (403), never leaked.
- Security: the SSO session surface passed an adversarial review; the login
  CSRF and redirect_uri findings (above) are fixed. Sessions are HttpOnly,
  `SameSite=Lax`, with a custom-header CSRF gate on cookie-auth mutations.

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

### Code↔spec conformance (new rule families)

"Does the code match the specs?" is now part of `wairon validate` instead of
a manual sweep. Two rule families, fed by a per-run source-code model built
with **zero mandatory parser dependencies** (TypeScript compiler resolved
dynamically from the analyzed project or the wairon install when available;
declarative per-language pattern tables for 12 languages; a generic
word-boundary scan as the universal floor — every finding carries its
analysis grade `exact | pattern | generic`).

- **`structural-conformance`** — every L4 `sourcePath` must resolve to a real
  file inside the project root (`MISSING_SOURCE_FILE`,
  `SOURCE_PATH_ESCAPES_ROOT` — *errors*), and every L3 contract method must be
  realized in that file (`UNREALIZED_METHOD`, `MISSING_SOURCE_PATH`,
  `CONFORMANCE_ANALYSIS_SKIPPED` — *warnings*). When TypeScript/JavaScript
  files can only be analyzed below exact grade (no `typescript` resolvable
  from the analyzed project or the wairon install), one
  **`CONFORMANCE_DEGRADED`** warning per run makes the degradation visible —
  install `typescript` in the analyzed project to restore exact analysis. Realization is tiered per
  implementation via the new **conformance dial** (`conformance: declared |
  anchored | off`, Portal defaults to `anchored`) with per-method overrides,
  and intent-language renames are declared with the new per-method
  **`symbol:`** mapping (`put` realized by `saveSnapshot`). Many
  implementations sharing one file (N:1) is fully supported.
- **`dependency-conformance`** — runtime imports between component-mapped
  files must be justified by declared `dependsOn`/`owns` relations
  (`UNDECLARED_DEPENDENCY`), and declared edges should leave an import trace
  (`UNREALIZED_DEPENDENCY`) — both *warnings*. Type-only imports and
  re-export barrels never accuse; cross-subsystem imports are sanctioned by a
  declared edge to the target subsystem's published surface; portal↔server
  mounting declared in the portal→server direction is recognized.
- All conformance codes are **completeness-classed**: draft/design specs
  downgrade to draft-waived warnings, so in-progress trees stay green while
  complete specs gate.
- Design record: `docs/design/code-spec-conformance.md` (includes the Level 3
  call-graph↔narrative sketch).

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
- **Data-coupling overlay**: a **"Data coupling"** toggle overlays dashed edges
  showing where a component/subsystem depends on **another subsystem's types**
  (its data/model shape) even when there's no logical `dependsOn` — derived from
  the same `usedBy`/type-reference data as the ERD, pointed at the owner
  subsystem's published portal, and drawn only where a logical dependency doesn't
  already exist. Off by default; the architecture view stays "logical
  dependencies only" until asked. So a shared model library that everyone imports
  no longer looks like an unconnected island.
- **View-options panel**: the view toggles (Internals, Externals, Data coupling,
  Issues, Rearrange) moved out of the crowded header bar into a **"⚙ View"**
  dropdown, rendered as labelled on/off **switches** (with one-line descriptions)
  instead of inline checkboxes; the panel stays open while you flip several.
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
  and their direction read clearly in a busy graph (focusing an inner tile or an
  in/out port now highlights the wiring within its box too, not only top-level
  boxes — and hovering a port lights the stub edges to the tiles it serves); (c) the **Types ERD degrades
  gracefully on huge systems** — above ~400 in-scope types it renders a
  subsystem-cluster overview (double-click a cluster to open it), above ~120 it
  falls back to header-only boxes, with a banner and a "render full detail
  anyway" override — so a 1000+-type system stays interactive yet fully
  navigable — and drilling a subsystem's ERD now shows its own types plus only
  the shared types they *reference*, not the entire shared library (previously a
  subsystem owning a single type was unreachable because the whole shared model
  flooded its scope and re-clustered it); (d) **breadcrumbs preserve the active mode** — walking up from a
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
  External (ghost) nodes are placed just outside the node bounds **toward the
  in-scope node they connect to** (not a fixed corner), so their line is short
  instead of crossing the whole diagram — and overlapping externals are nudged
  apart; and **Internals** now lay each box's children out with the same chosen
  layout (Grid/Concentric) instead of always the layered columns. Concentric is
  stretched into a **landscape ellipse** (screens are horizontal) rather than a
  tall circle, and **Force** seeds from a diagonal cascade so it relaxes toward an
  entrypoints-top-left → leaves-bottom-right flow, then widens into landscape.
  Concentric also orders each ring by flow rank (entrypoints toward the top,
  leaves toward the bottom) and places externals toward the node they connect to.

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

**Who is affected:** projects running **`wairon validate --ci`**
(warnings-as-errors) in a pipeline, plus one case that affects plain
`wairon validate`: structural conformance makes a **stale `sourcePath` a hard
error** (`MISSING_SOURCE_FILE` — the spec names code that does not exist;
`SOURCE_PATH_ESCAPES_ROOT` for absolute/parent-escaping paths). Every other
new rule defaults to *warning* severity (except `INVALID_TRUSTED_LINK`,
which requires the new field to exist at all).

After upgrading, run `wairon validate` locally and review new findings:

0. **`MISSING_SOURCE_FILE`** — fix the `sourcePath` to the real file (or
   remove it while the implementation is still design-only; drafts are
   waived). **`UNREALIZED_METHOD`** — if the code name legitimately differs
   from the contract name, declare it: `methods: [{ name: put, symbol:
   saveSnapshot }]`; for registration-style realization (route/tool string
   tables) dial the implementation to `conformance: anchored`; for
   generated/vendored code use `conformance: off`.
   **`UNDECLARED_DEPENDENCY`** — declare the real collaboration on the
   component that uses it, or route the cross-subsystem hop through the
   target's published portal.

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
