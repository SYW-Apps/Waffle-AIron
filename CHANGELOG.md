# Changelog

The releases headed 6.1.3 and 6.1.4 were prepared as 6.2.0 and 6.2.1 and shipped as
6.1.3 and 6.1.4 (their merges carried no `[minor]`); they are listed under the versions
npm and the tags carry.

## v6.6.0 (from v6.5.0)

Upgrading: nothing in a spec tree has to change, but the code-vs-design gate now compares how a
narrated call runs, reads more Python, and composes a project's externals on a plain `validate`
(see Changed), so `wairon validate --ci` may fail on code or pins that passed under 6.5.0. Each
finding names the step, the call or the external, and its file.

1. Install 6.6.0 the way you installed wairon: `wairon update` for the binary,
   `npm install --global @wairon/cli@6.6.0` (or `--save-dev` in the project) for npm.
2. Run `wairon doctor --fix` once, so the generated guides (`.wai/context/wairon-guide.md`,
   `.claude/CLAUDE.md` and their kin) describe 6.6.0, and commit the result.
3. Restart your AI tool, or reconnect its MCP server (`/mcp` in Claude Code), so the assistant talks
   to the new wairon.
4. Run `wairon validate --ci` and settle what it reports. A project that declares externals but no
   members now composes the ones whose producer is inside its reach (a git commit, a project under
   its own root), so an unpinned or incompatible one of those fails it: adapt the uses and re-pin
   (`wairon externals pin <alias>`). A `../` sibling stays advisory, as before.
5. On a hosted instance, nothing changes in stored data; a user listing may now show subjects that
   hold grants without a user record (see Added).

### Added

- **How a call runs is compared.** A new rule, `call-manner-conformance`, reads what a narrative
  says about how a call runs against the call that realizes it, in TypeScript and Python:
  - `DETACHED_CALL_AWAITED`: a call step marked `detach: true` whose code awaits the call.
  - `CALL_NOT_CAUGHT`: a call step inside a `try` step that catches, whose code call no try/catch
    (or try/except) encloses.
  - `CALL_NOT_AWAITED`: a call step not marked `detach` whose call completes later and is never
    awaited, in a method that states its detail. Where the method leaves its detail open it is the
    notice `OPEN_CALL_NOT_AWAITED` instead, which never fails the gate.
  Only calls written in the method's own function are judged; a call through a helper, a dispatch
  step and a call into another project are not.
- **Python guard-style routers are read.** A function that selects its handler from the request's
  method and path (`if`/`elif` comparisons, `match` over the path, a dict keyed by path or by
  method and path, or a `BaseHTTPRequestHandler`'s `do_GET`) is read as a router: name it in
  `router:` (`<module>#handle`, or `Class.do_GET`). A comparison that does not settle to a literal,
  or a prefix that stops inside a path segment, leaves it `UNREADABLE_ROUTER`.
- **Python calls across components in one file are reported.** A Python method that calls another
  component's modelled method written in the same file, without its narrative naming the call, is
  now `UNDECLARED_COLOCATED_CALL`, as in TypeScript. Only a call the code settles is reported, never
  one a shared name merely suggests.
- **A member's own run shows the family root's network findings.** When the family root is on
  disk, a member's plain `wairon validate` (and `sdd_validate_tree`) lists the root's
  `GATEWAY_BYPASSED` and `EXPORT_BEYOND_NETWORK` findings on it, marked advisory. They never change
  the member's verdict or fail its `--ci`; the root's own run still gates them.
- **Hosted:**
  - The requester of a pending lock request can withdraw it (`sdd_host_withdraw_request`). Anyone
    else is refused, and a request decided in the meantime cannot be withdrawn.
  - `wairon host user list | add | set-status` manages hosted users from the CLI. `add` refuses an id
    that already has a record, so it never drops a user's role bindings.
  - The user listings (`wairon host user list`, `/web/admin/users`) also show subjects that hold
    grants but have no user record, marked "no user record". `wairon host permission set --user`
    warns when that user has no record.

### Changed

- **Externals are composed on a plain `validate`.** A project that declares externals but no
  members used to get only advisory live findings from `wairon validate`; it now takes the same
  composed run a family root does. A producer inside its reach (a git commit, a project under its
  own root) is composed as part of the gate, so `EXTERNAL_UNPINNED` and `EXTERNAL_INCOMPATIBLE`
  gate it. A producer outside its root, such as a `../` sibling, keeps the advisory live comparison:
  the pin gates it through `lock-check`, and `wairon externals status` is the opt-in live gate. The
  hint for such a producer now says that instead of sending the project to `--family`.
  `--no-recursive` still runs the owner's gate alone.
- **A call into another project says so.** A narrative call or declared call naming another
  project's component (`alias::name`) is now the notice `CALL_TARGET_UNJUDGED`, which says the call
  is not judged against that project's code. It used to be `CALL_TARGET_PLANNED`, which wrongly
  said the target had no code yet.
- **An Adapter is recommended for I/O, not required.** The architecture standard and the generated
  guides no longer call the Adapter the only block that may do external I/O. Using a library's API
  directly, or creating a client and using it, is a valid pattern. An Adapter is still recommended:
  one place to change or replace a library, and a one-call method for the components that need it.
- **`sdd_move_spec` moves specs into and out of a part.** A component, a type or a group now moves
  between the project's subsystems and a local part's (contained, or a sibling beside the project),
  and the code paths of what moves are re-expressed so they still name the same files. A move into
  or out of a part read from a git checkout is refused before anything is written.
- **Python reading is more precise.**
  - A router included through a package `__init__` re-export is followed to the module that builds it.
  - A route with a path converter followed by more segments (`/<path:p>/edit`) leaves its router
    unread, and so does including an unread router.
  - A legacy attrs class (`@attr.s` without `auto_attribs=True`) has only its `attr.ib()` fields.
  - `Field(default=...)` is required.
  - A `TypedDict` whose `total=` is not a literal has its optionality left uncompared.
  - When two fields share a name in different casings, the one spelled as the spec spells it is
    compared.
- **A hosted lock request is refused while the tree has errors**, naming the error count and codes;
  no pending request is created. Warnings do not block it, as with `wairon lock`.
- **Hosted refusals say more.** A caller holding only the `approval` grant is told it may request
  the lock but not write. A refused subsystem write names the spec's path relative to the project.
  `/web/projects` no longer shows the server's absolute paths.

### Fixed

- `export type * from X` beside `export * from X` in one file no longer loses the runtime
  dependency on X.
- `sdd_update_spec` no longer reports an L0 requirement written as `{description: …}` as not stored
  when the tree holds it as plain text.
- `wairon diagram --sequence` draws a detached call's callee without returning to the caller.

### Docs

- The guides tell the assistant to pass `search` (the folder holding sibling checkouts) when asked
  who is affected by a rename or a removal, and never to answer "no consumers" without it.
- The `MISSING_INTEGRATION_SIM` message and the implement skill explain that the first `simPath` in a
  subsystem makes the rest of it owe one, and the usual answers.
- The README's quick start says scripts pass `wairon lock --yes`.

### Known limitations

- A call to another project's component is not judged against that project's code
  (`CALL_TARGET_UNJUDGED` says so).
- A lock holder that stalls longer than the lock's stale age (15 s for hosted stores and the CLI's
  own files, 60 s for the spec tree) can be taken over while it still works; its final write is
  refused, which narrows the window but does not close it. (Carried from 6.2.0.)
- `wairon mcp install` does not lock the agent's configuration file, which the agent tools write
  without wairon's lock; it re-reads the file just before writing. (Carried from 6.3.0.)

## v6.5.0 (from v6.4.0)

Upgrading: nothing in a spec tree has to change, but the code-vs-design gate now reports exported
functions or methods, dependencies and parameter types it used to let pass (see Changed), so
`wairon validate --ci` may fail on code that passed under 6.4.0. Python code is now checked for
routes, data types and declared dependencies too. Each finding names the verb, the edge, the route,
the field or the parameter, and its file.

1. Install 6.5.0 the way you installed wairon: `wairon update` for the binary,
   `npm install --global @wairon/cli@6.5.0` (or `--save-dev` in the project) for npm.
2. Run `wairon doctor --fix` once, so the generated guides (`.wai/context/wairon-guide.md`,
   `.claude/CLAUDE.md` and their kin) describe 6.5.0, and commit the result.
3. Restart your AI tool, or reconnect its MCP server (`/mcp` in Claude Code), so the assistant talks
   to the new wairon.
4. Run `wairon validate --ci` and settle what it reports: declare what the code really does, or
   change the code to what the design says.

### Changed

- **A scalar parameter's type is compared.** A parameter the code annotates as another scalar than
  its contract declares (`authorId: number` for a `string`, a Python `text: int`) is now
  `PARAM_TYPE_MISMATCH`, naming both types, as a return type already was. TypeScript's `number` for
  an int, a date written as a string, an enum as a string and a named scalar as what it holds still
  agree; a union or a type the design does not know is not compared.

- **Python routes, data types and dependencies are checked.** Python's code reading used to say
  "not checked: routes, data types", and a declared edge between two Python components was never
  judged. Now:
  - A Python Portal's routes are read off the route decorators of FastAPI, APIRouter, Flask,
    Blueprint, Quart and Sanic objects, under the prefixes of their construction and of the
    `include_router` / `register_blueprint` calls that bring them in, across modules. They are
    compared with the Portal's HTTP endpoints like TypeScript routes (`UNDECLARED_ROUTE`,
    `UNROUTED_ENDPOINT`). Name the router object in `router:`. A router with a path, prefix,
    methods list or include that is not a string literal or a module constant holding one, or that
    mounts an application, is `UNREADABLE_ROUTER`. A Python Portal with HTTP endpoints that names
    no router now gets `ROUTES_UNCHECKED` or `ROUTER_UNDECLARED`.
  - The fields of dataclass, Pydantic, `TypedDict`, `NamedTuple` and attrs classes are compared
    with their type spec's (`UNREALIZED_TYPE_FIELD`, `UNDECLARED_TYPE_FIELD`,
    `TYPE_FIELD_OPTIONALITY`), names compared in either casing. `Optional[T]` alone means nullable,
    not optional, as in Pydantic v2. Plain classes are not read.
  - A declared dependency between two Python components is `UNREALIZED_DEPENDENCY` unless one
    imports the other, or calls a method of the other's contract through a field or a variable (a
    collaborator injected through a Protocol).

- **A re-export is a dependency.** A file that re-exports another component's code
  (`export { x } from`, `export * from`, `export * as ns from`) now needs the same declared relation
  as one that imports it, and `UNDECLARED_DEPENDENCY` reports it otherwise. A name imported through a
  barrel that no component realizes is charged to the file where the type checker finds it
  declared. A type-only re-export republishes no code and is still never reported.
- **The diagram API is designed.** The scoped and whole-set Mermaid diagrams behind
  `wairon diagram --subsystem`, `--sequence` and `--all` are now declared contract methods of the
  core Portal (`generateComponentDiagram`, `generateSequenceDiagram`, `generateDiagramSet`,
  `diagramSetIndex`), with `ComponentDiagramOptions`, `SequenceDiagramOptions` and `DiagramFile` as
  types. `loadSpecGraph` is no longer exported from the library entry.

- **A test's uses are read like any other code's.** A test, a composition root or another
  TypeScript or JavaScript file that no spec names used to keep an undeclared exported function or
  method from `UNDECLARED_PUBLIC_MEMBER` by writing its name anywhere, even as a method of another
  class. The type checker now reads such a file when its imports reach the project's code, and it
  counts as a use only when a call or reference lands on that very declaration, through a barrel
  included, or when the file imports the name from the file that exports it. A script file that imports none of the project's code no longer exempts anything. Files
  in a language no checker reads still exempt a name by writing it, and an exported class is judged
  as before.
- **The own-key list shows less.** `GET /web/tokens` (the Agents page) answers each key's id,
  projects, creation and expiry time, label, owner and `readOnly`, and no longer the key's hash or
  who minted it.
- **A refused lock says why.** A lock refused because the caller may not write the project now
  names where that was decided, so a read-only key's refusal says the key is read-only.

### Docs

- `rules.conformance.sourceRoots`, `exclude`, `unclaimed` and `testRoots` are described under
  `wairon validate`, with the exemption for a file that only re-exports other modules.

### Known limitations

- The code-vs-design gate compares a narrated call, not how it runs: code that awaits a call step
  marked `detach: true`, or drops the try/catch of an error-isolation (`try`) step, passes.
- A call to another project's component through a binding module is not judged against that
  project's code, and the `CALL_TARGET_PLANNED` notice says the target plans no file even once its
  code exists.
- Python routes are read only from route decorators on router objects: a handler that matches
  paths in its own body (`if path == …`) is not read, and its Portal gets `ROUTER_UNDECLARED`.
  Calls a Python method makes that its narrative does not name are not reported.
- `sdd_move_spec` cannot move a component, a type or a group into a part's subsystem; re-create the
  spec there and delete the old one. (Carried from 6.3.0.)
- A lock holder that stalls longer than the lock's stale age (15 s for hosted stores and the CLI's
  own files, 60 s for the spec tree) can be taken over while it still works; its final write is
  refused, which narrows the window but does not close it. (Carried from 6.2.0.)
- `wairon mcp install` does not lock the agent's configuration file, which the agent tools write
  without wairon's lock; it re-reads the file just before writing. (Carried from 6.3.0.)
- A member project's own `wairon validate` does not show the network findings judged at the family
  root (`EXPORT_BEYOND_NETWORK`, `GATEWAY_BYPASSED`); run `wairon validate` at the family root to
  read them. (Carried from 6.2.0.)
- The code-vs-design gate does not report external I/O or libraries a component uses: I/O outside
  an Adapter passes `validate --ci`. (Carried from 6.1.3.)
- Plain `wairon validate --ci` at a family root does not compose externals; `wairon validate
  --family` does, and `lock-check` gates on the pins. (Carried from 6.1.3.)

## v6.4.0 (from v6.3.0)

Upgrading: nothing in a spec tree has to change, but the code-vs-design gate now reports exported
verbs it used to let pass (see Changed), so `wairon validate --ci` may fail on code that passed
under 6.3.0. Each finding names the verb and the file; declare it, make it private or remove it.

1. Install 6.4.0 the way you installed wairon: `wairon update` for the binary,
   `npm install --global @wairon/cli@6.4.0` (or `--save-dev` in the project) for npm.
2. Run `wairon validate --ci` and settle any new `UNDECLARED_PUBLIC_MEMBER`.
3. In a project with parts, run `wairon doctor --fix` once, so each part's `.wai/.gitignore` keeps
   its spec write lock out of git (see Fixed), and commit the result.
4. On a hosted instance, revoke each self-service key that was minted read-only before 6.4.0 and
   mint it again: an older key is not read-only (see Security).

### Security

- **A read-only key could write.** A key minted on the Tokens page or through `POST /web/tokens`
  without write access acted with its owner's full permissions, so "Read only" was only a label.
  Such a key is now refused everything but reading, whatever its owner may do, and it never acts
  as an instance administrator; a key that cannot write cannot mint one that can, nor revoke any
  key, its owner's included. A key minted with
  write still acts as its owner. A key minted before 6.4.0 carries no read-only mark and keeps
  acting as its owner: revoke it and mint it again.

### Changed

- **A use is a use of that very function.** `UNDECLARED_PUBLIC_MEMBER` exempted an exported verb
  as soon as anything in the project wrote its name, so a verb removed from the design but still
  exported passed whenever a method of the same name existed elsewhere (a facade forwarding to
  `registration.isDeviceActive()` kept an exported `isDeviceActive` alive). Where the type checker
  read the using file, a call or reference now counts only when it lands on that function itself,
  and an import of the name from its file counts. A call the checker cannot follow to one function
  (a receiver typed `any`, a port no class realizes) still counts by its name. A re-export (`export { x } from`, `export *
  from`) publishes a name and is no use of it: the name counts as used only when what the barrel
  publishes it as is used. Files the run does not analyze (tests, a composition root) still exempt
  any name they write, except in their own re-export statements.

### Fixed

