> **⚠ LEGACY / SUPERSEDED — do NOT implement from this document.**
> This describes the **pre-ledger** state of waffler_core (before the canonical design sessions). It is retained for historical reference only. A per-service component map is **exactly what the standards should NOT contain** — that is design, not code-style. **Authoritative now:** `docs/waffler_core/CANONICAL_DECISIONS.md` §0.1/§3 (design decisions) + each service's own `docs/waffler_core/services/<service>/COMPONENTS.md`. **NOTE:** this file incorrectly lists `fs_secure`/`fs_zip` as services — they are in-process **extensions** per ledger §18.1 — and it omits `crates`, `runtime`, and `vault`. Where this file conflicts with the ledger, the ledger wins (see the ledger's "Authority order").

---

# Service Component Map

**Version:** 1.0 · **Date:** 2026-05-10

This document defines the ideal component composition for each separate Waffler service.

Use it when:
- creating a new service
- defining the architecture of a service
- checking whether a service design is complete and well separated

Read this together with:
- `12_ARCHITECTURE_CONFORMANCE.md`
- `13_STRICT_COMPONENT_RULES.md`
- `14_COMPONENT_BUILDING_BLOCKS.md`

---

## Purpose

The earlier standards define the allowed building blocks.
This document defines how those building blocks should be assembled per service.

It answers:
- which components each service should contain
- which components are core to the service
- which supporting components may exist around that core
- which component should own which concern

This document describes the perfect architectural state of the system.

---

## Global Rules

Every service should follow this default shape unless there is a strong reason not to:

- one `Portal`
- one or more narrow `Orchestrators`
- zero or one `Supervisor` if the service owns long-lived runtime state
- zero or more `Stores`
- zero or more `Registries` / `Indexes`
- zero or more `Observers`
- zero or more `Specialists`
- zero or more `Actors` if the domain owns live instances

Default rule:
- public commands enter through the `Portal`
- workflows are owned by `Orchestrators`
- runtime ownership belongs to `Supervisor` and `Actor`
- persistence belongs to `Store`
- event subscription belongs to `Observer`
- focused implementation belongs to `Specialist`

---

## Service Index

Service set:

- `core`
- `namespaces`
- `packages`
- `blueprints`
- `types`
- `classes`
- `interfaces`
- `enums`
- `signatures`
- `fs`
- `fs.zip`
- `fs.symlinks`
- `fs.tmp`
- `fs.secure`

Infrastructure services and non-domain runtime foundations:

- `MessageBroker`
- security middleware chain
- lifecycle monitor

These are not normal domain services and are listed separately at the end.

---

## `packages`

### Purpose

Manage package installation, mounting, registration, activation, deactivation, uninstallation,
runtime ownership, aliases, capabilities, and package-derived runtime metadata.

### Core Components

- `PackagePortal`
- `PackageInstallationOrchestrator`
- `PackageMountOrchestrator`
- `PackageRuntimeOrchestrator`
- `PackageRegistry`
- `PackageStore`
- `PackageIndex`
- `PackageSupervisor`
- `PackageActor`
- `PackageNamespaceObserver`
- `PackageChangedObserver`

### Supporting Components

- `PackageUpdateOrchestrator`
- `PackageUninstallationOrchestrator`
- `PackageActivator`
- `PackageDeactivator`
- `PackageRestarter`
- `PackageRepairer`
- `PackagePermissionResolver`
- `PackageManifestLoader`
- `PackageStateLoader`
- `PackageVersionLoader`
- `PackageRuntimeFactory`
- `PackageAliasResolver`
- `PackageUiPluginObserver`
- `PackageCapabilityIndex` if package lookup becomes too broad for one index

### Responsibility Split

- `PackagePortal`
  - handles package bus commands only
- `PackageInstallationOrchestrator`
  - places artifacts into storage
- `PackageMountOrchestrator`
  - reads a namespace-backed package location
  - builds a canonical package-domain entity
  - directly passes that entity into registration
- `PackageRuntimeOrchestrator`
  - compares desired package state against actual runtime state
  - decides whether to do nothing, activate, deactivate, restart, or repair
  - delegates the chosen action to the correct runtime action component
- `PackageRegistry`
  - simplified write-side interface for package domain operations
  - produces package-domain events such as `package.changed`
- `PackageStore`
  - owns authoritative package entity storage
  - stores package entities in memory
  - coordinates persistence of package state
  - persistence may be implemented through VFS/namespaces today and another backend later
- `PackageIndex`
  - read-side manifest, capability, and package lookup
- `PackageSupervisor`
  - owns active package actors
- `PackageActor`
  - owns one running package instance
- `PackageNamespaceObserver`
  - listens for namespace entity events of type `Package`
  - forwards namespace package entity information into the package mount workflow
- `PackageChangedObserver`
  - listens for package write-side change events
  - forwards package change information into the package runtime workflow
- `PackageActivator`
  - performs activation of one package runtime
- `PackageDeactivator`
  - performs deactivation of one package runtime
- `PackageRestarter`
  - performs restart of one package runtime
- `PackageRepairer`
  - performs repair actions for one package runtime
- `PackageManifestLoader`
  - specialist that loads and parses package manifests
- `PackageStateLoader`
  - specialist that loads package state
- `PackageVersionLoader`
  - specialist that loads version information
- `PackageRuntimeFactory`
  - specialist that creates concrete runtime handles for package runtime variants

### Notes

- A domain entity may cache namespace-derived fields such as id, technical name, and display name
  inside its own in-memory object model.
