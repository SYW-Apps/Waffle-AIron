# Chained subsystems — problem statement

This document is self-contained. It describes an open design problem in wairon for
anyone asked to analyze it, with or without access to the repository. It reflects
wairon's `dev` branch on 2026-09-12 (release v5.1.1-dev.11). Statements about
current behavior come from reading the code and from small probe projects run
against it; evidence with file references is kept per issue under `issues/`.

**Revision 2 (2026-09-12).** Corrected after a review that checked the statement
against the code: how a child's findings combine with its parent's (§2 and issue 04),
what a parent's lock writes into a child (§2 and issue 06), two reference-resolution
details (issue 02), and how far approval pins reach (issue 07).

Contents: 1 What wairon is · 2 How chaining works today · 3 The problem · 4 Questions
any model must answer · 5 Issues 00–10 · 6 Commitments so far · 7 What a good
proposal looks like · 8 Glossary

---

## 1. What wairon is — only what this problem needs

wairon is a spec-driven development tool for AI-assisted software work. A system's
architecture lives in its repository as a **spec tree** (`.wai/specs/`, YAML). AI
agents author it through MCP tools; a human approves it; the code is then held to it.

**The levels.**

| Level | Spec | Holds |
|---|---|---|
| L0 | System | vision, boundaries, global requirements, target language |
| L1 | Subsystem | an isolated service: what it publishes (`publicInterfaces`), who it trusts (`trustedLinks`) |
| L2 | Component | one building block with a stereotype — Portal, Orchestrator, Supervisor, Actor, Store, Index, Registry, Adapter, Observer, Specialist — or a pattern (Repository, Gateway) that owns member blocks; `dependsOn` names collaborators |
| L3 | Interface | the contract: method signatures |
| L4 | Implementation | one realization of a contract: `sourcePath` to real code, bound technologies |
| L5 | Narrative | each method as numbered steps; a `call` step targets a real method of a declared dependency |

**The gate.** A validator judges the tree, and `validate --ci` fails a build on any
error or unwaived warning. It enforces stereotype doctrine (a Portal never depends on
a Store; only an Adapter crosses a subsystem boundary, and only into what the other
subsystem publishes), reference resolution, completeness, and code↔spec conformance
(named files exist, contract methods are realized, the import graph matches declared
dependencies, the call graph matches the narratives). A project's `.wai/project.yaml`
tunes it: rule severities, a project type, extension packs that add doctrine, and
suppressions.

**Approval.** `wairon lock` records a human's approval on the committed
`.wai/lock.json`: one digest per spec. A spec that is approved and unchanged counts as
settled and is judged at full strictness; anything edited since is reported as drift
and is judged as a draft, where completeness findings are warnings.

**Derived outputs.** From the tree wairon derives an agent topology (an agent per
component, live briefs an orchestrating agent delegates implementation with) and
**surfaces**: contract-grade snapshots of what a project or subsystem publishes (YAML in
`.wai/surfaces/`, with an OpenAPI codec), which other projects can import and validate
against.

**Two ways to run it.** Locally: a CLI and an MCP server over a working copy. Hosted: a
self-hosted multi-project server — projects on its disk, role-based permissions,
scoped credentials, audit, git backing, and a web UI with a canvas and a spec editor.
The same MCP tools serve both.

---

## 2. How chaining works today

An **internal** subsystem is an L1 spec in the project's own tree. A **chained**
subsystem (also called external, or a subproject) is an L1 spec in the parent — the
**mount** — carrying `projectPath: <dir>`. That directory is a complete wairon project:
its own `.wai/`, L0, configuration, approval, and possibly mounts of its own.

**Loading and ids.**
- The path must stay inside the parent's directory. The parent loads the child's specs
  recursively and prefixes every child id with the mount id and `::`; a mount inside a
  child prefixes again. A missing child directory is reported as an error, and the
  child's specs are then absent.
