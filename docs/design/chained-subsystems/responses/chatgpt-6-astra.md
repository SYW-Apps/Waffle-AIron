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

1. **The specific lenient-parent regression is fixed here.** [validation.ts](../../../../src/core/validation.ts#L66) now limits fallback replacement to resolution-failure codes, keeps stronger child findings, and combines severity overrides using the stricter effective severity. The three regression cases at the end of [resolve-through-parent.test.ts](../../../../tests/core/resolve-through-parent.test.ts#L469) pass. This does not make the parent run use every child's own policy, or make the fallback independent of unrelated findings.
2. **Flat grandchildren and declaration shadowing have fixes here.** [qualifyDeclaredId and qualifySubsystemRef](../../../../src/core/specs.ts#L129) distinguish declarations from references and handle a same-id realization at arbitrary mount depth. The Payments duplication described in issue 01 is therefore not an outstanding example on this commit. The root-subsystem shortcut for *references*, and the implicit mount/realization merge, remain.
3. **The generation cascade goes beyond direct children.** [runGenerate](../../../../src/commands/generate.ts#L92) recursively calls itself for each child. The CLI's [lock workflow](../../../../src/cli/index.ts#L188) invokes it after approval. An unscoped parent lock can therefore regenerate descendants at multiple levels, rather than only its immediate children.
4. **Approval has both local and recursive aspects already.** [currentSpecDigests](../../../../src/core/approval.ts#L88) excludes child specs from the per-file approval map, and `children` records only direct children's approved StateIds. However, [hashGateState](../../../../src/core/statehash.ts#L162) hashes the recursively loaded spec tree as well as the bound root's doctrine. Payments' loaded L1–L4 content can affect Platform's gate hash. The accurate gap is missing *transitive approval provenance and owner context*, not complete absence of descendant content from Platform's approval identity.
5. **Confinement is narrower than the statement's blanket guarantee.** The loader checks a nested path against the *loading root*, while writer and hosted mount-binding paths check each owning root. The check is lexical, not a filesystem real-path check. See probe P3 and issue 09. Existing containment tests establish absolute-path and traversal cases, not universal confinement.
6. **A complete tree archive is conditional.** [listChainedRoots](../../../../src/core/specs.ts#L352) skips missing, escaping, and cyclic mounts, and stops deeper traversal after its depth limit. [exportSpecTree](../../../../src/core/treetransfer.ts#L220) also filters out roots without `.wai`. The archive mechanism supports families; its success alone does not prove that every declared member was captured.

### Additional findings reproduced on this checkout

| Probe | Minimal setup and observed result | Implication |
|---|---|---|
| P1 | Pin a child's family surfaces; add a private component in the parent; pin again. The second pin changes zero files, while every existing pin still reports `stale`. | Re-pinning does not necessarily repair the advertised freshness state. Content-based write suppression preserves the old whole-tree provenance hash. |
| P2 | A child calls `old()` through an imported surface. Replace only that surface with one exposing `new()`. `SURFACE_REF_NOT_EXPOSED` appears, but `computeGateStateId()` remains identical. | An input capable of changing the gate verdict is absent from the gate identity. This directly matters to approval validity. |
| P3 | A child at `packages/kid` declares a mount to `../peer`, also under the top project. Platform loads that peer under the child's namespace without `PROJECTPATH_ESCAPE`; the child alone rejects it. | Even mount membership and containment depend on the loading root. |
| P4 | A child declares a missing nested mount. Unscoped parent validation reports `SUBPROJECT_NOT_FOUND`; parent validation scoped to the child drops that finding. | Some loader diagnostics still have local ids and disappear under a qualified scope. |
| P5 | Store two snapshots publishing `portal`, with the wrong provider first. Resolve `super::wanted-provider::portal`. The wrong provider wins. | Matching still discards provider identity, even when the reference spells it explicitly. |
| P6 | Pin a published parent portal, then make it private without updating the pin. The child's pinned edge has no private-access finding. Add a separate component with an unresolved local dependency: the same pinned edge now receives `CROSS_SUBSYSTEM_PRIVATE_ACCESS`. | An unrelated resolution failure activates fallback and changes which evidence judges another edge. Pin precedence is conditional, not a coherent mode. |
| P7 | An internal subsystem has an outgoing Adapter dependency on a published portal in another parent subsystem. Externalize it. The moved dependency stays bare and becomes `moving::portal`, which does not exist. | Migration misses outgoing references inside the moved subtree, in addition to references held by other children. |
| P8 | Publish an Observer through a MessageBus interface and pin it. An Adapter's `dependsOn` that Observer is accepted against the snapshot, but the parent's live check reports `CROSS_SUBSYSTEM_TARGET_NON_PORTAL`. | Surfaces omit facts needed to reproduce live boundary judgments; matching the right provider alone will not restore parity. |

P1 follows from [writeSnapshotIfChanged](../../../../src/core/surfaces.ts#L336) excluding provenance when deciding whether to write, while [listExternalInterfaces](../../../../src/core/surfaces.ts#L627) uses that provenance for freshness. P2 follows from the input set in [statehash.ts](../../../../src/core/statehash.ts#L58). P3 and P4 follow from the recursive mount branch in [specs.ts](../../../../src/core/specs.ts#L949). P5 is the explicit last-segment algorithm in [resolveSurfaceRef](../../../../src/core/rules/namespace.ts#L35). P6 follows from the whole-result fallback in [validation.ts](../../../../src/core/validation.ts#L490). P7 follows from [externalizeSubsystem](../../../../src/core/provision.ts#L347) and its rewrite scope. P8 follows from the different live and snapshot paths in [stereotype-deps.ts](../../../../src/core/rules/stereotype-deps.ts#L45).

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

## 01 — Mount and realization: two specs for one subsystem

**Diagnosis.** The current merge is semantically lossy, even after fixing its depth behavior. [mergeMountRealizations](../../../../src/core/specs.ts#L401) retains the child object's fields and only the mount's `projectPath`. The path map also selects the child's file. Thus the apparent single object combines data and write ownership from different authored records. Multi-subsystem children expose the contradiction because there is no single L1 realization to merge.

**Options.** Retaining explicit mount-over-child precedence would make the loss visible but preserve two authorities for one interface. Requiring every child to be flat would simplify merging but restrict R2 and R9. Removing the mount from the L1 collection removes the false equivalence while supporting both child shapes.

**Recommendation.** Introduce a membership record separate from `SubsystemSpec`. Preserve both parent-authored membership metadata and the child's own L0/L1 records. The parent may give the member a display label, required policy, or selected export set; it may not manufacture exports the child has not published.

Billing's L0 can publish a stable export using the existing shape:

```yaml
# Billing/.wai/specs/.index.yaml — publication fragment
publicInterfaces:
  - id: invoices
    name: Invoices
    subsystem: billing
    component: invoice_portal
    type: Custom
    details: Invoice operations offered to the family
    audience: project
```

The new composition model must define how the current `project` audience maps to explicit family access. Reusing the spelling alone is not an access-control design. Existing L1 `publicInterfaces` remains the subsystem's boundary inside its owner project.

Creating a project member must produce a valid standalone project structure. If the command promises to create a subsystem, it must also create that real L1 inside the child. Attaching an existing project must preserve its L0 and actual subsystem set. Creation and attachment should be distinct operations.

**Migration.** Report all mount/child publication and trust disagreements before conversion. Preserve discarded mount metadata in the migration report, and require a deliberate choice where it changes access. Existing flat children can produce proposed L0 exports from their L1 publication; do not automatically publish every subsystem in a multi-subsystem child.

**Proof.** Renaming a membership alias does not change child L1 identity or export contents. Flat, differently named, and multi-subsystem children have the same loading rules. A parent and child record with conflicting text remain distinguishable and writable through their respective owners.

## 02 — Identity and references across roots

**Diagnosis.** A display address derived from mounting is being used as persistent identity. [qualifyId](../../../../src/core/specs.ts#L87) interprets the same strings differently according to the outer root's subsystem names. Snapshot lookup then throws away most of that address. Fixing declarations was useful, but reference meaning still lacks a stable provider binding.

**Options.** Strict `super::` paths with overflow errors would be a useful compatibility repair, but keep references coupled to family layout. Globally unique ids on every spec would remove ambiguity but introduce migration and authoring overhead. Stable project identity plus owner-local spec ids and explicit import aliases gives sufficient identity with fewer new fields.

**Recommendation.** Keep existing local ids. Add a committed project identity, distinct from its display name and path. Treat a spec key internally as `(projectId, specKind, localId)`. An exported contract has `(projectId, exportId)`. Validate duplicate identities within a composition, and do not infer identity from matching names.

An illustrative import and call are:

```yaml
# Shipping/.wai/project.yaml — proposed import declaration
projectId: syw.shipping
imports:
  billing:
    project: syw.billing
    snapshot: surfaces/billing.yaml  # relative to .wai/
    digest: "sha256:<contract-digest>"
```

```yaml
# Shipping's component / narrative fragments — proposed reference syntax
dependsOn: ["@billing::invoices"]
# ...
targetComponent: "@billing::invoices"
targetMethod: createInvoice
```

`billing` is Shipping's import alias. It is not Platform's mount id. `invoices` is Billing's public export id, not a search for any component named `invoice_portal`. Bare ids resolve only within the authoring project. Parent-qualified display ids can remain in the UI and legacy APIs, but authoring resolves them to an owner and explicit reference before saving.

The same resolver must handle component references, contracts, trusted links, dispatch targets, and parsed type references. Generic/union types cannot be migrated by replacing only an entire string that happens to equal an id.

Initially reject multiple distinct member instances with the same project identity in one composition. Supporting two versions or deployments of one project later requires an explicit instance/binding identity; a UUID alone does not solve that problem. Copies in different families can retain the same project identity.

**Migration.** Resolve legacy references while their context is available, then produce exact import bindings. Where two pins match or an ancestor hop overflows, stop and report ambiguity. Never convert whichever snapshot happened to be first into a permanent provider choice. Recognize old syntax for a transition period, with diagnostics; do not silently reinterpret it under the new grammar.

**Proof.** Adding a same-named subsystem elsewhere, reordering snapshots, changing a mount alias, relocating a checkout, or switching the entry root does not change the canonical target. Duplicate spellings of the same target normalize to one dependency while retaining distinct narrative call sites.

## 03 — Governance: whose rules judge a child's specs

**Diagnosis.** The validator constructs one [RuleContext](../../../../src/core/validation.ts#L459) using one root's extensions, variants, profile, and rules. A maximum of severity values cannot reconcile different rule implementations, allowed-edge tables, design depths, language definitions, or suppressions. The child and parent may literally be applying different predicates.

**Options.** Parent override supplies one family doctrine but breaks independent governance. Automatic ancestor inheritance preserves apparent consistency only while the ancestor remains available. Owner policy plus explicit, versioned family requirements supports R2, R3, R7, and R11 together.

**Recommendation.** Each project judges its own architecture under its own resolved policy. The parent decides whether to admit the resulting project and how the composition must behave. Shared rules should use explicitly selected and pinned policy/extension packages, with content available to the detached child.

For the agreed project-type inheritance, make inherited values a resolved, recorded input: either scaffold the chosen default into the child, or adopt it through a pinned policy. An implicit read of the nearest filesystem parent's current config would reintroduce the problem. A child override should be visible to the family admission check.

If Platform requires a policy Billing has not adopted, report two facts: Billing passes its declared project gate; Platform's membership requirement fails. Do not relabel Billing's local rules or suppress the disagreement. Where a shared policy declares non-overridable restrictions, attempts to weaken those restrictions fail policy resolution explicitly.

At depth two, Payments runs its own policy. Billing runs the policies for its composition, and Platform runs the policies for Platform's composition. An ancestor's additional family requirements are explicit inputs to admission, not a reason to skip Billing and replace Payments' doctrine with Platform's.

**Migration.** First expose policy provenance on current diagnostics and provide a comparison of parent-policy and owner-policy outcomes. Then adopt the new behavior through a schema/workflow version. A formerly clean family may correctly acquire errors from child-only packs; that is a visible gate change requiring review, not a safe silent default flip.

**Proof.** Child-only pack rules execute when validating the family. Parent severity changes cannot erase owner findings. A detached child with identical pinned policy gives the same result. Conflicting profiles yield a policy conflict or separate failed requirement, not load-order-dependent behavior.

## 04 — One edge, one verdict

**Diagnosis.** Reference resolution and adjudication are mixed. The fallback uses the presence or absence of issue codes as evidence that a target resolved. It can re-evaluate an entire scoped subtree after one unresolved reference, as P6 demonstrates. Its intermediate merge key is only `(code, specId)`, so it cannot distinguish two different edges or call sites in the same spec.

**Options.** Always preferring a reachable live tree fixes some stale-pin cases but violates location independence. Taking the most severe finding from every reachable root is conservative in some cases, but combines different evidence and policies and still cannot prove resolution. Explicit input selection plus structured resolution and assessment separates the questions correctly.

**Recommendation.** Define two useful assessments:

1. **Project assessment:** own specs and code, own policy and approval context, exact imported contract digests. This is the standalone reproducible gate.
2. **Composition assessment:** the selected member revisions, their owner assessments, actual provider exports, declared bindings, and composition policies. This is what validates the proposed family together.

A normal standalone run should not search ancestor directories. A family run should not merely repeat the current flatten-and-validate operation. Both use the same canonical resolver and boundary-checking logic with explicitly different inputs when appropriate.

The resolver should return a structured result before any severity or suppression handling:

```text
resolved(owner, export/spec, selectedDigest, facts)
missing(declaredProvider, requestedExport)
ambiguous(candidates)
unavailable(requiredInput)
forbidden(target)
```

A diagnostic then carries the owner, source field or call site, canonical target, rule identity/version, effective policy, input digest, and check coverage. Failure to emit a diagnostic is not proof that resolution succeeded. Suppression affects reporting or gate treatment after the resolution fact exists.

For a family selecting Billing B2 while Shipping imports B1, report `PROVIDER_INPUT_MISMATCH` with both identities. Evaluate the calls against B2 and report any incompatibilities. Do not allow a successful B1 assessment to stand in for B2 integration. Conversely, Shipping's B1 project assessment remains meaningful without pretending it certified B2.

Initially require exact selected export-digest alignment for family approval. A later compatibility policy may explicitly accept a different digest with a recorded comparison; signature addition/removal alone is not a complete behavioral compatibility checker.

Source conformance belongs to the owner root. The parent should collect each owner's code assessment, then map cross-root imports through an explicit source/package ownership index. Unsupported or unresolved cross-root imports must have a coverage result. Existing code analysis should not be presented as a complete inter-project import proof: the conformance rules deliberately skip chained implementations, while `buildCodeModel` receives paths interpreted relative to one root.

**Migration.** Keep the current fixes as compatibility protection. Add structured resolution and provenance first, then replace result-level fallback. Introduce explicit family/project modes before changing the meaning of existing `validate` invocations. Preserve the CLI distinction between errors, fatal warnings, and draft notices; [isCiDraftWaivable](../../../../src/commands/validate.ts#L43) shows why a severity-only ordering is insufficient.

**Proof.** Same canonical edge, call site, policy, evidence, and approval context gives the same finding and gate consequence from every entry point. Adding an unrelated unresolved edge cannot change another edge's verdict. Reusing one issue code for two targets cannot merge away either finding. Missing code-analysis coverage cannot become a successful family gate by omission.

## 05 — Contracts and pins

**Diagnosis.** A snapshot currently serves as a dependency declaration, contract cache, name-resolution fallback, and freshness signal. Its content may omit information the live rules need. Its provenance hashes too much, while the approval hash includes too little. P1, P2, P5, and P8 are different consequences of those distinctions being absent.

**Options.** Treat pins as offline caches and prefer live state; this gives convenient local updates but weakens reproducibility. Treat pins as immutable dependency inputs and add explicit integration/update checks; this satisfies R2 and R7. Require a full package registry and semantic-version solver; useful eventually, but unnecessary to solve the present issue.

**Recommendation.** Start with immutable contract inputs in the existing surface store, addressed by declared provider/export identity and a contract digest. Separate:

| Question | Evidence |
|---|---|
| Is the selected input intact? | Stored content matches the committed digest. |
| Does this consumer satisfy that input? | Project assessment against that exact contract. |
| Has the provider published a different contract? | Explicit comparison with an available selected provider state. |
| Does this family work together? | Composition assessment against its selected provider state. |

Hash contract-relevant facts, including the exported interface, reachable type definitions, guarantees, transport/call kind, and boundary eligibility. Decide explicitly whether documentation changes are contract changes; avoid adding every unrelated implementation or timestamp to this digest. Provider identity is part of the binding and verified with the snapshot.

A surface must preserve enough facts to run the supported boundary rules, or report the omitted check as unavailable. P8 specifically requires distinguishing an event subscription/export from a synchronous callable portal. Trusted-link treatment also differs between today's live and surface paths; it needs an explicit contract/boundary rule, not an accidental exception on one path.

Reconcile pins by declared imports. Detect unused imports, missing exports, removed providers, and ambiguous legacy providers separately. `surface pin` should not silently choose replacement providers or collect every sibling forever. Pin refresh is an explicit child edit, followed by normal validation and approval.

Staleness alone should not fail a reproducible historical project assessment. It should fail a family requirement when the pinned contract does not match the selected member state, or an explicitly configured update/revocation policy. An offline pin cannot reveal an online revocation made after publication; promising that would contradict detached operation. A release requiring current revocation checks must declare that additional input and fail if it cannot obtain it.

The family surface remains useful as a scoped publication artifact for detached children. It should represent explicitly exported contracts, with their own digests, rather than automatically becoming the identity of all specs in the family. Hosted and imported foreign surfaces should use the same contract schema and binding semantics.

**Migration.** Preserve old snapshot files as provenance. Derive exact contract digests only after resolving provider ambiguity. Fix the freshness/write-suppression mismatch independently. Invalidate old approvals for the new input-hash scheme; never claim they approved imports their digest did not cover.

**Proof.** Private provider edits leave contract freshness unchanged. A breaking contract change moves the contract digest. Re-pinning unchanged contracts is a true no-op without contradictory freshness. Two providers with the same export name remain distinct. Live and snapshot assessments agree for all facts the snapshot claims to represent.

## 06 — Working from the child's own root

**Diagnosis.** Topology intentionally has one owner layer, while the loader and validator sometimes pretend to have one family-wide project. The problem is not that hierarchical delegation exists; it is that status and briefing lack a consistent way to navigate between actual owners.

**Options.** Flatten every component agent at the parent, giving a large topology and blurred write scope. Keep opaque delegates only, limiting R3. Keep owner layers and add qualified navigation/briefing to the owning project, preserving both bounded context and useful parent coordination.

**Recommendation.** Retain hierarchical owners as the default view. Allow a parent user to expand a member's status and request a component brief composed at that member's root, using that member's policy, imports, approval, and source paths. The returned task context should identify the owner project, writable scope, selected inputs, and any composition constraint. Viewing a brief need not generate files.

Proposed interactions:

```text
wairon status --family
wairon agent brief --member billing --component invoice_portal
wairon generate --project syw.billing
```

Status should distinguish local completion, local approval drift, selected dependency state, and integration findings. A single family completion percentage must disclose its denominator and unavailable members. Missing L0/L1 scaffolding should appear as missing structure, not a reassuring empty work queue.

Move implicit descendant generation out of `lock`. An explicit family-generation command can still exist, with a concrete list of targeted roots and appropriate write authorization. It must operate as deliberate work on those roots, not a side effect of approving a parent. `generate` should not silently repair missing project configuration; that is initialization or doctor repair.

**Migration.** Preserve the delegate agent identities where practical. Add owner-aware briefing before removing the legacy path. Change cascading defaults visibly; an explicit recursive generation request retains the useful convenience. Existing child scaffolding can be repaired through a targeted initialization plan.

**Proof.** Parent and child requests for the same component produce equivalent owner-local briefs. Parent status, validation, and approval leave child file bytes and modification times unchanged. A fresh child can discover the subsystem and components the creation operation promised.

## 07 — Approval across a family

**Diagnosis.** Today's lock combines a recursive gate hash, local file-review digests, and direct-child approval pins. These represent different promises. The hash misses imported surfaces and child governance, and `currentChildPins` copies a child's recorded StateId without establishing that the child's current contents still match its approval. Descendant content sensitivity is not a proof of descendant approval.

**Options.** One family approval would simplify authority but weaken independent project approval. Local approvals alone preserve autonomy but cannot justify “this composition is approved.” Local approvals plus a composition approval cover both promises without approving another team's changes implicitly.

**Recommendation.** Preserve per-file owner approvals and add a versioned composition record. Conceptually:

```text
project assessment inputs =
  own L0–L5 content + resolved policy + imported contract digests
  + analyzer identity and source evidence when code conformance is claimed

composition approval =
  own reviewed state + selected member approval digests
  + exact member state/bindings + composition-policy inputs
  + complete successful integration assessment
```

Record the complete approval identity of each direct member, including that member's own selected children. This permits transitive verification without flattening every descendant approval into Platform's file map. An approval identity must cover member/binding metadata and policy inputs, rather than merely copy the current `stateId` field.

Verify that a member's current selected state matches its approval; a stale approval file does not suffice. Missing or unapproved members can remain visible during design, but cannot support a claim that the full family is approved. A scoped approval must record its scope and coverage explicitly.

Keep “this spec's text was reviewed” separate from “the project still passes its declared gate.” An unchanged spec may retain review provenance after an import or policy change, but that change invalidates the previous gate assessment. The parent should derive child settledness from the child's actual record, not from the parent's local file map.

Human approval and source-code conformance also need distinct language. If the lock certifies only the architectural design, say so and track code-check results separately. If it certifies code conformance, source revisions/digests and analyzer context must be part of the evidence. Current source checks alone do not make a specs-only hash a durable code certificate.

Capture a stable input set before validation and compare it before committing the approval. A hosted approval request must remain tied to exactly that set while a human reviews it. No family transaction may fabricate missing child approvals.

Do not make imported contracts hash the provider's whole approval recursively. Dependency cycles would then create circular hash definitions. Immutable contract digests are leaf inputs; transitive approval follows the acyclic membership relation.

**Migration.** Version the lock format and report older records as legacy approval evidence requiring revalidation for stronger claims. Preserve their human/file provenance. Do not synthesize new family approvals from old direct-child pins.

**Proof.** Payments drift invalidates full-family readiness through Billing. An unchanged old Billing lock cannot conceal current Billing edits. Altering an imported contract, member policy, or composition binding invalidates the relevant assessment. Approving Platform writes only Platform's approval record.

## 08 — Repository layouts and version control

**Diagnosis.** Filesystem containment currently doubles as membership discovery and source acquisition. Git backing follows hosted root records, while spec loading follows recursive mounts. Those traversals cover different sets of data.

There is also a concrete approval-persistence mismatch beyond child backup: [excludeLocalFiles](../../../../src/git/adapter.ts#L96) still adds `.wai/lock.json` to `.git/info/exclude`, and [the git enable workflow](../../../../src/git/orchestrator.ts#L28) calls it. An already tracked lock is not untracked by an ignore rule, but a newly generated lock can remain untracked. This conflicts with the premise that approval records are committed and portable.

**Options.** Nested paths only keep today's layout restriction. Accepting arbitrary mount paths weakens hosted confinement. An explicit source/workspace resolver supports multiple layouts while keeping authorized filesystem reach separate from membership semantics.

**Recommendation.** Make these first-class layouts:

| Layout | Source and persistence behavior |
|---|---|
| Monorepo | Resolve member roots explicitly; a reviewable commit may include their `.wai` paths in the same repository. |
| Git submodules | Record and verify each child checkout/revision; child commits and superproject gitlinks are separate operations. |
| Separate repositories | Bind declared project identities to authorized local checkouts or immutable artifacts; do not discover them by walking `..`. |

For local sibling repositories, an explicit workspace mapping can authorize the known roots. Hosted resolution should use registered project/source handles, not permit tenant-authored arbitrary filesystem paths. Paths provide location; content/revision identities establish which state was selected.

Keep Git commit ids, contract digests, and approval digests separate. A Git commit includes more than a contract; the same contract can exist at many commits; an approval says which scope and policy a human accepted. A binding can record all three and check their consistency.

Backups should enumerate the declared family through the same membership resolver as validation, capture each owned `.wai` tree and its project identity, and record expected versus captured members. Fail a claimed full backup on unavailable members. Restore must reconstruct bindings and approvals, not merely extract reachable directories. A spec archive is not a backup of source code or independent repository history.

**Migration.** Keep contained path sources working. Add explicit repository/workspace bindings before allowing side-by-side layouts. Repair lock-file exclusion and make backup coverage visible before broadening claims about hosted recovery. Avoid silently committing child repositories or rewriting `.gitmodules` during a structural spec migration.

**Proof.** The same selected project states yield the same assessments under all three layouts. A restore preserves every declared project's specs, imports, and approval metadata. Missing submodules and partial checkouts produce explicit unavailable-member results. Fresh hosted approval records actually enter the intended persistence path.

## 09 — Hosted: a child as a project, a part, or both

**Diagnosis.** Current authorization targets the top project record, while execution can bind a child directory. [ProjectBinding](../../../../src/server/projects.ts#L247) carries a path and top-level id, plus an optional qualifier. Tools have to remember which interpretation applies. The [record-tool refusal set](../../../../src/server/request.ts#L203) is a useful guard but does not express every future operation's scope.

One remaining source-level concern deserves explicit attention: `validateSddTree` calls `findChainingParent` to discover a parent before `resolveThroughParent` checks `parentReach`. Thus the resolver's later refusal does not itself prove that no parent discovery reads occurred. The guarded [resolveChainingParent](../../../../src/core/specs.ts#L2934) wrapper checks reach first, but validation takes the lower-level path. This is a read-boundary observation, not a claim that I demonstrated a remote data-exfiltration exploit.

The P3 top-root/immediate-root mismatch is independently reproduced. Symlink/junction containment was not exercised; lexical `path.resolve` checks alone do not establish it. The requested permission property needs canonical filesystem reach and access enforcement at the I/O boundary.

**Options.** Keep children permanently unregistered and add more qualified tool exceptions. Register a second unrestricted project over the same files, risking overlapping authority and history. Give each project root one canonical hosted identity and let authorized compositions reference it.

**Recommendation.** Adopt the third option. A hosted child can be opened and governed as its own project while remaining a member of a family. One canonical registration should own a given writable project root. Parent membership then references that registration, with an explicit composition access grant.

A binding should carry the target owner identity, allowed source roots, available imported contracts, requested composition context, and effective capabilities. Descriptors for MCP, REST, UI, background, and export operations should declare their read/write scope; registration should reject operations without a classification. Checks must apply to resolved targets, including nested members, before opening files or rebinding another root.

Preserve the authorized ability of a parent user to work across the family through explicit grants. Do not turn arbitrary dependency imports into permission to read or modify a provider. A child-scoped session can consume its authorized vendored contracts without reading private sibling or parent trees. An integration assessment outside its reach is unavailable or supplied as authorized evidence, never inferred by privileged filesystem discovery.

Audit both the initiating composition/session and the target owner project. Approval requests, history, git bindings, and the UI should use that same owner identity. The child UI can show the allowed membership context and navigate to its own L0, status, diagram, and approval page.

Organizational units remain administrative grouping. Membership is architecture/source composition. Hosted relations can represent contract-consumption connections. They should share identities and contract health, but a team hierarchy must not determine software containment or grant data access automatically.

**Migration.** Create canonical child records with explicitly preserved existing grants and persistence mappings. Retain `project::child` selectors as compatibility aliases. Reject overlapping writable registrations and surface any authority conflict before enabling the new record. Do not infer a grant from filesystem nesting.

**Proof.** Every operation is checked for both the owner target and required capability. A denied child context performs no ancestor discovery reads. Adding an unclassified tool fails registration. Parent-mediated and child-direct approved edits target the same files and audit the same owner. Nested traversal, absolute paths, symlinks, junctions, and missing paths have consistent outcomes at every root.

## 10 — Migrations

**Diagnosis.** Structural operations manipulate directories and selected strings without an explicit before/after ownership graph. They therefore cannot reliably preserve reference targets, imports, policy, approval, and code ownership. P7 shows that even a moved subsystem's outgoing edge can be lost. Current [rewriteRefsInDir](../../../../src/core/provision.ts#L508) handles selected fields and exact strings, not the complete reference language.

There are additional lifecycle costs: externalization provisions a target project before the move, and internalization [removes the child's entire `.wai`](../../../../src/core/provision.ts#L464). Imported surfaces, project settings, root-level types, approval metadata, and nested membership need explicit preservation or rejection rules. A flat L1 count alone is not enough evidence that deleting that project metadata is harmless.

**Options.** Best-effort in-place rewriting is convenient but cannot promise R5 or R11. A transaction over one repository can atomically publish a complete structural edit. A staged migration protocol can support several repositories, but cannot honestly promise one atomic Git commit across them.

**Recommendation.** Every migration should produce a concrete plan before applying it:

```text
before: project identities, selected states, resolved reference targets
changes: files/owners, member bindings, imports, exports, code paths
after: expected targets, policy inputs, approval invalidations
coverage: absent consumers, unavailable roots, unresolved ambiguities
```

Creation initializes the promised local structure. Attachment does not overwrite an existing project. Externalization establishes a new owner and rewrites both inbound and outbound references. Internalization requires an explicit destination for all child-owned metadata and resources, with a compatibility plan for published identities. A path move changes location. A membership alias rename changes presentation and compatibility addresses. A project-id change is a breaking identity migration and must be treated separately.

Use parsed reference positions and a canonical target map, including signatures and nested generic/union types. Determine source ownership before rebasing paths; turning a formerly valid source file into `../../src/file.ts` outside the new owner root is a reported migration consequence, not a successful standalone conversion.

For multiple repositories, publish compatible exports/aliases first, update consumers through reviewed changes, then remove old bindings only when supported consumers have moved. Without all consumers checked out, report incomplete coverage and preserve a compatibility surface where possible. Refuse a claimed complete breaking rewrite when it cannot be proven.

Within one controlled workspace, stage edits, recheck input digests, and apply with rollback/recovery support. For separate Git repositories, record progress and commit identities; a partial failure must be recoverable and visible. Neither process should grant fresh approvals automatically.

**Migration.** Initially add planning and refusal checks around existing operations. Converting legacy mount/reference semantics is itself one of these migrations, with before/after assessments available for review. Preserve legacy files and approvals as evidence rather than treating them as disposable scaffolding.

**Proof.** Before/after canonical reference targets match for every promised unchanged relationship. Cross-root source references remain valid or explicitly block the plan. Failure halfway through produces a known recoverable state. Unavailable consumers and metadata that cannot be preserved prevent an operation from claiming complete success.

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
