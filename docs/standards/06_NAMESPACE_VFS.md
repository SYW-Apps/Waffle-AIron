> **⚠ LEGACY / SUPERSEDED — do NOT implement from this document.**
> This describes the **pre-ledger** state of waffler_core (before the canonical design sessions). It is retained for historical reference only. **Authoritative now:** `docs/waffler_core/CANONICAL_DECISIONS.md` §1/§2/§17.2/§17.8 (design decisions) + the per-service docs under `docs/waffler_core/services/vfs/`, `docs/waffler_core/services/namespaces/`, and `docs/waffler_core/01_BOOTSTRAP_AND_VFS`. Where this file conflicts with the ledger, the ledger wins (see the ledger's "Authority order").

---

# Namespace & Virtual Filesystem Standards

**Version:** 2.0 · **Date:** 2026-04-14

The Unified Namespace Registry (VFS) is Waffler's hierarchical storage structure.
It gives every entity in the system — blueprints, schemas, packages, UI plugins,
and custom types — a stable place in a tree. This document defines how to work with
the namespace correctly.

See also `docs/2_architecture/2_IDENTITY_AND_NAMING.md` for the identity architecture.

---

## What the Namespace Is

The namespace is a tree of `RegistrySegment` nodes. Every Waffler entity lives at a
node in this tree. The tree provides:

- **Identity** — Every entity has a UUID-based `id` and a human-readable `display_name`.
- **Hierarchy** — Entities are organized into folders, packages, and workspaces.
- **Physical mapping** — Each node optionally maps to a path on disk.
- **State** — Each node carries an `EntityState` (enabled, permission groups, aliases).

---

## Entity Types

The `entity_type` field on a `RegistrySegment` determines what the node represents:

| Type | Description |
|------|-------------|
| `Folder` | A container with no runtime meaning. Groups related entities. |
| `Workspace` | The user's top-level logical container. Root-level creations go here. |
| `Package` | An installed Waffler package. |
| `Blueprint` | An executable blueprint definition. |
| `Schema` | A user-defined type definition (legacy name; see entity kinds below). |
| `UiPlugin` | A UI plugin contributed by a package. |
| *(custom)* | Any type contributed by a package via `entity_types` in its manifest. |

Custom entity types are registered by packages at load time. The VFS scanner uses them
to identify and mount package-defined entities when scanning the package's namespace folder.

### Typed Entity Kinds

Within the namespace, user-defined data model entities are stored as `RegistrySegment`
nodes with the following `entity_type` values (corresponding to the `EntityKind` enum):

| Entity kind | `entity_type` | Description |
|-------------|---------------|-------------|
| `WafflerType` | `"type"` | A structural type with named, typed fields. |
| `WafflerClass` | `"class"` | An object with properties, lifecycle, constructors, and method blueprints. |
| `WafflerInterface` | `"interface"` | A behavioral contract (method signatures) that classes may implement. |
| `WafflerEnum` | `"enum"` | A closed set of named values with underlying string/int storage. |
| `WafflerSignature` | `"signature"` | A callable function shape (inputs + outputs). |

These entity kinds are distinct from the `Schema` type used in earlier Waffler versions.
Code that uses `"schema"` as an entity type should be migrated to the specific kind.

---

## Tree Structure

```
/ (root)
└── {workspace-id}/                     ← Workspace
    ├── blueprints/
    │   ├── {blueprint-id}.json         ← Blueprint entity (Independent)
    │   └── ...
    ├── types/
    │   └── {type-id}.json              ← WafflerType entity
    ├── classes/
    │   └── {class-id}/
    │       ├── class.json              ← WafflerClass entity
    │       └── methods/
    │           └── {blueprint-id}.json ← OwnedByClass Blueprint (method)
    ├── interfaces/
    │   └── {interface-id}.json         ← WafflerInterface entity
    ├── enums/
    │   └── {enum-id}.json              ← WafflerEnum entity
    ├── signatures/
    │   └── {signature-id}.json         ← WafflerSignature entity
    └── packages/
        └── {publisher}.{domain}.{service}/  ← Package entity
            ├── package.json
            └── namespace/              ← Package's contributed entities
                └── ...
```

**Root transparency:** The namespace tree presents a transparent root. Creating an entity
"at the root" is automatically redirected to the active workspace. Client code should
not need to know the workspace ID — submit root-level creates and let the VFS handle
the redirect.

### Method Blueprint Placement

Method blueprints (owned by a class) live under the owning class node in the namespace tree:

```
classes/{class-uuid}/methods/{blueprint-uuid}.json
```

- They are **not** listed in the root `blueprints/` folder.
- `classes:list_owned_blueprints` returns the method blueprints for a given class UUID.
- Deleting a class triggers a cascade delete of all method blueprints under it. The UI
  shows a double-confirmation dialog listing all affected blueprints before deletion.

### Resolved Chain Queries

Some entities support resolved queries that traverse the inheritance/implementation chain:

| Command | Returns |
|---------|---------|
| `classes:resolve` | `ResolvedClassView` — all properties including inherited, full implements list |
| `types:resolve` | `ResolvedTypeView` — all fields including those from parent types |
| `classes:check_cycle` | `bool` — whether adding a proposed `extends` would create a cycle |
| `types:check_cycle` | `bool` — same for WafflerType inheritance |

---

## Working with the Namespace via Commands

All namespace operations are available through the `namespaces` service on the message bus.

### Fetching the Tree

```
namespaces:tree        → Full tree from root (with workspace projection)
namespaces:subtree     → Descendants of a specific node ID
```

### Creating Entities

```
namespaces:create      → Create a new node (ID is assigned by the VFS)
```

Payload fields:
- `parent_id` — ID of the parent node. Omit or set to root to place in the workspace.
- `name` — Technical/slug name (used in file system paths). Must be URL-safe.
- `display_name` — Human-facing label.
- `entity_type` — One of the types listed above, or a custom type from a package.

### Other Operations

```
namespaces:update      → Unified identity mutation: technical_name/parent_uuid/display_name/tags (supersedes `rename`; ledger §17.19 H)
namespaces:move        → Reparent a node to a different parent (sugar over `update`)
namespaces:delete      → Remove a node and its physical path (if any)
namespaces:resolve     → Resolve a technical name path to a node ID
```

---

## Physical Storage

Each `RegistrySegment` may have a `physical_path` that points to a directory or file on disk.

### Metadata Files

Each entity directory contains:
- `.ns` — Pipe-delimited metadata file: `id|parent_id|name|display_name|entity_type|created_at`
- `.state` — Compact pipe-delimited namespace state file with a strict positional contract

The VFS reads these files at startup to reconstruct the in-memory tree. Do not edit
these files manually — always go through the VFS API.

### `.state` Contract

The `.state` file is a universal namespace state file with a strict compact contract,
not a free JSON blob.

Logical contract:
- `enabled`
- `approved_group_ids`
- optional typed extension slots

Preferred optimized on-disk format:

```text
enabled_flag|approved_group_ids|typed_arg_1|typed_arg_2|typed_arg_3
```

Rules:
- Field 1: `0` or `1`
- Field 2: comma-separated approved group IDs, or empty
- Field 3+: optional typed primitive slots

Examples:

```text
1|
1|security.http,security.files
0|security.admin|s:stable|b:true|n:3
```

Typed primitive slot encodings:
- `s:value` — string
- `b:true` / `b:false` — boolean
- `n:123` / `n:3.14` — number

Interpretation rule:
- the namespace layer owns parsing and writing this format
- field 1 and 2 have universal meaning
- field 3+ may be interpreted by the owning domain for that entity type
- field 3+ must remain small, positional, and primitive-only

Strict prohibition:
- `.state` must not contain canonical domain files or large domain payloads
- `.state` must not become a free-form key/value store
- runtime-private operational data must not live in `.state`

### File Ownership Model

Not all files under an entity folder have the same owner.

#### Namespace-owned structural files

- `.ns`
- `.state`

Owned by:
- `namespaces`

#### Domain-owned canonical files

Examples:
- `blueprint.json`
- `type.json`
- `class.json`
- `interface.json`
- `enum.json`
- `signature.json`
- `package.json`
- package version manifests under `.versions/`

Owned by:
- the service for that domain

#### Entity-owned operational files

Examples:
- `.data/`
- caches
- local sqlite files
- runtime-private working files

Owned by:
- the entity/runtime principal

### Disk Synchronization

The `VfsSupervisor` runs a `DiskSyncTask` that watches for changes on disk and
synchronizes the in-memory tree. This means:
- Dropping a valid `.ns` file into the right location will register the entity.
- Deleting a `.ns` file will remove the entity from the tree.
- Package installation uses this mechanism — the installer writes the package files,
  and the VFS picks them up automatically.

---

## RegistrySegment Anatomy

```rust
pub struct RegistrySegment {
    pub id: String,                             // UUID — stable identifier
    pub parent_id: Option<String>,              // UUID of parent, None for root
    pub name: String,                           // Technical name (slug)
    pub display_name: String,                   // Human-facing label
    pub entity_type: NamespaceEntityType,       // Folder, Blueprint, Package, etc.
    pub physical_path: Option<PathBuf>,         // Optional disk path
    pub attributes: SegmentAttributes,          // Immutable creation-time metadata
    pub children: ArcSwap<HashMap<String, Arc<RegistrySegment>>>,
    pub state: ArcSwap<EntityState>,            // Runtime mutable state (hotswapped)
    pub write_lock: Mutex<()>,                  // Serializes local updates (CUD on children/state)
}

pub struct EntityState {
    pub enabled: bool,
    pub approved_group_ids: Vec<String>,        // Permission groups approved by user
    pub aliases: Vec<String>,                   // Short-name aliases for this entity
    pub preferences: serde_json::Value,         // Package/entity-specific preferences
}
```

---

## Rules for Namespace Consumers

1. **Always use the VFS API.** Never read or write `.ns` or `.state` files directly from
   business logic. Go through the `namespaces` bus commands or the `UnifiedNamespaceRegistry`
   API if you are inside waffler_core.

2. **Reference entities by UUID, not by name or path.** Technical names and display names
   can change. UUIDs do not. Store and pass UUIDs.

3. **Do not hardcode entity paths.** Paths are computed by the VFS from the hierarchy.
   If you need a physical path for an entity, ask the VFS for it.

4. **Respect the workspace boundary.** Do not create entities directly under the root.
   Always let the workspace redirect handle placement.

5. **Do not hold long-lived references to `RegistrySegment`.** The VFS can add, remove,
   or reparent nodes at any time. Hold the UUID; re-fetch the node when you need its state.

---

## Custom Entity Types (from Packages)

A package that contributes custom entity types must:

1. Declare them in `entity_types` in `package.json`:
   ```json
   "entity_types": [
     { "id": "ui_app", "display_name": "UI Application" }
   ]
   ```

2. Place entity instances in the package's `namespace/` directory with appropriate
   `.ns` files so the VFS scanner can pick them up at load time.

The VFS scanner, upon detecting a `.ns` file with an unrecognized entity type, consults
the `EntityTypeRegistry` to find which package contributed that type and routes the
mount event accordingly.
