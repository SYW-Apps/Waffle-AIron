_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

## 1. The model, in one page

> **A chained subsystem is a project that another project contains.** Containment is one
> of exactly two project-to-project relationships, both declared in files: **contains** (a
> *member*, mounted by path, whose internals the family may read) and **consumes** (an
> *external*, resolved to a published surface and pinned like a lockfile entry).
> Everything else — configuration, approval, topology, hosting — is a property of a
> project. A family view is *composed* from its members' own results; it is never
> obtained by re-judging a member's files under someone else's rules.

**Four concepts**: project · published surface · external (consumes) · member (contains).

**Retired**: flat child, family surface, sibling surface (both become externals of the
parent and of siblings), `super::` and `::` (accepted on load, rewritten by `doctor`),
the root-subsystem anchor, `resolvedThrough`, `surfaceResolved`, three-segment ids,
narrowed hosted credentials, the per-tool confinement list, the parent's cascade into
children.

**The seven rules a user reads:**

1. **Identity.** Every project has an id (`project.yaml name`, a slug). A mount's id equals
   the member's project id. A reference is `x` (mine) or `<projectId>::x` (theirs). No id
   has a third segment; project ids are unique within a family.
2. **Edges.** Crossing a subsystem boundary is unchanged: Adapter → published Portal.
   Crossing into a *member* is a family edge, judged against the member's L1-published
   surface. Crossing into an *external* is judged against that project's surface — its L0
   exports at your audience distance — which you pin.
3. **Judgement.** The consumer's project judges its own edges under its own effective
   configuration. A member's effective configuration is its own, where `governance: inherit`
   (the default for members) makes the parent's configuration a floor the member may
   only tighten. The family run composes each member's own run and adds family-level
   checks; it never re-judges a member's internals under the parent's config, and it
   reports divergence.
4. **Evidence.** The live surface when the producer is on disk (or hosted and reachable);
   the pin otherwise. When both are available and differ, that is a finding, never a
   silent choice.
5. **Approval.** Per project. An approval records the project's own spec digests and the
   external digests it was approved against. A parent's approval pins each direct member's
   approved state, and a parent may require its members to be approved. No lock is
   transitive.
6. **Writes.** A project's files change only by work at that project. The family may read
   its members. Migrations that must touch members say which, and refuse when one is
   absent.
7. **Hosted.** A member is a hosted project. Credentials, permissions, audit, git and the
   UI are per project; a family is a relation between project records.

**Commitments.**

