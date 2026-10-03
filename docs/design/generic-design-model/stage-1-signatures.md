# Stage 1 — Signatures: one source, named when shared

Status: designed spec-first on `feat/signatures` (off dev `0eeab5cb`), 2026-10-03. The specs are
authored and validate with 0 errors; the warnings left are exactly the code that does not exist yet
(listed at the end). Not locked. Context: [direction.md](direction.md), stage 1.

## What this stage does

1. A contract method with structured `params` shows a signature **derived** from its name, params
   (with their `?` markers) and returns, everywhere it is shown. The writer stores the derived text;
   `doctor --fix` regenerates the stored text once for existing trees. A method without params keeps
   its prose.
2. A new type kind, **`signature`**: params + returns + description, nothing else. It is a named
   function type: inputs, one output, no inheritance.
3. A contract method may take its params and returns from **one source**, `signatureFrom`: a
   signature type, or another contract method `component.method` that its component already
   reaches through `dependsOn` or `owns`. No chains.
4. **Type methods** gain optional `params`, and the same derivation applies to them.
5. Not part of signatures: `WAIRON_QUOTA_POLICY` gives the hosted quota policy a config source,
   built the same way as `WAIRON_AUDIT_POLICY`.

## Decisions

The maintainer settled every open question on 2026-10-03; the items that were open (D3, D8, D11,
D13) say what was decided. Every other item follows from the brief or from the code.

### D1. The stored `signature` field stays, and the writer stores the derived text

Measured on wairon's own tree: 2112 contract methods, 1848 of them with `params`. For 1741 of those
(94%) the prose already equals the derived text, so the derived text is what authors were already
writing. The remaining 107 methods, across 48 interfaces, differ:

- 51 differ only in the `?` markers that optional params need.
- 56 contain real drift. `commitScoped(subpaths, message)` has its params in the opposite order to
  its `params`. Other signatures spell a display name (`TreeImportOptions`) where the param says
  `tree_import_options`, or name a literal union that the param types as `string`.

The derived text corrects every one of these.

The other option was to drop the field whenever it can be derived. I rejected it for three reasons:

- `signature` would become optional on the TypeScript type that every consumer reads, and canvas,
  producers, surfaces and four rules would each need a fallback.
- The spec file would lose its one human-readable line. That line is what a reviewer, a diff and a
  lock approval read, and the lock hashes the file itself.
- The migration would delete text instead of rewriting it, which costs the same and leaves less to
  read.

With the field kept, the migration only rewrites text. Consumers need no change. The loader also
re-derives the text in memory on every load, so a stale stored text is never *shown*. A
hand-edited file that has drifted is reported as `SIGNATURE_TEXT_STALE`, and any save fixes it.

### D2. The format of the derived text

`name(a: T, b?: U): R`. Each param is written `name: type`, in declared order, with `?` after an
optional param's name. Types appear exactly as the params write them; normalising them is stage 2.
For a signature type the text is the same without a name: `(a: T, b?: U): R`.

If the stored text opens with a generic list (`find<T>(`), the derived text keeps that list, because
nothing structured declares it yet. There are 0 such methods with params today. Stage 2 can make
type parameters structured.

### D3. The source field is named `signatureFrom`, and its grammar

The name says what the field holds: where this method's signature comes from. It reads like the
existing `auth.from` and the re-export `from`, and it covers both kinds of source. Rejected names:

- `forwardsTo` claims a behaviour, and fits only the method form.
- `sameAs` is vague.
- `inherits` implies inheritance, which signatures do not have.

The value is a single string, and the resolver reads it **both ways**:

- As a **method source**: split at the last dot. The head must be a component, looked up in the
  owning interface's namespace, local first; an `alias::component` the scan has already bound also
  counts. The tail must be a method on any contract of that component.
- As a **type reference**: matched the way every type reference is matched
  (`type_spec.matchesRef`). Only a type of kind `signature` counts.

The outcome depends on how many readings resolve:

- **Exactly one** reading resolves: that one is the source.
- **Both** resolve: `SIGNATURE_SOURCE_AMBIGUOUS` (error). The finding names both candidates and
  tells the author to qualify the reference so that only one reading matches.
