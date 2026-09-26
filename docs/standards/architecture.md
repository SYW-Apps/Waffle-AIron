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
| **L0 System** | containment | `.index.yaml` (specs root) |
| **L1 Subsystem** | containment | `<subsystem>/.index.yaml` |
| **L2 Component** | containment leaf **and** refinement root (structure) | `<component>/.index.yaml` |
| **L3 Interface** | refinement | `<component>/.interface.yaml` |
| **L4 Implementation** | refinement | `<component>/.implementation.yaml` |
| **L5 Narrative** | refinement (a *sub-field* of L4, not a separate file) | steps inside `.implementation.yaml` |

---

## 2. The spec tree on disk

```
.wai/specs/
  .index.yaml                      ← L0  system: vision, boundaries, global requirements
  types/                           ← shared value objects (Money, Address, Email …)
    money.yaml
  <subsystem>/                     ← L1  a bounded context / service
    .index.yaml                    ← L1  public interface(s) the service exposes
    types/                         ← entities/aggregates owned by THIS subsystem (e.g. order.yaml)
    <component>/                   ← L2  a standalone block OR a pattern facade
      .index.yaml                  ← L2  structure: role/stereotype, responsibility, owns, dependsOn
      .interface.yaml              ← L3  contract: method signatures (referencing types by id)
      .implementation.yaml         ← L4+L5  sourcePath, concurrency variant, per-method narrative
      <owned-block>/               ← (only if this component is a pattern) a private owned block
        .index.yaml
        .interface.yaml
        .implementation.yaml
```

**File contents:**
- `.index.yaml` (L2) — identity, **role/stereotype**, **responsibility description**, `owns` (member blocks; patterns only), `dependsOn` (collaborators). No methods, no narratives.
- `.interface.yaml` (L3) — **method signatures** (name, params/returns referencing types, optional HTTP/gRPC/event binding). Interfaces are **method contracts only** — fields are implementation, never part of the contract.
- `.implementation.yaml` (L4+L5) — `sourcePath`, the **concurrency variant**, and the **per-method narrative** (L5 steps).

Different agents own different refinement files: the **architect** owns
`.index.yaml` + `.interface.yaml`; the **implementer** owns `.implementation.yaml`. (Legacy undotted names — `system.yaml`, `subsystem.yaml`, `component.yaml`, `interface.yaml`, `implementation.yaml` — still load; `wairon doctor --fix` migrates them.)

---

## 3. Building blocks (the primitives)

These ten are the **only** atomic component types.

| Block | Role | Owns | Default interface |
|---|---|---|---|
| **Portal** | The service's **inbound** front door — receives external commands and dispatches them | the inbound transport binding + dependencies | `dispatch(command) → result` |
| **Orchestrator** | **Logic as a flowchart** — ordered steps, conditions, branches, loops and parallel dispatch — calling its collaborators, other Orchestrators among them, nested down to leaf logic. One or more cohesive methods sharing those collaborators, realized as a class or a module of functions. Its `dependencyClass` (`pure` or `read`) bounds what it may depend on; unset, it is a **workflow** | dependencies only | domain-specific methods |
| **Supervisor** | Owns the **set** of live Actors and their lifecycle; may supervise other Supervisors | runtime state (the set of Actors) | `start/stop`, find-or-start by id |
| **Actor** | Owns **one** live thing — a session, a connection, a timer, or an entity instance — and handles its events one at a time. Its methods are full flowcharts, not shims | that thing's runtime state | `start/stop` + its messages |
| **Store** | Authoritative state boundary for **one aggregate** | the aggregate's entities | `get`, `list`, `write`, `remove` |
| **Index** | Read path; optimized derived lookup maps over a Store | derived lookup state | `get_by_<key>`, `list_by_<key>` |
| **Query** | A **Repository member** for computed reads over its Store — results the backend computes per call (an aggregate, a ranking, a report) | dependencies only | one method per computed read |
| **Registry** | Write path (CUD) for one aggregate | dependencies only | `create`, `update`, `delete` |
| **Adapter** | A **client to an external system/protocol** (DB, FS, HTTP, gRPC, WS, message bus). The **only** block doing raw external I/O | a connection/resource handle | protocol-shaped (`query`/`execute`, `send`/`receive`, `publish`…) |
| **Observer** | Subscribes to events and forwards them to one workflow | a subscription | `on_event(event)` |

### State vs dependencies vs workflow

Every component holds **dependencies** (its injected collaborators). What differs
is whether it also owns **state** or **workflow**:

| Owns domain/runtime state | Owns workflow | Owns only dependencies (stateless paths and boundaries) |
|---|---|---|
| Store (authoritative), Index (derived); Supervisor, Actor (runtime) | Orchestrator | Registry, Query, Portal, Observer, Adapter* |

\*The Adapter holds a *resource handle* (a connection), not domain state.
"Stateless" means **no domain state** — not "no fields."

