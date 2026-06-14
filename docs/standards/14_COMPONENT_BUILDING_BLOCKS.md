# Component Building Blocks

**Version:** 1.0 · **Date:** 2026-05-10

This document is the practical builder's guide for Waffler architecture.

Use it as the source of truth when creating new components. The goal is simple:
- choose one building block
- copy its template
- fill in the domain-specific parts
- do not invent new structure unless the existing blocks clearly do not fit

Read this together with:
- `01_ARCHITECTURE_PATTERNS.md`
- `05_CODING_STANDARDS.md`
- `12_ARCHITECTURE_CONFORMANCE.md`
- `13_STRICT_COMPONENT_RULES.md`

---

## Usage Rule

Every new meaningful type must answer these five questions before it is written:

1. Which building block is it?
2. What is its single responsibility?
3. What may it call directly?
4. What must go through the message bus?
5. Which template from this document does it follow?

If you cannot answer all five in under one minute, stop and simplify the design.

---

## Allowed Building Blocks

These are the only standard component types:

- `Portal`
- `Orchestrator`
- `Supervisor`
- `Store`
- `Registry`
- `Index`
- `Actor`
- `Observer`
- `Specialist`

Everything else is either:
- a behavior label on top of one of these
- or a bad abstraction that should not exist

Examples of behavior labels:
- `Scanner`
- `Router`
- `Evaluator`
- `Compiler`
- `Executor`
- `Resolver`
- `Validator`
- `Loader`
- `Mounter`

---

## Global Rules

These apply to every building block:

1. One component, one primary role.
2. One component, one single responsibility.
3. One function, one level of abstraction.
4. Public methods must read like a short story.
5. Cross-domain collaboration must be bus-visible.
6. Authoritative state belongs only in Stores; persistence is delegated (usually to the storage service), not done inline elsewhere.
7. Writes (CUD) belong on a Registry; reads (lookups) belong on an Index (CQRS).
8. Long-lived runtime state belongs only in Supervisors or Actors.
9. Event subscription belongs only in Observers.
10. A template may be extended, but not violated.

---

## Portal

### Purpose

The public bus boundary for one service domain. The Portal is a small **entrypoint orchestrator
composed of standard building blocks** — NOT a fixed `match command_type` switch. It composes a
**capabilities Index** (`name@version → handler`, used to route a call) + a **capabilities
Registry** (the add-only / `override` / `unregister` write-path that mutates it), and an
**interceptors Index** (ordered match list) + an **interceptors Registry** (register / remove).
These pairs are named `CapabilityRegistry` and `InterceptorChain`.

### Dispatch Flow

Receive call → match the capabilities Index → run **Before** interceptors as middleware →
execute the capability → pass the result through **After** interceptors → return. A fixed
`match` switch is at most a degenerate case of a statically-populated capabilities Index.

### Must Have

- a `BusHandle`
- a capabilities Index + Registry pair (and, where extension/interception applies, an
  interceptors Index + Registry pair)
- `new(...) -> (Self, Receiver<Command>)`
- `run(self, rx)` that dispatches via the capabilities Index and interceptor chain
- delegation of real work to Orchestrators or Specialists

### Must Not Have

- persistence logic
- workflow logic
- runtime lifecycle state
- direct disk access

### Direct Dependencies Allowed

- a `CapabilityRegistry` / `InterceptorChain` pair
- one or more Orchestrators
- read-only Indexes if strictly needed for formatting/query enrichment

### Bus Rule

- all public commands enter here first

### Template

```rust
pub struct ExamplePortal {
    capabilities: Arc<CapabilityRegistry>, // capabilities Index + write-path Registry
    interceptors: Arc<InterceptorChain>,   // interceptors Index + write-path Registry
    bus: BusHandle,
}

impl ExamplePortal {
    pub async fn new(
        capabilities: Arc<CapabilityRegistry>,
        interceptors: Arc<InterceptorChain>,
        command_tx: mpsc::UnboundedSender<Command>,
        event_tx: mpsc::UnboundedSender<Event>,
    ) -> (Self, mpsc::UnboundedReceiver<Command>) {
        let (handler_tx, handler_rx) = mpsc::unbounded_channel();
        let bus = BusHandle::new("examples".to_string(), command_tx, event_tx);
        bus.register_command_handler(handler_tx).await.unwrap();
        (Self { capabilities, interceptors, bus }, handler_rx)
    }

    pub async fn run(self, mut rx: mpsc::UnboundedReceiver<Command>) {
        self.publish_lifecycle(HealthStatus::Online);

        while let Some(cmd) = rx.recv().await {
            // route via the capabilities Index, run Before/After interceptors around the handler
            self.dispatch(cmd).await;
        }
    }
}
```