- The parent's loader never reads the child's L0 (two write paths read its name).
- If the child has a subsystem with the same id as the mount (a **flat** child), the
  parent merges the two into one subsystem record. Otherwise the mount and each of the
  child's subsystems (`<mount>::<id>`) are separate records. The merge only happens one
  level deep (issue 01).

**References** are written relative to the file's own tree: a bare id is local,
`super::x` climbs one tree, and `::x` is absolute from whichever root is loading. An id
whose first segment names a top-level subsystem of the loading root is treated as
already absolute. Writing a spec through the parent rewrites its references into
root-invariant `super::` paths (issue 02).

**Writing through the parent.** The MCP tools accept qualified ids at the parent
(`billing::invoice_portal`); wairon writes the file into the child's tree, stripping
the prefix and re-expressing implementation file paths relative to the child's root.

**Validation.**
- *From the parent*: one run over the whole family under the parent's configuration.
  The child's configuration is not read. The child's code is not checked against its
  specs; the child does that itself.
- *From the child*: under the child's configuration. A reference that a pinned surface
  covers is judged against the pin. If the run holds any finding from a fixed family of
  reference and boundary codes that no pin covers, and the parent is on disk — and,
  hosted, the credential reaches the top project — the top root is validated scoped to
  the mount chain under the top root's configuration. The child's findings in that
  family are replaced by the parent's and merged with the rest; the result records
  `resolvedThrough`. The family includes codes that fire on edges entirely inside the
  child, so a more leniently configured parent lowers or removes the child's own
  findings (issue 04). With no usable parent a reference keeps its raw verdict: an
  unresolved cross-tree warning that `--ci` does not waive.

**Surfaces.** A child runs `wairon surface pin` while its parent is on disk to store,
in its own `.wai/surfaces/`: the parent's **family surface** (what the parent publishes
to its family) and one **sibling surface** per other top-level subsystem of the parent
(its published Portals, Gateways and Observers). `wairon surface externals` reports each
pin as fresh or stale. A parent never writes surfaces into a child.

**Approval.** Each project root has its own approval record. The parent's digests
cover only its own specs and pin each direct child's approved state, the way a git
submodule pins a commit. Locking the parent never locks a child. Settledness is
computed per root.

**Derived topology.** The parent represents each child as one delegate "owner" agent;
the child builds its topology from its own subsystems. An unscoped lock at the parent
cascades into each direct child: it writes the child's project files when they are
missing and regenerates its skills, context files and guides (issue 06).

**Hosted.** A hosted project is a top-level root; a chained child is never a hosted
project of its own. A credential can be narrowed to `project::child`, which binds the
child's root; record-level tools are refused under that binding, while lock and tree
export/import act on the bound child. Permission checks and audit always use the top
project.

**Migrations.** *Create* adds a mount and scaffolds the child project. *Externalize*
moves an internal subsystem's specs into a new child. *Internalize* folds a flat child
back. *Move* relocates a child's directory.

**What already works — a proposal should not need to re-solve these.**
- A boundary edge between siblings, or from a child into its parent, gets the same
  verdict from both roots when the parent is reachable — under the top root's
  configuration (issues 03 and 04).
- Ids and implementation file paths round-trip when written through the parent.
- A mount cannot escape its parent's directory.
- Pins are pulled by the child; no surface is pushed into a child's tree. Derived files
  still are (issue 06).
- A narrowed hosted credential binds the child and cannot run record-level tools.
- Tree archives carry the whole family.

---

## 3. The problem: one set of specs, two scopes

A chained subsystem is one set of specs with two legitimate views.

**From the parent it is part of the system.** The parent's architecture extends through
the mount. The child's components are the parent's components under a namespace; an
edge between two children, or between a child and an internal subsystem, is an
internal edge of one system. The parent wants to validate, approve, visualize and
delegate across all of it as one architecture.

**From its own root it is a project.** It has its own L0 and can be developed,
validated, approved and released on its own schedule — possibly in its own repository,
possibly with no parent on disk at all. It may ignore its parent. It may depend on the
parent or on a sibling, which to it are external systems. And it is itself the root of
any children it mounts.