- A package-domain mutation may update that cached package entity immediately even when a
  namespace-owned metadata update is still pending confirmation from `namespaces`.
- `PackageNamespaceObserver` is named for what it observes, not for what it triggers.
- `PackageMountOrchestrator` should directly continue into registration rather than emitting an
  extra intermediate event.
- `PackageRegistry` is the simplified write-side package interface.
- `PackageStore` owns storage and persistence concerns behind that interface.
- `PackageStore` persists package-domain state immediately.
- If a package-domain change requires namespace-owned metadata to change as well, the package domain
  emits a namespace change request event rather than writing namespace files directly.
- That namespace change request is intent only. The corresponding namespace fact becomes true only
  after `namespaces` applies the update and publishes the resulting namespace fact event.
- `PackageRuntimeOrchestrator` is preferred over splitting activation/deactivation into separate
  peer orchestrators.
- Activation, deactivation, restart, and repair should usually be separate focused runtime action
  components under one runtime orchestration layer.
- `packages` may observe factual namespace events afterward to keep its own in-memory domain entity
  aligned with namespace-confirmed structural truth.

### Ideal Event Flow

1. `namespaces` registers or mounts a namespace entity of type `Package`.
2. `namespaces` publishes the namespace package entity event.
3. `PackageNamespaceObserver` receives the event.
4. `PackageNamespaceObserver` forwards the namespace package entity into `PackageMountOrchestrator`.
5. `PackageMountOrchestrator` reads the disk-backed package location.
6. `PackageMountOrchestrator` uses package loading specialists to build a canonical package-domain entity.
7. `PackageMountOrchestrator` directly calls `PackageRegistry` to register or update the package.
8. `PackageRegistry` uses `PackageStore` to write the package entity and coordinate persistence.
9. `PackageRegistry` emits `package.changed` and any more specific package-domain events that are useful.
10. If namespace-owned metadata changed, the package domain emits a namespace metadata change request event.
11. `PackageChangedObserver` receives `package.changed`.
12. `PackageChangedObserver` forwards the package change into `PackageRuntimeOrchestrator`.
13. `PackageRuntimeOrchestrator` compares desired package state vs actual runtime state.
14. `PackageRuntimeOrchestrator` chooses one action: no-op, activate, deactivate, restart, or repair.
15. The chosen runtime action component performs the action.
16. `PackageSupervisor` owns the resulting active or inactive package actor state.
17. `namespaces` handles the namespace metadata change request.
18. `namespaces` persists `.ns` or `.state` as needed.
19. `namespaces` emits a factual namespace event confirming the namespace update.
20. `packages` may consume that factual namespace event to align cached namespace-derived fields.

---

## `namespaces`

### Purpose

Manage the namespace tree, namespace mutations, physical mapping, entity metadata, and VFS-driven
discovery of namespace facts.

### Core Components

- `NamespacePortal`
- `NamespaceOrchestrator`
- `NamespaceRegistrationOrchestrator`
- `NamespaceStore`
- `UnifiedNamespaceRegistry`
- `VfsScanner`

### Supporting Components

- `NamespaceMoveOrchestrator`
- `NamespaceDeleteOrchestrator`
- `NamespaceResolveOrchestrator`
- `NamespaceMutationOrchestrator`
- `NamespacePersistenceCoordinator`
- `DiskSyncTask`
- `EntityTypeRegistry`
- `NamespaceProjectionObserver`

### Responsibility Split

- `NamespacePortal`
  - public namespace command boundary
- `NamespaceOrchestrator`
  - owns namespace service workflows at the public boundary
  - delegates to narrower namespace orchestrators where useful
- `NamespaceRegistrationOrchestrator`
  - owns registration of namespace entities into the namespace domain
  - receives discovered namespace segment information from the scanner path
  - validates and normalizes namespace entity registration
  - registers the namespace entity into the namespace registry
- `NamespaceStore`
  - `.ns`, `.state`, `content.json`, physical persistence
- `UnifiedNamespaceRegistry`
  - in-memory structural truth
  - authoritative namespace entity set in memory
  - once a namespace entity is registered, emits typed namespace-domain events
- `VfsScanner`
  - scans disk for namespace segments and namespace-backed entities
  - directly reports discovered namespace segment information into namespace registration flow
- `NamespaceMoveOrchestrator`
  - owns namespace move and reparent workflows
- `NamespaceDeleteOrchestrator`
  - owns namespace delete workflows
- `NamespaceResolveOrchestrator`
  - owns namespace path and identity resolution workflows
- `NamespaceMutationOrchestrator`
  - optional shared workflow layer for create/rename/move/delete if the service grows
- `NamespacePersistenceCoordinator`
  - optional specialist or orchestrator-owned helper that ensures namespace state is written
    to the persistence backend without leaking persistence details into workflow code
- `EntityTypeRegistry`
  - owns the registered set of valid namespace entity types and custom entity type mappings
- `NamespaceMetadataChangeObserver`
  - optional observer that consumes namespace metadata change request events from other domains and
    forwards them into namespace update workflows

### Notes

- The namespace service must remain the owner of namespace facts.
- VFS scanning is not the package system and not the blueprint system.
- The scanner should directly continue into namespace registration rather than emitting an extra
  intermediate observer hop inside the namespace service.
- Downstream domains should react to typed namespace entity events after namespace registration
  has succeeded.
