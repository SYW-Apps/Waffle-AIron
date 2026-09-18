# Changelog

## Unreleased (from v5.1.0)

**Breaking.** Merge dev → main with `[major]` in the merge commit message →
**v6.0.0**. Six changes are visible on upgrade without any action by the user,
and each needs one (see *Upgrading* below): machine-wide packs no longer apply to
a project that has not declared them, existing lock records read as stale, a
project referencing a global pack's profile can newly fail `validate --ci`, and so
can a chained subproject whose gate was waving cross-tree findings through or whose
nested mount reaches outside its own project, a tree that still has a Specialist or
a Gateway or breaks the new Supervisor and Actor dependency rules, a tree whose
narratives or names the new readability checks judge, or a tree holding a case the
fixed validator rules used to miss. A scripted `sdd_update_spec` delta can also
behave differently, where it was relying on a merge rule that was silently wrong
(item 10). Nothing here is purely additive, so `[minor]` would understate it.

### A chained subproject is judged through its parent — never waved through

Validated from its own root, a chained child could not fail its gate for anything
that crossed into its parent. Every reference into the parent became an
`UNVERIFIED_EXTERNAL_REF` warning that `--ci` waives — including references the
parent judges as hard boundary violations. On the regression fixture the parent,
scoped to the mount, reported `CROSS_SUBSYSTEM_NON_ADAPTER`,
`CROSS_SUBSYSTEM_PRIVATE_ACCESS`, `INVALID_DEPENDENCY_REFERENCE` and
`INVALID_TARGET_METHOD_REFERENCE` as errors; the child reported `valid: true`.
Every code↔spec conformance error was downgraded and waived the same way, so a
child naming code that did not exist passed too. Nothing hosted ever delivered
surfaces, so a hosted subproject lock approved real violations.

- **Judged through the parent.** When a chained child holds references it cannot
  resolve and its parent is on disk, validation walks to the top root, validates
  there scoped to the mount chain — with the parent's own rules and doctrine and
  the same strictness — and merges the result into the child's own findings,
  under the child's ids. It is a union with no severity changed, so a child is
  never judged more leniently than its parent. The result names where it came
  from: `resolvedThrough`, printed by `wairon validate` and returned by
  `sdd_validate_tree`.
- **Hosted reach is the credential's.** Resolving reads the parent tree, so a
  token for the top project (or `*`) resolves through it, a token narrowed to
  `project::child` never does, and the walk never climbs above the tenant root.
- **No usable parent, no softening.** Every reference keeps its raw verdict: a
  cross-tree form stays a `CROSS_TREE_REF_UNRESOLVED` warning that `--ci` does not
  waive, and a typo stays an error. `UNVERIFIED_EXTERNAL_REF` and
  `CHAINED_SUBPROJECT_CONTEXT` are retired.
- **A child pins its own surfaces: `wairon surface pin`.** Run in a chained child
  while its parent is on disk, it stores the family surface and every sibling's
  published surface into the child's `.wai/surfaces/`, rewriting only what
  changed — so a child cloned without its parent (a submodule checked out alone
  in CI) still has contracts to validate against. A surface held inside a mount
  now also decides that mount's references when validating from the parent root.
- **A parent lock no longer pushes surfaces into its children.** Pushed delivery
  is gone: the lock hook, `wairon surface generate-children`, and `SURFACE_STALE`.
  So is the git flood a scoped lock used to cause — (children × subsystems)
  snapshots rewritten into other people's working trees on the parent's schedule.
  An unscoped lock still regenerates the derived files (skills, context and
  guides) of every chained descendant — each child's layer, then its own
  subprojects' — and initializes a child that is missing its project files.
- **A child's source paths are its own.** They are read against the child root,
  as the loader always did. An implementation written through the parent (a
  `child::` id) now stores its `sourcePath` and `simPath` relative to the child
  when the path lands inside it, and `subsystem externalize` / `internalize`
  rebase the moved paths exactly. The conformance downgrade, its
  `crossTreeContext` marker and the `--ci` waiver are gone.
- **A loader refusal is anchored to its spec id**, qualified into the mount, so
  `wairon validate --subsystem <mount>` no longer drops a malformed child spec
  that the child's own validate reports.

### Chained subprojects, continued: never softer with the parent on disk, flat at every depth, confined when narrowed

Checking the change above against the code found that it could do the opposite of
what it promised. Three more gaps sat close by, one of them in hosted confinement.

- **A leniently configured parent could soften a child's own findings.** The walk
  to the parent was triggered by — and replaced — a family of codes that included
  verdicts on edges entirely inside the child (`CROSS_SUBSYSTEM_NON_ADAPTER`,
  `UNDECLARED_DEPENDENCY_CALL`). With a parent that set such a code to `warning` or
  `off`, a child that failed alone passed with its parent checked out. Now only a
  reference-resolution failure triggers the walk; the parent-side run judges each
  rule at the stricter of the parent's and the child's severity; and a child
  finding gives way only to an equally or more severe parent finding on the same
  spec, or to a resolution failure the parent's run did not repeat.
- **A flat chained child now works at every depth.** A grandchild whose subsystem
  is named after its mount loaded from the top as two subsystems, and with the
  shadowing fix below its components would have pointed at an id nothing
  declares. A reference to the mount's own name is now the mount at any depth.
- **A credential narrowed to a chained child reads nothing above the child.**
  Validation already honored this; discovering the parent did not. Surface
  freshness in `sdd_list_external_interfaces` and the bind-time announcement now
  answer for a child-scoped credential as a top root would, and the four landscape
  discovery tools are refused under a subproject-qualified binding, like the other
  record-level tools, instead of answering for the whole project.
- **Hosted reads are gated as reads.** `sdd_list_external_interfaces` and the
  topology tools (`listAgents`, `getAgent`, `listDomains`, `validateTopology`,
  `getProjectConfig`) fell into the fail-closed default and required
  `project:write`. They require `project:read` now, and a test fails when a tool the
  hosted server advertises relies on that default.
- **Two August fixes are finally on `dev`.** Their pull request was merged into a
  branch that had already been merged, so neither landed: namespace shadowing
  detectable from disk with the `--ci` draft-subsystem waiver, and the closed
  Specialist dependency matrix. Their entries follow below; the Specialist has
  since retired (see *Logic is an Orchestrator*).

### Chained subprojects: correct on the current model before it changes

A repository-backed review of the chaining code, taken after the fixes above,
found places where one tree got different answers depending on where it was read
from, and checks that did less than they said. These are fixed without changing
the chaining model itself, which is being redesigned separately.

- **A mount is contained by the project that declares it.** A nested child's
  `projectPath` was checked against whichever root loaded the tree, so a child
  declaring `../sibling` loaded from the top project and was refused from its own
  root. Loading, namespace resolution, parent detection, whole-tree walks and the
  writers now all decide containment against the declaring project, both as the
  path is written and as the filesystem resolves it. **Breaking:** that `../`
  mount is now refused from the top root too.
- **Findings about a nested mount carry its qualified id**, so
  `validate --subsystem <mount>` keeps a missing, cyclic or escaping grandchild
  instead of dropping it.
- **Finding a parent is gated like reading one.** A credential narrowed to a
  chained child no longer reads the parent's spec files to learn whether a parent
  exists, and no request looks above its own top project root.
- **A pinned surface is matched by the provider a reference names.**
  `super::billing::invoice_portal` was resolved against whichever pinned surface
  exposed an `invoice_portal` first, even another sibling's. It now consults
  billing's surface alone, and a reference that names no provider while several
  pinned surfaces expose that name with different contracts is the new error
  `SURFACE_REF_AMBIGUOUS` instead of a silent pick.
- **Pin freshness is judged on content.** `sdd_list_external_interfaces` and
  `wairon surface externals` compared a pin's recorded state with the parent's
  whole-tree state, so any unrelated parent edit made every pin stale — and
  re-pinning could not repair it, because an unchanged contract is not rewritten.
  A pin is now fresh exactly when its contracts equal what the parent publishes
  now, so `wairon surface pin` always repairs a stale entry.
- **The lock covers the contracts a verdict consulted.** The gate identity now
  also digests the stored surface snapshots of the project and of every chained
  mount, provenance excluded: swapping a pinned contract invalidates a lock, while
  re-pinning an unchanged one does not. The algorithm marker becomes
  `sha256+doctrine+inputs`, so every existing lock reads stale once.
- **Externalizing a subsystem keeps its own references pointing where they did.**
  `subsystem externalize` rewrote the parent's references to the moved subsystem
  but left the moved specs' own references as written, so once they loaded from
  the new child root, a reference to a sibling subsystem or to another chained
  project no longer resolved. Those are now rewritten into `super::` form (one
  already in `super::` form gains a hop), and `internalize` restores them exactly.
  Type names resolve by name wherever they live and are left as written.
- **A tree archive is complete, or says it is not.** A `.waitree` export silently
  left out any chained mount it could not follow — escaping its project, missing,
  cyclic, nested too deep, or holding no spec tree. It now refuses, naming each
  one and why, unless `--allow-partial` (`wairon remote push|pull`) or
  `allowPartial` (`sdd_host_export_tree` and the admin and web export routes) is
  given; then the archive is built and the result lists what was skipped.
- **Hosted git commits the approval.** Git backing kept `.wai/lock.json` out of
  commits, so a hosted approval never reached the bound remote. Only
  `.wai/git.json` stays local now, and an exclusion left by an earlier version is
  removed with a warning.
- **`sdd_get_status` opens with the family context** — the mount a child is known
  by and its parent's name (within the credential's reach), and the subprojects a
  root mounts — because a connected agent never sees the startup log line that
  used to be the only place this was said.
- **A narrowed credential is served only tools that act on its tree.** Hosted
  confinement refused a fixed list of record-level tools and served everything
  else. Every tool now declares whether it acts on the bound tree or on the
  project record, and under a `proj::child` credential a tool that declares
  neither is refused, so a newly added tool fails closed.

### Project configuration goes through one Repository

`.wai/project.yaml` was read and written directly from about 35 files — the CLI,
the core, the validator, the skills exporter, the MCP server and the hosted
server — each with its own parse, merge or raw write. Wairon's own rule, that held
state lives in a Store and never in the components using it, did not hold for
wairon. Every reader and writer now goes through one `project_config_repository`
in sdd_core (a Store, a Registry, an Index and a filesystem Adapter), reached
through each subsystem's core adapter. Behaviour is kept, except as listed here.

- **A key wairon does not know survives every write.** A typed save used to drop
  any key the schema did not model, anywhere in the file, while the hosted raw
  merges kept them. Every write now carries unknown keys over verbatim and keeps
  the file's key order.
- **Pack writes do what they did, in one place.** `pack add` registers a path once,
  `pack use` moves a re-selected pack to the highest precedence, `pack unuse` and
  `pack remove` each touch only their own kind of entry, `pack bundle` and
  `doctor --fix` write once, and every pack write records `useGlobalPacks`. The
  hosted pack registry now stores pack files only; the pack and policy workflows
  register what it vendored.
- **`wairon init` keeps an existing configuration.** A folder holding
  `.wai/project.yaml` but no spec tree had its configuration overwritten with
  defaults; init now keeps it and bootstraps only the missing tree.
- **Creating a configuration never overwrites one.** Provisioning a root that
  already has a `project.yaml` is refused before anything is written, and so is
  externalizing a subsystem into a folder that already holds one — which used to
  overwrite that configuration and its L0.
- **Hosted policy reads and writes go through the schema.** `setProjectType`, the
  recorded profile selection and policy evaluation read the configuration through
  the Repository, so a `project.yaml` that fails the schema is reported instead of
  read partially, and a write puts the schema's defaults in the file, as any CLI
  save already does — one diff in a git-backed project, then stable.
- **The specs folder is resolved once, when a project root is bound**, still from
  `paths.specsDir`, and still found when the configuration fails the schema.
- **Fixed: a project selecting a pack by name lost its health references.** The
  hosted health report took each pack entry's file stem; a by-name selection threw
  inside a swallowed error, so the project reported no pack or profile references
  at all. It now reports the selection's name, and a `wairon dev` project's
  references carry its project id instead of its folder name.

### A method can name its own source file, and a contract method declares its findings

An implementation had one `sourcePath`, so a method whose body lived elsewhere — a CLI command in its own file, a
provisioning workflow outside the orchestrator's main module — was checked against the wrong file. The call check found
no function there and skipped the method without a word, and no agent's write fence covered the file that actually held
the code.

- **A method names its own file.** `sourcePath` on an L4 method overrides the implementation's for that method.
  `sdd_write_narrative` accepts it, and a chained subproject's save and `subsystem externalize` / `internalize` keep it
  relative to the right root, exactly like the implementation's own path.
- **Every check reads the method's own file.** Structural conformance checks each contract method in its own file and
  reports a missing, escaping or unreadable file once per file, naming the methods that use it; a problem in one method's
  file no longer blocks the others. Call-step realization, the narrative-detail lint, dependency, hidden-state and
  integration conformance and the technology-leakage scan follow the same file, and the code model analyzes every file an
  implementation or its methods name.