---

## Orchestrator

### Purpose

Own one workflow or one tightly cohesive workflow family.

### Minimum Contract

- one public method per workflow
- each workflow reads top-to-bottom as named steps
- delegates low-level work to helpers or other components
- enforces invariants and sequencing

### Must Have

- clear workflow-named methods
- only the dependencies required for its workflow
- rich return types or domain-specific results

### Must Not Have

- bus subscription
- bus command registration
- long-lived mutable runtime ownership
- direct persistence unless the type is actually a Store

### Direct Dependencies Allowed

- Stores
- Registries / Indexes
- Supervisors
- Specialists
- other Orchestrators when truly cross-workflow

### Freedom Level

High. Orchestrators are allowed to be complex, but only within one workflow goal.

### Template

```rust
pub struct ExampleActivationOrchestrator {
    store: Arc<ExampleStore>,
    registry: Arc<ExampleIndex>,
    supervisor: Arc<ExampleSupervisor>,
    runtime_factory: Arc<ExampleRuntimeFactory>,
}

impl ExampleActivationOrchestrator {
    pub async fn activate_example(&self, example_id: &str) -> Result<(), WafflerError> {
        let record = self.load_activation_record(example_id).await?;
        self.ensure_activation_is_allowed(&record).await?;
        let runtime = self.create_runtime(&record).await?;
        self.supervisor.mount_runtime(record.id.clone(), runtime).await?;
        Ok(())
    }
}
```

### Split Rule

If an orchestrator needs unrelated methods like:
- `install`
- `mount`
- `register`
- `activate`
- `deactivate`
- `uninstall`

then those should probably be separate orchestrators.

### Difference From Specialist

- `Orchestrator` owns workflow sequence and policy.
- `Specialist` owns one focused implementation capability.
- An `Orchestrator` decides what happens next.
- A `Specialist` knows how one thing is done.

---

## Supervisor

### Purpose

Own long-lived runtime state and lifecycle over time.

### Must Have

- internal runtime state
- lifecycle methods such as `mount`, `unmount`, `start`, `stop`, `restart`
- clear ownership of active instances

### Must Not Have

- public bus command handling
- storage writes
- policy decisions

### Direct Dependencies Allowed

- Actors
- runtime registries
- narrow Specialists needed for lifecycle operations

### Template

```rust
use arc_swap::ArcSwap;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct ExampleSupervisor {
    // Lock-free, wait-free reads for supervising tasks
    active: ArcSwap<HashMap<String, Arc<ExampleActor>>>,
    // Mutex is used to serialize writes to prevent write-write overwrites.
    write_lock: Mutex<()>,
}

impl ExampleSupervisor {
    pub fn new() -> Self {
        Self {
            active: ArcSwap::new(Arc::new(HashMap::new())),
            write_lock: Mutex::new(()),
        }
    }

    pub fn mount_runtime(
        &self,
        example_id: String,
        actor: Arc<ExampleActor>,
    ) -> Result<(), WafflerError> {
        let _guard = self.write_lock.lock().unwrap();
        
        let mut new_map = (**self.active.load()).clone();
        new_map.insert(example_id, actor);
        self.active.store(Arc::new(new_map));
        Ok(())
    }

    pub fn unmount_runtime(&self, example_id: &str) -> Result<(), WafflerError> {
        let _guard = self.write_lock.lock().unwrap();
        
        let mut new_map = (**self.active.load()).clone();
        new_map.remove(example_id);
        self.active.store(Arc::new(new_map));
        Ok(())
    }
}
```

---

## Store

### Purpose

Own a domain's authoritative state via whatever backend is appropriate — disk, database,
external system, or in-memory. In `waffler_core` a Store is **almost always in-memory**
(authoritative RAM); persistence is a separate, delegatable concern: the domain **delegates it
to the storage service (VFS) over the bus** (e.g. `vfs:write_part`) so the backend is swappable
(disk → DB) in one place. Direct backend I/O is allowed only where the domain genuinely owns
its backend.

### Must Have

- One authoritative state boundary (RAM by default; disk/DB/external where the domain owns it).
- Methods to hold and return references (`Arc<T>`).
- A persistence path — direct, or (the common case) delegated to the storage service.

### Must Not Have

- Event subscription.
- Workflow decisions.
- Public bus command handling.

### Direct Dependencies Allowed

- A storage-service client (for delegated persistence) or an owned storage backend.
- Serializers.
- Schema types.

### Template

