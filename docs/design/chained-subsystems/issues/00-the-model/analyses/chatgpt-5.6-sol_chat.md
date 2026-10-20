_Section copied verbatim from [`responses/chatgpt-5.6-sol_chat.md`](../../../responses/chatgpt-5.6-sol_chat.md) (ChatGPT 5.6 Sol · answered `problem.md` r2 · no repository access)._
_This file holds the source's model section (§1), its issue-00 section, and its worked example, interactions, what-not-to-do, prior art, questions and bottom line (§2–§6), per the folder convention._

# 1. Model, in one page

My recommendation is to **delete “chained subsystem” as a semantic concept**.

Wairon currently makes one object mean three different things: an architectural L1 subsystem, a separately governed project, and a physical source mount. That is why the mount sometimes behaves as architecture, sometimes as repository layout, sometimes as an approval boundary, and sometimes as a hosted permission scope. The mismatch is visible directly in the current model: the mount is L1, while the child brings its own L0 and potentially several L1s, so the hierarchy has no coherent interpretation.

I would instead make these concepts orthogonal:

```text
Project
  = identity + governance + approval + release + hosted security boundary

Subsystem (L1)
  = architectural boundary inside exactly one project

Project relation
  = relationship between two projects

Source
  = how another project or project fragment is materialized on disk
```

There should be **two project-relation kinds**:

```yaml
members:
  billing:
    project: acme.billing
    source:
      path: services/billing

dependencies:
  tax:
    project: acme.tax
```

A **member** says: “this independently governed project is a constituent part of my larger system.” The parent may inspect its complete spec tree, include it in diagrams/status/topology, aggregate its validation, and delegate work into it. It does **not** re-govern or re-approve the member.

A **dependency** says: “I consume this independent project through published contracts.” Only surfaces are visible.

If the actual requirement is merely “split one project over several directories or repositories but keep one governance/approval scope,” that should not create another project at all. Add a physical `specSources`/fragment mechanism to one project. Repository layout is not architecture.

This preserves an important rule: **a project boundary always means an authority boundary**.

A child's L0 therefore stays its L0. It never pretends to be a parent's L1. A parent's member relation is grouping metadata, not an architecture node. The child's L1 subsystems remain L1 subsystems, merely displayed under a project namespace when viewed from the parent.

## Identity

Every project gets a stable identity independent of checkout location or parent naming:

```yaml
project:
  id: acme.billing
  name: Billing
```

References are interpreted in the lexical project that owns the spec, not in the root from which the validator happened to load it.

```yaml
# local project
dependsOn:
  - invoice_store

# another project
dependsOn:
  - "@billing::invoice_portal"
```

`billing` is a local import alias declared by the referencing project:

```yaml
dependencies:
  billing:
    project: acme.billing
```

The canonical target of the latter reference is therefore:

```text
(project = acme.billing, entity = invoice_portal)
```

The parent may call the same member `accounts` without changing Shipping's reference. There is no `super::`, loading-root `::`, suffix lookup, or root-dependent normalization.

## Validation

A finding has an owner.

For an edge originating in Shipping:

```text
Shipping config
+ Shipping spec/code
+ the exact Billing contract Shipping declared
= authoritative edge verdict
```

Platform does not run Shipping's edge through Platform's rules again.

A family validation instead aggregates member results and adds **composition findings**:

```text
Shipping says it requires Billing invoice_portal contract X.
The Billing member currently present supplies contract Y.
Does Y satisfy X?
```

That is deliberately separate from the edge verdict.

Thus Shipping can validate reproducibly from a detached clone against X, while Platform can report that the currently composed Billing no longer satisfies X. No ambient checkout changes Shipping's own verdict.

## Contracts

Pins become proper consumer dependency locks.

```yaml
# .wai/deps.lock.yaml
dependencies:
  billing:
    project: acme.billing
    interfaces:
      invoice_portal:
        digest: sha256:...
        surface: surfaces/billing/invoice_portal.yaml
```

The lock contains the contract Shipping was approved against. Live source does not silently outrank it.

When Platform has both projects, it performs semantic compatibility:

```text
current Billing contract ⊇ Shipping's required locked contract
```