- **Neither** resolves: `SIGNATURE_SOURCE_UNRESOLVED`.

*Decided by the maintainer.* This replaces my draft rule that a component head always wins. Spec
ids are not unique across kinds, so a value can name both a method and a signature type, and wairon
does not guess between them. The collision does not happen in today's tree, since type ids are
snake_case and method names camelCase. A prefixed form (`type:…`) was not needed.

### D4. A method with a source states no params or returns of its own

The two ways to break this are handled differently:

- **An authored write that states both is refused** with `SIGNATURE_SOURCE_RESTATED`. Create tools
  check this in `spec_restatement.applyTo`, and deltas check it in the `updateSpecGated` hook. The
  check looks at the method on its own and needs no knowledge of the tree.
  - A delta is merged onto the **stored** form. A sourced method carries only its source there, so
    editing its description never trips the check.
  - To adopt a source on a method that restated its signature, the delta must also unset that
    method's `params` and `returns`. The tool description says so.
- **A spec file that holds both** got there by a hand edit. The source wins at load. The validator
  reports the method only when the restated params or returns *differ* from the source's. An equal
  restatement is merely redundant, and `doctor --fix` drops it.
- **The writer always drops what a source supplies.** `method_signature.storedForm()` writes a
  sourced method with only its source. Renames, moves and a lock's status promotion all save specs
  that were loaded with resolved params, and none of them can write those params back.

### D5. Resolution happens in the loader

The work is done by a new pure Orchestrator, `signature_resolver` (`src/core/signature-sources.ts`).
The Spec Index calls it inside its scan, after every reference in the family is bound. This is the
same arrangement the Export Resolver already has.

- It answers with the resolved interfaces and types:
  - every sourced method carries its source's params and returns;
  - every params-bearing contract method and type method carries its derived text;
  - every signature type carries its derived text.
- It also answers with **facts**: one per `signatureFrom` it met, and one per stored text that
  differs from the derived text.
- It never refuses anything, and it does not judge edges. A method source that is off the design's
  edges still resolves, so consumers see its params while the rule reports the edge.
- The facts are kept on the index as `SpecIndex.signatures`. They reach the validator along the
  path export usages already take: `spec_index.signatureFacts` → `spec_loader` (1:1 forward) →
  `spec_tree_portal` → `validator_core_adapter` → `spec_validator`, and land in
  `RuleContext.signatureFacts`.
- The loaded specs are already resolved, so these facts are the only place the stored form is still
  visible. That is why the facts exist at all.

When a source is unresolved, ambiguous or chained, the method gets no params and returns `unknown`. The rule
reports it, and nothing downstream sees invented params.

### D6. `sdd_get_spec` returns the stored form, with resolved signatures beside it

Agents re-author specs from `sdd_get_spec`. If the answer carried the resolved params, the next
`sdd_define_interface` would state both the source and the params, and D4 would refuse it. So:

- the answer gives a contract's methods in stored form (`storedForm`);
- the resolved params, returns and text of each sourced method come back as a derived, read-only
  `resolvedSignatures` marker;
- the structured content keeps that marker separate from the spec, as `variantGuidance` already is.

### D7. No chains, and a source is a method or a signature type, never another kind of type

A chain is reported, not followed. When the source's own source is a signature type, the finding
names that type, because any method may name a signature type directly. This collapses most chains
in practice.

This matters for adoption. Of the 781 forwarders that restate their target exactly, **256** are
themselves the target of another forwarder: Portal → Orchestrator → Repository → Index layers. Once
one layer adopts a source, the layer above it must keep its restatement or switch to a shared
signature type.

### D8. The adoption suggestion: only on Repository facades, one NOTICE per facade contract

Measured on wairon's own tree:

| What was counted | Methods | Contracts |
|---|---|---|
| Pure forwarders (exactly one call step, or one declared call) | 1131 | — |
| …that forward along a `dependsOn`/`owns` edge to an identical signature (param names, types, optional markers, order, and returns) | **781** | **96** |
| …of which are Repository facades | 163 | 25 |