- `namespaces` is the only service that emits factual namespace events.
- Other domains may emit namespace metadata change request events, but never namespace fact events.
- When `namespaces` receives a namespace metadata change request, it must treat that message as
  intent and only publish namespace fact events after the namespace mutation was actually applied.
- Downstream domains may cache namespace-derived fields locally, but they should treat namespace
  fact events as the final confirmation of structural namespace truth.

### Ideal Event Flow

1. `VfsScanner` discovers a namespace segment or namespace-backed entity on disk.
2. `VfsScanner` directly passes the discovered segment information into `NamespaceRegistrationOrchestrator`.
3. `NamespaceRegistrationOrchestrator` validates the segment shape and entity type.
4. `NamespaceRegistrationOrchestrator` registers the namespace entity into `UnifiedNamespaceRegistry`.
5. `UnifiedNamespaceRegistry` updates the in-memory namespace structure.
6. `NamespaceStore` persists namespace metadata and state as required.
7. The namespace service publishes a typed namespace entity event describing what was registered,
   mounted, updated, moved, renamed, or deleted.
8. Other services subscribe to those namespace events through their own observers.

### Namespace Request vs Fact Events

The namespace service distinguishes clearly between:

- request events
- fact events

Request events are published by other domains when namespace-owned metadata should be changed.
Fact events are published only by `namespaces` after the namespace change has actually succeeded.

Typical request events:

- `namespace.entity_update_requested`
- `namespace.entity_state_change_requested`
- `namespace.entity_rename_requested`

Typical fact events:

- `namespace.entity_registered`
- `namespace.entity_updated`
- `namespace.entity_state_changed`
- `namespace.entity_renamed`
- `namespace.entity_deleted`
- `namespace.entity_moved`

Rule:
- no service except `namespaces` may publish namespace fact events
- request events express intent
- fact events express confirmed truth

### Typed Namespace Events

The namespace service should be the source of events such as:

- `namespace.entity_registered`
- `namespace.entity_updated`
- `namespace.entity_deleted`
- `namespace.entity_moved`
- `namespace.entity_renamed`
- `namespace.entity_state_changed`

The payload should always include:

- namespace entity id
- namespace entity type
- physical location when relevant
- parent identity when relevant
- enough metadata for downstream services to decide whether they care

---

## `blueprints`

### Purpose

Manage blueprint CRUD, validation, compilation, execution, activation, runtime execution records,
and blueprint lifecycle operations.

### Core Components

- `BlueprintPortal`
- `BlueprintMountOrchestrator`
- `BlueprintRuntimeOrchestrator`
- `BlueprintRegistry`
- `BlueprintStore`
- `BlueprintIndex`
- `ActiveBlueprintSupervisor`
- `BlueprintNamespaceObserver`
- `BlueprintChangedObserver`
- `BlueprintCompiler`
- `BlueprintExecutor`

### Supporting Components

- `BlueprintUpdateOrchestrator`
- `BlueprintValidationOrchestrator`
- `BlueprintActivator`
- `BlueprintDeactivator`
- `BlueprintRestarter`
- `BlueprintRepairer`
- `ExecutionRegistry`
- `ExecutionStore`
- `ExecutionIndex`
- `ExecutionActor` if individual executions become first-class runtime instances
- `ExpressionEvaluator`
- `ExpressionFunctionRegistry`
- `ExpressionTypeResolver`
- `CapabilityRouter`
- `BuiltinNodeRegistry`
- `BuiltinFunctionRegistry`
- `BlueprintSerializer`
- `BlueprintValidator`

### Responsibility Split

- `BlueprintPortal`
  - public blueprint command boundary
- `BlueprintMountOrchestrator`
  - reads a namespace-backed blueprint location
  - builds a canonical blueprint-domain entity
  - directly passes that entity into registration
- `BlueprintRuntimeOrchestrator`
  - compares desired blueprint runtime state against actual runtime state
  - decides whether to do nothing, activate, deactivate, restart, or repair
  - delegates the chosen action to the correct runtime action component
- `BlueprintRegistry`
  - simplified write-side interface for blueprint domain operations
  - produces blueprint-domain events such as `blueprint.changed`
- `BlueprintStore`
  - owns authoritative blueprint entity storage
  - stores blueprint entities in memory
  - coordinates persistence of blueprint-domain state
- `BlueprintIndex`
  - read-side blueprint lookup, trigger lookup, and execution-related lookup views
- `ActiveBlueprintSupervisor`
  - owns active blueprint runtime instances and long-lived blueprint runtime state
- `BlueprintNamespaceObserver`
  - listens for namespace entity events of type `Blueprint`
  - forwards namespace blueprint entity information into the blueprint mount workflow
- `BlueprintChangedObserver`
  - listens for blueprint write-side change events
  - forwards blueprint change information into the blueprint runtime workflow
- `BlueprintCompiler`
  - compiles blueprint definitions into an executable or validated runtime form
- `BlueprintExecutor`
  - executes one compiled blueprint invocation
- `BlueprintActivator`
  - performs activation of one blueprint runtime
- `BlueprintDeactivator`
  - performs deactivation of one blueprint runtime
- `BlueprintRestarter`
  - performs restart of one blueprint runtime
- `BlueprintRepairer`
  - performs repair actions for one blueprint runtime
- `ExecutionRegistry`
  - simplified write-side interface for execution records if execution history becomes a first-class subdomain
- `ExecutionStore`
  - authoritative execution record storage if execution history is retained
- `ExecutionIndex`
  - read-side lookup for execution history, active runs, and diagnostics
