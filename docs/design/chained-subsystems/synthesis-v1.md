> **Superseded.** This is the first synthesis (v1). It predates ChatGPT 6 Astra's repository-backed review on `dev` e7d30d7 (`responses/chatgpt-6-astra.md`) and is superseded by [`synthesis.md`](synthesis.md), which re-derives every verdict below against that review and the code after PR #68.

# Chained subsystems — synthesis

**Lead reviewer:** Fable 5.1 · 2026-09-12 · written against the working tree of
`fix/chaining-verdicts-confinement` (dev at v5.1.1-dev.11 plus the six commits `7d59a22…e2a63cc`).
**Sources reviewed in full:** [`problem.md`](problem.md) r2; [Fable 5.1](responses/fable-5.1.md)
(repository access, answered r1, corrections folded into r2); [ChatGPT 5.6 Sol](responses/chatgpt-5.6-sol_chat.md)
and [ChatGPT 6 Astra](responses/chatgpt-6-astra_chat.md) (with its chat text
[`chatgpt-6-astra_chat_response.md`](responses/chatgpt-6-astra_chat_response.md); the two forms are one
answer in two renderings — see the provenance notes in each `issues/*/analyses/chatgpt-6-astra_chat.md`);
and the evidence in every `issues/<id>/README.md`. Every claim a conclusion rests on was checked
against the code (§9).

**The decision this document supports:** which model of a chained subsystem to commit to. The
recommendation is written up as
[`issues/00-the-model/proposals/projects-and-two-relations.md`](issues/00-the-model/proposals/projects-and-two-relations.md).

Contents: 1 Models side by side · 2 Convergence · 3 Divergence and verdicts · 4 Per issue ·
5 Recommended model · 6 Migration and staging · 7 Risks and probes · 8 Decisions for the
maintainer · 9 Claims checked against the code

---

## 1. The models side by side

| | **Fable 5.1** (repo access) | **ChatGPT 5.6 Sol** | **ChatGPT 6 Astra** |
|---|---|---|---|
| Core concepts | project · published surface · **member** (contains) · **external** (consumes); the mount stays an L1 file declaring only `id` + `projectPath`; `governance` is a project property | project = identity + governance + approval + release + security boundary · subsystem (inside one project) · **project relation** `member \| dependency` · **source** (materialization); composition moves out of L1 into `project.yaml`; a pure directory split should be *one* project with spec fragments | project · **membership** · **consumption**, declared in `project.yaml` outside L0–L5; a child's L0 stays an L0; two explicit assessments (project validity, composition validity) |
| Identity / references | `project.yaml name` (slug, unique in the family) = mount id; `x` or `<projectId>::x`, two segments; `super::` and `::` retired | immutable `project.id` (`acme.billing`) + a consumer-local alias table (`dependencies.billing → acme.billing`); `@billing::invoice_portal`; `::`/`super::` invalid in schema v2 | immutable namespace-qualified id (`syw.billing`) + owner-local `imports` alias; `dep:billing/invoice_portal#create_invoice`; authored spelling preserved, canonicalization an explicit formatter |
| Who judges an edge | the consumer's project under its *effective* config; the family run composes member runs + family checks | the owning project under its own config; the family run aggregates and adds composition findings | owner evaluator `V(P)`; `Family(F)` = all `V(P)` AND import↔provider compatibility AND composition policy; findings keep issuer and basis |
| Evidence (live vs pinned) | live when reachable, else pin; both present and different → `EXTERNAL_PIN_STALE` (warning, fails `--ci`); `--frozen` = pins only | the lock defines the consumer's verdict; the family run separately checks live provider ⊇ locked contract (`WAI_COMPOSITION_INCOMPATIBLE`); `--against-workspace` as a non-reproducible diagnostic | locked inputs define `V(P)`; composition needs an explicit context `F` (working or an immutable captured artifact); no ancestor fallback; a missing input = *incomplete* |
| Governance | `governance: inherit` (default): the parent's effective config is a floor, own may only tighten; `own` opts out with `GOVERNANCE_DIVERGENCE` at the parent; the floor rides in the externals lock | isolation; the parent puts required packs (with digest) on the member relation and *verifies the attestation*, never re-runs the child | owner policy + pinned policy profiles (`syw.service@sha256:P1`); the parent `composition.requirePolicies` over `descendants`; stricter-floor merge for the same rule, explicit conflict otherwise; no ambient inheritance |
| Approval | per project; the record adds `externals` digests; the parent pins each direct member's approved state (`members`); `requireApprovedMembers`; never transitive by writing | project approval (specs + config + packs + deps digests) + a Merkle-like **composition approval** (`lock --family`), transitive by hash | `ownSubject(P)` and `compositionSubject(P)` on one record; `lock --family --context F` requires recursively approved, matching members and a passing integration; preflight at settled strictness |
| Hosting | stage 1: confinement as a property of the binding (tools declare `scope`) + in-band announcement; stage 2: members as records with `parentProjectId`, parent bindings a permission *floor* | every logical project a record; `ProjectRelation(member \| dependency)`; a child credential is a `ProjectHandle`, confined at resource access, so no prohibition list | every project registered once; `(principal, projectId, action, permitted artifacts)` enforced in the common service and filesystem gateway; family access by *explicit* member grants; audit records the initiating composition |
| Layouts | members inside the parent (monorepo, submodule); side by side = consumption via `externals` with `path:`; containment kept for hosted isolation | general source resolvers for members too (`path`, `../x`, `git url+rev`, `hostedProject`) + `wairon sync`; containment no longer required | nested `path` keeps the escape restriction; side-by-side through a separately *selected* workspace descriptor; immutable fetched sources; backup once per git repository + a composition manifest |
| Migration cost | no relationship migration (mounts *are* members); `doctor --fix` rewrites references family-wide; mount id must equal project name; a flat child's subsystem becomes `billing::billing`; pins → externals lock | `schemaVersion: 2` + compatibility loader; `wairon migrate project-relations --plan/--apply`; per-consumer alias insertion; ambiguity stops the migration | versioned schema + legacy reader; per-owner rewrites; conflicts reported, never guessed; new `context` artifacts |

