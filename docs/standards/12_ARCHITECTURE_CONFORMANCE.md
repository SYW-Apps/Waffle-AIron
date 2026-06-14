# Architecture Conformance

**Version:** 1.0 · **Date:** 2026-05-10

This document closes the gap between Waffler's architectural patterns and how they are
actually applied in code. The existing standards define the roles. This document defines
the conformance rules that must be enforced when wiring real components together.

Read this together with:
- `01_ARCHITECTURE_PATTERNS.md`
- `03_MESSAGE_BUS.md`
- `04_PACKAGE_SYSTEM.md` (**LEGACY — see ledger + `docs/waffler_core/services/*` docs**)
- `06_NAMESPACE_VFS.md` (**LEGACY — see ledger + `docs/waffler_core/services/*` docs**)

---

## Why This Exists

Waffler already names many components correctly, but several implementations still combine
multiple roles behind the right name. That is architectural drift, not merely style debt.

Typical drift patterns seen in this codebase:
- a `Supervisor` also acting as a Portal or Orchestrator
- a `Registry` (write path) serving read-path lookups that belong on an `Index`
- an `Index` (read path) mutating state instead of leaving CUD to the `Registry`
- a `Portal` doing domain work directly instead of composing its capability/interceptor blocks
- a VFS observer performing lifecycle side effects
- bootstrap wiring direct object collaboration where the bus should be the contract boundary

This document is binding. When the code and the role name disagree, the code must change.

---

## Core Rule

The `MessageBroker` is the center of the system.

That means:
- External callers talk to services through bus commands.
- Cross-domain collaboration happens through bus commands or events.
- Direct object references are allowed only for private, in-domain collaborators such as a
  Portal holding its Orchestrator, or an Orchestrator holding its Store/Registry/Supervisor.
- Bootstrap may compose the graph, but it must not become a hidden integration layer with
  business behavior spread across direct callbacks.

If two components belong to different service domains, their contract must be visible on the bus.

---

## Conformance Rules

### 1. Portals are the only bus command handlers for a domain

A Portal is an entrypoint orchestrator composed of standard building blocks (a capabilities
Index + Registry and an interceptors Index + Registry), not a fixed `match` switch. It routes
each call through its capabilities Index, runs Before/After interceptors around the handler,
and delegates the real work outward.

Allowed:
- register with the broker
- parse command payloads
- route via the capabilities Index and run the interceptor chain
- delegate to an Orchestrator or domain specialist
- publish lifecycle events

Forbidden:
- holding domain lifecycle state
- reading or writing storage directly
- implementing multi-step business workflows
- exposing a second command loop on a Supervisor or Registry

Implication:
- A domain must not have both `PackagePortal` and `PackageSupervisor::handle_bus_command(...)`
  as public command surfaces. The Portal owns the command boundary.

### 2. Orchestrators own workflows and policy

Allowed:
- coordinate Stores, Registries, Supervisors, and bus calls
- enforce validation, authorization, dependency rules, and sequencing
- publish domain events after successful state changes

Forbidden:
- being the long-lived runtime owner of entity instances
- being the persistence layer
- being the raw bus registration point

Implication:
- If package install/enable/disable/uninstall involves real multi-step policy, indexing,
  persistence, runtime startup, and event emission, that is Orchestrator work even if a
  Supervisor participates in the flow. Reserve Orchestrators for genuine workflows — simple
  CUD belongs in the write-path Registry, not in a new Orchestrator.

### 3. Supervisors own runtime state only

Allowed:
- track active instances and runtime handles
- start, stop, restart, and recover running entities
- react to lifecycle events and internal commands from their own domain

Forbidden:
- handling external bus commands directly
- parsing public command names
- deciding domain policy
- acting as a VFS observer that performs installation or bootstrap workflows

Implication:
- A Supervisor may receive instructions from its Orchestrator.
- A Supervisor must not be the first component that reacts to a public bus command.

### 4. Stores own authoritative state; Registry = write path, Index = read path (CQRS)

A Store is the **authoritative state owner**. In `waffler_core` it is almost always in-memory
(authoritative RAM); persistence is a separate, delegatable concern — the domain delegates it
to the storage service (VFS) over the bus rather than writing storage directly, so the backend
(disk → DB) is swappable in one place. Direct backend I/O is allowed only where the domain
genuinely owns that backend.

Over a Store, writes and reads are split (CQRS):
- **Registry = the write path** — create / update / delete (and `mount` for system sync). It
  validates, updates authoritative state via the Store, delegates persistence, and publishes
  events on success.
- **Index = the read path** — list / get / lookup-by-key over derived, in-memory, zero-copy
  (`Arc<T>`) maps. One Index per key variant.

Forbidden:
- a Registry serving read-path lookups (that belongs on an Index)
- an Index mutating state or owning persistence (that belongs on the Registry/Store)
- either owning lifecycle state (that belongs on a Supervisor)

Implication:
- Reads go through an Index; writes go through a Registry. If a type both serves lookups and
  performs CUD under one name, split it into an Index and a Registry.
- The Store, not the Registry/Index, decides how state is persisted — usually by delegating to
  the storage service.

### 5. Observers are event adapters, not workflow engines

Allowed:
- subscribing to specific bus events
- validating event relevance
- forwarding events into the correct workflow boundary
- updating local read models when that is their only responsibility

