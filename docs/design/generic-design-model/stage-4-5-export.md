# Stages 4 and 5 — the design export (and why "runnable" is not a wairon concept)

Status: designed spec-first on `feat/export-seam` (off dev `dab01923`, stages 1 and 2 merged),
2026-10-04. The maintainer settled stage 4, M1–M3 and the three follow-up points (section 2). The
specs are authored and validate with **0 errors and 26 warnings**, and every warning is code that does not exist yet (section 7). No
code, not locked, not committed. Context: [direction.md](direction.md), stages 4 and 5. It builds on
[stage-1-signatures.md](stage-1-signatures.md) (resolved signatures, signature types) and
[stage-2-type-grammar.md](stage-2-type-grammar.md) (canonical types, enums, named scalars).

## What this stage does

1. **Stage 4 is dropped as a wairon concept.** Executable versus library is a packaging decision. The
   export carries the facts the design states, and each consumer decides for itself.
2. **The design export.** It is one JSON document per project holding the whole design, resolved:
   - every element is keyed, and every reference is a key;
   - signatures are inlined;
   - every type position is canonical text plus a parsed expression;
   - narratives are flat step lists.

   The document carries `format: wairon-design`, a `formatVersion`, a written compatibility promise,
   and a JSON Schema generated from its zod schema. It is delivered as `wairon export` and as
   `exportDesign()` from the package's library entry.
3. **A rename trace.**
   - **What records it.** The rename tools write `previousIds` on the renamed spec and
     `previousNames` on a renamed or moved method. The export shows them as `formerly`.
   - **Retired names.** A name in a trace is retired. Reusing it is refused at write, and a hand edit
     that reuses it is reported as `RENAME_TRACE_CONFLICT`.
   - **New tool.** `sdd_rename_type` joins the rename tools.
4. **A published name survives an internal rename.** Renaming a component or type that backs an
   export entry without `as` now writes `as: <old public name>`. Before this change, consumers' pins
   broke silently.

## 1. Measurements

All counts come from two trees:

- wairon's own tree (`.wai/specs`): 12 subsystems, about 1,320 spec files, 4.9 MB of YAML, 427 types;
- the example tree under `examples/wrapper/demo-project`: 1 subsystem, 5 components.

### What "entrypoint" means in the tree

Five mechanisms say "something outside calls this". All five exist for reachability: they seed the
unused-detection walk (`src/core/rules/wiring/unused-detection.ts:28-82`). None of them says how a
program starts.

| Mechanism | wairon's tree | Demo |
|---|---|---|
| Portal / Observer stereotype | 25 Portals, 0 Observers | 1 Portal |
| Published component (L1 `publicInterfaces`) | 22 entries | 1 |
| Lifecycle root (L1 `lifecycle`: init, shutdown, cyclic, interrupt, scheduled) | 2, both `init` (`host_server.init`, `surface_repository.hydrate`) | 0 |
| `invokedBy` (runtime, external, sibling-subsystem) | 8 (3 / 3 / 2) | 0 |
| Endpoint on a Portal method | 211 on 11 Portals: 164 HTTP, 47 Custom | 1 MessageBus `subscribe` |

What the counts show:

- **Custom endpoints are not served by a process.** wairon's tree binds in-process library calls
  to them, such as `@wairon/sdk#buildPack` and `in-process migration.plan`.
- **The `wairon` binary has no entrypoint in the tree.** It is `cli_runner`, a published
  Orchestrator with neither an endpoint nor a lifecycle root.
- **wairon is both an executable and a library**, as a Cargo or npm package can be.

### Export-like outputs

No emitted artifact was close to being the seam. The **surface snapshot** has the right properties:

- it is resolved and schema-typed;
- its types are canonical;
- it is content-addressed.

Its scope, though, is only the public contract, about 35–40% of a whole design. The **canvas model**
has the right scope and the wrong properties: unresolved, display-shaped, unversioned and lossy on
purpose. Producers, the `.waitree` archive, `sdd_get_spec`, status, briefs and the parent excerpt are
each lossy, stored-form or text.

