# wairon — CLI Reference

All commands operate on the `.wai/` directory in the current project. Global
flags: `--verbose`, `--silent`, `-v`/`--version`.

---

## Project

### `wairon init [-y, --yes] [--pack <source>]`
Bootstrap `.wai/` in the current project: project config, the SDD spec tree
(an L0 `.index.yaml` is seeded), the shared `.wai/context/` and the AI guide
(`CLAUDE.md` / `GEMINI.md`), the project-local MCP registration, and the SDD
skills installed into each selected target tool. No agent files are written:
agents are served as live briefs (`sdd_get_agent_brief`, `wairon agent brief
<id>`) unless the project opts into `rules.materializeAgentFiles: true`. `--yes`
uses defaults without prompts (a shell with no terminal needs it): the project name from the folder, profile backend, target claude only — another tool is one interactive answer or one `targets` entry away;
`--pack <source>` (repeatable) vendors + registers an extension pack right after
init (see `wairon pack`). Re-running on an
initialized project is a no-op that points you back to the SDD flow. Run in a
folder an existing project binds (see *Which project a command acts on* below),
it asks on a terminal whether to make that folder a **member** of the parent —
which edits the parent's `project.yaml` — and with `--yes` it refuses, writing
nothing and printing the exact `wairon member add <alias> <path> --project` to
run from the parent (or: make the folder its own repository with `git init` and
re-run `wairon init` for an independent project).

**What to commit.** All of `.wai/` — the specs, `project.yaml`, `lock.json`,
`externals/` and `externals.lock.yaml`, vendored packs: the gate reads committed
files only (a migration's scratch folder, `.wai/transactions/`, ignores itself).
The one exception is `.wai/.spec-write.lock`, the short-lived lock every write
into `.wai` takes so two sessions never lose a write: `wairon init` writes
`.wai/.gitignore` ignoring it (in an older project, add that line yourself). A
writer that read a spec another session changed before it wrote is refused with
`spec-write-conflict` — nothing is written to that file; run it again. A lock
wairon cannot read is broken by the next write once it is 10 s old, and
`wairon doctor` names a lock that is present.
The generated `CLAUDE.md`/`GEMINI.md`, `.claude/` (or `.gemini/`) skills and
`.mcp.json` hold no machine path: commit them and every clone's assistant starts
with them, or ignore them and run `wairon generate` after a clone — either way
`wairon generate` / `wairon doctor --fix` refreshes them.
A root `CLAUDE.md` (and `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`,
`.codexrules`) is usually your own file: wairon writes only its block between
`<!-- wairon-root-start -->` and `<!-- wairon-root-end -->` and keeps every other
byte — `init`, `generate`, `lock` and `doctor --fix` never delete text you wrote
there. A root file holding the unmarked pointer an earlier release wrote is
migrated into the marked block, keeping whatever followed it. `.mcp.json` is
merged: only its `wairon` server entry is wairon's. A folder whose name gives no
usable project id (`con`, `super`) starts with `<name>-project`, said once.
wairon writes no `.gitignore` — your toolchain's own entries (`node_modules/`,
`dist/`, …) are all it needs.

#### Which project a command acts on
Every command, the MCP server (`wairon mcp serve`) and `wairon dev` bind the same
project: from the folder you are in, the nearest folder whose `.wai/specs` holds
an L0 — but the walk **never climbs past the repository root** (the nearest folder
holding `.git`) unless a project above it declares the crossing as a member
(`members` naming the repository's folder, or a folder inside it). A stray `.wai`
in a parent folder therefore binds nothing in a child repository. Outside any
repository the walk is unbounded. Each command that acts on a project prints
`project <id> at <root>` on stderr first, so `wairon export` and every `--json`
output keep a pure stdout.

#### When a command refuses
A refusal is one `✖` line and a non-zero exit — never a Node stack trace, whatever
the input. A `.wai/project.yaml` that does not parse as YAML (most often a key
written twice, e.g. a second `rules:` block appended by hand) stops every command
the same way, naming the file, the line and the key —
`✖ .wai/project.yaml:33: duplicated mapping key "rules" — …` — and `wairon doctor`
diagnoses it too; no command runs on defaults instead. To report a bug, set
`WAIRON_DEBUG=1` and the stack is printed after the line.

#### Ids and names
Every id and name the design holds follows one grammar, and every writer, the
loader and the CLI judge it the same way. Spec ids (subsystems, components,
interfaces, implementations, types), project ids, and member and external
aliases, as well as method, parameter and field names, are never empty, at most
64 characters, never start with `-` (no command line could name one), hold no
control, NUL or zero-width character, and are never `__proto__`. Spec ids and
aliases are `[a-z0-9-_]+`, project ids `[a-z0-9-_.]` starting and ending
alphanumeric; these become folder and file names, so a name Windows reserves for
a device (`con`, `aux`, `nul`, `com1`, …) is refused on every platform, and a
project id or an alias is never `super`, the `::` grammar's namespace hop.
Method, parameter and field names are ASCII identifiers that never start with a
digit, and never a word the tree's `targetLanguage` reserves for that kind of
identifier: TypeScript and JavaScript allow a keyword as a method or a field but
not as a parameter, and no method named `constructor`; Rust, Python, Go, Java, C#,
C and Kotlin refuse their keywords everywhere (`RESERVED_IDENTIFIER`, naming the
language and an alternative) — except a word the language can spell as an ordinary
identifier (Rust `r#type`, C# `@class`, Kotlin backticks), which is only a notice,
`RESERVED_IDENTIFIER_ESCAPED`, naming the spelling and suggesting no rename; Rust's
`crate`, `self`, `Self` and `super` have no raw form and stay errors. A display `name` is never blank and holds no
invisible character.

### `wairon status [--subsystem <id>] [--no-recursive] [--all]`
Print the SDD spec tree as a hierarchy. Its percentages measure **authoring
progress** — 80% once a component's component, contract and implementation specs
are written, 100% once its implementation names source files that exist, capped
at 50% while any of them is `draft` or `design` — and are
separate from **approval**, which is the lock record in `.wai/lock.json` and is
printed on its own line. `wairon lock` never rewrites a spec's status, so an
approved tree can still show draft specs. `--subsystem <id>` shows one
subsystem; `--no-recursive` shows this project without its members; `--all` lists
every spec that moved since the approval instead of the first few.
Each member project prints as `[Project] alias (id)` holding its own subsystems,
with its **approval state** computed at the member's own root (`approved`,
`drifted`, `never`) and how this project's lock pinned it (`matches`, `moved`,
`unpinned`). The report closes with this project's own state. Asked at the parent
or at the member, the answer is the same. When an external moved in its live
producer, drifted or could not be compared, an **Externals** section follows
the verdict (the same advisory comparison `validate` prints); it never changes
the exit code.

### `wairon validate [--ci] [--all] [--subsystem <id>] [--family] [--no-recursive]`
Run the architecture-conformance gate over the spec tree: reference integrity,
contract↔implementation method symmetry, narrative-call resolution, component
stereotype dependency rules, and dependency-cycle detection. `--ci` treats
warnings as errors (notices are printed and counted, never fatal).