Forbidden:
- starting packages
- writing storage
- loading firewall rules
- running full domain initialization flows inline
- accumulating unrelated routing policy across domains

Implication:
- Observers may be first-class components.
- Their job is event subscription and forwarding, not owning the downstream workflow.
- Heavy reactions must be delegated to the owning domain through its Orchestrator/Supervisor
  chain.

### 6. Scanners are Specialists, not primary architectural roles

A scanner is not a new top-level pattern beside Portal/Orchestrator/Supervisor/Store.
It is a Specialist or task owned by a domain.

Scanner responsibilities:
- traverse a source of truth
- detect manifests, files, or changes
- emit structured findings

Scanner non-responsibilities:
- apply domain policy
- mount runtime entities directly across domains
- start services
- update unrelated registries

Recommended shape:
- `{Domain}Scanner` as a Specialist owned by an Orchestrator or Supervisor
- or `{Domain}ScanTask` when it is purely operational background work

For VFS specifically:
- scanning disk is scanner work
- deciding how findings affect the namespace tree is orchestration work
- holding the live tree is registry/supervisor work

### 7. Bootstrap composes; it does not substitute for architecture

Allowed:
- instantiate components
- wire channels
- start long-running tasks

Forbidden:
- relying on direct callback observer lists as the primary integration contract between domains
- embedding policy sequencing that belongs in an Orchestrator

If a behavior matters after startup as well, it must exist as a real runtime contract, not
only as bootstrap wiring.

---

## Current Drift Hotspots

These are not theoretical examples. They exist in the current codebase and should guide
refactor priority.

### `waffler_core/src/packages/supervisor.rs`

Current drift:
- `PackageSupervisor` exposes `run(...)` and `handle_bus_command(...)`.
- `PackageSupervisor` also implements `VfsEntityObserver`.
- Inside `on_entity_mounted(...)` it loads rules, ensures `.data/`, and starts packages.

Why this is drift:
- command handling belongs to `PackagePortal`
- package workflows belong to a `PackageOrchestrator`
- runtime ownership belongs to `PackageSupervisor`
- VFS observation should not launch package lifecycle flows directly

Required direction:
- keep `PackageSupervisor` as runtime owner of active package actors
- move install/enable/disable/uninstall/startup sequencing into a `PackageOrchestrator`
- keep `PackagePortal` as the only bus command surface
- replace direct VFS observer startup with namespace events handled through the package domain

### `waffler_core/src/packages/registry.rs`

Current drift:
- `PackageRegistry` serves read-path lookups, owns the authoritative in-memory state, AND
  performs CUD writes (`save_package_state(...)`, `set_approved_permissions(...)`) under one type

Why this is drift:
- one type collapses the Store (authoritative state owner), the write-path Registry (CUD), and
  the read-path Index (lookups) — three CQRS roles in one

Required direction:
- separate the authoritative state into a `PackageStore`, the CUD writes into a write-path
  Registry (which delegates persistence to the storage service), and the lookups into a
  `PackageIndex`

### `waffler_core/src/core/namespace/vfs_supervisor.rs`

Current drift:
- `VfsSupervisor` scans directories
- resolves manifests
- mounts entities into the tree
- loads `.state`
- loads `content.json`
- notifies observers

Why this is drift:
- one type is acting as scanner, mount orchestrator, state loader, and observer dispatcher

Required direction:
- extract a `VfsScanner` or `NamespaceScanner`
- keep orchestration separate from raw scan traversal
- replace direct cross-domain callback observers with bus-published namespace events and
  dedicated observer components where modular event wiring is needed

### `waffler_core/src/core/namespace/portal.rs`

Current drift:
- `NamespacePortal` holds both the tree and storage directly
- the Portal performs domain operations itself

Why this is drift:
- this collapses Portal + Orchestrator + Store concerns

Required direction:
- introduce a `NamespaceOrchestrator`
- keep persistence and file operations behind dedicated namespace store components

### `waffler_core/src/core/bootstrap.rs`

Current drift:
- bootstrap wires direct observers from VFS into package/index subsystems
- package and namespace interactions rely on direct callbacks more than visible bus contracts

Why this is drift:
- the system's real runtime collaboration becomes hidden in startup wiring

Required direction:
- bootstrap should wire components, but cross-domain reactions should be event-driven and
  visible as bus contracts

---

## Refactor Priority

1. Extract `PackageOrchestrator` and remove public command handling from `PackageSupervisor`.
2. Split `PackageRegistry` into a Store (authoritative state), a write-path Registry (CUD), and a read-path Index (lookups).
3. Introduce `NamespaceOrchestrator` for namespace mutations and VFS-driven mount flows.
4. Extract `VfsScanner` from `VfsSupervisor`.
5. Convert heavy observer reactions into explicit bus events.

---

## Review Checklist

When reviewing a new or changed component, ask:

1. Is this component's name aligned with what it actually does?
2. Does this domain have exactly one public command boundary?
3. Are real multi-step workflows in an Orchestrator (not a Portal or Supervisor), while simple CUD stays in the write-path Registry?
4. Are writes (CUD) on a Registry and reads (lookups) on an Index, with the Store as the single authoritative state owner?
5. Does any Observer do more than event subscription, filtering, and forwarding?
6. Is cross-domain collaboration visible on the bus?
7. If bootstrap wiring disappeared, would the runtime contract still be explicit?

If any answer is "no", the design is not conformant yet.
