# Architecture Patterns

**Version:** 1.0 · **Date:** 2025-10-01

This document defines the standard component roles used throughout `waffler_core`.
Every major piece of functionality must map to one of these patterns.
Do not introduce a generic `Manager`, `Handler`, or `Service` struct without first
checking whether an existing pattern covers the responsibility.

---

## Core Metaphor

Waffler's internal topology is described using a body metaphor:

| Metaphor | Component | Role |
|----------|-----------|------|
| The Heart | `MessageBroker` | Pumps commands and events through the system |
| The Skeleton | `UnifiedNamespaceRegistry` | Hierarchical structure that gives the system form |
| The Brain | `BlueprintOrchestrator` | Coordinates blueprint lifecycle and execution |
| The Portals | `*Portal` | Public gateways into service domains |
| The Specialists | `*Orchestrator`, `*Supervisor`, internal modules | Expert components for deep domain logic |

This metaphor is not decoration — it reflects a deliberate design choice to keep
responsibilities narrow and composable.

---

## Component Patterns

### Portal

**What it is:** The single public-facing entry point for a service domain. Every command
targeting a service arrives at its Portal first and only at its Portal.

The Portal is a small **entrypoint orchestrator composed of standard building blocks** — it
is NOT a fixed `match command_type` switch. It composes two Index+Registry pairs:

- a **capabilities Index** (`name@version → handler` hashmap) used to route an incoming call,
  plus a **capabilities Registry** — the add-only / `override` / `unregister` write-path that
  mutates that index.
- an **interceptors Index** (the ordered match list) plus an **interceptors Registry**
  (register / remove).

**Dispatch flow (the orchestration):** receive call → match the capabilities Index → the
matched capability handler runs the **Before** interceptors as middleware → execute the
capability → pass the result through the **After** interceptors → return to the caller. So the
Portal is the orchestrator *over* those Index+Registry pairs. A fixed `match command_type`
switch is at most a degenerate special case of a statically-populated capabilities Index.

**Responsibilities:**
- Register with the `MessageBroker` as the command handler for the service's name.
- Listen on a `mpsc` channel for incoming `Command` messages.
- Route each call through its capabilities Index → Before interceptors → capability → After
  interceptors, delegating real work to Orchestrators or Specialists.
- Respond to the command with a typed payload or a `WafflerError`.
- Publish lifecycle events (`HealthStatus::Online`).

**What it must NOT do:**
- Contain business logic. Portals route and compose; they do not decide.
- Hold persistent state (beyond its `BusHandle` and the Index+Registry pairs it composes).
- Access the disk or database directly.

**Naming:** `{Domain}Portal` — e.g., `BlueprintPortal`, `NamespacePortal`, `PackagePortal`, `CorePortal`.
The composed write-paths follow the building-block names `CapabilityRegistry` and
`InterceptorChain` (an interceptors Index + Registry pair).

**Structure template:**
```rust
pub struct BlueprintPortal {
    capabilities: Arc<CapabilityRegistry>, // capabilities Index + write-path Registry
    interceptors: Arc<InterceptorChain>,   // interceptors Index + write-path Registry
    bus: BusHandle,
    // read-only shared dependencies only
}

impl BlueprintPortal {
    pub async fn new(...) -> (Self, mpsc::UnboundedReceiver<Command>) { ... }

    pub async fn run(self, mut rx: mpsc::UnboundedReceiver<Command>) {
        self.publish_lifecycle_event(HealthStatus::Online);

        while let Some(cmd) = rx.recv().await {
            // route via the capabilities Index, run Before/After interceptors around the handler
            self.dispatch(cmd).await;
        }
    }
}
```

---

### Orchestrator

**What it is:** The domain's primary business logic coordinator. It owns the sequence of
steps required to fulfill a high-level domain operation.

**Responsibilities:**
- Accept high-level operations from the Portal (e.g., `create_blueprint`, `run_blueprint`).
- Coordinate between Stores, Registries, Supervisors, and other Orchestrators.
- Enforce domain rules and invariants (validation, authorization checks).
- Return rich result types, not raw data structures.

**What it must NOT do:**
- Listen directly on the message bus. That is the Portal's job.
- Own mutable long-lived state itself — delegate to Stores or Supervisors.
- Know about wire formats or IPC protocols.

**Naming:** `{Domain}Orchestrator` — e.g., `BlueprintOrchestrator`, `SecurityOrchestrator`.

---

### Supervisor

**What it is:** A long-running actor that manages a specific domain's lifecycle and
operational state over time.

**Responsibilities:**
- Own the runtime lifecycle of domain entities (start, pause, stop, restart).
- Hold mutable runtime state that evolves during the system's uptime.
- React to lifecycle events from the rest of the system.
- Recover from partial failures within its domain.