People work at both scopes — a platform team at the parent, a service team in the
child — locally and hosted, and the same person switches between them. Every capability
has to give an answer that is right from each scope and consistent across them.

**An example family**, used throughout:

```
platform/                          project "Platform" (the top root)
├── .wai/specs/
│   ├── core/          internal subsystem "core" — publishes core_portal
│   ├── billing/       mount "billing"  → services/billing
│   └── shipping/      mount "shipping" → services/shipping
└── services/
    ├── billing/                   project "Billing"
    │   ├── .wai/specs/
    │   │   ├── billing/   subsystem "billing" (same id as the mount: a flat child)
    │   │   │              — publishes invoice_portal
    │   │   └── payments/  mount "payments" → payments
    │   └── payments/                  project "Payments" (a grandchild of Platform)
    │       └── .wai/specs/payments/   subsystem "payments" (flat)
    └── shipping/                  project "Shipping"
        └── .wai/specs/dispatch/   subsystem "dispatch" (differs from the mount id)
                                   — dispatch_adapter calls billing's invoice_portal
```

One edge, `dispatch_adapter → invoice_portal`, three views:

- **Platform** sees `shipping::dispatch_adapter → billing::invoice_portal`, an internal
  edge between two parts of one system.
- **Shipping** sees a dependency on a sibling it does not contain, written
  `super::billing::invoice_portal` — an external system it may reach only through what
  Billing publishes.
- **Billing** sees an inbound consumer it may know nothing about.

Each view is legitimate. The issues below are about whether one model can serve all of
them without any of them silently being wrong.

---

## 4. Questions any model must answer

- **Identity.** Is a spec's identity relative to a root? What makes a reference mean
  the same thing from every root that can see both ends?
- **Judgement.** Whose rules judge an edge from a child into its parent or a sibling —
  the parent's, the child's, both? What happens when they disagree?
- **Dependency.** When the parent is not on disk, what does the child depend on: the
  live parent, a pinned contract, nothing?
- **Approval.** Whose approval covers a child's spec, and what does each approval
  promise?
- **Ownership of writes.** Who may change a child's specs and derived files, from where?
- **Kinds.** Is "chained subsystem" one concept or several — for example an internal
  subsystem; a *federated part* the parent owns and judges as its own; an *independent
  project* the parent only consumes through its published contracts, as a dependency
  rather than a part? Should the kind be declared?

---

## 5. Issues

Each issue lists what happens today, why it matters, and the open questions. The ids are
stable; analyses and proposals are filed under `issues/<id>-<slug>/`.

### 00 — The model: what a chained subsystem is

**Today.** One mechanism mixes two relationships. *Loading is federated*: the parent
reads the child's specs as its own, judges them under its own configuration, and can
reference anything inside them. *Governance is independent*: the child keeps its own
configuration, approval, agent topology and pinned contracts, and can be validated
without its parent. Nothing declares which relationship a mount means, so each
capability picks one: validation from the parent is federated, validation from the
child is independent with a fallback to the parent, approval is independent, the
parent's topology treats the child as an opaque delegate, and hosting treats the child
as part of the parent that can never be a project of its own.

The levels do not line up either. A child's L0 plays the role of the parent's L1, and a
child with several subsystems turns the mount into a subsystem that contains subsystems,
which the level model does not define.

**Why it matters.** Chaining is used for different intents: splitting one product across
directories or repositories for size or team ownership; composing products that are
released independently; consuming a shared library project. For the first, the parent
should be authoritative; for the others, the child should be, and the parent should see
only what the child publishes. A mount's path must lie inside the parent's directory, so
a project reused by two parents exists as two copies or checkouts.

**Open questions.**
- One concept, or declared kinds? What does each kind promise about loading, judging,
  approving, referencing and hosting?
- Can a project change kind over its life, and what does that migration look like?
- Can one project be a part of one family and a dependency of another?
- What should a child's L0 correspond to in the parent?

### 01 — Mount and realization: two specs for one subsystem

