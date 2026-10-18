Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems

# Chained subsystems — an independent analysis

Written with the repository open. Every statement below about current behaviour was
checked against `dev` at v5.1.1-dev.11 (`src/core/specs.ts`, `validation.ts`,
`rules/namespace.ts`, `surfaces.ts`, `approval.ts`, `provision.ts`, `agent_resolver.ts`,
`server/request.ts`, `server/projects.ts`, their tests) and, where a claim mattered to a
recommendation, reproduced with a probe (`scratchpad/probe-fable/probe1.mts`, run with
`npx tsx`). The sections follow the order `prompt.md` asks for, after a corrections
section — two of the corrections change the diagnosis.

Conventions: `Platform / Billing / Payments / Shipping` are the statement's family;
"member" and "external" are the two relationships the model below proposes; file
references are `path:line` on `dev`.

## Corrections to the statement

1. **"A union; no severity is lowered" (§2, issue 04) is false, and R7 is violated today
   in a direction the statement does not list.** `SUBPROJECT_REFERENCE_CODES`
   (`src/core/validation.ts:61-70`) includes `CROSS_SUBSYSTEM_NON_ADAPTER` and
   `INVALID_SUBSYSTEM_REFERENCE`, codes that fire on purely local edges. Any finding in
   that set counts as `uncovered` (`:459`), which (a) triggers the walk to the parent even
   when the child holds no cross-tree reference at all, and (b) drops the child's own
   finding from `kept` (`:478`), leaving whatever the parent's run produced under the
   *parent's* configuration (`:533-544`). Probe: a child with two internal subsystems and
   an Orchestrator depending directly on the other subsystem's Portal, no cross-tree
   reference anywhere; the parent's `project.yaml` sets `CROSS_SUBSYSTEM_NON_ADAPTER`
   to `warning`, then `off`; the child's config is the default (`error`).

   | Run | Verdict |
   |---|---|
   | child, `crossTree: 'off'` (standalone) | `error CROSS_SUBSYSTEM_NON_ADAPTER @k-orch`, valid=false |
   | child, parent on disk, parent says `warning` | `warning …`, valid=true, `resolvedThrough` set |
   | child, parent on disk, parent says `off` | finding gone, valid=true |

   So the same child is *softer* with its parent checked out than cloned alone. Issue 04's
   "the fallback … is triggered only by an unresolved reference" is inaccurate for the
   same reason: it is triggered by a code family, not by resolution failure.

2. **The lost fix `116d5f7` would not close issue 01's depth-two split.** Its
   `qualifyDeclaredId(…, mountRealization=true)` collapses a child *subsystem* declared
   under the mount's own local name to the mount id at any depth, but every member's
   `subsystem:` field still goes through `qualifyId` with the root-subsystem anchor. At
   depth two that yields a subsystem `billing::payments` whose components say
   `subsystem: billing::payments::payments` — a dangling reference instead of a split.
   (Read from `git show 116d5f7 -- src/core/specs.ts`; not executed. The shadowing half
   of the fix is sound.)

3. **A parent lock does more to a child than regenerate agent files.** `runGenerate`
   cascades into every direct mount and calls `ensureProjectInitialized(child.subsystemId)`
   first (`src/commands/generate.ts:105-113`, `src/core/provision.ts:91-121`), which
   writes `project.yaml` and an L0 into a child that lacks them; with the default
   `materializeAgentFiles: false` what it then writes is skills, context and guides, and it
   prunes leftover managed files. The parent can *initialize* a child as a side effect of
   its own approval. The CHANGELOG's "a parent lock writes nothing into its children" is
   wrong for three kinds of file.

4. **`super::` over-climb is clamped silently.** `qualifyId` pops an empty prefix array
   without complaint (`specs.ts:92-99`): `super::super::x` authored at depth one resolves
   to the root's `x` with no finding. Relevant to R11.

5. **Pin matching is first-hit across pools, not only last-segment.** `resolveSurfaceRef`
   returns the first snapshot whose entry `component` or `id` equals the reference's last
   segment (`rules/namespace.ts:48-52`). Two siblings each publishing a `portal` are
   indistinguishable; the sibling stored first wins. A correctness defect independent of
   the spelling problem the statement lists.

6. **"The parent never reads the child's L0" holds for the loader only.** Two write paths
   read it: `saveSubsystemSpec` through a namespaced id sets the mount's `parentSystem`
   from the child's L0 name (`specs.ts:1461-1472`), and `ensureProjectInitialized` reads
   it for the fallback name. Minor, but it means the mount already carries child-derived
   data — a precedent for deriving the whole mount from the child's L0 (issue 01).

7. **Approval pins stop at one hop.** `currentChildPins` pins only direct mounts without
   `::` (`approval.ts:217`), so "the platform is approved" says nothing about Payments —
   not even which approved state of it was pinned. The statement says "each direct child"
   without drawing the consequence.

Everything else I checked held: containment at every write and load site,
`SUBPROJECT_NOT_FOUND` skipping the child, pins outranking the live tree, the
whole-family `stateId` on every pin, the per-tool confinement lists, audit and permission
on the top project, no rename tool, flat-only internalize, the one-level merge and the
depth-two split (reproduced: `kid::extra` as the mount and `kid::extra::extra` as the
content, components with `subsystem: kid::extra::extra`).

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

## 01 — Mount and realization: two specs for one subsystem

**Diagnosis.** Two declarations for one subsystem, reconciled by a naming coincidence
that is implemented *inside reference resolution*: `qualifyId` treats any id whose first
segment is in `rootSubsystems` as absolute (`specs.ts:101-104`), and `rootSubsystems` is
filled only at depth 0 (`:739-741`). That single shortcut is what makes a flat child's
`subsystem: billing` land on the mount id so that `mergeMountRealizations` (`:351-373`)
can collapse the two records. Everything the statement lists follows from it: the merge
works one level deep (no anchor exists at depth ≥ 1 — reproduced: `kid::extra` and
`kid::extra::extra`), the child copy wins wholesale (`{ ...child, projectPath }`), a
mount's `publicInterfaces`/`trustedLinks` bind nothing when the ids differ, and a
child id that collides with a root subsystem cannot be reported as shadowing because it
has already been re-anchored. The root cause is that the mount was allowed to carry
content at all.

**Options.**