- **`MISSING_SOURCE_PATH` names the methods left without a file.** An implementation with no path of its own is complete
  when every method names one; an implementation that names no file at all is still reported, whatever its contract's
  size.
- **Agent write fences hold every file** an implementation and its methods name.
- **`wairon status` lists each method's own file** under its implementation, flagged when missing, and counts the
  source-file share of completeness only when every named file exists.
- **A contract method declares the findings it reports: `findings: [{ code, severity, summary }]`.**
  `sdd_define_interface` accepts it and `sdd_update_spec` upserts and deletes entries by `code`. A declared code must
  be anchored in the method's source file, as a string literal or a property-access name such as `Codes.X`, or
  `UNREALIZED_FINDING` (warning) says so — the catalog of what
  a check reports sits on its contract, the way ESLint keeps a rule's messages in its `meta`. Below exact analysis grade
  the check is lenient: it can miss an unreported code, but never flags a reported one.
- **Wairon's own tree** points 26 methods at their real files: 19 of `cli_runner`'s command methods at
  `src/commands/*.ts` and 7 of `core_orchestrator`'s provisioning methods at `src/core/provision.ts`. The checks this
  turned on found `init`, `generate`, `list` and `show` reaching core and skills internals directly. They now go through
  `cli_core_adapter`, which gained `resolveAgentTopology`, `ensureProjectInitialized`, `listDirectChainedSubprojects`
  and `defaultPackSelections`, and `init` bootstraps the L0 system spec through core's own non-destructive bootstrap.
- **`wairon init` no longer writes an `agent-architect` file.** Agent files are opt-in (`materializeAgentFiles`, off by
  default), yet `init` wrote one regardless, and the next `wairon generate` removed it again. A project that opts in gets
  its agent files, the architect included, from `wairon generate`, rendered from the resolved topology.

### The validator's rules are designed in the spec tree

The validator's 43 rules existed only as code. The spec tree modelled the rule machinery but described the rules in one
prose step, so a rule change had no spec to change first, and nothing checked that the codes the specs promised were the
codes the rules reported.

- **Eight rule families and a projector.** `sdd_validator` gains `integrity_rules`, `narrative_rules`, `intrinsic_rules`,
  `doctrine_rules`, `extension_rules`, `wiring_rules`, `conformance_rules` and `heuristic_rules`, plus
  `narrative_graph_projector`, the reachability walk two wiring rules share. Each rule is one method named after it,
  declares the codes it reports as `findings`, and has a full narrative; `rule_registry` registers every rule in run
  order.
- **One file per rule.** Each rule lives in `src/core/rules/<family>/<rule>.ts`, and its spec method names that file with
  `symbol: check`. No rule file imports another: shared analysis goes through queries on the rule context, model
  functions in `src/models` (type references, the code model, the step graph, surface references) and the projector.
- **The validator gathers, then the rules judge.** `validate` runs the writer's round-trip dry run and gathers the known
  issue codes before any rule runs, so no rule calls core. The write gate, `validateComponentCandidate`, is served
  through the validator portal and gathers the same codes.
- **`spec_validator` is modelled as an Orchestrator**, because validation is a workflow, and `rule_store` gains `clear`.
- **No finding changes.** Every message, severity and order is the same. The existing tests, the e2e journeys and the
  rule-matrix tier pass with their assertions unchanged, and the matrix's code universe is the same 160 codes. A new test
  keeps the code's rule registry and the spec catalog identical in both directions: rules and methods, codes, severities,
  summaries, spec scope, registration order, and one file per rule.
- **The type specs model what the rules read**, among them a component's Portal, event and link fields, an
  implementation's `simPath` and `technologies`, a type's `invariants`, the code model's analysis fields and the
  project's pack selections.
- **What narrating the rules surfaced.** The gate hash in `sdd_core` reads the validator's built-in rule list, an edge
  the old import path hid from dependency conformance; `state_hash_specialist_impl` acknowledges it until a design change
  decides how core obtains the list. 27 of the 44 narratives exceed the coming complexity defaults; they stay faithful
  here and are split in a later change. Rule behaviour that looks wrong is fixed separately, each fix with a failing test
  first.
- **Library exports.** `LANGUAGE_MARKERS`, `normalizeLanguage`, `extractGenericTypeVariables`, `extractTypeGenerics` and
  `extractTypesFromSignature` are no longer exported. The model functions that replace their uses are:
  `methodTypeRefs`, `methodGenericParameters`, `typeGenericParameters`, `fieldTypeRefs` and
  `interfaceGenericParameters`.

### The validator's rules do what their narratives say

Narrating the 43 rules faithfully turned up behaviour that disagreed with a rule's own description, with its neighbours,
or with the step graph. Each fix was reproduced by a failing test first; the rule's narrative changed, then its code, and
each test was proven by reverting the fix. Findings a tree did not see before come first, because `validate --ci` can
newly fail on them (see *Upgrading*).

- **Newly reported.**
  - `UNDECLARED_DEPENDENCY_CALL` (error) covers calls and dispatches that resolve against a surface snapshot: a step that
    reaches another tree's component the caller does not list in `dependsOn` no longer passes.
  - `PORTAL_WRITE_SHORTCUT` (error) judges a Portal's dispatch table too: a binding that routes a capability to a
    write-effect Repository or Index method is reported once, on the Portal.
  - `ROUTER_COMPONENT_CONTAINMENT` (error) fires on a RouterComponent that owns more than one Portal, as its message
    always said.
  - `CIRCULAR_DEPENDENCY` (error) in a `--subsystem` run reports a cycle through the scope even when the search meets an
    out-of-scope cycle first; the scoped run used to report nothing. The finding is anchored on the first component of
    the path it shows.
  - `UNTYPED_SEAM` judges a published method through its type references, so a prose signature without structured
    `params` gets the verdict the same params would, and a bare type nested in another (`Json[]`, `Map<string, Json>`,
    `Record<string, unknown>`) counts. Its summary now names `object`, which it always flagged. Wairon's own
    `icli_runner.runHostProject` and `runHostKey` took `options: object`; their signatures now name the options each
    command passes.
  - `UNREALIZED_CLAIM` recognises "persisting" and "persistence".
  - `UNCONDITIONAL_CALL_CYCLE` treats a call inside a parallel arm as unavoidable, because every arm runs.
  - `UNCONDITIONAL_CALL_CYCLE` treats a call inside a `doWhile` body, and one in the FIRST step of a `try` body, as
    unavoidable too. A `doWhile` runs its body before it tests, so what the body cannot avoid the loop cannot avoid; a
    `try` is always entered at its body's first step, which executes before any handler can catch anything. Both headers
    used to "complete" around their own body — the loop through its exit edge, the try through a catch — so a call that
    genuinely always happens read as guarded and a real unbounded recursion went unreported. Anything DEEPER in a try
    body is still avoidable: a throw before it diverts to the handler.
- **No longer reported wrongly or twice.**
  - `MEANINGLESS_BRANCH` reads fall-through from the step graph: a branch or switch ending a parallel arm falls through
    to the join, not into the next arm, and a switch whose unmatched values end the method decides something.
  - `INESCAPABLE_CYCLE` accepts a cycle that exits by falling off the end of the narrative.
  - `UNREALIZED_CLAIM` ignores text in quotes or backticks, which names a value or quotes a message, and counts a
    `register` step to a data-layer component as the structural edge it is.
  - `UNWIRED_INTEGRATION_SIM` leaves a missing file to `MISSING_SOURCE_FILE`, and a chained subproject's child-relative
    paths to the child's own run.
  - `UNREALIZED_DEPENDENCY` reports a target that is both owned and depended on once, naming both relations.
  - `UNCONSUMED_TOPIC` and `UNSOURCED_SUBSCRIPTION` report a topic once per component, listing every declaration that
    binds it there.
  - `NARRATIVE_SEMANTIC_UNBACKED` is not judged against a dispatch binding whose method does not exist; that is
    `UNSERVED_CAPABILITY`.
  - A building block's `owns` is `BLOCK_OWNS_MEMBERS` and nothing more. It no longer makes the block an owner, so a
    Store or Registry it claims is still judged by `UNOWNED_STORE` and `REGISTRY_WITHOUT_STORE`, its dependants get no
    `VISIBILITY_VIOLATION`, and a pattern's member it claims gets no `SHARED_OWNED_MEMBER`.
  - `HIDDEN_STATE` honours the method-level conformance dial: a method dialled `off` does not make its file mapping
    evidence, and a method dialled on under an implementation dialled off does.
- **Draft context is read the same way everywhere.** A finding on an implementation reads the implementation, its
  contract, its component and its subsystem; one on an interface also reads the interface's own status; one on a
  subsystem or an entity reads the subsystem's. Naming, complexity, technology leakage (`TECH_LEAKAGE`,
  `VENDOR_NAME_IN_CONTRACT`, `TECH_ON_LOGIC_COMPONENT`), unused detection, the invariant findings and the non-Portal
  endpoint ban now follow it, so `--ci` waives their warnings in a draft subsystem as it does for the others.
- **Findings land where the fix is made and say what was checked.**
  - `UNUSED_METHOD` is reported on the interface that declares the method, like `INVOKED_BY_*`, so an allow covers one
    contract.
  - `ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT` is reported on the interface that declares the endpoint.
  - `SHARED_OWNED_MEMBER` names the first owner against every later claimant.
  - `CROSS_SUBSYSTEM_TARGET_NON_PORTAL` names the crossing component's stereotype instead of calling every crosser a
    client Adapter.
  - `UNREALIZED_FINDING` names both anchors it accepts, a string literal or a property-access name, in its summary and
    its message.
  - `UNCONDITIONAL_CALL_CYCLE` orders its members by code unit instead of locale collation, so its anchor, and an allow
    on it, are the same on every machine.
- **One configuration, one answer.** `GOD_COMPONENT` reads the effective `maxComponentDependencies` for the component's
  subsystem, the value `EXCESSIVE_DEPENDENCIES` reads, and uses its own default of 8 only where none is set. An empty
  `profile: ''` means no profile for severity overrides too, as it already did for rule configs and design depth.
- **Kept, with the reason written into the narrative.** `UNASSERTED_INVARIANT` still reports a write method an
  implementation does not implement: the obligation belongs to the contract's write method, and the finding names the
  invariants the missing narrative must assert.
- **The skills say what the rules check.** The narrative skill documents a switch's `on` as optional, the two ways to
  continue a loop, and a closing step per nested loop; the guides and the architect and implement skills say
  `PORTAL_WRITE_SHORTCUT` covers dispatch-table bindings.

### Logic is an Orchestrator; Specialist and the Gateway pattern retire

Wairon's building blocks said what a component holds, but not what its logic may reach. A Specialist was "one focused
capability" with its own list of forbidden edges, and nothing checked whether logic only computed, only read, or ran a
workflow. A Gateway was a pattern that owned its interceptors, so logic that several front doors need could not be
shared. Findings a tree did not see before come first, because `validate --ci` can newly fail on them (see
*Upgrading*).

- **Newly reported, as errors.**
  - `STEREOTYPE_RETIRED` reports a component still typed `Specialist` or `Gateway`. The write tools no longer offer
    either and refuse to save a component that keeps one, so a Specialist is retyped before its component is edited.
  - `DEPENDENCY_CLASS_VIOLATION` reports logic depending on a component its `dependencyClass` does not allow, and
    `DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR` a class declared on anything but an Orchestrator.
  - `ARCHITECTURE_VIOLATION_SUPERVISOR_DEP` reports a Supervisor depending on anything but Actors, Orchestrators,
    Adapters or other Supervisors: a Supervisor reaches data only through workflows.
  - `ACTOR_REACHED_WITHOUT_SUPERVISOR` reports a component that depends on a live Actor it does not supervise without
    also depending on a Supervisor that supervises it.
  - `ARCHITECTURE_VIOLATION_QUERY_DEP` and `UNOWNED_QUERY` judge the new Query block.
- **Logic is an Orchestrator with a dependency class.**
  - `dependencyClass: pure | read` is a first-class component field, enforced as a Store's `durability` is.
    `sdd_add_component` and `sdd_update_spec` express it. Unset means a workflow.
  - `pure` logic depends only on pure logic, and every block may use it: a Store may call a codec.
  - `read` logic may also depend on read logic, Repositories, Indexes and Adapters. That it calls only their read
    methods is not judged yet; that check waits for facade methods to carry effect tags.
- **Specialist and the Gateway pattern are retired.**
  - `wairon doctor` lists each Specialist with the dependency class its dependencies give it, or none (a workflow) when
    a dependency fits neither, and says why. `doctor --fix` retypes each to an Orchestrator and rebases project
    variants built on Specialist.
  - A Gateway migrates by hand, following the steps in its finding.
  - `ARCHITECTURE_VIOLATION_SPECIALIST_DEP` and `GATEWAY_CONTAINMENT` are gone, facade forwarding checks Repositories
    only, and the cross-subsystem rule no longer accepts a Gateway as a front door.
