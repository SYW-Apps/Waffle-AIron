# Changelog

## Unreleased — v6.0.0 (from v5.1.0)

**Breaking: merge dev → main with `[major]` in the merge commit message → v6.0.0.**

v6 makes a wairon project a set of **projects that name each other**. A project has
an id, its levels export like a module, and another project is reached only as
`alias::name` through a member or a declared external. A part of a system that only
lives in another folder or repository is a **part**, not a project. Around that:
approval is per project and the same on every machine, packs apply only where a
project selects them, contract types use one language-neutral grammar, logic is an
Orchestrator (Specialist and Gateway retire), and the validator checks readability
and reads the code more closely. Reach is modelled too: every Portal verb is either
called by the design or declared an entry, Portals state one `transport`, listener
`mounts` retire, projects may declare networks with gateways, and another project's
library is called directly.

Who is affected:

- **Every project:** the first `validate --ci` after upgrading reports new findings,
  and every lock reads stale once. Run the upgrade steps below. Portals are no longer
  reached just by existing, so a Portal verb that no modelled caller reaches reports
  `UNUSED_COMPONENT` / `UNUSED_METHOD` until its entry is declared.
- **Families (a project with chained subprojects):** the chained mounts become
  `members`. `wairon doctor --fix` migrates them.
- **Hosted operators:** run `wairon host doctor --fix` once. Several admin API
  answers and defaults change.
- **CI:** `validate --ci` can newly fail. The optional `lock-check` workflow is new;
  it also runs `validate --ci`, which belongs at the family root.
- **MCP clients and scripts:** some tools are renamed or removed, 16 tools declare an
  `outputSchema`, and nested unknown keys are refused. `sdd_add_component` takes
  `transport` instead of `portalType` and no longer takes `mounts`.
- **Generators reading `wairon export`:** the design export is format 2.0.
- **Library embedders:** `validateSddTree` is now `validateProject`, with no alias,
  and 99 exports are gone.

### Upgrading from v5.1.0

Follow these in order. Every `doctor --fix` rewrite moves the gate identity, so lock
last.

1. **Upgrade wairon everywhere at once:** developer machines, CI (and the
   `setup-wairon` action's `version`) and the hosted server. Then restart or
   reconnect each AI tool's wairon MCP server. A server whose build on disk changed the
   spec schemas now refuses every spec write and says so.
2. **Hosted operators: `wairon host doctor`, then `wairon host doctor --fix`.** The
   dry run prints the plan. `--fix` migrates a data dir that predates the permission
   model. It also registers every member that hosted families declare as a project
   record of its own. It grants nothing: access is inherited, so everyone's reach
   stays the same, and the plan shows that before anything is written. `wairon serve`
   warns at startup while this is pending. It also migrates every hosted project's
   spec tree onto the reachability model (the same rewrites as step 5), audited per
   project; each project it rewrote owes one re-lock by its approvers. The server
   never applies this on its own when it binds a project, because the rewrite moves
   the approved design.
   - To upgrade a hosted project's spec tree, pull it into a checkout
     (`wairon remote pull`), run steps 3–8 there, then push it back
     (`wairon remote push --force`, which backs up the tree it replaces).
3. **Read the plan first: `wairon doctor`** at the top of the project. It writes
   nothing. It lists every repair `--fix` will make, for this project and for each
   member below it. In a family, also run:
   - `wairon doctor --report chaining`, for the member migration and the new
     cross-project dependencies it adds;
   - `wairon doctor --report composed-validation`, for which of today's findings are
     new and why.
   - Read the new dependencies first. A cycle between two projects
     (`PROJECT_DEPENDENCY_CYCLE`) usually means a reference that should move.
4. **Decide on machine-wide packs.** Packs installed machine-wide no longer apply to a
   project that has not selected them. Either:
   - let the next step record the packs it applies today as explicit selections; or
   - set `extensions.useGlobalPacks: true` in `.wai/project.yaml` first, to keep the
     old behaviour on that machine.

   A subsystem whose `profile` comes from an unselected pack reports `UNKNOWN_PROFILE`.
5. **Run `wairon doctor --fix` once, from the top of the family.** In scripts, use
   `--fix --yes`. Writes outside the project root also need `--global`. It applies:
   - recovery of an unfinished family migration;
   - pack selections;
   - Specialists retyped to Orchestrators with a `dependencyClass`;
   - stray narrative-step fields (`FOREIGN_STEP_FIELD`) removed;
   - stored signature texts regenerated;
   - stored type spellings rewritten to the canonical grammar. This includes
     `Result<T, E>` → `result<T, E>`, `()` → `void`, `T[]` → `list<T>`,
     `T | null` → `T?` and `Promise<T>` → `async T`;
   - the reachability migration. `portalType` becomes `transport` (`HTTP_API` is
     `HTTP`; a `Custom` Portal that binds no wire address becomes `InProcess`), each
     listener's `mounts` become a Portal-level entry on every Portal it served and
     that Portal's implementation `router` (the mount's `via`), `invokedBy: external`
     becomes `entry` on a Portal verb and `runtime` elsewhere, an authored export
     `type` that agrees with the derived kind is dropped, in-process `Custom`
     endpoint addresses are removed, and allows of retired codes are dropped or
     renamed. It never invents design: what it cannot decide is listed for an author
     (`wairon doctor --report reachability`);
   - the member migration. Each legacy L1 mount moves into `members`, ids are
     declared, the exports, externals and `use` imports each reference needs are
     written, deprecated reference forms are rewritten to `alias::name` or a bare
     local id, and the result is pinned. The old family surface pins are deleted.

   **Members are repaired by the same run.** Every member inside the project root gets
   the per-project repairs, each line marked `[alias]`. A member in a sibling checkout
   (`../x`) is named with the command to run in its own directory.

   **Committed agent files are kept.** A `project.yaml` that never set
   `rules.materializeAgentFiles` reads as `true` while wairon-managed agent files are
   committed (or staged) in git, so the first lock keeps them. A save at the project's
   root writes `true` down. Ignored or untracked leftovers (a gitignored `.claude/`)
   do not count: such a project gets live briefs, and the lock writes no agent files.
   Outside a git repository every managed agent file present counts.
6. **Make the pack selections reproducible for CI.** CI has no pack store, so a
   declared pack it cannot get is `PACK_NOT_INSTALLED`, and every command refuses.
   Either:
   - run `wairon pack bundle --all` and commit `.wai/packs/`; or
   - record a fetchable source (`wairon pack use <name> --source <url>`) and run
     `wairon pack sync` in CI (or the `setup-wairon` action with `packs: sync`).

   A pack installed from a local path has no URL, so bundle it. Otherwise it reports
   `PACK_SOURCE_UNFETCHABLE` and fails `--ci`.
7. **Settle by hand what `doctor` lists but never writes:**
   - **Gateways.** The Portal the Gateway owns becomes the front door, with
     `variant: gateway`. Its other members become that Portal's dependencies, its
     consumers depend on the Portal, and the Gateway spec is deleted.
     `sdd_rename_component` can give the Portal the Gateway's id.
   - **`number` positions.** Write `int` or `float`. `doctor` proposes `int` where
     the name says a whole number.
   - **String-literal unions.** `doctor` proposes an enum (its id and values) but does
     not write it. Define the enum with `sdd_add_type` (`kind: enum`), then write its
     id in the position.
   - **Type forms the grammar leaves out.** Each is named with its replacement. An
     inline object or a mixed union becomes a value-object, and a single value gets a
     named scalar (`holds`). An inline function type becomes a `signature` type.
   - **Migration findings.** These include `positional-ambiguous` (pick the
     producer), `import-shadowed`, `import-collision` and `target-unpublished`
     (export the target, or move the reference). A legacy mount that carries
     `trustedLinks`, `lifecycle`, `profile`, `targetLanguage`, `designDepth` or `ext`
     blocks the migration until that member holds the field itself.
   - **Supervisors.** A Supervisor narrative that calls shared data must call methods
     tagged `effect: read` or `effect: lifecycle`. Move each write into an
     Orchestrator.

   Write these through the MCP tools, which regenerate a method's signature text. A
   type you change by editing the spec file leaves `SIGNATURE_TEXT_STALE` until you
   run `wairon doctor --fix` again.