What was about 80% done is the **loader's in-memory model**:

- since stages 1 and 2, every sourced method carries its params, and every type position is
  canonical;
- `statehash.ts` already gathers that model into one object to hash it;
- the surface projector already holds the export resolver, the type closure and `canonicalTypeRef`.

The design export is that model, projected, versioned and documented.

### Identity and renames

- **No spec carries a stored uid.** The only `randomUUID` calls in `src/` are for hosted subjects,
  grants, audit records and share links.
- **What identifies an element.** A spec's identity is its mutable `id`. Methods, fields, params and
  enum values are identified by name. Narrative steps are identified by `stepNumber`, which an edit
  renumbers.
- **What a rename records.**
  - The only stored history was the project's `previousIds`.
  - `renameComponent`, `renameMethod` and `moveMethods` rewrite references and record nothing.
  - Types, subsystems, fields and enum values have no rename operation.
- **What a consumer loses.** A consumer of two exports cannot tell a rename from a delete plus an
  add, so a generator that keeps its user's wired code loses that work on every rename.
- **The side bug.** An export entry without `as` takes its public name from the backing
  interface or component id (`src/core/exports.ts:236, 246`). Renaming that component changes the
  published name and breaks every consumer's pin. No current tree is affected.

## 2. Decisions

### Decided by the maintainer (2026-10-04)

- **Stage 4 is dropped.** "Executable or library" is a packaging and deployment decision outside
  the design layer. The export carries the facts as they are:
  - lifecycle roots with their phases;
  - Portal methods with their transports and endpoints;
  - the L0 export table.

  The project has no derived `kind`, no status line and no canvas badge.
- **M2, identity: the rename trace.** It consists of:
  - `previousIds` on component, interface, implementation and type specs;
  - `previousNames` on contract methods;
  - `formerly` in the export;
  - retired-name reuse refused at write, and `RENAME_TRACE_CONFLICT` on hand edits;
  - the new tool `sdd_rename_type`;
  - `renameComponent` (and `renameType`) writing `as` so that a published name survives.
- **M3, delivery:** the CLI command `wairon export` and the library function `exportDesign()`, plus
  a format page and a JSON Schema generated from the zod schema. There is no MCP tool and no hosted
  route.
- **`approved` is the one verdict the tool has.** It means what `wairon lock-check` and
  `wairon status` mean: the committed record resolved against the gate identity. That identity covers
  the parsed own tree, its governing doctrine, its declared inputs, `composition`, and the direct
  members' approvals. It is never a weaker per-spec digest comparison. The core cannot compute the
  gate identity, so the CLI decides the verdict first (`cli_lock_adapter.checkApproval`, not strict)
  and hands its state in, the same way `status` receives its approvals.
- **JSON Schema:** generated at build time with the `zod-to-json-schema` devDependency (zod is
  3.23).
- **Method-name reuse:** the deviation is accepted. Reusing a retired method name across contracts,
  or by a hand edit, is only reported (`RENAME_TRACE_CONFLICT`). Spec ids, and method names on the
  same contract, are refused at write.
- **Out of this PR:** modelling wairon's own command line as a Portal with `CLI` endpoints, and
  putting the `@wairon/sdk` surface in the L0 export table. This is a separate dogfood follow-up.

### Why stage 4 is not a wairon concept

This reasoning is kept from the proposal; the measurements above are its evidence.

- **The same design packages either way.** A REST design can ship as a service, or as a library a
  host mounts. A PLC program is started by its runtime. A plugin is loaded by its host. The
  architecture is identical in each case, and only the packaging differs. Packaging is the same kind
  of decision as deployment, which wairon leaves out.
- **Any derivation guesses at one consumer's notion of a start.**
  - "Has a lifecycle root" calls the demo, a scenario its platform runs on every message, a
    library.
  - "Has an endpoint" calls wairon's in-process `@wairon/sdk#…` bindings starts.
  - "Has a named transport" works on both trees, but it still asserts something the design never
    said.
