# Strict Component Rules

**Version:** 1.0 · **Date:** 2026-05-10

This document defines the strict design rules for building Waffler components so the
system stays small, readable, composable, and maintainable while retaining current
functionality.

Read this together with:
- `01_ARCHITECTURE_PATTERNS.md`
- `05_CODING_STANDARDS.md`
- `12_ARCHITECTURE_CONFORMANCE.md`

---

## Purpose

Waffler already has the right vocabulary, but the code often stops at naming.

This document makes the vocabulary operational:
- what a component is
- what a role is
- what a single responsibility means
- what an Orchestrator is and is not
- how Observer, Scanner, Router, Evaluator, Compiler, Executor, and Actor fit
- when a workflow must be split into multiple components

This is the strict contract future code must follow.

---

## Core Definitions

### Component

A **component** is any concrete unit in the system with a stable responsibility boundary.

Examples:
- `PackagePortal`
- `BlueprintOrchestrator`
- `PackageActor`
- `VfsScanner`
- `BlueprintStore`
- `CapabilityRouter`

`Component` is the generic word.
`Portal`, `Orchestrator`, `Supervisor`, `Store`, `Registry`, `Index`, `Actor`,
`Observer`, and `Specialist` are architectural roles a component can take.

Every meaningful runtime type must be a component.
Every component must have exactly one primary architectural role.

### Role

A **role** is the architectural kind of the component:
- Portal
- Orchestrator
- Supervisor
- Store
- Registry
- Index
- Actor
- Observer
- Specialist

These are not optional labels. They define what the component is allowed to do.

### Behavior Label

Words like these are **behavior labels**, not top-level architectural roles:
- Scanner
- Router
- Evaluator
- Compiler
- Executor
- Validator
- Resolver
- Dispatcher
- Loader
- Mounter

They describe what the component does, not what kind of component it is.

Examples:
- `VfsScanner` → Specialist
- `CapabilityRouter` → Specialist
- `ExpressionEvaluator` → Specialist
- `PackageMountObserver` → Observer
- `BlueprintCompiler` → Specialist

Rule:
- a component has one primary role
- it may also have one or more behavior labels in its name if that improves clarity

---

## Single Responsibility

### What it means

A component has a **single responsibility** when it has one reason to change.

That does **not** mean:
- one public method
- one file only
- trivial logic only

It **does** mean:
- one clear goal
- one clear boundary
- one clear owner in the architecture

Examples:
- `PackageActivationOrchestrator` has one responsibility:
  coordinate the activation of a package.
- `PackageActor` has one responsibility:
  own one running package instance.
- `PackageStore` has one responsibility:
  persist package state and metadata.

Counterexample:
- a `PackageSupervisor` that installs packages, reads manifests, loads permissions,
  handles bus commands, creates actors, and indexes capabilities
  does not have one reason to change.

### The split threshold

Split a component when any of these become true:
- it handles more than one lifecycle stage
- it mixes bus, workflow, runtime state, and persistence
- it changes for unrelated reasons
- it requires comments to explain which part owns what
- its public API reads like a grab bag instead of one story

---

## Orchestrator

### What an Orchestrator is

An **Orchestrator** is a component whose responsibility is to coordinate a multi-step
workflow toward a clear domain goal.

An Orchestrator is:
- a component, not just a single method
- responsible for sequencing
- responsible for policy and invariants
- responsible for deciding which other components are called and in what order

An Orchestrator is **not**:
- the runtime owner of long-lived state
- the persistence layer
- the bus-facing command handler
- a grab bag for all domain logic

### Orchestrator scope

An Orchestrator may own:
- one domain with a narrow workflow surface
- or one use-case within a domain

Both are valid.

Good:
- `BlueprintOrchestrator` if blueprint workflows are cohesive
- `PackageActivationOrchestrator` if package activation is distinct from installation
- `PackageInstallationOrchestrator` if installation has different rules and dependencies

Bad:
- `PackageOrchestrator` that becomes a second package service monolith

### Orchestrator only where a real workflow warrants it

An Orchestrator exists **only where a genuine multi-step workflow warrants it** — not for every
service. Simple CRUD does not need an Orchestrator: it lives directly in the write-path
Registry (the `CudRegistry`/`MounterRegistry`), which coordinates validation, the Store update,
persistence delegation, and event publishing. Do not wrap plain create/update/delete in an
Orchestrator; reach for one only when sequencing, cross-component policy, or multi-stage
invariants are actually present.

### Strict rule

If a workflow has a different goal, different invariants, or different collaborators,
it should be its own Orchestrator.

Examples of distinct package goals:
- install package artifacts
- mount package metadata from VFS
- register package into runtime catalog
- activate package runtime
- deactivate package runtime
- uninstall package

These may be:
- separate orchestrators
- or sub-orchestrators behind a small `PackageOrchestrator` façade

