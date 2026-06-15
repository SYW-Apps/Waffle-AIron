# wairon — Architecture Standard

> The canonical, language-neutral definition of wairon's architecture model: the
> building blocks, the patterns, the entity/behavior rules, the spec-tree layout,
> and the rules a conformant design must obey. The schema, the validator, the MCP
> tools, and the SDD skills all reconcile to this document.
>
> This standard describes *how to structure any system designed with wairon*. It
> is language-agnostic — the structural rules apply to any OOP or structured
> language. Language-specific realization (concurrency, memory) lives in
> [language-bindings.md](language-bindings.md).

---

## 1. Two orthogonal axes: containment and refinement

Everything is positioned on **two independent axes**. Conflating them is the most
common source of confusion, so they come first.

- **Containment (the tree → folders):** what contains what —
  `System ⊃ Subsystem ⊃ Component ⊃ owned blocks`.
- **Refinement (level of detail → files):** for *one* component, increasing
  detail — `structure → interface → implementation + narrative`.

The labels L0–L5 walk down containment first, then refinement:

| Label | Axis | Artifact |
|---|---|---|
| **L0 System** | containment | `system.yaml` |
| **L1 Subsystem** | containment | `<subsystem>/subsystem.yaml` |
| **L2 Component** | containment leaf **and** refinement root (structure) | `<component>/component.yaml` |
| **L3 Interface** | refinement | `<component>/interface.yaml` |
| **L4 Implementation** | refinement | `<component>/implementation.yaml` |
| **L5 Narrative** | refinement (a *sub-field* of L4, not a separate file) | steps inside `implementation.yaml` |

---

## 2. The spec tree on disk

```
.wai/specs/
  system.yaml                      ← L0  system: vision, boundaries, global requirements
  types/                           ← shared value objects (Money, Address, Email …)
    money.yaml
  <subsystem>/                     ← L1  a bounded context / service
    subsystem.yaml                 ← L1  public interface(s) the service exposes
    types/                         ← entities/aggregates owned by THIS subsystem (e.g. order.yaml)
    <component>/                   ← L2  a standalone block OR a pattern facade
      component.yaml               ← L2  structure: role/stereotype, responsibility, owns, dependsOn
      interface.yaml               ← L3  contract: method signatures (referencing types by id)
      implementation.yaml          ← L4+L5  sourcePath, concurrency variant, per-method narrative
      <owned-block>/               ← (only if this component is a pattern) a private owned block
        component.yaml
        interface.yaml
        implementation.yaml
```

**File contents:**
- `component.yaml` (L2) — identity, **role/stereotype**, **responsibility description**, `owns` (member blocks; patterns only), `dependsOn` (collaborators). No methods, no narratives.
- `interface.yaml` (L3) — **method signatures** (name, params/returns referencing types, optional HTTP/gRPC/event binding). Interfaces are **method contracts only** — fields are implementation, never part of the contract.
- `implementation.yaml` (L4+L5) — `sourcePath`, the **concurrency variant**, and the **per-method narrative** (L5 steps).

Different agents own different refinement files: the **architect** owns
`component.yaml` + `interface.yaml`; the **implementer** owns `implementation.yaml`.

---

## 3. Building blocks (the primitives)

These ten are the **only** atomic component types.

| Block | Role | Owns | Default interface |
|---|---|---|---|
| **Portal** | The service's **inbound** front door — receives external commands and dispatches them | the inbound transport binding + dependencies | `dispatch(command) → result` |
| **Orchestrator** | Owns one workflow; the cross-collaborator control flow | dependencies only | one workflow method (domain-specific) |
| **Supervisor** | Owns the set of live processes/instances + their lifecycle | runtime state (the set of Actors) | `mount/unmount/start/stop` |
| **Actor** | Owns **one** live process / loop / session / instance | that instance's runtime state + its run-loop | `start/stop/state` |
| **Store** | Authoritative state boundary for entities | the entities | `get`, `list`, `write`, `remove` |
| **Index** | Read path; optimized derived lookup maps | derived lookup state | `get_by_<key>`, `list_by_<key>` |
| **Registry** | Write path (CUD) for one aggregate | dependencies only | `create`, `update`, `delete` |
| **Adapter** | A **client to an external system/protocol** (DB, FS, HTTP, gRPC, WS, message bus). The **only** block doing raw external I/O | a connection/resource handle | protocol-shaped (`query`/`execute`, `send`/`receive`, `publish`…) |
| **Observer** | Subscribes to events and forwards them to one workflow | a subscription | `on_event(event)` |
| **Specialist** | One focused capability (the residual/wildcard role) | nothing, or (as a wildcard pattern) blocks | one method (domain-specific) |

