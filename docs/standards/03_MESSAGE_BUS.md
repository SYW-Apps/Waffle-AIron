> **⚠ LEGACY / SUPERSEDED — do NOT implement from this document.**
> This describes the **pre-ledger** state of waffler_core (before the canonical design sessions). It is retained for historical reference only. **Authoritative now:** `docs/waffler_core/CANONICAL_DECISIONS.md` §6 (design decisions) + the per-service docs under `docs/waffler_core/services/message_bus/`. Where this file conflicts with the ledger, the ledger wins (see the ledger's "Authority order").

---

# Message Bus Standards

**Version:** 1.0 · **Date:** 2025-10-01

The message bus is Waffler's central nervous system. All inter-service communication
goes through it — whether the other party is an internal Portal, an external package
over IPC, a WASM module, or a remote process over the network. Understanding how to
use the bus correctly is essential to writing correct Waffler code.

See also `docs/2_architecture/12_MESSAGE_BUS.md` for the full architecture specification.

---

## Two Message Types

### Commands — Request/Response

A `Command` is a directed message from one sender to one target service, with an
expected response. Use commands when you need a result.

```rust
pub struct Command {
    pub id: Uuid,
    pub source_id: String,
    pub target_service: String,  // e.g., "blueprints"
    pub command_type: String,    // e.g., "list"
    pub payload: CommandPayloadContainer,
    pub context: MessageContext, // JWT/security context
    // response channel (private)
}
```

Key properties:
- **1-to-1:** Exactly one service handles a given command.
- **Synchronous from the caller's perspective:** `bus.execute_command(...)` awaits the response.
- **Timeout-aware:** Always specify a timeout for commands that call external services.
- **Security-gated:** Every command passes through the security middleware chain before dispatch.

### Events — Fire-and-Forget

An `Event` is a broadcast notification. The publisher does not know or care who is listening.
Use events to notify the system that something happened.

```rust
pub struct Event {
    pub id: Uuid,
    pub source_id: String,
    pub topic: String,    // e.g., "execution.finished"
    pub payload: EventPayloadContainer,
    pub context: MessageContext,
}
```

Key properties:
- **1-to-N:** Zero or many subscribers may receive a given event.
- **Fire-and-forget:** The publisher does not await a response.
- **Non-blocking:** Publishing an event must never block the caller.

---

## When to Use Commands vs. Events

| Use a Command when... | Use an Event when... |
|-----------------------|----------------------|
| You need a response or result | You are announcing something that happened |
| The operation must be authorized | Listeners are optional |
| You are invoking a service operation | You are notifying the system of a state change |
| The caller must wait for completion | The caller can continue immediately |

---

## Command Naming Convention

**Format:** `{service}:{command_type}`

- The `:` separator is mandatory and is the only separator between service and command.
- `service` — the stable short name of the target service (see table below).
- `command_type` — lowercase, dot-separated path describing the operation within the service.

### Core Services

| Service name | Responsible for |
|---|---|
| `core` | System status, global variables, security vault, firewall, policies |
| `blueprints` | Blueprint CRUD and execution |
| `packages` | Package install/uninstall/enable/disable, capabilities, aliases |
| `namespaces` | Namespace tree, entity CRUD |
| `schemas` | User-defined type (schema) management, global functions |

### Command Type Naming Rules

1. **Simple CRUD on the service's primary entity** — use a bare verb:
   ```
   blueprints:list
   blueprints:get
   blueprints:create
   blueprints:update
   blueprints:delete
   ```

2. **Operations on a sub-resource** — use `{sub_resource}.{verb}`:
   ```
   core:security.firewall.list
   core:security.firewall.save
   core:security.vault.list
   core:security.vault.get
   packages:capabilities.list
   packages:alias.list
   packages:alias.claim
   ```

3. **Operations on a variant of the primary resource** — use `{variant}.{verb}`:
   ```
   core:vars.schema
   core:vars.schema.update
   core:vars.values
   core:vars.values.update
   ```

4. **Actions that are not CRUD** — use a descriptive verb:
   ```
   blueprints:run
   blueprints:execute
   blueprints:validate
   blueprints:trigger
   packages:install
   packages:uninstall
   packages:approve_groups
   namespaces:resolve
   namespaces:move
   ```

5. **External packages** use their full package ID as the service:
   ```
   syw.network.http:http.request
   syw.network.websocket:ws.send
   syw.database.postgres:db.query
   ```
   The `command_type` within an external package follows the same dot-separated convention
   and should be prefixed with the package's domain (e.g., `http.`, `ws.`, `db.`).

### Full Reference — System Commands

```
core:status
core:vars.schema
core:vars.schema.update
core:vars.values
core:vars.values.update
core:security.vault.list
core:security.vault.get
core:security.vault.exchange
core:security.policy.load
core:security.policy.list
core:security.firewall.list
core:security.firewall.save
core:security.firewall.delete

blueprints:list
blueprints:get
blueprints:create
blueprints:update
blueprints:delete
blueprints:run
blueprints:execute
blueprints:trigger
blueprints:validate
blueprints:logs

packages:list
packages:install
packages:install_zip
packages:uninstall
packages:enable
packages:disable
packages:dependencies
packages:approve_groups
packages:capabilities.list
packages:ui_plugins.list
packages:alias.list
packages:alias.claim
packages:alias.release

namespaces:tree
namespaces:subtree
namespaces:create
namespaces:delete
namespaces:update
namespaces:move
namespaces:resolve

schemas:list
schemas:get
schemas:create
schemas:update
schemas:delete
schemas:functions.list
```

---

## Event Topic Naming Convention

**Format:** `{domain}.{sub_domain?}.{event_name}` — all lowercase, dot-separated.

Rules:
1. Use past tense or state nouns for event names (`created`, `finished`, `changed`, `connected`).
2. The domain should match the origin service or subsystem.
3. Sub-domains are optional — add them when events within a domain need to be distinguished.

```
system.status
service.lifecycle
package.state_changed
package.mounted
resource.updated
execution.started
execution.node_started
execution.node_completed
execution.finished
blueprint.created
network.ws.connected
network.ws.message
network.ws.disconnected
network.ws.error
network.tcp.connected
network.tcp.data
network.tcp.disconnected
network.tcp.error
```

---

## Using the BusHandle

### Sending a Command

```rust
// Preferred: use SystemCommand for internal system calls
let result = bus.execute_command(
    SystemCommand::GetAllBlueprints.service(),
    SystemCommand::GetAllBlueprints.command_type(),
    EmptyPayload(),
    None,   // timeout (None = default)
    None,   // wire encoding (None = JSON)
).await?;

// Or inline with string literals when addressing an external package:
let result = bus.execute_command(
    "syw.network.http",
    "http.request",
    payload,
    Some(Duration::from_secs(30)),
    None,
).await?;
```

Always use `SystemCommand::X.service()` and `SystemCommand::X.command_type()` for
internal system commands — never hardcode the string literals. This ensures type-safety
and makes refactoring traceable.

### Publishing an Event

```rust
bus.publish_event(
    SystemEvent::ExecutionFinished.as_str(),
    ExecutionFinishedPayload { execution_id, outputs },
)?;
```

Event publishing is infallible from the caller's perspective. Never propagate a publish
error as a fatal error — if no subscribers are registered, the event is silently dropped.

### Registering as a Command Handler

A service registers itself once during initialization:

```rust
let (handler_tx, handler_rx) = mpsc::unbounded_channel();
bus.register_command_handler(handler_tx).await?;
// Now listen on handler_rx in the run() loop
```

Only one handler may be registered per `service_id`. Attempting to register a second
handler for the same service ID will fail at startup.

### Subscribing to Events

```rust
let (event_tx, event_rx) = mpsc::unbounded_channel();
bus.subscribe_to_topic(
    SystemEvent::PackageStateChanged.as_str().to_string(),
    event_tx,
).await?;
```

---

## Payload Standards

### For Commands

- Internal commands between trusted components: prefer typed payload structs that implement `CommandPayload`.
- Commands arriving from external sources (IPC, WASM, network): use `ValuePayload` and extract fields defensively.
- Use `get_as::<T>()` for a direct downcast (trusted internal path).
- Use `get_payload_forced::<T>()` for a downcast with JSON fallback (external/IPC path).

### For Events

- Event payloads must implement `Serialize + Send + Sync`.
- Keep event payloads small — include only the fields that subscribers need to react.
- Never include sensitive data (secrets, credentials) in event payloads.

### Empty Payloads

When a command or response carries no data, use `EmptyPayload()`. Never pass
`serde_json::Value::Null` through the bus — it has no type information.

---

## Security on the Bus

Every command passes through the `SecurityMiddleware` before it reaches the target handler.
The middleware checks the command's `context` (JWT) against the firewall rules.

The authorization check uses the full target string `{service}:{command_type}`.
This means:
- Permission rules are written against the same `service:command_type` format.
- Wildcards are supported: `blueprints:*` grants access to all blueprint commands.
- Packages that need to send commands must declare the required permissions in their
  manifest's `permissions.groups` — see `08_SECURITY_MODEL.md`.

---

## Cross-Protocol Consistency

Regardless of how a package is connected to waffler_core (IPC, WASM call, native plugin,
or future network transport), the logical communication model is always the same:

- **Command** → target service + command type + payload → response or error
- **Event** → topic + payload (broadcast, no response)

The transport layer translates between its wire format (JSON-RPC, C ABI, WASM memory)
and this canonical model. Package code should think in terms of commands and events,
not in terms of transport details.