An **Orchestrator holds only its collaborators**: whatever one call computes lives
on that call's stack. Runtime state — a live session, a timer, the set of running
instances — belongs to an **Actor** or a **Supervisor**, whose own methods run
logic over it; domain state belongs to a **Store**. State an Orchestrator keeps
for itself between calls is hidden state, invisible to every rule in this
standard.

### Dependency rules

- **Pure logic** — an Orchestrator with `dependencyClass: pure` — may be used by
  **every** block: a Store, Registry, Index or Query validating or deriving
  through it, an Adapter translating with it. It depends only on other pure
  Orchestrators, so it never drags data, I/O or held state into its caller.
- **Portal** is the inbound boundary; no *local* component may depend on it. It
  dispatches to Orchestrators and may consult Repository and Index **read** faces
  for passthrough reads; a write reached from a Portal's narrative or dispatch
  table routes through an Orchestrator (`PORTAL_WRITE_SHORTCUT`). It never depends
  on a Store, Registry, Adapter or Query. A Portal may **message a Supervisor by
  id** to reach a live Actor (below).
  The **one** exception to "no component depends on a Portal" is a
  **cross-subsystem client Adapter** (see below): from its side the remote
  subsystem's Portal is an external front door, so it depends on that Portal —
  never on the remote subsystem's internals.
- **Observer** may depend on exactly **one** Orchestrator *or* one Supervisor
  entry; it may use a message-bus **Adapter** to subscribe. No component depends on it.
- **Orchestrator** — its `dependencyClass` bounds its dependencies. The class is
  checked on every hop, so by induction nothing below pure logic reaches data or I/O:
  - `pure` depends only on pure Orchestrators;
  - `read` also depends on read Orchestrators, Repositories, Indexes and Adapters,
    and never calls their write methods (judged once facade methods carry effect tags);
  - unset, it is a **workflow**: it may depend on whatever the other rules allow —
    Repositories, other Orchestrators, Adapters, and Supervisors to reach live Actors.
- **Supervisor** reaches data **only through workflows**: it depends on its
  Actors, Orchestrators, Adapters and other Supervisors — never on a Store,
  Registry, Repository, Index, Query or presentation block.
- **Actor** — a live Actor is **reached by id through a Supervisor that
  supervises it**. Whoever depends on an Actor also depends on a Supervisor whose
  `dependsOn` lists that Actor, so its own `dependsOn` lists both
  (`ACTOR_REACHED_WITHOUT_SUPERVISOR`); a Supervisor depending on the Actor
  supervises it. The Actor itself may use Repository facades, Indexes, Adapters
  and Orchestrators, and never depends on its own Supervisor.
- **Store** may depend on an **Adapter** (its backend), another Store, or pure
  logic. It is depended *upon* by Registries, Indexes and Queries — never the reverse.
