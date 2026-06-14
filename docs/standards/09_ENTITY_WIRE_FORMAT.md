# Entity Wire Format Standards

**Version:** 2.0 · **Date:** 2026-04-14

This document defines the **canonical JSON wire format** for every entity exchanged over
the Waffler message bus between `waffler_core` and any consumer (web app, desktop app,
SDK, or test harness).

These rules are binding. Any portal, API, or consumer that deviates is wrong; fix the
violating code rather than adding another workaround.

---

## Core Rules

1. **One field, one meaning.** A concept (UUID, display name, technical name) appears
   exactly once on the wire. It is never mirrored at the top level AND inside `identity`.

2. **All field names are `snake_case`.** Rust serializes naturally to snake_case.
   TypeScript consumers read the exact same keys — no renaming, no camelCase aliases.
   `#[serde(rename = "camelCaseName")]` alongside a snake_case duplicate is a bug.

3. **`identity` is the single source of namespace metadata.** Every enriched entity
   response carries exactly one `identity: NamespaceSegment` object. Portals must not
   also inject `uuid`, `id`, `name`, `technical_name`, or `display_name` at the top level
   of the same response.

4. **Struct fields serialize as-is, with one conditional omission.** The Rust struct's own
   persisted fields (`id`, `uuid`, `name`, `namespace`, …) serialize directly. Portal
   enrichment must not override or duplicate any of them. The only exception: when a portal
   embeds `identity`, any top-level field whose value is already fully represented inside
   `identity` **must be removed** from the JSON before responding (e.g. Blueprint's `id`
   is removed when `identity.uuid` carries the same value). TypeScript consumers must
   reconstruct the omitted field from `identity` after deserialization.

---

## `NamespaceSegment` Wire Format

Every entity in the namespace tree is described by a `NamespaceSegment`. This type is
used both stand-alone (namespace tree API) and embedded as `identity` on entity responses.

> **Ledger authority (CANONICAL_DECISIONS §1/§2/§12/§17.19 H — ledger supersedes this standard on design):**
> the **core-persisted `.ns` column set is exactly 5 columns:** `uuid, display_name, entity_type,
> created_at, tags`. `technical_name` (folder name) and `parent_uuid` (parent directory's segment)
> are **derived from the physical directory layout on scan** and are NOT stored inside the `.ns` file.
> `primary_color`/colours is a **UI concern — NOT a core-persisted segment field** (not in `.ns`).
> `created_at` is the **only** core-persisted timestamp; `modified_at` / `created_by` / `modified_by`
> are **NOT core-required** (the full who/when audit trail is the future Journal, §22, not segment
> columns). `full_path` and `children` are **derived views** (computed by following `parent_uuid` /
> the `ChildrenIndex`), not stored `.ns` columns — they may appear on the wire as conveniences.
> The in-memory representation (`NamespaceSegment` / `SegmentManifest` on wire/in RAM) retains all
> 7 fields for operational convenience.


```json
{
  "uuid": "a245d79e-e7d5-4381-b5df-8745c0696247",
  "parent_uuid": "root",
  "technical_name": "TestBlueprint",
  "display_name": "Test Blueprint",
  "entity_type": "blueprint",
  "created_at": "2026-01-01T00:00:00Z",
  "tags": [],
  "full_path": "workspace.TestBlueprint",
  "children": []
}
```

### Field Reference

| Field | Type | Description |
|-------|------|-------------|
| `uuid` | `string` | Immutable UUID. The only stable cross-reference key. Always use this. |
| `parent_uuid` | `string \| null` | UUID of the direct parent. `"root"` for workspace-level segments; empty/null for a top-level root. |
| `technical_name` | `string` | Slug/code name. URL-safe. Used in `full_path` segments and on-disk paths. |
| `display_name` | `string` | Human-readable label shown in UIs. May contain spaces and Unicode. |
| `entity_type` | `string` | Lowercase type string: `blueprint`, `folder`, `package`, `class`, etc. |
| `created_at` | `string` | Creation timestamp (the **only** core-persisted timestamp; also encoded in the UUID v7). |
| `tags` | `string[]` | Metadata tags. |
| `full_path` | `string` | Dot-separated technical path from the tree root. **Derived** (from the `parent_uuid` chain), not a stored `.ns` column. |
| `children` | `NamespaceSegment[]` | Recursive children (populated by subtree queries). **Derived view** (via the `ChildrenIndex`), not a stored `.ns` column. |

**UI-only / NOT in `.ns` (must not be treated as a core segment field):** `primary_color` (and any colours) is a UI accent concern persisted by the UI layer, **not** a core-persisted `.ns` column (§1/§2). Likewise `modified_at` / `created_by` / `modified_by` are **NOT** core segment fields — auditing is the future Journal (§22), not per-segment columns.

### Fields That Must NOT Appear

These were emitted for backward compatibility and are removed:

| Removed field | Was a duplicate of |
|---|---|
| `id` | `uuid` |
| `name` | `display_name` |
| `technicalId` | `technical_name` |
| `technicalName` | `technical_name` |
| `displayName` | `display_name` |
| `entityType` | `entity_type` |
| `parentId` | `parent_uuid` |
| `fullPath` | `full_path` |

---

## Blueprint Wire Format

Blueprint responses come from `blueprints:get` and `blueprints:list`.

### With identity (wire transfer)

When the portal successfully resolves a `NamespaceSegment` for the blueprint, `identity`
is embedded and the top-level `id` field is **omitted** — its value is already available
as `identity.uuid`.

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
  },
  "is_enabled": false,
  "entry_node": "trigger_0",
  "nodes": {},
  "inputs": {},
  "outputs": {},
  "subroutines": {},
  "static_context": {},
  "logging_config": { "enabled": true, "log_variable_values": true },
  "tags": [],
  "dependencies": [],
  "identity": {
    "uuid": "a245d79e-e7d5-4381-b5df-8745c0696247",
    "technical_name": "TestBlueprint",
    ...
  }
}
```

The legacy `blueprint_type` string field is accepted by the deserializer for backward
compatibility but is **never written** in new blueprint documents. Treat it as write-once
migration input.

### Without identity (local storage / fallback)

When no namespace segment exists yet (e.g. the file was just created), `id` is present
and `identity` is absent. This is the canonical on-disk format inside the VFS.

```json
{
  "id": "a245d79e-e7d5-4381-b5df-8745c0696247",
  "context": {
    "invocation_mode": "OnDemand",
    "ownership": { "Independent": {} },
    "target_spec": { "environments": [], "required_tags": [], "excluded_tags": [], "strict_mode_enabled": false }
  },
  ...
}
```

### Consumer contract

TypeScript consumers **must** treat `blueprint.id` as always present. The `WebAPI`
layer reconstructs `id` from `identity.uuid` after deserialization when it was omitted
on the wire, so callers always see a populated `id` regardless of which format was sent.

Key rules:
- `id` (when present) is the Blueprint UUID — the file-system FK. When `identity` is
  present, `id` is absent from the wire but reconstructed client-side.
- `technical_name` and `display_name` **never** appear at the Blueprint top level.
  Use `identity.technical_name` and `identity.display_name`.
- `uuid` never appears as a separate top-level field — it would duplicate either `id` or
  `identity.uuid`.
- `name` never appears at the top level. The Blueprint Rust struct marks it
  `skip_serializing`; it is a runtime-only field populated from the registry.

---

## WafflerClass Wire Format

Class responses come from `classes:get` and `classes:list`.

```json
{
  "uuid": "...",
  "description": null,
  "extends": null,
  "implements": [],
  "properties": [],
  "lifecycle": {},
  "identity": { ... }
}
```

Key points:
- `uuid` is the UUID (from the WafflerClass Rust struct).
- `name` and `namespace` do **not** appear on the wire — both are skipped from serialization (`#[serde(skip_serializing)]`) as `identity` is the single source of namespace metadata. TypeScript consumers reconstruct them from `identity` if needed.
- `id` does **not** appear — it was an injected alias.