The two ChatGPT answers are close to each other (both had only the statement) and Fable's is
close to both on every structural point; the differences are in evidence semantics, identity
form, governance mechanism and how far to go on hosting/layouts. That is a strong signal in
itself: three independent runs of the same prompt produced one shape.

## 2. Where they converge

All three, unprompted by each other:

1. **No `kind` flag.** Each rejected the maintainer's kinds idea for the same reason: a kind
   bundles behaviours (who judges internals, what may be referenced, who approves, how it
   hosts) that vary independently, and today's design is already a mix.
2. **Two relationships, declared in files:** *contains* (member; internals readable; the
   family view composed) and *consumes* (external/dependency; surfaces only; pinned).
3. **The mount carries no L1 content.** The child owns its L1s; no same-id merge; the term
   "flat child" disappears (Sol: "if a design still needs special semantics because a child L1
   happens to have the same text id as a relation alias, the identity model is still leaking").
4. **A reference names a project, never a position.** `super::`, loading-root `::`, the
   root-subsystem anchor, last-segment/first-hit pin matching and silent clamping all go.
5. **One judge per edge: the project that authored it, under its own configuration.** The
   family run composes/aggregates and never re-judges a member's internals under the parent's
   config. All three therefore retire `resolveThroughParent` and its code-family merge.
6. **Pins become per-producer/per-contract locks with content digests.** The whole-family
   `stateId` freshness goes; the *family surface* as a kind goes; unused pins are reported;
   undeclared references are errors.
7. **A parent lock writes nothing into members** — no `ensureProjectInitialized`, no
   skills/context/guides; generation is explicit.
8. **Approval per project; a parent never locks a child; "the family is approved" is a
   separate, explicit claim** (they differ on the mechanism, §3 D4).
9. **A member is a real hosted project record; confinement is a property of the
   binding/handle, not a per-tool list.**
10. **Migrations are plan-first, family-aware and honest about unavailable owners;
    `move` touches no reference.**
11. **Commit ids and approval digests are recorded together but never merged.**
12. **Code conformance belongs to the source file's owner** (Fable and Astra explicitly; Sol by
    construction).

## 3. Where they diverge — and verdicts

**D1 — Evidence at the consumer's gate: live-else-pin (Fable) vs lock-defined (Sol, Astra).**
*Fable:* when the producer is reachable, judge the edge against the live surface and add
`EXTERNAL_PIN_STALE`; a revoked publication is visible at the child the moment the family is
on disk, and a monorepo developer sees Shipping break as soon as Billing changes.
*Sol/Astra:* the consumer's own verdict must be a pure function of its files and lock — R7 and
R11 — and the live comparison is a *composition* finding (Sol at the family run or under
`--against-workspace`; Astra under an explicit context). Their strongest point: "checkout
topology as a validation input" is exactly today's disease, and hosted "reachable" is a
credential question, which must never change an owner's verdict.
*Verdict — Sol/Astra's invariant with Fable's ergonomics.* The owner's finding on the edge is
lock-defined and identical from every root and checkout; when the producer is reachable the
run *adds* an explicitly scoped composition finding (`EXTERNAL_INCOMPATIBLE`, error, when a
*used* entry no longer holds; `EXTERNAL_PIN_STALE`, notice, when only unused parts moved) —
by default, at the child as well as at the parent, because a developer must not need a flag to
learn that a dependency broke. A detached clone cannot see it and `externals status` says
`unreachable`, which is honest. The two positions turn out to differ only in *which finding
carries the disagreement*; keeping the owner finding stable is the cleaner property to test and
to reason about hosted. `--frozen` becomes unnecessary. Compatibility is semantic (used
methods still exist with equal signatures; additions never fail; unknowns fail closed) — Sol
and Astra are right that byte-equal digests over-fire, and Fable's per-used-method digest is a
fine implementation of the same check. *Confidence: high on the invariant; medium on
"composition findings on by default at the child"* (decision Q5).