Adding an unused method can therefore remain compatible. Removing or renaming a required method cannot.

## Approval

Separate two claims:

```text
project approval
    "I approve this project's own specs, config and dependency inputs."

composition approval
    "I approve these exact approved member projects being composed together."
```

A parent never locks or writes a child.

Composition approval is Merkle-like and transitive:

```text
Platform composition
 ├─ Billing project approval
 │   └─ Billing composition
 │       └─ Payments project approval
 └─ Shipping project approval
```

Platform therefore indirectly binds Payments without writing Payments and without pretending Platform approved Payments' contents.

## Hosted

Every project remains a hosted project record, even when it is a member of another project. Relations connect records; permissions belong to records.

A child-scoped credential receives a child project handle. Confinement is enforced at resource access, not through a growing denylist of tools.

## Commitments

| Commitment | Position | Consequence |
|---|---|---|
| R1 one verdict per edge | **Keep, strengthen** | Parent aggregates the owning project's verdict; scope-specific composition findings are separate and explicit. |
| R2 child first-class project | **Keep** | Every member has its own identity, config, approval, release and hosted record. |
| R3 parent first-class system | **Keep intent, weaken authority** | Parent can see, validate, diagram and delegate across members, but does not reinterpret their internals under its rules. |
| R4 no cross-project side-effect writes | **Keep hard** | No cascading lock/generated-file writes. |
| R5 authoring round-trips | **Keep hard** | References are never rewritten according to loading root. |
| R6 confinement | **Keep hard** | Enforced through project handles/ACLs rather than per-tool exceptions. |
| R7 no softening by location | **Keep hard** | Validation inputs come from declared files/locks. |
| R8 repository layouts | **Keep** | Path, git, hosted and cached sources are materialization strategies. |
| R9 nesting | **Keep** | Project composition is recursive without special flat-child behavior. |
| R10 proportional cost | **Keep** | A project validates from its own locks; only family validation traverses members. |
| R11 predictability | **Keep hard** | Project alias → stable project ID → exact local ID. |

The principal thing I would **drop** is the implicit commitment that a parent's configuration is entitled to reinterpret a child's internals merely because the child is visible to it. That behavior is the source of several contradictions today. Current validation explicitly does apply the loading root's configuration across child specs.

---

## 00 — The model: what a chained subsystem is

### Diagnosis

The root cause is not insufficient mount metadata. It is that `projectPath` currently conflates:

1. architecture containment;
2. project composition;
3. filesystem/repository location.

The product then has to invent different semantics per feature: federated loading, independent approval, partially independent validation, opaque agent delegation, and top-project-only hosting.

### Options

**A. Keep one mount concept and add flags.**

For example:

```yaml
projectPath: services/billing
governance: child
visibility: full
approval: independent
```

This can satisfy R1–R10 with enough rules, but badly damages R11. Every capability must understand the combinatorial matrix.

**B. Declare `member` and `dependency`. Recommended.**

`member` permits full architectural inspection but preserves project governance. `dependency` exposes surfaces only.

This strongly supports R1, R2, R3, R7, R10 and R11.

**C. Make all projects surface-only dependencies.**

Conceptually very clean and excellent for R2/R10, but gives up a substantial part of R3: Platform could not deeply visualize or delegate through Billing and Shipping.

**D. Make members truly parent-owned.**

This makes parent federation simple, but R2 becomes false: the child's config and approval cease to be authoritative.

### Recommendation

Move project composition out of L1 specs:

```yaml
# Platform/.wai/project.yaml
project:
  id: acme.platform
  name: Platform

members:
  billing:
    project: acme.billing
    source:
      path: services/billing

  shipping:
    project: acme.shipping
    source:
      path: services/shipping
```

Independent consumption:

```yaml
dependencies:
  fraud:
    project: acme.fraud
```

A project may simultaneously be:

```text
member of Platform
dependency of Storefront
dependency of Analytics
```

because those relationships no longer imply who owns the project.

### Migration

Existing `projectPath` mounts map initially to `members`.

That is the closest representation of today's intent because current parents already load complete child internals while children keep separate governance.

Do not immediately delete old mount syntax. Introduce:

```text
schemaVersion: 2
```

and a compatibility loader plus:

```console
wairon migrate project-relations --plan
wairon migrate project-relations --apply
```

### Proof

Property tests:

```text
member relation does not change child-local validation findings
dependency never exposes non-published target entities
the same project can be referenced from multiple composition roots
member source location does not participate in canonical identity
```

---

# 2. Worked example — Platform / Billing / Payments / Shipping

The current family has Platform containing Billing and Shipping, Billing containing Payments, and Shipping calling Billing's `invoice_portal`; today that edge is interpreted differently depending on scope.

## Platform

```yaml
# platform/.wai/project.yaml
schemaVersion: 2

project:
  id: acme.platform
  name: Platform

members:
  billing:
    project: acme.billing
    source:
      path: services/billing

  shipping:
    project: acme.shipping
    source:
      path: services/shipping
```

Platform's own architecture remains:

```text
core subsystem
  └── core_portal
```

Billing and Shipping are project-group nodes, not synthetic L1s.

## Billing

```yaml
# services/billing/.wai/project.yaml
schemaVersion: 2

project:
  id: acme.billing
  name: Billing

members:
  payments:
    project: acme.payments
    source:
      path: payments
```

Its real L1:

```yaml
# Billing billing subsystem
id: billing
level: subsystem

publicInterfaces:
  - invoice_portal
```

There is no requirement that this L1 be named `billing`; changing that local architecture does not change Billing's project identity.

## Payments

```yaml
project:
  id: acme.payments
  name: Payments
```

Payments need not declare “my parent is Billing.”

The relationship is owned by the composing project.

That is important because Payments could simultaneously be:

```text
a member of Billing
a dependency of another unrelated product
```

without modifying Payments itself.

## Shipping

```yaml
# services/shipping/.wai/project.yaml
schemaVersion: 2

project:
  id: acme.shipping
  name: Shipping

dependencies:
  billing:
    project: acme.billing
    imports:
      - invoice_portal
```

Its architecture:

```yaml
id: dispatch_adapter
stereotype: Adapter

dependsOn:
  - "@billing::invoice_portal"
```

Narrative:

```yaml
steps:
  - call: "@billing::invoice_portal.create_invoice"
```

Its lock:

```yaml
dependencies:
  billing:
    project: acme.billing

    interfaces:
      invoice_portal:
        digest: sha256:62ab...
        surfaceFile: surfaces/billing/invoice_portal.yaml
```

Stored surface:

```yaml
project: acme.billing
interface: invoice_portal

methods:
  - name: create_invoice
    parameters:
      - name: order_id
        type: OrderId
    returns: Invoice
```

## Judgement from Shipping

Shipping resolves:

```text
@billing
 -> Shipping.dependencies.billing
 -> acme.billing

invoice_portal
 -> locked imported contract

create_invoice
 -> method in that locked contract
```

The Adapter boundary rule is evaluated under **Shipping's** doctrine.

Result:

```text
PASS
edge:
  source: acme.shipping/dispatch_adapter
  target: acme.billing/invoice_portal.create_invoice
  targetContract: sha256:62ab...
```

No parent required.

## Judgement from Platform

Platform loads Shipping as a member.

It encounters exactly the same authored reference.

It does **not** reinterpret `@billing` through:

```yaml
Platform.members.billing
```

Instead it retains the lexical source project:

```text
source project = acme.shipping
```

and therefore performs the same alias resolution Shipping did.

The edge verdict is consequently the same:

```text
PASS against sha256:62ab...
```

Platform can additionally resolve its live Billing member.

Suppose live Billing's current `invoice_portal` is compatible with `62ab`.

Platform reports:

```text
Shipping edge: PASS
Billing composition: compatible
```

## Judgement from Billing

Billing does not own the outbound edge, so ordinary:

```console
cd Billing
wairon validate
```

does not attempt to validate Shipping.

It validates:

```text
invoice_portal is a valid published Billing contract
Billing code conforms to it
Billing's own doctrine is satisfied
```

This asymmetry is intentional.

Ownership follows the source of the dependency.

A provider should not require all consumers to be checked out in order to validate or release itself.