- **The facts are enough for any consumer.** A consumer that needs the answer reads the facts:
  - lifecycle roots (the runtime invokes these);
  - endpoints and their transports (calls arrive from outside the process);
  - the export table (what other projects link against).

  It can then decide for its own target, for example "a `main` that runs the init roots and serves
  the HTTP Portals". Different consumers may rightly decide differently.

### Decided in this design (each with its reason in sections 3–5)

- **The artifact.**
  - The design export is a new document. It is not a widened snapshot, because a snapshot is a
    pinned contract and internals would leak into every pin and digest. It is not the canvas model,
    because that is a display model.
  - It follows the principle of Smithy's JSON AST and protobuf descriptors: absolute keys, and
    every reference resolved to such a key.
- **Scope.** One project per document, with its parts folded in. Project members and externals are
  listed as `dependencies`, never inlined.
- **What it leaves out.** Lint, conformance tiers, `symbol` and `exportedVia`, `simPath`, finding
  declarations and timestamps. Pack `ext` data is passed through untouched as the sanctioned
  extension channel.
- **Approval.** The source carries two fields:
  - `approval` is the lock-check state the caller decided: `locked`, `stale` or `unlocked`. It is
    `unjudged` when an in-process caller passed no verdict, and then claims nothing either way.
  - `approved` is true exactly when that state is `locked`.

  Both replace validation findings in the document.
- **Determinism.**
  - Object keys are sorted, element lists are sorted by key, and inner lists keep their declared
    order.
  - There is no timestamp, so equal `stateId`s mean byte-identical documents.
- **Versioning.** `formatVersion` is `MAJOR.MINOR`.
  - A minor version only adds fields or members of a closed set, and consumers ignore what they do
    not know.
  - A major version removes, renames or changes a meaning, and is named in the CHANGELOG.
  - One major is emitted at a time. A design change is never a format change.
- **Keys.**
  - Subsystems, components, interfaces and implementations are keyed by their id.
  - A type is keyed `subsystem::id` when a subsystem owns it, and by its bare id when it is
    system-level.
  - A contract method is keyed `<interface>.<name>`, a type method `<type>.<name>`.
  - Fields, params and enum values are keyed by name within their owner, and steps by number
    within their method.
  - Anything in another project is `alias::publicName`.
- **Where the format lives.** The format types are owned by `sdd_surfaces`. The export is its
  sibling of the snapshot, and both read the core through `surfaces_core_adapter`.
- **The library entry is the published `surface_portal.exportDesign`.** `src/index.ts` re-exports it,
  just as it re-exports the validator portal's entries. There is no new component for the package
  API.
- **Where reuse is refused.** Reusing a retired id at write is refused for spec ids: by every rename
  tool and by the gated write when it creates a new spec. For a method name, it is refused on the
  same contract by `renameMethod`, `moveMethods` and the restatement. Reuse across contracts, and any
  hand edit, is left to `RENAME_TRACE_CONFLICT`.
- **What traces are not.** They are never rewritten by any reference rewrite and never bound as
  references, because they name keys that no longer exist. A re-authoring carries them as unexpressed
  fields. A surface snapshot never carries `previousNames`, so a rename moves no digest beyond the
  name it changed.
- **What escapes the trace.** Externalize and internalize move elements between projects, and no
  single-project trace can follow them. They stay delete-plus-add, and the format page says so.
  There is no backfill: past renames left no trace.

## 3. The design export

### Contents (types `design_*`, owned by `sdd_surfaces`)