But they must not collapse back into one giant type.

---

## Narrative Coding and Single-Action Functions

Narrative coding remains mandatory, but this document tightens it.

### Function rules

Every function must be either:
- a workflow function
- or a single-action function

A **workflow function**:
- is usually on a Portal or Orchestrator
- reads top-to-bottom as named steps
- delegates each step to a smaller function

A **single-action function**:
- performs one meaningful action
- sits at one level of abstraction
- has a name that states exactly what it does

Examples:
- `read_package_manifest`
- `load_package_state`
- `register_package_record`
- `create_package_actor`
- `start_wasi_runtime`
- `publish_package_registered_event`

### Strict granularity rules

1. A function must not both decide and execute low-level detail.
2. A function must not both parse bus payloads and perform domain workflow.
3. A function must not both read storage and mutate runtime state unless it is a Store.
4. A `match` arm in a Portal should almost always delegate immediately.
5. Comments like `Step 1`, `Step 2`, `Step 3` mean the function is too large.

---

## How Everything Must Fit

Every meaningful component must be classifiable.

### Portal

Use when:
- a service receives public bus commands

Examples:
- `PackagePortal`
- `BlueprintPortal`
- `NamespacePortal`

### Orchestrator

Use when:
- a domain workflow coordinates multiple steps and collaborators

Examples:
- `BlueprintOrchestrator`
- `PackageActivationOrchestrator`
- `NamespaceMountOrchestrator`

### Supervisor

Use when:
- runtime state evolves over time and must be kept alive, monitored, restarted, or stopped

Examples:
- `ActiveBlueprintSupervisor`
- a future `PackageRuntimeSupervisor`

### Store

Use when:
- Authoritative state storage (RAM, Disk, or DB) is required.

Rules:
- The authoritative source of truth.
- Coordinates or delegates persistence writes.
- Does not handle bus commands or business workflow.

### Registry

Use when:
- A write-side abstraction (Command) over a Store is needed.

Rules:
- Handles all CUD (Create, Update, Delete) or Mount operations.
- Coordinates validation, persistence (via Store), and RAM updates.
- Publishes bus events after successful state changes.

### Index

Use when:
- A read-side abstraction (Query) or derived model is needed.

Rules:
- Provides optimized in-memory lookups.
- Heavily utilizes zero-copy references (`Arc<T>`).
- Does not mutate state.

### Actor

Use when:
- one running entity instance owns state, handles, and communication

Examples:
- `PackageActor`
- a future `ExecutionActor` if one blueprint execution becomes an owned runtime unit

### Observer

Use when:
- the component subscribes to specific bus events and forwards them into a workflow boundary

Examples:
- `PackageMountObserver`
- `PackageRegistrationObserver`
- `PackageActivationObserver`

Strict rule:
- an Observer may decide whether an event is relevant
- an Observer may translate event payload into workflow input
- an Observer must not become the workflow implementation itself

### Specialist

Use when:
- the component performs one focused capability without being a bus endpoint or long-lived
  runtime owner

Examples:
- `VfsScanner`
- `CapabilityRouter`
- `ExpressionEvaluator`
- `BlueprintCompiler`
- `BlueprintExecutor`
- `PackageManifestLoader`

---

## Observer Rule

`Observer` is a first-class component role in Waffler.

Strict rules:
- an Observer subscribes to the message bus for specific events
- an Observer forwards matching events into one downstream workflow boundary
- an Observer does not own the downstream workflow
- an Observer should usually forward to one Orchestrator or one Supervisor entry point
- callback-based in-memory observer lists must not be the main cross-domain integration mechanism

Therefore:
- VFS scanning should publish namespace events on the bus
- package-related observers should subscribe through the bus
- downstream workflows such as mounting, registration, and activation remain modular and reusable
- direct in-memory observers are still acceptable only for internal, same-domain, read-model
  projection updates where no workflow side effects exist

---

## Scanner Rule

`Scanner` is a Specialist.

A Scanner may:
- traverse disk
- inspect manifests
- detect changes
- emit structured findings

A Scanner must not:
- decide policy
- mutate unrelated domains
- activate runtime instances
- directly call multiple downstream observers as a workflow engine

The output of a Scanner should be one of:
- findings returned to an Orchestrator
- internal same-domain projection updates
- bus events

For VFS:
- `VfsScanner` should detect namespace entities
- a namespace-oriented component should decide how those findings become mounted state
- downstream domains should react through events, not direct observer chains

---

## Router, Evaluator, Compiler, Executor

These are all behavior labels and usually belong to the Specialist role.

### Router

A Router chooses a destination or execution path.

Example:
- `CapabilityRouter` should be a Specialist, not a service boundary.

### Evaluator

An Evaluator computes a value from inputs.