My looser count of same-name, same-shape groups (420 groups covering 1107 methods) does not match
the brief's ~235/~594. That figure presumably used a stricter grouping. The 781 above is the
precise count of methods that could legally adopt a source today.

*Decided by the maintainer: option (b).* `SIGNATURE_SOURCE_AVAILABLE` is raised only on Repository
facade methods that restate exactly the owned member method they forward to. It is one notice per
facade contract, with the restating methods as the units it covers; each unit names the
`member.method` its `signatureFrom` would hold. On wairon's tree that is about 25 notices, covering
163 methods.

The reason for the restriction:

- **A facade must forward 1:1, by doctrine** (`facade-forwarding`). Its signature *is* its member's,
  so a reference to the member is always right.
- **Other forwarders are different.** A Portal restating an Orchestrator, or a client Adapter
  restating a remote Portal, is often a public surface. Such a surface should stay deliberately
  decoupled from an internal signature, so it can change on its own schedule. wairon therefore does
  not suggest coupling them.
- Authors may still adopt a source on those methods, as long as the edge rule allows it. The
  suggestion just never asks them to.

Notices never fail the gate, and a project can switch the code off with
`rules.sddRuleSeverity: { SIGNATURE_SOURCE_AVAILABLE: off }`.

My draft pick, which was overruled, was one notice per contract across every stereotype: 96 notices
on wairon's tree. A notice on each method (781) was never on the table.

### D9. Type methods get `params`, but no `signatureFrom`

A type method reaches no component, so there is no edge for a method source to follow. A named
signature could be allowed later; it is left out for now to keep the scope small. A new
`type_method` type spec now describes the type method shape, which until now was an untyped
`object[]` on `type_spec`.

### D10. The shape of a signature type

- `TypeKindSchema` gains `signature`. `TypeSpec` gains optional `params` (the `MethodParam` shape)
  and `returns`.
- A signature type may be system-level or owned by a subsystem.
- It may also be the type of a param, which is how a callback is typed.
- `SIGNATURE_TYPE_MEMBERS` is a validate-time error. It covers:
  - a signature type carrying fields, methods, invariants, componentClass, database, table or
    linkedEntity, or missing its returns;
  - an entity or value-object carrying params or returns.
- **It is not refused at write time.** The candidate gate judges only component candidates today,
  and extending it to types would mean a type candidate path through `authoring_validator_adapter`
  and `spec_validator`. Left as a follow-up.
- `specKind()` in `src/core/specs.ts` recognises a type file by `Array.isArray(raw.fields)`. It must
  also accept `kind: signature`, or the writer must always write `fields: []`. Implementers must not
  miss this.

### D11. Approval semantics (confirmed)

The lock hashes each spec file (sha256). When a source method or signature type changes, the
*effective* contract of every method that names it changes, but those files' hashes do not.

*Confirmed by the maintainer* as the same rule types already follow:

- **Within a project.** The source's own file is hashed. Changing it makes the lock stale, and the
  re-approval that requires covers every method that names the source.
- **Across projects.** A source in another project (`alias::…`) is governed the way a type from
  that project is. Within a family, the member's own approval covers it. For an external, the
  pinned snapshot covers it: the pinned member digests move when the source changes (D13), so drift
  is reported (`EXTERNAL_DRIFTED` / `EXTERNAL_INCOMPATIBLE`).

### D12. Specs reopened to `design`

New method files are named in three implementations that were `complete`:

- `core_orchestrator_impl` → `src/core/signature-repair.ts`
- `integrity_rules_impl` → three new rule files
- `heuristic_rules_impl` → one new rule file

Under `complete`, a sourcePath that names a missing file is an error. These three are back at
`design` until the code lands. The new `signature_resolver` and its implementation are also at
`design`.

The new fact types carry no `sourcePath` yet. A type that names a missing file is an error at any
status. Wave 2 adds `sourcePath: src/core/signature-sources.ts` to them once the file exists.

### D13. Surfaces: signature types travel complete (in this PR)

*Decided by the maintainer: not deferred.*