- `ExecutionActor`
  - owns one long-lived execution instance if blueprint execution becomes actor-shaped
- `ExpressionEvaluator`
  - evaluates expressions used inside blueprints
- `ExpressionFunctionRegistry`
  - owns registered inline/expression functions
- `ExpressionTypeResolver`
  - resolves expression types and contracts
- `CapabilityRouter`
  - resolves which capability endpoint or provider a blueprint node should call
- `BuiltinNodeRegistry`
  - owns the registered built-in node set
- `BuiltinFunctionRegistry`
  - owns the registered built-in inline function set
- `BlueprintSerializer`
  - specialist that loads and writes blueprint canonical files
- `BlueprintValidator`
  - specialist that validates blueprint structure and semantics

### Notes

- `blueprints` follows the same structural pattern as `packages`: observer -> mount orchestrator ->
  registry -> store/index -> runtime orchestration.
- The blueprint runtime stack remains inside the `blueprints` service as internal subdomains rather
  than being split into separate top-level services.
- A blueprint-domain entity may cache namespace-derived fields such as id, technical name, and display name
  inside its own in-memory object model.
- `BlueprintStore` persists blueprint-domain state immediately.
- If a blueprint-domain change requires namespace-owned metadata to change as well, the blueprint
  domain emits a namespace change request event rather than writing namespace files directly.
- That namespace change request is intent only. The corresponding namespace fact becomes true only
  after `namespaces` applies the update and publishes the resulting namespace fact event.
- Expressions, capability routing, built-in nodes, and inline functions should remain outside the
  main runtime orchestrator as separate Specialists or Registries.
- `BlueprintRuntimeOrchestrator` is preferred over splitting activation/deactivation into separate
  peer orchestrators.

### Blueprint Runtime Subdomains

The following runtime-oriented subdomains belong inside the `blueprints` service and collaborate
directly through injected components rather than through separate top-level service boundaries:

- `expression engine`
  - `ExpressionEvaluationOrchestrator`
  - `ExpressionEvaluator`
  - `ExpressionParser`
  - `ExpressionTypeResolver`
- `inline functions`
  - `ExpressionFunctionRegistry`
  - `BuiltinFunctionRegistry`
- `node and capability execution`
  - `CapabilityRouter`
  - `BuiltinNodeRegistry`
- `execution records`
  - `ExecutionRegistry`
  - `ExecutionStore`
  - `ExecutionIndex`

Rule:
- expression evaluation, inline functions, built-in nodes, and capability routing are internal
  blueprint runtime subdomains
- they may be exposed through `blueprints:*` commands when needed
- they do not register as separate top-level bus services

### Ideal Event Flow

1. `namespaces` registers or mounts a namespace entity of type `Blueprint`.
2. `namespaces` publishes the namespace blueprint entity event.
3. `BlueprintNamespaceObserver` receives the event.
4. `BlueprintNamespaceObserver` forwards the namespace blueprint entity into `BlueprintMountOrchestrator`.
5. `BlueprintMountOrchestrator` reads the disk-backed blueprint location.
6. `BlueprintMountOrchestrator` uses blueprint loading and validation specialists to build a canonical blueprint-domain entity.
7. `BlueprintMountOrchestrator` directly calls `BlueprintRegistry` to register or update the blueprint.
8. `BlueprintRegistry` uses `BlueprintStore` to write the blueprint entity and coordinate persistence.
9. `BlueprintRegistry` emits `blueprint.changed` and any more specific blueprint-domain events that are useful.
10. If namespace-owned metadata changed, the blueprint domain emits a namespace metadata change request event.
11. `BlueprintChangedObserver` receives `blueprint.changed`.
12. `BlueprintChangedObserver` forwards the blueprint change into `BlueprintRuntimeOrchestrator`.
13. `BlueprintRuntimeOrchestrator` compares desired blueprint state vs actual runtime state.
14. `BlueprintRuntimeOrchestrator` chooses one action: no-op, activate, deactivate, restart, or repair.
15. The chosen runtime action component performs the action.
16. `ActiveBlueprintSupervisor` owns the resulting active or inactive blueprint runtime state.
17. `namespaces` handles the namespace metadata change request.
18. `namespaces` persists `.ns` or `.state` as needed.
19. `namespaces` emits a factual namespace event confirming the namespace update.
20. `blueprints` may consume that factual namespace event to align cached namespace-derived fields.

---

## `types`

### Purpose

Manage `WafflerType` entities and their CRUD, resolution, and inheritance-aware views.

### Core Components

- `TypePortal`
- `TypeMountOrchestrator`
- `TypeRegistry`
- `TypeStore`
- `TypeIndex`
- `TypeNamespaceObserver`

### Supporting Components

- `TypeUpdateOrchestrator`
- `TypeResolveOrchestrator`
- `TypeChangedObserver`
- `TypeValidator`
- `TypeCycleChecker`
- `TypeResolver`
- `TypeSerializer`
- `ResolvedTypeIndex`

### Responsibility Split

- `TypePortal`
  - public type command boundary
- `TypeMountOrchestrator`
  - reads a namespace-backed type location
  - builds a canonical type-domain entity
  - directly passes that entity into registration
- `TypeRegistry`
  - simplified write-side interface for type domain operations
  - produces type-domain events such as `type.changed`
- `TypeStore`
  - owns authoritative type entity storage
  - stores type entities in memory
  - coordinates persistence of type-domain state
- `TypeIndex`
  - read-side type lookup by id, technical name, and namespace location
