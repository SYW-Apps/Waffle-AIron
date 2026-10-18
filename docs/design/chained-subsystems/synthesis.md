# Chained subsystems — synthesis (v2)

**Lead reviewer:** Fable 5.1 · 2026-09-12 · written against `dev` at `e7d30d7` (v5.1.1-dev.12, PR #68
merged). Supersedes [`synthesis-v1.md`](synthesis-v1.md).
**Sources reviewed in full, each before the previous synthesis was re-read:**
[Fable 5.1](responses/fable-5.1.md) (repository access on r1-era code; its corrections were folded
into r2); [ChatGPT 5.6 Sol](responses/chatgpt-5.6-sol_chat.md) (chat, no repository, r2);
[ChatGPT 6 Astra, chat](responses/chatgpt-6-astra_chat.md) (with its chat text
[`chatgpt-6-astra_chat_response.md`](responses/chatgpt-6-astra_chat_response.md) — one answer in two
renderings); and [ChatGPT 6 Astra, repository](responses/chatgpt-6-astra.md) (Codex on `dev`
`e7d30d7`, written without reading the other answers or v1). Every claim a conclusion rests on was
re-checked against the code at `e7d30d7`, and three of Astra's probes were re-run here (§9).

**The decision this document supports:** which model of a chained subsystem to commit to, and in what
order to get there. The recommendation is written up as
[`issues/00-the-model/proposals/projects-and-two-relations.md`](issues/00-the-model/proposals/projects-and-two-relations.md),
revised to match this synthesis.

Contents: 0 What changed since v1 · 1 Models side by side · 2 Convergence · 3 Divergence and verdicts ·
4 Per issue · 5 Recommended model · 6 Migration and staging · 7 Risks and probes · 8 Decisions for
the maintainer · 9 Claims checked against the code

---

## 0. What changed since v1, and why

v1 was written against the `fix/chaining-verdicts-confinement` working tree with three answers. Since
then PR #68 merged, and a fourth answer arrived that read the merged code and ran eight
characterization probes. Its model is the same shape as the other three; its *facts* are new, and
three of them move verdicts.

**New facts (all confirmed against `e7d30d7`, three re-run — §9).**

1. **The gate identity has a hole.** `hashGateState` digests the spec tree and the doctrine
   (`src/core/statehash.ts:57-66, 155-157`) and nothing else: a pinned surface can be swapped for one
   that changes the verdict (`SURFACE_REF_NOT_EXPOSED` appears) while the lock's StateId stays
   identical (Astra P2). An approval therefore cannot tell that its inputs moved. v1 said the lock
   should *record* externals digests; it must also *hash* them.
2. **Re-pinning does not repair staleness.** `writeSnapshotIfChanged` skips the write when content is
   unchanged, keeping the old `stateId` (`src/core/surfaces.ts:336-359`), while freshness compares
   exactly that `stateId` with the parent's current one (`:627-651`). After any private parent edit
   every pin reads `stale` forever, and `surface pin` writes zero files (Astra P1; re-run here).
3. **Pin precedence is conditional, not a mode.** Once *any* resolution failure triggers the walk, the
   parent-side run's findings are unioned in (`src/core/validation.ts:520-524`), so a pinned edge
   that stood alone is suddenly judged live (Astra P6). v1 treated "pins outrank the live tree" as a
   fixed rule to replace; it is worse — which evidence judges an edge depends on an unrelated typo.
4. **Containment is a property of the loading root, and the reach gate sits after discovery.** The
   loader checks a nested mount against the *bound* root (`src/core/specs.ts:954-968`), the writer
   and the hosted binding check the *owning* root (`:261-272`, `src/server/projects.ts:213-215`); the
   same declaration is accepted from one root and refused from another (Astra P3, design level). On
   the validation path, `findChainingParent` runs before `resolveThroughParent` consults
   `parentReach` (`validation.ts:504` vs `:556-557`) — the guarded wrapper `resolveChainingParent`
   (`specs.ts:2934-2943`) checks reach first, but validation does not use it. #68's confinement fix is
   real and incomplete.
5. **Externalize loses the moved subsystem's own outgoing edges** (Astra P7; re-run here: an Adapter's
   `family-portal` becomes `moving::family-portal`, `INVALID_DEPENDENCY_REFERENCE`). v1's migration
   table only covered *inbound* references.
6. **Surfaces omit facts the live boundary rules need**: a pinned Observer passes the snapshot path
   (only "source is an Adapter" is checked, `src/core/rules/stereotype-deps.ts:61-79`) while the live
   path reports `CROSS_SUBSYSTEM_TARGET_NON_PORTAL` (`:142-150`) (Astra P8).
7. **Scoped validation drops a nested mount's loader diagnostics**: `SUBPROJECT_NOT_FOUND` carries the
   bare mount id (`specs.ts:981-986`), so `--subsystem kid` filters it out (Astra P4; re-run here).