**D2 — Identity: mount id = `project.yaml name` (Fable) vs an immutable namespaced id plus a
consumer-local alias table (Sol, Astra).** *Fable:* fewer concepts, readable YAML, the id in
a reference is the name people use, family-unique is all the loader needs.
*Sol/Astra:* renames and multi-composition need an identity that never appears in
references; Bazel's canonical-vs-apparent names; hosted needs a globally unique id anyway.
*Code:* `ProjectConfig.name` is free text (`src/models/project.ts:254-255`), so Fable's slug
assumption is false today and a new field is needed either way; `OrganizationUnitRecord.id`
already uses dot-qualified slugs (`src/server/types.ts:487-499`) — precedent for `acme.billing`.
*Verdict — hybrid.* A declared, immutable, slug `id` (dot namespace allowed; family-unique
locally, instance-unique hosted), used *directly* in references as `<alias>::x` where the
alias defaults to the id. The alias table is not a third concept: the `members`/`externals`
maps are already keyed by alias with a `project:` value (Sol's `dependencies`, Astra's
`imports`, Fable's `externals` are the same table); when alias = id nothing extra is written.
That keeps the common case free of indirection and keeps the escape hatch for renames and
collisions. *Confidence: high.*

**D3 — Reference syntax: `billing::invoice_portal` (Fable) vs `@billing::…` (Sol) vs
`dep:billing/invoice_portal#method` (Astra).** *Code:* `SpecIdSchema` is `/^[a-z0-9-_]+$/`
(`src/models/specs.ts:6`); `::` is what the loader, the MCP tool schemas, hosted selectors,
the canvas and the OpenAPI codec already split on. A sigil's only job — telling a project
reference from a subsystem-qualified type reference `sub::Type` — is done by
`LOCAL_ID_SHADOWS_PROJECT`. *Verdict: `::`, no sigil. Confidence: high.*

**D4 — Governance: inherited floor (Fable) vs attested/pinned requirement (Sol, Astra).**
*Fable:* `governance: inherit` computes an effective config recursively; zero ceremony for
the "one product split over directories" case; `[lints] workspace = true`.
*Sol/Astra:* no ambient parent — the child declares the doctrine it adopts (as a digested
input), the parent *requires* it on the relation and verifies adoption; the same child in two
compositions cannot receive contradictory doctrine; a detached clone needs no missing files.
Fable's own design already pins the floor into the externals lock for detached clones — that
*is* the Sol/Astra mechanism in disguise.
*Verdict — Sol/Astra's mechanism with Fable's ergonomics.* Pinned policy profiles adopted by
the child, required by the parent (`composition.requirePolicies`), non-adoption a composition
finding (`POLICY_NOT_ADOPTED`); `create`/`adopt` write the parent's required profiles into the
new member once so the common case needs no manual step; an adopted profile is a floor the
child may only tighten (`POLICY_LOOSENS` error). This also answers the lead engineer's "can a
platform team *require* inheritance?" — yes: the member stays valid alone but cannot be
composed, which is the right shape (Astra: "the parent can decline that child version").
*Confidence: high.*

**D5 — Approval: a chain of one-hop pins (Fable) vs a Merkle-like composition hash (Sol,
Astra).** These converge once stated precisely. Today `currentChildPins` pins the child's
approved gate StateId (`src/core/approval.ts:211-222`), and because the default scan is
recursive (`scanAll`, `src/core/specs.ts:700-701`) that StateId already digests grandchildren's
*content* as of the child's lock — what it cannot say is whether the grandchild was
*approved*. Pin the member's **composition subject** (its own approval digest ⊕ its own
`members` pins) instead of its content StateId and the chain is transitive by construction —
Fable's pin with Astra's hashing. Add `requireApprovedMembers` (Fable) as the switch that makes
`lock` refuse (Sol/Astra's `lock --family`). *Confidence: high.*

**D6 — Layouts: containment for members (Fable; Astra for `path:`) vs general source
resolvers including `../billing` and git for members (Sol).** *Sol's point:* R8 promises
separate repositories, and the "platform team and service team in separate repos" case wants
a *member*, not a consumer. *Against:* hosted tenant isolation is containment
(`src/core/specs.ts:196-222`); a manifest that points outside its root is ambient filesystem
access; a parent checkout incomplete by design. *Verdict — Astra's shape:* `path:` stays
contained; a member outside the root binds only through an explicitly selected, local-only
workspace descriptor that hosted never reads; everything else side by side is consumption
(`externals` with `source: {path: ../x}`). Git-fetched member sources (`wairon sync`) deferred:
checking out a member is git's job. *Confidence: medium.*

**D7 — Where the mount is declared: keep the L1 file with only `id`/`projectPath` (Fable) vs
`project.yaml members:` (Sol, Astra).** *Fable:* no schema migration; everything that
enumerates mounts keeps working. *Sol/Astra:* a relation is not architecture; an L1 file keeps
inviting L1 fields and keeps a synthetic subsystem record in the loader. *Verdict:* the
relation moves to `project.yaml members:`; the L1 `projectPath` form loads for one release and
`doctor --fix` moves it; the family view draws a *project node*. The cost is every site that
does `loadSubsystemSpecs().filter(s => s.projectPath)` (validation, approval, generate,
provision, the MCP mount tools, hosted `resolveSubprojectMounts`) — mechanical, and a loader
that reads both forms makes it stageable. *Confidence: medium.*

**D8 — Explicit composition contexts (Astra alone: `.wai/contexts/*.yaml`, `validate
--context`, projections shared into children).** *For:* a reproducible family verdict; a
child can re-run its integration obligation without sibling filesystem access. *Against:* a
new artifact class and command set, most of which the parent's lock record already is (a
pinned selection of member states and external digests). *Verdict:* not now. The parent's lock
record *is* the immutable context; `validate --at-approval` can be added later. Keep Astra's
"projection into the child" as the *hosted* delivery of composition findings (relation
health), not as a file. *Confidence: medium.*

