# Stage 2 — A neutral type grammar, and an enum kind

Status: designed spec-first on `feat/type-grammar` (off dev `c892910c`), 2026-10-04. The maintainer
settled M1–M3 as recommended (section 6). The specs are authored and validate with 0 errors; the
warnings left are exactly the code that does not exist yet (listed under "Validate state"). No code,
no migration run, not locked. Context: [direction.md](direction.md), stage 2; it builds on
[stage-1-signatures.md](stage-1-signatures.md) (derived signature text, signature types).

**Revised 2026-10-05 (release readiness), decided by the maintainer** — see "M4–M6" in section 6:
the grammar gains `result<T, E>` and `()` as void; every type-expression code is a warning on load
(still refused at write); and the doctor proposes an enum for a string-literal union.

## What this stage does

1. Every **type position** gets one small, language-neutral grammar: a param's `type`, a method's
   `returns`, a field's `type`, a type method's params and returns, and a signature type's params
   and returns. Today these are free strings that are tokenized, never parsed.
2. Today's TypeScript-flavoured spellings (`string[]`, `Promise<X>`, `X | null`, `Record<K, V>`,
   `boolean`, …) stay **accepted as input** and are **normalised** to the canonical spelling.
3. A new type kind, **`enum`**: a closed, ordered set of named values, joining entity,
   value-object and signature.
4. The grammar replaces the tokenizer in every consumer (references, ERD multiplicity, OpenAPI,
   surface digests, param conformance), and the TypeScript reading of the same grammar is what code
   conformance compares against.

Three questions went to the maintainer (M1–M3, section 6) and were decided as recommended.
Everything else is decided below, with the measurement it rests on. The spec model that realizes it
is in section 7, and the implementation waves in section 8.

## Measurements

Scripts parsed every type position in wairon's own tree (`.wai/specs`: 1309 files, 295 interfaces,
411 types), the example tree under `examples/wrapper/demo-project`, and the type strings in the test
fixtures. "Occurrences" counts positions; "distinct" counts different strings.

### Where type expressions live

| Position | Occurrences |
|---|---|
| Contract method params (structured) | 2744 |
| Contract method returns | 1963 |
| Type fields | 2318 |
| Type method returns | 154 |
| Params inside prose signatures (methods without structured params): contract / type methods | 241 / 117 |
| Signature types (params + returns) | 0 (the kind is new) |
| **Total** | **7537** (596 distinct) |

The example tree holds 16 occurrences (`string`, `void`, `boolean`, one named type). The test
fixtures hold 118 distinct strings, synthetic by design (`Promise<order>`, `u64`, `Result<Ack>`,
`Map<string,  billing::Invoice | null>`, `shared::index-value`).

**Parseability.** A TypeScript-like recursive-descent parser reads 7536 of the 7537. The one
failure is an intersection (`MigrationCommandOptions & { id?: string }`) inside a prose signature.
There is no trailing prose, comment or aside in any type position. The tokenizer's prose-stripping
is defensive code that this tree never needs, so a strict parser costs nothing here.

### By category

| Category | Occurrences | Distinct | Notes |
|---|---|---|---|
| Bare primitive | 4500 | 9 | `string` 3372, `boolean` 472, `void` 456, `number` 118, `bytes` 40, `object` 20, `json` 9, `i32` 9, `unknown` 4 |
| Bare named type | ~1430 | ~270 | none qualified with `::` or `.` in this tree |
| Array `T[]` | 1101 | 198 | returns 383, params 202, fields 478, type-method returns 35; nested (`string[][]`) 1 |
| `T \| null` | 288 | 57 | 183 on returns, 84 on params, 10 on type-method returns, 8 on fields |
| `T \| undefined` | 29 | 13 | 17 on type-method returns |
| `A \| B \| null`, `T \| null \| undefined` | 8 | 3 | |
| `Promise<T>` | 58 | 1 | always `Promise<void>`, always a return, in 4 interfaces |
| `Set<T>` | 41 | 3 | |
| `Map<K, V>` / `Record<K, V>` | 24 / 24 | 12 / 12 | **every key is `string`**; nested maps 3 |
| `object` / `unknown` / `json`, `Json` | 56 / 5 / 25 | | 36 of the `object` uses are `object[]` fields on meta types |
| Union of types (no null) | 20 | 6 | 12 are named types only (a union of six spec kinds); 8 mix in a primitive (`PackSelection \| string` ×4, `boolean \| number` ×2, `(string \| number)[]`, a map value) |
| Inline object shape | 23 | 22 | all inside prose signatures of 2 interfaces (CLI option bags); none in a structured position |
| Function type | 12 | 4 | 5 in prose signatures, 7 fields on one type |
| String-literal union | 1 | 1 | `'global' \| 'local'` |
| `Partial` / `Pick` / `Omit` / `Array<>` / tuples / declared type parameters | 0 | | |
| `date` / `datetime` / `duration` | 0 | | 69 `string` fields are named `*At` or `timestamp` |

Four further measurements decide specific questions below.

- **Optional versus null.**
  - The `optional` flag is set on 898 fields and 423 params.
  - The flag is combined with `| null` 4 times and with `| undefined` 5 times.
  - `| null` lives where no flag exists: returns, which say "none found".
- **`number`.** 122 positions use it. Read by their names, nearly all are integers: counts, sizes,
  limits, step numbers, ports, days, minutes. About six may be fractional: `x`, `y`, `w`, `h`,
  `score` and `maxCompressionRatio`.
- **Async.** A regex pass located the realizing TypeScript function for 1449 contract methods.
  - 120 of those functions are `async`.
  - The spec says `Promise<…>` for 58 of the 120, and every one of the 58 is async in the code.
  - **62 async methods are not marked in the spec.** The spec has never had a reason to say it.
- **Enums.**
  - In type positions there is one literal union. In descriptions, about 45 of the 3288
    `string`-typed fields and params list their closed set of values in prose, such as
    `"active" or "disabled"` or `` `claude` or `gemini` ``.
  - One type, `update_channel`, is an enum written as a fieldless value-object with methods.
  - The code behind the tree has 33 string-literal union aliases, 80 `z.enum([...])` schemas and
    no TypeScript `enum`.

### What normalisation would rewrite

A simulation canonicalised every structured position, using the rules proposed below. Of the 7179
structured positions, **2068 (29%) change, in 508 files**:

- `T[]` → `list<T>`: 1100
- `boolean` → `bool`: 471
- `T | null` → `T?`: 289
- `object`, `json`, `Json`, `unknown` → `any`: 82
- `Promise<T>` → `async T`: 58
- `Set` → `set`: 36
- `T | undefined` → `T?`: 29
- `Map` → `map`: 25
- `Record` → `map`: 24
- `i32` → `int`: 9

Three more groups cannot be rewritten mechanically:

- 122 `number` positions are not an alias (M2): an author picks int or float, and the repair
  proposes int where the name plainly says an integer.
- 8 positions need an author: 7 function types and 1 literal union.
- Unions of named types (12) are kept as they are; the 8 unions mixing in a primitive need an author
  (M3).

## Consumers of type strings today