### State vs dependencies vs workflow

Every component holds **dependencies** (its injected collaborators). What differs
is whether it also owns **state** or **workflow**:

| Owns domain/runtime state | Owns workflow | Owns only dependencies (stateless coordinators/paths) |
|---|---|---|
| Store, Supervisor, Actor (authoritative); Index (derived) | Orchestrator | Registry, Specialist, Portal, Observer, Adapter* |

\*The Adapter holds a *resource handle* (a connection), not domain state.
"Stateless" means **no domain state** — not "no fields."

### Dependency rules

- **Portal** is the inbound boundary; no component may depend on it. It dispatches
  to Orchestrators (and may consult read-only Indexes for routing/formatting).
- **Observer** may depend on exactly **one** Orchestrator *or* one Supervisor
  entry; it may use a message-bus **Adapter** to subscribe. No component depends on it.
- **Store** may depend on an **Adapter** (its backend) or another Store. It is
  depended *upon* by Registries and Indexes — never the reverse.
- **Index** is a read-only **projection over a Store**: it shares the Store's
  per-entry references. It may depend on its Store (and an Adapter for cold reads).
  It **never** depends on a Registry — read and write paths are decoupled.
- **Registry** is the write path to a Store; it may depend on its Store, Adapters
  (e.g. a message-bus Adapter to publish), and validation Specialists. It does
  **not** depend on Indexes.
- **Adapter** is a dependency-sink toward the system (its other side is external).
  It may not depend on Orchestrators or Stores. **Any** component may depend on an
  Adapter to reach an external system.
- **Specialist** stays narrow; it **may** depend on Repositories, Indexes, and
  **Adapters**, but must not own bus/persistence/runtime (those are
  Observer/Store/Actor).
- The narrative `call` graph and the `dependsOn` graph must both be **DAGs** (no
  cycles), and every narrative `call` must target a method on a declared dependency.

### The Orchestrator, precisely

A **class, not a function**: it holds its collaborators (constructor-injected) and
exposes one cohesive workflow, decomposed into private named steps. It is
**domain-stateless** — each call's state lives on the stack, so a shared instance
is concurrency-safe and its instantiation lifecycle is irrelevant to correctness.

- **Workflow control flow** (branch/loop deciding the sequence of cross-component
  steps) → Orchestrator. **Local control flow** (guard clauses, a Specialist's
  internal loop, a Registry's `exists?` check) → fine anywhere. Coordination, not
  complexity, is the discriminator.
- Dependencies are injected at construction; method arguments carry only the
  **workflow input**. For "same workflow over many repositories," prefer one
  instance per concrete dependency behind a shared interface; use dynamic dispatch
  only when the choice is genuinely per-call.

### Self-initiated and long-running processes

There is **no separate "Process/Daemon" block** — owning one live process *is* the
**Actor's** defining job. An Actor's run-loop *is* the process; it stays thin
(own the loop + instance state) and **delegates** per-iteration/per-event work to
Orchestrators (workflow) and Specialists (tasks), using **Adapters** for any
external connection. The **Supervisor** owns the *set* of Actors + lifecycle.

| Need | Modeled as |
|---|---|
| cron / scheduler | an Actor whose loop is `sleep → trigger → delegate to Orchestrator` |
| batch job | an Actor owning the iteration, delegating each item |
| stream / websocket consumer | an Actor owning the read-loop + an Adapter owning the connection |
| message-bus consumer | an Observer subscribing via a bus Adapter, or an Actor owning a poll-loop |
| daemon | an Actor owning a long-running loop |

---

## 4. External I/O and emission — the Adapter

The **Adapter** is the single boundary to the outside world, in two shapes:
1. **Behind a Store** — a DB/FS Adapter the Store translates domain calls into
   (`store.get` → `adapter.query(...)` → deserialize → entity).
2. **Standalone outbound** — an Orchestrator/Specialist/Registry calling an
   HTTP/gRPC/email/message-bus Adapter directly for an external effect.

**Inbound vs outbound:** the **Portal** is *our* front door (others call us); the
**Adapter** is *our* client to external systems (we call/connect out, including
publishing). They are different roles, not duplicates.

**Emission has no special block, and is optional.** Events are a pattern for
**decoupled reactions** — used when a producer should not know its consumers.
Realizations, smallest-first:
- *No bus (in-process):* "emit" is a **fire-and-forget** call — spawn a task/thread
  that invokes the handler/Observer; the producer does not await it.
- *Message bus:* emit by calling a **message-bus Adapter** (`publish(topic, event)`)
  — a normal `dependsOn → Adapter` edge; an Observer subscribes via a bus Adapter.
- *Simplest systems* may skip events entirely and call the next step directly.

There is no "EventPublisher" block in any case. The optional `eventPublication`
interface binding (mirror of `eventSubscription`) lets producer↔consumer event
contracts be validated when events are used.

**Ports + implementations (the Carrier rule).** When a capability has multiple
external providers, define an **interface (a port)** and one Adapter per provider:
`Carrier` interface ← `DhlAdapter`, `UpsAdapter`. Callers depend on the `Carrier`
interface; the concrete Adapter is injected at bootstrap. This is composition +
polymorphism via interfaces — **not** inheritance.

---

## 5. Object modeling: where behavior lives

Entities are **passive state**; behavior belongs to the object that can perform it.
The test: **can the object do this autonomously, using only its own state?**

- **Yes → an intrinsic method on the entity.** `order.total()`, `order.is_valid()`,
  `dog.bark()` — pure logic over the entity's own fields (computed values,
  invariants, self-contained state transitions).
