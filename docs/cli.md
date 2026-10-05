# wairon — CLI Reference

All commands operate on the `.wai/` directory in the current project. Global
flags: `--verbose`, `--silent`, `-v`/`--version`.

---

## Project

### `wairon init [-y, --yes] [--pack <source>]`
Bootstrap `.wai/` in the current project: project config, the SDD spec tree
(an L0 `.index.yaml` is seeded), the shared `.wai/context/`, the architect agent
file, and the SDD skills installed into each selected target tool. `--yes` uses
defaults without prompts; `--pack <source>` (repeatable) vendors + registers an
extension pack right after init (see `wairon packs`). Re-running on an
initialized project is a no-op that points you back to the SDD flow. Run inside
a subdirectory of an existing project, it offers to make that directory a
**member** of the parent (see `wairon member add`).

### `wairon status`
Print a hierarchical completeness dashboard of the SDD spec tree (which
subsystems/components/interfaces/implementations are drafted vs complete).
Each member project prints as `[Project] alias (id)` holding its own subsystems,
with its **approval state** computed at the member's own root (`approved`,
`drifted`, `never`) and how this project's lock pinned it (`matches`, `moved`,
`unpinned`). The report closes with this project's own state. Asked at the parent
or at the member, the answer is the same.

### `wairon validate [--ci]`
Run the architecture-conformance gate over the spec tree: reference integrity,
contract↔implementation method symmetry, narrative-call resolution, component
stereotype dependency rules, and dependency-cycle detection. `--ci` treats
warnings as errors.

### `wairon generate [--target <type>] [--domain <id>] [--domains <ids>] [--root] [--family] [--dry-run]`
Regenerate agent output files from the spec-derived topology and (re)install the
SDD skills. Filters limit generation to a target type or to specific domains.
`--dry-run` previews without writing.

`generate` writes **only this project's** outputs. A parent's topology lists a
member's agents by reference (`delegatesTo: <alias>::<agentId>`) instead of
copying them, and a brief for `<alias>::<agent>` composes at the member's own
root. `--family` also generates each member's own layer, in its own root.
(`--no-recurse` is accepted for one release; not cascading is now the default.)

### `wairon lock [-y, --yes] [--subsystem <id>]`
Review and approve the design. Validates the spec tree **as if complete** (full
strictness, no draft-status relaxation) and — only if the **design** passes —
records the current tree as approved and regenerates this project's agent
topology.

**What it certifies is the design.** Only design findings can refuse a lock.
Code-conformance findings (the code↔spec checks) are recorded **beside** the
claim in the record's `code` block, with the analyzer that produced them, and
printed as `code: N error(s), … recorded beside the claim`. CI enforces them:
`wairon validate --ci` still fails on a code error. A design can be approved
before its code exists.

**It approves this project only.** The gate identity it records covers this
project's own specs, the design doctrine, its declared inputs, its `composition`
block, and each direct member's **composition subject** — the `stateId` in the
member's own lock record. The record (format 2) lists each direct member under
`members` with its subject and state (`approved`, `drifted`, `never`). Nothing is
written below the project: each member locks at its own root. With
`composition.requireApprovedMembers: true` in `project.yaml`, the lock refuses
while a direct member is drifted or never approved, naming each.

The identity is captured **before** validating and confirmed **before** writing:
if a spec, the doctrine, an input or a member's approval moves while the lock
runs, it refuses and writes nothing. (`--no-recursive` is accepted for one
release and changes nothing: a lock never reaches below its project.)

It writes **nothing into your spec tree**. The approval is one sha256 per spec
file on `.wai/lock.json`, the record that was always committed — so your
teammates, a fresh clone and CI all see the same approval you gave, and
`wairon status` elsewhere can name what has drifted from it. Keys are sorted, so
re-approving a one-spec change shows up as a two-line diff. A failed or
cancelled lock changes nothing at all.

`lockedBy` records who approved **and how that identity was established**: your
git author identity where there is one (so a reviewer can match it against the
author of the commit carrying the lock), else `user@hostname`. On a hosted
instance it is the authenticated subject. None of it is proof — the commit that
introduces `lock.json` is what carries that.

Before approving, it reports what moved since the last approval — the question
a human is actually answering:

