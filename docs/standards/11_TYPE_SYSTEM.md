> **⚠ LEGACY / SUPERSEDED — do NOT implement from this document.**
> This describes the **pre-ledger** state of waffler_core (before the canonical design sessions). It is retained for historical reference only. **Authoritative now:** `docs/waffler_core/CANONICAL_DECISIONS.md` §3 (design decisions) + the per-service docs under `docs/waffler_core/services/{types,classes,enums,interfaces,signatures}/`. Where this file conflicts with the ledger, the ledger wins (see the ledger's "Authority order").

---

# Entity Type System Standards

**Version:** 1.0 · **Date:** 2026-04-14

Waffler's entity type system lets users define their own data model inside the namespace.
Five entity kinds are supported. This document is the binding standard for how these
entities are related, validated, and compiled.

See also `docs/rfcs/008-entity-type-system.md` for the full specification including design
decisions, open questions, and rationale.

---

## The Five Entity Kinds

| Kind | Bus prefix | Description |
|------|-----------|-------------|
| `WafflerType` | `types:` | A structural type with named, typed fields. Supports inheritance via `extends`. |
| `WafflerClass` | `classes:` | An object type with properties, lifecycle hooks, constructors, and method blueprints. |
| `WafflerInterface` | `interfaces:` | A behavioral contract (method signatures). Classes implement interfaces. |
| `WafflerEnum` | `enums:` | A closed set of named values with underlying string or integer storage. |
| `WafflerSignature` | `signatures:` | A callable function shape (typed inputs + typed outputs). |

Each kind has its own portal, store, and bus service in `waffler_core`.

---

## TypeRef

`TypeRef` is the universal way to reference one entity from another. It carries the target
entity's UUID, kind, and namespace path, plus any generic argument bindings.

```rust
pub struct TypeRef {
    pub entity_uuid:      String,
    pub entity_kind:      EntityKind,
    pub entity_namespace: String,
    pub generic_args:     Vec<GenericArgBinding>,
}
```

Use `TypeRef` for:
- `WafflerClass.extends` — the parent class.
- `WafflerType.extends` — the parent type.
- `WafflerInterface.extends` — a parent interface.
- `FieldDefinition.type_annotation` — the type of a field or property.
- `flow.set_variable` type annotation configuration.

Do **not** store raw UUID strings where a `TypeRef` is expected. The `entity_kind` and
`entity_namespace` fields are informational but enable offline validation and tooling
without a live bus query.

---

## TypeRefOrParam

Inside an entity's own field definitions, a type slot may either bind to a concrete entity
or pass through one of the enclosing entity's generic parameters:

```rust
pub enum TypeRefOrParam {
    Concrete(Box<TypeRef>),  // Box breaks the recursive size cycle
    Param(String),           // Name of a GenericParameter on the enclosing entity
}
```

`Param("T")` means "whatever type the caller binds to parameter `T`". It is only valid
inside entity definitions — never in runtime scope or `flow.set_variable` configs.

Example — `class Pair<A, B>` with two fields:

```json
{
  "name": "first",
  "type_annotation": { "Param": "A" }
}
```

---

## Generics

An entity declares its generic parameters as an ordered list:

```json
"generic_parameters": [
  { "name": "T", "constraint": null },
  { "name": "E", "constraint": { "entity_uuid": "...", "entity_kind": "WafflerInterface", ... } }
]
```

When referencing a generic entity in a `TypeRef`, `generic_args` must be provided:

```json
{
  "entity_uuid": "...",
  "entity_kind": "WafflerClass",
  "entity_namespace": "workspace.Optional",
  "generic_args": [
    {
      "param_name": "T",
      "binding": { "Concrete": { "entity_uuid": "...", "entity_kind": "WafflerType", ... } }
    }
  ]
}
```

### Validation rules

- At design time (loose mode): mismatches produce warnings shown in the editor.
- At save time (strict mode ON): mismatches produce errors and the save is rejected.
- At compile time: always a hard error regardless of strict mode.
- The UI picker filters the entity list to only show entities with compatible generic
  parameter counts when constructing a `TypeRef`.

---

## Class Model

### Properties

Properties on `WafflerClass` follow the `FieldDefinition` shape:

```rust
pub struct FieldDefinition {
    pub name:            String,
    pub type_annotation: Option<TypeRefOrParam>,
    pub self_tagged:     bool,
}
```

`self_tagged: true` marks the special `self` parameter on method blueprints' trigger
output. This field cannot be removed and is locked in the designer.

### Inheritance

`WafflerClass.extends` is an `Option<TypeRef>` pointing to the parent class. Resolved
properties from the parent are included in `ResolvedClassView.all_properties`.

**Circular reference prevention:** `classes:check_cycle` must be called before saving an
`extends` reference. If it would create a cycle, the save is rejected as a hard error
regardless of strict mode. The UI picker also pre-filters options to exclude cycle-creating
candidates.

### Interface Implementation

`WafflerClass.implements` is a `Vec<TypeRef>` listing the interfaces the class claims to
implement. `waffler_core` validates at save time that the class provides all required
properties and method blueprints declared by each interface:

- Loose mode: missing members produce warnings.
- Strict mode: missing members produce errors.
- Compile time: always a hard error.

The class editor auto-injects locked placeholder properties for any interface-required
members that are missing, so the user can fill them in rather than hunting for them.

### Constructors

Constructors are explicitly registered on the class — they are not auto-discovered.

```rust
pub enum ConstructorKind {
    Default,
    Named(String),
    External { module_id: String, capability_id: String },
}
```

To discover the ways to obtain an instance, call **`classes:list_producers`** (renamed from
`rescan_constructors` — Ledger §17.19 D): it lists flagged constructors, the synthesized default,
static factory methods, and (with `include_methods`) instance methods returning the class. It is a
discovery aid, not the identity authority.

Constructor identity is an **explicit `role: constructor`** flag on an owned static method blueprint
(Ledger §17.19 D — the implicit `ConstructorKind::External` return-type-match inference is **dropped**).
The platform-synthesized **default** constructor renders as a form-based input in the UI, gated by
`enable_default_constructor`; explicitly-flagged constructors register with explicit labels.

---

## Interface Model

Interfaces declare method signatures and may extend a parent interface or type:

```json
{
  "extends": { "entity_uuid": "...", "entity_kind": "WafflerInterface", ... },
  "generic_parameters": [],
  "methods": [
    { "name": "speak", "type_annotation": { "Concrete": { ... } } }
  ]
}
```

`extends` accepts `WafflerInterface`, `WafflerType`, or `WafflerClass` as the parent.
Only one parent is supported. Circular extend chains are rejected as hard errors.

---

## Enum Model

Enum values carry an `underlying_value` that is stored and compared at runtime. The
display label is for the UI only and is not stored in scope.

```json
{
  "values": [
    { "label": "Red",   "underlying_value": "red" },
    { "label": "Green", "underlying_value": "green" }
  ]
}
```

When a variable is annotated as an Enum type, the designer renders a dropdown picker.
Selecting a value stores `underlying_value` as a `Static` input value.

### Enum Built-in Functions

| Function | Category | Returns |
|----------|----------|---------|
| `getStringValue(e)` | `Enum` | The `underlying_value` of the enum instance as a string. |
| `getDisplayName(e)` | `Enum` | Best-effort: returns the string value at runtime. Full label lookup is deferred to the compiler phase (no registry access in the executor). |

---

## Signature Model

A `WafflerSignature` describes a callable shape without being tied to a specific
implementation. It is used as a type annotation for function-typed fields and variables.

```json
{
  "inputs":  { "key": "...", "type": { "kind": "Object", "fields": [ ... ] } },
  "outputs": { "key": "...", "type": { "kind": "Object", "fields": [ ... ] } }
}
```

At runtime, a Signature-typed variable holds a `FunctionRef` sentinel (see
`07_BLUEPRINT_SYSTEM.md` — FunctionRef Sentinel section). `flow.call_function` reads
the sentinel and dispatches to the referenced registered function or blueprint.

`WafflerSignature` is non-generic. Higher-order function generics (e.g. `map<A, B>`) are
a known deferred feature.

---

## Loose vs. Strict Mode

Waffler uses a three-layer model for type enforcement:

| Layer | Enforcement |
|-------|-------------|
| **Designer (design time)** | Controlled by the blueprint's `strict_mode_enabled` flag. Strict ON → errors; Strict OFF (default) → warnings only. |
| **Runtime interpreter** | Always loose. Type annotations are metadata. Mismatches are never enforced at runtime. Dynamic properties on class instances are always allowed. |
| **Compiled output** | Determined by the target language. Inherently strict languages (Rust, C#, Java) always produce hard errors. JS/TS output respects the `strict_mode_enabled` flag. |

In loose mode (the default), a blueprint with type annotation mismatches can be saved and
executed. The designer surfaces the mismatch as a warning so the user is aware.

---

## Inheritance and Validation Rules Summary

| Scenario | Loose mode | Strict mode | Compile time |
|----------|-----------|-------------|--------------|
| Generic arg count mismatch | Warning | Error | Hard error |
| Interface member missing | Warning | Error | Hard error |
| Circular `extends` chain | Hard error | Hard error | Hard error |
| `self` input missing on method | Hard error | Hard error | Hard error |
| Type annotation mismatch | Warning | Error | Depends on target |
| Dynamic property on class instance | Allowed | Allowed | Promoted to scope var |

---

## Per-Entity Compilation Table

| Entity Kind | TypeScript | Rust | C# | Java | C / Embedded |
|-------------|-----------|------|----|------|--------------|
| `WafflerType` | `interface` | `struct` | `record` | `class` | `struct` |
| `WafflerClass` | `class` | `struct + impl` | `class` | `class` | `typedef struct + fns` |
| `WafflerInterface` | `interface` | `trait` | `interface` | `interface` | `function ptr table` |
| `WafflerEnum` | `enum` (string union) | `enum` | `enum` | `enum` | `#define` constants |
| `WafflerSignature` | `type Fn = (args) => out` | `fn(...) -> ...` | `delegate` | `@FunctionalInterface` | `typedef fn_ptr` |

Full per-target mapping details are in RFC 008 §10 (per-entity compilation table).
The compiler plugin implements these mappings; they are deferred to Phase Z.

---

## Bus Commands Reference

### Types

| Command | Description |
|---------|-------------|
| `types:list` | List all WafflerType entities |
| `types:get` | Get a single WafflerType by UUID |
| `types:create` | Create a new WafflerType |
| `types:update` | Save changes to a WafflerType |
| `types:delete` | Delete a WafflerType |
| `types:resolve` | Get `ResolvedTypeView` — all fields including inherited |
| `types:check_cycle` | Check if adding an `extends` would create a cycle |

### Classes

| Command | Description |
|---------|-------------|
| `classes:list` | List all WafflerClass entities |
| `classes:get` | Get a single WafflerClass by UUID |
| `classes:create` | Create a new WafflerClass |
| `classes:update` | Save with validation |
| `classes:delete` | Delete (cascade-deletes owned method blueprints) |
| `classes:resolve` | Get `ResolvedClassView` — all properties including inherited |
| `classes:check_cycle` | Check if adding `extends` would create a cycle |
| `classes:list_producers` | Discover instance-acquisition paths (flagged constructors, synthesized default, static factories, optional instance methods) — Ledger §17.19 D, renamed from `rescan_constructors` |
| `classes:list_owned_blueprints` | List method blueprints owned by a class |

### Interfaces

| Command | Description |
|---------|-------------|
| `interfaces:list` | List all WafflerInterface entities |
| `interfaces:get` | Get a single WafflerInterface |
| `interfaces:create` | Create |
| `interfaces:update` | Save |
| `interfaces:delete` | Delete |

### Enums

| Command | Description |
|---------|-------------|
| `enums:list` | List all WafflerEnum entities |
| `enums:get` | Get a single WafflerEnum |
| `enums:create` | Create |
| `enums:update` | Save |
| `enums:delete` | Delete |

### Signatures

| Command | Description |
|---------|-------------|
| `signatures:list` | List all WafflerSignature entities |
| `signatures:get` | Get a single WafflerSignature |
| `signatures:create` | Create |
| `signatures:update` | Save |
| `signatures:delete` | Delete |