- The first 100 findings per severity are printed; the rest are counted ("N
  more not shown") and a per-code total follows. `--all` prints every finding.
- `--subsystem <id>` validates one subsystem.
- It ends with one **code-reading line**, the same sentence `sdd_validate_tree`
  carries in its hint: the analysis grade the code was read at (the weakest any
  file got — see `wairon lock` for the grades) and, at `exact`, the TypeScript
  compiler that read it — `Code read at grade exact with TypeScript 5.9.3
  (wairon's own copy)` on a project with TypeScript 7 or none, `(the project's
  own)` on TypeScript 5 or 6 — or `Code: none read yet` before any file the design
  names exists. Then, per language, what that reading CHECKED and what it did
  not: `typescript: 9 file(s) at grade exact, checked methods, params, returns
  (where annotated), public members, imports, calls, routes, data types`;
  `python: 4 file(s) at grade pattern with its signature reader, checked methods,
  params, returns (where annotated), public members, imports, calls through
  declared receivers, routes, data types (of declarative data classes)`; a
  language read by its pattern table alone checks methods only and names
  everything else. A family run prints each project's reading under its verdict,
  and the closing line repeats it in a few words (`Code checked: python pattern;
  rust pattern (not checked: params, returns, public members, imports, calls,
  routes, data types); typescript exact.`) — a pass never implies more was
  checked than was.
  Routes are read only out of a router a Portal names (`router:`), so where an
  HTTP Portal names none the line says `routes where a router is named` and
  counts it among what was not checked (`not checked: routes of 1 HTTP Portal(s)
  naming no router`); such a Portal is judged by its realizing class's public
  methods alone.
- What it never checks is behaviour: the reading compares the code's structure and
  linkage with the design (which methods, signatures, imports, calls and routes exist),
  not what a method computes. A business rule deleted from a method body that keeps
  its signature and its calls passes; tests catch that, the gate does not. HOW a
  narrated call runs is compared where the narrative says it (call-manner-conformance):
  a call step marked `detach: true` that the code awaits is `DETACHED_CALL_AWAITED`,
  a call step inside a `try` step that catches whose code call no try/catch encloses
  is `CALL_NOT_CAUGHT`, and a call step not marked `detach` whose call completes
  later and is never awaited is `CALL_NOT_AWAITED` (or the notice
  `OPEN_CALL_NOT_AWAITED` where the method leaves its detail open). Only calls
  written in the method's own function are judged, not those inside a helper; a
  step whose manner (detach, or inside a catching try) the code realizes only
  through a helper, or whose target plans no code yet, is the notice
  `CALL_MANNER_UNJUDGED` naming the step and why, so a pass is never read as a
  judged one.
- **The code's own surface, signature and calls** (warnings, so `--ci` fails on
  them). A function annotated to return another type than its contract's
  `returns` is `RETURN_TYPE_MISMATCH` on that method, naming both types (a caller
  whose port no longer matches the class is not reported again: its call and its
  edge are held under that finding until the return is fixed).
  A public method of a component's realizing class, or a function or class its
  file exports, that no contract declares and nothing in the project uses — no
  call in its file, no other file or test using it — is `UNDECLARED_PUBLIC_MEMBER`
  (private, protected, `#private`, underscore-prefixed, static, accessor,
  `override`, constructor, protocol and lifecycle members are exempt). Where the
  TypeScript checker reads the using file (a test or a composition root among
  them, once its imports reach the project's code), a use is a call or reference
  that lands on that very declaration: a same-named method of another class is
  none, and a TypeScript or JavaScript file that imports none of the project's
  code uses nothing. A file no checker reads, such as a Python test, uses a name
  by writing it, and an exported class is used wherever its name is written.
  What a method's narrative says about its calls is judged by how much it
  states. **Stated detail is binding:** a method whose `detail` (`full` or
  `calls-only`) is set on the method or its implementation, or that declares
  `calls`, has said its narrative is the whole list, so any call its own body
  makes into another component's contract that no step names is
  `UNNARRATED_CALL`. **Unstated detail is open, never assumed:** without a
  stated detail, leaving out a verb of a collaborator the narrative names is
  still `UNNARRATED_CALL`, but a call to another collaborator the component
  depends on, or any such call from a method at `intent` or with no narrative,
  is a route the design allows without saying the method takes it. That is the
  `OPEN_ROUTE_CALL` notice, which names each one and never fails `--ci`. A
  design can stay loose and still see every route its code takes; state the
  detail where the narrative should be complete. Calls inside helpers are what a
  step summarizes, and a collaborator the design does not list at all is
  `UNDECLARED_DEPENDENCY`. Python is read by its signature reader: parameter
  names (in snake_case, so the contract's `documentId` is `document_id`),
  annotations, return annotations, public members and imports are judged like
  TypeScript's. Its routes are read off the route decorators of FastAPI,
  APIRouter, Flask, Blueprint, Quart and Sanic objects (`@app.get("/x")`,
  `@bp.route("/x", methods=["POST"])`), under the prefixes their construction
  and their includes state (`APIRouter(prefix=…)`, `include_router`,
  `Blueprint(url_prefix=…)`, `register_blueprint`), followed across modules; a
  Portal names the router object (`router: app`, `<module>#router`, or a module
  alone), followed through a package `__init__` that re-exports it. A function
  that selects its handler by the request's method and path is read as a router
  too (a router named through a package `__init__` re-export is followed to the
  module that defines it; `if`/`elif` comparisons, `match` over the path, a dict keyed by path or by
  method and path, or a `BaseHTTPRequestHandler`'s `do_GET`): name it
  `<module>#handle` or `Class.do_GET`. A router whose path, prefix, methods or
  include is not a string literal or a module constant holding one, that mounts
  an application, that places a path converter before further segments, that
  includes an unread router, or a guard whose comparisons do not all settle
  (a prefix that stops inside a segment included), is `UNREADABLE_ROUTER`, never
  read in part. Its data types are the fields of
  dataclass, Pydantic (`BaseModel`, `BaseSettings`), `TypedDict`, `NamedTuple`
  and attrs classes, compared with the type's by name in either casing (and,
  in either language, by a field's scalar type: `amount: str` where the spec
  declares `float` is the warning `TYPE_FIELD_TYPE_MISMATCH`, naming both
  types; an annotation that is a union, a list, a record or a named type the
  design does not know is not compared): a field
  may be absent when it has a default or a default factory, is `NotRequired`,
  or sits in a `total=False` TypedDict, and `Optional[T]` alone is nullable but
  required, as in Pydantic v2. `Field(...)` and `Field(default=...)` are required;
  a legacy `@attr.s` class without `auto_attribs=True` has only its `attr.ib()`
  fields; a `total=` that is not a literal leaves optionality uncompared; and of
  two fields sharing a name in different casings, the one spelled as the spec
  spells it is compared. A plain class, a model built by a call and a
  type alias are not read. A declared edge between two Python components is
  `UNREALIZED_DEPENDENCY` unless one imports the other (an import of a package
  whose `__init__.py` no component realizes reaches every file in it) or a file
  of the source calls a method of the target's contract through a field or a
  name, which is what a collaborator injected through a Protocol writes; an
  edge between a TypeScript and a Python component is not judged. A component importing a Portal that depends on it and calls it is
  `UNDECLARED_DEPENDENCY` on the importer, in either language: only a server
  importing a Portal mounted onto it, which the Portal does not call, is the
  declared edge read in reverse.
- **Binding modules.** A consumer whose code reaches another project's library
  through a hand-written binding module (a typed binding to a native addon, a
  client stub) names it on the implementation — `bindings:
  [src/routing/geo_binding.ts]` (code linkage like `sourcePath`: setting it
  never reopens the approval; `sdd_write_narrative` or `sdd_update_spec`).
  `validate` then compares the binding's exported declarations with what the
  projects that implementation's component reaches publish — the pinned snapshot
  of an external, or what a member exports now. A component reaches a project
  through every `alias::name` its specs write, the types its contract's
  params and returns name included, so a binding to a types-only contracts
  library is compared too:
  `BINDING_DRIFT` (warning) for a method or function the pin renamed — `"tile_for_coordinate"
  was renamed to "tile_at" in geo::tiles — follow the rename` — or no longer
  exports, a parameter list whose arity or names differ (a parameter rename
  named), a type the producer renamed that the binding still declares (or types
  a field with) under its former name, and a field the pinned type renamed, does
  not have or has that the binding lacks. A verb the producer removed is named
  when a doc comment ties the declaration to its interface (`/** geo::tiles */`,
  or `/** geo::tiles.tile_at */` on a free function), and — for a free function
  with no tag — when an earlier pin held it: a re-pin records each method the
  producer removed since (`retired` in the snapshot), so `"vincenty_distance"
  was removed from geo::tiles` is said instead of reading the declaration as the
  binding's own. A declaration is matched by the `alias::name` its doc comment
  names (`/** geo::tiles */`), else by name (an `Api`/`Port`/`Client` suffix
  ignored), else by the pinned interface most of its methods belong to; names
  compare ignoring case and `_`, and a declaration nothing matches (a loader, an
  aggregate handle) is the binding's own. `BINDING_UNREAD` (notice) says when a
  binding cannot be compared: not written yet, outside the root, not
  TypeScript/JavaScript (the only languages read), declaring nothing the reader
  compares (it names the export forms it cannot see into — the N-API
  `module.exports = require('./build/Release/geo.node')` one-liner among them:
  declare the producer's names in the binding itself), or its component reaches
  neither a pinned external nor a member project that exports something. Both
  ES module exports and CommonJS exports are read (`exports.X = { … }`,
  `module.exports.X = function (…) {…}` or `= X`, each property of
  `module.exports = { … }` — a shorthand `{ Client }` included —
  `module.exports = class X { … }`, a TypeScript `export = X`, and JSDoc
  `@typedef`/`@property`), a bare identifier through the module's own
  declaration of it; a `_private` class or object member is not compared, and
  an object tagged as a whole has each member judged against its tag. Return types are not compared. A binding into a contained **member**
  project (declared under `members`, never pinned — named by its alias or its
  project id) is compared the same way with what the member's L0 exports now
  (its exported contracts and types, and the types they name), so a
  `rename-param` or `rename-field` in the member reaches its parent's binding
  at `validate` time as `BINDING_DRIFT` with the rename to follow; a member is
  never told to pin — one that exports nothing is told to export there. A
  member in a `../` sibling checkout is a contained one here. A git
  member is pinned like an external (`wairon externals pin <alias>`) and
  compared with that pin. A file of another project imported directly from its
  source tree is not a binding: it is the producer's own code.
- At a project that declares members **or externals**, `validate` is the
  **family run**: every member's own gate, and this project's externals composed
  against their live producers within its root - an externals-only project has
  no member levels, so its family run is itself, and `EXTERNAL_INCOMPATIBLE`,
  `EXTERNAL_UNPINNED` and `EXTERNAL_CHECK_UNAVAILABLE` gate it as they gate a
  project with members. `--no-recursive` runs this project's gate alone (its
  externals judged against their pins). `--family` widens the reach: it
  walks up and out to a producer outside the root (a `../` sibling checkout, a
  member's parents) within the request's reach. An external whose producer lies
  outside the reach is counted in a one-line hint: at a member of a family above
  it, the hint names `validate --family`; at a project with no family above it,
  a producer it declares outside its root (a `../` sibling) keeps the advisory
  live comparison, the pin gating it (`lock-check`), with `wairon externals
  status` as the opt-in live gate;
  a run that was already explicit is told instead that the producer lies outside
  the request's reach or cannot be read, and that `wairon externals status`
  compares it live.
- **Where the network proofs run.** The proofs that need the whole family —
  `ENTRY_UNPROVEN` (a `network` entry no modelled caller reaches), the gateway
  rules for members, cross-project reach — are judged by the family run at the
  **family root** (the project that declares the members). A member validated on
  its own judges its own gate with its `network` entries counted as declared, and
  says so in one line, so a green member run is never read as a proven one. When
  the family root is on disk and in reach, a member run alone also lists the
  root's findings on it under **Network proofs, judged at the family root
  (advisory: the root gates)**, each with the project and spec it sits on and the
  severity the root gives it. They are **advisory**: printed and counted beside
  the verdict, but neither the exit code nor `--ci` (nor the MCP `valid`) ever
  decides on them - an advisory error included - so a member's verdict is the
  same with or without its family on disk; the root's own run is where they gate.
  Nothing is listed for a hosted request, or where no family root lies in reach.
  **In CI, run `wairon validate --ci` at the family root**, after installing
  the project's dependencies (`npm ci` or your package manager's equivalent —
  the gate reads TypeScript/JavaScript code with the project's own TypeScript
  when it is 5 or 6, and with the copy wairon ships otherwise;
  see [Using it in GitHub Actions](#using-it-in-github-actions)); a member in
  its own repository adds the root's run to its pipeline or relies on the root
  repository's.
- **Externals, compared live (advisory: the pin gates).** The gate judges each
  external against its pin. Then every external the run did not compose is
  compared with its **live** producer, offline, and printed in its own section:
  `EXTERNAL_LIVE_INCOMPATIBLE` (warning: a used member changed at signature
  level, was renamed — the new name is given — or is gone; it names the specs
  that use it and the fix: adapt the uses, then `wairon externals pin <alias>`),
  `EXTERNAL_DRIFTED` (notice: the producer moved, nothing used did) and
  `EXTERNAL_LIVE_UNCOMPARED` (notice: the producer could not be read — a git
  external is never fetched here; `wairon externals status` compares it). These
  findings are **advisory**: printed and counted, but neither the exit code nor
  `--ci` ever decides on them. A family run composes the externals in its reach
  as its gate (`EXTERNAL_INCOMPATIBLE`, error) and gives them no second word.
- **Planned code is a notice.** An implementation whose `sourcePath` (or a
  method's) names a file not written yet is `SOURCE_FILE_PLANNED`, and one
  naming no file is `MISSING_SOURCE_PATH` — both notices. Once realization
  begins (any file the implementation names exists) a contract method naming no
  file is `METHOD_SOURCE_PATH_MISSING` (warning). A type's file follows the
  same rule: a file only its methods name stays planned while its fields file
  exists, and only the type's OWN file missing once a methods file exists is
  `MISSING_SOURCE_FILE` (error). `rules.conformance.requireCode: true`
  in `project.yaml` reports the two notices as errors, for a CI that must say
  every designed implementation has code. It is code-conformance configuration,
  outside the approval identity: flipping it never stales a lock (see `lock-check`).
- **Code nobody designed.** `rules.conformance.sourceRoots` in `project.yaml`
  lists where this project's own code lives (project-relative; a folder is
  walked recursively, a file names itself). Files under the roots are read when
  the gate judges code, so a use or a wiring in a file no spec names still
  counts, and each such file is `UNCLAIMED_SOURCE_FILE` (warning) until a spec
  names it as a `sourcePath`. `rules.conformance.exclude` leaves paths inside a
  root out (vendored or generated code), `rules.conformance.unclaimed` carries
  today's unclaimed files as debt (the list only shrinks: an entry that is now
  claimed or no longer found is `STALE_UNCLAIMED_ENTRY`), and
  `rules.conformance.testRoots` names test folders, which are not claimed. A
  pure re-export barrel, a file that only re-exports other modules, declares
  nothing of its own and is not reported, once exact-grade analysis proves it
  one; a file it cannot prove is judged like any other. Declaring no root walks
  nothing.
- **Types are linked to code too.** A type spec without a `sourcePath` is
  `MISSING_TYPE_SOURCE_PATH` — a notice before its subsystem has code, a
  warning after. Plan a type's `sourcePath` when you plan the implementations'.
- **What the closing line says.** Plain `validate` passes with warnings and
  says so — `Passed with N warning(s)` (`--ci` fails on them); `All checks
  passed` means none. A tree holding no design yet (no L0, or an L0 with nothing
  below it) says there is nothing to check.
- **Unknown keys are reported.** A key a spec's schema does not know (an
  `exports:` table in the L0 — the export table is `publicInterfaces`; a
  misspelt field) is `UNKNOWN_SPEC_KEY`, and an unknown setting in
  `.wai/project.yaml` is `UNKNOWN_CONFIG_KEY` (both warnings): the parse would
  otherwise drop them without a word.
- **Code that crosses the design.** A call through a constructor-injected
  collaborator is collaboration whatever the import's form: when its type comes
  from a component the caller never declared, even through `import type`, it is
  `UNDECLARED_DEPENDENCY`. So is a re-export of another component's code
  (`export { x } from`, `export * from`, `export * as ns from`; a type-only
  one republishes no code), and a name imported through a barrel no component
  realizes, which is charged to the file the type checker resolves it to; a
  Portal calling a write- or lifecycle-effect method
  of a Repository, Index, Store or Registry is
  `PORTAL_WRITE_SHORTCUT_IN_CODE` (error, the code twin of
  `PORTAL_WRITE_SHORTCUT`). A Portal's calls are resolved by the TypeScript
  type checker, so how the receiver is written does not matter: the call lands
  on the method the checker resolves it to, and a call through an interface or
  type — a port declared in the Portal's own contracts file included — lands on
  every class of the project that realizes it (the ones that say `implements`
  when any does, else every class the checker finds assignable). Taking a
  method as a value counts as using it (`Reflect.apply`, a `Function`-typed
  variable, `.bind`, a callback), and code no component maps — a helper in a
  module no spec names, or a function that is none of its file's components'
  modelled methods — is read as if it were inlined where it is called; the
  finding names the path. A call the checker cannot resolve because its
  receiver is typed `any` or `unknown`, cast to either or to an index
  signature, picked by a computed key, or typed nothing, under the name of a
  data component's write (or with a computed key on a receiver that was a data
  component before the cast — however the receiver or the key is cast, and
  whether the member is invoked on the spot or taken as a value and invoked
  later), is `PORTAL_CALL_UNRESOLVED` (a warning, so `--ci` fails): give the
  receiver its type. A key the checker types as one literal
  (`const name = 'put'`) names its member by that literal. An Orchestrator (or any component) whose
  code calls a write- or lifecycle-effect method of another component that its
  narrative never claims is `UNDECLARED_WRITE_CALL`, and so is a Portal calling
  a workflow verb its narrative never names whose effect is a write — declared,
  or, where the verb declares none, read off its own narrative (a verb whose
  narrative only reads is a read; one nothing settles is reported as an
  unnarrated call whose effect is undeclared); the same unclaimed write through
  a receiver the checker cannot follow is `CALL_ORIGIN_UNRESOLVED` (a warning).
  A narrated call through a port to a collaborator whose code is not written
  yet (no file its implementations name exists) is `CALL_TARGET_PLANNED`, a
  notice like `SOURCE_FILE_PLANNED`, and is judged as usual once that code
  exists. A narrated call to another project's component (`alias::name`) is
  `CALL_TARGET_UNJUDGED`, a notice: that project's code is not read here. The narrative↔code and
  declared-edge checks read the checker too, so a type-only `ports.ts` barrel,
  `export *`, a port declared in a shared module and a dependency object typed
  inline realize the calls and edges they carry. And a file importing a technology's package
  outside the components that bind it — itself, or through a helper module no
  component maps (followed transitively; the finding names the path) — is
  `TECH_LEAKAGE_IN_CODE`. A technology's
  packages are its declared tokens (its name, or its `matches`) plus the common
  packages wairon knows for it — see [Technologies and their
  packages](#technologies-and-their-packages). An Adapter's call step to a verb
  of a Portal that declares an out-of-process transport (HTTP, gRPC, a
  database, a bus, a CLI…) is the link the design models: it is never resolved
  to the remote Portal's file, so it never reads as `CALL_ORIGIN_UNRESOLVED`;
  the call to the Adapter stays checked. Likewise the Adapter's `dependsOn` to
  that Portal is realized by the link, never reported `UNREALIZED_DEPENDENCY`:
  never add an import across a network boundary to satisfy a check.

#### Framework handlers, injected handles and routers

The parameter check pairs a verb's contract parameters with the function that
realizes it, in order. A framework handler is green without any design change:

- **Take the contract's own parameters, under its names.** `cancelOrder(req, res)`
  realizing `cancelOrder(orderId, customerId)` is two substitutions
  (`UNREALIZED_PARAM` + `UNDECLARED_PARAM`), however the handles are typed (a
  hand-written `type Req = { params: … }` included) and wherever the contract's
  types live (a member project's `shared::order_id` is read live): a parameter
  named as a transport handle (req, res, ctx, request, response, next, reply) where
  the contract declares an argument of its own is never a silent pairing. Neither
  is a platform transport class (`IncomingMessage`, a fetch `Request`) or an
  object sharing none of a record's fields where the contract declares that
  record; an object holding every field under another name is a rename
  (`PARAM_NAME_MISMATCH`), and one object carrying several of the contract's
  parameters (`cancelOrder(input: { orderId, customerId })`) leaves each of them
  unrealized.
- **A record parameter is typed as the record.** Where the contract declares a
  record, a parameter typed `any`, `unknown`, `object` or
  `Record<string, unknown>` (or not annotated at all, in TypeScript) names no field
  to compare, and an object missing the record's fields or adding its own
  (`{ stops; secret }`) is another shape: both are `PARAM_TYPE_MISMATCH`. The check
  fails closed on them, as it does on an `any` receiver. A scalar (a string, a
  number, a boolean, a date) realized by an `any`-typed parameter the body reads
  as an object (`args.habitId` where the contract declares `date`) is
  `PARAM_TYPE_MISMATCH` too; one read only as the scalar it is is not. A scalar
  parameter the code annotates as ANOTHER scalar (`authorId: number` where the
  contract declares a string, a Python `text: int`) is `PARAM_TYPE_MISMATCH`,
  naming both types, whatever either side calls it. The spellings a scalar is
  written as agree: TypeScript's `number` for an int or a float, a date, a
  datetime or a duration as a string, a `Date` or a number, an enum as a string,
  a named scalar as what it holds, and optionality set aside. A union, a named
  type the design does not know and `any` are not compared.
- **Declare what the framework hands you as wiring.** Name the handles in the
  implementation's `injectedParams` (code linkage: `sdd_update_spec`, no
  re-lock). A name matches with or without its leading `_`, at the start or the
  end of the list — `handler(ctx, req, orderId, customerId, res)` with
  `injectedParams: [ctx, req, res]`. An injection no handler takes is
  `UNUSED_INJECTED_PARAM`, a notice: it hides nothing, so drop it when you see it.
- **Or read the parameters off the request.** Where the framework hands the
  handler the request alone, inject it and read each contract parameter off it by
  its own name (`req.params.orderId`, `req.query.limit`, `req.body.code`,
  `const { orderId } = req.params`, `url.searchParams.get('limit')` on a
  `new URL(req.url, base)`): that realizes the parameter through the handle. So
  does a helper the request is passed to, written in the same file or in a module
  no implementation claims (`const { orderId } = pathParams(req)`), and the one
  record parameter is realized by reading the body whole: `req.body`, or — plain
  node:http has none — the request handed as the first argument to a function,
  any function (an imported body parser included) but a collaborator's method,
  whose result the handler binds and uses whole (`const cart = await
  readJsonBody(req)`, then passes `cart` on). A result only destructured or only
  read for fields is not the body. A parameter never read off it stays
  `UNREALIZED_PARAM`, and one left unrealized because `injectedParams` names the
  contract's own parameter says so.
- **`conformance: off`** on an implementation or a method is for code wairon is
  not meant to compare with its contract (generated or vendored code). It switches
  the realization checks off — method, parameters, async, whether narrated calls
  are found — and never the doctrine: an unnarrated write
  (`UNDECLARED_WRITE_CALL`), a call the analysis cannot follow, a Portal write
  shortcut and route coverage are judged whatever it says. A dial turned off is
  said: `REALIZATION_UNCHECKED` (a notice per implementation) and a
  `Conformance off:` line in `wairon status`.

A Portal's `router` (code linkage) names the table or function the server
actually dispatches: the entry its own file exports (`handleOrderRequest`), a
class's method as `Class.method` (`HabitPortal.handle`, the class exported), a
central module's entry or table (`src/routes.ts#routes`, or
`src/routes.ts#Class.method`), or a module alone (`src/routes.ts`, every
route-bearing export read). Where the server dispatches an aggregate spreading
each Portal's table, name the aggregate: a Portal's own table is read as it
stands, so one left out of the spread reads clean — the only signal is
`ROUTER_NOT_DISPATCHED`, a notice when a sibling aggregate of its module leaves
it out (which process dispatches which table is never read). A module-private
table or function cannot be named; `ROUTER_UNDECLARED` lists what can, and says
"export it" for the rest. Several Portals may name one router — a module, or one table both
name (`router: routes`) — and a route is declared when any of them declares it.
Guards on `<request>.method` and `parts[i]` are read, and so are route tables — an
array of `{ method, path }` objects or an object keyed `VERB /path`
(template-literal keys over constants included), bound to a const or returned in
place, spreading other tables (`[...ingestRoutes, ...statsRoutes]`) from any
module. Route coverage is never silently off: a Portal whose contract binds HTTP
endpoints and whose implementation names no router while its files hold what reads
as a router or a route table gets `ROUTES_UNCHECKED` (a warning, so `--ci` fails)
naming each spelling `router:` accepts; one whose files hold none is served method
by method and gets the `ROUTER_UNDECLARED` notice, its realizing class's public
methods judged by `UNDECLARED_PUBLIC_MEMBER`; and a router that cannot be read is
`UNREADABLE_ROUTER`. A table is read under the ONE prefix its router strips off the
path (`path.slice(BASE.length)`), so that prefix must be the Portal's `basePath`:
another one is `UNDECLARED_ROUTE` + `UNROUTED_ENDPOINT`, naming both.

Another project's code is reached through what it publishes — its member alias, a
pinned external — or through a binding module the implementation declares in
`bindings`. An import that resolves into its source under a name it does not
export is `CROSS_PROJECT_SOURCE_IMPORT` (warning); one into a module realizing its
Store is the persistence shortcut past its surface. A claimed call into a
component whose code is in another language (a Rust member behind a binding) is
not judged by the TypeScript call graph: it is said once per project and language
as `CALL_ACROSS_LANGUAGE` (notice), never as an unrealized call.

#### Technologies and their packages

`TECH_LEAKAGE_IN_CODE` compares each import's package with the packages of the
technologies an implementation binds. A design writes the technology the way
people say it (`postgres`) while the code imports its driver (`pg`), so wairon
knows the common packages of the common technologies by default:

| Technology (any of these names) | Packages |
| --- | --- |
| `postgres`, `postgresql`, `pg` | `pg`, `postgres`, `pg-promise`, `@neondatabase/serverless`, `@vercel/postgres` |
| `mysql`, `mariadb` | `mysql2`, `mysql`, `mariadb` |
| `redis`, `valkey` | `redis`, `ioredis`, `@redis/client` |
| `mongodb`, `mongo` | `mongodb`, `mongoose` |
| `sqlite`, `sqlite3` | `better-sqlite3`, `sqlite3`, `sqlite` |
| `kafka` | `kafkajs`, `node-rdkafka` |
| `rabbitmq`, `amqp` | `amqplib`, `amqp-connection-manager` |

An HTTP client (`fetch`, `axios`, `got`, `undici`) is never a technology — it is
how an Adapter reaches anything — so no entry names one. To extend the list,
write the technology as `{ name, matches }` (each `matches` token is a package
too), or have a pack contribute `technologyPackages: { <technology>: [<package>,
…] }`.

A package of a technology that **no** implementation binds is reported too:
the code uses a technology the design never placed, so every importer is
outside its (missing) home. Bind it on the data-layer component that owns the
vendor call (`technologies: [redis]`), and that component becomes its home.

### `wairon generate [--target <name>] [--domain <id>] [--domains <ids>] [--root] [--family] [--no-prune] [--global] [--dry-run]`
Reconcile the generated guides, skills and context, and — only when the project
opts in — write the agent files from the spec-derived topology.

**Agent files are opt-in.** With `rules.materializeAgentFiles` off (the default,
and what an unstated setting reads as) no agent file is written, and a run removes
the ones an earlier version wrote; agents are served as live briefs instead
(`sdd_get_agent_brief`, `wairon agent brief <id>`). Set
`rules.materializeAgentFiles: true` in `.wai/project.yaml` to keep agent files
on disk: one owner per subsystem, never one per component (the retired
`rules.generateComponentImplementers` is ignored).

- `--target <name>` limits generation to one of the project's configured
  targets (`claude`, `agy`, …); an unknown name exits non-zero and lists the
  targets the project configures.
- `--domain <id>` / `--domains <ids>` / `--root` limit it to some domains.
- `--no-prune` keeps wairon-managed agent files that left the topology.
- `--global` also writes a target whose output directory is outside the project
  root, backing up each file it replaces.
- `--dry-run` previews without writing.

`generate` writes **only this project's** outputs. A parent's topology lists a
member's agents by reference (`delegatesTo: <alias>::<agentId>`) instead of
copying them, and a brief for `<alias>::<agent>` composes at the member's own
root. `--family` also generates each member's own layer, in its own root.

### `wairon lock [-y, --yes] [--subsystem <id>]`
Review and approve the design. Validates the spec tree **as if complete** (full
strictness, no draft-status relaxation) and — only if the **design** passes —
records the current tree as approved and refreshes this project's generated
outputs (agent files only when `rules.materializeAgentFiles` is on).

**It approves; it does not change statuses.** No spec's `status` is rewritten:
approval lives in `.wai/lock.json`. Implementation gates on that approval —
`wairon lock-check` in CI, `sdd_get_status` for an AI tool — not on
`status: complete`. Commit `.wai/lock.json` with the change it approves.
When any spec is still `draft` or `design`, the lock says how many of how many,
per kind (subsystems, components, contracts, implementations, types), and that
it approves them as they stand. Approval is not status, so a design that
`wairon validate --ci` fails on can still be locked; the summary says plainly
how many findings CI would fail on (errors and warnings, code findings
included, with the draft-related warnings CI waives counted apart), or that it
would pass. Run `validate --ci` until it passes before asking someone to
approve a design meant to be finished. Re-running it when nothing it records moved
keeps the record on file — its `lockedAt` included — so `.wai/lock.json` stays
unmodified; a change of approver, verdict or member pin writes a new record. A
new wairon release writes nothing by itself: when its built-in design rules are
the same as the ones the record was taken under (the record's `gateParts.release`
is unchanged), the approval simply still matches and the record — its release
stamp included — is left as it is; when they moved, the approval carries over
by re-validation and one `wairon lock` refreshes the stamp (see *Upgrading
wairon* under `lock-check`). Evidence recorded *beside* the approval (the code
results with the analyzer's version, the design counts, gate parts, a release
stamp that is missing, no version or newer than the running wairon) is refreshed
and named; the summary says when this run left the file untouched.

**What it certifies is the design.** Only design findings can refuse a lock.
Code-conformance findings (the code↔spec checks) are recorded **beside** the
claim in the record's `code` block, with the analyzer that produced them, and
printed as `code: N error(s), … recorded beside the claim`, with the analysis
**grade** — the weakest any analyzed file got: `exact` (read with the project's
TypeScript compiler API: declarations, imports and calls resolved), `pattern`
(read through the language's declaration and import patterns — recognized, not
resolved), `generic` (word-boundary identifiers only, the floor for any
language), or `none` (no file analyzed yet: no code, or none the specs name).
CI enforces them:
`wairon validate --ci` still fails on a code error. A design can be approved
before its code exists.

**It approves this project only.** The gate identity it records covers this
project's own specs, the design doctrine, its declared inputs, its `composition`
block, and each direct member's **composition subject** — the `stateId` in the
member's own lock record. The record (format 3) lists each direct member under
`members` with its subject and state (`approved`, `drifted`, `never`). Nothing is
written below the project: each member locks at its own root. With
`composition.requireApprovedMembers: true` in `project.yaml`, the lock refuses
while a direct member is drifted or never approved, naming each.

The identity is captured **before** validating and confirmed **before** writing:
if a spec, the doctrine, an input or a member's approval moves while the lock
runs, it refuses and writes nothing. A lock never reaches below its project.

**Code linkage is not part of the approval.** The gate identity and the per-spec
digests read each spec's **design**: where it is realized — `sourcePath`,
`symbol`, `exportedVia`, `simPath`, `injectedParams`, conformance tiers, a Portal's
`router`, `externalLinks` — and the `createdAt`/`updatedAt` timestamps are left
out (`specsReading: design`). Linking code to an approved design, or a change and
its revert, never stales the lock; declare planned `sourcePath`s at design time.

**Readiness is not part of the approval either.** A spec's `status` (`draft`,
`design`, `complete`) says how far authoring is, never what the design says, so
it is left out of the design view: promoting a spec to `complete` after the lock
never reopens it. A format-3 record taken while the view still carried `status`
keeps passing when nothing but a status moved — it is judged in the reading it
was taken in, each spec's approved status recovered from its digest — and
`wairon upgrade` carries it into the current reading without a review.

