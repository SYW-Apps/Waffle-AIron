_Sections copied verbatim from [`responses/chatgpt-6-astra.md`](../../../responses/chatgpt-6-astra.md) — ChatGPT 6 Astra's **repository-backed** review (answered `problem.md` r2 · repository access through Codex · `dev` at `e7d30d7`, after PR #68 merged). Relative links into `src/` and `tests/` are re-based for this folder's depth. Where the review's confinement text was exploit-level (probe P3's setup, one sentence naming a bypass class), a design-level summary stands in its place, marked in italics; the specifics were given to the maintainer directly._

# ChatGPT 6 Astra — 2026-09-12 — prompt.md as supplied, paired with problem.md revision 2

Repository-backed independent review of chained subsystems. Examined checkout: `dev`, commit `e7d30d7c69d752cb5b2c14546481f7239b5925cb`.

**Conclusion:** keep project composition, but stop using the loading root to determine ownership, reference meaning, and validation authority. A project should remain the owner of its specs, policy, approval, and source analysis. A parent should compose those projects and judge their integration. Contract consumption needs explicit, pinned provider identity. Adding more exceptions to the current flattened-tree validator will not establish those guarantees.

I recommend **projects with membership and contract imports**, rather than several intrinsic kinds of project. Membership says which projects form an architecture; an import says which published contract a consumer uses. Neither should silently transfer authorship or approval. A family gate combines member assessments with integration checks over explicitly selected member states.

This recommendation does change an important behavior: a parent's policy no longer silently replaces a child's policy. The parent remains authoritative about whether that child is acceptable in its system, and can require an explicitly adopted policy. That distinction is necessary if standalone projects and independent releases are real requirements.

## Scope and evidence

I read the repository README, this investigation's README, `problem.md`, and `prompt.md`, then traced loading, reference qualification, validation, surfaces, approval, generation, migration, hosted binding, and backup through the source. I developed the recommendation before consulting issue 00's filing index; I did not read the previous full responses or `synthesis.md` to derive it. This is an additional assessment, not a decision or an implementation proposal already accepted by the maintainer.

The checkout is newer than several behaviors described in revision 2. The existing relevant regression suites pass: **177 tests across 11 files**, covering parent resolution, identity round-trips, namespace fuzzing, containment, chained subsystems, migrations, approvals, surfaces, surface churn, hosted child binding, and tree transfer. That establishes the tested behavior, not the correctness of every composition of those features.

I also ran eight temporary characterization probes. They asserted the observed behavior described below, including undesirable behavior; their passing is evidence that the problems reproduce, not evidence that they are fixed. The temporary test file was removed. No production code or permanent test changes form part of this response.

### Corrections and qualifications to the problem statement