- `TypeNamespaceObserver`
  - listens for namespace entity events of type `type`
  - forwards namespace type entity information into the type mount workflow
- `TypeUpdateOrchestrator`
  - owns explicit type update workflows when one write operation spans multiple steps
- `TypeResolveOrchestrator`
  - owns resolved-type workflows that traverse inheritance or composition chains
- `TypeChangedObserver`
  - listens for type write-side change events
  - updates projections or triggers downstream recalculation when needed
- `TypeValidator`
  - validates structural correctness of one type definition
- `TypeCycleChecker`
  - detects invalid inheritance or self-reference cycles
- `TypeResolver`
  - resolves fields, inherited members, and effective type shape
- `TypeSerializer`
  - specialist that loads and writes `type.json`
- `ResolvedTypeIndex`
  - optional read-side projection of fully resolved types if resolving on demand becomes too expensive

### Notes

- `types` follows the same namespace-origin model as `packages` and `blueprints`.
- A type-domain entity may cache namespace-derived fields such as id, technical name, and display name
  inside its own in-memory object model.
- `TypeStore` persists type-domain state immediately.
- If a type-domain change requires namespace-owned metadata to change as well, the type domain emits
  a namespace change request event rather than writing namespace files directly.
- Types are passive domain entities. They do not need a runtime supervisor or actor.
- Resolution, validation, and cycle checking should remain narrow Specialists unless they become
  clearly multi-step workflows.

### Ideal Event Flow

1. `namespaces` registers or mounts a namespace entity of type `type`.
2. `namespaces` publishes the namespace type entity event.
3. `TypeNamespaceObserver` receives the event.
4. `TypeNamespaceObserver` forwards the namespace type entity into `TypeMountOrchestrator`.
5. `TypeMountOrchestrator` reads the disk-backed type location.
6. `TypeMountOrchestrator` uses loading and validation specialists to build a canonical type-domain entity.
7. `TypeMountOrchestrator` directly calls `TypeRegistry` to register or update the type.
8. `TypeRegistry` uses `TypeStore` to write the type entity and coordinate persistence.
9. `TypeRegistry` emits `type.changed` and any more specific type-domain events that are useful.
10. If namespace-owned metadata changed, the type domain emits a namespace metadata change request event.
11. `TypeChangedObserver` may update projections or resolved views when the type changes.
12. `namespaces` handles the namespace metadata change request.
13. `namespaces` persists `.ns` or `.state` as needed.
14. `namespaces` emits a factual namespace event confirming the namespace update.
15. `types` may consume that factual namespace event to align cached namespace-derived fields.

---

## `classes`

### Purpose

Manage `WafflerClass` entities, methods, owned blueprints, inheritance, and resolved class views.

### Core Components

- `ClassPortal`
- `ClassMountOrchestrator`
- `ClassRegistry`
- `ClassStore`
- `ClassIndex`
- `ClassNamespaceObserver`
- `ClassOwnedBlueprintObserver`

### Supporting Components

- `ClassUpdateOrchestrator`
- `ClassResolveOrchestrator`
- `ClassMethodOrchestrator`
- `ClassChangedObserver`
- `ClassValidator`
- `ClassCycleChecker`
- `ClassResolver`
- `ClassSerializer`
- `ResolvedClassIndex`

### Responsibility Split

- `ClassPortal`
  - public class command boundary
- `ClassMountOrchestrator`
  - reads a namespace-backed class location
  - builds a canonical class-domain entity
  - directly passes that entity into registration
- `ClassRegistry`
  - simplified write-side interface for class domain operations
  - produces class-domain events such as `class.changed`
- `ClassStore`
  - owns authoritative class entity storage
  - stores class entities in memory
  - coordinates persistence of class-domain state
- `ClassIndex`
  - read-side class lookup by id, technical name, and namespace location
- `ClassNamespaceObserver`
  - listens for namespace entity events of type `class`
  - forwards namespace class entity information into the class mount workflow
- `ClassOwnedBlueprintObserver`
  - observes blueprint facts relevant to class-owned method blueprints
  - forwards them into class-owned blueprint update workflows when needed
- `ClassUpdateOrchestrator`
  - owns explicit class update workflows when one write operation spans multiple steps
- `ClassResolveOrchestrator`
  - owns resolved-class workflows that traverse inheritance and implementation chains
- `ClassMethodOrchestrator`
  - owns workflows around creation, update, linking, or removal of owned method blueprints
- `ClassChangedObserver`
  - listens for class write-side change events
  - updates projections or triggers downstream recalculation when needed
- `ClassValidator`
  - validates structural correctness of one class definition
- `ClassCycleChecker`
  - detects invalid inheritance cycles
- `ClassResolver`
  - resolves properties, inherited members, implementations, and effective class shape
- `ClassSerializer`
  - specialist that loads and writes `class.json`
- `ResolvedClassIndex`
  - optional read-side projection of fully resolved classes if resolving on demand becomes too expensive

### Notes

- `classes` follows the same namespace-origin model as the other passive entity services.
- A class-domain entity may cache namespace-derived fields such as id, technical name, and display name
  inside its own in-memory object model.
- `ClassStore` persists class-domain state immediately.
- If a class-domain change requires namespace-owned metadata to change as well, the class domain emits
  a namespace change request event rather than writing namespace files directly.
- Classes are richer than `types`, `interfaces`, `enums`, and `signatures` because they may own
  method blueprints and future behavior-rich concepts.