- **Index** is a read-only **projection over a Store**: it shares the Store's
  per-entry references. It may depend on its Store, an Adapter for cold reads, and
  pure logic. It **never** depends on a Registry — read and write paths are decoupled.
  As an **exceptional case**, when one Index's projection is itself worth
  re-presenting another way, a derived Index may depend on another Index — only
  one **owned by the same Repository**, and never in a cycle of Index edges
  (`ARCHITECTURE_VIOLATION_INDEX_DEP` otherwise). It is not a way to chain lookups:
  reach for it only when a second parse of the Store would duplicate state the
  first Index already holds (wairon's export tables over its scanned specs).
  An Index that **scans** a tree of project roots may read the configuration of
  the root it is walking, through that root's own binding — the same per-root
  binding it already resolves that root's files through — and nothing else of
  it (wairon's spec scan reads each root's `project.yaml` for the project graph).
- **Query** computes reads over its own Repository's Store: it depends **only on
  its Store, a backend Adapter or pure logic**, and it lives only inside a
  Repository (`UNOWNED_QUERY`).
- **Registry** is the write path to a Store; it may depend on its Store, Adapters
  (e.g. a message-bus Adapter to publish), and pure logic for validation. It does
  **not** depend on Indexes, and it drives no workflow.
- **Adapter** is a dependency-sink toward the system (its other side is external).
  It may use pure logic, but never a Store or any other Orchestrator. Workflows,
  read logic, Actors, Supervisors and the data blocks may depend on an Adapter to
  reach an external system. **Cross-subsystem client Adapter** (the one
  Adapter that depends *outward* on a Portal): a sibling subsystem is "potentially
  external" — designed to be swappable for a network service — so a local client
  Adapter is its only reachable surface, and it depends on the **remote subsystem's
  Portal** (its front door), which dispatches inward. It still may not depend on the
  remote subsystem's Orchestrators or Stores directly.
- The narrative `call` graph and the `dependsOn` graph must both be **DAGs** (no
  cycles), and every narrative `call` must target a method on a declared dependency.

### The Orchestrator, precisely

An Orchestrator is **logic as a flowchart**: ordered steps, conditions, branches,
loops, parallel dispatch and calls, where a call to another Orchestrator nests its
flowchart, down to leaf Orchestrators of native logic. It holds its collaborators
(constructor-injected, or closed over by a module of functions — see
[language-bindings.md](language-bindings.md)) and **no domain state**: each
call's state lives on the stack, so a shared instance is concurrency-safe and its
instantiation lifecycle is irrelevant to correctness.

- **All logic is a flowchart.** It is an Orchestrator's, an Actor's or
  Supervisor's own method over its own runtime state, or a type method for
  arithmetic over one value's own fields (§5). A verdict, a translation, a derived
  view and a multi-step workflow are all Orchestrators; what tells them apart is
  what they may depend on. **Local control flow** (guard clauses, a Registry's
  `exists?` check) is fine anywhere.
- **The dependency class** says what an Orchestrator may reach:

  | `dependencyClass` | May depend on | Typical shapes |
  |---|---|---|
  | `pure` | pure Orchestrators only | a verdict over supplied facts, a format translation, a view or text derived from values it is handed |
  | `read` | pure and read Orchestrators, Repositories, Indexes, Adapters — reading, never writing | a derivation that loads its own source, a lookup that gathers the facts for a verdict |
  | unset (a workflow) | whatever the other rules allow | writes, sequences, transactions, reaching live Actors |

  Choose the narrowest class that holds, and split to reach it: loading in the
  workflow and deriving in pure logic makes the derivation replayable and
  testable without fakes.
- **One or more cohesive methods.** An Orchestrator is the unit that holds one
  set of collaborators. Its methods belong together when they serve one purpose
  and share those collaborators; groups of methods that call no common component
  are two Orchestrators in one.
- Dependencies are injected at construction; method arguments carry only the
  **workflow input**. For "same workflow over many repositories," prefer one
  instance per concrete dependency behind a shared interface; use dynamic dispatch
  only when the choice is genuinely per-call.

### Self-initiated and long-running processes

There is **no separate "Process/Daemon" block** — owning one live thing *is* the
**Actor's** defining job. An Actor holds the runtime state of one live thing — a
session, a connection, a timer, or an entity instance — and handles its events one
at a time, so that state has a single writer. Its **methods are full
flowcharts**: an Actor method may call Repository facades, Indexes, Adapters and
Orchestrators itself. A part moves into an Orchestrator only when something else
also triggers it, or when it is too big to read in place. An Actor never passes
itself to an Orchestrator; it passes values from its state and applies the result.
The **Supervisor** owns the *set* of Actors and their lifecycle (find-or-start by
id, stop, restart with backoff, unload idle instances) and may supervise other
Supervisors, so a runtime is a **tree** under one root Supervisor.

| Need | Modeled as |
|---|---|
| cron / scheduler | an Actor owning the timer; each tick is its own method, calling the Orchestrator that does the work |
| batch job | an Actor owning the iteration, handling each item itself or through an Orchestrator |
| stream / websocket consumer | an Actor owning the read-loop + an Adapter owning the connection |
| message-bus consumer | an Observer subscribing via a bus Adapter, or an Actor owning a poll-loop |
| daemon | an Actor owning a long-running loop |

**Entity Actors.** An Actor may be the live instance of an entity — an auction
lot, a match, a device twin. The entity type stays data with pure methods; the
Actor holds one instance's working state and handles its messages; the **Store
stays authoritative**, loaded when the Actor starts and written through the
Repository. Use an entity Actor when live in-memory interaction is the point; use
persisted status plus event-driven workflows when steps are minutes or days
apart. A live entity Actor is the **only writer of its aggregate** in its
process: every other writer messages it through its Supervisor (a cluster needs a
lease or sharded routing to keep one writer).

**Large decisions: the Decider shape.** When an Actor's handling of a message
holds real decision logic, split it: *decide* — a pure Orchestrator, given the
state and the message, returns a decision; *persist* — the Actor's method writes
it in the transaction it owns (§10); *apply* — only after the commit, the Actor
updates its own state; *act* — it notifies or emits through its collaborators.
The decision logic is then replayable and testable without the Actor.

**Timers.**

| Timer | Modeled as |
|---|---|
| per-instance and loss-safe (a heartbeat, an idle timeout) | state of the Actor that owns the instance |
| a deadline on an aggregate (a lot's end, an order's payment due) | a **field of the aggregate** (`lot.endsAt`), read by its Index; a sweep Actor handles what falls due |
| a timer that spans several aggregates | a schedule aggregate with its own Repository, fired by an Actor |
| a process-wide schedule (a backup every minute) | its own Actor |
| restart backoff, passivation | the Supervisor |
| an external scheduler | an Adapter |

A deadline kept as a field survives a restart with nothing preloaded: the sweep
finds whatever fell due while the process was down.

---

## 4. External I/O and emission — the Adapter

The **Adapter** is the single boundary to the outside world, in two shapes:
1. **Behind a Store** — a DB/FS Adapter the Store translates domain calls into
   (`store.get` → `adapter.query(...)` → deserialize → entity).
2. **Standalone outbound** — an Orchestrator, Actor or Registry calling an
   HTTP/gRPC/email/message-bus Adapter directly for an external effect. An
   external tool — a linter run as a process, a policy engine behind an API — has
   the same shape: an Adapter runs it, and an Orchestrator interprets its output.

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

There is no "EventPublisher" block in any case. Event topology is declared, not
inferred: a component lists the topics it `emits` and `subscribesTo` (L2
fields), and a MessageBus public interface's endpoints carry a
`direction: publish | subscribe`. The validator pairs the two by topic —
an emitted topic nobody consumes is `UNCONSUMED_TOPIC`, a subscription with no
source is `UNSOURCED_SUBSCRIPTION` (topics with external ends are acknowledged
via `lint.allow`). Trees that use no events see neither check.

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
  `Caretaker` (an Orchestrator) with `take_out(dog)`.

This is the rich-vs-anemic balance, and it maps onto the blocks: **the Store holds
the entity; Registries/Orchestrators/Actors/Adapters act *on* it.** It keeps
domain logic out of passive data and prevents "god entities" that secretly
orchestrate. Behavior that belongs to **one live instance**, message by message,
lives on an entity Actor (§3), which still keeps the entity itself passive.

**Writes follow the aggregate.** An owner's value objects (a customer's address)
are saved with it in one Store call. A separate aggregate (the customer's
credentials) is written by the workflow, in one transaction when both must land
together (§10), with the ids generated in the workflow and the dependent
referencing its owner.

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
data-model/ER diagrams derivable — see §14).