8. **Run `wairon validate --ci` and work through the findings** (`--all` prints every
   one). Most are covered by the codes table below. The usual remedies:
   - Split a coarse `lint.allow` into one allow per site (`at:`). The
     `UNUSED_LINT_ALLOW` finding lists the sites.
   - Delete allows that name retired codes, and allows whose finding no longer
     fires (`UNUSED_LINT_ALLOW` says "no such finding fired").
   - Write a method's `calls` where its narrative shows no steps.
   - Declare the entries the migration will not invent. A Portal whose callers are
     outside the design takes a Portal-level `invokedBy: { kind: entry, caller }`:
     a CLI, a stdio tool surface (`transport: JSONRPC`), a library or SDK
     (`transport: InProcess`), and any HTTP Portal no listener mounted. Never declare
     one only to quiet a finding.
   - Settle every other unreached verb: model the caller that really calls it, or
     remove it.
   - Make a member's parent-relative `sourcePath`s relative to the member.
   - To soften a warning while you pay it down, set it to `notice` in
     `rules.sddRuleSeverity` (notices never fail `--ci`).
   - Re-pin with `wairon externals pin` after editing what a consumer uses.
9. **Lock bottom-up: each member project first, then the top.** Run `wairon lock` at
   each project's own root and commit `.wai/lock.json`. A part has no lock of its
   own: the parent's lock covers it.
   - `lock` refuses only on design errors. It records code-conformance results beside
     the approval and does not block on them, so a passing lock alongside a failing
     `validate --ci` is expected until the code findings are paid.
   - `lock` no longer writes `status: complete` into spec files.
   - A lock written by an earlier v6 build (format 2) still passes while nothing it
     covers moved. Run `wairon doctor --fix` to re-express it as format 3: who
     approved it and when are kept, and the record notes `reexpressed`. One that
     already drifted needs one `wairon lock`; after that, linking code never
     drifts it.
10. **Update scripts and integrations** for the renamed CLI commands, MCP tools,
    library exports and hosted API answers in the tables below.
11. **Optional: gate merges on approval.** `wairon lock-check` is new and fails only
    when a design moved past its approval:

    ```yaml
    jobs:
      approved-design:
        uses: SYW-Apps/Waffle-AIron/.github/workflows/lock-check.yml@v6.0.0
        with:
          wairon-version: '6.0.0'
    ```

    Pin both the ref and `wairon-version`: the gate identity's algorithm can change
    between versions. Turn on `strict: true` only once re-locking is part of review.
    After the approval check the job runs `wairon validate --ci` (input `validate`,
    default `true`). Point `working-directory` at the family root, the project that
    declares the members: there it is the family run, which judges the network
    proofs a member's own gate cannot.

`.wai/transactions/` (staged family migrations) ignores itself. Never commit it.

### Breaking changes

#### CLI

| v5.1.0 | v6.0.0 |
|---|---|
| `wairon subsystem add <id> --project-path <dir>` | `wairon member add <alias> <source>`: creates a **part** (`--project` creates a project) |
| `wairon subsystem move <id> --project-path <dir>` | `wairon member move <alias> <path>` |
| `wairon subsystem internalize <id>` | `wairon member internalize <alias> [--into <subsystem>] [--packs adopt\|drop]` |
| `wairon subsystem externalize <id> --project-path <dir>` | `wairon subsystem externalize <id> --path <dir>`: moves it into a **part** (`--as project` creates a project) |
| `wairon surface externals` | `wairon externals status` / `wairon externals list` |
| `wairon surface generate-children` | removed: a parent pushes nothing into its members; a consumer pins with `wairon externals pin` |
| `wairon host promote` | removed: `wairon lock` is the approval |
| `wairon validate` at a project with members | runs the **family run**; `--no-recursive` runs the project's own gate alone |
| `wairon generate` at a parent | writes this project's outputs only; `--family` walks the members (`--no-recurse` is accepted and ignored) |
| `wairon lock` | approves this project only, refuses on design errors only, rewrites no spec file (`--no-recursive` is accepted and ignored) |
| `wairon generate` with `materializeAgentFiles` off | writes no agent files and removes wairon-managed ones; agents are live briefs |
| `pack use\|unuse\|add\|remove\|install`, `host packs install\|remove --project` | show the pack's impact and ask in a terminal; pass `--yes` in scripts |
| `doctor --fix`, `subsystem externalize`, `member internalize` | print a plan and ask; `--yes` in scripts, `--report` to see the plan only |
| `doctor --fix` / `generate` writing outside the project root | needs `--global` (each replaced file is backed up) |
| `wairon generate --target <unknown>` | refused, naming the configured targets |
| Which project a command binds (every command, `wairon mcp serve`, `wairon dev`) | the walk up to the nearest project stops at the repository root (the nearest folder holding `.git`) unless a project above declares the folder as a member; a stray `.wai` above a repository binds nothing. Each command prints `project <id> at <root>` on stderr |
| `wairon init -y` | configures the `claude` target only (name from the folder, profile backend); another tool is one interactive answer or one `targets` entry away |
| `wairon init` in a folder a parent project binds | asks on a terminal before making the folder a member, which edits the parent's `project.yaml`; with `--yes` it refuses, writes nothing and prints the `wairon member add <alias> <path> --project` to run from the parent |
| `wairon externals status` | exits 1 when an external is incompatible and 2 when something could not be compared (it always exited 0); a CI step that ran it for information now gates |
| `wairon externals pin` | exits 1 when an alias could not be pinned (unresolved or unreachable) |
| `wairon lock-check` at a project with members | judges the members too: a member with spec changes nobody approved fails, and a member that re-locked fails until this project is locked again to pin its new approval. `--strict` also fails a member that was never approved |

#### MCP tools

| v5.1.0 | v6.0.0 |
|---|---|
| `sdd_add_subsystem` with `projectPath` | refused; use `sdd_add_member` (`source`, `as`) |
| `sdd_move_subsystem_project` | `sdd_move_member` |
| `sdd_internalize_subsystem` | `sdd_internalize_member` (`into`, `packs`, `exports`, `dryRun`) |
| `sdd_externalize_subsystem { projectPath }` | `sdd_externalize_subsystem { path, as, dryRun }` |
| `sdd_set_subsystem_project_path` | removed: members are configuration |
| `sdd_list_external_interfaces` | `sdd_pin_externals` / `sdd_get_externals_status` |
| `sdd_host_promote_project` | removed |
| Unknown key nested in a tool's input (a method, param, step, endpoint, …) | refused by name; it used to be dropped silently. `sdd_update_spec`'s `delta` stays open and lists ignored keys under `ineffective` |
| Tool results | 16 tools declare an `outputSchema` and return `structuredContent` beside the unchanged text: the six create tools, `sdd_update_spec`, `sdd_get_spec` (the spec sits under `spec`), `sdd_validate_tree`, `sdd_set_endpoints`, `sdd_set_public_interfaces`, `sdd_delete_spec`, `sdd_add_member`, `sdd_pack_impact`, `sdd_pin_externals`, `sdd_get_externals_status`. A proxy that rewrites results must carry `structuredContent` |
| Finding severity | can be `notice`; `sdd_validate_tree` returns a separate `notices` list. The `crossTreeContext` marker is gone; a family run adds `projects` and a `project` key per finding |
| Change report `change` | can also be `renumbered` or `relocated` |
| `sdd_update_spec` deltas | the merge semantics changed (array merges, step deletes and step retypes). See *Fixes*; a script that relied on the old behaviour was writing specs nobody intended |
| Spec writes through a server older than the build on disk | refused with `writesRefused: true`; reconnect the server |
| Spec schema (`Specialist`, `Gateway`, `number`, L1 `projectPath`) | refused at write |

#### Library (`@wairon/cli`)

`validateSddTree` is renamed with **no alias**. The package entry exports 509 names
(v5.1.0: 313). 99 are gone, all of them internals a star export had swept in.