- **Dependency injection through an object of a module's functions.** A collaborator wired as
  `threshold: { isBreach }` in a composition root, where the caller types it by a port it declares
  itself, was reported as `CALL_ORIGIN_UNRESOLVED` and `UNREALIZED_DEPENDENCY`. The type checker
  now also reads the project files no spec names that import the analyzed files (a composition
  root, the tests), and an object literal typed as a port realizes its members with the module
  functions it names. Reading those files makes `validate` slower on a large repository (about
  10% on wairon's own).
- **Renames inside a part.** Renaming a component, a contract, an implementation, a method, a type
  or a field rewrote references only in the root's own spec folder. In a part, an implementation
  kept its old contract and was written back into the old component's folder. Every rename now
  rewrites the parts' specs too (a part fetched from git is read-only and is not written).
- **A part's spec write lock was committed.** Only the root's `.wai/.gitignore` ignored the lock.
  A new part or member project gets the same line, and `wairon doctor --fix` adds it to existing
  ones inside the project folder. A part outside that folder is not written: add
  `.spec-write.lock*` to its `.wai/.gitignore` by hand. A lock already committed stays tracked
  until it is removed from the index (`git rm -r --cached <part>/.wai/.spec-write.lock`) and that
  is committed.
- **`wairon host` accepted a weak admin token** that `wairon serve` then refused to start with.
  Both now apply the same rule, in the same words.
- **Messages:**
  - A narrowed key connecting to `/mcp` for a project it is not narrowed to is told so in one added
    sentence, said the same way for a project that does not exist.
  - `INVALID_TARGET_METHOD_REFERENCE` says when a member project removed the verb from its
    approved design, not only when it renamed it.
  - `METHOD_BODY_NOT_FOUND` ends with the remedy.
  - The Python line of `validate`'s code report says what it checks of calls: claimed calls are
    found by name, and calls the narrative does not have are not reported.

### Docs

- `docs/cli.md` documents the self-service key routes (`GET /web/tokens`, `POST /web/tokens`,
  `POST /web/tokens/revoke`), what a read-only key may do, and how a narrowed key is refused on
  `/mcp`.

## v6.3.0 (from v6.2.1)

Upgrading: nothing in a spec tree has to change.

1. Install 6.3.0 (the Node.js requirement is unchanged from 6.2.0: 22.23.4+, 24.22.1+ or
   26.12.1+).
2. Run `wairon generate` to refresh the guides and skills, so your assistant's guide lists the two
   new lookup tools (`wairon doctor` reports the guides stale until you do), then reconnect your
   assistant's MCP server so it runs the new release.
3. Commit the regenerated files.

### New

- **Spec lookup for assistants.** Two read-only MCP tools answer the questions a session used to
  answer by reading spec files:
  - `sdd_search_specs` finds any design element from whatever you hold: an id, part of a name,
    a method, a type, an endpoint, a code file or a code symbol. Each match comes with where it
    sits, who owns it, the code that realizes it, its approval state and how sure the match is.
  - `sdd_find_references` answers "who uses this, and what breaks if it changes". Each reference
    is graded by its evidence, and what the design declares is joined with what the code does:
    confirmed, declared only, or in the code only. Tests and waivers are listed apart, and the
    answer ends with an impact verdict, from one component up to `public` when the project's
    export table exports the target beyond the family. A code file answers for the component it
    realizes, and a method that only re-exports another counts as that method, as the
    code-vs-design gate already judges it.

  The code model behind both is cached against the source files, so later lookups are fast (on a
  large repository, about 12 s for the first and under 4 s after).
- **Type diagrams per group.** `wairon diagram --types` writes a Mermaid overview of the type
  groups (`types/index.md`): each group with its type count, child groups inside their parent,
  and the references between two groups added up into one counted edge. `wairon diagram --group
  <id>` writes one group's types as a Mermaid class diagram, with fields, enum values and methods,
  and a stub naming the group of each type it references elsewhere. `--all` writes every type
  diagram with the rest of the set. Both options are Mermaid only; the canvas already folds types
  by group.

### Changed

- **`sdd_get_status` answers a summary by default.** Pass `detail: full` for the whole report. A
  script that read the full report from the default answer must now ask for it.
- **A type planned in a file another component already wrote is planned, not missing.** When the
  components that write a type (its `componentClass`, else the components whose contracts use it)
  have no code yet, a declaration missing from a shared file that exists is `SOURCE_FILE_PLANNED`,
  a notice naming those writers, instead of an `UNREALIZED_TYPE` warning that failed
  `validate --ci` before anyone could write it. Once one of them has code, a missing declaration is
  `UNREALIZED_TYPE` as before.
- **The CLI's own files take a write lock.** The credential store (`~/.wairon/credentials.json`)
  and the settings file (`~/.wairon/config.json`) do each change under the same write lock the
  hosted stores use, so two `wairon login` or `remote attach` commands at once both keep their
  credential, and two commands recording settings at once both keep theirs. A credential file that
  exists but cannot be read is now refused, naming the file, instead of being replaced by a file
  holding only the new credential: repair or remove it. `wairon mcp install` re-reads the agent's
  configuration just before it writes and adds only the wairon entry, so a server the agent added
  in the meantime is kept.

### Fixed

- **Security: a key narrowed to projects stays within them.** An API key minted for some projects
  acts as its owner only there. Its narrowing was applied where a request picks its project, but
  not to every permission check, so on some routes the key could act with its owner's wider
  permissions. Every permission outside the key's projects is now refused, and a narrowed key
  never holds the instance administrator's bypass, whoever owns it. Unnarrowed keys and browser
  sessions are unchanged. Hosted operators: install 6.3.0; no key has to be reissued. One thing a
  narrowed key could do before and no longer can: use a permission granted on an organization unit
  or the instance, such as creating a project (`sdd_host_initialize_project`). Use a key minted
  without `--project` for that.
- **A refused write in a subsystem says what is missing.** The refusal names the grant the write
  needs and the `wairon host permission set … --subsystem <id>` command an administrator runs to
  give it, instead of ending at "decided by the project rung".
- **Spec files are replaced atomically.** A spec write goes to a temporary file that is then
  renamed over the old one, so a command reading the tree at the same moment sees the old spec or
  the new one, never an empty file (it answered `spec-missing` before). A symbolic link is written
  through, permissions are kept, and a read-only file is still refused.
- **A type whose new home is taken is refused.** A type leaving its group, or joining another,
  while another file already holds its new path, used to change the group, leave the file where
  it was and report success. Nothing is written now, and the refusal names both files.
- **A refusal names another project's spec as that project spells it.** A write naming a member
  project's spec in another letter case, or by its name, is refused with the id that project uses,
  and `spec-missing` adds `did you mean "<id>"?` when exactly one spec matches that way.
- **Python code is quoted as Python.** Conformance findings wrote a Python call as
  `this._store.lookup(…)`; they now write `self.` and no `new`.
- **`wairon host key mint --project "<id>::<name>"`** explains that a key narrows to whole
  projects, lists the project's members, and names the permission grant that confines a person to
  one subsystem.

### Docs

- The hosted web routes (`/web/*`) are the browser app's backend, not an API: an API key belongs
  on `/mcp`, and administration scripts use `wairon host`. `docs/cli.md` also documents the
  `POST /web/login` body.
- `docs/cli.md` says how a reviewer without a web sign-in decides a lock request: with their own
  API key on the admin API (`GET /admin/approvals?status=pending`,
  `POST /admin/approvals/{id}/decision`).

### Known limitations

- A lock holder that stalls longer than the lock's stale age (15 s for hosted stores and the
  CLI's own files, 60 s for the spec tree) can be taken over while it still works. Its final write
  is refused when that happened, which narrows the window to the write itself but does not close
  it. (Carried from 6.2.0.)
- `sdd_move_spec` cannot move a component, a type or a group into a part's subsystem: it offers
  only the subsystems of the project's own folder, and names a part's subsystem as another
  project. Re-create the spec in the part's subsystem and delete the old one, then update what
  referred to it.
- `wairon mcp install` does not lock the agent's configuration file: the agent tools write it
  without wairon's lock. It re-reads the file just before writing, which narrows the window.
- A member project's own `wairon validate` does not show the network findings judged at the
  family root (`EXPORT_BEYOND_NETWORK`, `GATEWAY_BYPASSED`); run `wairon validate` at the family
  root to read them. (Carried from 6.2.0.)
- The code-vs-design gate does not report external I/O or libraries a component uses: I/O
  outside an Adapter passes `validate --ci`. The "Never checked" line of `validate` says so.
  (Carried from 6.1.3.)
- Plain `wairon validate --ci` at a family root does not compose externals; `wairon validate
  --family` does, and `lock-check` gates on the pins. (Carried from 6.1.3.)

## v6.2.1 (from v6.2.0)

A fix release. Nothing to do when upgrading: install 6.2.1.

- **A type's group can be removed.** `sdd_update_spec` with `unset: ["group"]`, and re-defining
  the type with `sdd_add_type` without the `group` argument, reported the group removed while
  the saved file kept it (only `updatedAt` moved), so a type naming a group nothing declares
  (`TYPE_GROUP_UNKNOWN`) could not be corrected through any tool. A save that states no group
  now removes it. When the type leaves a declared group, its file also leaves the group's folder
  for the home an ungrouped type has, and the write says so ("type X left group G: its file is
  now ..."). The write receipt and `sdd_get_status` now agree on the change.
- **A refusal for a member project of a member project names the right project.** Writing
  `outer::inner::some-type` from the family root named the first hop (`outer`) and told you to
  call the bare id there, which does not resolve. It now names the project that holds the spec
  (`inner`, with its folder) and the id as that project's own root spells it.

## v6.2.0 (from v6.1.4)

Upgrading: nothing in a spec tree has to change.

1. Install 6.2.0. Installed through npm, it runs on your own Node.js, and it now requires a
   release with the October 2026 Node.js security fixes: 22.23.4+, 24.22.1+ or 26.12.1+
   (`engines`: `^22.23.4 || ^24.22.1 || >=26.12.1`; Node.js 18 and 20 get no fix). Update
   Node.js first. The release binaries and the Docker image carry their own Node.js 24.22.1.
2. Run `wairon generate` to refresh the guides and skills (`wairon doctor` reports them stale
   until you do), then reconnect your assistant's MCP server so it runs the new release.
3. Commit the regenerated files.

Two things to know:

- Do not run two wairon versions on one tree at the same time. The spec-tree write lock now keeps its files
  in a folder, `.wai/.spec-write.lock/`; an older wairon that finds that folder refuses to write
  (it never writes past it), so finish or close sessions of the old version before the new one
  writes. A lock file a crashed older session left behind (`.wai/.spec-write.lock`) is taken over
  once it is stale.
- The local `wairon dev` server's data folder is disposable: a folder an older version wrote is
  deleted and started fresh, never migrated. Nothing of a project's own lives there.

### New

- **Type groups form a tree.** A group may name a `parent` group (`sdd_add_group`, or
  `sdd_update_spec` with `kind: group`), and the folders under `types/` follow the parent chain.
  Groups are layout and presentation only: type ids stay bare and global and nothing resolves
  through a group. `sdd_rename_spec` and `sdd_move_spec` take `kind: group` (a group moves with
  its whole folder), the canvas clusters types by group, `sdd_get_status` / `wairon status`
  count types per group, and the design export (format 2.2) carries the tree. New checks:
  `TYPE_GROUP_UNKNOWN`, `GROUP_PARENT_UNKNOWN`, `GROUP_PARENT_CROSS_HOME`, `GROUP_CYCLE` and
  `TYPE_GROUP_MISPLACED`; `wairon doctor --fix` moves a misplaced group folder or type file to
  where its group puts it.
- **`wairon dev` always starts.** It no longer refuses a tree with errors: the canvas shows what
  could be read and a findings panel lists every finding, so the problems are visible where they
  are. Data an older version left in its folder is discarded instead of failing the start, and a
  banner says which project the server registered.
- **A project of only types is a design.** Its types and its L0 export table are approved by
  `wairon lock` like any other design; `status`, `validate` and `lock-check` no longer call it
  empty. A tree with truly nothing approvable says so in one sentence, and a member project with
  nothing approvable is reported as a notice (`MEMBER_NOTHING_APPROVABLE`).
- **The running version is in every reading.** `sdd_get_status` and `sdd_validate_tree` carry
  `validatorVersion`, and `wairon validate` prints it on its closing line, so a pasted result
  says which release produced it. `sdd_get_status` now answers in structured content too: the
  whole report (`report`) beside the version.
- **`wairon surface diff` reports a reordered type's fields** (a field-order row), which matters
  to positional bindings even when no field was added or removed.
- **The generated guides name `wairon dev`** as the way to browse a design locally.

### Fixed

- **The release binaries run Node.js 24.22.1** (they embedded Node 20.18.0, which is past its end
  of life). 24.22.1 carries the October 2026 Node.js security release, including
  CVE-2026-111497 in the bundled Brotli decoder, which wairon reaches through `fetch` (sign-in
  discovery, remote servers, git sources, producers). The Docker image already runs 24.22.1.
  **Installed through npm, wairon runs on your own Node.js, and its `engines` now names only
  the fixed releases (22.23.4+, 24.22.1+, 26.12.1+).** The reusable `lock-check.yml` workflow
  installs the CLI on Node.js 24 by default (it was 20).
- **The canvas escapes every name it shows.** The breadcrumbs, the flow view's crumb and its call
  links put spec names into the page unescaped, and attribute values did not escape quotes. On a
  hosted server, anyone who could edit a design could put markup into another user's view.
- **Every hosted store locks its writes.** Permission grants, the organization and its
  placements, roles, policy, approvals, audit, sessions, share links and the rest now read and
  write under the file's lock, as the credential and project registries did in 6.1.4, so two
  processes changing the same store at once no longer lose a change. A family migration holds the
  stores' locks for its whole run. The lock is generation-numbered, so taking over a stale lock
  can never end a lock another process took meanwhile.
- **Hosted record ids are project ids.** A project whose id contains `.` or `_` (valid project
  ids) can now be registered on the hosted server and by `wairon dev`; before, the record grammar
  allowed only letters, digits and `-`, and such a member was refused.
- **Revoked credentials are deleted**, not kept with a revocation time; records an older version
  kept that way are dropped when the file is next read.
- **Decorator metadata is read from the project's `tsconfig.json`.** A type-only import counts as
  a runtime use only when the nearest `tsconfig.json` turns decorator metadata on.

### Known limitations

- Two CLI-side files are not locked yet: the remote binding (`wairon login`, `mcp install
  --hosted`) and the user configuration. Two of those commands run at the same moment can lose
  one change; run them one at a time.
- A lock holder that stalls longer than the lock's stale age (15 s for hosted stores, 60 s for
  the spec tree) can be taken over while it still works. Its final write is refused when that
  happened, which narrows the window to the write itself but does not close it.
- A member project's own `wairon validate` does not show the network findings judged at the
  family root (`EXPORT_BEYOND_NETWORK`, `GATEWAY_BYPASSED`); it only says they are judged
  there. Run `wairon validate` at the family root to read them before changing a member's export
  audience.
- The code-vs-design gate does not report external I/O or libraries a component uses: I/O
  outside an Adapter passes `validate --ci`. The "Never checked" line of `validate` says so.
  (Carried from 6.1.3.)
- Plain `wairon validate --ci` at a family root does not compose externals; `wairon validate
  --family` does, and `lock-check` gates on the pins. (Carried from 6.1.3.)

### Also in this release

- **CDN releases are published per platform plus an index.** The SYW CDN sits behind a 100 MB
  request limit and the five archives are about 204 MB together, so the single publish request
  of 6.1.4 was refused. Each platform is now its own exact release (`<version>-<target>`, no
  aliases), verified by a public download, followed by the index release `<version>` whose
  `version.json` (schema 2) names every archive by its exact URL and which alone moves
  `latest` / `v<major>` / `beta` / `preview` (never over a newer version). The publisher also
  refuses an incomplete archive set and any request over a 90,000,000-byte budget before
  sending. A new `cdn-republish.yml` workflow republishes an existing tag with the fixed
  publisher (a rerun of the original tag run would use the original script). See
  `docs/cdn-release.md`.
- **The code-versus-design check reads decorators per declaration.** An import used only as a
  type counts as a runtime use under decorator metadata only when the annotated declaration
  emits it: a property with its own decorator, a constructor parameter of a class that is
  decorated or has a decorated constructor parameter, or a parameter of a decorated method. A
  decorator on an unrelated method no longer turns a type-only import into an
  `UNDECLARED_EXPORT`, and a class whose only decorator sits on a constructor parameter is no
  longer missed.
- **One file realizing two components:** a method whose implementation names its class
  (`exportedVia`) is credited only to that class, so a caller importing the other component's
  class gets its `UNDECLARED_EXPORT`.
- **`wairon mcp install --hosted <url>/mcp`** finds a credential that `wairon login` stored
  under the `/mcp` address too.
- **Write locks:** a lock whose recorded process id cannot be checked (a corrupt record) is
  treated as held until it is stale, not broken at once.
- **`wairon host serve --port 0`** binds a free port and prints the one it bound.

## v6.1.4 (from v6.1.3)

A fix release from an outside review of 6.1.2/6.1.3. Nothing to do when upgrading: install
6.1.4.

- **Hosted registries no longer lose a concurrent write.** The credential and project registries
  read their whole file, changed it and wrote it back with nothing held in between, so two
  processes writing at once (the server and the admin CLI, say) could each save a set missing
  the other's change. Every change now reads and writes under the file's own lock
  (`<file>.lock`), through a temporary file of its own; a failed change writes nothing, and a
  registry file that exists but cannot be read or parsed refuses the change instead of being
  written over as an empty set. The credential file is written owner-only (0600) on Linux and macOS, as its design already said;
  on Windows it keeps the permissions of its folder.
- **Every hosted store writes through a temporary file of its own.** Two writers no longer share
  one `<file>.tmp`, and on Windows the final rename is retried for a moment while another process
  replaces or reads the same file; before, parallel writes could fail with `EPERM`.
- **`wairon mcp install --hosted` accepts the address the server prints.** Given
  `http://host:port/mcp`, it wrote `.../mcp/mcp`, which answers 404; the instance is now read as
  its base URL either way, and the credential stored by `wairon login <base URL>` is found. A
  credential stored under the `/mcp` address is not: the install says so and names
  `wairon login <base URL>` (or pass `--token`).
- **The spec-tree write lock names its host.** A holder is judged gone by its process id only on
  its own host; one on another machine or container sharing the volume holds until its lock is
  stale.
- **The install scripts verify the download.** `install.sh` and `install.ps1` check the archive
  against the `.sha256` file the release publishes and refuse to install on a mismatch or a
  missing checksum, as `wairon update` already did.
- Each release now runs its packaged binary (Windows x64, Linux x64, macOS arm64) before
  publishing: `--version` must match the tag, and a fresh `init --yes` must pass `validate --ci`.
- **Docs:** the README says what wairon checks and what it does not; `examples/ci/strict-gate.yml`
  is a ready-to-copy strict CI gate with the repository protections it needs; the hosting guide
  is re-measured and runs one instance per data directory; CONTRIBUTING opens with the normal
  contributor path and says how to report a security issue; issue templates for bugs, false
  alarms and experience reports.

### Known limitations

- Only the credential and project registries lock their writes so far. The other hosted stores
  (permission grants, the organization and its placements, roles, policy, approvals and the
  rest) can still lose a change when two processes write the same file at the same moment, such
  as several `wairon host permission set`, `host unit create` or `host project create` commands
  run in parallel (a project created that way can miss its unit placement). Run such changes
  one at a time; a later release gives every store the same lock.

## v6.1.3 (from v6.1.2)

v6.2 holds a method's stated detail to what it states and says where a design leaves routes
open, lets the design name callers it cannot show yet (a component's runtime hook, a planned
caller), and makes agent files strictly opt-in, one owner per subsystem.

Who is affected:

- **Projects that relied on committed agent files without stating it:** a `.wai/project.yaml`
  that never states `rules.materializeAgentFiles` now reads it as off, so the next `wairon
  generate` or `wairon lock` removes the wairon-managed agent files. State it `true` first to
  keep them.
- **Projects with `rules.generateComponentImplementers: true`:** the setting is ignored (with a
  warning). Materialized agents are one owner per subsystem; a component's brief is still
  composed on demand.
- **Designs a new rule now judges:** a declared `calls` entry is held to the same rules as a
  narrative call step (`PORTAL_WRITE_SHORTCUT`, `SUPERVISOR_WRITE_SHORTCUT`,
  `LIFECYCLE_CALLS_WRITE`), and a subsystem publishing a component that is not a Portal is
  `PUBLIC_INTERFACE_NOT_PORTAL`. Both can newly fail `validate --ci`.

### Upgrading from v6.1.2

1. Install 6.1.3 everywhere the project is checked: every teammate, CI, and the `wairon` your
   assistant's MCP server starts. No `wairon upgrade` is needed: the tree stays on major 6.
2. If you keep agent files on disk (`.claude/agents/` and the like) and your
   `.wai/project.yaml` does not state `rules.materializeAgentFiles`, add
   `materializeAgentFiles: true` under `rules` now. Remove `generateComponentImplementers` if
   it is there.
3. Run `wairon generate` to refresh the guides and skills, then reconnect your assistant's MCP
   server (in Claude Code, `/mcp`) or start a new session.
4. Run `wairon validate --ci` and `wairon lock-check`. The approval carries over unless 6.1.3's
   rules find something in the approved design; then fix what they name (for
   `PUBLIC_INTERFACE_NOT_PORTAL`: publish the Portal in front of the component, or drop the
   entry) and run `wairon lock`.
5. Commit the regenerated files, and `.wai/lock.json` if you re-locked.

### Stated detail is binding, unstated detail is open

Detail is never required, and wairon never assumes what was left out: what a method states
it calls is binding, and where it states nothing, every route its component depends on is
open, and wairon says so.

- **Declared `calls` are judged like narrative call steps.** `PORTAL_WRITE_SHORTCUT`,
  `SUPERVISOR_WRITE_SHORTCUT`, `LIFECYCLE_CALLS_WRITE` and the entry-point checks read only
  narrative steps, so a write declared in `calls` passed them. They now read both and point at
  "step N" or "a declared call". A design whose declared calls break one of these newly fails.
- **Agent briefs say what is fixed and what is open.** Each implementer brief has a section
  with one line per method: binding (make exactly the calls named), or open (the collaborators
  the narrative names, and every other one its component depends on, which the design allows
  without saying the method takes it — take one only as needed, and name it in the report).
- **Status says how much of the design is binding.** Beside the completeness percentage,
  `wairon status` and `sdd_get_status` count the methods that state their calls and the ones
  that leave routes open.
- **Design export 2.1:** each method body carries `detailStated`, and an `invokedBy` may carry
  `planned`. A minor version: the fields are added, nothing is removed or redefined.

### Callers the design cannot show yet

- **A component-level `invokedBy: { kind: runtime }`.** On any component it is the hook every
  method inherits (a method's own declaration replaces it), so a component the process's own
  runtime calls through no longer needs the declaration repeated on each method. Before, it was
  accepted on a non-Portal and silently ignored. `INVOKED_BY_REDUNDANT` reports it once the
  narratives reach every method that inherits it, and its caller prose is held to the same floor.
- **Planned callers: `invokedBy: { kind: entry, caller, planned: true }`.** A Portal whose
  callers are not built yet keeps its entry, so its verbs stay reached, and the new
  `ENTRY_CALLER_PLANNED` notice names it until the caller exists and the flag is dropped. It works
  on a runtime declaration too.
- **`transport: Custom` says what it assumes.** Custom, the free-form escape hatch, is read as a
  network transport (scopes, the gateway rule, network flows). A new `CUSTOM_TRANSPORT_AS_NETWORK`
  notice on each Custom Portal says so and names the local and in-process transports to state
  when its callers are not across a network. The generated guide now lists Custom.
- **`PUBLIC_INTERFACE_NOT_PORTAL` (warning).** A subsystem that publishes a component other than
  a Portal is reported where it publishes it: nothing can use it, since a hop from another
  subsystem enters through a published Portal and another project consumes only a Portal's
  verbs. Before, only the dependency on it was refused. **Can fail `--ci`.**
- **A live Actor's handle is supervision, not data.** `ACTOR_REACHED_WITHOUT_SUPERVISOR` now
  names the Actor's Supervisor first: depend on it and take the handle from it, since a lookup by
  id or a runner checked out of a pool needs no data component. A Registry is named only as the
  by-id alternative, and never one the Supervisor owns. Before, the remedy could point at an owned
  Registry, which is the Supervisor's private state and `SUPERVISION_STATE_INTRUSION`. A Registry
  a Supervisor maintains through lifecycle calls (a directory of live handles) no longer draws
  `REGISTRY_WITHOUT_STORE`.

### Agent files

- **An unstated `rules.materializeAgentFiles` reads as off.** Before, a project that never stated
  it read it as on while committed wairon-managed agent files were present. Now the next
  `wairon generate` (or `wairon lock`) removes those files, and says why. Keep them with
  `rules.materializeAgentFiles: true` in `.wai/project.yaml`.
- **Per-component agents are retired.** `rules.generateComponentImplementers` is read and
  ignored, with a warning from `wairon generate` while it is set true. Materialized agent files
  are one owner per subsystem, which owns its components' code; a component's brief is still
  composed on demand (`sdd_get_agent_brief`, `wairon agent brief <component>`). A large project
  no longer generates hundreds of agent files on every lock.

### Fixes

- **A guard router that tests the whole path is read.** A route written as `req.path === '/orders'`,
  or as an anchored regular expression tested against the path (`/^\/orders\/([^/]+)$/.exec(req.path)`,
  `.test`, `path.match(...)`, directly or through a const holding the match), is a route; an honest
  `GET /orders/{orderId}` served that way was reported `UNROUTED_ENDPOINT`. The finding now names
  the route forms it reads.
- **A pin over a rename is refused.** `wairon externals pin` (and `sdd_pin_externals`) refuses an
  alias while a member the last pin records as used is renamed (the new name is given) or removed
  in the producer, and keeps the previous pin: follow it in the uses first, then pin once. Before,
  the pin went through, and a second pin and lock were owed. Outcome `refused`, exit 1.
- **Contracts for I/O methods are written `async`.** The architect skill now says that in a language
  with asynchronous I/O a method that waits on I/O returns `async T`, so honest async code does not
  fail `ASYNC_MISMATCH`.
- **A renamed parameter is reported even where the types cannot be compared.** A Python
  `quote_order(order_items: list[dict])` realizing `quote_order(items: list<order_item>)` passed
  silently: nothing decided rename or substitution, so nothing was said about the name. It is now
  `PARAM_NAME_MISMATCH`, saying the comparison could not be made. **Can fail `--ci`** where code
  and contract name a parameter differently.
- **`wairon update` on Windows stages the new build first.** The new executable is copied beside the
  running one before anything moves, so a failed copy (a full disk, a scanner holding the file)
  leaves the running wairon untouched; the swap itself is two renames.
- **`.wai/upgrade-report.md` is written whole or not at all**: it is staged and renamed into place,
  so a failed write never leaves a partial report.

### Known limitations

- The code-vs-design gate does not report external I/O or libraries a component uses: a file
  read, `fetch`, an HTTP client or Python `requests` in a component that is not an Adapter, or a
  helper class no component realizes, passes `validate --ci`. Only a bound technology's packages
  are compared (`TECH_LEAKAGE_IN_CODE`). The "Never checked" line of `validate` now says so.
- Plain `wairon validate --ci` at a family root does not compose externals; `wairon validate
  --family` does, and `lock-check` gates on the pins.

## v6.1.2 (from v6.1.1)

A fix release from the review of 6.1.1 and from upgrading a large family. Nothing to do when
upgrading: install 6.1.2.

- **`wairon upgrade` keeps who calls a method.** A v5 `invokedBy: { kind: sibling-subsystem }` that
  no modelled call stands for is now rewritten to `kind: runtime` with its `caller` kept byte for
  byte, instead of dropped: the method stays reached, as it was, and the report names the call to
  model instead (`INVOKED_BY_REDUNDANT` then names the declaration to remove). A tree 6.1.1 already
  upgraded has lost those callers: recover them from version control, or upgrade the pre-upgrade
  commit again with 6.1.2.
- **`wairon upgrade` writes its report to `.wai/upgrade-report.md`.** Every rewrite and decision is
  there in full, one per line, so nothing has to be copied off a wrapped console.
- The upgrade report for a subsystem export no Portal backs no longer points at
  `EXPORT_UNCONSUMABLE`, which judges only the L0 table and L1 re-exports.
- **TypeScript, NestJS and Angular:** 6.1.1 counted a plain import used only as a type as a type
  import. In a class carrying a decorator, a constructor parameter or property type is emitted as a
  runtime injection token under decorator metadata, so it is a value use again, and an
  `UNDECLARED_EXPORT` crossing there is reported as before 6.1.1.
- **`UNDECLARED_EXPORT` no longer reports dependency injection by class.** A component that declares
  `dependsOn` on another and constructs or injects the class realizing it (decorated or not) is
  the dependency made real, not a surface reached across. A component without that dependency
  taking the class, or anyone taking an owned member's class, is still reported.
- **`wairon update` (Windows):** when the new build cannot be copied into place after the running
  one was moved aside, the running one is moved back, so the install is never left without
  `wairon.exe`; the error says the running wairon is unchanged.
- Validation no longer returns its internal reference bookkeeping when it stops early (no L0, an
  unknown subsystem).
- The MCP refusal for an unstamped project reads as a sentence; the upgrade's own refusal names
  leftover files from the project root, not from its temporary copy; the printed
  `subsystem externalize --path` is quoted.

## v6.1.1 (from v6.1.0)

A fix release for `wairon upgrade`. On a project whose design used a wairon 5 form the
upgrade could not decide for its author, it committed spec files wairon 6 refuses to
read. The tools then could not open those files, and every reference into them was
reported as a separate error.

Who is affected:

- **Projects upgraded from wairon 5 with 6.1.0** that used `invokedBy: { kind:
  sibling-subsystem }`, an export entry's `type` that no backing Portal derives (or
  that disagrees with the derived kind), or a `portalType` that names no transport.
  `wairon validate` shows them as `SCHEMA_VALIDATION_ERROR`s naming a "wairon 5 form".
- **Rust, C# and Kotlin designs** with a member named after a keyword the language can
  escape (`type`, `move`, `impl`...): that is a notice now, not an error.

### Finishing a stuck upgrade

1. Install 6.1.1 everywhere the project is checked.
2. At the top of the project, run `wairon upgrade`. A tree stamped 6 that still holds a
   wairon 5 form is an unfinished upgrade: the plan names it so, and applying it
   rewrites the remaining forms. No hand edit is needed.
3. Read the plan's reported items: each dropped declaration says what you can model
   instead. Then run `wairon lock` where the plan says a re-lock is owed.

### What changed

- `wairon upgrade` never keeps a wairon 5 form. What it cannot decide is dropped and
  reported:
  - A `sibling-subsystem` declaration whose call the tree already models goes
    silently. Otherwise the report quotes its stored caller, names the subsystem that
    caller names, and gives the routes the rules allow: a call step onto a published
    Portal, the route through the subsystem's Portal, or `invokedBy: { kind: runtime }`
    for a dependency the code receives at wiring time.
  - An export `type` is always dropped; one that disagreed with the derived kind, or
    that no Portal derives, is reported.
  - A `portalType` that names no transport is dropped; `MISSING_PORTAL_TRANSPORT`
    names the Portal until its transport is set.
- The upgrade checks its own result: a spec file still holding a wairon 5 form refuses
  the upgrade, and nothing is written.
- A spec file that exists but fails to parse is said so by `sdd_get_spec`,
  `sdd_update_spec` and the other tools, quoting the reason, instead of "does not exist".
  A wairon 5 form's refusal names `wairon upgrade`.
- References into a spec that fails to parse are folded into its parse error ("N
  references into it are not judged until it parses") instead of being reported one by
  one.
- `RESERVED_IDENTIFIER` is an error only for a keyword the language cannot escape (in
  Rust: `crate`, `self`, `Self`, `super`). A keyword it can escape is the notice
  `RESERVED_IDENTIFIER_ESCAPED`, naming the spelling (`r#type`, `@class`, a Kotlin
  backtick) and suggesting no rename.
- The MCP server's refusal for a project with no major stamp says no stamp was found
  and that wairon 5 is assumed, as `wairon upgrade` does.
- Moving a subsystem into a part declared first under the subsystem's id
  (`sdd_externalize_subsystem`, `wairon subsystem externalize`) planned nothing and gave no
  reason: it read the part as an externalize already done. It now moves the subsystem in.
  Adding a part also says how a subsystem gets into it: `sdd_add_subsystem` adds to the top
  project's tree, and externalize moves one into the part.
- **Python:** a narrated call deleted from the code is now reported (`CALL_STEP_UNREALIZED`).
  Python code is read without a type checker, so a call is matched by name: a claim is
  reported only when the method's code makes no call by that name at all. The
  "Code checked" line says so ("a narrated call by name"). Before, only calls the code
  makes that the narrative does not name were judged for Python, though the line said
  calls were checked.
- **TypeScript:** a class imported with a plain `import { X }` and used only as a type (a
  constructor parameter, an annotation) no longer draws `UNDECLARED_EXPORT` on the file
  that exports it; it is a type import whatever its spelling, as `import type` was.
- **HTTP Portals:** an endpoint path that repeats its Portal's `basePath` (`basePath: /products`
  with `/products/{id}`, which serves `/products/products/{id}`) is the new warning
  `ENDPOINT_BASEPATH_REPEATED`, at design time. `UNDECLARED_ROUTE` and `UNROUTED_ENDPOINT` print
  the full joined route, and say so when the code and the design differ only by a repeated
  basePath. A route printed as `//…` is fixed. Designs that repeat the prefix now fail
  `--ci`: drop the prefix from the endpoint paths, or the `basePath`.
- A project member added through the MCP server (`sdd_add_member` with `as: project`) is set up
  for its own sessions (guide, skills, `.mcp.json`), as `wairon member add` already did; before,
  a session opened in its folder had no wairon tools.
- A migration run through the MCP server no longer lists the spec tree's write lock as a
  file to delete, and never removes the lock a running write holds.

### Known limitations

- After `wairon lock`, approved and unchanged specs are judged as complete, so
  `UNUSED_COMPONENT` on an approved draft component is no longer waived by `validate --ci`
  (the waiver covers draft components only until they are approved). Wire or remove the
  component before locking.

### Small fixes

- `wairon update` on Windows no longer fails with "wairon.exe is currently in use" when an
  MCP server started before the previous update is still running from the old binary:
  the update moves the running exe aside under a fresh name, and leftovers are swept
  once no process runs from them.
- `wairon upgrade` on an unstamped 6.0.0 tree no longer says "written by major 5
  (unstamped)": it says "made by wairon 6.0.0, before the major stamp".
- `OPEN_ROUTE_CALL` no longer says "read as full, not stated".

## v6.1.0 (from v6.0.0)

v6.1 moves compatibility out of the core: a release reads only its own major's forms,
and `wairon upgrade` moves an older tree forward once. It also fixes which type a bare
type name means, and makes an SSO provider name the addresses it may return to.

Who is affected:

- **Every project:** the tree is stamped with the major that wrote it, once. The
  approval carries over unless 6.1.0's rules find something in the approved design.
- **Teams and CI:** move together. wairon 6.0.0 reads the stamp as an unknown setting,
  so its `validate --ci` fails on an upgraded tree.
- **Designs with same-named types in different subsystems:** a reference may now bind
  to another type, or report `AMBIGUOUS_TYPE_REF`.
- **Hosted operators:** an SSO provider with no allowed redirect addresses stops signing
  anyone in, and the server upgrades its data directory when it starts.

### Upgrading from v6.0.0

1. Install 6.1.0 everywhere the project is checked: every teammate, CI, and the
   `wairon` your assistant's MCP server starts.
2. At the top of the project (the family root, when it has members), run
   `wairon upgrade`. A 6.0.0 tree needs no rewrite, so it is only stamped
   (`waironMajor: 6` in each `.wai/project.yaml`), without asking. Any other `wairon`
   command stamps it too. Until it is stamped, the MCP server refuses every tool and
   names `wairon upgrade`.
3. Run `wairon generate` to refresh the guides and skills, then reconnect your
   assistant's MCP server (in Claude Code, `/mcp`) or start a new session.
4. Run `wairon validate --ci` and `wairon lock-check`. If the approved design is clean
   under 6.1.0's rules, the approval carries over. If not, it is stale for exactly the
   findings it names. A type finding (`AMBIGUOUS_TYPE_REF`, or a type that now reads
   unused because its references used to bind to another subsystem's namesake) is fixed
   by writing the type's id or `subsystem::name` where it is referenced. An
   `UNNARRATED_CALL` on a method whose `detail` is stated means its code calls something
   the narrative leaves out: narrate the call. Then run `wairon lock`.
5. Commit each `.wai/project.yaml`, the regenerated files, and `.wai/lock.json` if you
   re-locked.
6. **Hosted:** before you restart the server on 6.1.0, give every enabled SSO provider
   its allowed redirect addresses, usually `https://<this host>/web/sso/callback` (see
   the SSO section below). At start, the server copies its data directory beside itself
   and then upgrades it. An environment setting that still holds a retired value stops
   the start and names its replacement. Scripts that call the admin provider API need
   to read the new answer shapes.

### Major upgrades: `wairon upgrade`

wairon now keeps compatibility out of its core: each release reads only its own major's
forms, and a tree another major wrote is moved forward once, by an upgrade step per major,
run in order. Every `.wai/project.yaml` records the major that wrote it (`waironMajor`,
written when a project is created).

- `wairon upgrade` brings a project and every member below it to the running major, all
  or nothing: it prints the plan (`--report` stops there), asks, and applies it
  (`--yes` for scripts). It names each project whose design moved: run `wairon lock`
  there. It never locks. From 5 to 6 it does what `wairon doctor --fix` did for a v5
  tree: the old lock formats, legacy spec file names, a legacy `.wairon` folder,
  chained subprojects without a configuration, legacy L1 mounts into `members` with
  their references rewritten to `alias::name`, Specialists retyped, and the
  reachability model.
- Before a project command runs, wairon checks which major wrote the tree. A tree made by
  6.0.0 carries no stamp but needs no rewrite: it is stamped on the spot. Any other older
  tree is offered the upgrade on a terminal and refused in CI, naming `wairon upgrade`.
  A tree a newer wairon wrote is refused, naming the release to install. The MCP server
  refuses every tool on a tree another major wrote, until the human runs
  `wairon upgrade`.
- `wairon whatsnew [version]` prints a release's highlights, and the first command after
  an update shows the highlights of every release since the one you last saw, once.
- `wairon doctor` reports the major the tree was written by, and no longer carries the
  v5 repairs or the `--report chaining` and `--report reachability` sections.
- **Hosted:** the server upgrades its data directory when it starts: it copies the
  directory whole beside itself, applies the permission model, upgrades every hosted
  project's tree, registers the member records, and records the major in
  `<dataDir>/version.json`. Any failure stops the start, naming the backup to restore.
  `wairon host doctor` is removed: everything it did now happens at start.
- The "until the next major release" promise for deprecated forms is withdrawn: forms
  are not kept alongside the current ones, `wairon upgrade` rewrites them.

### Breaking: the core reads only wairon 6 forms

The forms wairon 5 wrote are read only inside `wairon upgrade`. Anywhere else a tree
holding one does not load: the error names the form and what replaces it. The forms are:

- `portalType` (read `transport`) and `HTTP_API`;
- the `Specialist` and `Gateway` stereotypes;
- listener `mounts`, and an `invokedBy` of kind `external` or `sibling-subsystem`;
- an export entry's `type`;
- a legacy L1 mount (`projectPath`) and a member's long-form `path` (read `source`);
- the reference forms `::x`, `super::x` and member paths (read `local_id` and `alias::name`);
- lock record formats 1 and 2;
- a `.wairon` folder.

- `wairon upgrade` now merges each Gateway into the Portal it owned, which takes the
  `gateway` variant. A Gateway it cannot merge refuses the upgrade, naming the hand
  steps.
- A v5 lock record that nothing proves unchanged is kept in the current format and reads
  stale until `wairon lock`. Before, it was left unreadable. A lock record or tree the
  upgrade cannot read now fails the upgrade instead of being skipped.
- Removed rules: `DEPRECATED_REFERENCE_FORM`, `DEPRECATED_MOUNT_FORM`,
  `INVOKED_BY_RETIRED_KIND`, `STEREOTYPE_RETIRED` and `PACK_FIELD_DEPRECATED`.
- Removed CLI surface: the `wairon packs` alias, `generate --no-recurse`,
  `lock --no-recursive`, and `doctor --report composed-validation` with its verdict
  changes.
- Removed MCP inputs: `HTTP_API`, the export `type` input, and the `projectPath` input.
- A pack's `foreignBuiltins` is a load error naming its removal.
- An L0 export entry's `id` and `subsystem` are wairon 5 forms: `wairon upgrade` rewrites
  them to `as` and `from`.

### Breaking: the hosted server reads only wairon 6 forms

The server rewrites what an older major stored once, when it starts on an older data
directory, and refuses those forms afterwards:

- **Member-qualified selectors.**
  - A `projectId::alias` selector or token entry is no longer resolved. A request
    naming one gets 400, and minting one is refused: name the member by its own
    project record id.
  - The start upgrade rewrites stored token entries to the member's record id. It
    drops an entry that names no member, and revokes a key left with none.
- **Old lock requests.** A lock request recorded with a member scope is closed at
  start: a pending one is denied, an approved one cancelled, so the requester can ask
  again on the member's record. Executing a lock request that carries a scope is
  refused.
- **Retired stored values.**
  - `adminApiMode` values `local_only`, `private_network` and `public` become
    `enabled`.
  - The user statuses `suspended`, `deactivated`, `disabled` and `deleted` become
    `inactive`.
  - A surface audience of `public` becomes `external`.
  - Each is refused afterwards, naming the file and the values it accepts.
- **Share snapshots.** A snapshot keeps only its per-portal OpenAPI capture. A share
  captured before per-portal captures loses its OpenAPI download until its owner
  refreshes it; its canvas and HTML stay.
- **Policy variables.** `WAIRON_AUDIT_POLICY` `metadataMode: full-redacted` and
  `WAIRON_QUOTA_POLICY` `mode: block` stop the start, naming `redacted` and `observe`.
- **Exposure policy errors.** An exposure policy file that cannot be read now fails
  loudly, instead of the server silently using the default posture.

### Breaking: an SSO provider must name the addresses it may return to

An enabled SSO provider with no allowed redirect addresses no longer signs anyone in.
Before, an empty list accepted any address; now it accepts none, and a provider names
the addresses it may return to (`allowedRedirectUris`, or `WAIRON_OIDC_ALLOWED_REDIRECT_URIS`
for the provider the server registers from the environment). Usually that is one
address, `https://<this host>/web/sso/callback`.

- The login page lists such a provider as not set up yet, with a disabled button; trying
  to sign in anyway answers that sign-in through it is not set up and to ask an
  administrator, and the refusal is audited (`web.signin.refused`, `sso.refused`).
- The admin view shows a warning on the provider and suggests the address; saving a
  provider answers the same warning. The server log names each such provider at start.
- The admin API changes shape: the provider list answers `{ provider, setupProblem? }`
  entries, and saving a provider answers `{ provider, warnings }`.

### Fixes: a type is the one its own subsystem names

- A bare type reference now resolves in the subsystem that writes it first. Before, it
  bound by id suffix alone, so a contract in one subsystem could bind silently to a
  same-named type of another and leave its own type unused.
- New warning `AMBIGUOUS_TYPE_REF` (rule `type-ref-scope`): a reference that matches
  several types with nothing in its own subsystem to settle which is meant, or that binds
  to a type while another type carries that display name and sits at least as close to
  the referrer (its own subsystem nearest, a project-level type in the middle, another
  subsystem far, so two project-level types sharing a name are caught too). One finding
  per spec and written reference, naming every position it is written at. Write the
  type's id, or `subsystem::name`, to say which is meant.
- Two types of different subsystems declaring one id (`DUPLICATE_SPEC_ID`) no longer
  hide the second one: `subsystem::id` reaches it, and the finding names both
  `sdd_rename_type <subsystem>::<id> <new id>` calls. Renaming either half moves only
  its file and respells only the references that resolve to it.
- `sdd_rename_type` respells only references that resolve to the renamed type from where
  they are written. It refuses, listing every site as `<file> <position>`, a reference
  that matches several types including it (`ambiguous-ref`, no escape), and one that binds
  to it while another type carries that name and sits at least as close (`shadowed-ref`):
  write which type is meant in those specs, or pass `allowShadowed` to rename anyway and
  respell them. A dry run lists the shadowed sites separately instead of refusing. Its
  description now says which signatures it rewrites: a signature type's params and
  returns, a contract method's stored text re-derived from its params, and only the
  result of a prose signature that has no params.

### Release QA

- A release's QA verdict passes only when `release-notes/<version>.md` exists with at
  least one highlight.

### Small fixes from the v6.0.0 QA panel

- `wairon mcp install` and `doctor --fix` name the Gemini CLI for the project
  `.gemini/settings.json`, and Antigravity only for its global `mcp_config.json`.
- `wairon doctor` no longer closes with "Most issues clear with `wairon generate`" when
  the warnings left are ones `generate` does not clear; each warning names its own fix.
- `wairon status` explains a completeness below 100% in one line: 20% a component's spec,
  +30% a contract, +30% an implementation, +20% once the source files it names exist.
- `wairon host key list` shows each key's owner (or that it has none and so no
  permissions), its label, expiry and revocation; the legacy role shows only where set.
- A contract method stating no parameters is refused with the fix (`params: []`), and
  `INTENT_FLOOR` says what counts as thin (under 40 characters, or only the method's name).
- Docs: the code reading checks structure and linkage, never behaviour (a dropped business
  rule is caught by tests, not the gate).

### Fixes from the v6.1.0 QA panel

- `wairon upgrade` on a 6.0.0 project with a part (a folder holding some of its
  subsystems, with no `project.yaml` of its own) failed on every command ("Cannot stamp
  …: it has no project.yaml"). A part carries no stamp: it goes along with the project
  that declares it, and only a folder holding a `project.yaml` is stamped.
- `wairon member add <alias> <path> --project` now sets the new project's folder up for
  its own sessions, as `member promote` does: its guide, skills and context, and its
  `.mcp.json` when claude is a target.
- **A narrative's calls are judged by how much it states.** Before, a call to a
  collaborator a narrative never named passed silently, whatever the narrative claimed,
  so code could take on a whole new collaboration while `validate` read green.
  - **Stated detail is binding.** A method whose `detail` (`full` or `calls-only`) is
    set on the method or its implementation, or that declares `calls`, has said its
    narrative is complete: every call into another component that no step names is
    `UNNARRATED_CALL` (warning). A narrative that states its detail and misses calls
    newly fails `--ci`: narrate the calls.
  - **Unstated detail is open.** Leaving out a verb of a collaborator the narrative names
    is still `UNNARRATED_CALL`. A call to another collaborator the component depends on,
    or any such call from a method at `intent` or with no narrative, is a route the
    design allows without saying the method takes it: the new `OPEN_ROUTE_CALL` notice
    names each one and never fails `--ci`.

### Known limitations

- Hosted: when a lock request is still pending and someone with the right to lock
  approves the same design directly, deciding the request later approves that design
  again and records the decider as the approver. The request is checked against the
  design it was made for, so it never approves a design nobody asked about.

## v6.0.0 (from v5.1.0)

**Breaking: a major release.**

v6 makes a wairon project a set of **projects that name each other**. A project has
an id, its levels export like a module, and another project is reached only as
`alias::name` through a member or a declared external. A part of a system that only
lives in another folder or repository is a **part**, not a project. Around that:
approval is per project and the same on every machine, packs apply only where a
project selects them, contract types use one language-neutral grammar, logic is an
Orchestrator (Specialist and Gateway retire), and the validator checks readability
and reads the code more closely. Reach is modelled too: every Portal verb is either
called by the design or declared an entry, Portals state one `transport`, listener
`mounts` retire, projects may declare networks with gateways, and another project's
library is called directly.

Who is affected:

- **Every project:** the first `validate --ci` after upgrading reports new findings,
  and every lock reads stale once. Run the upgrade steps below. Portals are no longer
  reached just by existing, so a Portal verb that no modelled caller reaches reports
  `UNUSED_COMPONENT` / `UNUSED_METHOD` until its entry is declared.
- **Families (a project with chained subprojects):** the chained mounts become
  `members`. `wairon doctor --fix` migrates them.
- **Hosted operators:** run `wairon host doctor --fix` once. Several admin API
  answers and defaults change.
- **CI:** `validate --ci` can newly fail. The optional `lock-check` workflow is new;
  it also runs `validate --ci`, which belongs at the family root.
- **MCP clients and scripts:** some tools are renamed or removed, 16 tools declare an
  `outputSchema`, and nested unknown keys are refused. `sdd_add_component` takes
  `transport` instead of `portalType` and no longer takes `mounts`.
- **Generators reading `wairon export`:** the design export is format 2.0.
- **Library embedders:** `validateSddTree` is now `validateProject`, with no alias,
  and 99 exports are gone.

### Upgrading from v5.1.0

> **From v6.1.0 on**, steps 2, 3 and 5 are done for you: run `wairon upgrade` at the top
> of the family (`--report` for the plan), and a hosted server upgrades its data directory
> and every hosted tree when it starts. `wairon host doctor` and `doctor --report chaining`
> no longer exist. The rest of these steps still apply.

Follow these in order. Every `doctor --fix` rewrite moves the gate identity, so lock
last.

1. **Upgrade wairon everywhere at once:** developer machines, CI (and the
   `setup-wairon` action's `version`) and the hosted server. Then restart or
   reconnect each AI tool's wairon MCP server. A server whose build on disk changed the
   spec schemas now refuses every spec write and says so. A machine with two installs
   (an old standalone binary and the npm package) can start an older server than the CLI
   you run, because the committed `.mcp.json` says `wairon` and the PATH decides which:
   `wairon doctor` names the version that entry starts when it differs from the CLI's,
   and a server older than the wairon that last wrote the project (its lock or guides)
   leads its `sdd_get_status` answer with an `OLDER SERVER` banner.
2. **Hosted operators: `wairon host doctor`, then `wairon host doctor --fix`.** The
   dry run prints the plan. `--fix` migrates a data dir that predates the permission
   model. It also registers every member that hosted families declare as a project
   record of its own. It grants nothing: access is inherited, so everyone's reach
   stays the same, and the plan shows that before anything is written. `wairon serve`
   warns at startup while this is pending. It also migrates every hosted project's
   spec tree onto the reachability model (the same rewrites as step 5), audited per
   project; each project it rewrote owes one re-lock by its approvers. The server
   never applies this on its own when it binds a project, because the rewrite moves
   the approved design.
   - To upgrade a hosted project's spec tree, pull it into a checkout
     (`wairon remote pull`), run steps 3–8 there, then push it back
     (`wairon remote push --force`, which backs up the tree it replaces).
3. **Read the plan first: `wairon doctor`** at the top of the project. It writes
   nothing. It lists every repair `--fix` will make, for this project and for each
   member below it. In a family, also run:
   - `wairon doctor --report chaining`, for the member migration and the new
     cross-project dependencies it adds;
   - `wairon doctor --report composed-validation`, for which of today's findings are
     new and why.
   - Read the new dependencies first. A cycle between two projects
     (`PROJECT_DEPENDENCY_CYCLE`) usually means a reference that should move.
4. **Decide on machine-wide packs.** Packs installed machine-wide no longer apply to a
   project that has not selected them. `wairon doctor` lists the installed packs a
   project does not apply. Either:
   - select the ones the project relies on by name (`wairon pack use <name>`); or
   - set `extensions.useGlobalPacks: true` in `.wai/project.yaml` first, to keep the
     old behaviour on that machine.

   `doctor --fix` never selects them for you: what is installed on one machine is
   not the project's doctrine.

   A subsystem whose `profile` comes from an unselected pack reports `UNKNOWN_PROFILE`.
5. **Run `wairon doctor --fix` once, from the top of the family.** In scripts, use
   `--fix --yes`. Writes outside the project root also need `--global`. It applies:
   - recovery of an unfinished family migration;
   - Specialists retyped to Orchestrators with a `dependencyClass`;
   - stray narrative-step fields (`FOREIGN_STEP_FIELD`) removed;
   - stored signature texts regenerated;
   - stored type spellings rewritten to the canonical grammar. This includes
     `Result<T, E>` → `result<T, E>`, `()` → `void`, `T[]` → `list<T>`,
     `T | null` → `T?` and `Promise<T>` → `async T`;
   - the reachability migration. `portalType` becomes `transport` (`HTTP_API` is
     `HTTP`; a `Custom` Portal that binds no wire address becomes `InProcess`), each
     listener's `mounts` become a Portal-level entry on every Portal it served and
     that Portal's implementation `router` (the mount's `via`), `invokedBy: external`
     becomes `entry` on a Portal verb and `runtime` elsewhere, an authored export
     `type` that agrees with the derived kind is dropped, in-process `Custom`
     endpoint addresses are removed, and allows of retired codes are dropped or
     renamed. It never invents design: what it cannot decide is listed for an author
     (`wairon doctor --report reachability`);
   - the member migration. Each legacy L1 mount moves into `members`, ids are
     declared, the exports, externals and `use` imports each reference needs are
     written, deprecated reference forms are rewritten to `alias::name` or a bare
     local id, and the result is pinned. The old family surface pins are deleted.
     A reference the migration cannot follow (such as `target-unpublished`: the
     target is not in its subsystem's L1 `publicInterfaces`) is named in the run with
     its hand fix. What it moves for the rest is written, but nothing is written for
     that reference, and a finding that blocks the apply writes none of the
     migration. Fix those by hand (step 7), then re-run `wairon doctor --fix`; the
     export and `use` import follow once the target is published.

   **Members are repaired by the same run.** Every member inside the project root gets
   the per-project repairs, each line marked `[alias]`: its specs, and its agent
   surfaces (the project `.mcp.json`, the guide, the `.wai/context` documents and the
   skills), so an assistant opened in the member's own folder has the wairon tools.
   A machine-wide registration stays the one plan the top asks about. A member in a
   sibling checkout (`../x`) is named with the command to run in its own directory.
   Plain `wairon doctor` lists, per member, what is pending, agent surfaces included.

   **Committed agent files are kept.** A `project.yaml` that never set
   `rules.materializeAgentFiles` reads as `true` while wairon-managed agent files are
   committed (or staged) in git, so the first lock keeps them. A save at the project's
   root writes `true` down. Ignored or untracked leftovers (a gitignored `.claude/`)
   do not count: such a project gets live briefs, and the lock writes no agent files.
   Outside a git repository every managed agent file present counts.
6. **Make the pack selections reproducible for CI.** CI has no pack store, so a
   declared pack it cannot get is `PACK_NOT_INSTALLED`, and every command refuses.
   Either:
   - run `wairon pack bundle --all` and commit `.wai/packs/`; or
   - record a fetchable source (`wairon pack use <name> --source <url>`) and run
     `wairon pack sync` in CI (or the `setup-wairon` action with `packs: sync`).

   A pack installed from a local path has no URL, so bundle it. Otherwise it reports
   `PACK_SOURCE_UNFETCHABLE` and fails `--ci`.
7. **Settle by hand what `doctor` lists but never writes:**
   - **Gateways.** The Portal the Gateway owns becomes the front door, with
     `variant: gateway`. Its other members become that Portal's dependencies, its
     consumers depend on the Portal, and the Gateway spec is deleted.
     `sdd_rename_component` can give the Portal the Gateway's id.
   - **`number` positions.** Write `int` or `float`. `doctor` proposes `int` where
     the name says a whole number.
   - **String-literal unions.** `doctor` proposes an enum (its id and values) but does
     not write it. Define the enum with `sdd_add_type` (`kind: enum`), then write its
     id in the position.
   - **Type forms the grammar leaves out.** Each is named with its replacement. An
     inline object or a mixed union becomes a value-object, and a single value gets a
     named scalar (`holds`). An inline function type becomes a `signature` type.
   - **Migration findings.** These include `positional-ambiguous` (pick the
     producer), `import-shadowed`, `import-collision` and `target-unpublished`
     (publish the target in its subsystem's L1 `publicInterfaces`, or move the
     reference; then re-run `wairon doctor --fix`, which writes the export and import
     it was waiting on). A legacy mount that carries
     `trustedLinks`, `lifecycle`, `profile`, `targetLanguage`, `designDepth` or `ext`
     blocks the migration until that member holds the field itself.
   - **Supervisors.** A Supervisor narrative that calls shared data must call methods
     tagged `effect: read` or `effect: lifecycle`. Move each write into an
     Orchestrator.

   Write these through the MCP tools, which regenerate a method's signature text. A
   type you change by editing the spec file leaves `SIGNATURE_TEXT_STALE` until you
   run `wairon doctor --fix` again.
8. **Run `wairon validate --ci` and work through the findings** (`--all` prints every
   one). Most are covered by the codes table below. The usual remedies:
   - Split a coarse `lint.allow` into one allow per site (`at:`). The
     `UNUSED_LINT_ALLOW` finding lists the sites.
   - Delete allows that name retired codes, and allows whose finding no longer
     fires (`UNUSED_LINT_ALLOW` says "no such finding fired").
   - Write a method's `calls` where its narrative shows no steps.
   - Declare the entries the migration will not invent. A Portal whose callers are
     outside the design takes a Portal-level `invokedBy: { kind: entry, caller }`:
     a CLI, a stdio tool surface (`transport: JSONRPC`), a library or SDK
     (`transport: InProcess`), and any HTTP Portal no listener mounted. Never declare
     one only to quiet a finding.
   - Settle every other unreached verb: model the caller that really calls it, or
     remove it.
   - Make a member's parent-relative `sourcePath`s relative to the member.
   - Plan a `sourcePath` on every component not built yet. A project that generates
     one implementer agent per component (`rules.generateComponentImplementers`)
     reports `NO_OWNED_PATHS` for each component whose implementation names no file,
     and the fix is the planned file, not a `meta` tag: set it with
     `sdd_write_narrative` or `sdd_update_spec` (`sourcePath`; the file need not
     exist yet). It is a notice, like `MISSING_SOURCE_PATH`, so it does not fail
     `--ci`, unless `rules.conformance.requireCode` is on, which makes every unplanned
     or unbuilt component an error. Planning the path is code linkage: it does not
     reopen the approval.
   - A Portal that a member exports and only the parent calls reports
     `UNUSED_COMPONENT` inside the member, which cannot see the parent's call. Declare
     the entry in the member: a Portal-level `invokedBy: { kind: entry, caller }` naming
     the parent (or the outside caller that really reaches it). `sdd_list_consumers`
     shows who calls the verb across the family.
   - To soften a warning while you pay it down, set it to `notice` in
     `rules.sddRuleSeverity` (notices never fail `--ci`).
   - Re-pin with `wairon externals pin` after editing what a consumer uses.
9. **Lock bottom-up: each member project first, then the top.** Run `wairon lock` at
   each project's own root and commit `.wai/lock.json`. A part has no lock of its
   own: the parent's lock covers it.
   - `lock` refuses only on design errors. It records code-conformance results beside
     the approval and does not block on them, so a passing lock alongside a failing
     `validate --ci` is expected until the code findings are paid.
   - `lock` no longer writes `status: complete` into spec files.
   - `lock` accepts a design that still has drafts or warnings (approval is not
     status), and says how many findings `validate --ci` would fail on. Run
     `validate --ci` until it passes before locking a design meant to be finished.
   - `wairon diagram` writes `.wai/docs/diagrams/`, which is derived and never read
     back: commit it to browse the diagrams on GitHub, or ignore it.
   - A lock written by an earlier v6 build (format 2) still passes while nothing it
     covers moved. Run `wairon doctor --fix` to re-express it as format 3: who
     approved it and when are kept, and the record notes `reexpressed`. One that
     already drifted needs one `wairon lock`; after that, linking code never
     drifts it.
10. **Update scripts and integrations** for the renamed CLI commands, MCP tools,
    library exports and hosted API answers in the tables below.
11. **Optional: gate merges on approval.** `wairon lock-check` is new and fails only
    when a design moved past its approval:

    ```yaml
    jobs:
      approved-design:
        uses: SYW-Apps/Waffle-AIron/.github/workflows/lock-check.yml@v6.0.0
        with:
          wairon-version: '6.0.0'
    ```

    Pin both the ref and `wairon-version`: the gate identity's algorithm can change
    between versions. Turn on `strict: true` only once re-locking is part of review.
    After the approval check the job runs `wairon validate --ci` (input `validate`,
    default `true`). Point `working-directory` at the family root, the project that
    declares the members: there it is the family run, which judges the network
    proofs a member's own gate cannot.

`.wai/transactions/` (staged family migrations) ignores itself. Never commit it.

### Breaking changes

#### CLI

| v5.1.0 | v6.0.0 |
|---|---|
| `wairon subsystem add <id> --project-path <dir>` | `wairon member add <alias> <source>`: creates a **part** (`--project` creates a project) |
| `wairon subsystem move <id> --project-path <dir>` | `wairon member move <alias> <path>` |
| `wairon subsystem internalize <id>` | `wairon member internalize <alias> [--into <subsystem>] [--packs adopt\|drop]` |
| `wairon subsystem externalize <id> --project-path <dir>` | `wairon subsystem externalize <id> --path <dir>`: moves it into a **part** (`--as project` creates a project) |
| `wairon surface externals` | `wairon externals status` / `wairon externals list` |
| `wairon surface generate-children` | removed: a parent pushes nothing into its members; a consumer pins with `wairon externals pin` |
| `wairon host promote` | removed: `wairon lock` is the approval |
| `wairon validate` at a project with members | runs the **family run**; `--no-recursive` runs the project's own gate alone |
| `wairon generate` at a parent | writes this project's outputs only; `--family` walks the members (`--no-recurse` is accepted and ignored) |
| `wairon lock` | approves this project only, refuses on design errors only, rewrites no spec file (`--no-recursive` is accepted and ignored) |
| `wairon generate` with `materializeAgentFiles` off | writes no agent files and removes wairon-managed ones; agents are live briefs |
| `pack use\|unuse\|add\|remove\|install`, `host packs install\|remove --project` | show the pack's impact and ask in a terminal; pass `--yes` in scripts |
| `doctor --fix`, `subsystem externalize`, `member internalize` | print a plan and ask; `--yes` in scripts, `--report` to see the plan only |
| `doctor --fix` / `generate` writing outside the project root | needs `--global` (each replaced file is backed up) |
| `wairon generate --target <unknown>` | refused, naming the configured targets |
| Which project a command binds (every command, `wairon mcp serve`, `wairon dev`) | the walk up to the nearest project stops at the repository root (the nearest folder holding `.git`) unless a project above declares the folder as a member; a stray `.wai` above a repository binds nothing. Each command prints `project <id> at <root>` on stderr |
| `wairon init -y` | configures the `claude` target only (name from the folder, profile backend); another tool is one interactive answer or one `targets` entry away |
| `wairon init` in a folder a parent project binds | asks on a terminal before making the folder a member, which edits the parent's `project.yaml`; with `--yes` it refuses, writes nothing and prints the `wairon member add <alias> <path> --project` to run from the parent |
| `wairon externals status` | exits 1 when an external is incompatible and 2 when something could not be compared (it always exited 0); a CI step that ran it for information now gates |
| `wairon externals pin` | exits 1 when an alias could not be pinned (unresolved or unreachable) |
| `wairon lock-check` at a project with members | judges the members too: a member with spec changes nobody approved fails, and a member that re-locked fails until this project is locked again to pin its new approval. `--strict` also fails a member that was never approved |

#### MCP tools

| v5.1.0 | v6.0.0 |
|---|---|
| `sdd_add_subsystem` with `projectPath` | refused; use `sdd_add_member` (`source`, `as`) |
| `sdd_move_subsystem_project` | `sdd_move_member` |
| `sdd_internalize_subsystem` | `sdd_internalize_member` (`into`, `packs`, `exports`, `dryRun`) |
| `sdd_externalize_subsystem { projectPath }` | `sdd_externalize_subsystem { path, as, dryRun }` |
| `sdd_set_subsystem_project_path` | removed: members are configuration |
| `sdd_list_external_interfaces` | `sdd_pin_externals` / `sdd_get_externals_status` |
| `sdd_host_promote_project` | removed |
| Unknown key nested in a tool's input (a method, param, step, endpoint, …) | refused by name; it used to be dropped silently. `sdd_update_spec`'s `delta` stays open and lists ignored keys under `ineffective` |
| Tool results | 16 tools declare an `outputSchema` and return `structuredContent` beside the unchanged text: the six create tools, `sdd_update_spec`, `sdd_get_spec` (the spec sits under `spec`), `sdd_validate_tree`, `sdd_set_endpoints`, `sdd_set_public_interfaces`, `sdd_delete_spec`, `sdd_add_member`, `sdd_pack_impact`, `sdd_pin_externals`, `sdd_get_externals_status`. A proxy that rewrites results must carry `structuredContent` |
| Finding severity | can be `notice`; `sdd_validate_tree` returns a separate `notices` list. The `crossTreeContext` marker is gone; a family run adds `projects` and a `project` key per finding |
| Change report `change` | can also be `renumbered`, `relocated` or `reordered` (a list restated in a new order now takes that order) |
| `sdd_update_spec` with `id`, `createdAt`, a component's or type's `subsystem`, a contract's `component` or an implementation's `contract` | refused, naming the tool that owns the change; it used to write a second spec or move the folder |
| `sdd_delete_spec` | deletes the spec with what it contains, is refused while specs that stay reference it (`force`, `dryRun` are new); the answer gains `dryRun`, `removed`, `references` |
| Spec writes introducing a doctrine-edge or duplicate-route error | refused at write (a code tuned down in `sddRuleSeverity` is a notice) |
| `sdd_update_spec` deltas | the merge semantics changed (array merges, step deletes and step retypes). See *Fixes*; a script that relied on the old behaviour was writing specs nobody intended |
| Spec writes through a server older than the build on disk | refused with `writesRefused: true`; reconnect the server |
| Spec schema (`Specialist`, `Gateway`, `number`, L1 `projectPath`) | refused at write |

#### Library (`@wairon/cli`)

`validateSddTree` is renamed with **no alias**. The package entry exports 509 names
(v5.1.0: 313). 99 are gone, all of them internals a star export had swept in.

| Removed | Use instead |
|---|---|
| `validateSddTree` | `validateProject` (one project's gate), `validateFamily` (the family run) |
| `saveSystemSpec`, `saveSubsystemSpec`, `saveComponentSpec`, `saveInterfaceSpec`, `saveImplementationSpec`, `saveTypeSpec`, `delete*Spec` | `saveSpec(kind, spec)`, `deleteSpec(kind, id)`, `loadSpec(kind, id)` |
| `createChainedSubsystem`, `moveSubsystemProject`, `internalizeSubsystem` | `createMember`, `moveMember`, `internalizeMember(alias, destination)` |
| `saveProjectConfig` | `createProjectConfig`, `setProjectType`, `recordProfileSelection`, `setExecutionTier`, `registerPackRef` / `deregisterPackRef`, `upsertPackSelection` / `removePackSelection`, `markSelectionsBundled`; `projectConfigExists()` |
| `listExternalInterfaces`, `projectSubsystemSurface`, `projectChildSurface`, `generateChildSnapshots`, `checkChildSurfaceFreshness`, `loadSurfaceSnapshots`, `saveSnapshot` | `pinExternals`, `getExternalsStatus`, `exportSurface`, `importSurface`, `listExternals` |
| `findDomain`, `listFreeStandingDomains`, `deriveSubsystemDomains`, `addFreeStandingDomain`, `removeFreeStandingDomain` | `resolveDomains`, `addDomain`, `removeDomain` |
| `extractGenericTypeVariables`, `extractTypeGenerics`, `extractTypesFromSignature`, `LANGUAGE_MARKERS`, `normalizeLanguage` | no replacement on the entry |
| Context documents (`contextDir`, `CONTEXT_PATHS`, `renderDomainsDoc`, `renderWaironGuide`, `read*Context`, `write*Context`, `hasArchitectureContext`), the OpenAPI codec (`toOpenApi`, `toOpenApiSet`, `fromOpenApi`, `isOpenApiDocument`), skill and template registry internals, pack manifest schemas, spec path helpers (`get*Path`), group-spec functions, the status ratchet (`promoteAllComplete`, `applySpecStatus`, `collectPromotableSpecs`) | no longer exported |

Also: `LoadedExtensions` has the required fields `instructions` and
`selectionFailures` (build one with `emptyExtensions()`). In the code model,
`SourceFileFacts.functionCalls` is replaced by `functionCallSites` (read each site's
`name`). The embedding API in `docs/extending-wairon.md` is exported by name, and
`examples/wrapper/wrapper.js` calls `validateProject`.

#### Finding codes that can newly fail `validate --ci`

`--ci` fails on errors and warnings, never on notices. Code-conformance findings
(marked †) need an implementation `sourcePath` and fire at exact analysis grade.

| Code | Severity | Fires when | Remedy |
|---|---|---|---|
| `STEREOTYPE_RETIRED` | error | a component is still `Specialist` or `Gateway` | `doctor --fix`; Gateways by hand (step 7) |
| `DEPENDENCY_CLASS_VIOLATION`, `DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR` | error | logic reaches past its `dependencyClass` (`pure`, `read`), or the class sits on a non-Orchestrator | change the class or the edge |
| `SUPERVISOR_WRITE_SHORTCUT` | error | a Supervisor calls a shared data method whose effect is not `read` or `lifecycle` | tag the method, or route the write through an Orchestrator |
| `SUPERVISOR_CONTAINMENT`, `SUPERVISION_STATE_INTRUSION`, `LIFECYCLE_CALLS_WRITE`, `ARCHITECTURE_VIOLATION_SUPERVISOR_DEP` | error | a Supervisor owns more than its own Store or Registry, another component reaches that state, a `lifecycle` method calls a write, or a Supervisor depends on a presentation block | follow the message |
| `ACTOR_REACHED_WITHOUT_SUPERVISOR` | error | a live Actor is reached neither through a Supervisor that supervises it nor through a Registry such a Supervisor maintains | model the lookup hop |
| `UNDECLARED_DEPENDENCY_CALL`, `PORTAL_WRITE_SHORTCUT`, `ROUTER_COMPONENT_CONTAINMENT`, `CIRCULAR_DEPENDENCY` | error | existing rules now also judge calls through a pinned contract, a Portal's dispatch table, a RouterComponent owning two Portals, and a cycle through a `--subsystem` scope | fix the edge |
| `DUPLICATE_STEP_LABEL` | error | two steps of one narrative share a label | rename one |
| `DUPLICATE_SPEC_ID` | error | two spec files of one project declare one id | remove or rename one |
| `DUPLICATE_MEMBER_NAME`, `RESERVED_IDENTIFIER` | error | two methods, parameters or fields of one place share a name, or a name is a word the `targetLanguage` reserves for that kind (`fn` in Rust, a keyword parameter in TypeScript) | rename it (`wairon method rename`, `rename-param`, `type rename-field`) |
| `ENDPOINT_PATH_PLACEHOLDER` | error | an HTTP path placeholder is unclosed, written twice, or names neither a parameter of its method nor a field of a parameter's type | respell the path |
| `SCHEMA_VALIDATION_ERROR` | error | a spec id or alias that starts with `-` or is `__proto__`, a method, parameter or field name over 64 characters or starting with a digit, or a blank display `name` or one holding a control or zero-width character | rename it |
| `EXPORT_INVALID`, `EXPORT_ID_DUPLICATE`, `EXPORT_CYCLE`, `EXPORT_UNCONSUMABLE`, `EXPORT_WIDENS_AUDIENCE` | error | an L0 or L1 `publicInterfaces` entry has no source, names something not exported, repeats an id, cycles, re-exports a non-Portal/Observer, or widens a member's audience | fix the entry |
| `EXTERNAL_UNDECLARED`, `EXTERNAL_NOT_EXPORTED`, `IMPORT_AMBIGUOUS`, `IMPORT_UNRESOLVED`, `IMPORT_SHADOWED_BY_LOCAL`, `TRUSTED_LINK_CROSSES_PROJECT` | error | a reference reaches another project undeclared or at a name it does not export, or a `use` import is ambiguous, unresolved or shadowed | `doctor --fix`, then the hand items |
| `UNDEFINED_TYPE_REFERENCE` | error | a dotted type reference names another project through its alias (`alias.name`); it used to be accepted silently | write `alias::name`, as the message says |
| `EXTERNAL_INCOMPATIBLE`, `MEMBER_NOT_FOUND`, `PROJECT_ID_COLLISION`, `PART_UNAVAILABLE`, `MEMBER_KIND_MISMATCH` | error | family run: a used contract changed or vanished, a member is missing or unreadable, or two projects share an id | re-pin, restore, or rename |
| `MEMBER_UNAPPROVED`, `MEMBER_DRIFTED`, `PROJECT_DEPENDENCY_CYCLE`, `EXTERNAL_CHECK_UNAVAILABLE`, `PROJECT_ID_AMBIGUOUS`, `LOCAL_ID_SHADOWS_PROJECT` | warning | family run: a member is unlocked or its lock is stale, two projects depend on each other, a used contract cannot be compared, or an id is missing or shadowed | lock members bottom-up; tune in the parent's `rules.sddRuleSeverity` |
| `PROJECTPATH_ESCAPE` | error | a legacy mount leaves the project that declares it (a `../sibling`) | declare the sibling from the project that contains both, or migrate with `doctor --fix` |
| `SURFACE_REF_AMBIGUOUS` | error | a reference matches pinned contracts of several producers that disagree | name the producer (`alias::name`) |
| `PACK_NOT_INSTALLED`, `PACK_VERSION_UNSATISFIED`, `PACK_INTEGRITY_MISMATCH` | error | a declared pack cannot be resolved; every command refuses | step 6 |
| `UNPINNED_PACK_SELECTION`, `PACK_SOURCE_UNFETCHABLE`, `PACK_STORE_DRIFT` | warning | a selection floats, or cannot be fetched, or the bundle and the store disagree | pin, bundle, or `rules.enforceReproducibility: false` |
| `TYPE_SPELLING_STALE`, `SIGNATURE_TEXT_STALE` | warning | a stored alias spelling, or a signature text its params no longer derive | `doctor --fix` |
| `TYPE_NOT_NEUTRAL`, `TYPE_FORM_UNSUPPORTED`, `TYPE_EXPRESSION_INVALID`, `TYPE_POSITION_INVALID` | warning | `number` or a legacy builtin, a form the grammar leaves out, a position that does not parse, or a misplaced `void`, `async` or `result` (all refused at write) | step 7 |
| `FOREIGN_STEP_FIELD` | warning | a narrative step carries a field its type cannot have | `doctor --fix` |
| `NARRATIVE_COMPLEXITY`, `EXCESSIVE_NARRATIVE_STEPS` | warning | a narrative above the `moderate` cognitive band, or above 25 steps (the limit now has a default) | split it, or set `complexity.cognitiveWarnAbove` / `maxNarrativeSteps` |
| `MISLEADING_BLOCK_WORD`, `GENERIC_COMPONENT_NAME`, `METHOD_REPEATS_COMPONENT`, `COMPONENT_IS_ITS_ONLY_METHOD`, `INCOHESIVE_METHODS` | warning | a name says a block it is not, says nothing, repeats its component, or an Orchestrator holds two jobs (a pure forwarder is exempt) | rename or split, or a reasoned `lint.allow` |
| `UNUSED_COMPONENT`, `UNUSED_METHOD` | warning | a method with no narrative steps no longer vouches for every collaborator | write its `calls` |
| `METHOD_SOURCE_PATH_MISSING` | warning | an implementation's realization has begun (a file it names exists) but some contract methods name no file | name each method's file, or the implementation's `sourcePath` |
| `UNUSED_LINT_ALLOW`, `UNKNOWN_LINT_ALLOW_CODE` | warning | a coarse allow on a code that names sites, an allow naming an error, or an allow naming a retired code | one allow per site (`at:`); delete the rest |
| `UNUSED_COMPONENT`, `UNUSED_METHOD` (on a Portal) | warning | Portals are no longer automatic reachability roots: a verb that no modelled caller reaches and that is not declared an entry | model the caller, declare the entry for real outside callers, or remove the verb |
| `MISSING_PORTAL_TRANSPORT` | error | a Portal states no `transport` (was `MISSING_PORTAL_TYPE`) | `doctor --fix`, or state it |
| `ENTRY_ON_NON_PORTAL` | error | `invokedBy: { kind: entry }` on a method of a non-Portal | use `kind: runtime` |
| `GATEWAY_BYPASSED` | error | inside a declared network, a non-gateway Portal is entered from outside, or a modelled call crosses into the network onto a non-gateway | enter through the gateway, or mark the Portal `variant: gateway` |
| `LIBRARY_CALL_IMPURE` | error | pure or read logic calls a library verb whose `effect` it may not reach (an undeclared effect counts as impure) | declare the verb's `effect`, or move the call into a workflow |
| `LANGUAGE_BRIDGE_MISSING` | error | a native `InProcess` library (no `abi`) is called from a project in another `targetLanguage` | declare `abi: c` or `abi: wasm`, or put a network Portal in front |
| `IMPLEMENTS_MISMATCH` | error | an interface that `implements` an extension point misses one of its methods or changes a signature | state every method with the same signature |
| `ENTRY_SCOPE_NOT_NETWORK`, `INVOKED_BY_RETIRED_KIND` | warning | an entry `scope` on a local or in-process verb, or an `invokedBy` kind `external` / `sibling-subsystem` (read compatibly for one release) | drop the scope; `doctor --fix` for `external`, model the caller for `sibling-subsystem` |
| `ENTRY_UNPROVEN`, `EXPORT_BEYOND_NETWORK` | warning | family run: a `network` entry no modelled caller in its boundary reaches; a network verb exported beyond the project that is not the outermost gateway entered from outside | model the caller (or a reasoned `lint.allow` for an unmodelled one); narrow the audience or export the gateway |
| `UNTYPED_SEAM`, `UNREALIZED_CLAIM`, `UNCONDITIONAL_CALL_CYCLE` | warning | existing rules now see bare types nested in a published method, "persistence" claims, and cycles through parallel, `doWhile` and `try` steps | follow the message |
| † `CALL_STEP_UNREALIZED` | warning | a call step (or declared call) does not land in the target method's own source file; a same-named function elsewhere no longer counts | fix the call or the target's `sourcePath`, or map it with `symbol` |
| † `CALL_ORIGIN_UNRESOLVED`, `METHOD_BODY_NOT_FOUND`, `UNDECLARED_COLOCATED_CALL` | warning | a call site the analysis cannot follow, a declaration without a body, or an undeclared call between components sharing a file | point at the body, narrate or declare the call |
| † `UNREALIZED_PARAM`, `UNDECLARED_PARAM`, `PARAM_NAME_MISMATCH`, `PARAM_OPTIONALITY`, `PARAM_TYPE_MISMATCH` | warning | contract `params` and the realizing function disagree on a parameter, its name or its optionality, or a record parameter is typed so it cannot hold the record (`any`, `unknown`, a partial object) | fix either side; declare wiring arguments in `injectedParams` |
| `ENDPOINT_STATUS_MISMATCH` | warning | an endpoint states a status no client library names (`299`), a 204/304 on a verb answering a value, or a redirect on a verb answering a record | state the status the answer allows, or change the answer |
| † `ASYNC_MISMATCH` | warning | an `async` returns and the function disagree | fix either side |
| † `UNDECLARED_EXPORT`, `UNREALIZED_EXPORT_HANDLE` | warning | a file exports a name no contract declares and another component imports it, or a declared `exportedVia` names a missing export | put the name on a contract, or stop exporting it |
| † `IMPORT_BYPASSES_PORTAL` | warning | an import into another subsystem lands on a file that realizes none of its published components | import through the portal |
| † `MISSING_TYPE_SOURCE_PATH` | warning | a type names no `sourcePath`, so its shape is never compared with the code, and its subsystem already has code (a notice before that) | name the file that declares the type (`symbol` when the code name differs) |
| † `TECH_LEAKAGE_IN_CODE` | warning | now also fires for a technology written by its plain name: common packages are known by default (`postgres` covers `pg`) | move the import behind the component that binds the technology |
| `EXTERNAL_UNPINNED` | error | a declared external was never pinned (the project's gate composed with its externals, and the family root); `wairon lock` refuses until it is | `wairon externals pin` |
| † `RETURN_TYPE_MISMATCH` | warning | a realizing function (TypeScript or Python) is annotated to return something the contract's `returns` cannot hold | fix the code, or restate the contract (a design change) |
| † `UNDECLARED_PUBLIC_MEMBER` | warning | a public method, exported function or exported class of a realizing file that no contract, `symbol`, `exportedVia`, router or type declares, and nothing in the project uses | declare it, make it private, or remove it |
| † `UNDECLARED_DEPENDENCY` | warning | now also fires when a component imports a Portal that depends on it and calls it: the import runs against the declared edge, and only a Portal mounted onto its host without calling it is forgiven | remove the import, or declare the collaboration |
| † `UNNARRATED_CALL` | warning | a method narrated at call level calls a contract method of a collaborator its narrative names, with no step for that call | narrate the call, declare it in `calls`, or remove it |
| † `ROUTES_UNCHECKED` | warning | a Portal's files hold a router or route table that no `router:` names, so its routes are never compared with the design | name the router on the Portal implementation |
| `REMOVABLE_FORWARDER` | warning | an Orchestrator only passes calls on, and every caller could make the call itself | remove the hop, or keep it with a reasoned `lint.allow` |

Code-conformance findings can be recorded as classified debt in
`rules.conformance.carried` instead of being allowed.

**Planned code is a notice.** `MISSING_SOURCE_PATH` is now a notice (it was a
warning), and a named file that does not exist yet is the new notice
`SOURCE_FILE_PLANNED`, while the implementation's realization has not begun (no
file it names exists). Once it has begun, `MISSING_SOURCE_FILE` (error) and
`SIM_FILE_MISSING` (warning) apply as before. A design-only tree therefore
passes `--ci`. `rules.conformance.requireCode: true` reports both notices as
errors.

**Retired codes** (an allow naming one is `UNKNOWN_LINT_ALLOW_CODE`; a severity entry naming
one does nothing):
`ARCHITECTURE_VIOLATION_SPECIALIST_DEP`, `GATEWAY_CONTAINMENT`,
`LANGUAGE_FOREIGN_BUILTIN`, `NAMESPACE_SHADOWING`, `CROSS_TREE_REF_UNRESOLVED`,
`SURFACE_STALE`, `UNVERIFIED_EXTERNAL_REF`, `CHAINED_SUBPROJECT_CONTEXT`, and with the
reachability model `UNMOUNTED_PORTAL`, `ENDPOINT_OUTSIDE_MOUNT`, `MOUNT_TARGET_NOT_PORTAL`,
`PUBLIC_INTERFACE_TYPE_MISMATCH` and `PUBLIC_INTERFACE_EVENT_MISTYPED`.
`MISSING_PORTAL_TYPE` is renamed `MISSING_PORTAL_TRANSPORT` (`doctor --fix` rekeys an
allow or severity naming it). Two notices are new: `MULTIPLE_GATEWAYS` and
`ENTRY_SCOPE_UNBOUNDED` (a `network` scope with no declared network around it). The built-in
rules are split into smaller named rules (40 → 115); a split rule kept its codes.

#### Spec, configuration and lock

- `UNCONSUMED_TOPIC` and `UNSOURCED_SUBSCRIPTION` are sited at their topic. An
  existing whole-spec `lint.allow` for them no longer covers them: write
  `at: <topic>` on it.

- **`project.yaml`** gains `id` (written by `init` and `doctor --fix`), `members`,
  `externals`, `composition` (`requirePolicies`, `requireApprovedMembers`),
  `execution`, `previousIds` and `partOf`. `rules` gains `materializeAgentFiles`,
  `complexity.*` thresholds and `conformance` (`sourceRoots`, `exclude`, `unclaimed`,
  `carried`, `testRoots`). `aiGuide` is gone; it was never read. A save keeps
  comments, unknown keys, key order and line endings, and places a new key in schema
  order.
- **A project's own `complexity`, `documentation` and `naming` settings override its
  profile pack's**, as its severities already did.
- **Reachability.** A Portal states `transport` (renamed from `portalType`; one
  vocabulary with its endpoints, `HTTP_API` read as `HTTP`, and new `JSONRPC` for
  JSON-RPC over stdio and `InProcess` for a library, which binds no endpoint), an
  optional `abi` (`c`, `wasm`) when `InProcess`, and an optional Portal-level
  `invokedBy` entry its verbs inherit. Component `mounts` are gone; a Portal's L4
  `router` names the router entry its file exports (linkage, outside the approval).
  `invokedBy.kind` is `entry | runtime` with a `scope` (`outside | network`); `external`
  and `sibling-subsystem` are retired. The export kind (`type`) on L1 and L0
  `publicInterfaces` entries is derived from the backing Portal, no longer authored;
  an entry may carry `role: implement`, and an interface may declare `implements`.
  The method `effect` vocabulary gains `none` and `io`. `project.yaml` gains
  `network`, which enters the gate identity only when declared.
- **Naming follows the target language.** A method's casing defaults from
  `targetLanguage` (camelCase for TypeScript and Java, snake_case for Rust and
  Python) unless `rules.naming` sets it, and the rename tools validate a new name
  against it instead of always requiring camelCase.
- **Design export format 2.0.** `components[].portalType` is `transport`, `mounts` is
  removed, a Portal may carry `abi` and `invokedBy`, `invokedBy` kinds are
  `entry | runtime` with a `scope`, and export entries carry `role` and a derived
  `type`. The schema ships as `schemas/design-export-2.json`. Surface snapshots
  carry each entry's `transport`, `abi` and `role` and the producer's
  `targetLanguage`; a pin taken before reads the absent fields as unchanged.
- **Specs:** `Specialist` and `Gateway` retire. Type positions follow the grammar.
  `lint.allow` gains `at` and `covers`, and `sdd_update_spec` merges allows by code
  and `at`. A method effect can be `lifecycle`. An L1 subsystem carrying
  `projectPath` is a deprecated form.
- **Lock record format 3.** It adds `members` (alias → project, approved state),
  `code` (the conformance results beside the claim), `projectId` and one digest per
  spec. `children` is read for one release and never written.
  - The per-spec digests and the gate identity read each spec's **design**
    (`specsReading: design`). Code linkage is left out: `sourcePath`, `symbol`,
    `exportedVia`, `simPath`, `injectedParams`, conformance tiers, a Portal's `router`,
    `externalLinks`, and the `createdAt`/`updatedAt` timestamps. Linking code to an
    approved design, or a change and its revert, never stales a lock.
  - A format-2 record from an earlier v6 build still passes while unchanged, and
    `doctor --fix` re-expresses it (upgrade step 9).
  - The **gate identity** is computed differently. It no longer depends on the
    machine, and it now also covers the governing doctrine, the pinned contracts,
    `composition` and the members' approvals. Code findings are recorded beside the
    approval instead of inside it.
  - So every v5.1.0 lock reads stale once, and `lock-check` says why.
  - `lock` never rewrites spec `status`. A spec that is approved and unchanged is
    judged as complete in memory.

#### Hosted

- `wairon host doctor --fix` is required (step 2). Every member of a hosted family
  becomes a project record that inherits access through its parent. An explicit
  "no" on a member's own record beats any inherited grant.
- **Writes are judged per member and per subsystem.** A spec write into a member, or
  a subsystem, that the caller may not write is refused with `SubsystemWriteDenied`,
  even when the caller may write the parent.
- **A hosted lock is an approval.** It needs `approval:decide` over the project on
  every surface (MCP, the admin API, the web UI, `wairon lock` while attached). A
  person who may write the whole project but holds no `approval:decide` now gets a
  pending approval request for someone else to decide, where they used to lock
  directly. The web Lock button makes the same decision as the MCP tool: it locks
  for someone who may approve, and for a writer it creates the request and says
  "Approval requested; someone with approval rights decides it". The admin API
  still refuses a caller who may not approve. Grant `approval:decide` to the people
  who approve designs.
- **Promote is removed:** `wairon host promote`, `sdd_host_promote_project`, the
  admin and web promote routes, the `project:promote` approval kind and the Promote
  button. Stored `promote:mark-ready` grants still migrate.
- **Token mint requires its project list** (`*` for the owner's full reach). A token
  qualified `project::member` is mapped to the member's record id. The mint answer
  is `{ token, mapped }`.
- **Admin API answers:**
  - Policy-governed project creation (`POST /web/projects`, the policy portal's init,
    an approved init) answers a `GovernedProjectCreation` (`record`, `packImpacts`,
    `profileImpact`); read the record from `record`.
  - A refused lock answers 409.
  - A lock request whose design moved after it was requested ends `cancelled`, with
    the reason.
  - `environment` is no longer part of a project-init request.
- **Defaults and values:**
  - A landscape entry with no audience is `instance` (it was `public`).
  - The exposure, audit and quota settings offer only the values that behave
    differently: `adminApiMode` is `disabled` or `enabled`, `metadataMode` is `none`
    or `redacted`, and quota `mode` is `observe` or `warn`. Stored retired values are
    mapped with a warning for one release.
- **Git backing commits `.wai/lock.json`**, so an approval reaches the bound remote.
- A member with a `../` or git source is refused on hosted (hosted roots are
  isolated). A hosted detach or adopt moves the member's directory.

### Deprecated

**Removed right after v6.0.0.** Each is still read in v6.0.0, reported as a notice,
and rewritten by `wairon doctor --fix`:

- a leading `::` (`::shared::error-type`);
- `super::`;
- member paths (`billing::invoice::invoice_portal`);
- the L1 mount form (a subsystem carrying `projectPath`);
- the hosted token qualifier `projectId::alias` (mint by record id).

**Read for one release:**

- the long-form member `path` key (`doctor --fix` rewrites it to the one location
  key);
- `children` in a lock record;
- `generate --no-recurse` and `lock --no-recursive` (accepted and ignored);
- a pack's `languages.<id>.foreignBuiltins` (`PACK_FIELD_DEPRECATED`);
- the retired hosted settings values.

`wairon packs` remains a deprecated alias of `wairon pack`.

### New

**The code gate closes the holes the release QA found, and says what it checked.**
A release QA seat changed realized code one way at a time and found ordinary
mismatches passing with "All checks passed". Each is now caught, and `validate` says
how much of the code it read. Each new code is a **warning, so `validate --ci` can
newly fail** on code that passed before:

- **`RETURN_TYPE_MISMATCH`** (new): a function annotated to return a type its
  contract's `returns` does not describe is reported on that method, naming the
  contract's type and the code's. Before, a changed return type surfaced only on a
  caller whose own port no longer matched (`UNREALIZED_DEPENDENCY` "the declared edge
  is stale", `CALL_ORIGIN_UNRESOLVED`). Those caller findings are no longer reported
  on their own: they are held under `RETURN_TYPE_MISMATCH`, which says so, and are
  judged again once the return is fixed. Not compared: a contract returning void, a function registering
  the method's handler, a void handler writing through an injected response handle,
  an unannotated body, and a type the design does not know.
- **`UNDECLARED_PUBLIC_MEMBER`** (new): a public method of a component's realizing
  class, or a function or class its file exports, that no contract declares and
  nothing in the project uses (no call in its own file, no other file, no test). A
  class counts as used when its own file names it outside its own body (constructed,
  extended, annotated with, `instanceof` / `isinstance`, passed on); its own static
  factory does not count. Before,
  `UNDECLARED_EXPORT` fired only once another component imported the name. Exempt:
  constructors, accessors, fields, static, private, protected, `#private` and
  underscore-prefixed members, `override`, computed names, language protocol and
  framework lifecycle hooks, Python dunders, test files, and `conformance: off`.
- **`UNNARRATED_CALL`** (new): a method whose narrative is at `full` or
  `calls-only` detail (or that declares its calls) calls, in its own body, a verb of a
  collaborator the narrative names that no step names — the forward twin of
  `CALL_STEP_UNREALIZED`. A collaborator reached through a port (a planned one, or
  another project's) counts as the component its narrated calls go to.
- **`ROUTES_UNCHECKED`** (new): a Portal binding HTTP endpoints whose files hold a
  router or route table its implementation never names in `router:` was a standing
  `ROUTER_UNDECLARED` notice; it is now a warning naming each spelling `router:`
  accepts. `ROUTER_UNDECLARED` stays a notice only where the files hold no router: the
  Portal is then read as served method by method, and an undeclared handler method is
  `UNDECLARED_PUBLIC_MEMBER`.
- **Python is judged, not only read for method names.** A signature reader (no
  interpreter, no dependency) reads each `def`: parameter names — compared in
  snake_case, so the contract's `documentId` is the code's `document_id` — their
  annotations and return annotations, class members, imports and call sites. A
  renamed parameter is `PARAM_NAME_MISMATCH` (and the rest of the parameter checks),
  a changed return annotation `RETURN_TYPE_MISMATCH`, an import of another
  component's module the design does not list `UNDECLARED_DEPENDENCY`, an extra
  public method or module function `UNDECLARED_PUBLIC_MEMBER`, and an unnarrated call
  through an annotated collaborator `UNNARRATED_CALL`. Python gains a type dialect;
  briefs give its mapping without the "mapping only" line.
- **An import that runs against a Portal's call edge is `UNDECLARED_DEPENDENCY`.**
  The reverse import a declared edge forgives is the mounting shape: a server's file
  importing the Portal that depends on it, to serve it. That was forgiven for any
  component the Portal depends on, so an Orchestrator importing the Portal that calls
  it passed silently in Python and showed in TypeScript only as `UNDECLARED_EXPORT` on
  the Portal's file. A Portal that calls a component (a narrative call or dispatch
  step, a declared call or a dispatch-table binding) is now that component's client:
  its import back is `UNDECLARED_DEPENDENCY` on the importer, naming the edge it
  inverts, and it no longer realizes the Portal's own edge. `UNDECLARED_EXPORT` now
  also names the files that took each name, not only the file that publishes it.
- **What was checked is said.** The code-reading line (`validate`, `sdd_validate_tree`)
  now names, per language, the grade and the checks it ran and did not
  (`python: 4 file(s) at grade pattern with its signature reader, checked methods,
  params, returns (where annotated), public members, imports, calls through declared
  receivers — not checked: routes, data types`); a family run prints it per project,
  and the closing line repeats it in a few words (`Code checked: …`). Routes are read
  only out of a router a Portal names, so a language whose code realizes an HTTP
  Portal naming no router says `routes where a router is named` and counts those
  Portals among what it did not check.
- **Still not checked**, and said in that line: calls made inside helpers and calls to
  collaborators a narrative never names (the detail dial lets a narrative summarize
  them; a collaborator the design does not list at all is `UNDECLARED_DEPENDENCY`);
  Python routes and data shapes; a declared Python dependency that no import
  realizes; languages other than TypeScript, JavaScript and Python beyond method
  names. Static methods are exempt from `UNDECLARED_PUBLIC_MEMBER`, and a verb some
  other code mentions by name counts as used.
- wairon's own tree carries what the new checks measured in it as drift in its
  conformance debt register: 29 narratives that leave out a call to a collaborator
  they narrate, and 6 contracts whose `returns` the code no longer matches. Three dead
  exports they also found were removed.

**Forwarders: required or removable.**

- New warning `REMOVABLE_FORWARDER`. An Orchestrator whose every narrated method
  only passes the call on is reported when every modelled caller could legally
  call the forwarded target itself. Legal is the doctrine rules' own verdict on
  that edge, including a pack profile's `allowedEdges` and `forbid-edge`
  assertions, so a forwarder doctrine requires is never reported: Portal →
  Orchestrator → Adapter, or a Portal in front of a write.
- **This can fail `validate --ci` on an existing project** that has such a
  forwarder. Two ways out: keep it on purpose with a `lint.allow` for
  `REMOVABLE_FORWARDER` and a reason on the component, or set
  `rules.sddRuleSeverity.REMOVABLE_FORWARDER` in `project.yaml` (`notice` keeps it
  visible without failing CI). Or remove the hop.
- `ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP` on a Portal → Adapter edge now says
  why: the Portal goes through an Orchestrator, which is where the two shapes are
  translated. The wording for the other targets is unchanged.

**Reachability, networks and libraries.**

- Every Portal verb is reached by a modelled caller or declared an entry, and the
  unused-component and unused-method findings now name both remedies for a Portal.
  A Portal-level entry covers every verb; a verb may override its scope.
- **Networks.** `network: true` (or `{ description }`) in `project.yaml` makes a
  project and its members an isolated network. Entries are scoped `outside` or
  `network`, relative to the innermost network, so a member written alone still
  resolves them. Inside a network only a `gateway` Portal is entered from outside,
  one gateway per level. The family run at the root proves each `network` entry has a
  modelled caller inside its boundary. A project that declares no network sees none
  of this.
- **Libraries.** An `InProcess` Portal is a library (or, with `abi`, an FFI, DLL or
  WebAssembly surface) and needs no endpoint. Another project calls its exported
  verbs directly from any component, with no client Adapter, checked for purity and
  for the language bridge.
- **Extension points.** An export entry with `role: implement` is a contract
  consumers supply (a trait, a callback, a webhook); a consumer's interface declares
  `implements: alias::name`, and its methods count as reached.
- **Derived networking.** `wairon network flows | policy | diagram | check | why`
  derives an allowed-flows matrix (JSON, CSV or Markdown), Kubernetes
  `NetworkPolicy` from a bindings file kept outside `.wai/`, a Mermaid diagram of the
  networks as trust boundaries, a comparison of observed live flows, and the
  modelled chain behind one flow. The specs never hold an address. The MCP server
  adds `sdd_get_network_flows` and `sdd_explain_flow`, and the hosted web API adds
  `GET /web/projects/network`. See `docs/network.md`.
- **CI at the family root.** A member validated alone says in one line that its
  network proofs are judged at the family root. The reusable `lock-check` workflow
  gains a `validate` input (default `true`) that runs `wairon validate --ci` in its
  `working-directory`.
- `wairon doctor --report reachability` prints the reachability migration's plan.

**Members, parts and projects.**

- A member is declared by one location key: `scheduler: services/scheduler`,
  `admin: ../admin`, `payments: git@host:acme/payments.git#<commit>` or
  `hosted:<id>`. Its content decides whether it is a project (it has an id, an L0 or
  a lock) or a part (anything else).
- A part's subsystems are the parent's own: same ids, same lock, same agents.
- Git members are fetched at their pinned commit into an offline-capable cache
  (`WAIRON_CACHE_DIR`). `wairon member update` moves the pin.
- A part stored outside its parent can pin the excerpt of the parent it uses, so its
  own CI can validate it alone.

**Cross-project references.**

- `project.yaml` `externals` declares the projects a project consumes. Each level's
  `publicInterfaces` is an export table, with named re-exports, type exports and
  wildcards.
- `wairon externals pin | status | list` records and compares exactly what is used,
  at signature level. `use` imports bring in bare names.
- `validate --family` (and `sdd_validate_tree` with `family`) runs every member's own
  gate and composes each external against its live producer.

**Family migrations.** `member attach | detach [--widen] | adopt | rename-alias |
internalize | promote | demote`, `project rename` and `subsystem externalize` print a
plan, ask, then apply to every project they touch, or to none. Each has an MCP tool
with `dryRun`. A rename keeps the old id in `previousIds` and asks for a re-lock
(`PROJECT_ID_RENAMED`).

**Approval.**

- `wairon lock-check` checks that the design in the tree is the approved design, and
  comes with a reusable workflow.
- `wairon status` names the specs that changed since approval.
- `lockedBy` records where the identity came from (`git`, `os` or `hosted`).
- A parent can require approved members (`composition.requireApprovedMembers`).

**Packs.**

- A machine-wide pack store with versions (`pack install | uninstall | which`).
- Per-project selection (`pack use | unuse`, `--pin`, `--source`, `--bundle`),
  `pack sync` and `pack bundle`.
- `pack impact`, also `sdd_pack_impact` and hosted previews: what a pack changes,
  before it is written.
- Parent requirements: `composition.requirePolicies`, judged by `POLICY_NOT_ADOPTED`
  and `POLICY_DEVIATION`.
- `applyByDefault` seeds a pack into new projects. A pack's `instructions` and skills
  that extend a built-in skill reach the connecting agent.

**Types and contracts.**

- One neutral grammar: ten primitives, `list` / `set` / `map`, `T?`, `async T` and
  `result<T, E>`. It reaches OpenAPI, the ERD and the snapshots, and implementer
  briefs carry each language's mapping.
- New type kinds: `enum`, named scalars (`holds`) and `signature` types.
- A method's signature text is derived from its `params`, and `signatureFrom` names
  the method or signature type it forwards.
- Contract methods declare their `findings`, and a method can name its own
  `sourcePath`.

**Code ↔ spec.**

- Calls are checked where they land, and parameters, exports, type shapes and routes
  are compared against the code. Route coverage reads a Portal's routes from its L4
  `router`.
- `rules.conformance.sourceRoots` reports `UNCLAIMED_SOURCE_FILE` for code no spec
  names.
- A type can claim its file (`sourcePath`, `symbol`).
- A method's `calls` declares what it calls when its narrative shows no steps.
- `register` steps and `invokedBy` (`entry` on a Portal, `runtime` anywhere) declare
  callers outside the modelled graph.
- `rules.conformance.carried` holds classified debt.

**Design blocks.**

- Logic is an Orchestrator with `dependencyClass: pure | read`.
- Query is a Repository member, and a Supervisor may own its own state.
- Built-in variants: `arbiter`, `projector`, `composer` and `codec` on Orchestrator,
  and `gateway` on Portal.
- A `publicInterfaces` entry can name its `consumers`.

**Readability checks.** Narrative complexity, naming discipline and method cohesion,
each with configurable thresholds.

**Authoring.**

- Rename and move tools: `sdd_rename_component`, `sdd_rename_method`,
  `sdd_rename_type` and `sdd_move_methods`. A move that a rule refuses ranks the
  legal homes. A rename leaves a trace (`previousIds`, `previousNames`) and keeps
  published names.
- Creates take a `status`, `sdd_get_spec` can return chosen `methods`, and
  `sdd_update_spec` takes `dryRun` and `unset` and reports `ineffective` keys and
  `testsToRevisit` (`rules.conformance.testRoots`).
- A write is refused when it would place a field its component type cannot have.

**Agents.**

- Agents are **live briefs**, through `sdd_get_agent_brief`, the `wairon-agent://`
  resource and `wairon agent brief`. Agent files are opt-in
  (`rules.materializeAgentFiles`), and `wairon agent customize` adds your own
  guidance in `.wai/agents/<id>.md`.
- The new `sdd-delegate` skill spawns a subagent from a brief.
- Execution budgets (`execution.tier`, `wairon execution show | set-tier`) give
  each agent a capability tier, a turn ceiling and a tool class.
- The MCP server sends `instructions` on connect and offers the skills as prompts.

**Code linkage and live drift.**

- Code linkage is outside the approval (lock format 3), so planned `sourcePath`s
  are declared at design time. Briefs fence planned files, marked
  `(planned — create it)`, simulation harnesses and the subsystem's type files.
  `rules.conformance.requireCode` makes unlinked and planned code an error.
- Plain `validate` and `status`, `sdd_validate_tree` and `sdd_get_status` compare
  each external with its **live** producer, offline, and report what moved as
  advisory findings (`advisory: true`): `EXTERNAL_LIVE_INCOMPATIBLE` (warning) names
  each moved member, the specs that use it and the fix; `EXTERNAL_DRIFTED` and
  `EXTERNAL_LIVE_UNCOMPARED` (notices). They never decide `valid` or `--ci`: the pin
  stays the gate. `wairon externals status` is the opt-in live gate.
- A rename reads as a rename. The surface projection, the pin snapshot and
  `wairon surface export` carry the producer's rename trace as `formerly`, outside
  every digest, so no existing pin moves. A used name that was renamed is `renamed`
  with `renamedTo`, and `EXTERNAL_INCOMPATIBLE` and `EXTERNAL_LIVE_INCOMPATIBLE`
  say "renamed to X".
- `wairon externals add` and `sdd_add_external` declare an external: one-sentence
  refusals, a check against the producer it reaches (a contradicted declaration is
  removed again), and a pin by default. `sdd_get_externals_status` returns each
  external's `health`.

**Severity `notice`:** reported everywhere, never a failure. Any code can be set to
`notice` in `rules.sddRuleSeverity`.

**Design export.** `wairon export` and `exportDesign()` produce the whole resolved
design as one deterministic JSON document (`wairon-design` 1.0,
`schemas/design-export-1.json`, `docs/design-export.md`).

**Moving between local and hosted.**

- `.waitree` archives.
- `wairon remote push | pull | attach | detach | status`.
- `wairon login | logout`.
- `wairon mcp install --hosted`.
- Hosted tree export and import, also from the web Transfer tab.

**Hosted.**

- Access rules per subsystem.
- A permission explanation (`/web/admin/permissions/explain`).
- Relation health on the canvas and on the project's Relations tab.
- Member crumbs and openable member nodes.
- A custom theme builder.
- `WAIRON_AUDIT_POLICY` and `WAIRON_QUOTA_POLICY` set the audit and quota policies.

**Approval and upgrades.**

- A spec's `status` (draft, design, complete) is readiness, not design: it is left
  out of the approval, so promoting a spec after the lock never reopens it. A lock
  taken while status was still part of the approval keeps passing when only a
  status moved, and `wairon doctor --fix` carries it into the current reading.
- `wairon doctor --fix` re-expresses an older lock record before any repair touches
  a spec, so an unchanged tree is carried into the current format even when the
  rules it was judged under moved. A lock whose specs are unchanged but that no
  longer matches now says why: the gate moved (a newer release's rules, the rule
  tuning, composition, network, consumed contracts or a member's approval), never
  the design.

**Code conformance.**

- A call through an injected collaborator whose type comes from a component the
  caller never declared is an undeclared dependency even when the type is imported
  type-only. A Portal calling a write or lifecycle method of a data component that
  way is `PORTAL_WRITE_SHORTCUT_IN_CODE`, the code twin of `PORTAL_WRITE_SHORTCUT`.
- Importing a technology's package (one of its declared tokens) from a component
  that does not bind that technology is `TECH_LEAKAGE_IN_CODE`.
- An Adapter's call step to a verb of a Portal on an out-of-process transport is
  the link the design models: it is no longer resolved to the remote file, so it no
  longer reads as an unresolved call. The call to the Adapter is still checked.
- `CONFORMANCE_DEGRADED` says what is missing: no TypeScript installed, or one that
  ships no JavaScript compiler API (TypeScript 7). A project's TypeScript 7 is
  passed over for a usable compiler where one can be found.
- An Adapter's `dependsOn` to a Portal on an out-of-process transport is realized
  by the link, never by an import, so it is never `UNREALIZED_DEPENDENCY`. Nothing
  asks for an import across a network boundary any more.
- A call is followed through a non-null assertion, a cast to a named type, a local
  alias of a field and a destructured field exactly as through the field itself, so
  those forms no longer hide `PORTAL_WRITE_SHORTCUT_IN_CODE` or
  `UNDECLARED_DEPENDENCY`. A Portal's call through a receiver the analysis cannot
  follow, under the name of a nearby data component's write, is reported as the
  notice `PORTAL_CALL_UNRESOLVED` instead of passing silently. A field typed
  `T | null` or `T | undefined` is read as a `T`.
- Interfaces declared in a shared contracts file are followed to the classes whose
  `implements` clause names them, wherever they live, so the layout no longer
  breaks call tracing.
- `TECH_LEAKAGE_IN_CODE` knows the common packages of common technologies
  (postgres, mysql, redis, mongodb, sqlite, kafka, rabbitmq; an HTTP client is never
  a technology). The table is documented and extended per technology by
  `{ name, matches }` or by a pack's `technologyPackages`. A technology written
  once as a name and once as `{ name, matches }` is one technology, with no spurious
  `TECH_LEAKAGE`.
- A type without a `sourcePath` is reported (`MISSING_TYPE_SOURCE_PATH`): a notice
  before its subsystem has code, a warning after. The architect skill plans type
  source paths with the implementations'.
- The planned files of one implementation are one `SOURCE_FILE_PLANNED` notice.

**Authoring.**

- `wairon type rename-field` and `sdd_rename_field` rename a type's field and
  respell its references. The old name stays on the field (`previousNames`) and
  shows as `formerly` in the design export.
- `wairon method rename-param` and `sdd_rename_param` rename a contract method's
  parameter: the old name stays on the parameter (`formerly` in the design export),
  the signature is re-derived and an HTTP path placeholder that bound it follows.
- A contract that implements another project's extension point takes its method
  and parameter names from the producer: those methods are exempt from the local
  casing rule, and `sdd_rename_method` accepts the producer's names. Per-method
  allows for that are no longer needed.
- A key a spec's schema does not know (for example `exports:` in the L0, whose
  export table is `publicInterfaces`) is reported as `UNKNOWN_SPEC_KEY`, and an
  unknown setting in `project.yaml` as `UNKNOWN_CONFIG_KEY`. The docs show how to
  author the L0 export table.
- The architect skill and guide aim for the smallest sound design: one standalone
  Store for simple state, and the Repository pattern only for real lookup needs.

**Briefs.**

- Rust and Python briefs carry a type mapping table, marked as mapping only (no
  analyzer reads those languages yet). A design with no code yet takes its language
  from `targetLanguage`.
- A consumer's brief lists the externals it uses (names, transport, abi) and adds
  the pinned snapshot to its read paths.
- A subsystem owner's fence includes the project's shared setup files (manifest,
  compiler settings, crate or package root, system-level type files).

**Externals.**

- `wairon externals use` changes an external's imports, `wairon externals remove`
  removes a declaration with its pin, and `wairon externals consumers` lists the
  family projects that consume this one. MCP: `sdd_update_external` and
  `sdd_remove_external`.
- A re-pin refreshes every fact the snapshot carries (abi, transport, role,
  renames), and a stale snapshot reads as drifted, never ok.
- Export audiences: a name exported to a narrower audience than the consumer's is
  refused with both audiences named; a `department` export is noted
  (`EXPORT_AUDIENCE_NARROW`), and a re-export cannot widen an audience.
- Implementing another project's trait: the producer's bare type names and
  `alias::name` compare as one type, and a cross-project `signatureFrom` resolves
  from the pin.
- The methods of an implemented contract are pinned one by one, so the producer
  renaming one reads live as "renamed to <name>".
- A public name gone from the live producer is `EXTERNAL_INCOMPATIBLE` whether the
  consumer pinned it or not.
- `wairon externals consumers --search <dir>…` finds consumers outside the family,
  and `sdd_list_consumers` gives an assistant the same answer.
- `wairon surface diff [--against <file>] [--json]` and `sdd_surface_diff` list
  what changed on the public surface.
- The design export's `uses` lists every referenced name.
- A pin taken before anything references the external says it fills on the next
  pin. A producer that cannot be read is named with its file and error. A name
  exported but reached by nothing is the notice `EXPORT_UNREACHED`.
- Removing the last external also removes `externals.lock.yaml`.
- An Adapter exported as an extension point is typed `InProcess` (pins of such a
  producer read drifted once). `surface export --format openapi` is refused for a
  library. Pins carry the methods and constructors of exported types.

**Networks.**

- The network commands judge the design through the validator first. A flow a gate
  error sits on is refused: marked in the matrix (a `gate` column), left out of
  every policy (and `policy` exits 1), explained by `why`, and filed as disallowed
  by `check`. `why` also says when a callee is reached in-process (never a network
  flow) and when a name is unknown.
- Bindings include the Portal's `basePath`, so live checks match real paths, and
  `check` reports disallowed flows apart from unknown ones.
- A caller is named by its workload (its subsystem) across a project boundary.
- An Adapter may state its transport, which must match its target Portal's
  (`ADAPTER_TRANSPORT_MISMATCH`).
- `wairon network declare | undeclare` and `sdd_set_network` write the network
  declaration.
- Migrations: promoting a member (or externalizing a subsystem into a project)
  declares an entry on each verb the parent calls and names the topics that cross
  the new boundary, which the family run pairs; externalizing re-roots moved types'
  source paths; demoting removes the setup a promote wrote. `sdd_update_spec`
  refuses a member project's spec from the root and names the member's folder.
- Promoting (or externalizing as a project) leaves a valid tree: export entries are
  rewritten, and source paths outside the new project become member-relative
  planned paths. The tool route sets the new project up for its own sessions, as
  the CLI does.
- `network policy` and `check` resolve a renamed project's former id in bindings
  and observed names, with a NOTE; `policy` exits 1 when a name stays unbound, and
  notes a workload that serves verbs of different reach on one port. A project
  rename's plan lists the binding and telemetry keys to rename.
- Inside a member, the network commands answer from the enclosing family
  (`--no-recursive` judges the member alone). `flows` exits 1 on a design the gate
  refuses, and its JSON names the root project.
- `network why` answers for subsystems with only types, member projects and
  `alias::name` parties. `sdd_get_status` has a Network line.
- A Portal transport change, dry run included, lists the Adapters it affects.

**CLI.**

- `wairon diagram` draws relation health (`--no-health` skips it).
- `validate --all` prints every finding, with per-code totals.
- `wairon update --channel dev`.
- `wairon dev` is a local Canvas and Specs shell with no sign-in.
- `wairon lock --all` lists every changed spec; a long list is otherwise
  summarized.
- The reusable `lock-check` workflow installs the project's dependencies (npm, pnpm
  or yarn, from the lockfile; input `install`) before `validate --ci`, so a
  TypeScript project's analysis runs at full grade on a fresh clone. The docs' CI
  recipe says the same.

### Fixes

- **`wairon doctor`, assistant registrations:** `doctor --fix` now repairs every assistant registration that
  `doctor` reports out of date, including a project `.gemini/settings.json` when Antigravity is a
  target (it used to rewrite only the Claude entry). A registration that starts a different build than
  this CLI is shown as a warning, never a check mark, and an up-to-date entry now names the build it
  starts, e.g. `registered (starts wairon 5.1.1)`.
- **Confirmations with no terminal:** `wairon domains remove` without a terminal now refuses with a
  failing exit code instead of failing inside the prompt; `wairon lock` and the migration commands
  already refuse this way, and a test now pins it.
- **Hosted operator setup:**
  - The shipped docs now explain how to turn on the web UI (the exposure policy's
    `webUiEnabled`), what `requireTls` does, how the built-in administrator signs in
    (`WAIRON_ADMIN_USER` / `WAIRON_ADMIN_PASSWORD`), how to set up single sign-on
    (`WAIRON_OIDC_*`), and who may approve a design. `wairon serve` logs one line
    saying whether the web UI is on and how a person can sign in.
  - `wairon mcp install --hosted` works in an empty folder. It writes only the
    registration, with no local spec tree or guide, and warns that the file now
    holds a credential.
  - A hosted lock records its gate parts, as a local lock does, so status no longer
    reports a fresh hosted approval as an old record that needs rewriting.
  - `wairon remote --help` no longer offers `project::subsystem`: a key is never
    narrowed to a subsystem. A refused mint names `wairon host permission set
    --subsystem`, which confines a person to one.
- **Code↔spec conformance, round-4 trials:**
  - A Portal's calls are resolved by the TypeScript type checker, so no receiver spelling hides a write to a data component any more (element access, destructuring, `.call`, a field of a dependency bag, a type alias, a barrel, `Pick<>`, a factory, `new Store()`, a port interface the Portal declares itself): `PORTAL_WRITE_SHORTCUT_IN_CODE`, plus `UNDECLARED_DEPENDENCY` on the edge.
  - `PORTAL_CALL_UNRESOLVED` is now a **warning** (was a notice): a write-named call through an `any`/`unknown`/untyped receiver fails `--ci` instead of passing.
  - New `UNDECLARED_WRITE_CALL` (warning): a method's code calls another component's write- or lifecycle-effect method that its narrative never claims.
  - `TECH_LEAKAGE_IN_CODE` also reports a known technology package (e.g. `ioredis`) that no implementation binds.
  - Constructor parameter properties count as the class's fields (no false `UNREALIZED_TYPE_FIELD`).
  - `typescript` is now a runtime dependency: the analyzer uses the project's own TypeScript 5/6 and wairon's copy otherwise, so TypeScript 7 or no TypeScript no longer means `CONFORMANCE_DEGRADED`.
  - A long-lived MCP server no longer keeps a stale compiler or a stale parse: both are keyed on what they depend on.
- **Code↔spec conformance, round-5 trials:**
  - Unowned code is read as part of whoever calls it: a function in a file no component realizes (a persistence helper module), or one that is none of its file's components' modelled methods, is analyzed as if inlined at the call site, transitively, and the finding names the path (`PORTAL_WRITE_SHORTCUT_IN_CODE`, `UNDECLARED_WRITE_CALL`).
  - A reference to a method is a use, not only a call: a write method passed to `Reflect.apply`, kept in a `Function`-typed variable, bound, or handed on as a callback is judged like a call.
  - A computed member on a receiver that was a data component before a cast (`(store as Record<string, fn>)[key]()`) fails closed as `PORTAL_CALL_UNRESOLVED`, naming the component's writes; the checker records the receiver's original type.
  - An Orchestrator's unnarrated write through an unresolvable receiver (`(this.store as any).put(…)`) now fails closed too, as `CALL_ORIGIN_UNRESOLVED` (warning) — the fail-closed half of `UNDECLARED_WRITE_CALL`.
  - A Portal calling a workflow verb (Orchestrator, Supervisor, Actor) that its narrative never names, and whose effect is not declared `read` or `none`, is `UNDECLARED_WRITE_CALL`. Declare the verb's effect, narrate the call, or remove it.
  - Honest dependency injection is clean: `CALL_ORIGIN_UNRESOLVED` and `UNREALIZED_DEPENDENCY` accept what the type checker resolves, so a type-only `ports.ts` barrel, `export *`, a Store port declared in a shared module and a deps object typed inline no longer fail `--ci`. The import graph still accepts on its own, and is the only reading where no checker loads.
  - A private field a getter reads is backing storage, not undeclared data (`UNDECLARED_TYPE_FIELD`).
  - `UNDECLARED_PARAM` names an inserted leading parameter, not the declared one it pushed along, when the trailing names prove the shift.
- **Code↔spec conformance, round-6 trials:**
  - A computed key on a data component fails closed however the receiver or the key is cast: a key the checker types as one literal names its member by the literal's value (`const name = 'put'; (store as any)[name](…)` was silent), and a member read by a key that names no single member off a receiver that was a data component before any cast is recorded even when it is taken as a value and invoked later (`const f = store[k] as Fn; f.call(store, …)`) — `PORTAL_CALL_UNRESOLVED` in a Portal, `CALL_ORIGIN_UNRESOLVED` elsewhere.
  - New `CALL_TARGET_PLANNED` (notice): a claimed call written through a port to a collaborator whose code is not written yet (no file its implementations name exists) is planned, not `CALL_ORIGIN_UNRESOLVED` — the first component of a service implemented from its brief no longer turns `--ci` red. It is judged as usual once the target's realization begins.
  - An Orchestrator, Supervisor or Actor verb that declares no `effect` has it read off its own narrative, transitively: a Portal's unnarrated call to a verb that only reads is no longer `UNDECLARED_WRITE_CALL`. A verb whose narrative reaches a write still is; one nothing settles (no narrative, a dispatch step) is reported as an unnarrated call whose effect is undeclared, never as a write.
  - A parameter whose name starts with `_` is imposed and unused, never `UNDECLARED_PARAM`: a `node:http` handler `getRoute(_req, _url, params)` realizing `getRoute(id)` is clean, and its request is no longer paired with `id`. `_id` realizing `id` is the same argument.
  - `PARAM_NAME_MISMATCH` no longer goes quiet when the parameter's type is an external one (`stops: list<geo::coordinate>` realized as `points: Coordinate[]`): an external type answers to the name its pinned snapshot gives it.
  - `TECH_LEAKAGE_IN_CODE` reads a technology import moved into a helper module as its importer's: unowned modules a file imports are followed transitively (the finding names the hops), as unowned code already was for calls.
- **Approval, migrations, externals and surfaces, round-4 trials:**
  - `wairon status`, `sdd_get_status`, `lock-check` and `lock` read one verdict: a project whose id moved since its approval (`wairon project rename`), or whose declared external was never pinned or is used beyond its pin, reads **drifted** with what it owes (`ProjectApproval.owed`) — never "approved … no spec has changed since" while `lock-check` fails. "No spec has changed since" now always says what the approval owes instead. A member in that state is `MEMBER_DRIFTED` with the reason.
  - `PROJECT_ID_RENAMED` names the new id (it printed the display name where the new id belongs).
  - `wairon lock` refuses a design whose external uses are not in its pin ("used now, but not in the lock") exactly as it refuses a never-pinned external — re-pin first, nothing written; `lock-check` fails on both.
  - A storage move is no design change: a part's TYPE `sourcePath`s are read relative to the part's root like its implementations' (no more `SOURCE_PATH_ESCAPES_ROOT` after `subsystem externalize`), and every migration whose edits only move files (`member internalize` of a part included) asks for a re-lock only when the approval no longer covers the tree.
  - `surface diff` lists every fact a consumer's pin drifts by — `abi`, transport, role, stereotype, basePath, auth, a method's effect, a type's own methods, `targetLanguage` — never prints "signature A → A" (a method whose closure type changed shape says so), and refuses an impossible comparison (no git, no committed approval) in one line, exit 1.
  - A call to a renamed method carries "It was renamed to …" from the target's rename trace (`INVALID_TARGET_METHOD_REFERENCE`, `SURFACE_REF_NOT_EXPOSED`), as a renamed type always did.
  - New `wairon method rename <component> <method> <new-name> [--dry-run] [--search <dir...>] [--no-pin-symbol]`; `sdd_rename_method` takes `dryRun` and `search` and answers `breaks`: the consumers (family members and found checkouts) whose specs call the method through an export. `externals consumers` / `sdd_list_consumers` report method-granular use (`uses`).
  - `sdd_validate_tree` (and `validate --family`) at a member's root judges its network from the enclosing family — no "no declared network encloses the root" or `ENTRY_UNPROVEN` on verbs the family proves — says that its proofs are judged at the family root as the CLI does, and every per-project count is counted from the findings listed under it.
  - `network why` reads a renamed project's former id (with a note) and, at a member's root, the member's bare names.
  - `implements:` naming an export consumers call (not role implement) is `EXTERNAL_NOT_EXPORTED`; `sdd_update_spec` reports it on the write, dry run included.
  - An undeclared alias in `alias::name` is `EXTERNAL_UNDECLARED` alone — no `DEPRECATED_REFERENCE_FORM` "member path" beside it.
  - `sdd_remove_external`'s dry run answers what the real run removes (round 5 marks it a dry run); `sdd_get_externals_status` and `EXTERNAL_LIVE_INCOMPATIBLE` list a renamed name once.
  - The externals hint no longer sends a project without members to `validate --family`.
  - `member attach` refuses a malformed alias as `alias-invalid` (was `alias-taken`).
  - The generated AI guide names every `sdd_*` tool the server registers and says plainly that an L4/L5 prose change re-opens the approval while code linkage does not.
- **Identifiers, robustness and docs, round-5 trials:**
  - Ids that are JavaScript prototype names work: `constructor` is a component, type, subsystem, member alias or project id like any other (it broke `sdd_add_component`, `sdd_add_type` and `sdd_delete_spec` with raw Node errors and was refused as a `DUPLICATE_SPEC_ID` of `function Object()`), and every registry keyed by a user id reads by own key only. `__proto__` is refused by the id grammar for every kind of id, naming why (a YAML or JSON key of that name is dropped on read); `member add __proto__` no longer says "already declared as {}".
  - One id grammar for every kind of id: spec ids, project ids, member and external aliases, and method, parameter and field names are never empty, at most 64 characters, never start with `-`, hold no control, NUL or zero-width character and are never `__proto__`; project ids and aliases also refuse Windows device names and `super`; method, parameter and field names are ASCII identifiers that never start with a digit. `project rename con` / a 300-character id (CLI and `sdd_rename_project` dry run alike), a 300-character or digit-leading method name and a leading-dash component id are refused; `member add aux` is refused for the right reason (a device name). Display `name`s are never blank and hold no invisible character. A name-derived project id is cut to 64 characters, and one the grammar still refuses is no id (`PROJECT_ID_AMBIGUOUS`).
  - Language-aware names: new `RESERVED_IDENTIFIER` (error) refuses a method, parameter or field name the tree's `targetLanguage` reserves for that kind — Rust, Python, Go, Java, C#, C and Kotlin keywords everywhere; TypeScript/JavaScript and Ruby keywords as parameters only, and `constructor` as a TypeScript method — naming the language and an alternative. The writers and the rename tools refuse the same names.
  - `sdd_define_interface` (and `sdd_add_type`, `sdd_update_spec`) refuse a method, parameter or field name they introduce that `sdd_rename_method`/`rename-param`/`rename-field` would refuse — the identifier grammar, a reserved word, a duplicate, and (for a contract implementing no extension point) the tree's method casing.
  - New `DUPLICATE_MEMBER_NAME` (error): two methods of one contract or type, two parameters of one method or two fields of one type sharing a name. New `ENDPOINT_PATH_PLACEHOLDER` (error): an HTTP path placeholder left unclosed, written twice, or naming neither a parameter of its method nor a field of a parameter's type. `RENAME_TRACE_CONFLICT` reports a method, parameter or field trace that holds its own current name.
  - `sdd_update_spec` with `[]` clears every list, the keyed ones (`publicInterfaces`, `methods`, `fields`, `dispatch`, `lifecycle`) included — `publicInterfaces: []` was silently ignored.
  - `sdd_get_network_flows to: <project>::<portal>` resolves the bound project's own id, and a party that names nothing is refused instead of answering `[]`.
  - `status --subsystem nope` (and `sdd_get_status`), `diagram --subsystem nope`, `diagram --depth -1|abc` and `member add x .wai` are refused with one line.
  - An Observer may bind a messaging technology, and its prose naming one is no `TECH_LEAKAGE` (Observer joins Adapter, Store, Registry and Index as a technology seam).
  - `validate` ends with one code-reading line — the analysis grade and, at exact grade, the TypeScript compiler and whose copy it is (`Code read at grade exact with TypeScript 5.9.3 (wairon's own copy)`); `sdd_validate_tree` carries the same sentence in its hint.
  - `lock` counts every draft or design spec per kind (it counted components only, and only when all were draft), and a re-run with nothing it records changed keeps `.wai/lock.json` — `lockedAt` included — untouched.
  - The rename plan no longer prints `id: id: old → new`.
  - Docs: `wairon method rename` (`--dry-run`, `--search`, `--no-pin-symbol`) has a cli.md section and a README row; cli.md documents the id grammar, the code-reading line and lock's draft count; the generated `.wai/context/wairon-guide.md` states "Prose is design; linkage is not".
- **Approval, doctor, externals, surfaces and OpenAPI, round-5 trials:**
  - An approval record that cannot be read fails closed everywhere. A `.wai/lock.json` that is empty (a BOM alone included), not JSON, JSON that is not a lock record (`null`, a string, `{"formatVersion": 99}`), or of a newer lock format is no longer read as "absent": `lock-check` (plain and `--strict`), `status`, `validate`, `sdd_get_status` and the family gates each stop with one `✖` line naming the file and what is wrong (never `Cannot read properties of undefined`), and `doctor` names it. `wairon lock` never overwrites a record it cannot read: restore it (`git checkout -- .wai/lock.json`) or delete it to approve afresh. An editor's BOM before a valid record is tolerated. **Breaking for scripts:** a plain `lock-check` that passed on a corrupt record now fails.
  - A specs folder whose L0 (`.wai/specs/.index.yaml`) was deleted while spec files remain is an error, not an empty tree: `validate` and `validate --ci` exit 1 naming the missing file and how many spec files it leaves unjudged, and `lock-check` refuses at every strictness (it said "the spec tree is empty" / "nothing is gated", exit 0).
  - `wairon doctor --fix` no longer records the packs installed on the machine as explicit selections in a project (or in its members) that never declared `useGlobalPacks`: that wrote one developer's home store into an approved repository, drifted the approval and asked for a pack CI could not fetch. `doctor` still lists them and names `wairon pack use <name>`. The `pinInstalledPacksAsSelections` core export and the project-config repository's `pinGlobalPacksAsSelections` write are removed.
  - `effect` travels through `signatureFrom`: a verb whose signature comes from a contract method (this project's or another project's export) takes that method's effect unless it declares its own, so a Portal verb forwarding a pure method is pure — exports and pins carry it, and a pure consumer may call it (`LIBRARY_CALL_IMPURE` judged it "not declared").
  - `surface diff` prints an effect that was not declared as `undeclared` (a newly declared `effect: none` read `effect none → none`).
  - Field and parameter renames reach a consumer with their new names. A snapshot carries each field's (and signature parameter's) rename trace as `formerly`. `surface diff` lists `renamed <type>.<field> — field "zoom" renamed to "z"` instead of an anonymous shape change (the shape row stays only for what the renames do not explain), and `renamed <entry>.<method> — parameter "address" renamed to "query"` (it listed nothing). A consumer's `EXTERNAL_LIVE_INCOMPATIBLE` / `EXTERNAL_INCOMPATIBLE` and `externals status` name `field "tile_coord.zoom" renamed to "z" (its shape is otherwise unchanged) — follow the rename`, and a parameter rename is a stale fact naming the new name.
  - A use beyond the pin is named by `validate` (and `sdd_validate_tree`, `status`): `EXTERNAL_LIVE_UNCOMPARED` (advisory notice) lists each `<name>.<member>` used now but not in the lock and that `wairon lock` refuses and `lock-check` fails until it is re-pinned. `validate --ci` still passes it — the approval is `lock-check`'s gate, which the CI recipe runs beside it. `externals status` lists such uses member by member, as `lock` does.
  - `drifted` agrees with the health: a pinned snapshot whose carried facts moved (an `abi`, an effect, a rename trace) is `drifted: true` in `sdd_get_externals_status` and `externals status --json` (MCP said `health: drifted` beside `drifted: false`).
  - `sdd_rename_method`'s dry-run `breaks` is narrowed to what breaks: the public names publishing the method, each with that one member (it listed the consumer's whole use of the producer), as the CLI dry run says it.
  - Dry runs say they are dry runs: `sdd_remove_external` / `externals remove --dry-run --json` answer `dryRun: true`, `removed: false`, `unpinned: false` and `wouldRemove: {declaration, pin}` (they answered `removed: true`, identical to the real run); `sdd_add_external` and `sdd_update_external` dry runs carry `dryRun: true`. **MCP output schema:** `sdd_remove_external` gains `dryRun` and `wouldRemove`, `sdd_add_external` and `sdd_update_external` gain `dryRun` (all optional).
  - The OpenAPI document of a project's own HTTP API: `surface export --format openapi` renders every HTTP Portal of the project, exported to other wairon projects or not (the L0 export table governs consumption, not documentation) — its default audience is now `project`; a wider `--audience` narrows it to what the table shares there, and `--portal` naming a Portal left out says why instead of "Unknown portal". The credential a Portal's auth binds (`token`, `bearerToken`, an `apiKey` named like the scheme's key, …) is no longer a required query or body parameter beside `security`; it is named under `x-wairon-credential-param`. Express-style `:name` placeholders are path parameters (`/routes/:id` → `/routes/{id}`, `in: path`), and `method rename-param` respells them in their own form. The Portal's `basePath` is part of every path (named once as `x-wairon-base-path`; the relative `servers` URL is gone). A type of a pinned external (`geo::coordinate`) renders from the pin as `geo.coordinate` instead of "Unresolved type". `info.version` is the project's declared version (package.json, Cargo.toml or pyproject.toml). The hosted demo's endpoint paths are now relative to their Portal's basePath, as the reach model always joined them.
- **Delegation briefs and binding modules, round-6 trials:**
  - A brief's code write fence is exact files, never a folder glob: `codeFence` holds the files its specs alone name — implementation, method, simPath and binding files, and the files of the types the agent owns (a component's: its `componentClass` types and the types only its own contracts use, so a subagent creates `Payment` at its planned home instead of copying it). A file another component's specs also name is no single fence's. `src/**` is gone, so sibling fences never overlap and parallel implementers need no hand-narrowed fences.
  - New `sharedPaths` on the brief (and a "Shared, owned by no single agent" list in its fence section, `wairon agent brief` and the `wairon-agent://` resource): the files other components' specs name too, the module setup from the project root down to the code (`package.json`, `tsconfig.json`, `Cargo.toml`, … — a service's own manifest included, so a subagent can fix the module type its tests need) for implementers as well as owners, the package roots there and up to eight unnamed source files beside its own. The rule is stated once: touch them only for this component's needs and name each in the report; a shared or unnamed file that would need a responsibility of its own is a design change — stop and report it. **Breaking for brief consumers:** a subsystem owner's setup files moved from `codeFence` to `sharedPaths`.
  - An implementer's `readPaths` carry the specs of the types its contracts use (and of the types their fields name), its dependencies' contracts and the files realizing them.
  - The `gateway` variant's guidance agrees with what a gateway does: checking the credential its `auth` declares is its own admission step and may be a step of its narrative; a check needing state or policy is called (it said "hold NO verification logic" beside approved narratives that verify the token).
  - New `bindings` on an implementation (code linkage, outside the approval; `sdd_write_narrative`, `sdd_update_spec`): the hand-written binding modules through which its code reaches another project's library. New rule `binding-modules`: `BINDING_DRIFT` (warning) compares each binding's exported declarations with the pinned snapshots of the externals the component reaches — a method or function the pin renamed (`"tile_for_coordinate" was renamed to "tile_at" in geo::tiles — follow the rename`), one it no longer exports, a parameter list whose arity or names differ (a parameter rename named), a field the pinned type renamed or lacks; `BINDING_UNREAD` (notice) for a binding not written yet, outside the root, not TypeScript/JavaScript, or whose component reaches no pinned external. A stale call into a library through a binding no longer survives re-pin, `validate`, tsc and the tests unremarked. Return types are not compared.
  - `BINDING_DRIFT` also compares a binding into a **member** project, which is never pinned, with what the member's L0 exports now (read live in the family scan, rename traces included): a parameter or field renamed in a member (`rename-param`, `rename-field`) reaches the parent's binding at `validate` time with the rename to follow (`parameter "zoom" of "tileAt" was renamed to "z" — follow the rename`, compared "as its member project exports it now"), where before only the rename's dry-run `breaks` named that consumer. A binding whose component reaches a member is no longer `BINDING_UNREAD` telling you to pin it. The built-in rule set changes; an approval taken under the previous release carries over when the re-validation is clean.
- **Approval, authoring, generated files, renames, surfaces and networks, round-6 trials:**
  - Root pointer files keep your text. `wairon init`, `generate`, `lock` and `doctor --fix` write only wairon's block of the root `CLAUDE.md` (and `GEMINI.md`, `.cursorrules`, `.github/copilot-instructions.md`, `.codexrules`), between `<!-- wairon-root-start -->` and `<!-- wairon-root-end -->`; every other byte is kept, the block takes the file's line endings, and a file whose own text already imports `@.claude/CLAUDE.md` is not given a second import. `init -y` used to replace an existing root `CLAUDE.md`, and every later lock, generate or doctor --fix deleted text appended to it. A root file holding the unmarked pointer an earlier release wrote (alone or with text after it) is migrated into the marked block. `init` says it wrote into an existing file instead of "Created". A demote removes only the marked block.
  - **Upgrading wairon no longer stales an approval by itself.** A lock records each input of its gate identity on its own (`gateParts` in `.wai/lock.json`: design, release, rules, packs, network, composition, contracts, members). When only the release's built-in design rules moved, the approved design is re-validated under the current rules in the same command: clean at the `--ci` standard it carries over, nothing written, and `lock-check`, `status`, `sdd_get_status`, `validate` and the family view say "approved under <old>, re-validated under <new>: still approved"; `wairon lock` then refreshes the record's release stamp (`restamped`) without asking for a re-approval. If the new rules find errors or warnings, the approval is stale for exactly those ("the new release finds N issue(s) in the approved design: …"), never the generic five-candidate sentence. The project's own rule tuning, packs, network and pins stay in the identity. A record from before gate parts is judged the same way when another release took it, no own spec moved and every member pin is unchanged (its own tuning and pins it can only prove inside its digest until one `wairon lock`). New on `ProjectApproval`: `release` and `inputsMoved`; new on `StateId`: `parts`; new on `LockRecord`: `gateParts`, `restamped`.
  - The hosted project configuration view (`getProjectConfig` / `setProjectType`, the web UI's lock badge) reads the same release verdict: an approval carried over a release change reports `locked`, not `lockStale`, as `lock-check` and `status` say locally.
  - A stale approval names the input that moved when its record carries gate parts: after `wairon network declare` the verdict says "the network declaration" (likewise the rule tuning, the packs, a consumed contract's pin, `composition`), in `lock-check`, `status`, `lock` and `MEMBER_DRIFTED`.
  - **BREAKING (MCP `sdd_update_spec`):** a list of plain values (`owns`, `dependsOn`, `guarantees`, `previousNames`, a technology's `matches`, the L0's `globalRequirements` written as text) MERGES at every depth: values the delta names are appended when missing and every held value is kept; one is removed only by a marker element `{ "value": <v>, "action": "delete" }` (a requirement also `{ "description": <text>, "action": "delete" }`), and `[]` still clears. It used to replace the list, so one new requirement deleted the other three. A marker naming a value the list does not hold is refused. The tool's description says so (description text only, no input-schema change).
  - The hosted web Specs editor saves list edits in that vocabulary: removing an L0 boundary or global requirement, an implementation's technology or a contract method's guarantee now sends a removal marker (it sent the whole list, which the merge kept whole, so a removal silently did nothing), and a reorder or an in-place edit removes the stored items and re-adds the list in the order shown, in one delta. A list mixing text and object items, which the server replaces whole, is still sent whole.
  - A corrupt, empty, `null` or schema-invalid L0 with specs below it fails closed exactly like a missing one: plain `lock-check` (and `--strict`) refuse it instead of "No SDD spec tree here … nothing is gated"; `status` says it in one line, once ("The L0 System spec (.wai/specs/.index.yaml) cannot be read: …"), instead of a raw schema dump twice; `validate`'s `MISSING_SYSTEM_SPEC` names `.wai/specs/.index.yaml` and says whether it is missing or unreadable. `status` and `lock` with a missing L0 and specs below it say what `validate` says (its root is gone) instead of "not started" / "no spec tree".
  - A lock record without `lockedAt` or a usable `lockedBy` reads "approved at an unrecorded time by an unrecorded approver", never "approved undefined by unknown".
  - `sdd_get_network_flows` filters by a member's own party at a member root: `to: <portal>`, `<member>::<portal>` and a subsystem now return the rows the unfiltered call lands there (they returned `[]`), as `wairon network why` reads them.
  - `wairon doctor` reports a derived context document whose content a regenerate would change as stale, not "current" because its stamp matches.
  - **BREAKING (validate):** a tree with no `targetLanguage` is judged by the TypeScript reserved words, as it is already judged by TypeScript's camelCase method casing: a method named `constructor` or a parameter named `class` there is `RESERVED_IDENTIFIER`, and the message says the tree declares no targetLanguage.
  - `wairon init` in a folder whose name gives no usable project id (`con`, `super`, `aux`) writes `<name>-project` as the id and says why, instead of a project.yaml with no id.
  - `externalizeSubsystem`, `internalizeMember` and `member promote` re-base an implementation's `bindings` paths as they re-base its other file paths.
  - `wairon method rename-param` and `wairon type rename-field` take `--dry-run` and `--search <dirs...>`, and name every consumer that breaks: the family in reach (members included) and checkouts in the searched folders. `sdd_rename_param` and `sdd_rename_field` take `dryRun` and `search` and answer `publishedIn` and `breaks`. `sdd_rename_component` and `sdd_rename_type` take `dryRun`.
  - A parameter rename respells the HTTP placeholder (`{old}` or `/:old`) on every method whose `signatureFrom` takes the renamed method's signature, not only on the method's own binding.
  - Rename dry runs' `breaks[].uses[].specs` name only the specs that reach the renamed member. `ExportUse` gains `memberSpecs`, which also shows in `sdd_list_consumers` output.
  - `surface diff` / `sdd_surface_diff` count each traced rename once: a renamed method with an unchanged shape no longer also reads as a signature change, an alias respelling of another project's type is no change, and a type rename plus a field rename no longer marks every type embedding them as "type shape changed".
  - **BREAKING (library report shape):** `ParamRename` and `FieldRename` gain a required `publishedIn` (for `FieldRename` a list of `ExportUse`).
  - **BREAKING (validate):** new rule `ENDPOINT_ROUTE_DUPLICATE` (error): two methods bound to the same HTTP verb and path within one Portal, or across Portals declaring the same basePath; placeholders are compared by position, so `{id}` and `:code` are the same segment. The built-in rule set (part of the gate identity) changes. The OpenAPI export refuses two operations on one path and verb, naming both, instead of silently dropping one.
  - **BREAKING (validate):** an L0 wildcard re-export whose source exports nothing is `EXPORT_INVALID` instead of passing silently.
  - `surface export` never prints ✔ when it publishes nothing, and warns with the error count and codes when the design fails validate. Status lines go to stderr, so `surface export --format openapi > api.json` writes pure JSON. `surface diff` lists an added L0 entry that publishes nothing instead of "no change"; `--against` an OpenAPI document, or any non-snapshot file, is refused in one line instead of a raw schema error.
  - **BREAKING (OpenAPI):** operations answer the verb's conventional success code (204 no content, 201 POST, else 200), and `result<T, E>` adds a `default` error response with E's schema. `surface import` reads any 2xx, reads 204 as void, and turns an error response back into `result<T, E>`. `auth.scheme: custom` no longer invents an `Authorization` header: it is an apiKey scheme in `auth.name`'s header when one is named, otherwise an http scheme `custom`.
- **Approval, lock and migrations, round-7 trials:**
  - **BREAKING (approval):** a lock record without gate parts (every record written before wairon recorded them) never carries over a change of the wairon release automatically: it cannot prove the project's own rule tuning, packs, network or pins unchanged, so a tuning change made in the same upgrade can no longer be restamped as approved. It is stale with one sentence — "Approved under wairon <old> before wairon recorded its inputs separately — re-lock once to record them; later upgrades then carry over." — on `lock-check`, `status`, `validate`, `sdd_get_status` and the family view, and `wairon lock` takes a real approval (it asks), never a restamp. Records with gate parts keep the carry-over.
  - A member's restamp is no re-approval: `restamped` records the subject of the human approval (`restamped.subject`), and a parent's gate identity and member pin read that subject (`lock_record.approvalSubject`), so a family carries a release upgrade over at every root without a re-approval per member.
  - A lock of an unchanged approval leaves the record on file as it is — `lockedAt`, release stamp and `restamped` trace — and `.wai/lock.json` untouched; only evidence beside the approval (code results, design counts, gate parts that are missing or do not match the identity) is refreshed, and the summary names it. Another approver locking an unchanged design is told their own approval is recorded. `wairon lock` prints "Lock record unchanged … left untouched" when it wrote nothing.
  - A release stamp that is no wairon version, or is newer than the running wairon, is no upgrade: stale, saying "written by a newer wairon" or that the stamp is no version, never "re-validated under". A record without gate parts whose stamp claims a release that records them says its stamp was edited and an earlier wairon took it, instead of five candidate inputs.
  - Gate parts must break down the `stateId` they sit beside: parts that do not (a part missing, a part differing while the identity matches, or no part moved while the identity did) are ignored with a notice and carry nothing over; `wairon lock` rewrites them from a still-matching identity, keeping the approval.
  - **BREAKING (CLI `lock --subsystem`):** a scoped lock only re-approves. It is refused as a first approval (the identity a lock certifies is the whole design's), and refused whenever a spec outside the subsystem or an input besides the design moved since the approval; when it passes, the record is the one a full lock writes, so the record, the identity, `status` and `lock-check` agree.
  - Family migrations judge each project they change on their rehearsal copy and announce every design finding the result will have that the project does not report now, as a plan note (`after attach: N new error(s) the projects it changes do not report now: …`), in the CLI report and the MCP answer alike. Both sides are judged on copies of the `.wai` trees, so planning reads no code. The copy now also holds a member the plan declares without writing into it.
  - **BREAKING (validate):** a `signatureFrom` naming another project's export (`alias::name.method`) needs no `dependsOn` whatever the relation: a contained member is judged like a declared external (it raised `SIGNATURE_SOURCE_OFF_EDGE` only as a member). An implementer of an extension point never depends on the producer's component. Only a source inside the method's own project needs the edge.
  - A test holds `docs/cli.md` and the `project.yaml` schema to the same settings: every documented key (`rules.conformance.requireCode`, `composition.requireApprovedMembers`, …) must be one the schema reads.
- **Authoring tools, round-7 trials:**
  - **BREAKING (MCP `sdd_update_spec`):** a delta is refused when it changes which spec it is or where it lives: its `id` or `createdAt`, a component's or type's `subsystem`, a contract's `component`, an implementation's `contract` (by value or by `unset`). The delta used to write a second spec under the new id (same route, same lint allows) or move the folder, leaving every reference behind, and answered "1 change". The refusal names the tool that owns the change (`sdd_rename_component`, `sdd_rename_type`, `sdd_move_methods`) and says so where none exists yet: no tool moves a component or a type to another subsystem, or renames a subsystem. A restated value is still accepted, and setting a subsystem still repairs a spec whose stored subsystem the tree does not have.
  - **BREAKING (MCP `sdd_delete_spec`):** deletes a spec with everything it contains: a contract with its implementations, a component with its contracts, implementations and owned members, a subsystem with its components and types. It used to remove only the index file, orphan the rest and answer "Successfully deleted". A deletion that would leave a reference in a spec that stays is refused and lists every reference (the invalid references validate would report). New inputs: `force: true` deletes anyway and answers the references it left, and `dryRun: true` answers the plan and removes nothing. The structured answer gains `dryRun`, `removed` and `references`.
  - **BREAKING (MCP authoring):** the write gate refuses the error-level design findings a write introduces: a doctrine edge between two existing blocks (a Portal depending on a Store, and the other `ARCHITECTURE_VIOLATION_*_DEP` codes) and a route another method already binds (`ENDPOINT_ROUTE_DUPLICATE`). This applies to `sdd_update_spec` (its dry run included), `sdd_set_endpoints`, `sdd_add_component` and `sdd_define_interface`. Findings the tree already had are not judged, and a code the project tuned down in `sddRuleSeverity` is reported as a notice instead.
  - A list restated with exactly its stored elements in a new order takes that order and reports `reordered`; it used to answer "No change — the delta matches what is stored". The change report has a new kind, `reordered`. A list of plain values (`dependsOn`, `technologies`, requirements written as text) is reported value by value, so a mixed edit no longer reads as the whole list `set` and cut at 120 characters. A long text that changed is shown from just before the change.
  - A dry run takes the write's path through the writer's schema and write checks, so it is refused exactly when the write would be. Before, `technologies: [{name: …}]` and `unset: ["vision"]` answered "would be added" or "1 change would be made", and then the write refused them. A property test checks that a dry run and a write of the same delta give the same result.
  - `unset: ["dependsOn"]` (any list the schema defaults) reports the clearing without a contradicting `NO EFFECT … unset did not remove it`.
  - `sdd_add_component` takes `variant`, so a gateway Portal is one call. When the input leaves it out, a stored variant is carried as before.
  - The `sdd_update_spec` description is shorter: about 1,000 characters plus a 2,100-character `delta` description (was 1,000 plus 5,600). The server never cut it; the trial's probe printed only the first 6,000 characters of the schema.
  - `sdd_rename_param` and `sdd_rename_field` refuse a rename back to a name the parameter or field itself retired (`name-retired`), as `sdd_rename_method` does. Before, the rename went through and the tree then reported `RENAME_TRACE_CONFLICT`.
  - `member attach` / `sdd_attach_member` accept a sibling path with a leading `../`, as `member add` does. Any other path out of the project is still `not-contained`. `cli.md` no longer lists `sdd_add_member` and `sdd_move_member` among the tools that take `dryRun`; only the family migrations do.
- **Surfaces, externals, binding modules and the OpenAPI codec, round-7 trials:**
  - **BREAKING (validate):** binding modules are compared in every shape the trials met. A binding into a contained member declared under an alias other than its project id is compared with what the member exports now (it was `BINDING_UNREAD … pin it`, a pin a member cannot have); a component reaches a project through the types its contract names too, so a binding to a types-only contracts library is compared; CommonJS exports (`exports.X = { … }`, `module.exports.X = …`, the properties of `module.exports = { … }`) are read; a type the producer renamed is named when the binding still declares it, or types a field with it, under the former name; a verb the producer removed is named when the declaration is tagged to its interface (`/** geo::tiles */`, `/** geo::tiles.tile_at */`) or an earlier pin held it. New `BINDING_DRIFT` findings can fail `--ci`.
  - `BINDING_UNREAD` says why in member terms: a member is never told to pin (one that exports nothing is told to export there), a pin is suggested only for a declared external (`wairon externals pin <alias>`), and a module that declares nothing comparable names the export forms it cannot see into (`module.exports = require(…)`). The message reads "is not compared:" (was "is not compared with any pin:"). A brief's "Externals used" names a member as a member project read live, never "not pinned yet".
  - A re-pin records each method the producer removed since the previous pin as `retired` on the snapshot's entry, carried while the name stays absent. Provenance: no digest, carried fact or drift comparison reads it.
  - `wairon method rename-param` / `sdd_rename_param` follow `signatureFrom`: renaming a parameter of a method a published Portal verb forwards names that Portal's exports in `publishedIn` and the consumers calling the verb in `breaks` (it answered `publishedIn: []`). Asked of the Portal verb, the rename is made on its source and `routedFrom` says so (it was refused `param-missing`); a verb forwarding another project's method or a signature type is still refused, naming the source and that a rename there reaches the verb. `ParamRename` gains `published` (method-granular, with former names) and `routedFrom`.
  - Rename break reports keep a consumer whose reference an earlier rename already broke: a call still naming a method's former name, and a former public name it still writes, are named among the breaks (`ExportUse` gains `formerNames` and `formerMembers` on a rename's published list).
  - **BREAKING (`surface diff`):** against a revision it covers the project's own HTTP Portals (exported or not), and every type they name from a pinned external or a member is expanded from that side's pin or member, so a re-pin that reshapes the project's own wire format is a change on the verb. A field rename keeps its row beside its type's rename (traced, or a changed public name of the same definition, which is no longer "removed + added"), and a type reshaped only by a rename it embeds is a `changed` row naming it.
  - `externals status` / `sdd_get_externals_status` say what moved with a renamed method — each parameter renamed per its trace, each field of its closure renamed, added or removed — and never "(its signature is unchanged)" beside a parameter or answer type that moved.
  - **BREAKING (OpenAPI):** a method whose one body param is an object type sends that object as the bare body (named under `x-wairon-body-param`, which `surface import` reads back); several body params stay the properties of a body object. A POST answers `201` only when it creates — effect `lifecycle`, or an undeclared, `write` or `io` effect with a creating name (`create…`, `add…`, `place…`, `signUp`, …) — and `200` otherwise (a cancel, an archive, a log-in).
  - The OpenAPI export resolves a member project's types from what the member exports now, by public name, as it resolves a pinned external's, and a type nothing resolves is named in a warning instead of a ✔ (`SurfaceExportResult.unresolvedTypes`).
  - **BREAKING (CLI `member add`):** a git producer whose L0 exports its names only more narrowly than `instance` (the audience a git member is read at) is refused with the audience reason `externals add` gives, writing nothing; a pin of a name exported too narrowly says so instead of "gone".
- **Conformance analyzer, round-7 trials:**
  - **BREAKING (validate, param conformance):** a parameter whose name starts with `_` is set aside only when the analyzer proves it unused (no identifier of its name in the body or another parameter's default, no `arguments`). A used `_secret` or `_apiKey` is judged like any parameter, so the one-character bypass is closed. `ParameterFact` gains `unused` and `kind`.
  - **BREAKING (validate, param conformance):** parameters are paired in order by the best agreement (names, then declared types, then the kind of value the checker settles), ties aligned against the tail as the rule text always said. `planRoute(apiKey, req)` for `planRoute(request)` now names `apiKey`, not `req`. A paired parameter whose name differs and whose kind differs is a substitution: `getRoute(params: Record<string, string>)` realizing `getRoute(id: string)` reports `id` as `UNREALIZED_PARAM` and `params` as `UNDECLARED_PARAM`. The honest `(req, url, params)` handler draws no `PARAM_OPTIONALITY`, and the finding names the one green path: `injectedParams: [req, url]` and the contract's own parameters after them. A private dispatch table keyed by the same verb names no longer hides the published handler.
  - **BREAKING (validate, fail-closed `any`):** class code is read like closure code. `await (this.store as any).x()` in a method that is not async, an optional (`store?:`) or `| undefined` Store field, a local alias, `(this as any).store`, a const read through its initializer and a Store typed by an interface a factory realizes all keep the receiver's original type, so the write is `PORTAL_CALL_UNRESOLVED` / `CALL_ORIGIN_UNRESOLVED`. Every string-typed computed key on a data component (`as string`, a reassigned `let`, an array element, a function result, an environment value, an index-signature variable, a `keyof` concatenation) fails closed the same way.
  - **BREAKING (validate):** a Portal call that lands only on a port no written class realizes, under the name of a data component's write the Portal claims nowhere, is `PORTAL_CALL_UNRESOLVED` even before the Store's file exists. The finding says when the Store has no code yet. `ResolvedCallFact` gains `port`.
  - A member of a workflow component's class that its contract does not declare is that component's code, not unowned code read as the caller's. A code-only rename (`markDone` → `complete`) is `CALL_STEP_UNREALIZED` naming the method the code calls instead, never `✖ PORTAL_WRITE_SHORTCUT_IN_CODE` blaming the Portal. A Portal calling such a member beside its narrated verbs is `UNDECLARED_WRITE_CALL`.
  - Route coverage reads string constants, concatenations and template literals, through the type checker across modules. A prefix the router strips before splitting the path (`pathname.slice(BASE.length)`) is folded in front of its routes, and such routes are read under the Portal's `basePath`, so `BASE = '/v1/habits'` under basePath `/v1` lists no phantom routes. Route tables (an array of `{ method, path }` objects with `/a/:b` templates or anchored regular expressions, or an object keyed `VERB /path`) are read, also in the functions the router entry calls. A table with an entry that does not settle is `UNREADABLE_ROUTER`; it is never read in part. `RouteFact` gains `fullPath`.
  - **BREAKING (validate):** new rule `CROSS_PROJECT_IMPORT_UNRESOLVED` (warning): an import, runtime or type-only, from another project's source (a folder with its own `.wai/project.yaml`) that the checker resolves to nothing, because the module is gone or no longer exports the name. A type-only import of a renamed `CustomerId` used to pass at grade exact. `SourceFileFacts` gains `crossProjectImports`.
  - wairon's own tree: `mcp_hosting_portal.createMcpServer` and `mcp_server.create` take an `options: mcp_server_options` (new type), as the code always did, instead of `hostedTools: bool`. `authenticateMaster`'s parameter is called `credential` in the code too.
- **Surfaces, externals, binding modules and the OpenAPI codec, round-8 trials:**
  - **BREAKING (OpenAPI):** every exported document is valid: a component key is `<alias>.<id>` (a qualified id's `::` written `.`), matching `^[a-zA-Z0-9._-]+$`; a type is ONE component however it is reached — under a member's alias, its project id, or another producer's closure — keyed by the first alias the project is held under; and the document holds exactly the types its operations reach (it held every type of the closure, each member type two or three times, `contracts::money` keys referenced by nothing).
  - **BREAKING (OpenAPI, schema):** an HTTP endpoint takes an optional success `status` (a 2xx or 3xx code; `sdd_set_endpoints` `status`), which the export answers with in place of its convention: 202 Accepted for work done later, a 3xx redirect (a `Location` header, no body), a 201 for a workflow verb that files something (`POST /routes/plan`). `surface import` reads a non-conventional success code back as `status` — a third-party create answering 200 now imports with `status: 200`.
  - **BREAKING (OpenAPI):** a field or parameter typed `T?` is no longer `required` (it stays nullable), and a field's description is carried on its property (and read back by `surface import`). Error responses are unchanged: a `default` response only for a `result<T, E>`, never one the design does not state.
  - **BREAKING (`surface diff`):** a moved endpoint is a change of the Portal verb — its path, HTTP verb or stated status (`endpoint POST /routes/plan → PUT /routes/plans`); it read "no change". Contract methods whose signatures moved only through the same renamed type or field are ONE row naming every method (`3 methods (listHabits, getHabit, archive): signatures read the same, but they name renamed types: …`), and no row is listed twice.
  - `surface diff` no longer reports an alias respelling (`shop-platform::money` → `contracts::money`) as a change of every verb — a round-7 regression: a pinned producer's own qualified closure ids (`contracts::money` inside the platform's pin) were left in its spelling when the pin was expanded, so both sides spelled `contracts::…` differently. Every closure type is now respelled under the alias.
  - Rename break reports follow a type through the signature closure of exported verbs to a consumer that depends on the publishing Portal as a whole (a bare `dependsOn: alias::portal`): `type rename-field`, `sdd_rename_field`, `method rename-param`, `sdd_rename_param`, `method rename` and `sdd_rename_method` named "No consumer in reach" for it.
  - `sdd_rename_type` takes `search` and answers `publishedIn` and `breaks`, as the field and parameter renames do (`TypeRename` gains `publishedIn`). `sdd_rename_component` keeps every public name through `as`, so it breaks no consumer and takes no search.
  - `externals consumers` / `sdd_list_consumers` mark a verb a consumer still calls on a kept public name that the contract no longer holds (`tiles.tile_for_coordinate (no longer exported)`), as the tool's description always promised.
  - **BREAKING (validate):** binding modules are read in every CommonJS shape: `module.exports = { Client }` (shorthand), `module.exports.X = X`, `module.exports = class X { … }` / `= X`, a TypeScript `export = X` or `export = { X }` (a `.d.ts` too), and JSDoc `@typedef` with `@property` lines — a bare identifier read through the module's own declaration of it. A `_private` member of a class or object is not part of the surface (it was reported "not exported"). A `module.exports = { … }` tagged as a whole judges each untagged member against its tag, so an extra member is reported. New `BINDING_DRIFT` findings can fail `--ci`.
  - `BINDING_DRIFT` names a renamed type a binding tags by its RETIRED id (`/** shared::customer_id */`) even when the rename kept the display name, and names the project that owns a type a member's verb answers (`shared::money`), never the member (`payments_svc::money`).
  - The advisory `EXTERNAL_LIVE_INCOMPATIBLE` names the binding modules the using specs' implementations declare: a binding is compared with the pin, never live, so it draws `BINDING_DRIFT` once the re-pin lands — the finding now says where the code must follow before then.
- **Conformance analyzer, round-8 trials:**
  - **BREAKING (validate, fail-closed `any`):** a write taken as a VALUE off an opaque receiver and invoked later (`const f = (this.plans as any).save; f(x)`) is `PORTAL_CALL_UNRESOLVED` / `CALL_ORIGIN_UNRESOLVED`, as the rule text always said. A receiver is opaque however it came to be — a cast, an any-typed closure parameter, a local typed any, a function result typed any (`parseJson`). A port cast away while the data component behind it is still planned (`(this.sink as any).update(x)`, `const s: any = this.sink`) is judged by the design's write set, which a planned component has too; it passed until the Store's file existed. The same name reached in two functions is two findings — the first no longer hides the second.
  - **BREAKING (validate, param conformance):** an object where the contract declares a record is compared structurally, by the property names the checker gives its type: one holding every field is a rename (`PARAM_NAME_MISMATCH`), one sharing none a substitution (`UNREALIZED_PARAM` + `UNDECLARED_PARAM`), and a platform transport class (`IncomingMessage`, a fetch `Request`…) where a record is declared is a substitution — `planRoute(req: IncomingMessage)` and `planRoute(session: { user: string })` for `planRoute(request: plan_request)` passed silently. Where the code settles no kind (unannotated JavaScript, `any`), a parameter named as a transport handle (req, res, ctx, request, response, next, reply) in a domain argument's place is a substitution: same-arity framework handlers like `cancelOrder(req, res)` for `cancelOrder(orderId, customerId)` passed `--ci`. A date, datetime, duration or bytes compares with the kinds it is written as, so a fresh name for one (`when: string` for `date: date`) is `PARAM_NAME_MISMATCH`, which says when the code still uses the parameter's retired name.
  - **BREAKING (validate):** new `UNUSED_INJECTED_PARAM` (warning): an `injectedParams` name none of the implementation's realizing functions takes — stale linkage that would wave through the next parameter of that name. `ParameterFact` gains `fields`, `transport` and `reads`.
  - Framework handlers have a green path that needs no design change: `injectedParams` matches a name with or without its leading `_`, and drops a TRAILING run as well as a leading one (a trailing one only where the contract declares no parameter of that name); a contract parameter the code does not take but reads off an injected request handle by its own name (`req.params.code`, `req.query['limit']`, a destructuring of such a read) is realized through it. The findings name both shapes.
  - **Fix:** the conformance dial (`conformance: off` on an implementation or a method) was stored but ignored by the parameter and async checks; it now switches them off. In the call check it switches only the forward direction off (whether the claims are found in the code) — the converse (`UNDECLARED_WRITE_CALL`, `CALL_ORIGIN_UNRESOLVED`, `UNDECLARED_COLOCATED_CALL`) is judged whatever the dial says, where `off` used to skip it too. Doctrine checks (`PORTAL_WRITE_SHORTCUT_IN_CODE`, `PORTAL_CALL_UNRESOLVED`, `UNDECLARED_DEPENDENCY`, route coverage) never read the dial.
  - **BREAKING (validate):** new `CROSS_PROJECT_SOURCE_IMPORT` (warning): an import that RESOLVES into another project's source (a member's, or a sibling's) under a name that project does not publish — its L0 export table as a member exports it now, or the pinned snapshot of the external it is — is code reaching into its internals past its surface; the finding names the data component the module realizes, since a write through it is the persistence shortcut past the other project's surface. A declared binding module is the sanctioned place for that reach and is never reported. `CrossProjectImportFact` gains `resolved` and `module`.
  - Routers: `router` may name a central module's table or entry (`src/routes.ts#ROUTES`) or a module alone (`src/routes.ts`, every route-bearing export read), and a route table bound to a top-level const is read under its own name; several Portals naming one router are judged against all of them. An object table keyed by template literals over constants (`` [`POST ${PREFIX}/orders`] ``) and a table returned in place (`return [ … ]`) are read instead of `UNREADABLE_ROUTER`. A table is read under the one prefix its router strips (`path.slice(BASE.length)`), so a prefix that is not the Portal's `basePath` is `UNDECLARED_ROUTE` + `UNROUTED_ENDPOINT` naming both — it passed. A router module counts as claimed source. `RouteFact` gains `table`; `SourceFileFacts` gains `routePrefixes`.
  - New `CALL_ACROSS_LANGUAGE` (notice): a claimed call from TypeScript or JavaScript into a component whose code is in another language (a Rust member reached through a binding) is no longer judged by the call graph — it drew `CALL_STEP_UNREALIZED` warnings no code could clear, turning a family root red on attach — and the boundary is said once per project and language.
  - Docs: `sdd-implement` and `sdd-delegate` describe the handler shape, `injectedParams`, reading parameters off the request, the dial and router linkage; cli.md says the same under `validate`.
  - wairon's own tree: `host_request_orchestrator_impl` no longer declares a `dataDir` injection no handler takes.
- **Approval and lock, round-8 trials:**
  - A release stamp that is missing, no wairon version (`"banana"`) or newer than the running wairon (`"9.9.9"`) is reported on every path: round 7 judged the stamp only when the identity no longer matched, so a matching record kept a bogus stamp silently. `lock-check`, `status`, `sdd_get_status` and `validate` name it as a notice (the identity still decides), and `wairon lock` replaces it with the running release, keeping the approval.
  - A matching record whose `gateParts` block was deleted gets the notice `{}` got ("the record carries none"), and `lock` rewrites the parts.
  - **BREAKING (approval):** a `.wai/lock.json` that names one key twice in an object (what a careless conflict resolution leaves) cannot be read and fails closed by name, like conflict markers; JSON.parse silently kept the last copy.
  - **BREAKING (`lock-check`, `validate`, `lock`):** a committed approval that records spec files while `.wai/specs` is gone fails closed at every strictness ("the design it approved is gone"); "no spec tree here, nothing is gated" is said only when no approval is on record.
  - `lock-check` names a missing `.wai/project.yaml` instead of blaming the network declaration or the rule tuning it held.
  - The family root names a member in its own terms: one whose record predates gate parts is "its approval predates recorded inputs — re-lock it once at its own root", not "spec changes nobody approved", which is kept for a member whose specs may have moved.
  - `lock` at a parent warns, before it writes, when a direct member is not covered by its own approval: the order is bottom-up (members first), or the parent locks twice. cli.md says so.
  - **BREAKING (CLI `lock --subsystem`):** a member project's subsystem (`--subsystem payments_svc::payments` at the root) is refused, naming the member's folder: a member's subsystem is approved at the member's own root. It used to print "nothing has changed … ✔ Specs locked" over a changed member spec.
  - **BREAKING (approval):** an extension pack the project selects that cannot load leaves the approval owed: `lock-check` fails naming the pack ("make the pack load, then `wairon lock`") instead of passing while `validate` is red.
  - The approval verdict (`status`, `sdd_get_status`) names every moved spec up to forty, then counts the rest and names `wairon status --all`; it named five and "… and N more".
  - A lock that records the project's own inputs for the first time (a first approval, a record from before gate parts) or after the rule tuning or packs moved prints them: projectType, each severity override (`PORTAL_WRITE_SHORTCUT → notice`), the selected packs, a declared network, `composition`.
  - A no-op `lock` says ".wai/lock.json is left untouched by this run"; evidence it refreshes (the analyzer's version in `code`, a replaced stamp) is named.
  - Docs: cli.md no longer says a change of wairon release writes a new record (a release whose built-in rules are unchanged leaves the record as it is), states that code-conformance configuration (`rules.conformance`, `requireCode` included, and code-rule severity overrides) is outside the approval identity and why, and the generated guide mentions `wairon lock --subsystem` and the bottom-up order.
- **Authoring tools and family migrations, round-8 trials:**
  - **BREAKING (MCP, authoring):** every write tool refuses a spec of another project, through one shared guard (`crossProjectWriteRefusal`), the dry run included: from a family root, `sdd_delete_spec {component: payments_svc::payment_store}` deleted the member's `.index.yaml` with no force and orphaned its contract and implementation, while `sdd_update_spec` on the same id was refused. The create tools (a parent in a member: `component: payments_svc::x`, `subsystem: payments_svc::payments`), `sdd_update_spec`, `sdd_delete_spec` (a member type by its key or by an `alias::name` too — it answered "file may not exist"), `sdd_set_endpoints`, `sdd_set_public_interfaces`, `sdd_move_methods`, the renames and the two new tools all answer "chained-spec: … lives in another project; <verb> it from that project's own root", naming the member's folder and the call to make in a session there.
  - **BREAKING (MCP):** `sdd_delete_spec` of an id no spec of the kind holds is refused (`spec-missing`) with what the id might have meant — the kind that does hold it (`"analytics" is a subsystem — pass kind "subsystem"`), a type's `<subsystem>::<id>` form for `api-gateway.principal`, the ids the kind holds — instead of answering "could not be deleted (file may not exist)". The L0 is refused by name.
  - **BREAKING (MCP, structured output):** a deletion reports `published` — every public name of the project a consumer reaches what goes through — and `breaks`, the consumers in reach (family members, and checkouts in the new `search` folders) whose specs use one, as every rename has. A producer deleting `sku_id` from a library saw "3 references" and no consumer.
  - **BREAKING (MCP, authoring):** removing a contract method through `sdd_update_spec` (a delete marker, or the list emptied) — or re-authoring a contract without it through `sdd_define_interface` — takes the method's implementation entries with it in the same write (`cascaded`; a dry run says which would go): a narrative realizes its contract method and means nothing without it, and the entry left behind was `UNEXPECTED_IMPLEMENTATION_METHOD`, refused by `lock`. The removal is refused while another spec still references the method (a call, register or dispatch step, a declared call, a dispatch binding, a lifecycle entrypoint, a signatureFrom), naming each, exactly as a deletion is. A removed published verb is reported under `published` and `breaks` (`sdd_update_spec` takes `search`).
  - **BREAKING (MCP, authoring):** the write gate refuses a dependsOn edge into another subsystem whose target is not a Portal (`CROSS_SUBSYSTEM_NON_ADAPTER`, `CROSS_SUBSYSTEM_PRIVATE_ACCESS`, `CROSS_SUBSYSTEM_TARGET_NON_PORTAL` on it, as validate reports them): no trustedLink or export makes a Store another subsystem's front door, so no later write can cure it. A Portal -> Store edge across subsystems was written ("1 change") while the same edge inside one subsystem was refused. A cross-subsystem edge into a Portal is curable (a client Adapter, a trustedLink, the target's export) and rides along as a warning notice.
  - **BREAKING (MCP, authoring):** a delta setting a system-level type's `subsystem` is refused like any other move, naming `sdd_move_spec` (it was written, leaving the file in `types/` and its references behind). The identity refusals now name the owning tools: `sdd_rename_spec` for a contract's or an implementation's id, `sdd_move_spec` for a subsystem.
  - New MCP tool `sdd_rename_spec {kind: interface | implementation, id, newId, dryRun?}`: renames ONE contract or implementation on its own and rewrites every reference — implementations' `contract`, export entries' `interface` (a public name derived from the old id is kept with `as`), lint allows and debt-register entries keyed on it — with a rename trace. The ids a component rename keeps when they are not derived from the component's had no rename at all.
  - New MCP tool `sdd_move_spec {kind: component | type, id, subsystem?, dryRun?}`: moves a component — with the members it owns, its contracts and implementations — or a type to another subsystem (a type also to or from system level). Ids never change; what names the old subsystem follows: its export entries and lifecycle entrypoints for the moved components, an L0 re-export from it (a whole-subsystem re-export gets an entry per moved export), and every type reference qualified by the old subsystem. A component move is gated: a forbidden doctrine edge or a cross-subsystem edge into a non-Portal it would create refuses it with the rule's words.
  - `sdd_rename_component` moves every file the component owns: a contract or implementation whose id is not derived from the component's (`memory_stats_store`) kept its id but stayed in the old folder, named after a component that no longer existed, with the validator silent. It now follows the component's folder.
  - `sdd_add_type` and `sdd_set_endpoints` take `dryRun` (the authoring seam's `writeSpec` takes `dryRun` on the restatement; the receipt says `dryRun`).
  - Every MCP tool description ends with its argument names (`Arguments: id, newId, dryRun?.`), read from the input schema — `sdd_externalize_subsystem` takes `subsystem`, the component and type renames `newId`, the method/param/field renames `newName`; callers guessed them from the CLI.
  - The change report no longer says both `reordered` and "NO EFFECT: the stored spec already held this value" for a list restated in another order, nor "the write did not store it" for a new field whose type it respelled (`string[]` stored as `list<string>`).
  - `constructor` stays a legal component id (accepted since round 5): renamed to, moved, deleted and read like any other — now covered by a test.
  - **BREAKING (family):** a `members` entry pointing at a `../` sibling checkout that holds a project is composed live, like a contained member: the family scan follows it, its own gate runs in the family run, and it is never pinned. `externals pin <alias>` on such a member is refused with the reason, and a plain `externals pin` prunes the pin an earlier release took. It was judged against its pin as a referenced external (lib-and-app: 19 × `EXTERNAL_CHECK_UNAVAILABLE`, a pin `geo → geo`, and `SIGNATURE_SOURCE_UNRESOLVED` / `IMPLEMENTS_MISMATCH` on a trait implementer). Git and hosted members are unchanged.
  - `member adopt` / `sdd_adopt_member` accept an external whose source is a `../` sibling, as `member attach` and `member add` read a location, so `member attach` refused with "use member adopt" is no longer a dead end.
  - **BREAKING (CLI):** a family migration (`member …`, `subsystem externalize`, `project rename`) run without `--yes` and with no terminal to confirm it exits 1. (A refusal already exited 1; the round-8 "`member add` refused with exit 0" did not reproduce from source or the built CLI.)
  - `member demote` and `member internalize` accept every file wairon writes under `.wai` — they refused every project `wairon init` created over `phased_design.md`. `phased_design.md`, `mcp`, `git.json`, `remote.json` and `producers.json` are deleted and listed (a workbook that differs from the home project's is named in the plan as not carried); `variants` and vendored `packs` are placed in the home project, and a differing file of the same name refuses. A file wairon never writes is still refused by name.
  - A family migration that respells params writes the derived signature texts itself (the store's re-save and reference respelling re-derive them): an internalize left 39 stale texts, read as `EXTERNAL_UNDECLARED`, until `doctor --fix`.
  - `member internalize` names in its plan the dependency loop it closes when it re-points a sibling consumer at the parent, and the plan's announcement now includes the resulting `PROJECT_DEPENDENCY_CYCLE` (announcements compare each side's family graph, not only the per-project runs).
  - `subsystem externalize --as project` (and `member promote`) declares, imports and pins the new project's externals for the sibling projects its moved specs name, instead of announcing an `EXTERNAL_UNDECLARED` per reference. `PromoteResult` gains `externalsDeclared`.
  - A plan's announcement judges a changed folder only where the result keeps a project root: a demote no longer announces `MISSING_SYSTEM_SPEC` for the folder it turns into a part. Internalize and demote plans list what could not be carried and each signature text they re-derived.
  - `status` and the canvas label a sibling member with its `../` location.
- **What the assistant reads (skills, guide, briefs), round-9 trials:**
  - `injectedParams` are code linkage, set by the implementer once the code exists: the architect skill and the `sdd_write_narrative` description say never to declare them while designing (the skill guessed `db`, `deps`, `config`, `req, res` on a fresh design, and approved projects carried them into `UNUSED_INJECTED_PARAM`); `sdd-implement` and every implementer brief say when and how to declare them (`sdd_write_narrative` or `sdd_update_spec`, no re-lock) and that a design-time guess the code does not take is removed — the brief lists the ones declared now.
  - No file is fenced to two implementers any more: a type's `componentClass` claimed its file even when another component's specs named that file too, so one `src/types.ts` holding two Stores' entity types sat in both Stores' write fences; such a file is now shared, and a last pass takes any file still in two implementer fences out of both. The architect skill plans type files per owning component (shared value types in one subsystem types file no component owns).
  - A first-wave brief lists the package or crate root beside its code as shared when a spec names it as planned (a maths module and its Portal's planned `mod.rs`), with the rule that a module root another agent owns takes only the line declaring the module; it was listed only once the file existed.
  - A Portal implementer's brief carries a `## Handler shape` section (the contract's own parameters, the handles named in `injectedParams`, a contract parameter read off the request by its own name, the `router` linkage and what `conformance: off` does and does not switch off).
  - A brief's member section spells the names a component uses by the member's PUBLIC export names (`geo::geocoding`, not the internal `geo::geocoding_portal`), and tells the binding modules to follow the member's live L0 export table instead of "the pin" for a member that is never pinned.
  - The generated guide (`.claude/CLAUDE.md`, `.wai/context/wairon-guide.md`, `GEMINI.md`) and the MCP server instructions list the commands the assistant recommends to the human — `surface export --format openapi`, `lock`, `lock-check`, `externals pin`, `network declare`, `member …`, `doctor --fix`, `agent customize` — state the `validate --ci` rule plainly (errors and warnings fail it, except the draft-related warnings; notices never do), and say a JSDoc `@typedef` makes plain-JS fields checkable.
  - The architect skill says where a Portal's need for an Adapter goes: into the Orchestrator it already dispatches to, or — for a sibling subsystem in the same process — a `trustedLink` that lets the Portal depend on the sibling's published Portal, never a one-call forwarding Orchestrator added for the hop.
- **Conformance analyzer, round-9 trials:**
  - **BREAKING (validate, fail-closed parameters):** new `PARAM_TYPE_MISMATCH` (warning): where the contract declares a record, a parameter typed opaquely — `any`, `unknown`, `object`, `{}`, `Record<string, unknown>`, or no annotation at all in TypeScript — or as an object missing the record's fields or adding its own (`{ stops: unknown[]; secret: string }`) is reported, naming the fields missing and added. `planRoute(request: any)` realizing `planRoute(request: plan_request)` passed `--ci`: the fail-closed rule that catches every `any` receiver stopped at the parameter list. A new code rather than `UNREALIZED_PARAM`, because the parameter IS taken, under its own name — what fails is its type, and the finding says so. Unannotated JavaScript stays unjudged. `ParameterFact` gains `opaque`; its `fields` are the type's DATA properties (methods set aside).
  - **BREAKING (validate, param conformance):** a parameter named as a transport handle (req, res, ctx, request, response, next, reply) in a contract parameter's place is a substitution however the handle is typed — a hand-written `type Req = { params: … }` included — and a MEMBER project's contract types (`shared::order_id`) are read live from the family, their code name, kind and fields: `cancelOrder(req: Req, res: Res)` realizing `cancelOrder(orderId: shared::order_id, customerId: shared::customer_ref)` passed with 0 findings, reading nothing off `req`. An object whose properties name two or more of the contract's own parameters bundles them: `cancelOrder(input: { orderId, customerId })` reports both unrealized and the object undeclared, where it named `orderId` alone (and wrongly).
  - The framework-handler green path reads what node:http handlers read: a contract parameter read off an injected request (`req`, `request`, `ctx`, `context`, `event`, and now `url`) through `req.query.x`, `req.body.x`, `url.searchParams.get('x')` on a `new URL(req.url, base)`, a destructuring at any depth, a local the request flows into, or a helper the request is passed to — in the same file, or in a module no implementation claims (`const { orderId } = pathParams(req)`) — is realized; the one record parameter left unpaired is realized by the body read whole (`hit: hit_event` by `req.body`). Each of these stayed `UNREALIZED_PARAM`.
  - **`UNUSED_INJECTED_PARAM` is a notice** (was a warning since round 8): `injectedParams` are code linkage, and an injection no function takes hides nothing, so finished, approved projects whose design-time `injectedParams` the code never took no longer go red in `validate --ci` after the upgrade.
  - **BREAKING (validate, route coverage):** route coverage is never silently off. New `ROUTER_UNDECLARED` (notice): a Portal binding HTTP endpoints whose implementation names no `router:` while its code is read at exact grade, naming the route-bearing functions and tables its files hold — a route table moved to another module with no `router:` switched the check off without a word. A route table may spread other tables (`[...ingestRoutes, ...statsRoutes]`, an object spread too), followed through the type checker into any module; a linkage naming a declaration that holds neither a body nor a readable table is `UNREADABLE_ROUTER` (both passed silently). One literal table named by several Portals is one router, as the module form was: a route is declared when any of them declares it — each Portal was blamed for the other's routes.
  - New `REALIZATION_UNCHECKED` (notice): an implementation whose conformance dial is off, on itself or on some of its methods, is said once, naming the methods — the dial is code linkage outside the approval, and `validate --ci` said "All checks passed" with the realization checks off. `wairon status` (and `sdd_get_status`) print a `Conformance off:` line naming them.
  - `TECH_ON_LOGIC_COMPONENT` no longer tells a Portal to move its web framework behind a data seam: a Portal is the transport seam and binds the framework that serves its endpoints. A Portal binding a technology a data-layer component of the tree binds too (`postgres` beside its Store) is still reported, saying so.
  - wairon's own tree: `admin_portal` and `host_http_portal` name their routers (`routeAdmin`, `routeData`), so their 36 endpoints are route-checked; 23 stale `conformance: off` method dials that hid nothing are gone; `cli_runner_impl` carries a reasoned `lint.allow` for `runMcpInstall`, whose handler takes commander's flags (`--hosted`, `--project`, `--token`) and maps them onto `mcp_install_options`.
- **Conformance analyzer, round-10 trials:**
  - The one record parameter of a plain node:http handler is realized by a body helper: the injected request handed as a call's first argument to any function — an imported body parser included — whose result the handler binds to a local and uses whole (`const cart = await readJsonBody(req)`, `(await readJsonBody(req)) as Cart`, `const cart: Cart = await readJsonBody<Cart>(req)`, or two steps through `body`), the node:http spelling of `req.body`. Each stayed `UNREALIZED_PARAM`, so honest handlers needed the router to parse the body into `req.body`. It stays unrealized when the result is discarded, never used, only destructured or only read for fields, when the request is not the first argument, and when the callee is a collaborator (`this.orders.place(req)`, a method of another handler parameter). `ParameterFact` gains `handedWhole`. The finding now names both ways a parameter is read off an injected request, with the method's own names.
  - **BREAKING (validate, fail-closed parameters):** a scalar parameter (a string, a number, a boolean, a date, a datetime or a duration) realized by an opaque-typed parameter (`any`, `unknown`, …) the body reads as an object — a member no such value has, `args.habitId` where the contract declares `date` — is `PARAM_TYPE_MISMATCH`. It paired silently while the record rule failed closed. One read only as the scalar it is (`date.length`, `day.getTime()`) is not. `ParameterFact` gains `members`, the member names read directly off the parameter.
  - An `UNREALIZED_PARAM` caused by `injectedParams` naming the contract's own parameter says so (`injectedParams` names "habitId", "date" — the contract's own parameter(s) … drop them). The seven findings gave no hint.
  - A Portal served by a class's method has a `router:` spelling: `Class.method` (`HabitPortal.handle`) and `<module>#Class.method`. The class is the export and must hold the method. `HabitPortal`, `handle`, `HabitPortal.handle`, `HabitPortal#handle` and `ROUTES` were each refused with a different code. A refused bare name that is a method of an exported class is told its `Class.method` spelling, one declared but not exported is told to export it, and `Class#method` is told to use a dot. `ROUTER_UNDECLARED` lists only names the linkage accepts (an exported router or table, `Class.method`, an exported entry calling into a router of its file) and names private ones apart with "export it". It suggested a module-private `ROUTES` that was then refused.
  - New `ROUTER_NOT_DISPATCHED` (notice): a router naming a route table that a sibling aggregate of its module leaves out (`router: statsRoutes` beside `routes = [...ingestRoutes]`, in the module or one importing its tables). If the server dispatches the aggregate, none of the table's routes is served, and coverage read the table as it stands and stayed green. It is a notice because which process dispatches which table is never read. `SourceFileFacts` gains `tableSpreads`.
- **What the assistant reads (skills, briefs), round-10 trials:**
  - The architect skill, `sdd-implement`, the Portal brief and cli.md say `router` names the table or function the server actually dispatches (the aggregate, not a Portal's own table spread into it), and give the `Class.method` spelling. The architect planned per-Portal tables, and a table dropped from the dispatched spread read clean.
  - The architect skill says a client Adapter verb takes its signature from the Portal verb it calls (`signatureFrom: <portal>.<verb>`, `alias::…` across projects) instead of restating the params. A producer's parameter rename reached the restated copies as nothing.
  - `sdd-implement`, the Portal brief and cli.md describe the record read whole through a body helper and the scalar `any` rule.
- **Surfaces, externals and members, round-9 trials:**
  - A consumed verb's ROUTE is part of what the consumer depends on: a moved path, verb or stated status of a used Portal verb reads `drifted` (a carried fact, `endpoint of stats-api.getStats (GET /stats/{code} → GET /v2/stats/{code})`), the use says `endpoint moved: …` in `externals status`, the advisory `EXTERNAL_DRIFTED` names the route and that a client spelling it must follow, a route REMOVED is `changed` (incompatible), and a re-pin says what moved since the last pin instead of rewriting the path without a word. `externals status` said `unchanged`, `drifted: false`.
  - A project that composes this one as a `../` sibling MEMBER is its consumer: `externals consumers`, `sdd_list_consumers` and the rename/delete dry runs read the folders enclosing the bound root (a folder of at most 256 folders; `--search` reads any) and the searched folders for a `members:` entry resolving here, and list every project of that family that uses it. All three said "no consumer" while the parent sat one folder up.
  - A verb removed from a live member reaches the consumer's binding: a member is never pinned, so the binding is compared with the member's live export AND its surface at the approval it is judged against (the one the consumer's lock records for it, else the member's own last committed approval, read from git): a bare binding export the approved design held and the live export no longer does is `BINDING_DRIFT` "was removed … (the member's approved design held it)". It was silent through every run.
  - A binding into the parent's own re-exports (the shape `member promote` writes, `shop-platform::money`) is compared with the member they re-export from — it was never compared — and the OpenAPI document resolves such a type from the project's own surface. The OpenAPI document also resolves a `../` sibling member's types (it read only contained members: three "Unresolved type" schemas), and the "no schema" warning's advice follows what the alias is — a member is never told to pin, nor a project to pin itself.
  - A live member's relation health (the canvas, the hosted Relations tab) compares it with its approved surface like an external's pin: a used verb that changed since reads incompatible, any other move drifted — it counted resolution failures only.
  - `surface diff`: a contract's local record spelled `<subsystem>.<id>` (`orders.order`) is read with its closure — its embedded member types were invisible to every digest, so a gateway's wire change through it (`order.total.currencyCode`) was missing from the changelog; an exported type reached through such a record names the verb too; a signature row renders parameters under their own names (it printed `contracts::order_id: shared::order_id`); a type swap that follows another project's rename names the renames inside it (`type "geo::tile_coord" renamed to "geo::tile"; field "geo::tile.zoom" renamed to "z"`). A pinned consumer's comparison re-reads the locked digests from the pinned snapshot, so the closure now read moves no existing pin.
  - OpenAPI: the one object body param is the bare body when it is optional or `T?` too (a `{ "reminder": … }` wrapper the server never read); a `T?` body is required and nullable, an optional one not required.
  - New `ENDPOINT_STATUS_MISMATCH` (warning): an endpoint `status` that is no standard success or redirect code (`299`), a 204/304 on a verb answering a value, or a redirect on a verb answering a record rather than the location.
- **Surfaces, externals and members, round-10 trials:**
  - The live externals gate sees a verb a consumer reaches through a contract it uses WHOLE (`use: [habit_portal]`, a bare `dependsOn` with no call named): every method the pin holds is compared, so a removed verb reads `removed`, a renamed one `renamed to habit_portal.markDone`, both `incompatible` (`externals status` exits 1, `EXTERNAL_LIVE_INCOMPATIBLE`), and a moved route names the verb — it said `unchanged · drifted: re-pin when convenient` and "nothing this project uses changed".
  - `surface diff` against a revision reads a `../` sibling member as the approval the baseline's own lock recorded for it: the baseline tree in the fetch cache holds no sibling, so its types never expanded and every verb naming one read `changed — a type it names changed shape` right after a clean re-lock. Nothing changed now reads "no change"; a member change since the approval is still named on the verb.
  - The live comparison names a field ADDED to or REMOVED from a used member's types (`field "code_stats.window" added`) beside the traced renames, and says "(and its shape changed beyond that)" only when something besides fields moved.
  - `sdd_set_endpoints` names the consumers a route move breaks, as a rename or a removal does: the public names publishing the moved verb and each consumer reaching it (`PUBLISHED as … the route of each would move`, `BREAKS 1 consumer(s)`; `published`, `breaks`, `rerouted` on the structured answer), with a new optional `search` for sibling checkouts.
  - `sdd_get_spec` with `alias::name` reads an external's pinned contract with `methods` and with no kind (it answered "No spec of any kind"), and a type the pinned contract carries without exporting it (`legacy::habit`), the marker naming what carries it.
  - `BINDING_DRIFT` into a member says "the member's" and "the member's type" for a parameter and a field, never "the pin's" or "the pinned type": a member is read live and never pinned.
- **Approval, authoring, the spec write lock and member verbs, round-10 trials:**
  - `wairon lock` on the release-stamp refresh path judges members exactly like the ordinary path: a sibling member edited and not re-locked at its own root since the record (its subject, and so the gate identity, unchanged) is no release change — the lock reports it `drifted` with the bottom-up warning and never records it `approved` (it printed "stamp refreshed — no review needed … member geo: approved" while `lock-check --strict` failed).
  - A release-stamp refresh also refreshes the code results and design counts recorded beside the approval (`lock.json#code` read the old analyzer until the next no-op lock).
  - The release re-verdict of an upgraded approval is kept across commands, in wairon's user cache (`WAIRON_CACHE_DIR`, else the OS user cache; one small file per project root, never in the tree), keyed by the root, the record and the current gate identity: every `validate`, `status` and `lock-check` no longer re-runs the whole owner's gate while the approval carries the older stamp.
  - `wairon lock --subsystem <id>` counts the subsystem's own types (a type whose `subsystem` names it) inside the scope; it called them "outside it".
  - `sdd_move_spec` of a type re-points the L0 export table: an entry publishing a project-level type (no `from`) moved into a subsystem re-exports it `from` that subsystem, whose L1 gains the type's export entry; a type made system-level is published by the L0 directly again (its entries lose `from`, its L1 entries go — previously refused). A component move also re-points an L0 or L1 entry that names it by its contract alone. No more `EXPORT_INVALID` after a move.
  - Every `sdd_move_spec` is rehearsed in a private copy of the tree, as the family migrations rehearse theirs: the report carries `files` (each written, a moved one as `old → new`), `references` (each type reference respelled, each export entry re-pointed, added or dropped) and `findings` (the design errors and warnings the result reports that the tree does not now); a dry run answers that rehearsal, and a real move that would leave a new error is refused, writing nothing.
  - A type move is placement, not an edit: every file it touches keeps its `updatedAt` and its line endings, and the folder the moved file leaves empty is pruned — moving a cluster back leaves the tree byte-identical (it left an empty `tiles/types/` and `updatedAt`-only diffs).
  - **EDGE (BLOCKER):** two CLI writers of one spec no longer both print `✔` while one change is lost. Every write into a `.wai` tree — the store's, the core's raw rewrites, CLI commands, migrations (each owner's lock is held across a family commit), `doctor --fix` and the hosted server — takes the tree's `.wai/.spec-write.lock` at the shared file helper, and a spec document that changed on disk since this process read it is refused with `spec-write-conflict` (the other write is kept, nothing is written to that file; run the command again) instead of being overwritten.
  - **EDGE:** a `.spec-write.lock` wairon cannot read (empty, foreign, truncated) is broken by the next write once it is 10 s old (it blocked every write for 30 s, said it would be broken, and never was); `wairon doctor` names a present lock, its holder, whether that holder is live or gone, and whether the next write breaks it.
  - **EDGE:** `member add` / `sdd_add_member` create a member inside the project or as a sibling checkout one level up (`../<name>`) only: `../../../toolchain` is refused, naming where it lands and the accepted forms, before anything is written (it scaffolded a `.wai` outside the family). An alias already declared otherwise is refused before anything is scaffolded. New `member add --report` prints what would be created, refused exactly as the write would be, and writes nothing.
  - `wairon init` writes `.wai/.gitignore` ignoring `.spec-write.lock` (created when absent, the line added when missing), so a lock a crashed session left behind is never committed by a team that commits `.wai/` wholesale. An init refusal in a subfolder exits 1 (pinned by a test).
  - **BLOCKER:** a write never lands in a member project through a bare id. Ids are per project: a bare id is the bound project's own, so from a family root `sdd_add_subsystem tiles` beside a member holding `tiles` creates the root's own `tiles` (it re-authored the member's subsystem in place and cleared its `publicInterfaces`), `sdd_add_component` of an id a member's Repository owns is placed in the root's own folder (the layout normalization moved it into the member's), and an update, delete, rename, move or child create naming such an id is refused as missing (or, for the component-addressed tools, with the project boundary's sentence) — the spec path builders no longer answer a bare id with a member's file by suffix or by an owner's local id. Reads still compose members under their keys; only a deprecated legacy L1 mount keeps its bare-id resolution until `doctor --fix` rewrites it.
- **Members, externals, approval and briefs, round-11 trials:**
  - `sdd_get_spec` with `kind: system` reads the L0 the id names, and only that one: `alias::system` (or `alias::<its L0 name>`, `<project-id>::<its L0 name>`) answers a MEMBER project's own L0 as stored at its root, export table included, with a read-only `memberProject` marker; with no kind it is inferred. It answered the CONSUMER's own L0 relabelled under the member's id, and the no-kind form said "No spec of any kind". A part, an external (its pin's exported names are listed), a name the member's L0 does not go by, an unknown prefix, and a bare id that is none of this L0's names (`system`, its name, the project id) are refused, naming why.
  - **BREAKING (externals status):** a used verb of a wire Portal whose endpoint moved is `changed`, so the external is `incompatible` (`wairon externals status` exits 1, `EXTERNAL_LIVE_INCOMPATIBLE`) — a client calling it over the wire spells the route. It read `unchanged … drifted`, exit 0. An InProcess library binds no route, so nothing changes for it.
  - `wairon lock` with a member that drifted at its own root (its pin unchanged) keeps the approval on record, as it says: the member's new state is refreshed beside it as evidence (`the member state(s) recorded beside their unchanged pins (geo: approved → drifted)`). It printed "its lockedAt … kept" and wrote a new `lockedAt`.
  - An approval an older release recorded, carried over because this release changed no built-in rule, is said once as a notice by `status`, `lock-check` and `validate` (`approved under wairon <old>; this release (<new>) judges the design by the same rules`). Every surface was silent.
  - A write's change report echoes a reference another project provides as it is stored (`dependsOn added: "geo::distance"`), never as the producer's internal id it binds to (`geo-sdk::distance_portal`).
  - A file only a type's METHODS name (`src/reminder_schedule.ts` beside the fields in `src/types.ts`) stays `SOURCE_FILE_PLANNED` (a notice) once the type's own file exists, as a component method's planned file does — it was `MISSING_SOURCE_FILE` (an error) mid-implementation. The type's own file missing while a methods file exists is still `MISSING_SOURCE_FILE`. The brief of the component whose narratives call those methods fences that file; it was listed as shared by every contract naming the type, and fenced by none.
  - The code write fence of every implementer brief, `sdd-implement` and `sdd-delegate` say never to delete or move a file or folder outside the fence (an ignored project folder included) and never to use an existing project folder as scratch space.
  - A requirement added through `sdd_update_spec` as `{ description }` is stored in the form its siblings take: text beside text (it was the one object in a list of strings).
  - **EDGE:** `wairon surface export --out <folder>` is refused naming a file path and how several portals are written; it failed on a raw `EISDIR`.
- **Approval wording, renames and briefs, round-11 trials (EDGE):**
  - `wairon status` with only a member's pin moved says what moved and what to do: `this project is not covered by its approval: none of its own specs changed, but member geo was re-approved at its own root since, and this approval still pins its earlier approval`, with `wairon lock` here as the fix, and the verdict reads `none of this project's own specs has changed since; what moved is a member's approval` with `Member pin moved since approval: geo was re-approved at its own root after this approval …`. It said `this project is drifted` beside `no spec has changed since`.
  - `wairon lock-check` beside a member carrying unapproved changes names what this project's own approval no longer covers — its own specs, a member's moved pin (`this approval still pins geo at an earlier approval`), what it owes, or the inputs that moved — and says it still covers the design when it does (an approval an older release took and this one carries over included). It said `This project's own approval is stale too` whenever the gate identity differed, though no own spec had moved.
  - `wairon project rename` / `sdd_rename_project` from a member's own root names each consumer outside the family it writes nothing in: a parent that declares the project as a `../` sibling member is named with its folder and alias, to re-lock there once this project is re-locked (`Outside this family: route-planner (../route-planner) declares this project as its member "geo" …`). The plan named the renamed project alone. Its closing note says what a rename does not look for — a project outside the family that declares the renamed one as an external, listed by `wairon externals consumers --search <dir>` — where it claimed such a project beside the renamed one was found.
  - `wairon type rename-field` / `sdd_rename_field` report the prose they leave alone, as the method rename does: `mentions` lists the type itself and every spec with the type in view (naming a type that carries the field, a contract naming one, or an implementation of such a contract) whose descriptions, intents or narrative steps spell the old field — dry run and real alike; the CLI prints them as `Left alone (prose still names "zoom" …)`. A spec that never has the type in view is not reported for a common field name. There was no `mentions` field.
  - Briefs and the `sdd-implement` skill name the binding tag convention: a declaration in a binding module that mirrors a producer name carries a doc comment naming it (`/** geo::<public name> */` above an interface, a class or a type; `/** geo::<public name>.<method> */` above a free function), so `validate` compares it with that export alone and names a verb the producer no longer holds; an untagged declaration nothing matches by name is the binding's own plumbing. It was documented only in `docs/cli.md`.
- **BREAKING (MCP and CLI, refusal wording):** every spec write tool words a refusal of an id it cannot write the same way. A spec another project holds — named through a member's or an external's alias, by a member's key, or by a bare id only a member holds — is `chained-spec: "<id>" lives in another project, and a project's specs are changed only from its own root.`, followed by which project and how: a member with its folder, the session to open there and the call to make there; an external as read-only here, changed by its owner from its own root. An id no project in reach holds is `spec-missing: this project has no <kind> "<id>". Nothing was written.` The renames (`sdd_rename_*`, `wairon method rename`, `method rename-param`, `type rename-field`) and moves said "lives in another project" while `sdd_update_spec`, `sdd_delete_spec`, `sdd_set_endpoints`, `sdd_set_public_interfaces`, `sdd_move_methods` and the create tools (for a parent) said the spec "does not exist" for the same id; the codes `component-missing`, `type-missing`, `chained-component` and `chained-type` are now `spec-missing` and `chained-spec`, and the rename and move tools no longer prefix their refusal with `WaironError:`. What a write may change is unchanged: a bare id is still the bound project's own.
- **Authoring tools and family migrations, round-9 trials:**
  - `sdd_move_spec` of a type follows every spelling of a reference to it: `orders::order_status` and the documented dot form `orders.order_status` alike, matched as the loader matches, wherever it stands in a type expression (`list<…>`, `…?`, `map<…>`, `result<…>`, a union, a returns, a field, a foreign key's `.field`). The dot form was left dangling (`rewritten: []`, then `UNDEFINED_TYPE_REFERENCE`). Moved to system level, the qualifier goes with its separator.
  - `sdd_move_spec` moves a connected cluster: the new optional `together` (a list of ids of the same kind) moves them in ONE call, planned by one dry run, the components judged together in their new subsystem, all written or none. A single move the gate refuses now names its collaborators left behind as the `together` list that takes them along. Input-schema addition.
  - `member internalize` de-aliases every type position through the same rewriter: `list<shared::x>`, `shared::x?` and a returns kept the alias of the project it deleted (28 `EXTERNAL_UNDECLARED` that `doctor --fix` could not clear).
  - `member rename-alias` on a trait implementer (`implements: geo::point` beside `signatureFrom: geo::point.<method>`) refused its own plan ("not at its position any more"): a contract's `implements` was no position the reference writer read. It now plans and applies, every occurrence respelled.
  - **BREAKING (`sdd_update_spec`):** a reference is compared by its written text. A delta naming a reference the stored spec holds in another spelling of the same target (`geo::distance` for `geo::distance_portal`) is a change — reported with both texts and written — where it was "No change … matches what is stored", so the spelling the gate asks for could not be written. A no-change answer to a `methods` (or `fields`) list that left stored elements out says that lists upsert and how to remove one (`{"name": …, "action": "delete"}`).
  - **BREAKING (`sdd_update_spec`, code linkage):** an implementation's `injectedParams` and `bindings` restated REPLACE what is stored instead of merging (`[_ctx, req, res]` + `[ctx, req, res]` stored `[_ctx, req, res, ctx]`). Both state the code's reality whole — the realization's leading parameters in order, its binding modules — and an entry left over from an earlier statement is itself a finding (`UNUSED_INJECTED_PARAM`, `BINDING_UNREAD`). A `{ value, action: "delete" }` marker still removes one value. Every other plain-value list keeps merging.
  - **BREAKING (`sdd_get_spec`):** an `alias::name` id resolves through the alias table the way a write resolves it — a member's spec reads under its key (`ext::cadence` answered "does not exist"), and an EXTERNAL's spec reads from the pinned snapshot this project holds of it: the pinned contract entry or exported type as `spec`, with a read-only `pinnedSnapshot` marker beside it (alias, producer, snapshot file, StateId). Output-schema addition.
  - **BREAKING (`sdd_initialize_system`):** refused, writing nothing, when the session was opened in a folder that is not the bound project's root (it bound upward) and that project already has an L0 — it re-authored the PARENT's name, vision, boundaries, requirements and `targetLanguage` (95 `NAMING_CONVENTION_VIOLATION`). The refusal names the root and the next step `wairon init` names: `wairon member add <alias> <path> --project` from the root. Re-initializing from the project's own root needs no flag: it is the documented way to re-author the L0, it already announces what it replaces and clears, `lock-check` catches it, and `sdd_update_spec` edits the L0 field by field.
  - **BREAKING (`sdd_rename_method`):** an implementation that names no symbol is pinned to the old name only when its code exists — the file realizing the method is on disk. With no code written it pinned the old name for code that would be written under the new one. `pinSymbol: true` always pins; `false` never does.
  - **Security (EDGE):** a path-shaped name never writes outside the tree. `sdd_add_component { subsystem: "../../../dashboard/.wai/specs/dashboard" }` answered "Successfully added" and wrote into another project; `links/../analytics`, `links/` and `Links` were accepted because existence was checked by path, case-insensitively on Windows. Every id a path is built from — a spec's own id, the subsystem, component or contract it is written under, a type's group — must be an id first (letters, digits, `-` and `_` per `::`-segment; `not-an-id` otherwise), checked before any path exists, and a spec found at a path is that spec only under exactly the id asked for.
  - **EDGE:** two sessions writing one spec at the same moment no longer lose one write while both answer "Updated". Every spec-write MCP tool runs under the tree's cross-process write lock (`.wai/.spec-write.lock`, created exclusively — atomic on Windows too — reentrant, a lock whose holder is gone broken at once) and re-reads the tree before it writes.
  - Refusal wording: the rename tools give the project boundary's refusal for a member's or an external's spec named through its alias (they said `component-missing`), and name a member project by its id, as every other write tool does; `sdd_set_endpoints` and `sdd_set_public_interfaces` name themselves in a boundary refusal instead of `sdd_update_spec`.
  - `sdd_attach_member` of an alias already attached says so instead of answering an empty plan; `sdd_add_member` says when it created a new folder OUTSIDE the project.
- **Ids Windows cannot store are refused on every platform.** A spec id (component,
  subsystem, type, …) may no longer be a name Windows reserves for a device —
  `con`, `prn`, `aux`, `nul`, `com0`–`com9`, `lpt0`–`lpt9` — nor longer than 64
  characters: such an id became a folder no Windows checkout can hold, and
  `git add -A` failed for the whole repository (a 270-character id died on a raw
  `ENOENT`). The MCP tools and the CLI refuse it with the reason and write
  nothing; `validate` reports one already in a tree as `SCHEMA_VALIDATION_ERROR`,
  now worded `path: message` instead of a JSON dump. An external alias, which
  names its pin file, refuses the same device names.
- **A `project.yaml` that does not parse stops every command alike.** A duplicated
  key (a second `rules:` block appended by hand) crashed `validate` and
  `network declare` with a Node stack trace, while `lock-check` and `status`
  carried on as if the file were fine. Every command now refuses with one line
  naming the file, the line and the key — `✖ .wai/project.yaml:33: duplicated
  mapping key "rules"` — and exits 1; `doctor` diagnoses it in the same words.
- **No stack traces for bad input.** Whatever a command throws is printed as one
  `✖` line with exit 1 (`surface export --portal <unknown>`, `surface diff`
  without a committed approval, …); `WAIRON_DEBUG=1` prints the stack for a bug
  report. `project rename` to a malformed id is refused as `id-invalid` (it said
  `id-collision`), and `member rename-alias` to a malformed alias as
  `alias-invalid` (it said `alias-taken`).
- **OpenAPI path parameters.** `surface export --format openapi` declared every
  parameter of `GET /stats/{code}` `in: query` — an invalid document, and a
  generated client sent `?code=`. A param named by a `{name}` segment of the path
  is now `in: path`, required; the others stay in the query (GET, DELETE) or the
  JSON body (POST, PUT, PATCH).
- **`TECH_LEAKAGE` reads no binding into prose.** Binding `redis` on one Store
  made another Store's description ("in memory now, Redis later") a leak, on its
  component, contract and implementation. The prose of a data-layer seam (Adapter,
  Store, Registry, Index) names a technology about its own realization and is no
  longer leakage; its identifiers, and every surface of a logic component, still
  are.
- **Docs.** `wairon surface diff`, `externals consumers --search`, the dev
  server's MCP endpoint (`POST /mcp?project=local`), what to commit, the analysis
  grades and how a refusal is printed are documented. The CI recipe pins "the
  version you lock with" instead of a fixed dev or release version, and README
  links the design docs and `CONTRIBUTING.md` relatively — the package now ships
  them — so no link 404s before `main` has the file.
- **Approval messages agree.** `lock` no longer says "Nothing has changed" when
  only an input moved (the project id, a network, a pinned external): it names
  what did. A storage move is no change for `lock`, as it already was for
  `lock-check`. `lock` says when it approves an all-draft design, and
  `validate --ci` prints how many draft-related warnings it waived.
- **Nothing to approve on an empty tree.** `lock` on a tree that holds only the
  L0 writes no lock and says to add a subsystem first (exit 0); `lock-check` and
  `status` say the same.
- **`lock-check` agrees with `lock` on the project id.** A hand-edited id
  (`PROJECT_ID_CHANGED`) now fails `lock-check`, with or without `--strict`, and
  names the fix: restore the id, or use `wairon project rename`. A rename not yet
  re-locked fails it too.
- **`lock-check` names what moved** in the same words as `lock` (for example the
  network declaration), not a generic list.
- **`status` and `lock-check` agree on unknown keys.** A key the spec schema does
  not read, such as a top-level `symbol:` on an implementation, no longer shows
  as a changed spec in `status`. It is reported as `UNKNOWN_SPEC_KEY`, with a hint
  to put `symbol` on the method.
- **Long cache paths on Windows.** wairon's git calls for its fetch cache use
  `core.longpaths`, so `surface diff` and git producer fetches work under a deeply
  nested cache directory.
- **Networks.** `network declare` keeps the description. `GATEWAY_BYPASSED` is
  reported once per Portal. `MULTIPLE_GATEWAYS` has one severity and anchor in the
  project and the family run. `ENDPOINT_TRANSPORT_MISMATCH` stays an error on
  drafts.
- **Docs.** The documented tool count matches the server, shipped docs link only
  to shipped files, and the docs explain which version of the reusable workflow
  to pin on a dev build. `pack init` accepts `-y`.
- **`externals status`** explains only the words it printed.

- **Wording.** Plain `validate` ends with "Passed with N warning(s)" when it printed
  warnings, and says there is nothing to check on an empty tree. `status` marks a
  file not written yet as planned, and its percentages read files the same way the
  lines do. `INVOKED_BY_UNDESCRIBED` states its threshold. `lock` prints the code
  line once. `sdd_get_status` with no project says that no project binds the
  folder.
- **CLI.** `-y` is accepted wherever `--yes` is. `init` takes the project name from
  `package.json` (or `Cargo.toml`) when there is one.
- **Reachability.** No Portal is exempt from the unused findings by a field the
  authoring tool wrote for it. A library no longer needs invented `Custom`
  endpoint addresses to satisfy `MISSING_ENDPOINT`, and a library's consumers no
  longer need a client Adapter per library. An exported extension point is no longer
  refused as unconsumable. A type the project exports at L0 counts as used, and in
  the family run so do its consumers' uses. An export's kind is no longer guessed
  from its description prose.
- **Rename tools and casing.** The rename tools accepted only camelCase method names
  even in a tree whose define tools wrote snake_case; they now follow the project's
  method casing.
- **Lazy loads in the code analysis.** A call through a destructured
  `require('…')` or `await import('…')` binding (`const { f } = require('./m')`)
  resolves to the module it loads, as a static named import does, so the call it
  realizes is no longer reported unrealized. A name two lazy loads bind differently,
  or that a static import or a local function also binds, stays unresolved.
- **Hosted member upgrade.** The member upgrade's plan, apply and drop are one
  workflow of the member registration again, so the local admin entry point only
  forwards to it.

- **External sources.** A `project.yaml` external's `source` is read in either
  form: the location string (`../x`, `hosted:<id>`, `<git url>`,
  `<git url>#<commit>`) or the object. `source: { git, commit }` and a malformed
  `url#commit` are that external's problem, named with the forms that work. They
  no longer produce a raw schema dump or hide the other externals from
  `externals list`. A `<git url>#<full commit>` external uses that commit directly
  instead of failing `ls-remote`.
- **Approval drift without a design change.** `updatedAt` is no longer part of a
  spec's approved digest, so a no-op re-save or a change and its revert no longer
  drifts the lock.
- **Delta merges.**
  - Every array merges by identity at every depth (it used to replace whole lists
    such as `trustedLinks`, `invariants`, `lint.allow`, `params` and `catches`).
  - A field a delta leaves out keeps its value, `unset` works at every level, and
    `[]` clears a narrative.
  - A step whose `type` changes is rebuilt for the new type.
  - A label can retarget a jump that already has a number.
  - Deleting a step is refused when it addresses nothing, its restatement does not
    match, or it would leave a region body without its header.
  - Malformed step markers are refused.
- **Re-authoring** with a create tool carries what the tool cannot express
  (`lint.allow`, `ext`, `auth`, …) and names what it removed. It no longer reopens a
  complete subsystem as draft.
- **No-op writes.** A write that changes nothing writes nothing and says so. A real
  change is reported field by field, and narrative changes step by step.
- **Write targets.** `sdd_move_methods` into a component without a contract creates
  it. An unknown owning subsystem is refused.
- **Stale locks.** A stale lock no longer reports as locked; `status` and `doctor`
  name the staleness and its remedy.
- **Hosted.**
  - The legacy validate view no longer reports every tree as clean.
  - The organizations page no longer crashes on units saved before slugs existed.
  - An unmigrated data dir is announced at startup.
  - Read-only topology tools need read access, not write.
  - A unit removal refuses a missing or unknown disposition.
  - `pack remove` takes the name the listing shows.
  - A producer-run failure answers its own HTTP status instead of 500.
- **Hosted CLI.**
  - `wairon host unit`, `host key` and `host permission` behave as the hosted
    quick start documents them.
  - `host unit create` without `--parent` creates a `business_entity`, the only
    kind a top-level unit can be (it defaulted to `team`). Under a parent the
    default stays `team`.
  - `host key mint` refuses a project that no hosted record holds, and mints
    nothing.
  - Granting `project:write` to a user who cannot read that scope, or minting a
    token for an owner who cannot read its project, warns and names the
    `project:read` grant that fixes it.
- **`wairon dev`.**
  - A stale or expired session no longer strands it on a sign-in screen.
  - It places its project at startup, so it no longer warns that a
    permission-model migration is pending.
- **`wairon update`.** The stable channel no longer installs dev builds.
- **`wairon init`.**
  - It keeps an existing configuration.
  - It writes no agent file.
  - For an Antigravity (`agy`) target it no longer writes a project
    `.gemini/settings.json`, which Antigravity ignores. It prints the command that
    registers the server machine-wide instead.
  - It refuses clearly without a terminal (use `-y`).
  - Provisioning and externalizing never overwrite an existing `project.yaml`.
  - It never edits a parent project's `project.yaml` without asking.
- **Promoted projects.** A project made by `member promote` or
  `subsystem externalize --as project` is set up like one made by `init`.
- **MCP registration.** A project-scoped registration (`.mcp.json`,
  `.gemini/settings.json`), written by `init`, `mcp install` or `doctor --fix`, holds
  nothing machine-specific. It runs `wairon mcp serve` from the PATH (or the CLI by a
  project-relative path when the CLI is installed inside the project) and pins no
  project directory. `doctor --fix` rewrites an older entry that named absolute
  paths. A `--global` registration is machine-wide and still names the CLI by its
  absolute path.
- **`wairon doctor`.** On a machine without Antigravity it reports nothing to
  register, instead of a missing registration.
- **`wairon generate`.**
  - It keeps the derived context documents current.
  - It prints what it reconciled.
  - It refuses an unknown `--target`.
- **Line endings.** Every `.wai` writer keeps a file's line endings.
- **`validate --ci`.** It waives `DRAFT_SUBSYSTEM_WARNING` like
  `DRAFT_COMPONENT_WARNING`.
- **Rule false positives fixed.**
  - `MEANINGLESS_BRANCH` reads fall-through from the step graph.
  - `INESCAPABLE_CYCLE` accepts an exit off the end.
  - `UNREALIZED_CLAIM` ignores quoted text.
  - `UNUSED_TYPE` counts type-method signatures.
  - `GOD_COMPONENT` and `EXCESSIVE_DEPENDENCIES` exempt a pure forwarder and read
    the effective `maxComponentDependencies`.
  - Several rules report once instead of twice.
  - `UNUSED_METHOD` and `ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT` land on the
    interface that declares the method.
- **Analysis.**
  - The pattern-grade analyzer no longer drops a second file's declarations.
  - Aliased and named re-exports, local workspace packages and own-class calls are
    followed.
  - A technology can declare the tokens it is matched by
    (`{ name, matches }`).
  - A forwarding method that shares its target's name is no longer assumed to
    realize the call: identity is judged on the function body, so a handler that
    bypasses its orchestrator is reported (`CALL_STEP_UNREALIZED`).
  - A collaborator typed through `Pick`, `Omit`, `Partial`, `Required` or
    `Readonly`, through one type alias, or as a property of an object of
    collaborators is followed to its module.
  - An `import type` realizes a dependency edge, and a pattern's own files may
    import its members.
  - A component with no code yet gets no simulation finding.
  - Findings use shorter messages.
- **Migrations.**
  - Self-qualified invariant references are migrated.
  - `EXPORT_INVALID` names a duplicate export id.
  - `lock` says when it replaces an older approval.
  - A family migration no longer writes `materializeAgentFiles: false` into a
    `project.yaml` that never set it. The migration rehearses in a copy that has no
    agent files, so the default was recorded and the next lock deleted the
    committed agent files.
  - `member promote` and `subsystem externalize --as project` respell every
    reference across the new boundary: dotted type tokens at every type position
    (fields, params, returns, type-method signatures), `signatureFrom` and asserted
    invariants. They drop `consumers` entries that name a subsystem across the
    boundary, write type re-exports with `from:`, and take intact pins of other
    family projects again. The plan is the rehearsal the apply commits, so it lists
    exactly what is written.
  - `member rename-alias` also respells type-method signatures and returns.
  - `member demote` writes an `alias::<type>` token of a type expression or an
    asserted invariant back as a local reference. A `consumers` list that still
    restricts a surface gets back each subsystem across the old boundary that
    depends on it, so a promote followed by a demote no longer leaves
    `CROSS_SUBSYSTEM_UNLISTED_CONSUMER` behind. A list the promote removed whole
    is not recreated: absent means any subsystem may depend, and the promote's plan
    named the removal.
  - `subsystem externalize` moves every spec file the subsystem owns, whatever the
    layout. In the flat layout (`subsystems/`, `types/`, …) it used to declare the
    part and move nothing. In the nested layout a type of the subsystem kept in the
    shared `types/` folder was left behind.
- **Packs.** `pack bundle` of a pack installed as a single file by an older
  `packs add --global` writes a pack directory that resolves without the store. It
  used to write the file where the directory belongs, so a clone and CI still
  reported `PACK_NOT_INSTALLED`. Such a bundle no longer reports `PACK_STORE_DRIFT`
  against the file it came from.
- **Messages and tools.**
  - `sdd_get_spec` infers the kind from a unique id, and refuses an id that names
    specs of several kinds.
  - `sdd_set_endpoints` refuses a transport the Portal's `transport` does not imply,
    and an endpoint on an `InProcess` Portal, which needs none.
  - A family migration's re-lock list names the project it ran in as
    `this project (.)`, where it printed a bare `.` that read as an empty list.
  - `lock-check` on a stale lock says what moved: how many of the project's own spec
    files changed, and which direct member's approval moved, was added or was
    removed.
  - The design export's `source.stateId` and the lock record's `stateId` are
    different digests by design. `docs/design-export.md` now says so: `stateId` is
    the content id to cache on, and `source.approval` relates an export to its
    approval.
  - `wairon export` at a project with member projects names them. Members are
    listed under `dependencies` and never inlined, so the top of a family that holds
    no design of its own exports no components. That export no longer reads as
    empty without a reason.
  - The design-export schema declares its `$schema` and no longer carries an `$id`
    that did not resolve.
- **Packages.** The library entry ships TypeScript declarations, and the npm package
  and release binaries ship the web app (the build fails without it).
  The npm package also ships the documentation. Generated skills, guides and
  `.mcp.json` keep their line endings.
- **Agent briefs.** A brief states which files the agent may write, and a brief
  can be asked for by component id.
- **Generated guidance.** The guide and the `sdd-architect`, `sdd-implement` and
  `sdd-delegate` skills describe the reachability model: how to declare entries and
  networks, that an entry is never invented to quiet a finding, that libraries are
  called directly, how to name transports, and that method names follow the
  language's casing while wire names live on endpoints.
- **`wairon status`.** Progress is measured per component: 80% once its
  component, contract and implementation specs are written, and 100% once its
  implementation names source files that exist. It is capped at 50% while any of
  them is a draft. `--all` lists every spec that moved since the approval.
- **Wording.** `status`, `doctor` and the externals commands word their output
  more clearly.

### Security

- **Hosted approval decisions are read strictly:** a decision request whose body lacks the accepted
  fields, or carries a value of the wrong kind, was recorded as a denial. It is now refused with a
  message naming the accepted fields, and the request stays pending (`docs/cli.md`, hosted section).

Hosted deployments of v5.1.0 should upgrade. This release hardens:

- the confinement of credentials narrowed to a member;
- write authorization for members and subsystems inside a hosted request;
- CSRF protection on web writes (approval decisions, project configuration);
- the sign-in redirect allowlist on every sign-in entry point;
- session handling on the local dev server;
- how integration secrets reach the Git and producer integrations;
- the local operator's administrative writes;
- approval of a hosted design, which now requires the approval capability on every
  surface.

### Release process

Every release now passes a QA gate before dev is merged into main: a fixed panel of four
persona seats plus free automated checks, recorded in a short verdict that CI checks on pull
requests into main (`docs/release-qa.md`). The upgrade from v5.1.0 is also replayed on every pull
request by an end-to-end test against a project v5.1.0 itself wrote and locked.

## v5.1.0 (from v5.0.1)

### Hosted profile application: a selected profile now actually governs (new, `feat/profile-apply-into-spec`)

Picking an architectural profile for a hosted project used to record a name.
If the profile came from an extension pack that was not installed **in that
project**, it resolved to nothing: `UNKNOWN_PROFILE`, doctrine family silently
`neutral`, and the profile's whole `rules` block (designDepth, rule severities,
naming, complexity) never applied. A project's own pack profiles were also
invisible to the picker, and any later pack write erased the recorded selection.

- **Project-scoped profile catalog** — `GET /web/projects/profiles` lists
  built-ins ∪ the profiles contributed by that project's **own** registered
  packs (`installed`) ∪ those from the server-global tiers (adoptable), each
  source-tagged. The instance-wide `/web/admin/profiles` catalog is unchanged
  but cannot see a project's own packs, which is why the picker switched.
- **Writing a profile makes it resolve** — `setProjectType` ensures the profile
  is resolvable *before* writing: a built-in or project kind passes through, a
  profile contributed only by a server-global pack has that pack **vendored
  into the project** (reported as `adoptedPackName`), and an id no tier carries
  is **refused** rather than written as a name nothing enforces. The applied id
  is folded to the front of the recorded `profileSelection`.
- **Initialization applies the selection** — a project created under a policy
  that requires a profile comes up governed by it (first resolvable id;
  remaining ids are reported as an unapplied remainder, since a project has
  exactly one governing profile). An unresolvable selection leaves the default
  and is audited, never failing project creation.
- **Honest reporting** — `getProjectConfig` returns `profileSource`,
  `profileResolvable`, the unapplied remainder, and the subsystems whose own
  `profile` overrides the project-level one; `evaluateProjectPolicy` reports
  `governingProfileId` + `unappliedProfileIds`. The web UI surfaces an
  unresolvable recorded project type instead of leaving it silent.
- **Reconciliation repairs, and converges** — `reconcileProjectPolicy` repairs
  the governing profile only when it is broken or policy-noncompliant (a
  deliberate, resolvable, compliant choice survives), and folds the repair into
  the recorded selection so compliance is satisfied in **one** pass. Without
  that fold it reported the required profile as "not selected" forever.
- **Fixes silent data loss** — `profileSelection` is now modeled in
  `ProjectConfigSchema`; previously any `saveProjectConfig` round trip (a pack
  install, adopt, or removal) stripped the unmodeled key.
- New `ihost_core_adapter.builtinProjectKinds`, with `PROJECT_KINDS` exported
  once from the core rules registry so the profiles rule and the hosted apply
  path cannot disagree about which composite kinds are legal `projectType`s.

**Validation rail (web UI)**: scoped to the focused spec by default — a
component scopes to its whole unit (component + interface + implementation) —
with an honest `N on this component · M elsewhere` count and a show-all toggle.
Each finding carries a clickable chip naming the affected spec, and issues whose
code maps to a concrete field (description, componentType, durability, profile,
publicInterfaces) scroll to and highlight it.

*Known gap*: a **subsystem**-level `profile` chosen from a not-yet-installed
pack still resolves to nothing (no adopt step on that path) — the project-level
write is the one that adopts. Tracked as the next step, together with the
subproject-vs-internal-subsystem inheritance model (a subproject is its own
project and may carry its own `projectType`; internal subsystems inherit).

### Subproject-scoped credentials are actually scoped (new, `feat/subproject-confinement`)

A hosted token can be narrowed to a chained subproject (`projectId::subsystemId`),
and the data plane binds the CHILD root for ordinary `sdd_*` tools. Eleven tools
bypassed that: they act on the hosted project RECORD with the TOP project id, so a
credential scoped to one subproject could act across the WHOLE parent. Not
privilege escalation (a narrowing never widens grants) but a confinement failure,
with no workaround but avoiding narrowed tokens.

- **Record-level tools are refused** on a subproject-qualified binding —
  `sdd_host_initialize_project`, `sdd_host_get_approval_status`,
  `sdd_host_await_approval`, and the six project-ops tools (pack list/install,
  policy evaluate/reconcile, produce, commit). The refusal is an `isError` tool
  result naming the tool and the bound qualifier (HTTP stays 200), raised BEFORE
  the lifecycle dispatch and BEFORE the permission gate, and audited through the
  same path as any other outcome.
- **`lock` / `promote` are confined rather than refused**: the qualifier is
  forwarded and binds the child's tree through the containment-guarded mount
  resolution, so a narrowed agent can freeze exactly its own subtree. An
  unresolvable qualifier fails loudly — it never falls back to the parent, which
  was the defect.
- **The approval path is confined too.** Approval is the one path where the
  requester does not perform the action, so the qualifier is recorded on the
  `ApprovalRequest` via the existing `payload`/`payloadType` fields (the mechanism
  `project:init` already uses), named in the summary so an approver sees the real
  scope, and forwarded by both the auto-execute and the retry path. A malformed
  scope payload refuses rather than widening to the whole project.
- A subproject-scoped lock performs **no git sync and no publish**: the git binding
  is read from the bound root, so a child tree carries none. Note the frozen child
  tree is not staged by the project's own `.wai/`-scoped commit either — a chained
  child lives outside that pathspec — so reaching a remote takes a commit whose
  scope covers the child's path.

### Sibling surfaces include Gateway- and Observer-published subsystems (fix)

A chained child receives each sibling subsystem's published surface, but the
projection only accepted a `Portal`. A subsystem published through a `Gateway` was
legitimately published in-project yet absent from every child, leaving the child's
cross-tree references permanently unverifiable with no user workaround. The
projection now accepts what the boundary rules already sanction as a cross-boundary
target — `Portal`, `Gateway`, or an `Observer` for an event surface. A published
entry whose backing component can never serve a cross-boundary caller (a `Custom`
entry over a Specialist, say) is omitted and reported as a diagnostic when the
surfaces are generated; unbound entries and ones naming a missing component stay
silent, because the validator already raises those as errors.

## v5.0.1 (from v5.0.0)

Undocumented at the time; recorded here from the release range.

### ZIP (`.wpack`) extension packs + `@wairon/sdk` (new)

A portable, versioned `.wpack` archive became the pack unit across the CLI, the
webapp, and the hosted API, with a companion `@wairon/sdk` authoring library
(`wairon pack init|build|add|list|remove`; `packs` kept as a deprecated alias). A
`.wpack` is a directory pack plus a root `wairon-pack.yaml` envelope, extracted at
INSTALL time into `.wai/packs/<name>/` — a directory pack the loader already reads,
so the runtime load path is unchanged. The extractor enforces zip-slip
normalization and caps on entries, uncompressed size, per-entry size, compression
ratio and depth (stricter on hosted, which also keeps a max-body cap). Hosted
install stays declarative-only; code packs remain a filesystem/image concern.

### Distribution: scoped packages, tag-sourced releases, provenance

`@wairon/cli` (renamed from the unscoped package) and `@wairon/sdk` publish in
lockstep from a version tag with npm provenance; every `dev` push auto-tags
`-dev.N` and publishes to the `dev` dist-tag. Windows binaries are
Authenticode-signed behind a gate. The root build became self-sufficient (it builds
the `sdk/` workspace first), and the workspace package is bundled rather than left
as a runtime dependency — an unpublished workspace sibling must be bundled or the
shipped image cannot resolve it.

## v5.0.0 (from v4.3.0)

Accumulated capabilities since v4.0.0 around extension packs, the hosted server,
chained subprojects, agent-topology scale, the RBAC permission model, and the
Level-3 semantic-conformance program. Interim tags v4.1.0–v4.3.0 were cut from
earlier dev merges, so some bullets shipped in those. The RBAC permission model
changed hosted authorization behavior and the stereotype matrix gained newly
enforced edges, which is what made this a major.

### Level-3 semantic conformance + model-review program (new, `feat/level3-conformance`)

The validator moves from structural/topological checking toward semantic and
behavioral checking, plus the configurability and doctrine fixes from an
independent model review. All new checks default to **warnings** (lint.allow-
suppressible) unless noted; existing clean trees stay clean unless listed under
*migration* below.

**New rule codes** (see `wairon rules list` for the full descriptions):

- Detail sufficiency: `UNNARRATED_COMPLEXITY` (realized cyclomatic complexity —
  exact AST grade only — over `rules.complexity.maxUnnarratedComplexity`,
  default 8, while the method sits below `detail: full` with no narrative),
  `DETAIL_BELOW_STEREOTYPE` (explicit dial below a logic stereotype's full floor).
- Invariant registry: entities declare `invariants:` (anchored via
  `componentClass`); narrative steps assert them via `assertsInvariants` —
  `UNASSERTED_INVARIANT`, `INVARIANT_UNANCHORED` (warnings),
  `UNKNOWN_INVARIANT_REF`, `DUPLICATE_INVARIANT_ID` (errors). Declarations
  checked; enforcement never proven.
- L5 antipatterns (provable-only): `INESCAPABLE_CYCLE` (step cycle with no exit
  and no terminator), `MEANINGLESS_BRANCH`, `UNCONDITIONAL_CALL_CYCLE`
  (cross-component call cycle unavoidable on every path).
- Code↔spec Level 3 opener: `CALL_STEP_UNREALIZED` — every narrative `call`
  step must appear among the realized function's callees (set membership,
  same-file helper closure, symbol overrides + N:1 identity forwarding
  honored; exact grade only; aggregated one finding per method).
- Store/Registry doctrine: `UNOWNED_STORE` (two sanctioned shapes: Repository
  recommended, deliberate standalone Store via lint.allow),
  `REGISTRY_WITHOUT_STORE` (a storeless standalone Registry is mistyped or
  orphaned), `ARCHITECTURE_VIOLATION_REGISTRY_DEP` (Registry outbound: its
  Store or a backend Adapter only), `HIDDEN_STATE` (module-scope mutable
  bindings in files realizing only logic stereotypes), `MISSING_DURABILITY`
  (every Store declares its durability), `PORTAL_WRITE_SHORTCUT` (error — a
  Portal narrative calling a write-effect facade method).
- Event topology: components declare `emits:` / `subscribesTo:`; paired with
  MessageBus endpoint directions — `UNCONSUMED_TOPIC`, `UNSOURCED_SUBSCRIPTION`
  (silent on trees with no event edges).
- Guarantee vocabulary: `UNKNOWN_GUARANTEE` — a guarantee token on an L3 method
  or a narrative `assertsGuarantees` that is neither builtin
  (`idempotent | atomic | transactional | exactly-once`) nor declared by a
  loaded pack. The token consistency checks match literally, so an undeclared
  token silently escapes them.
- Facade rule now enforced: `FACADE_FORWARDING` — a Repository/Gateway facade
  method with an authored narrative that is not exactly one `call` step to an
  owned member (the standard §7 claim, previously "mechanically enforceable"
  but unimplemented; dogfooded at zero cost — wairon's own 63 narrated facade
  methods all conform).
- **Static integration gate** (docs/design/integration-conformance.md §4,
  implemented): L4 `simPath` names the committed integration harness (N:1
  sharing like `sourcePath`). `SIM_FILE_MISSING` (no such file / escapes
  root), `UNWIRED_INTEGRATION_SIM` (the harness's exact-grade import graph,
  closed over the analyzed modules, does not reach the component's own
  module + each direct dependency's — any module of the target subsystem for
  cross-subsystem edges; technology-boundary fakes sanctioned), and
  `MISSING_INTEGRATION_SIM` — which activates **per subsystem** once its
  first `simPath` is declared (adoption made mechanical; un-adopted trees
  see nothing). Wiring is proven statically; execution stays CI's job.
  wairon's own sdd_validator subsystem adopts first: all 7 non-leaf
  implementations declare `tests/core/validation.test.ts`, which wires the
  real registry/store/adapters.
- **Sim path coverage** (`SIM_PATH_UNCOVERED`, §4.5): a harness may claim
  coverage with string anchors — `"sim:<component>.<method>"` (happy path)
  and `"sim:<component>.<method>:<label>"` (the error path of the `throw`
  step carrying that narrative label). Opt-in per component (its first
  `sim:` anchor activates the expectation); unlabeled throw steps are never
  expected — the step label IS the path's renumber-proof identity. Anchors
  prove paths are NAMED; execution and assertion quality stay CI's job.

**New config & schema surface:**

- `rules.designDepth: components | interfaces | implementations | narratives`
  (default `narratives`) + per-subsystem `designDepth` override + pack-profile
  default — expectation checks below the declared depth are gated; soundness
  of authored content always applies.
- Pack profiles (`ProfileDef.rules`) can now carry `sddRuleSeverity` (applies
  to their subsystems; explicit project config wins) alongside the existing
  documentation/complexity/naming and the new designDepth.
- **Profile edge-deltas**: `ProfileDef.allowedEdges` — `{from[], to[],
  reason}` entries LICENSE intra-subsystem `dependsOn` edges the builtin
  stereotype matrix refuses, for components governed by the profile (the
  review's "game-ecs would error on its own idiom" fixed: an ECS pack
  licenses `Specialist → Store`). Cross-subsystem boundary rules and pattern
  containment are never relaxable; the DENY half is a `forbid-edge`
  declarative assertion. Together these complete the profile-scoped matrix
  mechanism (severity deltas + allow deltas + deny assertions).
- `durability` grows to `durable | read-through | ram-projection | cache`
  (only `durable` requires the hydration round-trip).
- Lifecycle entrypoint `phase` grows to `init | shutdown | cyclic | interrupt |
  scheduled` — all root the reachability walker; only `init` feeds hydration.
- `ext:` — an opaque, verbatim-preserved extension-data map on every spec kind
  and on L3/L4 methods, for pack rules to read.
- **Declarative rule assertions** (docs/design/declarative-rule-dsl.md): a
  declarative pack may carry `assertions:` — instances of three closed kinds
  (`forbid-edge` selector-matched dependency/ownership bans, `require-field`
  over top-level and `ext.*` fields with optional closed value sets,
  `endpoint-shape` transport allowlists + address patterns) with pack-local
  codes surfaced namespaced (`<PACK>_<CODE>`), declared severities, and the
  doctrine reason quoted in every finding. Packs add rule INSTANCES, never
  rule logic — the hosted (declarative-only) pack path finally carries real
  doctrine; an unknown kind fails the pack load loudly. Assertion codes join
  `knownIssueCodes`, so lint.allow and `sddRuleSeverity` treat them exactly
  like builtins.
- **Pack-declarable guarantee tokens**: the guarantee schema is now open
  (`z.string()`); a pack manifest may declare `guarantees: [compensating, …]`
  to extend the vocabulary. The narrative↔contract consistency check
  (`NARRATIVE_SEMANTIC_UNBACKED`) applies to pack tokens exactly as to
  builtins; the MCP `guarantees`/`assertsGuarantees` inputs accept any
  declared token.
- **Symbolic step labels**: a narrative step may declare a `label` anchor, and
  every jump-by-number flow field has a `*Label` twin (`toLabel`,
  `onTrueLabel`, `onFalseLabel`, `defaultLabel`, `endLabel`, `finallyLabel`,
  plus `label` in `cases`/`catches`/`branches` entries) resolved to step
  numbers at write time — the stored spec keeps plain numbers. Guards LLM
  step-counting off-by-ones: an unknown/duplicate label REJECTS the write,
  and an `sdd_update_spec` delta can reference labels anchored on
  pre-existing steps (resolution runs post-merge, against the final
  numbering).
- **`parallel` fan-out/join step + `detach` call flag** (flow algebra
  extension sanctioned by the technology-boundaries design record §4; the
  model review's GPU/robotics/backend convergence). A `parallel` header owns
  body `next..endStep`, covered by ≥2 contiguous ordered arms
  (`branches: [{step}]`); the join is implicit after `endStep` once ALL arms
  complete — `stepGraph()` routes an arm's last step to the join, never into
  its neighbor (nesting handled). `detach: true` on a call/dispatch step is
  fire-and-forget. Soundness lives in the narrative-flow rule (arm coverage,
  ordering, region overlap, dangling entries); `updateSpec` relocates
  `branches[].step` on insert/delete and refuses to delete an arm entry
  target; language/platform packs gate both via `unsupportedFlow`
  (`parallel:`, `detach:`).
  `UNCONDITIONAL_CALL_CYCLE` treats arms as alternatives for now
  (under-reports across parallel regions — conservative direction).
- **Parallel/detach rendering across the diagram surfaces.** The canvas flow
  modal renders a `parallel` header as a fan-out BAR spanning one lane per
  arm, with the implicit join bar after `endStep` (all arms complete before
  flow continues) — an arm's last step wires into the join, never into its
  neighbor arm. A detached call hangs its callee OFF the flow as a ghost
  node reached by a dashed open arrow annotated "detached", while the firing
  step's own lane continues normally — failure visibly does not propagate.
  Both survive the "Hide error paths" toggle (they are not error paths), and
  the flow modal's draw.io/Excalidraw exports keep the bars and ghosts. The
  Mermaid sequence exporter maps endStep-bounded parallel regions onto
  `par`/`and` fragments (mirroring loop/critical) and renders detached
  calls/dispatches as async open arrows (`-)`, annotated, no activation, no
  return). The Steps list spells both out (`∥ parallel — arms …`,
  `⇢ detached — fire & forget`).
- Cross-subsystem: a `trustedLink` on the SOURCE subsystem licenses a direct
  in-process edge to the peer's published Portal (no Adapter shim); Portals may
  depend on Repository/Index for reads.
- FeatureComponent arity relaxed: exactly one Orchestrator + **one or more**
  Views (was exactly one of each) — a feature slice with list/detail/form
  faces no longer needs artificial per-view slices. Foreign member types
  inside the slice are still rejected.
- Honest profile labeling: `lowlevel-os` / `game-ecs` / `realtime-embedded`
  are now labeled as *blueprints* everywhere they're described (init menu,
  roadmap) — today they enforce only backend-family fencing; the described
  platform validations are explicitly marked unimplemented, and doctrine is
  expected from extension packs. `plc-cyclic`'s unimplemented narrative
  checks are likewise marked.
- Placement notices: `sdd_add_type` (and siblings) explain flat-layout
  placement and never-relocate semantics instead of silently "ignoring" the
  subsystem parameter. `doctor --fix` still performs no flat→nested migration
  (known gap).
- sdd-implement's Definition of Done now includes an integration sim against
  real dependencies (docs/design/integration-conformance.md holds the designed
  static gate); the standard gains a transactions & unit-of-work + outbox
  doctrine and the two-path store doctrine.

**Migration for existing trees:** `MISSING_DURABILITY` fires once per
undeclared Store (declare one of the four modes); storeless standalone
Registries get `REGISTRY_WITHOUT_STORE` (retype to a `read-through` Store, or
lint.allow); narrative-bearing trees may see `CALL_STEP_UNREALIZED` where
per-method `symbol` maps are missing. `Store → Registry` edges are now errors
(the standard always said so; none existed in wairon's own tree).

**Dogfood: spec_loader promoted to a real Repository.** The
REGISTRY_WITHOUT_STORE debt marker on wairon's own spec loader is retired the
honest way: `spec_loader` is now a Repository owning `spec_file_store`
(read-through Store over the YAML tree, `readYamlFile`/`writeYamlFile`/
`listFilesRecursive` symbols), `spec_registry` (validated write face + the
round-trip dry run), and `spec_index` (read/lookup face). The facade's 16
methods are pure 1:1 forwards — verified by the new `FACADE_FORWARDING` rule
on a real remodel. Spec-tree-only change; the code already had this shape.

### Extension packs: pack-provided AI skills + versioned pattern references (new)

Two generic extension-pack capabilities so profiles and wrapper products can
carry more reusable, versioned knowledge — while wairon's core model stays
portable. Both are opt-in and change nothing for projects that don't use them.

- **Pack-provided AI-agent skills.** A directory pack can ship declarative
  `skills:` (SKILL.md files); `wairon skills install` / `generate` install them
  into the supported client targets, and the hosted MCP server publishes them
  through the same `wairon-skill://` resource mirror as the built-ins. Skills
  install **namespaced `<pack-id>-<skill-id>`** (the built-in `sdd-*` names are
  reserved), so skills from different packs never collide and provenance +
  version are legible in `wairon skills list`. These are AI-client skills, not
  MCP tools.
- **Versioned reusable pattern references.** Packs declare named, versioned
  `patterns:`; a component references one via `patterns: [{ id, version }]`.
  Wairon resolves the reference (`UNKNOWN_PATTERN_REF`, plus
  `PATTERN_VERSION_MISMATCH` for a pinned version no pack provides), lists them
  with `wairon patterns list`, and exposes them to pack rules via
  `ctx.ext.patterns` — the pattern's actual constraints are enforced by its
  declaring pack's own rules. Publishes a reusable architecture convention
  across projects without copy-pasting a spec shape.

Internally, the previously-unmodeled core extension machinery is now first-class
in wairon's own spec tree — the pack loader, the conformance rule set as a
proper in-memory **Repository**, and the `packs`/`rules`/`patterns` CLI — held to
the same conformance gate as everything else. See `docs/extending-wairon.md`.

### Component variants (new)

A **variant** is a named, base-anchored specialization of a core stereotype — a
"kind of `Adapter`/`Specialist`/…" (e.g. a `publisher`) — carrying implementation
guidance. It gives components domain vocabulary and, crucially, tells the
**implementer** "this is the same kind as those other components — reuse one
shared approach instead of reinventing it per instance." The base stereotype
stays authoritative for all generic semantics; the variant only adds vocabulary,
a rule target, and the guidance. (A cross-cutting capability like `retriable` is
*not* a variant — that stays a method `guarantee`.)

- **A dynamic registry on top of packs.** Variants live outside packs — define
  one on demand (no pack edit/release) and share it anywhere (a tiny portable
  YAML). Loaded from `WAIRON_VARIANTS_DIR` (machine/org-wide) then `.wai/variants/`
  (project wins), so a good variant is reusable across projects, orgs, tenants.
- **One per component, strictly base-anchored.** A component declares a single
  `variant`; `base` is required, so a variant is always "a kind of `<stereotype>`".
  Resolution: `UNKNOWN_VARIANT` (undeclared) and `VARIANT_BASE_MISMATCH` (the
  component's stereotype ≠ the variant's base, error).
- **Deep implementer integration.** A component's variant guidance and its
  same-variant siblings are injected into the generated owner/implementer agent
  context, so same-variant components get implemented consistently. Listed by
  `wairon variants list`; exposed to pack rules via `ctx.variants`.

### Hosted server: real SSO + web admin UI + agent tokens (new)

The hosted server (`sdd_host`, `wairon host`) gains the pieces that make its
web UI a real, self-serviceable control plane. Opt-in as before
(`exposurePolicy.webUiEnabled`, default off).

- **SSO for self-hosted providers.** The OIDC adapter now resolves each
  provider's endpoints by **explicit overrides → `.well-known` discovery →
  providerType template** (Keycloak `/protocol/openid-connect/*`, Authentik
  `/application/o/*`, generic), so **self-hosted Keycloak/Authentik actually
  connect** — previously it derived `/authorize`+`/token`, which matches neither.
  The returned **id_token signature is verified against the provider JWKS**
  (plus `iss`/`aud`/`exp`), no longer trusting the TLS channel alone.
- **Split-horizon endpoints.** New `IdentityProviderConfig` overrides
  (`authorizationEndpoint`/`tokenEndpoint`/`jwksUri`/`userinfoEndpoint`) let a
  **public** front-channel authorize URL pair with a **VPC-internal** back-channel
  token/JWKS URL — the common self-hosted-in-a-private-network topology.
- **Web admin UI.** The identity/admin control-plane portals are bound to the
  loopback admin listener and unreachable from a remote browser, so admins had
  no real control plane in the UI. New data-plane `/web/admin/*` routes + client
  forms bring **Users** (create/status/grants), **Identity Providers/SSO**
  (incl. the discovery + split-horizon fields), and **Organization units** into
  the browser app, forwarding the session as the credential so existing scope
  authorization is unchanged.
- **Agent tokens, separate from web login.** A signed-in user can mint a
  **single-project MCP token** for an AI agent — self-scoped (no `key:manage`
  needed for a token no broader than your own access) and **owned by the minting
  user**, so deactivating that user revokes their agent tokens. List + revoke
  round out the lifecycle.
- **Project lifecycle in the UI.** Humans **create / lock / promote / destroy**
  their projects from the browser (the admin project methods already authorize by
  grant scope), with a scoped project list — no longer CLI/loopback-only.

### Layered agent topology (new)

`wairon generate` now produces a **layered, per-project** agent topology instead
of one flat pile at the top:

- Generation emits agents for **only the current project's own layer** — the
  architect and one owner per local subsystem. A **chained subproject collapses
  to a single delegating owner** that routes work into the subproject; it never
  enumerates the subproject's internals (which belong to the subproject's own
  layer). On the real Waffler project this took the root from 507 flat agents to
  **10**, and `waffler_core` from 2000+ to **29** — each `.claude/agents` (and the
  context every session loads) now proportional to one layer.
- **Cascade by default**: one `wairon generate` walks every chained subproject
  and generates each layer into its **own** `.wai/.claude`, ensuring each child is
  initialized first (non-destructive). `--no-recurse` limits to the current layer.
- **`generateComponentImplementers` now defaults to `false`** — one owner per
  subsystem, not one implementer per component (the source of the explosions).
  Opt in with `true` on small trees. Projects with the field explicitly set are
  unaffected.
- The domain-owner agent template now instructs **hierarchical self-division**:
  break the domain into components/tasks, spawn focused subagents (which split
  further as needed), and — for a chained-subproject domain — delegate into the
  subproject rather than implementing its internals.
- `wairon generate` (and the exporters) now write relative to the bound project
  root, so running it from a subdirectory targets the project, not the cwd.
- **`generate` now reconciles its output dirs** — it prunes agent files that are
  no longer in the topology (a removed component's orphaned agent, or the old
  flat pile after the switch to layered) so the on-disk set actually shrinks
  instead of accumulating. Every generated file carries a `wairon:managed`
  marker; pruning only ever removes wairon-owned files (that marker, or the
  generated `-owner`/`-implementer`/`-architect` naming), **never a
  hand-authored agent**. Scoped runs (`--domain`/`--root`) never prune (they
  wrote only part of the set); `--no-prune` disables it entirely. The cascade
  reconciles each layer's own dir.

### Chained subprojects: self-initialize + doctor backfill (new)

- Creating a chained subsystem (`sdd_add_subsystem` with a `projectPath`) now
  **fully initializes** the child in the same action (project.yaml + system
  spec), **non-destructively** — never overwriting an existing spec tree (this
  also fixed a latent clobber in the old scaffold path).
- `wairon doctor` **detects** chained subprojects that have specs but no
  project.yaml (un-runnable standalone), and `--fix` **backfills** them.

### Validation-scope fixes

- **`validate --subsystem <name>` now errors on an unknown subsystem**
  (`SUBSYSTEM_NOT_FOUND`) instead of silently validating clean. The error lists
  the known subsystems, so a typo or wrong namespace prefix fails loudly.
- **Chained subprojects no longer explode when validated from their own
  directory.** A subproject validated standalone physically does not contain its
  parent tree, so references into it (shared types, sibling subsystems,
  cross-tree components) and code↔spec sourcePaths stored relative to the parent
  root cannot resolve — previously this produced hundreds of hard errors from
  the subproject dir while the same specs were clean from the top project
  ("different root, different verdict"). Now `wairon` detects that the current
  project is a chained subproject of a discoverable parent and **downgrades
  those root-dependent resolution failures to warnings**, with one clear notice
  (`CHAINED_SUBPROJECT_CONTEXT`) pointing at the parent root for full
  verification. So an agent running `wairon validate` / `mcp serve` inside a
  subproject dir gets an honest, non-exploding result instead of a wall of false
  errors. Additionally, cross-subproject references are now stored in the
  root-invariant relative form (`super::`) rather than a root-absolute `::`
  anchor, so newly-authored refs resolve identically from either root.

## v4.0.0 (from v3.2.5)

A large correctness + capability release, versioned **major** to signal two
breaking *deployment/CI* changes to downstream consumers (the CLI, MCP tools,
spec schema, and library APIs themselves are fully backward compatible — nothing
was removed or renamed):

1. **Stricter validation.** The new conformance gate makes `wairon validate`
   stricter — a stale L4 `sourcePath` is now a hard error, and `validate --ci`
   surfaces new warnings. A pipeline that was green may go red until the specs
   are reconciled (see *Compatibility & migration*).
2. **Container image rebased debian→alpine, npm removed.** Extension images
   built `FROM` the wairon image must use `apk` (not `apt`) and cannot rely on a
   bundled npm at runtime.

### Security hardening (multi-tenant + web UI + image)

Findings from an adversarial re-review of the authz core, the browser/SSO
session surface, and a container CVE scan — all fixed:

- **Data-plane batch bypass (HIGH):** a JSON-RPC *batch* body let a second,
  unchecked tool call ride past the `mcp:read`/`mcp:write` permission gate
  (which inspected only the first message) — a read-only token could smuggle a
  write. The data plane now refuses multi-request batch bodies (`400`); one
  tool call per request. Cross-tenant isolation was never affected.
- **SSO login CSRF (HIGH):** the OIDC `state` nonce was signed but never bound
  to the browser. Sign-in now sets a short-lived HttpOnly nonce cookie and the
  callback requires it to match the signed state, so a forged/replayed callback
  delivered to a victim fails closed.
- **SSO redirect_uri allowlist (MEDIUM):** an identity provider may now declare
  `allowedRedirectUris`; when set, `POST /web/sso/start` refuses any redirect
  URI not on the exact-match list (server-side redirect pinning).
- **Grant-shape normalization:** a `projectId:'*'` grant that also carries an
  `orgUnitId` is now treated as unit-scoped (never instance-wide super-admin)
  everywhere, matching the scope engine.
- **Signing key fails closed:** an absent signing secret now throws instead of
  signing/verifying with an empty HMAC key (only reachable under `--no-auth`).
- **Container image:** rebased to `node:24-alpine`, `apk upgrade`, and npm
  removed from the runtime layer (the server runs `node` directly). The image
  ships no perl/npm and scans **0 critical / 0 high**, down from 1 critical /
  20 high on the previous debian base; size 488 MB → 318 MB.

### Post-RBAC web UI: permission grid, canvas engine, hierarchical environment

The three deliberately-deferred UI epics, landed after the RBAC merge:

- **Permissions admin view** (`/admin/permissions`) — the whole assignment
  grid (subject × scope × capability → value) with scope/subject filters, a
  scope-defaults (everyone) section, and a set-assignment form over the
  existing hardened endpoints. Canonical-subject semantics throughout: the UI
  displays record ids and submits them (the API canonicalizes); grid rows
  resolve back to users by BOTH subject userId and record id, with a
  "legacy key" badge on diverged-key rows.
- **Canvas engine epic** — floating header (the classic renderer's solid top
  bar becomes a floating toolbar over a full-bleed canvas, yielding to the
  details panel), and **data-plane realtime**: successful MCP `sdd_*` writes
  now nudge the project's realtime channel, so open canvases live-update on
  agent spec edits (previously only `/web` mutations pushed). The event
  carries no data — authorization stays at the scoped REST refetch.
- **Hierarchical environment canvas** — the landscape is filtered by the
  permission RESOLVER (`resolveVisibleScopes`), never a display projection:
  ancestor units of a deeper actionable scope now appear as read-only
  BREADCRUMBS (`actionable: false`, other children omitted) so the hierarchy
  stays navigable in the no@org + yes@one-project case; every node carries
  `actionable`, carried through `/web/graph` to the environment canvas.
  Cross-tenant invisibility is pinned by a dedicated two-tenant test suite.
- **Header overflow → dropdown** — canvas header controls that no longer fit
  collapse into a trailing "⋯" menu (horizontal scroll remains the
  last-resort fallback).

### Unified web UI (opt-in)

One role-based browser app for the hosted server — developers author specs
visually, admins additionally get control-plane pages, all gated by the
Phase-6 grant/role model. A browser session resolves to a Principal like a
bearer token, so the UI reuses the existing scoped API with no new
authorization surface. Enable with `webUiEnabled: true` in the instance
exposure policy (default **off**).

- **View** — an embedded live architecture canvas per authorized project
  (the same engine as `wairon diagram --format canvas`).
- **Specs (authoring)** — a component index + structured inspector that reads
  and edits specs over the existing `/mcp` data plane (`sdd_get_spec` /
  `sdd_update_spec`) and runs `sdd_validate_tree`, with write affordances
  disabled for read-only sessions (Phase-6b `mcp:read`/`mcp:write` enforced
  server-side).
- **Admin (control pages)** — session-scoped `/web/admin/*` routes over the
  existing Phase-6 scoped control-plane functions: pending approvals (with
  approve/reject), the scoped user directory, the landscape (units / projects
  / relations), and the instance health report. Every view filters to the
  caller's grants; a viewer session is refused (403), never leaked.
- Security: the SSO session surface passed an adversarial review; the login
  CSRF and redirect_uri findings (above) are fixed. Sessions are HttpOnly,
  `SameSite=Lax`, with a custom-header CSRF gate on cookie-auth mutations.

### Hosting server (self-hosted)

- **`wairon serve`** — run wairon as an HTTP server that hosts many
  **fully-isolated** projects behind one endpoint (the new `sdd_host` subsystem):
  a public **data plane** (`POST /mcp` — the `sdd_*` tools over streamable HTTP,
  scoped per request to the authenticated project) and an admin **control
  plane**, plus `/healthz` + `/readyz`. Each request binds its project root via
  `AsyncLocalStorage`, reusing the core/validation/MCP layers unchanged. `sdd_mcp`
  is untouched.
- **Auth** (default-on; `--no-auth` for trusted networks): a master credential
  (`WAIRON_ADMIN_TOKEN`) gates the control plane; project API keys are minted per
  project/role and stored hashed. Scope is derived from the token, never from a
  client-supplied parameter.
- **`wairon host …`** (in-process, no running server needed — works over SSH /
  `docker exec`): `project create|list|destroy`, `key mint|list|revoke`, and the
  commit-scoped **`lock`** / **`promote`**.
- **State-scoped lock/promote:** `lock` validates the tree as-complete and writes
  `.wai/lock.json` scoped to a deterministic `StateId`; `promote` recomputes the
  `StateId` and refuses on any drift — never merges to production.
- **Docker:** `Dockerfile` + `docker-compose.yml` at the repo root; state on a
  `/data` volume. See
  [docs/design/hosted-mcp-server.md](docs/design/hosted-mcp-server.md).
- New library surfaces: `validateAsComplete` (full-strictness gate, reused by the
  local `wairon lock` story) and a request-scoped project root
  (`runWithProjectRoot`) so one process serves concurrent projects safely.
- **Diagrams over the admin API** — the diagram engine is now a first-class
  `diagram_specialist`; the hosting server generates/downloads a project's canvas,
  Mermaid, draw.io, or Excalidraw on demand, and serves the interactive canvas to
  a browser via a short-lived HMAC-**signed** `/view/diagram` link (no bearer —
  the capability is in the URL), with generate/download bearer-authed.
- **Producers** (`sdd_producers`) — project a spec tree into an external target as
  a one-way, idempotent subsection. Two producers ship, both raw REST with **no new
  dependency**, and both usable **hosted** (`wairon host producer …`,
  `/admin/projects/{id}/producers/*`) and **locally** (`wairon produce <target> --page <id>`,
  credential from flag/env/prompt):
  - **Notion** — a "wairon specs" page subtree whose pages carry each component's
    methods + a Mermaid diagram (target-agnostic `DocPage` model).
  - **Miro** — the architecture graph rendered onto a board as native shapes +
    connectors inside a `wairon architecture` frame (target-agnostic `GraphModel`;
    `--page` is the board id). Idempotent: the frame is cleared and rebuilt, the
    rest of the board untouched.
- **Runtime secret store** — integration tokens (git, Notion, Miro, signing)
  resolve data-dir store → env, and `wairon host secret set` / `PUT /admin/secrets/{key}`
  set them at runtime, so an integration can be added to a live container without a
  restart.
- **Git-backed projects** (`sdd_git`) — a hosted project can relocate its source
  of truth to a git repo (`wairon host git enable --remote …`, or
  `POST /admin/projects/{id}/git`): the container clones it, works on an isolated
  `wairon/work` branch, and `lock` becomes git-aware — sync → validate-as-complete
  → promote → **commit + push the working branch**, recording the commit SHA and a
  compare URL for a human to open the PR (push-only, one `WAIRON_GIT_TOKEN` bot
  identity, sync on-demand + auto-before-lock). `promote` still refuses a stale
  lock and never merges. The Docker image now ships with `git`.
- **Extension packs in a hosted container** (`sdd_host` → `pack_orchestrator` +
  `pack_registry`) — install architectural profiles and language/platform tables
  into a running container without shell access, at **server-global** scope
  (`GET/PUT/DELETE /admin/packs/{name}`, or `wairon host packs …`) or into one
  **project** (`GET/PUT/DELETE /admin/projects/{id}/packs/{name}`, committed with
  the project so every clone and CI enforce it). Installs over the admin surface
  are **declarative-only** (pure data — profiles + language tables); programmatic
  **rule/code** packs are refused there and install via the trusted filesystem (a
  mounted `WAIRON_PACKS_DIR` volume or `wairon packs add`), which the API still
  *lists*. Server-global packs now live on the data volume (`WAIRON_PACKS_DIR`
  defaults to `$WAIRON_DATA_DIR/packs`) so they **persist across container
  recreation** — previously a machine-wide install landed in an ephemeral home dir.

### Conformance gate (the architecture linter)

- The validator is now a **rule registry**: 16 documented rule modules under
  `src/core/rules/`, inspectable via the new **`wairon rules list`** (codes,
  default severities, per-project overrides), plus any extension-pack rules.
- **New rules:**
  - `MUTUAL_SUBSYSTEM_DEPENDENCY` *(warning)* — two subsystems depending on
    each other must be acknowledged with a `trustedLinks` declaration on
    either side (see below); otherwise the mutual coupling is flagged.
  - `INVALID_TRUSTED_LINK` *(error)* / `UNUSED_TRUSTED_LINK` *(warning)* —
    trusted links must name real peers and correspond to an actual
    cross-subsystem dependency.
  - `GOD_COMPONENT` *(warning)* — `dependsOn` fan-out above 8 suggests a
    split or a pattern facade.
  - `LANGUAGE_FOREIGN_BUILTIN` *(warning)* — with a declared
    `targetLanguage`, signatures using another language family's unambiguous
    builtins (e.g. `Vec`/`usize` in a TypeScript system) are flagged.
    Opt-in: only fires when `targetLanguage` is set.
- **Bug fixes with visible effect:** the unused-detection walk now covers ALL
  interfaces of a component and handles namespaced (subproject) component ids
  — previously invisible unused components/methods may now be reported
  (true positives).

### Code↔spec conformance (new rule families)

"Does the code match the specs?" is now part of `wairon validate` instead of
a manual sweep. Two rule families, fed by a per-run source-code model built
with **zero mandatory parser dependencies** (TypeScript compiler resolved
dynamically from the analyzed project or the wairon install when available;
declarative per-language pattern tables for 12 languages; a generic
word-boundary scan as the universal floor — every finding carries its
analysis grade `exact | pattern | generic`).

- **`structural-conformance`** — every L4 `sourcePath` must resolve to a real
  file inside the project root (`MISSING_SOURCE_FILE`,
  `SOURCE_PATH_ESCAPES_ROOT` — *errors*), and every L3 contract method must be
  realized in that file (`UNREALIZED_METHOD`, `MISSING_SOURCE_PATH`,
  `CONFORMANCE_ANALYSIS_SKIPPED` — *warnings*). When TypeScript/JavaScript
  files can only be analyzed below exact grade (no `typescript` resolvable
  from the analyzed project or the wairon install), one
  **`CONFORMANCE_DEGRADED`** warning per run makes the degradation visible —
  install `typescript` in the analyzed project to restore exact analysis. Realization is tiered per
  implementation via the new **conformance dial** (`conformance: declared |
  anchored | off`, Portal defaults to `anchored`) with per-method overrides,
  and intent-language renames are declared with the new per-method
  **`symbol:`** mapping (`put` realized by `saveSnapshot`). Many
  implementations sharing one file (N:1) is fully supported.
- **`dependency-conformance`** — runtime imports between component-mapped
  files must be justified by declared `dependsOn`/`owns` relations
  (`UNDECLARED_DEPENDENCY`), and declared edges should leave an import trace
  (`UNREALIZED_DEPENDENCY`) — both *warnings*. Type-only imports and
  re-export barrels never accuse; cross-subsystem imports are sanctioned by a
  declared edge to the target subsystem's published surface; portal↔server
  mounting declared in the portal→server direction is recognized.
- All conformance codes are **completeness-classed**: draft/design specs
  downgrade to draft-waived warnings, so in-progress trees stay green while
  complete specs gate.
- Design record: `docs/design/code-spec-conformance.md` (includes the Level 3
  call-graph↔narrative sketch).

### Spec schema (additive)

- `targetLanguage` on L0 (system default) and L1 (subsystem override).
- `trustedLinks: [{ subsystem, reason }]` on L1 — explicitly sanctioned tight
  couplings ("fast lanes"), turning architectural exceptions into reviewable
  spec.
- Structured method **`params: [{ name, type, description?, optional? }]`**
  on L3 methods — when present they are the AUTHORITATIVE source for
  type-reference validation and the free-form `signature` string is never
  heuristically parsed. Strongly recommended for new specs.

### Narrative control flow + the detail dial (L5)

- **Flow steps**: narratives stay a FLAT ordered list (order mimics the code
  lines) and gain 7 step types that jump by step number — `branch` (if/else),
  `switch`, `loop` (`loopKind: forEach | for | while | doWhile`), `try`
  (`catches` + `finallyStep`), `jump` (break/continue/rejoin), `return`,
  `throw`. Every existing narrative is already valid (linear = jump-free);
  older wairon binaries reject the new step types, so upgrade before adopting.
- **New rules**: `MALFORMED_FLOW_STEP` / `INVALID_STEP_JUMP` /
  `REGION_OVERLAP` *(error)* and `UNREACHABLE_STEP` / `JUMP_INTO_REGION` /
  `FALLTHROUGH_INTO_HANDLER` / `BACKWARD_JUMP` *(warning)* enforce
  structural soundness: regions must nest or be disjoint and are entered
  through their header, try bodies must not fall through into their own
  handlers, and backward jumps are only idiomatic as a continue to an
  enclosing loop header.
- **`LANGUAGE_FOREIGN_FLOW`** *(warning, requires `targetLanguage`)* —
  narrative flow constructs the target language lacks are flagged
  (try/throw in Rust, Go, C; do-while in Rust, Go, Python), with the
  idiomatic re-modeling suggested.
- **`sdd_update_spec` relocation**: narrative inserts/deletes renumber steps
  AND relocate every jump field automatically; deleting a jump target is
  rejected naming the referrers.
- **Narrative detail dial**: `detail: full | calls-only | intent` per method
  (or L4 spec-level default); omitted = stereotype default
  (Portal/Observer/Adapter → calls-only, Store/Index/Registry → intent,
  logic components → full). `intent` methods specify behavior as an `intent`
  paragraph instead of steps. `MISSING_NARRATIVE` / `INTENT_FLOOR` hold each
  method to its declared (or defaulted) level — explicit declarations as
  errors, stereotype-defaulted gaps as warnings. Unused-detection falls back
  to L2 edges for intent-level methods so collaborators don't false-positive
  as unused.
- **Renderers**: the canvas narrative modal draws real flowcharts (diamonds
  with labeled true/false/case edges, loop back-edges, dashed error edges,
  return/throw terminators, region indentation) with a **"Hide error paths"**
  toggle; Mermaid sequence diagrams render `loop`/`try` as native
  `loop`/`critical` fragments and other flow steps as annotated markers.

### Spec engine

- **SpecWorkspace**: all spec-tree state (index cache, loader issues) lives on
  per-project-root workspace instances; nested subproject resolution no longer
  mutates a global project root (the historical source of namespacing bugs).
- **Schema-validated writes**: every spec save is Zod-validated first — a
  malformed `sdd_update_spec` delta now fails loudly instead of writing a
  corrupt file.
- **Freshness**: a long-running MCP server now notices external YAML edits
  (mtime-signature cache check, throttled to 2s).
- **Explicit status demotion**: `sdd_update_spec` with an explicit `status`
  can reopen a completed spec; re-adds still cannot silently demote.
- **Endpoint updates**: an explicitly changed endpoint via `sdd_update_spec`
  now wins (previously the stored endpoint silently overwrote it).

### Diagrams & visualization (new)

- **`wairon diagram`** — Mermaid component diagrams (subsystem subgraphs,
  boundary-hop edges, `owns` containment, public-surface marking) and L5
  narrative → sequence diagrams; `--all` writes the full living-doc set.
- **`wairon diagram --canvas`** — interactive single-page HTML canvas
  (Cytoscape.js embedded inline; fully offline): collapsible boundaries with
  aggregated "tube" edges, spec-derived detail panel, search,
  validation-issue overlay, locked blueprint layout with crossing
  minimization, "rearrange" toggle, PNG export.
- **`wairon diagram --drawio` / `--excalidraw`** — editable exports in open
  formats with the same computed layout.
- **Canvas 2.0**: SYW / light themes, redesigned toolbar, view levels
  (System / Components / Full), presentation mode, per-browser layout
  persistence with reset, search dims edges along with nodes, sidebar with
  collapsible sections, hover-highlighting from references, narrative
  flowchart modal (call drill-down with back navigation, PNG export), and an
  Export menu (PNG / draw.io / Excalidraw) that uses the CURRENT — possibly
  rearranged — positions. `--format <fmt>` flag added.
- **Data-coupling overlay**: a **"Data coupling"** toggle overlays dashed edges
  showing where a component/subsystem depends on **another subsystem's types**
  (its data/model shape) even when there's no logical `dependsOn` — derived from
  the same `usedBy`/type-reference data as the ERD, pointed at the owner
  subsystem's published portal, and drawn only where a logical dependency doesn't
  already exist. Off by default; the architecture view stays "logical
  dependencies only" until asked. So a shared model library that everyone imports
  no longer looks like an unconnected island.
- **View-options panel**: the view toggles (Internals, Externals, Data coupling,
  Issues, Rearrange) moved out of the crowded header bar into a **"⚙ View"**
  dropdown, rendered as labelled on/off **switches** (with one-line descriptions)
  instead of inline checkboxes; the panel stays open while you flip several.
- **Scoped C4-style navigation**: every canvas view renders exactly one
  scope's direct children — System → top-level subsystems → a subsystem's
  children (nested subsystems + components) → a pattern's members,
  infinitely deep by ownership. Double-click (or "Open as view") drills in;
  the breadcrumb navigates back. "Internals" previews each child's own
  children inside its box; "Externals" shows out-of-scope dependencies as
  ghost references (double-click a ghost jumps to it). Layout
  rearrangements persist per view; exports capture the current view.
- **CLI behavior change**: bare `wairon diagram` now writes the interactive
  canvas (the primary format); Mermaid moved behind `--format mermaid` /
  `--subsystem` and writes a file instead of printing to stdout (use a
  `.mmd` `--out` for raw Mermaid).
- **Canvas readability fixes**: (a) with nothing selected, the sidebar now
  describes the **current view scope** (the subsystem/component you drilled
  into) instead of always the root system — the breadcrumb still walks up to
  the parent; (b) **focus mode** — selecting any box lifts its own edges above
  everything and recolours them **by direction** (outgoing "depends on →" vs
  incoming "← used by") while unrelated elements recede, so one block's relations
  and their direction read clearly in a busy graph (focusing an inner tile or an
  in/out port now highlights the wiring within its box too, not only top-level
  boxes — and hovering a port lights the stub edges to the tiles it serves); (c) the **Types ERD degrades
  gracefully on huge systems** — above ~400 in-scope types it renders a
  subsystem-cluster overview (double-click a cluster to open it), above ~120 it
  falls back to header-only boxes, with a banner and a "render full detail
  anyway" override — so a 1000+-type system stays interactive yet fully
  navigable — and drilling a subsystem's ERD now shows its own types plus only
  the shared types they *reference*, not the entire shared library (previously a
  subsystem owning a single type was unreachable because the whole shared model
  flooded its scope and re-clustered it); (d) **breadcrumbs preserve the active mode** — walking up from a
  subsystem's ERD now lands on the *parent's types* (not its components), so you
  can climb from a subsystem's types all the way to the system-wide ERD; the
  Components/Types toggle stays the explicit way to switch mode.
- **Layout picker** — a **Layout ▾** menu lets you switch the auto-layout instead
  of being stuck with the dependency-column heuristic (which stacked leaves under
  unrelated components and turned the ERD into one giant vertical ladder):
  **Layered** (the original columns), **Force** (physics relaxation seeded from
  the layered positions — untangles crossings, places nodes near their
  connections), **Concentric** (most-referenced in the centre, rings outward),
  and **Grid** (compact wrapped rows). Force uses cytoscape's built-in `cose`
  tuned for the large box sizes (accounts for node dimensions, high repulsion /
  long ideal edges) so nodes spread instead of overlapping; Concentric and Grid
  are size-aware presets computed for both the component view and the ERD —
  Concentric derives each ring's radius from the nodes it holds (compact, not
  sprawling) and only centres a *lone* most-referenced node, spreading a tied top
  tier into a ring rather than a central pile. The choice persists, is remembered
  per view, and a manual **Rearrange** still wins on top for fine-tuning.
  External (ghost) nodes are placed just outside the node bounds **toward the
  in-scope node they connect to** (not a fixed corner), so their line is short
  instead of crossing the whole diagram — and overlapping externals are nudged
  apart; and **Internals** now lay each box's children out with the same chosen
  layout (Grid/Concentric) instead of always the layered columns. Concentric is
  stretched into a **landscape ellipse** (screens are horizontal) rather than a
  tall circle, and **Force** seeds from a diagonal cascade so it relaxes toward an
  entrypoints-top-left → leaves-bottom-right flow, then widens into landscape.
  Concentric also orders each ring by flow rank (entrypoints toward the top,
  leaves toward the bottom) and places externals toward the node they connect to.

### Technology boundaries (L4 `technologies`)

- An external technology is abstracted as a component: an Adapter behind an
  intent interface (inside a Repository/Gateway). The L4 of that component
  declares the binding — `technologies: [mysql]` — and the ownership tree
  becomes the technology's home. New warning-severity, `lint.allow`-able
  rules police the declaration (no hardcoded vendor lists — only declared
  tokens are checked):
  - **`TECH_LEAKAGE`** — the token referenced in any spec outside the owning
    boundary (prose, ids, `dependsOn` facade bypasses, vendor-shaped types
    in the shared type space).
  - **`VENDOR_NAME_IN_CONTRACT`** — the token in ANY L3 identifier surface
    (method names, signatures, params, endpoints), including the owning
    adapter's own contract: the L3 is the swap seam.
  - **`TECH_ON_LOGIC_COMPONENT`** — technology bound outside
    Adapter/Store/Registry/Index suggests a missing Adapter wrapper.
  This is also the spec-side hook for future code↔spec conformance checking
  (the same declaration later gates actual imports).

### Extension packs (`extensions.packs`)

- Wairon is now a **profile enforcer with a plugin surface**: platform-
  specific profiles and rules are injected from outside — a wrapper tool
  (e.g. an automation-platform SDD product) layers its doctrine on wairon
  without forking it, and wairon core never learns about the platform.
- `.wai/project.yaml` gains `extensions: { packs: [...] }` — each entry a
  relative **declarative YAML pack** (custom profiles: `family` +
  forbidden/discouraged stereotypes with reasons; language/platform tables:
  unsupported flow constructs with remodeling guidance, foreign builtin
  markers) or a requireable **programmatic JS pack** (the same data plus
  `rules: SddRule[]` written against the now-exported rule API). CLI and
  MCP load packs identically, so `sdd_validate_tree` enforces injected
  rules; pack rule codes work with `lint.allow` and `rules.sddRuleSeverity`
  unchanged; `wairon rules list` shows pack rules tagged with their pack.
  A broken pack is an **`EXTENSION_LOAD_ERROR`** (error), never a silent
  skip.
- **Profiles are open**: L1 `profile` and `projectType` accept
  pack-registered names; unregistered names get **`UNKNOWN_PROFILE`**
  *(warning)*. Pack profiles enforce **`PROFILE_FORBIDDEN_STEREOTYPE`**
  *(error)* / **`PROFILE_DISCOURAGED_STEREOTYPE`** *(warning)*.
- **`wairon packs add | list | remove`** — first-class pack installation.
  `add <source>` vendors a pack (file or directory with a `pack.yaml` /
  `pack.cjs` entry) into `.wai/packs/` and registers it in project.yaml
  (committed → CI and every clone enforce it); `add --global` installs
  machine-wide into `WAIRON_PACKS_DIR` / `~/.wairon/packs`, auto-loaded for
  every project (project packs win on collision; opt out via
  `extensions.useGlobalPacks: false`). `remove <name>` is the uninstall.
  **`wairon init --pack <source>`** applies doctrine at project birth.
- **Distribution needs no npm**: wrapper products ship a release ZIP (pack
  files + an install script that runs `wairon packs add`) on top of the
  standalone wairon binaries — see the ZIP recipe in
  `docs/extending-wairon.md`.
- The narrative **flow algebra stays closed** (packs can gate and re-label
  constructs, never inject step kinds — reachability analysis and jump
  relocation depend on a closed successor semantics). The
  `LANGUAGE_FOREIGN_FLOW` gate now covers the full construct keyspace
  (branch/switch/forEach/for/while/doWhile/try/throw/jump), so a pack can
  mark e.g. `forEach` unsupported on its platform with guidance.
- **Wrapper-product template**: `examples/wrapper/` — packs (custom profile
  + language table + injected rule), the installer such a product ships
  (`install.js` → `wairon packs add`), an advanced library-embedding demo,
  and a CI-clean **spec-only** demo project (implementation lives on the
  platform; `requireOwnedPaths: false`) — guarded by a golden test so the
  example cannot rot. Full reference: `docs/extending-wairon.md`.
- Design record: `docs/design/technology-boundaries-and-extensibility.md`.

### Per-spec lint suppression — `lint.allow`

- Any L1–L4 or type spec may declare
  `lint: { allow: [{ code, reason }] }` — wairon's `#[allow(...)]`: the
  named WARNING code is silenced **on that spec only**, with the reason in
  reviewable spec (same philosophy as `trustedLinks`). Error-severity
  findings are never locally suppressible (a human can still re-tune codes
  globally via `rules.sddRuleSeverity`). `UNKNOWN_LINT_ALLOW_CODE` /
  `UNUSED_LINT_ALLOW` *(warning)* keep suppressions honest: typo'd codes
  and allows that no longer match anything are flagged.

### Types & ERD

- **`HOLLOW_TYPE`** *(warning)* — a type with no fields and no methods is a
  placeholder that informs neither implementers nor the ERD; fill it or
  delete it.
- **Canvas Types view is a real logical ERD now**: boxes render as
  UML-style tables (header, divider, `field?: type` rows sized to content,
  intrinsic methods), reference edges carry **multiplicity** derived from
  the field shape (`LineItem[]` → `*`, optional → `0..1`, plain → `1`) as a
  target-end label, and types group into per-subsystem containers (shared
  system-level types in their own box) — ready for large trees.

### Testing & tooling

- End-to-end MCP stdio integration tests (spawn the real server, drive the
  full `sdd_*` authoring pipeline).
- Skills/standards/README/init text updated to the canonical dot-prefixed
  spec layout (`.index.yaml` / `.interface.yaml` / `.implementation.yaml`);
  legacy names still load and `wairon doctor --fix` migrates them.
- Dead `lint` npm script removed (eslint was never configured); vitest 4.

### Compatibility & migration

**Who is affected:** projects running **`wairon validate --ci`**
(warnings-as-errors) in a pipeline, plus one case that affects plain
`wairon validate`: structural conformance makes a **stale `sourcePath` a hard
error** (`MISSING_SOURCE_FILE` — the spec names code that does not exist;
`SOURCE_PATH_ESCAPES_ROOT` for absolute/parent-escaping paths). Every other
new rule defaults to *warning* severity (except `INVALID_TRUSTED_LINK`,
which requires the new field to exist at all).

After upgrading, run `wairon validate` locally and review new findings:

0. **`MISSING_SOURCE_FILE`** — fix the `sourcePath` to the real file (or
   remove it while the implementation is still design-only; drafts are
   waived). **`UNREALIZED_METHOD`** — if the code name legitimately differs
   from the contract name, declare it: `methods: [{ name: put, symbol:
   saveSnapshot }]`; for registration-style realization (route/tool string
   tables) dial the implementation to `conformance: anchored`; for
   generated/vendored code use `conformance: off`.
   **`UNDECLARED_DEPENDENCY`** — declare the real collaboration on the
   component that uses it, or route the cross-subsystem hop through the
   target's published portal.

1. **`MUTUAL_SUBSYSTEM_DEPENDENCY`** — if the mutual coupling is intentional
   (e.g. a latency fast lane bypassing the bus), declare it on either
   subsystem and it becomes sanctioned:

   ```yaml
   trustedLinks:
     - subsystem: runtime-runners
       reason: runtime dispatch latency — bus round-trip too slow
   ```

   Otherwise break one direction (usually via events over the bus).
2. **`GOD_COMPONENT`** — split the workflow or group cohesive collaborators
   behind a Repository/Gateway facade.
3. **New `UNUSED_COMPONENT`/`UNUSED_METHOD` findings** — these were always
   true; the walk previously missed multi-interface components and
   namespaced ids. Wire the narratives or remove the dead surface.
3b. **`MISSING_NARRATIVE` / `INTENT_FLOOR`** — methods are now held to their
   narrative detail level (stereotype-defaulted gaps are warnings). Either
   write the missing narrative, add substantive `intent`/description prose,
   or declare a lower `detail` level where the stereotype default is wrong.
4. Any rule can be tuned per project in `.wai/project.yaml`:

   ```yaml
   rules:
     sddRuleSeverity:
       GOD_COMPONENT: 'off'        # or 'warning' / 'error'
   ```

   Prefer fixing over silencing — the overrides exist for deliberate,
   documented exceptions.

Also note: spec files are canonicalized on their next save (schema defaults
like `trustedLinks: []` are materialized), which produces one-time YAML diff
churn per file. No action needed.

## 0.1.x

Initial development series: SDD spec tree (L0–L5), conformance validation,
spec-derived agent topology, SDD skills, MCP server, subsystem chaining,
self-update with release channels.