- **A gateway is a Portal variant.** It authenticates, authorizes, validates or rate-limits before it dispatches, by
  calling that logic and returning early on a rejection. Inbound auth stays in the Portal's `auth`.
- **Variants are built in.**
  - wairon ships `arbiter`, `projector`, `composer` and `codec` on Orchestrator, and `gateway` on Portal.
  - They load before the global (`~/.wairon/variants`) and project (`.wai/variants`) directories, and a later layer
    overrides a variant with the same id.
  - Until now the shapes the standard describes existed only in wairon's own repository.
- **Query joins the Repository members**, for computed reads over its Repository's Store. It depends only on that Store,
  a backend Adapter or pure logic, and lives only inside a Repository.
- **Hidden-state no longer flags Supervisor and Actor files**, which own runtime state by design.
- **One finding per mistake.**
  - A dependency on a Portal or an Observer reports once.
  - A retired component reports once: the dependency, containment and class rules skip it, and its migration decides
    what its edges become.
  - A Repository still judges its other members while one is retired. A Feature or Router component is judged again
    once its retired member is migrated, because that member changes the count the rule checks.
  - A pattern owning a pattern no longer adds `VISIBILITY_VIOLATION` on the inner pattern's dependants.
- **The validator computes the lock's gate identity.** Core no longer reads the validator's rule list: `sdd_validator`
  computes the identity, and core compares a lock with the identity its caller passes. The marker is now
  `sha256+content+doctrine+inputs`, so every existing lock reads stale once.
- **`sdd_rename_component`** renames a component together with the interfaces and implementations named after it, and
  rewrites every reference in the tree: ownership, published interfaces, an interface's component, an implementation's
  contract, component classes and `auth` sources.
- **`sdd_rename_method`** renames a contract method the same way: it moves on every interface of the component that
  declares it — its name, and the name inside its signature — and on the implementations of those contracts, and
  narrative `call`, `register` and `dispatch` steps, dispatch-table bindings and lifecycle entrypoints follow. An
  implementation that declared no `symbol` is pinned to the old name (`pinSymbol: false` declines), so the function it
  already binds to keeps binding. Prose is never rewritten and a gRPC binding keeps its wire method — renaming a
  contract method must not silently rename an RPC — and both are reported as mentions.
- **Wairon's own tree:**
  - its 27 Specialists are Orchestrators (18 pure, 9 read), and 14 are renamed for what they are responsible for;
  - `mcp_server` is an Orchestrator;
  - `host_server` supervises a `backup_schedule` Actor and delegates boot seeding to `instance_bootstrap`.
- **The standard:** §3, §7, §8, §10 and §12 teach the model above, the language bindings add the module-of-functions
  form, and a live auction is the worked example.

### One rule, one question: rule methods that were several rules are split

The complexity dial the section below adds turned on wairon's own validator family and found rule methods that were not
one rule at all: one method, several finding codes, several independent loops, and a narrative nobody could hold in
their head. Splitting them makes each rule a thing a user can name in `wairon rules list`, in a `lint.allow` reason or
in a bug report, and drops each narrative under the `complex` band. Every finding code is preserved exactly — no code
is added, removed or re-graded — so no `sddRuleSeverity` override, no `lint.allow` keyed on those codes and no rule-matrix
fixture changes. A code may now be owned by two rules, which is the honest shape where the same sentence is true on both
sides of a seam.

| was | is | why |
| --- | --- | --- |
| `dispatch-tables` | `dispatch-table-bindings` + `dispatch-step-routing` | the table a Portal declares, and the narrative step that routes through it — `UNSERVED_CAPABILITY` means "this capability has no server" on both sides |
| `type-references` | `type-declarations` + `field-type-references` + `signature-type-references` | what a type declares about itself, and the two places a reference to a missing type actually bites |
| `architectural-profiles` | `profile-registration` + `profile-stereotype-fencing` + `pack-profile-stereotypes` | three questions with three owners: is the name real (the project's config), does the built-in family doctrine allow this stereotype (wairon), does the pack's own declared doctrine allow it (the pack) |
| `structural-conformance` | `source-file-linkage` + `method-realization` + `finding-realization` | three questions about the same code model: does the spec name files that exist, does the file contain the method, does it report the codes the method declares |
| `narrative-flow` | `narrative-step-config` + `narrative-reachability` + `narrative-jump-edges` | does each step carry the config its type requires, can every step be reached (and do the regions nest), and where do the jump edges land |
| `contract-symmetry-and-narratives` | `contract-symmetry` + `narrative-target-references` + `cross-tree-references` + `surface-reference-backing` | four questions a user recognizes: does the implementation mirror its contract, does a target inside this tree resolve, does a target that leaves it pin to exactly one declared surface, and does that surface back what the step asks of it |
| `stereotype-dependencies` | `subsystem-boundary-dependencies` + `logic-dependency-class` + `data-block-dependencies` + `entrypoint-dependencies` + `portal-write-shortcut` | where an edge is allowed to LAND, and then the intra-subsystem matrix by the layer that answers for it — an Orchestrator's declared class, the data blocks, the entry points and the process layer — with the Portal read-face guard last, the one that reads narratives and dispatch tables rather than `dependsOn` |
| `pattern-ownership` | `pattern-membership` + `pattern-containment` + `unowned-blocks` + `member-visibility` | who may own and what a claim must name, what each pattern must contain, which data blocks are left standing alone, and who may see a private member |
| `declarative-assertions` | `assertion-forbidden-edges` + `assertion-required-fields` + `assertion-endpoint-shapes` | the assertion KIND is what a pack author writes, and each kind asks its own question of its own collection: an edge in the dependency graph, a field on a spec at one level, or the transport and address an endpoint binds |
| `target-language` | `signature-language-builtins` + `narrative-language-constructs` | what a CONTRACT may name in the declared language, and what a NARRATIVE may describe in it — two codes over two collections that only ever shared the `targetLanguage` opt-in |
| `technology-boundaries` | `technology-binding` + `technology-boundaries` | which stereotype may bind a technology at all, separated from where that technology's NAME may then appear |
| `public-surface` | `public-surface-binding` + `public-surface-declared-type` + `public-surface-bound-contract` | what BACKS the entry, whether that component's stereotype can realize the type it declares, and whether the contract it binds is that component's own |
| `namespace-hygiene` | `reserved-id-segments` + `namespace-shadowing` | two questions of the same ids: the one segment the `::` grammar reserves, and the local name that would anchor a bare reference to the root instead |
| `integration-conformance` | `integration-sim-declaration` + `integration-sim-file` + `integration-sim-wiring` + `integration-sim-coverage` | one rule per finding about one harness: is a harness expected here, does the declared one exist, does it wire the real modules, does it name every narrated path |
| `narrative-antipatterns` | `meaningless-branches` + `inescapable-cycles` + `unconditional-call-cycles` | three separate proofs that happened to share a file: a decision whose arms all land on one step, a step cycle nothing can leave, and a call cycle in which no edge is guarded |
| `narrative-detail` | `narrative-detail` + `detail-sufficiency` | does a method carry the detail its level PROMISES (a narrative at full, prose below it), and is that level low enough to be hiding something the reader is owed |
| `portal-endpoints` | `portal-endpoints` + `non-portal-endpoints` | the two arms of one `if`, and two different subjects: what a Portal must bind, and what everything else may not carry at all |
| `portal-call-auth` | `portal-call-auth` + `auth-source-wiring` | the CALL SITE (who may present a credential, and must it say where the credential comes from) separated from the SOURCE (does the `component:` reference resolve to a provider the presenter is wired to) |
| `invariant-backing` | `unique-invariant-ids` + `invariant-backing` + `invariant-references` | three questions of one registry, two of which share nothing with the middle one: are the entity's ids unique, does each invariant reach every write path of its owner, and does every asserted reference name something declared |

`profile-registration` also checks the project's own `projectType` before each subsystem's profile rather than after —
the project-wide question first. On wairon's own tree the split retires `wiring_rules_impl`'s
`EXCESSIVE_NARRATIVE_STEPS` allow outright — no narrative in that family lists more than 25 steps any more.

`narrative-flow` needed a derivation moved first. Its later phases ran only over a narrative it had already found
structurally sound, and splitting that flag away would have had the reachability walk call sound steps dead whenever a
jump target did not exist — wrong findings, not merely noisier ones. So `MethodImplementation.stepConfigVerdict()` is
now a pure derivation beside `stepGraph()`, returning the step-config problems (`StepConfigProblem`: the step, the code
it maps to, the detail) and the `sound` verdict; `narrative-step-config` reports what it returns, and the other two gate
on it. `CONFORMANCE_DEGRADED` stays with `source-file-linkage` for the same kind of reason: it is run-wide and carries no
spec id, so it belongs to the one rule that builds the file index, or it would be reported once per rule that rebuilt it.

On wairon's own tree the conformance split retires `conformance_rules_impl`'s `EXCESSIVE_NARRATIVE_STEPS` allow — the
31-step narrative it named is gone and nothing left in that family lists more than 25 — and both families' remaining
`NARRATIVE_COMPLEXITY` allows were rewritten to name only the narratives that still reported at that point — the
waves below retire them, and every other one, outright.

`contract-symmetry-and-narratives` was the worst of them: 66 steps at cognitive score 99, because roughly half of it was
the cross-tree surface-resolution sequence written twice — once for dispatch steps and once for call/register steps,
which the code's own comment described as "IDENTICAL target validation". That duplication is unified first: one
resolution path every entry kind feeds, where the kinds differ only in the verb the finding reads with
(`dispatches through` / `registers callback` / `calls`) and in what the surface must expose (a served capability or an
exposed method). The unification is behaviour-preserving to the letter — every message, anchor, severity, draft context
and `surfaceResolved` flag is byte-identical, verified by diffing the full finding set of all 561 rule-matrix fixtures
before and after. `SURFACE_REF_AMBIGUOUS` still names the reaching clause per kind, and the `surfaceResolved` flag still
marks exactly the findings whose reference resolved against a snapshot, which is what keeps them at full strength in a
chained subproject. The split is four rules rather than the three the shape suggests: the cross-tree half measured 21
even unified, so resolving a reference (`cross-tree-references`: ambiguous, unresolved-outside-the-root, or the plain
typo) is separated from judging the contract it resolved to (`surface-reference-backing`: the declared collaborator, the
exposed method or served capability, the asserted guarantees). The four narratives measure 13, 19, 11 and 18. The family's
`EXCESSIVE_NARRATIVE_STEPS` allow is retired — nothing in it lists more than 20 steps any more.

`stereotype-dependencies` and `pattern-ownership` were the two biggest left — 63 steps at cognitive score 95 and 45 at
52 — and both were re-paying the same prologue before they could check anything: walk the components, walk their
`dependsOn`, resolve the id, decide what an unresolved one means, skip an edge with a retired end, tell an
intra-subsystem edge from a boundary crossing, and let the governing pack profile license the pair. So the prologue is
extracted first, as a fifth entry in the shared read model the section below describes: `ctx.dependencyEdges()`, the
run's resolved dependency edges, each carrying what it declares, what it reached, where that lands (`internal`,
`cross-subsystem`, `surface`, `ambiguous`, `unpinned` or `missing` — six answers, exhaustive), whether either end is
retired, the draft context a finding on it takes, and whether the profile's `allowedEdges` licenses the stereotype pair.
`all` is every edge; `matrix` is the subset the intra-subsystem matrix judges, with all three filters already applied.
The pack escape is the reason the extraction has to come first: it relaxes the WHOLE matrix, and a matrix split five
ways would otherwise repeat it five times — where a licensed edge would escape some parts of it and not others.

Two behaviours had to survive the cut exactly. `ARCHITECTURE_VIOLATION_PORTAL_DEP` is an edge's ONE finding — nothing
may depend on a Portal or an Observer, and no consumer-side check reports the same edge again — which was a `continue`
inside the single loop; `entrypoint-dependencies` keeps it for its own later checks, and the two consumer-side rules
(`logic-dependency-class`, `data-block-dependencies`) open on the same guard, named as the doctrine it is. And
`CROSS_SUBSYSTEM_NON_ADAPTER` still carries `surfaceResolved` on the surface-resolved path and not in-tree, which is
what keeps a chained subproject's verdict at full strength: the two paths stayed two arms of the boundary rule rather
than being merged on the strength of their shared code.