**D9 — Directory-split-as-one-project (Sol's spec fragments).** Sol alone: when the only
goal is one project over several directories with one approval and one config, do not
manufacture a project. Astra says "keep their subsystems in one project" but offers no
mechanism; Fable says "a member with `governance: inherit`". *Verdict:* orthogonal and
deferred — a member with adopted policy covers doctrine; what remains is per-member approval,
which is *wanted* when the directories belong to different teams and unwanted when they do not.
Measure demand before building fragments. *Confidence: medium.*

**D10 — Hosted permission: parent bindings as an automatic floor over members (Fable) vs
explicit member grants only (Astra; Sol: membership never implies permission).** *Code:*
`ScopeKind = 'instance' | 'unit' | 'project'` (`src/server/types.ts:38`) and the resolver
walks project → placement unit → unit ancestors → instance
(`src/server/permission_resolver.ts:73-81`); there is no project → project rung, so either
option is new resolver work (Fable's "already walks unit → project; add project → member"
understates it). *Verdict:* explicit grants, recorded at migration equal to today's reach so
nothing widens or narrows on upgrade; the UI offers "grant family access" when a member is
created. Ancestry is not authorization. *Confidence: medium.*

## 4. Per issue

Format: options that emerged · convergence · recommended direction · confidence · what would change my mind.

**00 — The model.** *Options:* (a) one kind, parent authoritative; (b) declared kinds on the
mount; (c) two relations + project properties (all three sources); (d) consume-only.
*Convergence:* (c), unanimously; the kind flag rejected unanimously. *Direction:* (c) as in
§5 — a project is the unit; contains/consumes are the relations; a child's L0 is its L0 and
the family view shows it as a project node. *Confidence: high.* *Changes my mind:* evidence that
real users want the parent's team to *own* a child's internal verdicts (the lead engineer's
"platform should be authoritative for the split-product case") — then D4's required-policy
mechanism must be shown insufficient before any kind flag is reconsidered.

**01 — Mount and realization.** *Options:* mount wins; child wins formalised at every depth
(fix 2 on the branch); mount carries no content, no merge (all three); per-field precedence.
*Convergence:* no content on the mount, no merge, the child owns zero-to-many L1s, creation
scaffolds a real L1 (Sol, Astra) or only L0 + `project.yaml` (Fable). *Direction:* no merge;
mount = a `members` entry; `MOUNT_DECLARES_CONTENT` for one release then error; `doctor --fix`
moves mount-level `publicInterfaces`/`trustedLinks` into the child's same-named subsystem when
it has none, else stops with a listed conflict (Sol's `WAI_MIGRATION_CONFLICT`); a flat child's
subsystem becomes `billing::billing`; creation scaffolds `project.yaml` + L0 and, with
`--initial-subsystem`, one L1. *Confidence: high.* *Changes my mind:* the doubled id leaking
into exported artifacts turning out to be unacceptable to users (probe P2) — then a member's L0
may name a *primary* subsystem for display, never for identity.

**02 — Identity and references.** *Options:* rigorous `super::`; root-invariant `::`;
project-id-anchored two-segment references (Fable); immutable id + alias table + sigil (Sol,
Astra); opaque ids (rejected by all). *Convergence:* stable project identity, no positional
paths, exact pin matching, authored text never rewritten by the loading root. *Direction:*
declared slug `id`; `<alias>::x` with alias = id by default (D2, D3); `DEPRECATED_REFERENCE_FORM`
for one release; `PROJECT_ID_COLLISION`, `LOCAL_ID_SHADOWS_PROJECT`, `DUPLICATE_SPEC_ID`.
*Confidence: high.* *Changes my mind:* a corpus check (probe P1) showing that bare `core::x`
inside children (meaning the parent's *internal* subsystem) is so common that rewriting it to
`platform::x` is the dominant migration cost — then keep the parent's internal subsystem ids
as a second alias family for one more release.

**03 — Governance.** *Options:* isolation (Sol); inheritance as a floor (Fable); override
(today's parent run); explicit required/pinned policy (Sol, Astra). *Convergence:* the
owner's configuration judges the owner's specs; the parent's doctrine reaches a child only
through something declared; disagreement is a finding. *Direction:* pinned policy profiles
adopted by the child, required by the parent, scaffolded at creation (D4). Pack doctrine the
child adds applies to the child; a required pack the child lacks is `POLICY_NOT_ADOPTED` at
the family run. Project type: explicit owner value, copied once at scaffold (Track D2's
"inherit unless declared" becomes "copied at creation"). *Confidence: high.* *Changes my
mind:* a hosted instance policy that must apply to *every* project regardless of adoption — that
is an instance-level floor (`InstancePackPolicy`), a separate hierarchy from composition, and
it can coexist.

**04 — One edge, one verdict.** *Options:* repaired union (branch fix 1); parent as sole
judge; consumer's project as sole judge + composed family run (all three); pins-only.
*Convergence:* one judge per edge, composition never re-judges, live disagreement is explicit.
*Direction:* `validateProject` / `validateFamily` as in §5; owner verdict lock-defined;
composition findings added when a producer is reachable (D1); code conformance per owner, with
cross-mount import edges judged by the *importer* in the family run and reported as
`CROSS_PROJECT_IMPORT_UNJUDGED` (notice) standalone. *Confidence: high.* *Changes my mind:*
nothing on the invariant; on the default-on composition finding at the child, a team that
genuinely wants a detached-identical result locally can turn it off per project.

**05 — Contracts and pins.** *Options:* per-producer snapshot with a content digest (Fable);
per-imported-interface lock (Sol, Astra); versioned contracts overlay; no pins. *Convergence:*
a lockfile per consumer, digests per producer/contract, `used` granularity, undeclared = error,
unused = notice, family surface retired, one mechanism for family peers, foreign imports and
hosted relations. *Direction:* `externals.lock.yaml` with per-producer snapshot digest and a
`used` map; freshness computed per used entry; semantic compatibility (D1); `externals pin |
status | prune`; `doctor --fix` converts today's `.wai/surfaces/` pins keyed by producing
project id. *Confidence: high.* *Changes my mind:* the compatibility codec proving hard for
non-REST transports — then fall back to per-used-entry digest equality (Fable) for those, which
fails closed.

**06 — The child's own root.** *Options:* flatten; opaque delegate (today); member by
reference with briefs composed at the member's root (all three). *Convergence:* federate the
read models, keep writes local; no cascade. *Direction:* member node listing agent ids resolved
live; `sdd_get_agent_brief('billing::x')` composes at the member's root; status per member from
the member's root; `lock` never enters a member; `generate --family` explicit. *Confidence:
high.* *Changes my mind:* nothing found.

**07 — Approval.** *Options:* transitive lock; rolled-up digests; per root + pins + policy
(Fable); project + composition approval hashes (Sol, Astra). *Convergence:* per project, never
written by the parent, composition as an explicit claim. *Direction:* D5 — pin composition
subjects; record externals and policy digests on the lock; `requireApprovedMembers`; status
prints the pin tree. Astra's "preflight at settled strictness" already exists (`lock` gates on
`validateAsComplete`, `src/commands/lock.ts:26-30`). *Confidence: high.* *Changes my mind:* a
requirement that a platform lead can approve a member *from the parent* — then it is a
member-bound operation under the member's permission (Sol), never a parent lock side effect.

**08 — Repository layouts.** *Options:* submodule-only; lift containment for members (Sol);
contain = inside, consume = anywhere (Fable); explicit workspace binding for side-by-side
members (Astra). *Convergence:* location is not identity; approval and commit pins distinct;
hosted backup must cover every `.wai` in the family. *Direction:* D6; hosted `commitProject
--family` stages every member `.wai/` in the same repository until members have their own git
binding (stage 6). *Confidence: medium.* *Changes my mind:* real demand for a member in a
sibling directory *hosted* — then the workspace descriptor must be a registered record, which
is stage 6's data model anyway.

**09 — Hosted.** *Options:* keep scopes and finish the UI; members as records (all three);
relation-only families. *Convergence:* members are records; confinement is a property of the
binding; audit names the member. *Direction:* Fable's two stages with Astra's explicit grants
(D10); the in-band announcement (`sdd_get_status → family`) in stage 1, because the current
announcement is still written to the server's startup channel (`src/mcp/server.ts:1660-1681`)
of a per-request server. *Confidence: high on staging, medium on the grant model.* *Changes my
mind:* the RBAC probe (P4) showing that a project → member rung breaks a "no" override at a unit
— then members are placed in units like any project and family reach is *only* a grant.

**10 — Migrations.** *Options:* per-parent rewrites (today); family-wide dry-run-first,
refuse when incomplete (Fable); plan/apply with per-owner patches, pending when owners are
unavailable (Sol, Astra). *Convergence:* plan first; move is free; rename is an id change;
detach/adopt are relation edits; internalize any number of subsystems; nested subjects
addressed by id. *Direction:* Fable's table with Sol/Astra's plan output (`--report` writes the
per-owner patch set; unavailable owners listed; no partial success claimed); Sol's expiring
`legacyReferences` only if the corpus probe shows staged public migrations are needed.
*Confidence: high.* *Changes my mind:* R4 being read to forbid even named migrations from
writing into members (decision Q8) — then migrations degrade to "rewrite the parent, emit
patches", which is Sol's cross-repository mode applied everywhere.

## 5. Recommended model

The full statement is the proposal
[`projects-and-two-relations.md`](issues/00-the-model/proposals/projects-and-two-relations.md);
this is the page.

**A project is the unit.** `.wai/project.yaml` declares an immutable slug `id` (display
`name` unchanged), its configuration, its adopted policies, its `members` (contains) and its
`externals` (consumes). A subsystem is a level *inside* a project. A mount is a `members`
entry: `{ project: <id>, path: <contained path> }`, alias = id by default. No L1 content on a
mount; no merge; a flat child's subsystem is simply `<id>::<subsystem>` from the parent.

**References name projects.** `x` is mine; `<alias>::x` is a member below me, a declared
external, or — inside a family — my parent or a sibling by the parent's alias. Two segments,
today's id characters. The loader has no root anchor, no `super`, no leading `::`; old forms
load with a notice for one release and `doctor --fix` rewrites them. Save strips only the
file's own prefix, so authored text round-trips.

**One judge per edge; composition is explicit.** `validateProject(P)` is a pure function of
P's files, config plus adopted policies, approval record and externals lock. A reachable
producer *adds* scoped composition findings (`EXTERNAL_INCOMPATIBLE` error when a used entry
no longer holds; `EXTERNAL_PIN_STALE` notice otherwise). `validateFamily(top)` is the union of
member runs plus `MEMBER_NOT_FOUND`, `PROJECT_ID_COLLISION`, `POLICY_NOT_ADOPTED`,
`MEMBER_UNAPPROVED`, `MEMBER_DRIFTED`. `resolveThroughParent`, the resolution-failure family,
`surfaceResolved` and the mount-pool lookup are deleted.

**Governance by adoption.** Pinned policy profiles adopted by the child, required by the
parent, scaffolded at creation; an adopted profile is a floor the child may only tighten.

**Approval per project, transitive by hashing.** The lock records own spec digests, pinned
external and policy digests, and each direct member's composition subject.
`requireApprovedMembers` makes the parent's lock refuse on an unapproved or drifted member. A
parent lock writes nothing below itself.

**Derived outputs by reference.** The parent's topology lists member agents by id; briefs
compose at the member's root; status per member from the member's root.

**Hosting in two stages.** Stage 1: confinement as a binding property (tools declare
`scope: tree | record`, undeclared refused) and an in-band announcement. Stage 2: members as
project records with `parentProjectId`, explicit family grants recorded at migration, their
own permissions, audit, git binding, approval page and UI crumb; a hosted relation is an
external with `source: hosted`; relation health = `externals status`.

**Layouts.** Members contained (monorepo, submodule); side-by-side consumption via
`externals` with `path:`; a side-by-side *member* only through an explicit local workspace
descriptor, later.

**Migrations.** Family-wide, plan-first, refuse when a project to rewrite is absent
(`--report` lists it): `create`, `externalize`, `internalize` (all subsystems), `move` (free),
`rename` (id change), `detach`, `adopt`.

**Worked example.** Platform `members: {billing, shipping}`; Billing `members: {payments}`
and a subsystem `billing` publishing `invoice_portal`; Payments a leaf; Shipping
`externals: {billing: {}, platform: {}}` and `dispatch_adapter` (Adapter) with
`dependsOn: [billing::invoice_portal]`, call step `billing::invoice_portal.createInvoice` —
the same string from every root. Judged: from Shipping alone, clean against the lock; from
Shipping with the family on disk, the same owner findings plus `EXTERNAL_INCOMPATIBLE` if
Billing's live portal lost the used method; from Platform, Shipping's run verbatim under
`shipping::` plus family checks; from Billing, nothing about Shipping (the family run and hosted
relation health list the inbound consumer). Approvals: Payments its specs; Billing its specs +
`members.payments`; Shipping its specs + `externals.billing: 9c1…`; Platform its specs +
`members.billing/shipping` (composition subjects). When Billing renames `createInvoice`:
Billing re-locks its own gate; Shipping alone still passes (its declared input did not change;
`externals status` says `unreachable`); Shipping with the family reports
`EXTERNAL_INCOMPATIBLE`, the team fixes the call, re-pins (`4d0…`) and re-locks; Platform shows
the same finding until then, and with `requireApprovedMembers` refuses to lock while `billing:
moved, shipping: moved`; hosted relation health turns red with the same message.

**Commitments.** R1 keep (one judge; the only cross-root difference is an explicitly scoped
composition finding) · R2 strengthen · R3 keep (composed) · R4 strengthen (only named
migrations write) · R5 keep (save rewrites nothing) · R6 reframe (a credential names a
project; family reach is a recorded grant) · R7 keep by construction · R8 weaken honestly
(side-by-side *members* need an explicit local workspace) · R9 keep for layout (ids
two-segment) · R10 strengthen · R11 keep.

**The four fixes on the branch.**

| Fix | Kept? | Under the model |
|---|---|---|
| 1 resolve-through-parent softening closed (resolution-failure trigger, stricter-of-both, give-way rule) | yes, until stage 3 | retired when composition replaces `resolveThroughParent`; its tests (`resolve-through-parent.test.ts:530-556`) become the `location-independent` property |
| 2 flat child at every depth (`qualifySubsystemRef`) | yes, until stage 2 | the no-merge loader makes it moot; its tripwire becomes `depth-invariance` |
| 3 `qualifyDeclaredId` (declarations always mount-qualify), `--ci` draft waiver, Specialist matrix | yes | "a declaration never root-anchors" is exactly what the new loader generalises to every reference; the other two are unrelated to chaining |
| 4 reach gate in `resolveChainingParent`, explicit read/write classification, discovery tools refused when narrowed | yes | the foundation of hosting stage 1: the refusal lists collapse into a declared `scope`; the gate stays as defence in depth once members are records |

Still open by design on the branch, and closed by the model: pins outranking the live tree
(D1), parent config governing the family (D4), per-root settledness divergence (each member's
run reads its own lock), the generate cascade (stage 4), git backup scope and web UI child
scope (stage 6), migrations not touching other children (stage 5), `::`/`super::` spelling
and last-segment pin matching (stage 1–2), children as hosted projects (stage 6).

## 6. Migration and staging

Each stage ships alone, leaves every existing tree valid, and is proved by the named
properties (each is a test over the Platform family fixture from both scopes).

| Stage | Changes | For existing trees | Proves it |
|---|---|---|---|
| **0 — the branch** (done) | fixes 1–4 | none | `resolve-through-parent.test.ts`, `chained-subsystem.test.ts`, classification test |
| **1 — identity and declared externals** | `project.yaml id` (default from `name` slugified, reported when ambiguous); `externals` + `externals.lock.yaml` with per-producer digests and `used`; pins matched by `(project, entry)`; `EXTERNAL_UNDECLARED` (notice → error next release); `DEPRECATED_REFERENCE_FORM`; in-band chaining announcement; hosting stage 1 (`scope` per tool) | `doctor --fix` converts `.wai/surfaces/*.yaml` pins into `externals` entries keyed by the producing project id; nothing else changes; verdicts unchanged | `pin-is-a-projection`, `stale-only-when-used-changes`, `no-first-hit`, `confinement-is-total`, `announced` |
| **2 — loader without position** | mounts read from `project.yaml members` (L1 `projectPath` still accepted); no `mergeMountRealizations`, no `rootSubsystems`; `<alias>::x`; `LOCAL_ID_SHADOWS_PROJECT`, `PROJECT_ID_COLLISION`, `DUPLICATE_SPEC_ID`; project node in the canvas | `doctor --fix` at the top: moves the mount declaration, rewrites references family-wide (refuses and lists when a member is absent), moves mount-level L1 fields into the child or stops on conflict; flat children's subsystem ids become `id::sub` (scoped selectors rewritten) | `root-invariance`, `writer-is-inverse` (text equality), `depth-invariance`, `shadowing-reachable`, `mount-carries-no-content` |
| **3 — composed validation** | `validateProject`/`validateFamily`; owner verdict lock-defined; composition findings; policy adoption + `requirePolicies`; per-member approval context; cross-mount imports judged by the importer; `resolveThroughParent` and its codes deleted | behavioural: children that passed only through a lenient parent fail; children whose pin hid a revoked publication get `EXTERNAL_INCOMPATIBLE` with the family on disk; `resolvedThrough` consumers print the composition summary | `one-judge`, `location-independent`, `live-drift-is-explicit`, `no-softening-by-location`, `same-config-both-roots`, `renamed-method-seen-from-parent`, `approval-context-both-roots` |
| **4 — approval and derived outputs** | lock records externals/policy digests and member composition subjects; `requireApprovedMembers`; no cascade (`generate --family` explicit); member node by reference; briefs through the mount; status per member | `children` keeps being read, new records write `members`; teams relying on the cascade run `generate --family` once | `parent-lock-writes-nothing-below`, `pin-chain`, `require-refuses`, `brief-through-mount`, `status-agrees`, `context-proportional` |
| **5 — migrations** | plan/apply; `rename`, `detach`, `adopt`; multi-subsystem `internalize`; nested subjects by id; MCP tools gain `dryRun` | none | `atomic-or-nothing`, `family-consistent`, `move-is-free`, `detach-then-adopt-is-identity`, `externalize-updates-siblings` |
| **6 — hosting stage 2** | member project records with `parentProjectId`; grants recorded at upgrade equal to today's reach; member git binding (own repo or parent repo + pathspec); UI crumb and family canvas; relation health = `externals status`; narrowed tokens rewritten to member ids | registry scan registers every mount; `ApiKeyRecord.projects` entries `platform::billing` → `billing` (documented widening *within* the member only) | `member-is-a-project`, `no-widening`, `audit-names-the-member`, `family-commit-covers-members`, `hosted-and-family-agree` |
| **7 — optional** | local workspace descriptor for side-by-side members; spec fragments; `validate --at-approval` | none | `side-by-side-is-consumption`, `containment-unchanged-for-members` |

Order rationale: 1 and 2 change files but not verdicts; 3 changes verdicts but not files; 4–6
are additive. A release note per stage lists the deliberate behaviour changes (stage 2's
doubled subsystem ids and reference rewrite; stage 3's newly failing children).

## 7. Risks and unknowns — with probes

| # | Risk | Probe / prototype |
|---|---|---|
| P1 | **Migration size is unknown.** This repository's own `.wai` tree has no `projectPath` mount and two `super::` references, so nothing here sizes the reference rewrite; users' trees might lean on bare `core::x` inside children. | Run `doctor --fix --report` (stage 2 dry run) over the maintainer's private and hosted trees; count rewrites per form. Cheap: a script over `dependsOn`/`targetComponent`/`subsystem` fields. |
| P2 | **`billing::billing` leaks into exported artifacts** (share snapshots, OpenAPI operation ids, canvas labels). | Grep the surface/OpenAPI/share fixtures for subsystem ids; decide display collapsing before stage 2. |
| P3 | **Semantic compatibility is weaker than it looks** for non-method surfaces (dispatch tables, auth, basePath, type closure changes). | Implement `satisfies(lockedEntry, liveEntry)` over `SurfaceContractEntry` and run it against `tests/core/surface-*.test.ts` fixtures; anything not comparable fails closed. Half a day. |
| P4 | **Hosted permission change.** A project → member rung or explicit grants could interact with a unit-scoped `no`. | Prototype `parentProjectId` + a grant row behind a flag; run the RBAC matrix; confirm a member's "no" at its unit still wins. |
| P5 | **Composition-finding-by-default at the child** could surprise CI that validates children with the family checked out. | Ship it as a warning first (`--ci` fails on unwaived warnings anyway), promote to error one release later. |
| P6 | **N member contexts cost more than one federated context** (R10). | Time `validate` at the top of a 3-member fixture before/after stage 3. |
| P7 | **Windows paths** in `path:` and any workspace descriptor. | Existing containment tests already cover `..` and absolute paths; extend to drive-letter and UNC forms. |
| P8 | **Users relying on the lock cascade** to regenerate child guides. | Release note + `generate --family`; a one-time `doctor` notice when a member has managed files older than its parent's lock. |
| P9 | **Id uniqueness hosted:** two registered projects whose slugified `name` collide. | Enumerate hosted records' names before stage 1 defaults `id` from `name`. |

## 8. Decisions only the maintainer can make

Consolidated and deduplicated from the three sources' question lists and the lead engineer's
notes. Each: options → recommendation.

1. **Project identity form.** Bare slug (`billing`) / dotted namespace (`acme.billing`) / free
   `name` only (no). → *Slug required, dots allowed; family-unique locally, instance-unique
   hosted; `name` stays display.*
2. **Reference syntax.** `alias::x` / `@alias::x` / `dep:alias/x#m`. → *`alias::x`; the code
   already speaks `::`.*
3. **Alias table.** Mandatory (Sol, Astra) / optional with alias = id (Fable-compatible). →
   *Optional; the `members`/`externals` maps are the table.*
4. **What a member may consume from a sibling.** The sibling's L1 `publicInterfaces` (today;
   Fable) / only L0 exports at audience `project` (the doc comment at
   `src/models/specs.ts:46-50`; Astra). → *L1-published for family members, L0-at-audience for
   externals outside the family; `audience: project` then means "family".*
5. **Composition findings at the child by default when a producer is reachable.** Default on
   (recommended) / only under `--family` or `--against-workspace` (Sol, Astra). → *On, as a
   warning first (P5).*
6. **`--ci` at a parent on an unapproved or drifted member.** Fail by default / report only /
   `requireApprovedMembers` policy. → *`MEMBER_UNAPPROVED`/`MEMBER_DRIFTED` as warnings (so
   `--ci` fails unless waived), `requireApprovedMembers` off for one release.*
7. **Where the mount is declared.** `project.yaml members:` / keep the L1 file. → *Move it;
   accept both for one release.*
8. **May family-wide migrations write into members?** Yes, named and dry-run-first / never
   (patches only). → *Yes; R4's one sanctioned exception, refused when incomplete.*
9. **Governance mechanism.** Implicit inherited floor / adopted pinned profiles required by the
   parent. → *Adopted profiles, scaffolded at creation; `POLICY_NOT_ADOPTED` blocks
   composition, not the member's own gate.*
10. **Approval transitivity.** One-hop content pins (today) / composition subjects / a
    recursive parent lock (no). → *Composition subjects.*
11. **Side-by-side members.** Now via a workspace descriptor / defer, consumption only. →
    *Defer to stage 7.*
12. **`--frozen`.** Wanted / not needed. → *Not needed once the owner verdict is lock-defined.*
13. **Spec fragments** (one project over several directories, Sol). → *Defer; measure demand.*
14. **Hosted family reach.** Automatic parent → member floor / explicit grants. → *Explicit
    grants, recorded at upgrade equal to today's reach.*
15. **Compatibility semantics.** Digest equality per used entry / signature-level superset. →
    *Superset over used methods with signature equality; unknowns fail closed.*
16. **Doubled subsystem id `billing::billing`.** Accept / let the L0 name a primary subsystem
    for display. → *Accept; collapse in the canvas only.*
17. **Should a member need any L0 `publicInterfaces` at all** when only its family consumes
    it? → *No (follows from 4).*
18. **Is the lost commit `116d5f7` still wanted in any form?** → *Its declaration half is on
    the branch (fix 3) and survives; its `mountRealization` half is superseded by "no merge".*

## 9. Claims checked against the code

Confirmed unless marked otherwise. Line numbers are on the branch's working tree.

**The branch's fixes, as described by the lead engineer.**
- Fix 1: only `RESOLUTION_FAILURE_CODES` trigger the walk; the parent-side run judges under
  `stricterSeverities(parent, child)`; a child finding gives way only to an equal-or-stricter
  parent finding on the same code and spec, or to a resolution failure the parent did not
  repeat — `src/core/validation.ts:47-115, 501-530, 577-584`; tests
  `tests/core/resolve-through-parent.test.ts:530-556`.
- Fix 2: `qualifySubsystemRef` maps a bare reference equal to the mount's local name to the
  mount id at any depth — `src/core/specs.ts:144-156`. Note: `mergeMountRealizations`
  (`:401-423`) and the depth-0 `rootSubsystems` anchor (`:789-791`) still exist; the fix
  *extended* the flat merge to every depth rather than removing it. The recommended model
  removes both.
- Fix 3: `qualifyDeclaredId` — declarations always mount-qualify (`specs.ts:110-142`);
  `--ci` waives `DRAFT_SUBSYSTEM_WARNING`/`DRAFT_COMPONENT_WARNING` and draft
  `UNUSED_COMPONENT` only (`src/commands/validate.ts:43-49`), so `CROSS_TREE_REF_UNRESOLVED`
  and any future stale/incompatible warning fail `--ci`; Specialist → Registry/Actor forbidden
  (`src/core/rules/stereotype-deps.ts:209-215`).
- Fix 4: `parentReach` is derived from the credential's project list and handed to the
  binding (`src/server/request.ts:669-676`), the walk never climbs above `topRoot`
  (`validation.ts:556-569`); the landscape discovery tools are in the refused set
  (`request.ts:161-162, 503-507`); classification is explicit with a fail-closed default
  (`request.ts:254-256, 303-305`). Design level only; no further detail here.

**Outside analysts' assumptions.**
- Sol: "current validation applies the loading root's configuration across child specs" —
  confirmed: one `buildRuleContext` per run with the bound root's `rules`/`projectType`
  (`validation.ts:458-476`; `src/commands/validate.ts:54`).
- Sol, assumption 2: "spec ids need only be unique within a project" — confirmed: the loader
  indexes components by bare id (`specs.ts:800-804`), unprefixed by subsystem, so
  `(project, localId)` is a sound identity. **Contradiction of a related premise:** there is no
  duplicate-id check across subsystems inside one project — a second component with the same id
  silently overwrites the path index (hence `DUPLICATE_SPEC_ID` in the proposal).
- Sol, assumption 3: "a surface contains enough detail to check compatibility" — confirmed:
  entries carry `methods` with params and returns plus a transitive type closure
  (`src/core/surfaces.ts:63-110, 141-162`), and `version`/`stability` per entry
  (`src/models/specs.ts:77-78`).
- Sol and Astra: "hosted models only the top root as a project record" — confirmed:
  `HostedProjectRecord { id, rootPath, status, createdAt, unitId? }` (`src/server/types.ts:1034-1042`),
  no parent pointer; narrowing lives on the token as `proj::a::b` (`types.ts:203-211`).
- Sol's `@billing::x` and Astra's `dep:billing/x#m` **contradict the id grammar**:
  `SpecIdSchema` is `/^[a-z0-9-_]+$/` (`src/models/specs.ts:6`), and the loader, the MCP
  schemas, hosted selectors, the canvas and the codec all split on `::`. A sigil grammar would
  be a cross-cutting change; the `::` form is not.
- Sol and Astra: "organizational units group people and policy; relations use the same graph"
  — confirmed: the landscape graph has unit, project and public-interface nodes with
  placement, publishes and relation edges (`src/server/landscape.ts:434-518`);
  `ProjectRelationRecord { sourceProjectId, targetProjectId, kind, sourceAdapter, targetPublicInterface, status }`
  (`types.ts:729-743`) is already the declared shape of an external.
- Astra: "keep the existing nested-path escape restriction" — confirmed
  (`specs.ts:196-222`, `PROJECTPATH_ESCAPE` at load and every write site).
- Astra: "approval preflight judges candidate specs at settled strictness" — **already the
  case**: the lock runner gates on `validateAsComplete` before `runLock`
  (`src/commands/lock.ts:26-30`; `treatAllAsComplete` in the validator).
- Astra: "suppressions name their issuing policy; a parent suppression cannot waive a child's
  finding" — **partly true today**: per-spec `lint.allow` lives on the spec and architecture
  violations are never locally suppressible (`src/models/specs.ts:151-165`); what crossed the
  boundary was project-level `rules.sddRuleSeverity`, which the parent's run applied to the
  whole family and which, on the branch, applies at the stricter of both
  (`validation.ts:100-115`).
- Astra: `LockOptions.recursive` — accepted and never read by the lock
  (`src/commands/lock.ts:38-39`); still true.

**Fable 5.1's own assumptions (an outside analyst to this synthesis, checked the same way).**
- Assumption 1, "`project.yaml name` can be required to be a slug" — **contradicted**:
  `name` is "Human-readable project name", `z.string()` with no constraint
  (`src/models/project.ts:254-255`). A new `id` field is required; Sol and Astra were right to
  add one. Precedent for dot-qualified slugs: `OrganizationUnitRecord.id`
  (`src/server/types.ts:487-499`).
- Assumption 2, "component ids are flat within a project" — confirmed (`specs.ts:800-804`).
- "The hierarchical resolver already walks unit → project; add project → member" —
  **understated**: `ScopeKind = 'instance' | 'unit' | 'project'` (`types.ts:38`); the chain is
  project → placement unit → unit ancestors → instance (`src/server/permission_resolver.ts:73-81`).
  A project → project rung is new work, and the explicit-grant model (D10) avoids it.
- "One-hop approval pins" — confirmed (`src/core/approval.ts:211-222`), with the refinement
  that the pinned StateId is computed over the *recursively* loaded tree (`scanAll` defaults
  `recursive ?? true`, `specs.ts:700-701`; `computeStateId` over `loadTree()`,
  `src/core/statehash.ts:57-72`), so a parent's pin already binds grandchildren's *content* as
  of the child's lock — only the grandchild's *approval* is unbound (D5).
- "The chaining announcement goes nowhere" — still true on the branch: written to the
  server's startup channel of a per-request server (`src/mcp/server.ts:1660-1681`); fix 4 made
  it *answer correctly* for a narrowed credential, not in-band.

**Things no source assumed that matter.**
- This repository does not dogfood chaining: no `projectPath:` mount in `.wai/specs`, two
  `super::` occurrences. Every migration estimate in this folder is untested against a real
  family (probe P1).
- `--ci`'s waiver list is closed (`validate.ts:43-49`): every new warning proposed here fails
  CI unless waived, which is the lever the model relies on.
- Approval digests already carry doctrine (`sha256+doctrine`, `statehash.ts:47-54`), so the
  "approved under this doctrine" half of the composition subject exists today.