| Consumer | What it does with the string | Effect of the grammar |
|---|---|---|
| `src/models/type-references.ts`: `extractTypeIdentifiers`, `methodTypeRefs`, `fieldTypeRefs`, `signatureTypeRefs`, `BUILTIN_TYPES` | Tokenizes: every identifier is a reference, and the operators are separators. Strips comments, trailing prose and literals. A 70-word builtin vocabulary mixes TS, Rust, Python and wairon (`mcpserver`) | Replaced by a parser and a typed expression. References are the named types in the tree. The builtin set becomes the primitive set plus the alias table |
| Reference rules: `field-type-references`, `signature-type-references`, `type-declarations`, `unused-types`; `part-context`; the loader's `rawReferences` and family | Read references through the tokenizer | Same questions, now read from the parsed expression |
| Canvas ERD (`src/core/canvas.ts`, `MANY_SHAPE`) | Multiplicity by regex: `[]`, `Array<`, `Vec<`, `Set<`, `List<`, `Map<`, `Record<`, `HashMap<` | `list`, `set` and `map` mean many; `T?` or an `optional` field means 0..1. No regex |
| `untyped-seams` (`UNTYPED_SEAM`) | `json`, `any`, `unknown` or `object` on a public seam | After normalisation only `any` remains to look for |
| `signature-language-builtins` (`LANGUAGE_FOREIGN_BUILTIN`) and the pack field `foreignBuiltins` | Pushes contracts **towards** the target language's spellings | The opposite of this stage; retired (see below) |
| OpenAPI codec (`src/core/openapi.ts`, `schemaFor` / `typeRefFromSchema`) | Unwraps `Promise<>`, handles `T[]`, maps a small primitive table. **Everything else becomes `{type: object, description: "Unresolved type: …"}`**: every `T \| null`, `Map`, `Set`, `bytes` and union. `date` maps to `date-time` | Driven by the expression (table below). A real fix, not just a port |
| Surface digests (`canonicalTypeRef`, `typeShape`, `closureShapes` in `src/models/surface-references.ts`) | Re-spells identifiers inside the text; punctuation is kept as written | The digest hashes the canonical expression. Consequence: pinned externals see drift once (see Migration) |
| `param-conformance` (`PARAM_NAME_MISMATCH`) | `typeAgrees`: the spec's type string equals the code's annotation text after whitespace normalisation, or the type id maps to its code name | Compares the canonical spec type with the code annotation **read through the TypeScript dialect** (see Code conformance) |
| `type-shape`, `type-realization` | Compare field names and optionality only, never types. A union alias is skipped | Unchanged for data types. The enum kind adds a value comparison |
| Stage-1 derived signature text (`deriveMethodSignature`) | Writes `p.type` verbatim | Shows the canonical spelling: `listProjects(credential: string): list<HostedProjectRecord>` |
| Briefs (`composeAgentBrief`), producers, the web Specs editor | Show text or pass it through | Text only. Implementer briefs gain the type mapping for their language (see Code conformance) |
| MCP tool descriptions (`src/mcp/server.ts`) and the `sdd-architect` skill (`signature: "save_invoice(invoice: Invoice): Promise<void>"`) | Teach the TypeScript spelling | Teach the canonical spelling. Aliases still work |

## 1. The grammar

### Surface syntax

```
type-position = [ "async" ] type ;            (* "async" only at the top of a returns *)
type          = member { "|" member } ;
member        = primary [ "?" ] ;
primary       = name [ "<" type { "," type } ">" ]
              | "(" type ")"
              | "(" ")" ;                       (* the unit type: another spelling of void *)
name          = ident { ( "::" | "." ) ident } ;
ident         = letter { letter | digit | "_" | "-" } ;
```

`result<T, E>` is written with the generic syntax (`name "<" type "," type ">"`): it is a generic
form of the grammar, like `list<T>` and `map<K, V>`, not a user generic.

Whitespace is free. A position is read as a whole: anything left over after the grammar finishes is
`TYPE_EXPRESSION_INVALID`, so no trailing prose, comments or asides are allowed. The 0 occurrences
above say nothing relies on them, and a description field already exists for prose.

### Canonical form, and what each part means

| Form | Meaning | Canonical spelling |
|---|---|---|
| Primitive | one of the ten below | lower-case name |
| Named type | an entity, value-object, enum or signature type, local or `alias::name` | as today: matched by `type_spec.matchesRef` |
| `list<T>` | ordered, duplicates allowed | `list<T>` |
| `set<T>` | unordered, unique | `set<T>` |
| `map<K, V>` | keyed lookup; **K is `string`, `int` or an enum** | `map<K, V>` |
| `T?` | T, or no value | `?` after the member; a union with none becomes `(A \| B)?` |
| `A \| B` | exactly one of the named types (rules below) | members in written order |
| `async T` | the call completes later with T; returns only | `async T`, `async void` |
| `result<T, E>` | the call completes with T or fails with E; a whole returns, or under its `async` | `result<T, E>`, `async result<void, E>` |
| A user generic `Page<T>` | a named type applied to arguments | as today. Declaring type parameters stays in the type's name, which is unchanged |

**Primitives:** `string`, `int`, `float`, `bool`, `bytes`, `date`, `datetime`, `duration`, `void`,
`any`. These are direction.md's set, unchanged. Each one exists in every mainstream language, either
as a core type or in the standard library:

- `date` is a calendar day.
- `datetime` is an instant.
- `duration` is an elapsed time.
- `bytes` is binary data.

Integer width (`i32`, `u64`) is not a design fact (languages disagree: Python has one unbounded
`int`) and is left to L4.

`uuid` and `decimal`, which today's vocabulary accepts, stay out of the core set. Mainstream standard
libraries do not agree on either: JavaScript, Go and Rust have neither in their standard library. A
project that needs one models it as a named value-object (`money`, `order_id`), which also carries
its own meaning. Neither appears in this tree.

**Position rules** (all `TYPE_POSITION_INVALID`, error):

- `void` only as a whole returns (`void` or `async void`), never inside a collection or union, and
  never `void?`.
- `async` only at the top of a returns: a method's, a type method's or a signature type's. The tree
  has 0 promises in fields or params, and a stored pending computation is a runtime construct, not
  a design one.