---

## WafflerType Wire Format

Type responses come from `types:get` and `types:list`.

```json
{
  "uuid": "...",
  "schema": {},
  "extends": null,
  "identity": { ... }
}
```

Key points:
- `uuid` is the UUID.
- `WafflerType` has **no `name` or `namespace` struct fields** — identity is the only
  source for the technical name, display name, and path.
- `id`, `name`, `namespace` do **not** appear — all were injected by the portal.

---

## WafflerEnum Wire Format

Enum responses come from `enums:get` and `enums:list`.

```json
{
  "uuid": "...",
  "values": [
    { "key": "red", "label": "Red", "value": "#FF0000" }
  ],
  "identity": { ... }
}
```

Key points:
- Same as WafflerClass — `name` and `namespace` do **not** appear on the wire, as both are skipped from serialization (`#[serde(skip_serializing)]`). TypeScript consumers reconstruct them from `identity` if needed.
- Each entry in `values` is an `EnumItem` with exactly `{ "key", "label", "value" }`.
  `key` is the stable code identifier, `label` is the human-readable display string,
  and `value` is the underlying JSON value (string, number, etc.). There is **no**
  `underlying_value` field.

---

## WafflerSignature Wire Format

Signature responses come from `signatures:get` and `signatures:list`.

```json
{
  "uuid": "...",
  "inputs": {},
  "outputs": {},
  "identity": { ... }
}
```

---

## WafflerInterface Wire Format

Interface responses come from `interfaces:get` and `interfaces:list`.

```json
{
  "uuid": "...",
  "methods": [],
  "identity": { ... }
}
```

---

## TypeRef Wire Format

`TypeRef` is the universal cross-entity reference for type annotations. It appears in
entity field definitions, class property lists, interface method signatures, and
`flow.set_variable` configurations.