The nine narratives measure 17, 7, 13, 12, 10 (dependencies) and 16, 10, 7, 3 (patterns). `pattern-containment` needed
no further per-kind split: a Repository is judged member by member and the two counting patterns share one pass, which
is 10. `member-visibility` deliberately does NOT read the edge index — it judges the dependency id as authored, and an
id no pattern owns is nobody's private member whether it names a facade, a standalone block or nothing at all, so
resolution, reach and licensing decide nothing there. Behaviour is preserved to the letter: the full finding set of all
561 rule-matrix fixtures (2069 findings) is byte-identical before and after. `doctrine_rules_impl`'s
`EXCESSIVE_NARRATIVE_STEPS` allow is retired and its `NARRATIVE_COMPLEXITY` allow now names only `portalEndpoints` and
`portalCallAuth`, the two the family still owes.

`declarative-assertions` was the last of the 48-step narratives, at cognitive score 61, and its shape was a ladder over
the three assertion kinds: one loop, one `switch`, and three arms that shared nothing but a selector and a message
suffix. The kinds are not implementation detail — a pack author writes `kind: forbid-edge` by hand — so each is now a
rule a user can find in `wairon rules list` under the word they typed, and the shared reading of one assertion (which
components a selector picks, how a violation is reported at the pack's severity with its stated reason) is
`declared-assertion.ts`, imported by all three. The alternative, keeping one rule and hiding the kind dispatch in a
derivation, would have moved the bulk of the logic into three unnarrated functions and left the registry claiming one
rule where a user sees three doctrines. The three narratives measure 14, 14 and 10.

`technology-boundaries` was reshaped rather than split in half: `TECH_ON_LOGIC_COMPONENT` reads an implementation's own
`technologies` and its component's stereotype and nothing else, so it lifts out whole as `technology-binding` (score 3),
but `TECH_LEAKAGE` and `VENDOR_NAME_IN_CONTRACT` share the technology-HOME index — the ownership closure, its contracts,
its implementations and its subsystem chain, per declared token — and separating them would build that index twice. They
stay one rule, at 15 rather than 23, because the collection phase now walks every declared token of every declaring
implementation once instead of nesting a token loop inside an implementation loop, with each declaring component's scope
computed once and reused. That map is deliberately still the PLAIN owner map (every `owns` claim, last claimant winning)
and not `ctx.ownershipIndex()`: it feeds a scope-widening step, so narrowing it would turn one finding into two on a tree
that already carries an ownership error. `target-language` needed neither trick — its two codes never shared a loop, only
the `targetLanguage` opt-in — and its halves measure 6 and 6 once each collects the specs it judges before judging them.

Behaviour is preserved to the letter: the full finding set of all 561 rule-matrix fixtures (2069 findings) is
byte-identical before and after. Both families' `NARRATIVE_COMPLEXITY` and `EXCESSIVE_NARRATIVE_STEPS` allows are
retired outright — nothing in `extension_rules_impl` or `heuristic_rules_impl` reaches the severe band or lists more
than 25 steps any more, and the worst narrative left in either family measures 15.

`public-surface` (33) and `integration-conformance` (29) split along seams their codes already drew, and both splits
cost a precondition the single loop used to inherit by falling through. `public-surface`'s two `continue`s ARE its
precedence: an entry that names no component, or one that names a component that does not exist, says nothing reliable
about a type or a contract, so both siblings restate that guard rather than accuse on top of a binding finding.
`public-surface-bound-contract` needs it most — `intf.component !== pi.component` is trivially true for EVERY interface
when `pi.component` names nothing, so without the guard one mistyped component id would accuse a perfectly good
contract of belonging elsewhere. Its three narratives measure 14, 15 and 16. `integration-conformance`'s precedence was
two `continue`s and an exact-grade gate; `integration-sim-wiring` and `integration-sim-coverage` each restate
`integration-sim-file`'s verdict, so a harness that does not exist is still reported once rather than three times, and
the four measure 7, 7, 14 and 16. Neither split invents a shared "is this judgeable" helper: a precondition one rule
inherits from another is doctrine it owes its own reader, and it is written out where the accusation is.

`namespace-hygiene` (25) is two codes, and was not 25 because of either of them. Its private `checkId` closure has no
spec representation, so the same two checks were unrolled across five id kinds, and splitting alone would have left two
halves of 15 with the five-fold copy intact. The walk moves into the shared read model instead, as `ctx.specIds()` —
every spec id in the tree with the kind label its findings already name it by (`Subsystem`, `Component`, `Interface`,
`Implementation`, `Type`) — and `reserved-id-segments` and `namespace-shadowing` become one loop and one branch each, at
3. It returns every id, in scope or not, and each rule keeps its own `ctx.isSpecInScope` test: which specs a rule may
accuse is doctrine the rule states for itself, not plumbing to be folded away.

`call-conformance` is NOT split and keeps its single code. It asks one question — is every narrative call step realized
as a real call — and two rules for one question is what this section exists to prevent. Its 25 was the DESCENT:
implementation, contract, component, chained-subproject skip, method, source file, facts, exact grade — six of its nine
branches before a single call step was examined. So the descent becomes the read model's second new member,
`ctx.implementationMethods()`: each implementation method with the component it realizes, the file that realizes it (the
method's `sourcePath`, else the implementation's, absent when neither names one) and its draft context, with
implementations whose contract or component does not resolve and those inside a chained subproject already left out.
Plumbing only — the conformance dial and the exact-grade test stay written in `call-conformance`, because "only exact
grade may accuse" is the honesty stance a rule owes its reader and belongs where the accusation is read. The narrative
drops from 25 to 15. `narrative-detail` walks the same descent and will be its second consumer when it splits.

Behaviour is preserved to the letter here too: the full finding set of all 561 rule-matrix fixtures (2069 findings) is
byte-identical before and after. `integrity_rules_impl`'s two allows (`NARRATIVE_COMPLEXITY` and
`EXCESSIVE_NARRATIVE_STEPS`) and `conformance_rules_impl`'s `NARRATIVE_COMPLEXITY` allow are retired outright — nothing
in either family reaches the severe band or lists more than 25 steps any more. That last allow had named
`dependencyConformance` among the narratives it covered, which stopped being true one wave earlier, when the shared read
model below dropped that narrative from 28 to 14.

The last six severe rule methods come under the bar together. `narrative-antipatterns` (26) was three separate proofs
in one file, and its `MEANINGLESS_BRANCH`, `INESCAPABLE_CYCLE` and `UNCONDITIONAL_CALL_CYCLE` become
`meaningless-branches` (11), `inescapable-cycles` (8) and `unconditional-call-cycles` (11). Two of them run a Tarjan
SCC, but over graphs with nothing in common — one method's step graph, and the call graph across every component — so
the traversal moves into a shared module (`narrative/completed-step-graph.ts`) beside the completion-closed step graph
and the "is this step unavoidable" reading, and each rule states its own graph. Sharing the traversal is not sharing
the graph. `narrative-detail` (27) splits along the seam its own comments drew: `narrative-detail` (18) keeps
`MISSING_NARRATIVE` and `INTENT_FLOOR` — the two arms of one branch, a narrative at `full` and prose below it — while
`detail-sufficiency` (16) takes `UNNARRATED_COMPLEXITY` and `DETAIL_BELOW_STEREOTYPE`, which stay together because the
measured finding SUPPRESSES the stereotype one: evidence outranks expectation, and separating them would mean
measuring the same function twice to reproduce that. `portal-endpoints` (20) and `portal-call-auth` (26) were the
cleanest cuts. The first was two arms of one `if` about two different subjects, and becomes `portal-endpoints` (12)
and `non-portal-endpoints` (8). The second is two questions with one subject: `portal-call-auth` (12) judges the CALL
SITE (an authenticated outbound call is made by an Adapter, and says where its credential comes from) and
`auth-source-wiring` (16) judges the SOURCE (a `component:` reference resolves, to an Adapter or Store, that the
presenter is wired to). Five rules for five codes was rejected: the last three codes are one question's three failure
modes — missing, wrong kind, unwired — and each extra rule would re-walk every narrative step in the tree to ask a
third of it. `invariant-backing` (20) splits three ways, since the file already marked its seam: `unique-invariant-ids`
(6) needs only the entity's own invariant list, `invariant-references` (3) walks the steps rather than the entities,
and `invariant-backing` (12) keeps the two codes that share the owner resolution and its write-method scan. The
invariant REFERENCE grammar (`<type-ref>.<invariant-id>`, split at the last dot) moves to `wiring/invariant-ref.ts`,
because one rule resolves such a reference and another asks whether it denotes a particular entity's invariant, and the
two must never disagree about what the string means.

`unused-detection` (20) is deliberately split only three ways, and its three remaining codes stay together. The
reachability walk is the expensive thing and it already runs TWICE: once from internal seeds alone, which is what makes
`INVOKED_BY_REDUNDANT` answerable, and once with the `invokedBy` entrypoints added, which is what makes
`UNUSED_COMPONENT` and `UNUSED_METHOD` answerable. One rule per code would walk the same graph four times. So
`unused-types` (3) lifts out with its own reference scan, `invoked-by-description` (8) lifts out as a prose floor on
the declaration's `caller`, and the reachability trio keeps the rule at 15.

One proposal was refused. `detail-sufficiency` was to take its walk from `ctx.implementationMethods()`, as
`call-conformance` did. It cannot: that member drops implementations whose contract names a component that does not
resolve — which `UNNARRATED_COMPLEXITY` still judges today, tolerating an absent component throughout — and it drops
chained subprojects, which is right for the code-side reading but wrong for `DETAIL_BELOW_STEREOTYPE`, a purely
spec-side verdict that is judged at the parent root like every other spec-side rule. Since the suppression keeps the
two codes in one rule, the rule flattens its own walk instead: it gathers the methods the dial holds below `full` with
nothing written, then judges that flat list — 16 rather than the 26 a nested walk would have cost. No fixture covers
either combination, so the identical finding set would not have caught it.

Behaviour is preserved to the letter once more: the full finding set of all 561 rule-matrix fixtures (2069 findings) is
byte-identical before and after. `narrative_rules_impl`'s, `doctrine_rules_impl`'s and `wiring_rules_impl`'s
`NARRATIVE_COMPLEXITY` allows are retired outright — no rule family carries one any more, and the worst narrative left
in the three measures 19. The built-in registry grows from 77 rules to 86.

### The rules share one derived read model

Four indexes were rebuilt inside individual rules — the same walk, in file after file, with subtly different shapes.
That is duplicated work and duplicated semantics, and it is why several rules could not be split honestly: a seam that
forces an index to be rebuilt twice is a bad seam. They are now memoized `RuleContext` methods over named value objects,
so a pack-authored rule reads them too:

| method | what it holds | who rebuilt it before |
| --- | --- | --- |
| `codeIndex()` | every analyzed path's facts, and its three anchor tiers: what the file declares, what is anchored in it, and its finding anchors | the seven code↔spec conformance rules and the narrative detail dial — eight files |
| `realizationIndex()` | which files realize which components, both ways, plus the implementations behind each — one walk of the implementations whose contract and component resolve and that are not inside a chained subproject | `dependency-conformance` and `integration-conformance`, half-built in `source-file-linkage` |
| `importGraph(paths?)` | resolved import edges, the re-export pass, the file-set connectivity test and the reachability closure — over a CLOSED path set, which is part of the graph's identity because resolution is string matching against it | `dependency-conformance` (mapped exact-grade files) and `integration-conformance` (every analyzed path) walked their own |
| `ownershipIndex()` | which pattern privately owns each member block | `pattern-ownership`, which built it inside the loop that reports on it |

`interfaceMethodsOf` is memoized too: eight rules ask it per dispatch binding or per narrative step, and it rebuilt its
array on every call.

The ownership map is the one whose shape decides findings rather than only speed, so it keeps `pattern-ownership`'s
semantics exactly: a retired or building-block claimant records nothing, so do an unresolved member and an inner
pattern, and where two patterns claim one block the first claimant stays the owner. `dependency-conformance` and
`technology-boundaries` keep their own PLAIN owner maps — every `owns` claim, last claimant winning — because the two
readings differ on trees that already carry an ownership error, where narrowing the map would turn one finding into two.
Switching them is a doctrine decision, not a refactor, and each map now says so where it is built.

Behaviour is preserved to the letter: the full finding set of all 561 rule-matrix fixtures (2069 findings, each dumped
as severity, code, spec id, draft context, surface-resolved flag and message) is byte-identical before and after. On
wairon's own tree `dependencyConformance` drops from cognitive score 28 to 14 — its file map, its edge pass and two
near-identical trace branches are gone — and `hiddenState` from 8 to 6, now that the index's own exact-grade set is the
loop. `patternOwnership` loses the step that recorded the map it reports on.

### Complexity, naming and cohesion are checked

Wairon judged a tree's structure but not its readability. A narrative could grow to sixty steps of nested guards, a
component could be called a registry while being a Store, a method could repeat the name of the component it sits on,
and an Orchestrator could quietly hold two unrelated jobs. Each check below ships with a default drawn from measuring
wairon's own tree, and the rules that add them pass their own thresholds.