Where consumer impact information is available, an additional command can exist:

```console
wairon consumers check
```

or the hosted UI can show:

```text
invoice_portal
  consumers:
    acme.shipping
```

but this is impact analysis rather than Billing-local architectural correctness.

## Approvals before a change

Assume all four projects are approved.

Shipping approval includes:

```text
Shipping specs
Shipping policy/config
Billing requirement contract 62ab
```

Billing approval includes its current Billing specs.

Billing composition approval includes Payments.

Platform composition approval binds:

```text
Platform approval
Billing approval
Billing composition approval
Shipping approval
```

therefore transitively including Payments.

## Billing renames the method

Billing changes:

```yaml
create_invoice
```

to:

```yaml
issue_invoice
```

and updates its implementation.

### Billing alone

```console
cd Billing
wairon validate
```

may pass.

Its own spec and code agree.

Its previous approval is drifted because Billing changed.

After a Billing human approves:

```console
wairon lock
```

Billing once again has a valid project approval.

There is nothing inherently invalid about Billing deciding to create a breaking API revision.

### Shipping alone

Shipping has not changed.

Its lock still contains:

```yaml
create_invoice
```

and its narrative still calls it.

Therefore:

```console
cd Shipping
wairon validate
```

still passes.

That may initially look surprising, but it is the necessary result of R2 and reproducibility:

> Shipping is approved against a declared contract. The meaning of its checkout cannot change because somebody elsewhere changed Billing.

### Platform

Platform has both current Billing and Shipping.

It compares:

```text
Shipping requirement:
  invoice_portal.create_invoice exists

Current Billing:
  invoice_portal.issue_invoice exists
  create_invoice absent
```

and reports:

```text
WAI_COMPOSITION_INCOMPATIBLE

consumer: acme.shipping
provider: acme.billing
interface: invoice_portal

required method missing:
  create_invoice(OrderId) -> Invoice

provider currently exposes:
  issue_invoice(OrderId) -> Invoice
```

Thus:

```text
Shipping edge verdict: PASS against its declared input.
Platform composition: FAIL.
```

Platform cannot be family-approved in that state.

### Updating Shipping

A developer runs:

```console
cd Shipping
wairon deps update billing --from-workspace
```

Wairon sees the new contract and can report:

```text
Cannot update dependency cleanly.

Broken references:
  dispatch_adapter
    @billing::invoice_portal.create_invoice

Possible replacement:
  @billing::invoice_portal.issue_invoice
```

After Shipping changes:

```yaml
steps:
  - call: "@billing::invoice_portal.issue_invoice"
```

and refreshes its dependency lock:

```console
wairon deps update billing --from-workspace
wairon validate
wairon lock
```

Platform composition is compatible again and may be re-approved.

### Non-breaking alternative

Billing could temporarily expose both:

```yaml
methods:
  - create_invoice   # deprecated
  - issue_invoice
```

Then current Billing remains a superset of Shipping's required contract.

Platform stays green while Shipping migrates independently.

That is a much better representation of compatibility than “any hash changed, therefore everything is stale.”

---

# 3. Interactions

Several recommendations are really one design move viewed from different directions.

### Stable project identity reinforces repository independence

Issue 02 removes parent-path identity.

That directly makes issue 08 easier: once `acme.billing` is the semantic identity, nested checkout, submodule, git fetch and side-by-side clone become equivalent materializations.

It also dramatically simplifies issue 10 because moving a project no longer changes references.

### Project-local governance enables multi-parent composition

If Platform were allowed to redefine Billing's doctrine, a Billing project mounted into two systems could receive contradictory semantics.

Issue 03's project-local authority therefore reinforces issue 00's ability for one project to participate in multiple systems.

### Contract locks and family validation deliberately separate two truths

Issue 04 and issue 05 depend on keeping these distinct:

```text
What contract was Shipping built and approved against?
What contract does the currently composed Billing provide?
```

Collapsing those questions is exactly what recreates ambient validation.

The cost is that Shipping may be green while Platform is red.

I consider that a feature, not inconsistency: each result describes a different scope and names why.

### Transitive approval depends on stable member identities