**What it must NOT do:**
- Handle external commands directly — that is the Portal's job.
- Persist data to disk — that is the Store's job.
- Make policy decisions — that is the Orchestrator's job.

**Naming:** `{Domain}Supervisor` — e.g., `ActiveBlueprintSupervisor`, `PackageSupervisor`, `VfsSupervisor`.

---

### Store

**What it is:** The **authoritative state owner** for a domain. A Store ensures and persists a
service's state via whatever backend is appropriate — disk, database, external system, or
in-memory. It is the source of truth for its domain's entities.

In `waffler_core` a Store is **almost always in-memory** (authoritative RAM, e.g.
`HashMap<UUID, Arc<Entity>>`). Persistence is a separate, delegatable concern: rather than
writing storage itself, the Store's domain **delegates persistence to the storage service
(VFS) over the bus** (e.g. `vfs:write_part`), so the storage backend is swappable (disk → DB)
in one place. Direct backend I/O is allowed only where the domain genuinely owns its backend.

**Responsibilities:**
- Hold the authoritative state and hand out references (`Arc<T>`) to it.
- Provide get/set access for domain entities.
- Ensure state is persisted — directly if it owns a backend, or by delegating to the storage
  service. The mechanism is backend-agnostic.

**What it must NOT do:**
- Contain business logic or validation. Stores hold state; they do not decide.
- Publish events or send commands (beyond a persistence-delegation call to the storage service).
- Know about other domains.

**Naming:** `{Domain}Store` — e.g., `BlueprintStore`, `GlobalVariableStore`, `FirewallRuleStore`.

---

### Registry / Index (CQRS)

**What they are:** A complementary pair that splits writes from reads over a Store (CQRS).

- **Registry = the WRITE path (CUD).** It owns create / update / delete (and `mount` for system
  sync). It coordinates validation, the authoritative state update via the Store, and any
  persistence delegation, then publishes domain events on success.
- **Index = the READ path.** It owns list / get / lookup-by-key. It is a derived, in-memory
  lookup map (typically `HashMap<Key, Arc<Entity>>` referencing Store values via `Arc`),
  one per key variant. It never mutates state.

**Registry responsibilities (write side):**
- Expose CUD-named (or `mount`-named) methods.
- Validate, update authoritative state via the Store, delegate persistence, publish events.

**Index responsibilities (read side):**
- Provide O(1) / O(log n) lookup for frequently queried domain entities.
- Be derived and zero-copy (`Arc<T>` references into the Store), one Index per key variant.

**What they must NOT do:**
- A Registry must not serve read-path lookups — that belongs in an Index.
- An Index must not mutate state or own persistence — that belongs in the Registry/Store.
- Neither holds mutable lifecycle state — that is the Supervisor's job.

**Naming:** `{Domain}Registry` (write) or `{Domain}Index` (read) — e.g., `BlueprintCudRegistry`,
`BlueprintMounterRegistry` on the write side; `PackageIndex`, `BlueprintIndex` on the read side.

**Use `Registry`** for the write/CUD side of a store or list.  
**Use `Index`** for the read/lookup side.

---

### Specialist

**What it is:** A focused, reusable unit of domain logic that is too complex to inline
into an Orchestrator but does not need its own lifecycle.

**Responsibilities:**
- Implement a narrow, well-defined capability (e.g., "evaluate an expression", "parse a blueprint node").
- Be stateless or hold only immutable shared state (via `Arc`).
- Be callable from Orchestrators or the blueprint execution engine.

**What it must NOT do:**
- Register with the message bus.
- Manage lifecycle state.

**Naming:** Named by capability, not by pattern — e.g., `ExpressionEvaluator`, `BlueprintValidator`,
`LocalSpecialist` (trait). Internal execution modules follow the pattern `{Domain}Module`
(e.g., `FlowModule`, `SystemModule`, `UtilitiesModule`).

---

### Observer

**What it is:** A thin event-integration component that subscribes to specific message bus
events and forwards matching events into a workflow boundary.

**Responsibilities:**
- Register subscriptions for one or more specific event topics.
- Receive events for a narrow integration concern.
- Validate that an event is relevant.
- Forward the event to the correct Orchestrator, Supervisor, or other workflow entry point.

**What it must NOT do:**
- Own the workflow it triggers.
- Perform multi-step business logic inline.
- Persist data directly.
- Become a hidden alternate command path around the bus contract.

**Naming:** `{Domain}{Purpose}Observer` â€” e.g., `PackageMountObserver`, `PackageActivationObserver`.

---

### Actor