```
3 spec(s) changed since the last approval:
  ~ sdd_core/spec_loader/.index.yaml
  ~ sdd_core/spec_loader/.interface.yaml
  + sdd_core/spec_index/.index.yaml
```

`--yes` skips the confirmation (for CI); `--subsystem`
limits the scope.

### `wairon lock-check [--strict]`
The **merge gate**. One question, one exit code: *is the design in this working
tree the design that was approved?* It compares the tree's gate identity against
the one recorded in the committed `.wai/lock.json`.

| What it finds | Default | `--strict` |
| --- | --- | --- |
| **`locked`** — the approval still covers this design | pass (0) | pass (0) |
| **`stale`** — the design moved past its approval | **fail (1)** | **fail (1)** |
| **`unlocked`** — nothing was ever approved | pass, with a notice (0) | **fail (1)** |
| no `.wai/specs` in this directory at all | pass, saying so (0) | **fail (1)** |

A lock taken before stage 5 reads `stale` once, because the gate identity
gained inputs. The message says so — the approval *was taken under an earlier
gate identity* — and whether any own spec file changed since; re-lock once and
commit `.wai/lock.json`. It stays about this project's own approval: a member's
state is `wairon status`'s to report.

**It is optional by construction.** Only `stale` refuses by default, and `stale`
cannot happen in a project that never locked — so adding this to an existing
repository's CI cannot make it start failing. `--strict` is what turns "never
approved" into a failure, and a project has to ask for it.

It is **not** `wairon validate`. Validate asks whether the design is *legal* and
runs the whole rule set to answer; this asks whether it is *approved* and reads
one JSON file, which is why it is safe to run on every pull request. The two are
independent — a tree can be approved and illegal, or legal and unapproved — so
run both.

It gates on the **gate identity** (the hashed parsed tree plus the governing
doctrine), not on the per-spec content digests the same lock record carries.
Those answer "has this file changed since you approved it": a whitespace-only
edit moves them, and a gate that demands a re-lock for reformatting is one people
learn to bypass.

**What it proves:** that the design in the commit being merged is the design that
was approved. **What it does not prove:** *who* approved. `lockedBy` is a claim,
not an attestation — anyone who can run the CLI can write a lock record. Pull
request review is what establishes who reviewed; this establishes that the thing
merging is the thing that was reviewed.

#### Using it in GitHub Actions

This repository publishes it as a **reusable workflow**. Add one job to your own
workflow:

```yaml
# .github/workflows/ci.yml in YOUR repository
on: [pull_request]

jobs:
  approved-design:
    uses: SYW-Apps/Waffle-AIron/.github/workflows/lock-check.yml@v5.1.0
```

With inputs (all optional):

```yaml
  approved-design:
    uses: SYW-Apps/Waffle-AIron/.github/workflows/lock-check.yml@v5.1.0
    with:
      working-directory: packages/api   # where the .wai/ tree lives (default: .)
      wairon-version: '5.1.0'           # version or npm dist-tag (default: latest)
      strict: false                     # fail when nothing was approved (default: false)
      node-version: '20'                # (default: '20')
      runs-on: ubuntu-latest            # (default: ubuntu-latest)
```

Pin `@<ref>` to a **tag**, never to `main` or `dev`. A moving branch means the
check that gates your merges can change under you between two runs of the same
commit — and this one decides whether code merges.

On a `pull_request` event the default checkout is the merge commit, so what the
gate judges is literally the design that would land.

**A failing job does not block a merge on its own.** A workflow can only fail;
making a failing job stop a merge is a branch-protection / ruleset setting on
your repository ("Require status checks to pass" → add this job). No workflow
can declare that for itself.

### `wairon doctor [--fix]`
Health check: flags stale generated guides/skills, an unregistered MCP server,
and spec-tree issues. `--fix` regenerates stale in-project guides/context/skills
and registers the MCP server.

Among its spec repairs, `--fix` rewrites every stored type position that is an
alias of its canonical spelling (`string[]` becomes `list<string>`, `boolean`
becomes `bool`, `T | null` becomes `T?`, `Promise<T>` becomes `async T`) — what
any later save would write. It never guesses: a `number` position whose name
says a whole number (`count`, `maxDepth`, `port`) gets `int` *proposed* and
listed, and every position no rewrite can settle (an inline function type, a
literal union, a union mixing in a primitive, a `number` with no proposal) is
listed with its replacement for an author. Plain `wairon doctor` prints the same
plan without writing it.