Issue 07 works cleanly because composition approval stores project identities and approval digests rather than flattened spec prefixes.

That also removes the current one-level Payments blind spot.

### Hosted security becomes easier only if projects remain genuine projects

Issue 09 strongly reinforces issues 00 and 06.

Once Shipping is a first-class project record, “run a brief as Shipping,” “lock Shipping,” “install a pack for Shipping,” and “give this token Shipping-only access” all become ordinary project operations.

### There is one real tension: R3 versus project authority

The strongest possible interpretation of R3 would be:

> Platform may authoritatively apply its configuration to every descendant spec.

That conflicts with R2 and R7.

I would resolve that conflict in favor of project authority.

Platform can still require:

```text
Billing must have passed policy baseline X
```

but Billing should be the scope in which X is actually evaluated.

### Another tension: strict locks versus convenient monorepo development

Lock-based validation means a local Billing edit does not implicitly redefine Shipping.

For a monorepo workflow that can feel slower.

Solve that with explicit commands:

```console
wairon validate --against-workspace
wairon deps update --from-workspace
```

not by making ordinary validation context-sensitive.

---

# 4. What I would not do

I would not retain the mount as an L1 and continue refining the merge algorithm. The recursive-flat-child bug is evidence that the abstraction is wrong, not merely that the recursion is incomplete.

I would not preserve `super::` as the normal cross-project reference syntax. A consumer should identify the provider it depends on, not encode how somebody else currently embeds both projects.

I would not let `::foo` mean “absolute from whoever happened to start the command.” Absolute names require an absolute identity domain.

I would not use last-segment matching for imported surfaces.

I would not make live source automatically outrank dependency locks. That turns filesystem state into undeclared validation input.

I would not make pins automatically outrank live source **without** reporting composition compatibility either. That is how a revoked or renamed API becomes invisible at the family scope today.

I would not run a child's complete spec tree under the parent's configuration. If organizational policy is required, make the requirement explicit and attest that the child passed it.

I would not make parent lock recursively invoke child lock. Approval is a human authority action, not dependency resolution.

I would not regenerate another project's managed files as part of parent lock.

I would not collapse VCS revision and approval identity into one hash. A commit can be unapproved; the same semantic approval might also be materialized from different repository mechanics.

I would not enforce hosted child confinement through a list saying which MCP tools are allowed. The project scope should be a capability/property of the object handle.

I would not require an atomic write across every repository when externalizing or reorganizing architecture. Generate a transaction plan and make incomplete distributed migration explicit.

And I would remove the term **flat child** from the eventual model entirely. If a design still needs special semantics because a child L1 happens to have the same text ID as a parent relation alias, the identity model is still leaking.

---

# 5. Prior art

None of these systems is a direct blueprint for wairon. The useful pieces come from different ones.