8. **Hosted git backing excludes the approval record**: enabling git appends `.wai/lock.json` to
   `.git/info/exclude` (`src/git/adapter.ts:97-105`, called at `src/git/orchestrator.ts:28`). That
   contradicts the approval-baseline design ("the approval rides in the lock record, which was always
   committed") for every hosted git-backed project; this repository tracks its own lock and its
   `.gitignore` says so deliberately (`.gitignore:48`).
9. Smaller: the generate cascade is *transitive*, not "each direct child" (`src/commands/generate.ts:112`
   recurses); a tree archive silently omits mounts that are missing, escaping, cyclic, deeper than 32,
   or without `.wai` (`specs.ts:352-393`, `treetransfer.ts:237`); the lost fix `116d5f7` is on `dev`
   and #68 added the half Fable said was missing (`qualifySubsystemRef`, `specs.ts:153-156`).

**Verdicts reversed or moved.**

- **D1 (evidence at the consumer's gate): reversed on the default.** v1 put composition findings *on
  by default at the child* whenever the producer is reachable. That re-introduces "what is on disk
  changes CI" (the lead engineer's concern b), it needs ambient parent discovery on the default
  path — the exact mechanism behind fact 4 — and Astra's repository review argues the same point
  independently. The owner gate is now lock-defined with **no discovery**; composition findings exist
  only in an explicit family run (`validate` at a parent, or `validate --family` at a member, reach-
  gated *before* any read). §3 D1.
- **D5 (approval): strengthened.** The gate identity must cover the externals lock, adopted policies
  and members' composition subjects (fact 1). Every existing lock reads stale once — the same forced
  re-lock `sha256+doctrine` already caused.
- **Staging: a new first stage.** Astra's "close the correctness gaps in the current interpretation"
  is cheap, changes no schema, and de-risks everything after it: qualify the mount-branch loader
  diagnostics, decide containment against the owning root, gate discovery before reads, match pins
  by provider, fix the freshness/write-suppression mismatch, hash consumed contracts into the gate,
  rewrite outgoing references on externalize, refuse a partial archive, drop the lock-file exclusion.
  It also gives the migration-sizing probe (concern a) a stable base.

**New risks.** Forcing a re-lock instance-wide (fact 1's fix); hosted projects starting to commit
`lock.json` (fact 8's fix) on repositories that never carried it; the family run losing a convenience
(a developer at the child must ask for the composition view).

Everything else in v1 — the model, the rejection of a kind flag, project-id references, per-project
governance by adopted policy, composition subjects, members as hosted records, plan-first migrations
— re-derived from the four sources and the code and stands, with the refinements in §3–§5.

## 1. The models side by side

| | **Fable 5.1** (repo, r1) | **ChatGPT 5.6 Sol** (chat) | **ChatGPT 6 Astra** (chat) | **ChatGPT 6 Astra** (repo, `e7d30d7`) |
|---|---|---|---|---|
| Core concepts | project · published surface · **member** (contains) · **external** (consumes); the mount stays an L1 file with only `id` + `projectPath`; `governance` a project property | project (identity + governance + approval + release + security) · subsystem inside one project · **relation** `member \| dependency` · **source**; composition leaves L1 for `project.yaml`; a pure directory split = one project with fragments | one project model + **membership** and **consumption** relations outside L0–L5; a child's L0 stays an L0; two assessments (project, composition) | first-class projects + **membership** (`members` with `project` and `source`) + **contract imports**; a member's L0 is the project node, expandable to its real L1s; the smallest valuable change is an owner-aware project graph beside `SpecIndex` with compatibility projections |
| Identity / references | `project.yaml name` (slug) = mount id; `x` or `<projectId>::x`; `super::`/`::` retired | immutable `project.id` + consumer alias table; `@billing::invoice_portal`; `::`/`super::` invalid in v2 | immutable `syw.billing` + owner-local `imports`; `dep:billing/invoice_portal#m`; authored spelling preserved | committed `projectId` (`syw.billing`) distinct from name and path; key `(projectId, specKind, localId)`; `@billing::invoices` where `invoices` is an **L0 export id**, never a component name; bare ids local only; duplicate identities in one composition rejected initially |
| Who judges an edge | the consumer's project under its *effective* config; family run composes | the owning project; family aggregates + composition findings | `V(P)`; `Family(F)` = all `V(P)` AND compatibility AND policy | **project assessment** (own specs+code, own policy+approval, exact import digests) vs **composition assessment** (selected member revisions, owner results, provider exports, bindings, composition policy); a structured resolver result (`resolved \| missing \| ambiguous \| unavailable \| forbidden`) before any severity; `PROVIDER_INPUT_MISMATCH` |
| Evidence | live when reachable else pin; both and differ → `EXTERNAL_PIN_STALE`; `--frozen` | the lock defines the verdict; family checks live ⊇ locked; `--against-workspace` diagnostic | locked inputs define `V(P)`; explicit context `F`; missing input = incomplete | immutable contract inputs by provider/export identity + digest; the family compares the *selected* provider state; staleness never fails a reproducible project assessment; an offline pin cannot see a later revocation; exact digest alignment for family approval at first |
| Governance | `governance: inherit` floor, own may tighten; floor rides in the externals lock | isolation; required packs attested on the relation | owner policy + pinned profiles; `requirePolicies` over descendants; stricter floor for the same rule | own resolved policy; parent admission through explicit, pinned policy packages present in the child; inherited project type scaffolded or pinned, never read from the nearest parent's current config; "two facts" reported, never relabelled; a severity maximum cannot reconcile different predicates |
| Approval | per project; lock records externals; parent pins each direct member; `requireApprovedMembers` | project approval + Merkle composition approval (`lock --family`) | `ownSubject` / `compositionSubject`; preflight at settled strictness | per-file owner approvals + a versioned composition record with each direct member's *complete* approval identity; the gate hash must include imported contracts (P2) and analyzer evidence when code is certified; capture the input set before validation; contract digests are leaf inputs (no recursive provider hashing) |
| Hosting | stage 1 `scope` per tool + in-band announcement; stage 2 members as records with `parentProjectId`, parent bindings a floor | every logical project a record; `ProjectHandle` confinement | every project registered once; `(principal, projectId, action, artifacts)`; explicit member grants | one canonical registration per writable root; compositions reference it with an explicit grant; bindings carry owner, allowed roots, imported contracts, capabilities; every descriptor declares scope, unclassified refused; discovery gated before reads; audit both the initiating composition and the owner; `project::child` kept as an alias |
| Layouts | members inside (monorepo, submodule); side by side = consumption with `path:` | general source resolvers + `wairon sync` | nested `path` keeps containment; side by side via a selected workspace descriptor | explicit source/workspace resolver (never walk `..`); hosted through registered handles; fix the `lock.json` exclusion; backup through the membership resolver, a claimed full backup fails on an unavailable member |
| Migration | none for the relationship; `doctor --fix` rewrites family-wide | `schemaVersion: 2` + `migrate --plan/--apply` | versioned schema, per-owner rewrites, conflicts reported | a legacy interpretation loaded explicitly; stage 1 = correctness gaps on the current model; owner graph behind compatibility views; approvals invalidated for the new input hash, never synthesized |

Four independent runs of one prompt — two with the code, two without — produced one shape. The
repository-backed pair differ from the chat pair mainly in what they refuse to promise (offline
revocation, behavioural compatibility, atomic multi-repository migrations) and in staging.

## 2. Where they converge

All four, unprompted by each other:

1. **No `kind` flag** (all four). A kind bundles behaviours that vary independently; today's design is
   already a mix; the first team wanting "our rules, the platform's gate" needs a third kind.
2. **Two declared relations**: *contains/member* (internals readable, family view composed) and
   *consumes/external/import* (contract only, pinned) — all four.
3. **The mount carries no L1 content; no same-id merge; "flat child" disappears** — all four. Astra
   (repo) adds that the merge is lossy *even after* #68 fixed its depth: the collapsed record mixes
   data and write ownership from two authored files (`specs.ts:401-423, 1015-1019`).
4. **A reference names a project, never a position** — all four. `super::`, loading-root `::`, the
   root-subsystem anchor, last-segment/first-hit pins and silent clamping go.
5. **One judge per edge: the project that authored it, under its own configuration; the family
   composes and never re-judges** — all four. `resolveThroughParent` and its code family retire.
6. **Declared, digested contract inputs per consumer** replace family/sibling snapshots keyed by the
   whole family's state — all four.
7. **A parent lock writes nothing below itself; generation is explicit** — all four.
8. **Approval per project; the family's approval is a separate, explicit, transitive claim** — all four.
9. **Members are hosted project records; confinement is a property of the binding, not a tool list** —
   all four.
10. **Migrations are plan-first and honest about unavailable owners; a path move touches no reference**
    — all four.
11. **Commit ids, contract digests and approval digests stay distinct** — all four.
12. **Code conformance belongs to the source file's owner** — Fable, Astra ×2 explicitly; Sol by
    construction.
13. **The standalone gate must not depend on what happens to be checked out above it** — Sol, Astra ×2
    explicitly; Fable's own tests (`location-independent`) demand it while its default violated it.

## 3. Where they diverge — and verdicts

**D1 — Evidence at the consumer's gate.** *Fable:* live-else-pin, with `EXTERNAL_PIN_STALE` when both
exist and differ; a monorepo developer sees Shipping break as soon as Billing changes. *Sol / Astra
(chat):* the consumer's verdict is a pure function of its files and lock; the live comparison is a
composition finding under `--against-workspace` or an explicit context. *Astra (repo):* the same, plus
the observation that today's evidence selection is *conditional on unrelated findings* (P6) and that
"a normal standalone run should not search ancestor directories" — the ambient walk-up is the
mechanism behind the reach-ordering defect. *v1's verdict* was lock-defined owner findings *plus*
composition findings on by default at the child. *Verdict now — reversed on the default.* The owner
gate is lock-defined and performs **no discovery**. Composition findings (`EXTERNAL_INCOMPATIBLE`
error when a used entry no longer holds; `EXTERNAL_DRIFTED` notice otherwise) are computed only in a
composition run: `validate` at a parent is one by definition; `validate --family` at a member asks for
one explicitly, and the walk-up it needs is reach-gated *before* the first read. `wairon externals
status` reports drift on request. Fable's ergonomic point survives as a one-line hint printed by
`validate` at a member that holds an externals lock ("compare with live producers: `externals
status`, `validate --family`") — static text, no read. Why this beats v1: R7 and R11 hold by
construction rather than by a per-project switch; the child's CI cannot flip on a sibling's edit
(concern b); hosted "reachable" stops being a validation input; and no default path discovers a
parent, which is what the containment and reach findings ask for. *Confidence: high on the invariant
and the default; medium on the hint being enough for monorepo teams* (decision 5).

**D2 — Identity form.** *Fable:* `project.yaml name` as a slug, mount id = name. *Sol / Astra ×2:* an
immutable namespaced id plus a consumer-local alias table. *Code:* `name` is free text
(`src/models/project.ts:255`), so a new field is needed either way; `OrganizationUnitRecord.id` is a
dot-qualified slug (`src/server/types.ts:487-499`) — precedent. *Verdict — unchanged hybrid.* A
declared immutable slug `id` (dots allowed; family-unique locally, instance-unique hosted), used
directly in references as `<alias>::x` where the alias defaults to the id; the `members`/`externals`
maps *are* the alias table. New precision from Astra (repo): a consumer's alias maps to the producer's
**project id**, so a parent renaming its *membership alias* touches no sibling, and only a producer
*id* rename is a family migration. *Confidence: high.*

**D3 — Reference syntax.** `billing::x` (Fable) · `@billing::x` (Sol; Astra repo) ·
`dep:billing/x#m` (Astra chat). *Code:* `SpecIdSchema` is `/^[a-z0-9-_]+$/` (`src/models/specs.ts:6`);
the loader, the MCP schemas, hosted selectors, the canvas and the OpenAPI codec split on `::`. A
sigil's only job — telling a project reference from a subsystem-qualified type reference — is done
by `LOCAL_ID_SHADOWS_PROJECT`. *Verdict: `::`, no sigil. Confidence: high.*

**D4 — What a cross-project reference targets.** *Astra (repo), alone:* an **L0 export id**
(`invoices`, backed by `invoice_portal`), so a member renaming a published component breaks no
consumer, and "what the family may call" is an owner-declared contract; "do not default to
publishing every child subsystem". *Fable / v1:* family edges are the ordinary subsystem-boundary
rule (Adapter → a sibling's L1-published Portal), zero ceremony for the split-product case; L0
exports at audience govern consumption from *outside* the family. *Code:* the `project` audience is
documented as "family-internal" (`src/models/specs.ts:46-47`) yet family resolution today reads L1.
*Verdict — L1 for family edges, L0 exports for externals, with an optional indirection:* a producer
*may* declare an L0 export with `audience: project` as a stable alias over a published component; a
reference to the export id resolves to the component; renaming the component behind an export is
then free. Not required. This keeps the common case free of a second publication layer and gives the
rename stability where a team wants it. *Confidence: medium.* What would change it: evidence that
sibling breakage from internal renames is common (probe P2 in §7).

**D5 — Governance.** *Fable:* an implicit inherited floor. *Sol / Astra ×2:* no ambient parent — the
child adopts doctrine as a pinned input, the parent requires it on the relation. Astra (repo) adds the
argument against severity-merging as a governance model: different packs are different predicates,
allowed-edge tables, design depths and languages, not comparable by `off < warning < error`; and the
"inherit unless declared" project type (Track D2) must become a value scaffolded or pinned, never a
read of the nearest parent's current file. *Verdict — unchanged: adopted pinned profiles, required by
the parent, scaffolded at creation; `POLICY_NOT_ADOPTED` blocks composition, not the member's own
gate; `POLICY_LOOSENS` when an adopted profile is weakened.* #68's `stricterSeverities` stays as a
stopgap on the legacy path only. *Confidence: high.*

**D6 — Approval.** *Fable:* a chain of one-hop pins + `requireApprovedMembers`. *Sol / Astra (chat):* a
Merkle composition hash. *Astra (repo):* the same, with three additions: the gate identity omits
consumed contracts (P2), so a re-pin can change the verdict without touching the lock; say whether a
lock certifies design or code, and hash the evidence for whichever it is; capture the input set
before validation and compare before writing (hosted approval requests). *Verdict — composition
subjects (v1) **plus** a gate identity over tree ⊕ doctrine ⊕ externals lock ⊕ adopted policies ⊕
members' composition subjects.* Existing locks read stale once. The lock certifies the design under
declared inputs; code-conformance results are recorded beside it with the analyzer identity, not
folded into the approval claim (decision 10). *Confidence: high.*

**D7 — Layouts.** Unchanged from v1 (Astra's shape: nested `path` keeps containment; a side-by-side
*member* only through an explicitly selected local workspace descriptor; side-by-side *consumption*
first-class). Astra (repo) adds two facts that move into stage 1: the `lock.json` exclusion and the
silent archive. *Confidence: medium → high on the shape, high on the two fixes.*

**D8 — Where the mount is declared.** `project.yaml members:` (Sol, Astra ×2) versus the L1 file
(Fable). *Verdict unchanged: move it; both forms load for one release.* Concern (c) — `project.yaml`
must stay simple — is answered by the shorthand: `members: { billing: services/billing }` is the whole
declaration for the plain monorepo; `id` is written once by `doctor` from `name`; `externals` is one
line per consumed sibling; the lock file is generated. *Confidence: high.*

**D9 — Explicit composition contexts as files** (Astra chat). Astra (repo) does not repeat the
artifact; it asks for explicit *modes* and for caches keyed by all selected inputs. *Verdict
unchanged: the parent's lock record is the immutable context; `validate --at-approval` later.*
*Confidence: medium.*

**D10 — Directory split as one project** (Sol's fragments). Astra (repo): "making a separate
repository need not automatically create a separate approval authority" — still no mechanism.
*Deferred; measure demand.*

**D11 — Hosted family reach.** Automatic parent → member floor (Fable) versus explicit grants (Astra
×2; Sol: membership never implies permission). *Code:* the resolver walks project → unit → ancestors →
instance (`src/server/permission_resolver.ts:78-88`); no project → project rung exists. *Verdict
unchanged: explicit grants recorded at migration equal to today's reach; ancestry is not
authorization.* Concern (d) agreed: this is resolver work and is the last stage. *Confidence: medium.*

**D12 — What to do with the current fallback now.** *Fable / v1:* delete `resolveThroughParent` when
composition lands. *Astra (repo):* keep the fixes as compatibility protection; add structured
resolution and provenance first; introduce explicit modes before changing what `validate` means.
*Verdict — Astra's order.* The fallback stays until the composed run exists, but its two defects that
matter for hosting and for CI are closed now: discovery after the reach gate, and the mount-branch
diagnostics qualified (stage 1). Its conditional evidence (P6) is documented as a known limitation
until the composed run replaces it, not patched with another code list — all four agree that
list-of-codes is the wrong abstraction. *Confidence: high.*

**D13 — Surface facts.** Astra (repo) alone: a surface must carry enough to reproduce the live
boundary judgement or declare the check unavailable (P8). *Verdict — accepted:* the externals snapshot
records each entry's stereotype and transport kind; the consumer-side rule applies the live target
rule (Adapter → Portal/Gateway; an Observer only through an event subscription); a fact the snapshot
lacks is `EXTERNAL_CHECK_UNAVAILABLE` (warning), never a pass. *Confidence: high.*

## 4. Per issue

Format: options · convergence · direction · confidence · what would change my mind.

**00 — The model.** *Options:* one kind, parent authoritative; declared kinds; two relations +
project properties (all four); consume-only. *Convergence:* two relations, unanimously; the kind flag
rejected unanimously; Astra (repo) names the overloaded concept precisely — the project *root* is at
once a filesystem boundary, an id namespace, a configuration, an approval scope and a viewpoint.
*Direction:* §5. *Confidence: high.* *Changes my mind:* real users wanting the parent's team to *own*
a child's internal verdicts — then required policy (D5) must be shown insufficient before a kind flag
is reconsidered.

**01 — Mount and realization.** *Options:* mount wins; child wins at every depth (#68, on `dev`);
no content on the mount and no merge (all four); per-field precedence. *Convergence:* no merge; the
child owns zero-to-many L1s; creation scaffolds a real L1 (Sol, Astra ×2) or L0 only (Fable); Astra
(repo): create and *attach* are distinct operations, and attaching an existing project preserves its
L0 and L1 set. *Direction:* the mount is a `members` entry; `MOUNT_DECLARES_CONTENT` (warning, then
error); `doctor --fix` moves mount-level `publicInterfaces`/`trustedLinks` into the child's same-named
subsystem when it has none, else stops with the conflict listed; a flat child's subsystem is
`billing::billing` from the parent; `create --initial-subsystem`; a new `attach` verb for an existing
project. *Confidence: high.* *Changes my mind:* the doubled id proving unacceptable in exported
artifacts (probe P3) — then the L0 may name a *primary* subsystem for display only.

**02 — Identity and references.** *Options:* rigorous `super::`; root-invariant `::`; project-id
two-segment references (Fable); immutable id + alias + sigil (Sol, Astra ×2); opaque ids (rejected by
all). *Convergence:* stable project identity, no positional paths, exact pin matching by provider,
authored text never rewritten by the loading root, migration stops on ambiguity (Sol, Astra ×2:
never promote today's first-hit winner to an identity). *Direction:* declared slug `id`;
`<alias>::x`, alias = id by default, alias → producer id (D2, D3, D4); `DEPRECATED_REFERENCE_FORM`
for one release; `PROJECT_ID_COLLISION`, `LOCAL_ID_SHADOWS_PROJECT`, `DUPLICATE_SPEC_ID`; the same
resolver for `dependsOn`, call targets, trusted links, dispatch and parsed type references (Astra
repo: "generic/union types cannot be migrated by replacing a whole string"). *Confidence: high.*
*Changes my mind:* the corpus probe (P1) showing bare `core::x` inside children (the parent's
*internal* subsystem) dominates — then keep those ids as a second alias family for one more release.

**03 — Governance.** *Options:* isolation; inherited floor; override (today); explicit pinned policy
(Sol, Astra ×2). *Convergence:* the owner's configuration judges the owner's specs; the parent's
doctrine reaches a child only through something declared; disagreement is a finding. *Direction:*
D5. Project type and target language: explicit owner values copied once at scaffold. Pack doctrine
the child adds applies to the child; a required pack the child lacks is `POLICY_NOT_ADOPTED` in the
family run. *Confidence: high.* *Changes my mind:* an instance-wide mandatory doctrine — that is an
instance floor (`InstancePackPolicy`), a separate hierarchy, and coexists.

**04 — One edge, one verdict.** *Options:* repaired union (#68); parent as sole judge; consumer's
project as sole judge + composed family run (all four); pins only. *Convergence:* one judge per
edge; composition never re-judges; evidence selection must be explicit, not conditional (Astra repo
P6); a structured resolver result before any severity (Astra repo). *Direction:* `validateProject` /
`validateFamily` (§5); owner verdict lock-defined, no discovery; composition findings only in a
family run; resolver results `resolved | missing | ambiguous | unavailable | forbidden` carried on
every finding with owner, call site, canonical target and input digest; code conformance per owner,
cross-mount imports judged by the importer in the family run and `CROSS_PROJECT_IMPORT_UNJUDGED`
(notice) standalone; nothing infers "resolved" from the absence of a code. Stage 1 closes P4 and the
reach ordering on the legacy path. *Confidence: high.* *Changes my mind:* nothing on the invariant.

**05 — Contracts and pins.** *Options:* per-producer snapshot digest (Fable); per-imported-interface
lock (Sol, Astra ×2); versioned contracts; no pins. *Convergence:* a lockfile per consumer keyed by
provider identity, `used` granularity, undeclared = error, unused = notice, family surface retired,
one mechanism for family peers, foreign imports and hosted relations; the digest covers contract
semantics (interface, type closure, guarantees, transport, boundary eligibility), not timestamps or
unrelated specs (Astra ×2). *Direction:* `externals.lock.yaml` with per-producer content digest and a
`used` map; snapshots carry stereotype and transport (D13); freshness per used entry; semantic
compatibility with unknowns failing closed; `externals pin | status | prune`; `doctor --fix` converts
`.wai/surfaces/` pins keyed by producing project id, stopping on ambiguity. Stage 1 fixes the
re-pin/freshness mismatch on today's store. *Confidence: high.* *Changes my mind:* the compatibility
codec proving hard for non-REST transports — then per-used-entry digest equality for those.

**06 — The child's own root.** *Options:* flatten; opaque delegate; member by reference with briefs
composed at the member's root (all four). *Convergence:* federate the read models, keep writes local;
no cascade; `generate` never repairs configuration (Astra repo). *Direction:* member node listing agent
ids resolved live; `sdd_get_agent_brief('billing::x')` composes at the member's root and names the
owner project, writable scope and selected inputs; status per member from the member's root, with an
explicit denominator; `lock` never enters a member at any depth; `generate --family` explicit and
listed. *Confidence: high.*

**07 — Approval.** *Options:* transitive lock; rolled-up digests; per root + pins + policy (Fable);
project + composition subjects (Sol, Astra ×2). *Convergence:* per project, never written by the
parent, composition explicit and transitive by hashing; the current `currentChildPins` copies a
StateId without verifying the child still matches it (Astra repo). *Direction:* D6 — composition
subjects, gate identity over all declared inputs, lock format versioned (`children` read, `members`
written), `requireApprovedMembers`, `MEMBER_UNAPPROVED`/`MEMBER_DRIFTED`; status prints the pin tree
with `approved | moved | never`; approval preflight already runs at settled strictness
(`src/commands/lock.ts:26-30`). *Confidence: high.* *Changes my mind:* a requirement that a platform
lead approves a member *from* the parent — then it is a member-bound operation under the member's
permission.

**08 — Repository layouts.** *Options:* submodule-only; lift containment for members (Sol); contain =
inside, consume = anywhere (Fable); explicit workspace binding (Astra ×2). *Convergence:* location is
not identity; approval and commit pins distinct; backup must enumerate the family through the same
resolver as validation and fail a claimed full backup on an unavailable member (Astra repo).
*Direction:* D7; stage 1 removes the `lock.json` exclusion and makes `exportSpecTree` report skipped
members; hosted `commitProject --family` stages every member `.wai/` in the same repository until
members have their own git binding. *Confidence: high.*

**09 — Hosted.** *Options:* keep scopes and finish the UI; members as records (all four);
relation-only families. *Convergence:* members are records; confinement is a property of the
binding; every operation classified, unclassified refused; audit names the owner and the initiating
composition; ancestry is not authorization. *Direction:* stage 1 — discovery after the reach gate,
containment decided against the owning root, the announcement in-band (`sdd_get_status → family`)
because today it goes to the startup channel of a per-request server (`src/mcp/server.ts:1660-1681`),
the three refusal sets collapsed into a declared `scope` per tool; last stage — member records with
`parentProjectId`, explicit grants recorded at upgrade, own permissions/audit/git/UI. *Confidence:
high on staging, medium on the grant model.* *Changes my mind:* the RBAC probe (P4) showing a
project → member rung breaks a unit-level "no" — then members are placed in units like any project.

**10 — Migrations.** *Options:* per-parent rewrites (today); family-wide dry-run-first, refuse when
incomplete (Fable); plan/apply with per-owner patches, pending when owners are unavailable (Sol,
Astra ×2). *Convergence:* plan first; move is free; alias rename is parent-local; id rename is a
breaking identity migration; detach/adopt are relation edits; internalize any number of subsystems
with an explicit destination for child-owned metadata (Astra repo: today it deletes the child's
whole `.wai`, `provision.ts:465`); externalize must rewrite *outgoing* references too (P7). *Direction:*
Fable's verb table with Sol/Astra's plan output (`--report` writes per-owner patches, unavailable
owners listed, no partial success claimed); parsed reference positions, never whole-string equality.
*Confidence: high.* *Changes my mind:* R4 read to forbid named migrations writing into members
(decision 8) — then every migration emits patches, which is Sol's cross-repository mode everywhere.

## 5. Recommended model

The full statement is the proposal; this is the page.

**A project is the unit.** `.wai/project.yaml` declares an immutable slug `id` (display `name`
unchanged), its configuration, its adopted `policy.profiles`, its `members` (contains) and its
`externals` (consumes). A subsystem is a level *inside* a project. A mount is a `members` entry —
`billing: services/billing` in the short form, `{ project, path }` in full; alias = id by default. No
L1 content on a mount; no merge; a flat child's subsystem is `<id>::<subsystem>` from the parent.

**References name projects.** `x` is mine; `<alias>::x` is a member below me or a declared external —
and inside a family, a sibling or my parent through *my own* alias, which maps to the producer's
project id. Two segments, today's id characters. A producer may declare an L0 export at
`audience: project` as a stable alias over a published component. No root anchor, no `super`, no
leading `::`; old forms load with a notice for one release and `doctor --fix` rewrites them. Save
strips only the file's own prefix; authored text round-trips.

**One judge per edge; composition is explicit and asked for.**

```
validateProject(P):                       # the owner's gate — pure in P's files; no discovery
  cfg     = P.config ⊔ adopted policies (a floor P may only tighten, else POLICY_LOOSENS)
  inputs  = P.externals.lock              # never the live tree, never an ancestor walk
  issues  = rules(P.tree, cfg, inputs, P.approval)
            every finding carries: owner, call site, canonical target, resolver result, input digest
  return issues                           # + a static hint when an externals lock exists

validateFamily(root):                     # `validate` at a parent; `validate --family` at a member
  reach   = must be granted before any read (hosted: the credential's; local: the walk-up is explicit)
  results = { validateProject(M) for M in root ∪ members* }
  compose = for each external E of each M whose producer is a selected member or reachable:
              compare(lock.used[E], selected surface of E)
              → EXTERNAL_INCOMPATIBLE (error) | EXTERNAL_DRIFTED (notice) | EXTERNAL_CHECK_UNAVAILABLE (warning)
  family  = MEMBER_NOT_FOUND · PROJECT_ID_COLLISION · POLICY_NOT_ADOPTED · MEMBER_UNAPPROVED · MEMBER_DRIFTED
            · cross-mount import edges judged by the importer
  return prefix(results) ∪ compose ∪ family
```

`resolveThroughParent`, the resolution-failure family, `surfaceResolved` and the mount-pool lookup are
deleted when this lands. `--ci` fails on errors and unwaived warnings as today. No `--frozen`.

**Governance by adoption.** Pinned policy profiles adopted by the child, required by the parent
(`composition.requirePolicies`), written into a new member once at creation; an adopted profile is a
floor. Project type and target language are owner values, copied at scaffold.

**Approval per project, transitive by hashing.** The gate identity is tree ⊕ doctrine ⊕ externals
lock ⊕ adopted policies ⊕ each direct member's composition subject. The lock records own spec
digests, the external and policy digests, and members' composition subjects. `requireApprovedMembers`
makes the parent's lock refuse on an unapproved or drifted member. A parent lock writes nothing
below itself. The approval certifies the design under those inputs; code-conformance results are
recorded beside it with the analyzer identity.

**Derived outputs by reference.** The parent's topology lists member agents by id; briefs compose at
the member's root and name the owner, the writable scope and the selected inputs; status per member
from the member's root.

**Hosting.** Stage 1: discovery after the reach gate; containment against the owning root; every tool
declares `scope: tree | record`, undeclared refused; `sdd_get_status → family`. Last stage: member
project records with `parentProjectId`, explicit family grants recorded at upgrade equal to today's
reach, own permissions, audit (owner + initiating composition), git binding, approval page and UI
crumb; a hosted relation is an external with `source: hosted`; relation health = `externals status`.

**Layouts.** Members contained (monorepo, submodule); side-by-side consumption via `externals` with
`path:`; a side-by-side *member* only through an explicit local workspace descriptor, later.

**Migrations.** Family-wide, plan-first, refuse when a project to rewrite is absent: `create`,
`attach`, `externalize` (inbound *and* outbound references), `internalize` (all subsystems, explicit
destination for child metadata), `move` (free), `rename` (id change), `detach`, `adopt`.

**Worked example — Platform / Billing / Payments / Shipping.**

Platform: `id: platform`, `members: { billing: services/billing, shipping: services/shipping }`,
`composition.requirePolicies: [acme/service-baseline@P1]`. Billing: `id: billing`,
`members: { payments: payments }`, subsystem `billing` publishing `invoice_portal` (loads as
`billing::billing` from Platform). Payments: `id: payments`, a leaf. Shipping: `id: shipping`,
`policy.profiles: [acme/service-baseline@P1]`, `externals: { billing: {}, platform: {} }` (alias =
producer id), `dispatch_adapter` (Adapter, subsystem `dispatch`) with
`dependsOn: [billing::invoice_portal]` and a call step `billing::invoice_portal.createInvoice` — the
same string from every root. After `wairon externals pin` at Shipping:
`.wai/externals/billing.yaml` (entries with stereotype and transport, methods, type closure) and
`.wai/externals.lock.yaml` with `billing: { digest: 9c1…, used: { invoice_portal: { createInvoice } } }`.

| From | What runs | Verdict on `dispatch_adapter → invoice_portal` |
|---|---|---|
| Shipping, cloned alone | `validateProject(shipping)` | Adapter ✓, `invoice_portal` pinned as a Portal ✓, `createInvoice` used ✓ → clean; missing `externals.billing` → `EXTERNAL_UNDECLARED`. Identical with the family on disk: no discovery. |
| Shipping, `validate --family` (family on disk, reach granted) | Shipping's run + the composition against live Billing | the same owner findings; plus `EXTERNAL_INCOMPATIBLE` if Billing's live `invoice_portal` no longer has `createInvoice`; `POLICY_NOT_ADOPTED` if Shipping dropped the required profile |
| Platform | `validateFamily(platform)` | Shipping's run verbatim under `shipping::`, the composition findings, the family checks — one judgement of one edge, reached from three roots |
| Billing | `validateProject(billing)` | nothing: Billing does not know Shipping. `wairon externals consumers billing` at Platform and hosted relation health list the inbound edge, with their search coverage. |

Approvals: Payments — its specs, policies, inputs; Billing — its specs, policies and
`members.payments` (Payments' composition subject); Shipping — its specs, policies and
`externals.billing: 9c1…`; Platform — its specs, policies and the composition subjects of Billing and
Shipping, hence Payments transitively.

Billing renames `createInvoice → issueInvoice`: Billing validates clean and re-locks (its own gate;
it cannot know Shipping); a configured release-compatibility check against its last published
surface reports the removal. Shipping alone still passes — its declared input did not change.
Shipping with `--family`, and Platform: `EXTERNAL_INCOMPATIBLE @dispatch_adapter` ("`createInvoice`
no longer on `billing::invoice_portal`; `issueInvoice` added"). The Shipping team fixes the call,
runs `externals pin` (digest → 4d0…) and re-locks; Platform's lock then reports `billing: moved`,
`shipping: moved` and, with `requireApprovedMembers`, refuses until both are re-approved. Hosted, the
Shipping → Billing relation turns red with the same message. If Platform renames its alias `billing`
to `accounts`, Shipping changes nothing — its alias maps to the id. If Billing keeps `createInvoice`
as a deprecated method, Platform stays green while Shipping migrates.

**Commitments.**

| | | |
|---|---|---|
| R1 one verdict per edge | keep | one judge; the only cross-root difference is an explicitly scoped composition finding that only a family run produces |
| R2 child first-class | strengthen | validates alone against declared inputs, with no discovery |
| R3 parent first-class | keep | composed validation, canvas, approval tree, delegation by reference; the parent admits, it does not re-govern |
| R4 no side-effect writes | strengthen | includes the transitive init/generate cascade; named migrations are the one exception |
| R5 authoring round-trips | keep, simplify | the canonical form is root-invariant; save rewrites nothing |
| R6 confinement | reframe | a credential names a project; containment is the owning root's property; reach is checked before any read; family reach is a recorded grant |
| R7 no softening by location | keep, by construction | the owner gate is a pure function of the owner's files and lock |
| R8 layouts | weaken honestly | side-by-side *members* need an explicit local workspace; side-by-side *consumption* is first-class |
| R9 nesting | keep for layout | ids two-segment; every rule at every depth, including loader diagnostics |
| R10 proportional cost | strengthen | a child never loads its family; the family loads each member once |
| R11 predictability | keep | `project.yaml` and the lock say, from files alone, what a reference points at, who judges it and against which inputs |

**The four fixes merged in #68.**

| Fix | Kept? | Under the model |
|---|---|---|
| 1 resolve-through-parent softening closed (resolution-failure trigger, stricter-of-both, give-way) | yes, until the composed run | stage 1 closes its two remaining defects (discovery before reach; P4); P6's conditional evidence is documented, not patched; its tests become `location-independent` |
| 2 flat child at every depth (`qualifySubsystemRef`) | yes, until the no-merge loader | moot once the merge goes; its tripwire becomes `depth-invariance` |
| 3 `qualifyDeclaredId`, `--ci` draft waiver, Specialist matrix | yes | "a declaration never root-anchors" is what the new loader generalises; the other two are unrelated to chaining |
| 4 reach gate in `resolveChainingParent`, landscape tools refused, read classification | yes, extended | the gate is moved ahead of discovery on every path; the refusal sets collapse into a declared `scope`; the classification test becomes "every tool declares a scope" |

## 6. Migration and staging

Each stage ships alone, leaves every existing tree valid, and is proved by the named properties
(tests over the Platform family fixture from both scopes, plus the hosted binding matrix).

| Stage | Changes | For existing trees | Proves it |
|---|---|---|---|
| **1 — correctness on the current model** (new) | mount-branch loader diagnostics qualified into the mount; containment decided against the owning root on every path; discovery after the reach gate on the validation path; pins matched by `(provider, entry)` — ambiguity is a finding, not a first hit; freshness compared on content, and `surface pin` repairs it; gate identity includes stored surfaces (algorithm `sha256+doctrine+inputs`); externalize rewrites the moved subtree's outgoing references; `exportSpecTree` reports skipped members and refuses a claimed full archive; the `lock.json` exclusion removed; `sdd_get_status → family` in-band; every hosted tool declares `scope` | verdicts unchanged except where they were wrong; **every lock reads stale once** (re-lock); hosted git-backed projects start committing `lock.json` | `scoped-diagnostics-kept`, `containment-same-from-every-root`, `no-read-before-reach`, `no-first-hit`, `repin-repairs-freshness`, `gate-sees-inputs` (P2 as a test), `externalize-keeps-outgoing`, `archive-complete-or-refused`, `lock-reaches-remote`, `confinement-is-total`, `announced` |
| **2 — identity and declared externals** | `project.yaml id` (defaulted from `name` slugified, reported when ambiguous); `externals` + `externals.lock.yaml` with per-producer digests, `used`, stereotype/transport facts; `EXTERNAL_UNDECLARED` (notice → error next release); `DEPRECATED_REFERENCE_FORM`; the owner-aware project graph built beside `SpecIndex` with a compatibility projection | `doctor --fix` converts `.wai/surfaces/*.yaml` pins into `externals` keyed by producing project id, stopping on ambiguity; nothing else changes | `pin-is-a-projection`, `stale-only-when-used-changes`, `live-and-snapshot-agree` (P8 as a test), `undeclared-is-an-error-everywhere`, `graph-projection-equals-index` |
| **3 — loader without position** | mounts read from `project.yaml members` (L1 `projectPath` still accepted); no merge, no root anchor; `<alias>::x`; `LOCAL_ID_SHADOWS_PROJECT`, `PROJECT_ID_COLLISION`, `DUPLICATE_SPEC_ID`; project node in the canvas | `doctor --fix` at the top moves mount declarations, rewrites references family-wide (refuses and lists absent members), moves mount-level L1 fields into the child or stops on conflict; flat children's subsystem ids become `id::sub` | `root-invariance`, `writer-is-inverse` (text equality), `depth-invariance`, `shadowing-reachable`, `mount-carries-no-content`, `alias-rename-touches-no-sibling` |
| **4 — composed validation** | `validateProject` / `validateFamily`; owner gate lock-defined with no discovery; composition findings in family runs only; resolver results on findings; policy adoption + `requirePolicies`; per-member approval context; cross-mount imports judged by the importer; `resolveThroughParent` and its codes deleted | behavioural: children that passed only through a lenient parent fail; children whose pin hid a revoked publication get `EXTERNAL_INCOMPATIBLE` in the family run; old and new evaluators run side by side for one release (`validate --legacy`) | `one-judge`, `location-independent`, `no-discovery-standalone`, `no-softening-by-location`, `same-config-both-roots`, `renamed-method-seen-from-parent`, `approval-context-both-roots`, `unrelated-failure-changes-nothing` (P6 as a test) |
| **5 — approval and derived outputs** | lock records externals/policy digests and members' composition subjects; `requireApprovedMembers`; no cascade (`generate --family` explicit); member node by reference; briefs through the mount; status per member | `children` read, `members` written; teams relying on the cascade run `generate --family` once | `parent-lock-writes-nothing-below`, `pin-chain`, `require-refuses`, `brief-through-mount`, `status-agrees`, `context-proportional` |
| **6 — migrations** | plan/apply; `attach`, `rename`, `detach`, `adopt`; multi-subsystem `internalize` with a metadata destination; nested subjects by id; MCP tools gain `dryRun` | none | `atomic-or-nothing`, `family-consistent`, `move-is-free`, `detach-then-adopt-is-identity`, `externalize-updates-siblings` |
| **7 — hosting: members as records** | `parentProjectId`; grants recorded at upgrade equal to today's reach; member git binding; UI crumb and family canvas; relation health = `externals status`; narrowed tokens rewritten to member ids | registry scan registers every mount; `platform::billing` → `billing` (documented widening *within* the member only) | `member-is-a-project`, `no-widening`, `audit-names-the-member`, `family-commit-covers-members`, `hosted-and-family-agree` |
| **8 — optional** | local workspace descriptor for side-by-side members; spec fragments; `validate --at-approval` | none | `side-by-side-is-consumption`, `containment-unchanged-for-members` |

Order rationale: stage 1 changes no schema and fixes what is wrong today; 2 and 3 change files but
not verdicts; 4 changes verdicts but not files; 5–7 are additive. A release note per stage lists the
deliberate behaviour changes (stage 1's forced re-lock and committed `lock.json`; stage 3's doubled
subsystem ids and reference rewrite; stage 4's newly failing children).

**Sizing the migration (concern a).** This repository has no `projectPath` mount and two `super::`
references, so nothing here sizes stages 3–4. The cheapest honest measure is a read-only report, run
at the top of every real family the maintainer has (private trees, the hosted instance's project
directory): `wairon doctor --report chaining` counting mounts and depth, flat children,
mount-level `publicInterfaces`/`trustedLinks`, reference forms (`super::`, `::`, bare `a::x` with `a`
a root subsystem, bare `a::x` with `a` a mount, three-segment ids), pins and how each reference
matched them (unique / ambiguous / none). Its output is exactly stage 3's dry run, so building it is
building `doctor --fix --report`. Second measure: a committed reference family (the Platform fixture,
three levels, one flat and one non-flat child, one pinned sibling) that every stage's properties run
over, so "breaks every chained tree" becomes a number over a known tree before it is a number over
users'. Third: stage 4 ships `validate --legacy` for one release so a team can diff old and new
verdicts on its own tree before the default flips.

## 7. Risks and unknowns — with probes

| # | Risk | Probe / prototype |
|---|---|---|
| P1 | **Migration size unknown** (concern a). | The `doctor --report chaining` counter over the maintainer's real families; the committed reference family; `validate --legacy` diffs. Cheap: a script over `dependsOn`/`targetComponent`/`subsystem`/`trustedLinks` fields plus `.wai/surfaces/`. |
| P2 | **Renames inside members break siblings** often enough that D4's optional L0 export should be the default. | Count, in the same report, references whose target is a published component and whose producer is another project; ask the two largest families how often those components were renamed in the last year. |
| P3 | **`billing::billing` leaks into exported artifacts** (share snapshots, OpenAPI operation ids, canvas labels). | Grep the surface/OpenAPI/share fixtures for subsystem ids; decide display collapsing before stage 3. |
| P4 | **Hosted permission change** (concern d). | Prototype `parentProjectId` + a grant row behind a flag; run the RBAC matrix; confirm a member's "no" at its unit still wins. Scheduled last (stage 7). |
| P5 | **Losing the child-side live warning** (D1) hurts monorepo teams (concern b's mirror image). | Ship the static hint and `validate --family` in stage 4; count how often the hint is followed in the hosted audit log; if never, consider a per-project `validate.family: true` opt-in that a team declares in its own `project.yaml` (still no ambient discovery: the walk is declared). |
| P6 | **Forced re-lock instance-wide** when the gate identity gains inputs (stage 1). | Same precedent as `sha256+doctrine`: a release note and `wairon status` saying why each lock reads stale; hosted admin API lists affected projects before upgrade. |
| P7 | **Committing `lock.json` on hosted repositories** that never carried it surprises teams whose review flow assumed it was local. | Behind `git.commitLock` defaulting to true with a one-release warning when a tracked exclusion is found; the mirror sync already scopes to `.wai/`. |
| P8 | **`project.yaml` growth** (concern c). | The shorthand forms are tested as the only thing a plain monorepo needs: `members: { billing: services/billing }`, no `externals` until a sibling is referenced, the lock generated. A fixture with exactly that file must validate. |
| P9 | **Semantic compatibility weaker than it looks** for non-method surfaces (dispatch, auth, basePath, type closure). | `satisfies(lockedEntry, liveEntry)` over `SurfaceContractEntry`, run against `tests/core/surface-*.test.ts` fixtures; anything not comparable is `EXTERNAL_CHECK_UNAVAILABLE`. Half a day. |
| P10 | **Containment against the owning root** changes what loads for a family that relied on a mount reaching a sibling directory of its parent. | The report counter lists mounts whose resolved directory lies outside the declaring project; expected zero; each one is a `detach` candidate. |
| P11 | **N member contexts cost more than one federated context** (R10). | Time `validate` at the top of a three-member fixture before/after stage 4. |
| P12 | **Windows paths** in `path:` and any workspace descriptor. | Extend the containment tests to drive-letter and UNC forms and to case; run the family fixture on Windows CI. |
| P13 | **Id uniqueness hosted**: two registered projects whose slugified `name` collide. | Enumerate hosted records' names before stage 2 defaults `id` from `name`. |

## 8. Decisions only the maintainer can make

Consolidated from the four sources' question lists, the lead engineer's concerns and §3. Each:
options → recommendation. **Blocks stage 1** is marked; everything else blocks stage 2 or later.

1. **Gate identity gains inputs, forcing one re-lock everywhere.** Accept / defer to stage 5 (leaving
   P2 open). → *Accept in stage 1; precedent exists.* **Blocks stage 1.**
2. **Hosted git backing commits `lock.json`.** Remove the exclusion / keep the approval local on
   hosted. → *Remove it; the approval-baseline design already promises a committed record.*
   **Blocks stage 1.**
3. **Containment is decided against the owning root on every path.** Owning root / bound top root
   (today's loader). → *Owning root; a mount that only resolves from the top is a `detach` case.*
   **Blocks stage 1.**
4. **The legacy fallback stays until stage 4.** Keep with stage-1 fixes / delete now (children lose
   parent resolution until stage 4). → *Keep.* **Blocks stage 1.**
5. **Composition findings at a member.** Never on the default path (recommended) / on by default
   when reachable (v1) / per-project opt-in. → *Never on the default path; `validate --family`
   explicit; revisit with probe P5.*
6. **Project identity form.** Bare slug / dotted namespace / free `name` only. → *Slug required, dots
   allowed; `name` stays display.*
7. **Reference syntax.** `alias::x` / `@alias::x` / `dep:alias/x#m`. → *`alias::x`.*
8. **Alias table.** Mandatory / optional with alias = id. → *Optional; the maps are the table; alias
   → producer id.*
9. **What a member may consume from a sibling.** L1-published components (today) / only L0 exports at
   `audience: project` (Astra repo) / L1 with an optional L0 export alias (D4). → *The third.*
10. **What a lock certifies.** Design under declared inputs / design + code conformance. → *Design;
    code results recorded beside it with analyzer identity.*
11. **`--ci` at a parent on an unapproved or drifted member.** Fail / report / policy. →
    *`MEMBER_UNAPPROVED`/`MEMBER_DRIFTED` as warnings; `requireApprovedMembers` off for one release.*
12. **Where the mount is declared.** `project.yaml members:` / keep the L1 file. → *Move it; both load
    for one release; the shorthand keeps the monorepo file tiny.*
13. **May family-wide migrations write into members?** Yes, named and dry-run-first / never. →
    *Yes; R4's one sanctioned exception, refused when incomplete.*
14. **Governance mechanism.** Implicit inherited floor / adopted pinned profiles required by the
    parent. → *Adopted profiles, scaffolded at creation.*
15. **Approval transitivity.** One-hop content pins / composition subjects / recursive parent lock. →
    *Composition subjects.*
16. **Side-by-side members.** Now via a workspace descriptor / defer. → *Defer to stage 8.*
17. **Spec fragments** (one project over several directories). → *Defer; measure demand.*
18. **Hosted family reach.** Automatic parent → member floor / explicit grants. → *Explicit grants,
    recorded at upgrade equal to today's reach.*
19. **Compatibility semantics.** Digest equality per used entry / signature-level superset with
    unknowns failing closed. → *The latter.*
20. **Doubled subsystem id `billing::billing`.** Accept / let the L0 name a primary subsystem for
    display. → *Accept; collapse in the canvas only.*
21. **Create versus attach.** One verb / two. → *Two: `create` scaffolds, `attach` adopts an existing
    project and preserves its L0 and L1 set.*
22. **Duplicate project instances in one composition.** Reject / instance ids. → *Reject initially.*
23. **Is the lost commit `116d5f7` still wanted?** → *It is on `dev`; its shadowing half survives as
    `LOCAL_ID_SHADOWS_PROJECT`; its `mountRealization` half is superseded by "no merge".*

## 9. Claims checked against the code

Confirmed unless marked otherwise. Line numbers are on `dev` at `e7d30d7`. Confinement findings are
stated at design level; the specifics went to the maintainer directly.

**PR #68, as described by the lead engineer.**
- (1) Only `RESOLUTION_FAILURE_CODES` trigger the walk (`src/core/validation.ts:66-73, 503-505`); the
  parent-side run judges under `stricterSeverities` (`:100-115, 580-584`); a child finding gives way
  only to an equal-or-stricter parent finding on the same code and spec, or to a resolution failure
  the parent did not repeat (`:512-517`); tests `tests/core/resolve-through-parent.test.ts`.
  **Qualification:** every parent finding the child does not already carry at ≥ severity is *added*
  (`:520-524`) — the union that makes evidence conditional (Astra P6).
- (2) `qualifySubsystemRef` maps a bare reference equal to the mount's local name to the mount at any
  depth (`src/core/specs.ts:153-156`); `mergeMountRealizations` (`:401-423`) and the depth-0
  `rootSubsystems` anchor (`:789-791`) remain.
- (3) `qualifyDeclaredId` (`:129-142`); `--ci` waives only the draft codes (`src/commands/validate.ts:43-49`);
  Specialist → Registry/Actor forbidden (`src/core/rules/stereotype-deps.ts:209-215`).
- (4) `parentReach` derived from the credential and handed to the binding (`src/server/request.ts:669-676`);
  the walk never climbs above `topRoot` (`validation.ts:558-566`); landscape tools in the refused set
  (`request.ts:160-165, 203-209`); classification explicit (`request.ts:258+`).
  **Qualification (Astra §09, confirmed):** on the validation path `findChainingParent` runs before
  the reach check (`validation.ts:504` vs `:556-557`); `resolveChainingParent` (`specs.ts:2934-2943`)
  is the gated wrapper and validation does not use it.

**Astra (repository) — corrections to r2.**
- 1 lenient-parent regression fixed — confirmed (above).
- 2 flat grandchild and declaration shadowing fixed — confirmed (`specs.ts:129-156`); the reference
  anchor and the merge remain, as it says.
- 3 the generate cascade is transitive — confirmed: `runGenerate` recurses into each child's
  `runGenerate` (`src/commands/generate.ts:105-114`); the CHANGELOG's "each direct child" understates it.
- 4 the gate hash already digests descendant content — confirmed: `loadTree()` uses the default
  recursive loaders (`src/core/statehash.ts:57-66`); only descendant *approval* is unbound
  (`src/core/approval.ts:211-222`).
- 5 confinement narrower than the statement's guarantee — confirmed at design level: the loader
  checks against the bound root (`specs.ts:954-968`, by design per its comment), the writer against
  the owning root (`:261-272`), the hosted mount resolver per hop (`src/server/projects.ts:213-215`);
  the check is lexical (`specs.ts:222-226`).
- 6 a tree archive is conditional — confirmed: `listChainedRoots` skips silently and stops past
  depth 32 (`specs.ts:352-393`); `exportSpecTree` filters roots without `.wai` (`src/core/treetransfer.ts:237`).

**Astra (repository) — probes.** Three re-run here with a throwaway script (`npx tsx`, temp dirs);
the rest confirmed by reading.
- P1 re-pin keeps stale — **re-run, reproduced**: two pins `fresh`; a private parent component → both
  `stale`; a second pin writes 0 files; still `stale`. Cause: `surfaces.ts:336-359` versus `:627-651`.
- P2 gate identity omits surfaces — confirmed: `loadTree()` has no surface input (`statehash.ts:57-66`).
- P3 containment depends on the loading root — confirmed by reading (design level, above).
- P4 nested loader diagnostics dropped under scope — **re-run, reproduced**: unscoped
  `SUBPROJECT_NOT_FOUND@extra`; scoped to the mount: no finding, `valid: true`. Cause: bare
  `subproj.subsystemId` on the mount-branch issues (`specs.ts:793-796, 981-986`) and the scope filter
  (`src/core/rules/index.ts:251-273`). The CHANGELOG's "a loader refusal is anchored to its spec id,
  qualified into the mount" covers parse errors, not the mount guards.
- P5 provider identity discarded — confirmed: `resolveSurfaceRef` keeps only the last segment and
  returns the first pool hit (`src/core/rules/namespace.ts:37-53`).
- P6 unrelated failure changes another edge's evidence — confirmed (`validation.ts:503-524`).
- P7 externalize misses outgoing references — **re-run, reproduced**: the moved Adapter's
  `dependsOn: [family-portal]` loads as `moving::family-portal`, `INVALID_DEPENDENCY_REFERENCE`.
  Cause: the rename map covers the moved subsystem's own ids only (`src/core/provision.ts:372, 477-500`)
  and the rewrite excludes the moved subtree (`:409`).
- P8 surfaces omit boundary facts — confirmed: snapshot path checks only that the source is an
  Adapter (`stereotype-deps.ts:61-79`); live path adds `CROSS_SUBSYSTEM_PRIVATE_ACCESS` /
  `CROSS_SUBSYSTEM_TARGET_NON_PORTAL` (`:133-150`); `projectSubsystemSurface` exports Observers.
- "`.wai/lock.json` added to `.git/info/exclude`" — confirmed (`src/git/adapter.ts:97-105`,
  `src/git/orchestrator.ts:28`); contradicts `docs/design/approval-baseline.md:57-69` and this
  repository's own `.gitignore:48`.
- "177 tests across 11 files pass" — the eight chaining-related files I ran (`resolve-through-parent`,
  `chained-subsystem`, `projectpath-containment`, `subsystem-migration`, `approval`, `surfaces`,
  `surface-churn`, `server/subproject-binding`) pass: 109 tests. Not disputed.

**Fable 5.1 (r1-era) — status of its seven corrections on `dev`.**
1 softening — fixed by #68. 2 `116d5f7` would not close the depth-two split — superseded: #68 added
`qualifySubsystemRef`, the half it named. 3 the cascade initializes children — still true, and
transitive. 4 `super::` over-climb clamped silently — still true (`specs.ts:92-99`). 5 first-hit pins —
still true. 6 two write paths read the child's L0 — still true (`specs.ts:1516`). 7 one-hop approval
pins — still true (`approval.ts:217`). Its assumption that `project.yaml name` can be a slug —
contradicted (`src/models/project.ts:255`); its "the resolver already walks unit → project; add
project → member" — understated (`src/server/permission_resolver.ts:78-88`, no project → project rung).

**Outside analysts' assumptions (chat answers) — unchanged from v1, re-verified.**
Sol: the loading root's configuration governs the family — confirmed (`validation.ts:458-476`). Sol
and Astra: hosted models only the top root — confirmed (`src/server/types.ts:1034-1042`; narrowing on
the token `:206-211`). Sol's `@` and Astra's `dep:` contradict `SpecIdSchema` (`src/models/specs.ts:6`).
Units and relations share a landscape graph — confirmed (`src/server/landscape.ts`;
`ProjectRelationRecord`, `types.ts:729-741`). Astra (chat): approval preflight at settled strictness
already exists (`src/commands/lock.ts:26-30`); `LockOptions.recursive` is accepted and never read
(`lock.ts:38-39`); a parent suppression cannot waive a child's finding — partly true (per-spec
`lint.allow` is local; project-level severities crossed, now at the stricter of both).

**v1's own claims re-tested.** All hold except: v1 described the cascade as "each direct child"
(transitive); v1 treated fix 4 as closing discovery under a narrowed credential (the walk-up on the
validation path precedes the gate); v1 put composition findings on by default at the child (reversed,
§3 D1); v1 said the lock should *record* externals digests (it must *hash* them, fact 1).

**Things no source assumed that matter.**
- This repository does not dogfood chaining: no `projectPath:` mount in `.wai/specs`, two `super::`
  occurrences (the earlier `projectPath` grep hits are narrative text in implementation specs).
- `--ci`'s waiver list is closed (`validate.ts:43-49`): every new warning proposed here fails CI
  unless waived — the lever the model relies on.
- Approval digests already carry doctrine (`sha256+doctrine`, `statehash.ts:54`), so widening the
  gate identity to declared inputs is an extension of an existing, precedented mechanism.
- The announcement of chaining still goes to the startup channel of a per-request server
  (`src/mcp/server.ts:1660-1681`), reach-gated by #68 but not in-band.