A **format-2** record (written before code linkage left the approval) still passes
`lock-check` while nothing it covered moved. `wairon upgrade` re-expresses it
as format 3 in place — before any other step touches a spec — keeping
`lockedAt`, `lockedBy`, the results and the member pins, and recording
`reexpressed: { at, fromAlgorithm, fromReading, by }`. When no spec file moved
but the record still does not match, what moved is the **gate** it was judged
under — the design rules of a newer wairon release, the project's rule tuning,
`composition`, the network declaration, consumed contracts or a member's
approval — never your design: `wairon upgrade` still carries the record into the
design reading (its claim stays as certified), and the record is then judged as
any record from before gate parts is when the release changed (below). A format-2 record whose specs moved reads stale
once; one `wairon lock` clears it for good.

It writes **nothing into your spec tree**. The approval is one sha256 per spec
(over its design view) on `.wai/lock.json`, the record that was always committed — so your
teammates, a fresh clone and CI all see the same approval you gave, and
`wairon status` elsewhere can name what has drifted from it. Keys are sorted, so
re-approving a one-spec change shows up as a two-line diff. A failed or
cancelled lock changes nothing at all.

`lockedBy` records who approved **and how that identity was established**: your
git author identity where there is one (so a reviewer can match it against the
author of the commit carrying the lock), else `user@hostname`. On a hosted
instance it is the authenticated subject. None of it is proof — the commit that
introduces `lock.json` is what carries that.

Before approving, it reports what moved since the last approval — the question
a human is actually answering:

```
3 spec(s) changed since the last approval:
  ~ sdd_core/spec_loader/.index.yaml
  ~ sdd_core/spec_loader/.interface.yaml
  + sdd_core/spec_index/.index.yaml
```

`--yes` skips the confirmation (for CI). `--subsystem <id>` *re-approves* one
subsystem of an approved design: the identity a lock certifies is always the
whole design's, so it is refused as a first approval (run `wairon lock`), and
refused whenever a spec outside the subsystem — or an input the identity covers
besides the design (rule tuning, packs, network, a pin, a member's approval,
the release) — moved since the approval; when it passes, the rest stays approved
exactly as it was, and the record is the one a full lock would write. A
member project's subsystem (`--subsystem payments_svc::payments` at a parent) is
refused: a member's subsystem is approved at the member's own root
(`wairon lock --subsystem payments` in its folder), then the parent locks to pin
its new approval. When
nothing changed, `lock` leaves the approval on record as it is — its `lockedAt`
and restamp trace — and `.wai/lock.json` untouched by that run; only evidence
recorded *beside* the approval (the code results, the design counts, gate parts
that are missing or do not match the identity, a release stamp that is missing,
no version or newer than this wairon — replaced with this release) is refreshed,
and it says which. When a lock records the project's own inputs for the first
time (a first approval, or a record from before gate parts) or the rule tuning
or packs moved, it prints the inputs it records — projectType, each rule
severity override, the selected packs, a declared network, `composition` — so
the tuning you approve is shown, not only digested.

**In a family, lock bottom-up.** A parent's record pins each member's approval,
so lock every member that is not approved at its own root first, then the
parent: three projects cost three locks. A parent locked first records the
member as drifted, its `lock-check` fails until the member re-locks, and it
must lock again to pin the new approval — `lock` warns before it writes when a
direct member is not covered by its own approval.
Another approver locking an unchanged design records their own approval. A shell
with no terminal and no `--yes` writes nothing.

### `wairon lock-check [--strict]`
The **merge gate**. One question, one exit code: *is the design in this working
tree the design that was approved?* It compares the tree's gate identity against
the one recorded in `.wai/lock.json` **as it is in the working tree**. In CI that
is the file committed in the checked-out revision; locally an uncommitted lock
record counts too, so commit it before you rely on a local pass.

| What it finds | Default | `--strict` |
| --- | --- | --- |
| **`locked`** — the approval still covers this design | pass (0) | pass (0) |
| **`stale`** — the design moved past its approval | **fail (1)** | **fail (1)** |
| **`unlocked`** — nothing was ever approved | pass, with a notice (0) | **fail (1)** |
| no `.wai/specs` in this directory at all, and no approval on record | pass, saying so (0) | **fail (1)** |
| no `.wai/specs` (or none left), while `.wai/lock.json` approves spec files | **fail (1)**: the tree was deleted | **fail (1)** |
| `.wai/project.yaml` missing while an approval is on record | **fail (1)**, naming the file | **fail (1)** |
| a member project's own approval does not cover it (spec changes, inputs that moved, a record that predates recorded inputs) | **fail (1)**, in the member's own terms | **fail (1)** |
| a member project was never approved by anyone | pass, naming it as *not gated* (0) | **fail (1)** |
| only a member's own approval moved (it re-locked) | **fail (1)**, naming the member: re-lock here to pin its new approval | **fail (1)** |

**What plain `lock-check` guarantees:** that a *committed* approval still covers the
design, and that no member project carries unapproved changes. Nothing more: a
project with no `.wai/lock.json` — never locked, *or the record deleted in the
pull request* — passes, because it reads exactly like one that never opted in.
**In CI, run `wairon lock-check --strict`** (or the reusable workflow with
`strict: true`) once the project has been locked: then a missing record, or a
member nobody ever approved, fails.

**Members.** The gate identity pins each direct member's *recorded* approval, so
the root reads every member project's own approval at its own root too. A member
whose specs moved past its own approval fails the root's check — run `wairon lock`
in that member's folder. A member that re-locked is expected (its own approver
signed it off), and the root is judged by whether its pin of the member is still
the member's approved one: after a member re-locks it is not, and the verdict says
exactly that — no own spec moved, run `wairon lock` here to pin the new approval.
A member whose release stamp `wairon lock` only *refreshed* (a restamp) has not
re-approved anything: the root pins the subject of the member's human approval,
which the restamp keeps (`restamped.subject`), so a family carries an upgrade
over at every root without one re-approval.