| Type | Carries |
|---|---|
| `design_export` | `format` (`wairon-design`), `formatVersion`, `generator` (the wairon version), `source`, `project`, `dependencies`, then `subsystems`, `components`, `interfaces`, `implementations` and `types` |
| `design_source` | `projectId`, `stateId` (`sha256:…`, the cache key), `approval` (the lock-check state: locked, stale or unlocked, or unjudged) and `approved` (true exactly when `approval` is locked) |
| `design_project` | name, vision, boundaries and requirements as text, `targetLanguage`, and `exports` (the resolved L0 table) |
| `design_export_entry` | `publicName`, `targetKind`, `target` (a key), `audience`, `version` and `stability` |
| `design_dependency` | `alias`, `projectId`, `role` (`design_dependency_role`: member, external), the pinned `digest`, and the public names it `uses` |
| `design_subsystem` | key, name, description, status, profile, `targetLanguage`, `lifecycle` (`LifecycleEntrypoint`: phase, component key, method), `exports` (the resolved L1 table), `trustedLinks`, `ext` |
| `design_component` | key, name, description, status, subsystem, `stereotype`, variant, `dependencyClass`, durability, `portalType`, `owns`, `dependsOn`, `emits`, `subscribesTo`, `auth`, `basePath`, `dispatch`, `formerly`, `ext` |
| `design_interface` | key, component, name, description, status, `methods`, `formerly`, `ext` |
| `design_method` | key, name, description, `params`, `returns`, the derived `signature` text, `signatureType` (a named signature type; a method source is inlined and never named), `effect`, `guarantees`, `invokedBy`, `endpoint` (as declared: `transport` plus its address fields), `formerly`, `ext`. Type methods use the same shape |
| `design_param` / `design_field` | name, `type`, `optional`, description; a field also carries `key` and `references` |
| `design_type_ref` | `text` (canonical), and `expression` (a `TypeExpression` whose named members carry resolved keys). The expression is absent when the grammar cannot read the position, so a consumer sees the text as opaque rather than an invented shape |
| `design_implementation` | key, contract, component, name, description, status, `technologies`, `sourcePath`, `methods`, `formerly`, `ext` |
| `design_method_body` | `method` (a key), `detail` (after the stereotype default), `intent`, `calls`, and `narrative` (`NarrativeStep` as stored, with targets as keys) |
| `design_type` | key, kind, name, description, status, `fields`, `methods`, a signature's `params` and `returns`, an enum's `values`, a named scalar's `holds`, `invariants`, `componentClass`, `database`, `table`, `linkedEntity`, `formerly`, `ext` |

### Components and the call path

```
wairon export ─▶ cli_runner.runExport ─▶ cli_lock_adapter.checkApproval   (the lock-check verdict)
                                    └─▶ cli_surfaces_client_adapter.exportDesign(out, approval)
  ─▶ surface_portal.exportDesign   (re-exported by src/index.ts as exportDesign)
  ─▶ surface_orchestrator.exportDesign ─▶ design_exporter.exportDesign
                                      └─▶ surface_transfer_adapter.writeDesignTo   (when --out)
design_exporter ─▶ surfaces_core_adapter: loadSystemSpec, loadSubsystemSpecs*, loadComponentSpecs,
  loadInterfaceSpecs, loadImplementationSpecs*, loadTypeSpecs, resolveProjectExports,
  loadProjectConfig, resolveExternals, computeStateId                            (* new forwarders)
```

- **`design_exporter`** is new: a read Orchestrator with the `projector` variant and status
  `design`. Its implementation is `src/core/design-export.ts`, and its narrative has 24 steps. It
  never decides the approval verdict itself; it stamps the state it is handed.
  - It refuses a tree with no L0 (`no-system`).
  - Everything else is projection: keys, type refs, sections, what to leave out, sorting and the
    stamp.
- **`wairon export [--out <file>]`.**
  - It first decides the approval verdict exactly as `lock-check` does (not strict).
  - With `--out`, it writes the file and reports the path and the approval state.
  - Without it, it prints the JSON to stdout and nothing else, so it pipes cleanly.
  - It exports an unapproved tree too, carrying its state (`stale` or `unlocked`).
  - The command body lives in `src/commands/surface.ts`, beside `runSurface`.

### Documentation (written in wave 5)

- **`docs/design-export.md`, the format page.** It covers:
  - every section and field, and the keys;
  - the compatibility promise;
  - what is left out, and why;
  - the facts a consumer reads to decide "bootable or library";
  - the consumer's rename algorithm (section 4);
  - what escapes the trace (externalize and internalize).