- **Narrative complexity, on two independent axes.**
  - `NARRATIVE_COMPLEXITY` (warning) reports a narrative whose cognitive band is above the configured one, `moderate`
    by default. The band comes from shape, not length: a branch, switch, loop or parallel step counts one plus its
    nesting depth, each catch clause of a try counts the same, and each jump counts one, flat — so a flat list of calls
    scores zero however long it is.
  - `EXCESSIVE_NARRATIVE_STEPS` (warning) now **defaults to 25 steps**. Until now it ran only where a project had
    configured a limit.
  - `NARRATIVE_COMPLEXITY_OVER_MAX` and `NARRATIVE_STEPS_OVER_MAX` (errors) report only where `maxCognitiveLevel` or
    `narrativeStepsHardMax` is set; neither has a default.
  - The step check moved from `complexity-and-metadata` to the new `narrative-complexity` rule, so both axes of the
    same judgement live in one place.
- **Naming discipline.**
  - `MISLEADING_BLOCK_WORD` (warning): a component's head noun names a building block it is not, such as a Store still
    called `..._registry`. Only the head noun counts, so `pack_store_adapter` is fine — its qualifiers name what it
    adapts.
  - `GENERIC_COMPONENT_NAME` (warning): manager, helper, utils, handler, service and the rest say nothing.
  - `METHOD_REPEATS_COMPONENT` (warning): a method repeating its component's concept directly after the verb
    (`architecture_diagrams.renderDiagram`). A qualified compound such as `policy_repository.getPackPolicy` is not
    repetition. Adapters and Portals are exempt, because a forwarder's method mirrors the command or route it exposes.
  - `COMPONENT_IS_ITS_ONLY_METHOD` (warning): a component with one method, named after that method — fold it into its
    caller, or name it for its responsibility.
- **Cohesion.** `INCOHESIVE_METHODS` (warning) reports an Orchestrator whose methods fall into two or more groups of two
  or more that share no called component: the shape of a component holding two jobs. A **pure forwarder is exempt** — a
  component whose every narrated method holds exactly one `call` or `dispatch` step and nothing beside it but a `return`
  hands off and answers for no responsibility of its own, so its methods reach different components precisely because it
  is a switchboard. That is the same reasoning that exempts Adapters and Portals from the stutter check above, and the
  same shape §7 already calls pure 1:1 forwarding on a Repository facade. One `local` step — in-component work — or one
  flow step in any narrated method is enough to be judged again, and a method carrying no narrative is the detail dial's
  business, not this rule's. A deliberate facade that is not a pure forwarder still acknowledges the finding with a
  reasoned `lint.allow`.
- **A project's own configuration wins.** The `complexity`, `documentation` and `naming` configs now resolve as the
  profile pack's settings overlaid with the project's own, which is how `rules.sddRuleSeverity` already resolved.
  Before this, an installed pack's profile overrode a project's explicit value.
- **What `wairon rules list` prints is checked against the specs.** Nothing compared a rule's description with the spec
  method it implements, and four had drifted apart. `hidden-state` was still described by its pre-doctrine wording,
  `declarative-assertions` omitted why its codes are the packs' own, and `portal-fields` read two ways at once.
- **New configuration:** `complexity.cognitiveWarnAbove`, `complexity.maxCognitiveLevel` and
  `complexity.narrativeStepsHardMax`, beside the existing `complexity.maxNarrativeSteps`.
- **Wairon's own tree.** The seven components retyped from Registry to Store or Repository in an earlier review are
  renamed for what they are: `credential_repository`, `project_repository` and `secret_repository`, and
  `git_config_store`, `lock_store`, `pack_store` and `producer_config_store`.
- **The naming findings are fixed rather than suppressed.** 37 contract methods stop repeating the component they sit
  on — `architecture_diagrams.renderDiagram` reads `render`, `web_project_orchestrator.listProjects` reads `list` —
  and `mcp_server` drops "Manager" from its name. Where the clean name would be a bare verb exported from a module, or
  a reserved word like `export`, the implementation pins the existing function with `symbol:`, the seam every
  validator rule already uses for `check`. What the complexity and cohesion checks report still carries a reasoned
  `lint.allow` naming the cleanup that removes it.

### Two web orchestrators stop holding two jobs

The cohesion check above named three components on wairon's own tree, and each carried a `lint.allow` promising a split.
The pure-forwarder exemption answers one of them outright (`project_ops_orchestrator`: 38 methods, every one a single
hand-off). The other two are answered by moving the logic — spec-only moves: every method stays the function it already
was, in the file it already lived in.

- **`web_orchestrator` is now `web_session_orchestrator`** and holds only the browser-session lifecycle: SSO sign-in
  start/complete, the built-in admin password sign-in, sign-out on one device and on all of them, the local-developer
  session, the pre-auth login options, and the session-principal context. Its other half was two methods that forwarded
  `getGraph` and `getProjectCanvas` to `web_graph_orchestrator` and did nothing else — the hop left behind when that
  component was split out, for this same dependency reason, and never removed. The hop is gone rather than renamed: a
  third component holding two forwards would be the synthetic facade the doctrine refuses. `web_portal` reaches the
  graph orchestrator directly (6 → 7 dependencies, both already realized in `src/server/web.ts`), and the session
  orchestrator falls from 10 dependencies to 9 and from 10 methods to 8. Its `INCOHESIVE_METHODS` allow is deleted.
- **`web_admin_orchestrator` is now only a switchboard.** Of its 23 methods, 18 already forwarded the browser session
  straight to the identity or permission-admin orchestrator; five did not. Those five — listing organization units,
  upserting one, placing a project into one, disposing of one, and listing the configured secret key names — are the
  instance-structure surfaces the loopback control plane never exposes to a browser, and `src/server/webadmin.ts`
  already gathers exactly them behind one gate (`requireInstanceAdminSession`, whose own comment calls them that). They
  move to a new **`web_instance_admin_orchestrator`** (5 methods, 7 dependencies), which the portal reaches directly.
  What remains forwards and nothing else, so the exemption covers it: its `INCOHESIVE_METHODS` allow is deleted too,
  and the bridge falls from 9 dependencies to 2.
- **Nothing was absorbed over the cap.** The natural homes were already full: `landscape_orchestrator` owns the
  credential-anchored `upsertUnit` and `placeProject`, and `identity_orchestrator` owns the provider configuration the
  secret refs exist to serve. Both sit exactly at the configured `maxComponentDependencies: 10`, and the moved
  workflows need `permission_repository` and `user_repository` (landscape) or `secret_repository` (identity) that
  neither declares. A new component is what the cap leaves.
- **`removeUnit` keeps a step-count allow, reworded, in its new home.** Its 37 steps are the workflow: a gate, an
  existence check, four dispositions to validate and resolve, then either the whole re-homing path (reparent the
  children, re-point the placements, remap the permission and user scopes, delete the emptied unit) or the cascade that
  deletes the subtree, and the best-effort audit. It is one function in `src/server/webadmin.ts`, so narrating it
  shorter would mean naming a component the code does not have.
- **The two allows that stay were rewritten to say what is true.** `cli_runner` and `core_orchestrator` both claimed to
  be deliberate facades. They are not — 27 of the runner's 32 narrated methods and 13 of core's 45 hold flow of their
  own, which is precisely why the new exemption does not reach them. Each allow now rests on the ground that actually
  holds: being the one entry point of the terminal and of the library, which splitting along the call groups would
  multiply.

### The long narratives find the homes their code already had

The step check above named seven methods on wairon's own tree over its 25-step default, each carrying an
`EXCESSIVE_NARRATIVE_STEPS` allow. None of them is complex — every one scores 9 or less on the cognitive axis — so
this was length, not nesting. Five are answered by naming a phase the code already had: four of the six new contract
methods are functions that were sitting in the source unmodelled, so their narrative steps move verbatim into the
method they always belonged to. Two keep an allow, reworded, because their step count is the length of a list, not
the size of a job.

- **`completeSsoLogin` (26 → 20 steps) was inlining two methods its own contract already declares.** The code calls
  `resolveEnabledProvider` and `tryAppendAudit`, which `identity_orchestrator` models as `resolveEnabledProvider` and
  `appendAuditBestEffort` and which `mintSelfToken`, `revokeSelfToken` and `startSsoLogin` were written against; only
  this narrative spelled both out longhand. The four provider-resolution steps and the four-step audit try/catch are
  now one call each. Spec-only — not a line of code changed — and its allow is deleted.
- **One initialization body, narrated once (`createGovernedProject`, 22 steps).** `initializeProjectWithProfile` (29 →
  6) and `executeApprovedInit` (25 → 2) both call `performInit` in `src/server/policy.ts`, whose own comment calls it
  "the single profile-aware initialization body shared by the gated portal path and approval execution". The spec had
  it twice, and the copies had already drifted: three of the twenty step descriptions differed, one of them about who
  `selectedBy` is stamped from. The body is now one method bound to that function by `symbol:`, and each entry narrates
  only what is its own — the credential gate, or the note that there is none.
- **`reconcileProjectPolicy` (34 → 24) hands its profile half to `repairGoverningProfile` (9 steps).** The method ran
  two jobs under one authorization: apply the instance policy's missing required/default packs, then repair a governing
  profile that is broken or non-compliant. The second is now a function of its own in `src/server/policy.ts` and a
  method of its own on the contract, returning what it left in force (`ProfileRepair`); the eight steps moved into it
  byte for byte. A `project_policy_orchestrator.appendAuditBestEffort` binds the same `tryAppendAudit` that file already
  had, mirroring the identity plane, so the audit block is one step on both callers. Dependencies unchanged at 9 — a
  method calling its own component adds no edge.
- **`renameComponent` (30 → 17) hands the move itself to `moveRenamedSpecs` (15 steps).** What carries the length is
  not the guards: reload each renamed spec as the reference rewrite left it, write it under the new id where the loader
  places it, clear a colliding file first, then remove the file it left and prune the folders that empties. That is one
  phase with one name, extracted in `src/core/provision.ts` and narrated there. The shared refusal block the phased
  design proposed — the four guard steps `renameComponent` and `renameMethod` hold in common — is real, but it is worth
  four steps and would have left this at 26: it stays for the DRY pass rather than riding along here.