- **No (it needs an external actor or system) → a method on the acting *block*,
  taking the entity as an argument.** An order cannot ship itself → a `Carrier`
  (interface) with `DhlAdapter.ship(order)`. A dog cannot take itself out → a
  `Caretaker` (Specialist/Orchestrator) with `take_out(dog)`.

This is the rich-vs-anemic balance, and it maps onto the blocks: **the Store holds
the entity; Registries/Orchestrators/Specialists/Adapters act *on* it.** It keeps
domain logic out of passive data and prevents "god entities" that secretly
orchestrate.

**Composition over inheritance.** The model has no class hierarchies. Variation is
expressed by **interfaces (ports) with multiple implementations** (the Carrier
example) and by **composition** (a pattern owns blocks). Inheritance is avoided;
"is-a" relationships that tempt a hierarchy are almost always "implements-an-
interface" or "is-composed-of."

---

## 6. Entities and types

Entities and value objects are **first-class type specs** (not one of the ten
blocks — they are the *data* the blocks operate on). Each is defined **exactly
once**, scoped by ownership:

- **Shared value objects** with no single owner (Money, Address, Email) → the
  **system-level `types/`** (sibling to subsystems, under L0).
- **Entities / aggregates** (Order, Customer) → defined in the **subsystem that
  owns their lifecycle** (the bounded context whose Store is authoritative):
  `<subsystem>/types/`.

A type is **never** redefined in multiple places and is **not** a sibling to all
subsystems. When other subsystems process an Order, they **reference the owner's
contract** (its L1 public interface) or hold a **local projection/DTO** (an
anti-corruption view) — they do not share or redefine the owning aggregate. An L3
interface references types by id, so signatures stay structured (which also makes
data-model/ER diagrams derivable — see §13).

---

## 7. Patterns (named compositions)

A **pattern** is a *named, rule-bound composition of building blocks, exposed as
one component (a facade)*. A pattern owns **only building blocks** — never another
pattern (§9).

### Repository
> The data-access-layer component. It **owns** exactly one **Store**, one
> **Registry** (write face), one-or-more **Indexes** (read faces), and optionally
> one **Adapter** (the backend), and contains **no logic of its own**. The Store
> and Adapter are **private behind** the Registry/Indexes. Its facade **forwards
> 1:1** to the Registry (writes) and Indexes (reads); **consumers depend on the
> Repository facade only** — never the inner blocks.

The Registry's write is `validate → store.write (→ optionally publish)`; it does
**not** touch the Indexes. Indexes are **projections over the Store** that share its
per-entry references — a value-content update is seen through the shared reference
with no index change; only create/delete, or an update that changes an *indexed
field*, propagates structurally from the Store to its Indexes. Write-time
constraints (uniqueness, validation) are checked against the **Store** (the
authoritative source) + validation Specialists — not via an Index. A "custom query"
is an **Index** method (Adapter-backed if needed) — never a consumer→Adapter shortcut.

### Gateway
> `Portal + ingress Orchestrator + interceptor Specialists`. The **Portal** is the
> dumb inbound boundary; the **ingress Orchestrator** owns the middleware/interceptor
> sequence and the early-return policy; **Specialists** are the interceptors (auth,
> validation, rate-limit). A bare Portal (no ingress logic) is a block, not a Gateway.