1. **The specific lenient-parent regression is fixed here.** [validation.ts](../../../../../../src/core/validation.ts#L66) now limits fallback replacement to resolution-failure codes, keeps stronger child findings, and combines severity overrides using the stricter effective severity. The three regression cases at the end of [resolve-through-parent.test.ts](../../../../../../tests/core/resolve-through-parent.test.ts#L469) pass. This does not make the parent run use every child's own policy, or make the fallback independent of unrelated findings.
2. **Flat grandchildren and declaration shadowing have fixes here.** [qualifyDeclaredId and qualifySubsystemRef](../../../../../../src/core/specs.ts#L129) distinguish declarations from references and handle a same-id realization at arbitrary mount depth. The Payments duplication described in issue 01 is therefore not an outstanding example on this commit. The root-subsystem shortcut for *references*, and the implicit mount/realization merge, remain.
3. **The generation cascade goes beyond direct children.** [runGenerate](../../../../../../src/commands/generate.ts#L92) recursively calls itself for each child. The CLI's [lock workflow](../../../../../../src/cli/index.ts#L188) invokes it after approval. An unscoped parent lock can therefore regenerate descendants at multiple levels, rather than only its immediate children.
4. **Approval has both local and recursive aspects already.** [currentSpecDigests](../../../../../../src/core/approval.ts#L88) excludes child specs from the per-file approval map, and `children` records only direct children's approved StateIds. However, [hashGateState](../../../../../../src/core/statehash.ts#L162) hashes the recursively loaded spec tree as well as the bound root's doctrine. Payments' loaded L1–L4 content can affect Platform's gate hash. The accurate gap is missing *transitive approval provenance and owner context*, not complete absence of descendant content from Platform's approval identity.
5. **Confinement is narrower than the statement's blanket guarantee.** The loader checks a nested path against the *loading root*, while writer and hosted mount-binding paths check each owning root. The check is lexical, not a filesystem real-path check. See probe P3 and issue 09. Existing containment tests establish absolute-path and traversal cases, not universal confinement.
6. **A complete tree archive is conditional.** [listChainedRoots](../../../../../../src/core/specs.ts#L352) skips missing, escaping, and cyclic mounts, and stops deeper traversal after its depth limit. [exportSpecTree](../../../../../../src/core/treetransfer.ts#L220) also filters out roots without `.wai`. The archive mechanism supports families; its success alone does not prove that every declared member was captured.

### Additional findings reproduced on this checkout

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P1 | Pin a child's family surfaces; add a private component in the parent; pin again. The second pin changes zero files, while every existing pin still reports `stale`. | Re-pinning does not necessarily repair the advertised freshness state. Content-based write suppression preserves the old whole-tree provenance hash. |
| P2 | A child calls `old()` through an imported surface. Replace only that surface with one exposing `new()`. `SURFACE_REF_NOT_EXPOSED` appears, but `computeGateStateId()` remains identical. | An input capable of changing the gate verdict is absent from the gate identity. This directly matters to approval validity. |
| P3 | *Filed at design level — see the provenance note.* Whether a nested mount is contained is decided against the **loading** root rather than the **owning** root, so one and the same declaration is accepted from one root and refused from another. The check is lexical. | Even mount membership and containment depend on the loading root. |
| P4 | A child declares a missing nested mount. Unscoped parent validation reports `SUBPROJECT_NOT_FOUND`; parent validation scoped to the child drops that finding. | Some loader diagnostics still have local ids and disappear under a qualified scope. |
| P5 | Store two snapshots publishing `portal`, with the wrong provider first. Resolve `super::wanted-provider::portal`. The wrong provider wins. | Matching still discards provider identity, even when the reference spells it explicitly. |
| P6 | Pin a published parent portal, then make it private without updating the pin. The child's pinned edge has no private-access finding. Add a separate component with an unresolved local dependency: the same pinned edge now receives `CROSS_SUBSYSTEM_PRIVATE_ACCESS`. | An unrelated resolution failure activates fallback and changes which evidence judges another edge. Pin precedence is conditional, not a coherent mode. |
| P7 | An internal subsystem has an outgoing Adapter dependency on a published portal in another parent subsystem. Externalize it. The moved dependency stays bare and becomes `moving::portal`, which does not exist. | Migration misses outgoing references inside the moved subtree, in addition to references held by other children. |
| P8 | Publish an Observer through a MessageBus interface and pin it. An Adapter's `dependsOn` that Observer is accepted against the snapshot, but the parent's live check reports `CROSS_SUBSYSTEM_TARGET_NON_PORTAL`. | Surfaces omit facts needed to reproduce live boundary judgments; matching the right provider alone will not restore parity. |

P1 follows from [writeSnapshotIfChanged](../../../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../../../src/core/rules/stereotype-deps.ts#L45).

These findings make the case for a shared model stronger than the original examples do. The components work in isolation, but their inputs and boundaries do not compose reliably.

## 00 — The model: what a chained subsystem is

**Diagnosis.** The overloaded concept is the project root. It is simultaneously a filesystem boundary, an id namespace, a validation configuration, an approval scope, and an architectural viewpoint. Flattening a child into a parent discards distinctions later features need to reconstruct. The resulting special cases are visible throughout `specs.ts`, `validation.ts`, and the surface rules.

**Options.**

| Option | Benefit | Cost against the commitments |
|---|---|---|
| One recursively owned project, with directory or repository partitions | One doctrine and approval are straightforward. | A partition cannot also have unconditional independent governance and approval; weakens R2. |
| Explicit `integrated` and `independent` mount kinds | Makes a governance choice visible. | Every subsystem capability now needs kind-specific semantics, including changes of kind. A project reused elsewhere still needs relationship-specific behavior. |
| First-class projects; explicit membership and contract imports | Preserves independent ownership and permits a composed architecture. | Family validation must aggregate owner results and evaluate integration; a single flattened rule run is insufficient. |

**Recommendation: the third option.** A child remains a project. Membership forms a composition tree; dependencies form a separate graph. A project can be a member of one family and an imported provider to another. Whether its files live in a monorepo or a submodule does not decide its authority.

The parent sees the child's L0 as a member project/system node. It can expand that node to inspect the child's actual L1 subsystems. A mount is not itself another L1 subsystem, and matching names do not collapse different authored records.

Use the existing `project.yaml`, L0 publication model, surface store, and extension-pack machinery where possible. The following is **proposed syntax**, not accepted by the current schemas:

```yaml
# Platform/.wai/project.yaml — relevant fields only
projectId: syw.platform
members:
  billing:
    project: syw.billing
    source: { path: services/billing }
  shipping:
    project: syw.shipping
    source: { path: services/shipping }
```

Membership describes composition and location. A separate import in Shipping binds an alias to Billing's published contract. Publication stays provider-owned. A platform policy can require members to adopt a specific shared policy package, but that package must be present and pinned in each member's own declared inputs.

I would retain all eleven commitments with these clarifications:

| Commitment | Position |
|---|---|
| R1: one verdict per edge | Same edge **and same evidence/policy context** must give the same judgment. Different selected provider revisions produce explicitly different assessments. |
| R2: independent project | Keep. Standalone validation uses committed inputs, without discovering authority through filesystem ancestors. |
| R3: first-class parent system | Keep. Full family validation includes member results, integration, graph checks, and coverage. Parent approval is approval of that composition. |
| R4: no incidental cross-project writes | Keep. A deliberately targeted member edit is work on that member; parent validation, lock, and status do not regenerate it. |
| R5: authoring round-trips | Keep semantic and canonical serialization equivalence. Do not promise preservation of arbitrary YAML formatting that the current writer does not preserve. |
| R6: confinement | Keep. Membership access is explicitly authorized; a child binding cannot discover private parent files to fill gaps. |
| R7: no softening by location | Keep. Selected inputs, rather than disk adjacency, decide what is assessed. |
| R8: repository layouts | Keep. Repository and checkout location become source bindings, independent of project identity. |
| R9: nesting | Keep recursive semantics. Resource limits must fail explicitly, rather than quietly omitting deeper members. |
| R10: proportional cost | Keep. A child loads its own tree and consumed contracts. Family aggregation evaluates each owner once per input set. |
| R11: predictability | Keep. Committed ids, imports, policy selections, and composition inputs explain every target and authority. |

**Migration.** Existing `projectPath` relationships should first load through an explicitly identified legacy interpretation. Convert them through a reviewable migration, not by guessing governance from a directory shape. A team wanting one authority can retain one project with internal subsystems; making a separate repository need not automatically create a separate approval authority.

**Proof.** The same owner project assessed through its root or a parent's family view produces identical owner findings for identical inputs. Adding or removing a containing checkout does not change a standalone result. Membership alone does not make a private target callable.

## Worked example: Platform, Billing, Payments, and Shipping

The examples below are schema sketches, not commands to run on the current implementation.

Platform declares Billing and Shipping as members as shown in issue 00. Its `core` remains a local L1 subsystem publishing `core_portal`. Billing declares:

```yaml
# Billing/.wai/project.yaml
projectId: syw.billing
members:
  payments:
    project: syw.payments
    source: { path: payments }
```

Payments declares `projectId: syw.payments` and its real local `payments` L1. Shipping declares `projectId: syw.shipping` and its real `dispatch` L1. Billing's own `billing` L1 remains independent of Platform's `billing` membership alias; their matching names have no semantic role.

Billing publishes the L0 export `invoices`, backed by `invoice_portal`, with a contract containing `createInvoice`. Shipping imports the selected contract through its own alias `billing`, as shown in issue 02. Its Adapter writes:

```yaml
id: dispatch_adapter
subsystem: dispatch
componentType: Adapter
dependsOn: ["@billing::invoices"]
```

```yaml
# A call step in the Adapter's implementation
stepNumber: 1
type: call
description: Create the shipment's invoice
targetComponent: "@billing::invoices"
targetMethod: createInvoice
```

There are three legitimate views of this relationship:

| View | What is assessed |
|---|---|
| Shipping project | Shipping's policy judges its Adapter and call against the exact imported `syw.billing/invoices` contract. Shipping code is analyzed at Shipping's root. |
| Platform family | The family obtains that same Shipping owner assessment, selects the actual Billing member state, checks that it supplies the bound export/digest, and applies Platform's integration policies. Canonical ownership is retained even if the diagram labels nodes `shipping::dispatch_adapter` and `billing::invoice_portal`. |
| Billing project | Billing judges its implementation and published contract under Billing's policy. It need not know every consumer. An authorized composition impact query may separately report Shipping's known consumption. |

Payments follows the same rules one level down. A Payments call into Billing requires a declared contract import; being nested under Billing does not bypass publication. Platform does not replace Payments' policy. Billing's composition assessment covers its membership and wiring; Platform includes that result in its larger composition.

**Approval.** Shipping approves its own reviewed specs and assessment inputs, including the invoices digest. Payments approves its own project. Billing approves its own state and, for complete composition approval, the selected approved Payments state plus their integration. Platform approves its own state, the selected Billing and Shipping approvals, and the family integration. Each approval is written only at its owner root. A missing Payments approval leaves the full composition unapproved, while local design work can continue.

**Billing renames `createInvoice` to `issueInvoice`.** This produces a new invoices contract digest:

1. Shipping's old pin is unchanged. Its standalone assessment still means “valid against the old invoices contract.” It does not imply compatibility with the new Billing.
2. A Platform family selecting the new Billing reports the selected-provider mismatch and the missing `createInvoice` call. Billing cannot conceal it by sharing a component name with another provider.
3. An authorized impact query identifies Shipping's known affected call site. It must identify its search coverage; Billing cannot know every detached consumer.
4. Shipping explicitly refreshes its input and changes the call and implementation, then revalidates and obtains the relevant approval. Alternatively, Billing preserves the old method/export during a compatibility period.
5. Platform approves the new composition only after the selected members and integration agree. Adding a sibling, a private Billing component, or an unrelated Shipping typo cannot change which contract version is selected.

If Billing merely renames its internal component while preserving the `invoices` export and contract, Shipping needs no edit. If Platform renames the membership alias from `billing` to `accounts`, Shipping still needs no edit. Those are the practical benefits of separating export identity, owner identity, and view addresses.

## Interactions and implementation order

The recommendations reinforce each other only if the same ownership and input model reaches every consumer of the tree. Stable ids alone do not fix policy. Per-root policies alone do not fix pins. Contract digests alone do not fix approval if the lock does not hash them. Hosted project records alone do not fix confinement if helpers can still discover arbitrary ancestors.

I would stage the work as follows:

1. **Close correctness gaps in the current interpretation.** Scope nested loader diagnostics correctly; align nested containment checks; guard parent discovery before reads; fix pin identity ambiguity and contradictory freshness; include consumed contract inputs in gate identity; remove the stale lock-file exclusion. Keep these changes explicit about legacy behavior and approval invalidation.
2. **Add ownership and resolution structure behind compatibility views.** Preserve owner project, local id, actual spec path, and member identity in the loaded model. Return resolution results and call-site identities independently of rule severity. Keep existing display ids usable through adapters.
3. **Introduce declared imports and assessment modes.** Separate project and family input selection. Run each owner once with its own configuration, approval context, and source root; add integration and coverage results. Use the same boundary facts for live and snapshot assessments.
4. **Introduce membership and approval migrations.** Remove implicit mount/realization merging from the new model, version approval records, add owner-aware status/briefing, and remove incidental generation from lock.
5. **Extend hosted registration and repository layouts.** Use the established identity, ownership, and assessment model for child UI, permissions, audit, backup, and separate checkout bindings.

The smallest valuable architectural change is an owner-aware project graph alongside the existing `SpecIndex`, with compatibility projections for current rules and diagrams. It need not begin by rewriting every rule. The existing `workspaceFor` and request-scoped root binding are useful foundations for owner-local evaluation. They are not, by themselves, a substitute for structured input and capability boundaries.

Family graph properties need dedicated attention. Cycles or forbidden dependencies can span several members even when every member is locally valid against contracts. Composition must canonicalize imported edges to selected providers before running graph policies. Missing providers create incomplete coverage; they do not justify treating that global graph as acyclic.

Caching should key owner assessments by all selected validation inputs, including policy/contract versions and source evidence when applicable. A private edit can invalidate its owner's code/design assessment without forcing every consumer to refresh an unchanged contract. Scope filters should select work after dependency requirements are known, rather than discard unqualified findings from a larger run.

## What I would not do

- Add another list of issue codes to the fallback. The validator needs resolution facts and evidence selection; diagnostic lists are an unstable proxy.
- Enforce “newest reachable contract wins.” Reachability and current directory should not alter a reproducible gate.
- Merge severities as the governance model. Different doctrines are not comparable by `off < warning < error`, and CI also uses provenance such as draft context.
- Flatten a child's L0 into an L1 or preserve the same-id merge as a permanent rule. Both erase actual ownership and make multi-subsystem children exceptional.
- Treat a matching terminal component name as provider identity, even when only one matching snapshot exists today.
- Turn every project into a globally registered service or require a package registry before local composition works. Committed identities and files are enough for an initial implementation.
- Promise that a pinned offline contract detects later revocation or proves runtime compatibility. Those claims need additional selected evidence.
- Equate parent access with automatic child approval, or fix backup by blindly staging an entire parent checkout.
- Promise atomic structural migrations across independent repositories. Compatibility and recoverable staged changes are the honest model there.

## Prior art and its limits

**Cargo workspaces:** membership and dependencies are separate declarations, and members explicitly opt into inherited package fields and lint settings. This supports explicit shared policy rather than inferring it from a parent's presence. The analogy stops at approval and hosting: Cargo does not supply independent human architecture approvals or tenant authorization, and workspace behavior should not be copied as a promise that every member is already portable standalone. [Cargo workspace documentation](https://doc.rust-lang.org/cargo/reference/workspaces.html).

**Git submodules:** a gitlink selects a specific child commit while the child retains its repository history. This is a useful model for explicit source selection and separate child operations. It does not establish that the selected commit passed a child's gate, that a working copy is unchanged, or that its APIs are compatible. Wairon must carry and verify those facts separately. [Git submodule documentation](https://git-scm.com/docs/gitsubmodules).

**Bazel lockfiles:** explicit resolution inputs and a mode that rejects missing/outdated resolution information are useful precedents for predictable gates. Wairon can likewise separate input refresh from assessment. Bazel's own documentation distinguishes modes and qualifications around extension behavior; it should not be cited as proof that adding a lockfile makes arbitrary tools hermetic. Architecture governance, human approvals, and cross-tenant reach remain wairon's responsibilities. [Bazel lockfile documentation](https://bazel.build/external/lockfile).

**Pact's compatibility matrix:** compatibility is a relationship between selected consumer and provider versions. This is the closest analogy for the distinction between Shipping passing against its pin and Platform accepting a particular Shipping/Billing pair. Pact records verification evidence from consumer/provider testing. Wairon's current contract and narrative checks are primarily static; they must not be described as equivalent behavioral verification. [Pact `can-i-deploy` documentation](https://docs.pact.io/pact_broker/can_i_deploy).

These examples support particular mechanisms. None decides whether Platform should own Billing's architecture policy; that remains a product commitment.

## Assumptions and decisions for the maintainer

My recommendation assumes that “the child may be developed, approved, and released alone” includes independent policy and a useful result against committed dependencies. If instead a child must always obey the parent's current unpinned doctrine, the product should say that it is a partition of one approval authority and weaken R2. The present design cannot promise both interpretations without declaring the context.

The decisions that materially change implementation are:

1. **What does family approval promise?** I recommend approved selected members plus successful integration with complete declared coverage. Permit partial design assessment, but name it differently from full approval.
2. **Can a family require shared member policy?** I recommend yes, through explicit pinned policy adoption and visible admission failures, not implicit ancestor configuration.
3. **What is a public project contract?** I recommend stable L0 export ids, backed by actual child L1/L3 definitions, with explicit family audience and operation kinds. Do not default to publishing every child subsystem.
4. **Are duplicate project instances needed immediately?** I recommend initially rejecting ambiguous duplicate identities inside one composition and adding explicit instance bindings only when required.
5. **Does a lock certify source conformance or reviewed design?** The current checks and stored identities imply different answers. State the promise, then hash and retain the evidence needed for that promise.
6. **May a published compatibility boundary survive an internalization or reorganization?** I recommend yes; otherwise innocent layout changes become API migrations for every consumer.

The investigation should resolve those choices before committing to a large schema rewrite. The strongest immediate evidence is that the current gate does not have one explicit, complete set of inputs: P2 changes its verdict without changing its identity, and P6 changes an existing edge's evidence because another edge fails resolution. Correcting that foundation is more valuable than making every root display the same undifferentiated verdict.