- **Contract entries.** Snapshots are built from the loaded, resolved tree. A contract-grade
  snapshot carries every method's params inline, and never a `signatureFrom`, because a snapshot
  names no producer-internal method.
- **Signature types in the closure.** `SurfaceTypeDef` gains optional `params` and `returns`, and
  its `kind` may be `signature`.
  - The closure (`surface_projector.projectOwnSurface`, `computeTypeClosure` in
    `src/core/surfaces.ts`) follows a signature type's params and returns, as it follows a data
    type's fields.
  - Canonicalization (`canonicalReferences`) rewrites the signature's param and return types like
    any other reference.
- **Comparing types.** The surface-exchange checks compare types through the digests.
  - The type shape inside `surface_snapshot.contentDigest` and `memberDigest` (`typeShape` and
    `closureShapes` in `src/models/surface-references.ts`) includes, for a signature, its kind, its
    params' types and optionality in order (never their names, matching method shapes), and its
    returns.
  - The closure walk follows params and returns.
  - Changing a named signature therefore moves the digest of every member that names it, so
    `EXTERNAL_DRIFTED` and `EXTERNAL_INCOMPATIBLE` see the change. No new rule is needed.
- **OpenAPI** (`openapi_codec`). A function type has no JSON-Schema form, and no JSON value can
  carry a function. The codec therefore writes no invented shape:
  - On render (`toOpenApi` / `toOpenApiSet`), a signature type becomes a component with **no
    `type` constraint**, a description saying it is a function type with no JSON form, and an
    **`x-wairon-signature`** extension holding its params (name, schema or `$ref`, optional) and
    returns.
  - An operation whose param or return is typed by a signature still documents that value, because
    the codec does not hide the contract.
  - On import (`fromOpenApi`), a component carrying `x-wairon-signature` decodes back into a
    signature type, so a document wairon rendered round-trips. Generic OpenAPI tools ignore the
    extension.
  - I rejected omitting the type, which leaves a dangling `$ref`, and `not: {}`, which claims no
    value is valid. Neither is honest.

### D14. `WAIRON_QUOTA_POLICY`

It works the same way as `WAIRON_AUDIT_POLICY`:

- **Input.** A partial JSON object laid over the disabled default. It may set:
  - `enabled` (boolean);
  - `mode` (`observe` | `warn` | `block`; `block` is accepted and still downgraded to an
    observation, as `evaluateQuota` does today);
  - the non-negative integer limits `maxProjectsPerUser`, `maxMcpRequestsPerMinute`,
    `maxProjectBytes` and `maxAuditEventsPerDay`.
- **Refused at startup.** Invalid JSON, a non-object, an unknown field or a wrong type each stop
  the server, with a message that names the variable.
- **Where it is modelled.** In the same places as the audit policy: the description of
  `host_config.quotaPolicy`, and a new type method `host_config.effectiveQuotaPolicy()` (in
  `src/server/operations.ts`), which replaces the private `resolveQuotaPolicy`. Step 8 of
  `operations_orchestrator_impl.evaluateQuota` now names it.
- **Code changes.**
  - `HostConfig.quotaPolicy` becomes `Partial<ResourceQuotaPolicy>`.
  - `resolveHostConfig` in `src/commands/host.ts` calls the new `parseQuotaPolicyEnv`, which
    mirrors `parseAuditPolicyEnv` and its `AUDIT_POLICY_FIELDS` table.
  - `docs/cli.md` lists the variable.

## Finding codes