### The facade rule (mechanically enforceable)
A pattern's facade does **pure 1:1 forwarding with no logic**: **every facade
method's narrative is exactly one `call` step.** More than one step, or a `local`
step, means the facade contains logic — a violation.

### Specialist as the wildcard pattern
Named patterns have *specific* containment rules; the **Specialist** is the
composition with *only the universal* rules. It may be a single leaf block *or* an
unnamed bounded composition of blocks. Guardrail: one responsibility, one coherent
interface; it must not silently become an Orchestrator or own bus/persistence/runtime.

---

## 8. Roles (naming vocabulary)

Below patterns are **roles** — conventional names for Specialists (and some
Orchestrators) that share a block's rules but carry a documented name + recommended
interface. They are vocabulary, **not** distinct types.

| Role | Recommended interface | Underlying block |
|---|---|---|
| Router | `route(input) → destination` | Index (flat key→target) or Specialist (rule-based) |
| Validator | `validate(x) → Result` | Specialist |
| Scanner | `scan(scope) → findings` | Specialist |
| Mapper / Compiler / Evaluator | one transform method | Specialist |

**Router vs Portal vs Facade:** a **Router** selects a destination from *dynamic
input values*; a **Portal** is the *transport* boundary that *uses* a Router/Index
to dispatch; a **Facade** does *no* routing (the caller already chose the method).

---

## 9. Relationships, composition, and layering

- **`owns` (composition):** a pattern owns its member blocks — **exactly one hop**;
  patterns never own patterns, blocks own nothing. This makes depth finite (no
  "L2.5").
- **`dependsOn` (collaboration):** any component uses others.
- **Visibility rule:** a component may depend on (a) blocks within its own group,
  (b) the *facade* of any other group, or (c) any standalone block — **never** a
  block private to another group.
- **"Leaf" is graph-specific:** an *ownership-leaf* owns no sub-components (a bare
  Specialist); a *dependency-sink* depends on nothing (typically a Store or
  Adapter). A bare Specialist is an ownership-leaf that may still depend on a
  Repository — so it is not a dependency-sink. The two are orthogonal.

**Layering inside a subsystem:**
```
Ingress:   Portal ─▶ Gateway = Portal + ingress Orchestrator + interceptor Specialists
Workflow:  Service Orchestrators (multi-step / cross-aggregate workflows)
Data:      Repository = Registry(write+constraints) + Index(read) + Store + Adapter(private)
Process:   Supervisor + Actors (self-initiated / long-running)
```

Workflow Orchestrators **use** Repositories; Repositories never contain a Portal or
a workflow Orchestrator. **When you are tempted to nest a pattern inside a
component, promote it to a subsystem (L1)** — composition of *patterns* is an L1
concern. A **Saga** is therefore an L1-level arrangement (an Orchestrator + an
Observer + a sibling Repository for its persisted progress), not an L2 pattern.

---

## 10. Implementation variants (L4) — language-neutral rule

Structure (L2/L3) is *what it is*; the concurrency strategy (L4) is *how it is
realized*. **Concurrency is only a concern when shared mutable state is actually
accessed concurrently** — a single-threaded or simple system uses plain ownership
and skips this section entirely; do not add concurrency machinery a system does not
need. When it *is* needed, the rule, stated neutrally:

| Updating… | Strategy |
|---|---|
| one value, simple read-modify-write (counter, flag, single reference) | a single **atomic operation** — wait-free, ordered, cheaper than a lock |
| one location, compound update with no atomic equivalent (rare) | a compare-and-set retry (race-free; avoid over large/variable values) |
| multiple locations that must stay mutually consistent (a map; or two fields) | **serialize writes (in order) + wait-free snapshot reads** (the default) |

**Default = wait-free reads / in-order serialized writes:** readers read a snapshot
reference without blocking; writers are serialized so they apply in order; on
commit the snapshot reference is swapped for all readers. Values are held by
reference so the snapshot swap is pointer-only (zero-copy).

The concrete primitives per language (atomics, swappable references, sharded maps,
persistent structures, transactional backends) live in
[language-bindings.md](language-bindings.md). The standard itself prescribes only
the *strategy*, so it remains language-agnostic.

**Exceptions to the default:** write-heavy large collections → sharded locks or a
persistent structure; cross-store atomic transactions → a transactional backend via
the Adapter; single-writer (Actor) state → wait-free reads, no write lock;
non-shared / write-once state → plain ownership.

---

## 11. Zero-copy / reference semantics (language-neutral)