### `wairon list` (alias `ls`) / `wairon show <id>`
List, or show full details of, the agents resolved from the spec tree
(`system-architect`, `<subsystem>-owner`, `<component>-implementer`, and owners
for free-standing domains).

### `wairon rules list`
List the SDD conformance rule registry — every rule group, the issue codes it
can emit, default severities, and any per-project overrides from
`rules.sddRuleSeverity`. The gate is a documented architecture linter: each
rule is a self-contained module in `src/core/rules/`. Rules injected by
extension packs are listed too, tagged with their pack.

### `wairon execution show` (alias `ls`) / `wairon execution set-tier <tier>`
Execution budgets — the resource axis of the derived topology. Where authority
says which paths an agent owns, a budget says what its work costs to do:
a capability tier, a reasoning effort, a turn ceiling, a tool class, and
whether it may delegate further or load MCP servers.

`show` lists every agent's allowance next to the rationale that produced it
(component stereotype, owned-path breadth, role), so a tier choice is auditable
rather than magic. It also flags any agent an override has pinned to the
`frontier` tier — derivation never selects it.

`set-tier` moves the aggressiveness dial and states what the new tier costs:

| Tier | What it does |
|------|--------------|
| `off` (default) | No budgets derived. Output is byte-identical to before this feature existed. |
| `free` | Structural constraints only — tool class, MCP access, nested delegation. No model or effort selection, so no quality tradeoff at all. |
| `default` | Adds capability-tier selection per role and turn ceilings. Mechanical work (Store, Index, Registry, Adapter) runs smaller; work carrying decisions (Orchestrator, Supervisor) keeps the capable tier. |
| `trade` | Adds effort reduction on mechanical work and steps standard work down a tier. Real but bounded quality cost. |
| `aggressive` | Small tier for everything but deep reasoning, halved turn ceilings. Expect partial results and worse judgment. |

Raising the dial can only tighten a budget, so it is safe to turn without
auditing every agent. Per-agent overrides live in `.wai/project.yaml` under
`execution.overrides`.

### `wairon packs list | add <source> [--global] | remove <name> [--global]`
Extension packs — plain config files (YAML, or a JS module for programmatic
rules) injecting custom profiles, language/platform tables, and conformance
rules (see [Extending wairon](extending-wairon.md)).

- `add <source>`: verify the pack loads, then vendor it into `.wai/packs/`
  and register it in `project.yaml → extensions.packs` (commit `.wai/` so CI
  and every clone enforce it). With `--global`, install machine-wide into
  `WAIRON_PACKS_DIR` / `~/.wairon/packs` — auto-loaded for every project on
  this machine (project packs win on collision; a project opts out via
  `extensions.useGlobalPacks: false`). A source may be a file or a directory
  with a pack entry file (`pack.yaml` | `pack.cjs` | `index.cjs` | …).
- `list`: global + project packs and what each provides (profiles,
  languages, rules), with load errors inline.
- `remove <name>`: deregister by pack name and delete vendored files under
  `.wai/packs/` (files elsewhere are left in place); `--global` removes a
  machine-wide pack.