| Code | Severity | Rule | Raised when |
|---|---|---|---|
| `SIGNATURE_SOURCE_UNRESOLVED` | error | integrity `signature-sources` | Neither reading of a `signatureFrom` finds a contract method or a signature type (a type of another kind is named in the message) |
| `SIGNATURE_SOURCE_AMBIGUOUS` | error | integrity `signature-sources` | The value resolves both as a contract method and as a signature type; names both candidates and asks the author to qualify |
| `SIGNATURE_SOURCE_CHAINED` | error | integrity `signature-sources` | The source itself names a `signatureFrom`; the finding names the source's own source |
| `SIGNATURE_SOURCE_OFF_EDGE` | error | integrity `signature-sources` | A method source's component is in neither `dependsOn` nor `owns` of the method's component |
| `SIGNATURE_SOURCE_RESTATED` | error | integrity `signature-sources`, and refused at write by the authoring seam | A spec file holds a source plus *different* params or returns. At write time: any source stated beside params or returns |
| `SIGNATURE_TEXT_STALE` | warning | integrity `signature-text` | A stored text differs from the text its params derive, on contract and type methods alike; `doctor --fix` repairs it |
| `SIGNATURE_TYPE_MEMBERS` | error | integrity `signature-types` | A signature type has a member it cannot have or lacks returns, or a data type carries params or returns |
| `SIGNATURE_SOURCE_AVAILABLE` | notice | heuristic `signature-source-suggestions` | A Repository facade's methods restate exactly the owned member method they forward to, where adopting it is legal (D8); one per facade contract, covering those methods |

These rules are registered in `rule_registry.registerBuiltinRules`:

- the three integrity rules right after `signature-type-references`;
- the suggestion right after `method-cohesion`.

Two existing rules change:

- `signature-type-references` skips sourced methods, because their params are judged where the
  source declares them. It now also judges type methods with params and the params and returns of
  signature types.
- `unused-types` counts a `signatureFrom` as a use of the signature type it names.

## Migration

`wairon doctor --fix` gains a mechanical repair, `core_orchestrator.repairSignatures(apply)`, which
is reached through `spec_maintenance_portal` → `cli_core_adapter` → `runDoctor`.

- **Fix order.** The repair runs right after the foreign-step-field repair and before the chaining
  migration. It touches one project, is idempotent, and stays outside the family transaction.
- **Report mode.** Without `--fix`, plain `wairon doctor` plans the repair and lists each interface
  or type it would rewrite.
- **What it does.**
  - It reads `spec_loader.signatureFacts()`. For every interface or type with a stale text, or with
    an equal restatement on a sourced method, it re-saves the loaded spec.
  - The writer's stored form produces the derived text and drops the restatement, so the repair
    writes exactly what any later save would.
  - A *differing* restatement is never repaired: only its author knows which contract was meant.
    `SIGNATURE_SOURCE_RESTATED` keeps reporting it.
- **Effect on wairon's tree.**
  - 107 methods in 48 interfaces get their text rewritten.
  - No type method has params today, so no type spec changes.
  - The 48 rewritten interfaces make the lock stale, so a re-lock follows (`wairon lock`, run by the
    human).
  - After an applied run the plan is empty, which is the idempotence check.

## How a rename carries references