```rust
use arc_swap::ArcSwap;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct ExampleStore {
    // Lock-free, wait-free reads via ArcSwap.
    items: ArcSwap<HashMap<String, Arc<ExampleRecord>>>,
    // Mutex is used to serialize writes to prevent write-write overwrites.
    write_lock: Mutex<()>,
}

impl ExampleStore {
    pub fn new() -> Self {
        Self {
            items: ArcSwap::new(Arc::new(HashMap::new())),
            write_lock: Mutex::new(()),
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<ExampleRecord>> {
        // Wait-free load: no cache bouncing, no blocking
        self.items.load().get(id).cloned()
    }

    pub fn set(&self, id: String, item: Arc<ExampleRecord>) {
        // Guard write path to serialize mutations
        let _guard = self.write_lock.lock().unwrap();
        
        // Clone the outer map (shallow clone of pointers is extremely cheap)
        let mut new_map = (**self.items.load()).clone();
        new_map.insert(id, item);
        self.items.store(Arc::new(new_map));
    }
}
```

---

## Registry

### Purpose

The Write-Path abstraction (Command) for one or more Stores.

### Must Have

- Public CUD-named methods (create, update, delete) or Mount-named methods.
- Logic to coordinate validation, persistence (via Store), and RAM mutation.
- Automatic event publishing on success.

### Must Not Have

- Read-side lookups (that belongs in Index).
- Multi-domain workflow (that belongs in Orchestrator).

### Direct Dependencies Allowed

- Stores
- Indexes
- EventPublisher
- Validation Specialists

### Template

```rust
pub struct ExampleCudRegistry {
    store: Arc<ExampleStore>,
    index: Arc<ExampleIndex>,
    bus: BusHandle,
}

impl ExampleCudRegistry {
    pub async fn create_example(&self, record: ExampleRecord) -> Result<(), WafflerError> {
        self.validate_rules(&record)?;
        let arc_record = Arc::new(record);
        self.store.set(arc_record.id.clone(), arc_record.clone()).await;
        self.index.index_record(&arc_record).await;
        self.bus.publish("example.created", &arc_record).await;
        Ok(())
    }
}
```

---

## Index

### Purpose

The Read-Path abstraction (Query) for a Store.

### Must Have

- Optimized lookup methods (get_by_id, list_by_owner, etc.).
- Heavy use of `Arc<T>` for zero-copy efficiency.
- Purely in-memory derived lookup maps.

### Must Not Have

- Any methods that mutate state.
- Persistence logic.

### Direct Dependencies Allowed

- Synchronization primitives (RwLock).

### Template

```rust
use arc_swap::ArcSwap;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

pub struct ExampleIndex {
    // Wait-free read map
    by_category: ArcSwap<HashMap<String, Vec<Arc<ExampleRecord>>>>,
    // Protect write updates from concurrent Registry indexing
    write_lock: Mutex<()>,
}

impl ExampleIndex {
    pub fn new() -> Self {
        Self {
            by_category: ArcSwap::new(Arc::new(HashMap::new())),
            write_lock: Mutex::new(()),
        }
    }

    pub fn list_by_category(&self, cat: &str) -> Vec<Arc<ExampleRecord>> {
        // Wait-free read, zero lock contention
        self.by_category.load().get(cat).cloned().unwrap_or_default()
    }

    pub fn index_record(&self, record: &Arc<ExampleRecord>) {
        let _guard = self.write_lock.lock().unwrap();
        
        let mut new_map = (**self.by_category.load()).clone();
        new_map.entry(record.category.clone())
            .or_default()
            .push(record.clone());
        self.by_category.store(Arc::new(new_map));
    }
}
```

---

## Actor

### Purpose

Own one live runtime instance.

### Must Have

- one owned runtime handle
- one owned communication boundary
- methods that act on exactly one instance

### Must Not Have

- global registry concerns
- multi-instance orchestration
- service-wide workflow logic

### Direct Dependencies Allowed

- runtime handles
- bus handle
- instance-local specialists

### Template

```rust
use arc_swap::ArcSwap;
use std::sync::Arc;

pub struct ExampleActor {
    id: String,
    bus: BusHandle,
    // Readers read state wait-free; only the Actor's task writes (no write lock needed)
    state: ArcSwap<ExampleRuntimeState>,
    runtime: ExampleRuntimeHandle,
}

impl ExampleActor {
    pub async fn run(&self) -> Result<(), WafflerError> {
        self.runtime.start().await
    }

    pub async fn stop(&self) -> Result<(), WafflerError> {
        self.runtime.stop().await
    }

    pub fn get_state(&self) -> Arc<ExampleRuntimeState> {
        // Lock-free, wait-free snapshot load
        self.state.load_full()
    }
}
```

---

## Observer

### Purpose

Subscribe to specific bus events and forward them into a workflow boundary.

### Must Have

