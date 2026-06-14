> **⚠ LEGACY / SUPERSEDED — do NOT implement from this document.**
> This describes the **pre-ledger** state of waffler_core (before the canonical design sessions). It is retained for historical reference only. **Authoritative now:** `docs/waffler_core/CANONICAL_DECISIONS.md` §5 + §3 (design decisions) + the per-service docs under `docs/waffler_core/services/runtime/` and `docs/waffler_core/services/blueprints/`. **NOTE:** the execution model described here (scope-chain / interpreter) is **replaced by the slot-VM** in the ledger. Where this file conflicts with the ledger, the ledger wins (see the ledger's "Authority order").

---

# Blueprint System Standards

**Version:** 2.0 · **Date:** 2026-04-14

Blueprints are Waffler's executable programs. They are visual, node-based flows that
describe a sequence of actions using package capabilities. This document defines the
blueprint data model, execution lifecycle, variable scoping, and the rules for
implementing or extending the blueprint system.

See also `docs/2_architecture/4_BLUEPRINT_SYSTEM.md` for the full specification.

---

## What a Blueprint Is

A blueprint is a JSON document that describes:
- A directed graph of **nodes** (steps), each referencing a package capability.
- An **entry point** — the first node to execute.
- **Subroutines** — named sub-flows with their own inputs and outputs.
- **Variable references** — how data flows between nodes.

Blueprints are stored as entities in the VFS (entity type: `Blueprint`) and managed
through the `blueprints` service on the message bus.

---

## Blueprint Context

Every blueprint carries a `context` object that replaces the old `blueprint_type` string field.
This context encodes three orthogonal dimensions:

```json
{
  "context": {
    "invocation_mode": "OnDemand",
    "ownership": { "Independent": {} },
    "target_spec": {
      "environments": [],
      "required_tags": [],
      "excluded_tags": [],
      "strict_mode_enabled": false
    }
  }
}
```

### InvocationMode

| Value | Meaning |
|-------|---------|
| `"Autonomous"` | Triggered by the scheduler, events, or external systems. Runs without a caller waiting for a response. |
| `"OnDemand"` | Explicitly invoked by another blueprint, a UI action, or the bus `blueprints:execute` command. Synchronous from the caller's perspective. |
| `"Template"` | A reusable sub-flow, directly embedded into another blueprint's subroutine graph. |

The old string field `blueprint_type` (`"Default"`, `"Function"`, `"Template"`) is deserialized
via a legacy alias for migration compatibility but must not appear in any new blueprint document.

### BlueprintOwnership

```json
{ "Independent": {} }                              // standalone blueprint
{ "OwnedByClass":     { "class_uuid": "...", "class_namespace": "workspace.MyClass" } }
{ "OwnedByInterface": { "interface_uuid": "...", "interface_namespace": "workspace.IFoo" } }
```

- `Independent` — normal user-created blueprint.
- `OwnedByClass` — method blueprint. Lives under the owning class in the namespace tree (see
  §06_NAMESPACE_VFS.md). Receives a `self` input whose type is the owning class.
- `OwnedByInterface` — default method implementation contributed by an interface.

### BlueprintTargetSpec

Controls which runtime environments and target languages can execute this blueprint,
and whether strict type enforcement is active at design time.

| Field | Type | Description |
|-------|------|-------------|
| `environments` | `TargetEnvironment[]` | Allowed execution environments (`Browser`, `Node`, `Desktop`, `Embedded`, `Server`, `Any`). Empty = unrestricted. |
| `required_tags` | `string[]` | Runtime must provide all these context tags. |
| `excluded_tags` | `string[]` | Runtime must not provide any of these tags. |
| `strict_mode_enabled` | `bool` | If true, type annotation mismatches are reported as errors in the designer. |

---

## Blueprint Data Model

```json
{
  "id": "uuid-here",
  "name": "My Blueprint",
  "context": {
    "invocation_mode": "OnDemand",
    "ownership": { "Independent": {} },
    "target_spec": {
      "environments": [],
      "required_tags": [],
      "excluded_tags": [],
      "strict_mode_enabled": false
    }
  },
  "main_entry_point_id": "node-1",
  "nodes": {
    "node-1": {
      "Action": {
        "id": "node-1",
        "module": {
          "module_id": "syw.network.http",
          "capability_id": "http.request"
        },
        "input_mapping": [
          { "target": "url", "source": "{{ blueprint.target_url }}" }
        ],
        "store_result": "http_response",
        "next": "node-2"
      }
    },
    "node-2": { ... }
  },
  "subroutines": []
}
```

### Node Types

| Type | Description |
|------|-------------|
| `Action` | Executes a package capability. Has `next` for the next node. |
| `Trigger` | Entry point that starts execution in response to an external event. |
| `Condition` | Evaluates a boolean expression; branches to `true_next` or `false_next`. |
| `Switch` | Matches a value against cases; routes to the matching case. |
| `Loop` | Iterates over a collection; runs a sub-graph for each item. |
| `SetVariable` | Assigns a value to a named variable in the current scope. |
| `CallSubroutine` | Invokes a named subroutine with inputs; receives outputs. |
| `Return` | Ends a subroutine and returns output values. |
| `Throw` | Emits an error, halting execution unless caught. |

### Node Fields

- `id` — Unique within the blueprint. Used to reference the node from `next` fields.
- `module.module_id` — The package ID this capability belongs to (e.g., `syw.network.http`).
  May also be a short alias (e.g., `http`) if the package claims one.
- `module.capability_id` — The capability being invoked (e.g., `http.request`).
- `input_mapping` — Array of `{ target, source }` pairs mapping input fields from
  variables, expressions, or literal values.
- `store_result` — Variable name to store the capability's output in (optional).
- `next` — ID of the next node to execute after this one completes.

---

## Variable Scoping

### Scope Chain

Blueprint execution maintains a **stack of scopes**. Variables are looked up from the
innermost (current) scope outward to the root scope. The first scope that holds the key wins.

Scopes are pushed when a subflow starts (loop body, branch, subroutine call) and
automatically popped when the subflow ends.

**Shadowing is disallowed.** Declaring a variable whose name already exists in any ancestor
scope is an error. This prevents the ambiguity of "which scope's variable does this refer to?"
— only one variable of any given name is visible at a time, from anywhere in the call stack.

### Root Scope Variables

The root scope is populated at blueprint start:

| Variable | Value | Notes |
|----------|-------|-------|
| `blueprint` | JSON object of trigger input values | Access as `{{ blueprint.input_name }}` |
| `global` | JSON object of persistent values | Cross-execution, persisted (Phase 2) |
| `execution.id` | Execution UUID string | Read-only system variable |
| `execution.start_time` | RFC 3339 timestamp | Read-only system variable |

Trigger inputs arrive as `{{ blueprint.x }}` — the `blueprint` object is the namespace that
holds them.

### Node Output Variables

Every node that executes automatically stores its result under its **node ID**:

```json
// On success (node ID = "action_3"):
"action_3" = { "success": true, "output": <return value> }

// On failure:
"action_3" = { "success": false, "error": "Error message" }
```

Access via path traversal expressions:

```
{{ action_3.output }}           ← the node's return value
{{ action_3.output.status }}    ← nested field within output
{{ action_3.success }}          ← bool
{{ action_3.error }}            ← only meaningful in an error handler
```

### Loop Variables

Loop nodes (`flow.for_each`, `flow.for_index`) inject their iteration context under the
**loop node's own ID** into the loop body's child scope:

```
// For a for_each node with ID "process_items":
{{ process_items.loop_body.item }}   ← current list element
{{ process_items.loop_body.i }}      ← 0-based iteration index
```

Nested loops each use their own node ID, so references are always unambiguous:

```
// Outer loop "outer_loop", inner loop "inner_loop":
{{ outer_loop.loop_body.item }}   ← outer element
{{ inner_loop.loop_body.item }}   ← inner element — no conflict
```

There are no configurable loop variable names. The node ID is the namespace.

### Error Handler Variables

When a node fails and its error handler fires, the error is accessible via the failing
node's ID — which is deterministic and known at design time:

```
{{ action_4.error }}    ← error message string
{{ action_4.success }}  ← always false inside the error handler
```

No ambient `error` variable is injected. The error always belongs to the specific node
that failed.

### Rules

1. **No qualification prefix required.** Variables are referenced by their natural path:
   `node_id.output.field`, `blueprint.input_name`, `loop_node_id.loop_body.item`.

2. **Blueprint inputs always under `blueprint`.** Never access trigger inputs without the
   `blueprint.` prefix — they live in the `blueprint` root object.

3. **Declare once, use everywhere in scope.** Variables persist in their scope until the
   scope is popped. Sub-scopes (loop bodies, branches) can READ ancestor variables, but
   cannot RE-DECLARE a name that already exists in an ancestor.

4. **Global variables persist between runs.** Declare and read them via the `global` root
   object. _(Implementation: Phase 2)_

5. **Node IDs must be unique within a blueprint.** The node auto-store pattern relies on
   unique IDs to prevent conflicts.

---

## Expressions

Within `input_mapping` source values and condition expressions, Waffler supports an
expression language:

```
{{ blueprint.response | to_upper_case() }}
{{ add(blueprint.count, 1) }}
{{ if(blueprint.is_active, "yes", "no") }}
{{ action_3.output.status_code }}
{{ process_items.loop_body.item }}
```

- `{{ ... }}` — expression block.
- Variable references: path strings using dot notation (`node_id.output.field`, `blueprint.name`).
- Function calls: built-in functions (`add`, `concat`, `to_upper_case`, `format_date`, etc.).
- Chaining via `|` (pipe): `{{ blueprint.name | to_lower_case() | concat("_suffix") }}`.

For the full function reference, query `schemas:functions.list` via the bus.

---

## Subroutines

Subroutines are reusable named sub-flows within a blueprint. They are not shared across
blueprints — for shared logic, use a dedicated blueprint.

```json
{
  "subroutines": [
    {
      "name": "ProcessItem",
      "entry_node": "sub-node-1",
      "inputs": [
        { "name": "item", "type": "object" }
      ],
      "outputs": [
        { "name": "result", "type": "string" }
      ]
    }
  ]
}
```

- Subroutine inputs are accessible by their declared input names within the subroutine
  (they are injected into the subroutine's scope as named variables).
- Subroutine outputs are set via `Return` nodes.
- A `CallSubroutine` node's output is stored under its node ID (`{{ call_node_id.output }}`),
  following the standard node auto-store pattern.

---

## Execution Lifecycle

1. **Trigger** — An external event (HTTP request, schedule, manual `run`) arrives at
   the `BlueprintPortal`.

2. **Dispatch** — The portal delegates to `BlueprintOrchestrator.run_blueprint(id, inputs)`.

3. **Lookup** — The orchestrator resolves the blueprint by ID or name from the `BlueprintIndex`.

4. **Context creation** — An `ExecutionContext` is created with:
   - A `BusHandle` for the execution to send commands.
   - The input variables in blueprint scope.
   - References to the `SchemaRegistry`.

5. **Execution** — The `BlueprintRunner` walks the node graph starting from `main_entry_point_id`,
   executing each node and storing results.

6. **Completion** — The runner publishes `execution.finished` and returns the outputs.

7. **Registration** — The `ActiveBlueprintRegistry` tracks in-progress executions so
   they can be monitored, cancelled, or logged.

---

## Method Blueprints and the `self` Pattern

A blueprint with `ownership: OwnedByClass` is a **method blueprint**. It must follow these rules:

1. **`self` input.** The trigger node's outputs always include a `self` input whose type annotation
   references the owning class via `TypeRef`. The `self_tagged: true` flag is set on that
   `FieldDefinition`. This input cannot be removed by the user; the designer locks it.

2. **`self` availability.** Once the trigger fires, `self` is in blueprint scope as
   `{{ blueprint.self }}` (it is part of the trigger inputs, wrapped in the `blueprint`
   object). Every node in the method blueprint can read it as a typed variable.

3. **Invocation.** Method blueprints are callable via three paths:
   - **Inline expression** (non-void return) — auto-available via `object.methodName(args)` syntax.
   - **Capability node** — registered in the owning package manifest; usable as an Action node.
   - **Direct OnDemand call** — always available via `blueprints:execute` with the class instance as input.

---

## Typed Variable Definition (`flow.set_variable`)

The `flow.set_variable` node supports a type annotation toggle. When enabled:

1. **Category picker** — user selects the entity category: `Primitive`, `Type`, `Class`,
   `Interface`, `Enum`, `Signature`.
2. **Entity picker** — filtered to entities in the namespace matching the chosen category.
3. **Form rendering** — per-category:
   - `Primitive` / `Type` / `Class` → inline form fields for the schema.
   - `Interface` → pick an implementing class, then render that class's form.
   - `Enum` → dropdown of enum values, stores the `underlying_value` (not the label).
   - `Signature` → stores a `FunctionRef` sentinel (see below).

"Leave unset" is always available and stores `null`.

### FunctionRef Sentinel

At runtime, a Signature-typed variable is stored in scope as a JSON sentinel object:

```json
{ "__fn_ref__": "Registered", "name": "my_package.my_fn" }
{ "__fn_ref__": "Blueprint",  "uuid": "..." }
```

The `flow.call_function` node reads this sentinel from scope and dispatches to the appropriate
registry lookup or bus call. Expression evaluator checks for the `__fn_ref__` key before
performing normal variable resolution.

---

## Handle-Local Scope Injection

When a node opens a subflow via one of its handles (loop body, branch, error handler),
it injects context into that subflow's scope **under the node's own ID** as a JSON object.

| Node | Handle | What is injected (under `node_id`) |
|------|--------|-------------------------------------|
| `flow.for_each` | `loop_body` | `{ loop_body: { item, i } }` — current element and 0-based index |
| `flow.for_index` | `loop_body` | `{ loop_body: { i } }` — current counter value |
| `flow.while` | `loop_body` | *(nothing — loop state lives in pre-declared variables)* |
| `flow.if_condition` | `then`, `else_if`, `else` | *(nothing — conditions carry no extra data)* |
| Any node's error handler | error subflow | The failing node's `{ success: false, error: "..." }` auto-store is already in scope |

Access loop context via:
```
{{ for_node_id.loop_body.item }}
{{ for_node_id.loop_body.i }}
```

Access error handler context via:
```
{{ failed_node_id.error }}
{{ failed_node_id.success }}
```

No configurable variable names. No ambient `item`, `i`, or `error` injections. Everything
is addressable by the stable node ID that the blueprint author assigned.

---

## Error Handling and `flow.throw`

### Error Entity

`syw.core.errors.Error` is the canonical error class. Wire format:

```json
{
  "message": "Something went wrong",
  "code":    "ERR_HTTP_TIMEOUT",
  "source":  "syw.network.http",
  "inner":   null
}
```

### Propagation Chain

When a node returns a `WafflerError` at the Rust level, it is stored in the node's
auto-store variable as `node_id = { success: false, error: "message" }`. Inside the error
handler subflow, access it as `{{ node_id.error }}` where `node_id` is the ID of the
failing node — known at design time.

### `flow.throw`

The `flow.throw` node is only available when an `Error` instance is present in the current
scope. It is a terminal node — it propagates the error up the call chain and does not have
a `next` connector. Use it to re-throw a caught error or to signal a new error condition.

---

## Blueprint Service Commands

| Command | Purpose |
|---------|---------|
| `blueprints:list` | List all blueprints with their namespace metadata |
| `blueprints:get` | Fetch a single blueprint definition |
| `blueprints:create` | Create a new blueprint |
| `blueprints:update` | Save changes to an existing blueprint |
| `blueprints:delete` | Delete a blueprint |
| `blueprints:run` | Start asynchronous execution; returns execution ID immediately |
| `blueprints:execute` | Synchronous execution; waits for completion and returns outputs |
| `blueprints:trigger` | Trigger execution from an HTTP trigger context |
| `blueprints:validate` | Validate a blueprint against its context (tags, ownership, targets) |
| `blueprints:logs` | Retrieve execution logs for a past execution |
| `classes:list_owned_blueprints` | List method blueprints owned by a specific class |

### `run` vs `execute`

- **`run`** — Non-blocking. Returns the `execution_id` immediately. Use when the caller
  does not need to wait for the result (e.g., a scheduled trigger).
- **`execute`** — Blocking. Waits for the blueprint to complete and returns its outputs.
  Use when the caller is an external system that expects a response (e.g., an HTTP webhook).

---

## Blueprint Package Reference (in Nodes)

When a node references a package capability:

```json
"module": {
  "module_id": "syw.network.http",
  "capability_id": "http.request"
}
```

- `module_id` must match either the full package ID or a declared alias.
- `capability_id` must match a capability ID declared in the package's manifest.
- The capability must be of category `Action`, `Query`, or `Trigger` to be usable in a node.

The execution engine resolves `module_id` against the `PackageIndex` at runtime.
If the package is not installed or is disabled, the node execution fails with a
descriptive error.

---

## Rules for Blueprint System Code

1. **All blueprint mutations go through the `BlueprintPortal` and `BlueprintOrchestrator`.**
   Never write to `BlueprintStore` directly from outside the blueprint domain.

2. **Execution is always tracked.** Every `run` or `execute` call must register an entry
   in `ActiveBlueprintRegistry` before the first node executes and deregister it after
   completion or failure.

3. **Errors are not fatal to the execution engine.** A failing blueprint should produce
   an error result and publish `execution.finished` with the error — it must never
   crash the waffler_core process.

4. **Variable mutations are local to one execution.** Variables declared in any scope
   never escape the execution. Global scope mutations (`global.*`) persist across executions
   and should be treated as a shared resource — document when a blueprint writes global
   variables.

5. **Input mapping expressions are evaluated lazily.** The expression is resolved
   immediately before a node executes, not when the blueprint is parsed. This means
   the value is always the current state at execution time.

6. **`blueprint_type` is a migration alias only.** All new code must write and read `context`.
   When loading old data, the custom deserializer converts `blueprint_type` to an equivalent
   `BlueprintContext`. Do not write new code that reads `blueprint_type` directly.

7. **Method blueprints must have a valid `self` input.** `waffler_core` enforces this at
   save time as a hard error regardless of strict mode. The designer locks the self input
   to prevent removal.