```json
{
  "entity_uuid": "a245d79e-...",
  "entity_kind": "class",
  "generic_args": [
    {
      "parameter_name": "T",
      "bound_to": { "Concrete": { "entity_uuid": "...", "entity_kind": "type", "generic_args": [] } }
    }
  ]
}
```

### TypeRef fields

| Field | Type | Description |
|-------|------|-------------|
| `entity_uuid` | `string` | UUID of the referenced entity. The only authoritative cross-reference; there is no `entity_namespace` field. |
| `entity_kind` | `EntityKind` | `snake_case` discriminant. One of: `"type"`, `"class"`, `"interface"`, `"enum"`, `"signature"`. |
| `generic_args` | `GenericArgBinding[]` | Bindings for each generic parameter declared by the referenced entity. Empty if the entity is not generic. Each binding is `{ "parameter_name": string, "bound_to": TypeRefOrParam }`. |

### TypeRefOrParam

Used inside entity definitions where a generic parameter name (from the enclosing entity's
own generic parameters) may be passed through rather than bound to a concrete entity.

```json
{ "Concrete": { ... } }      // A TypeRef — binds to a concrete entity
{ "Param": "T" }             // Passes through generic parameter "T" from the enclosing entity
```

`TypeRefOrParam::Param` only appears in definition contexts (entity struct fields, class
property types). It never appears in a runtime scope or in a `flow.set_variable` configuration,
where all type references must be fully concrete.

### GenericParameter Wire Format

```json
{
  "name": "T",
  "constraint": null
}
```

`constraint` is an optional `TypeRef` that the type argument must satisfy (subtype check).
Currently always `null` — constraint enforcement is a future feature.

### ResolvedClassView Wire Format

Returned by `classes:resolve`. Includes fully resolved inheritance and interface chains.

```json
{
  "uuid": "...",
  "all_properties": [
    {
      "name": "name",
      "type_annotation": { "entity_uuid": "...", "entity_kind": "type", "generic_args": [] },
      "self_tagged": false,
      "declared_by": "workspace.Animals.Animal"
    }
  ],
  "implements": [
    { "entity_uuid": "...", "entity_kind": "interface", "generic_args": [] }
  ]
}
```

### ResolvedTypeView Wire Format

Returned by `types:resolve`.

```json
{
  "uuid": "...",
  "all_fields": [
    { "name": "field_name", "type_annotation": { ... }, "self_tagged": false, "declared_by": "..." }
  ]
}
```

---

## TypeScript Access Patterns

```typescript
// ── Universal: any entity with identity ──────────────────────────────────────
const displayName   = entity.identity?.display_name ?? entity.uuid;
const technicalName = entity.identity?.technical_name;
const fullPath      = entity.identity?.full_path;
const uuid          = entity.identity?.uuid ?? entity.uuid;  // same value

// ── Blueprint ─────────────────────────────────────────────────────────────────
const id            = blueprint.id;                           // UUID
const label         = blueprint.identity?.display_name ?? blueprint.id;

// ── Class / Enum / Signature / Interface ─────────────────────────────────────
const techName      = entity.identity?.technical_name ?? '';  // technical slug (entity.name omitted from wire)
const label         = entity.identity?.display_name ?? entity.uuid;
const path          = entity.identity?.full_path ?? '';       // full path (entity.namespace omitted from wire)
const uuid          = entity.uuid;

// ── Type (WafflerType — no name/namespace struct fields) ─────────────────────
const techName      = entity.identity?.technical_name ?? '';
const label         = entity.identity?.display_name ?? entity.uuid;
const path          = entity.identity?.full_path ?? '';

// ── WRONG PATTERNS (removed) ─────────────────────────────────────────────────
entity.id                     // removed from Class/Type/Enum/Sig/Interface
entity.name                   // removed (skip_serializing in Rust; use identity.technical_name)
entity.namespace              // removed (skip_serializing in Rust; use identity.full_path)
blueprint.name                // removed (skip_serializing in Rust)
entity.display_name           // was a portal-injected top-level duplicate
entity.technical_name         // was a portal-injected top-level duplicate
entity.identity?.technicalId  // removed camelCase alias
entity.identity?.displayName  // removed camelCase alias
entity.identity?.entityType   // removed camelCase alias
entity.identity?.parentId     // removed camelCase alias
entity.identity?.fullPath     // removed camelCase alias
```

---

## Portal Enrichment Pattern (Rust)

Every portal's `list` and `get` handlers must follow this pattern:

```rust
let mut val = serde_json::to_value(&entity).unwrap();
if let Some(identity) = self.tree.get_subtree(&entity.uuid_or_id).await {
    val["identity"] = serde_json::to_value(&identity).unwrap();
    // Nothing else. No uuid, id, name, technical_name, display_name copies.
}
```

---

## Rust Struct Constraints

- `NamespaceSegment` in `shared/src/namespaces.rs` must have no camelCase `#[serde(rename)]`
  fields and no `id` or `name` duplicate fields.
- Portal code in `waffler_core/src/*/portal.rs` must attach only `identity`; it must not
  inject or override any other field on the serialized entity value.
