# Stage 2a-0 — where `.wai/project.yaml` is read and written

_Working note, 2026-09-13. A read-only Explore agent mapped every access to a project's configuration on `dev` at `f5c33b9`, to size the config Repository migration (stage 2a-0). Kept for the implementation phase; verify line numbers before relying on them._

## Access modes today

Code reaches `project.yaml` in five ways:
1. `loadProjectConfig` / `saveProjectConfig` (`src/config/loader.ts`), which parse against the schema.
2. Raw YAML read/merge/write helpers that bypass the schema: `server/policy.ts`, `server/packs.ts`, `core/extensions.ts`, `commands/init.ts`, and `loader.ts`'s `aiPathsAt().specsDir()`.
3. Existence checks.
4. Deleting a child's whole `.wai` on internalize.
5. Fresh-config builders (`defaultProjectConfig`, `buildProjectConfig`).

## Spec tree (implementations)

R read · W write · E existence · D delete.

| Implementation.method — steps | Component (type, subsystem) | Op | Fields |
|---|---|---|---|
| cli_packs_adapter_impl.addPack 11/12, listPacks 1, removePack 9/11, syncPacks 3; usePack, unusePack, bundlePack (intent) | cli_packs_adapter (Adapter, sdd_cli) | R/W | extensions.packs (selection version/bundle) |
| core_orchestrator_impl.provisionProject 1/3; createChainedSubsystem 7/8; externalizeSubsystem 4; internalizeSubsystem 9 | core_orchestrator (Orchestrator, sdd_core) | W/E/D | whole default config; child deletion |
| extension_orchestrator_impl.loadProjectExtensions 1/3/6; globalPacksEnabled 1–3 (config passed in); diagnoseProjectPacks 1–2 (intent); pinInstalledPacksAsSelections 4–5 (intent) | extension_orchestrator (Orchestrator, sdd_core) | R/W | packs, useGlobalPacks (and whether useGlobalPacks is declared) |
| pack_registry_impl: listProjectPacks, readProjectReferences, executeApprovedListProjectPacks, executeApprovedListProjectProfiles (R); installProjectPack, installProjectPackArchive, removeProjectPack, executeApprovedInstallProjectPack, executeApprovedEnsureProfileInstalled (W) — intent only | pack_registry (Store, sdd_host) | R/W | packs; profileSelection.{requiredPackNames, defaultPackNames, profileIds} |
| project_policy_orchestrator_impl.initializeProjectWithProfile 15/20; executeApprovedInit 11/16; evaluateProjectPolicy 10; reconcileProjectPolicy 16/19/20; getProjectConfig 6; setProjectType 7/8 | project_policy_orchestrator (Orchestrator, sdd_host) | R/W | projectType, profileSelection |
| instructions_specialist_impl.buildServerInstructions 1 | instructions_specialist (Specialist, sdd_skills) | R | projectType |
| spec_validator_impl.validateProjectConfig 1–2 (config passed in); validateSddTree 19/20 | spec_validator (Specialist, sdd_validator) | R | targets; rules.sddRuleSeverity (including a parent project's) |
| tree_archive_adapter_impl.hasSpecTree 1 | tree_archive_adapter (Adapter, sdd_core) | E | file present |
| cli_runner_impl.runValidate 5, runGenerate 2, runInit 9/11 | cli_runner (Orchestrator, sdd_cli) | R/W | targets; whole (init) |
| cli_validator_adapter_impl.runValidation 1/3 | cli_validator_adapter (Adapter, sdd_cli) | R | — |
| skills_exporter_impl.exportSddSkills 1 | skills_exporter (Adapter, sdd_skills) | R | targets |
| cli_mcp_adapter_impl.installMcpServer 2 | cli_mcp_adapter (Adapter, sdd_cli) | R | targets |
| agent_resolver_impl.resolveAgentTopology 8 | agent_resolver (Orchestrator, sdd_core) | R | rules.generateComponentImplementers |

**Forwarders only, which never touch the file:**
- `web_project_orchestrator.createProject`
- `web_portal.webGetProjectConfig` and `webSetProjectConfig`, via `project_ops_orchestrator`
- `admin_orchestrator.executeApprovedCreate` and `createProject`, via `host_core_adapter` and `core_portal.provisionProject`
- `validator_portal.validateProjectConfig`
- `host_request_orchestrator`, which classifies the `getProjectConfig` MCP tool as a read

**Interfaces whose descriptions promise a config read or write:**
- `icli_packs_adapter`
- `icore_orchestrator` / `icore_portal`: provision, chained create, externalize, internalize
- `iextension_orchestrator`, including `defaultPackSelections`
- `ipack_registry`
- `iproject_policy_orchestrator` and `iproject_ops_orchestrator`
- `iweb_portal` and `iweb_project_orchestrator`
- `validateProjectConfig` on `ispec_validator`, `ivalidator_portal` and `icli_validator_adapter`
- `itree_archive_adapter.hasSpecTree`
- `iinstructions_specialist.buildServerInstructions`

## Code (`src/`)

- **`server/packs.ts` ↔ pack_registry:**
  - 236 `scanProjectPackProfiles` (R)
  - 432 `storeListProjectPacks` (R)
  - 449–453 `storeInstallProjectPack` (R/change/W: extensions.packs, useGlobalPacks)
  - 475–479 `storeInstallProjectPackArchive`
  - 487–498 `storeRemoveProjectPack`
  - 533 `readProjectReferences` (raw R: packs, profileSelection)
- **`server/policy.ts` ↔ project_policy_orchestrator.** Raw helpers:
  - 434 `readProjectProfileSelection`
  - 443–445 `recordProjectProfileSelection` (R/merge/W)
  - 453 `readProjectType`
  - 462–464 `writeProjectType` (R/merge/W)

  Called from: `foldAppliedProfile` 550/558, `performInit` 760/773, `evaluateProjectPolicy` 897–898, `reconcileProjectPolicy` 937/956/977/984, `getProjectConfig` 1046–1047, `setProjectType` 1105/1109.
- **`core/extensions.ts` ↔ extension_orchestrator:**
  - 291 `globalPacksEnabled` (object passed in)
  - 579 `loadProjectExtensions` (R)
  - 655 `globalPacksLeftUnset` (raw R: is useGlobalPacks declared?)
  - 699 `diagnoseProjectPacks` (R)
  - 752/768–769 `pinInstalledPacksAsSelections` (R/change/W)
- **`commands/packs.ts` ↔ cli_packs_adapter.** Load, change `extensions`, save:
  - `addPack` 148–152
  - `addPackFromArchive` 230–234
  - `writeSelection` 525–532 (from `usePack`)
  - `bundlePack` 669/694–702 (also selection.version/bundle)
  - `unusePack` 714–723
  - `removePack` 800–813

  Read only: `syncPacks` 572, `listPacks` 737.
- **`core/provision.ts` ↔ core_orchestrator:**
  - `defaultProjectConfig` 38–63
  - `provisionProject` 68 (W)
  - `ensureProjectInitialized` 103–104 (E/W)
  - `childHasSpecsButNoConfig` 209 (E) and `backfillChainedSubprojectConfigs` 236 (W)
  - `createChainedSubsystem` 276 (W child)
  - `externalizeSubsystem` 381 (W child)
  - `internalizeSubsystem` 472 (D child `.wai`)
- **`commands/init.ts` ↔ cli_runner.runInit:**
  - `executeInit` 372 (raw writeYamlFile, whole config)
  - `buildProjectConfig` 543–588
  - `runInitAsExternalSubsystem` 147 (→ `createChainedSubsystem`)
- **`commands/execution.ts`:** `showExecution` 38 (R execution); `setExecutionTier` 117–125 (R/change/W execution.tier).
- **`commands/doctor.ts`:**
  - reads at 116, 156, 261 and 346;
  - writes through `pinInstalledPacksAsSelections` (370) and `backfillChainedSubprojectConfigs` (395).
- **Other readers:**

| Location | Function | Fields |
|---|---|---|
| `commands/generate.ts` 110 | `runGenerate` | → `ensureProjectInitialized` (child W) |
| `commands/generate.ts` 126 | `generateLayer` | rules.materializeAgentFiles |
| `exporters/generate.ts` 47, 63, 132 | — | globalTemplatesDir, execution, targets |
| `commands/validate.ts` 54 | `runValidate` | — |
| `commands/mcp.ts` 258, 394 | — | — |
| `commands/rules.ts` 20 | `listRules` | — |
| `commands/diagram.ts` 67 | `collectIssues` | — |
| `commands/subsystem.ts` 97, 129, 144 | provision calls | child W/D |
| `cli/index.ts` 157 | `runLock` | — |
| `mcp/server.ts` 760, 781, 1522 | `validateTopology`, `getProjectConfig`, `sdd_validate_tree` | — |
| `mcp/server.ts` 910, 1010, 1029 | provision calls | child W/D |
| `core/agent_resolver.ts` 253, 486, 514 | — | — |
| `core/skills.ts` 246 | — | — |
| `core/instructions.ts` 36 | — | — |
| `core/context.ts` 120 | — | — |
| `core/validation.ts` 33, 261 | — | — |
| `core/validation.ts` 584 | — | parent root |
| `core/specs.ts` 3138 | `computeGateStateId` | — |
| `core/authoring.ts` 37 | — | — |
| `core/diagram.ts` 55 | — | — |
| `server/adapters.ts` 103 | — | — |
| `core/treetransfer.ts` 116 | — | E |
| `server/admin.ts` 148 | `provisionProject` | W |

## `src/config/loader.ts` public surface

| Export | What it does |
|---|---|
| `WaiPaths` | 19 path accessors |
| `aiPathsAt(rootDir)` | Resolves `.wai`, falling back to legacy `.wairon`. `specsDir()` raw-reads `paths.specsDir` from project.yaml. |
| `AI_PATHS` | The same accessors, bound to `getProjectRoot()` |
| `isProjectInitialized()` / `assertProjectInitialized()` | Checks that the project is initialized, or throws |
| `loadProjectConfig()` | Asserts, reads the YAML, then `ProjectConfigSchema.parse`, wrapping errors |
| `saveProjectConfig(config)` | `writeYamlFile`, with no validation and no timestamp update |
| `loadRegistry()` | Builds agents from the spec tree |
| `loadTopologyConfig()` / `saveTopologyConfig()` | Loads and saves `.wai/topology.yaml` |

## Mismatches found

- **useGlobalPacks default:** the comment at `core/extensions.ts` 648–651 says the parsed config defaults `useGlobalPacks` to true, but the schema (`models/project.ts` 321) defaults it to false.
- **Tree archive project name:** the type `tree_archive_manifest` says the project name comes from project.yaml, but `treetransfer.ts` 241 and `tree_transfer_orchestrator_impl` step 1 take it from the L0 system spec.

## Registry write semantics, taken from the code

`extensions.packs` holds two kinds of entry: a by-name `PackSelection`, and a deprecated path string. Every pack write
today replaces `extensions` and records `useGlobalPacks` at its effective value (`globalPacksEnabled(config)`); doctor's
pin is the one write that records false. The consumers agent found the first registry draft would change four of these
behaviours, so the registry now mirrors each call site:

| Code | What it does today | Registry method |
|---|---|---|
| `commands/packs.ts` `addPack` 148–152, `addPackFromArchive` 230–234; `server/packs.ts` `storeInstallProjectPack` 449–453, `storeInstallProjectPackArchive` 475–479 | Appends the path string when that exact string is absent | `registerPackRef(ref): boolean` |
| `commands/packs.ts` `removePack` 800–813 | The caller probes path strings for the name and drops the one found; selections are skipped | `deregisterPackRef(ref): boolean` |
| `server/packs.ts` `storeRemoveProjectPack` 487–498 | Finds the first entry of either kind that matches, throws when none, drops it | The caller matches, then `deregisterPackRef` or `removePackSelection` |
| `commands/packs.ts` `writeSelection` 525–532, from `usePack` | Drops same-name selections and appends the new one last (highest precedence); reports whether it replaced one | `upsertPackSelection(selection): boolean` |
| `commands/packs.ts` `unusePack` 714–723 | Drops same-name selections; errors without writing when there are none | `removePackSelection(name): boolean` |
| `commands/packs.ts` `bundlePack` 669/694–702 | Sets version and `bundle` on the bundled selections in place; one save | `markSelectionsBundled(bundled[])` |
| `core/extensions.ts` `pinInstalledPacksAsSelections` 752/768–769 | Appends selections and records `useGlobalPacks: false`; one save | `pinGlobalPacksAsSelections(selections[])` |

Nothing but `create` writes `useGlobalPacks` on its own, so `setGlobalPacksEnabled` was dropped.

Differences that remain, each from a decision already taken:
- A key under `extensions` the schema does not know now survives a pack write, because the Store round-trips unknown
  keys. Today the schema parse drops it.
- `removePackSelection` drops every same-name selection, where the hosted removal dropped only the first match. No
  writer produces duplicates: upsert removes them, and doctor's pin adds only packs that no route applies yet.
- The registry refuses a write when the project has no configuration. Today's raw `writeProjectType` would create a
  minimal file, a path hosted flows never reach.

Checked and unchanged: `create` refuses an existing configuration, and `wairon init` never reaches it with one —
`commands/init.ts` 59–62 returns "Project already initialized" before the write at 372.

Differences found while implementing (wave 1), for the CHANGELOG:
- **Externalizing into a folder that already holds a `project.yaml` is refused before anything moves.** It used to
  overwrite that configuration and its L0. It follows from `create` refusing an existing configuration.
- **`provisionProject` creates the configuration before it writes the L0**, so a root that already has one is refused with
  nothing written. The narrative first wrote the L0; the step order was swapped.
- **A schema failure names the project root** on a second line after today's `Invalid .wai/project.yaml: …`.
- **Registry writes serialize through the schema, so its defaults appear in `project.yaml`** — as every CLI save already
  does. The hosted raw merges (`policy.ts`) used to leave the file otherwise untouched, so a hosted `setProjectType` or
  profile record now also writes the defaults (one diff in a git-backed project, then stable).
- **`wairon init` over a configuration without a spec tree keeps the configuration** and bootstraps the missing tree
  (decided by the maintainer). It used to overwrite `project.yaml` with defaults: init's early return looks for the L0,
  not the configuration, so this case reached the write. Everything else init does still runs there as before (starter
  docs and rules rewritten, guides refreshed), skills and agent files use the targets chosen at the prompt rather than
  the kept configuration's, and a kept configuration that fails the schema is kept as well.
- **Hosted, on a project with no configuration** (unreachable for provisioned projects): the project pack listing is
  empty and the profile catalog has no project tier, where both threw; removing a pack reports "no registered pack
  named …" instead of "project not initialized".
- **`tree_archive_adapter.hasSpecTree` (`treetransfer.ts` 116) stays raw.** It checks the import destination's layout, not
  the bound project's configuration, and its Adapter depends only on `sdk_portal`; moving it would need a spec change.

## Hosted (sdd_host) findings from the migration

- **`readProjectReferences` loses every reference of a project with a selection.** `server/packs.ts` 540 maps `stem()` over
  every `extensions.packs` entry; a by-name selection object makes `path.basename` throw, the catch at 550 returns
  `empty`, and that project's health references disappear — its profile selection included. The derivation moves onto
  the configuration — `project_config.declaredPackNames()` and `declaredProfileIds()`, decided 2026-09-13 — and takes
  a selection's name. A fix with a visible effect on the health report: its own commit, test and CHANGELOG entry.
- **Reference project id.** Today it is `path.basename(rootPath)`. A hosted project's root is `<dataDir>/projects/<id>`
  (`server/projects.ts` 51–53), so the two agree, except for `registerLocalDevProject` (`wairon dev`), whose root is the
  developer's own folder. The migrated derivation takes the record id, which is right in both cases.
- **Hosted policy reads become schema-checked.** `server/policy.ts` read `projectType` and `profileSelection` raw because
  `profileSelection` was once outside the schema. The schema now models it (`models/project.ts` 326–332), so a Store read
  keeps it. The one difference: a `project.yaml` that fails the schema now raises in evaluate, reconcile,
  `getProjectConfig` and `setProjectType` instead of being read partially. The health report catches it per project.
- **The adopted pack's path stays with pack storage.** `executeApprovedEnsureProfileInstalled` vendored and registered
  `.wai/packs/<name>.yaml` itself. With registration moved to the orchestrators, `ProfileApplication` gains
  `adoptedPackRef`, set by the pack registry, so no orchestrator composes the storage layout.

## Readers the first spec pass missed

Found while scoping the code waves: every remaining `loadProjectConfig` caller outside the migrated specs. Each read now
goes through its subsystem's core adapter, as every other reader does.

- **`mcp/server.ts` 1521 (`sdd_validate_tree`).** `imcp_core_adapter` gains `loadProjectConfig`, and
  `mcp_orchestrator_impl.validateTree` reads through it before running the gate. The `validateTopology` and
  `getProjectConfig` MCP tools (760, 781) have no spec at all — an older modelling gap — so their code migrates onto the
  core surface without new specs.
- **`commands/rules.ts` 18–20 (`wairon rules list`).** `cli_rules_adapter_impl.listRules` now checks
  `projectConfigExists` and reads the severity overrides through `core_portal`.
- **`server/adapters.ts` 102–104 (`validateProjectAsComplete`).** `host_validator_adapter` reads rules and projectType
  through `host_core_adapter` before forwarding, exactly as the code does. A pure forward — the callers pass the options —
  would need `ivalidator_portal.validateAsComplete` to declare the options the code already takes; that contract, like
  `validateSddTree`'s, declares none, an older gap in sdd_validator left out of 2a-0.

**For the code migration:** delete `loader.ts`'s `loadProjectConfig` and `saveProjectConfig` rather than keeping them as
aliases. The call-step conformance check matches callees by name, so a leftover direct reader named `loadProjectConfig`
would satisfy a `core_portal.loadProjectConfig` step and hide a half-finished migration.