| Prior art | What genuinely applies | Where the analogy breaks |
|---|---|---|
| **Bazel external repositories / Bzlmod** | Strong precedent for separating a module's stable identity from the repository that materializes it. Bazel modules declare dependencies, repository mappings provide local names, external repositories can come from different source mechanisms, and lock state provides deterministic resolution. Its strict direct-dependency visibility is especially relevant to `@billing` aliases. | Bazel ultimately solves build dependency resolution. It does not model human architectural approval, ownership of design doctrine, published runtime contracts, or inbound consumer compatibility. |
| **Cargo workspaces and path dependencies** | Workspaces demonstrate that several separately named packages can be grouped into one development workspace, while path dependencies remain ordinary package dependencies. Cargo also supports dependencies from registry, git and filesystem paths. | Cargo's workspace is primarily a build/development convenience and has shared Cargo-level machinery. It does not need wairon's distinction between architecture policy, project approval and system composition. |
| **Go modules + `replace`** | One of the strongest analogies for identity versus location. Code keeps importing the canonical module path while the main module can resolve that identity to a local checkout or alternate source using `replace`. | `replace` is intentionally a main-module resolution decision and is ignored transitively. That is useful for builds, but wairon must not let the current top root redefine what another project's architecture references mean. |
| **Nx** | Nx's project graph is a useful analogy for a parent/workspace obtaining a unified view of independently described projects and their dependencies, then deriving task behavior from that graph. | Nx mainly derives workspace structure and execution. It is not a contract/governance boundary and generally assumes one workspace. |
| **Turborepo** | Its distinction between the package graph and task graph is conceptually useful: composition of projects does not mean their internal concepts should collapse into one namespace. It also derives internal dependency relationships from package metadata. | Turborepo explicitly leaves package dependency management to the package manager. It has no equivalent to wairon's architectural surfaces, approvals or doctrine. |
| **git submodules** | Excellent analogy for “the parent refers to an exact child repository state while the child retains its own history.” | A submodule commit is only a byte/VCS identity. It says nothing about whether that state is architecturally valid or human-approved. Therefore wairon's source revision and approval digest should be related but not conflated. |
| **Nix flake inputs** | Flake inputs and locks illustrate declaring external inputs independently from where the current checkout happens to sit, with reproducible locked resolution. | Nix inputs exist primarily to produce reproducible evaluation/build results. Nix does not need separate architecture owners, provider publication boundaries or consumer contract approval. |
| **Terraform modules** | Terraform cleanly separates root module, nested child modules and module source. Modules can come from local paths, registries or VCS and can nest recursively. | A Terraform child module is fundamentally instantiated/called by its parent. It is not analogous to an independently running service project with its own architecture, approval authority and independent consumers. |
| **Backstage system model** | Very relevant conceptually: components belong to systems while APIs are first-class boundaries, and systems provide an abstraction that hides internal implementation from consumers. | Backstage is primarily a software catalog. Its relations document ownership/discovery; they do not ordinarily serve as a deterministic executable architecture gate or approval lock. |
| **C4** | C4's explicit hierarchy of software system → container → component is a useful warning against pretending that a complete independently scoped system automatically becomes one lower-level element when viewed from elsewhere. It also deliberately distinguishes zoom level from physical packaging. | C4 is a visualization/communication model. It does not specify repository resolution, validation ownership, versioned contracts or approval. |
| **Pact / contract testing** | Very strong analogy for Shipping's dependency lock: a consumer records the provider behavior it actually requires, and provider compatibility can then be checked against those requirements. Pact explicitly models consumer/provider contracts rather than requiring all provider behavior to remain frozen. | Pact contracts are primarily executable examples of runtime interactions. Wairon's surfaces are richer architectural specifications including topology, visibility, stereotypes and static design rules. |
| **DDD bounded contexts / context maps** | The central lesson is directly relevant: independent contexts have explicit relationships rather than being flattened into one universal model. Context maps exist specifically to describe those inter-context relationships. | DDD context maps describe conceptual/team/domain relationships. They do not answer materialization, hashes, hosted ACLs, CI reproducibility or approval semantics. |

The prior art therefore points in one consistent direction, but no single precedent supplies the whole design:

```text
Bazel / Go / Nix:
  identity and deterministic dependency resolution

Cargo / Nx / Turborepo:
  workspace aggregation without identity collapse

git:
  independent repositories plus parent-selected state

Pact:
  consumer requirement versus provider compatibility

Backstage / DDD:
  explicit system/context relationships and published boundaries

C4:
  do not confuse a change of viewing scope with a change of architectural level
```

---

# 6. Assumptions and questions for the maintainers

## Assumptions I made

1. **Project IDs can become stable persisted identity.** I assume adding something like `project.id` is acceptable.

2. **Spec IDs need only be unique within a project.** Cross-project identity is therefore `(projectId, localId)`.

3. **A surface contains enough type/method detail to check backward compatibility.** If it does not, I would extend the surface rather than fall back to whole-family hashes.

4. **A project's configuration and dependency locks are logically part of what was approved.** Otherwise an unchanged spec could be judged against changed inputs while still appearing settled.

5. **Project membership is not exclusive.** I assume the same independent project may be part of more than one larger system. My model handles that naturally.

6. **Member composition should form an acyclic graph.** Dependency edges may follow whatever architectural cycle rules wairon otherwise permits.

7. **A parent needing complete member architecture can materialize/fetch that member.** Surface-only operation is available through `dependency`; full `member` operation logically requires the member's specs or an immutable spec artifact.