| | | |
|---|---|---|
| a | Mount wins: the parent's declaration overrides the child's same-id subsystem | Parent authoritative for a thing the child's team edits; breaks R2 and R5 (the child's own validation disagrees with the family's). |
| b | Child wins, formalised: keep the merge, fix it at every depth (the lost fix plus a matching fix for `subsystem:` fields) | Keeps two files for one record and keeps the root anchor, which is the cause of issue 02's shadowing and absolute-vs-local ambiguity. |
| c | The mount declares only the relationship (`id`, `parentSystem`, `projectPath`); the child owns everything; no merge — a same-named subsystem is just `billing::billing` | One source of truth. Removes the anchor, the depth limit and the flat-child concept. Costs a doubled name in the flat case unless the child picks another subsystem name. |
| d | Split with per-field precedence (`publicInterfaces` from the mount, content from the child) | Two sources again, now with a table to remember. |

**Recommendation: c.**

- Schema: `projectPath` present ⇒ `publicInterfaces`, `trustedLinks`, `lifecycle`,
  `profile`, `designDepth`, `targetLanguage` must be absent (`MOUNT_DECLARES_CONTENT`,
  warning for one release, then error). `name`/`description` on the mount are ignored and
  synthesised from the child's L0 `name`/`vision`; `doctor --fix` deletes them.