---

## 7. Patterns (named compositions)

A **pattern** is a *named, rule-bound composition of building blocks, exposed as
one component (a facade)*. A pattern owns **only building blocks** — never another
pattern (§9).

### Repository
> The data-access-layer component for **one aggregate**. It **owns** exactly one
> **Store** — the aggregate's entity and everything that must stay consistent with
> it, across as many tables as that takes — and the faces over it: a **Registry**
> (write face), one-or-more **Indexes** (read faces), any **Queries** (computed
> reads), and optionally one **Adapter** (the backend). It contains **no logic of
> its own**. The Store and Adapter are **private behind** the Registry, Indexes and
> Queries. Its facade **forwards 1:1** to the Registry (writes) and to the Indexes
> and Queries (reads); **consumers depend on the Repository facade only** — never
> the inner blocks.

The Registry's write is `validate → store.write (→ optionally publish)`; it does
**not** touch the Indexes. Indexes are **projections over the Store** that share its
per-entry references — a value-content update is seen through the shared reference
with no index change; only create/delete, or an update that changes an *indexed
field*, propagates structurally from the Store to its Indexes. Write-time
constraints (uniqueness, validation) are checked against the **Store** (the
authoritative source) with pure validation logic — not via an Index.

**Index or Query.** An Index shares the Store's references, so it is never stale.
A read the backend computes on every call — an aggregate, a ranking, a report the
database assembles — is not a projection: it is a **Query** member, depending on
its Store or the backend Adapter (and pure logic). A custom computed query is a
Query, never an Adapter-backed Index method, and never a consumer→Adapter shortcut.

**Reads across aggregates.** A Repository stays a self-contained unit: a Query
never depends on another Repository's facade (two such Queries would also form a
cycle). A join falls into one of three cases:
- **within one aggregate** — a Store or Query method whose join is its implementation;
- **across aggregates** with small data or in different databases — a **read
  Orchestrator** joining the facades' results;
- **across aggregates in one database, as one statement** — a **read-model
  Repository** whose Query runs the join through the shared database Adapter.
  Declaring which aggregates a read model reads is not modelled yet; name them in
  its description.