`wairon packs` is the deprecated alias of `wairon pack`, whose selection
commands (`install | uninstall | which | use | unuse | impact | bundle | sync`)
are described in [Extending wairon](extending-wairon.md#installing-and-selecting-packs).

### `wairon pack impact <name>[@version]` — and confirm before every pack write
Packs exist to adjust wairon's checks and behaviour, and a pack may loosen or
remove them by design (an automation platform cannot hold every concept a full
backend can). So installing a pack is never judged — but it is always
intentional, and its impact is shown first.

`wairon pack impact` shows, writing nothing, what a pack changes on this
project:

- its **doctrine against wairon's defaults**, by the profile that carries each
  change: rules loosened, raised, turned off or added; profiles added or a
  builtin redefined; stereotypes removed or discouraged, edges licensed,
  patterns, guarantee tokens and language tables added;
- the **profiles of it that would govern** here (the `projectType` and each
  subsystem profile that names one);
- the **findings that change** on this project — introduced, resolved and
  regraded, from a dry validate of the current and the candidate
  configuration — with both totals.

A pack this project does not apply (or applies at another version) is measured
as applied; one it applies exactly as asked is measured as removed, so the
report reads as what the pack accounts for now. Nothing in the report is a
finding.

Every command that selects, updates or removes a project's pack — `pack use`,
`pack unuse`, `pack add`, `pack remove`, and `pack install` when it moves this
project's floating selection — **shows the same report and asks before it
writes**; anything but yes writes nothing. In a script, pass `-y, --yes`: the
write happens without the report, and the command says it applied without
showing it. A run with no terminal to ask on (CI, a pipe) behaves the same way.

### `wairon diagram [--format <fmt>] [--subsystem <id>] [--sequence <component:method>] [--depth <n>] [--all] [--out <path>]`
Generate architecture diagrams derived from the spec tree — living
documentation from the same source of truth as the conformance gate. Every
format writes a file (paths are printed); nothing opens automatically.

- **default (no flags): the interactive canvas** (`canvas.html`).
- `--format mermaid` (or `--subsystem <id>`): system-wide or scoped Mermaid
  **component diagram** as a markdown file (subsystems as subgraphs,
  `dependsOn` edges, thick edges for boundary hops, dashed `owns`
  containment, bold border on the published surface). Use a `.mmd` `--out`
  path for raw Mermaid.
- `--subsystem <id>`: scope to one subsystem plus its directly-connected
  external neighbors.
- `--sequence <component:method>`: a **sequence diagram** derived from the
  method's L5 narrative, recursively expanding `call` steps (cycle-guarded,
  `--depth` limits expansion; default 3).
- `--canvas`: an **interactive HTML canvas** — the whole system on one page.
  Subsystems as containers, pattern compounds nested inside, components laid
  out in dependency layers (entrypoints left → data right), subsystems in
  topological order (callers left of providers) with barycenter
  crossing-reduction so links stay short and untangled. Pan/zoom,
  double-click a boundary to collapse it (its external edges aggregate into
  labeled "tubes"), click anything for a spec-derived detail panel
  (description, interfaces, methods, endpoints, narratives, dependencies,
  trusted links), search, and a validation-issue overlay. The computed
  layout is locked by default — enable "rearrange" to drag, "reset layout"
  to undo — and "export PNG" renders the full graph to a high-res image for
  Miro/docs/slides. Fully self-contained (Cytoscape.js embedded inline,
  works offline).
- `--format <mermaid|canvas|drawio|excalidraw>`: friendly alias for the flags below/above.
- `--drawio` / `--excalidraw`: **editable** exports in open formats
  (draw.io / diagrams.net XML, Excalidraw scene JSON) with the exact same
  computed layout as the canvas — import into diagrams.net, excalidraw.com,
  VS Code extensions, or any whiteboard tool that accepts these formats.
- `--all`: write the full set (system, per-subsystem, one sequence per
  entrypoint method with a narrative, plus `canvas.html`,
  `architecture.drawio`, and `architecture.excalidraw`) into
  `.wai/docs/diagrams/` (or `--out`).

The canvas is a small single-page app with **C4-style scoped navigation**:
each view renders one scope's direct children (System → subsystems →
components → pattern members, infinitely deep by ownership); double-click
drills in, the breadcrumb navigates back, "Internals" previews children
inside boxes, "Externals" shows out-of-scope references as ghosts. Plus
SYW/light themes, presentation mode, per-view layout persistence,
narrative flowcharts with call drill-down, and an Export menu
(PNG / draw.io / Excalidraw) capturing the current view and layout.

### `wairon export [--out <file>]`
The whole design, resolved, as one JSON document for generators,
translators and documentation tools (format `wairon-design`; the
[format page](design-export.md) describes every field, the compatibility
promise and how a consumer follows renames).

- It first decides the approval verdict exactly as `wairon lock-check` does
  (not strict) and stamps it as `source.approval` (`locked`, `stale` or
  `unlocked`) and `source.approved`. An unapproved tree is exported too,
  carrying its state.
- Without `--out` it prints the JSON to stdout and nothing else, so it pipes
  cleanly (`wairon export | jq .components`). With `--out` it writes the file
  and reports the path and the approval state.