- Rule `MOUNT_ID_MISMATCH` (error): mount id ≠ the member's `project.yaml name`.
- Loader: no `mergeMountRealizations`, no `rootSubsystems`. A member's subsystems load as
  `<memberId>::<subsystemId>` at every depth; a member's members as their own project id
  (issue 02). The mount loads as a *project node* (kind `member`) distinct from a
  subsystem; the canvas draws it as a container of the member's subsystems
  (`src/core/diagram.ts` gains a mount node — issue 09's evidence says it has none).
- Boundary rules: unchanged for components (`comp.subsystem` is the real subsystem,
  `billing::billing`). A `trustedLinks[].subsystem` naming a *project id* licenses direct
  edges into any subsystem of that member — the natural reading, and it is what today's
  mount-level `trustedLinks` were trying to say.
- Create: scaffolds `project.yaml` (`name` = mount id, `governance: inherit`) and an L0.
  Nothing else — and nothing else is needed, because the mount is realised by the L0, not
  by a same-id subsystem. A child component written with `subsystem: billing` where no
  subsystem `billing` exists is `INVALID_SUBSYSTEM_REFERENCE` from both roots, instead of
  today's "scored from the parent, invisible from the child".
- Internalize: generalises. Fold every subsystem of the member into the parent
  (collision check first), rewrite `billing::x → x` family-wide (issue 10). The flat-only
  guard (`provision.ts:441-444`) goes.
- Several subsystems per member: yes, always, as `<memberId>::<sub>`. There is no
  "subsystem containing subsystems": there is a *project* containing subsystems, which the
  level model already defines (L0 → L1). The container's own fields are the L0's.

**Migration.** Component ids do not change for flat children — `billing::invoice_portal`
is the same string before and after, because component ids are flat within a project and
the prefix is the project id either way. What changes is the *subsystem* id of those
components (`billing` → `billing::billing`), visible in `--subsystem` scopes, `trustedLinks`
targets and status output; `doctor --fix` rewrites scoped selectors it can find and the
rule above accepts the project id as a trusted-link target so existing `subsystem: billing`
links keep meaning what they meant. Mount content: `doctor --fix` moves
`publicInterfaces`/`trustedLinks` from a mount into the child's same-named subsystem when
that subsystem has none, otherwise reports the conflict and stops. Non-breaking for trees
that validate today; the doubled-name cosmetic is the one visible change.

**Proof.**

- `mount-carries-no-content`: a fixture mount with `publicInterfaces` yields
  `MOUNT_DECLARES_CONTENT`; after `doctor --fix` the child's subsystem carries them and
  the family verdict on every edge is unchanged.
- `depth-invariance`: for a member at depth *d* ∈ {1,2,3} whose subsystem shares its
  project id, `loadSubsystemSpecs()` at the top contains exactly one record per
  subsystem and every component's `subsystem` names an existing record.
- `create-then-author-from-child`: after `createChainedSubsystem`, adding a subsystem and
  a Store at the child makes `status` at the child and at the parent report the same
  completion for it.
- `internalize-multi`: a two-subsystem member internalizes; references in every family
  project that consumed it are rewritten; the family validates with the same edge
  verdicts.

## 02 — Identity and references across roots

**Diagnosis.** There are four id spaces and they are resolved by *position*, not by
identity: `::x` (absolute at the loading root — `qualifyId` strips it, `specs.ts:89-91`),
`super::x` (relative hops, silently clamped at the root — correction 4), bare `a::x`
(anchored at the loading root's top-level subsystems, `:101-104`), and the pin space
(last segment, first hit — correction 5). `relativizeId` (`:131-169`) can make the second
form root-invariant, which is why saves rewrite `::` into `super::`, but a relative path
still encodes the *parent's* naming of its mounts, so a child's files break when the
parent renames a mount, and `super::billing::x` and `::billing::x` are two spellings of
one target with no canonical form. The root cause: references name a place in a tree
rather than a project.

**Options.**

| | | |
|---|---|---|
| a | Keep `super::`; land the lost shadowing fix; add a dedupe on save | Still positional, still couples children to the parent's mount ids, still clamps; the dedupe hides that two spellings exist. |
| b | Make `::` mean "the *file's* project root" (root-invariant) and keep `super::` for ancestors | Fixes the loading-root dependence; still positional for siblings and still couples to mount ids. |
| c | Project-id-anchored references: `x` is mine, `<projectId>::x` is theirs; at most two segments; project ids unique in a family | Root-invariant and position-invariant; renaming a mount becomes renaming a project (issue 10); resolution needs no anchor set. Requires unique project ids and a slug-safe `project.yaml name`. |
| d | Opaque stable ids (UUIDs) with names as labels | Unreadable in YAML and in agent briefs; R11 dies. |

**Recommendation: c.** Grammar, loader and writer:

```
ref      := local | project "::" local
local    := [a-z0-9-_]+            (component, interface, implementation, type, subsystem)
project  := [a-z0-9-_]+            (a member's or external's project id; must be declared:
                                    a mount below me, a declared external, or — for a
                                    member — its parent or a sibling in the family)
```

- Load, when the bound root is `P` and the file belongs to project `Q`: `local` →
  `Q::local` if `Q ≠ P`, else `local`; `project::local` → verbatim. No `rootSubsystems`, no
  `super`, no `::` prefix — those are accepted for one release, resolved relative to the
  *file's* project (`::x` → `x`; `super::x` → `<parent id>::x`; `super::s::x` → `s::x`),
  and reported as `DEPRECATED_REFERENCE_FORM` (notice) until `doctor --fix` rewrites them.
- Save: the exact inverse — strip `Q::` from ids that belong to the file's own project,
  leave `project::local` verbatim. Nothing else is rewritten; authored text round-trips
  byte for byte (R5), because the canonical form is already root-invariant.
- Pins are keyed by project id and matched by `(projectId, entry.id | entry.component)`,
  never by last segment alone (correction 5 closes).
- Collisions:
  - `PROJECT_ID_COLLISION` (error, family run): two members with the same `name`.
  - `LOCAL_ID_SHADOWS_PROJECT` (error): a subsystem id equal to a project id visible from
    this project — the one genuine ambiguity, because subsystem-qualified type
    references (`sub::Type`, `rules/index.ts:413-418`) share the grammar.
  - `NAMESPACE_SHADOWING` retires: with no anchor, a bare id can never escape its
    project, so there is nothing to shadow.
- Three-segment ids disappear: Payments' components are `payments::pay_portal` from every
  root, whether Payments is mounted in Billing or in Platform. Nesting is layout.

Shipping's adapter today and after:

```yaml
dependsOn: [super::billing::invoice_portal]     # today (or ::billing::…, or billing::… when
                                                #  authored at Platform and rewritten on save)
dependsOn: [billing::invoice_portal]            # after — same string from every root
```

**Migration.** Purely mechanical, run by `doctor --fix` at the top root over every member
on disk (this is the one sanctioned write into members — issue 10). Rewrite table, for a
file in member `m` of parent `p`: `super::x` → `p::x`; `super::s::x` → `s::x`;
`::s::x` → `s::x`; `::x` → `p::x` when `x` is not local, else `x`; bare `s::x` where `s`
is a top-level subsystem of `p` that is *internal* → `p::x` (component ids are flat in
`p`); where `s` is a mount → unchanged (already the project id);
`a::b::x` → `b::x` when `b` is a member of `a`. A member that is absent is listed and the
run refuses (`--report` writes the list instead). Hosted selectors `proj::a::b` map to
project ids (issue 09). Old forms load for one release with the notice, so nothing breaks
before the rewrite runs.

**Proof.**

- `root-invariance`: for each project in a family fixture and each reference in it,
  resolution from the project's own root and from every ancestor root yields the same
  target file.
- `writer-is-inverse`: `relativize(qualify(ref)) === ref` for every ref in the fixture
  corpus, from every root (extends the existing ROUNDTRIP dry-run to *text* equality).
- `one-spelling`: the loader emits `DEPRECATED_REFERENCE_FORM` for every non-canonical
  spelling in the corpus and none after `doctor --fix`; `doctor --fix` is idempotent.
- `no-clamp`: a reference to a project id not visible from this project is
  `EXTERNAL_UNDECLARED`, an error, from every root.
- `shadowing-reachable`: a member subsystem named like a family project id trips
  `LOCAL_ID_SHADOWS_PROJECT` from disk (the fixture `references-namespace.fixtures.ts:99-153`
  becomes live; `ratchet.json` shrinks).
- `mount-rename-does-not-touch-children`: renaming a mount directory (move) changes no
  member file; renaming a *project id* is a family migration (issue 10) and rewrites
  exactly the references that named it.

## 03 — Governance: whose rules judge a child's specs

**Diagnosis.** `buildRuleContext` takes one `projectType`, one `rules` and one loaded
extension set for the whole run (`validation.ts:413-431`), chosen by whoever is bound
(`commands/validate.ts:117-122`; `resolveThroughParent` loads the *top* root's config,
`validation.ts:533-537`). Governance is attached to the run instead of to the spec's
owning project. That is why a child's config is ignored from the parent, an intermediate
parent's is ignored from the top, and — correction 1 — a child with its parent on disk is
judged under the parent's config even for purely local edges.

**Options.**

| | | |
|---|---|---|
| Isolation | each project judges its own specs under its own config, full stop | Simplest; a platform cannot impose doctrine on parts it owns. |
| Inheritance as a floor | a member's effective config = parent's effective config ⊔ own, where own may only tighten; `governance: own` opts out and is reported | Expresses both "part" (inherit) and "independent" (own) without a kind flag; disagreement is a finding, not a silent pick. **Recommended.** |
| Override | the parent's config governs the family | What the parent's run does today; kills R2 and R7 and makes a team's deliberate config a no-op depending on where validation ran. |

**Recommendation.** A pure function `effectiveConfig(projectRoot)`:

```
own       = project.yaml at projectRoot
if own.governance == 'own' or no mounting parent: return own
parent    = effectiveConfig(mounting parent root)          # recursive: Payments inherits Billing's
                                                            # effective config, which inherited Platform's
projectType = own.projectType declared ? own : parent      # Track D2, already approved
packs     = parent.packs ∪ own.packs                        # a pack the child adds applies to the child
severity[c] = max(parent.severity[c], own.severity[c])      # error > warning > off; own may only tighten
designDepth, limits: own if declared else parent
```

- Every rule context is built per project, from `effectiveConfig(that project's root)`.
  The family run builds one context per member (issue 04 explains why that is cheaper,
  not dearer, than today's single context).
- `GOVERNANCE_DIVERGENCE @<member>` (warning, raised in the family run at the parent):
  the member declares `own` and its effective severity for some code is below the
  parent's floor. Lists the codes. Never softens the parent's verdict on *its own* edges;
  never hardens the member's.
- `GOVERNANCE_LOOSENS @<project>` (error): an `inherit` project whose `sddRuleSeverity`
  lowers a code below the floor — the config is invalid, not silently clipped.
- Standalone child with no parent on disk: the floor comes from
  `.wai/externals.lock.yaml`, which `wairon externals pin` writes alongside the surface
  digests (issue 05): the parent's effective config as of the pin. A detached clone then
  validates under the same doctrine as the family, and a floor that moved since the pin
  is `EXTERNAL_PIN_STALE` like any other input.
- Pack doctrine the child applies and the parent does not: applies to the child (it is
  the child's own tightening); the family run loads the child's packs for the child's
  context. The reverse (parent pack, child lacks it) is the floor and applies to the child
  under `inherit`; under `own` it is reported as divergence.
- Showing it: `wairon status` prints `governance: inherit (floor: platform)` or
  `governance: own — diverges from platform on: CROSS_SUBSYSTEM_NON_ADAPTER (warning < error)`.

**Migration.** Existing members have no `governance` key; default `inherit`. Members whose
own config already loosens a code relative to the parent will start failing
`GOVERNANCE_LOOSENS` — a deliberate, listed behaviour change (the statement's issue-03
probe becomes an error at the child instead of a disagreement). `doctor` reports these
before the switch flips; a team that wants the loosening declares `governance: own` and
accepts the divergence warning at the parent.

**Proof.**

- `same-config-both-roots`: for every member in a family fixture, the config the family
  run uses for that member's context deep-equals `effectiveConfig(member root)`.
- `tighten-only`: an `inherit` member setting a code to `off` under a parent `error` floor
  fails with `GOVERNANCE_LOOSENS`; setting `error` under a `warning` floor validates and
  the family run reports that code as `error` for that member.
- `divergence-is-visible`: the issue-03 probe (child `off`, parent `error`) with
  `governance: own` yields no finding at the child and `GOVERNANCE_DIVERGENCE` at the
  parent; with `inherit` it yields `GOVERNANCE_LOOSENS` at both.
- `no-softening-by-location` (the correction-1 probe as a test): a child-internal
  `CROSS_SUBSYSTEM_NON_ADAPTER` is an error from the child root with and without the
  parent on disk, whatever the parent's `sddRuleSeverity` says.
- `detached-floor`: a child validated with its parent removed from disk, holding a pin
  taken under the parent's floor, reports the same governance findings as with the parent
  present.

## 04 — One edge, one verdict: composing judgements across roots

**Diagnosis.** Two judges with different inputs, and a merge that filters by code family.
The child's run sees its own config, its own approval and its pins; the parent's run
sees the parent's config, no child approval and the child's pins only through the
mount-pool lookup. `validateSddTree` then keeps the child's findings *except* an entire
code family (`:459, :478`) and unions in the parent's — which is how a stale pin outranks
a live parent (a pin hit is `surfaceResolved`, so no walk), how a purely local error is
softened (correction 1), and why the walk covers references only (it is gated on a code
family, and nothing else triggers it). The root cause is that a verdict is a function of
the loading root and of what happens to be on disk, instead of a function of *(this
project's specs, its declared inputs, its effective configuration)*.

**Options.**

| | | |
|---|---|---|
| a | Union of two judges (today), with the code-family filter repaired | Still two judges with different inputs; every future rule must decide which family it is in. |
| b | The parent is the sole judge whenever it is reachable | Kills R2 (a child's verdict changes when someone checks out the parent) and R10 (every child validate loads the family). |
| c | The *consumer's project* is the sole judge of its edges; the family run is a composition of member runs plus family-level checks | One judge per edge, by construction the same from every root; per-member config and approval fall out; cheaper than the single federated context. **Recommended.** |
| d | Verdicts against pins only, never live (pure lockfile) | Deterministic, but a revoked publication hides until someone re-pins — the stale-pin probe becomes the design. Offered as an explicit mode (`--frozen`), not the default. |

**Recommendation: c.** The algorithm, as `validate` would run it:

```
validateProject(root, opts):
  cfg      = effectiveConfig(root)                                   # issue 03
  tree     = load(root)                                              # this project only
  inputs   = for each declared external / family peer E referenced by tree:
               live(E) if reachable(E) else pin(E)                   # issue 05
             where reachable = E's root on disk inside this family, or hosted+authorized
  issues   = rules(tree, cfg, inputs, approval(root))                # one context, this project
  for each E where live(E) and pin(E) both exist and digest differ:
             issues += EXTERNAL_PIN_STALE @E (warning; --ci fails on it; --frozen ignores live)
  return issues

validateFamily(topRoot):                                             # what `validate` at a parent does
  results  = { P: validateProject(root(P)) for P in self ∪ members (recursively) }
  family   = PROJECT_ID_COLLISION, MOUNT_ID_MISMATCH, MOUNT_DECLARES_CONTENT,
             GOVERNANCE_DIVERGENCE, MEMBER_NOT_FOUND, inbound-consumer report
  return   prefix(results) ∪ family
```

- Every edge is judged exactly once, by the project that authored it, under that
  project's effective config, against the producer's surface. The family run *calls* the
  same function; it does not re-derive anything. `resolvedThrough`, `surfaceResolved`,
  `SUBPROJECT_REFERENCE_CODES`, `isCollapsedCrossTreeRef` and the mount-pool lookup
  (`namespace.ts:39-47`, `surfaces.ts:408-418`) are deleted.
- Evidence ranks: live when reachable, pin when not, and when both exist and differ the
  difference is a finding. A pin therefore never *outranks* the live tree; it stands in
  for it.
- Approval context: each member's run reads its own `lock.json`
  (`settledStatusBearing` is already per root, `validation.ts:604-637`), so a settled
  child spec is judged at full strictness from the parent too. The parent additionally
  sees whether the member is approved at all (issue 07).
- Code: each project judges its own code against its own specs (unchanged in spirit,
  `rules/conformance.ts:39-48`, now by construction rather than by skip). Import edges
  that cross a mount are judged by the *importer's* project in the family run, which has
  both projects' L4 `sourcePath` maps to resolve a file to `billing::<component>`;
  standalone, an import into a path that belongs to a member or a parent is
  `CROSS_PROJECT_IMPORT_UNJUDGED` (notice) — honest, never an error for a clone that
  cannot see the other project's L4.
- Modes: `--ci` as today (unwaived warnings fail, so a stale pin fails); `--frozen`: use
  pins only and do not read live producers (a detached CI that wants determinism; a live
  producer that *is* on disk is then reported as unread, not consulted); `--locked` is
  unnecessary because `--ci` already fails on `EXTERNAL_PIN_STALE`.

Cost (R10): a child run loads the child plus the *surfaces* of what it consumes (from
pins, or projected from one sibling's tree when live) — never the family. The family run
loads each member once and builds N small contexts instead of one large one; the rule
loop is the same total size.

**Migration.** No file changes. Behavioural: children that pass today only because the
parent's run was lenient (correction 1) will fail; children whose pins hide a revoked
publication will get `EXTERNAL_PIN_STALE` as soon as they validate with the parent on
disk — both are the point. `resolvedThrough` consumers (`commands/validate.ts:123-128`,
the hosted result shape) print the composition summary instead ("judged as member of
platform; 2 externals live, 0 pinned").

**Proof.**

- `one-judge` (R1 as a test): for every family fixture, every project *P* and every edge
  *e* authored in *P*: `verdict(e | validateProject(P))` equals
  `verdict(e | validateFamily(top))` restricted to *P*, modulo id prefix.
- `location-independent` (R7): `validateProject(P)` with the parent on disk equals
  `validateProject(P)` with the parent absent, when every pin is fresh; when a pin is
  stale, the only additional finding is `EXTERNAL_PIN_STALE`.
- `live-over-pin`: the statement's stale-pin probe (parent unpublishes after the child
  pinned) yields `SURFACE_REF_NOT_EXPOSED` *and* `EXTERNAL_PIN_STALE` at the child with
  the parent on disk, and the same `SURFACE_REF_NOT_EXPOSED` at the parent.
- `renamed-method-seen-from-parent`: the statement's rename probe yields
  `SURFACE_REF_NOT_EXPOSED @shipping::dispatch_adapter-impl` from Platform.
- `approval-context-both-roots`: the statement's approval probe (child impl missing a
  method, approved at the child) is an error from both roots.
- `frozen-is-honest`: `--frozen` with a stale pin and the parent on disk passes and
  reports "1 live producer not consulted".

## 05 — Contracts across the boundary: pins and freshness

**Diagnosis.** Pins began as *delivery* (the parent pushed family snapshots on lock,
`surfaces.ts:536-544` tells the history) and became *inputs* without becoming *declared*
inputs. So they are a cache: unaddressed by references (nothing maps a reference to the
pin it needs, so unused pins and undeclared references are both invisible), keyed for
freshness by the whole family's `stateId` (`surfaces.ts:168, 286` via `stateIdString()`
inside the parent binding; `statehash.ts:57-72`), and consulted before the live tree
(issue 04). The hosted plane already has the declared form — `ProjectRelationRecord`
names a source Adapter, a target project and a target public interface
(`server/types.ts:729-743`) — and knows nothing of pins.

**Options.**

| | | |
|---|---|---|
| a | Snapshot per producer, keyed by project id, with a content digest of *that surface* | Freshness moves only when the consumed surface changes. Base of the recommendation. |
| b | Consumer contract (Pact-style): pin only the entries and methods this project uses; per-entry digests | Staleness names the method that changed; an unused entry cannot stale you. Recommended as the *granularity* of (a), not a separate artifact. |
| c | Versioned contracts (semver on L0 entries; `version`/`stability` already exist) | An overlay for externals that publish releases; not required for members, whose "version" is the approval pin. |
| d | No pins while the parent can load the child | Rejected: R2 needs a detached child to validate against something, and issue 04 needs an explicit drift signal. |

**Recommendation.** One lockfile per project, written by the consumer:

```yaml
# services/shipping/.wai/project.yaml
name: shipping
governance: inherit
externals:
  billing: {}                    # a family sibling: source implied (member of my parent)
  platform: {}                   # my parent
  crm:
    source: { hosted: https://wairon.example/, project: crm }

# services/shipping/.wai/externals.lock.yaml   (written by `wairon externals pin`, committed)
pinnedAt: 2026-09-12T10:00:00Z
governance:                      # the inherited floor as of the pin (issue 03)
  from: platform
  digest: sha256:…               # of platform's effective config
externals:
  billing:
    surface: .wai/externals/billing.yaml       # the snapshot body (today's sibling surface, keyed by project id)
    digest: sha256:9c1…                        # of the snapshot content, provenance stripped
    used:                                      # what this project actually references
      invoice_portal: { createInvoice: sha256:4a…, getInvoice: sha256:77… }
  platform:
    surface: .wai/externals/platform.yaml
    digest: sha256:e02…
    used: { core_portal: { lookup: sha256:… } }
```

- `wairon externals pin [id…]` (replaces `surface pin`): for each declared external,
  project its surface — a family peer's L1-published cross-boundary targets, an
  outsider's L0 exports at my audience distance — from the live source, write the
  snapshot, record digests. `wairon externals status` (replaces `surface externals`):
  per external, `fresh | stale (invoice_portal.createInvoice removed, issueInvoice
  added) | unreachable`, plus `unused` pins and `undeclared` references.
  `wairon externals prune` removes unused pins.
- Validator codes: `EXTERNAL_UNDECLARED` (error — `x::y` where `x` is neither a member
  below me, a family peer, nor a declared external), `EXTERNAL_UNRESOLVED` (error — no
  pin and no reachable live source; replaces the `CROSS_TREE_REF_UNRESOLVED` warning,
  which `--ci` could not waive anyway), `EXTERNAL_PIN_STALE` (warning, computed per used
  entry so an unrelated change in the producer does not fire it), `EXTERNAL_PIN_UNUSED`
  (notice). Freshness fails a gate exactly when a *used* entry changed and `--ci` is on.
- The family surface disappears as a kind: the parent is just the external `platform`
  whose surface, for a member, is L1-based. Foreign imports (`origin: exchanged|authored`)
  are externals with `source: { file: … }` — same store, same lock, same codes.
- Hosted: a relation record *is* an externals entry with `source: hosted`; relation
  health compares the same digests. The hosted server can serve `externals pin` for a
  hosted consumer (it already serves surfaces), so families and cross-project consumption
  are one mechanism at last.

**Migration.** `doctor --fix` converts existing generated snapshots
(`.wai/surfaces/<System>.yaml` and `<System>--<sub>.yaml`) into `externals` entries keyed
by the producing *project id* (the family surface → the parent's id; a sibling surface →
the sibling's id, read from its `project.yaml` when on disk, else from the mount id), moves
the bodies to `.wai/externals/`, and writes the lock with content digests; the stale
whole-family `stateId` is dropped. Old snapshots keep loading for one release.
`sdd_list_external_interfaces` keeps its shape (`projectName`, `freshness`) and gains
`used`/`unused`.

**Proof.**

- `stale-only-when-used-changes`: editing a sibling's *unpublished* component, or a
  published method the consumer does not call, leaves every pin `fresh`; renaming a
  called method makes exactly that external `stale` and names the method.
- `undeclared-is-an-error-everywhere`: a `crm::x` reference with no `externals.crm`
  yields `EXTERNAL_UNDECLARED` from the child root and from the family run.
- `pin-is-a-projection`: for a family on disk, `externals pin` at a member produces a
  snapshot whose content digest equals the digest the family run computes for the same
  producer surface — so `live-over-pin` (issue 04) can never fire on a fresh pin.
- `hosted-and-family-agree`: the same consumer, once as a hosted relation and once as a
  family member, records the same digest for the same producer state.
- `no-push`: no operation at a parent writes under a member's `.wai/externals/`.

## 06 — Working from the child's own root: status, topology, briefs

**Diagnosis.** Derived outputs are computed from the bound root's federated tree with
local-id filters (`agent_resolver.ts:244-246`), the parent's topology is *deliberately*
opaque about members (`:285-305`), `create` leaves a child with no subsystem (issue 01),
and `lock` cascades `ensureProjectInitialized` + `generate` into every member
(correction 3). Two root causes: a member is not a first-class node in any derived output,
and R4 was applied to surfaces but not to derived files.

**Options.**

| | | |
|---|---|---|
| a | Flatten: the parent's topology enumerates every member's agents and writes them into the parent's `.claude/agents` | Context proportional to the deep tree (the reason the layered topology exists); a member's agents then exist twice. |
| b | Opaque delegate (today) | The parent cannot delegate into a member without a human switching directories. |
| c | Member node *by reference*: the parent's topology lists the member's agents by id and composes any of their briefs at the member's root on request; nothing is materialised at the parent | R4 holds, context stays proportional, delegation crosses the mount. **Recommended.** |

**Recommendation.**

- Topology at Platform: `system-architect`, `core-owner`, and a `billing` member node whose
  record lists `agents: [billing::billing-owner, billing::payments (member)]` — ids only,
  resolved live. `sdd_get_agent_brief('billing::billing-owner')` and
  `wairon-agent://billing::billing-owner` resolve `billing` to its root and compose the
  brief *there*, with the member's own topology, config and skills
  (`composeAgentBrief` gains a root-resolution step; nothing is written). An
  orchestrating agent at Platform delegates into a member by fetching that brief and
  spawning the subagent with the member's root as its working directory — the
  `sdd-delegate` skill needs one sentence added.
- Status at Platform: own subsystems as today, then one line per member computed at the
  member's root — completion, approval (`approved | drifted (3 specs) | never`), pin state
  (`pinned at …`, `moved`), governance (`inherit | own (diverges)`), and the member's own
  members indented. Status at Billing: own subsystems, `member of platform (mounted as
  billing)`, and its externals with freshness. Nothing from the parent's tree beyond the
  mount id appears at the child.
- Writes: `lock` and `generate` at a parent never enter a member — no
  `ensureProjectInitialized`, no skills/context/guides, no pruning. `wairon generate
  --family` is an explicit opt-in that runs `generate` at each member root exactly as a
  person would there, and says so per member. `create` is the only operation that
  provisions a child, and it provisions `project.yaml` + L0 only.
- The child's root shows work for what the parent scores because, with issue 01, there is
  nothing the parent can score that the child's own root cannot see: a component belongs
  to a subsystem the child declares, or it is an error at both roots.

**Migration.** Behavioural only. Teams that relied on a parent `lock` to regenerate
members' guides run `wairon generate --family` once. The `-owner` delegate record keeps
its id; it gains the `agents` list.

**Proof.**

- `brief-through-mount`: `sdd_get_agent_brief('billing::billing-owner')` at Platform
  deep-equals `sdd_get_agent_brief('billing-owner')` at Billing, except for the id prefix.
- `status-agrees`: for each member and each subsystem in it, completion reported at the
  parent equals completion reported at the member.
- `parent-lock-writes-nothing-below` (R4): snapshot every file under each member before
  `wairon lock --yes` at the parent; byte-identical after, including a member that has
  no `project.yaml` (it stays uninitialised).
- `context-proportional`: the number of agent records at the parent is independent of the
  number of components inside members.

## 07 — Approval across a family

**Diagnosis.** The per-root approval with child pins (`approval.ts:88-100, 211-222`) is
the right shape — it is a submodule pin — and the defects are around it: the parent cannot
*see* a child's approval when judging (issue 04's single context), pins are one hop deep
(correction 7), nothing lets a parent *require* approved members, and the parent's own
approval says nothing about the external contracts the family was approved against.

**Options.**

| | | |
|---|---|---|
| Transitive lock | a parent lock locks every member | Breaks R4 and R2: a platform lead freezes a service team's in-flight work, and a child cloned alone carries an approval it did not make. |
| Rolled-up | a parent's record digests every member's specs | Every child edit dirties the parent; the parent's diff stops being a review signal (the reason `currentSpecDigests` excludes mounts). |
| Per root + pins + policy | keep the pin model; make the parent see it, chain it, and let the parent require it | Keeps every commitment; two small additions. **Recommended.** |

**Recommendation.**

```yaml
# platform/.wai/project.yaml
lock:
  requireApprovedMembers: true      # default false: pin what is approved, report the rest
```

```json
// platform/.wai/lock.json — the parent's approval
{ "specs": { ".wai/specs/core/…": "sha256…" },
  "members": { "billing": "sha256+doctrine:…", "shipping": "sha256+doctrine:…" },
  "externals": { "crm": "sha256:…" } }
// services/shipping/.wai/lock.json — a member's approval
{ "specs": { … }, "externals": { "billing": "sha256:9c1…", "platform": "sha256:e02…" } }
```

- **What each approval promises.** A project's lock: "these specs, judged under this
  doctrine (`sha256+doctrine`), against these external contracts, passed the gate and a
  human said yes." A parent's lock additionally: "at the time, each direct member's
  approval was at this state." Payments is reached through Billing's pin of it — the chain
  of pins is the transitive statement, exactly as nested submodules work, and it is
  inspectable: `wairon status --family` prints the pin tree with `approved | moved |
  never` per node.
- **Requiring approval.** With `requireApprovedMembers`, `wairon lock` at the parent
  refuses when any direct member is unapproved or has moved from its own approval
  (`MEMBER_UNAPPROVED @billing`, `MEMBER_DRIFTED @shipping`); without it, the lock pins
  what exists and prints the same two facts as information. Never does it lock a member.
- **Seeing it while judging.** Falls out of issue 04: the member's run reads the member's
  `lock.json`, so a settled member spec is judged at full strictness from every root; the
  parent's family run adds `MEMBER_UNAPPROVED` (notice) for members without any approval,
  so "the platform validates" no longer treats its parts as drafts by accident.
- **Who may approve.** The project's own permission (`project:write` on that project —
  hosted, that is the member project's record, issue 09). A platform lead approves a member
  by locking *that* project, never through the parent's lock. Locally, whoever runs `lock`
  at that root.
- **Externals in the approval.** `lock` records the digests of every pinned external; a
  re-pin that changes a *used* digest makes the approval drifted (`status`: "approved
  against billing@9c1…, pinned now 4d0…"), which is the review signal the family needs when
  a producer changes its contract.

**Migration.** `children` keeps being read; new records write `members` (same content).
`externals` is absent on old records, which reads as "approved against unknown contracts"
and `status` says so. `requireApprovedMembers` defaults off, so no lock that succeeds
today starts failing.

**Proof.**

- `parent-lock-never-writes-member-lock`: after `lock --yes` at the parent, no member's
  `lock.json` changed (exists or not).
- `require-refuses`: with `requireApprovedMembers`, a moved member refuses the parent's
  lock naming it; without it, the lock succeeds and the record pins the member's *approved*
  state, not its current one.
- `settled-from-both-roots`: a member spec approved and unchanged is judged at full
  strictness by the family run (the statement's approval probe becomes an error at the
  parent).
- `pin-chain`: Payments approved → Billing locks (pins Payments) → Platform locks (pins
  Billing); editing Payments then makes `status --family` at Platform show `payments:
  moved` under `billing: approved`.
- `externals-in-approval`: re-pinning a changed used method marks the consumer's approval
  drifted without any spec edit.

## 08 — Repository layouts and version control

**Diagnosis.** Containment (`projectPathEscapesRoot`, applied at every write and at load,
`specs.ts:196-222, 908-916`) is a *tenant-isolation* invariant for the hosted plane
("Fix B2"), and it was applied to the only relationship that existed, so the layout the
statement calls weakest — a part in another repository — has to be expressed as
containment even when it is really consumption. Git backing scopes `.wai/` at the bound
root (`git/orchestrator.ts:19`, `server/admin.ts:414-440`), so a member's `.wai/` is in the
working tree but never in the pathspec; tree archives walk every root
(`treetransfer.ts:218-253`). Approval pins and commit pins are unrelated because nothing
asked what a commit has to do with a design decision.

**Options.**

| | | |
|---|---|---|
| a | Lift containment locally: allow `projectPath: ../billing` for members | Makes a family span repositories by *containment*; the parent's clone is then incomplete by design, archives cannot carry it, and hosted must refuse it anyway — two behaviours for one field. |
| b | Contain = inside; consume = anywhere: members stay inside the parent's directory; a project elsewhere is an external with a local `path:` source | One rule for the field, the same locally and hosted; side-by-side repositories get live resolution and pins. **Recommended.** |
| c | Package-manager style: members fetched from a registry into `.wai/members/` | Reinvents (b) with a registry; not needed while git exists. |

**Recommendation: b.**

| Layout | Relationship | What works |
|---|---|---|
| Monorepo, `services/billing/` | member | Everything: live family run, pins optional, one repo. |
| Git submodule at `services/billing/` | member | Family run when the submodule is checked out; `MEMBER_NOT_FOUND` (error) when not — the parent's CI must init submodules, as with any path dependency. The parent's approval pins the member's approved StateId; `status` also prints the submodule's commit and whether the pinned approval exists at that commit (`git -C services/billing cat-file` on `.wai/lock.json`). |
| Separate repositories side by side, `../billing` | external with `source: { path: ../billing }` | Live surface when the sibling checkout exists (any directory — no containment for consumption), pin otherwise. Not a member: Platform does not validate Billing's internals; Billing is a system Platform consumes. |
| Hosted | member (inside the parent's root) or external (`source: hosted`) | Issue 09. |

- Approval pins and VCS pins stay two things — a design decision versus a file state —
  but the record carries both when it can: `members.billing: { approval: "sha256+doctrine:…",
  commit: "abc123" }` when the member directory is a git checkout. `status` reports the
  three-way state (pinned approval / member's current approval / checked-out commit).
- Hosted backup: with members as projects (issue 09), each member has its own git binding
  — its own repository, or the parent's repository with pathspec `services/billing/.wai/`.
  Until then, `commitProject` at a parent gains `--family`, which stages every member's
  `.wai/` that lies in the same repository (`admin.ts:262-272` already names the gap).
- Archives: unchanged for members; an external's pin travels in the consumer's `.wai/`
  by construction.

**Migration.** None for monorepo and submodule members. A team that today mounts a
sibling checkout *inside* the parent (a clone in a subdirectory) to consume it keeps
working; if they would rather keep it side by side, `wairon member detach billing --path
../billing` (issue 10) converts the mount to an external and pins.

**Proof.**

- `submodule-missing-is-loud`: a parent whose member directory is absent reports
  `MEMBER_NOT_FOUND` (error) and still judges its own edges into that member against the
  parent's pin of it, marked `pin (member absent)`.
- `side-by-side-is-consumption`: an external with `path: ../billing` resolves live when
  the directory exists, from the pin when it does not, and never loads Billing's internals
  (no `billing::<private component>` is resolvable).
- `containment-unchanged-for-members`: every existing `PROJECTPATH_ESCAPE` fixture still
  fails.
- `family-commit-covers-members`: hosted `commitProject --family` on a monorepo stages
  each member's `.wai/`, and a member's `lock.json` reaches the remote.

## 09 — Hosted: a child as a project, a part, or both

**Diagnosis.** Hosted treats the *record* as the unit and the family as a property of one
record: a member exists only as a mount plus, optionally, a credential narrowed to it
(`server/projects.ts:193-219, 272-307`), permission and audit anchor at the top id
(`request.ts:641-648, 691`), and confinement is a list of refused tools plus per-tool
forwarding (`request.ts:171-205, 375-402, 457-461, 526-557`) because a narrowed
credential is a *top-project* credential with a smaller tree — a shape no tool can reason
about generically. The web UI and git backing gate on records (`web.ts:585-649`,
`admin.ts:363-389`), so a member has neither. The announcement goes to stderr of a
per-request server (`mcp/server.ts:1660-1681`, `request.ts:699`), i.e. nowhere.

**Options.**

| | | |
|---|---|---|
| a | Keep members as scopes; make confinement a binding property and finish the UI | Fixes the list but a member still has no permissions, history or git of its own. |
| b | A member is a hosted project record with `parentProjectId`; the family is a relation between records | Every existing per-project capability (roles, audit, git, approvals, UI, share links) applies to a member unchanged; confinement disappears as a concept. **Recommended**, in two stages. |
| c | Hosted families are relation-only: members are sibling roots, no on-disk nesting | Clean, but breaks containment-based tenant isolation as implemented and every existing hosted family; and local and hosted would differ on what a mount is. |

**Recommendation: b, staged.**

*Stage 1 — no schema change, closes the open holes.*
- Confinement becomes a property of the binding: every tool registration declares
  `scope: 'tree' | 'record'`; under a binding whose `rootPath ≠ topRoot`, a `record` tool
  is refused and an undeclared tool is refused (fail closed). The three sets in
  `request.ts` collapse into one lookup, and a tool added later cannot forget to opt in.
- Announcement in-band: `sdd_get_status` returns `family: { memberOf: 'platform',
  mountedAs: 'billing', governance: 'inherit' }` and the server `instructions` carry one
  line — the agent learns where it is from the first call, not from a log it cannot read.

*Stage 2 — members are projects.*
- `HostedProjectRecord` gains `parentProjectId?` and members keep `rootPath` inside the
  parent's root (containment still holds physically; `resolveSubprojectMounts` is what
  registers them). A registry scan on upgrade registers every mount as a member record
  named by the member's `project.yaml name`; selectors are project ids — `payments`, not
  `platform::billing::payments`.
- Permissions: the hierarchical resolver already walks unit → project; add project →
  member so a parent's role bindings are a *floor* on members (the same word as issue 03,
  deliberately), while a member's own bindings can add. Audit stamps the member's id and
  carries `parentProjectId`. A credential names a project; the parent's credential
  reaches members through that inheritance, a member's credential reaches nothing above
  it (R6, with no list).
- Git: a member has its own binding — its own repository, or the parent's repository with
  a pathspec — so backup covers every `.wai/` in the family (issue 08).
- UI: a member opens as a project with a "member of platform" crumb; the family canvas is
  the landscape restricted to the family (the landscape graph already has project nodes
  and relation edges — `landscape.ts`). Lock, approvals, tokens, share links: the member's
  own.
- Externals: a hosted `ProjectRelationRecord` is an `externals` entry with
  `source: hosted`; relation health and `externals status` compute the same digests
  (issue 05).
- Units versus families: not two answers to one question. A family is *containment*
  (physical, spec-level, one parent); a unit is *organisation* (people, permissions, many
  projects). A member may sit in a different unit than its parent. Keep both; a family is
  a relation of kind `member-of` beside `consumes`, and the landscape draws either.

**Migration.** Stage 1 is behaviour-preserving for every existing tool. Stage 2: the
upgrade registers members and rewrites narrowed entries in `ApiKeyRecord.projects`
(`platform::billing` → `billing`); a narrowed token keeps exactly the tree it had and
gains record-level tools *on the member*, which it could not call before — a documented
widening within the member's own scope, never beyond it.

**Proof.**

- `confinement-is-total` (stage 1): for every registered tool, a binding with
  `rootPath ≠ topRoot` either dispatches into the member tree or refuses; no tool reaches
  the top project's record (the anti-vacuity tests in `.wai/phased_design.md:194` become
  a loop over the tool list).
- `member-is-a-project` (stage 2): every hosted test that runs against a project record
  passes with a member record substituted.
- `no-widening`: a member credential cannot bind, read or list its parent or a sibling;
  a parent credential lists members and binds them.
- `audit-names-the-member`: a tool call under a member binding audits with the member's
  id and `parentProjectId`.
- `announced`: `sdd_get_status` under a member binding returns `family.memberOf`.

## 10 — Migrations: create, externalize, internalize, move, rename

**Diagnosis.** Each migration rewrites at most the parent's own `.wai/specs`
(`rewriteRefsInDir`, `provision.ts:409, 468`) because references in other members were
never modelled as something the family owns; there is no rename because a mount id is
encoded positionally in every sibling's `super::` path (issue 02); internalize is
flat-only because of the merge (issue 01). With project-id references, most of this
dissolves: a *move* touches no reference, a *rename* is a rename of a project id, and
every rewrite is a substitution of `<id>::` prefixes that can be computed for the whole
family before any file is touched.

**Options.**

| | | |
|---|---|---|
| a | Keep per-parent rewrites; document that other members must be fixed by hand | Leaves dangling references by design. |
| b | Family-wide, dry-run-first migrations that refuse when a member that would need a rewrite is absent (`--report` lists it instead) | Atomic in the only sense that matters: nothing is written unless everything can be. **Recommended.** |
| c | Record a rename log the absent member replays on its next `doctor` | Two-phase and stateful; the log is a new artifact to get wrong. Possible later on top of (b). |

**Recommendation: b.** The table, with what each touches. "Family" means every project
on disk that declares the subject as a member or an external, found by walking mounts from
the top and reading each project's `externals`.

| Migration | Parent tree | Subject | Other family projects | Refuses when |
|---|---|---|---|---|
| `create <id> --path` | writes the mount | `project.yaml` (`name: <id>`, `governance: inherit`) + L0 | — | id collides with a project id in the family |
| `externalize <sub> --path` | subsystem specs move to the child; mount written | child provisioned; implementation paths rebased | `x` → `<sub>::x` for every component of the subsystem, in every project that referenced them (before: only the parent) | a referencing member is absent |
| `internalize <id>` | member's subsystems fold in (all of them; collision check) | child `.wai` removed | `<id>::x` → `x` everywhere | collision, or a referencing project absent |
| `detach <id> [--path ../…]` | mount deleted; `externals.<id>` added and pinned | untouched | untouched (`<id>::x` still resolves — now as an external) | the member consumed something the family exposes only at L1 (list it: those edges become `SURFACE_REF_NOT_EXPOSED`) |
| `adopt <id> --path` | mount written; `externals.<id>` removed | untouched | untouched | the directory is outside the parent; the id collides |
| `move <id> --to` | `projectPath` updated; directory renamed | untouched | untouched — references name the project, not the path | target exists |
| `rename <old> <new>` | mount renamed | `project.yaml name` | `<old>::x` → `<new>::x` in every project on disk; `externals.<old>` → `<new>`; lock `members`/`externals` keys | a referencing project is absent |

- Every migration computes its full change set first (a dry run that prints per-project
  file counts), then writes; `--report` writes the change set as YAML and stops. This is
  the one place the family writes into members, and it is explicit, listed, and refused
  when incomplete (R4's sanctioned exception).
- Nested subjects: every migration accepts a project id, so a member of a member is
  migrated from the top just as from its own parent; nothing is "namespaced" any more
  (`provision.ts:347, 420` guards go).
- Approval after a migration: the subject's own lock keeps its digests where files did not
  change (a move) and drifts where they did (a rename rewrites files → re-approve, which is
  right: the design's *names* changed); the parent's `members` pin follows the new key.
- MCP: `sdd_externalize_subsystem` / `sdd_internalize_subsystem` /
  `sdd_move_subsystem_project` keep their names and gain `dryRun`; new
  `sdd_rename_project`, `sdd_detach_member`, `sdd_adopt_external`. All four "kind"
  changes from issue 00 are now named verbs.

**Migration of the migrations.** None; existing trees migrate with the same verbs.

**Proof.**

- `atomic-or-nothing`: a rename with one referencing member removed from disk changes no
  file anywhere and lists that member.
- `family-consistent`: after each migration on the Platform family fixture, every project
  validates with the same edge verdicts as before, and `grep` for the old prefix over
  every `.wai` finds nothing.
- `move-is-free`: `move` changes exactly two things: the mount's `projectPath` and the
  directory name; every member's `lock.json` digest set is unchanged.
- `detach-then-adopt-is-identity`: detach followed by adopt reproduces the original mount
  and leaves the child byte-identical.
- `externalize-updates-siblings`: a sibling that referenced `core_portal` before
  `externalize core` references `core::core_portal` after and validates.

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