Every operation that moves an identity walks one reference-field table, in `src/core/specs.ts`
(`rewriteSpecRefs`, plus the loader-side `mapSpecReferences` / `rawReferences` /
`bareRawReferences` / `respellStoredReferences` and the writer's relativize). **`signatureFrom`
joins that table** as a new position on an interface method.

- **How the table reads it.** The value is read as a `component.method` pair, through the existing
  `rewritePair` logic, and also as a `type` position. A remap acts only on what it matches, so a
  component rename rewrites the head, a method rename rewrites the tail, and a type migration
  rewrites a type reference.
- **Binding on load and write.** The loader binds the head as a component (local first, then
  `alias::`) and keeps a type reference raw, as every type reference is kept. The writer
  relativizes it as the exact inverse.
- **`renameMethod`.** Every `signatureFrom` naming `component.oldName` is retargeted. The renamed
  method's own text is re-derived by the writer, so `renameInSignature` now applies only to prose
  methods.
- **`renameComponent`.** The head of every `signatureFrom` naming the component is rewritten.
- **`moveMethods`.** A `signatureFrom` naming a moved method is retargeted to the method's new
  home. A moved method keeps its own `signatureFrom`. If its new component no longer reaches the
  source, the validator reports `SIGNATURE_SOURCE_OFF_EDGE`.
- **Types.** There is no rename tool for types today. The `type` position covers the migrations that
  respell type references (qualification and relativization).

## How each consumer sees resolved params

| Consumer | What it reads | Change needed |
|---|---|---|
| Validator rules: param-conformance against code, untyped-seams, technology-boundaries, call conformance, OpenAPI codec | Loaded index, already resolved | None. A sourced method is checked against its *own* code with its source's params |
| `signature-type-references` | Loaded index | Skips sourced methods; adds type method params and signature types |
| Canvas (`src/core/canvas.ts`, `web/src/canvas/engine.ts`) | Loaded index; `m.signature` is derived | Show "from X" next to a sourced method; draw a signature type with its text instead of a field list |
| Briefs (`composeAgentBrief`) | Do not render signatures; agents read specs through `sdd_get_spec` | None in the brief. `sdd_get_spec` follows D6 |
| `sdd_get_spec` | Loader | Stored form plus a `resolvedSignatures` marker (D6) |
| Producers (`src/producers/projection.ts`, Notion, Miro) | Loaded index; `m.signature` | A "from X" note; a section for signature types |
| Surfaces and snapshots (`src/core/surfaces.ts`, `src/models/surface-references.ts`) | Loaded index | Params arrive resolved inline. Signature types enter the closure complete, and the canonical form and digests cover their params and returns (D13) |
| OpenAPI codec (`src/core/openapi.ts`) | Snapshot | A signature type renders as a component with no `type` constraint plus `x-wairon-signature`, and decodes back from it (D13) |
| Web Specs editor (`web/src/views/SpecsEditor.tsx`) | Its own read and write | Signature field read-only when params exist; a `signatureFrom` field. Not modelled at this granularity in the specs |

## MCP tools and the re-authoring seam

- **`sdd_define_interface`.** A method item gains `signatureFrom`. `signature` becomes optional: it
  is derived when params are given, and required only for a prose method. `returns` becomes optional
  when `signatureFrom` is set.
- **`sdd_add_type`.** `kind` gains `signature`; there are new top-level `params` and `returns`; a
  method item gains `params`, and its `signature` becomes optional when params are given.
- **`sdd_update_spec`.** The delta is open below its top level, so it needs no schema change. Its
  behaviour changes as D4 describes.
- **`sdd_get_spec`.** Follows D6.
- **`tests/mcp/schema-field-coverage.test.ts`.** The new canonical fields (`MethodSignatureSchema`
  `signatureFrom`; `TypeSpecSchema` `params` and `returns`; `TypeMethodSchema` `params`) are all
  **expressed** by the create tools. None of them is update_spec-only, and none needs an entry in
  `UPDATE_SPEC_ONLY`.

On the zod side, the shape **stored on disk** differs from the **resolved** shape that consumers
type against:

- On disk, `signature` is optional when params or a source is present, and `returns` is optional
  when a source is present. A `superRefine` enforces the remaining requirements.
- The resolved `MethodSignature` type that consumers use keeps `signature: string` and
  `returns: string`, because the loader always fills both.
- The writer parses `storedForm(...)`. The round-trip dry run (`dryRunSerializeSpecs`) goes through
  the same writer pipeline, so it stays truthful.

## Specs touched

**New:**

- component `signature_resolver`, its contract `isignature_resolver` (`resolveTree`) and
  `signature_resolver_impl`, all at `design`;
- types `type_method`, `signature_source_fact`, `stale_signature_text`, `signature_facts`,
  `signature_resolution` and `signature_text_repair`.

**Changed:**

- **Types:** `method_signature` (new field `signatureFrom`; descriptions of signature, params and
  returns; methods `derivedSignature` and `storedForm`), `type_spec` (kind; fields `params` and
  `returns`; `methods: TypeMethod[]`; `derivedSignature`), `spec_index` (`signatures`),
  `rule_context` (`signatureFacts`), `spec_restatement` (`applyTo` refusal and notice), and
  `host_config` (quota description, `effectiveQuotaPolicy`), `surface_type_def` (kind `signature`;
  fields `params` and `returns`), and `surface_snapshot` (the `contentDigest` and `memberDigest`
  descriptions). `signature_source_fact` also gains `candidates` and the `ambiguous` outcome.
- **Components:** `spec_index` (dependsOn adds `signature_resolver`; description) and
  `spec_registry` (description).
- **Interfaces:** `ispec_index`, `ispec_loader`, `ispec_tree_portal` and `ivalidator_core_adapter`
  (each `+signatureFacts`); `icore_orchestrator` (`+repairSignatures`, and the renameMethod,
  renameComponent, moveMethods and updateSpec descriptions); `ispec_maintenance_portal` and
  `icli_core_adapter` (each `+repairSignatures`); `iintegrity_rules` (`+signatureSources`,
  `+signatureText`, `+signatureTypes`, and the signatureTypeReferences description);
  `iheuristic_rules` (`+signatureSourceSuggestions`); `iwiring_rules` (unusedTypes description);
  `iauthoring_orchestrator` (writeSpec); `imcp_portal` (sdd_define_interface, sdd_add_type,
  sdd_get_spec, sdd_update_spec); `imcp_orchestrator` (defineInterface, getSpec, addType);
  `ispec_canvas` (build); `isurface_projector` (projectOwnSurface); and `iopenapi_codec`
  (toOpenApi, fromOpenApi, toOpenApiSet).
- **Implementations:**
  - `spec_index_impl`: a scan step that calls `signature_resolver.resolveTree`, and
    `signatureFacts`.
  - `spec_loader_impl`, `spec_tree_portal_impl` and `validator_core_adapter_impl`:
    `signatureFacts`.
  - `spec_validator_impl`: reads the facts before building the context.
  - `spec_registry_impl`: a stored-form step in `saveInterfaceSpec`, and the `save` description.
  - `core_orchestrator_impl`: `repairSignatures`, and reopened to design.
  - `spec_maintenance_portal_impl` and `cli_core_adapter_impl`: `repairSignatures`.
  - `cli_runner_impl`: fix and report steps in `runDoctor`.
  - `integrity_rules_impl`: three rules, and reopened to design.
  - `heuristic_rules_impl`: one rule, and reopened to design.
  - `rule_registry_impl`: four register steps.
  - `authoring_orchestrator_impl`: the writeSpec refusal and the update hook.
  - `operations_orchestrator_impl`: `evaluateQuota` step 8.
  - `surface_projector_impl`: `projectOwnSurface` step 9 (the closure through signature types).

## Validate state at hand-off

`sdd_validate_tree`: **0 errors, 27 warnings, 0 notices**. Every warning is code that does not exist
yet:

- `MISSING_SOURCE_FILE` (6, in draft context): `signature-sources.ts`, `signature-repair.ts`, and
  the four new rule files.
- `UNREALIZED_METHOD` (6): `signatureFacts` on index, loader, tree portal and validator adapter;
  `repairSignatures` on the maintenance portal and the CLI adapter.
- `CALL_STEP_UNREALIZED` (3): `listProjectRoots` → `resolveTree`, `validateProject` →
  `signatureFacts`, and `runDoctor` → `repairSignatures` (×2).
- `UNREALIZED_TYPE_METHOD` (5): `effectiveQuotaPolicy`, `derivedSignature` (×3) and `storedForm`.
- `UNREALIZED_TYPE_FIELD` (6): `method_signature.signatureFrom`, `rule_context.signatureFacts`,
  `spec_index.signatures`, `type_method.params`, `type_spec.params`/`returns`, and
  `surface_type_def.params`/`returns`.
- `DRAFT_COMPONENT_WARNING` (1): `signature_resolver`.

## Implementation waves

Each wave ends green: tests pass, `wairon validate` shows no new errors, and the warnings that wave
was meant to remove are gone. Wave 7 is independent and can run first or in parallel.

1. **Model and derivation.** `src/models/specs.ts`:
   - schemas: `signatureFrom`; `TypeKind` `signature`; `TypeSpec` `params`/`returns`; `TypeMethod`
     `params`; the stored and resolved method types with their `superRefine`;
   - functions: `deriveMethodSignature`, `deriveTypeSignature`, `storedMethodSignature`;
   - `src/models/type-references.ts`: type-method params feed type refs; the signature type's
     params and returns.

   Unit tests for the format, the generic-list carry-over and the optional markers.
2. **Loader and writer.**
   - New `src/core/signature-sources.ts`: the resolver and the fact types; then add their
     `sourcePath`s to the type specs.
   - `src/core/specs.ts`:
     - the scan calls `resolveTree` after imports are bound; `SpecIndex.signatures`;
     - `signatureFacts` on the workspace, index and loader exports;
     - `signatureFrom` in the reference-field table (all of its readers and writers, listed under
       renames above);
     - `specKind` accepts signature types;
     - the writer's `prepareInterfaceForWrite` and `prepareTypeForWrite` apply the stored form;
     - `updateSpec` merges onto the stored form.
   - `src/core/index.ts`: `spec_tree_portal.signatureFacts`.
   - Tests: id-space round-trip and fix-point fuzz with sourced methods; a cross-project
     `alias::component.method`.
3. **Authoring seam and MCP.**
   - `src/core/authoring.ts`: the `applyRestatement` refusal and notice; the `updateSpecGated` hook.
   - `src/mcp/server.ts`: tool input schemas; `sdd_get_spec` stored form plus `resolvedSignatures`.
   - `tests/mcp/schema-field-coverage.test.ts`; e2e journeys covering an adoption delta with unset.
4. **Rules.**
   - `src/core/rules/integrity/signature-sources.ts`, `signature-text.ts` and `signature-types.ts`;
     `src/core/rules/heuristic/signature-source-suggestions.ts`.
   - `RuleContext.signatureFacts` in `src/core/rules/types.ts`; `src/core/validation.ts` and
     `src/core/adapters/validator-core.ts` read the facts.
   - Register the rules in `src/core/rules/repository.ts`, in the order listed above.
   - Edit `signature-type-references.ts` and `unused-types.ts`.
   - Rules-matrix fixtures for each new code (one that fires and one control, for the ratchet), and
     the rule catalog.
5. **Doctor and renames.**
   - New `src/core/signature-repair.ts`; the export in `src/core/index.ts`;
     `src/commands/adapters/core.ts`; `src/commands/doctor.ts` (the fix step after the foreign-field
     repair, and the report step).
   - `src/core/provision.ts`: `renameMethod` leans on the writer for params methods; tests that
     `renameMethod`, `renameComponent` and `moveMethods` carry `signatureFrom`.
   - Then run `doctor --fix` on wairon's own tree. Expect 107 methods in 48 interfaces to be
     rewritten and `SIGNATURE_TEXT_STALE` to reach 0. Review the 56 drift cases in the diff:
     `commitScoped` shows that some of them were wrong prose.
6. **Consumers.**
   - `src/core/canvas.ts` and `web/src/canvas/engine.ts`: the source badge and the signature type
     node.
   - `src/producers/projection.ts`.
   - `web/src/views/SpecsEditor.tsx`.
   - Surfaces:
     - `SurfaceTypeDefSchema` gains `params` and `returns` (in `src/models/specs.ts`);
     - `computeTypeClosure` and `canonicalReferences` in `src/core/surfaces.ts`;
     - `typeShape` and `closureShapes` in `src/models/surface-references.ts`;
     - tests: a snapshot never carries `signatureFrom`; a signature type travels complete; changing
       a signature moves `memberDigest`.
   - `src/core/openapi.ts`: render `x-wairon-signature` with no `type` constraint, and decode it
     back; a round-trip test.
7. **Quota (independent).**
   - `src/commands/host.ts`: `parseQuotaPolicyEnv` and `QUOTA_POLICY_FIELDS`.
   - `src/server/types.ts`: `quotaPolicy?: Partial<ResourceQuotaPolicy>`.
   - `src/server/operations.ts`: export `effectiveQuotaPolicy(cfg)`, replacing
     `resolveQuotaPolicy`.
   - `tests/commands/host-quota-policy.test.ts`, mirroring `host-audit-policy.test.ts`; the
     operations tests.
   - `docs/cli.md`; the CHANGELOG.

Close-out:

- Promote `signature_resolver` and its implementation, and the three reopened implementations, back
  to `complete`.
- Validate to 0 errors and 0 warnings. Notices follow D8.
- Then the human runs `wairon lock`. Lock on the branch, and commit the lock record before the merge.