**Mapping an ORM.** An object-relational mapper fits the model: the database
context (Entity Framework's `DbContext`, for one) is the database **Adapter** —
the connection, change tracking and the transaction context §10 has it issue;
entity mappings, navigation properties and `Include` joins implement a **Store**;
cross-aggregate projections and view-mapped keyless entities are read-model
**Queries**. The one habit the model pushes against is querying the context
straight from a workflow.

**When the full pattern is overkill — the two sanctioned shapes for held state.**
The Repository is the RECOMMENDED shape wherever read and write consumers diverge
or write-time constraints exist. For genuinely simple held state, a **deliberately
standalone Store** is the sanctioned lightweight form: the state stays visible as a
component, reachable from the workflow layer (a workflow Orchestrator or an Actor),
acknowledged with a `lint.allow` reason on the `UNOWNED_STORE` warning — and it
declares its `durability` like every Store (`durable` | `read-through` |
`ram-projection` | `cache`). The durability axis is **orthogonal** to the shape:
an in-memory Repository (`ram-projection` Store inside) and a persisted bare Store
(`read-through` file backing) are both legal quadrants. What is NEVER sanctioned is
the third path — folding held state into an Orchestrator's fields; hidden state
is invisible to every rule in this standard. And a standalone **Registry** is not a
shape at all: a Registry is the write path to a Store (`REGISTRY_WITHOUT_STORE`) —
a component that itself holds persisted state is a *Store*, whatever its file I/O
looks like. A **Query** has no standalone shape either: it lives only inside the
Repository whose Store it reads (`UNOWNED_QUERY`).

### gateway: a Portal variant
> A gateway is a **Portal** with the built-in `gateway` variant: a Portal that
> **authenticates, authorizes, validates or rate-limits before it dispatches**, by
> calling that logic, and declares its inbound authentication in `auth`. The
> checks are Orchestrators it depends on — typically read logic that gathers the
> caller's grants and pure logic that rules on them — never members it owns. A
> Portal with no ingress checks needs no variant.

The variant carries the implementation guidance (§8). The Gateway *pattern*
(`Portal + ingress Orchestrator + interceptor Specialists`) is retired
(`STEREOTYPE_RETIRED`); §8 lists its migration.

### The facade rule (mechanically enforced: `FACADE_FORWARDING`)
A pattern's facade does **pure 1:1 forwarding with no logic**: **every facade
method's authored narrative is exactly one `call` step targeting an owned
member.** More than one step, a `local` step, or a call that leaves the pattern
means the facade contains logic — a violation. The validator enforces this on
Repository facades as the `FACADE_FORWARDING` warning
(lint.allow-suppressible for deliberate exceptions); methods without an
authored narrative are governed by the detail dial, not this rule.

### No wildcard block
The model has no residual block for what fits nowhere else. A need that seems to
fit no block is a decomposition not yet made: held or derived state → a Store,
Index or Repository; behavior over a value's own fields → a type method; external
I/O → an Adapter; logic → an Orchestrator with the narrowest `dependencyClass`
that holds; one live thing → an Actor.

---

## 8. Roles (naming vocabulary)

Below patterns are **roles** — conventional names for Orchestrators (and some
Indexes) that share a block's rules but carry a documented name + recommended
interface. They are vocabulary, **not** distinct types.

| Role | Recommended interface | Underlying block |
|---|---|---|
| Router | `route(input) → destination` | Index (flat key→target) or a pure Orchestrator (rule-based) |
| Validator | `validate(x) → Result` | a pure Orchestrator |
| Scanner | `scan(scope) → findings` | a pure Orchestrator handed the scope, or a read Orchestrator that loads it |
| Mapper / Compiler / Evaluator | one transform method | a pure Orchestrator |

### The built-in variants

One step above roles sit **variants** — recurring shapes with a machine-recognized
identity (`variant:` on the component, resolved against the variant registry)
whose guidance travels into every agent brief. wairon ships a **built-in layer**.
The registry loads it first, then the global variants (`WAIRON_VARIANTS_DIR`, else
`~/.wairon/variants`), then the project's `.wai/variants/`; a later layer
**overrides a variant with the same id**, so a project can reword the built-in
guidance for its own team. A component's stereotype must equal its variant's
`base` (`VARIANT_BASE_MISMATCH`).

Variants carry **identity and guidance, not rules**. What an Orchestrator may
depend on is its `dependencyClass` field, which the validator enforces; one shape
can sit in either class, which is why the class is a field and not a variant.

| Variant | Base | Class | Shape | Discipline (guidance-enforced) |
|---|---|---|---|---|
| `arbiter` | Orchestrator | `pure` | subject + supplied world → deterministic verdict + reasons | NO I/O, no state deps — the caller gathers the world (companion shape: read logic or a workflow gathers, the arbiter rules); no clock/randomness; `idempotent` where it holds |
| `projector` | Orchestrator | `pure` when handed its source, `read` when it loads it | source model → self-contained derived view (snapshot, graph, artifact, digest) | ≤1 read facade or parameters-only; recomputed per call, owns nothing, writes nothing. NOT an Index: an Index is a maintained read model over an owned Store (or, exceptionally, over another Index of the same Repository) |
| `composer` | Orchestrator | `pure` when handed its values, `read` when it loads them | templates + values → authored text/file map | returns content, never writes or executes it; degrades gracefully on missing optional inputs |
| `codec` | Orchestrator | `pure` | format ↔ format, bidirectional | pure whole-value translation; inbound half validates + safety-checks; both directions in one component so the round-trip stays testable |
| `gateway` | Portal | — | a Portal that authenticates, authorizes, validates or rate-limits before dispatching | calls that logic before it dispatches; declares its inbound auth in `auth`; writes still route through Orchestrators |

A variant is **promoted to a first-class stereotype** only when independent
projects/packs keep re-registering it, or when its edge rules exceed what guidance
can express.

### Retired stereotypes

`Specialist` and `Gateway` are retired. A component typed with either is
`STEREOTYPE_RETIRED` (error) until it is migrated; meanwhile the rules that judge a
stereotype's shape skip it, so it reports once.

| Retired | Becomes | Migration |
|---|---|---|
| `Specialist` | an Orchestrator with the `dependencyClass` its dependencies give it | `wairon doctor --fix` retypes it with that class, and rebases each Specialist-based variant onto Orchestrator |
| `Gateway` | the Portal it owned, with the `gateway` variant | by hand: (1) the owned Portal becomes the front door, with `variant: gateway`; (2) the Gateway's other members become that Portal's dependencies; (3) its consumers depend on the Portal; (4) delete the Gateway spec — `sdd_rename_component` can then give the Portal the Gateway's id |

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
- **"Leaf" is graph-specific:** an *ownership-leaf* owns no sub-components (every
  block); a *dependency-sink* depends on nothing (typically a Store or Adapter). A
  read Orchestrator is an ownership-leaf that may still depend on a Repository —
  so it is not a dependency-sink. The two are orthogonal.

**Layering inside a subsystem:**
```
Ingress:   Portal  (with the gateway variant when it authenticates, authorizes, validates or rate-limits first)
Workflow:  Orchestrators: workflows, over read and pure logic
Data:      Repository = Store (one aggregate) + Registry (write+constraints) + Indexes/Queries (read) + Adapter (private)
Process:   a Supervisor tree + Actors (sessions, connections, timers, live entity instances)
```

Workflow Orchestrators **use** Repositories; Repositories never contain a Portal or
an Orchestrator. **When you are tempted to nest a pattern inside a
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
the Adapter (see the unit-of-work rule below); single-writer (Actor) state →
wait-free reads, no write lock; non-shared / write-once state → plain ownership.

### Transactions & the unit of work

A transaction is a **value, not a place**. The doctrine, in five rules:

1. **The backend Adapter issues the transaction context.** The Adapter over the
   transactional technology (declared via `technologies` on its L4) exposes
   begin/commit/rollback as ordinary contract methods; `begin` returns an opaque
   transaction-context value. No other block ever creates one.
2. **The method that owns the workflow owns the scope** — an Orchestrator's
   method, or an Actor's own method when the Actor runs the workflow. Begin,
   commit, and rollback are narrative steps of that method — begin, then a
   `try` region whose calls carry the context, commit as the body's last step,
   rollback in the `catch` handler. The transaction boundary is thereby VISIBLE
   in the L5 narrative, reviewable like any other flow.
3. **The context travels as an explicit method argument.** Repository facades
   (and their inner Registry/Store) MAY accept an optional transaction-context
   parameter on write-face methods and pass it through to the backend Adapter.
   Never store the context in component state — a held transaction is hidden
   state and a concurrency hazard in one.
4. **In-memory state changes only after commit.** An Actor applies a decision to
   its own state after the commit step, never before: a rollback leaves nothing in
   memory to undo, and no reader sees a state the Store does not hold.
5. **Guarantee tags stay honest.** A method declaring `transactional`/`atomic`
   should either bind a transactional backend through its technology Adapter or
   accept the context parameter. The validator checks claim↔declaration
   consistency (a narrative step asserting a guarantee must call a method
   declaring it) — whether the transaction actually holds is implementation
   correctness, proven by tests, not by the gate.

**Publish-and-persist atomically = the outbox pattern.** When a workflow must
persist domain state AND emit an event without a gap, do not call the bus in the
same breath as the write: append an outbox entry in the SAME transaction as the
domain write, through a **sibling outbox Repository** (the outbox is an aggregate
of its own, so it has its own Store), and let an Actor (or Observer on the
backend's change feed) drain the outbox, publish through the bus Adapter, and mark
entries delivered. A relay that restarts republishes, so consumers drop duplicates
by event id. The Saga arrangement (§9) composes with this: the outbox is its
delivery half, and the saga's progress Repository its memory.

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

A derived Index — the exceptional Index over another Index of the same
Repository (§3) — projects that Index's references rather than the Store's,
and is dropped and rebuilt with it, so the same holds for it.

A coherent Index defined this way is **never stale**. A deliberately **evicting /
TTL cache** is a different thing — it is for *external or expensive-to-compute*
data, not a projection of an in-process Store. An external cache service (e.g.
Redis) is a caching **Adapter**; an in-process memo/TTL cache is a **Store with
`durability: cache`** — evictable, loss-safe, hydration-exempt, and VISIBLE as
held state. It is never a memoizing Orchestrator (an Orchestrator holds only its
collaborators) and never a private field inside a logic component (hidden state).

---

## 12. Infrastructure (not building blocks)

- **Message broker** — external infra (like a database). *Our client to it is an
  Adapter* (so publish/subscribe edges are visible in the graph — see §4).
- **Composition root / wiring (DI)** — the bootstrap that constructs the graph and
  injects dependencies. Infrastructure, not a domain block.
- **Cross-cutting** (authz, logging/metrics/tracing, config): coarse checks run at
  the ingress — a Portal with the `gateway` variant calls authentication,
  authorization, validation and rate-limit logic before it dispatches — plus infra
  facilities; fine-grained authz lives in Registries/Orchestrators. Config loaded
  at boot is infra injected at the composition root.

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
  one Portal + a couple of Orchestrators + one Repository. Don't add blocks,
  patterns, or layers a system doesn't require.

The *discipline* is the same everywhere (right block for the job, correct
dependencies, behavior on the right object); only the *amount* of structure scales.

---

## 14. Diagram generation

The spec tree is a typed graph, so it renders to diagrams with no extra
modeling. These surfaces are SHIPPED (interactive canvas, Mermaid, draw.io,
Excalidraw exports, and the flow modal):
- component + `dependsOn` → C4 / component diagrams
- `owns` tree → containment / module diagrams
- typed entities (§6) → data-model / ER diagrams
- L3 interfaces → contract views; L1 public interfaces → API maps
- **L5 narratives → sequence diagrams and flowcharts** (each `call` is a
  message; `parallel` fans out, `detach` renders fire-and-forget)

Designs should stay faithful to the typed model so the diagrams stay free.

---

## 15. Worked example: a live auction

Sellers list lots. Bidders watch a lot live and place bids; a bid in the last
seconds extends the lot's end. An open lot closes at its deadline, a payment feed
marks sold lots paid, and each seller has a dashboard of their lots, bids and
bidders.

| Component | Block | Responsible for |
|---|---|---|
| `bidding_portal` | Portal (HTTP and WebSocket) | bids, watch subscriptions, admin commands |
| `bidding` | Orchestrator (workflow) | `place(lotId, bid)`: load the bidder, hand the bid to the live lot |
| `lot_lifecycle` | Orchestrator (workflow) | `open`, `close`, `cancel`, `markPaid` — shared by the deadline sweep, admins and the payment feed |
| `bid_rules` | Orchestrator, `pure` | `decide(lot, bid, bidder, policy, now)`, including the last-second extension |
| `seller_dashboard` | Orchestrator, `read` | a seller's lots with their bids and bidders, joined across two Repositories |
| `live_lot` | Actor | one open lot's working state, its watchers, its heartbeat |
| `live_lots` | Supervisor | find-or-start a live lot by id, stop it, unload idle ones |
| `deadline_sweep` | Actor | the process-wide tick that closes lots whose deadline has passed |
| `outbox_relay` | Actor | publishing outbox entries through the event bus and marking them delivered |
| `auction_runtime` | Supervisor (root) | starting and stopping `live_lots`, `deadline_sweep` and `outbox_relay` |
| `lot_repository` | Repository | the lot aggregate: a Store over the tables `lots` and `bids`, a Registry, an Index by id and by `endsAt`, and the Query `bid_history` |
| `bidder_repository` | Repository | the bidder aggregate |
| `outbox_repository` | Repository | the outbox aggregate |
| `auction_database` | Adapter | the database connection; issues transactions |
| `event_bus` | Adapter | publishing and subscribing to events |
| `watcher_sockets` | Adapter | pushing updates to watching clients over WebSocket |
| `payment_feed` | Observer | forwarding payment events to `lot_lifecycle.markPaid` |

```
bidding_portal    → bidding, lot_lifecycle, seller_dashboard, live_lots, live_lot
bidding           → bidder_repository, live_lots, live_lot
lot_lifecycle     → live_lots, live_lot
seller_dashboard  → lot_repository, bidder_repository
payment_feed      → lot_lifecycle, event_bus
auction_runtime   → live_lots, deadline_sweep, outbox_relay
live_lots         → live_lot
live_lot          → bid_rules, lot_repository, outbox_repository, auction_database, watcher_sockets
deadline_sweep    → lot_repository, lot_lifecycle
outbox_relay      → outbox_repository, event_bus
```

**Placing a bid.** `bidding_portal` hands the bid to `bidding.place`, which loads
the bidder through `bidder_repository`, asks `live_lots` for the live lot by id
(starting it, with its state loaded through `lot_repository`, when it is not
running) and calls `live_lot.placeBid(bid, bidder)`. That method is the Decider
shape (§3):
1. **decide** — `bid_rules.decide(lot, bid, bidder, policy, now)` accepts or
   rejects the bid, and moves `endsAt` when the bid lands in the last seconds; a
   rejection returns at once;
2. **persist** — begin a transaction through `auction_database`; in a `try`
   region, write the bid and the lot's `endsAt` through `lot_repository` and
   append a `bid_placed` entry through `outbox_repository`, both carrying the
   context; commit; on failure, roll back and rethrow;
3. **apply** — only after the commit, update its own leading bid and `endsAt`;
4. **act** — push the new standing to the lot's watchers through `watcher_sockets`.

`outbox_relay` later publishes `bid_placed` through `event_bus` and marks the
entry delivered.

**Closing.** The deadline is the field `lot.endsAt`, which the lot Index keeps in
order. On each tick `deadline_sweep` reads the lots that are due through
`lot_repository` and calls `lot_lifecycle.close` for each; `close` reaches the live
lot through `live_lots`, the same single writer a bid goes through. `live_lot`
checks `endsAt` against its own state before it closes, because a last-second bid
it handled first may have moved the deadline.

**After a restart.** Nothing is preloaded. A lot's Actor starts again on its next
bid, watch or close; lots that fell due while the process was down close within one
tick; the relay republishes entries it had not marked delivered, and consumers drop
duplicates by event id.

**The names.** Each component is named for what it is responsible for: a process
(`bidding`, `lot_lifecycle`), a live thing (`live_lot`), a set of them
(`live_lots`), an aggregate's data (`lot_repository`), an external system
(`auction_database`, `event_bus`), an audience or a feed (`seller_dashboard`,
`payment_feed`). Logic without collaborators is named for the rules it holds
(`bid_rules`). A method is a verb phrase that does not repeat its component's
words — `bidding.place`, not `bidding.placeBid` — and arithmetic over one value's
own fields is a method on its type (`lot.isOpen(now)`). A role word appears only to
tell apart components that share a noun, and it matches the block:
`lot_repository` is a Repository.

**The rules it demonstrates.**
1. **A live Actor is addressed through its Supervisor.** `bidding`,
   `lot_lifecycle` and `bidding_portal` reach a lot by id through `live_lots` and
   never hold it; each lists `live_lot` together with `live_lots` in `dependsOn`,
   since a call must target a declared dependency.
2. **One writer per live aggregate.** `live_lot` is the only writer of its lot in
   the process: a close from the sweep or an admin goes through `live_lots` just as
   a bid does. A cluster needs a lease or sharded routing to keep it so.
3. **The method that owns the workflow owns the transaction.** `live_lot.placeBid`
   begins, commits and rolls back, and changes its in-memory state only after the
   commit.
4. **Supervisors form a tree.** `auction_runtime` supervises `live_lots` and the
   two process-wide Actors.
5. **A Portal messages a Supervisor by id**, as an Observer may: `bidding_portal`
   adds a watcher to a live lot through `live_lots`.
6. **Deadlines are aggregate fields read by an Index.** A schedule aggregate is
   only for timers that span aggregates.
7. **Reads across aggregates go through read logic.** `seller_dashboard` joins
   `lot_repository` (its `bid_history` Query computes a lot's bids per call) with
   `bidder_repository`; the outbox is a sibling Repository, written in the bid's
   transaction.

---

## 16. Summary of binding rules

1. Two axes: containment (folders) and refinement (the three files per component).
2. Ten building blocks only; dependency rules fixed; the **Adapter** is the single
   external-I/O boundary.
3. A pattern owns **only blocks**, **one hop**, **never a pattern**; compose
   patterns at L1.
4. `owns` ≠ `dependsOn`; cross-group access is via facades only.
5. A Repository facade forwards 1:1 with no logic (single-`call`-to-owned-member
   narratives; enforced as `FACADE_FORWARDING`).
6. State-owners (Store/Index for domain state; Supervisor/Actor for runtime state) ≠
   components holding only collaborators (Orchestrator/Registry/Query/Portal/Observer).
7. All logic is a flowchart: an Orchestrator's methods, or an Actor's or
   Supervisor's own methods over its runtime state. An Orchestrator's
   `dependencyClass` bounds its dependencies — `pure` on pure logic only, `read` also
   on read logic, Repositories, Indexes and Adapters, unset a workflow — and pure
   logic may be used by every block. Local control flow → anywhere.
8. Behavior lives where it can be performed autonomously; coordinated/external
   behavior lives on the acting block, taking the entity as an argument.
   Composition + interfaces over inheritance.
9. Entities are first-class types, defined once by their owner; referenced, never
   redefined, elsewhere. Interfaces are method contracts; fields are implementation.
10. The Actor owns one live thing and its methods are full flowcharts; the
    Supervisor owns the set of Actors, may supervise Supervisors, and reaches data
    only through workflows. A live Actor is reached by id through a Supervisor that
    supervises it and is the only writer of its aggregate; the method that owns a
    workflow owns its transaction, and in-memory state changes only after commit.
11. Structure is L2/L3; the concurrency variant is L4 (neutral strategy here,
    primitives in the language-bindings appendix). The bus client, composition root,
    and cross-cutting concerns are infrastructure, not blocks.
12. A Store covers one aggregate. Registry (write), Index and Query (read) are
    decoupled — all work on the Store; Indexes are reference-sharing projections,
    Queries compute per call inside their Repository, and the Registry updates
    neither. Reads across aggregates go through read logic or a read-model Repository.
13. Right-size: L1, concurrency, and events are all optional; use the smallest set
    of blocks a system needs, while upholding the same discipline at any scale.
14. A gateway is a Portal with the `gateway` variant. Variants load built-in →
    global → project and carry guidance, not rules. `Specialist` and `Gateway` are
    retired (`STEREOTYPE_RETIRED`) until migrated.