- **`validateSddTree` (26 → 25) names `resolveThroughParent` (4 steps).** The function has existed since chained
  children were judged through their parents; only the narrative inlined it. This is the one place where a step was
  partitioned rather than moved whole: the old step blended the walk and the parent's verdict (which are the callee's)
  with the gate and the merge (which are the caller's), so each clause now sits on the side that performs it. Nothing
  was dropped.
- **`registerBuiltinRules` keeps its allow, reworded: 89 steps of catalog.** The function is three statements — empty
  the set, walk `SDD_RULES`, append each — and the narrative says exactly that in steps 1, 88 and 89. The other 86 are
  one `register` seed per built-in rule: the catalog that makes each rule family's method reachable, and the list
  `tests/core/rule-catalog.test.ts` pins in order to `SDD_RULES` so registry and rule set cannot drift. Splitting the
  seeds per family would split no code and would break that invariant — the eight families occur in thirteen
  non-contiguous blocks of `SDD_RULES` (integrity alone in three, at positions 1–7, 59–61 and 86), so per-family
  registration would reorder the run sequence. A new rule adds one step here, which is the point.
- **`runPack` keeps its allow, reworded: 26 steps of command family.** A flat twelve-arm `if`-chain, one adapter call
  per `wairon pack` subcommand, two steps each plus the switch and the unknown-action refusal. The same shape sits at
  every size in the runner — `runPacks` (8), `runAgent` (9), `runSurface` (12), `runRemote` (14) — and there is no seam
  to split on: all twelve arms call one module, and every subcommand's action calls `runPack` directly, so scope-based
  sub-dispatchers would be invented rather than named.
- **Allows deleted:** the `EXCESSIVE_NARRATIVE_STEPS` allows on `identity_orchestrator_impl`, `core_orchestrator_impl`,
  `spec_validator_impl` and `project_policy_orchestrator_impl` (which covered two methods). `cli_runner_impl` keeps its
  unrelated `UNDECLARED_DEPENDENCY` allow untouched. Two value objects are new for the extracted returns:
  `ParentResolution` and `ProfileRepair`. Tree: 0 findings before and after.

### The last two severe narratives: one names the functions it already called, one names the derivation inside it

The two narratives still in the severe cognitive band — the only ones left in the tree — carried the last
`NARRATIVE_COMPLEXITY` allows. Neither turned out to be complicated logic. One was three phases of a request narrated as
one method although the code had split them years ago; the other was a pure derivation inlined into a graph walk.

- **`host_request_orchestrator.handle` (59 steps / score 25 → 21 / 5) was inlining two functions the code already had.**
  `src/server/request.ts` exports `dispatchProjectLifecycleTool` and `auditToolCall`, and `handleMcpRequest` calls both —
  but `ihost_request_orchestrator` declared only `handle` and `viewDiagram`, so the spec spelled both out longhand. Both
  are contract methods now, each bound by `symbol:` to the function that was already sitting there. Steps 13–46 (the
  sixteen-arm hosted tool table and the envelope it shapes) move into `dispatchProjectLifecycleTool`; steps 54–58 (build
  the redacted event, append it, diagnose a failure) move into `auditToolCall` (6 steps, score 1), which is what the
  confinement refusal, the permission refusal and both dispatch paths have always shared. Spec-only — not a line of code
  changed — and one new value object, `McpToolResponse`, for the envelope the dispatch returns. No dependency was added:
  a method calling its own component adds no edge, so the component stays at 9 against its cap of 10.
- **The tool table keeps a step allow, reworded, because its length is a list and not a job.**
  `dispatchProjectLifecycleTool` lists 38 steps and scores 18: one guard, one switch, and sixteen arms of two steps each
  — a call to the orchestrator that owns the tool, then the jump back to the single envelope-shaping step. Splitting it
  by owning orchestrator would invent three sub-dispatchers where `request.ts` has one switch, and each would need a
  `default` arm invented for it: today the single default IS `sdd_host_get_approval_status`, so two of the three new
  defaults would be unreachable code deciding what an impossible tool name does. Same shape and same reasoning as
  `cli_runner.runPack` (26) and `rule_registry.registerBuiltinRules` (89).
- **`narrative_graph_projector.walk` (25 steps / score 21 → 20 / 15) hands its per-step edge derivation to `stepEdges`
  (8 steps, score 1).** Unlike `handle`, this one is a genuine extraction: the file held exactly one exported function
  and a `methodKey` helper, so nothing was waiting to be modelled. The switch inside the narrative loop — which edges a
  `call`, `register` or `dispatch` step contributes — is a pure derivation over one step, so it is now a pure function
  returning `NarrativeEdge[]`, and the walk applies each edge by reaching its component and enqueueing its method. The
  three per-arm jumps disappear with it.
- **The derivation stayed on the component and did NOT become a `narrative_step` type method.**
  `method_implementation.cognitiveScore()` and `stepGraph()` are the precedent for pure arithmetic belonging on the type,
  and it was measured against them. Refused for three reasons, now written into the component's own description: the
  derivation needs the whole tree's components to route a `dispatch` step through a Portal's dispatch table, so it is not
  intrinsic to one step; it takes `followRegisterEdges`, which is the walk's policy rather than a property of the step;
  and what the switch encodes IS the doctrine the component exists to carry in an L5 narrative (a `register` step is a
  handoff, a dispatch table is a served surface) — and a type method carries no narrative.
- **Allows: two `NARRATIVE_COMPLEXITY` deleted** (`host_request_orchestrator_impl`, `narrative_graph_projector_impl`)
  **and one `EXCESSIVE_NARRATIVE_STEPS` reworded** (`host_request_orchestrator_impl`, which named `handle` and now names
  the tool table it moved to). No narrative anywhere in the tree is severe any more, and every step allow that remains
  says why it is permanent.
- **Proof.** 56 of `handle`'s 59 steps and 18 of `walk`'s 25 are byte-identical in their new homes, diffed field by field
  with jump targets relocated for the shift; the three that are not are the seam itself — the branch that blended the
  callee's classification with the caller's dispatch, and the two jumps the method boundary replaced — partitioned clause
  by clause with no clause dropped. The projector's extraction was checked against the pre-extraction inner loop over all
  384 shapes of narrative step (every type × target × method × capability × option) and agrees on every one. 3316 unit
  tests, 21 e2e; the tree validates at 0 findings before and after.

### The twelve draft components are complete — nothing in the tree is draft any more

D2b's last item. Ten `sdd_validator` components (`conformance_rules`, `doctrine_rules`, `extension_rules`,
`heuristic_rules`, `integrity_rules`, `intrinsic_rules`, `narrative_rules`, `wiring_rules`, `gate_identity`,
`narrative_graph_projector`) and two on `sdd_host` (`backup_schedule`, `instance_bootstrap`) were still `draft`, each
with its interface and its implementation — 36 specs. They are `complete`. Every spec in the tree now says `complete`,
so the draft machinery has nothing left to apply to.

- **What it turns on.** A finding carrying draft context had two escapes. `getRuleSeverity` downgraded the 23
  completeness codes from error to warning — `MISSING_IMPLEMENTATION_METHOD`, `MISSING_NARRATIVE`, `INTENT_FLOOR`,
  `MISSING_ENDPOINT`, the structural-conformance family (`MISSING_SOURCE_PATH`, `MISSING_SOURCE_FILE`,
  `UNREALIZED_METHOD`, `UNDECLARED_DEPENDENCY`, …), `UNNARRATED_COMPLEXITY`, `UNASSERTED_INVARIANT`,
  `CALL_STEP_UNREALIZED` and the integration-sim gate — and `--ci` waived `DRAFT_COMPONENT_WARNING` outright plus any
  `UNUSED_COMPONENT` raised against a draft component. `MISSING_INTEGRATION_SIM` skipped a draft implementation before
  it was ever asked. None of that applies to the rule families any more: if one of them drifts from the code that
  realizes it, or loses a narrative, the gate fails with an error instead of printing a warning that `--ci` forgives.
- **It cost nothing, because the tree was already complete-clean.** `validate` and `validate --ci` were at 0 findings
  before the promotion and at 0 findings after it. No `lint.allow` was added, and none was made stale: no allow in the
  tree rests on draft or design status, and the 36 specs carried no allows at all. `status` — with `updatedAt` — is the
  only field that moved on any of them: 36 files, 72 insertions, 72 deletions, two lines each. 3316 unit tests, 21 e2e.
- **One exemption is now the subsystem's, not the component's.** `backup_schedule` and `instance_bootstrap` each declare
  two dependencies and no `simPath`, so `MISSING_INTEGRATION_SIM` is live for them and silent only because `sdd_host`
  has adopted no integration sims (the rule asks per subsystem; `sdd_validator` has 16). The first sim `sdd_host`
  declares will put the question to both of them — as an error now, where a draft would have been asked nothing.

### Execution budgets: the topology gains a resource axis

The derived topology said who owns what, and nothing about what their work costs
to do. In a delegating workflow that gap is expensive: a subagent's `model` field
defaults to `inherit`, so an agent file that omits it silently adopts the parent
session's model — measured across three archived sessions of this project's own
development, 1,860 of 2,176 subagent turns ran on the most expensive tier that
way, and the fixed per-spawn overhead everyone worries about was under 2% of the
bill by comparison.

- **`ExecutionProfile` — what the work is like.** Derived from the topology alone
  (no spec authoring): `breadth` from owned-path spread, `writes` from the role,
  `reasoningDepth` from the component stereotype, `delegates` from the template.
  The vocabulary already encoded the last one — a Store is plumbing its contract
  and narrative fully describe, an Orchestrator carries the decisions — so
  derivation reads the stereotype rather than inventing a second classification.
- **`ExecutionBudget` — what that earns.** Capability *tiers* (`small`,
  `standard`, `large`, `frontier`), never vendor model names, plus effort, a turn
  ceiling, a tool class, nested-delegation rights and MCP access. Mapping a tier
  onto a real model is the consumer's job, because only the consumer knows what
  its host tool understands.
- **A tier dial, `execution.tier`, defaulting to `off`.** `free` applies
  structural constraints only and is defined as having no quality tradeoff at
  all; `default` adds tier selection and turn ceilings; `trade` and `aggressive`
  each name what they cost. Raising the dial can only tighten a budget, so it is
  safe to turn without auditing every agent. At `off` every output is
  byte-identical to before this existed.
- **Both delivery paths carry it.** Generated agent files can *enforce* a budget
  through front-matter (`model`, `effort`, `maxTurns`, `tools`, `mcpServers`);
  a live brief can only *advise*, since the caller spawning from it is what
  applies it. That asymmetry is deliberate — a brief is consumed by tools wairon
  does not control. Since `materializeAgentFiles` is off by default, the brief is
  the path most projects actually use.
- **`frontier` is never derived.** It is reachable only by an explicit
  per-agent override, and it is not an owner tier: treat it as a sparring partner
  for a question the specs do not settle. An owner that genuinely needs it is
  usually a component doing too much.
- **`orchestrate` is not derived either.** Every agent in a wairon topology owns
  and authors something — even a chained-subproject owner writes its mount spec —
  so the thin no-bulk-content grant would break them rather than make them
  cheaper. It stays selectable by override for a hand-defined manager.

`sdd-delegate` applies the budget when spawning, because constituting a subagent
correctly is part of spawning it rather than a separate concern.

Budget front-matter is emitted for the `claude` target only. The
`cursor`/`copilot`/`codex` targets reuse the Claude markdown shape, but the
budget fields are Claude Code's subagent contract — writing them elsewhere
would add keys those tools ignore rather than constraints they honour, and an
unhonoured budget reads as enforced when nothing enforces it. A target opts in
once its own fields are verified.

`wairon execution show` lists every agent's allowance with the rationale that
produced it, so a tier choice is auditable rather than magic;
`wairon execution set-tier <tier>` moves the dial and says what the new tier
costs before you keep it.

### `wairon lock` stopped rewriting your spec tree

Approving used to ratchet every spec's `status` from `draft` to `complete` on
disk — **786 files** on this project's own tree, for a decision that changed no
design. A lock scoped to one subsystem still rewrote everything it could reach,
and the specs a human had actually edited were buried under files whose content
had not changed. `.wai/phased_design.md` records that blanket freeze being
reverted by hand four times, once annotated "product gap: lock needs phase
awareness".

The fix is one addition that retires several concepts: **record what was
approved per spec, not one hash of the whole tree.**

- **The approval lives on the committed lock record** (`src/core/approval.ts` →
  `.wai/lock.json`): one sha256 per spec file, ~90 KB for this project's 786
  specs. Being committed is the point — a teammate, a fresh clone and CI all see
  the same approval the approver saw. Keys are sorted, so re-approving a
  one-spec change is a two-line diff; digests normalize line endings, so an
  approval taken on Windows survives a Linux checkout. A test asserts the spec
  tree is byte-identical after `lock`.
- **`wairon status` names what moved** instead of asserting that something did.
  `Lock: STALE` — which fired on a tree validating 0 errors / 0 warnings, named
  nothing, and asked for work producing no new information — is gone:

  ```
  3 specs changed since approval (2 changed, 1 added) — approved … by Robbe <…>:
    .wai/specs/sdd_core/spec_loader/.index.yaml
    ...
  ```

  Silent before there has ever been an approval: a design still being written
  is not news.
- **Settledness is derived, not stored.** The ratchet was load-bearing — the
  MCP authoring tools always write `status: 'draft'`, draft specs get
  completeness findings downgraded to warnings, and lock was the only promoter,
  so deleting it naively would have left the gate permanently soft. A spec that
  is approved and unchanged is now presented to the rules as complete in
  memory. It is also bidirectional, which the one-way on-disk ratchet could
  never be: a spec that drifts after approval returns to draft context by
  itself.
- **`lockedBy` records the identity AND its source.** `hosted` was
  authenticated by the instance; `git` and `os` are self-declared. Locally the
  git author identity is preferred, because it is what a reviewer can match
  against the commit carrying the lock, falling back to `user@hostname`. The
  hosted lock previously wrote a constant `admin:master` while its caller held a
  resolved principal; it now records the subject, and on the approval path the
  decider rather than the requester.
- **Per `.wai`, with children pinned.** Every project root owns its own lock
  record, so a parent's approval never freezes a child's in-flight work and a
  child cloned alone carries its approval with it. A parent pins each child's
  approved `StateId` the way a submodule pins a commit: a child edit does not
  dirty the parent, but the parent still sees the child move.
- **`lock --subsystem` approves only its own scope.** Everything outside keeps
  the approval it already had.

Rationale record: [docs/design/approval-baseline.md](docs/design/approval-baseline.md).

### Removed: `promote`, a second gate on an already-locked door

`wairon host promote` re-read the lock, recomputed the `StateId`, and — if
nothing had drifted — flipped `.wai/lock.json`'s `status` from `ready` to
`promoted`. That was its entire effect. `'promoted'` appeared in four places in
the whole codebase: the field's comment, its type union, the single write, and
one UI function that treated `ready` and `promoted` **identically**. Nothing
merged, published, deployed, or branched on it; its own success message read
"change-set marked ready for promotion".

It was designed as a separation-of-duties checkpoint, wired through the approval
machinery so a second person could sign off. But `lock` is already the human
gate — agents do not run it — so promote gated a door that was already locked.

Removed end to end: the CLI command, the `sdd_host_promote_project` MCP tool,
the admin and web HTTP routes, `executeApprovedPromote`, the lifecycle
orchestrator action, the `project:promote` approval kind, `PromoteResult`, and
the Promote button. `LockRecord.status` is now the single value `'ready'`.

**Kept:** the `promote:mark-ready` → `project:write` alias in `migration.ts`, so
stored permission grants on existing hosted instances still upgrade.