- **`schemas/design-export-1.json`.** It is generated at build time from the zod schema in
  `src/models/design-export.ts` with the `zod-to-json-schema` devDependency, and shipped in the
  package. A test fails when the two drift.
- **`docs/cli.md`:** the `export` command.
- **CHANGELOG:** the new artifact, the rename trace, `as` preservation, and `sdd_rename_type`.

## 4. Rename-stable identity: the rename trace

- **Fields.**
  - `previousIds` (`list<string>`, oldest first) on `component_spec`, `interface_spec`,
    `implementation_spec` and `type_spec`.
  - `previousNames` on `method_signature`. Each entry is a former key `<interface>.<name>`: a rename
    keeps the interface and changes the name, while a move changes the interface.
- **Writers.**
  - `renameComponent` (via `moveRenamedSpecs`) traces the component and its moving `i<id>` and
    `<id>_impl`.
  - `renameMethod` traces the method.
  - `moveMethods` traces each arriving method.
  - The new `renameType` traces the type.

  An author never writes a trace. The restatement carries traces forward as unexpressed fields, and
  `sdd_update_spec` can unset one to release the names it holds.
- **Refusals at write.**
  - `id-retired`: from `renameComponent` and `renameType`, and from the gated write when a create
    gives a new spec an id that a spec of its kind (a type within its owner) lists. The answer comes
    from `spec_index.retiredBy`.
  - `name-retired`: from `renameMethod`, `moveMethods`, and the restatement, for a new method under a
    name its own contract retired.
- **Validation.** Rule `rename-traces` reports `RENAME_TRACE_CONFLICT` (warning) when a trace entry
  equals a live key of the same kind, or when two elements claim one former key.
- **Published names.**
  - `renameComponent` and `renameType` write `as: <old public name>` on every L1 or L0 export entry
    whose public name was derived from the old id, and report it as `keptPublicNames`.
  - `renameMethod` reports the export entries that publish the method as `publishedIn`. It does not
    prevent the rename, because no mainstream export mechanism aliases a single member.
- **The consumer's algorithm (documented on the format page).**
  1. The consumer keeps the keys it generated from.
  2. For a key that is now missing, it resolves the owner first (subsystem, component, interface,
     type) through `formerly`, then the member by name or through the member's own `formerly`.
  3. A match is a rename, and anything left unmatched is a deletion.
  4. Because the trace accumulates, this works across chains and across skipped exports.

## 5. Finding codes and refusals

| Code | Severity | Rule / place | Raised when |
|---|---|---|---|
| `RENAME_TRACE_CONFLICT` | warning | integrity `rename-traces`, registered right after `named-scalar-types` | A trace entry equals a live key of the same kind, or two elements claim one former key (a hand edit; the tools refuse it) |
| `id-retired` | refusal | `core_orchestrator.renameComponent` / `renameType`, `authoring_orchestrator.writeSpec` | A rename or create would give an id that a spec of that kind retired |
| `name-retired` | refusal | `renameMethod`, `moveMethods`, `spec_restatement.applyTo` | A method would take a name its contract retired |
| `no-system` | refusal | `design_exporter.exportDesign` | The tree has no L0 to export |

## 6. Specs touched

**New (20 files)**

- Component `design_exporter`, contract `idesign_exporter` (`exportDesign`) and
  `design_exporter_impl`, all at `design`.
- 16 format types: `design_export`, `design_source`, `design_project`, `design_export_entry`,
  `design_dependency`, `design_dependency_role` (enum), `design_subsystem`, `design_component`,
  `design_interface`, `design_method`, `design_param`, `design_field`, `design_type_ref`,
  `design_implementation`, `design_method_body` and `design_type`. None has a `sourcePath` yet;
  wave 2 adds `src/models/design-export.ts`.
- Type `type_rename`, the `renameType` report.

**Changed (39 files)**