- Deterministic: the same tree and verdict give byte-identical output.
- A tree without an L0 is refused. The JSON Schema ships in the package as
  `schemas/design-export-1.json`, and the library twin is `exportDesign()`.

---

## Members

A project's **members** are declared in its `.wai/project.yaml`, each by one
location key:

```yaml
members:
  scheduler: services/scheduler                          # contained
  admin: ../admin                                        # a sibling checkout
  payments: git@host:acme/payments.git#<full commit>     # a git repository at a commit
  ledger: { source: services/ledger, description: The books, as: project }  # long form
```

A member is a **part** or a **project**, and what it is follows from its
content — `as:` only asserts it (a contradiction is `MEMBER_KIND_MISMATCH`):

- A **part** (the default) is a piece of this project stored in another folder
  or repository. Its subsystems are this project's own: written by local id,
  judged by the ordinary subsystem rules, covered by this project's lock, and
  generated and briefed with this project's agents. It holds only a specs folder
  — plus, when it is not contained, a `project.yaml` holding just
  `partOf: { project: <parent id>, path: <parent root> }`.
- A **project** is an independent boundary: its tree declares an id, holds an L0
  or carries a lock. It is reached only as `alias::name` through its L0 exports,
  judged by its own gate and locked at its own root. A project stored outside
  this project (`../x`, git, `hosted:`) is a **referenced** project: this
  project's gate judges it against its pin (`wairon externals pin`), and the
  family run opens it where it is stored and composes it per use.

Boundaries are earned: grow a system from subsystems, to parts when a piece
needs its own folder or repository, to projects only when it needs its own team,
release, approval or public surface.

A git member is pinned at a full commit; it is read from the fetch cache
(`WAIRON_CACHE_DIR`, else the OS user cache directory), immutable and offline
once fetched. A git part is read-only here — change it in its own repository,
then move the pin with `wairon member update`. An uncached git part offline is
`PART_UNAVAILABLE`; an uncached git project falls back to its pin and is
`EXTERNAL_CHECK_UNAVAILABLE` — never a pass. Every cross-project reference is
`alias::name`: the alias is one of the referring project's project members or
declared `externals`, the name a public name in that project's L0 export table.
An id without `::` is local — a part's subsystems included.

| Command | Description |
|---------|-------------|
| `wairon member add <alias> <source> [--project] [--description <text>]` | Create a member at `<source>` (`path`, `../path` or `git-url[#commit]`) and declare it by the shorthand. A **part** by default: a specs folder (and, outside this project, its `partOf`). With `--project` a project: its `project.yaml` declaring `<alias>` as its id and its L0, each only when absent. A git member is never scaffolded: it is pinned at the commit given, else the default branch head, and its content decides what it is |
| `wairon member promote <alias> [--id <id>]` | Make a part an independent project **in place**: its id, an L0 exporting exactly what this project uses of it, references across the new boundary respelled `alias::name` (`<parent id>::name` the other way), the parent declared as its external, pins on both sides. Refused for a part fetched from git, a trustedLink that would cross the boundary, a component used across it that its subsystem does not publish, or an id already taken |
| `wairon member demote <alias> [--home <subsystem>] [--packs adopt\|drop]` | Make a project member a part **in place** — promote's inverse: its own metadata goes home (as `internalize` sends it), its L0, lock and pins end, references across the old boundary become local ids. Refused while another family project consumes it, or for a member fetched from git |
| `wairon member update <alias> [--ref <ref> \| --commit <sha>] [--report]` | Move a git member's pinned commit to its ref's head (or the ref or commit given), printing the spec files it adds, changes and removes; `--report` writes nothing. The only way a git member's content changes; this project's lock reads stale until re-locked when the content moved |
| `wairon member move <alias> <path>` | Move a contained member's directory and point its `members` entry there (a legacy L1 mount is moved into `members` first) |
| `wairon member attach <alias> <path> [--description <text>]` | Make the **existing** project at `<path>` a member, keeping its L0, subsystems, packs and lock; its id is declared when it only defaulted one (the id its lock approved, else its effective id). Refused when its id collides with a family project's |
| `wairon member detach <alias> [--widen]` | Take a member out of the family: this project and every family consumer reach it as an external by `source.path`, this project's pinned. Refused (`audience-too-narrow`, each export named with its users) while a family project uses a name the member exports only to the family; `--widen` instead widens exactly those used exports to `instance` in the member's L0, each shown in the plan |
| `wairon member adopt <alias>` | Make this project's external found by a path inside it a member again — detach's inverse |
| `wairon member rename-alias <old> <new>` | Rename one alias of this project (a member or an external) and respell this project's references through it; no member or sibling changes |
| `wairon member internalize <alias> [--into <subsystem>] [--packs adopt\|drop] [--export <name>…]` | Fold a member into this project's own specs folder. A **part** is a storage move: its subsystems move in and nothing else changes. A **project** is demoted first — its own metadata goes to a home (its L0 vision onto the `--into` subsystem, its boundaries, requirements and databases into this L0, its language, profile and depth onto the moved subsystems, its members and externals into this configuration, its packs adopted or dropped), what has no home (its lock, pins, derived outputs) is deleted and listed, and every family project that consumed it is re-pointed here |
| `wairon project rename <new-id> [--project <alias path>]` | Move a project's id — this project's, or a member's named by its alias path — and every reference to the old id family-wide; the old id is kept in `previousIds`. Lists every project it writes to re-lock |
| `wairon subsystem externalize <id> --path <dir> [--as part\|project]` | Move an internal subsystem's specs into a **part** at `<dir>` (a new one, declared under the subsystem id, or the existing part there) — a storage move: no reference, export or pin changes, the same verdict. With `--as project` the move is followed by a promote, family-wide: references across the new boundary become `alias::name`, what crosses it is exported and imported, and every other family project's names are checked to keep resolving. You move the source code |

