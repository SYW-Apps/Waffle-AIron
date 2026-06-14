# Naming Conventions

**Version:** 1.0 · **Date:** 2025-10-01

Consistent naming is how Waffler's codebase stays readable without relying on comments.
Names should tell the reader what a thing *is* and *does*, not just what it contains.
Follow these rules in all Rust, TypeScript, and JSON/manifest code.

---

## Rust

### Types (structs, enums, traits)

Use `PascalCase`. Suffix indicates the component role (see `01_ARCHITECTURE_PATTERNS.md`):

| Suffix | Role | Example |
|--------|------|---------|
| `Portal` | Bus-facing entry point | `BlueprintPortal`, `PackagePortal` |
| `Orchestrator` | Domain coordinator | `BlueprintOrchestrator`, `SecurityOrchestrator` |
| `Supervisor` | Lifecycle manager | `ActiveBlueprintSupervisor`, `VfsSupervisor` |
| `Store` | Authoritative state owner | `BlueprintStore`, `FirewallRuleStore` |
| `Registry` | Write-path abstraction (CUD) | `BlueprintCudRegistry`, `BlueprintMounterRegistry` |
| `Index` | Read-path flat lookup | `PackageIndex`, `BlueprintIndex` |
| `Actor` | Single-instance owner | `PackageActor` |
| `Payload` | Bus message data carrier | `StringPayload`, `ValuePayload`, `EmptyPayload` |
| `Error` | Error type | `WafflerError` |
| `Config` | Configuration data | `PackageBuildConfig`, `PackageProcessConfig` |
| `Context` | Execution environment | `ExecutionContext` |

**Avoid generic suffixes** like `Manager`, `Helper`, `Util`, `Service`, `Handler`.
If you feel you need one of these, it means the responsibility should be split.

### Functions and Methods

Use `snake_case`. Names should read as a short English sentence describing what they do.

**Constructor methods:**
- `new(...)` — Standard constructor.
- `new_with_{detail}(...)` — Constructor with a significant variant, e.g., `new_with_path(...)`.
- `new_named(...)` — When a name/ID is the primary differentiator.

**Async lifecycle:**
- `run(self, rx)` — Consumes self; the main loop of a Portal or Supervisor. Never returns under normal operation.
- `execute(...)` — Carries out a specific action and returns a result.
- `activate(...)` / `initialize(...)` — One-time setup that must complete before the component is usable.
- `shutdown(...)` — Graceful teardown.

**Query methods** (read-only, return data):
- `get_{entity}(id)` — Fetch a single entity by identifier.
- `list_{entities}()` — Return a collection.
- `resolve_{thing}(...)` — Compute or look up a derived value.
- `find_{entity}(predicate)` — Search by criteria.

**Mutation methods** (change state):
- `create_{entity}(...)` — Insert a new entity.
- `update_{entity}(...)` — Modify an existing entity.
- `delete_{entity}(id)` — Remove an entity.
- `enable_{entity}(id)` / `disable_{entity}(id)` — Toggle active state.

**State transitions:**
- `transition_to_{state}(...)` — Explicit state machine step.
- `mark_{state}(...)` — Lightweight flag set (e.g., `mark_online()`).

**Boolean predicates:**
- `is_{condition}()` / `has_{thing}()` — e.g., `is_online()`, `has_capability()`.

### Variables and Parameters

Use `snake_case`. Names should be specific — avoid single-letter names outside of short iterators.

| Context | Good names | Bad names |
|---------|------------|-----------|
| Entity identifier | `blueprint_id`, `package_id`, `node_id` | `id`, `i`, `bid` |
| Display label | `display_name` | `name` (ambiguous — is this technical or human?) |
| Technical/slug name | `name`, `slug` | (acceptable for short-lived technical IDs) |
| Execution tracking | `execution_id`, `exec_id` | `run` |
| Command routing | `target_service`, `command_type` | `target`, `cmd` |
| Bus handle | `bus` | `b`, `handle` |
| Arc-wrapped shared state | `orchestrator`, `store`, `registry` | `arc_thing`, `shared` |
| Async channel senders | `command_tx`, `event_tx` | `tx`, `sender` |
| Async channel receivers | `command_rx`, `rx` | `receiver` |
| Clones made for async moves | `{name}_clone` | `{name}2`, `{name}_copy` |

### Modules (files and `mod` declarations)

Use `snake_case`. Module names reflect content, not role suffix:
- `portal.rs` — not `blueprint_portal.rs`
- `orchestrator.rs` — not `blueprint_orchestrator.rs`
- `store.rs` / `index.rs` / `actor.rs`
- `mod.rs` — allowed for domain root modules

---

## TypeScript / JavaScript

Use standard JS/TS conventions throughout:

- **Classes and interfaces:** `PascalCase` — `WafflerModule`, `CapabilityContract`
- **Methods and properties:** `camelCase` — `getCapabilities()`, `executeAction()`, `capabilityId`
- **Constants:** `SCREAMING_SNAKE_CASE` — `DATA_DIR`, `DEFAULT_TIMEOUT_MS`
- **Files:** `kebab-case` — `web-api.ts`, `waffler-module.ts`
- **Interfaces** use the `I` prefix only when the interface name would otherwise clash with a class name. Prefer plain names: `Capability`, not `ICapability`.