**Upgrading wairon never stales an approval by itself.** A lock records each
input of its gate identity on its own (`gateParts`: the design, this release's
built-in rules, the project's rule tuning, its packs, the network declaration,
`composition`, consumed contract pins, members' approvals). When only the
release's built-in rules moved — the approved design and every input the project
decides are as approved — the approved design is **re-validated under the new
rules in the same command**: clean at the `--ci` standard (no error, no warning
but the draft-related ones `--ci` waives; notices never count) the approval
*carries over* and nothing is written — `lock-check`, `status`, `sdd_get_status`,
`validate` and the family view all say *approved under <old>, re-validated under
<new>: still approved*, and one `wairon lock` refreshes the record's release
stamp (`restamped`) without asking for a re-approval. When the new release
changed no built-in rule at all, there is nothing to re-validate: the approval
holds as it is, and `lock-check`, `status` and `validate` say so in one notice
(*approved under wairon <old>; this release (<new>) judges the design by the same
rules*). If the new rules find
errors or warnings, the approval is stale for exactly those: *the new release
finds N issue(s) in the approved design: …*. The project's own rule tuning,
packs, network and pins stay in the identity: changing one still stales the
approval, and the verdict names the input that moved (*the network declaration*
after `wairon network declare`). Only a record that *proves* the project's own inputs unchanged
carries over. A record from before gate parts (every record written before wairon recorded them) cannot — its rule tuning, packs and pins are only inside its digest — so
it never carries over automatically: it is stale with one sentence, *approved
under <old> before wairon recorded its inputs separately — re-lock once to record
them; later upgrades then carry over*, and `wairon lock` takes a real approval
(never a restamp). The same holds for gate parts that do not break down the
`stateId` beside them (they are ignored, with a notice; when the identity still
matches, `wairon lock` rewrites them keeping the approval), and for a release
stamp that is no wairon version or is *newer* than the running wairon when the
identity no longer matches — a record *written by a newer wairon* is never
re-judged by an older one. When the identity still matches, the identity
decides: the approval holds, and every surface (`lock-check`, `status`,
`sdd_get_status`, `validate`) reports the stamp as a notice (`its release stamp
"banana" is no wairon version`, `… says wairon 9.9.9 took it, a newer release than
this one`); `wairon lock` replaces it with the running release. A matching
record that carries no gate parts at all gets the same notice `{}` gets, and
`lock` rewrites them. A `lock.json` that names one key twice (what a careless
conflict resolution leaves) cannot be read, like one with conflict markers.

**What the identity covers, and what it leaves out.** The project's own *design*
rule tuning — `projectType`, `sddRuleSeverity` overrides of design rules, the
other design settings under `rules` — its pack selection, network declaration
and `composition` are inputs: changing one stales the approval. A selected pack
that cannot load (not installed, not vendored) leaves the approval *owed* —
`lock-check` fails, naming the pack — because the doctrine it was judged under
cannot be read. **Code-conformance configuration is deliberately outside the
identity:** `rules.conformance` (`requireCode` included) and severity overrides
of rules that judge code govern how the *code* is held to the design, not what
the design is, so flipping `requireCode` changes what `validate --ci` fails on
and never stales an approval — exactly as adding a `sourcePath` never does. The
analyzer's doctrine is recorded beside the claim (`code.analyzer.doctrineDigest`)
instead.

**It is optional by construction.** By default only a moved approval (or a
member's unapproved changes) refuses, and neither can happen in a project that
never locked — so adding this to an existing repository's CI cannot make it start
failing. `--strict` is what turns "never approved" into a failure, and a project
has to ask for it — which is why a project that has locked should run it strict.

It is **not** `wairon validate`. Validate asks whether the design is *legal* and
runs the whole rule set to answer; this asks whether it is *approved* and reads
one JSON file, which is why it is safe to run on every pull request. The two are
independent — a tree can be approved and illegal, or legal and unapproved — so
run both.

It gates on the **gate identity** (the hashed parsed tree plus the governing
doctrine), not on the per-spec content digests the same lock record carries.
Those answer "has this file changed since you approved it": a whitespace-only
edit moves them, and a gate that demands a re-lock for reformatting is one people
learn to bypass.

**What it proves:** that the design in the commit being merged is the design that
was approved. **What it does not prove:** *who* approved. `lockedBy` is a claim,
not an attestation — anyone who can run the CLI can write a lock record. Pull
request review is what establishes who reviewed; this establishes that the thing
merging is the thing that was reviewed.

#### Using it in GitHub Actions

This repository publishes it as a **reusable workflow**. Pin it — and the CLI it
installs — to **the version you lock with**: the one `wairon --version` prints
where you run `wairon lock`. Every published version has a git tag `v<version>`
and the same version on npm: a release `X.Y.Z` is `@vX.Y.Z` with
`wairon-version: 'X.Y.Z'`; a dev build `X.Y.Z-dev.N` is `@vX.Y.Z-dev.N` with
`wairon-version: 'X.Y.Z-dev.N'` (the npm `dev` dist-tag names the newest dev
build, but it moves — pin the exact version). Check that the version you pin is
on npm before you commit the job: `npm view @wairon/cli@<version> version`. The
workflow and the `lock-check` command first ship with 6.0.0 and its dev builds;
an older version has neither. Below, `<version>` stands for yours. Add one job
to your own workflow:

```yaml
# .github/workflows/ci.yml in YOUR repository
on: [pull_request]

jobs:
  approved-design:
    uses: SYW-Apps/Waffle-AIron/.github/workflows/lock-check.yml@v<version>
    with:
      wairon-version: '<version>'
      strict: true      # a deleted .wai/lock.json fails instead of switching the gate off
```

With inputs (all optional):

```yaml
  approved-design:
    uses: SYW-Apps/Waffle-AIron/.github/workflows/lock-check.yml@v<version>
    with:
      working-directory: packages/api   # where the .wai/ tree lives (default: .)
      wairon-version: '<version>'       # the version you lock with, or an npm dist-tag (default: latest)
      strict: true                      # fail when nothing was approved — use it once you have locked (default: false)
      validate: true                    # also run `wairon validate --ci` there (default: true)
      install: auto                     # the project's dependencies before validate: auto | none | <command> (default: auto)
      node-version: '24'                # (default: '24')
      runs-on: ubuntu-latest            # (default: ubuntu-latest)
```

Pin `@<ref>` to a **tag**, never to `main` or `dev`. A moving branch means the
check that gates your merges can change under you between two runs of the same
commit — and this one decides whether code merges. Pin `wairon-version` too, to
the version you lock with: the gate identity's algorithm can change between
releases, and the default `latest` moves.

On a `pull_request` event the default checkout is the merge commit, so what the
gate judges is literally the design that would land.

A ready-to-copy strict version — `strict: true`, `validate: true`, pinned to a tag
— is [`examples/ci/strict-gate.yml`](https://github.com/SYW-Apps/Waffle-AIron/blob/main/examples/ci/strict-gate.yml). The approval is
only as meaningful as the repository protections around it, because `lockedBy` is a
claim: protect the default branch, require pull-request review, put a CODEOWNERS
entry on `.wai/lock.json` and `.wai/specs/` and require code-owner review, and
require the status checks of both jobs (the approved-design job and your own build).
A workflow can only fail a job; making it block a merge is a branch-protection
setting.

After the approval check the job runs `wairon validate --ci` in the same
directory (`validate: false` turns it off). Point `working-directory` at the
**family root** — the project that declares the members — so that run is the
family run, which judges the network proofs no member's own gate can.

**The project's dependencies come first.** The conformance gate reads
TypeScript/JavaScript code with the project's own TypeScript compiler when it is
TypeScript 5 or 6, and with the copy wairon ships otherwise — a fresh checkout,
a project without TypeScript, or one on TypeScript 7 (whose native compiler has
no JavaScript API) is still read at exact grade, and `CONFORMANCE_DEGRADED` is
left for a file the compiler could not read at all. Installing the project's
dependencies keeps the analysis on the project's own compiler. So before
`validate --ci` the job
installs them with the project's own package manager (`install: auto`, the
default): nothing without a `package.json`; otherwise the nearest lockfile from
`working-directory` up to the repository root decides — `package-lock.json` →
`npm ci`, `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` →
`yarn install` (`--immutable`, or `--frozen-lockfile` for Yarn 1). `install:
none` skips it; any other value is run as the install command. The approval
check alone (`validate: false`) installs nothing.

#### Without the reusable workflow

The same gate as plain steps — for another CI system, or a job of your own. For
a TypeScript/JavaScript project with code, **install the project's dependencies
before `wairon validate --ci`** (`npm ci`, `pnpm install --frozen-lockfile` or
`yarn install --immutable`, whichever your lockfile is for):

```yaml
# .github/workflows/design.yml in YOUR repository
on: [pull_request]

jobs:
  design:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npm install --global @wairon/cli@<version>   # the version you lock with (wairon --version)
      - run: wairon lock-check --strict
      - run: npm ci                                    # the project's dependencies: the gate reads your code with your TypeScript (5 or 6)
      - run: wairon validate --ci
```

**A failing job does not block a merge on its own.** A workflow can only fail;
making a failing job stop a merge is a branch-protection / ruleset setting on
your repository ("Require status checks to pass" → add this job). No workflow
can declare that for itself.

### `wairon doctor [--fix] [-y, --yes] [--global]`
Health check: flags stale generated guides/skills, an unregistered MCP server,
unfinished family-migration transactions, spec-tree issues and a tree written by
another wairon major. The **Major** check reads the tree's `waironMajor` stamp
against the running wairon: current passes, an older tree is an error naming
`wairon upgrade` (the fixes and the commands wait for it), and a newer or
out-of-window tree names the release to install.

`--fix` finishes unfinished transactions, regenerates stale in-project
guides/context/skills, repairs narrative steps carrying a field their type cannot
have, regenerates stored signatures, rewrites type spellings, and registers the MCP
server. It is skipped, with a warning naming `wairon upgrade`, for a tree whose
standing is not current. It no longer migrates anything between majors: renaming
legacy spec files, re-expressing the lock, retiring Specialists, the reachability
model and the chaining migration are steps of `wairon upgrade`. A write outside the
project root (a machine-wide MCP config) also needs `--global` (`--yes` answers its
confirmation in a script); each file it replaces is backed up beside itself.

In a family, `--fix` runs the same per-project repairs in every member project inside the
project root, each line marked `[alias]`: its specs, and its agent surfaces (the project
`.mcp.json`, the injected guide, the `.wai/context` documents and the skills), so an assistant
opened in a member's own folder has the wairon tools. The member never asks for a second
machine-wide write; the top's plan covers it. A member in a sibling checkout is named with the
command to run there. Plain `wairon doctor` lists what is pending per member, agent surfaces
included, and warns when the MCP entry would start a different wairon than the running CLI.

Among its spec repairs, `--fix` rewrites every stored type position that is an
alias of its canonical spelling (`string[]` becomes `list<string>`, `boolean`
becomes `bool`, `T | null` becomes `T?`, `Promise<T>` becomes `async T`) — what
any later save would write. It never guesses: a `number` position whose name
says a whole number (`count`, `maxDepth`, `port`) gets `int` *proposed* and
listed, and every position no rewrite can settle (an inline function type, a
literal union, a union mixing in a primitive, a `number` with no proposal) is
listed with its replacement for an author. Plain `wairon doctor` prints the same
plan without writing it.

**Older forms.** A release reads only its own major's forms; `wairon upgrade` moves an older
tree. Deprecated flags and aliases are removed, not kept.

### `wairon upgrade [--report] [-y, --yes]`
Moves a project (and every member below it) written by an older wairon major to the
running one. Every project's `.wai/project.yaml` carries a `waironMajor` stamp; a tree
with none was written by the oldest major the release can still read. The command plans
the whole family on a private copy first, prints each project's standing, every rewrite
per project and spec with the ones that change the approved design marked, what only an
author can decide, and a short account of what the new major changes, then applies the
plan all or nothing. A plan that only moves the stamp needs no confirmation; any other
asks (`--yes` answers it in a script; a non-interactive run without `--yes` writes
nothing and says so). `--report` prints the plan and writes nothing. A failure leaves
every file as it was. Each project whose approved design moved is named with the
`wairon lock` to run at its root; the upgrade never locks. A tree this release cannot
upgrade (a newer major, or one older than the oldest kept step) is refused, naming the
release to install.

Every command that acts on a project checks the tree's standing first: a tree an older
major wrote is offered the upgrade on a terminal (a stamp-only upgrade is applied without
asking) and otherwise refused naming `wairon upgrade`; `upgrade`, `whatsnew`, `doctor`,
`init`, help/version and the commands that act on no project are exempt.

### `wairon whatsnew [version]`
Prints the curated release notes of a version (the running one by default) and the link
to the full changelog. On a terminal, the first command run after an update prints the
notes since the version last seen on the machine (recorded in `~/.wairon/config.json`),
newest first, once; it stays silent under `--silent`, `CI` and any non-interactive run.

### `wairon list` (alias `ls`) / `wairon show <id>`
List, or show full details of, the agents resolved from the spec tree
(`system-architect`, `<subsystem>-owner` and owners for free-standing domains).
A component's own brief is composed on demand (`wairon agent brief <component>`).

### `wairon agent brief <id>` / `wairon agent customize <id>`
`brief` prints the live delegation brief for one agent — the same composition
`sdd_get_agent_brief` returns, rendered from the current spec tree on every
call. `customize` scaffolds the user-owned guidance file `.wai/agents/<id>.md`,
which later briefs for that agent include.

What a brief fences, for an agent that implements components (a component's
implementer, a subsystem owner):

- **Code write fence** (`codeFence`) — exact files, never a folder glob: the
  files the agent's specs alone name — its implementations' and methods'
  `sourcePath`s, `simPath` harnesses and `bindings`, and the files of the types
  it owns (a component's `componentClass` types and the types only its own
  contracts use; an owner's subsystem types). Planned files are marked
  `(planned — create it)`. A file another component's (for an owner, another
  subsystem's) specs also name belongs to no single fence, so sibling fences
  never overlap.
- **Shared** (`sharedPaths`) — files the agent may touch but does not own: the
  files its specs name that other specs name too (a shared type module,
  created at its planned home exactly as its spec declares it), the setup files
  from the project root down to its code (`package.json` and its lockfile,
  `tsconfig.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`), the package or
  crate roots there (`index.ts`, `lib.rs`, `main.rs`, `mod.rs`, `__init__.py`)
  and up to eight unnamed source files beside its own. The brief states the
  rule: touch a shared file, or one no spec names (a helper, the composition
  root, test setup), only for this component's needs and name it in the
  report; one that would need a responsibility of its own is a design change —
  stop and report it.
- **Read paths** (`readPaths`) — for an implementer: the system spec, its own
  component, contract and implementation specs, the specs of the types its
  contracts use (and of the types their fields name), its dependencies'
  contracts and the files realizing them, and the pinned snapshot of each
  external it reaches.

A consumer's brief also names, under *Externals used*, the binding modules its
implementations declare (see *Binding modules* under `wairon validate`).

### `wairon rules list`
List the SDD conformance rule registry — every rule group, the issue codes it
can emit, default severities, and any per-project overrides from
`rules.sddRuleSeverity`. The gate is a documented architecture linter: each
rule is a self-contained module in `src/core/rules/`. Rules injected by
extension packs are listed too, tagged with their pack.

### `wairon execution show` (alias `ls`) / `wairon execution set-tier <tier>`
Execution budgets — the resource axis of the derived topology. Where authority
says which paths an agent owns, a budget says what its work costs to do:
a capability tier, a reasoning effort, a turn ceiling, a tool class, and
whether it may delegate further or load MCP servers.

`show` lists every agent's allowance next to the rationale that produced it
(component stereotype, owned-path breadth, role), so a tier choice is auditable
rather than magic. It also flags any agent an override has pinned to the
`frontier` tier — derivation never selects it.

`set-tier` moves the aggressiveness dial and states what the new tier costs:

| Tier | What it does |
|------|--------------|
| `off` (default) | No budgets derived. Output is byte-identical to before this feature existed. |
| `free` | Structural constraints only — tool class, MCP access, nested delegation. No model or effort selection, so no quality tradeoff at all. |
| `default` | Adds capability-tier selection per role and turn ceilings. Mechanical work (Store, Index, Registry, Adapter) runs smaller; work carrying decisions (Orchestrator, Supervisor) keeps the capable tier. |
| `trade` | Adds effort reduction on mechanical work and steps standard work down a tier. Real but bounded quality cost. |
| `aggressive` | Small tier for everything but deep reasoning, halved turn ceilings. Expect partial results and worse judgment. |

Raising the dial can only tighten a budget, so it is safe to turn without
auditing every agent. Per-agent overrides live in `.wai/project.yaml` under
`execution.overrides`.

### `wairon pack …`
Extension packs — plain config files (YAML, or a JS module for programmatic
rules) injecting custom profiles, language/platform tables, and conformance
rules (see [Extending wairon](extending-wairon.md)). 

| Command | Description |
|---------|-------------|
| `wairon pack init <name> [--kind declarative\|code] [--dir <path>] [--skill]` | Scaffold a new pack project |
| `wairon pack build [source] [--out <file>]` | Build an installable `.wpack` archive from a pack directory |
| `wairon pack install <source> [-y]` | Install a pack (`.wpack`/`.zip` or a directory) into this machine's pack store. It applies to nothing until a project selects it |
| `wairon pack uninstall <name>[@version]` | Remove a pack from the store |
| `wairon pack use <name>[@version] [--source <url>] [--pin] [--bundle] [-y]` | Select an installed pack for this project, recorded in `.wai/project.yaml` |
| `wairon pack unuse <name> [-y]` | Deselect a pack for this project (it stays installed) |
| `wairon pack impact <name>[@version]` | What a pack changes here, writing nothing (below) |
| `wairon pack sync` | Install every declared-but-missing pack from the source its selection records — what a fresh machine or CI runner needs |
| `wairon pack bundle [name] [--all]` | Commit a copy of a selected pack under `.wai/packs/`, so a clone and CI need no pack store |
| `wairon pack which <name>` | Which installed pack a name resolves to: version, path, digest, origin |
| `wairon pack list` | Global and project packs and what each provides, with load errors inline |
| `wairon pack add <source> [--global]` / `wairon pack remove <name> [--global]` | Vendor a pack file or directory into `.wai/packs/` (or install it machine-wide), or remove it |

The vendoring commands in detail:

- `add <source>`: verify the pack loads, then vendor it into `.wai/packs/`
  and register it in `project.yaml → extensions.packs` (commit `.wai/` so CI
  and every clone enforce it). With `--global`, install machine-wide into
  `WAIRON_PACKS_DIR` / `~/.wairon/packs` — auto-loaded for every project on
  this machine (project packs win on collision; a project opts out via
  `extensions.useGlobalPacks: false`). A source may be a file or a directory
  with a pack entry file (`pack.yaml` | `pack.cjs` | `index.cjs` | …).
- `list`: global + project packs and what each provides (profiles,
  languages, rules), with load errors inline.
- `remove <name>`: deregister by pack name and delete vendored files under
  `.wai/packs/` (files elsewhere are left in place); `--global` removes a
  machine-wide pack.

The store and selection commands (`install | uninstall | which | use | unuse |
impact | bundle | sync`) are described in
[Extending wairon](extending-wairon.md#installing-and-selecting-packs).

`wairon patterns list` lists the reusable, versioned architecture patterns the
loaded packs declare; `wairon variants list` lists the component variants (each
anchored on a base block, with its implementation guidance).

### `wairon pack impact <name>[@version]` — and confirm before every pack write
Packs exist to adjust wairon's checks and behaviour, and a pack may loosen or
remove them by design (an automation platform cannot hold every concept a full
backend can). So installing a pack is never judged — but it is always
intentional, and its impact is shown first.

`wairon pack impact` shows, writing nothing, what a pack changes on this
project:

- its **doctrine against wairon's defaults**, by the profile that carries each
  change: rules loosened, raised, turned off or added; profiles added or a
  builtin redefined; stereotypes removed or discouraged, edges licensed,
  patterns, guarantee tokens and language tables added;
- the **profiles of it that would govern** here (the `projectType` and each
  subsystem profile that names one);
- the **findings that change** on this project — introduced, resolved and
  regraded, from a dry validate of the current and the candidate
  configuration — with both totals.

A pack this project does not apply (or applies at another version) is measured
as applied; one it applies exactly as asked is measured as removed, so the
report reads as what the pack accounts for now. Nothing in the report is a
finding.

Every command that selects, updates or removes a project's pack — `pack use`,
`pack unuse`, `pack add`, `pack remove`, and `pack install` when it moves this
project's floating selection — **shows the same report and asks before it
writes**; anything but yes writes nothing. In a script, pass `-y, --yes`: the
write happens without the report, and the command says it applied without
showing it. A run with no terminal to ask on (CI, a pipe) behaves the same way.

### `wairon diagram [--format <fmt>] [--subsystem <id>] [--sequence <component:method>] [--depth <n>] [--types] [--group <id>] [--all] [--out <path>] [--no-health]`
Generate architecture diagrams derived from the spec tree — living
documentation from the same source of truth as the conformance gate. Every
format writes a file (by default under `.wai/docs/diagrams/`; `--out` names
another file or directory); nothing opens automatically.

- **default (no flags): the interactive canvas** (`canvas.html`).
- `--format mermaid` (or `--subsystem <id>`): system-wide or scoped Mermaid
  **component diagram** as a markdown file (subsystems as subgraphs,
  `dependsOn` edges, thick edges for boundary hops, dashed `owns`
  containment, bold border on the published surface). Use a `.mmd` `--out`
  path for raw Mermaid.
- `--subsystem <id>`: scope to one subsystem plus its directly-connected
  external neighbors.
- `--sequence <component:method>`: a **sequence diagram** derived from the
  method's L5 narrative, recursively expanding `call` steps (cycle-guarded,
  `--depth` limits expansion; default 3).
- `--canvas`: an **interactive HTML canvas** — the whole system on one page.
  Subsystems as containers, pattern compounds nested inside, components laid
  out in dependency layers (entrypoints left → data right), subsystems in
  topological order (callers left of providers) with barycenter
  crossing-reduction so links stay short and untangled. Pan/zoom,
  double-click a boundary to collapse it (its external edges aggregate into
  labeled "tubes"), click anything for a spec-derived detail panel
  (description, interfaces, methods, endpoints, narratives, dependencies,
  trusted links), search, and a validation-issue overlay. The computed
  layout is locked by default — enable "rearrange" to drag, "reset layout"
  to undo — and "export PNG" renders the full graph to a high-res image for
  Miro/docs/slides. Fully self-contained (Cytoscape.js embedded inline,
  works offline).
- `--types`: the **type groups overview** as Mermaid (`types/index.md`): one
  node per type group with the types it holds, child groups inside their
  parent, an Ungrouped node, and the references between two groups added up
  into one counted edge.
- `--group <id>`: one type group's types as a Mermaid **class diagram**
  (`types/groups/<parent>/<group>.md`): fields, enum values and methods, an
  edge per reference labelled with the field or method, and each type it
  references in another group as a stub naming that group. Only the
  project's own types are drawn. `--types` and `--group` are Mermaid only:
  the canvas already folds types by group.
- `--format <mermaid|canvas|drawio|excalidraw>`: friendly alias for the flags below/above.
- `--drawio` / `--excalidraw`: **editable** exports in open formats
  (draw.io / diagrams.net XML, Excalidraw scene JSON) with the exact same
  computed layout as the canvas — import into diagrams.net, excalidraw.com,
  VS Code extensions, or any whiteboard tool that accepts these formats.
- `--all`: write the full set (system, per-subsystem, one sequence per
  entrypoint method with a narrative, the type groups overview, one class
  diagram per type group and one of the ungrouped types, plus `canvas.html`,
  `architecture.drawio`, and `architecture.excalidraw`) into
  `.wai/docs/diagrams/` (or `--out`).
- `--no-health`: skip comparing each consumption relation with its live
  producer; the canvas draws those edges as not checked.

The files under `.wai/docs/diagrams/` are derived from the spec tree and
rewritten by every run; wairon never reads them back. Commit the folder if you
want the diagrams browsable on GitHub and in review, or add it to `.gitignore`.
The command says so after each run that writes to the default folder.

The canvas is a small single-page app with **C4-style scoped navigation**:
each view renders one scope's direct children (System → subsystems →
components → pattern members, infinitely deep by ownership); double-click
drills in, the breadcrumb navigates back, "Internals" previews children
inside boxes, "Externals" shows out-of-scope references as ghosts. Plus
SYW/light themes, presentation mode, per-view layout persistence,
narrative flowcharts with call drill-down, and an Export menu
(PNG / draw.io / Excalidraw) capturing the current view and layout.

### `wairon export [--out <file>]`
The whole design, resolved, as one JSON document for generators,
translators and documentation tools (format `wairon-design`; the
[format page](design-export.md) describes every field, the compatibility
promise and how a consumer follows renames).

- It first decides the approval verdict exactly as `wairon lock-check` does
  (not strict) and stamps it as `source.approval` (`locked`, `stale` or
  `unlocked`) and `source.approved`. An unapproved tree is exported too,
  carrying its state.
- Without `--out` it prints the JSON to stdout and nothing else, so it pipes
  cleanly (`wairon export | jq .components`). With `--out` it writes the file
  and reports the path and the approval state.
- Member projects are listed under `dependencies`, never inlined: export each
  from its own root. So the top of a family that holds no design of its own
  exports no components. It names its members (on stderr without `--out`), so
  that does not read as an empty design. A part's subsystems are the project's
  own and are exported with it.
- Deterministic: the same tree and verdict give byte-identical output.
- A tree without an L0 is refused. The JSON Schema ships in the package as
  `schemas/design-export-1.json`, and the library twin is `exportDesign()`.

### `wairon type rename-field <type> <field> <new-name> [--dry-run] [--search <dirs...>]`
Renames a field of a type and respells every reference to it — each foreign
key `references: <type>.<field>` naming it, the type's own included. The field
keeps its place, type and description; its old name joins the field's rename
trace (`previousNames`), which `wairon export` shows as `formerly`, so a
consumer holding the old name reads a rename, not a removal and an addition.
Traces and prose are never rewritten: the specs whose prose still spells the
old field — the type itself, and every spec with the type in view (naming a
type that carries the field, a contract naming one, or an implementation of
such a contract) — are listed as mentions to respell by hand, as the method
rename lists its own. It refuses, writing nothing, a type or
field that does not exist, a name that is not an identifier or that the target
language reserves for a field (`fn` in Rust), and a name another field of the
type holds or retired. It names every export a consumer reaches the field
through — an exported type that is, or embeds, the renamed type, and an
exported contract whose methods name one — and every consumer whose specs reach
one of them (the family in reach, members included): their code reading the
old name breaks. `--dry-run` prints all of that and writes nothing;
`--search <dirs...>` also scans these folders for consumer checkouts outside
the family. The MCP twin is `sdd_rename_field` (with `dryRun` and
`search`). As with any design edit, the next `wairon lock` approves it.

### `wairon method rename <component> <method> <new-name> [--dry-run] [--search <dirs...>] [--no-pin-symbol]`
Renames a contract method and retargets every reference to it in the bound
tree. The method moves on every interface of the component that declares it,
and on the implementations of those contracts with its narrative, source path
and symbol; call, register and dispatch steps, dispatch-table bindings,
lifecycle entrypoints, the lint allows keyed on it and the debt register
(`rules.conformance.carried`) follow. Its old name joins the method's rename
trace (`previousNames`), which `wairon export` shows as `formerly`, so a
consumer reads a rename, not a removal and an addition. Prose and a gRPC wire
method are never rewritten; they are listed as mentions.

- `--dry-run` prints what the rename would move, retarget and break — every
  consumer that calls the method through an export, by project and spec — and
  writes nothing. Run it first on a published verb.
- `--search <dirs...>` also scans these folders for consumer checkouts outside
  the family (for example the folder holding sibling checkouts), so the dry run
  names a sibling project the rename breaks.
- `--no-pin-symbol`: by default an implementation that declares no `symbol` is
  pinned to the OLD name, so the function its code already holds keeps binding.
  Pass it when the code is not written yet, or will be renamed with the
  contract, so the implementation follows the new name.

It refuses, writing nothing: a component that does not exist, one in another
project (rename it from that project's root), a method the component does not
declare, a name a moving contract already declares or retired, and a new name
that is not an identifier in the tree's method casing (snake_case in a Rust or
Python tree, camelCase in a TypeScript one), that is longer than 64 characters
or starts with a digit, or that the target language reserves for a method
(`constructor` in TypeScript, `fn` or `type` in Rust — the refusal names the
language and offers an alternative). A contract that implements another
project's extension point takes its method names from that producer, so its
casing is not judged. The MCP twin is `sdd_rename_method` (with `dryRun`). The
next `wairon lock` approves the rename.

### `wairon method rename-param <component> <method> <param> <new-name> [--dry-run] [--search <dirs...>]`
Renames a parameter of a contract method. The parameter moves on every
interface of the component that declares the method, keeping its place, type,
description and optionality; its old name joins the parameter's rename trace
(`previousNames`), which `wairon export` shows as `formerly`, so a generator or
consumer reads a rename, not a signature change. Each signature is re-derived
from the params (a method whose `signatureFrom` names this one follows by
itself), and an HTTP endpoint path placeholder `{old}` (or `/:old`) is
respelled on the method's own binding and on every method whose
`signatureFrom` takes its signature — the URL a caller sends is unchanged.
Prose is never rewritten. It names the exports publishing the method — and
every export publishing a verb that forwards it through `signatureFrom` (the
Portal verb an architect writes for each orchestrator method) — and every
consumer that calls it there (the family in reach, members included), a
consumer whose call still names a former method name included. Asked of a
Portal verb that takes its signature from another of this project's methods,
it renames the parameter on that source and says so: the rename reaches the
verb through its `signatureFrom`.
`--dry-run` prints all of that and writes nothing; `--search <dirs...>` also
scans these folders for consumer checkouts outside the family. It refuses, writing nothing, a component, method or parameter that
does not exist (or a parameter the method takes from another project's method or
a signature type — the refusal names that source), a name
that is not an identifier or that the target language reserves for a parameter
(`class` in TypeScript, `type` in Rust), and a name another parameter of the
method holds or retired. The MCP twin is `sdd_rename_param` (with `dryRun`
and `search`). The next `wairon lock` approves it.

### `wairon network flows|policy|diagram|check|why|declare|undeclare`
Networking derived from the design: the reach the validator already models
(modelled calls, Portal entries and their scopes, declared networks and their
gateways), never addresses. Run at the family root.

- `flows [--format json|csv|markdown] [--out <file>]` prints the allowed-flows
  matrix, narrowed to the modelled callers wherever the family proves a
  `network` entry.
- `policy --bindings <file> [--out <file>]` generates Kubernetes
  `NetworkPolicy` from the matrix and a bindings file you keep outside
  `.wai/`. Names it cannot bind are listed, never guessed.
- `diagram [--out <file>]` prints a Mermaid flowchart of the networks as
  trust boundaries, with the gateways, outside and the flows.
- `check --observed <file> [--bindings <file>]` compares observed live flows
  (CSV or JSON) with the matrix. It exits 1 on an unexpected flow or an
  unknown verb.
- `why <from> <to>` prints the modelled chain behind one flow. It exits 1
  when nothing allows it.
- `declare [--description <text>]` writes the project's `network` declaration
  into `.wai/project.yaml`; `undeclare` removes it (the assistant's twin is
  `sdd_set_network`). It changes which rules fire: validate, then re-lock.

[Derived networking](network.md) describes every output, the bindings file
and the observed-flow format.

---

## Members

A project's **members** are declared in its `.wai/project.yaml`, each by one
location key:

```yaml
members:
  scheduler: services/scheduler                          # contained
  admin: ../admin                                        # a sibling checkout
  payments: git@host:acme/payments.git#<full commit>     # a git repository at a commit
  ledger: { source: services/ledger, description: The books, as: project }  # long form
```

A member is a **part** or a **project**, and what it is follows from its
content — `as:` only asserts it (a contradiction is `MEMBER_KIND_MISMATCH`):

- A **part** (the default) is a piece of this project stored in another folder
  or repository. Its subsystems are this project's own: written by local id,
  judged by the ordinary subsystem rules, covered by this project's lock, and
  generated and briefed with this project's agents. It holds only a specs folder
  — plus, when it is not contained, a `project.yaml` holding just
  `partOf: { project: <parent id>, path: <parent root> }`.
- A **project** is an independent boundary: its tree declares an id, holds an L0
  or carries a lock. It is reached only as `alias::name` through its L0 exports,
  judged by its own gate and locked at its own root. A project contained in this
  project, or in a `../x` sibling checkout beside it, is followed by the family
  scan and composed **live**: its exports are read where it is stored, its own
  gate runs in the family run, and nothing is pinned (`wairon externals pin`
  says so for a member alias). A project fetched from git or a `hosted:` record
  is a **referenced** project: this project's gate judges it against its pin
  (`wairon externals pin`), and the family run opens it where it is stored and
  composes it per use. A hosted instance never reads a `../` source.

Boundaries are earned: grow a system from subsystems, to parts when a piece
needs its own folder or repository, to projects only when it needs its own team,
release, approval or public surface.

A git member is pinned at a full commit; it is read from the fetch cache
(`WAIRON_CACHE_DIR`, else the OS user cache directory), immutable and offline
once fetched. A git part is read-only here — change it in its own repository,
then move the pin with `wairon member update`. An uncached git part offline is
`PART_UNAVAILABLE`; an uncached git project falls back to its pin and is
`EXTERNAL_CHECK_UNAVAILABLE` — never a pass. Every cross-project reference is
`alias::name`: the alias is one of the referring project's project members or
declared `externals`, the name a public name in that project's L0 export table.
An id without `::` is local — a part's subsystems included.

**Authoring the L0 export table.** What another project may reference is the
project's **L0 export table**: the `publicInterfaces` list of the L0 spec
(`.wai/specs/.index.yaml`). It is authored in two steps, both through the MCP
tools (an assistant runs them; a human may edit the YAML the same way):

1. Each subsystem publishes its own surface — its inbound Portal, and the types
   it shares — with `sdd_set_public_interfaces` (an L1 `publicInterfaces`).
2. The L0 **re-exports** from those subsystems with `sdd_update_spec` on kind
   `system`, delta `publicInterfaces`. Each entry names a subsystem in `from`;
   `from` alone re-exports everything it publishes, `component` (optionally
   narrowed with `interface`) or `typeDef` picks one item, `as` renames it
   (the public name consumers write after `alias::`), `role: implement` marks
   an extension point consumers implement, and `audience` decides who may see
   it (below).

```yaml
# .wai/specs/.index.yaml (excerpt)
publicInterfaces:
  - from: distance            # everything the distance subsystem publishes
  - from: tiles
    component: tile_portal
    as: tiles                 # consumers write geo::tiles
    audience: external
  - from: shared
    typeDef: coordinate       # a shared type, as geo::coordinate
```

The key is `publicInterfaces` — an `exports:` (or any other key the schema does
not know) is reported as `UNKNOWN_SPEC_KEY`, never silently ignored, and an
unknown setting in `.wai/project.yaml` as `UNKNOWN_CONFIG_KEY`. A reference to a
name the producer does not export is `EXTERNAL_NOT_EXPORTED`.

**Export audiences.** Each L0 entry carries an `audience` (default `instance`)
that decides who may see the public name. Narrowest first:

| Audience | Who sees it |
|----------|-------------|
| `project` | Only this project's family: its members, its parent and their siblings. |
| `department` | The family, and — on a hosted instance — the projects of the owning department. A local sibling checkout or git consumer does **not** see it. |
| `instance` | The default. Any project on the instance, and any local consumer by path or git. |
| `partner` | Also consumers outside the instance that a partner grant admits. |
| `external` | Publicly consumable. |

A consumer is read at one audience: a family project at `project`, so it sees
everything; a path, git or hosted consumer outside the family at `instance`, so
it sees `instance`, `partner` and `external` entries only. A name exported to a
narrower audience is refused by `externals add` (and `externals use`), naming
the export's audience, the consumer's and this ranking. Because a project cannot
tell from its own tree whether its consumers are hosted department units,
`validate` notes every `department` export (`EXPORT_AUDIENCE_NARROW`, a
notice): widen it to `instance` when a sibling checkout or a git consumer uses
it, or keep it and allow the notice. A re-export can narrow an audience, never
widen it (`EXPORT_WIDENS_AUDIENCE`).

| Command | Description |
|---------|-------------|
| `wairon member add <alias> <source> [--project] [--description <text>] [--report]` | Create a member at `<source>` (`path` inside this project, `../<name>` — a sibling checkout ONE level up, any deeper climb refused — or `git-url[#commit]`) and declare it by the shorthand; `--report` prints what it would create, refused exactly as the write would be, and writes nothing. A **part** by default: a specs folder (and, outside this project, its `partOf`). With `--project` a project: its `project.yaml` declaring `<alias>` as its id and its L0, each only when absent. A git member is never scaffolded: it is pinned at the commit given, else the default branch head, and its content decides what it is. A git project is read from outside its family, at audience `instance`: one whose L0 exports its names only more narrowly (`project`, `department`) is refused, naming the audience it exports at and the one it is read at — widen the producer's export, or make it a path member. Then pin it (`wairon externals pin <alias>`), and a pin of a name exported too narrowly says so instead of calling it gone |
| `wairon member promote <alias> [--id <id>]` | Make a part an independent project **in place**: its id, an L0 exporting exactly what this project uses of it, references across the new boundary respelled `alias::name` (`<parent id>::name` the other way), the parent declared as its external, pins on both sides. Refused for a part fetched from git, a trustedLink that would cross the boundary, a component used across it that its subsystem does not publish, or an id already taken |
| `wairon member demote <alias> [--home <subsystem>] [--packs adopt\|drop]` | Make a project member a part **in place** — promote's inverse: its own metadata goes home (as `internalize` sends it), its L0, lock and pins end, references across the old boundary become local ids. Refused while another family project consumes it, or for a member fetched from git |
| `wairon member update <alias> [--ref <ref> \| --commit <sha>] [--report]` | Move a git member's pinned commit to its ref's head (or the ref or commit given), printing the spec files it adds, changes and removes; `--report` writes nothing. The only way a git member's content changes; this project's lock reads stale until re-locked when the content moved |
| `wairon member move <alias> <path>` | Move a contained member's directory and point its `members` entry there (a legacy L1 mount is moved into `members` first) |
| `wairon member attach <alias> <path> [--description <text>]` | Make the **existing** project at `<path>` a member, keeping its L0, subsystems, packs and lock; its id is declared when it only defaulted one (the id its lock approved, else its effective id). `<path>` reads as `member add` reads a location: inside this project, or a sibling with a leading `../`. Refused when its id collides with a family project's, and for any other path out of this project (`not-contained`) |
| `wairon member detach <alias> [--widen]` | Take a member out of the family: this project and every family consumer reach it as an external by `source.path`, this project's pinned. Refused (`audience-too-narrow`, each export named with its users) while a family project uses a name the member exports only to the family; `--widen` instead widens exactly those used exports to `instance` in the member's L0, each shown in the plan |
| `wairon member adopt <alias>` | Make this project's external found by path a member again — detach's inverse. Its source reads as `member attach` reads a location: inside this project, or a sibling with a leading `../` (a sibling member is composed live like a contained one, never pinned) |
| `wairon member rename-alias <old> <new>` | Rename one alias of this project (a member or an external) and respell this project's references through it; no member or sibling changes |
| `wairon member internalize <alias> [--into <subsystem>] [--packs adopt\|drop] [--export <name>…]` | Fold a member into this project's own specs folder. A **part** is a storage move: its subsystems move in and nothing else changes. A **project** is demoted first — its own metadata goes to a home (its L0 vision onto the `--into` subsystem, its boundaries, requirements and databases into this L0, its language, profile and depth onto the moved subsystems, its members and externals into this configuration, its packs adopted or dropped), what has no home (its lock, pins, derived outputs) is deleted and listed, and every family project that consumed it is re-pointed here |
| `wairon project rename <new-id> [--project <alias path>]` | Move a project's id — this project's, or a member's named by its alias path — and every reference to the old id family-wide; the old id is kept in `previousIds`. Lists every project it writes to re-lock, and names each consumer outside the family it writes nothing in — a parent declaring it as a `../` sibling member, re-locked there once this project is |
| `wairon subsystem externalize <id> --path <dir> [--as part\|project]` | Move an internal subsystem's specs into a **part** at `<dir>` (a new one, declared under the subsystem id, or the existing part there) — a storage move: no reference, export or pin changes, the same verdict. With `--as project` the move is followed by a promote, family-wide: references across the new boundary become `alias::name`, what crosses it is exported and imported, and every other family project's names are checked to keep resolving. You move the source code |

On a hosted instance a project member is a project record of its own and
inherits access from its parent, while a **part is part of its parent's record**:
it gets no record, and a demote retires the member's record (disabled as "part of
`<parent>`", audited `member.retired`, its own-scope settings kept) and a promote
re-enables it; the record's `disabledReason` (shown in the web app and `host
project list`) says why. Hosted roots are isolated, so a member with a `../` or git source
is refused there; a `hosted:` project member is its own top-level record.
`sdd_detach_member` also **moves** the member to an isolated root of its own
(writing `source: { hosted: <id> }` for its consumers) and `sdd_adopt_member`
with `path` moves it back. A `source.hosted` producer outside a hosted server is
reported as "hosted-only producer `<id>`: available only through the hosted
server".

**A part on its own.** A part stored outside its parent can be validated in its
own repository's CI: run `wairon externals pin` at the part (with the parent on
disk at `partOf.path`) to pin the excerpt of the parent it uses; `wairon validate`
there then judges the part against that pin (`PART_JUDGED_ALONE`). Unpinned, it
says "part of `<parent>`; validate from the parent" (`PART_UNPINNED`).

**Family migrations.** `attach`, `detach`, `adopt`, `promote`, `demote`,
`rename-alias`, `internalize`, `project rename` and `subsystem externalize` all run
one flow: plan, print the plan (each project's edits, every refusal, the notes,
the file changes, the projects to re-lock), then apply it all or nothing.
`--report` prints the plan and writes nothing; otherwise the command asks —
`--yes` answers, and a shell with no terminal and no `--yes` writes nothing. A
refused plan exits non-zero and writes nothing. The plan is computed by running
the verb's writes on a private copy of the family's `.wai` trees (its parts'
included), and each project it changes is validated on that copy too: every design finding
the result will have that the project does not report now is a note — *after
attach: 2 new error(s) the projects it changes do not report now: …* — so a
migration never turns an approved project red unannounced; applying it stages every change with a backup under each project's
`.wai/transactions/<id>/` (never committed) and swaps them in, restoring every
backup on any failure. A crash mid-swap leaves a journal: `wairon status` and
`wairon validate` show it as a notice, and `wairon doctor --fix` rolls it back.
No verb ever locks — each names the projects to re-lock. A promote (or `externalize --as project`) re-roots every
source path that moves with the new project: a path inside the new project's folder becomes
member-relative, and one outside it (source code you have not moved yet) becomes a member-relative
*planned* path — `SOURCE_FILE_PLANNED`, never a path that escapes the root — so the new project
validates on day one and you move the code when you are ready. A topic finding
(`UNCONSUMED_TOPIC`, `UNSOURCED_SUBSCRIPTION`) is sited at its topic: an allow names it
with `at: <topic>`. A member stored in a
`../` sibling checkout on the same volume joins the same transaction: its files
change all-or-nothing with the family's, the coordinator's journal names every
owner (so `wairon doctor --fix` recovers from either root), and the plan says
plainly "files: all-or-nothing; commits: one per repository" — commit each
repository yourself; no commit across repositories is ever atomic. A sibling on
another volume is refused (`cross-volume`), and a git member always is (its files
are a read-only cache). `member demote` names every L0 export entry it removes.

**Required packs.** A project may require packs of the members below it with
`composition.requirePolicies` (see
[Extending wairon](extending-wairon.md#governance--what-a-pack-changes-and-what-a-parent-requires)).
`wairon member add --project` — and `wairon init` run in a subdirectory when you
answer yes on a terminal, which creates a project member the same way — writes those packs into the new member's selection once,
each pinned to the highest installed version its range admits, sets the
`projectType` a requirement names, and prints what it applied and each
requirement nothing installed satisfies. Scaffolding is an unattended pack write,
so it shows no impact report; run `wairon pack impact <name>` at the member's
root to see one.

**Older forms.** A release reads only its own major's forms: a leading `::`
(`::shared::money`), `super::`, a member path (`billing::invoice::invoice_portal`), an L1
subsystem carrying `projectPath` and a member's long-form `path` key belong to an older
major. `wairon upgrade` rewrites them to `members`, the one location key and `alias::name`.

---

## Domains

A domain is a unit of agent ownership. Subsystem-derived domains come from the
spec tree (read-only); free-standing domains live in `.wai/topology.yaml`.

| Command | Description |
|---------|-------------|
| `wairon domains list` | List all domains (subsystem-derived + free-standing) |
| `wairon domains scan [--add]` | Detect physical directory candidates; `--add` adds selected ones as free-standing domains |
| `wairon domains add [--path] [--id]` | Manually add a free-standing domain |
| `wairon domains remove <id>` | Remove a free-standing domain (subsystem-derived domains cannot be removed here) |

---

## Skills

The five SDD skills (`sdd-architect`, `sdd-narrative`, `sdd-auditor`,
`sdd-implement`, `sdd-delegate`) drive the spec-driven workflow inside your AI
tool.

| Command | Description |
|---------|-------------|
| `wairon skills list` | List the built-in SDD skills |
| `wairon skills install` (alias `sync`) | Install/refresh the skills into each active target's skills dir |

---

## MCP

The wairon MCP server exposes topology and `sdd_*` tools so AI tools can query
and author specs directly.

| Command | Description |
|---------|-------------|
| `wairon mcp serve` | Start the MCP server (stdio transport) |
| `wairon mcp install [--global] [--config-dir <path>] [--backend claude\|gemini]` | Register the server. Default: project-local. `--global` uses the home config (respects `CLAUDE_CONFIG_DIR`/`GEMINI_CONFIG_DIR`); `--config-dir` installs into an explicit, validated config dir (requires `--backend`) |
| `wairon mcp install --hosted <url> [--project <id>] [--token <token>]` | Register a **hosted** entry against an instance instead of the local stdio server; the token defaults to the credential stored by `wairon login`. It needs no local project — run it in an empty folder: it writes only the registration (no `.wai/`, no guide), and the AI tool started there gets the hosted project's tools. The file then holds the bearer, so keep it out of version control (or install with `--global`) |
| `wairon mcp status` | Show whether the server is registered |

A project-local registration (`.mcp.json`, `.gemini/settings.json`) is committed with the
project, so it holds nothing machine-specific: it runs `wairon mcp serve` from the PATH (or
`node ./<path>` when the CLI lives inside the project, as in a checkout of wairon itself),
and the server attaches to the project it is started in. A `--global` registration is
machine-wide and names the running CLI by its absolute path.

The project entry is deliberately not an absolute path: the file is committed and shared
across machines, and a path to one developer's install breaks on every other. The cost is
that `wairon` resolves through the PATH, so a machine with two installs (an old standalone
binary and the npm package) can start an older server than the CLI you run. Two checks say so.
`wairon doctor` asks the entry which wairon it would start (`wairon --version` for a bare
`wairon`, the package version for a `node ./path` entry; nothing else from the file is ever
executed) and warns when it is not the running CLI's version, and for a project entry that names
an absolute path. And an MCP server older than the wairon that last wrote the project (the release
stamped on `.wai/lock.json` or on a generated guide) leads its `sdd_get_status` answer, and trails
its `sdd_validate_tree` answer, with an `OLDER SERVER` banner (`olderServer` in the structured
content, where the tool has one). Fix it by updating or removing the old install (`where wairon` on Windows,
`which -a wairon` elsewhere), then reconnect the assistant.

The local server offers 52 tools:

| Group | Tools |
|-------|-------|
| Topology (read) | `listAgents`, `getAgent`, `listDomains`, `validateTopology`, `getProjectConfig` |
| Authoring | `sdd_initialize_system`, `sdd_add_subsystem`, `sdd_set_public_interfaces`, `sdd_add_component`, `sdd_define_interface`, `sdd_set_endpoints` (dry run), `sdd_write_narrative`, `sdd_add_type` (dry run), `sdd_add_group` (dry run), `sdd_update_spec` (dry run, search), `sdd_delete_spec` (dry run, force, search) |
| Reading and checking | `sdd_get_spec`, `sdd_get_status`, `sdd_validate_tree`, `sdd_search_specs` (where is X designed, which spec holds this file or symbol), `sdd_find_references` (who uses X, what breaks if it changes) |
| Renames and moves (in this tree) — each with `dryRun` | `sdd_rename_component`, `sdd_rename_method`, `sdd_rename_param`, `sdd_rename_type`, `sdd_rename_field`, `sdd_rename_spec` (a contract or an implementation on its own), `sdd_move_methods`, `sdd_move_spec` (a component or a type to another subsystem) |
| Members | `sdd_add_member`, `sdd_move_member` |
| Family migrations (each takes `dryRun`) | `sdd_externalize_subsystem`, `sdd_promote_member`, `sdd_demote_member`, `sdd_internalize_member`, `sdd_attach_member`, `sdd_detach_member`, `sdd_adopt_member`, `sdd_rename_project`, `sdd_rename_member_alias` |
| Externals | `sdd_add_external`, `sdd_update_external`, `sdd_remove_external`, `sdd_pin_externals`, `sdd_get_externals_status` |
| Public surface (the producer's side) | `sdd_list_consumers`, `sdd_surface_diff` |
| Network | `sdd_set_network`, `sdd_get_network_flows`, `sdd_explain_flow` |
| Packs | `sdd_pack_impact` |
| Delegation | `sdd_get_agent_brief` (the live brief for one agent; also served as the `wairon-agent://` resource) |

Every tool description ends with its argument names (`Arguments: id, newId, dryRun?.`). Every write
tool refuses a spec of another project — a member's spec read through this tree is written from the
member's own root, and the refusal names its folder and the call to make there. `sdd_delete_spec` and
a contract method removed through `sdd_update_spec` report `published` (the public names a consumer
reaches what goes through) and `breaks` (the consumers in reach, and in the `search` folders, that use
one), as the renames do; a removed contract method takes its implementation entries with it
(`cascaded`) and is refused while another spec still calls it. A delta never changes a spec's id or
subsystem: `sdd_rename_spec` and `sdd_move_spec` do, with every reference and published entry.

A hosted server adds its own `sdd_host_*` and `sdd_landscape_*` tools; see the
[hosted server guide](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/hosted-mcp-server.md).

---

## Hosting (self-hosted server)

`wairon serve` runs wairon as an HTTP server that hosts many **fully-isolated**
projects behind one endpoint — a public **data plane** (the `sdd_*` tools over
streamable HTTP, per-project API-key scoped) and an admin **control plane**
(project & key lifecycle, state-scoped lock). See the
[hosted server guide](https://github.com/SYW-Apps/Waffle-AIron/blob/main/docs/design/hosted-mcp-server.md) for the architecture, Docker
self-hosting, auth, and sizing.

Run **one server per data directory**: scale up (a bigger machine), not out.
Several replicas sharing one data directory over a network volume are not
supported. The admin CLI (`wairon host …`) may run beside the server on the same
data directory, and its changes may run in parallel: every hosted store locks its writes. Each
store keeps its latest lock files (`<file>.lock.<n>` and `<file>.lock.<n>.end`) beside its file
between writes. They are not leftovers: the lock numbers its next generation from them, so do not
delete them.

### `wairon serve [--host <h>] [--port <p>] [--admin-host <h>] [--admin-port <p>] [--data-dir <path>] [--no-auth]`
Start the hosting server. Data plane on `0.0.0.0:8080` (`POST /mcp`, `/healthz`,
`/readyz`); admin plane on `127.0.0.1:8081` (`/admin/*`). Auth is **on by
default** and requires `WAIRON_ADMIN_TOKEN` (the master credential) — the server
refuses to start without it; `--no-auth` disables data-plane auth for a trusted
network. `--data-dir` (or `WAIRON_DATA_DIR`, default `~/.wairon/data`) is the data
root holding `projects/` and `auth/`. `WAIRON_AUDIT_POLICY` (optional) sets the
durable audit policy as a JSON object of overrides laid over the secure default
(capture `info` and above, keep events 90 days and `security` events 365, skip read
events, redacted metadata) — e.g. `{"retentionDays":30,"includeReadEvents":true}`.
Its fields are `enabled` and `includeReadEvents` (booleans), `retentionDays` and
`securityRetentionDays` (non-negative numbers), `minimumLevel` (`debug`, `info`,
`warning`, `error` or `security`) and `metadataMode` (`none` or `redacted`; the
retired `full-redacted` is refused, naming `redacted`); an unknown field, a retired value, a wrong type or invalid JSON stops the server at
startup with a message naming the variable. `WAIRON_QUOTA_POLICY` (optional) sets the
advisory quota policy the same way, as a JSON object of overrides laid over the
disabled default (`enabled: false`, mode `observe`, no limits) — e.g.
`{"enabled":true,"mode":"warn","maxProjectsPerUser":20}`. Its fields are `enabled`
(boolean), `mode` (`observe` or `warn`, the label an exceeded limit is reported
with; quotas never block or throttle yet, so the retired `block` is refused, naming `observe`)
and the non-negative integer
limits `maxProjectsPerUser`, `maxMcpRequestsPerMinute`, `maxProjectBytes` and
`maxAuditEventsPerDay`; it is refused at startup exactly as the audit policy is.

### `wairon host …` — control plane
Runs **in-process** (no running server needed), so it works over SSH /
`docker exec`. Reads the master credential from `WAIRON_ADMIN_TOKEN`.

Every project lives in an **organization unit**, and access is a grid of
**permission assignments** (subject × scope × capability). An API key acts as its
**owner's** live permissions, narrowed to the projects it names. The first
project on a new instance:

```sh
wairon host unit create --slug acme                               # a root unit (business_entity)
wairon host project create --id shop --unit acme
wairon host permission set --user alice --capability project:read  --project shop
wairon host permission set --user alice --capability project:write --project shop
wairon host key mint --project shop --owner alice                 # → wk_… (shown once)
```

`project:write` does not include `project:read`: a key whose owner can only
write is refused every read tool. `host permission set` warns when it grants
`project:write` to a user who cannot read that scope, and `host key mint --owner`
warns when the owner cannot read the project — each naming the grant that fixes
it. An owner needs no user record — an id with no record acts as a service
principal — but a grant for an id with no record is not listed or deactivated
anywhere until the record exists, so `host permission set` warns and names
`wairon host user add --user <id>`. The user listings (`wairon host user list`,
the Users view) show such a subject marked "no user record", with no status.

**Who approves a design.** A hosted lock (`sdd_host_lock_project`, the web UI's
Lock, `wairon lock` while attached) is the project's approval, so it is decided
by `approval:decide` over the project, not by `project:write`. The admin route
`POST /admin/projects/{id}/lock` only locks: it needs `approval:decide` = `yes`,
and refuses anyone else (403, naming `sdd_host_lock_project` as the way to
request). The others:

- `approval:decide` = `yes` locks directly, recorded as that person's approval.
- A person who may write the project (`project:write` = `yes` or `approval` at
  the project — a subsystem grant is not enough) but holds no `approval:decide`
  `yes` only **requests** the lock: the request is pending until someone else
  with `approval:decide` decides it (in the web UI under Approvals), and the
  requester can wait for it with `sdd_host_await_approval`. Nobody decides
  their own request. `approval:decide` = `approval` requests as well. A request
  is refused up front, naming the error count and each error's code, while the
  tree has validation errors (warnings do not block, as at `wairon lock`).
  The requester can take a pending request back with `sdd_host_withdraw_request`
  (a request id and an optional reason): it becomes cancelled and is never
  decided or executed; only the requester can withdraw it, and a request
  already decided, completed or expired is refused.
- Anyone else is refused, and nothing is requested.

Give authors `project:write` and reviewers `approval:decide`; a single
administrator holds both. `wairon host lock` runs with the master credential,
which approves on any project.

**Deciding a request.** The web UI's Approvals page and `POST /web/admin/approvals/decide`
take a JSON body with exactly these fields:

| Field | Type | |
|-------|------|---|
| `requestId` | string | required: the id of a pending request |
| `approved` | boolean | required: `true` approves, `false` denies |
| `reason` | string | optional |

Anything else is refused with `400` and a message naming these fields, and the request
stays pending: a body without `approved` (for example `{"decision": "approve"}`), a value that
is not a boolean, or a missing or unknown `requestId` is never read as a denial. Who
decided is always the signed-in person, never a field of the body. The admin API's
`POST /admin/approvals/{id}/decision` takes the same `approved` and `reason`, with the id in the path.

**A reviewer without a web sign-in.** Only the built-in administrator signs in to the web UI
with a password; everyone else signs in through an SSO provider. Without one, a reviewer decides
with their own API key (an administrator mints it: `wairon host key mint --owner <their user id>`) on the admin API:
`GET /admin/approvals?status=pending` lists the pending requests they may decide, and
`POST /admin/approvals/{id}/decision` decides one, with `Authorization: Bearer <key>`. The
decision is recorded as theirs, and their `approval:decide` grant is checked as on the web.

| Command | Description |
|---------|-------------|
| `wairon host unit create --slug <slug> [--kind <kind>] [--name <name>] [--parent <unitId>]` | Create an organization unit. A root unit (no `--parent`) must be a `business_entity`, which is its default kind; under `--parent` the default is `team`, and `department`, … are allowed where the hierarchy admits them |
| `wairon host project create --id <id> --unit <unitId>` | Provision a new isolated project (its own `.wai/` tree) in a unit |
| `wairon host project list` | List hosted projects |
| `wairon host project destroy --id <id>` | Remove a project and its tree |
| `wairon host demo [--id <id>] [--unit <unitId>] [--force]` | Provision a project seeded with an example spec tree (default id and unit `demo`; the unit is created if absent), so the canvas has content |
| `wairon host permission set --user <userId> --capability <cap> [--value yes\|approval\|no\|inherit] [--project <id> [--subsystem <id>] \| --unit <unitId> \| --instance]` | Set one assignment. Capabilities: `project:read`, `project:create`, `project:write`, `project:admin`, `approval:decide`. The scope defaults to the instance |
| `wairon host permission list [--user <userId>] [scope flags]` / `remove --id <assignmentId>` | List or remove assignments |
| `wairon host user list` / `add --user <id> [--name <n>] [--email <e>] [--unit <unitId>]` / `set-status --user <id> --status active|inactive` | List the hosted users (a subject that holds grants but has no user record is marked "no user record"), create an active user record (an id that already holds a record is refused: add never replaces one, which would drop its role bindings), or set a user's status (`inactive` revokes the user's API keys and web sessions, and the command says so; setting a user back to `active` restores none, and the command says new keys are minted with `wairon host key mint`) |
| `wairon host key mint --project <id\|*> --owner <userId> [--label <label>]` | Mint an API key acting as the owner's live permissions (plaintext shown once). The project must exist (`*` aside); a token naming a project covers its members, and a member is named by its own record id. A key never narrows to a subsystem: confine a person to one with `wairon host permission set --project <id> --subsystem <id>`. Without `--owner` (the legacy `--role editor\|admin` mint) the key resolves to **zero** permissions and the command warns |
| `wairon host key list [--project <id>]` | List API keys |
| `wairon host key revoke --id <id>` | Revoke a key |
| `wairon host lock --project <id>` | The same lock flow as `wairon lock` (design gate, `members`, `code` beside the claim, format 3) against the hosted project |
| `wairon host git enable \| disable \| sync \| commit \| status \| sync-config` | Bind a hosted project to its real repository (wairon commits only `.wai/`) |
| `wairon host producer configure \| produce \| remove \| list` | Project a hosted project to Notion or Miro |
| `wairon host secret set \| list` | Set integration secrets at runtime (`git-token`, `notion-token`, `miro-token`, `signing-secret`) — no restart |
| `wairon host packs list [--project <id>]` | List the server-global packs, or one hosted project's |
| `wairon host packs install --file <pack.yaml> [--name <n>] [--project <id>] [-y]` | Install a declarative pack server-wide, or into a hosted project. Into a project it first shows the pack's impact on that project (measured by the host, writing nothing) and asks; `--yes`, or no terminal, installs without the report and says so |
| `wairon host packs remove --name <n> [--project <id>] [-y]` | Remove a pack; from a project it first shows what the pack accounts for there and asks, as install does |

The hosted API and web UI preview the same way:
`POST /admin/projects/{id}/packs/{name}/impact` (a declarative pack's YAML as
`content`, or no body to preview adopting the server-global pack of that name)
and `POST /admin/projects/{id}/packs/{name}/removal-impact`; both need
`project:read` and write nothing. The hosted MCP data plane offers the same
preview as `sdd_host_pack_impact`. The unattended hosted policy writes —
reconcile, a project type change, and a policy-governed project creation —
return the impact of every pack they applied in their results.

### Web UI and sign-in

The browser UI (canvas, specs, approvals, administration) is served on the
**data plane** at `/` with its API under `/web/*` — the same listener and port as
`/mcp`. It is **off** by default: until it is on, every web path answers 404, and
the server's startup log says so. Turn it on in the instance exposure policy, the
JSON file `exposure-policy.json` in the data dir (a partial object; unset flags
keep their defaults). The server reads it on every request, so no restart is
needed:

```json
{ "webUiEnabled": true }
```

`requireTls` (default `true`) marks the session cookie `Secure`, so browsers send
it only over HTTPS (and on `localhost`). Serve the UI behind TLS; set it to
`false` only on a trusted network reached over plain HTTP. Once the UI is on, an
administrator edits the same policy under Instance → Exposure.

A person signs in one of two ways; the startup log names the ones configured:

- **The built-in administrator.** Set both `WAIRON_ADMIN_USER` and
  `WAIRON_ADMIN_PASSWORD` in the server's environment; the login page then shows
  a username and password form. The form posts the JSON body
  `{ "user": "<WAIRON_ADMIN_USER>", "password": "<WAIRON_ADMIN_PASSWORD>" }` to
  `POST /web/login`, which answers with the session cookie. This account is the
  instance super-administrator, like `WAIRON_ADMIN_TOKEN`, and the only
  password login: there are no per-user passwords.
- **Single sign-on (OIDC).** Everyone else signs in through an identity
  provider. Set `WAIRON_OIDC_ISSUER` (with `WAIRON_OIDC_CLIENT_ID` and
  `WAIRON_OIDC_CLIENT_SECRET`, or `WAIRON_OIDC_CLIENT_SECRET_REF` naming a secret
  stored with `wairon host secret set`) and the server registers the provider
  `default` at every start. Register `<public URL>/web/sso/callback` as the
  redirect URI at the provider, and list it in `WAIRON_OIDC_ALLOWED_REDIRECT_URIS`
  (required: a provider with no allowed redirect addresses signs nobody in, and
  no other address is accepted; the login page shows it as not set up yet, the
  Sign-in (SSO) view and the startup log warn about it). A provider added in
  the UI names the same list under Allowed redirect URIs, usually the one
  address `<public URL>/web/sso/callback`. Optional: `WAIRON_OIDC_DISPLAY_NAME` (the button
  label), `WAIRON_OIDC_PROVIDER_TYPE` (default `oidc`),
  `WAIRON_OIDC_ALLOWED_DOMAINS` (email domains admitted),
  `WAIRON_OIDC_ADMIN_GROUPS` (group claims bound to the built-in `sso-admin`
  role: project administration and creation everywhere, never the
  super-administrator), and `WAIRON_OIDC_AUTHORIZATION_ENDPOINT`,
  `_TOKEN_ENDPOINT`, `_JWKS_URI`, `_USERINFO_ENDPOINT` to override discovery.
  List values are comma-separated. More providers can be added in the UI under
  Sign-in (SSO).

A person who signs in through a provider starts with no permissions: an
administrator grants them under Users or Permissions, or with
`wairon host permission set --user <id>` using the id the Users view shows.
API keys for AI tools stay what `wairon host key mint --owner` mints (or the UI
under Agents), and act as their owner.

The `/web/*` routes are the browser app's own backend, not an API: they answer
a signed-in browser session. An API key belongs on `/mcp` (what `wairon mcp
install --hosted` configures), and administration scripts use `wairon host`.
Wherever it is sent, a key acts as its owner and never more: a key narrowed to
projects (`--project`) is refused every permission outside them, including on
`/web/*` and the admin API, and never holds the instance administrator's
bypass, whoever owns it. When an AI tool connects to `/mcp` naming a project
the key is not narrowed to, the refusal adds one sentence — "This key is
narrowed to its projects, and this project is not one of them." — and says the
same for a project that does not exist, so it never tells whether a project is
there. Other routes refuse a narrowed key with their usual `forbidden`; the
status codes are unchanged.

**Your own agent keys.** A signed-in user lists, mints and revokes keys for AI
tools under Agents in the web UI, which uses three routes. A browser session
sends a `POST` with the `X-Wairon-Web: 1` header; every key it mints or lists is
owned by the person who is signed in, and a person sees and revokes only their
own.

| Route | Takes | Answers |
|---|---|---|
| `GET /web/tokens` | nothing | `200` `{ "tokens": [...] }`: the caller's own keys, each with `id`, `projects`, `createdAt`, `label`, `expiresAt` (when set), `ownerSubject` and `readOnly` (`true` for a read-only key). Neither the key nor its hash is in the list |
| `POST /web/tokens` | JSON `{ "projectId": "<project id>", "write": true \| false }` | `201` `{ "token": "wk_…" }`. The key is shown once and cannot be read back. `projectId` is required and names one project by its record id (a member is named by its own id, never `project::alias`); `write` is optional and only `true` asks for write access (anything else mints a read-only key). The key is narrowed to that project and acts as its owner: the caller must already hold `project:read` on it (and `project:write` when `write` is `true`), else the answer is `403`. An unknown project answers `404` and an invalid `projectId` `400`, each naming the problem, except to a caller whose own key is narrowed to other projects: it is answered `403` for any project outside its narrowing, whether the project exists or not |
| `POST /web/tokens/revoke` | JSON `{ "id": "<key id>" }` | `200` `{ "ok": true }`. A key the caller does not own answers `404` as if it did not exist |

A read-only key reads what its owner reads and nothing more: every write, approval, share and
administration is refused (`403` on a route, a forbidden tool result on `/mcp`), whatever its
owner may do, and it never acts as an instance administrator. It cannot mint a key with write
access, and `POST /web/tokens/revoke` refuses it (`403`) for every key, its owner's included. A
key minted before 6.4.0 is not read-only, whatever was asked: revoke it and mint it
again.

---

## Connecting to a hosted instance

| Command | Description |
|---------|-------------|
| `wairon login <url> [--token <token>] [--project <id>]` | Store a bearer credential for a hosted instance on this machine (`--project` verifies it against that project first; the token defaults to `WAIRON_REMOTE_TOKEN`) |
| `wairon logout [url]` | Forget a stored credential (local only — it does not revoke it), or list what is stored |
| `wairon remote push \| pull [--url] [--project] [--token] [--unit <id>] [--force] …` | Migrate a spec tree to or from a hosted project (`--unit` creates the destination project first). `--project` is a project id; a member is a project of its own and is named by its own id. A key is never narrowed to a subsystem — confine a person to one with `wairon host permission set --project <id> --subsystem <id>` |
| `wairon remote attach \| detach \| status` | Bind this checkout to a hosted project; while attached, `wairon lock` locks the hosted project |

## Surfaces, externals and producers

| Command | Description |
|---------|-------------|
| `wairon externals add <alias> [<source>] [--project <id>] [--ref <ref>] [--dir <dir>] [--use a,b\|'*'] [--description <text>] [--no-pin] [--dry-run] [--json]` | Declare one external in `.wai/project.yaml`. The source is the location grammar members use: `../sibling`, `hosted:<id>`, `<git url>` or `<git url>#<commit>` (the commit is the ref the pin follows, fixed there); omit it when the family provides the producer. Text that is no location (braces, quotes, whitespace) is refused. The declaration is checked against the producer it reaches **before** anything is written — `--dry-run` included: one answering to another id, or not exporting a `use` name to this project, is refused naming the id, the closest exported names, or the narrower audience the name is exported to (see Export audiences). Pins by default; a producer that cannot be read leaves it declared and unpinned, saying why, and exits 2 (nothing was pinned). A refusal is one sentence naming the accepted form, and exits 1 |
| `wairon externals use <alias> [--add a,b\|'*'] [--remove c] [--dry-run] [--json]` | Change one declared external's `use` imports, so the specs may name the producer's public names bare (e.g. so an `implements` of the producer's trait spells its types as the producer does — though `alias::name` and the bare imported name compare as one type either way). An added name the producer does not export to this project is refused. The pin is untouched. Exits 1 on a refusal |
| `wairon externals remove <alias> [--dry-run] [--json]` | Remove one external: its declaration and its pin (`.wai/externals/<alias>.yaml` and its lock entry) together. An orphaned pin — one whose declaration was deleted by hand, which `externals list` shows — is removed too. Exits 1 when the alias is neither declared nor pinned |
| `wairon externals consumers [--search <dirs...>] [--json]` | From a producer's root: the projects that consume it — each with the alias and section it declares it under and the public names its specs use — so a producer sees who breaks before it changes its surface. Without `--search`, the family read from the highest root in reach. `--search ..` (any folders) also scans those folders and the project roots directly under them for projects declaring this one as an external by a path that resolves here, or by git — a sibling checkout is found this way. A hosted consumer, or one on another machine, declares its dependency on its own side and is not visible here (`sdd_list_consumers` is the same answer for an assistant) |
| `wairon externals pin [alias…] [--json]` | Pin declared externals into `.wai/externals/<alias>.yaml` and `.wai/externals.lock.yaml`. The snapshot is rewritten whenever anything it carries moved — not only the signatures the digest covers: a producer that added `abi: c`, changed a transport or a role, or recorded a rename is refreshed by a re-pin. Exits 1 when an alias could not be pinned (unresolved or unreachable — its previous pin stays) |
| `wairon externals status [--json]` | Each pin compared with its live producer per used member — `unchanged`, `changed`, `renamed` (with the new name), `removed`, `unlocked`, `unavailable` — and each external's health (`incompatible`, `not compared`, `drifted`, `ok`); a pinned snapshot that no longer carries what the producer says (a stale `abi`, transport or role) is `drifted`, never `ok`, and names the stale facts. A use the lock does not hold is still compared with the live producer: gone from it, it is `removed` or `renamed`. A contract used whole (a bare `dependsOn`, no call named) stands for every method its pin holds, each compared by name. A used verb of a wire Portal whose endpoint moved or went (an HTTP verb, path or stated status, another transport's address) is `changed` — a client calling it over the wire spells the route, so the external is `incompatible`; an InProcess library binds no route, so it has none to move. Git producers are fetched. The opt-in **live** gate: exits 1 when any external is incompatible, 2 when nothing is incompatible but something could not be compared (never a pass), 0 otherwise |
| `wairon externals list [--json]` | The declared externals, how each resolves and what is pinned; a malformed declaration, and an orphaned pin whose declaration is gone, are listed with their problem, never hidden |
| `wairon surface export \| import \| list [--audience <level>] [--format native\|openapi] [--portal <id>] [--out <path>] [--source <path>]` | Exchange a public surface document: export this project's (native snapshot or one OpenAPI 3.1 document per portal), import one, or list them. OpenAPI defaults to the `project` audience, so every HTTP Portal of the project's own is described — one its L0 export table never exports included (a wider `--audience` narrows to what the table shares there); the native snapshot defaults to `instance`. In the OpenAPI document a path placeholder — `{name}`, or the Express spelling `:name`, which is rewritten to `{name}` — is a parameter `in: path`, the other params the query of a GET/DELETE or the JSON body of a POST/PUT/PATCH — the one object-typed param left IS the body, as a client sends it — an optional one or a `T?` too, the body then optional or nullable, never wrapped under its name (named under `x-wairon-body-param`, so `surface import` puts it back), and several are the properties of a body object. The Portal's `basePath` is joined into every path (the document carries no `servers` entry: where it is served is deployment, not design). The parameter that carries the credential the Portal's `auth` binds (a bearer `token`, say) is left out of the parameters and the body — `security` describes it — and named under `x-wairon-credential-param` so a wairon reader can restore it. Each operation answers the success `status` its endpoint states (`sdd_set_endpoints` `status`: `202` Accepted, a `3xx` redirect with a `Location` header and no body, a `201` for a workflow verb that files something), else its conventional code — `204` with no content for a method returning nothing; `201 Created` for a POST that creates: a method whose `effect` is `lifecycle`, or one whose effect is undeclared, `write` or `io` and whose name says it creates (`createHabit`, `placeOrder`, `signUp`); else `200` (a cancel, an archive, a log-in) — and a method returning `result<T, E>` also answers a `default` error response carrying E's schema (`surface import` reads both back). A `custom` auth becomes an `apiKey` scheme only when the Portal's `auth.name` (with `auth.in`, default header) names where the credential travels; naming none, it is an `http` scheme `custom` with the design's description — no header name is invented. Two operations of one Portal on the same verb and path (placeholders compared by position) are refused naming both, never dropped (`validate` reports them as `ENDPOINT_ROUTE_DUPLICATE`). A type another project publishes resolves from its pin, or — for a member project — from what the member exports now; a type nothing resolves is named in a warning (`The document has no schema for N type(s) it names: …`), never passed under a ✔. The components are exactly the types the operations reach, each ONCE — a member's type reached under its alias, its project id or another producer's closure is one component, keyed `<alias>.<id>` (a qualified id's `::` written `.`, so every key matches `^[a-zA-Z0-9._-]+$`); a field or parameter typed `T?` is not `required` (it stays nullable), and a field's description is carried on its property. Every status line goes to stderr, so `surface export --format openapi > api.json` writes the JSON alone; an export that publishes nothing, or of a design `validate` refuses (its error count and codes), is a warning, never a ✔. An unknown `--portal` is refused naming the portals the surface renders |
| `wairon surface diff [--against <ref\|file>] [--json]` | The public-surface changelog: this project's export table now against the same table at its last **committed** approval (or at a git revision, or in a saved native snapshot from `surface export`) — every exported name and contract method `added`, `removed`, `renamed` (from its rename trace) or `changed` (signature or type shape), and how many a consumer may have to follow. A field renamed per its trace keeps its own row beside its type's rename (traced, or a changed public name of the same definition — never "removed + added"), and an exported type reshaped only by a rename it embeds says which (`embeds renamed field "money.currency" → "currencyCode"`). Against a revision it also covers the project's own HTTP Portals (its service API, exported or not), with every type they name from a pinned external or a member project expanded from the pin or member of each side: a re-pin that reshapes the project's own wire format (`GET /routes/:id/tiles` answering a renamed field) is a change of its own surface, named on the verb. What a producer writes release notes from before it re-locks; `wairon externals consumers --search <dir>` then says who uses what. Read-only. With no approval ever committed it says so (lock and commit first, or name `--against`). An L0 export entry added since that publishes nothing (a wildcard over a subsystem that publishes nothing) is listed as such, never read as no change. `--against` takes a native snapshot or a git revision: an OpenAPI document, or a file the native schema does not read, is refused in one line. `sdd_surface_diff` is the same answer for an assistant |
| `wairon produce <notion\|miro> [--page <id>] [--token <token>]` | Project the local spec tree to Notion or Miro (the token comes from `--token`, the environment, else a prompt; nothing is stored) |

## Tooling

| Command | Description |
|---------|-------------|
| `wairon dev [--port <port>] [--open]` | A local single-project dev server: the wairon web UI over the current project, no login or tenancy (loopback only). It serves the same project over MCP (streamable HTTP) at `POST http://127.0.0.1:<port>/mcp?project=local` — the current project is registered as `local`; without `?project=local` the endpoint answers 403. For an AI tool on the same machine the stdio server (`wairon mcp serve`, what `wairon mcp install` registers) remains the usual route |
| `wairon update [--check] [--channel <name>]` | Check/install the latest release; switch channel |
| `wairon aliases list` | Show command aliases (`wai`) and their status |
| `wairon aliases enable <name>` / `disable <name>` | Create / remove an alias |