- Method-blueprint ownership should remain explicit and not leak into unrelated blueprint code.
- Classes still do not need a runtime supervisor or actor unless classes themselves become active runtime units.

---

## `interfaces`

### Purpose

Manage `WafflerInterface` entities and interface-related resolution and validation.

### Core Components

- `InterfacePortal`
- `InterfaceMountOrchestrator`
- `InterfaceRegistry`
- `InterfaceStore`
- `InterfaceIndex`
- `InterfaceNamespaceObserver`

### Supporting Components

- `InterfaceUpdateOrchestrator`
- `InterfaceChangedObserver`
- `InterfaceValidator`
- `InterfaceResolver`
- `InterfaceSerializer`
- `ResolvedInterfaceIndex`

### Notes

- `interfaces` follows the same structural pattern as `types`.
- Interfaces are passive domain entities. They do not need runtime supervision.
- `InterfaceRegistry`, `InterfaceStore`, and `InterfaceIndex` should mirror the same write/store/read split used elsewhere.

---

## `enums`

### Purpose

Manage `WafflerEnum` entities and enum-related lookup and validation.

### Core Components

- `EnumPortal`
- `EnumMountOrchestrator`
- `EnumRegistry`
- `EnumStore`
- `EnumIndex`
- `EnumNamespaceObserver`

### Supporting Components

- `EnumUpdateOrchestrator`
- `EnumChangedObserver`
- `EnumValidator`
- `EnumSerializer`

### Notes

- `enums` follows the same structural pattern as `types`.
- Enums are passive domain entities. They do not need runtime supervision.
- Keep enum logic narrow. Validation and serialization should remain Specialist-heavy.

---

## `signatures`

### Purpose

Manage `WafflerSignature` entities and callable-shape metadata.

### Core Components

- `SignaturePortal`
- `SignatureMountOrchestrator`
- `SignatureRegistry`
- `SignatureStore`
- `SignatureIndex`
- `SignatureNamespaceObserver`

### Supporting Components

- `SignatureUpdateOrchestrator`
- `SignatureChangedObserver`
- `SignatureValidator`
- `SignatureResolver`
- `SignatureSerializer`

### Notes

- `signatures` follows the same structural pattern as `types`.
- Signatures are passive domain entities. They do not need runtime supervision.
- Keep signature logic narrow and focused on callable-shape semantics.

---

## `core`

### Purpose

Expose the system control plane for shared platform concerns such as configuration, lifecycle,
runtime status, and policy control over shared infrastructure like security.

### Core Components

- `CorePortal`
- `CoreOrchestrator`
- `SystemConfigurationRegistry`
- `SystemConfigurationStore`
- `RuntimeStatusIndex`

### Supporting Components

- `LifecycleOrchestrator`
- `SecurityControlOrchestrator`
- `SecretsVaultRegistry`
- `SecretsVaultStore`
- `SecretsVaultIndex`
- `ConnectionsVaultIndex`
- `VaultExchangeOrchestrator`
- `FeatureFlagRegistry`
- `FeatureFlagStore`
- `GlobalVariableRegistry`
- `GlobalVariableStore`
- `SystemStatusSpecialist`
- `CoreChangedObserver`

### Responsibility Split

- `CorePortal`
  - public command boundary for system control commands
- `CoreOrchestrator`
  - owns top-level core workflows
  - delegates to narrower control-plane orchestrators where useful
- `SystemConfigurationRegistry`
  - simplified write-side interface for system-wide configuration changes
  - produces core-domain events such as `core.configuration_changed`
- `SystemConfigurationStore`
  - owns authoritative storage of system-wide configuration values
  - coordinates persistence of system control-plane state
- `RuntimeStatusIndex`
  - read-side lookup for current system and subsystem status
- `LifecycleOrchestrator`
  - owns startup, shutdown, reload, and other system lifecycle workflows
- `SecurityControlOrchestrator`
  - owns control-plane workflows that manage shared security policy
  - does not execute enforcement directly
- `SecretsVaultRegistry`
  - simplified write-side interface for the authoritative vault domain owned by the main system instance
- `SecretsVaultStore`
  - authoritative storage for secrets and derived connections inside the vault domain
- `SecretsVaultIndex`
  - read-side lookup for secret metadata, class matching, and inheritance-aware secret discovery
- `ConnectionsVaultIndex`
  - read-side lookup for derived connection metadata, class matching, and connection lookup by parent secret
- `VaultExchangeOrchestrator`
  - owns secure one-time-token exchange workflows used when another service must obtain a secret or connection
- `FeatureFlagRegistry`
  - simplified write-side interface for platform feature flags if those become first-class
- `FeatureFlagStore`
  - authoritative storage for feature flags
- `GlobalVariableRegistry`
  - simplified write-side interface for system-scoped variables if those remain part of `core`
- `GlobalVariableStore`
  - authoritative storage for system-scoped variables
- `SystemStatusSpecialist`
  - assembles health, diagnostics, and runtime summaries from underlying indexes and services
- `CoreChangedObserver`
  - optional observer that reacts to relevant infrastructure fact events and refreshes core projections

### Notes

- `core` is a control plane, not a business domain and not a generic dumping ground.
- Shared security is an underground cross-cutting platform component controlled through `core`,
  not modeled as an ordinary domain service.
- The authoritative vault domain lives with the main shared security instance and is controlled
  through `core`, not replicated across every service instance.
- Connections are vault children derived from secrets, not a separate top-level service.
- The vault domain supports metadata-only listing and filtering by secret/connection class,
  including inheritance-aware matching across the class chain.