| Removed | Use instead |
|---|---|
| `validateSddTree` | `validateProject` (one project's gate), `validateFamily` (the family run) |
| `saveSystemSpec`, `saveSubsystemSpec`, `saveComponentSpec`, `saveInterfaceSpec`, `saveImplementationSpec`, `saveTypeSpec`, `delete*Spec` | `saveSpec(kind, spec)`, `deleteSpec(kind, id)`, `loadSpec(kind, id)` |
| `createChainedSubsystem`, `moveSubsystemProject`, `internalizeSubsystem` | `createMember`, `moveMember`, `internalizeMember(alias, destination)` |
| `saveProjectConfig` | `createProjectConfig`, `setProjectType`, `recordProfileSelection`, `setExecutionTier`, `registerPackRef` / `deregisterPackRef`, `upsertPackSelection` / `removePackSelection`, `markSelectionsBundled`; `projectConfigExists()` |
| `listExternalInterfaces`, `projectSubsystemSurface`, `projectChildSurface`, `generateChildSnapshots`, `checkChildSurfaceFreshness`, `loadSurfaceSnapshots`, `saveSnapshot` | `pinExternals`, `getExternalsStatus`, `exportSurface`, `importSurface`, `listExternals` |
| `findDomain`, `listFreeStandingDomains`, `deriveSubsystemDomains`, `addFreeStandingDomain`, `removeFreeStandingDomain` | `resolveDomains`, `addDomain`, `removeDomain` |
| `extractGenericTypeVariables`, `extractTypeGenerics`, `extractTypesFromSignature`, `LANGUAGE_MARKERS`, `normalizeLanguage` | no replacement on the entry |
| Context documents (`contextDir`, `CONTEXT_PATHS`, `renderDomainsDoc`, `renderWaironGuide`, `read*Context`, `write*Context`, `hasArchitectureContext`), the OpenAPI codec (`toOpenApi`, `toOpenApiSet`, `fromOpenApi`, `isOpenApiDocument`), skill and template registry internals, pack manifest schemas, spec path helpers (`get*Path`), group-spec functions, the status ratchet (`promoteAllComplete`, `applySpecStatus`, `collectPromotableSpecs`) | no longer exported |

Also: `LoadedExtensions` has the required fields `instructions` and
`selectionFailures` (build one with `emptyExtensions()`). In the code model,
`SourceFileFacts.functionCalls` is replaced by `functionCallSites` (read each site's
`name`). The embedding API in `docs/extending-wairon.md` is exported by name, and
`examples/wrapper/wrapper.js` calls `validateProject`.

#### Finding codes that can newly fail `validate --ci`

`--ci` fails on errors and warnings, never on notices. Code-conformance findings
(marked †) need an implementation `sourcePath` and fire at exact analysis grade.

| Code | Severity | Fires when | Remedy |
|---|---|---|---|
| `STEREOTYPE_RETIRED` | error | a component is still `Specialist` or `Gateway` | `doctor --fix`; Gateways by hand (step 7) |
| `DEPENDENCY_CLASS_VIOLATION`, `DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR` | error | logic reaches past its `dependencyClass` (`pure`, `read`), or the class sits on a non-Orchestrator | change the class or the edge |
| `SUPERVISOR_WRITE_SHORTCUT` | error | a Supervisor calls a shared data method whose effect is not `read` or `lifecycle` | tag the method, or route the write through an Orchestrator |
| `SUPERVISOR_CONTAINMENT`, `SUPERVISION_STATE_INTRUSION`, `LIFECYCLE_CALLS_WRITE`, `ARCHITECTURE_VIOLATION_SUPERVISOR_DEP` | error | a Supervisor owns more than its own Store or Registry, another component reaches that state, a `lifecycle` method calls a write, or a Supervisor depends on a presentation block | follow the message |
| `ACTOR_REACHED_WITHOUT_SUPERVISOR` | error | a live Actor is reached neither through a Supervisor that supervises it nor through a Registry such a Supervisor maintains | model the lookup hop |
| `UNDECLARED_DEPENDENCY_CALL`, `PORTAL_WRITE_SHORTCUT`, `ROUTER_COMPONENT_CONTAINMENT`, `CIRCULAR_DEPENDENCY` | error | existing rules now also judge calls through a pinned contract, a Portal's dispatch table, a RouterComponent owning two Portals, and a cycle through a `--subsystem` scope | fix the edge |
| `DUPLICATE_STEP_LABEL` | error | two steps of one narrative share a label | rename one |
| `DUPLICATE_SPEC_ID` | error | two spec files of one project declare one id | remove or rename one |
| `EXPORT_INVALID`, `EXPORT_ID_DUPLICATE`, `EXPORT_CYCLE`, `EXPORT_UNCONSUMABLE`, `EXPORT_WIDENS_AUDIENCE` | error | an L0 or L1 `publicInterfaces` entry has no source, names something not exported, repeats an id, cycles, re-exports a non-Portal/Observer, or widens a member's audience | fix the entry |
| `EXTERNAL_UNDECLARED`, `EXTERNAL_NOT_EXPORTED`, `IMPORT_AMBIGUOUS`, `IMPORT_UNRESOLVED`, `IMPORT_SHADOWED_BY_LOCAL`, `TRUSTED_LINK_CROSSES_PROJECT` | error | a reference reaches another project undeclared or at a name it does not export, or a `use` import is ambiguous, unresolved or shadowed | `doctor --fix`, then the hand items |
| `UNDEFINED_TYPE_REFERENCE` | error | a dotted type reference names another project through its alias (`alias.name`); it used to be accepted silently | write `alias::name`, as the message says |
| `EXTERNAL_INCOMPATIBLE`, `MEMBER_NOT_FOUND`, `PROJECT_ID_COLLISION`, `PART_UNAVAILABLE`, `MEMBER_KIND_MISMATCH` | error | family run: a used contract changed or vanished, a member is missing or unreadable, or two projects share an id | re-pin, restore, or rename |
| `MEMBER_UNAPPROVED`, `MEMBER_DRIFTED`, `PROJECT_DEPENDENCY_CYCLE`, `EXTERNAL_CHECK_UNAVAILABLE`, `PROJECT_ID_AMBIGUOUS`, `LOCAL_ID_SHADOWS_PROJECT` | warning | family run: a member is unlocked or its lock is stale, two projects depend on each other, a used contract cannot be compared, or an id is missing or shadowed | lock members bottom-up; tune in the parent's `rules.sddRuleSeverity` |
| `PROJECTPATH_ESCAPE` | error | a legacy mount leaves the project that declares it (a `../sibling`) | declare the sibling from the project that contains both, or migrate with `doctor --fix` |
| `SURFACE_REF_AMBIGUOUS` | error | a reference matches pinned contracts of several producers that disagree | name the producer (`alias::name`) |
| `PACK_NOT_INSTALLED`, `PACK_VERSION_UNSATISFIED`, `PACK_INTEGRITY_MISMATCH` | error | a declared pack cannot be resolved; every command refuses | step 6 |
| `UNPINNED_PACK_SELECTION`, `PACK_SOURCE_UNFETCHABLE`, `PACK_STORE_DRIFT` | warning | a selection floats, or cannot be fetched, or the bundle and the store disagree | pin, bundle, or `rules.enforceReproducibility: false` |
| `TYPE_SPELLING_STALE`, `SIGNATURE_TEXT_STALE` | warning | a stored alias spelling, or a signature text its params no longer derive | `doctor --fix` |
| `TYPE_NOT_NEUTRAL`, `TYPE_FORM_UNSUPPORTED`, `TYPE_EXPRESSION_INVALID`, `TYPE_POSITION_INVALID` | warning | `number` or a legacy builtin, a form the grammar leaves out, a position that does not parse, or a misplaced `void`, `async` or `result` (all refused at write) | step 7 |
| `FOREIGN_STEP_FIELD` | warning | a narrative step carries a field its type cannot have | `doctor --fix` |
| `NARRATIVE_COMPLEXITY`, `EXCESSIVE_NARRATIVE_STEPS` | warning | a narrative above the `moderate` cognitive band, or above 25 steps (the limit now has a default) | split it, or set `complexity.cognitiveWarnAbove` / `maxNarrativeSteps` |
| `MISLEADING_BLOCK_WORD`, `GENERIC_COMPONENT_NAME`, `METHOD_REPEATS_COMPONENT`, `COMPONENT_IS_ITS_ONLY_METHOD`, `INCOHESIVE_METHODS` | warning | a name says a block it is not, says nothing, repeats its component, or an Orchestrator holds two jobs (a pure forwarder is exempt) | rename or split, or a reasoned `lint.allow` |
| `UNUSED_COMPONENT`, `UNUSED_METHOD` | warning | a method with no narrative steps no longer vouches for every collaborator | write its `calls` |
| `METHOD_SOURCE_PATH_MISSING` | warning | an implementation's realization has begun (a file it names exists) but some contract methods name no file | name each method's file, or the implementation's `sourcePath` |
| `UNUSED_LINT_ALLOW`, `UNKNOWN_LINT_ALLOW_CODE` | warning | a coarse allow on a code that names sites, an allow naming an error, or an allow naming a retired code | one allow per site (`at:`); delete the rest |
| `UNUSED_COMPONENT`, `UNUSED_METHOD` (on a Portal) | warning | Portals are no longer automatic reachability roots: a verb that no modelled caller reaches and that is not declared an entry | model the caller, declare the entry for real outside callers, or remove the verb |
| `MISSING_PORTAL_TRANSPORT` | error | a Portal states no `transport` (was `MISSING_PORTAL_TYPE`) | `doctor --fix`, or state it |
| `ENTRY_ON_NON_PORTAL` | error | `invokedBy: { kind: entry }` on a method of a non-Portal | use `kind: runtime` |
| `GATEWAY_BYPASSED` | error | inside a declared network, a non-gateway Portal is entered from outside, or a modelled call crosses into the network onto a non-gateway | enter through the gateway, or mark the Portal `variant: gateway` |
| `LIBRARY_CALL_IMPURE` | error | pure or read logic calls a library verb whose `effect` it may not reach (an undeclared effect counts as impure) | declare the verb's `effect`, or move the call into a workflow |
| `LANGUAGE_BRIDGE_MISSING` | error | a native `InProcess` library (no `abi`) is called from a project in another `targetLanguage` | declare `abi: c` or `abi: wasm`, or put a network Portal in front |
| `IMPLEMENTS_MISMATCH` | error | an interface that `implements` an extension point misses one of its methods or changes a signature | state every method with the same signature |
| `ENTRY_SCOPE_NOT_NETWORK`, `INVOKED_BY_RETIRED_KIND` | warning | an entry `scope` on a local or in-process verb, or an `invokedBy` kind `external` / `sibling-subsystem` (read compatibly for one release) | drop the scope; `doctor --fix` for `external`, model the caller for `sibling-subsystem` |
| `ENTRY_UNPROVEN`, `EXPORT_BEYOND_NETWORK` | warning | family run: a `network` entry no modelled caller in its boundary reaches; a network verb exported beyond the project that is not the outermost gateway entered from outside | model the caller (or a reasoned `lint.allow` for an unmodelled one); narrow the audience or export the gateway |
| `UNTYPED_SEAM`, `UNREALIZED_CLAIM`, `UNCONDITIONAL_CALL_CYCLE` | warning | existing rules now see bare types nested in a published method, "persistence" claims, and cycles through parallel, `doWhile` and `try` steps | follow the message |
| † `CALL_STEP_UNREALIZED` | warning | a call step (or declared call) does not land in the target method's own source file; a same-named function elsewhere no longer counts | fix the call or the target's `sourcePath`, or map it with `symbol` |
| † `CALL_ORIGIN_UNRESOLVED`, `METHOD_BODY_NOT_FOUND`, `UNDECLARED_COLOCATED_CALL` | warning | a call site the analysis cannot follow, a declaration without a body, or an undeclared call between components sharing a file | point at the body, narrate or declare the call |
| † `UNREALIZED_PARAM`, `UNDECLARED_PARAM`, `PARAM_NAME_MISMATCH`, `PARAM_OPTIONALITY` | warning | contract `params` and the realizing function disagree on a parameter, its name or its optionality | fix either side; declare wiring arguments in `injectedParams` |
| † `ASYNC_MISMATCH` | warning | an `async` returns and the function disagree | fix either side |
| † `UNDECLARED_EXPORT`, `UNREALIZED_EXPORT_HANDLE` | warning | a file exports a name no contract declares and another component imports it, or a declared `exportedVia` names a missing export | put the name on a contract, or stop exporting it |
| † `IMPORT_BYPASSES_PORTAL` | warning | an import into another subsystem lands on a file that realizes none of its published components | import through the portal |
| † `MISSING_TYPE_SOURCE_PATH` | warning | a type names no `sourcePath`, so its shape is never compared with the code, and its subsystem already has code (a notice before that) | name the file that declares the type (`symbol` when the code name differs) |
| † `TECH_LEAKAGE_IN_CODE` | warning | now also fires for a technology written by its plain name: common packages are known by default (`postgres` covers `pg`) | move the import behind the component that binds the technology |
| `EXTERNAL_UNPINNED` | error | a declared external was never pinned (the project's gate composed with its externals, and the family root); `wairon lock` refuses until it is | `wairon externals pin` |

Code-conformance findings can be recorded as classified debt in
`rules.conformance.carried` instead of being allowed.

**Planned code is a notice.** `MISSING_SOURCE_PATH` is now a notice (it was a
warning), and a named file that does not exist yet is the new notice
`SOURCE_FILE_PLANNED`, while the implementation's realization has not begun (no
file it names exists). Once it has begun, `MISSING_SOURCE_FILE` (error) and
`SIM_FILE_MISSING` (warning) apply as before. A design-only tree therefore
passes `--ci`. `rules.conformance.requireCode: true` reports both notices as
errors.

**Retired codes** (an allow naming one is `UNKNOWN_LINT_ALLOW_CODE`; a severity entry naming
one does nothing):
`ARCHITECTURE_VIOLATION_SPECIALIST_DEP`, `GATEWAY_CONTAINMENT`,
`LANGUAGE_FOREIGN_BUILTIN`, `NAMESPACE_SHADOWING`, `CROSS_TREE_REF_UNRESOLVED`,
`SURFACE_STALE`, `UNVERIFIED_EXTERNAL_REF`, `CHAINED_SUBPROJECT_CONTEXT`, and with the
reachability model `UNMOUNTED_PORTAL`, `ENDPOINT_OUTSIDE_MOUNT`, `MOUNT_TARGET_NOT_PORTAL`,
`PUBLIC_INTERFACE_TYPE_MISMATCH` and `PUBLIC_INTERFACE_EVENT_MISTYPED`.
`MISSING_PORTAL_TYPE` is renamed `MISSING_PORTAL_TRANSPORT` (`doctor --fix` rekeys an
allow or severity naming it). Two notices are new: `MULTIPLE_GATEWAYS` and
`ENTRY_SCOPE_UNBOUNDED` (a `network` scope with no declared network around it). The built-in
rules are split into smaller named rules (40 → 115); a split rule kept its codes.

#### Spec, configuration and lock

- `UNCONSUMED_TOPIC` and `UNSOURCED_SUBSCRIPTION` are sited at their topic. An
  existing whole-spec `lint.allow` for them no longer covers them: write
  `at: <topic>` on it.

- **`project.yaml`** gains `id` (written by `init` and `doctor --fix`), `members`,
  `externals`, `composition` (`requirePolicies`, `requireApprovedMembers`),
  `execution`, `previousIds` and `partOf`. `rules` gains `materializeAgentFiles`,
  `complexity.*` thresholds and `conformance` (`sourceRoots`, `exclude`, `unclaimed`,
  `carried`, `testRoots`). `aiGuide` is gone; it was never read. A save keeps
  comments, unknown keys, key order and line endings, and places a new key in schema
  order.
- **A project's own `complexity`, `documentation` and `naming` settings override its
  profile pack's**, as its severities already did.
- **Reachability.** A Portal states `transport` (renamed from `portalType`; one
  vocabulary with its endpoints, `HTTP_API` read as `HTTP`, and new `JSONRPC` for
  JSON-RPC over stdio and `InProcess` for a library, which binds no endpoint), an
  optional `abi` (`c`, `wasm`) when `InProcess`, and an optional Portal-level
  `invokedBy` entry its verbs inherit. Component `mounts` are gone; a Portal's L4
  `router` names the router entry its file exports (linkage, outside the approval).
  `invokedBy.kind` is `entry | runtime` with a `scope` (`outside | network`); `external`
  and `sibling-subsystem` are retired. The export kind (`type`) on L1 and L0
  `publicInterfaces` entries is derived from the backing Portal, no longer authored;
  an entry may carry `role: implement`, and an interface may declare `implements`.
  The method `effect` vocabulary gains `none` and `io`. `project.yaml` gains
  `network`, which enters the gate identity only when declared.
- **Naming follows the target language.** A method's casing defaults from
  `targetLanguage` (camelCase for TypeScript and Java, snake_case for Rust and
  Python) unless `rules.naming` sets it, and the rename tools validate a new name
  against it instead of always requiring camelCase.
- **Design export format 2.0.** `components[].portalType` is `transport`, `mounts` is
  removed, a Portal may carry `abi` and `invokedBy`, `invokedBy` kinds are
  `entry | runtime` with a `scope`, and export entries carry `role` and a derived
  `type`. The schema ships as `schemas/design-export-2.json`. Surface snapshots
  carry each entry's `transport`, `abi` and `role` and the producer's
  `targetLanguage`; a pin taken before reads the absent fields as unchanged.
- **Specs:** `Specialist` and `Gateway` retire. Type positions follow the grammar.
  `lint.allow` gains `at` and `covers`, and `sdd_update_spec` merges allows by code
  and `at`. A method effect can be `lifecycle`. An L1 subsystem carrying
  `projectPath` is a deprecated form.
- **Lock record format 3.** It adds `members` (alias → project, approved state),
  `code` (the conformance results beside the claim), `projectId` and one digest per
  spec. `children` is read for one release and never written.
  - The per-spec digests and the gate identity read each spec's **design**
    (`specsReading: design`). Code linkage is left out: `sourcePath`, `symbol`,
    `exportedVia`, `simPath`, `injectedParams`, conformance tiers, a Portal's `router`,
    `externalLinks`, and the `createdAt`/`updatedAt` timestamps. Linking code to an
    approved design, or a change and its revert, never stales a lock.
  - A format-2 record from an earlier v6 build still passes while unchanged, and
    `doctor --fix` re-expresses it (upgrade step 9).
  - The **gate identity** is computed differently. It no longer depends on the
    machine, and it now also covers the governing doctrine, the pinned contracts,
    `composition` and the members' approvals. Code findings are recorded beside the
    approval instead of inside it.
  - So every v5.1.0 lock reads stale once, and `lock-check` says why.
  - `lock` never rewrites spec `status`. A spec that is approved and unchanged is
    judged as complete in memory.

#### Hosted

- `wairon host doctor --fix` is required (step 2). Every member of a hosted family
  becomes a project record that inherits access through its parent. An explicit
  "no" on a member's own record beats any inherited grant.
- **Writes are judged per member and per subsystem.** A spec write into a member, or
  a subsystem, that the caller may not write is refused with `SubsystemWriteDenied`,
  even when the caller may write the parent. A lock needs write on the whole project.
- **Promote is removed:** `wairon host promote`, `sdd_host_promote_project`, the
  admin and web promote routes, the `project:promote` approval kind and the Promote
  button. Stored `promote:mark-ready` grants still migrate.
- **Token mint requires its project list** (`*` for the owner's full reach). A token
  qualified `project::member` is mapped to the member's record id. The mint answer
  is `{ token, mapped }`.
- **Admin API answers:**
  - Policy-governed project creation (`POST /web/projects`, the policy portal's init,
    an approved init) answers a `GovernedProjectCreation` (`record`, `packImpacts`,
    `profileImpact`); read the record from `record`.
  - A refused lock answers 409.
  - A lock request whose design moved after it was requested ends `cancelled`, with
    the reason.
  - `environment` is no longer part of a project-init request.
- **Defaults and values:**
  - A landscape entry with no audience is `instance` (it was `public`).
  - The exposure, audit and quota settings offer only the values that behave
    differently: `adminApiMode` is `disabled` or `enabled`, `metadataMode` is `none`
    or `redacted`, and quota `mode` is `observe` or `warn`. Stored retired values are
    mapped with a warning for one release.
- **Git backing commits `.wai/lock.json`**, so an approval reaches the bound remote.
- A member with a `../` or git source is refused on hosted (hosted roots are
  isolated). A hosted detach or adopt moves the member's directory.

### Deprecated

**Removed right after v6.0.0.** Each is still read in v6.0.0, reported as a notice,
and rewritten by `wairon doctor --fix`:

- a leading `::` (`::shared::error-type`);
- `super::`;
- member paths (`billing::invoice::invoice_portal`);
- the L1 mount form (a subsystem carrying `projectPath`);
- the hosted token qualifier `projectId::alias` (mint by record id).

**Read for one release:**

- the long-form member `path` key (`doctor --fix` rewrites it to the one location
  key);
- `children` in a lock record;
- `generate --no-recurse` and `lock --no-recursive` (accepted and ignored);
- a pack's `languages.<id>.foreignBuiltins` (`PACK_FIELD_DEPRECATED`);
- the retired hosted settings values.

`wairon packs` remains a deprecated alias of `wairon pack`.

### New

**Reachability, networks and libraries.**

- Every Portal verb is reached by a modelled caller or declared an entry, and the
  unused-component and unused-method findings now name both remedies for a Portal.
  A Portal-level entry covers every verb; a verb may override its scope.
- **Networks.** `network: true` (or `{ description }`) in `project.yaml` makes a
  project and its members an isolated network. Entries are scoped `outside` or
  `network`, relative to the innermost network, so a member written alone still
  resolves them. Inside a network only a `gateway` Portal is entered from outside,
  one gateway per level. The family run at the root proves each `network` entry has a
  modelled caller inside its boundary. A project that declares no network sees none
  of this.
- **Libraries.** An `InProcess` Portal is a library (or, with `abi`, an FFI, DLL or
  WebAssembly surface) and needs no endpoint. Another project calls its exported
  verbs directly from any component, with no client Adapter, checked for purity and
  for the language bridge.
- **Extension points.** An export entry with `role: implement` is a contract
  consumers supply (a trait, a callback, a webhook); a consumer's interface declares
  `implements: alias::name`, and its methods count as reached.
- **Derived networking.** `wairon network flows | policy | diagram | check | why`
  derives an allowed-flows matrix (JSON, CSV or Markdown), Kubernetes
  `NetworkPolicy` from a bindings file kept outside `.wai/`, a Mermaid diagram of the
  networks as trust boundaries, a comparison of observed live flows, and the
  modelled chain behind one flow. The specs never hold an address. The MCP server
  adds `sdd_get_network_flows` and `sdd_explain_flow`, and the hosted web API adds
  `GET /web/projects/network`. See `docs/network.md`.
- **CI at the family root.** A member validated alone says in one line that its
  network proofs are judged at the family root. The reusable `lock-check` workflow
  gains a `validate` input (default `true`) that runs `wairon validate --ci` in its
  `working-directory`.
- `wairon doctor --report reachability` prints the reachability migration's plan.

**Members, parts and projects.**

- A member is declared by one location key: `scheduler: services/scheduler`,
  `admin: ../admin`, `payments: git@host:acme/payments.git#<commit>` or
  `hosted:<id>`. Its content decides whether it is a project (it has an id, an L0 or
  a lock) or a part (anything else).
- A part's subsystems are the parent's own: same ids, same lock, same agents.
- Git members are fetched at their pinned commit into an offline-capable cache
  (`WAIRON_CACHE_DIR`). `wairon member update` moves the pin.
- A part stored outside its parent can pin the excerpt of the parent it uses, so its
  own CI can validate it alone.

**Cross-project references.**

- `project.yaml` `externals` declares the projects a project consumes. Each level's
  `publicInterfaces` is an export table, with named re-exports, type exports and
  wildcards.
- `wairon externals pin | status | list` records and compares exactly what is used,
  at signature level. `use` imports bring in bare names.
- `validate --family` (and `sdd_validate_tree` with `family`) runs every member's own
  gate and composes each external against its live producer.

**Family migrations.** `member attach | detach [--widen] | adopt | rename-alias |
internalize | promote | demote`, `project rename` and `subsystem externalize` print a
plan, ask, then apply to every project they touch, or to none. Each has an MCP tool
with `dryRun`. A rename keeps the old id in `previousIds` and asks for a re-lock
(`PROJECT_ID_RENAMED`).

**Approval.**

- `wairon lock-check` checks that the design in the tree is the approved design, and
  comes with a reusable workflow.
- `wairon status` names the specs that changed since approval.
- `lockedBy` records where the identity came from (`git`, `os` or `hosted`).
- A parent can require approved members (`composition.requireApprovedMembers`).

**Packs.**

- A machine-wide pack store with versions (`pack install | uninstall | which`).
- Per-project selection (`pack use | unuse`, `--pin`, `--source`, `--bundle`),
  `pack sync` and `pack bundle`.
- `pack impact`, also `sdd_pack_impact` and hosted previews: what a pack changes,
  before it is written.
- Parent requirements: `composition.requirePolicies`, judged by `POLICY_NOT_ADOPTED`
  and `POLICY_DEVIATION`.
- `applyByDefault` seeds a pack into new projects. A pack's `instructions` and skills
  that extend a built-in skill reach the connecting agent.

**Types and contracts.**

- One neutral grammar: ten primitives, `list` / `set` / `map`, `T?`, `async T` and
  `result<T, E>`. It reaches OpenAPI, the ERD and the snapshots, and implementer
  briefs carry each language's mapping.
- New type kinds: `enum`, named scalars (`holds`) and `signature` types.
- A method's signature text is derived from its `params`, and `signatureFrom` names
  the method or signature type it forwards.
- Contract methods declare their `findings`, and a method can name its own
  `sourcePath`.

**Code ↔ spec.**

- Calls are checked where they land, and parameters, exports, type shapes and routes
  are compared against the code. Route coverage reads a Portal's routes from its L4
  `router`.
- `rules.conformance.sourceRoots` reports `UNCLAIMED_SOURCE_FILE` for code no spec
  names.
- A type can claim its file (`sourcePath`, `symbol`).
- A method's `calls` declares what it calls when its narrative shows no steps.
- `register` steps and `invokedBy` (`entry` on a Portal, `runtime` anywhere) declare
  callers outside the modelled graph.
- `rules.conformance.carried` holds classified debt.

**Design blocks.**

- Logic is an Orchestrator with `dependencyClass: pure | read`.
- Query is a Repository member, and a Supervisor may own its own state.
- Built-in variants: `arbiter`, `projector`, `composer` and `codec` on Orchestrator,
  and `gateway` on Portal.
- A `publicInterfaces` entry can name its `consumers`.

**Readability checks.** Narrative complexity, naming discipline and method cohesion,
each with configurable thresholds.

**Authoring.**

- Rename and move tools: `sdd_rename_component`, `sdd_rename_method`,
  `sdd_rename_type` and `sdd_move_methods`. A move that a rule refuses ranks the
  legal homes. A rename leaves a trace (`previousIds`, `previousNames`) and keeps
  published names.
- Creates take a `status`, `sdd_get_spec` can return chosen `methods`, and
  `sdd_update_spec` takes `dryRun` and `unset` and reports `ineffective` keys and
  `testsToRevisit` (`rules.conformance.testRoots`).
- A write is refused when it would place a field its component type cannot have.

**Agents.**

- Agents are **live briefs**, through `sdd_get_agent_brief`, the `wairon-agent://`
  resource and `wairon agent brief`. Agent files are opt-in
  (`rules.materializeAgentFiles`), and `wairon agent customize` adds your own
  guidance in `.wai/agents/<id>.md`.
- The new `sdd-delegate` skill spawns a subagent from a brief.
- Execution budgets (`execution.tier`, `wairon execution show | set-tier`) give
  each agent a capability tier, a turn ceiling and a tool class.
- The MCP server sends `instructions` on connect and offers the skills as prompts.

**Code linkage and live drift.**

- Code linkage is outside the approval (lock format 3), so planned `sourcePath`s
  are declared at design time. Briefs fence planned files, marked
  `(planned — create it)`, simulation harnesses and the subsystem's type files.
  `rules.conformance.requireCode` makes unlinked and planned code an error.
- Plain `validate` and `status`, `sdd_validate_tree` and `sdd_get_status` compare
  each external with its **live** producer, offline, and report what moved as
  advisory findings (`advisory: true`): `EXTERNAL_LIVE_INCOMPATIBLE` (warning) names
  each moved member, the specs that use it and the fix; `EXTERNAL_DRIFTED` and
  `EXTERNAL_LIVE_UNCOMPARED` (notices). They never decide `valid` or `--ci`: the pin
  stays the gate. `wairon externals status` is the opt-in live gate.
- A rename reads as a rename. The surface projection, the pin snapshot and
  `wairon surface export` carry the producer's rename trace as `formerly`, outside
  every digest, so no existing pin moves. A used name that was renamed is `renamed`
  with `renamedTo`, and `EXTERNAL_INCOMPATIBLE` and `EXTERNAL_LIVE_INCOMPATIBLE`
  say "renamed to X".
- `wairon externals add` and `sdd_add_external` declare an external: one-sentence
  refusals, a check against the producer it reaches (a contradicted declaration is
  removed again), and a pin by default. `sdd_get_externals_status` returns each
  external's `health`.

**Severity `notice`:** reported everywhere, never a failure. Any code can be set to
`notice` in `rules.sddRuleSeverity`.

**Design export.** `wairon export` and `exportDesign()` produce the whole resolved
design as one deterministic JSON document (`wairon-design` 1.0,
`schemas/design-export-1.json`, `docs/design-export.md`).

**Moving between local and hosted.**

- `.waitree` archives.
- `wairon remote push | pull | attach | detach | status`.
- `wairon login | logout`.
- `wairon mcp install --hosted`.
- Hosted tree export and import, also from the web Transfer tab.

**Hosted.**

- Access rules per subsystem.
- A permission explanation (`/web/admin/permissions/explain`).
- Relation health on the canvas and on the project's Relations tab.
- Member crumbs and openable member nodes.
- A custom theme builder.
- `WAIRON_AUDIT_POLICY` and `WAIRON_QUOTA_POLICY` set the audit and quota policies.

**Approval and upgrades.**

- A spec's `status` (draft, design, complete) is readiness, not design: it is left
  out of the approval, so promoting a spec after the lock never reopens it. A lock
  taken while status was still part of the approval keeps passing when only a
  status moved, and `wairon doctor --fix` carries it into the current reading.
- `wairon doctor --fix` re-expresses an older lock record before any repair touches
  a spec, so an unchanged tree is carried into the current format even when the
  rules it was judged under moved. A lock whose specs are unchanged but that no
  longer matches now says why: the gate moved (a newer release's rules, the rule
  tuning, composition, network, consumed contracts or a member's approval), never
  the design.

**Code conformance.**

- A call through an injected collaborator whose type comes from a component the
  caller never declared is an undeclared dependency even when the type is imported
  type-only. A Portal calling a write or lifecycle method of a data component that
  way is `PORTAL_WRITE_SHORTCUT_IN_CODE`, the code twin of `PORTAL_WRITE_SHORTCUT`.
- Importing a technology's package (one of its declared tokens) from a component
  that does not bind that technology is `TECH_LEAKAGE_IN_CODE`.
- An Adapter's call step to a verb of a Portal on an out-of-process transport is
  the link the design models: it is no longer resolved to the remote file, so it no
  longer reads as an unresolved call. The call to the Adapter is still checked.
- `CONFORMANCE_DEGRADED` says what is missing: no TypeScript installed, or one that
  ships no JavaScript compiler API (TypeScript 7). A project's TypeScript 7 is
  passed over for a usable compiler where one can be found.
- An Adapter's `dependsOn` to a Portal on an out-of-process transport is realized
  by the link, never by an import, so it is never `UNREALIZED_DEPENDENCY`. Nothing
  asks for an import across a network boundary any more.
- A call is followed through a non-null assertion, a cast to a named type, a local
  alias of a field and a destructured field exactly as through the field itself, so
  those forms no longer hide `PORTAL_WRITE_SHORTCUT_IN_CODE` or
  `UNDECLARED_DEPENDENCY`. A Portal's call through a receiver the analysis cannot
  follow, under the name of a nearby data component's write, is reported as the
  notice `PORTAL_CALL_UNRESOLVED` instead of passing silently. A field typed
  `T | null` or `T | undefined` is read as a `T`.
- Interfaces declared in a shared contracts file are followed to the classes whose
  `implements` clause names them, wherever they live, so the layout no longer
  breaks call tracing.
- `TECH_LEAKAGE_IN_CODE` knows the common packages of common technologies
  (postgres, mysql, redis, mongodb, sqlite, kafka, rabbitmq; an HTTP client is never
  a technology). The table is documented and extended per technology by
  `{ name, matches }` or by a pack's `technologyPackages`. A technology written
  once as a name and once as `{ name, matches }` is one technology, with no spurious
  `TECH_LEAKAGE`.
- A type without a `sourcePath` is reported (`MISSING_TYPE_SOURCE_PATH`): a notice
  before its subsystem has code, a warning after. The architect skill plans type
  source paths with the implementations'.
- The planned files of one implementation are one `SOURCE_FILE_PLANNED` notice.

**Authoring.**

- `wairon type rename-field` and `sdd_rename_field` rename a type's field and
  respell its references. The old name stays on the field (`previousNames`) and
  shows as `formerly` in the design export.
- `wairon method rename-param` and `sdd_rename_param` rename a contract method's
  parameter: the old name stays on the parameter (`formerly` in the design export),
  the signature is re-derived and an HTTP path placeholder that bound it follows.
- A contract that implements another project's extension point takes its method
  and parameter names from the producer: those methods are exempt from the local
  casing rule, and `sdd_rename_method` accepts the producer's names. Per-method
  allows for that are no longer needed.
- A key a spec's schema does not know (for example `exports:` in the L0, whose
  export table is `publicInterfaces`) is reported as `UNKNOWN_SPEC_KEY`, and an
  unknown setting in `project.yaml` as `UNKNOWN_CONFIG_KEY`. The docs show how to
  author the L0 export table.
- The architect skill and guide aim for the smallest sound design: one standalone
  Store for simple state, and the Repository pattern only for real lookup needs.

**Briefs.**

- Rust and Python briefs carry a type mapping table, marked as mapping only (no
  analyzer reads those languages yet). A design with no code yet takes its language
  from `targetLanguage`.
- A consumer's brief lists the externals it uses (names, transport, abi) and adds
  the pinned snapshot to its read paths.
- A subsystem owner's fence includes the project's shared setup files (manifest,
  compiler settings, crate or package root, system-level type files).

**Externals.**

- `wairon externals use` changes an external's imports, `wairon externals remove`
  removes a declaration with its pin, and `wairon externals consumers` lists the
  family projects that consume this one. MCP: `sdd_update_external` and
  `sdd_remove_external`.
- A re-pin refreshes every fact the snapshot carries (abi, transport, role,
  renames), and a stale snapshot reads as drifted, never ok.
- Export audiences: a name exported to a narrower audience than the consumer's is
  refused with both audiences named; a `department` export is noted
  (`EXPORT_AUDIENCE_NARROW`), and a re-export cannot widen an audience.
- Implementing another project's trait: the producer's bare type names and
  `alias::name` compare as one type, and a cross-project `signatureFrom` resolves
  from the pin.
- The methods of an implemented contract are pinned one by one, so the producer
  renaming one reads live as "renamed to <name>".
- A public name gone from the live producer is `EXTERNAL_INCOMPATIBLE` whether the
  consumer pinned it or not.
- `wairon externals consumers --search <dir>…` finds consumers outside the family,
  and `sdd_list_consumers` gives an assistant the same answer.
- `wairon surface diff [--against <file>] [--json]` and `sdd_surface_diff` list
  what changed on the public surface.
- The design export's `uses` lists every referenced name.
- A pin taken before anything references the external says it fills on the next
  pin. A producer that cannot be read is named with its file and error. A name
  exported but reached by nothing is the notice `EXPORT_UNREACHED`.
- Removing the last external also removes `externals.lock.yaml`.
- An Adapter exported as an extension point is typed `InProcess` (pins of such a
  producer read drifted once). `surface export --format openapi` is refused for a
  library. Pins carry the methods and constructors of exported types.

**Networks.**

- The network commands judge the design through the validator first. A flow a gate
  error sits on is refused: marked in the matrix (a `gate` column), left out of
  every policy (and `policy` exits 1), explained by `why`, and filed as disallowed
  by `check`. `why` also says when a callee is reached in-process (never a network
  flow) and when a name is unknown.
- Bindings include the Portal's `basePath`, so live checks match real paths, and
  `check` reports disallowed flows apart from unknown ones.
- A caller is named by its workload (its subsystem) across a project boundary.
- An Adapter may state its transport, which must match its target Portal's
  (`ADAPTER_TRANSPORT_MISMATCH`).
- `wairon network declare | undeclare` and `sdd_set_network` write the network
  declaration.
- Migrations: promoting a member (or externalizing a subsystem into a project)
  declares an entry on each verb the parent calls and names the topics that cross
  the new boundary, which the family run pairs; externalizing re-roots moved types'
  source paths; demoting removes the setup a promote wrote. `sdd_update_spec`
  refuses a member project's spec from the root and names the member's folder.
- Promoting (or externalizing as a project) leaves a valid tree: export entries are
  rewritten, and source paths outside the new project become member-relative
  planned paths. The tool route sets the new project up for its own sessions, as
  the CLI does.
- `network policy` and `check` resolve a renamed project's former id in bindings
  and observed names, with a NOTE; `policy` exits 1 when a name stays unbound, and
  notes a workload that serves verbs of different reach on one port. A project
  rename's plan lists the binding and telemetry keys to rename.
- Inside a member, the network commands answer from the enclosing family
  (`--no-recursive` judges the member alone). `flows` exits 1 on a design the gate
  refuses, and its JSON names the root project.
- `network why` answers for subsystems with only types, member projects and
  `alias::name` parties. `sdd_get_status` has a Network line.
- A Portal transport change, dry run included, lists the Adapters it affects.

**CLI.**

- `wairon diagram` draws relation health (`--no-health` skips it).
- `validate --all` prints every finding, with per-code totals.
- `wairon update --channel dev`.
- `wairon dev` is a local Canvas and Specs shell with no sign-in.
- `wairon lock --all` lists every changed spec; a long list is otherwise
  summarized.
- The reusable `lock-check` workflow installs the project's dependencies (npm, pnpm
  or yarn, from the lockfile; input `install`) before `validate --ci`, so a
  TypeScript project's analysis runs at full grade on a fresh clone. The docs' CI
  recipe says the same.

### Fixes

- **Approval messages agree.** `lock` no longer says "Nothing has changed" when
  only an input moved (the project id, a network, a pinned external): it names
  what did. A storage move is no change for `lock`, as it already was for
  `lock-check`. `lock` says when it approves an all-draft design, and
  `validate --ci` prints how many draft-related warnings it waived.
- **Networks.** `network declare` keeps the description. `GATEWAY_BYPASSED` is
  reported once per Portal. `MULTIPLE_GATEWAYS` has one severity and anchor in the
  project and the family run. `ENDPOINT_TRANSPORT_MISMATCH` stays an error on
  drafts.
- **Docs.** The documented tool count matches the server, shipped docs link only
  to shipped files, and the docs explain which version of the reusable workflow
  to pin on a dev build. `pack init` accepts `-y`.
- **`externals status`** explains only the words it printed.

- **Wording.** Plain `validate` ends with "Passed with N warning(s)" when it printed
  warnings, and says there is nothing to check on an empty tree. `status` marks a
  file not written yet as planned, and its percentages read files the same way the
  lines do. `INVOKED_BY_UNDESCRIBED` states its threshold. `lock` prints the code
  line once. `sdd_get_status` with no project says that no project binds the
  folder.
- **CLI.** `-y` is accepted wherever `--yes` is. `init` takes the project name from
  `package.json` (or `Cargo.toml`) when there is one.
- **Reachability.** No Portal is exempt from the unused findings by a field the
  authoring tool wrote for it. A library no longer needs invented `Custom`
  endpoint addresses to satisfy `MISSING_ENDPOINT`, and a library's consumers no
  longer need a client Adapter per library. An exported extension point is no longer
  refused as unconsumable. A type the project exports at L0 counts as used, and in
  the family run so do its consumers' uses. An export's kind is no longer guessed
  from its description prose.
- **Rename tools and casing.** The rename tools accepted only camelCase method names
  even in a tree whose define tools wrote snake_case; they now follow the project's
  method casing.
- **Lazy loads in the code analysis.** A call through a destructured
  `require('…')` or `await import('…')` binding (`const { f } = require('./m')`)
  resolves to the module it loads, as a static named import does, so the call it
  realizes is no longer reported unrealized. A name two lazy loads bind differently,
  or that a static import or a local function also binds, stays unresolved.
- **Hosted member upgrade.** The member upgrade's plan, apply and drop are one
  workflow of the member registration again, so the local admin entry point only
  forwards to it.

- **External sources.** A `project.yaml` external's `source` is read in either
  form: the location string (`../x`, `hosted:<id>`, `<git url>`,
  `<git url>#<commit>`) or the object. `source: { git, commit }` and a malformed
  `url#commit` are that external's problem, named with the forms that work. They
  no longer produce a raw schema dump or hide the other externals from
  `externals list`. A `<git url>#<full commit>` external uses that commit directly
  instead of failing `ls-remote`.
- **Approval drift without a design change.** `updatedAt` is no longer part of a
  spec's approved digest, so a no-op re-save or a change and its revert no longer
  drifts the lock.
- **Delta merges.**
  - Every array merges by identity at every depth (it used to replace whole lists
    such as `trustedLinks`, `invariants`, `lint.allow`, `params` and `catches`).
  - A field a delta leaves out keeps its value, `unset` works at every level, and
    `[]` clears a narrative.
  - A step whose `type` changes is rebuilt for the new type.
  - A label can retarget a jump that already has a number.
  - Deleting a step is refused when it addresses nothing, its restatement does not
    match, or it would leave a region body without its header.
  - Malformed step markers are refused.
- **Re-authoring** with a create tool carries what the tool cannot express
  (`lint.allow`, `ext`, `auth`, …) and names what it removed. It no longer reopens a
  complete subsystem as draft.
- **No-op writes.** A write that changes nothing writes nothing and says so. A real
  change is reported field by field, and narrative changes step by step.
- **Write targets.** `sdd_move_methods` into a component without a contract creates
  it. An unknown owning subsystem is refused.
- **Stale locks.** A stale lock no longer reports as locked; `status` and `doctor`
  name the staleness and its remedy.
- **Hosted.**
  - The legacy validate view no longer reports every tree as clean.
  - The organizations page no longer crashes on units saved before slugs existed.
  - An unmigrated data dir is announced at startup.
  - Read-only topology tools need read access, not write.
  - A unit removal refuses a missing or unknown disposition.
  - `pack remove` takes the name the listing shows.
  - A producer-run failure answers its own HTTP status instead of 500.
- **Hosted CLI.**
  - `wairon host unit`, `host key` and `host permission` behave as the hosted
    quick start documents them.
  - `host unit create` without `--parent` creates a `business_entity`, the only
    kind a top-level unit can be (it defaulted to `team`). Under a parent the
    default stays `team`.
  - `host key mint` refuses a project that no hosted record holds, and mints
    nothing.
  - Granting `project:write` to a user who cannot read that scope, or minting a
    token for an owner who cannot read its project, warns and names the
    `project:read` grant that fixes it.
- **`wairon dev`.**
  - A stale or expired session no longer strands it on a sign-in screen.
  - It places its project at startup, so it no longer warns that a
    permission-model migration is pending.
- **`wairon update`.** The stable channel no longer installs dev builds.
- **`wairon init`.**
  - It keeps an existing configuration.
  - It writes no agent file.
  - For an Antigravity (`agy`) target it no longer writes a project
    `.gemini/settings.json`, which Antigravity ignores. It prints the command that
    registers the server machine-wide instead.
  - It refuses clearly without a terminal (use `-y`).
  - Provisioning and externalizing never overwrite an existing `project.yaml`.
  - It never edits a parent project's `project.yaml` without asking.
- **Promoted projects.** A project made by `member promote` or
  `subsystem externalize --as project` is set up like one made by `init`.
- **MCP registration.** A project-scoped registration (`.mcp.json`,
  `.gemini/settings.json`), written by `init`, `mcp install` or `doctor --fix`, holds
  nothing machine-specific. It runs `wairon mcp serve` from the PATH (or the CLI by a
  project-relative path when the CLI is installed inside the project) and pins no
  project directory. `doctor --fix` rewrites an older entry that named absolute
  paths. A `--global` registration is machine-wide and still names the CLI by its
  absolute path.
- **`wairon doctor`.** On a machine without Antigravity it reports nothing to
  register, instead of a missing registration.
- **`wairon generate`.**
  - It keeps the derived context documents current.
  - It prints what it reconciled.
  - It refuses an unknown `--target`.
- **Line endings.** Every `.wai` writer keeps a file's line endings.
- **`validate --ci`.** It waives `DRAFT_SUBSYSTEM_WARNING` like
  `DRAFT_COMPONENT_WARNING`.
- **Rule false positives fixed.**
  - `MEANINGLESS_BRANCH` reads fall-through from the step graph.
  - `INESCAPABLE_CYCLE` accepts an exit off the end.
  - `UNREALIZED_CLAIM` ignores quoted text.
  - `UNUSED_TYPE` counts type-method signatures.
  - `GOD_COMPONENT` and `EXCESSIVE_DEPENDENCIES` exempt a pure forwarder and read
    the effective `maxComponentDependencies`.
  - Several rules report once instead of twice.
  - `UNUSED_METHOD` and `ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT` land on the
    interface that declares the method.
- **Analysis.**
  - The pattern-grade analyzer no longer drops a second file's declarations.
  - Aliased and named re-exports, local workspace packages and own-class calls are
    followed.
  - A technology can declare the tokens it is matched by
    (`{ name, matches }`).
  - A forwarding method that shares its target's name is no longer assumed to
    realize the call: identity is judged on the function body, so a handler that
    bypasses its orchestrator is reported (`CALL_STEP_UNREALIZED`).
  - A collaborator typed through `Pick`, `Omit`, `Partial`, `Required` or
    `Readonly`, through one type alias, or as a property of an object of
    collaborators is followed to its module.
  - An `import type` realizes a dependency edge, and a pattern's own files may
    import its members.
  - A component with no code yet gets no simulation finding.
  - Findings use shorter messages.
- **Migrations.**
  - Self-qualified invariant references are migrated.
  - `EXPORT_INVALID` names a duplicate export id.
  - `lock` says when it replaces an older approval.
  - A family migration no longer writes `materializeAgentFiles: false` into a
    `project.yaml` that never set it. The migration rehearses in a copy that has no
    agent files, so the default was recorded and the next lock deleted the
    committed agent files.
  - `member promote` and `subsystem externalize --as project` respell every
    reference across the new boundary: dotted type tokens at every type position
    (fields, params, returns, type-method signatures), `signatureFrom` and asserted
    invariants. They drop `consumers` entries that name a subsystem across the
    boundary, write type re-exports with `from:`, and take intact pins of other
    family projects again. The plan is the rehearsal the apply commits, so it lists
    exactly what is written.
  - `member rename-alias` also respells type-method signatures and returns.
  - `member demote` writes an `alias::<type>` token of a type expression or an
    asserted invariant back as a local reference. A `consumers` list that still
    restricts a surface gets back each subsystem across the old boundary that
    depends on it, so a promote followed by a demote no longer leaves
    `CROSS_SUBSYSTEM_UNLISTED_CONSUMER` behind. A list the promote removed whole
    is not recreated: absent means any subsystem may depend, and the promote's plan
    named the removal.
  - `subsystem externalize` moves every spec file the subsystem owns, whatever the
    layout. In the flat layout (`subsystems/`, `types/`, …) it used to declare the
    part and move nothing. In the nested layout a type of the subsystem kept in the
    shared `types/` folder was left behind.
- **Packs.** `pack bundle` of a pack installed as a single file by an older
  `packs add --global` writes a pack directory that resolves without the store. It
  used to write the file where the directory belongs, so a clone and CI still
  reported `PACK_NOT_INSTALLED`. Such a bundle no longer reports `PACK_STORE_DRIFT`
  against the file it came from.
- **Messages and tools.**
  - `sdd_get_spec` infers the kind from a unique id, and refuses an id that names
    specs of several kinds.
  - `sdd_set_endpoints` refuses a transport the Portal's `transport` does not imply,
    and an endpoint on an `InProcess` Portal, which needs none.
  - A family migration's re-lock list names the project it ran in as
    `this project (.)`, where it printed a bare `.` that read as an empty list.
  - `lock-check` on a stale lock says what moved: how many of the project's own spec
    files changed, and which direct member's approval moved, was added or was
    removed.
  - The design export's `source.stateId` and the lock record's `stateId` are
    different digests by design. `docs/design-export.md` now says so: `stateId` is
    the content id to cache on, and `source.approval` relates an export to its
    approval.
  - `wairon export` at a project with member projects names them. Members are
    listed under `dependencies` and never inlined, so the top of a family that holds
    no design of its own exports no components. That export no longer reads as
    empty without a reason.
  - The design-export schema declares its `$schema` and no longer carries an `$id`
    that did not resolve.
- **Packages.** The library entry ships TypeScript declarations, and the npm package
  and release binaries ship the web app (the build fails without it).
  The npm package also ships the documentation. Generated skills, guides and
  `.mcp.json` keep their line endings.
- **Agent briefs.** A brief states which files the agent may write, and a brief
  can be asked for by component id.
- **Generated guidance.** The guide and the `sdd-architect`, `sdd-implement` and
  `sdd-delegate` skills describe the reachability model: how to declare entries and
  networks, that an entry is never invented to quiet a finding, that libraries are
  called directly, how to name transports, and that method names follow the
  language's casing while wire names live on endpoints.
- **`wairon status`.** Progress is measured per component: 80% once its
  component, contract and implementation specs are written, and 100% once its
  implementation names source files that exist. It is capped at 50% while any of
  them is a draft. `--all` lists every spec that moved since the approval.
- **Wording.** `status`, `doctor` and the externals commands word their output
  more clearly.

### Security

Hosted deployments of v5.1.0 should upgrade. This release hardens:

- the confinement of credentials narrowed to a member;
- write authorization for members and subsystems inside a hosted request;
- CSRF protection on web writes (approval decisions, project configuration);
- the sign-in redirect allowlist on every sign-in entry point;
- session handling on the local dev server;
- how integration secrets reach the Git and producer integrations;
- the local operator's administrative writes.

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
