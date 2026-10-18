# Chained subsystems — decisions

The maintainer's decisions, in the order they were taken. Numbers refer to
[`synthesis.md`](synthesis.md) §8; where a decision departs from the synthesis's recommendation, the
reasoning is recorded here.

## Stage 1 — correctness on the current model (2026-09-12, merged in #69)

1. **The gate identity gains inputs, forcing one re-lock everywhere.** Accepted.
2. **Hosted git backing commits `.wai/lock.json`.** Accepted.
3. **Containment is decided against the owning root on every path.** Accepted.
4. **The legacy resolve-through-parent fallback stays**, with the stage-1 fixes, until stage 4.
   Accepted.

## Stage 2 — identity and declared externals (2026-09-12)

6. **Project identity.** `project.yaml` gains a required, immutable slug `id` (dots allowed); `name`
   stays the display name. Existing projects get `id` defaulted from `name`, slugified, and reported
   when that is ambiguous.

7. + 8. **References and aliases.** A cross-project reference is `alias::x`. The alias is optional and
   defaults to the producer's project `id`; the `members` and `externals` maps are the alias table.

9. **What another project may consume — reframed by the maintainer.** The synthesis recommended
   L1-published components plus an optional L0 export alias. That premise was rejected: every project
   is a crate of its own — this is actual software — so another project can reach only what a project
   explicitly exports, and siblings are no exception. Siblings do not know they are siblings; they are
   external libraries to each other, as packages are in any language. A component that is published at
   L1 but not exported was simply not exported, and exporting it is one entry.

   This matches how dependencies work everywhere: in Rust only items reachable from the crate root
   are usable (`pub use` re-exports; `pub(crate)` never leaves the crate); a Node package with an
   `exports` map refuses deep imports; a Java module reads only `exports`-ed packages; .NET's
   `internal` stops at the assembly. A workspace or monorepo grants nothing. It is also what the L0
   schema already states — an L0 `publicInterfaces` entry is "the ONLY thing another project may
   consume" — and chaining was the exception that broke it.

   Decided:
   - Cross-project consumption — parent → member, member → parent, member → member — resolves only
     to an L0 `publicInterfaces` export whose `audience` covers the consumer.
   - L1 `publicInterfaces` are `pub(crate)`: visible to other subsystems of the same project only.
   - A consumer names an export by its **export id** (`billing::invoicing`, the L0 entry's `id`), which
     defaults to the backing component id. Renaming the component behind an export never touches a
     consumer. Two exports with one id in a project are an error.
   - The chaining sibling surface (L1-published components projected at the family audience) is
     retired: a pin holds another project's exports and nothing else.
   - `trustedLinks` stay inside one project; a sanctioned fast lane cannot pierce a project boundary.
   - A parent still displays and composes its members (canvas, family validation, approval), but its
     references into them go through their exports like anyone else's.
   - Enforcement follows the staging rule: `EXTERNAL_NOT_EXPORTED` is a notice in stage 2 and an
     error once composed validation lands in stage 4.

   **Refined the same day — exports work like real module exports.** Every level exports, as every
   file in a crate or a Node package does, but only the top of a project is public outside it (like
   `lib.rs` or `index.js`). To keep that top small, a level re-exports rather than redeclaring, the
   equivalent of `export X from Y`:
   - **Three tiers.**
     - A component's L3 interfaces are visible within its subsystem.
     - A subsystem's L1 `publicInterfaces` are visible to every subsystem of the project
       (`pub(crate)`).
     - A project's L0 `publicInterfaces` are visible to other projects within each entry's `audience`.
   - **One set of entry forms at L1 and L0:**
     - an own item;
     - a one-to-one re-export of a component or a type from a source (`from`), optionally renamed
       (`as`);
     - a wildcard re-export of everything a source exports (`from` alone).
     L1 sources are the project's other subsystems; L0 sources are subsystems, members and externals.
     Own items and re-exports mix in one table, so a facade that combines several subsystems with its
     own logic, or extends one, is simply a table.
   - **Resolved like a module resolver.** Every re-export is followed once per scan to its canonical
     target, memoized and cycle-checked. Snapshots store the flattened table, and digests cover the
     canonical contracts, so restructuring re-exports never touches a consumer.
   - **A re-export can narrow its audience, never widen it.** Two different targets under one public
     name are an error; one target exported twice is not.
   - **Out of scope.** Interface inheritance (an L3 interface that inherits another's methods) is a
     separate feature, not part of this.

19. **Compatibility.** Signature-level superset: every used export method must still exist with an
    equal signature and reachable types; additions never fail; anything that cannot be compared is
    `EXTERNAL_CHECK_UNAVAILABLE`, never a pass.

**Migration of references that only reach L1.** Existing chained trees reference parent or sibling
components that were published at L1 but never exported. `doctor --fix` plans first: per producer, the
exports it lacks and every reference rewrite. Applying adds those L0 export entries (audience
`project`) to the producers and rewrites the consumers — a named family migration, refused when a
producer is absent.

## Stage 2a — export tables, `notice`, project id (2026-09-12, after sparring)

Sparring record: [`responses/fable-5.1-stage2a-spar.md`](responses/fable-5.1-stage2a-spar.md).

- **Name clashes.** An explicit or own entry overrides a name that a wildcard brings in, silently —
  the extension idiom of ES modules and Rust. When two wildcards bring one public name from different
  targets, that is `EXPORT_ID_DUPLICATE` (error) at the definition, and the name is left out of the
  table. Real systems fail only when the name is imported, but wairon's resolved table is a published
  contract, so the clash fails where it is made.
- **Cycles.** A wildcard cycle resolves to the union, as ES modules and Rust allow. It is reported as
  `EXPORT_CYCLE` (warning): two levels that re-export each other form a circular module surface, the
  same smell wairon already flags for mutual subsystem dependencies. A named chain that never reaches a
  component or type is `EXPORT_CYCLE` (error).
- **Project id changes.** The lock records the project's effective id, and `PROJECT_ID_CHANGED`
  (error) fires when `project.yaml` later disagrees. The sanctioned path is the stage-6 rename
  migration followed by a re-lock. A defaulted id is written into `project.yaml` on the configuration's
  next save, so editing the display name cannot move it.
- **Default public name.** `as ?? interface ?? component` — today's L0 default — so no published name,
  snapshot entry or OpenAPI tag moves. An entry that narrows to one interface should set `as`. This
  replaces "defaults to the backing component id" in decision 9 and removes that migration step.
- **Engineering defaults taken:**
  - `notice` is the new level's name.
  - `EXPORT_UNCONSUMABLE` (notice, error in stage 4) covers an export whose target no boundary caller
    may reach: only a Portal or a Gateway, or an Observer for events, may be.
  - A chained child's default id is its subsystem id.
  - `EXPORT_WIDENS_AUDIENCE` moves to 2b, where members can be re-exported.
  - The hosted landscape and the canvas read exports through the resolver.
  - The landscape's `public` audience default aligns with the projector's `instance`. This narrows
    hosted visibility of entries without an audience and is noted in the CHANGELOG.

## Wairon modeling decisions surfaced while designing 2a (2026-09-13)

- **A Specialist is the last resort.** Held or derived state belongs in a Store, Index or Repository;
  pure intrinsic behaviour belongs on the type; I/O belongs in an Adapter; workflow belongs in an
  Orchestrator. A Specialist is allowed only when none of these express the need, or when splitting
  it would be genuine overkill — and then with written reasoning. Wairon's own tree is the example.
  Enforcement:
  - component specs gain a `rationale`, and a Specialist without one gets
    `SPECIALIST_WITHOUT_RATIONALE` (warning);
  - the architecture standard, the sdd-architect skill and agent briefs state the rule with its
    decomposition checklist;
  - wairon's own 19 Specialists are audited in a separate track after stage 2: decomposed where a
    real block fits, given a rationale where none does.

  Stage 2a's two draft Specialists were dissolved on this rule: the export tables are an Index
  projection, and identity is pure `project_config` behaviour.
- **Project configuration is held state, and ships first.** A `project_config_repository` in sdd_core
  owns a Store (read-through `.wai/project.yaml`), a Registry (the write path) and an Index (the read
  path). It ships as its own behaviour-neutral pull request, "2a-0 — project configuration as held
  state", before stage 2a: every reader and writer migrates behind it — 10 components in 4 subsystems
  and 76 code sites. Hosted `pack_registry`, today one Store holding two aggregates, is reduced to the
  instance pack store; project pack registration moves behind `project_config_registry`. Stage 2a's
  identity read and id backfill then build on it.
- **An Index may project another Index — as an edge case.** An Index normally projects its Store's
  references directly. When data is complex enough that one Index's projection is itself worth
  re-presenting another way, a derived Index may refer to the same references on top of it. Guardrails
  (verified 2026-09-13):
  - both Indexes are owned by the same Repository;
  - there are no Index dependency cycles;
  - the doctrine text says it stays an exceptional case.

  The export tables are that case: `export_index` projects the scanned specs `spec_index` holds, and
  both are owned by `spec_loader`. Proposed for the Specialist track, still to verify: a derived-Index
  edge carries a written `rationale` too.
- **The config Store round-trips unknown keys.** A typed save used to drop every key the schema did
  not know, while the raw merge writers kept them. The Store now parses the fields it knows and writes
  every other key back verbatim, so no write erases data.
- **The specs folder is resolved at binding.** `paths.specsDir` is read once, when a project root is
  bound, through `project_config_index.specsDir()`, and handed to the spec repository. The spec
  repository never reads configuration itself, and no edge between the two Repositories exists.
- **Held-state authoring is Repository-first.** A Repository always has a Store, so adding a
  Repository scaffolds its Store in the same call, with durability required, and the result names
  both. Members (Registry, Index, Adapter) are added with `ownedBy: <repository>`, which appends them
  to `owns`. A Store outside a Repository must declare `standalone: { reason }` when it is created, or
  the write is refused at once. This replaces the `UNOWNED_STORE` warning and its `lint.allow`, and the
  sdd-architect recipe becomes Repository-first. It ships in the doctrine and authoring-UX track
  together with the Specialist enforcement, not in 2a-0. Before, the members-first recipe triggered a
  "no owning pattern" notice on every correct use.
- **Export entries get a type spec.** `public_interface` (the L1 entry: own items and re-exports)
  stands beside `system_public_interface` (L0).
- **Type behaviour gets conformance, later.** An optional `sourcePath`/`symbol` on type specs, so
  wairon can check that code realizes intrinsic methods such as `project_config.effectiveId()`. Not
  part of 2a.

## Stage 2a-0 — taken while migrating (2026-09-13)

- **The config registry mirrors today's pack writes.** The first registry draft would have changed four behaviours; the
  approved API follows each call site instead (map: [`stage-2a0-config-map.md`](stage-2a0-config-map.md) § Registry write
  semantics). Path references and selections have their own methods, `upsertPackSelection` moves a re-selected pack to
  the highest precedence, bundling and doctor's pin are one write each, and every pack write records `useGlobalPacks`.
  `setGlobalPacksEnabled` is gone, because nothing writes that flag alone.
- **Exposure-policy administration is its own orchestrator.** The config edge took `operations_orchestrator` past
  GOD_COMPONENT, and the rule had found a real second responsibility: exposure policy is the component's only write,
  and the only user of `policy_repository` and `audit_repository`. `exposure_policy_orchestrator` takes it;
  `operations_orchestrator` keeps the read-only health, usage and quota reports. No code moves: both specs point at
  `src/server/operations.ts`.
- **A configuration's declared packs and profiles are behaviour of the configuration.** Once the file read moved to the
  config Repository, `pack_registry.readProjectReferences` only reshaped a configuration its caller had loaded: it held
  nothing and read nothing. Pack storage holds no configurations, and keeping a copy there would duplicate state
  `project_config_store` owns. `project_config` gains `declaredPackNames()` and `declaredProfileIds()`, the health report
  builds its `ProjectPackReference` from them in a local step, and the method leaves the Store.
- **The adopted pack's path stays with pack storage.** `ProfileApplication` gains `adoptedPackRef`, so the orchestrators
  that now register an adopted pack never compose `.wai/packs/<name>.yaml` themselves.
- **`wairon init` completes what is missing.** A folder holding `.wai/project.yaml` but no spec tree used to get its
  configuration overwritten with defaults. Init now keeps the existing configuration and bootstraps only the missing tree
  — the rule `createChainedSubsystem` and `ensureProjectInitialized` already follow.
- **The public library `loadProjectConfig` keeps throwing** when a project has no configuration. The core read returns
  null; `@wairon/cli`'s main entry keeps today's contract through a small wrapper, so 2a-0 changes no programmatic API.
  Switching it waits for a release that announces it.
- **`saveProjectConfig` leaves the public library entry now.** It replaced the whole file without validation and dropped
  unknown keys, and the Repository deliberately has no whole-file write. Library users move to the intent-level writes;
  the CHANGELOG's Upgrading section says so.
- **Wairon's authoring friction is fixed in a small pull request between 2a-0 and 2a.** Stage 2a leans on
  `sdd_update_spec`, and every agent in 2a-0 hit the same traps. The pull request covers:
  - a write that changes nothing says so and names the ignored keys, and nested `[]` and step-level `unset` work;
  - changing a step's type replaces the step instead of merging the old type's fields into it;
  - a per-type field check replaces `MALFORMED_FLOW_STEP`, and the seven stale steps in wairon's tree today are fixed;
  - `sdd_update_spec` documents that labels resolve in deltas.

  The rest goes to the doctrine and authoring-UX track: call conformance by import origin rather than name, a per-method
  `sourcePath`, nullable parameter types, params upserted by name, delete guards, and structured calls on intent-only
  methods.

  **Revised by the maintainer after PR #70 opened: most of the friction is resolved, not deferred.** The tool must be
  clear and truthful — no unneeded silence or confusion — so a write that changed nothing, a check that skipped, or a
  suppression that silently covers a new case are defects, not UX polish. The friction log
  ([`wairon-friction-2a0.md`](wairon-friction-2a0.md), F1–F27) is triaged into truthful authoring tools, conformance that
  never goes quiet, and delegation; each fix goes to the maintainer as a proposal with a before/after example before it is
  built ([`friction-fixes-proposals.md`](friction-fixes-proposals.md)).

  Decided for the authoring tools:
  - a key that has no effect at its depth refuses the whole write, naming the path;
  - a write that changes nothing answers plainly "No change … — nothing written", not an error;
  - a step's type change keeps `description` and `label` unless restated and drops every field the new type cannot
    have, listing them;
  - `FOREIGN_STEP_FIELD` is a warning, and `wairon doctor --fix` removes those fields.

  Decided for conformance:
  - a call step is realized only by a call that resolves to the target's source file; a callee whose origin cannot be
    resolved is `CALL_ORIGIN_UNRESOLVED` (warning), saying why — nothing passes on its name alone;
  - an intent method declares the calls it makes, and the fallback that made every collaborator reachable is removed;
  - source roots are opt-in per project, and an unclaimed file under them is `UNCLAIMED_SOURCE_FILE` (warning).

  **A principle the maintainer set while reviewing lint allows:** migration cost is never the reason to keep a weaker
  design — the tool is still being developed, and big changes for the better are allowed. Every feature and fallback
  needs a reason in what it does, and follows how real code and generic linters behave. The first lint-allow proposal
  (keep target-less allows, list what they silence) was rejected on that ground.

  Decided next:
  - **Lint allows are site-precise.** Every finding carries its site (a method, step, field or dependency target), and an
    allow names the site it covers, matching only that — like `@ts-expect-error` or `eslint-disable-next-line`. There is
    no wider allow scope; wider suppression goes through the explicit dials that exist (`conformance: off`,
    `rules.sddRuleSeverity`). Existing allows are rewritten.
  - **Co-located components are checked as units.** In a shared file, a component realized as an object or class owns its
    members; an undeclared call from one unit's member to another's is `UNDECLARED_COLOCATED_CALL` (warning). Top-level
    helpers stay shared, a stated limit.
  - **Types gain `sourcePath`/`symbol` now**, reversing "type conformance later": type methods must exist in code, and
    call steps to them are checked like component calls.
  - **Delivery: three pull requests, all before stage 2a** — authoring tools, then conformance, then delegation — each
    spec-first. Also taken as planned: worktree validation limited to the bound root, its subfolders or git worktrees of
    the same repository (refused on the hosted data plane); a method-move tool; every unmodelled MCP tool and validator
    contract modelled.
  - **Spec authoring is its own bounded context, `sdd_authoring`.** Gated writes were already a layer of their own in the
    code (access paths → authoring → specs + rules) but modelled nowhere. `sdd_authoring` publishes `writeSpec` and
    `updateSpec`, runs the gated write in an Orchestrator, and reaches core and validator through client Adapters, so
    dependencies run one way; placing it in `sdd_core` would have made core and validator depend on each other. Delta
    semantics and the per-type step fields are type methods (`spec_delta.applyTo`, `narrative_step.foreignFields`), not a
    Specialist.
  - **Authoring writes return structured JSON** — `{ written, changes: [{ path, change, dropped? }], notices }` with a
    one-line summary — as `sdd_validate_tree` does; "No change" is `written: false` with no changes.

  Decided after a spec-coverage audit (2026-09-13):
  - **The validator's rules are designed in the spec tree, starting in PR A.** Asked why A12 needed no spec change, the
    audit found no reason on record: the tree models the rule Repository and the rule types, but the behaviour of all 43
    rules is one prose step in `spec_validator_impl.validateSddTree`, and 11 of them are not named in it. PR A and PR B
    add or change nine rules, which would otherwise all be written code-first. The rule model is part of PR A's L3, so
    PR A's L4 waits for it; its shape is proposed separately.
  - **Everything else the specs leave out is track D, spec coverage.** 148 of 234 source files are named by no spec, and
    none is left out for a recorded reason: 17 are designed but their file is not linked (B3, B8), 13 are named only in
    prose (B6), 32 have no component or contract (agent-file exporters, realtime and its WebSocket transport, the
    permission-model migration, domain detection, AI guide files, project context, execution budgets, the version
    stamp, the demo seed, and plumbing), and the React app's 42 files rest on one unrecorded note ("presentation,
    outside the SDD model") that the standard does not support. A legitimate exclusion stays claimed: generated or
    vendored code with `conformance: off`, a private helper by the component whose step it performs. `UNCLAIMED_SOURCE_FILE`
    (B8) makes the list visible; each area is then designed spec-first. Stage 2a changes none of them, so track D does
    not block it. If UI is ever declared outside SDD, that decision and its reason go into the standard.
  - **All 43 rules get full narratives in PR A**, not intent first.
  - **Any L3 method may declare `findings`** — each code it reports, with severity and summary — checked against its
    source file (`UNREALIZED_FINDING`). The rules use it; so can a compiler pass, an API validator or a policy engine.
  - **The rule model's shape is sparred before it is chosen.** The maintainer lacked the context to pick between rule
    families, one component per rule and one contract with many implementations, so a Fable 5.1 agent reviews the shapes
    against the code, and each candidate gets a side-by-side impact sheet
    ([`responses/fable-5.1-rule-model-spar.md`](responses/fable-5.1-rule-model-spar.md)). Its recommendation, verified in
    code by the lead: rule families tied to code folders, one rule per file (B′). **Chosen by the maintainer.**
  - **Order before PR B, for shape B′: a schema PR, then the rule model, then PR A.** The schema PR adds a per-method
    `sourcePath` (B3, moved up from PR B) and `findings` on L3 methods; its rule-code changes are the one step taken before
    the rules have specs. The rule model PR designs all 43 rules with full narratives, adds `UNREALIZED_FINDING` and the
    catalog test, and refactors the rule code to match without changing behaviour. PR A then carries the authoring tools,
    with A4 and A12 as spec changes to their rules first.
  - **The schema PR's L3 is approved, with two refinements.** `UNREALIZED_FINDING` lands with `findings` in the schema PR,
    so the field is checked from the day it exists; the rule model PR then designs it with the other rules. And wairon's
    own designed methods whose code lives in another file point at that file in the same PR, which fixes whatever the
    checks then surface.
  - **A method names another file only when its own body lives there.** A scan of wairon's tree found 248 methods with
    no body in their implementation's file. Most are not candidates: a Portal or Adapter that forwards by import or
    re-export is realized by that forwarding; a body in a collaborator's file belongs to the collaborator; and shared
    plumbing (`utils/fs.ts`, `utils/yaml.ts`) is no single component's code. That leaves 25 links in the schema PR —
    `cli_runner`'s 20 command methods and `core_orchestrator`'s 5 provision methods. `approval.ts`, `config/loader.ts`
    and `diagram-export.ts` hold code no modelled method owns, so they wait for track D instead of being claimed by a
    forwarding method.
  - **What linking surfaced is fixed in the schema PR, because `validate --ci` fails on warnings.** Linking made 12
    warnings visible that the unclaimed command files had hidden: `init` and `generate` import core and skills internals
    directly, `list` and `show` resolve the topology outside the core adapter, and `runMcpInstall`'s body is split between
    the CLI action and the adapter. Approved fixes: `cli_core_adapter` gains `resolveAgentTopology`,
    `ensureProjectInitialized`, `listDirectChainedSubprojects` and `defaultPackSelections` (forwarding through
    `core_portal`, and to `core_orchestrator` or `extension_orchestrator`); `project_config.activeTargetTypes()` becomes a
    type method; `init` bootstraps L0 through core's `ensureProjectInitialized` instead of writing it a second time;
    `generate`'s redundant cache invalidation goes; the MCP install action is named and bound by `symbol`. Routing `init`
    through the skills adapter also showed the whole `exportSddSkills` chain declaring `(): void` while the code has
    always taken optional target types and returned the export result; the four contracts now say so, with a
    `skills_export_result` type. The public library entry keeps core's `activeTargetTypes()` through an explicit
    re-export, beside the new pure `activeTargetTypes(config)` in models.
  - **`wairon init` stops writing its own architect agent file.** It rendered a bootstrap-only `agent-architect` file even
    though agent files are opt-in (`materializeAgentFiles`, off by default) and the next `wairon generate` removes managed
    files. Agents are live briefs; a project that opts into files gets them from `generate`, rendered from the resolved
    topology.

## Rule model, doctrine and data model (2026-09-14 and 2026-09-15)

- **Rule model PR.** L2 approved 2026-09-14: eight arbiter families, `narrative_graph_projector`, and `rule_registry`
  depending on `rule_store` and the eight. L3 approved 2026-09-15. `spec_validator` becomes an Orchestrator
  ("validating sounds like a clear task, a workflow to process"). `rule_store` gains `clear`, the reset
  `registerBuiltinRules` performs today.
- **Empty optional arrays.** A delete that removes the last element also removes the property (F30, folded into A2).
- **Logic is an Orchestrator (E6, E7).** A flowchart that may nest others down to leaf logic; its variant declares a
  dependency class the validator enforces (`pure`, `read`); Specialist retires. An external tool such as Semgrep is an
  Adapter plus an Orchestrator; wairon's own rules stay rule logic.
- **Process and data access (E8, E9).** An Actor holds the runtime state of one live thing, entity instances included,
  and its methods are full flowcharts; a Supervisor owns the set; an Orchestrator holds only collaborators and has one
  or more cohesive methods (a class or a module). A Store covers one aggregate; `Query` joins the Repository members.
  Entity Framework maps onto the model: the DbContext is the database Adapter, mappings and `Include` joins implement a
  Store, cross-aggregate projections are read-model Queries.
- **E10.** Complexity: a level from a cognitive score plus a step count, each with a warning and an optional max;
  defaults warn above moderate and above 25 steps, no max ("easy to change, experience will tell"). Naming checks:
  stutter, generic words, role word versus component type, a one-method component named after its method — more checks
  welcome. Entities as table schemas: one type with persistence metadata, relations on fields, derived read models
  instead of `extends`, a schema producer, migrations left to the ORM. The live auction becomes the standard's worked
  example, with its six process rules (Actor addressing through the Supervisor, single writer, workflow-owned
  transactions, Supervisor trees, Portal to Supervisor, deadlines as aggregate fields).
- **Doctrine ships as two PRs (2026-09-15).**
  - D1, blocks: Specialist retires into Orchestrator with a dependency class; process-layer rules; Query as a Repository member; hidden-state for Supervisor and Actor; Gateway containment; the gate-hash decision; `LOGIC_STEREOTYPES`; the standard and the auction example; wairon's tree migrated with names that say what each component is.
  - D2, checks: complexity levels, naming and cohesion checks, the narrative splits they require, doWhile/try unavoidability, and draft checks as type methods.
  - Reason: the checks would flag names and narratives D1 changes, so they land on the final shapes.
- **The dependency class is a first-class field (2026-09-15; revises E7's "a variant declares a dependency class").** A logic component carries `dependencyClass: pure | read`, which the validator enforces as it enforces a Store's `durability`; unset means a workflow. Variants stay guidance-only, as chartered, and are rebased onto Orchestrator. Reasons:
  - variants load only from the global and project registries, so nothing enforced can live there;
  - the variant charter is "identity and guidance at zero rule-matrix cost";
  - shapes split across classes: of 6 projectors, 2 are handed their input and 4 load it; of 3 composers, 1 and 2.
- **D1 L2 approved (2026-09-15).**
  - The 27 Specialists become Orchestrators (18 `pure`, 9 `read`; shape variants kept), and 14 are renamed for what they are responsible for.
  - `mcp_server` becomes an Orchestrator: `createMcpServer` builds a server on each call and supervises nothing.
  - `host_server` stays the root Supervisor. A `backup_schedule` Actor owns the 60-second backup timer, and an `instance_bootstrap` Orchestrator takes over the boot seeding, since a Supervisor reaches Repositories only through workflows.
  - A pure `gate_identity` in `sdd_validator` computes the gate identity (option C): no new subsystem edge, and core compares a lock with the gate id its caller passes.
  - Renames go through a new `sdd_rename_component` that rewrites every reference, extending the provisioning rewriter to the positions it misses.
- **D1 L3 approved (2026-09-15).**
  - A Query lives only inside a Repository (`UNOWNED_QUERY` is an error).
  - There is no Actor-specific dependency rule, revising E9. §7 sanctions a standalone Store for every workflow-layer block, Actors included, and existing rules already cover the rest: visibility guards owned members, REGISTRY_WITHOUT_STORE flags an orphan Registry, and the dependency DAG rejects an Actor depending on its own Supervisor.
  - Open: the maintainer asked whether a Gateway is a variant of a Portal rather than a pattern.
- **Variants are built in; a gateway is a Portal variant (2026-09-15).**
  - The maintainer expected variants to ship with wairon, and they did not. The loader reads only `~/.wairon/variants` and the project's `.wai/variants/`, and the four shapes existed only in wairon's own project, although §8 presents them as registered shapes.
  - D1 ships a built-in variant layer under the global and project directories, with later layers overriding by id:
    - arbiter, projector, composer and codec, based on Orchestrator;
    - `gateway`, based on Portal: a Portal that authenticates, authorizes, validates or rate-limits before dispatching by calling that logic, and declares its inbound auth in `auth`.
  - The Gateway pattern retires:
    - `GATEWAY_CONTAINMENT` goes;
    - facade forwarding covers Repositories only;
    - the cross-subsystem rule no longer accepts a Gateway as a front door;
    - `STEREOTYPE_RETIRED` reports a Gateway with manual steps, while `doctor --fix` retypes a Specialist.
  - The dependency class stays a field. Of the three reasons for it, the missing built-in home no longer holds; the variant charter and the split shapes still do.
  - Modelling the variant registry stays with track D.
- **D1 L4/L5 approved (2026-09-15).**
  - Modelling `runDoctor` exposed `wairon doctor`'s direct core imports.
  - They are acknowledged with a reasoned UNDECLARED_DEPENDENCY allow on `cli_runner_impl` that names the unmodelled areas: legacy filenames, subproject config backfill, context sync, stamps, guide injection, skill freshness, approver text and pack diagnosis.
  - Routing them through modelled adapters belongs to track D, which designs those areas.
- **Decider order clarified (2026-09-15, while writing the standard).** E9's "decide → apply → act" contradicts rule 3 of the auction example ("in-memory state changes only after commit"). The standard teaches decide → persist → apply → act: a pure Orchestrator decides from the state and the message, the owning method writes the result in one transaction, the Actor applies it to its own state only after commit, then acts through its collaborators.
- **The write gate refuses an edit that keeps a retired stereotype (2026-09-15, found by wave 2; follows from the approved L3).** `retired-stereotypes` is spec-scoped, and spec-scoped rules run in the write gate, so `sdd_add_component` or `sdd_update_spec` is refused when the result is still a Specialist or a Gateway.
  - An edit that retypes the component passes, and `wairon doctor --fix` retypes without going through the gate.
  - An unmigrated tree is migrated first, then edited: wairon's own tree runs `doctor --fix` before its renames.
- **Order.** Schema PR → rule model PR → rule fixes PR → doctrine D1 → doctrine D2 → data-model PR → PR A → PR B → PR C → track D → stage 2a.

## Still open

§8 #16–#17 (stage 8).

## Stage 2a identity — no save-time backfill (2026-09-26)

- **An ordinary save never writes a defaulted project id** (reverses §11's "writers backfill on the next save"). A default can be wrong: an existing chained child answers to its mount's subsystem id, which a plain config save cannot know, so a backfill could persist the name slug for good. Only deliberate writers set an id — init, provisioning, hosted creation, and doctor (2c's `doctor --fix` for existing projects). `PROJECT_ID_DEFAULTED` says no save writes it. Wairon's own `.wai/project.yaml` declares `id: waffle-airon`.

## Stage 2b design (2026-09-26)

- **Per-root configuration read.** The project graph needs each root's id and externals, so the spec scan reads each root's `project.yaml` through the same per-root binding it already uses for that root's specs folder (`aiPathsAt` → `projectConfigRepositoryAt`). Doctrine: a scan may read the configuration of the root it is walking, through that root's binding. `project.yaml` joins the scan's freshness signature.
- **One default id everywhere.** A project without a declared id is `slug(name)` in every reader, the graph included; there is no mount-alias default (supersedes §11's "a chained child's default id is its subsystem id" for existing children — new children are still created with it). A mounted child's PROJECT_ID_DEFAULTED names the mount's subsystem id as the id to declare; 2c's `doctor --fix` writes it.
- **Gate inputs** extend `core_orchestrator.consumedContractInputs` (no `computeGateStateId` exists on core; the validator computes it).
- **EXTERNAL_UNRESOLVED** (notice) added: a declaration that resolves to no producer.
- **DEPRECATED_REFERENCE_FORM** fires only on leading `::` in 2b; `super::` waits for stage 3's `alias::name`, since wairon's own writer emits it.
- **`source.path` externals** have empty `used` in stage 2 (no stage-2 reference form reaches outside the family); status reports EXTERNAL_CHECK_UNAVAILABLE. Directly-used types are pinned only through signature closures or typeDef exports until stage 3.
- **`externals_repository`** (sdd_surfaces) is its own Repository; `surface_repository` keeps only the legacy `.wai/surfaces` aggregate.
- A project-level named re-export cycle is an error, like any named cycle.

## Stage 2c design (2026-09-26)

- **`chaining_migration_orchestrator` lives in sdd_cli** (the design's premise of sdd_core was false: a core or surfaces workflow calling the gated seam closes a subsystem cycle). Its producer L0 export entries go through the gated authoring seam. Doctrine amended: repairs that restate what is already there stay ungated; a migration that authors new spec content goes through the seam.
- **F82 fix uses the `yaml` package (v2)**, in the project-config file adapter only: the save edits the parsed document, so comments, order and quoting survive, and new keys land at their schema-order position. (The premise that the repo's YAML library keeps comments was false: it is js-yaml.)
- **A member with its own lock keeps the id its lock approved**; writing the mount id would raise PROJECT_ID_CHANGED and deadlock the re-lock. The mismatch is reported (`id-locked`); moving it is the stage-6 rename.
- References keep their form (stage-2 §6, not the "rewrites the consumers" line above); legacy `.wai/surfaces` pins stay on disk until stage 3; no `removeExternal` until a caller needs it; no MCP tool in 2c; a family only partly in reach blocks apply.

## Stage 3 preconditions (2026-09-27)

- **#12 Mounts move to `project.yaml members:`** (shorthand `members: { billing: services/billing }`, alias = key). The L1 `projectPath` still loads for one release with a deprecation notice; `doctor --fix` moves each mount. Mounts stop being subsystems with content, so the loader needs no position-based merge or root anchor.
- **#13 Family-wide migrations may write into members**, named and dry-run first, refused when a member is absent — already the practice of 2c's `doctor --fix`.
- **#20 `billing::billing` is accepted**; ids stay honest everywhere, and only the canvas displays the collapsed name when alias and subsystem coincide. Probe P3 (grep surface/OpenAPI/share outputs for a doubled id in a display name) runs before stage 3 ships.
- **#22 One project is mounted at most once; no instance ids.** The maintainer challenged the premise: instances of one project (EU/US) are deployment, not design — the same code and specs, with the instance a runtime detail such as an environment variable the logic reads. wairon's spec tree is logical architecture. A project used in two roles is modelled as consumption (two components depending on one producer — externals already allow many consumers), never as two copies of its tree; copies would be identical, and differently configured copies are configuration, which the design layer does not model. Instance ids would thread through every reference, pin, lock, approval and hosted grant without answering a design question. Two mounts resolving to one project id are `PROJECT_ID_COLLISION` (error), whose message points at consumption.
- **Probe P1 run on a real family (Waffler, 2026-09-27)** with 2c's `doctor --report chaining`: 16 projects (top, 14 members, one nested member), 13 ids to declare, 13 L0 entries (transpiler -> waffler_core portals), 18 externals (13 of them the converted stage-1 family pin), 156 superseded sibling pins (the stage-1 full mesh; no reference relies on any), 51 findings. About 100 cross-project references, all `alias::name`-shaped already (alias = mount), plus ~19 `super::` and ~47 leading `::` forms. Stage 3's rewrite is therefore small here; the removal of sibling pins is safe.
- **A project exports its own project-level types by explicit L0 `typeDef` entries** (no `from`, like `pub struct` at a crate root). Found by P1: `shared` is a vocabulary project of 462 types with no subsystems and no L0, so under decision 9 nothing in it was consumable (49 of the 51 findings). The migration creates a minimal L0 for a project that has none (new content, gated seam) and adds entries only for the types consumers use. A project-level type wildcard was rejected: it would make every type public contract.
- **`PROJECT_DEPENDENCY_CYCLE`** (warning in stage 3, error in stage 5 where approval pins need an acyclic graph), naming the edges that close the loop. Found by P1: `shared` <-> `waffler_core` (three `*-mode` types).
- **Report output fixes ride with stage 3:** superseded sibling pins collapse to one line per project; projector messages no longer leak into the report; the "does not hold" wording for project-level types is corrected.

## Stage 3 design (2026-09-27)

- **Members are keyed by project id** (`<id>::<local id>` at any depth; the bound root's own specs bare) — the only key that is both root- and depth-invariant (synthesis §5, R9). Waffler's transpiler subtree re-keys from `waffler_core::transpiler::*` to `transpiler::*`; one re-lock.
- **Mount paths get one release of grace** like `super::` and leading `::`: a first segment the referrer does not declare is read from the bound root and reported as a deprecated form, so ~400 of Waffler's references keep resolving until `doctor --fix` rewrites them.
- **Correction:** `shared` (and every Waffler member) has an L0 (`.index.yaml`); the earlier "no L0" claim was a directory listing that hid dot-files. The migration reports any non-schema key its first gated L0 write would drop (e.g. `status: draft`) and asks for confirmation with the rest.
- A mount's `description` moves to the member's long form in the parent's `project.yaml`; a mount's `publicInterfaces` entry becomes a child L0 export at audience `project`.
- `DUPLICATE_SPEC_ID` covers types (error), naming both files (Waffler: the transpiler's `cpu-primitive-binding` in `cpu` and `cpu-x86`).
- A type exported only inside a signature closure and named directly is EXTERNAL_NOT_EXPORTED (notice).
- wairon's own mount writers switch to `members` within stage 3.
- **Second design pass (writers, hosted, status):** `saveSubsystemSpec` is deleted and its callers move to the generic `save` (migration cost is no reason to keep it); no `sdd_set_member_path` (members are configuration like externals; `sdd_move_member` relocates); renamed tools and commands (`sdd_add_member`, `sdd_move_member`, `sdd_internalize_member`, `wairon member add|move|internalize`) get no aliases — the release is major and the CHANGELOG names each rename. Hosted token qualifiers keep their text; each hop is read as a member alias, so every existing token binds the same root and nothing widens (re-keying to project ids is stage 7).
- **Stage 3 code ships in three waves on one branch** (A resolution, B writers/tools/hosted/status/docs, C migration proven on a temp copy of Waffler), one PR and one lock.
- **Wave B follow-ups (decided 2026-09-27, implemented in wave C):**
  - `member move` on a legacy mount whose L1 spec carries fields beyond path and description (`publicInterfaces`, `trustedLinks`, `lint`, …) REFUSES and points at `doctor --fix`, which carries them plan-first; a move never drops a field.
  - `internalizeMember` refuses while another family project references the member (listing those references); rewriting other projects is the family migration's job, named and dry-run first.
  - A parent declared as a member's external must not read as EXTERNAL_UNRESOLVED from the member's own root when the chaining climb reaches it; the notice fires only when neither the scan nor the climb finds the producer.

## Stage 4 preconditions (2026-09-28)

- **#5 Composition findings appear only in a family run** (`validate --family` at a member, plain `validate` at a parent). A member's own run judges its files and pinned externals lock only, so its verdict is identical whether or not the family is on disk; it prints a one-line hint when it has externals.
- **#14 Governance is its own stage after 4** (policy adoption, floors, `composition.requirePolicies`, POLICY_NOT_ADOPTED, POLICY_LOOSENS). Stage 4 stays about who judges an edge.
- **#11 MEMBER_UNAPPROVED / MEMBER_DRIFTED are warnings** in the family run (`--ci` at the parent fails until the member is locked or waived); a parent lock that refuses (`requireApprovedMembers`) is stage 5.
- **No `validate --legacy`.** The old evaluator (`resolveThroughParent` and its codes) is deleted outright; the upgrade instead reports what changed — every finding new relative to what the last lock recorded, grouped by code, with the reason (e.g. it was resolved through the parent before).

## Stage 4 design (2026-09-28)

- **Found:** type resolution was a case/punctuation-insensitive suffix match across every type in the scan, crossing project boundaries with no export or declaration (Waffler's transpiler uses `WafflerError` 1,129 times without declaring `shared`). Judged per project, Waffler's children would get ~5,300 new errors.
- **Declared imports (maintainer):** an external may import names — `externals: { shared: { use: ['*'] } }` or `use: [waffler-error]`. A bare name resolves to a local spec first, then to an exported public name of an external that imports it; two imports supplying one name is an error. Owner-scoped and explicit; no family-wide suffix matching. Rewriting ~5,000 references to `alias::name` was rejected: specs would read noisier than the code they describe.
- **Pin digests are canonical** — they hash the canonical contract, never a reference's spelling (the stage-3 rewrite changed five digests with no contract change); `doctor --fix` pins last. `EXTERNAL_INCOMPATIBLE` is an error only on canonical digests.
- **A stage-4 migration step** adds the `use` imports, exports, externals and pins for positional references, and rewrites the self-prefixed `registry.x` form stage 3 missed.
- A parent's own gate reads its contained members' live export tables; a parent's lock ignores member findings until stage 5's composition subjects; MEMBER_DRIFTED = the member's own lock is stale; MEMBER_NOT_FOUND is a family-run error (owner gate: unavailable); EXPORT_UNCONSUMABLE escalates to error; unknown `x::y` is EXTERNAL_UNDECLARED (error); the SDK exports `validateProject`/`validateFamily` with no alias for `validateSddTree`; the family half of project identity moves to the family member checks; judging cross-project code imports is deferred.
- The lock records only totals, so the upgrade report (`doctor --report composed-validation`) classes today's findings (escalated / pinned / positional) instead of claiming a per-code diff it has no data for.
- **Second pass (2026-09-28):** Waffler's true count is ~7,352 new errors; the migration's 237 named `use` imports, self-prefix rewrites, exports and pins clear all but ~178 (transpiler references whose name exists in both `shared` and `waffler_ui`). Tie-break: a declared producer, then one that already exports the name, else a person picks — every automatic choice shown in the plan. The migration is faithful: it adds dependencies exactly as the specs resolve today (e.g. waffler_core → waffler_ui, 96 references) and lists every NEW cross-project dependency prominently; it does not guess layers (maintainer). Named imports, not globs (maintainer). An explicit named import colliding with a local name is an error; a `*` import is shadowed by locals silently. Self-prefixed references are notices until rewritten. Pin digests ignore prose.
- **Stage 4 wave C (2026-09-29):** the positional tie-break runs in rounds — a producer declared by an earlier round of the same plan counts as declared — so one run equals running until nothing changes and the migration stays idempotent (a single-round match left 175 transpiler references for a second run). Every such choice prints as "declared-producer (declared by this plan)". Proof on a Waffler copy: family-run errors 5,689 → 120, all explained; 0 EXTERNAL_INCOMPATIBLE.

## Governance stage preconditions (2026-09-29)

- **Packs may loosen wairon's defaults, and that is legitimate (maintainer).** Packs exist to adjust the tool's checks and behaviour; a pack for an automation/integration platform — system design on a far less capable runtime — may have to loosen or remove concepts that cannot exist there. A pack's loosening is never a finding. What matters: installing a pack is intentional, its impact is understood, and it is applied per project. (Supersedes the synthesis's `POLICY_LOOSENS` framing.)
- **The policy unit is a pack selection.** A parent's `composition.requirePolicies` names extension packs by **semver range** (optionally one profile inside a pack); a member adopts by selecting the pack in its own `extensions.packs` (exact version + digest, as today). No new policy format; the hosted instance floor and profile selections coexist.
- **A required pack a member does not select is `POLICY_NOT_ADOPTED`** in the family run (composition, never the member's own gate). A member that selects a version outside the range is reported the same way, naming the range.
- **A member's local deviation from a required pack's settings is visible, not blocking:** `POLICY_DEVIATION` (notice) in the family run names the setting, the pack's value and the member's; `--ci` never fails on it (a team may raise it with sddRuleSeverity).
- **Pack impact report:** selecting or updating a pack (CLI, MCP, hosted) first shows its impact against wairon's defaults — rules loosened, raised, turned off or added, concepts removed or added, and the findings that change on this project if applied (a dry validate); on demand as `wairon packs impact <pack>`.
- A new member is scaffolded with its parent's required packs, once, at creation; afterwards it is the member's own selection.
- **Governance design pass (2026-09-29):** requirements use an npm-style semver subset (no new dependency; member selections still pin exactly); a floating selection of a required pack is POLICY_NOT_ADOPTED ("unpinned") — never judged by the machine's loaded version, so the family verdict stays location-independent; `*` admits an unversioned pack; a malformed range is POLICY_REQUIREMENT_INVALID at the requiring project's own gate; POLICY_DEVIATION covers every profile-overridable setting (severity, depth, subsystem profile, lint.allow, naming, complexity, documentation); a pack redefining a builtin profile is reported as a change, never a finding; impact is shown for use/add/install/unuse/remove and hosted install, and hosted policy writes (reconcile, ensure-profile, init-with-profile) carry their impacts in their results; the hosted preview needs project:read; the command is `wairon pack impact` (+ read-only `sdd_pack_impact`); a requirement from above the bound root is judged only from that ancestor.

## Stage 5 preconditions (2026-09-30)

- **#10 A lock certifies the design under its declared inputs** (specs, doctrine, externals lock, adopted packs, members' composition subjects). Code-conformance results are recorded in the lock beside it, with the analyzer's identity, but are not part of the approval claim — an analyzer upgrade never invalidates an approval.
- **#15 Composition subjects.** Each project locks itself; a parent's lock records each direct member's composition subject (a hash of that member's own approved state, its members' subjects included), so the family's approval is transitive by hashing and a parent lock never writes below itself. Replaces the `children` StateId copy, which was never re-verified. The lock format is versioned: `children` read, `members` written.
- **`composition.requireApprovedMembers` is opt-in, off by default.** By default a parent's lock proceeds and records each member's state (approved / drifted / never); with the flag it refuses. MEMBER_UNAPPROVED / MEMBER_DRIFTED stay warnings in the family run.
- **No generate cascade.** `generate` at a project writes only that project's outputs; `generate --family` walks the members explicitly.
- `composition` joins the gate identity (deferred from the governance stage), so a changed requirement stales the requiring project's lock.
- **Stage 5 design pass (2026-09-30):** a member's subject is the stateId in its own lock record (read, not recomputed) — so a change two levels down reaches the top once the middle re-locks, and until then the top shows the middle as drifted. **Code-conformance findings no longer block `wairon lock` (maintainer):** the lock refuses on design errors only and records code findings beside the claim; `validate --ci` still fails on code errors, so CI enforces conformance, and a design can be approved before it is implemented (the SDD flow). The code-judging rules, `rules.conformance` and `sddRuleSeverity` overrides of code codes form the analyzer digest, outside the gate identity. Hosted approval requests pin the gate identity at request time; a missing member is `never`; `lock-check` stays about the project's own claim; the lock format is versioned (format 2: `members`, `code`; `children` read one release).

## Stage 6 preconditions (2026-09-30)

- **Verbs:** `attach` (adopt an existing project as a member, keeping its L0 and subsystems), `rename` (project id; rewrites every reference family-wide), alias rename (parent-local; members change nothing), `detach` / `adopt` (relation edits; references to a detached member become externals with `source.path`), multi-subsystem `internalize` with an explicit destination for the member's own metadata (today it deletes the member's whole `.wai`); `move` exists. All plan-first, confirmed, refused when a project to write is absent or out of reach; MCP tools gain `dryRun`.
- **Staged, all-or-nothing (maintainer):** apply stages every file change in a transaction directory with a backup of every replaced file, then swaps them in; any failure restores every backup and reports what failed — the family is fully migrated or exactly as before. A crash mid-swap leaves a journal that `doctor --fix` rolls back.
- **A rename never writes a lock:** it lists every project to re-lock; the id is part of what was approved. Hosted records wait for stage 7.
- **Stage 6 design pass (2026-09-30):** new subsystem `sdd_migrations` (migration portal, verb families membership / identity / boundary, `family_transaction`, a transaction Repository). Apply by **rehearsal**: the verb's own writers run on a copy of the family's `.wai` trees; the byte difference is the plan; stage with backups under each owner's `.wai/transactions/<id>/`, swap by rename (retrying Windows sharing violations, refusing cross-volume), restore on any failure, crash journal rolled back by `doctor --fix`. Rename keeps `previousIds` and reports PROJECT_ID_RENAMED (notice) until re-lock; an alias equal to the old id follows the rename. Internalize refuses a member with conformance debt; its L0 requirements/boundaries go to the parent's L0; packs need an explicit adopt/drop. detach→adopt: member byte-identical, parent semantically identical. Outside consumers get a prominent note. Every verb has an MCP tool with dryRun. **The chaining and position migrations move onto the transaction in this stage** (they could leave a family half-migrated), and a pending transaction shows as a banner in status and validate.
- **Stage 6 wave B follow-ups (2026-10-01):** `member detach` refuses when a detached member's used exports are narrower than `instance` (a path external only sees `instance` and wider), listing each export and its users; **`--widen` (maintainer)** adds widening exactly those used exports to `instance` in the member's L0 to the plan — new content through the gated seam, shown and confirmed, never silent. Planners do no file-system I/O themselves (containment/realpath/exists checks move to the family file adapter). Internalize stamps only valid subsystem profiles and reports the rest. detach→adopt: member byte-identical when detach did not write it, semantically identical otherwise (a registry save fills schema defaults).

## Stage 7 preconditions (2026-10-01)

- **#18 Explicit grants at upgrade (maintainer).** Membership never implies permission. At upgrade, every principal that reaches a member today (through its parent) gets an explicit grant on the new member record — exactly today's reach, nothing wider — listed in the upgrade report and audited. Afterwards a member is permissioned like any project: a "no" at the member's unit always wins, and parent and member grants are independent.
- **Member git binding: the parent's repository, scoped (maintainer).** A contained member is committed through its parent's repository under its path — one repository per family; a family commit covers every member it touched; a member's own history is the path-filtered log. A member gets its own repository only by being detached.
- **Stage 7 design pass (2026-10-01):** today a member request is authorized over the family root's record, so a member's "today's reach" = the root's project-scope settings over the root's unit placement; the upgrade copies the placements, every project-scope assignment (no and approval included) and the role bindings at that scope — identical resolution for every principal, later users included. **A member registered after the upgrade gets the same one-time, audited copy of its parent's reach at that moment (maintainer)** — not inheritance; afterwards independent. "No wins" = a no on the member's own record beats anything on the parent. A family-root token entry expands to its member ids (today's reach). Family migrations on hosted auto-commit as ONE commit covering every member (other hosted writes commit on request). The record stores memberPath (checked at bind; reconcile relocates). A hosted `project rename` re-keys grants, placements and token narrowings onto the new id. Hosted `member detach` refuses while the member's directory is inside its parent's tree. Recover-on-bind moves into member registration. Fixes found: hosted member specs were never committed; the backup mirror missed members.
- **REVERSED (maintainer, 2026-10-01): hosted access is INHERITED through the project chain**, replacing #18's explicit grants. Access to a project gives access to all its members, transitively — exactly as access to an org, department or team unit covers everything below it; projects nest like units. The resolver gains a project → parent-project rung: a member's chain is its own scope → parent project → … → the family root's unit chain → instance, most specific wins, so an explicit no on a member beats an inherited yes. Consequences: the upgrade copies no grants (reach is equal by construction; the no-widening comparison stays as a pre-write safety check); no copy at registration; tokens naming a project cover its members; a rename re-keys only member-own settings. Because membership now changes reach, hosted attach/adopt/reconcile (widen) and detach (narrow) list per principal who gains or loses access, and audit it. Finer-grained denies below a project (e.g. one subsystem) are a separate later feature (maintainer).
- **Stage 7 third pass (2026-10-01):** hosted detach RELOCATES the member (its files leave the family tree as deletes and arrive in a new isolated root as creates, inside the same family transaction; the record becomes top-level; the plan lists everyone who loses access); consumers across roots use `source.hosted: <record id>` (owner gates still judge only pinned snapshots; live status is unavailable off-host or out of reach, never a pass). Hosted adopt relocates back (detach→adopt is the identity on hosted too). Placing a member in a unit refuses (a member takes its units from its family root). Renaming a hosted family root's id refuses, stating plainly it is not supported. `host doctor`'s permission-model migration must never sweep members into the `unassigned` unit.

## Stage 8 — open, under discussion (2026-10-02)

- The maintainer considers side-by-side members (workspace descriptor), spec fragments and `validate --at-approval` useful, and wants polyprojects discussed properly: they are common, and wairon exists to design, visualize and keep overview of larger systems — where polyprojects are the norm. My first assessment (location dependence for side-by-side members, a second modelling path for fragments, low marginal value for --at-approval) is input to that discussion, not a decision. Concrete gap found while assessing: for a path external outside the family, `externals status` detects drift but reports per-use comparison as unavailable, so a sibling checkout that breaks a used method is not caught as EXTERNAL_INCOMPATIBLE. Order: friction items F83–F87 first, then the polyproject discussion, then the deferred items.

## Stage 8 — parts and projects (2026-10-02)

- **Composition, storage and collaboration are independent axes** (maintainer). What the system is made of, where files live, and who owns/approves what must not be welded together; Waffler mixes every shape (microservices inside core, extension projects acting as microservices, a React frontend, SDKs for language and UI, a registry), and systems like admin/core/payments may be separate repositories, languages and teams.
- **One member setting, `as: part | project`, with storage orthogonal** (contained, sibling path, git repository, hosted record). A **part** is a piece of its parent stored elsewhere: the parent's own subsystems — local ids, ordinary subsystem rules, no export ceremony, covered by the parent's lock. A **project** is an independent boundary (today's member): own id, exports, own lock. Non-contained members are pinned (part: content digest + commit; project: approved subject + commit), so verdicts stay location-independent. This replaces stage 8's separate "side-by-side members" and "spec fragments" ideas.
- **Default is `part` (maintainer): boundaries must be earned.** Start with a system and its parts; create a project by an explicit action (`member promote`, or `--project` at creation); a project's own members default to parts again. The current model was skewed: splitting storage forced a crate boundary. Existing members are migrated once by `doctor --fix` writing `as: project`, so nothing silently changes meaning.
- **A part opened alone judges against a pinned parent (maintainer):** a part records its parent and pins the parent surface it uses, so its own repository's CI is meaningful; without a pin it says "part of <parent>; validate from the parent".
- **Stage 8 design simplified (maintainer, 2026-10-02):** (1) **a member's kind follows from what it is** — a member whose own tree has an id, an L0 or a lock is a project, anything else is a part; `promote` / `--project` create that content and `demote` removes it; `as:` stays optional, only to assert intent (a contradiction is an error); no kind migration and no "inferred" notices. (2) **One location key, shorthand first** — `billing: services/billing` (contained), `admin: ../admin` (sibling), `payments: git@host:acme/payments.git#<commit>` (git at a commit), long form `{ source, as }` only when needed; leaving the root is only ever an explicit `..`. Also settled: the git commit lives in project.yaml (like go.mod) and `member update` moves it; an uncached git part offline is an error, an uncached project member falls back to its pin; promote/demote refuse git-sourced members; git and sibling sources refused on hosted for now; a per-rule `needsWholeTree` flag decides what a part alone skips; `externalize` defaults to a part; `partOf` is written only where a part cannot be found from its parent (non-contained), and its mismatch folds into one finding.
- **Stage 8 wave B follow-ups (2026-10-03):** the family transaction extends to **sibling checkouts on the same volume (maintainer)** — local files, same all-or-nothing guarantee; each repository still gets its own commit and the plan says so; another drive is refused with that reason; git-sourced members stay refused (read-only cache). A pin records a commit only when the producer lives in a different repository than the consumer (no lock churn in monorepos). Demote lists every L0 export entry it removes. A retired hosted record carries its reason. The gate identity covers a hosted referenced member through its pin, not its live subject (only the server resolves it). A referenced project keeps its own agent topology.

## Hosted access below a project (2026-10-03)

- **A subsystem rung at the front of the resolver chain (maintainer):** subsystem → project → parent projects → units → instance; nearest definitive setting wins. Parts are their parent's subsystems, so they are covered automatically. **Granularity: subsystem (and parts)** — no component-level rules.
- **Write-side capabilities only** (changing a subsystem's specs, and lock/approval where they apply per subsystem). Reading stays whole-project: validation, the canvas, agent briefs and every verdict need the whole tree, and per-user partial views would make one project look different to different people. Confidentiality inside a project is what a project boundary (promote) is for.
- **Allow and deny:** settings at a subsystem are yes/no like everywhere else — deny someone one subsystem of a project they can edit, or let a team edit only its own subsystem without project-wide write.
- **Design pass (2026-10-03):** only `project:write` exists at the subsystem rung (other capabilities resolve as the project; subsystem rules are administered by project admin); writes map to subsystems in the core's spec writers, not by guessing tool arguments; locks and family migrations are whole-tree writes (decided at the project rung; any subsystem denial refuses them); promoting or externalizing a subsystem carries its rules onto the new project record (no silent widening), listed in the plan; rules for a missing subsystem are kept but labelled "subsystem not found"; a permission explanation names the deciding rung (web/API); the signed view-link canvas stays "health not checked" (no user behind the token).