On a hosted instance a project member is a project record of its own and
inherits access from its parent, while a **part is part of its parent's record**:
it gets no record, and a demote retires the member's record (disabled as "part of
`<parent>`", audited `member.retired`, its own-scope settings kept) and a promote
re-enables it; the record's `disabledReason` (shown in the web app and `host
project list`) says why. Hosted roots are isolated, so a member with a `../` or git source
is refused there; a `hosted:` project member is its own top-level record.
`sdd_detach_member` also **moves** the member to an isolated root of its own
(writing `source: { hosted: <id> }` for its consumers) and `sdd_adopt_member`
with `path` moves it back. A `source.hosted` producer outside a hosted server is
reported as "hosted-only producer `<id>`: available only through the hosted
server".

**A part on its own.** A part stored outside its parent can be validated in its
own repository's CI: run `wairon externals pin` at the part (with the parent on
disk at `partOf.path`) to pin the excerpt of the parent it uses; `wairon validate`
there then judges the part against that pin (`PART_JUDGED_ALONE`). Unpinned, it
says "part of `<parent>`; validate from the parent" (`PART_UNPINNED`).

**Family migrations.** `attach`, `detach`, `adopt`, `promote`, `demote`,
`rename-alias`, `internalize`, `project rename` and `subsystem externalize` all run
one flow: plan, print the plan (each project's edits, every refusal, the notes,
the file changes, the projects to re-lock), then apply it all or nothing.
`--report` prints the plan and writes nothing; otherwise the command asks —
`--yes` answers, and a shell with no terminal and no `--yes` writes nothing. A
refused plan exits non-zero and writes nothing. The plan is computed by running
the verb's writes on a private copy of the family's `.wai` trees (its parts'
included); applying it stages every change with a backup under each project's
`.wai/transactions/<id>/` (never committed) and swaps them in, restoring every
backup on any failure. A crash mid-swap leaves a journal: `wairon status` and
`wairon validate` show it as a notice, and `wairon doctor --fix` rolls it back.
No verb ever locks — each names the projects to re-lock. A member stored in a
`../` sibling checkout on the same volume joins the same transaction: its files
change all-or-nothing with the family's, the coordinator's journal names every
owner (so `wairon doctor --fix` recovers from either root), and the plan says
plainly "files: all-or-nothing; commits: one per repository" — commit each
repository yourself; no commit across repositories is ever atomic. A sibling on
another volume is refused (`cross-volume`), and a git member always is (its files
are a read-only cache). `member demote` names every L0 export entry it removes.

**Required packs.** A project may require packs of the members below it with
`composition.requirePolicies` (see
[Extending wairon](extending-wairon.md#governance--what-a-pack-changes-and-what-a-parent-requires)).
`wairon member add --project` — and `wairon init` run in a subdirectory, which
creates a project member the same way — writes those packs into the new member's selection once,
each pinned to the highest installed version its range admits, sets the
`projectType` a requirement names, and prints what it applied and each
requirement nothing installed satisfies. Scaffolding is an unattended pack write,
so it shows no impact report; run `wairon pack impact <name>` at the member's
root to see one.

**Deprecated forms.** For one release wairon still reads, and reports: a leading
`::` (`::shared::money`), `super::` (`super::sibling`), a member path
(`billing::invoice::invoice_portal`) and an L1 subsystem carrying
`projectPath` (`DEPRECATED_MOUNT_FORM`), and a member's long-form `path` key
(`{ path: services/x }`, stage 8: one location key, `source`). `wairon doctor
--fix` rewrites them to `members`, the one location key and `alias::name`.

---

## Domains

A domain is a unit of agent ownership. Subsystem-derived domains come from the
spec tree (read-only); free-standing domains live in `.wai/topology.yaml`.

| Command | Description |
|---------|-------------|
| `wairon domains list` | List all domains (subsystem-derived + free-standing) |
| `wairon domains scan [--add]` | Detect physical directory candidates; `--add` adds selected ones as free-standing domains |
| `wairon domains add [--path] [--id]` | Manually add a free-standing domain |
| `wairon domains remove <id>` | Remove a free-standing domain (subsystem-derived domains cannot be removed here) |

---

## Skills

The SDD skills (`sdd-architect`, `sdd-narrative`, `sdd-auditor`, `sdd-implement`)
drive the spec-driven workflow inside your AI tool.

| Command | Description |
|---------|-------------|
| `wairon skills list` | List the built-in SDD skills |
| `wairon skills install` (alias `sync`) | Install/refresh the skills into each active target's skills dir |

---

## MCP

The wairon MCP server exposes topology and `sdd_*` tools so AI tools can query
and author specs directly.

| Command | Description |
|---------|-------------|
| `wairon mcp serve` | Start the MCP server (stdio transport) |
| `wairon mcp install [--global] [--config-dir <path>] [--backend claude\|gemini]` | Register the server. Default: project-local. `--global` uses the home config (respects `CLAUDE_CONFIG_DIR`/`GEMINI_CONFIG_DIR`); `--config-dir` installs into an explicit, validated config dir (requires `--backend`) |
| `wairon mcp status` | Show whether the server is registered |

**Tools:** `listAgents`, `getAgent`, `listDomains`, `validateTopology`,
`getProjectConfig`, `sdd_initialize_system`, `sdd_add_subsystem`,
`sdd_set_public_interfaces`, `sdd_add_member`, `sdd_move_member`,
`sdd_externalize_subsystem`, `sdd_internalize_member`, `sdd_attach_member`,
`sdd_detach_member`, `sdd_adopt_member`, `sdd_rename_project`,
`sdd_rename_member_alias` (each family migration takes `dryRun`),
`sdd_add_component`, `sdd_define_interface`, `sdd_set_endpoints`,
`sdd_write_narrative`, `sdd_add_type`, `sdd_get_spec`, `sdd_update_spec`,
`sdd_delete_spec`, `sdd_validate_tree`, `sdd_get_status`.

---

## Hosting (self-hosted server)

`wairon serve` runs wairon as an HTTP server that hosts many **fully-isolated**
projects behind one endpoint — a public **data plane** (the `sdd_*` tools over
streamable HTTP, per-project API-key scoped) and an admin **control plane**
(project & key lifecycle, state-scoped lock). See the
[hosted server guide](design/hosted-mcp-server.md) for the architecture, Docker
self-hosting, auth, and sizing.

### `wairon serve [--host <h>] [--port <p>] [--admin-host <h>] [--admin-port <p>] [--data-dir <path>] [--no-auth]`
Start the hosting server. Data plane on `0.0.0.0:8080` (`POST /mcp`, `/healthz`,
`/readyz`); admin plane on `127.0.0.1:8081` (`/admin/*`). Auth is **on by
default** and requires `WAIRON_ADMIN_TOKEN` (the master credential) — the server
refuses to start without it; `--no-auth` disables data-plane auth for a trusted
network. `--data-dir` (or `WAIRON_DATA_DIR`, default `~/.wairon/data`) is the data
root holding `projects/` and `auth/`. `WAIRON_AUDIT_POLICY` (optional) sets the
durable audit policy as a JSON object of overrides laid over the secure default
(capture `info` and above, keep events 90 days and `security` events 365, skip read
events, redacted metadata) — e.g. `{"retentionDays":30,"includeReadEvents":true}`.
Its fields are `enabled` and `includeReadEvents` (booleans), `retentionDays` and
`securityRetentionDays` (non-negative numbers), `minimumLevel` (`debug`, `info`,
`warning`, `error` or `security`) and `metadataMode` (`none` or `redacted`; the
retired `full-redacted` still loads as `redacted`, with a deprecation warning); an unknown field, a wrong type or invalid JSON stops the server at
startup with a message naming the variable. `WAIRON_QUOTA_POLICY` (optional) sets the
advisory quota policy the same way, as a JSON object of overrides laid over the
disabled default (`enabled: false`, mode `observe`, no limits) — e.g.
`{"enabled":true,"mode":"warn","maxProjectsPerUser":20}`. Its fields are `enabled`
(boolean), `mode` (`observe` or `warn`, the label an exceeded limit is reported
with; quotas never block or throttle yet, so the retired `block` loads as `observe`,
with a deprecation warning) and the non-negative integer
limits `maxProjectsPerUser`, `maxMcpRequestsPerMinute`, `maxProjectBytes` and
`maxAuditEventsPerDay`; it is refused at startup exactly as the audit policy is.

### `wairon host …` — control plane
Runs **in-process** (no running server needed), so it works over SSH /
`docker exec`. Reads the master credential from `WAIRON_ADMIN_TOKEN`.

| Command | Description |
|---------|-------------|
| `wairon host project create --id <id>` | Provision a new isolated project (its own `.wai/` tree) |
| `wairon host project list` | List hosted projects |
| `wairon host project destroy --id <id>` | Remove a project and its tree |
| `wairon host key mint --project <id\|*> [--owner <userId>] [--role editor\|admin]` | Mint an API key (plaintext shown once). A token naming a project covers its members; a deprecated member-qualified `--project platform::billing` is stored as the member's record id, and the command says what it mapped |
| `wairon host doctor [--fix]` | Inspect the data dir and, with `--fix`, migrate it: roll back a transaction a crash left unfinished there, apply the permission-model migration, then register every hosted family's members as records of their own (no grant written — access is inherited through the parent chain — and every member-qualified key entry rewritten to a record id), all or nothing, audited |
| `wairon host key list [--project <id>]` | List API keys |
| `wairon host key revoke --id <id>` | Revoke a key |
| `wairon host lock --project <id>` | The same lock flow as `wairon lock` (design gate, `members`, `code` beside the claim, format 2) against the hosted project |
| `wairon host packs list [--project <id>]` | List the server-global packs, or one hosted project's |
| `wairon host packs install --file <pack.yaml> [--name <n>] [--project <id>] [-y]` | Install a declarative pack server-wide, or into a hosted project. Into a project it first shows the pack's impact on that project (measured by the host, writing nothing) and asks; `--yes`, or no terminal, installs without the report and says so |
| `wairon host packs remove --name <n> [--project <id>] [-y]` | Remove a pack; from a project it first shows what the pack accounts for there and asks, as install does |

The hosted API and web UI preview the same way:
`POST /admin/projects/{id}/packs/{name}/impact` (a declarative pack's YAML as
`content`, or no body to preview adopting the server-global pack of that name)
and `POST /admin/projects/{id}/packs/{name}/removal-impact`; both need
`project:read` and write nothing. The hosted MCP data plane offers the same
preview as `sdd_host_pack_impact`. The unattended hosted policy writes —
reconcile, a project type change, and a policy-governed project creation —
return the impact of every pack they applied in their results.

---

## Tooling

| Command | Description |
|---------|-------------|
| `wairon update [--check] [--channel <name>]` | Check/install the latest release; switch channel |
| `wairon aliases list` | Show command aliases (`wai`) and their status |
| `wairon aliases enable <name>` / `disable <name>` | Create / remove an alias |