---

## Package Identifiers

### Package ID

Format: `{publisher}.{domain}.{service}` — all lowercase, dot-separated.

```
syw.network.http
syw.network.websocket
syw.network.ports
syw.database.postgres
syw.identity.core
```

Rules:
- `publisher` — the organization or individual that owns the package (e.g., `syw` for first-party).
- `domain` — the broad capability area (e.g., `network`, `database`, `identity`, `storage`).
- `service` — the specific service within the domain (e.g., `http`, `websocket`, `postgres`).
- Never use hyphens or underscores in a package ID. Dots only.

### Package Namespace

Format: `{publisher}.{domain}` — the parent of the service. Used for grouping in the namespace tree.

```
syw.network   (parent of syw.network.http, syw.network.websocket)
syw.database  (parent of syw.database.postgres)
```

> **No aliases.** Packages and services are always referred to by their full, exact ID — there
> are no short alias names. (Aliases were removed: an aliased call could silently bypass the
> Fast-Lane and fall back to the bus.) Ergonomics come from typed **SDK clients**, which
> provide the correct service/command names with no typos. Package-to-package dependencies
> always use the full package ID.

### Capability IDs

Format: `{domain}.{operation}` — all lowercase, dot-separated, within the package's namespace.

```
http.request
http.get
http.post
db.query
db.execute
ws.send
ws.connect
network.listen
```

The `domain` segment should match the package's `domain` component (e.g., `http` for `syw.network.http`).
The `operation` is a verb or verb-noun pair describing what the capability does.

---

## Message Bus — Commands

Full treatment in `03_MESSAGE_BUS.md`. Quick reference:

**Format:** `{service}:{command_type}`

- `service` — short stable name: `core`, `blueprints`, `packages`, `namespaces`, `types`.
  External packages use their full package ID: `syw.network.http`.
- `command_type` — lowercase, dot-separated path describing the operation.

```
blueprints:list
blueprints:get
blueprints:create
blueprints:run
core:status
core:vars.schema
core:vars.schema.update
core:security.firewall.list
packages:list
packages:install
packages:capabilities.list
namespaces:tree
namespaces:create
types:list
syw.network.http:http.request
```

---

## Message Bus — Events

**Format:** `{domain}.{sub_domain}.{event}` — all lowercase, dot-separated.

```
system.status
service.lifecycle
package.state_changed
execution.started
execution.node_started
execution.finished
blueprint.created
network.ws.connected
network.ws.message
network.tcp.data
```

---

## Files and Folders

- **Rust source files:** `snake_case.rs`
- **Rust modules (folders):** `snake_case/`
- **Documentation files:** `SCREAMING_SNAKE_CASE.md` (e.g., `MESSAGE_BUS.md`)
- **Entity manifest (incl. packages):** the type-blind `.manifest` part (CANONICAL_DECISIONS §1 — every entity, packages included, uses the universal `.manifest` part; there is no special-cased `package.json` filename)
- **Namespace metadata:** `.ns` part (the identity anchor)
- **Entity state files:** `.state` part
- **Standards documents (this folder):** `NN_SCREAMING_SNAKE_CASE.md` with numeric prefix for ordering

---

## Project Specific Naming

Follow these project-wide names for the core ecosystem components:

| Name | Role | Notes |
|------|------|-------|
| **Wack** | Runtime Environment / Runner | Executes compiled `.waffle` binaries. |
| **Wairon** | AI Builder / Compiler | Orchestrates the graph→bytecode compilation. |

### Artifacts and Formats

- **`.waffle`** — The portable compiled blueprint format (binary).
- **`.compiled`** — The VFS part name for a compiled artifact (historically `.waffle` bytes stored in this part).
- **Package** — The unified distribution ZIP (contains `/.manifest`, `/artifact/`, `/namespace/`).

### CLI Syntax

- **`wack <file.waffle>`** — The Runner. Invokes the Wack on a compiled bundle. No subcommands (e.g. no `wack run`).
- **`waffler <command>`** — The WDK/SDK developer tool (e.g. `waffler build`, `waffler init`).

---

## What to Avoid

| Avoid | Reason | Use instead |
|-------|--------|-------------|
| `data`, `info`, `stuff`, `thing` as variable names | No semantic content | Name after the specific domain concept |
| `process`, `handle`, `obj` | Overly generic | Name after what is being processed/handled |
| Abbreviations (`bp`, `pkg`, `cfg`) | Reduces readability | `blueprint`, `package`, `config` — unless the abbreviation is the canonical term (e.g., `ipc`, `vfs`) |
| Hungarian notation (`strName`, `bEnabled`) | Redundant with types | `name`, `enabled` |
| Negated boolean names (`is_not_ready`, `no_errors`) | Double negatives are confusing | `is_ready`, `has_errors` |
| Magic string literals for command types | Hard to trace and refactor | Use `SystemCommand::X.target()` or a named constant |