Separation of duties is worth rebuilding — but on a baseline, where "approved by
X at baseline B" is a reviewable fact, rather than as a status string nothing
reads.
### Spec trees move between local and hosted — `.waitree` archives + `wairon remote`

A spec tree was stuck where it was born: a project outgrowing local had no path
to a hosted instance, a hosted project could not be forked locally, and a
developer whose agent worked against a hosted project could not run `wairon
validate` from their checkout at all. Three additions close that, sharing one
archive format.

- **`.waitree`, the spec-tree archive.** A project's whole tree — its own `.wai/`
  plus the `.wai/` of every chained subproject, at their original relative paths
  — packs into one file with a `wairon-tree.yaml` envelope carrying the project
  name, the packed roots, the tree's content state id and per-entry sha256s.
  Authored design travels (specs, lock, rules, variants, surfaces, packs);
  regenerable artifacts (`generated/`, `docs/`) stay behind unless asked for,
  since the destination rebuilds them. Rides the same ZIP boundary and the same
  pre-decompress safety model as `.wpack` (zip-slip, bomb, depth, symlink), with
  caps sized for thousands of small YAML files.
- **Hosted export/import.** `sdd_host_export_tree` / `sdd_host_import_tree` on
  the data plane (project:read / project:admin), a **Transfer** tab in the web
  project view, and `GET|POST /admin/projects/{id}/tree` for operators. Both are
  TREE-scoped like lock and promote: a credential narrowed to `proj::child`
  transfers exactly that child. Import **never writes into a live tree** — it
  extracts to staging inside the project root and only then swaps into place,
  moving the previous tree aside to a timestamped backup, so a rejected or
  corrupt archive leaves the destination byte-identical. Executable content
  (a bundled code pack) is always refused over the wire, the same rule the pack
  surface already applies; a local extraction on your own machine is the trusted
  filesystem tier and is not restricted.
- **`wairon remote push|pull|attach|detach|status`, `wairon login|logout`.**
  Migration in both directions from a checkout, over the *same* authenticated MCP
  endpoint an agent uses — no second auth surface. `attach` records a standing
  binding (instance + project in `.wai/remote.json`, credential in
  `~/.wairon/credentials.json`, never mixed), after which `validate`, `status`
  and `lock` run against the hosted tree; everything needing local files keeps
  failing with guidance to pull first. With nothing attached, the binding falls
  back to **the agent's own MCP configuration** — so a developer whose agent
  already works against a hosted project types no credential twice, and the two
  cannot drift onto different projects. `wairon mcp install --hosted <url>`
  writes that entry.

Two constraints worth knowing: creating the destination project during
`push --unit` rides the hosted *web* route (the data plane resolves its project
binding before dispatch, so it cannot address a project that does not exist yet),
and `wairon logout` forgets a credential locally without revoking it — revocation
lives in the hosted UI under Tokens, which the command says out loud.

### Fixed: `wairon update` installed dev builds onto stable installs

`-dev.N` was never in the self-updater's list of pre-release labels — it knew
only `-beta.N` and `-preview.N` — so a dev build fell through the channel filter
as a *stable* release. On the default `stable` channel, `wairon update` would
download the build cut from the last merge to `dev`. Both halves of the release
pipeline were already correct (every `-dev.N` GitHub release is marked
pre-release, and npm has `latest` on the stable version with dev builds under the
`dev` dist-tag), so this was purely the client misreading correct tags — no
release or tag needed republishing.

`dev` is now a first-class update channel alongside `stable`, `beta` and
`preview`. Channels are ranked, and each sees its own tier and every narrower
one: `stable` installs only `vX.Y.Z`, `dev` sees everything. Switch with
`wairon update --channel dev` (persisted in `~/.wairon/config.json`); an
unrecognized `--channel` value is now rejected rather than saved.

Classification is closed by default, which is what failed before: any tag with a
pre-release suffix is a pre-release, and a suffix this build does not recognize
(`-rc.1`, `-nightly.N`) ranks at the *widest* tier instead of falling through to
stable — so the next label added to the release pipeline cannot repeat this. The
updater also cross-checks GitHub's own `prerelease` flag, so a release marked
pre-release is never a stable-channel candidate however its tag reads. Two
related fixes ride along: an up-to-date narrow channel now says when a newer
pre-release exists on a wider one (silence read as "nothing is newer" rather
than "nothing is newer *for you*"), and the release page size went from 20 to
100 — `dev` cuts a build per merge, so a page of 20 could hold nothing but
`-dev.N` and leave a stable install seeing no eligible release at all.

### `sdd_get_status`, `sdd_validate_tree` and `listDomains` can be exercised end to end again

Four `sdd_*` tools reached their implementations through lazy
`require('../commands/status.js')`-style calls. Shipped builds were fine — the
bundler inlines those — but the test runner resolves neither the `.js` specifier
nor the path, so any test driving them through a real MCP client got `Cannot
find module` instead of a result. They could be shipped but not proven, which is
how the hosted data plane ended up with tools no end-to-end test covered. Now
static imports, extending the fix already applied once to the spec surface (and
documented there) to the rest. `context.ts`'s lazy `require('./domains.js')` —
documented as breaking a circular dependency that does not exist — went the same
way.

### `wairon dev` is its own local mode again — no sign-in screen, no hosted chrome

The local dev server could land on the hosted sign-in screen and stay there,
reporting *"No sign-in method is configured on this instance"* — a dead end,
since `wairon dev` deliberately configures none. Two causes, both fixed, plus the
mode itself is now a distinct surface rather than the hosted app with pieces
hidden.

- **A stale session cookie no longer wedges the dev server.** Auto-login only ran
  on a *cookieless* GET, but session cookies are not port-scoped: a
  `wairon_session` left by another project's dev server, a hosted instance on the
  same host, or an ephemeral dev data dir that was cleaned would be presented,
  resolve to nothing, and 401. Any bearerless GET in devMode now re-establishes
  the local session and overrides the presented cookie (re-sending `Set-Cookie`
  only when the value actually changes). Hosted mode is untouched — it still
  mints nothing and 404s `/web/dev-login`.
- **An expired dev session is no longer handed back.** `startDevSession` reused
  the first stored session for the local-developer subject without checking its
  expiry, so after the 30-day TTL it returned a dead credential forever. It now
  prunes expired sessions before reuse and mints a fresh one.
- **Local mode is a separate shell.** `wairon dev` serves one project on
  loopback with no accounts, so it no longer renders the environment/org-unit
  navigator or hosted chrome: a slim bar with two surfaces — **Canvas** (the live
  architecture graph, bound to the local project) and **Specs** (the spec value
  editor, previously unreachable in dev) — sharing the same components as the
  hosted app, so the canvas ↔ specs deep-links work in both. The sign-in screen
  is unreachable in local mode: an unauthenticated boot probes the dev-only
  re-establish route once, recovering silently on a dev server and falling
  through to the real login only on a hosted one.

### Validator fixes: --ci draft parity + namespace shadowing detectable from disk

Two intent/implementation gaps the rule-matrix and e2e tiers surfaced, both
fixed to match the documented intent.

- **`validate --ci` waives `DRAFT_SUBSYSTEM_WARNING` like the component
  variant** — `isCiDraftWaivable` waived `DRAFT_COMPONENT_WARNING` but not
  `DRAFT_SUBSYSTEM_WARNING`, so any fresh draft tree failed `--ci` on a pure
  status notice while the CLI simultaneously printed "N draft-related
  warning(s) (non-fatal in --ci)". Both codes (the whole `DRAFT_*_WARNING`
  family — hierarchy.ts emits each with the same unconditional draft context)
  are now waived identically; every other warning, including draft-downgraded
  completeness findings like an unbound Portal method, stays fatal. The e2e
  authoring journey's `lint.allow` workaround for this is gone.