- **Types:**
  - `component_spec`, `interface_spec`, `implementation_spec` and `type_spec` gain `previousIds`;
  - `method_signature` gains `previousNames`;
  - `component_rename` gains `keptPublicNames`;
  - `method_rename` gains `publishedIn`;
  - `spec_index` gains `retiredBy`;
  - `spec_restatement.applyTo` now carries traces and refuses `name-retired`.
- **Component:** `surface_orchestrator`, whose `dependsOn` gains `design_exporter`.
- **Interfaces:**
  - `isurfaces_core_adapter` gains `loadSubsystemSpecs` and `loadImplementationSpecs`;
  - `isurface_transfer_adapter` gains `writeDesignTo`;
  - `isurface_orchestrator`, `isurface_portal` and `icli_surfaces_client_adapter` gain
    `exportDesign(outPath?, approval?)`, and `idesign_exporter.exportDesign` takes `approval?`;
  - `icli_runner` gains `runExport`, which first calls `cli_lock_adapter.checkApproval`;
  - `icore_orchestrator` gains `renameType`, and the `renameComponent`, `renameMethod` and
    `moveMethods` descriptions change;
  - `ispec_maintenance_portal`, `imcp_core_adapter` and `imcp_orchestrator` gain `renameType`;
  - `imcp_portal` gains `sdd_rename_type`;
  - `iauthoring_core_adapter` gains `scanAllSpecs`;
  - `iintegrity_rules` gains `renameTraces`;
  - `isurface_projector.projectOwnSurface` changes its description: traces never enter a snapshot.
- **Implementations:**
  - The matching forwarders: `surfaces_core_adapter_impl`, `surface_transfer_adapter_impl`,
    `surface_orchestrator_impl`, `surface_portal_impl`, `cli_surfaces_client_adapter_impl`,
    `cli_runner_impl`, `spec_maintenance_portal_impl`, `mcp_core_adapter_impl`,
    `mcp_orchestrator_impl`, `mcp_portal_impl` and `authoring_core_adapter_impl`.
  - `core_orchestrator_impl`: `renameComponent` steps 11, 12, 16 and 21; `moveRenamedSpecs` steps 6,
    8 and 12; `renameMethod` steps 11, 12, 16, 23 and 25; `moveMethods` steps 2 and 6; and a new
    17-step `renameType`.
  - `authoring_orchestrator_impl.writeSpec`: new steps 6–9 (the `id-retired` check), with the later
    steps renumbered.
  - `integrity_rules_impl`: `renameTraces`, and **reopened to `design`**, because it names the
    not-yet-written `rename-traces.ts`.
  - `rule_registry_impl`: a register step 16.

## 7. Validate state at hand-off

`sdd_validate_tree` reports **0 errors, 26 warnings, 0 notices**. The baseline before this design was
0/0/0. Every warning is code that does not exist yet:

- `DRAFT_COMPONENT_WARNING` (1): `design_exporter`.
- `MISSING_SOURCE_FILE` (2, in draft context): `src/core/design-export.ts` and
  `src/core/rules/integrity/rename-traces.ts`.
- `UNREALIZED_METHOD` (13):
  - `scanAllSpecs` on the authoring core adapter;
  - `runExport`;
  - `exportDesign` on the CLI client adapter, the surface orchestrator and the surface portal;
  - `renameType` on the core orchestrator, the MCP core adapter, the MCP orchestrator and the
    maintenance portal;
  - `sdd_rename_type`;
  - `loadSubsystemSpecs` and `loadImplementationSpecs` on the surfaces core adapter;
  - `writeDesignTo`.
- `CALL_STEP_UNREALIZED` (1): `writeSpec` step 7 → `authoring_core_adapter.scanAllSpecs`.
- `UNREALIZED_TYPE_METHOD` (1): `spec_index.retiredBy`.
- `UNREALIZED_TYPE` (1): `TypeRename`.
- `UNREALIZED_TYPE_FIELD` (7): `previousIds` ×4, `previousNames`, `keptPublicNames` and
  `publishedIn`.

## 8. Implementation waves (for agents)

