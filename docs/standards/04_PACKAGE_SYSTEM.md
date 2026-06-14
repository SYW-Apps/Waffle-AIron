> **⚠ LEGACY / SUPERSEDED — do NOT implement from this document.**
> This describes the **pre-ledger** state of waffler_core (before the canonical design sessions). It is retained for historical reference only. **Authoritative now:** `docs/waffler_core/CANONICAL_DECISIONS.md` §7/§17.12 (design decisions) + the per-service docs under `docs/waffler_core/services/packages/`. Where this file conflicts with the ledger, the ledger wins (see the ledger's "Authority order").

---

# Package System Standards

**Version:** 2.0 · **Date:** 2026-04-14

Packages are the primary extension mechanism for Waffler. They add capabilities (actions,
triggers, queries) that blueprints can use. This document defines how packages are structured,
how they communicate with waffler_core, and what every SDK implementation must provide.

See also `docs/2_architecture/11_CORE_PLUGIN_ARCHITECTURE.md` for the full plugin architecture.

---

## Distribution & Installation

Waffler Packages are distributed as standard ZIP archives. To maintain the immutability and storage-abstraction of the Library VFS, package installation utilizes a **VFS-Abstracted Staged Ingest** model:

1. **Staging:** The Package Service verifies the primary Registry signature of the ZIP and extracts its contents to a secure staging directory.
2. **Entity-Level Signatures:** **Every file** inside the package ZIP (e.g., binaries, manifests) must have a companion `.sig` file appended with its signature (e.g., `logic.wasm` -> `logic.wasm.sig`).
3. **Explicit Handoff:** The Package Service commands the VFS Service to ingest the staged directory (`sys.fs.install_staged_package`).
4. **Manifest-Enforced Ingest:** The VFS Service independently verifies every `.sig` file. If 100% valid, it internalizes the package into its persistence backend (e.g., SQLite metadata and blob storage). If any validation fails, the entire installation is aborted.

---

## Package Types

### By Runtime

| Runtime | `features` flags | Description |
|---------|-----------------|-------------|
| `wasm` | `native_module: true` | Stateless WASM — new instance per call, no filesystem. Best for pure logic. |
| `wasi` | `native_module: true` | Stateful WASI — long-lived instance, filesystem access, reactive (called by host). |
| `wasi_service` | `native_module: true` | Persistent WASI service — runs its own event loop, may bind ports. |
| `javascript` | `native_module: true` | TypeScript/JavaScript via embedded JS engine. |
| `native` (alias: `dll`) | `native_module: true` | Native shared library loaded in-process. Highest performance, zero isolation. |
| `node` / `python` / etc. | `service: true` | External process, communicates via IPC. Strongest isolation. |

### By Feature Flags

A package can combine multiple features:

| Flag | Meaning |
|------|---------|
| `logic: true` | Provides capabilities usable in blueprints |
| `ui: true` | Provides UI plugin components |
| `service: true` | Runs as an external process (has a `process` config) |
| `native_module: true` | Runs as an in-process module (has a `module` config) |
| `multi_version_support: true` | Multiple versions can coexist (default: `true`) |

A package with only `logic: true` and no process or module config is a schema-only package
(build language `WafflerNative`) — it contributes blueprints, schemas, and types with no
compiled binary.

---

## Package Manifest (`package.json`)

Every package must have a `package.json` at its root. Required fields:

```json
{
  "id": "syw.network.http",
  "namespace": "syw.network",
  "version": "1.0.0",
  "display_name": "HTTP",
  "description": "Make HTTP requests from blueprints.",
  "manifest_version": "2.0",
  "features": {
    "logic": true,
    "native_module": true
  },
  "capabilities": [ ... ],
  "permissions": {
    "groups": [ ... ]
  }
}
```

### ID and Namespace

- `id` — Full dot-separated package identifier. See `02_NAMING_CONVENTIONS.md` for format rules.
- `namespace` — Parent namespace, always `{publisher}.{domain}`.
- These fields are immutable after first installation. Changing them is a breaking change
  that requires a new package identity.

### Version

- Follow semantic versioning: `MAJOR.MINOR.PATCH`.
- A breaking change to the manifest schema, capability IDs, or input/output contracts
  requires a MAJOR version bump.
- Adding new capabilities is MINOR.
- Bug fixes and internal changes are PATCH.

### Capabilities

Each capability in the `capabilities` array defines one thing the package can do:

```json
{
  "id": "http.request",
  "name": "HTTP Request",
  "description": "Perform an HTTP request to a URL.",
  "category": "Action",
  "inputs": { ... },
  "outputs": { ... },
  "strict": false,
  "node_capability": {
    "context_support": {
      "required_tags": [],
      "excluded_tags": [],
      "required_scope_types": [],
      "invocation_modes": ["OnDemand", "Autonomous"],
      "bridge_specs": []
    }
  }
}
```

**Capability ID rules:**
- Format: `{domain}.{operation}` — see `02_NAMING_CONVENTIONS.md`.
- Must be stable across versions (renaming a capability ID is a breaking change).
- Must be unique within the package.

**Category values:**
- `Action` — Performs an operation with side effects (HTTP call, DB write, notification).
- `Trigger` — Starts a blueprint execution when an external event occurs.
- `FlowControl` — Controls execution flow within a blueprint (internal use).
- `Query` — Reads data without side effects.
- `Internal` — Not exposed to blueprint builders; used internally.
- `Infrastructure` — Low-level system capabilities.

**Input/output contracts (`inputs`, `outputs`):**
- Defined as JSON Schema objects.
- Keep contracts stable — adding required fields is a breaking change.
- Adding optional fields is non-breaking.
- Use `strict: true` only when the engine must reject unknown input fields.

---

## Context Support (`context_support`)

The `context_support` field on `node_capability` controls when a capability can be
used. The blueprint designer filters available capabilities based on the blueprint's
`BlueprintContext` and the active `WafflerRuntimeContext`.

```json
"context_support": {
  "required_tags":        ["browser"],
  "excluded_tags":        ["embedded"],
  "required_scope_types": [
    { "entity_uuid": "...", "entity_kind": "WafflerClass", "allow_subtype": true }
  ],
  "invocation_modes":     ["OnDemand"],
  "bridge_specs":         []
}
```

| Field | Type | Description |
|-------|------|-------------|
| `required_tags` | `string[]` | Runtime must declare all these context tags. |
| `excluded_tags` | `string[]` | Runtime must not declare any of these tags. |
| `required_scope_types` | `ScopeTypeRequirement[]` | At least one in-scope variable of the specified type must be present in the blueprint scope. |
| `invocation_modes` | `InvocationMode[]` | Allowed blueprint invocation modes. Empty = all modes. |
| `bridge_specs` | `BridgeSpec[]` | Cross-environment bridge adapters. |

### `required_scope_types`

Used to conditionally expose capabilities that only make sense when a specific entity type
is in scope. For example, `flow.throw` requires an `Error` instance in scope.

```json
{
  "entity_uuid": "syw.core.errors.Error",
  "entity_kind": "WafflerClass",
  "allow_subtype": true
}
```

`allow_subtype: true` means a subclass satisfies the requirement (Dog satisfies Animal).
Checked by `classes:resolve` at design time.

### `declared_context_tags` in the package manifest

A package declares the context tags it introduces:

```json
"declared_context_tags": [
  {
    "id": "browser",
    "display_name": "Browser Runtime",
    "description": "The blueprint is executing in a web browser environment.",
    "group": "runtime"
  }
]
```

Tags are global across the platform. Packages must not claim tags already declared by
other packages. See `10_CONTEXT_TAG_SYSTEM.md` for the full tag catalogue and naming rules.

### `supported_languages` in the package manifest

Declares which compilation target languages this package provides code for:

```json
"supported_languages": ["typescript", "rust", "csharp"]
```

The compiler plugin uses this field to determine which packages can contribute compiled
output for a given target. Omit this field (or leave empty) for packages that do not
participate in compilation.

---

## Runtime Configuration

### Native Module (`module` config)

Required when `features.native_module: true`:

```json
"module": {
  "runtime": "wasm",
  "module_path": "dist/module.wasm",
  "memory_limit_mb": 64
}
```

For `wasi` / `wasi_service` runtimes, also declare resource requests:

```json
"module": {
  "runtime": "wasi",
  "module_path": "dist/module.wasm",
  "wasi_requests": {
    "fs": {
      "data_dir": true,
      "read": ["{{install_dir}}/config"],
      "write": []
    }
  }
}
```

**Runtime selection guidance:**
- Use `wasm` for stateless transformations (no I/O needed).
- Use `wasi` for stateful logic that needs a data directory or config files.
- Use `wasi_service` when the module must run a background loop or bind sockets.
- Use `native` only for trusted, high-throughput first-party code. A crash in a native
  plugin crashes the entire waffler_core process.

### External Process (`process` config)

Required when `features.service: true`:

```json
"process": {
  "runtime": "node",
  "entrypoint": "dist/index.js"
}
```

---

## Permissions

Packages declare permissions as named groups. Each group is shown as a single
approval checkbox during installation.

```json
"permissions": {
  "groups": [
    {
      "id": "http_access",
      "label": "Outbound HTTP Requests",
      "description": "Required to make HTTP requests on your behalf.",
      "required": true,
      "rules": [
        {
          "pattern": { "kind": "Command", "path": "syw.network.http:*" },
          "effect": "Allow"
        }
      ]
    }
  ]
}
```

Rules:
- Every permission group must have a stable `id` (never rename it; installed records reference it).
- `required: true` means declining blocks installation.
- `required: false` means the feature works partially without this group.
- Packages must not request more permissions than they need. Least-privilege is mandatory.
- Never use `*:*` or wildcard-all patterns. Be specific.

---

## SDK Mandate

**Every package that communicates with `waffler_core` must use the official Waffler SDK
for its language and runtime.** Custom or hand-rolled communication protocols are not
permitted.

This is not a preference — it is a hard requirement. The reasons:

- **Compatibility.** The SDK is versioned to match `waffler_core` build versions.
  An SDK version built against the same `waffler_core` release is guaranteed to be
  compatible with all instances of that release, regardless of deployment target
  (desktop, server, Raspberry Pi, embedded). A hand-rolled protocol has no such guarantee.
- **ABI and protocol stability.** The wire format between the core and packages
  (C ABI for native plugins, JSON-RPC framing for IPC processes, WASM memory layout
  for WASM modules) is an internal implementation detail managed by the SDK. It can
  change between build versions. Package code that bypasses the SDK is exposed to
  every such change without warning.
- **Robustness.** The SDK implements the fault isolation contract on the package side
  — structured error responses, panic catching, timeout signalling — that the core
  depends on. A package that bypasses the SDK cannot uphold this contract.
- **Consistency.** All packages, regardless of language or runtime, present the same
  logical interface to the core: capability registration, command dispatch, bus access.
  The SDK enforces this uniformity.

### SDK Versioning

SDK versions are tied to `waffler_core` build versions using the following rule:

- An SDK version **matches** a core build version if they share the same major and
  minor version component (e.g., SDK `1.3.x` matches core `1.3.x` for any patch `x`).
- A patch-level SDK update (bug fixes, documentation) is compatible with all core
  instances of the same minor version.
- A minor-level SDK update may add new features but must remain backward-compatible
  with the previous minor version of the core.
- A major-level SDK update signals a breaking change. Packages must be updated and
  republished before they work with the new core major version.

When installing a package, `waffler_core` checks the SDK version declared in the
package manifest against its own build version. A mismatch at the major level is a
hard install failure. A mismatch at the minor level produces a compatibility warning.

Always declare the SDK version used in the package manifest so the core can enforce
this check.

---

## SDK Contract

Every package SDK (regardless of language) must provide:

### 1. Capability Registration

The SDK must expose a way to declare the list of capability IDs the package handles.
In the Rust native SDK:
```rust
impl WafflerNativePlugin for MyPlugin {
    const CAPABILITIES: &'static [&'static str] = &["http.request", "http.get"];
    ...
}
```

In process-based SDKs, capabilities are declared in the manifest and dispatched by
capability ID in the handler.

### 2. Command Handler

A function or method that receives:
- `capability_id: &str` — Which capability is being invoked.
- `inputs: Value` — The capability inputs as a JSON object.

And returns:
- `Ok(Value)` — The capability outputs as a JSON object.
- `Err(String)` — A human-readable error message.

```rust
fn on_command(capability: &str, inputs: Value) -> Result<Value, String> {
    match capability {
        "http.request" => handle_request(inputs),
        _ => Err(format!("Unknown capability: {}", capability)),
    }
}
```

### 3. Initialization Hook (optional)

`on_init(bus: WafflerBus)` — called once when the package loads. Use this to:
- Spawn background threads or tasks.
- Establish external connections.
- Register event subscriptions.

### 4. Bus Access

The SDK must provide a `WafflerBus` (or equivalent) that wraps:
- `call(target, command, payload)` → `Result<Value, String>` — Send a command and wait for response.
- `emit(topic, payload)` — Publish a fire-and-forget event.

The underlying transport (C ABI for native, JSON-RPC for IPC, WASM memory for WASM) is
an SDK implementation detail. Package code should only use `call` and `emit`.

---

## Communication Flow

### Native Plugin (DLL)

```
waffler_core  ──[C ABI: waffler_plugin_dispatch]──►  plugin code
              ◄──[return value]──────────────────────
```

The host loads the `.dll`/`.so` once. Each capability invocation calls the exported
`waffler_plugin_dispatch` function synchronously. The plugin receives a `WafflerBus`
handle at `on_init` time and may call back into the core at any time.

### WASM / WASI Module

```
waffler_core  ──[WASM call: waffler_dispatch]──►  WASM sandbox
              ◄──[return value]─────────────────
```

For `wasm`: a fresh instance is created per call (stateless).
For `wasi` / `wasi_service`: a persistent instance is reused across calls.
The module communicates back to the core via imported host functions that
translate to bus calls.

### External Process (IPC)

```
waffler_core  ──[JSON-RPC over pipe/socket]──►  child process
              ◄──[JSON-RPC response]───────────
```

The process is started by waffler_core and communicates via a newline-delimited
JSON-RPC 2.0 protocol over stdin/stdout or a local socket. The SDK handles
the protocol framing; package code only sees capability invocations.

### Network / Remote (future)

When waffler_core and the package run on separate hosts, the same command/event
model applies. The transport (TCP, HTTP, WebSocket) is abstracted by the SDK.
From a package author's perspective, `call` and `emit` behave identically.

**This protocol-agnostic consistency is a core Waffler design principle.**
Package code must never contain transport-specific logic. If you find yourself
writing "if IPC do X, if WASM do Y", that logic belongs in the SDK, not the package.

---

## Core Fault Isolation Requirements

These are obligations of `waffler_core`, not of the package author. Every component in
the core that interacts with a package must satisfy all of the following. They are
non-negotiable requirements for Waffler to function as a robust platform.

### 1. All Package Calls Must Have Timeouts

Every command dispatched to a package — whether via IPC, WASM call, or native plugin
function — must have an enforced timeout. There is no such thing as a fire-and-forget
call to a package that the core waits on indefinitely. If a package hangs, the core
must detect it and return a structured timeout error to the caller.

Default timeouts are defined per runtime type. Packages may declare a custom timeout
for specific capabilities in their manifest, but they may not request an infinite timeout.

### 2. Native Plugin Calls Must Be Wrapped with `catch_unwind`

Native plugins (`.dll`/`.so`/`.dylib`) run in-process. A Rust panic inside the plugin
will unwind into `waffler_core` unless caught. Every call into a native plugin must be
wrapped with `std::panic::catch_unwind`. If a panic is caught, the plugin is transitioned
to `Failed` state and the capability call returns a structured error. The core continues
running.

Signal-based crashes (segfaults, aborts) cannot be caught — this is documented in the
native runtime description. This is one reason native plugins are discouraged for
untrusted code.

### 3. Package Process Crashes Must Be Detected and Contained

When an external process package terminates unexpectedly, the `PackageSupervisor` must:
1. Detect the exit (via the child process handle).
2. Transition the package to `Failed(reason)` state.
3. Publish a `package.state_changed` event.
4. Fail any in-flight capability calls for that package with a structured error.
5. Not affect any other package or any running blueprint that does not use that package.

A package crash is a recoverable condition for `waffler_core`. The platform continues
operating. Blueprints that were using the crashed package fail their current node with
an error result and follow their configured error path — they do not crash the runtime.

### 4. WASM Execution Must Be Sandboxed

WASM modules run in an isolated memory sandbox. The core must enforce:
- Memory limits declared in the package manifest (`memory_limit_mb`).
- WASI resource access only for paths and ports explicitly granted via `permissions.json`.
- Execution time limits. A WASM module that exceeds its CPU budget is terminated and
  the capability call returns a timeout error.

No WASM module may access host memory, host filesystem paths, or host network resources
that have not been explicitly granted.

### 5. Invalid or Malformed Package Responses Are Errors, Not Panics

A package that returns a response that does not match the expected format (wrong type,
missing fields, invalid JSON) must produce a `WafflerError::InvalidResponse` that is
returned to the blueprint execution engine. It must never cause an `unwrap()` panic or
a silent `None` in the core. Validate all package responses at the boundary.

### 6. Package Load Failures Must Not Block Other Packages

If a package fails to load (missing binary, signature mismatch, incompatible SDK version,
handshake timeout), it is put in `Failed` state and skipped. The remaining packages
continue loading. A single bad package must never prevent the platform from starting or
prevent other packages from becoming operational.

### 7. No Core State Is Corrupted by a Package Failure

All mutable core state (namespace tree, blueprint index, schema registry, active execution
registry) must be protected such that a package failure — even a mid-operation failure —
leaves the core in a consistent state. Use transactions, write-ahead patterns, or
rollback logic wherever a package interaction could leave state partially modified.

---

## Aliases (REMOVED)

> **Note:** Aliases for bus service IDs have been **removed** per the canonical decisions ledger. Services and capabilities must be addressed by their full Fully Qualified Identity (FQID) to prevent ambiguity in Fast-Lane routing. The following is retained for historical context only.

A package may claim short alias names for its bus service ID:

```json
"aliases": ["http", "rest"]
```

Once the package is installed and loaded, callers can address it as `http:http.request`
instead of `syw.network.http:http.request`.

Rules:
- Aliases are convenience — never use them in package-to-package dependencies.
- Only one installed package may hold an alias at a time.
- Alias conflicts are reported at install time; the conflicting package must be uninstalled first.

---

## Entity Types

Packages may contribute custom namespace entity types:

```json
"entity_types": [
  {
    "id": "ui_app",
    "display_name": "UI Application",
    "icon": "..."
  }
]
```

These are registered with the `EntityTypeRegistry` at package load time. The VFS scanner
uses them to recognize and route mount events for entities of package-defined types.