| | Verdict | Why |
|---|---|---|
| R1 one verdict per edge | keep | Each edge has exactly one judge (the consumer's project); the family run *reuses* that run. The only permitted difference between roots is `EXTERNAL_PIN_STALE`, which is explicit. |
| R2 child first-class | strengthen | A child validates alone against *declared* inputs (pins + inherited-governance lock), not against whatever is checked out above it. |
| R3 parent first-class | keep | The family view is composed: validate, canvas, approval tree, delegation by reference. |
| R4 no side-effect writes | strengthen | Includes `ensureProjectInitialized`/`generate` cascades (correction 3). Migrations are the one sanctioned exception, and they are explicit, dry-run first. |
| R5 authoring round-trips | keep, simplify | The canonical form is root-invariant, so save rewrites nothing; only `doctor` rewrites deprecated forms. |
| R6 confinement | reframe | A credential is for one project; a member is a project. A parent's credential reaches members by a family grant, not by an implicit walk. No list to maintain. |
| R7 no softening by location | keep | Violated today (correction 1); composition makes it hold by construction. |
| R8 layouts | weaken, honestly | Monorepo and submodule are *member* layouts. Side-by-side repositories are the *consume* relationship (`externals` with a local `path:`), never containment. |
| R9 nesting | keep for layout | Members nest arbitrarily; *ids* stay two-segment because a project is named, not positioned. |
| R10 proportional cost | strengthen | A child never loads its family; the family run loads each member once. |
| R11 predictability | keep | `project.yaml` (`externals`, `governance`) plus the mounts say, from files alone, what a reference points at and which project judges it. |

What this buys: one edge semantics for all three postures (internal, member, external),
one evidence model (live-else-pin, both-then-compare) shared with hosted relations, one
governance rule (floor + tighten + report), and the removal of every depth-limited or
root-dependent special case in the loader.

## 00 — The model: what a chained subsystem is

**Diagnosis.** The mechanism was built from the loader outward. `scanSpecsForProject`
federates a child's files into one index (`specs.ts:690-970`), and every later capability
either inherited "one tree" (validation from the parent, canvas, hosted binding) or
fought it (per-root approval, per-root config, the opaque owner agent, pins). Nobody
declared which relationship a mount means because the loader never needed to know. The
level misalignment the statement notes — a child's L0 plays the parent's L1 — is real and
it is *correct*: a project's L0 is its contract to the world, and inside a family the
world is the parent. The mistake is letting the parent hold a second declaration of the
same thing (issue 01), not the alignment itself.

**Options.**

| | Model | Against the commitments |
|---|---|---|
| A | One kind, parent authoritative: federated loading, parent config and approval govern, hosted child is a scope | R2 dies (a child cannot be judged alone), R4 becomes hard to hold, R10 dies |
| B | Declared kinds `part` / `dependency` on the mount | Bundles four independent behaviours (who judges internals, what the parent may reference, who approves, how it hosts). Today's design is already a *mix* of the two, and mixes are what teams ask for. A kind flag would be overridden field by field within a release. |
| C | Two relationships — *contains* (member) and *consumes* (external) — plus per-project properties (`governance`, lock policy) | Every commitment holds or strengthens (table in §1). Fewest concepts: both relationships already exist in the code as mounts and surface imports. |
| D | Consume only: no containment; every family edge is an external with a pin | Loses R3 (no composed view, no delegation by reference) and adds pin ceremony to the "one product split over directories" case, which is the most common one. |

**Recommendation: C.** The mount stays an L1 file so existing tooling keeps enumerating
it, but it declares only the relationship:

```yaml
# platform/.wai/specs/billing/.index.yaml   — a MEMBER: "billing is part of this system"
id: billing                 # must equal services/billing/.wai/project.yaml `name`
parentSystem: Platform
projectPath: services/billing
```

```yaml
# platform/.wai/project.yaml                — an EXTERNAL: "this system consumes crm"
name: platform
externals:
  crm:                      # a project id; referenced as crm::customer_portal
    source: { hosted: https://wairon.example/, project: crm }   # or { path: ../crm } or { file: … }
    pin: .wai/externals/crm.yaml
```

Answers to the open questions:

- *One concept or declared kinds?* Two relationships, no kind flag. "Part" is a member with
  `governance: inherit`; "independent project" is a member with `governance: own` or, when
  the parent should see nothing but the contract, an external.
- *Can a project change kind?* Yes, and each change is a named migration (issue 10):
  `externalize` (internal → member), `internalize` (member → internal), `detach` (member →
  external: delete the mount, add an `externals` entry and pin; the child's files do not
  change), `adopt` (external → member: add a mount; requires the project to sit inside the
  parent's directory).
- *Part of one family and a dependency of another?* Yes by construction. Membership is
  physical (one location, one parent); consumption is by pin (any number of consumers).
  The statement's "two copies or checkouts" is the answer for two *parents*, and it is the
  right one — Cargo and Bazel have the same rule.
- *What does a child's L0 correspond to in the parent?* The mount is the projection of the
  child's L0: `name`/`vision` supply the display name and description; the child's
  subsystems appear as `billing::<subsystem>`; the member's L1 publications are what the
  family may consume; the child's L0 `publicInterfaces` (with `audience`) are what the
  world beyond the family may consume. The `project` audience level then means exactly
  "family", which is what its doc comment already says (`models/specs.ts:46-52`).

**Migration.** No file changes for the relationship itself: existing `projectPath` mounts
*are* members. `doctor --fix` (run at the top, family-aware) writes `name` into each
member's `project.yaml` when absent (from the mount id) and refuses with a list when a
member's existing name differs from its mount id. The `governance` key defaults to
`inherit` for a project that a parent mounts — the same accepted behaviour change Track
D2 recorded for `projectType` (`.wai/phased_design.md:179-180`), with the same release
note.

**Proof.**

- `member-is-a-project`: for every family fixture, `validate` at a member root with no
  parent on disk and fresh pins returns the same findings as the family run restricted to
  that member, modulo id prefix.
- `external-sees-only-L0`: a project consuming another as an external cannot reference a
  component the producer publishes at L1 only (`SURFACE_REF_NOT_EXPOSED`), while the
  same reference from a member of the producer's family resolves.
- `relationship-is-declared`: removing the mount file and adding an `externals` entry
  (detach) changes no verdict on the edge as long as the pinned surface equals the live
  L0 export; removing both yields `EXTERNAL_UNDECLARED`, an error, from both roots.
- `no-kind-flag-needed`: the four postures in the options table are each expressible with
  the two relationships plus `governance`, and a fixture exists for each.

## Worked example: Platform / Billing / Payments / Shipping

**Declarations.**

```yaml
# platform/.wai/project.yaml
name: platform
lock: { requireApprovedMembers: false }

# platform/.wai/specs/billing/.index.yaml          (member)
id: billing
parentSystem: Platform
projectPath: services/billing

# platform/.wai/specs/shipping/.index.yaml         (member)
id: shipping
parentSystem: Platform
projectPath: services/shipping

# platform/.wai/specs/core/.index.yaml             (internal, unchanged)
id: core
parentSystem: Platform
publicInterfaces: [{ type: REST, details: core, component: core_portal }]
```

```yaml
# services/billing/.wai/project.yaml
name: billing                       # == mount id, else MOUNT_ID_MISMATCH
governance: inherit
externals: {}                       # billing consumes nothing

# services/billing/.wai/specs/.system.yaml
name: Billing
vision: Invoicing for the platform.
publicInterfaces:                   # what the WORLD may consume (audience ≥ department);
  - id: invoice_portal              # optional for family consumption, which is L1-based
    subsystem: billing
    component: invoice_portal
    audience: instance

# services/billing/.wai/specs/billing/.index.yaml  (subsystem; loads as billing::billing from Platform)
id: billing
parentSystem: Billing
publicInterfaces: [{ type: REST, details: invoicing, component: invoice_portal }]

# services/billing/.wai/specs/payments/.index.yaml (member of Billing)
id: payments
parentSystem: Billing
projectPath: payments
```

```yaml
# services/billing/payments/.wai/project.yaml
name: payments                      # unique in the family; Payments' components are payments::x from EVERY root
governance: inherit                 # floor = Billing's effective config = Platform's floor ⊔ Billing's own
```

```yaml
# services/shipping/.wai/project.yaml
name: shipping
governance: inherit
externals:
  billing: {}                       # a family sibling; source implied
  platform: {}                      # my parent

# services/shipping/.wai/specs/dispatch/dispatch_adapter/.index.yaml
id: dispatch_adapter
subsystem: dispatch
componentType: Adapter
dependsOn: [billing::invoice_portal]

# …/dispatch_adapter/.implementation.yaml (L5 call step)
- stepNumber: 3
  type: call
  targetComponent: billing::invoice_portal
  targetMethod: createInvoice
```

After `wairon externals pin` at Shipping: `.wai/externals/billing.yaml` (the L1-projected
surface of Billing's subsystems, keyed `billing`), `.wai/externals/platform.yaml`, and
`.wai/externals.lock.yaml` with content digests and the `used` map
(`invoice_portal.createInvoice`), plus the inherited governance floor.

**The edge `dispatch_adapter → invoice_portal`, judged.**

| From | What runs | Inputs for the edge | Verdict |
|---|---|---|---|
| Shipping, cloned alone | `validateProject(shipping)` under Shipping's effective config (the pinned floor) | pin `billing` | `dispatch_adapter` is an Adapter ✓; `invoice_portal` is in the pin ✓; `createInvoice` is on it ✓ → no finding. If the pin lacks the method: `SURFACE_REF_NOT_EXPOSED` (error). If `externals.billing` were missing: `EXTERNAL_UNDECLARED` (error). |
| Shipping, family on disk | same run | live surface of Billing (projected from `services/billing`) — pin compared | same verdict, plus `EXTERNAL_PIN_STALE @billing` (warning) if the used method's digest moved |
| Platform | `validateFamily(platform)` = `validateProject` for platform, billing, payments, shipping + family checks | Shipping's run, exactly as above, with live Billing | the same findings, ids prefixed `shipping::`; family checks add nothing here. It is *one* judgement of *one* edge, reached from three roots. |
| Billing | `validateProject(billing)` | — | nothing: Billing does not know Shipping. The family run at Platform lists inbound consumers per producer (`wairon externals consumers billing`: `invoice_portal.createInvoice ← shipping::dispatch_adapter`), and hosted relation health shows the same. |

What each root *may* reference: Shipping may reference anything Billing publishes at L1
(it is family) and anything Platform's internal subsystems publish; Platform may
reference `billing::invoice_portal` and `payments::pay_portal` as family edges from `core`
through an Adapter; an outsider `crm` that declares `externals.billing` sees only
Billing's L0 exports at its audience distance.

**What each approval covers.**

- Payments: its specs, under its effective doctrine; `externals: {}`.
- Billing: its specs + `members: { payments: <approved StateId> }`.
- Shipping: its specs + `externals: { billing: 9c1…, platform: e02… }` — "approved against
  these contracts".
- Platform: its own specs (`core`, the two mounts) + `members: { billing: …, shipping: … }`.
  With `requireApprovedMembers: true` the lock refuses while Shipping is drifted; without
  it, it pins Shipping's last approval and prints `shipping: moved`.

**Billing renames `createInvoice` → `issueInvoice`.**

1. *Billing* validates clean; its interface spec drifts from approval (draft context);
   the team re-locks Billing. Nothing about Shipping — Billing cannot know.
2. *Shipping, cloned alone (pin at 9c1…)*: still passes. Honest: it declares its input,
   and its input has not changed. `wairon externals status` needs the producer and says
   `unreachable`.
3. *Shipping, family on disk*: `SURFACE_REF_NOT_EXPOSED @dispatch_adapter-impl`
   ("`createInvoice` is not exposed on `billing::invoice_portal`") — error — and
   `EXTERNAL_PIN_STALE @billing` ("`invoice_portal.createInvoice` removed, `issueInvoice`
   added"). The team fixes the call step, runs `externals pin` (digest → 4d0…), re-locks
   Shipping (its approval now records `billing: 4d0…`).
4. *Platform*: the same two findings under `shipping::`, so Platform's CI fails until step
   3 is done; `wairon lock` at Platform then reports `billing: moved`, `shipping: moved`,
   and pins their new approvals.
5. *Hosted*: Billing's republished surface changes its digest; the Shipping→Billing
   relation's health turns red with the same message as `externals status`, because they
   compute the same thing.

Contrast with today: step 3 today validates *clean* (the pin outranks the live tree);
step 4 today reports `MISSING_ENDPOINT` and `UNUSED_COMPONENT` and nothing about the
call (issue 04's evidence).

## Interactions

**Reinforcing.**

- 02 → 01 → 10: project-id references require mount id = project id, which makes the
  mount content-free (01) and turns rename into a child-side identity change with a
  family-wide substitution (10). Move becomes free because nothing names a path.
- 03 → 04 → 07: per-project effective configuration is what lets validation be composed
  from member runs; composed runs are what let approval context be per member; per-member
  approval is what makes the parent's `MEMBER_UNAPPROVED` and `requireApprovedMembers`
  meaningful.
- 05 → 04 → 08: declared, digested externals are the input that makes a standalone run
  well-defined (R2), the thing a family run compares against (R1's explicit difference),
  and the mechanism that makes side-by-side repositories work without containment (R8).
- 05 ↔ 09: one lockfile shape for family pins, file imports and hosted relations; relation
  health and `externals status` are the same computation.
- 06 ↔ 09: a member that is a project (09) is exactly what "brief by reference, composed at
  the member's root" (06) needs hosted — the brief tool binds the member's record.
- 03 ↔ 05: the inherited governance floor rides in the externals lock, so a detached
  clone is judged under the family's doctrine — no new artifact.

**Conflicting, and how I resolved them.**

- *Doubled names* (01) versus *no third segment* (02): `billing::billing` is the price of
  removing the merge. Cheaper than any alternative I found; teams that mind name the
  subsystem differently.
- *Members as hosted projects* (09) versus *containment as tenant isolation* (08): kept
  containment physically (a member's root stays inside the parent's) so isolation code is
  untouched; only the *record* model changes.
- *Family-wide migrations write into members* (10) versus R4: the one sanctioned
  exception, made explicit (dry run, list, refuse when incomplete). The alternative —
  never touching members — leaves dangling references by design, which is today.
- *Live over pin* (04) versus *deterministic CI* (05): the default is live-else-pin with an
  explicit stale finding; `--frozen` exists for the team that wants pins only, and it says
  what it did not consult.
- *Inheritance floor* (03) versus *a member that deliberately loosens*: `governance: own`
  is allowed, and the parent sees `GOVERNANCE_DIVERGENCE`; what is not allowed is an
  `inherit` project silently loosening (`GOVERNANCE_LOOSENS`). The issue-03 probe's
  situation becomes a declared disagreement instead of a silent one.
- *Composition cost* (04) versus today's single scan: N contexts instead of one, but each
  loads one project and the surfaces it consumes; the total rule work is the same and the
  child-alone case gets cheaper (R10).

## What I would not do

- **Add a `kind: part | dependency` enum.** It bundles four behaviours that vary
  independently; the current design is already a mix, and the first user who wants "my
  team's rules, but the platform's approval gate" would need a third kind.
- **Let the parent's configuration govern members** (issue 03's "override"). It is what the
  parent's run does today and it is the mechanism behind correction 1. Doctrine flows down
  as a *floor*, never as a replacement.
- **Keep `resolveThroughParent` and repair its code family.** A union of two judges with
  different inputs cannot be made to satisfy R1; every new rule would have to be classified.
  Compose instead.
- **Keep `::` meaning "the loading root", or keep the root-subsystem anchor** even with the
  lost fix. They are the source of the shadowing, the clamp, the two spellings and the
  depth-one merge.
- **Merge `116d5f7` as-is** (correction 2). Take its shadowing half into the new loader;
  the `mountRealization` branch is superseded by "no merge".
- **Push anything into a child** — pins, agent files, guides, or `project.yaml` — from a
  parent operation that is not a named migration. Correction 3 shows the cascade already
  crosses the line the CHANGELOG says it does not.
- **Lock transitively or roll approvals up.** Both destroy the parent's diff as a review
  signal and take a decision away from the team that owns the files.
- **Let a pin outrank a reachable live producer**, or key freshness on the whole family's
  state.
- **Keep a per-tool confinement list.** A tool that must opt in to being confined will one
  day not.
- **Support anything at one depth only.** Every rule at every depth, or not at all.
- **Invent a "sub-subsystem" level.** A project containing subsystems is L0 → L1 and
  already defined; the mount is a project node.
- **Introduce stable opaque ids.** Names in YAML are the product; R11 depends on them.

## Prior art

| System | What genuinely applies | Where the analogy breaks |
|---|---|---|
| **Cargo workspaces + path dependencies** | The closest match. A workspace member is a full package (own manifest, publishable alone); the workspace is a build unit; members reference each other by *package name*, resolved via `path` when present; `[lints] workspace = true` is opt-in inheritance of doctrine — my `governance: inherit`. | One `Cargo.lock` per workspace; wairon needs one per project because members are *approved* separately. Cargo has no notion of a member's "published surface" narrower than its public API. |
| **Bazel external repositories** | `@billing//…` labels: references anchored on a *declared repository name*, never on a directory — my two-segment ids. Unique repo names per workspace. | One `WORKSPACE`/`MODULE.bazel` governs everything (no per-member governance); no approval concept. |
| **Go modules, `replace`, `go.work`** | `go.work` = "when these modules are on disk, use them live; otherwise the module cache" — exactly live-else-pin. `replace` = my external `path:` source. | Go pins *versions* from a registry; wairon pins *surfaces* by content digest, and a family has no registry. |
| **Nix flake inputs** | `flake.lock` per flake, inputs pinned by content hash, `follows` to dedupe a shared input — the externals lockfile, including the inherited-governance entry as a pinned input. | Inputs are immutable snapshots; wairon's live family is mutable and the drift finding is the point. |
| **Git submodules** | The approval pin is a submodule pin (the statement already says so); nested submodules are the chain of pins; "must be initialised for CI" is `MEMBER_NOT_FOUND`. | A submodule pins *files*; wairon pins a *decision* about a design. Both are needed (issue 08). |
| **Nx / Turborepo** | Project graph, `affected`, implicit vs explicit dependencies — the family canvas and the inbound-consumer report. | No contracts, no gate, no approval; "dependency" is a build edge, not a published surface. |
| **Terraform modules** | Module `source` + version + the provider lock; `terraform_remote_state` as consuming another root's outputs — an external's surface. | One-directional; no notion of a root being *part* of another. |
| **Backstage system model** | `System` ∋ `Component` with `providesApis` / `consumesApis`; `API` entities with owners — published surface + consumes, and the system as family. | Descriptive catalog; nothing is judged. |
| **C4** | System Landscape / System Context: a member is a container when zoomed in and a system when zoomed out; an external system is a box you cannot open — the member/external distinction as a *drawing* rule. | No rules, no identity model. |
| **Pact (consumer-driven contracts)** | The consumer records what it *uses*; the provider verifies against consumers' contracts — my `used` map in the lock, staleness per used method, and the inbound-consumer report as provider-side verification. | Pact runs at test time against a running provider; wairon compares specs. |
| **DDD context maps** | Published Language = surface; Open Host Service = Portal; Anticorruption Layer = the Adapter rule; Shared Kernel ≈ `trustedLinks`/shared types; Customer–Supplier = the inbound report as the supplier's obligation. | A vocabulary, not a mechanism; and DDD has no answer for "one context is *part of* another". |

## Assumptions and questions for the maintainers

**Assumptions I made.**

1. `project.yaml name` can be required to be a slug (`[a-z0-9-_]+`) and unique within a
   family. If existing names are free text, add `id` and keep `name` for display.
2. Component ids are flat within a project (true today: subsystems never prefix
   component ids), so `<projectId>::<localId>` is always two segments. The one existing
   use of `::` inside a project — subsystem-qualified *type* references
   (`rules/index.ts:413-418`) — is covered by `LOCAL_ID_SHADOWS_PROJECT`.
3. Family consumption is L1-based (a member sees what a sibling's subsystems publish),
   and the L0 `publicInterfaces` govern consumption from outside the family. This keeps
   the "one product split over directories" case free of L0 ceremony. If you would rather
   require L0 exports even inside a family, the model does not change — only the
   projection used for family externals does, and `audience: project` stops being
   redundant.
4. A family-wide migration is allowed to write into members on disk (dry run, listed,
   refused when incomplete). If R4 is meant to forbid even that, migrations degrade to
   "rewrite the parent, print the list", which is today.
5. Hosted members can remain physically inside the parent's root, so the containment code
   is untouched by stage 2.

**Questions.**

1. **Is the audience ladder meant to have "family" as a level?** `project` is documented
   as family-internal (`models/specs.ts:46-52`) but family resolution today reads L1, not
   L0 at `project`. Which is intended? (My recommendation assumes L1; see assumption 3.)
2. **Should `--ci` at a parent fail on an unapproved member by default?** I default
   `requireApprovedMembers` to off for compatibility; a platform team may want it on by
   policy (hosted `InstancePackPolicy` is the natural home).
3. **How much do users rely on writing bare `billing::x` inside a child** to mean the
   parent's top-level subsystem? It keeps meaning the same thing for *mounted* siblings
   (project id) and changes for *internal* parent subsystems (`core::x` → `platform::x`).
   A corpus check on real trees would size the migration.
4. **Hosted stage 2: are members-as-records acceptable to the permission model as it
   stands** (project → member inheritance as one more level of the hierarchical
   resolver), or does the resolver assume projects are leaves?
5. **Do you want `--frozen` at all?** It exists in my model only so a detached CI can be
   deterministic and honest. If every CI is expected to have the family checked out,
   drop it.
6. **Does anything depend on three-segment ids** beyond the loader, `getSubprojectPrefix`
   and hosted selectors? The canvas, share snapshots and OpenAPI codec name ids in their
   outputs; they would follow the loader, but a rename of ids is visible in exported
   artifacts.
7. **Is the lost commit `116d5f7` still wanted in any form?** Its shadowing half is the
   right instinct; under this model its tripwire changes name (`LOCAL_ID_SHADOWS_PROJECT`)
   and its `mountRealization` branch becomes unnecessary.