- **Declaration-site ids always mount-qualify, so `NAMESPACE_SHADOWING` is
  reachable** — the loader ran a chained child's DECLARED spec ids through the
  same `qualifyId` used for references, whose root-subsystem anchor returned
  any bare id colliding with a root subsystem name UNQUALIFIED. A child
  subsystem named like a root subsystem therefore silently merged into the
  root's id space (duplicate subsystem + `ORPHANED_SUBSYSTEM` noise, no
  shadowing warning) — the exact hazard `NAMESPACE_SHADOWING` documents, with
  its tripwire structurally unreachable from disk. Declarations now qualify
  through a dedicated `qualifyDeclaredId` (mount realizations — a child
  subsystem under the mount's own name — still collapse onto the mount);
  reference resolution is untouched, so `::`-absolute and bare root-anchored
  references from a child to root subsystems resolve exactly as before.
  **Behavior change:** a colliding chained-child subsystem (or component/
  interface/implementation/type) id now loads qualified (e.g.
  `partner-billing::ledger`) and trips `NAMESPACE_SHADOWING` instead of
  silently merging into the root subsystem's id space.

### Specialist dependency matrix closed: Registry and Actor edges now flag

**Superseded before release.** The Specialist has retired, and this code with it: see *Logic is an Orchestrator;
Specialist and the Gateway pattern retire*. This entry records the dev builds that carried it.

The Specialist is the wildcard block and was historically misused as a god
component (up to holding entity state in memory); the deliberate
counter-doctrine is that ALL storage — even in-memory — goes through the
Store/Registry/Index/Repository mechanism and Specialists stay pure
capabilities. The enforced forbidden list said so for Store but left the
persistence WRITE path and one runtime block open — an oversight the
rule-matrix sweep surfaced, now closed.

- **Behavior change:** `Specialist → Registry` and `Specialist → Actor`
  `dependsOn` edges now flag `ARCHITECTURE_VIOLATION_SPECIALIST_DEP` (error),
  joining Portal/Observer/Orchestrator/Store/Supervisor. This closes the
  wildcard god-component channel; Repository facades (plus Indexes, Adapters,
  and other Specialists) remain the legal way for a Specialist to reach held
  state. The rule message, doc comment, and the architecture standard's
  dependency-rules bullet now state the closed list.
- **Migration:** an existing tree with a deliberate `Specialist → Registry`/
  `Actor` edge acknowledges it with a `lint.allow` reason on the spec — or,
  better, retypes/rewires per the message's Repository-facade resolution.
  (Note errors are not locally suppressible by default; re-tune the code via
  `rules.sddRuleSeverity` first if a transition period is needed.)

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

### The gated write seam is its own subsystem

`src/core/authoring.ts` is the boundary every spec write passes: it judges a
component against the intrinsic rules and only then persists it, and it injects
that same judgement into the store's delta update as a hook. No spec named it, so
the one place that decides what may be written was the one place the tree could
not see — and the interface it calls said so out loud (`validateComponentCandidate`
carried "no sdd_core narrative models that call yet, because no spec names
authoring.ts").

The file's own header states the layering: *access paths → authoring → specs +
rules*. It is a layer **above** both `sdd_core` and `sdd_validator`, and a layer
above two peers cannot live inside one of them without inverting an edge.
Modelling it inside `sdd_core` first made that concrete, and cost three things —
the same mistake in three shapes: a second component that existed only to make the
hop into `sdd_validator` legal, a new `sdd_core → sdd_validator` trusted link
declaring a mutual coupling that did not exist, and a gate nothing depended on,
whose real caller could only be written down as prose. So the seam is
**`sdd_authoring`**, a subsystem of its own.

- **`authoring_portal`** (Portal) is the published surface: `addComponent` and
  `updateSpecGated`, the two exports `src/mcp/server.ts` imports. It exists so the
  inbound hop is a drawn edge — a cross-subsystem dependency may only enter through
  a published Portal.
- **`authoring_orchestrator`** (Orchestrator) is the gated workflow: `addComponent`
  judges a candidate and refuses it before anything touches disk; `updateSpecGated`
  builds the judgement as a write hook and hands the delta outward. A Portal never
  performs the write itself, so both writes route through here — the layer the
  doctrine has always required a Portal's writes to reach.
- **`authoring_core_adapter`** and **`authoring_validator_adapter`** (Adapters) name
  the two outward hops: to `sdd_core` for the writes and for the project's own rule
  severities, and to `sdd_validator` for the candidate judgement. Only a local client
  Adapter may cross a subsystem boundary, and both hops run outward.
- **`mcp_authoring_adapter`** (Adapter, `sdd_mcp`) makes the seam's inbound edge real.
  `sdd_add_component` now reaches `authoring_portal.addComponent` instead of claiming
  a `core_portal.saveComponentSpec` call the code never made — the spec had recorded
  the truth only as a `symbol: addComponent` footnote.
- **`core_orchestrator.updateSpec`** is on the contract at last — the delta applier
  the authoring tools have written through for months, with the guards, the merge,
  the no-op comparison and the injected gate in its narrative — and
  **`core_portal.updateSpec`** publishes it, because the caller now stands outside
  `sdd_core`.
- **The `sdd_core → sdd_validator` trusted link is gone.** It was needed only while
  the gate lived inside `sdd_core`. With the gate outside, both of its hops run
  outward and `sdd_validator` reads the spec tree through `sdd_core` exactly as it
  always did: no dependency is mutual, nothing needs acknowledging, and the tree now
  declares no `trustedLinks` anywhere.
- **No method carries an `invokedBy` any more.** Every edge the seam needs is drawn,
  including the one from the MCP server that used only to be described.

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

- **A write that changed nothing reported "Successfully updated".** `sdd_update_spec`
  answered with the same sentence whether a delta rewrote a narrative or landed
  nowhere at all, and re-stamped `updatedAt` on the way, so an edit that never
  happened was indistinguishable from one that did — and left a diff behind to prove
  it had. An update now compares the merged spec with what is stored, read through
  the same level schema the writer uses, and **writes nothing when they match**: the
  answer says so, and the file is untouched. When something did change, the answer
  names every change by path — `methods.runJourney.narrative.step 7.type`,
  `dependsOn`, `description` — with what it was and what it is. `updateSpec` and
  `updateSpecGated` return that report instead of a bare notice list.
- **A method-level `unset` silently did nothing.** `unset` was a verb at the top
  level only. One level down — on a method, a param, a field, a narrative step, a
  dispatch binding — it was neither a field nor a verb: it merged onto the element
  as data, the writer schema stripped it, and the tool answered "Successfully
  updated implementation spec" over a spec it had left exactly as it found it. A
  method's `symbol`, a step's `label`, could be set and never cleared. `unset` is
  now honoured at every level, and `[]` clears a method's `narrative` the way it
  clears every other list it names (fed to the step merge, `[]` used to mean "upsert
  no steps" and left the narrative in place).
- **Changing a step's `type` left the old type's fields standing.** A retype merged
  the new type's fields over the step and kept everything else, so a `branch` that
  became a `call` still carried its `condition` and `onFalseStep`: a step the schema
  accepts, a write that reports success, and a `MALFORMED_FLOW_STEP` at the next
  validate, blamed on the narrative rather than on the edit that made it. A step
  whose `type` changes is now **rebuilt for its new type** — every field the new type
  cannot carry is dropped and named in a NOTICE, while the human's own content (the
  `description`, and the `label` other steps address it by) is kept. A delta that
  retypes AND sets a field the new type cannot carry is refused rather than quietly
  stripped: dropping a stored leftover is cleaning up after the old type, dropping
  what the caller just wrote is ignoring them. Dissolving a region is now an
  explicit, reported act — retype a `loop`/`try`/`parallel` header and its `endStep`,
  `catches` and `finallyStep` go with it.
- **A label could not retarget a jump that already had a number.** Symbolic labels
  resolved only where no number was stored: a delta repointing an existing jump with
  `onFalseLabel` merged the label onto the OLD number, and resolution then saw both
  and refused the write as a contradiction ("sets both `onFalseStep=2` and
  `onFalseLabel="cleanup"` — they disagree"), leaving hand-counted numbers as the only
  way to move a jump. In a DELTA the number is what is stored and the label is the new
  intent, so **the stored twin gives way** — for every `*Label` field, and for a
  `cases`/`catches` entry's `label`. A delta that sets the number and its label
  together is still a genuine contradiction and still refused.
- **Three step deletes that broke a narrative silently.** `action: "delete"` refused
  exactly one thing: a step another step jumps to. It now also refuses **a delete that
  addresses no step** (a marker the writer stripped while reporting success), **a
  delete whose restated `label` or `description` does not match the step it landed
  on**, and **a delete of a loop/try/parallel header whose body is still there** —
  which used to leave that body standing with nothing looping, guarding or forking it:
  a narrative that still validates and no longer means what it says. The second guard
  exists because step deltas apply in ascending order against the numbering the
  earlier entries of the SAME delta left behind — delete step 3 and step 7 becomes
  step 6, so a second delete written as 7 addresses what used to be step 8. Restating
  what is being deleted is the only way that is ever noticed. That order is now
  written down: in the tool description, on the `SpecDelta` type, and above
  `updateSpec` itself alongside the rest of the application pipeline.
- **The identity promise stopped one level below the spec's own fields.** "Arrays
  upsert, they do not replace" was true of a spec's top-level arrays and of nothing
  inside them: a delta naming ONE of a method's `params` replaced the whole list and
  silently deleted the rest, and a delta retargeting ONE of a `try` step's `catches`
  dropped every other clause — the same data loss the top level was fixed for, one
  level down, with the tool still promising otherwise. Nested arrays now merge by
  identity at **every** depth, with the same delete markers and the same
  phantom-delete refusal. Switch cases are addressed by `value` and try catches by
  `error`, never by their `step`, which is a relocatable number and not an identity.
  Parallel arms follow the general rule: named, they merge by name; unnamed, they
  carry no identity at all and the list still replaces wholesale.
- **The authoring seam's configuration read reached past the portal it declares.**
  `candidateOptions` called `projectConfigRepository.load()` directly, so the spec had
  to carry intent prose where a call step belonged. It calls the core portal's
  `loadProjectConfig` now — the identical one-line read — and the spec says so with a
  call step, like its two siblings.
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
2. **Re-lock any locked project.** The lock now covers doctrine and the surface
   contracts a verdict consulted, so records written before this release read as
   *stale* until you re-lock. This fails closed by design: those locks were taken
   without that coverage and cannot be retro-verified.
3. **Declare the packs your projects apply.** Machine-wide packs no longer apply
   unless a project selects them. Run `wairon doctor` to see what is installed but
   unapplied and `wairon doctor --fix` to record it as explicit selections — or set
   `extensions.useGlobalPacks: true` in `.wai/project.yaml` to keep the old
   behaviour. **A project whose subsystem references a global pack's `profile` will
   otherwise report `UNKNOWN_PROFILE`, which fails `validate --ci`.**
4. **Embedding wairon as a library:** `LoadedExtensions` gained required
   `instructions` and `selectionFailures` fields. Use the exported
   `emptyExtensions()` rather than hand-constructing one.
5. **Chained subprojects: re-run `validate --ci` in each child.** It can newly
   fail, by design — it was waving these through:
   - a reference into the parent now carries the parent's verdict; fix the edge
     the parent rejects;
   - a child validated without its parent on disk keeps raw
     `CROSS_TREE_REF_UNRESOLVED` warnings — run `wairon surface pin` in the child
     while the parent is available, and commit the pinned surfaces;
   - a `MISSING_SOURCE_FILE` on a path written relative to the parent root: make
     it child-relative, or re-save the implementation through the parent, which
     now re-expresses it;
   - replace `wairon surface generate-children` in scripts with `wairon surface
     pin` run from the child, and drop `lint.allow` entries naming
     `UNVERIFIED_EXTERNAL_REF` or `CHAINED_SUBPROJECT_CONTEXT` (now reported as
     unknown codes);
   - a nested child whose `projectPath` leaves its own project (a `../sibling`)
     is now `PROJECTPATH_ESCAPE` from every root, the top one included: mount the
     sibling from the project that contains both;
   - a reference that names no provider, where two pinned surfaces expose that
     name with different contracts, is now `SURFACE_REF_AMBIGUOUS`: name its
     provider (`super::<provider>::<name>`);
   - a `.waitree` export (`wairon remote push|pull`, `sdd_host_export_tree`, the
     admin and web export routes) that would leave out a chained mount now
     refuses: fix the mount, or pass `--allow-partial` / `allowPartial` to export
     without it.
6. **Retype Specialists and migrate Gateways: run `wairon doctor`, then
   `wairon doctor --fix`.** A tree with either now fails `validate --ci` with
   `STEREOTYPE_RETIRED`, and the write tools refuse to save a component that keeps
   one.
   - `--fix` retypes each Specialist to an Orchestrator with the `dependencyClass`
     its dependencies give it, or none (a workflow) when a dependency fits neither,
     and rebases project variants built on Specialist.
   - Migrate each Gateway by hand: (1) the Portal it owns becomes the front door,
     with `variant: gateway`; (2) its other members become dependencies of that
     Portal; (3) its consumers depend on that Portal; (4) delete the Gateway spec.
     `sdd_rename_component` can then give the Portal the Gateway's id.
   - Remove `lint.allow` entries naming `ARCHITECTURE_VIOLATION_SPECIALIST_DEP` or
     `GATEWAY_CONTAINMENT`, now reported as `UNKNOWN_LINT_ALLOW_CODE`, and any
     `rules.sddRuleSeverity` entry naming them, which no longer does anything.
   - Also newly reported, as errors: a Supervisor depending on anything but Actors,
     Orchestrators, Adapters or other Supervisors, and a component that depends on
     a live Actor without also depending on a Supervisor that supervises it.
7. **Embedding wairon as a library: `saveProjectConfig` is removed** from the
   package's main entry. It replaced the whole `.wai/project.yaml` without
   validation and dropped keys the schema does not know. Write through the
   intent-level functions the core surface now exports instead:
   `createProjectConfig`, `setProjectType`, `recordProfileSelection`,
   `setExecutionTier`, `registerPackRef` / `deregisterPackRef`,
   `upsertPackSelection` / `removePackSelection` and `markSelectionsBundled`.
   `loadProjectConfig` from the main entry still throws when a project has no
   configuration; `projectConfigExists()` answers that question directly.
8. **Re-run `validate --ci`: the fixed rules report what they used to miss.**
   - New errors: a call or dispatch to a cross-tree component the caller does not
     list in `dependsOn` (`UNDECLARED_DEPENDENCY_CALL`); a Portal dispatch binding
     routed to a write-effect Repository or Index method (`PORTAL_WRITE_SHORTCUT`);
     a RouterComponent owning two Portals (`ROUTER_COMPONENT_CONTAINMENT`); in a
     `--subsystem` run, a dependency cycle through the scope (`CIRCULAR_DEPENDENCY`).
   - New warnings: a published method whose prose signature, or a type nested in a
     parameter or return, is a bare `Json`, `any`, `unknown` or `object`
     (`UNTYPED_SEAM`); a "persisting" or "persistence" claim with no data edge
     (`UNREALIZED_CLAIM`); a call cycle through a parallel arm
     (`UNCONDITIONAL_CALL_CYCLE`).
   - Move a `lint.allow` for `UNUSED_METHOD` from the component to the interface
     that declares the method. An `UNCONDITIONAL_CALL_CYCLE` allow goes stale where
     its members' ids sort differently by locale than by code unit (`_` against
     `-`): move it to the implementation the finding now names.
9. **Re-run `validate --ci`: readability is checked now.** New warnings appear on
   trees that configured nothing, so read them before you silence them.
   - `EXCESSIVE_NARRATIVE_STEPS` above 25 steps, and `NARRATIVE_COMPLEXITY` above the
     `moderate` band. Split the narrative into steps that call smaller methods, set
     `complexity.maxNarrativeSteps` or `complexity.cognitiveWarnAbove` in
     `.wai/project.yaml`, or allow the finding with a reason.
   - `MISLEADING_BLOCK_WORD`, `GENERIC_COMPONENT_NAME`, `METHOD_REPEATS_COMPONENT`,
     `COMPONENT_IS_ITS_ONLY_METHOD` and `INCOHESIVE_METHODS`. Rename or split, or
     acknowledge the shape with a reasoned `lint.allow` — a deliberate facade is a
     legitimate answer to the cohesion finding. A switchboard that already forwards
     and nothing else needs no allow: the cohesion rule exempts a pure forwarder, so
     the way out is often to move the one method that does more.
   - **A project's own `complexity`, `documentation` and `naming` config now overrides
     its profile pack's**, as its severities already did. Where a pack profile was
     deliberately overriding a project value, move that setting into the pack or drop
     it from the project.
10. **Scripted `sdd_update_spec` deltas: four previously-accepted deltas now behave
    differently.** All four were silently wrong before, so a script that relies on
    them was already producing a spec nobody intended — but they change without
    warning, so check any generator you have.
    - **A delta naming ONE element of an array INSIDE an element now MERGES instead
      of replacing.** `methods: [{ name, params: [one param] }]` used to leave that
      method with one param; it now leaves the others in place. To drop the others,
      mark each with `action: "delete"`, or clear the list with `[]` and write the
      new one in a second call. The same applies to a step's `catches` and `cases`.
    - **A nested delete that addresses nothing is refused**, where the marker used to
      be stripped while the write reported success.
    - **A delete of a narrative step the narrative does not have is refused**, where
      it used to be a silent no-op. A delta that deleted several steps by their
      ORIGINAL numbers was relying on this: step deltas apply in ascending order
      against the numbering earlier entries left behind, so the later numbers were
      already addressing the wrong steps. Renumber them, or restate each step's
      `label` or `description` on the delete and have them checked.
    - **A delete of a loop/try/parallel header whose body remains is refused.**
      Retype the header first — which drops its region fields and reports them —
      then delete it.
    - **A delta that retypes a step and also sets a field the new type cannot carry
      is refused**, where the field used to merge through and surface later as
      `MALFORMED_FLOW_STEP`. Drop the field from the delta.

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