- `result<T, E>` only as a whole returns or directly under its `async`, never optional; its T may
  be `void` (`result<void, E>`, Rust's `Result<(), E>`), its E may not. A success-or-failure is
  what a call answers, not a value a field or a param holds.
- A map key must be `string`, `int` or an enum. Every key in the tree is `string`. Scalar keys are
  what JSON, OpenAPI and the ERD can carry. Hashing a structured key is a per-language mechanism.
- `T??` is refused. `any?` normalises to `any`, because `any` already admits no value.

### Optional and nullable: two properties, one "none"

Languages differ:

- TypeScript has three spellings: `x?: T`, `T | null` and `T | undefined`.
- Kotlin, Swift and C# have one `T?`. Rust has `Option<T>` and Python has `Optional[T]`.
- JSON Schema separates "not required" from "may be null".

What they all agree on is two different things:

- **"No value"** is a property of a **type**. Every language has it (`T?`, `Option`, `None`, `nil`,
  `null`).
- **"May be left out"** is a property of a **position**: a default argument, an omittable field.
  Every language with default or named arguments has it, and so does every serialisation format.

**Recommendation, decided:**

- The grammar has one "none", `T?`. It is used where no flag exists: the 188 nullable returns, list
  elements, map values and union members.
- The existing `optional` flag on fields and params stays, meaning "may be left out". Nothing in it
  changes.
- `null` and `undefined` both mean `?`. TypeScript's difference between them is not one that
  mainstream languages share.
- `T | undefined` on a position whose `optional` flag is set normalises to `optional: true` with
  type `T`. In TypeScript, undefined *is* "absent". There are 5 such positions.
- Elsewhere, `T | undefined` normalises to `T?`.
- Both stated together (`optional` plus `T?`) is legal and means "may be left out, and may be
  explicitly none". JSON and PATCH semantics need that distinction; it occurs 4 times here. A
  translation to a language without the distinction collapses both into `Option<T>`.

### Unions

Mainstream languages do **not** agree on untagged unions of arbitrary types:

- TypeScript and Python typing have them.
- Rust, Swift, Kotlin and Java model a choice as a sum type (`enum` with payload, `sealed`).
- Go and C# have no union at all.

They do agree on "a value is exactly one of these named variants". That is the sum type, and every
language can express it with what it has. **Decided (M3): unions of named types only**, and `?` as
the only way a non-named member joins. A union mixing in a primitive or a collection is a form the
grammar leaves out (`TYPE_FORM_UNSUPPORTED`, a warning on load and refused at write), not a position
error, so the 8 such positions in wairon's tree keep loading until an author remodels them.

### What is deliberately not in the grammar

Each of these is refused at write and reported on load (`TYPE_FORM_UNSUPPORTED`). The message names
the replacement.

| Form | Occurrences | Replacement, and the reason |
|---|---|---|
| Inline object shape `{ a: T }` | 0 structured (23 in prose) | A named value-object. Most languages need a name to declare a record; the ERD, OpenAPI components and the surface closure all key on ids |
| Inline function type `(a: T) => R` | 7 structured (5 in prose) | A signature type (stage 1). Java and C# name their function types too; a named one translates everywhere |
| String-literal union `'a' \| 'b'` | 1 | An enum (section 4) |
| Intersection `A & B`, utility types (`Partial`, `Pick`, `Omit`), tuples, `keyof` / `typeof` | 0–1 | A named type. These are TypeScript's type algebra, not shared concepts |

Prose signatures (`signature` text on a method without `params`) remain prose. They are tokenized
leniently as today, because they are explicitly the unstructured form. The grammar governs
structured positions only.

## 2. Normalisation

### Aliases

The alias table is the one place that knows TypeScript's spellings. On input it maps:

| Written | Canonical |
|---|---|
| `T[]`, `Array<T>`, `ReadonlyArray<T>` | `list<T>` |
| `Set<T>`, `ReadonlySet<T>` | `set<T>` |
| `Map<K, V>`, `Record<K, V>`, `ReadonlyMap<K, V>` | `map<K, V>` |
| `T \| null`, `T \| undefined`, `T \| null \| undefined`, `Option<T>`, `Optional<T>` | `T?` (with the `undefined` rule above) |
| `Promise<T>` at the top of a returns | `async T` |
| `boolean` | `bool` |
| `integer`, `long`, sized integers (`i8` … `u128`, `isize`, `usize`) | `int` |
| `double`, `f32`, `f64` | `float` |
| `Buffer`, `Uint8Array` | `bytes` |
| `Date`, `timestamp` | `datetime` |
| `object`, `unknown`, `json`, `Json` | `any` |
| `str`; `vec`, `vector`, `List`; `dict`, `dictionary`, `HashMap` | `string`; `list`; `map` |
| `Result<T, E>`, `()` | `result<T, E>`, `void` (M4: Rust's spellings of a form the grammar has) |
| `number` | not an alias (M2): refused at write ("int or float?"), reported on load, read as `float` until fixed |

Two kinds of name are not aliases:

- **Names with no neutral meaning** that today's builtin vocabulary accepts: `uuid`, `decimal`,
  `char`, `byte`, `time`, `tuple`, `error`, `never`, `box`, `arc`, `rc`, `ref`, `cell`,
  `refcell`, `mutex`, `rwlock`, `std`, `mcpserver`. These are `TYPE_NOT_NEUTRAL`: refused at write,
  a warning on load, and the message names the replacement. A tree that validated yesterday still
  loads.
- **Spellings from other languages** that the vocabulary never accepted (`Vec<T>`, `List<T>`
  generics and the like) stay out. The table accepts only spellings that existing trees can already
  contain. Adding a language's spellings on request would be the tailoring the direction rules
  out.

### Stored or interpreted

There are two ways to treat an alias:

- **Rewrite** (normalise on write, and doctor migrates existing trees): the file, the diff, the
  lock approval, the canvas and every consumer read one spelling.
- **Interpret** (keep the alias as written, canonicalise in memory): authors keep the spelling they
  wrote.

This was **M1**, decided as recommended: **rewrite**. The reasons are below, and they also explain
how the decision shapes everything else.

- **One reader, one spelling.** A reviewer reading a lock diff, an agent reading `sdd_get_spec` and
  a consumer reading the export all see one form. Interpreting means two spellings of one type
  stay in circulation for good, which is the condition the direction exists to end.
- **Precedent.** Stage 1 kept the stored `signature` field and stored the derived text (D1),
  because the file is what reviews and the lock read. Interpretation would contradict that one stage
  later: the derived signature text would show `list<string>` while the param beside it says
  `string[]`.
- **The TypeScript readability cost is small and paid once.**
  - `list<string>` versus `string[]`, `T?` versus `T | null`, `bool` versus `boolean`: each pair is
    readable to a TypeScript developer at sight. `T?` is shorter than what it replaces.
  - Most authoring is done by agents through the `sdd_*` tools. Agents follow a written rule
    reliably, and the tools report each normalisation they applied (below).
- **No display dialect.** A per-project option to *show* TypeScript spellings is possible later as
  a pure rendering setting. I would not add it now: it reintroduces two spellings at the exact
  places a human compares them.

How the rewrite works, mirroring stage 1:

- **The loader** parses every structured position and keeps the canonical text in memory. Every
  consumer therefore sees canonical text even before a tree is migrated.
- **Facts.** Each position whose stored text is not canonical becomes a fact on the index
  (`SpecIndex.typeSpellings`). It reaches the validator along the path `signatureFacts` already
  takes.
- **`TYPE_SPELLING_STALE`** (warning) reports a non-canonical stored text. `doctor --fix` rewrites
  it, and so does any save.
- **The writer** stores the canonical text. Create tools and `sdd_update_spec` accept aliases and
  answer with a `normalised` list, `{ path, written, stored }`, so the author sees exactly what was
  rewritten. That list is the teaching channel; nothing is refused for using an alias.
- **What cannot be normalised** is refused at write and reported on load. This is the stage-1 pattern
  (refused at the authoring seam, reported by the validator), applied to `TYPE_EXPRESSION_INVALID`,
  `TYPE_FORM_UNSUPPORTED`, `TYPE_NOT_NEUTRAL` and `TYPE_POSITION_INVALID`.

## 3. Code conformance

Only one comparison of spec types against code exists today: `param-conformance` decides whether a
differently named param is a rename by checking that the types agree. `type-shape` compares field
names and optionality, never field types. The surface of this stage is therefore small. It is set
up so that a future type comparison, and a second language, fit in without new concepts.

### A dialect is a reader and a writer for one language

`type_dialect` is a pure value-object with two methods:

- **`read(annotation): type_expression?`** turns a language's own spelling into the canonical
  expression. The result is empty when the spelling has no canonical meaning.
- **`write(expr): string`** gives that language's idiomatic spelling of a canonical expression.

The **TypeScript dialect's `read` is exactly the alias table above**, plus what the code says and a
spec does not: `x?: T` for an omittable position, and an `async` modifier or a `Promise<T>` return
for `async T`. The table that normalises input is the table that reads code. It is one table, and
it cannot drift from itself.

| Canonical | TypeScript `write` | TypeScript `read` also accepts |
|---|---|---|
| `string` / `bool` / `bytes` | `string` / `boolean` / `Uint8Array` | `Buffer` |
| `int`, `float` | `number` | `number` reads as *int or float* (below) |
| `date`, `datetime`, `duration` | `string` (ISO 8601) | `Date` for `datetime` |
| `list<T>` / `set<T>` / `map<K, V>` | `T[]` / `Set<T>` / `Record<K, V>` | `Array<T>`, `ReadonlyArray<T>`, `Map<K, V>` |
| `T?` | `T \| null` | `T \| undefined` |
| `A \| B` | `A \| B` | |
| `async T` | `Promise<T>` | an `async` modifier |
| enum `E` | `type E = 'a' \| 'b'` | a `z.enum([...])` schema, a string-valued `enum E` |
| `any` | `unknown` | `any`, `object` |

**Comparison is canonical against canonical.** In `param-conformance`, `typeAgrees` becomes:
`dialect.read(code annotation)` equals the spec's canonical expression. Named types are compared
through the code-name map the rule already builds. Two readings are deliberately loose:

- TypeScript `number` agrees with both `int` and `float`, because the code cannot tell.
- `T | undefined` agrees with `T?`.

An annotation the dialect cannot read is silence, never a finding. That is the stance the rule
already takes when the code writes no annotation.

### Async conformance

A marker no check reads drifts. The measured state, 58 of 120 async methods marked, shows that it
already has. A new carryable warning, `ASYNC_MISMATCH` (rule `async-conformance`), compares `async`
on the returns with the realizing function at exact grade, in the same shape as `PARAM_OPTIONALITY`.
The analyzer records which functions complete later (`source_file_facts.asyncFunctions`: declared
`async`, or annotated to return a Promise).

**On wairon's tree: about 62 findings, fixed rather than carried.** Every one is the code already
being async and the contract not saying so, so the spec is what is wrong. They are cleared in the
migration wave (wave 6), right after `doctor --fix`: for each finding, the method's returns becomes
`async T`. That is a mechanical edit an agent makes from the finding list through `sdd_update_spec`,
one delta per interface. It is not done by the doctor, because the doctor reads specs and never code.
Carrying is the fallback only for a finding where the code is async by accident (an `async` function
that awaits nothing): there the code is what should change, and the debt register names it until it
does. The opposite direction (a spec saying `async` over a function that completes now) has 0 cases
today, since all 58 marked methods are async in code.

### Another language

A regex-grade or future exact-grade analyzer for another language contributes its own dialect. For
Rust, that means `Vec<T>` → `list<T>`, `HashMap<K, V>` → `map`, `HashSet` → `set`, `Option<T>` →
`T?`, `String` → `string`, the sized integers → `int`, `f32`/`f64` → `float`, `Vec<u8>` → `bytes`
and `async fn` → `async`. Its `write` side is what that language's implementer brief carries.

Dialects are code shipped with the analyzers, not configuration. A pack-provided dialect is a
possible later extension; nothing in this stage needs it.

**Implementer briefs.** A live agent brief (`agent_resolver.composeAgentBrief`) gains `typeMapping`:
the `write` table of the dialect for the language the agent's implementations are written in, also
folded into its instructions as a "Types in <language>" section. An implementer then maps
`list<HostedProjectRecord>` to `HostedProjectRecord[]` by rule rather than by guess. The
`sdd-implement` and `sdd-delegate` skills say to follow it.

### `LANGUAGE_FOREIGN_BUILTIN` is retired

The rule asks contracts to "speak the declared target language". This stage makes contracts
language-neutral and leaves the language to L4 `technologies`. After normalisation:

- every foreign builtin it could flag is either an alias, which has been rewritten, or
  `TYPE_NOT_NEUTRAL`, which is reported;
- the rule has nothing left to say.

The rule, its contract method (`heuristic_rules.signatureLanguageBuiltins`) and its registration are
removed. The pack field `languages.<id>.foreignBuiltins` is accepted and ignored for one release: the
extension loader merges the language without it and records a deprecation
(`LoadedExtensions.deprecations`), which a new notice reports (`PACK_FIELD_DEPRECATED`, rule
`pack-deprecations`). The field goes in the release after. The field `unsupportedFlow`, which governs
narratives, is untouched.

## 4. The enum kind

### Shape

```yaml
kind: enum
id: update_channel
name: UpdateChannel
description: Which release track `wairon update` follows, narrowest first.
values:
  - name: stable
    description: Releases only.
  - name: beta
  - name: preview
  - name: dev
methods:            # optional pure methods, exactly as on a value-object
  - name: isValid   # update_channel's own methods today: isValid, all
    params: [{ name: value, type: string }]
    returns: bool
```

- **`values`** is a non-empty list in declared order, and order is meaningful: `update_channel` is
  narrowest first, and its methods depend on that. Each value has a `name` and an optional
  `description`. The name is also the value as data carries it.
- **No explicit ordinals or separate wire values.** Numeric enum values (C, C#, TypeScript numeric
  enums) are not shared across languages. A separate wire value is a serialisation concern that the
  name already settles.
- **Names are unique by `nameKey`.** `foo-bar` and `foo_bar` are one name, because every language
  derives one identifier from both.
- **Methods are allowed.** They follow the existing pure-method doctrine, where a type method may be
  a free function in a language without methods on data. Rust, Java, Swift and Kotlin put them on
  the enum itself. This is not new reach: `update_channel` already has them.
- **Not allowed on an enum:** `fields`, `params`, `returns`, `componentClass`, `database`, `table`
  and `linkedEntity`. Holding any of them, or having no values, is `ENUM_MEMBERS` (error). The
  check mirrors stage 1's `SIGNATURE_TYPE_MEMBERS`. Being system-level or owned by a subsystem works
  as for any type.
- **Where an enum may appear:** anywhere a named type can, including a map key. `specKind()` must
  recognise `kind: enum` without `fields`, the same caveat stage 1 recorded for signature types
  (D10).

### How an enum maps

| Target | Mapping |
|---|---|
| TypeScript | `type E = 'stable' \| 'beta' \| …`. A `z.enum([...])` and a string-valued `enum` are also read as realizations |
| OpenAPI 3.1 | A component `{ type: string, enum: [...] }`, with the value descriptions in its description. `fromOpenApi` decodes a named component carrying `enum` back into an enum type. An inline anonymous `enum` on a parameter stays `string` plus a note, because it has no name to become |
| Surface digests | The shape is the kind plus the ordered value names, so adding, removing or reordering a value moves the digest |
| ERD / canvas | Drawn as a type node listing its values. A field typed by an enum gets no relation edge: an enum is a value domain, not an entity relation |
| Other languages | Rust / Java / Swift / Kotlin `enum`, Python `StrEnum`, C# `enum`, Go a typed `string` constant set |

### Conformance

- `type-realization` already counts a type alias and an enum declaration as a declaration, so
  existence works today.
- Value drift is new. The TypeScript analyzer gains an exact-grade fact listing an enum-like
  declaration's values: a literal-union alias, the array of a `z.enum(...)` constant followed one
  hop as derived shapes already are, or a string `enum`'s members.
- A rule of its own, `enum-values`, then reports `UNREALIZED_ENUM_VALUE` and
  `UNDECLARED_ENUM_VALUE`: two carryable warnings shaped exactly like `type-shape`'s field codes.
  It is its own rule rather than a branch of `type-shape` because a union alias is not a shape: the
  values come from a separate fact (`source_file_facts.enumValues`). Below exact grade it stays
  silent, and order is not judged.

### Migrating today's literal unions

There is one literal union in a structured position (`'global' | 'local'`, a param of
`iai_tool_guide`). The migration cannot invent its name, so it is reported (`TYPE_FORM_UNSUPPORTED`)
and the author creates the enum. The 45 prose-enumerated `string` fields are **not** flagged. A
heuristic over descriptions guesses, which is the kind of finding this tree's rules refuse to make,
and the regex pass already caught false positives (`displayName`, `slug`). They are listed in the
implementing PR as candidates for wairon's own tree to convert by hand, with `update_channel`
first.

## 5. What breaks, findings, migration

### What users see

- **Specs change spelling.** On wairon's tree, 2068 positions in 508 files are rewritten. The lock
  goes stale and the human re-locks.
- **Surface digests move once.** Digests now hash the canonical expression. Every consumer that
  pinned a snapshot whose members contain a changed spelling sees `EXTERNAL_DRIFTED` once and
  re-pins (`wairon surface pin`). The digests carry no algorithm version that could avoid this, and
  adding one only to skip a single re-pin is not worth a concept. The release notes say so.
- **Some positions need an author.** The doctor never guesses these:
  - inline function types become signature types (7 fields on one type here);
  - literal unions become enums (1);
  - unions mixing in a primitive become a named type or two params (8);
  - `number` becomes `int` or `float` (122). The doctor *proposes* `int` where the name plainly
    says an integer (count, size, length, limit, port, step, index, depth, level, days, minutes,
    seconds, bytes, version, ...), and an author confirms it by writing `int`, or writes `float`;
  - `TYPE_NOT_NEUTRAL` legacy names become a named type (0 here).
- **OpenAPI output changes for the better.**
  - `T?` renders as `type: [X, "null"]` (or `anyOf` with `{type: "null"}` for a `$ref`), where it
    used to render "Unresolved type".
  - `map` renders as `additionalProperties`, and `set` as an array with `uniqueItems`.
  - `bytes` renders as a string with `contentEncoding: base64`.
  - `date` renders as `format: date`, fixing today's `date-time`. `duration` renders as
    `format: duration`.
  - A union of named types renders as `oneOf`, and an enum as `enum`.
  - `fromOpenApi` produces canonical types, and a named string component carrying `enum` becomes an
    enum type.
- **`LANGUAGE_FOREIGN_BUILTIN` disappears**, and the pack field `foreignBuiltins` is deprecated
  (`PACK_FIELD_DEPRECATED`, a notice).
- **Aliases keep working on input**, through every tool, the web editor and hand edits. A hand edit
  is reported as stale until it is saved; a tool write is stored canonical and its answer names
  each respelling.

### Finding codes

| Code | Severity | Rule | Raised when |
|---|---|---|---|
| `TYPE_EXPRESSION_INVALID` | warning on load (M5; was an error); refused at write | integrity `type-expressions` | A structured position does not parse under the grammar |
| `TYPE_POSITION_INVALID` | warning on load (M5; was an error); refused at write | integrity `type-expressions` | `async` or `result` outside a returns, misplaced `void`, a map key that is not `string`, `int` or an enum, or `T??` |
| `TYPE_FORM_UNSUPPORTED` | warning on load; refused at write | integrity `type-expressions` | An inline object, inline function type, string-literal union, union mixing in a primitive or collection (M3), intersection, utility type or tuple. The message names the replacement |
| `TYPE_NOT_NEUTRAL` | warning on load; refused at write | integrity `type-expressions` | `number` ("int or float?", M2), or a legacy builtin with no neutral meaning (`uuid`, `decimal`, `tuple`, `box`, ...). The message names the replacement |
| `TYPE_SPELLING_STALE` | warning; any save or `doctor --fix` repairs | integrity `type-expressions` | A stored position is an alias of its canonical spelling (M1) |
| `ENUM_MEMBERS` | error | integrity `enum-types` | An enum without values, with two values equal by `nameKey`, or with a member it cannot hold; or values on a type of another kind |
| `UNREALIZED_ENUM_VALUE` | warning, carryable | conformance `enum-values` | The enum lists a value its declaration does not hold (exact grade) |
| `UNDECLARED_ENUM_VALUE` | warning, carryable | conformance `enum-values` | The declaration holds a value the enum does not list (exact grade) |
| `ASYNC_MISMATCH` | warning, carryable | conformance `async-conformance` | `async` on the returns disagrees with the realizing function (exact grade) |
| `PACK_FIELD_DEPRECATED` | notice | extension `pack-deprecations` | A loaded pack still declares `foreignBuiltins` |
| `LANGUAGE_FOREIGN_BUILTIN` | **retired** | (heuristic `signature-language-builtins`, removed) | |

Registration order in `rule_registry.registerBuiltinRules`:

- `type-expressions` and `enum-types` right after `signature-text`;
- `enum-values` right after `type-shape`, and `async-conformance` right after `param-conformance`;
- `pack-deprecations` right after `pack-requirements`.

Where the loader meets a form it cannot normalise, it is a warning, not an error, so that a tree
that validated yesterday still passes its gate the day this ships. Consumers treat an unreadable
or unsupported position as opaque `any`, which never invents a shape. The design first kept two
errors for what "no real tree holds" — a text that does not parse, a broken position rule — on the
evidence of wairon's own tree (0 such positions). An upgraded real-world tree held 1,720 of them
(`Result<(), E>` returns, which did not parse because `()` was no type), and an error on load kept
it from locking at all. So (M5) every type-expression code is a warning on load: the tree stays
lockable with its debt visible, the writer still refuses each of them, and consumers read the
position as opaque `any` as before.

Two existing rules change meaning without changing codes:

- `param-conformance`: types agree when the code's annotation, read through the file's dialect,
  equals the contract's canonical type (`type_dialect.agrees`). A file with no dialect, or an
  annotation the dialect cannot read, is silence.
- `untyped-seams`: judged on `any`, which `object`, `unknown`, `json` and `Json` now canonicalise to.

### Migration

`doctor --fix` gains `repairTypeSpellings` (`core_orchestrator.repairTypeSpellings`, reached through
`spec_maintenance_portal` → `cli_core_adapter` → `runDoctor`). It is placed like stage 1's
`repairSignatures`: right after it, idempotent, one project, outside the family transaction.

- **Fix.** It reads the spelling facts and re-saves each spec holding an alias position. The writer
  stores every position canonical, so the repair writes exactly what any later save would, and the
  derived signature texts follow from the canonical types.
- **Proposals, never applied.** A `number` position whose name plainly says an integer gets `int`
  proposed in the report. An author confirms by writing it (an `sdd_update_spec` delta, or by
  hand). A `number` with no such name gets no proposal. A string-literal union (`'a' | 'b'`, with
  or without a none) gets an **enum** proposed (M6, `type_expression_problem.enumProposal`): the
  enum id from the position's name in kebab-case and the values in written order. An author
  confirms by defining the enum and writing its id; until then it stays `TYPE_FORM_UNSUPPORTED`.
- **Families.** At a family's top, `doctor --fix` cascades the per-project repairs (Specialists,
  step fields, signatures, type spellings, pack selections) into every member inside the root,
  after the chaining migration, and names a member outside the root with the command to run there;
  the plain report counts every member's findings and lists each member with repairs pending.
- **Author needed.** Every position no rewrite can settle is listed with its replacement. Re-saving
  a spec that holds one leaves that position as written.
- **Report.** Plain `doctor` prints the plan: each spec it would rewrite, then the proposals, then
  the positions needing an author.
- **On wairon's tree.** 2068 positions rewritten in 508 files; most of the 122 `number`
  positions get an `int` proposal (counts, sizes, steps, ports; the plan lists each); 16 positions
  need an author (7 function types, 1 literal union, 8 mixed unions). A re-run plans nothing, which
  is the idempotence check.

## 6. Decisions

### Decided by the maintainer (2026-10-04)

- **M1: rewrite.** Stored specs are rewritten to the canonical spelling. The writer stores canonical
  text, `doctor --fix` migrates existing trees, and `TYPE_SPELLING_STALE` reports what is left.
  There is no display dialect.
- **M2: `number` is refused at write** with "int or float?", reported on load as `TYPE_NOT_NEUTRAL`
  and read as `float` until fixed. The migration may **propose** `int` where the name plainly says
  a count, size, port, step and the like; an author confirms.
- **M3: unions of named types only.** `?` is the only way a non-named member joins; a union mixing
  in a primitive or a collection is `TYPE_FORM_UNSUPPORTED`.

### Decided by the maintainer (2026-10-05, release readiness)

- **M4: `result<T, E>` joins the grammar**, and `()` reads as `void`. Success-or-failure is a
  mainstream concept (Rust's and Swift's `Result`, Kotlin's `Result`, F#'s `Result`); Rust's
  `Result<T, E>` is an alias, so `doctor --fix` respells `Result<(), E>` to `result<void, E>`
  mechanically. `result` is no longer a legacy name with no neutral meaning. The TypeScript
  dialect writes `result<T, E>` as T, with E as the error the function throws; TypeScript has no
  typed failure, so conformance compares a code annotation with T and never with E — an annotation
  of T agrees with `result<T, E>`, and nothing about E can produce a finding on TypeScript code. The
  OpenAPI codec documents the success body (the failure is the operation's error response), the ERD
  reads a result as its success type, and `result<void, E>` answers nothing like `void`.
- **M5: every type-expression code is a warning on load**, still refused at write (above).
- **M6: doctor proposes an enum for a string-literal union**, never applied (above).

### Decided in the design (each with its reason above)

- The primitive set is direction.md's ten. `uuid` and `decimal` are named value-objects, not
  primitives. Integer width is L4.
- Collections are `list`, `set` and `map`. Map keys are `string`, `int` or an enum.
- Optional and nullable are two properties of two different things. The type has one "none", `T?`.
  The `optional` flag keeps meaning "may be left out". `null` and `undefined` both mean `?`.
- `async` is a returns prefix (`async T`), not a new method field. It is checked against code by
  `ASYNC_MISMATCH`, and the ~62 findings on wairon's tree are fixed in the migration wave, not
  carried.
- Inline object shapes, inline function types, literal unions, intersections, utility types and
  tuples are not in the grammar. Each has a named replacement that exists in every language.
- Prose signatures stay prose. The grammar governs structured positions.
- Aliases cover only spellings existing trees can contain: TypeScript's, plus today's legacy
  builtin vocabulary. Anything in that vocabulary without a neutral meaning becomes
  `TYPE_NOT_NEUTRAL`.
- The TypeScript dialect's reader *is* the alias table. Conformance compares canonical with
  canonical. A dialect is shipped code per analyzer, not configuration.
- `LANGUAGE_FOREIGN_BUILTIN` is retired, and the pack field `foreignBuiltins` is deprecated with a
  notice.
- The enum is `values: [{ name, description? }]`: ordered, unique by `nameKey`, pure methods
  allowed, nothing else. Its code conformance is a rule of its own (`enum-values`), not a branch of
  `type-shape`.
- No heuristic finding for enums described in prose.
- Unsupported forms are warnings on load and refusals at write; only a malformed expression and a
  broken position rule are errors.
- Surface digests hash the canonical expression, and the one-time re-pin is accepted rather than
  versioned away.

## 7. The spec model

### Where the grammar lives: pure type methods, no new component

The grammar is pure logic over a value, so it lives on types, the way stage 1's
`method_signature.storedForm()` does. Type methods are reachable from every block without an edge,
which is what the writer, the authoring seam, the scan and the rules all need.

- `type_expression` (value-object: `form`, `name`, `args`) holds the whole grammar in its
  description. Its methods:
  - `parse(text, position): TypeParse` reads one position, normalises aliases and judges position
    rules;
  - `canonicalText()`, `namedRefs()` and `isMany()`.
- `type_parse` holds the expression, its canonical text, and the problem when there is one.
- `type_expression_problem` holds the code, the text as written, the detail, the replacement and the
  location.
- `type_respelling` holds the location, the text as written and the text stored.
- `interface_spec.canonicalTypes()` and `type_spec.canonicalTypes()` answer a
  `type_canonicalization`: one spec with every position read under the grammar, its respellings and
  its problems. The scan, the writer and the authoring seam all go through these two methods, so
  they cannot disagree about what a spelling means.

Unlike signature resolution, canonicalisation needs no cross-spec lookup: every position is judged
on its own text. That is why there is no resolver component beside `signature_resolver`.

### The dialect seam

`type_dialect` (value-object, field `language`) is the seam between the neutral grammar and one
language. Its methods:

- `forLanguage(language)` answers the shipped dialect for a language, or none;
- `read(annotation)` turns the language's own spelling into a canonical expression, or answers none;
- `agrees(annotation, expression, codeNames)` decides whether a code annotation and a spec
  expression describe the same type;
- `write(expression)` gives the language's spelling of a canonical expression;
- `mappingLines()` answers the write table for briefs.

`source_file_facts.dialect()` is how a rule reaches the dialect for the language a file was
analyzed as.

**A future language plugs in by shipping one dialect next to its analyzer**, registered under the
analyzer's language key in `src/models/type-dialects.ts`. It needs nothing else: param conformance,
async conformance and the briefs pick it up through `forLanguage`. The position markers that are not
types (`x?:` and the `async` modifier) arrive as analyzer facts (`parameter_fact.optional`,
`source_file_facts.asyncFunctions`), never through `read`.

### Loader facts, reusing stage 1's path

- **Scan.** `spec_index_impl.listProjectRoots` step 18 (`types`) runs before any reference is bound.
  It canonicalises every root's interfaces and types in memory, and keeps the respellings and
  problems as `SpecIndex.typeSpellings`. Because the binder and the signature resolver run after it,
  derived signature texts are built from canonical types.
- **Facts path.** It is the path signature facts already take:
  - `spec_index.typeSpellingFacts`
  - → `spec_loader.typeSpellingFacts` (its `signatureFrom` is the index's)
  - → `spec_tree_portal.typeSpellingFacts`
  - → `validator_core_adapter.typeSpellingFacts`
  - → `spec_validator_impl.validateProject` (step 46 on the main path, step 8 for a part judged
    against its pin)
  - → `RuleContext.typeSpellingFacts`.
- **Part excerpts.** A part's pinned excerpt is stored-form documents. `spec_tree_portal`'s
  `resolveSignatures` canonicalises them first, so a sourced method resolved from the excerpt
  carries canonical types too.

### Writer and authoring seam

- **Writer.** `spec_registry.save` writes every type position canonical. A position that is not
  canonical is written as it stands: a mechanical re-save (rename, move, lock promotion, doctor)
  must never destroy what only an author can settle. `saveInterfaceSpec` derives each text from the
  canonical types.
- **Creates.** `spec_restatement.applyTo` canonicalises an interface or type candidate. It records
  the respellings on `SpecRestatementApplication.respellings`, which `SpecWriteReceipt.respellings`
  reports, and it refuses any non-canonical position with its replacement.
- **Deltas.** The `updateSpecGated` hook canonicalises the merged spec and reports
  `SpecChangeReport.respellings`. It refuses only positions the delta itself wrote, so a spec
  holding one from before the grammar can still be edited and repaired.
- **MCP.** `sdd_add_type` takes kind `enum` with `values`. All three write tools document the
  grammar and answer with the respellings.
- **Re-authoring seam test.** The only new canonical *spec* schema fields are `TypeSpecSchema.values`
  and the enum member of `TypeKindSchema`. `values` must be **expressed** by `sdd_add_type`, with no
  `UPDATE_SPEC_ONLY` entry, so `tests/mcp/schema-field-coverage.test.ts` passes. The receipt and
  report fields are tool output, not spec fields. `SurfaceTypeDef.values` belongs to a snapshot,
  not a spec.

### Consumers

| Consumer | Spec change |
|---|---|
| Reference rules, unused types, part context, loader references | `method_signature.typeRefs`, `type_spec.fieldTypeRefs`: named refs from the parsed expression |
| Canvas ERD | `spec_canvas_impl.build` step 5: multiplicity from `isMany`, `T?` and `optional`; no edge to an enum; enum nodes list values (`ispec_canvas.build`) |
| OpenAPI | `iopenapi_codec.toOpenApi` / `fromOpenApi` and their narratives: the full mapping both ways |
| Surface digests and closure | `surface_snapshot.canonicalTypeRef` / `contentDigest`; `surface_type_def.values`; `surface_projector_impl.projectOwnSurface` step 9 carries enum values |
| Param conformance | `iconformance_rules.paramConformance`, impl step 7: `source_file_facts.dialect()` + `type_dialect.agrees` |
| Briefs | `agent_brief.typeMapping`; `iagent_resolver.composeAgentBrief`, impl step 13 |
| Untyped seams | `iwiring_rules.untypedSeams`: judged on `any` |
| Extension loader | `loaded_extensions.deprecations`; `extension_orchestrator_impl.loadFor` step 5; `language_pack_def.foreignBuiltins` deprecated |

### Specs touched

**New types (9, all system-level or `sdd_core`, no `sourcePath` yet):**

- `type_expression`, `type_parse`, `type_expression_problem`;
- `type_respelling`, `type_canonicalization`, `type_spelling_facts`, `type_spelling_repair`;
- `type_dialect`, `enum_value`.

**Changed types:**

- `type_spec`: kind `enum`, `values`, `canonicalTypes`, `fieldTypeRefs`;
- `interface_spec`: `canonicalTypes`;
- `method_signature`: the `params` and `returns` descriptions, and `typeRefs`;
- `spec_index` (`typeSpellings`) and `rule_context` (`typeSpellingFacts`);
- `spec_write_receipt`, `spec_change_report` and `spec_restatement_application` (each
  `respellings`), and `spec_restatement` (`applyTo`);
- `surface_type_def` (kind, `values`) and `surface_snapshot` (`canonicalTypeRef`, `contentDigest`);
- `source_file_facts` (`asyncFunctions`, `enumValues`, `dialect()`);
- `agent_brief` (`typeMapping`), `loaded_extensions` (`deprecations`), and `language_pack_def`
  (`foreignBuiltins` deprecated).

**Interfaces:**

- **New methods:**
  - `typeSpellingFacts` on `ispec_index`, `ispec_loader`, `ispec_tree_portal` and
    `ivalidator_core_adapter`;
  - `repairTypeSpellings` on `icore_orchestrator`, `ispec_maintenance_portal` and
    `icli_core_adapter`;
  - `iintegrity_rules` (`typeExpressions`, `enumTypes`), `iconformance_rules` (`enumValues`,
    `asyncConformance`) and `iextension_rules` (`packDeprecations`).
- **Removed:** `iheuristic_rules.signatureLanguageBuiltins`.
- **Descriptions only:** `iconformance_rules.paramConformance`, `iwiring_rules.untypedSeams`,
  `iauthoring_orchestrator` (`writeSpec`, `updateSpecGated`), `iopenapi_codec` (`toOpenApi`,
  `fromOpenApi`), `ispec_canvas.build`, `iagent_resolver.composeAgentBrief`, `imcp_portal`
  (`sdd_add_type`, `sdd_define_interface`, `sdd_update_spec`) and `imcp_orchestrator.addType`.

**Implementations:**

- **New methods, plus the facts and scan steps:** `spec_index_impl`, `spec_loader_impl`,
  `spec_tree_portal_impl`, `validator_core_adapter_impl`, `spec_validator_impl`,
  `spec_maintenance_portal_impl` and `cli_core_adapter_impl`.
- **Reopened to `design`, because they name files that do not exist yet:**
  - `core_orchestrator_impl` (`src/core/type-spelling-repair.ts`);
  - `integrity_rules_impl` (`type-expressions.ts`, `enum-types.ts`);
  - `conformance_rules_impl` (`enum-values.ts`, `async-conformance.ts`);
  - `extension_rules_impl` (`pack-deprecations.ts`).
- **Narrative edits:**
  - `cli_runner_impl.runDoctor`: step 22 is the fix, step 48 the report;
  - `rule_registry_impl`: five registrations added, one removed;
  - `heuristic_rules_impl`: method removed;
  - `spec_registry_impl` (`save`, `saveInterfaceSpec`);
  - `authoring_orchestrator_impl` (`updateSpecGated`, `writeSpec`);
  - `openapi_codec_impl`, `spec_canvas_impl`, `surface_projector_impl`, `agent_resolver_impl` and
    `extension_orchestrator_impl`.

The spec texts authored here still use today's spellings (`TypeExpression[]`, `string | null`).
The migration wave rewrites them with the rest of the tree.

### Validate state at hand-off

`sdd_validate_tree`: **0 errors, 27 warnings, 0 notices**. Every warning is code that does not exist
yet:

- `MISSING_SOURCE_FILE` (6, in draft context): the five new rule files (`type-expressions.ts`,
  `enum-types.ts`, `enum-values.ts`, `async-conformance.ts`, `pack-deprecations.ts`)
  and `type-spelling-repair.ts`.
- `UNREALIZED_METHOD` (6): `typeSpellingFacts` on index, loader, tree portal and validator adapter;
  `repairTypeSpellings` on the maintenance portal and the CLI adapter.
- `CALL_STEP_UNREALIZED` (2 findings, 4 steps): `runDoctor` → `repairTypeSpellings` (×2) and
  `validateProject` → `typeSpellingFacts` (×2).
- `UNREALIZED_TYPE_METHOD` (3): `interface_spec.canonicalTypes`, `type_spec.canonicalTypes` and
  `source_file_facts.dialect`.
- `UNREALIZED_TYPE_FIELD` (9): `agent_brief.typeMapping`, `loaded_extensions.deprecations`,
  `rule_context.typeSpellingFacts`, `source_file_facts.asyncFunctions`/`enumValues`,
  `spec_change_report.respellings`, `spec_index.typeSpellings`,
  `spec_restatement_application.respellings`, `spec_write_receipt.respellings`,
  `surface_type_def.values` and `type_spec.values`.
- `UNCLAIMED_SOURCE_FILE` (1): `src/core/rules/heuristic/signature-language-builtins.ts`, the
  retired rule's file, which wave 4 deletes.

## 8. Implementation waves

Each wave ends green: tests pass, `wairon validate` shows no new errors, and the warnings the wave
was meant to remove are gone. Waves 1–5 change code only. Wave 6 is the one-time migration of
wairon's own tree. Waves 4 and 6 belong in one PR with the rest, because from wave 4 on, the rules
report the tree's ~2068 stale spellings until wave 6 rewrites them.

1. **Grammar and dialect.**
   - New `src/models/type-grammar.ts`:
     - the parser for the grammar;
     - the alias table and the legacy vocabulary with their replacements;
     - position rules and problems;
     - `canonicalText`, `namedRefs`, `isMany`;
     - `interfaceCanonicalTypes` / `typeCanonicalTypes` (bind them with `symbol` on the two type
       methods, or move them to `specs.ts`).
   - New `src/models/type-dialects.ts`: the TypeScript dialect, `forLanguage`, `agrees` and
     `mappingLines`.
   - `src/models/specs.ts`:
     - `TypeKindSchema` gains `enum`;
     - the `EnumValue` schema;
     - `TypeSpecSchema.values` and `SurfaceTypeDefSchema.values`.
   - `src/models/type-references.ts` is rebuilt on `namedRefs`: `methodTypeRefs`, `fieldTypeRefs`
     and `signatureTypeRefs`. Prose signatures keep the lenient tokenizer, and `BUILTIN_TYPES` is
     retired into the grammar's tables.
   - `src/models/surface-references.ts`: `canonicalTypeRef` over the parsed expression; enum shapes
     in `typeShape`.
   - Then add `sourcePath`s to the nine new types.
   - Tests: one case per alias, per problem code and per position rule; canonical text is a fixed
     point; `tests/models/type-reference-unions.test.ts` updated.
2. **Loader, writer and facts path.**
   - `src/core/specs.ts`:
     - the scan step before binding;
     - `SpecIndex.typeSpellings`;
     - `typeSpellingFacts` on the index and loader exports;
     - the canonical write in the save pipeline;
     - `specKind` accepts `kind: enum` without `fields` (stage 1's caveat again).
   - `src/core/index.ts`: `spec_tree_portal.typeSpellingFacts`, and canonicalisation in
     `resolveSignatures`.
   - `src/core/adapters/validator-core.ts`, `src/core/validation.ts` (both steps) and
     `src/core/rules/types.ts`.
   - Tests: id-space round-trip and fix-point fuzz with aliases in every position; the derived
     signature text from canonical types.
3. **Authoring seam and MCP.**
   - `src/core/authoring.ts`: `applyRestatement` respells and refuses; the `updateSpecGated` hook
     refuses only positions the delta wrote; `respellings` on both answers.
   - `src/mcp/server.ts`: `sdd_add_type` kind `enum` and `values`; grammar text in the field
     descriptions of all three write tools; `respellings` in structured content.
   - `tests/mcp/schema-field-coverage.test.ts`: `values` is expressed.
   - An e2e journey: an alias goes in and comes back canonical with a respelling; `number` is
     refused with "int or float?".
4. **Rules and analyzer facts.**
   - New rule files:
     - `src/core/rules/integrity/type-expressions.ts` and `enum-types.ts`;
     - `src/core/rules/conformance/enum-values.ts` and `async-conformance.ts`;
     - `src/core/rules/extension/pack-deprecations.ts`.
   - `param-conformance.ts`: `typeAgrees` goes through `facts.dialect()`.
   - `untyped-seams.ts`: judged on `any`.
   - Delete `src/core/rules/heuristic/signature-language-builtins.ts`.
   - `src/core/rules/repository.ts`: registrations in the order listed above.
   - `src/core/source-analysis.ts` and `src/models/code-model.ts`: `asyncFunctions`, `enumValues`
     (literal-union alias, `z.enum` constant one hop, string `enum`), and `dialect()`.
   - `src/core/extensions.ts`: `deprecations`, with `foreignBuiltins` dropped from the merge.
   - Rules matrix: a firing fixture and a control for each new code; `LANGUAGE_FOREIGN_BUILTIN`
     out of the ratchet and the catalog.
5. **Consumers and doctor.**
   - `src/core/openapi.ts`, with a round-trip test for each form.
   - `src/core/canvas.ts` and `web/src/canvas/engine.ts`: multiplicity from the expression, enum
     nodes.
   - `src/core/surfaces.ts`: the closure carries enum values.
   - `src/models/agent.ts` and the brief composer: `typeMapping`.
   - New `src/core/type-spelling-repair.ts`: the export in `src/core/index.ts`,
     `src/commands/adapters/core.ts`, and `src/commands/doctor.ts` (fix after `repairSignatures`,
     report after the signature report).
   - The `sdd-architect` skill example (`Promise<void>` becomes `async void`), the `sdd-implement`
     and `sdd-delegate` skills (follow the brief's type mapping), `docs/cli.md` and the CHANGELOG.
6. **Migration of wairon's own tree** (the human reviews the diff):
   1. Build, then reconnect the MCP server, so the tools run the new code.
   2. Run `wairon doctor` and read the plan, then `wairon doctor --fix`: 2068 positions in 508 files.
   3. Settle the `number` positions:
      - accept the `int` proposals that are right (one delta per spec);
      - write `float` for the fractional ones (`x`, `y`, `w`, `h`, `score`, `maxCompressionRatio`);
      - decide the rest.
   4. Settle the 16 positions needing an author:
      - the 7 function-type fields of `status_decor` become two or three signature types;
      - the literal union becomes an enum;
      - the 8 mixed unions become a named type or two params.
   5. Clear `ASYNC_MISMATCH` (~62): add `async` to each returns the code already completes later.
      Carry only one whose code is async by accident.
   6. Optional, and could be its own PR: convert `update_channel` and the ~45 prose-enumerated
      `string` fields to enums.
   7. Promote the four reopened implementations back to `complete`, and validate to 0 errors and
      0 warnings.
   8. The human runs `wairon lock` on the branch, and the lock record is committed before the merge.
   9. Note for external consumers in the release notes: re-pin once.