Each wave ends green: tests pass, `wairon validate` shows no new errors, and the warnings that wave
targets are gone. Rebuild and reconnect the MCP server after wave 1, because a stale server strips
unknown fields from writes.

1. **Model.**
   - `src/models/specs.ts`: `previousIds` on the component, interface, implementation and type
     schemas, and `previousNames` on the method schema.
   - `src/core/specs.ts`: the reference-field table must **not** list them; the id-space round-trip
     and fix-point fuzz must carry them verbatim; and `spec_index.retiredBy`.
   - `tests/mcp/schema-field-coverage.test.ts`: both fields go in `UPDATE_SPEC_ONLY`.
2. **Format.**
   - New `src/models/design-export.ts`: the zod schemas for the 16 types and the format-version
     constant. Then add `sourcePath` to the 16 types.
   - New `src/core/design-export.ts`: the projector, following the narrative.
   - `src/core/adapters/surfaces-core.ts`: the two new forwarders.
   - Tests:
     - determinism: two runs are byte-identical, and an equal `stateId` gives an equal document;
     - keys, and every reference resolving to a key;
     - type refs: canonical text plus the resolved expression, and the opaque case;
     - a sourced method is inlined;
     - `approval` and `approved` follow the verdict handed in, and are unjudged and false without
       one;
     - the demo tree's MessageBus endpoint and wairon's init roots appear as facts.
3. **Delivery.**
   - `surface_orchestrator.exportDesign` and `surface_transfer_adapter.writeDesignTo` (in
     `src/core/surfaces.ts`).
   - `surface_portal.exportDesign` (in `src/core/surface-portal.ts`), re-exported from
     `src/index.ts`.
   - The CLI client adapter and `runExport` in `src/commands/surface.ts`, registered in
     `src/cli/index.ts` as `export [--out]`. `runExport` calls `checkApproval` (not strict) first
     and passes its state.
   - An e2e journey: export to stdout, then parse it against the shipped schema.
4. **Identity.**
   - `src/core/provision.ts`:
     - traces in `moveRenamedSpecs`, `renameMethod` and `moveMethods`;
     - `as` preservation, with `keptPublicNames` and `publishedIn`;
     - `id-retired` and `name-retired`;
     - the new `renameType`, with the `TypeRename` export.
   - `src/core/authoring.ts`: `applyRestatement` carries the traces and refuses `name-retired`, and
     `writeSpec` steps 6–9.
   - `src/core/adapters/authoring-core.ts`: `scanAllSpecs`.
   - The MCP chain for `sdd_rename_type` (`src/mcp/server.ts`, `src/mcp/adapters/core.ts`,
     `src/core/index.ts`).
   - `src/core/surfaces.ts`: the snapshot drops `previousNames`. Test that a rename moves no digest
     beyond the name.
   - Tests: the existing rename suites, extended.
5. **Rule and docs.**
   - The rule: `src/core/rules/integrity/rename-traces.ts`, registered in `src/core/rules/repository.ts`
     right after `named-scalar-types`, plus a firing fixture and a control in the rules matrix, and
     the rule catalog.
   - Docs: `docs/design-export.md`, the JSON Schema build step (`zod-to-json-schema` as a
     devDependency) and its drift test, `docs/cli.md`, the
     `sdd-architect` skill (renames leave traces; `sdd_rename_type`), and the CHANGELOG.
   - Close-out:
     - promote `design_exporter` and its implementation, and `integrity_rules_impl`, back to
       `complete`;
     - validate to 0 errors and 0 warnings;
     - the human runs `wairon lock` on the branch, and the lock record is committed before the
       merge.

**Follow-up (not this PR):** model wairon's command line as a Portal with `CLI` endpoints, and put
the `@wairon/sdk` surface in the L0 export table, so that wairon's own export states both of the
facts it ships with.

## 9. Still open for the maintainer

Nothing. The three points left open by the first pass were decided on 2026-10-04 (section 2):

- approved is the gate-identity verdict;
- the JSON Schema comes from `zod-to-json-schema`;
- the method-name reuse deviation is accepted.
