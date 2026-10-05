# The design export (`wairon-design`)

The design export is one JSON document holding a project's whole design, resolved. It is meant
for tools that work from a design: code generators, translators to other modelling languages,
documentation sites and design diff tools. Such a tool reads the export instead of walking
`.wai/specs`.

- **Every element has a key, and every reference is a key.** A consumer never resolves a
  name itself.
- **Signatures are inlined.** A method that takes its signature from a source carries that
  source's params and returns.
- **Types are canonical.** Every type position is canonical text plus a parsed expression.
- **Narratives are flat.** Each method body is a numbered step list, its targets resolved to
  keys.

The export is a projection. It holds no information the spec tree does not, and it is never
read back into a tree.

## Getting one

| Where | How |
|---|---|
| CLI | `wairon export` prints the JSON to stdout, and nothing else. `wairon export --out design.json` writes the file and reports the path and the approval state. See [cli.md](cli.md#wairon-export---out-file). |
| Library | `const { exportDesign } = require('@wairon/cli')` (or `import` from an ES module), then `exportDesign(outPath?, approval?)`, which returns the document and writes it when `outPath` is given. The package ships TypeScript declarations for the library entry (`dist/index.d.ts`, the `types` field), so `DesignExport` and `exportDesign` are typed. |
| JSON Schema | `schemas/design-export-1.json`, shipped in the package (`require.resolve('@wairon/cli/schemas/design-export-1.json')`). It is a JSON Schema draft-07 document (it declares `$schema`) and carries no `$id`: reference it by its path in the package. It is generated from the zod schema in `src/models/design-export.ts` at build time, and a test fails if the two drift. |

The CLI decides the approval verdict first, the same way `wairon lock-check` does (not strict),
and stamps it. It also exports a tree that is not approved, stamped with its state.

## Compatibility promise

- **`format`** is always `"wairon-design"`.
- **`formatVersion`** is `MAJOR.MINOR` and is currently `1.0`.
  - **A minor version only adds.** It adds new fields, or new members of a closed set (a
    `role`, an approval state). A consumer must **ignore fields it does not know**. A 1.x
    document validates against `design-export-1.json`.
  - **A major version breaks.** It removes or renames a field, or changes what one means. Every
    major version is named in the CHANGELOG, and wairon emits one major version at a time.
- **A design change is never a format change.** Two exports of different trees in the same
  format differ only in content.
- **`generator`** is the wairon version that wrote the document. It is for diagnostics only,
  and consumers must not branch on it.

## Determinism

The same tree with the same approval verdict produces **byte-identical** JSON, whatever order the
spec files sit in on disk.

- **Object keys** are sorted (ordinal).
- **Element lists** are sorted by key: `subsystems`, `components`, `interfaces`,
  `implementations`, `types`, `dependencies` and each export table.
- **Inner lists keep their declared order**, because that order is part of the design: params,
  fields, enum values, narrative steps, lifecycle roots and `formerly`.
- **The document has no timestamp.** Equal `source.stateId`s with equal approvals mean equal
  documents, so a consumer can cache on `stateId`.
- **`source.stateId` is a content id, not the lock's gate identity.** The two are different
  digests by design, and never compare equal:
  - `source.stateId` (`sha256:<digest>`) hashes the parsed spec tree the export was read
    from, every spec the scan loads, timestamps left out and specs in id order. Snapshots and
    archives carry the same id. It changes exactly when the specs change.
  - The lock's `stateId` in `.wai/lock.json` (`sha256+content+doctrine+inputs+members:<digest>`)
    is the gate identity. It hashes this project's own specs together with the governing
    doctrine, the declared inputs, `composition` and each direct member's composition subject,
    so it also moves when a rule, an input or a member's approval moves.

  To relate an export to an approval, read `source.approval`: it is `locked` exactly when
  that lock record covers this tree.

## Keys

| Element | Key |
|---|---|
| Subsystem, component, interface, implementation | its id |
| Type | `subsystem::id` when a subsystem owns it, the bare id when it is system-level |
| Contract method | `<interface key>.<name>` |
| Type method | `<type key>.<name>` |
| Field, param, enum value | its name, within its owner |
| Narrative step | its `stepNumber`, within its method |
| Anything in another project | `alias::publicName`: the alias this project declares the project under, and the public name that project's L0 exports it as |

A type's key `subsystem::id` uses `::` as a **key separator** inside this document: its first
segment is one of this document's own `subsystems` keys. A cross-project key's first segment is
an alias from `dependencies` instead, so the two never collide. Signature text (a method's
`signature` string) keeps the spec's own spelling, which writes a subsystem-owned type as
`subsystem.id`; read the structured `params` and `returns`, not the signature text, when you
need keys.

A reference into another project is always written the way a consumer can resolve it: through
the producer's **public** export table. It is never written with the loader's internal key, so
the reference stays valid when the producer renames something behind an `as`. A reference that
binds no exported name stays as written; the validator reports it.

## The document

### Top level (`design_export`)

| Field | Meaning |
|---|---|
| `format`, `formatVersion`, `generator` | See [Compatibility promise](#compatibility-promise). |
| `source` | Which tree the document was projected from, and the approval verdict over it. |
| `project` | The L0 of the exported project. |
| `dependencies` | The other projects this project depends on. They are listed, never inlined. |
| `subsystems`, `components`, `interfaces`, `implementations`, `types` | The design itself, one list per level. |

### `source` (`design_source`)

| Field | Meaning |
|---|---|
| `projectId` | The project's effective id (its system name when it declares none). |
| `stateId` | `sha256:<digest>`, the tree's content identity. It is the cache key. |
| `approval` | `locked`, `stale`, `unlocked` or `unjudged`. |
| `approved` | `true` exactly when `approval` is `locked`. |

**What `approved` means.** It is the same verdict `wairon lock-check` and `wairon status` give:

- The committed lock record is resolved against the gate identity. That identity is the parsed
  own tree, its governing doctrine, its declared inputs, `composition`, and the approvals of its
  direct members.
- It is never a weaker per-spec digest comparison.
- `stale` means a lock exists but the tree moved since. `unlocked` means no lock was ever
  written.
- `unjudged` means an in-process caller passed no verdict. It claims nothing either way.

Validation findings are not part of the document. Run `wairon validate` for those.

### `project` (`design_project`)

`name`, `vision`, `boundaries` and `requirements` (as text), `targetLanguage`, and `exports`:
the resolved L0 export table, as `design_export_entry` rows.

### Export entries (`design_export_entry`)

| Field | Meaning |
|---|---|
| `publicName` | The name consumers use. |
| `targetKind` | `component`, `interface` or `type`. |
| `target` | The canonical target's key. Every re-export has already been followed to that target. |
| `audience`, `version`, `stability` | As declared. |

### `dependencies` (`design_dependency`)

| Field | Meaning |
|---|---|
| `alias` | The alias the project uses for the dependency. It is the prefix of every `alias::publicName` that points into it. |
| `projectId` | The dependency's project id. |
| `role` | `member` for a project this one contains (an in-tree subdirectory member, a sibling or git member, a legacy mount). `external` for a declared external. A part is not a dependency: its subsystems are this project's own. |
| `digest` | The content digest pinned in `.wai/externals.lock.yaml`, when the dependency is pinned. It is absent when it is not pinned, or when the lock cannot be read. |
| `uses` | The public names this project's references reach in the dependency, sorted. |

### `subsystems` (`design_subsystem`)

| Field | Meaning |
|---|---|
| `key`, `name`, `description`, `status`, `profile`, `targetLanguage` | As declared. |
| `lifecycle` | The lifecycle roots: `{ phase, component, method }`. These are what the runtime invokes. |
| `exports` | The resolved L1 export table. |
| `trustedLinks` | The subsystem keys this subsystem holds a trusted link to. |
| `ext` | Pack extension data. |

### `components` (`design_component`)

| Field | Meaning |
|---|---|
| `key`, `name`, `description`, `status`, `subsystem` | As declared. |
| `stereotype`, `variant`, `dependencyClass`, `durability`, `portalType` | As declared. |
| `owns`, `dependsOn` | Keys. |
| `emits`, `subscribesTo` | The topics the component publishes to and consumes from. |
| `auth`, `basePath`, `dispatch` | A Portal's authentication, base path and dispatch table. Dispatch targets are keys. |
| `mounts` | A listener's mounts. Each portal is a key. |
| `patterns`, `externalLinks` | As declared. |
| `formerly` | The rename trace. See [Renames](#renames-formerly). |
| `ext` | Pack extension data. |

### `interfaces` (`design_interface`) and methods (`design_method`)

An interface carries `key`, `component`, `name`, `description`, `status`, `methods`, `formerly`
and `ext`. Each method carries:

| Field | Meaning |
|---|---|
| `key`, `name`, `description` | As declared. |
| `params`, `returns` | Type refs. A method whose signature comes from a source has its source's params and returns inlined. |
| `signature` | The derived signature text, for display only. |
| `signatureType` | The key of the signature type the method takes its signature from, when it names one. A method source is inlined and never named here. |
| `effect`, `guarantees`, `invokedBy` | As declared. |
| `endpoint` | The endpoint as declared: `transport` plus that transport's address fields. |
| `formerly`, `ext` | The method's rename trace (its former `<interface>.<name>` keys), and pack data. |

A type's pure methods use the same shape.

### Params, fields and type refs

- **`design_param`**: `name`, `type`, `optional` and `description`. `optional` means the
  param may be left out. "May be none" is part of the type, written as `T?`.
- **`design_field`**: the same fields, plus `key` (`primary`, `unique` or `foreign`) and
  `references`, which is a type key or `<type key>.<field>`.
- **`design_type_ref`**:
  - `text` is the canonical text in the neutral type grammar.
  - `expression` is the parsed form. It is a tree of `{ form, name?, args }`, where `form` is
    `primitive`, `named`, `list`, `set`, `map`, `optional`, `union`, `async` or `applied`.
  - The `name` of every named member is the **key** of the type it names.
  - When the grammar cannot read a position, `expression` is absent. The text is then opaque:
    the export never invents a shape.

### `implementations` (`design_implementation`) and bodies (`design_method_body`)

An implementation carries:

- `key`, `contract`, `component`, `name`, `description` and `status`;
- `technologies`, by name;
- `sourcePath`, `methods`, `formerly` and `ext`.

Each method body carries:

| Field | Meaning |
|---|---|
| `method` | The contract method's key. |
| `detail` | `full`, `calls-only` or `intent`, after the stereotype default is applied. |
| `intent` | The prose that stands in for steps, at `intent` detail. |
| `calls` | The declared calls, as method keys. |
| `narrative` | The flat step list as stored. A `call`, `register` or `dispatch` step's target, and a credential source, are keys. Flow steps jump by `stepNumber`. |

### `types` (`design_type`)

A type carries:

- `key`, `kind`, `name`, `description` and `status`;
- `fields` and its pure `methods`;
- a signature type's `params` and `returns`;
- an enum's `values`, in declared order;
- a named scalar's `holds`;
- `invariants`;
- `componentClass`, a key;
- `database`, `table` and `linkedEntity`;
- `formerly` and `ext`.

## What is left out, and why

| Left out | Why |
|---|---|
| Lint allows, conformance tiers and finding declarations | They are gate configuration, not design. |
| `symbol` and `exportedVia` | They bind to this repository's code. |
| `simPath` | It names a test harness. |
| `createdAt` and `updatedAt` | They would break determinism. |
| A member project's specs | They are listed as a dependency. Export the member itself for its design. |

Pack `ext` data is passed through untouched, under each pack's own key. It is the sanctioned
extension channel.

## Executable or library: the consumer decides

The export has no `kind` that says "program" or "library". Whether a design ships as a
service, a CLI, a library or a plugin is a packaging decision. The same architecture can be
packaged in each of those ways, so wairon leaves the decision to the consumer, as it does with
deployment. The export carries the facts a consumer needs to decide for its own target:

- **Lifecycle roots** (`subsystems[].lifecycle`): what the runtime invokes, with the phase
  (`init`, `shutdown`, `cyclic`, `interrupt` or `scheduled`).
- **Endpoints and transports** (`interfaces[].methods[].endpoint`, `components[].portalType`):
  calls that arrive from outside the process. A `Custom` endpoint can be an in-process binding.
- **Listener mounts** (`components[].mounts`): which listener serves which portal.
- **The export table** (`project.exports`): what other projects link against.

For example, one generator might emit a `main` that runs the `init` roots and serves the HTTP
portals. Another might emit a library that publishes `project.exports`. Both are correct readings
of the same export.

## Renames: `formerly`

Components, interfaces, implementations and types carry `formerly`: every key they held before,
oldest first. Contract methods carry their former `<interface>.<name>` keys. The rename tools
write these traces:

| Tool | What it records |
|---|---|
| `sdd_rename_component` | The component, and its `i<id>` and `<id>_impl` |
| `sdd_rename_method` | The method |
| `sdd_move_methods` | Each method that moved |
| `sdd_rename_type` | The type |

**Retired names cannot be reused.**

- A rename tool or a create that would give a new spec an id a trace holds is refused
  (`id-retired`).
- So is a new method under a name its own contract retired (`name-retired`).
- A hand edit that reuses one is reported as `RENAME_TRACE_CONFLICT`.
- Unsetting the trace releases the name. A consumer then sees a delete plus an add.

**The consumer's algorithm.** This is how a generator keeps its user's wired code across
renames:

1. Keep the keys you generated from.
2. For a key that is now missing, first resolve its **owner** (subsystem, component, interface
   or type) through `formerly`. Then resolve the **member** by name, or through the member's own
   `formerly`.
3. A match is a rename. Anything left unmatched is a deletion. A key present now and absent
   before is an addition.
4. Traces accumulate, so this works across chains of renames, and across exports you skipped.

**A published name survives an internal rename.** When a renamed component or type backed an
export entry whose public name came from its id, the rename writes `as: <old name>` on that
entry. Consumers' pins and `alias::publicName` references keep resolving. A renamed method that
is published is reported, but not prevented: no mainstream export mechanism aliases a single
member.

**What escapes the trace.** Moving elements between projects (`wairon subsystem externalize`,
`wairon member internalize`) is a delete in one project and an add in another. No
single-project trace follows such a move. Renames made before traces existed left none behind.