**What it is:** An owned unit that combines state and behavior for a single running entity
(typically a package instance).

**Responsibilities:**
- Own both the runtime state and the communication channels for one entity instance.
- Dispatch commands to the entity (via IPC, WASM call, or direct function call).
- Manage the entity's process or module handle.

**Naming:** `{Domain}Actor` — e.g., `PackageActor`.

---

## Choosing the Right Pattern

When adding new functionality, ask these questions in order:

1. **Is it a public-facing command endpoint?** → Portal
2. **Is it a real multi-step domain workflow?** → Orchestrator (simple CRUD instead lives in
   the write-path Registry — do not add an Orchestrator for it)
3. **Does it manage long-lived runtime state?** → Supervisor
4. **Does it own authoritative state for a domain?** → Store
5. **Does it create/update/delete domain entities?** → Registry (write path)
6. **Is it a fast in-memory lookup?** → Index (read path)
7. **Is it focused reusable logic without lifecycle?** → Specialist
8. **Does it own a single running instance (process/module)?** → Actor

If none of these fit cleanly, split the responsibility before introducing a new pattern.
A "Manager" that does multiple things from the list above is a design smell.

---

## The Core / Package Boundary

The architecture patterns in this document apply to **`waffler_core` infrastructure only**.
They describe how the core organises itself internally. They do not describe how packages
are built — packages use the Waffler SDK for that (see `04_PACKAGE_SYSTEM.md` — **LEGACY — see ledger + `docs/waffler_core/services/*` docs**).

This distinction is critical. `waffler_core` is Waffler's kernel. It is domain-neutral
and package-agnostic by design. The following rules are absolute and apply to every
component built with these patterns:

### Rules

1. **No core component may contain logic that is specific to any package.**
   A Portal, Orchestrator, Supervisor, Store, or any other core component must not
   reference, import, inspect, or special-case any package — including first-party
   `syw.*` packages. The core treats all packages identically via the generic package
   lifecycle interface.

2. **No core component may behave differently based on which packages are installed.**
   If you find yourself writing `if package "syw.network.http" is installed, do X`,
   that logic belongs in the package, or in a new generic interface the core exposes
   that the package implements. Never in the core itself.

3. **Core patterns are infrastructure, not features.**
   A Portal routes commands. An Orchestrator coordinates domain steps. A Store
   owns authoritative state. None of these are the right place for domain-specific capability
   logic. If a feature requires knowing what a specific package does, it is not a
   core feature.

4. **Package failures must be isolated, never propagated.**
   Every component that interacts with a package (primarily `PackageActor` and the
   IPC/WASM layers) must treat the package as an untrusted external dependency.
   A package crash, hang, or invalid response must produce a structured error that
   stays within the package boundary — it must never surface as an unhandled panic
   or silent failure in the core. See `04_PACKAGE_SYSTEM.md` for the full fault
   isolation requirements. (`04_PACKAGE_SYSTEM.md` is **LEGACY — see ledger + `docs/waffler_core/services/*` docs**.)

### Why This Boundary Exists

Waffler's power comes from the fact that any package can extend it with any capability.
That power disappears the moment the core starts knowing about specific packages.
Once the core has a special case for one package, it implicitly requires that package.
The modularity is broken. The system stops being a platform and becomes a collection
of hardcoded integrations.

The core is the platform. Packages are tenants. The landlord does not redesign the
building for one tenant.

---

## Anti-Patterns

| Anti-pattern | Why it's wrong | Correct approach |
|---|---|---|
| `XxxManager` with mixed responsibilities | Unclear ownership, hard to test | Split into Portal + (Orchestrator or write-path Registry) + Store |
| Business logic in a Portal | Portals route and compose; they don't decide | Move logic to Orchestrator |
| Persistence done inside an Orchestrator | Violates layering | Delegate to the Store (which persists, usually via the storage service) |
| Read-path lookups served by a Registry | Registry is the write/CUD path | Serve reads from an Index |
| State mutation in an Index | Indexes are read-only derived views | Mutate via the write-path Registry |
| An Orchestrator wrapping simple CRUD | Adds a needless layer | Put plain CUD in the write-path Registry; reserve Orchestrators for real multi-step workflows |
| A Supervisor that handles bus commands directly | Conflates routing with lifecycle | Add a Portal in front of it |
| A Store that publishes domain events | Stores own state, not events | Let the write-path Registry publish events after the state update succeeds |
| Package-specific logic in any core component | Breaks modularity, entangles core with extensions | Move to the package, or expose a generic core interface |
| Checking whether a specific package is installed before doing something in core | Implicit package dependency in core | The core must work identically regardless of which packages are installed |
