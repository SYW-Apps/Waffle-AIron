_Section copied from [`responses/fable-5.1.md`](../../../responses/fable-5.1.md) (Fable 5.1 · 2026-09-12 · prompt.md as of branch design/chained-subsystems)._

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
