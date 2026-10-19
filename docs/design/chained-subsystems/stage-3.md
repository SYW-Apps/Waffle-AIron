# Stage 3 — the loader without position

Stage 2 gave every project an identity, export tables and declared externals, but the loader still
builds a family the stage-1 way: a mount is an L1 subsystem that also carries `projectPath`, the
child's tree is merged under it, and a reference's first segment is read by position (a root
subsystem, a mount, `super::`, a leading `::`). Stage 3 removes position from resolution. A family
becomes a set of projects that name each other, and every cross-project reference is `alias::name`.

Decisions this plan rests on: [`decisions.md`](decisions.md) § Stage 2 (6–9, 19), § Stage 2a, 2b, 2c
and § "Stage 3 preconditions (2026-09-27)" (#12 mounts in `project.yaml`, #13 family-wide migrations
write into members, #20 `billing::billing` accepted, #22 one mount per project), plus the P1 results
and the two decisions taken on them (own L0 `typeDef` exports, `PROJECT_DEPENDENCY_CYCLE`).

## 1. Mounts move to `project.yaml`

```yaml
# parent .wai/project.yaml
members:
  billing: services/billing            # shorthand: alias = key, the path is relative to this root
  ledger: { path: services/ledger }    # long form, room for later fields
```

- A member is a project the parent contains. It is not a subsystem of the parent: it has no L1 spec
  in the parent's tree, carries no content there, and is named only by its alias.
- The L1 `projectPath` form still loads for one release. It reports `DEPRECATED_MOUNT_FORM`
  (notice), and `doctor --fix` moves it.
- A mount subsystem's own fields (`description`, `publicInterfaces`, `trustedLinks`, `consumers`,
  `lint`) move into the child where the child has a home for them, and the migration stops with a
  finding where the child already holds a conflicting value. Nothing is dropped silently.
- Containment stays decided against the owning root (stage 1, decision 3): a member path must lie
  inside the declaring project.
- Two members resolving to one project id are `PROJECT_ID_COLLISION` (error); the message points at
  consumption — one member, several consumers — never at instance ids (decision #22).

## 2. Resolution without position

- **Local first.** An id without `::` resolves inside the referring project.
- **`alias::name`.** The alias is one of the referring project's members or declared externals (the
  maps are the alias table, decision 7+8); `name` is a public name in that project's resolved L0
  export table (stage 2a), and nothing else. A reference to anything the table does not export is
  `EXTERNAL_NOT_EXPORTED`.
- **No merge, no root anchor.** The loader no longer folds a child's tree into the parent's namespace,
  and a first segment is never read as "a root subsystem of whoever is bound". The same reference
  means the same thing from every root (`root-invariance`) and at every depth (`depth-invariance`).
- **Shadowing is visible.** A local id equal to an alias is `LOCAL_ID_SHADOWS_PROJECT` (warning); two
  specs with one id inside one project are `DUPLICATE_SPEC_ID` (error).
- **`super::` and leading `::` are deprecated.** `DEPRECATED_REFERENCE_FORM` extends to `super::`
  now that a replacement exists, and wairon's own writer stops emitting it.
- **`billing::billing`** stays an honest id; only the canvas displays the collapsed name (decision
  #20). Probe P3 checks exported artifacts (share snapshots, OpenAPI operation ids, canvas labels)
  for a doubled id in a display name before release.

## 3. Exports a project owns

- L0 may export a project-level type it owns: `{ typeDef: host-var-values }` with no `from`, the
  crate-root `pub struct`. Found by P1: Waffler's `shared` is a sibling project, mounted by the
  parent as the L1 subsystem `shared` (`projectPath: ./shared`, `publicInterfaces: []`), whose own
  tree holds 462 project-level types and no subsystems. Stage 1 let siblings reach them as
  `shared::<type>` by merging the child into the parent's namespace; under decision 9 only exports
  are consumable, and nothing exported them. (Correction 2026-09-27: `shared` does have an L0 — its
  `.index.yaml` — as every Waffler member does; the design pass found it.)
- A project that exports anything needs an L0. The migration creates a minimal one where a project
  has none — new content, so through the gated seam.

## 4. The project graph

- `PROJECT_DEPENDENCY_CYCLE` (warning; error in stage 5, where approval pins need an acyclic graph)
  names the edges that close a loop. Found by P1: `shared` ↔ `waffler_core`.
- The canvas gains a project node per member; a member's internals are drawn through its exports.

## 5. What retires

- The sibling surface: `.wai/surfaces` sibling pins, `surface_projector.projectSubsystemSurface`,
  `surface_orchestrator.pinFamilySurfaces`, and the family pin — externals and their pins replace
  them. `wairon surface pin` and `wairon surface externals` go; `surface export`/`import` for
  foreign surfaces stay.
- `resolveSurfaceRef`'s match-by-backing-component fallback.
- The mount-aware branches of the loader that only existed for the merge.
- Not retired yet: `resolveThroughParent` and its codes (stage 4 deletes them with composed
  validation).

## 6. Migration — `doctor --fix`, plan first

Extends 2c's plan; the same shape (plan per owner, confirmation, `--yes`, refuse when a member is
absent or out of reach, idempotent, never locks):

1. Move each mount from its L1 `projectPath` into the parent's `members`, carrying mount-level fields
   into the child or stopping on conflict.
2. Create a minimal L0 for a project that exports and has none; add own `typeDef` entries for the
   project-level types consumers use.
3. Rewrite references family-wide to `alias::name` (`super::`, leading `::`, bare mount-first ids),
   listing every rewrite; refuse and list absent members.
   Sizing (design pass over Waffler): about 380 rewrites — 315 self member paths become bare local
   ids, 19 `super::` and 47 leading `::` become `alias::name` — plus 83 alias-shaped references
   whose text is unchanged but each needs its external and export.
4. Delete superseded sibling pins and the `.wai/surfaces` family pin once nothing reads them.

The report shows every step before anything is written, and each superseded or rewritten item once
(P1 showed 156 near-identical lines for one family).

## 7. Report fixes found by P1

- Superseded sibling pins collapse to one line per project.
- Projector messages (`[surfaces] skipped …`) no longer leak into the report.
- "`shared` does not hold" becomes an accurate reason for a project-level type.

## 8. Properties

`root-invariance`, `writer-is-inverse` (text equality), `depth-invariance`, `shadowing-reachable`,
`mount-carries-no-content`, `alias-rename-touches-no-sibling`, plus `migration-is-plan-first` and
idempotence over the new steps. A committed reference family — the Waffler shape in miniature: a
vocabulary member with project-level types, a nested member, a sibling pin mesh, `super::` and `::`
references, a mount-level field, a cycle — is the fixture every property runs over.

## 9. Not in stage 3

Composed validation and the removal of `resolveThroughParent` (stage 4); approval subjects and
`PROJECT_DEPENDENCY_CYCLE` as an error (stage 5); `attach`/`rename`/`detach` (stage 6); hosted
members as records (stage 7).