**Today.**
- The parent holds the mount: an L1 spec with an id, a path, and optionally its own
  description, published interfaces and trusted links. The child holds its own L0 and
  L1 subsystems. Nothing requires them to agree.
- For a flat child the loader merges the mount and the child's same-id subsystem, and
  the child's copy wins entirely: published interfaces or trusted links declared on the
  mount are silently discarded. When the ids differ (Shipping), both records exist — the
  mount as an empty subsystem `shipping`, the child's as `shipping::dispatch` — and
  anything declared on the mount binds to nothing, because the boundary rules key off
  each component's own subsystem.
- The merge works one level deep only. Payments, mounted inside Billing with a same-id
  subsystem, loads from Platform as two subsystems: an empty `billing::payments` and the
  real `billing::payments::payments`. Its components carry the first's prefix but point
  at the second.
- Creating a chained subsystem scaffolds the child project but no subsystem inside it.
  A component the child then authors against the mount id is scored and validated from
  the parent, but the child's own root shows no subsystem, 0% completion and no agent
  for it (issue 06).
- The parent never reads the child's L0, so the mount's description and the child's
  vision are unrelated texts.
- Folding a child back into the parent is only possible for a flat child.

**Why it matters.** There are two sources of truth for one subsystem. They are
reconciled by a naming convention that silently drops data, breaks at depth two, and
leaves the child's own root incomplete.

**Open questions.**
- Which side owns a subsystem's identity, published surface and trust — the mount, the
  child, or a split with explicit precedence?
- Should a mount carry anything besides a path?
- Should a child be able to present several subsystems to its parent, and at which level?

### 02 — Identity and references across roots

**Today.**
- A spec's id depends on the loading root: `billing::invoice_portal` from Platform,
  `invoice_portal` from Billing.
- `::x` means "x at whichever root is loading", so it changes meaning with the root. To
  keep references root-invariant, saving a spec through the parent rewrites each `::`
  reference into the equivalent `super::` path, even when a person wrote `::`.
- In Shipping, `::billing::invoice_portal` and `super::billing::invoice_portal` resolve
  to the same target from Platform and are not deduplicated.
- An id whose first segment names a top-level subsystem of the loading root is treated
  as absolute. That is what makes the flat merge work, but it also means a child
  subsystem that shares a name with one of the parent's top-level subsystems loads as a
  duplicate top-level subsystem instead of being reported as shadowing it. A fix for this
  was written but never merged.
- A sibling reference spells out the parent's mount ids (`super::billing::…`). Renaming
  or re-mounting Billing in Platform breaks Shipping's specs, and no migration rewrites
  references held in other chained children (issue 10).
- A reference checked against pinned surfaces is matched on its last segment only, and
  the first pin with a match wins, so two siblings that both publish a `portal` are
  indistinguishable. Shipping's `super::invoice_portal` (no sibling name) resolves
  against the pin from Shipping's root, but from Platform it names a top-level id that
  does not exist, and it is judged only against Shipping's pin, never against the live
  Billing (issue 04).
- Extra `super::` hops are clamped silently: `super::super::x`, written one level below
  the top, resolves to the top's `x` with no finding.

**Why it matters.** A reference should mean one thing. Today its meaning depends on the
loading root, the spelling, and whether a pin happens to match its last segment. Authored
text is rewritten, and a child's specs are coupled to how its parent names its mounts.

**Open questions.**
- Root-invariant relative paths, or a stable identity per project (a declared name that
  does not depend on where the project is mounted)?
- Should a child reference a sibling by the sibling's own identity rather than by the
  parent's mount id?
- One spelling per target? What should happen to authored text on save?
- How should a collision between a child's ids and its parent's be reported?

### 03 — Governance: whose rules judge a child's specs

**Today.**
- Validating from the parent applies the parent's configuration — severities, project
  type, packs and their doctrine, suppressions — to every spec in the family. The child's
  configuration is never read. In a probe, a child turned a rule off in its own
  configuration and validated clean; the parent reported the same edge, inside the
  child, as an error.
