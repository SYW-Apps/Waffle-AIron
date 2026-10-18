# Proposal — Projects and two relations

**Status:** proposed · 2026-09-12 · written by Fable 5.1 as lead reviewer · **revision 2**, against
`dev` at `e7d30d7` (PR #68 merged) · decided from in [`../../../synthesis.md`](../../../synthesis.md)

**Revision 2 — what changed from the first version** (which was decided from
[`synthesis-v1.md`](../../../synthesis-v1.md)): the owner's gate performs *no discovery* and
composition findings exist only in an explicit family run (v1 had them on by default at the child);
the gate identity covers every declared input, not only the tree and doctrine; a consumer's alias
maps to the producer's *project id*, so a parent's alias rename touches no sibling; externals
snapshots carry the facts the boundary rules need; a producer may declare an L0 export as a stable
alias over a published component; a new first stage fixes the current implementation before any
schema changes. The model itself — a project as the unit, two relations, no kind flag — is unchanged.

**Draws on:** [Fable 5.1](../analyses/fable-5.1.md) (the contains/consumes split, project-id
references with `::`, the externals lockfile with a `used` map, member-by-reference topology, staged
hosting, the migration table), [ChatGPT 5.6 Sol (chat)](../analyses/chatgpt-5.6-sol_chat.md) (a
project as the unit of identity/governance/approval/security, relations declared in `project.yaml`,
lock-defined consumer verdicts plus a separate composition finding, semantic contract compatibility,
attested policy requirements), [ChatGPT 6 Astra (chat)](../analyses/chatgpt-6-astra_chat.md) (owner
and composition assessments as two explicit questions, pinned policy profiles with a stricter-floor
merge, `ownSubject` / `compositionSubject` approval hashing, confinement bound to
`(principal, project, action)`, the migration-effect table), and
[ChatGPT 6 Astra (repository)](../analyses/chatgpt-6-astra.md) (no ambient discovery on the
standalone path; structured resolver results before severity; the gate identity must include consumed
contracts; surfaces must carry boundary facts; L0 export ids as stable contract names; explicit
membership grants; the stage-1 correctness fixes). Where the four disagreed, the synthesis says why
this proposal chose as it did.

## The model in one paragraph

> A **project** is the unit of identity, judgement, approval and hosting: a `.wai/` root with a
> declared, immutable **id**. A project relates to other projects in exactly two ways, both declared
> in its own `project.yaml`: it **contains** members (mounted by a contained path; their whole tree is
> readable; the family view is *composed* from their own results) and it **consumes** externals
> (resolved to a published surface and locked like a dependency). A **subsystem** is an architectural
> level *inside* one project and nothing else; a mount is not a subsystem and carries no L1 content. A
> **reference** names a project, never a position in a tree: `x` is mine, `<alias>::x` is theirs, and
> the alias maps to the producer's id. A project's **own verdict** is a pure function of its files,
> its configuration and adopted policies, its approval record and its externals lock — the same from
> every root and every checkout, and computed without looking at anything above or beside the
> project. Anything a family knows *in addition* (a selected provider that no longer satisfies a
> locked contract, a required policy not adopted, a member missing or unapproved) is a **composition
> finding**, explicit and scoped, produced only by a family run, never a change to an owner's finding.
> Nothing writes into another project except a named, dry-run-first migration.

Five concepts: project · subsystem · member (contains) · external (consumes) · published surface. No
kind flag. No flat child, family surface, sibling surface, `super::`, loading-root `::`,
root-subsystem anchor, ambient parent discovery, `resolvedThrough`, three-segment id, per-tool
confinement list, or parent cascade into children.

## Declarations

```yaml
# platform/.wai/project.yaml
id: platform                        # NEW: immutable slug; `name` stays the display name
name: Platform
members:                            # contains — the family
  billing: services/billing         # short form: alias = project id = `billing`, path contained
  shipping: { project: shipping, path: services/shipping }   # full form
composition:
  requirePolicies: [{ profile: acme/service-baseline@sha256:P1, scope: descendants }]
  requireApprovedMembers: false     # true: `lock` refuses while a member is unapproved or drifted
externals:                          # consumes — outside the family
  crm: { project: crm, source: { hosted: https://wairon.example/, project: crm } }
```

```yaml
# services/shipping/.wai/project.yaml
id: shipping
name: Shipping
policy:
  profiles: [acme/service-baseline@sha256:P1]   # adopted doctrine: a floor this project may only tighten
externals:
  billing:  {}                      # a family sibling: alias `billing` → project id `billing`, source implied
  platform: {}                      # my parent
```

```yaml
# services/shipping/.wai/externals.lock.yaml   (written by `wairon externals pin`, committed)
externals:
  billing:
    project: billing
    surface: .wai/externals/billing.yaml        # the snapshot: published entries with stereotype and
    digest: sha256:9c1…                         #   transport, methods, type closure; digest of its content
    used:                                       # what this project actually references
      invoice_portal: { createInvoice: sha256:4a… }
policies:
  acme/service-baseline: sha256:P1
```

A member's mount is *only* this entry; the plain monorepo needs one line per member and nothing else.
The L1 `projectPath` form loads for one release and `doctor --fix` moves it. The child owns its L0 and
every L1; a child's L0 `name`/`vision` supply the family view's label and description.

## References

- Grammar: `ref := local | alias "::" local`, both `[a-z0-9-_]+` (today's `SpecIdSchema`, no new
  characters). `alias` is a key of `members` or `externals`, or — inside a family — the parent's or a
  sibling's id as declared in the consumer's own `externals`. Default alias = project id; the alias
  table exists so a consumer survives a producer rename and two producers with the same id can both
  be consumed. A parent renaming its *membership* alias changes no sibling; renaming a project *id*
  is a family migration.
- Targets: a published component of the producer (the subsystem-boundary rule, Adapter → published
  Portal/Gateway). A producer *may* declare an L0 export at `audience: project` as a stable name over
  a published component; a reference to the export id resolves to the component, and renaming the
  component behind it is free. Outside the family, only L0 exports at the consumer's audience.
- Load: a file in project *Q* loaded from root *P* has its local ids prefixed `Q::` when *Q ≠ P*;
  `alias::local` is verbatim. No `rootSubsystems`, no `super`, no leading `::`. The old forms load
  with `DEPRECATED_REFERENCE_FORM` (notice) for one release, resolved relative to the *file's* project.
- Save: strip the file's own prefix, leave `alias::local` verbatim. Authored text round-trips byte
  for byte.
- Pins are keyed by `(project, entry)` — never by last segment, never first hit; an ambiguous match
  is a finding.
- Collisions: `PROJECT_ID_COLLISION` (family run), `LOCAL_ID_SHADOWS_PROJECT` (a subsystem id equal
  to an alias visible from this project), `DUPLICATE_SPEC_ID` (two specs with one id inside one
  project — the loader indexes by bare id today and the last one silently wins).
- One resolver for `dependsOn`, call targets, trusted links, dispatch tables and parsed type
  references; every finding carries the resolver's result (`resolved | missing | ambiguous |
  unavailable | forbidden`), the owner, the call site, the canonical target and the input digest.

## Judgement and evidence

```
validateProject(P):                      # the owner's verdict — pure in P's files; NO discovery
  cfg      = P.config ⊔ adopted policies (floor; own may only tighten, else POLICY_LOOSENS)
  inputs   = P.externals.lock            # never the live tree, never an ancestor walk
  issues   = rules(P.tree, cfg, inputs, P.approval)
  return issues                          # plus a static hint when an externals lock exists:
                                         #   "compare with live producers: externals status / validate --family"

validateFamily(root):                    # `validate` at a parent; `validate --family` at a member
  reach    = granted before any read (hosted: the credential's; local: the walk-up is explicit)
  results  = { validateProject(M) for M in root ∪ members* }
  compose  = for each external E of each M whose producer is a selected member or reachable:
               compare(lock.used[E], selected surface of E)      # scope: composition
               → EXTERNAL_INCOMPATIBLE     (error: a used entry removed or its signature changed)
               → EXTERNAL_DRIFTED          (notice: the surface moved, nothing used changed)
               → EXTERNAL_CHECK_UNAVAILABLE (warning: the snapshot lacks a fact the rule needs)
  family   = MEMBER_NOT_FOUND · PROJECT_ID_COLLISION · POLICY_NOT_ADOPTED · MEMBER_UNAPPROVED · MEMBER_DRIFTED
             · cross-mount import edges judged by the importer
  return prefix(results) ∪ compose ∪ family
```

Every edge has one judge: the project that authored it. The family run *calls* that function; it
never re-judges a member under the parent's configuration. A standalone run reads nothing above or
beside the project, so its result cannot change with what is checked out; a family run is asked for,
and its reach is checked before its first read. `wairon externals status` reports drift on request.
`resolveThroughParent`, the resolution-failure family, `surfaceResolved` and the mount-pool lookup
are deleted when the composed run lands; until then the legacy fallback stays with its stage-1 fixes.
`--ci` fails on errors and unwaived warnings as today; `--frozen` is unnecessary.

Compatibility is semantic: a used method must still exist with an equal signature and reachable
types; additions never fail; anything the codec cannot compare is `EXTERNAL_CHECK_UNAVAILABLE`, never
a pass. The snapshot carries each entry's stereotype and transport so the consumer-side rule applies
the same target rule as the live check (Adapter → Portal/Gateway; an Observer only through an event
subscription).

## Governance

No implicit inheritance. A project adopts doctrine as pinned policy profiles; a parent *requires*
profiles over its members (`composition.requirePolicies`). Non-adoption is `POLICY_NOT_ADOPTED` in the
family run — the member stays valid alone and cannot be composed. `create`/`attach`/`adopt` write the
parent's required profiles into the new member's `policy.profiles` once, so the common case needs no
manual step. Project type and target language are owner values copied at scaffold, never read from
the nearest parent's current file. A member that deliberately declines keeps its own gate; the
parent sees the divergence and may decline that member version.

## Approval

Per project, never transitive by writing. The **gate identity** is the tree ⊕ the doctrine ⊕ the
externals lock ⊕ the adopted policies ⊕ each direct member's composition subject (algorithm
`sha256+doctrine+inputs`; every existing lock reads stale once, as `sha256+doctrine` did). `lock`
records: own spec digests (as today), the digests of every pinned external and adopted policy, and
for each direct member its **composition subject** — the member's approved gate id, which already
covers that member's own `members` — so the chain is transitive by construction and inspectable
(`wairon status --family` prints `approved | moved | never` per node). With `requireApprovedMembers`,
`lock` refuses while a member is unapproved or drifted; without it, it pins what exists and says so.
A re-pin that changes a *used* digest drifts the consumer's approval. The approval certifies the
design under its declared inputs; code-conformance results are recorded beside it with the analyzer
identity, not folded into the claim. A parent lock writes nothing below itself at any depth: no
`ensureProjectInitialized`, no skills/context/guides, no pruning — `wairon generate --family` is the
explicit opt-in. Hosted git backing commits the lock record like any other `.wai/` file.

## Derived outputs, hosting, layouts, migrations

- **Topology/status/briefs.** The parent's topology lists a member node whose agents are ids
  resolved live; `sdd_get_agent_brief('billing::billing-owner')` composes the brief at the member's
  root, with the member's own topology, config and skills, and names the owner project, the writable
  scope and the selected inputs. Status at a parent prints one line per member computed at the
  member's root with an explicit denominator; status at a member prints `member of platform (as
  billing)` and its externals' freshness.
- **Hosting.** Stage 1 (now): discovery happens after the reach gate on every path; containment is
  decided against the owning root; every tool declares `scope: tree | record`, undeclared is refused;
  the chaining announcement moves in-band (`sdd_get_status` → `family: { memberOf, mountedAs }`).
  Last stage: a member is a hosted project record with `parentProjectId`, its own permissions, audit
  (owner and initiating composition), git binding, approval page and UI crumb; family reach is a
  recorded grant made at registration equal to today's reach (never an implicit walk); a hosted
  `ProjectRelationRecord` is an `externals` entry with `source: hosted`, and relation health is
  `externals status`.
- **Layouts.** Members stay inside the parent's directory (monorepo, submodule — a missing submodule
  is `MEMBER_NOT_FOUND`, and the parent still judges its own edges against its pin of the member). A
  project elsewhere is an external with `source: { path: ../x }` — live in a family run when present,
  pinned otherwise. A *member* outside the root, if ever wanted, binds through an explicitly selected
  local workspace descriptor that hosted never reads. Approval digests and commit ids are recorded
  side by side, never merged. A tree archive names every declared member it could not include and
  refuses to call itself complete.
- **Migrations.** Every migration computes its family-wide change set first (`--report` prints
  per-owner patches and stops) and refuses when a project it must rewrite is absent. `create`
  (scaffolds `project.yaml`, L0 and optionally one L1), `attach` (adopts an existing project,
  preserving its L0 and L1 set), `externalize` (rewrites inbound *and* the moved subtree's outgoing
  references), `internalize` (all subsystems, collision map, an explicit destination for the child's
  own metadata), `move` (touches no reference), `rename` (an id change: family rewrite), `detach`
  (member → external: delete the mount, add and pin an external; refuses when the family consumed
  something the member publishes only at L1), `adopt` (external → member). This is R4's one
  sanctioned exception.

## Worked example — Platform / Billing / Payments / Shipping

Declarations: Platform `members: {billing, shipping}`; Billing `members: {payments}`, subsystem
`billing` (loads as `billing::billing` from Platform) publishing `invoice_portal`; Payments a leaf;
Shipping `externals: {billing: {}, platform: {}}`, `dispatch_adapter` (Adapter, subsystem `dispatch`)
with `dependsOn: [billing::invoice_portal]` and a call step `billing::invoice_portal.createInvoice`.
The reference is the same string from every root.

| From | What runs | Verdict on `dispatch_adapter → invoice_portal` |
|---|---|---|
| Shipping, cloned alone — or with the family on disk | `validateProject(shipping)` against the lock | Adapter ✓, `invoice_portal` pinned as a Portal ✓, `createInvoice` used ✓ → clean. Missing `externals.billing` → `EXTERNAL_UNDECLARED`. Identical in both checkouts: nothing above the project is read. |
| Shipping, `validate --family` (reach granted) | the same, plus the composition against live Billing | the same owner findings; plus `EXTERNAL_INCOMPATIBLE` if Billing's live `invoice_portal` no longer has `createInvoice` |
| Platform | `validateFamily(platform)` | Shipping's run verbatim under `shipping::`, the composition findings, the family checks — one judgement of one edge, reached from three roots |
| Billing | `validateProject(billing)` | nothing: Billing does not know Shipping. `wairon externals consumers billing` at Platform, and hosted relation health, list the inbound edge with their search coverage. |

Approvals: Payments — its specs, policies and inputs; Billing — its specs, policies and
`members.payments`; Shipping — its specs, policies and `externals.billing: 9c1…`; Platform — its
specs, policies, `members.billing` and `members.shipping` (composition subjects, hence Payments).

Billing renames `createInvoice → issueInvoice`: Billing validates clean and re-locks (its own gate;
it cannot know Shipping). Shipping alone still passes — honest: its declared input did not change;
`externals status` says `unreachable` or, with the family on disk, names the removed method.
Shipping with `--family`, and Platform: `EXTERNAL_INCOMPATIBLE @dispatch_adapter` ("`createInvoice`
no longer on `billing::invoice_portal`; `issueInvoice` added") — the team fixes the call, runs
`externals pin` (digest → 4d0…) and re-locks. Platform: the same finding until that is done; then
`lock` reports `billing: moved`, `shipping: moved` and, with `requireApprovedMembers`, refuses until
both are re-approved. Hosted: the Shipping → Billing relation turns red with the same message,
because it is the same computation. Platform renaming its alias `billing` → `accounts` changes
nothing in Shipping.

## Commitments

| | | |
|---|---|---|
| R1 one verdict per edge | keep | one judge per edge; the only cross-root difference is an explicitly scoped composition finding that only a family run produces |
| R2 child first-class | strengthen | validates alone against declared inputs, with no discovery |
| R3 parent first-class | keep | composed validation, canvas, approval tree, delegation by reference; the parent admits, it does not re-govern |
| R4 no side-effect writes | strengthen | includes the transitive init/generate cascade; migrations are the named exception |
| R5 authoring round-trips | keep, simplify | the canonical form is root-invariant; save rewrites nothing |
| R6 confinement | reframe | a credential names a project; containment is the owning root's property; reach is checked before any read; family reach is a recorded grant |
| R7 no softening by location | keep, by construction | the owner verdict is a pure function of the owner's files and lock |
| R8 layouts | weaken honestly | side-by-side *members* need an explicit local workspace; side-by-side *consumption* is first-class |
| R9 nesting | keep for layout | ids stay two-segment; the loader has no depth; loader diagnostics qualify at every depth |
| R10 proportional cost | strengthen | a child never loads its family |
| R11 predictability | keep | `project.yaml` (`id`, `members`, `externals`, `policy`) and the lock say from files alone what a reference points at, who judges it and against which inputs |

## The fixes merged in PR #68

| Fix | Under this model |
|---|---|
| 1 resolve-through-parent: resolution-failure trigger + stricter-of-both + give-way | kept until the composed run lands, with stage 1 closing discovery-before-reach and the dropped scoped diagnostics; its conditional evidence (an unrelated failure changes which evidence judges a pinned edge) is documented, not patched with another code list; its tests become the `location-independent` property |
| 2 flat child at every depth (`qualifySubsystemRef`) | kept until the no-merge loader makes it moot; its tripwire becomes `depth-invariance` |
| 3 `qualifyDeclaredId` always mount-qualifies; `--ci` draft waiver; Specialist matrix | kept — "a declaration never root-anchors" is exactly what the new loader generalises; the other two are unrelated to chaining |
| 4 reach gate + explicit read/write classification + landscape tools refused | kept and extended: the gate moves ahead of discovery on every path, the refusal sets collapse into a declared `scope`, the classification test becomes "every tool declares a scope" |

## Staging, risks and open decisions

See [`synthesis.md`](../../../synthesis.md) §6–§8: eight shippable stages (the first fixes the
current implementation without a schema change) with the properties that prove each, the probes that
size the migration and de-risk the compatibility codec and the hosted permission change, and the
twenty-three decisions only the maintainer can make, four of which block the first stage.