Example:
- `ExpressionEvaluator` is a Specialist.

### Compiler

A Compiler transforms one representation into another.

Example:
- `BlueprintCompiler` is a Specialist.

### Executor

An Executor performs a bounded execution procedure.

Examples:
- `BlueprintExecutor` as a Specialist
- or `ExecutionActor` if executions become owned runtime units with state and channels

Rule:
- choose Specialist when the thing is stateless or bounded
- choose Actor when the thing owns one live instance over time

---

## Package Domain Reference Model

This is the preferred decomposition direction for the package domain.

### Bus boundary

- `PackagePortal`
  - receives public package commands
  - delegates to package orchestrators

### Workflow layer

- `PackageInstallationOrchestrator`
  - install package artifacts into storage
- `PackageMountOrchestrator`
  - interpret a VFS-discovered package directory into a package record
- `PackageRegistrationOrchestrator`
  - validate and register package metadata into runtime read models
- `PackageActivationOrchestrator`
  - decide whether and how a package should be started
- `PackageDeactivationOrchestrator`
  - stop package runtime and update state

These may sit behind a small façade `PackageOrchestrator`, but the narrow use-case
components are the preferred shape.

### State layer

- `PackageStore`
  - authoritative owner of manifests, versions, install metadata, state (persistence delegated
    to the storage service)

### Write path (CUD)

- `PackageRegistry`
  - create / update / delete (and `mount`) over the Store; delegates persistence and publishes
    events on success

### Read path

- `PackageIndex`
  - fast lookup of manifests and capability maps (derived, zero-copy, never mutates)

### Runtime layer

- `PackageRuntimeSupervisor`
  - tracks active package actors and runtime state
- `PackageActor`
  - owns one running package instance

### Specialists

- `PackageManifestLoader`
- `PackagePermissionResolver`
- `PackageRuntimeFactory`

### Event flow

Preferred package flow:
1. VFS scanner detects entity.
2. Namespace layer publishes entity-mounted event.
3. `PackageMountObserver` consumes the event and forwards it to the package mount workflow.
4. Package metadata is loaded and persisted/registered.
5. Package-registered event is published.
6. `PackageActivationObserver` or an equivalent lifecycle observer forwards that event to
   activation workflow when required.
7. Runtime supervisor creates a `PackageActor`.
8. Actor starts the concrete runtime and uses its own bus handle.

This is the correct direction.

---

## Namespace / VFS Reference Model

Preferred decomposition:
- `NamespacePortal` → public bus boundary
- `NamespaceOrchestrator` → namespace mutation workflows
- `NamespaceStore` → `.ns`, `.state`, `content.json`, disk persistence concerns
- `UnifiedNamespaceRegistry` → in-memory structural truth
- `VfsScanner` → Specialist that detects files and manifests
- `DiskSyncTask` → operational Specialist/Task for syncing storage events

Strict rule:
- VFS scanning is not itself the package system
- VFS scanning is not itself blueprint registration
- VFS scanning only discovers namespace facts

---

## Blueprint Domain Guidance

The blueprint domain is closer to the target shape, but the same rules still apply.

Likely classifications:
- `BlueprintPortal` → Portal
- `BlueprintOrchestrator` → Orchestrator
- `ActiveBlueprintSupervisor` → Supervisor
- `BlueprintStore` → Store
- `BlueprintIndex` → Index
- `BlueprintCompiler` → Specialist
- `BlueprintExecutor` / runner → Specialist unless it becomes a long-lived owned execution
- `ExpressionEvaluator` → Specialist
- `CapabilityRouter` → Specialist

Rule:
- expression evaluation, capability routing, built-in inline functions, and built-in node
  implementations should not blur the boundary of the blueprint Portal or Orchestrator
- they should remain narrow Specialists with explicit responsibilities

---

## Mandatory Classification Rule

When adding or reviewing a component, write down:

1. Its primary role.
2. Its behavior label if relevant.
3. Its single responsibility.
4. Which collaborators it may call directly.
5. Which interactions must go through the bus.

If this cannot be stated in five lines, the component is too vague.

---

## Design Checklist

Before keeping a design, verify:

1. Does every component have one primary role?
2. Is `Observer`, `Scanner`, `Router`, or `Executor` being used as a behavior label rather than a vague pseudo-role?
3. Does every component have one reason to change?
4. Do Orchestrators coordinate workflows rather than accumulate the whole domain?
5. Are long workflows split into stage-specific orchestrators where needed?
6. Do Supervisors own runtime state only?
7. Is the Store the single authoritative state owner, with persistence delegated (usually to the storage service)?
8. Are writes (CUD) on a Registry and reads (lookups) on an Index?
9. Are cross-domain reactions visible on the bus?
10. Do function bodies read like narrative workflows with single-action helpers?

If any answer is "no", the design is not ready.
