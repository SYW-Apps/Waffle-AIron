# Direction — a generic design model that translates 1:1

Status: direction, 2026-10-03. Not a plan of record; each stage below is designed spec-first and
decided on its own when it comes up.

## Why

wairon designs software of any shape and language. One of the projects designed with it, Waffler,
is a workflow platform that is itself a programming language and transpiles to many targets; the
plan is a translation package through which a system designed in wairon becomes a scaffolded system
there, and eventually that platform designs itself with wairon. Both sides already describe the
same things: boundaries that export a public surface, components, contracts, data types, function
signatures, and method bodies as flowcharts.

That is a reason to make wairon's model generic and precise, not to tailor it. The rule this
document holds itself to: **wairon adopts a concept when mainstream languages agree on it**, and
leaves out anything that belongs to one runtime or product (UI metadata on types, a particular
virtual machine, deployment targets). Every consumer reads wairon through one documented export;
wairon never depends on a consumer.

## The model against common language concepts

| wairon | Common concept | State |
|---|---|---|
| project (id, L0 export table, own lock) | package / crate / module with an export list | aligned: only exports cross the boundary |
| part (storage, same namespace) | none (storage is not composition) | fine |
| subsystem | namespace inside a package | aligned enough |
| L2 component (stereotype) | class / module | aligned |
| `owns` (Repository members) | composition | aligned |
| L3 interface / contract method | interface, method referencing a signature | gap: wairon has no named signature (stage 1) |
| L4 implementation | class implementing an interface | aligned |
| L5 narrative (steps: call, branch, loop, try, parallel, detach) | a method body as a control-flow graph | control flow aligns; data flow is deliberately below the design level (stage 3) |
| type spec (entity / value-object; fields; pure methods) | struct / record, enum | partly: no enum kind; type methods carry prose signatures, no params (stages 1, 2) |
| type expressions (`Promise<X \| null>`, `X[]`) | a type system | gap: wairon's are TypeScript-flavoured strings (stage 2) |
| lifecycle roots, Portal endpoints, the L0 export table | executable vs library package | packaging, not design: the export carries the facts and a consumer decides (stage 4) |

Where wairon is already more precise than many targets it stays that way and a translation narrows:
optional params, effect tags (read/write), invariants, async declared on the signature.

## Stages

### 1. Signatures — one source, named when shared (in progress)

- A contract method's shown signature is **derived** from `params` + `returns`; the stored text is
  regenerated once by `doctor --fix`. Methods without params keep their prose.
- A **named signature** is a type spec of a new kind `signature` (params + returns, description):
  a named function type, with inputs, one output and no inheritance.
- A method may take its signature from a source instead of restating it: a named signature, or the
  method it forwards to (only along a `dependsOn`/`owns` edge). One field, two sources; no chains.
- Type methods gain optional `params` like contract methods.

Detail: [`stage-1-signatures.md`](stage-1-signatures.md).

### 2. A neutral type grammar

Type expressions become a small language-neutral grammar: primitives (string, int, float, bool,
bytes, date, datetime, duration, void, any), `list<T>`, `map<K, V>`, `set<T>`, optional `T?`,
unions, and an async marker. Today's TypeScript spellings are accepted as aliases and normalised on
write. This is what makes "design once, emit any language" honest on wairon's side; L4
`technologies` remain where a language is chosen. An `enum` type kind joins entity and value-object.

### 3. Data flow — written down, not built

Design stops at the flowchart: the L5 narrative (steps, calls, branches, loops) is already the
deepest level wairon models, and it is enough for a design. Variables and the wiring of values
between steps would be one more layer below it. Producing immediately functional code from a design
is what an implementation platform is for, not wairon.

If that layer is ever added it is strictly optional; a design that stops at prose or at steps stays
legal. It would look like this:

- a step may bind its inputs (from the method's params, an earlier step's named result, or a
  literal) and name its result;
- the check it enables is runnability: every input a called signature requires is available at
  that step, from the method's own params or an earlier result. A required input available
  nowhere is then either created on the spot (a step that makes it) or the flowchart is invalid.

Until then, translation scaffolds instead of wiring. From a design, a consumer can generate every
type, signature, interface and class, and one method body per method with one node per step, in
order, with the branches and loops in place. That is structurally complete but not yet functional.
Wiring is the consumer's job: the user wires it, or the consumer attempts it, deterministically
(bind each input to the nearest earlier variable or method input of a matching type) or with AI,
and leaves what it cannot bind for the user. wairon's part is that the design it hands over carries
enough for that attempt: resolved signatures (stage 1) and precise types (stage 2).

### 4. Runnable projects: not a wairon concept

*Decided 2026-10-04: dropped.* Whether a project ships as an executable or a library is a packaging
decision: the same design can be built as either, and a framework, a runtime or a build file makes
that choice, not the architecture. That puts it outside the design layer, with deployment. A derived
"runnable" flag would also be a guess at one consumer's notion of a start: wairon's own tree binds
in-process library calls to endpoints, and models its command line without any entry mechanism.

What the design does say, the export carries as it is: each subsystem's lifecycle roots with their
phases, each Portal method's transport and endpoint, and the resolved L0 export table. A consumer
reads those facts and decides "bootable or library" for its own target. Detail:
[`stage-4-5-export.md`](stage-4-5-export.md).

### 5. The export seam

A versioned, documented export of a project, with specs resolved (signatures, types, references)
and ids stable across renames, as the one integration point any generator consumes. *Decided
2026-10-04:* `wairon export` and `exportDesign()` write one JSON document per project (format
`wairon-design`, `formatVersion` MAJOR.MINOR, a JSON Schema generated from the zod schema).
Elements are keyed by name, as mainstream IDLs key them, and the rename tools leave a trace
(`previousIds`, `previousNames`) that the export shows as `formerly`. Detail:
[`stage-4-5-export.md`](stage-4-5-export.md).

## Not adopted

UI metadata on types, runtime- or VM-specific constructs, deployment targets and environments, and
an untyped "anything" as the default. They belong to implementations, not to design.