- The vault domain uses one write-side registry over one authoritative store, with separate read-side
  indexes for secret metadata and connection metadata.
- Secret and connection types are class-based domain objects defined through the namespace/type/class
  system.
- Every secret type extends `BaseSecret`.
- Every connection type follows the same class-based pattern as secrets.
- The base secret contract may begin as one encrypted value, while richer secret classes may later
  encrypt multiple fields as one object payload.
- Vault persistence stores the encrypted object payload together with the class type identity and
  metadata needed for lookup and reconstruction.
- `core` may control shared infrastructure policy, but enforcement belongs in the underlying
  infrastructure components and middleware, not inside `core` itself.
- `core` should not absorb package, blueprint, namespace, filesystem, or type-domain workflows.
- If a concern grows into its own domain, it should become its own service rather than expanding `core`.

### Ideal Event Flow

1. A caller sends a system control command through `CorePortal`.
2. `CorePortal` forwards the command into `CoreOrchestrator` or a narrower control-plane orchestrator.
3. The orchestrator validates intent and delegates to the correct registry.
4. The relevant registry updates its store and emits a core-domain event such as `core.configuration_changed`.
5. If the change affects shared infrastructure policy, `core` emits a control-plane request event for that infrastructure layer.
6. The underlying infrastructure component applies the policy change.
7. The infrastructure component emits a factual event confirming the applied change.
8. `core` may consume that factual event to refresh status indexes and control-plane projections.
9. If the change targets the vault domain, the authoritative vault registry and store apply it locally under the main shared security instance rather than broadcasting vault contents over the bus.

---

## `fs`

### Purpose

Provide filesystem operations through a bus-safe service boundary.

### Mandatory Components

- `FsPortal`
- `FsOrchestrator`
- `FsPolicyObserver` if bus events or policy updates drive FS behavior

### Optional Components

- `FsReadSpecialist`
- `FsWriteSpecialist`
- `FsListSpecialist`
- `FsAuditObserver`
- `FsRuleResolver`

### Notes

- The filesystem family is intentionally split into modular built-in packages/services rather than
  one monolith.
- `fs` is the required base service because the system depends on filesystem-backed persistence and
  VFS storage.
- The other filesystem services are optional layered capabilities on top of `fs`.
- If a deployment does not need one of those capabilities, it should be possible to omit that
  service/package.
- This service should be capability-oriented.
- Most actual operation logic should live in Specialists.

---

## `fs.secure`

### Purpose

Provide policy-gated secure filesystem operations.

### Mandatory Components

- `FsSecurePortal`
- `FsSecureOrchestrator`

### Optional Components

- `FsSecureRuleResolver`
- `FsSecureAuditObserver`
- `FsSecureReadSpecialist`
- `FsSecureWriteSpecialist`

### Notes

- `fs.secure` is a modular helper service layered on top of `fs`.
- It exists to provide secure storage behavior, encryption-layer support, and filesystem integrity
  validation behavior when that protection mode is enabled.
- `fs.secure` should remain optional at the package/service composition level even if many
  deployments will treat it as effectively required.

---

## `fs.zip`

### Purpose

Provide archive-oriented filesystem operations.

### Mandatory Components

- `FsZipPortal`
- `FsZipOrchestrator`

### Optional Components

- `ZipExtractSpecialist`
- `ZipInspectSpecialist`

### Notes

- `fs.zip` is an optional archive capability layered on top of `fs`.
- It should be possible to ship or install the system without `fs.zip` when archive support is not
  needed.

---

## `fs.symlinks`

### Purpose

Provide symlink-specific operations behind a capability boundary.

### Mandatory Components

- `FsSymlinksPortal`
- `FsSymlinksOrchestrator`

### Optional Components

- `SymlinkCreateSpecialist`
- `SymlinkInspectSpecialist`

### Notes

- `fs.symlinks` is an optional capability layer, not part of the required persistence core.
- It is intentionally split out so deployments that do not want symlink behavior can omit it.

---

## `fs.tmp`

### Purpose

Provide temporary filesystem operations and isolated temp lifecycle management.

### Mandatory Components

- `FsTmpPortal`
- `FsTmpOrchestrator`

### Optional Components

- `TmpAllocationSpecialist`
- `TmpCleanupSupervisor` if temp allocations gain background lifecycle management

### Notes

- `fs.tmp` is an optional capability layer, not part of the required persistence core.
- It may later move into its own isolated Waffler package just like the other non-core FS
  capabilities.

---

## Shared Type Services

These services all follow the same target shape:

- `types`
- `classes`
- `interfaces`
- `enums`
- `signatures`

Default composition:
- one `Portal`
- one `Orchestrator`
- one `Store`
- one `Index` or `Registry`
- optional validators/resolvers as `Specialists`
- optional observers for event-driven projection updates

Rule:
- do not let these portals directly absorb store and workflow logic

---

## Infrastructure: Message Bus

This is not a normal domain service.

### Mandatory Components

- `MessageBroker`
- `MiddlewareChain`
- `BusHandle`

### Optional Components

- rate limiter
- audit middleware
- security middleware

### Notes

- no domain workflows belong here
- no service-specific policy belongs here

---

## Infrastructure: Security

Security is a shared cross-cutting platform component with one authoritative management instance
and optional clone/client instances for distributed or package-hosted runtimes.

### Authoritative Shared Instance

