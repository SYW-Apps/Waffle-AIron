# Stage 2 — identity, exports and declared externals

**Status:** plan, for approval · 2026-09-12 · baseline `dev` at `f5c33b9` (stage 1 merged in #69) ·
decided in [`decisions.md`](decisions.md) (6, 7 + 8, 9 reframed and refined, 19, the export migration)

Stage 2 introduces the declarations the model rests on — a project's `id`, its exports and its
`externals` — without changing what the loader loads or how references resolve. It changes files, not
verdicts. Every new finding is a notice or a warning that `--ci` does not fail on, except where a
decision names an error. The stage-1 machinery (resolve-through-parent, `.wai/surfaces` pins) keeps
judging until stages 3 and 4 replace it.

## 1. Project identity

- **The field.** `project.yaml` gains `id`, a slug of `[a-z0-9-_.]` that begins and ends
  alphanumeric. It is immutable; changing it is the stage-6 `rename` migration. `name` stays the
  display name.
- **What identifies a project today.** Nothing uses `project.yaml` `name` as identity — it is only
  displayed (`core/context.ts`, `commands/mcp.ts`). Snapshots and the hosted landscape key on the L0
  `system.name` and the hosted project id. From stage 2, `id` is the identity: externals key on it,
  and snapshots written from now on carry it beside `projectName`.
- **Defaulting.** A project without `id` gets `slugify(name)`, reported by `PROJECT_ID_DEFAULTED`
  (notice). An empty result, or two projects in one family that default to the same id, is
  `PROJECT_ID_AMBIGUOUS` (warning). An explicit `id` is required before stage 3.
- **The slug helper.** The one existing `slugify` (private, in `src/server/migration.ts`, for hosted
  unit slugs) keeps only `[a-z0-9-]` and falls back to `unit`. Project ids need a shared helper that
  keeps `_` and `.` and has no silent fallback.
- **Writers.** Every writer sets `id`:
  - `wairon init` (`commands/init.ts`, `buildProjectConfig`);
  - `defaultProjectConfig` / `provisionProject` (`core/provision.ts`), used by chained create,
    externalize and doctor's backfill;
  - hosted creation (`server/admin.ts` → `provisionProject(id)`).
- **Hosted collisions (P13).** Hosted creation already sets `name` to the hosted project id, and
  hosted ids are unique per instance. P13 therefore shrinks to projects whose `name` was edited later,
  which `wairon host doctor` lists.
- **Aliases.** The default alias is the id, when the id fits the reference grammar `[a-z0-9-_]+`. A
  dotted id needs an explicit alias.

## 2. Exports — modelled on real module exports

Every level exports, the way every file in a crate or a Node package does. Only the top of a project
is public outside it, like `lib.rs` or `index.js`. And like `export … from`, a level re-exports what a
level below already declares instead of redeclaring it, so the top stays a handful of lines rather
than a copy of every detail.

### Three tiers

| Level | Exports to | Real-code equivalent | Declared in |
| --- | --- | --- | --- |
| component | its own subsystem | a file's exports | its L3 interfaces |
| subsystem | every subsystem of the same project | a module's exports, `pub(crate)` | L1 `publicInterfaces` |
| project | other projects, within each entry's `audience` | `lib.rs` / `index.js` | L0 `publicInterfaces` |

The first two tiers are today's rules, unchanged. The third becomes the only way into a project from
another project (decision 9).

### Entry forms — the same at L1 and L0

```yaml
publicInterfaces:
  # an item this level owns (today's L1 form)
  - component: invoice_portal
    type: REST
    details: Invoicing API

  # one item, one to one — export { payment_portal as payments } from './payments'
  - from: payments
    component: payment_portal
    as: payments

  # a type (entity, value object, enum…) as is — export { money } from './payments'
  - from: payments
    typeDef: money

  # everything a source exports — export * from './shipping'
  - from: shipping
```

- **Sources.** `from` names a source the level can see. At L1 that is another subsystem of the same
  project. At L0 it is a subsystem, or a member or declared external by its alias: a facade project,
  `pub use billing::*`.
- **Own items and re-exports mix freely in one table.** A facade subsystem exports its own Gateway —
  the logic that combines several subsystems — beside pass-through re-exports of the parts it does not
  change. Combining and extending a surface are one table, not a special construct.
- **L0.** L0 owns no components, so every L0 entry is a re-export. Today's L0 entry
  `{ subsystem, component, id }` is read as `{ from: subsystem, component, as: id }`, so every existing
  tree keeps its exports.
- **Not included: interface inheritance.** An L3 interface that inherits another's methods is a
  separate feature; a re-export plus the level's own entries already covers combining and extending
  what a subsystem exposes.

### Resolution — the way a module resolver does it

- **Resolved once.** Each export table is resolved once per scan. Every `from` is followed to the
  item's canonical target `(project, component[, interface] | type)`, memoized per level, so a
  re-export chain costs one walk however many consumers use it.
- **Public names.** A public name is `as`, else the item's own id. A wildcard brings in the source's
  public names unchanged.
- **Snapshots are flat.** A snapshot stores the resolved table: each public name with the contract of
  its canonical target (methods, stereotype, transport, dispatch table, auth, base path), plus the type
  closure. A consumer resolves `alias::name` with one lookup and never walks the producer's chain.
- **Digests follow the contract.** Digests are taken over the canonical contracts. Moving an item
  between subsystems, or restructuring the re-exports, changes nothing for a consumer unless a public
  name or a contract changes.
- **Findings.**
  - `EXPORT_ID_DUPLICATE` (error): one public name bound to two different canonical targets.
    Re-exporting the same target twice under one name is no conflict, as in ES modules.
  - `EXPORT_CYCLE` (error): a re-export chain that leads back to itself.
  - `EXPORT_INVALID` (notice; error in stage 4): an entry whose source or item does not exist or is not
    exported by that source, or an own item the level does not own. No rule checks L0 entries today
    (`core/rules/public-surface.ts` covers L1 only), and the projector silently drops the invalid ones.
  - `EXPORT_WIDENS_AUDIENCE` (error): an L0 entry that declares a wider audience than the member or
    external export it re-exports. A re-export can narrow reach, never widen it, just as `pub use` of a
    `pub(crate)` item does not compile. Only new re-exports of members can trip it, so no existing tree
    newly fails.
- **Existing public names stay put.** Today the projection defaults an L0 entry's id to its
  `interface`, before its component. The migration writes that name as an explicit `as`, so no
  published name, snapshot entry or OpenAPI tag moves.

## 3. Externals

`project.yaml`:

```yaml
externals:
  billing: {}                                   # alias = producer id
  crm: { project: crm }                         # explicit producer id
  ledger: { project: acme.ledger, source: { path: ../ledger } }
```

In stage 2 a producer is found through the family (today's mounts: parent, members, siblings) or an
explicit `source.path`; `source.hosted` arrives with stage 7.

`wairon externals pin [alias…]` writes, for each external:

- **`.wai/externals/<alias>.yaml`** — the producer's resolved project export table, filtered to the
  consumer's audience: the family sees `project`, any other source sees `instance`.
  - Every entry carries a new `componentType`. `SurfaceContractEntrySchema` has no stereotype field
    today: `projectSubsystemSurface` filters on the stereotype but never records it.
  - Types appear both as exported entries and in the closure of the exported signatures.
- **`.wai/externals.lock.yaml`:**

```yaml
externals:
  billing:
    project: billing
    snapshot: .wai/externals/billing.yaml
    digest: sha256:9c1…                          # content of the snapshot, provenance stripped
    used:                                        # public name → method → signature digest
      invoicing: { createInvoice: sha256:4a… }
```

- **`used`** is computed from the consumer's references to the producer.
- **`wairon externals status`** compares each used entry with the live producer when it is reachable,
  as a signature-level superset (decision 19). Anything it cannot compare is reported as unavailable.
  It only reports; verdicts from that comparison arrive with composed validation in stage 4.
- **Commands.** `wairon externals` gains `pin`, `status` and `list`. `wairon surface pin` and
  `wairon surface externals` keep working for one release, with a deprecation line. MCP gains
  `sdd_pin_externals` and `sdd_get_externals_status`, both `scope: tree`; today MCP exposes only
  `sdd_list_external_interfaces`.
- **Gate inputs.** `computeGateStateId` already hashes every root's `.wai/surfaces`; it adds
  `.wai/externals/` and the lock.

## 4. The project graph

- **Today.** No loaded spec records its project. `SpecIndex` holds spec arrays and id→file maps; the
  owning project shows only in a namespace prefix and a file path; `RuleContext` has no project field.
  Nothing models a cross-project graph: `buildProjectGraph` is the web diagram, and hosted relations
  and the landscape work on hosted project ids.
- **New.** `scanSpecsForProject` already walks every mount with its prefix and directory. It now
  records a graph while it does: one node per project root (id, name, parent, mount alias, directory)
  and an owner for every spec id. `RuleContext` gains the graph.
- **Proof.** The property `graph-projection-equals-index` proves the owners agree with the index.

## 5. Findings

| Code | Severity in stage 2 | Fires when |
| --- | --- | --- |
| `EXTERNAL_UNDECLARED` | notice (error next release) | a reference reaches another project the referring project does not declare as an external |
| `EXTERNAL_NOT_EXPORTED` | notice (error in stage 4) | a reference reaches another project at anything but a public name whose audience covers the referrer |
| `DEPRECATED_REFERENCE_FORM` | notice | a `super::` or leading-`::` reference |
| `TRUSTED_LINK_CROSSES_PROJECT` | notice (error in stage 4) | a `trustedLinks` entry names a subsystem of another project |
| `EXPORT_ID_DUPLICATE` | error | §2 |
| `EXPORT_CYCLE` | error | §2 |
| `EXPORT_WIDENS_AUDIENCE` | error | §2 |
| `EXPORT_INVALID` | notice (error in stage 4) | §2 |
| `PROJECT_ID_DEFAULTED` / `PROJECT_ID_AMBIGUOUS` | notice / warning | §1 |

- **trustedLinks across mounts.** The loader and the writer neither qualify nor relativize a
  trustedLink today, and the cross-tree `dependsOn` branch ignores them. A child's link to a parent
  subsystem is therefore never resolved as one; `TRUSTED_LINK_CROSSES_PROJECT` names it plainly.
- **Registration.** Each code is declared in its rule's `codes` and gets a fire and a control fixture
  in `tests/rules-matrix`. The ratchet only shrinks.

## 6. Migration — plan first, applied on confirmation

`wairon doctor` runs `--fix` as a fixed list of steps, with no dry run. `wairon host doctor` already
has the shape to copy: a `MigrationReport { findings, applied }`, a dry run unless `--fix`. The
chaining migration follows it:

- `wairon doctor --report chaining` prints the family plan per owner and changes nothing.
- `wairon doctor --fix` prints the same plan and applies it only after confirmation (`--yes` in a
  non-interactive run). It refuses when a project it must write is absent.

The plan's steps:

1. Write each defaulted `id`.
2. Give each L0 entry that names an `interface` but no `id` that name as an explicit `as`.
3. Convert `.wai/surfaces` pins.
   - The family pin becomes an `externals` entry for the parent.
   - A sibling pin cannot convert as it stands, because it holds L1 components the parent never
     exported. Step 4 handles what it served.
4. For every reference that reaches another project at anything but a public name:
   - add the missing re-export lines to the producer, one `from: <subsystem>` entry per source
     subsystem with the items consumers use, at audience `project`;
   - declare the external on the consumer;
   - pin.

   References keep their current form; stage 3 rewrites them to `alias::name`.

The report doubles as probe P1: its counts over the maintainer's real families size stages 3 and 4.

## 7. Properties

- `pin-is-a-projection`
- `stale-only-when-used-changes`
- `live-and-snapshot-agree` (P8 as a test)
- `undeclared-is-reported-from-every-root`
- `graph-projection-equals-index`
- `public-name-is-the-name`
- `reexport-is-transparent` — a consumer's lock and verdict are identical whether an item is exported
  directly or through any re-export chain
- `export-table-resolved-once`
- `not-exported-is-reported`
- `export-invalid-is-reported`
- `migration-is-plan-first`
- `defaulted-id-is-stable`
- `notice-never-fails-ci`

## 8. Where it lands in the spec tree

The spec text already holds the rule this stage enforces: `system_spec.publicInterfaces` says
cross-project consumption "may only target these entries (never subsystem internals)". Only the
chaining family path breaks it — `surface_projector.projectSubsystemSurface` and
`surface_orchestrator.pinFamilySurfaces` project sibling subsystems' L1 surfaces. Two gaps affect
placement: no spec covers `project.yaml` I/O (writers reach the file directly), and neither doctor
command has a spec.

| Area | Owner | Change |
| --- | --- | --- |
| Notice severity | sdd_validator | `validation_issue.severity` gains `notice`; the CI gate and `valid` ignore it |
| Project identity | sdd_core | `project_config` gains `id` and `externals`, plus pure methods `effectiveId()` and `identity(lockedProjectId?)`. Identity is intrinsic behaviour of the configuration, so it needs no component. Routing every `project.yaml` writer through a store is a retrofit this stage does not attempt. |
| Export entry schema | sdd_core | `public_interface` (L1) and `system_public_interface` (L0) gain optional `from`, `typeDef` and `as`; `type` and `details` become optional for a re-export, which inherits them from its target |
| Export tables | sdd_core | `spec_index` (Index) gains `resolveSubsystemExports` and `resolveProjectExports` — canonical targets, cycle-safe, cached with the same scan — and the `spec_loader` Repository forwards them. They stay on the one Index, because an Index may depend only on its Store: a second export Index would have to re-parse what `spec_index` already holds. The projector and the validator both read them through the facade. |
| Projection | sdd_surfaces | `surface_projector.projectExports(audience)` — the flattened project table, each entry with `componentType` |
| Project graph | sdd_core | new `project_family_index` (Index) fed by `spec_index`'s scan: `listProjects`, `ownerOf(specId)`, `producerOf(reference)` |
| Externals pin, lock, status | sdd_surfaces | `surface_orchestrator.pinExternals` / `getExternalsStatus`; new `externals_lock_store` (Store, read-through `.wai/externals.lock.yaml`) owned by `surface_repository`; snapshots under `.wai/externals/` through `surface_fs_adapter` |
| Findings | sdd_validator | `spec_validator_impl` steps for the codes in §5, through a new `validator_family_adapter` onto `project_family_index` and the export tables |
| Gate inputs | sdd_core | `core_orchestrator.computeGateStateId` also reads `.wai/externals/` and the lock |
| Chaining report and migration | sdd_core, sdd_cli | new `chaining_migration_orchestrator` (Orchestrator): `planChainingMigration`, `applyChainingMigration`; `cli_runner.runDoctor` gains its first L3 method |
| CLI and MCP | sdd_cli, sdd_mcp | `wairon externals` (`pin`, `status`, `list`); MCP `sdd_pin_externals`, `sdd_get_externals_status`, both `scope: tree` |
| Hosted | sdd_host | project creation writes `id` = the hosted project id |

## 9. Delivery

Three pull requests, each shippable alone:

- **2a — notice, identity, export tables:**
  - the `notice` severity and its sweep;
  - `project.yaml` `id`, with defaulting and `PROJECT_ID_*`;
  - the export entry forms and their resolver;
  - `EXPORT_ID_DUPLICATE`, `EXPORT_CYCLE`, `EXPORT_WIDENS_AUDIENCE` and `EXPORT_INVALID`;
  - the projection over the resolved table;
  - `init`, provisioning and hosted creation writing `id`.
- **2b — externals:**
  - the project graph;
  - `externals` declarations;
  - `wairon externals` `pin`, `status` and `list`, with snapshots and lock;
  - the gate inputs;
  - `EXTERNAL_UNDECLARED`, `EXTERNAL_NOT_EXPORTED`, `DEPRECATED_REFERENCE_FORM` and
    `TRUSTED_LINK_CROSSES_PROJECT`;
  - the MCP tools.
- **2c — migration:** `doctor --report chaining` and a confirmed `doctor --fix`.

## 11. Refinements for 2a, after sparring

These supersede the sections above wherever they differ. They were decided with the maintainer — see
[`decisions.md`](decisions.md) § Stage 2a, and the sparring record in
[`responses/fable-5.1-stage2a-spar.md`](responses/fable-5.1-stage2a-spar.md).

- **Identity (§1).**
  - The lock record gains `projectId`; `PROJECT_ID_CHANGED` is an error.
  - ~~Writers backfill a defaulted id on the configuration's next save.~~ Reversed 2026-09-26: no
    ordinary save writes a defaulted id. A default can be wrong (an existing chained child answers
    to its mount's subsystem id, which a save cannot know), so only deliberate writers set one —
    init, provisioning, hosted creation, doctor; 2c's `doctor --fix` sets it for existing projects.
  - A chained child's default id is its subsystem id.
- **Export resolution (§2).**
  - Explicit and own entries shadow wildcard names. Wildcard-versus-wildcard is `EXPORT_ID_DUPLICATE`
    (error), and the name is excluded.
  - Wildcard cycles resolve as a union, plus `EXPORT_CYCLE` as a warning. A named chain that never
    grounds is `EXPORT_CYCLE` as an error.
  - The public name is `as ?? interface ?? component`, and a legacy L0 `id` reads as `as`. A public
    name must fit `[a-z0-9-_]+`, otherwise the entry is `EXPORT_INVALID`.
  - `EXPORT_UNCONSUMABLE` (notice) covers a target that is not a Portal, Gateway or Observer. It
    applies at L0 and to L1 re-exports; own L1 `Custom` entries are unchanged.
  - `EXPORT_WIDENS_AUDIENCE` moves to 2b.
  - An L1 re-export is a name, not a licence to depend on the target: inside a project, `dependsOn`
    still targets the owning subsystem's published component.
  - A legacy L0 entry without `subsystem` infers its source from the component's owner.
- **Types.**
  - An explicit `typeDef` export gives a type a public name. The snapshot lists it separately, because
    a type is not a contract entry.
  - The signature closure stays implicit.
  - The closure is keyed by qualified id, which fixes a silent collision between subsystems that own
    types of the same name.
- **Snapshots.** Entries record `componentType` and the narrowed `interface`. Snapshots and
  `ExternalSurfaceEntry` carry `projectId` beside `projectName`.
- **Readers of L0 entries.**
  - `projectOwnSurface` goes through the resolver; the sibling projector stays untouched until stage 3.
  - The hosted landscape and the canvas read the resolved table instead of raw YAML.
  - The landscape's `public` audience default aligns with the projector's `instance`.
  - `resolveSurfaceRef` stops matching an entry by its backing component when the entry has a public
    name; the fallback itself goes in stage 3.
- **Authoring.**
  - MCP `sdd_set_public_interfaces` accepts `from`, `typeDef`, `interface` and `as`, with `type` and
    `details` optional for a re-export.
  - The schema-field-coverage test gains a nested check for `publicInterfaces` entries.
- **`notice`.**
  - A draft downgrade is `min(resolved, warning)` and never raises a notice.
  - `lint.allow` covers notices.
  - `SEVERITY_RANK` gains `notice` between `off` and `warning`.
  - `--ci` prints and counts notices, and never fails on them.
  - MCP validate returns a separate `notices` list.
  - The lock record counts notices beside errors and warnings.
  - The canvas change needs the SPA rebuilt.
- **Migration (§6).** Step 2 is dropped: the default keeps interface names.
- **2a scope.**
  - Out: `EXPORT_WIDENS_AUDIENCE`.
  - In: `EXPORT_UNCONSUMABLE`, `PROJECT_ID_CHANGED`, the landscape and canvas reading the resolver,
    and the MCP authoring change.

## 12. Modeling decisions during 2a (2026-09-13)

These supersede §8 wherever they differ; they are recorded in [`decisions.md`](decisions.md).

- **Project configuration.** `project_config_repository` (Repository, sdd_core) owns:
  - `project_config_store` (Store, read-through `.wai/project.yaml`);
  - `project_config_registry` (Registry, the write path: pack registration, profile
    apply, project type);
  - `project_config_index` (Index, the read path).

  It ships **before 2a as its own pull request (2a-0)**, migrating every reader and writer — 10
  components in 4 subsystems, 76 code sites — and reducing hosted `pack_registry` to the instance pack
  store. `project_config` keeps identity as the pure methods `effectiveId()` and
  `identity(lockedProjectId?)`; 2a's identity read goes through the Repository (no id backfill — see §11).
- **Export tables.**
  - They become `export_index` (Index, sdd_core), which projects the scanned specs of `spec_index`.
    Both are owned by `spec_loader`, which forwards 1:1.
  - This needs a doctrine change, verified as an edge case: an Index may also depend on another Index
    **of the same Repository**, never in a cycle. It changes the `stereotype-dependencies` rule and its
    rules-matrix fixtures, the architecture standard (§3, §11, the projector-variant row) and the
    sdd-architect skill.
- **Bug found while designing.** `UNUSED_TYPE` counts type fields and interface signatures but not
  type methods, so a type returned only by a type method, such as `project_identity`, is flagged. The
  fix lands in 2a with a rules-matrix control fixture.
- **Export entry type.** A `public_interface` type describes the L1 entry (own items and re-exports).
  `subsystem_spec.publicInterfaces` becomes `PublicInterface[]`.
- **Not in 2a.**
  - The Specialist enforcement track (`rationale`, `SPECIALIST_WITHOUT_RATIONALE`, guidance, and the
    audit of wairon's 19 Specialists) follows stage 2.
  - Conformance for type methods comes later.

## 10. Open technical point — the `notice` severity

`ValidationIssue.severity` is `error | warning` today; `off` exists only as an override. Stage 2 adds
`notice`:

- every surface that lists findings (CLI, MCP, web) reports it;
- `valid` and `--ci` ignore it;
- `rules.sddRuleSeverity` (`src/models/project.ts`, today `error | warning | off`) can raise it to
  `warning` or `error`, or silence it with `off`. Raising a stage-2 code early is how a team opts into
  the stricter rule.

Every consumer today branches `error` versus else-`warning`, and `validate --ci` fails on any
non-waived warning, so an unhandled notice would fail CI as a warning. All 27 such branches must
classify `notice` explicitly:

| File | Branches |
| --- | --- |
| `src/mcp/server.ts` | 5 |
| `src/commands/validate.ts` | 4 |
| `src/core/validation.ts` | 4 |
| `src/core/canvas.ts` | 2 |
| `src/server/admin.ts` | 2 |
| `src/server/web.ts` | 2 |
| `src/commands/doctor.ts` | 2 |
| `src/core/rules/candidate.ts` | 2 |
| `src/cli/index.ts` | 1 |
| `src/commands/lock.ts` | 1 |
| `src/core/rules/declarative-assertions.ts` | 1 |
| `src/core/rules/index.ts` | 1 |
| `web/src/canvas/engine.ts` | 2 |