The **Store** owns the authoritative per-entry reference. **Indexes** hold the
**same** references (shared, not value-copied), keyed differently — so reads are
zero-copy and **value-content updates are transparent**: updating the entity behind
its shared reference is seen by the Store and every Index at once, with no index
change. Only **structural** changes — create, delete, or an update that changes an
indexed field — propagate from the Store to its Indexes (an internal change-
propagation mechanism, *not* the domain Observer block). The **Registry** writes
only the Store; it never updates Indexes. (Where a language can't share references
safely, the binding appendix gives the equivalent.)

A coherent Index defined this way is **never stale**. A deliberately **evicting /
TTL cache** is a different thing — it is for *external or expensive-to-compute* data,
not a projection of an in-process Store, and is modeled as a caching **Adapter**
(e.g. Redis) or a memoizing **Specialist**, not as a Store-backed Index.

---

## 12. Infrastructure (not building blocks)

- **Message broker** — external infra (like a database). *Our client to it is an
  Adapter* (so publish/subscribe edges are visible in the graph — see §4).
- **Composition root / wiring (DI)** — the bootstrap that constructs the graph and
  injects dependencies. Infrastructure, not a domain block.
- **Cross-cutting** (authz, logging/metrics/tracing, config): coarse concerns are
  ingress interceptor Specialists (Gateway) + infra facilities; fine-grained authz
  lives in Registries/Orchestrators. Config loaded at boot is infra injected at the
  composition root.

---

## 13. Right-sizing the model

The standard upholds good structure at **any scale** — it must not force
microservice / distributed / concurrent complexity on a system that doesn't need it.

- **L1 is optional.** A small system (a restaurant reservation app, a single
  webapp) can be **one subsystem ≈ the whole system** — the L1 layer collapses into
  L0. Use multiple subsystems only when there are real bounded-context or deployment
  boundaries.
- **Concurrency is optional** (§10) — only when shared mutable state is actually
  accessed concurrently. A simple single-threaded app uses plain ownership.
- **Events are optional** (§4) — a pattern for decoupled reactions, not a mandate.
  Without a message bus, in-process events are fire-and-forget calls; the simplest
  systems call the next step directly.
- **Use the smallest set of blocks/patterns the system needs.** A tiny app might be
  one Gateway + a couple of Orchestrators + one Repository. Don't add blocks,
  patterns, or layers a system doesn't require.

The *discipline* is the same everywhere (right block for the job, correct
dependencies, behavior on the right object); only the *amount* of structure scales.

---

## 14. Diagram generation (V2)

The spec tree is a typed graph, so it renders to diagrams with no extra modeling
(planned V2, not v1):
- component + `dependsOn` → C4 / component diagrams
- `owns` tree → containment / module diagrams
- typed entities (§6) → data-model / ER diagrams
- L3 interfaces → contract views; L1 public interfaces → API maps
- **L5 narratives → sequence diagrams** (each `call` is a message)

Designs should stay faithful to the typed model so this stays free to add later.

---

## 15. Summary of binding rules

1. Two axes: containment (folders) and refinement (the three files per component).
2. Ten building blocks only; dependency rules fixed; the **Adapter** is the single
   external-I/O boundary and any component may depend on one.
3. A pattern owns **only blocks**, **one hop**, **never a pattern**; compose
   patterns at L1.
4. `owns` ≠ `dependsOn`; cross-group access is via facades only.
5. A facade forwards 1:1 with no logic (single-`call` narratives).
6. State-owners (Store/Supervisor/Actor/Index) ≠ stateless coordinators
   (Orchestrator/Registry/Specialist/Portal/Observer).
7. Workflow control flow → Orchestrator; local control flow → anywhere.
8. Behavior lives where it can be performed autonomously; coordinated/external
   behavior lives on the acting block, taking the entity as an argument.
   Composition + interfaces over inheritance.
9. Entities are first-class types, defined once by their owner; referenced, never
   redefined, elsewhere. Interfaces are method contracts; fields are implementation.
10. The Actor owns its run-loop (self-initiated processes); the Supervisor owns the
    set of Actors.
11. Structure is L2/L3; the concurrency variant is L4 (neutral strategy here,
    primitives in the language-bindings appendix). The bus client, composition root,
    and cross-cutting concerns are infrastructure, not blocks.
12. Registry (write) and Index (read) are decoupled — both work on the Store;
    Indexes are reference-sharing projections, never updated by the Registry.
13. Right-size: L1, concurrency, and events are all optional; use the smallest set
    of blocks a system needs, while upholding the same discipline at any scale.