- `SecurityMiddleware`
- `SecurityOrchestrator`
- `FirewallRuleStore`
- `GroupStore`
- `SecretsVaultRegistry`
- `SecretsVaultStore`
- `SecretsVaultIndex`
- `ConnectionsVaultIndex`
- `VaultExchangeOrchestrator`
- optional security observers for audit/event integration

### Clone / Client Instance

- `SecurityMiddleware`
- `RuleProjectionStore`
- `GroupProjectionStore`
- optional `SecuritySyncObserver`

### Rules

- one authoritative shared security instance owns:
  - firewall/permission rules
  - permission groups
  - the vault domain
- one authoritative shared security instance exposes:
  - one write-side vault registry
  - one authoritative vault store
  - one secrets metadata index
  - one connections metadata index
- clone/client security instances may receive synced rules and groups
- clone/client security instances must not receive replicated secrets vault contents over the message bus
- clone/client security instances must not receive replicated connection payloads over the message bus
- clone/client security instances apply authorization policy locally from synced projections
- clone/client security instances do not expose management hooks for authoritative security mutation
- in the single-binary bootstrap case, baked-in services should share the same security instance directly
  rather than creating separate synced clones
- distributed or package-hosted runtimes may use clone/client security instances that subscribe to
  rule/group sync events
- connections are derived children of secrets inside the same vault domain
- one secret may create multiple connection records
- metadata listing may expose vault entries without exposing secret values
- secret and connection metadata lookup should go through indexes, not directly through the store
- class-chain matching should be covariance-like for lookup:
  - looking for a base class may return derived classes
  - looking for a derived class must not return its base class

### Event Model

- authoritative security changes emit sync events for:
  - permission rules
  - permission groups
- vault mutations do not emit secret payload replication events
- vault mutations do not emit connection payload replication events
- clone/client instances subscribe only to rule/group sync events
- authoritative vault writes remain local to the main shared instance

### Notes

- authorization policy belongs in shared security orchestration and middleware
- service-specific workflows still belong to their own domains
- the vault is not a bus-replicated domain
- connections stored under the vault follow the same locality rule as secrets
- class-based secret and connection lookup belongs to the vault domain
- secure OTT-based exchange belongs to the vault domain, not to ordinary domain services

---

## Infrastructure: Lifecycle

### Mandatory Components

- `LifecycleMonitor` or equivalent runtime lifecycle coordinator

### Optional Components

- service health observers
- restart policy specialists

### Notes

- this is infrastructure, not a normal business domain service

---

## Service Bootstrapping

Bootstrapping is a first-class architectural concern.

### Rule

Every service must be able to bootstrap itself through a dedicated startup/init entrypoint.

That entrypoint should:

- create the service's own internal components
- register its own bus handlers and observers
- accept required shared infrastructure through arguments
- work both in:
  - single-binary shared-instance mode
  - isolated/distributed service mode

### Required Pattern

Each service should expose a bootstrap/init method conceptually like:

- `ServiceBootstrapArgs`
- `bootstrap(args) -> ServiceRuntime`

Where:

- `ServiceBootstrapArgs`
  - contains the shared collaborators the service requires
  - for example:
    - message bus handle
    - security component instance
    - filesystem capability instance
    - runtime configuration
- `ServiceRuntime`
  - returns the service's live handles, portals, and owned runtime pieces

### Shared vs Clone Infrastructure

Services must depend on behavior contracts, not on whether an infrastructure dependency is shared
or cloned.

Example:

- in single-binary mode:
  - the runtime bootstrapper passes the shared in-process security instance by `Arc`
- in distributed mode:
  - the runtime bootstrapper passes a clone/client security instance with the same behavioral contract

From the service's perspective, both are the same dependency shape.

### Runtime Variants

The architecture supports two primary runtime variants:

- single-binary executable runtime
- isolated/distributed service runtime

These variants change who performs top-level bootstrapping, but they must not change the service's
own bootstrap contract.

#### Single-Binary Executable Runtime

In the single-binary executable runtime:

- one top-level application bootstrapper creates the whole local environment
- shared infrastructure may be instantiated once and passed by shared handle to many services
- baked-in services may share the same in-process infrastructure instances
- cross-service bus communication still remains the architectural contract even when direct
  infrastructure sharing is used

Typical examples:

- one shared security instance
- one shared message bus broker
- one shared local storage/runtime environment

#### Isolated / Distributed Service Runtime

In the isolated/distributed runtime:

- each service process or service package bootstraps itself independently
- each service receives its own runtime-local infrastructure instances or client/clone variants
- shared platform concerns are synchronized through explicit contracts and events where needed
- no service may depend on another service having bootstrapped it internally

Typical examples:

- a clone/client security instance that syncs rules and groups
- a service-local bus endpoint or transport adapter
- service-local runtime configuration and storage mounts

### System Bootstrapper

The application may have one top-level bootstrap orchestrator that:

- creates the single-binary local runtime environment
- constructs shared infrastructure instances
- calls each service's bootstrap/init method
- passes the required bootstrap arguments into each service

This top-level bootstrapper must not replace the service bootstrap contract.
It only coordinates it.

### Goal

This pattern keeps services:

- modular
- individually startable
- individually testable
- ready for future extraction into separate crates or distributed runtimes

---

## Final Rule

If a service description in this document feels too large, split the service internally
into narrower orchestrators and specialists before adding more logic.

Do not solve service complexity by:
- adding more code to the Portal
- adding more code to the Supervisor
- making one giant Orchestrator
- making one giant Registry

Solve it by composing the right building blocks.