- When a child resolves through its parent, the *top* root's configuration judges the
  child's cross-tree edges. An intermediate parent's configuration (Billing's, for
  Payments) is skipped.
- Inheriting the project type into a child is approved in principle (inherit unless the
  child declares its own) but not fully designed.

**Why it matters.** A team's deliberate configuration silently does or does not apply
depending on where validation runs, and nothing reports the disagreement.

**Open questions.**
- Isolation (each project judges its own specs), inheritance (the parent sets a floor
  the child may only tighten), or override?
- What about doctrine from a pack the child applies and the parent does not?
- How should a disagreement be shown?

### 04 — One edge, one verdict: composing judgements across roots

**Today.** When the parent is reachable, a boundary edge between siblings or into the
parent now gets the same verdict from both roots. What still diverges:
- **The parent can soften a child's own findings.** Resolving through the parent is
  triggered by a family of codes, not by a resolution failure, and the family includes
  boundary codes that fire on edges entirely inside the child. Each child finding in
  the family is replaced by whatever the parent's run reports under the top root's
  configuration. In a probe, a child's Orchestrator depended on a Portal in another of
  the child's own subsystems: an error with the child validated alone, a warning once a
  parent configured to warn was on disk, and no finding at all when the parent turned
  the rule off. The child is judged more leniently with its parent checked out — against
  R7.
- **Pins outrank the live tree.** A child reference that a pin covers is judged against
  the pin, and the parent is not consulted even when it is on disk and disagrees. In a
  probe, the parent stopped publishing a portal after the child had pinned it: the child
  validated clean; the parent reported a private-access error on the same edge.
- **From the parent, a child's reference can be judged only against the child's pin.**
  With the spelling problem in issue 02, a method renamed in Billing produced no finding
  at Platform about Shipping calling a method that no longer exists.
- **Approval context.** Completeness findings are errors for settled specs and warnings
  for drafts. Settledness is per root, and the parent cannot see a child's approval, so
  the same child spec is an error from the child's root and a warning from the
  parent's (issue 07).
- **Configuration** differs by root (issue 03).
- **Code.** The parent never checks a child's code against its specs; the child does.
  Import edges between parent code and child code are judged from neither root.
- **Scope of the fallback.** Resolving through the parent is triggered by that code
  family alone. It does not cover completeness, status or any other output.

**Why it matters.** CI that validates each child and CI that validates the parent reach
different answers. A stale pin can hide a revoked access indefinitely. A child's result
depends on whether its parent happens to be checked out.

**Open questions.**
- Which evidence ranks: the live tree whenever it is reachable, pins only when not?
- Should a verdict depend on what is on disk at all, or should a child's gate be defined
  against declared, versioned inputs, the way a lockfile defines a build?
- Is a union of two judges the right composition, or should each edge have exactly one
  authoritative judge — for example the project that owns the edge?
- Where does code conformance for a child belong, and who judges imports that cross a
  mount?

### 05 — Contracts across the boundary: pins and freshness

**Today.**
- A child pins what it may consume with `wairon surface pin`, which needs the parent on
  disk: the family surface, plus a sibling surface for each other top-level subsystem of
  the parent, limited to published Portals, Gateways and Observers.
- Each pin records a hash of the whole family's specs at pin time. `surface externals`
  compares that hash with the parent's current one, so any edit anywhere in the family —
  including the child's own — marks every pin stale.
- Nothing enforces freshness: validate, lock and doctor do not read it, and nothing
  re-pins automatically.
- Nothing reports a pin that no reference uses, or distinguishes a removed sibling from
  a renamed method.
- Surfaces imported from projects outside the family share the same store. The hosted
  server's cross-project visibility and relation health are a separate mechanism that
  knows nothing about chaining.

**Why it matters.** Pins exist so a child can be validated alone. Today they are also
the only thing some edges are judged against when the parent is present (issue 04), and
their staleness signal is too coarse to act on.

