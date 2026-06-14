# Context Tag System Standards

**Version:** 1.0 · **Date:** 2026-04-14

Context tags are string identifiers that describe the runtime environment in which a
blueprint executes. They allow package capabilities to declare environmental requirements
or exclusions, and allow the designer to filter available capabilities based on where
the blueprint will run.

See also `docs/rfcs/007-blueprint-context-and-compilation-targets.md` for the full
specification of the tag model.

---

## What a Context Tag Is

A context tag is a short dot-separated string, e.g. `browser`, `embedded`, `breakable`.
Tags are global across the platform. A package declares the tags it introduces in its
manifest; the designer uses the active `WafflerRuntimeContext` to determine which tags
apply at a given moment.

Tags describe **facts about the environment**, not permissions or capabilities.
A tag like `browser` means "this execution is happening inside a web browser" —
it does not grant or restrict any operation on its own. Tags only gain meaning when
a capability declares `required_tags` or `excluded_tags`.

---

## Tag Naming Convention

| Pattern | Meaning | Example |
|---------|---------|---------|
| `{runtime}` | Execution platform | `browser`, `node`, `desktop`, `embedded`, `server` |
| `{runtime}.{variant}` | Narrower runtime variant | `embedded.arduino`, `desktop.electron` |
| `{capability}` | A structural feature of the execution context | `breakable`, `loop`, `async` |
| `{publisher}.{name}` | Package-specific tag | `syw.sensors`, `acme.kiosk` |

Rules:
- All lowercase, dot-separated.
- No underscores or hyphens in tag IDs.
- Publisher-prefixed tags (`{publisher}.{name}`) are the only acceptable form for
  package-specific tags. Do not use generic words like `custom` or `plugin` as a prefix.
- Well-known tags (in the catalogue below) must be used as-is. Do not redefine them.

---

## Well-Known Tag Catalogue

These tags are declared by the `syw.core.runtime` builtin package and are always available
for capability `required_tags` / `excluded_tags` expressions.

| Tag | Declared by | Meaning |
|-----|-------------|---------|
| `browser` | `syw.core.runtime` | Executing in a web browser (DOM available). |
| `node` | `syw.core.runtime` | Executing in Node.js. |
| `desktop` | `syw.core.runtime` | Executing in a desktop application (Electron or similar). |
| `embedded` | `syw.core.runtime` | Executing on an embedded/microcontroller target (limited heap, no OS). |
| `server` | `syw.core.runtime` | Executing on a server-side runtime (not embedded, not browser). |
| `breakable` | `syw.core.runtime` | The execution context supports early loop exit (`break`/`continue`). |
| `loop` | `syw.core.runtime` | The execution context is inside a loop body. |
| `async` | `syw.core.runtime` | Async/await is available. |

---

## Package Tag Registration

To introduce a new tag, a package declares it in `declared_context_tags` in its manifest:

```json
"declared_context_tags": [
  {
    "id": "acme.kiosk",
    "display_name": "Acme Kiosk Runtime",
    "description": "Blueprint is executing inside an Acme kiosk application.",
    "group": "runtime"
  }
]
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | The tag identifier. Must follow naming rules above. |
| `display_name` | yes | Human-readable label shown in the designer. |
| `description` | no | Tooltip text explaining what this tag means. |
| `group` | no | UI grouping hint: `"runtime"`, `"capability"`, `"publisher"`, etc. |

A tag can only be declared by one package. If two packages declare the same tag ID,
the second package's installation is rejected with a conflict error.

---

## Runtime Context (`WafflerRuntimeContext`)

The `WafflerRuntimeContext` is a struct populated at runtime (and in the designer) that
describes the current execution environment:

```rust
pub struct WafflerRuntimeContext {
    pub active_tags: Vec<String>,
    pub target_environment: Option<TargetEnvironment>,
    pub language: Option<String>,
}
```

- `active_tags` — All tags currently applicable (derived from platform, OS, runtime flags).
- `target_environment` — The resolved `TargetEnvironment` for this execution.
- `language` — The compilation target language if this is a compiled execution.

In the designer, `WafflerRuntimeContext` is managed by the `useRuntimeContextStore` Zustand
store. The store is populated from the namespace's `ProjectTargetDefaults` and updated when
the user changes the active profile.

> **Note (frontend/designer layer only):** `ProjectTargetDefaults` is a **frontend/designer**
> construct, **not** a core `NamespaceSegment` field. Compilation targets are **out of
> waffler_core scope** (CANONICAL_DECISIONS §4 / §17.17), and the ledger **removed
> `project_target_defaults` from the core `NamespaceSegment`** (ST-2). The designer owns these
> target defaults; core neither persists nor interprets them.

### Runtime Tag Detection

Tags are derived at startup via `detect_runtime_tags()` which uses compile-time `#[cfg]`
macros to set `browser`, `desktop`, `server`, or `embedded` based on the build target.
Packages may inject additional tags at `on_init` time via the `TagRegistry` bus API.

---

## Compatibility Rule

A capability node is **compatible** with the current context when all of the following hold:

1. Every tag in `required_tags` is present in the runtime's `active_tags`.
2. No tag in `excluded_tags` is present in `active_tags`.
3. Every `required_scope_types` entry has at least one in-scope variable whose type satisfies
   it (subtype-compatible).
4. If `invocation_modes` is non-empty, the blueprint's `invocation_mode` is in the list.

Incompatible nodes are shown with a visual overlay in the designer. They can be placed but
the blueprint cannot be saved while incompatible nodes remain.

A **bridge spec** allows a capability to appear in contexts it would otherwise be excluded
from, by declaring how the runtime adapter bridges the gap:

```json
"bridge_specs": [
  {
    "target_tag": "embedded",
    "mechanism": { "Polyfill": { "module_id": "syw.embedded.polyfill" } }
  }
]
```

`BridgeMechanism` variants: `Polyfill`, `Proxy`, `Stub`, `Transpile`.

---

## TagRegistry Bus API

The `context_tags` bus service provides:

| Command | Description |
|---------|-------------|
| `context_tags:list` | List all declared tags with metadata |
| `context_tags:get` | Get a single tag declaration by ID |
| `context_tags:active` | Get currently active tags for this runtime instance |

These commands are read-only. Tag registration happens at package load time, not through
the bus.

---

## Import Name Derivation by Target Language

When a capability is compiled to a target language, the tag-based context support is used
to determine which platform-specific import path to use. The derivation convention:

| Language | Convention | Example |
|----------|------------|---------|
| TypeScript (browser) | `@syw/{domain}/{capability}` | `@syw/network/http` |
| TypeScript (Node) | `@syw-node/{domain}/{capability}` | `@syw-node/network/http` |
| Rust | `syw_{domain}::{capability}` | `syw_network::http` |
| C# | `Syw.{Domain}.{Capability}` | `Syw.Network.Http` |
| C / Embedded | `syw_{domain}_{capability}.h` | `syw_network_http.h` |

These conventions are enforced by the compiler plugin, not by waffler_core.