- event topic subscription
- narrow event relevance logic
- one downstream workflow target

### Must Not Have

- own the workflow logic
- persist directly
- coordinate multiple unrelated downstream flows

### Direct Dependencies Allowed

- one Orchestrator
- or one Supervisor entry point
- optionally one event payload mapper

### Template

```rust
pub struct ExampleMountedObserver {
    orchestrator: Arc<ExampleMountOrchestrator>,
    bus: BusHandle,
}

impl ExampleMountedObserver {
    pub async fn run(self, mut rx: mpsc::UnboundedReceiver<Event>) {
        while let Some(event) = rx.recv().await {
            if !self.is_relevant_event(&event) {
                continue;
            }

            if let Ok(input) = self.map_event_to_mount_input(&event) {
                let _ = self.orchestrator.mount_from_event(input).await;
            }
        }
    }
}
```

### Rule

Observers are intended to be highly swappable.
If you redesign event wiring, you should usually only change the Observer, not the workflow.

---

## Specialist

### Purpose

Implement one focused capability that is neither a service boundary nor a long-lived runtime owner.

### Minimum Contract

- one responsibility
- small public API
- clear input/output contract

### Freedom Level

High. Specialists are allowed the most internal freedom after Orchestrators, as long as:
- they remain narrow
- they remain readable
- they follow narrative coding
- they do not silently expand into another architectural role

### Common Specialist Labels

- `Scanner`
- `Router`
- `Compiler`
- `Evaluator`
- `Executor`
- `Resolver`
- `Validator`
- `Loader`
- `Mounter`

### Difference From Orchestrator

- `Specialist` implements one expert task.
- `Orchestrator` coordinates multiple steps and collaborators.
- A `Specialist` should usually be callable from an `Orchestrator`.
- A `Specialist` should not turn into a hidden workflow owner.

### Template

```rust
pub struct ExampleScanner {
    storage: Arc<dyn ExampleStorage>,
}

impl ExampleScanner {
    pub fn new(storage: Arc<dyn ExampleStorage>) -> Self {
        Self { storage }
    }

    pub async fn scan_examples(&self, root: &Path) -> Result<Vec<ExampleScanFinding>, WafflerError> {
        let paths = self.collect_candidate_paths(root).await?;
        let findings = self.read_findings(paths).await?;
        Ok(findings)
    }
}
```

---

## Minimum Freedom Rules For Orchestrators And Specialists

These two building blocks intentionally have more freedom than the others.

### Orchestrator minimum rules

An Orchestrator must still:
- own one workflow goal
- expose workflow-named methods
- read like narrative code
- delegate low-level steps
- not absorb unrelated workflows

### Specialist minimum rules

A Specialist must still:
- expose one focused capability
- stay out of bus registration unless it is actually an Observer
- stay out of persistence unless it is actually a Store
- stay out of runtime ownership unless it is actually an Actor or Supervisor

---

## Recommended File Layout

Use this structure when a domain grows:

```text
domain/
  mod.rs
  portal.rs
  orchestrator.rs
  supervisor.rs
  store.rs
  registry.rs
  index.rs
  actor.rs
  observer.rs
  scanner.rs
  compiler.rs
  router.rs
  validator.rs
```

Not every domain needs every file.
Only create the files for the building blocks that actually exist.

---

## Component Definition Header

At the top of each new component file, the developer should be able to state this plainly:

```rust
// Role: Observer
// Responsibility: Listen for package-mounted namespace events and forward them to package mount workflow.
// Direct dependencies: PackageMountOrchestrator, BusHandle.
// Bus responsibilities: Subscribe to `namespace.entity_mounted`.
```

This does not need to remain as a comment in production code, but if it cannot be written
clearly, the component is not well designed yet.

---

## Decision Table

Use this when choosing a building block:

| If the thing primarily... | Choose |
|---|---|
| receives public bus commands | `Portal` (composed of a capabilities Index + Registry, not a fixed `match`) |
| coordinates a real multi-step workflow | `Orchestrator` (simple CUD goes on the Registry instead) |
| owns long-lived runtime lifecycle | `Supervisor` |
| owns authoritative domain state | `Store` (persistence usually delegated to the storage service) |
| creates / updates / deletes entities | `Registry` (write path) |
| offers flat fast lookup | `Index` (read path) |
| owns one running instance | `Actor` |
| listens to events and forwards them | `Observer` |
| implements one focused capability | `Specialist` |

---

## Final Rule

Developers should build the system from these blocks first and only then fill in domain logic.

Do not start with:
- a big service
- a vague manager
- a mixed-responsibility supervisor
- an all-knowing orchestrator

Start with the smallest correct building block and compose upward.