**Open questions.**
- What should a pin be: a lockfile entry per consumed contract with its own digest, a
  versioned contract, a cache that only matters for a detached clone?
- When should staleness fail a gate?
- Should the family surface exist at all when the parent can load the child directly?
- How should pins relate to hosted published surfaces and to imports from unrelated
  projects?

### 06 — Working from the child's own root: status, topology, briefs

**Today.**
- The parent represents each child as one delegate "owner" agent. It never lists the
  child's components, and a brief for a child component cannot be composed at the parent.
- The child lists only its own subsystems. After creation (issue 01) that can be none,
  so the child's root shows no work for components the parent scores.
- An unscoped `wairon lock` at the parent cascades into each direct child without
  validating it: it writes the child's `project.yaml` and L0 when they are missing, and
  regenerates the child's skills, context files and guides, pruning stale managed files.
  A lock scoped to the mount skips all of it.
- Only validation looks through to the parent; status, topology and briefs do not.

**Why it matters.** A team working in the child sees an incomplete picture. An
orchestrating agent at the parent cannot delegate into a child directly. A child's
derived files change on the parent's schedule.

**Open questions.**
- What should each root's status and topology contain?
- Who writes a child's derived files?
- How should delegation cross a mount — does a parent orchestrator hand a child's work
  to an agent working at the child's root, or brief it from the parent?

### 07 — Approval across a family

**Today.**
- Each root has its own approval. The parent's excludes children's specs and pins each
  direct child's approved state — one level only, so Platform's approval records nothing
  about Payments. A child that was never approved is pinned as nothing.
- Locking the parent never locks a child, so a parent's approval promises nothing about
  a child's content beyond which approved state, if any, it pinned.
- Hosted, a child can be locked through a credential narrowed to it — through the MCP
  tools, not the web UI.
- The parent cannot see a child's approval when judging it (issue 04).

**Why it matters.** "The platform is approved" does not currently mean anything about
its parts, and the platform's own validation treats its parts' approved specs as drafts.

**Open questions.**
- Should a parent's approval require approved children? Should approval be transitive,
  rolled up, or strictly per root?
- Who may approve a child — its own team, the platform team, both?
- How should a family's approval state be shown?

### 08 — Repository layouts and version control

**Today.**
- A mount's path must lie inside the parent's directory, so a child in its own
  repository must be nested inside the parent's checkout (a git submodule or a clone in
  a subdirectory).
- A child cloned alone validates against its pins. A parent without its child checked
  out reports the missing directory as an error and loses the child's specs.
- Hosted git backup commits only the top project's `.wai/` directory, so a child's specs
  and approval record are never backed up by it — even in the same working tree — while a
  tree archive of the project includes every child.