8. **Hosted wairon can evolve its data model so nested projects gain real records.**

9. **`trustedLinks` or equivalent access policy can identify a consumer by canonical project identity rather than by a parent's mount alias.**

10. **A project can validly have zero L1s while being drafted.** Creation ergonomics can still scaffold one automatically.

## Questions that could change the recommendation

**1. Is a child project genuinely supposed to be independently authoritative?**

This is the most important question.

If maintainers actually intend:

> “A chained project's configuration is advisory; the parent's policy is authoritative whenever composed,”

then I would choose a different model and probably weaken R2 significantly.

The current commitments read the other way to me.

**2. Does “Platform approves the architecture” mean Platform's human is expected to approve Billing's internal design?**

My answer is **no**.

Platform approves:

```text
the Platform-owned architecture
+
the chosen approved Billing state
+
the composition between them
```

If the expected answer is yes, you need explicit multi-party approval rather than implicit parent validation.

**3. Must a parent be able to change a child spec directly?**

I would allow a Platform user with actual Billing write permission to do so through a Billing-bound operation.

I would not treat membership itself as permission.

**4. Can canonical project identity be organizational rather than globally internet-unique?**

For example:

```yaml
project:
  id: billing
  namespace: syw
```

could canonicalize to:

```text
syw/billing
```

The exact syntax matters less than immutability and independence from the mount alias.

**5. Are project renames identity changes or display-name changes?**

I recommend:

```yaml
id: acme.billing      # stable
name: Revenue Billing # freely renameable
```

**6. Should a provider contract update be accepted when it is semantically compatible but has a different digest?**

My recommendation is yes.

The digest identifies the consumer's exact approved input. Family compatibility should ask whether the live provider satisfies that input, not whether the byte hash is identical.

**7. How strong are interface compatibility rules?**

For simple method signatures:

```text
required methods must remain callable
```

is straightforward.

OpenAPI/schema/event compatibility may require codec-specific rules. If wairon cannot prove compatibility, conservative failure is preferable to hash-based false precision.

**8. Should organization policy be modeled above projects?**

If a hosted installation needs mandatory rules, I would rather have:

```text
organization policy
    ↓ required floor
project policy
```

than:

```text
whichever parent happened to invoke validation
```

That is a separate governance hierarchy from the architecture composition graph.

**9. Is simultaneous multi-repository migration a product requirement?**

If yes, wairon may eventually need a hosted transaction/orchestration concept.

I would still keep that separate from reference semantics. Distributed transactions should not be required merely to rename a mount.

**10. Does a member need to be source-visible at all times?**

If Platform only occasionally needs Billing internals, member state could optionally use an immutable published **spec bundle**:

```yaml
source:
  specBundle:
    project: acme.billing
    digest: sha256:...
```

That would let Platform perform architecture-wide analysis without cloning Billing's implementation repository.

**11. Is the term “family” intended to imply one parent tree forever?**

My model naturally moves from a strict tree toward a project graph.

A root's “family” can still mean:

```text
transitive member closure from this root
```

but a member may also participate in another closure.

---

# Bottom line

The smallest model I can find that resolves the issues together is:

```text
1. Project is the unit of identity, authority, approval and security.

2. Subsystem remains an architectural level inside a project.

3. Projects relate as either:
     member      — full-spec system composition
     dependency  — surface-only consumption

4. Repository/path/git/hosted location is merely a source resolver.

5. Cross-project references use local import aliases mapped to stable project IDs.

6. The project owning an edge owns its verdict.
   Parent validation aggregates; it does not reinterpret.

7. A consumer validates against its locked contract.
   A composition validates whether the selected provider satisfies that contract.

8. Project approval and composition approval are separate, content-addressed claims.

9. Nothing writes another project as a side effect.

10. Hosted projects stay projects even when they are members.
```

That removes the need for flat-child merging, loading-root identity, `super::`, ambient parent fallback, global family hashes, parent-generated child files, one-level approval pins, filesystem containment as dependency resolution, virtual hosted children, and most graph-wide rename rewrites.

Those problems are currently separate in the implementation, but architecturally they are mostly the same bug: **a project relationship is being represented as an L1 filesystem mount.**