- Approval pins (a child's approved state) and version-control pins (a submodule commit)
  are unrelated.

**Why it matters.** Chaining is often the answer to "this part lives in another
repository", and that is the layout with the weakest support.

**Open questions.**
- Which layouts are first-class: monorepo, submodule, separate repositories side by
  side, package-manager style dependencies?
- Should approval pins and version-control pins be one thing?
- What should hosted backup cover for a family?

### 09 — Hosted: a child as a project, a part, or both

**Today.**
- A hosted project is a top-level root. A chained child is never a hosted project: no
  record, permissions, git backing or approval page of its own.
- A credential narrowed to `project::child` binds the child's root for spec tools.
  Record-level tools (pack installation, policy, publishing, commits, initialization,
  approval status) are refused; lock and tree export/import act on the bound child.
  Permission checks and audit always use the top project.
- Confinement is implemented tool by tool — a list of refused tools plus per-tool
  forwarding — rather than as a property of the binding, so every tool added later must
  opt in.
- The web UI cannot open, diagram or lock a child as its own scope, although an
  administrator can mint a child-scoped agent credential there.
- A child cannot move or detach itself; its mount lives in the parent.
- An agent connected to a hosted child is not told that it is inside a chained subsystem.

**Why it matters.** A team that owns a service inside a hosted platform has no project of
its own: no permissions, history, approvals or view of just their part.

**Open questions.**
- Should a child be registrable as its own hosted project while also being mounted by a
  parent project?
- How should permissions, audit and git map onto a family?
- How do the hosted server's organizational units and project relations relate to
  chaining — are they two answers to the same question?

### 10 — Migrations: create, externalize, internalize, move, rename

**Today.**
- *Create* adds a mount and scaffolds the child project but no subsystem inside it
  (issue 01).
- *Externalize* moves an internal subsystem's specs into a new child, rebases
  implementation file paths, and rewrites references in the parent's own tree — but not
  references held in other chained children.
- *Internalize* accepts only a flat child. Neither operation accepts a subsystem nested
  inside a child.
- *Move* relocates the child's directory and updates the mount; version control and
  approval are untouched.
- There is no way to rename a mount id, which every sibling reference encodes (issue 02).

**Why it matters.** The family's structure changes over time, and every change today can
leave references dangling in projects the operation never touched.

**Open questions.**
- Which migrations must update the whole family atomically, and what if not every child
  is checked out?
- Should there be migrations between kinds (issue 00)?

---

## 6. Commitments so far — open to challenge

These are what the current design tries to hold. A proposal may argue that one is wrong.

- **R1 One verdict per edge.** The same edge gets the same verdict whichever root
  validates it, or the difference is explicit — never silently softer.
- **R2 A child is a first-class project.** It can be validated, approved and released
  alone, including when cloned without its parent.
- **R3 A parent is a first-class system.** It can validate, visualize, approve and
  delegate across its children as one architecture.
- **R4 No writes into another project as a side effect.** A child's files change only
  through work on the child.
- **R5 Authoring round-trips.** Writing through either scope produces the same files.
- **R6 Confinement.** A hosted credential scoped to a child never reads or acts beyond
  that child; a credential for the parent can see the family.
- **R7 No softening by location.** Nothing is waived because of where it was validated.
- **R8 Repository layouts.** A monorepo, git submodules and separate repositories all
  work.
- **R9 Nesting.** Arbitrary depth, same rules at every level.
- **R10 Proportional cost.** Validating one child does not require loading the whole
  family when that can be avoided.
- **R11 Predictability.** From the files alone, a person can tell what a reference points
  at and who judges it.

---

## 7. What a good proposal looks like

- It states its model in a paragraph a user could read, and it uses as few concepts as it
  can.
- It says which commitments it keeps, weakens or drops, and why.
- It defines verdict semantics that do not depend on the current directory.
- It works locally and hosted, in each repository layout it claims to support, and at
  any nesting depth.
- It has a migration path for existing trees: current `projectPath` mounts, `super::`
  references, approval records and pins.
- It names the properties that would prove it holds from both scopes, in a form that
  could become tests.

---

## 8. Glossary

- **Mount** — an L1 spec in a parent with `projectPath`, pointing at a child project.
- **Child** / **parent** / **top root** — the mounted project, the project that mounts
  it, and the outermost project of a family.
- **Family** — a top root and every project chained beneath it.
- **Flat child** — a child with a subsystem whose id equals its mount id.
- **Loading root** — the root a command or MCP session is bound to; ids and `::` are
  relative to it.
- **Qualified id** — an id with namespace segments, such as `billing::invoice_portal`.
- **Surface** — a contract-grade snapshot of what a project or subsystem publishes.
- **Pin** — a surface stored in a child's `.wai/surfaces/` by `wairon surface pin`.
- **Family surface** / **sibling surface** — a pin of what the parent publishes to its
  family, or of one other subsystem of the parent.
- **`resolvedThrough`** — the marker on a child's validation result when the parent's
  verdict was merged in.
- **Settled** — approved and unchanged since approval; judged at full strictness.
- **Owner agent** — the single agent a parent's topology uses to represent a child.
- **Narrowed credential** — a hosted credential restricted to `project::child`.
- **Record-level tool** — a hosted tool that acts on the project record (packs, policy,
  commits, publishing) rather than on its spec tree.
